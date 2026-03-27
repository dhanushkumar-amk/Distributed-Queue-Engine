import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { generateJobId } from './utils';
import { createJob, hydrateJob, Job, JobOptions, JobStatus, QueueMetrics } from './types';
import { jobKey, waitingKey, activeKey, channelKey, completedKey, failedKey } from './keys';

/**
 * High-level Queue class to interact with Redis and the Lua scripts.
 */
export class Queue<T = any> extends EventEmitter {
  private redis: Redis;
  private queueName: string;
  private watchdogTimer?: NodeJS.Timeout;

  constructor(queueName: string, redis: Redis) {
    super();
    this.queueName = queueName;
    this.redis = redis;
  }

  /**
   * Adds a new job to the queue. 
   * Supports immediate and delayed jobs via options.delay.
   */
  async add(name: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    const jobId = generateJobId();
    const job = createJob(jobId, name, data, options);
    
    const jk = jobKey(this.queueName, job.id);
    const wk = waitingKey(this.queueName);
    const ck = channelKey(this.queueName);

    // Call the updated enqueue Lua script
    // ARGV[1]: jobId, ARGV[2]: serializedData, ARGV[3]: runAt, ARGV[4]: maxAttempts
    await (this.redis as any).enqueue(3, jk, wk, ck, job.id, JSON.stringify(job), job.runAt, job.maxAttempts);

    this.emit('waiting', job);

    return job;
  }

  /**
   * Returns a job by its ID.
   */
  async getJob(jobId: string): Promise<Job<T> | null> {
    const jk = jobKey(this.queueName, jobId);
    const raw = await this.redis.hgetall(jk);
    return hydrateJob<T>(raw);
  }

  /**
   * Returns jobs that are delayed (ready at a future timestamp).
   */
  async getDelayedJobs(): Promise<string[]> {
    const wk = waitingKey(this.queueName);
    const now = Date.now();
    // In our Sorted Set, delayed jobs have scores > now
    return await this.redis.zrangebyscore(wk, now + 1, "+inf");
  }

  /**
   * Returns jobs ready to run now.
   */
  async getWaitingJobsIds(): Promise<string[]> {
    const wk = waitingKey(this.queueName);
    const now = Date.now();
    return await this.redis.zrangebyscore(wk, 0, now);
  }

  /**
   * Returns N most recent completed job IDs.
   */
  async getCompletedJobs(limit: number = 10): Promise<string[]> {
    const ck = completedKey(this.queueName);
    // ZREVRANGE for most recent (highest score) first
    return await this.redis.zrevrange(ck, 0, limit - 1);
  }

  /**
   * Gets the total count of completed jobs in the history.
   */
  async getCompletedCount(): Promise<number> {
    const ck = completedKey(this.queueName);
    return await this.redis.zcard(ck);
  }

  /**
   * Retrieves comprehensive metrics for the queue using a single pipeline call.
   */
  async getMetrics(): Promise<QueueMetrics> {
    const now = Date.now();
    const wk = waitingKey(this.queueName);
    const ak = activeKey(this.queueName);
    const ck = completedKey(this.queueName);
    const fk = failedKey(this.queueName);

    const pipeline = this.redis.pipeline();
    pipeline.zcount(wk, 0, now);          // Waiting (Ready)
    pipeline.zcount(wk, now + 1, "+inf"); // Delayed
    pipeline.hlen(ak);                    // Active
    pipeline.zcard(ck);                   // Completed
    pipeline.zcard(fk);                   // Failed
    
    const results = await pipeline.exec();
    
    return {
       waiting: results?.[0]?.[1] as number || 0,
       delayed: results?.[1]?.[1] as number || 0,
       active: results?.[2]?.[1] as number || 0,
       completed: results?.[3]?.[1] as number || 0,
       failed: results?.[4]?.[1] as number || 0
    };
  }

  /**
   * Cleans job history based on status and age.
   */
  async clean(status: JobStatus.COMPLETED | JobStatus.FAILED, gracePeriodMs: number): Promise<number> {
     const k = (status === JobStatus.COMPLETED) ? completedKey(this.queueName) : failedKey(this.queueName);
     const expiration = Date.now() - gracePeriodMs;
     // Note: This only cleans the history list (ids). 
     // Deleting actual job hashes would require ZRANGEBYSCORE + UNLINK.
     return await this.redis.zremrangebyscore(k, "-inf", expiration);
  }

  /**
   * Gets the total count of waiting/delayed jobs.
   */
  async getWaitingCount(): Promise<number> {
    const wk = waitingKey(this.queueName);
    return await this.redis.zcard(wk);
  }

  /**
   * Fetches the unique IDs of all jobs currently in the active set.
   */
  async getActiveJobs(): Promise<string[]> {
    const ak = activeKey(this.queueName);
    return await this.redis.hkeys(ak);
  }

  /**
   * Periodically checks for and recovers stalled jobs (Watchdog).
   */
  startWatchdog(checkInterval: number = 30000, stallTimeout: number = 60000): void {
     this.stopWatchdog();
     this.watchdogTimer = setInterval(() => {
        this.checkStalled(stallTimeout).catch(err => {
            console.error(`[Watchdog:${this.queueName}] Error:`, err.message);
        });
     }, checkInterval);
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Identifies and re-queues jobs that have haven't signaled liveness (heartbeat)
   * within the stallTimeout period.
   */
  async checkStalled(stallTimeout: number): Promise<string[]> {
     const ak = activeKey(this.queueName);
     const wk = waitingKey(this.queueName);
     const now = Date.now();
     
     const recovered = await (this.redis as any).cleanStalled(2, ak, wk, now, stallTimeout);
     
     if (recovered && recovered.length > 0) {
        this.emit('stalled_recovered', recovered);
     }
     
     return recovered || [];
  }
}
