import { Redis } from 'ioredis';
import { generateJobId } from './utils';
import { createJob, hydrateJob, Job, JobOptions, JobStatus } from './types';
import { jobKey, waitingKey, channelKey, completedKey, failedKey } from './keys';

/**
 * High-level Queue class to interact with Redis and the Lua scripts.
 */
export class Queue<T = any> {
  private redis: Redis;
  private queueName: string;

  constructor(queueName: string, redis: Redis) {
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
   * Gets the total count of waiting/delayed jobs.
   */
  async getWaitingCount(): Promise<number> {
    const wk = waitingKey(this.queueName);
    return await this.redis.zcard(wk);
  }
}
