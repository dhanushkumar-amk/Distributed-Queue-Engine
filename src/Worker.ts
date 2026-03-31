import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { Job, JobOptions, hydrateJob, JobStatus, WorkerOptions } from './types';
import { jobKey, waitingKey, delayedKey, activeKey, failedKey, completedKey, channelKey, limiterKey, latencyKey } from './keys';

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

    // Begin polling
    this.poll();
  }

  /**
   * Graceful shutdown: wait for active jobs to finish before stopping.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.log("🛑 Stopping worker gracefully...");

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.subRedis) {
      this.subRedis.disconnect();
      this.subRedis = undefined;
    }

    // Wait for active jobs to drain
    while (this.activeJobsCount > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.log("✅ Worker stopped.");
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

      // Resolve states
      const completedKeyVal = completedKey(qName);
      const finishedAt = Date.now();
      await (this.redis as any).complete(3, jk, ak, completedKeyVal, job.id, finishedAt);

      // ── Phase 36: Record processing duration in latency sorted set ────────
      // Score = duration ms, member = jobId. Cap at 1000 entries.
      const startedAt = job.startedAt ?? finishedAt;
      const duration  = finishedAt - startedAt;
      const lk = latencyKey(qName);
      const latencyPipeline = this.redis.pipeline();
      latencyPipeline.zadd(lk, duration, job.id);    // store duration
      latencyPipeline.zremrangebyrank(lk, 0, -1001); // keep newest 1000
      await latencyPipeline.exec();

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
