import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { Job, JobOptions, hydrateJob, JobStatus } from './types';
import { jobKey, waitingKey, activeKey, failedKey, completedKey, channelKey } from './keys';

/**
 * Worker class to process jobs from the queue.
 */
export class Worker<T = any> extends EventEmitter {
  private redis: Redis;
  private queueName: string;
  private processor: (job: Job<T>) => Promise<any>;
  private running: boolean = false;
  private concurrency: number;
  private activeJobsCount: number = 0;
  private pollInterval: number;

  private activeJobIds: Set<string> = new Set();
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInterval: number = 15000;
  
  private subRedis?: Redis;
  private cancelledJobs: Set<string> = new Set();

  constructor(
    queueName: string, 
    processor: (job: Job<T>) => Promise<any>, 
    redis: Redis,
    options: { concurrency?: number; pollInterval?: number } = {}
  ) {
    super();
    this.queueName = queueName;
    this.processor = processor;
    this.redis = redis;
    this.concurrency = options.concurrency || 1;
    this.pollInterval = options.pollInterval || 1000;
  }

  private async setupSubscriber(): Promise<void> {
    if (this.subRedis) return;
    
    this.subRedis = this.redis.duplicate();
    const ch = channelKey(this.queueName);
    await this.subRedis.subscribe(ch);
    this.log(`📡 Subscribed to cancellation events on: ${ch}`);

    this.subRedis.on('message', (_channel, message) => {
       try {
          const { event, jobId } = JSON.parse(message);
          if (event === 'cancel') {
             this.log(`⛔ Job cancellation received: ${jobId}`);
             this.cancelledJobs.add(jobId);
          }
       } catch {}
    });
  }

  /**
   * Internal logger.
   */
  private log(message: string): void {
    console.log(`[Worker:${this.queueName}] ${message}`);
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
   * Main polling loop.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    // Check concurrency limit
    if (this.activeJobsCount >= this.concurrency) {
      setTimeout(() => this.poll(), 100);
      return;
    }

    try {
      const wk = waitingKey(this.queueName);
      const ak = activeKey(this.queueName);
      const jkPrefix = `queue:${this.queueName}:jobs:`;

      // 1. Try to pick up a job
      const jobId = await (this.redis as any).moveToActive(3, wk, ak, jkPrefix, Date.now());

      if (jobId) {
        // 2. Fetch full job data
        const jk = jobKey(this.queueName, jobId);
        const raw = await this.redis.hgetall(jk);
        const job = hydrateJob<T>(raw);
        
        if (job) {
          // 3. Process the job
          this.activeJobsCount++;
          
          this.processJob(job).finally(() => {
            this.activeJobsCount--;
            // Immediately poll for the next job since we just finished one
            setImmediate(() => this.poll());
          });
        } else {
           // Orphaned ID? Just remove it from active and wait
           await this.redis.hdel(ak, jobId);
           this.poll();
        }
      } else {
        // No jobs: wait and poll again
        setTimeout(() => this.poll(), this.pollInterval);
      }
    } catch (err: any) {
      console.error("❌ Worker Poll Error:", err.message);
      setTimeout(() => this.poll(), this.pollInterval * 2); // Exponential backoff on error
    }
  }

  /**
   * Internal job execution handler.
   */
  private async processJob(job: Job<T>): Promise<void> {
    const jk = jobKey(this.queueName, job.id);
    const ak = activeKey(this.queueName);
    
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
      this.activeJobIds.add(job.id);
      this.log(`🚀 Processing job: ${job.name} (ID: ${job.id})`);
      this.emit('active', job);
      
      // Call user logic
      const result = await this.processor(job);
      
      // Resolve states
      const completedKeyVal = completedKey(this.queueName);
      await (this.redis as any).complete(3, jk, ak, completedKeyVal, job.id, Date.now());
      
      this.log(`✅ Job completed: ${job.id}`);
      this.emit('completed', job, result);
    } catch (err: any) {
      this.log(`❌ Job failed: ${job.id} - ${err.message}`);
      
      const failedKeyVal = failedKey(this.queueName);
      const waitingKeyVal = waitingKey(this.queueName);
      const now = Date.now();
      const nextRunAt = this.calculateNextRunAt(job, now);
      const errorJson = JSON.stringify({ message: err.message, stack: err.stack });
      
      await (this.redis as any).fail(4, jk, ak, waitingKeyVal, failedKeyVal, job.id, errorJson, now, nextRunAt);
      
      this.emit('failed', job, err);
    } finally {
      this.activeJobIds.delete(job.id);
      this.cancelledJobs.delete(job.id);
    }
  }

  /**
   * Periodically updates heartbeat for all currently processing jobs.
   */
  private startHeartbeatLoop(): void {
     this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeats().catch(err => this.log(`Heartbeat Error: ${err.message}`));
     }, this.heartbeatInterval);
  }

  private async sendHeartbeats(): Promise<void> {
    if (this.activeJobIds.size === 0) return;
    
    const ak = activeKey(this.queueName);
    const now = Date.now();
    
    // We update each job's timestamp in the active hash
    const promises = Array.from(this.activeJobIds).map(jobId => {
      return (this.redis as any).heartbeat(1, ak, jobId, now);
    });
    
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
