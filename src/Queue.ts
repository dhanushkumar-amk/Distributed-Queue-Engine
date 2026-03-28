import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { generateJobId } from './utils';
import { createJob, hydrateJob, Job, JobOptions, JobStatus, QueueMetrics, CleanupOptions } from './types';
import { jobKey, waitingKey, delayedKey, activeKey, channelKey, completedKey, failedKey, cancelledKey } from './keys';

/**
 * High-level Queue class to interact with Redis and the Lua scripts.
 */
export class Queue<T = any> extends EventEmitter {
  private redis: Redis;
  private queueName: string;
  private watchdogTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

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
    const id = generateJobId();
    const job = createJob(id, name, this.queueName, data, options);
    
    const jk = jobKey(this.queueName, job.id);
    const wk = waitingKey(this.queueName);
    const dk = delayedKey(this.queueName);
    const chk = channelKey(this.queueName);

    // Map priority string to numeric score (1 is highest priority)
    const priorityMap: Record<string, number> = { high: 1, normal: 5, low: 10 };
    const priorityScore = priorityMap[job.priority] || 5;

    // Call the updated enqueue Lua script
    // ARGV[1]: jobId, ARGV[2]: data, ARGV[3]: runAt, ARGV[4]: maxAttempts, ARGV[5]: priorityScore, ARGV[6]: now
    await (this.redis as any).enqueue(
        4, jk, wk, dk, chk, 
        job.id, JSON.stringify(job), job.runAt, job.maxAttempts, priorityScore, Date.now()
    );

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
    const dk = delayedKey(this.queueName);
    const ak = activeKey(this.queueName);
    const ck = completedKey(this.queueName);
    const fk = failedKey(this.queueName);
    const cnk = cancelledKey(this.queueName);

    const pipeline = this.redis.pipeline();
    pipeline.zcard(wk);                   // Waiting (Ready)
    pipeline.zcard(dk);                   // Delayed
    pipeline.hlen(ak);                    // Active
    pipeline.zcard(ck);                   // Completed
    pipeline.zcard(fk);                   // Failed
    pipeline.zcard(cnk);                  // Cancelled
    
    const results = await pipeline.exec();
    
    return {
       waiting: results?.[0]?.[1] as number || 0,
       delayed: results?.[1]?.[1] as number || 0,
       active: results?.[2]?.[1] as number || 0,
       completed: results?.[3]?.[1] as number || 0,
       failed: results?.[4]?.[1] as number || 0,
       cancelled: results?.[5]?.[1] as number || 0
    };
  }

  /**
   * Cancels a job. If it is in waiting or delayed, it will be moved to cancelled.
   * If it is active, it will be marked for cancellation.
   */
  async cancel(jobId: string): Promise<boolean> {
     const jk = jobKey(this.queueName, jobId);
     const ak = activeKey(this.queueName);
     const wk = waitingKey(this.queueName);
     const cnk = cancelledKey(this.queueName);
     
     const result = await (this.redis as any).cancel(4, jk, ak, wk, cnk, jobId, Date.now());
     
     if (result === 1) {
        this.emit('cancelled', jobId);
        // In a real system, we'd also publish a message to potential workers
        await this.redis.publish(channelKey(this.queueName), JSON.stringify({ event: 'cancel', jobId }));
        return true;
     }
     return false;
  }

  /**
   * Runs one cleanup pass on completed, failed, and cancelled sets.
   * Removes job hashes AND their sorted set entries atomically via Lua.
   */
  async runCleanup(options: CleanupOptions): Promise<{ completed: number; failed: number; cancelled: number }> {
    const jobPrefix = `queue:${this.queueName}:jobs:`;
    const maxAge = options.maxAge || 0;
    const maxCount = options.maxCount || 0;
    const now = Date.now();

    const [completedDel, failedDel, cancelledDel] = await Promise.all([
      (this.redis as any).cleanup(2, completedKey(this.queueName), jobPrefix, maxAge, maxCount, now),
      (this.redis as any).cleanup(2, failedKey(this.queueName), jobPrefix, maxAge, maxCount, now),
      (this.redis as any).cleanup(2, cancelledKey(this.queueName), jobPrefix, maxAge, maxCount, now),
    ]);

    const result = { completed: completedDel, failed: failedDel, cancelled: cancelledDel };
    const total = completedDel + failedDel + cancelledDel;
    if (total > 0) {
      console.log(`[Cleanup:${this.queueName}] Pruned ${total} job(s) (✅${completedDel} ❌${failedDel} ⛔${cancelledDel})`);
      this.emit('cleaned', result);
    }

    return result;
  }

  /**
   * Starts an automatic periodic cleanup loop.
   */
  startCleanup(options: CleanupOptions): void {
    this.stopCleanup();
    const interval = options.intervalMs || 30000;
    console.log(`[Cleanup:${this.queueName}] Auto-cleanup started (every ${interval}ms, maxAge=${options.maxAge || 'off'}, maxCount=${options.maxCount || 'off'})`);
    this.cleanupTimer = setInterval(() => {
      this.runCleanup(options).catch(err => {
        console.error(`[Cleanup:${this.queueName}] Error:`, err.message);
      });
    }, interval);
  }

  /**
   * Stops the automatic cleanup loop.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
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

  /**
   * Retries a failed job by moving it back to the waiting set.
   */
  async retry(jobId: string): Promise<boolean> {
    const jk = jobKey(this.queueName, jobId);
    const fk = failedKey(this.queueName);
    const wk = waitingKey(this.queueName);

    // Check if job exists in the failed set
    const score = await this.redis.zscore(fk, jobId);
    if (score === null) return false;

    const raw = await this.redis.hgetall(jk);
    if (!raw || !raw.id) return false;

    const now = Date.now();
    // Move from failed → waiting with priority score 5 (normal)
    const pipeline = this.redis.pipeline();
    pipeline.zrem(fk, jobId);
    pipeline.hset(jk, 'status', 'WAITING', 'attempts', '0', 'runAt', String(now));
    pipeline.zadd(wk, 5, jobId); // normal priority
    await pipeline.exec();

    this.emit('retried', jobId);
    return true;
  }

  /**
   * Lists job IDs from a given status set ('waiting','delayed','active','completed','failed','cancelled').
   */
  async getJobsByStatus(status: string, limit: number = 20): Promise<string[]> {
    switch (status) {
      case 'waiting':
        return this.redis.zrange(waitingKey(this.queueName), 0, limit - 1);
      case 'delayed':
        return this.redis.zrange(delayedKey(this.queueName), 0, limit - 1);
      case 'active':
        return this.redis.hkeys(activeKey(this.queueName));
      case 'completed':
        return this.redis.zrevrange(completedKey(this.queueName), 0, limit - 1);
      case 'failed':
        return this.redis.zrevrange(failedKey(this.queueName), 0, limit - 1);
      case 'cancelled':
        return this.redis.zrevrange(cancelledKey(this.queueName), 0, limit - 1);
      default:
        return [];
    }
  }

  /** Expose the queue name for API use */
  getName(): string {
    return this.queueName;
  }
}
