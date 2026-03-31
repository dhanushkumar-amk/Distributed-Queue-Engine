import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { generateJobId } from './utils';
import { createJob, hydrateJob, Job, JobOptions, JobStatus, QueueMetrics, CleanupOptions, RepeatableJobDef } from './types';
import { jobKey, waitingKey, delayedKey, activeKey, channelKey, completedKey, failedKey, cancelledKey, cronKey, latencyKey, pauseKey } from './keys';
import { CronExpressionParser } from 'cron-parser';

/**
 * High-level Queue class to interact with Redis and the Lua scripts.
 */
export class Queue<T = any> extends EventEmitter {
  protected redis: Redis;
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
   * Also computes p50/p95/p99 latency from the latency sorted set.
   */
  async getMetrics(): Promise<QueueMetrics> {
    const wk  = waitingKey(this.queueName);
    const dk  = delayedKey(this.queueName);
    const ak  = activeKey(this.queueName);
    const ck  = completedKey(this.queueName);
    const fk  = failedKey(this.queueName);
    const cnk = cancelledKey(this.queueName);
    const lk  = latencyKey(this.queueName);

    const pipeline = this.redis.pipeline();
    pipeline.zcard(wk);              // [0] Waiting
    pipeline.zcard(dk);              // [1] Delayed
    pipeline.hlen(ak);               // [2] Active
    pipeline.zcard(ck);              // [3] Completed
    pipeline.zcard(fk);              // [4] Failed
    pipeline.zcard(cnk);             // [5] Cancelled
    // Fetch all scores (durations) from latency sorted set — already ordered ASC
    pipeline.zrange(lk, 0, -1, 'WITHSCORES'); // [6] latency scores

    const results = await pipeline.exec();

    // ── Percentile calculation ────────────────────────────────────────────
    const rawLatency = (results?.[6]?.[1] as string[]) || [];
    // WITHSCORES returns [member, score, member, score ...] — extract scores only
    const durations: number[] = [];
    for (let i = 1; i < rawLatency.length; i += 2) {
      durations.push(parseFloat(rawLatency[i]));
    }
    // durations are already sorted ASC (Redis ZRANGE returns lowest score first)
    const pct = (arr: number[], p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, Math.min(idx, arr.length - 1))];
    };

    return {
      waiting:   (results?.[0]?.[1] as number) || 0,
      delayed:   (results?.[1]?.[1] as number) || 0,
      active:    (results?.[2]?.[1] as number) || 0,
      completed: (results?.[3]?.[1] as number) || 0,
      failed:    (results?.[4]?.[1] as number) || 0,
      cancelled: (results?.[5]?.[1] as number) || 0,
      p50: pct(durations, 50),
      p95: pct(durations, 95),
      p99: pct(durations, 99),
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

    const score = await this.redis.zscore(fk, jobId);
    if (score === null) return false;

    const raw = await this.redis.hgetall(jk);
    if (!raw || !raw.id) return false;

    const now = Date.now();
    const pipeline = this.redis.pipeline();
    pipeline.zrem(fk, jobId);
    pipeline.hset(jk, 'status', 'WAITING', 'attempts', '0', 'runAt', String(now));
    pipeline.zadd(wk, now, jobId); // score = now (FIFO from failed)
    await pipeline.exec();

    this.emit('retried', jobId);
    return true;
  }

  /**
   * Phase 37: Retries ALL jobs currently in the failed set.
   * Returns the count of successfully re-queued jobs.
   */
  async retryAll(): Promise<number> {
    const fk = failedKey(this.queueName);
    // Grab all failed job IDs in one shot
    const ids = await this.redis.zrange(fk, 0, -1);
    if (ids.length === 0) return 0;

    // Retry each one — pipeline them for speed
    const wk  = waitingKey(this.queueName);
    const now  = Date.now();
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      const jk = jobKey(this.queueName, id);
      pipeline.zrem(fk, id);
      pipeline.hset(jk, 'status', 'WAITING', 'attempts', '0', 'runAt', String(now));
      pipeline.zadd(wk, now, id);
    }
    await pipeline.exec();
    this.emit('retried_all', ids.length);
    return ids.length;
  }

  /**
   * Phase 37: Removes all completed jobs older than `maxAgeMs` (default 3600000 = 1h).
   * Returns the count of deleted jobs.
   */
  async clearCompleted(maxAgeMs: number = 60 * 60 * 1000): Promise<number> {
    const ck      = completedKey(this.queueName);
    const cutoff  = Date.now() - maxAgeMs;
    const jobPfx  = `queue:${this.queueName}:jobs:`;

    // Get all IDs with score (completedAt) <= cutoff
    const ids = await this.redis.zrangebyscore(ck, '-inf', cutoff);
    if (ids.length === 0) return 0;

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.del(`${jobPfx}${id}`);
    }
    pipeline.zremrangebyscore(ck, '-inf', cutoff);
    await pipeline.exec();
    return ids.length;
  }

  /**
   * Phase 37: Pauses the queue — workers will stop picking up new jobs.
   * Sets a simple Redis key that the Worker checks before each poll.
   */
  async pauseQueue(): Promise<void> {
    await this.redis.set(pauseKey(this.queueName), '1');
    this.emit('paused');
  }

  /**
   * Phase 37: Resumes the queue.
   */
  async resumeQueue(): Promise<void> {
    await this.redis.del(pauseKey(this.queueName));
    this.emit('resumed');
  }

  /**
   * Phase 37: Returns true if the queue is currently paused.
   */
  async isPaused(): Promise<boolean> {
    const val = await this.redis.get(pauseKey(this.queueName));
    return val === '1';
  }

  /**
   * Lists job IDs from a given status set with pagination support (start and limit).
   */
  async getJobsByStatus(status: string, start: number = 0, limit: number = 20): Promise<string[]> {
    const end = start + limit - 1;
    switch (status) {
      case 'waiting':
        return this.redis.zrange(waitingKey(this.queueName), start, end);
      case 'delayed':
        return this.redis.zrange(delayedKey(this.queueName), start, end);
      case 'active':
        // Note: Active jobs are in a Hash, so pagination is less direct than Sorted Sets.
        // For Active, we usually just return everything or use HSCAN if very large.
        // For now, we'll slice the keys array.
        const keys = await this.redis.hkeys(activeKey(this.queueName));
        return keys.slice(start, start + limit);
      case 'completed':
        return this.redis.zrevrange(completedKey(this.queueName), start, end);
      case 'failed':
        return this.redis.zrevrange(failedKey(this.queueName), start, end);
      case 'cancelled':
        return this.redis.zrevrange(cancelledKey(this.queueName), start, end);
      default:
        return [];
    }
  }

  /**
   * Registers a repeatable (cron) job definition.
   * The Scheduler will pick this up and enqueue jobs on schedule.
   * 
   * @param name   - Unique name for this repeatable job (also used for deduplication)
   * @param data   - Data to pass to the processor each time it runs
   * @param cron   - Cron expression, e.g. "* /10 * * * *" (every 10s — remove space)
   * @param options - Standard job options (priority, attempts, etc.)
   */
  async addRepeatable(name: string, data: any, cron: string, options: JobOptions = {}): Promise<RepeatableJobDef> {
    const ck = cronKey(this.queueName);
    
    // Parse the cron expression to get the first nextRunAt
    const interval = CronExpressionParser.parse(cron);
    const nextRunAt = interval.next().toDate().getTime();

    const def: RepeatableJobDef = {
      name,
      cron,
      data,
      options,
      nextRunAt,
      createdAt: Date.now(),
    };

    // Store in Redis Hash: field = name, value = serialized def
    await this.redis.hset(ck, name, JSON.stringify(def));
    console.log(`[Cron:${this.queueName}] Registered repeatable job "${name}" (${cron}) — next run at ${new Date(nextRunAt).toISOString()}`);
    return def;
  }

  /**
   * Returns all registered repeatable (cron) job definitions for this queue.
   */
  async getRepeatableJobs(): Promise<RepeatableJobDef[]> {
    const ck = cronKey(this.queueName);
    const raw = await this.redis.hgetall(ck);
    if (!raw) return [];
    return Object.values(raw).map(v => JSON.parse(v));
  }

  /**
   * Removes a repeatable job definition by name.
   */
  async removeRepeatable(name: string): Promise<boolean> {
    const ck = cronKey(this.queueName);
    const result = await this.redis.hdel(ck, name);
    return result === 1;
  }

  /** Expose the queue name for API use */
  getName(): string {
    return this.queueName;
  }
}
