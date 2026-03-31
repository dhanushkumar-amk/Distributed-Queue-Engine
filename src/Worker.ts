import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import * as os from 'os';
import { Job, JobOptions, hydrateJob, JobStatus, WorkerOptions } from './types';
import { jobKey, waitingKey, delayedKey, activeKey, failedKey, completedKey, channelKey, limiterKey, latencyKey, pauseKey, workerKey, WORKER_KEY_PATTERN } from './keys';

/**
 * Worker class to process jobs from one or more queues.
 */
export class Worker<T = any> extends EventEmitter {
  private redis: Redis;
  private queueNames: string[];
  private currentQueueIndex: number = 0;
  private processor: (job: Job<T>) => Promise<void>;
  private running: boolean = false;
  private concurrency: number;
  private activeJobsCount: number = 0;
  private pollInterval: number;

  private activeJobs: Map<string, Job<T>> = new Map(); // jobId -> Job
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInterval: number = 15000;

  private subRedis?: Redis;
  private cancelledJobs: Set<string> = new Set();
  private options: WorkerOptions;

  // Phase 38: Worker identity & stats
  private readonly workerPid: number = process.pid;
  private readonly workerHost: string = os.hostname();
  private readonly startedAt: number = Date.now();
  private jobsProcessed: number = 0;
  private workerStatusTimer?: NodeJS.Timeout;
  private readonly STATUS_TTL = 45; // seconds — key expires if no heartbeat

  /** Default drain timeout for graceful shutdown (30 s) */
  static readonly DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

  constructor(
    queueNames: string | string[], 
    processor: (job: Job<T>) => Promise<void>, 
    redis: Redis,
    options: WorkerOptions = {}
  ) {
    super();
    this.queueNames = Array.isArray(queueNames) ? queueNames : [queueNames];
    this.processor = processor;
    this.redis = redis;
    this.options = options || {};
    this.concurrency = options.concurrency || 1;
    this.pollInterval = options.pollInterval || 1000;
  }

  private async setupSubscriber(): Promise<void> {
    if (this.subRedis) return;
    
    this.subRedis = this.redis.duplicate();
    for (const q of this.queueNames) {
       const ch = channelKey(q);
       await this.subRedis.subscribe(ch);
       this.log(`📡 Subscribed to cancellation events on: ${ch}`, q);
    }

    this.subRedis.on('message', (channel, message) => {
       try {
          const { event, jobId } = JSON.parse(message);
          if (event === 'cancel') {
             this.log(`⛔ Job cancellation received: ${jobId}`, channel);
             this.cancelledJobs.add(jobId);
          }
       } catch {}
    });
  }

  /**
   * Internal logger.
   */
  private log(message: string, queueName?: string): void {
    const qLabel = queueName || this.queueNames.join(',');
    console.log(`[Worker:${qLabel}] ${message}`);
  }

  /**
   * Starts the polling loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log(`👷 Worker started (concurrency: ${this.concurrency})`);

    await this.setupSubscriber().catch(err => {
        this.log(`❌ Failed to setup subscriber: ${err.message}`);
    });

    this.startHeartbeatLoop();
    this.startWorkerStatusLoop(); // Phase 38

    // Begin polling
    this.poll();
  }

  /**
  /**
   * Graceful shutdown.
   * Stops polling, waits up to `timeoutMs` for active jobs to drain.
   * If they don't finish in time, emits 'drain_timeout' and resolves anyway
   * (the caller decides whether to force-exit).
   *
   * @param timeoutMs  Max ms to wait for active jobs. Default: 30 000 (30 s)
   * @returns          true = clean drain, false = timed out
   */
  async stop(timeoutMs: number = Worker.DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
    this.running = false;
    this.log(`🛑 Stopping worker gracefully (timeout: ${timeoutMs / 1000}s)…`);

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Phase 38: stop status loop & delete worker hash keys
    if (this.workerStatusTimer) {
      clearInterval(this.workerStatusTimer);
      this.workerStatusTimer = undefined;
    }
    await this.deleteWorkerStatus().catch(() => {});

    if (this.subRedis) {
      this.subRedis.disconnect();
      this.subRedis = undefined;
    }

    // Race: drain active jobs vs. hard timeout
    const drainLoop = async () => {
      while (this.activeJobsCount > 0) {
        this.log(`⏳ Waiting for ${this.activeJobsCount} active job(s) to finish…`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };

    const timeoutPromise = new Promise<void>(resolve =>
      setTimeout(resolve, timeoutMs)
    );

    let timedOut = false;
    await Promise.race([
      drainLoop(),
      timeoutPromise.then(() => { timedOut = true; }),
    ]);

    if (timedOut) {
      this.log(`⚠️  Drain timeout reached (${timeoutMs / 1000}s). ${this.activeJobsCount} job(s) still active — forcing stop.`);
      this.emit('drain_timeout', this.activeJobsCount);
      return false; // caller should force-exit
    }

    this.log('✅ Worker stopped cleanly.');
    return true; // clean drain
  }

  /** Returns the number of jobs currently being processed by this worker. */
  getActiveCount(): number {
    return this.activeJobsCount;
  }

  /**
   * Main polling loop rotating through queueNames.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    if (this.activeJobsCount >= this.concurrency) {
      setTimeout(() => this.poll(), 100);
      return;
    }

    let jobFound = false;
    let rateLimited = false;

    // Ordered / Round-robin rotation
    for (let i = 0; i < this.queueNames.length; i++) {
        const qIdx = (this.currentQueueIndex + i) % this.queueNames.length;
        const qName = this.queueNames[qIdx];

        try {
            const wk = waitingKey(qName);
            const dk = delayedKey(qName);
            const ak = activeKey(qName);
            const lk = limiterKey(qName);
            const jkPrefix = `queue:${qName}:jobs:`;

            // Phase 37: Skip this queue if it is paused
            const paused = await this.redis.get(pauseKey(qName));
            if (paused === '1') {
                this.log(`⏸️  Queue '${qName}' is paused — skipping poll.`, qName);
                continue;
            }

            const limitMax = this.options.rateLimit?.max || 0;
            const limitDuration = this.options.rateLimit?.durationMs || 0;

            const jobId = await (this.redis as any).moveToActive(
                4, dk, wk, ak, lk, 
                Date.now(), jkPrefix, limitMax, limitDuration
            );

            if (jobId === "RATE_LIMIT") {
                rateLimited = true;
                continue;
            }

            if (jobId) {
                jobFound = true;
                this.currentQueueIndex = qIdx; // Success: set as base for next poll

                const jk = jobKey(qName, jobId);
                const raw = await this.redis.hgetall(jk);
                const job = hydrateJob<T>(raw);
                
                if (job) {
                    this.activeJobsCount++;
                    this.processJob(job).finally(() => {
                        this.activeJobsCount--;
                        setImmediate(() => this.poll());
                    });
                    return; 
                } else {
                    // Orphaned ID? Just remove it
                    await this.redis.hdel(ak, jobId);
                }
            }
        } catch (err: any) {
            this.log(`❌ Poll error on ${qName}: ${err.message}`);
        }
    }

    // Backoff if no work or rate-limited
    const waitTime = rateLimited ? 1000 : this.pollInterval;
    if (!jobFound) {
       this.currentQueueIndex = (this.currentQueueIndex + 1) % this.queueNames.length;
    }
    setTimeout(() => this.poll(), waitTime);
  }

  /**
   * Internal job execution handler.
   */
  private async processJob(job: Job<T>): Promise<void> {
    const qName = job.queueName;
    const jk = jobKey(qName, job.id);
    const ak = activeKey(qName);

    // Attach progress reporter
    job.updateProgress = async (progress: number) => {
      await (this.redis as any).updateProgress(1, jk, progress.toString());
      job.progress = progress;
      this.emit('progress', job, progress);
    };

    job.isCancelled = () => {
       return this.cancelledJobs.has(job.id);
    };

    try {
      if (job.isCancelled()) return;
      
      this.activeJobs.set(job.id, job);
      this.log(`🚀 Processing job [${qName}]: ${job.name} (ID: ${job.id})`);
      this.emit('active', job);

      // Call user logic
      const result = await this.processor(job);

      // Resolve states — Lua complete.lua expects 4 keys: jobKey, activeKey, completedKey, throughputKey
      const completedKeyVal = completedKey(qName);
      const throughputKeyVal = `queue:${qName}:throughput:completed:minute`;
      const finishedAt = Date.now();
      await (this.redis as any).complete(4, jk, ak, completedKeyVal, throughputKeyVal, job.id, finishedAt);

      // ── Phase 36: Record processing duration in latency sorted set ────────
      // Score = duration ms, member = jobId. Cap at 1000 entries.
      const startedAt = job.startedAt ?? finishedAt;
      const duration  = finishedAt - startedAt;
      const lk = latencyKey(qName);
      const latencyPipeline = this.redis.pipeline();
      latencyPipeline.zadd(lk, duration, job.id);    // store duration
      latencyPipeline.zremrangebyrank(lk, 0, -1001); // keep newest 1000
      await latencyPipeline.exec();

      // Phase 38: count completed jobs + push fresh status immediately
      this.jobsProcessed++;
      this.publishWorkerStatus().catch(() => {});

      this.log(`✅ Job completed: ${job.id} (${duration}ms)`, qName);
      this.emit('completed', job, result);
    } catch (err: any) {
      this.log(`❌ Job failed: ${job.id} - ${err.message}`, qName);

      const failedKeyVal = failedKey(qName);
      const waitingKeyVal = waitingKey(qName);
      const now = Date.now();
      const nextRunAt = this.calculateNextRunAt(job, now);
      const errorJson = JSON.stringify({ message: err.message, stack: err.stack });

      await (this.redis as any).fail(4, jk, ak, waitingKeyVal, failedKeyVal, job.id, errorJson, now, nextRunAt);

      this.emit('failed', job, err);
    } finally {
      this.activeJobs.delete(job.id);
      this.cancelledJobs.delete(job.id);
    }
  }

  private startHeartbeatLoop(): void {
     this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeats().catch(err => this.log(`Heartbeat Error: ${err.message}`));
     }, this.heartbeatInterval);
  }

  private async sendHeartbeats(): Promise<void> {
    if (this.activeJobs.size === 0) return;

    const now = Date.now();
    const promises: Promise<any>[] = [];

    for (const job of this.activeJobs.values()) {
        const ak = activeKey(job.queueName);
        promises.push((this.redis as any).heartbeat(1, ak, job.id, now));
    }

    await Promise.all(promises);
  }

  // ── Phase 38: Worker Status Heartbeat ──────────────────────────────────────
  private startWorkerStatusLoop(): void {
    // Publish immediately, then every 15s
    this.publishWorkerStatus().catch(() => {});
    this.workerStatusTimer = setInterval(() => {
      this.publishWorkerStatus().catch(err => this.log(`Status Heartbeat Error: ${err.message}`));
    }, this.heartbeatInterval);
  }

  /**
   * Writes worker identity + live stats into a Redis Hash with a 45s TTL.
   * One Hash per (queueName × pid) so multiple queues get separate entries.
   */
  private async publishWorkerStatus(): Promise<void> {
    const now     = Date.now();
    const current = this.activeJobs.size > 0
      ? [...this.activeJobs.keys()].join(',')
      : '';

    const pipeline = this.redis.pipeline();
    for (const qName of this.queueNames) {
      const wk = workerKey(qName, this.workerPid);
      pipeline.hset(wk,
        'pid',            String(this.workerPid),
        'host',           this.workerHost,
        'queues',         this.queueNames.join(','),
        'startedAt',      String(this.startedAt),
        'jobsProcessed',  String(this.jobsProcessed),
        'currentJob',     current,
        'lastHeartbeat',  String(now),
        'concurrency',    String(this.concurrency),
      );
      pipeline.expire(wk, this.STATUS_TTL);
    }
    await pipeline.exec();
  }

  /** Deletes all worker hash keys for this process on graceful stop. */
  private async deleteWorkerStatus(): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const qName of this.queueNames) {
      pipeline.del(workerKey(qName, this.workerPid));
    }
    await pipeline.exec();
  }

  private calculateNextRunAt(job: Job<T>, now: number): number {
    const strategy = job.backoff;
    if (!strategy) return now + 1000;

    const { type, delay } = strategy;
    const attemptsMade = job.attempts;

    if (type === "fixed") {
      return now + delay;
    } else if (type === "exponential") {
      return now + (delay * Math.pow(2, attemptsMade));
    }

    return now + delay;
  }
}
