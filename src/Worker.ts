import { Redis } from 'ioredis';
import { Job, JobOptions } from './types';
import { jobKey, waitingKey, activeKey, failedKey, completedKey } from './keys';

/**
 * Worker class to process jobs from the queue.
 */
export class Worker<T = any> {
  private redis: Redis;
  private queueName: string;
  private processor: (job: Job<T>) => Promise<any>;
  private running: boolean = false;
  private concurrency: number;
  private activeJobsCount: number = 0;
  private pollInterval: number;

  constructor(
    queueName: string, 
    processor: (job: Job<T>) => Promise<any>, 
    redis: Redis,
    options: { concurrency?: number; pollInterval?: number } = {}
  ) {
    this.queueName = queueName;
    this.processor = processor;
    this.redis = redis;
    this.concurrency = options.concurrency || 1;
    this.pollInterval = options.pollInterval || 1000;
  }

  /**
   * Starts the polling loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log(`👷 Worker started for queue [${this.queueName}] (concurrency: ${this.concurrency})`);
    
    // Begin polling
    this.poll();
  }

  /**
   * Graceful shutdown: wait for active jobs to finish before stopping.
   */
  async stop(): Promise<void> {
    this.running = false;
    console.log("🛑 Stopping worker gracefully...");
    
    // Wait for active jobs to drain
    while (this.activeJobsCount > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log("✅ Worker stopped.");
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
        
        if (raw && Object.keys(raw).length > 0) {
          const job: Job<T> = JSON.parse(raw.data);
          job.status = (raw.status as any);

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
    
    try {
      console.log(`🚀 Processing job: ${job.name} (ID: ${job.id})`);
      
      // Call user logic
      await this.processor(job);
      
      // Resolve states
      const completedKeyVal = completedKey(this.queueName);
      await (this.redis as any).complete(3, jk, ak, completedKeyVal, job.id, Date.now());
      
      console.log(`✅ Job completed: ${job.id}`);
    } catch (err: any) {
      console.error(`❌ Job failed: ${job.id} - ${err.message}`);
      
      const failedKeyVal = failedKey(this.queueName);
      await (this.redis as any).fail(3, jk, ak, failedKeyVal, job.id, err.message);
    }
  }
}
