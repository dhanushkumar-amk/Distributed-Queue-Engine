import { Redis } from 'ioredis';
import { generateJobId } from './utils';
import { createJob, Job, JobOptions, JobStatus } from './types';
import { jobKey, waitingKey, channelKey } from './keys';

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
    // ARGV[1]: jobId, ARGV[2]: serializedData, ARGV[3]: runAt
    await (this.redis as any).enqueue(3, jk, wk, ck, job.id, JSON.stringify(job), job.runAt);

    return job;
  }

  /**
   * Returns a job by its ID.
   */
  async getJob(jobId: string): Promise<Job<T> | null> {
    const jk = jobKey(this.queueName, jobId);
    const raw = await this.redis.hgetall(jk);
    
    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }

    const job = JSON.parse(raw.data || "{}");
    job.status = raw.status;
    return job;
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
   * Gets the total count of waiting/delayed jobs.
   */
  async getWaitingCount(): Promise<number> {
    const wk = waitingKey(this.queueName);
    return await this.redis.zcard(wk);
  }
}
