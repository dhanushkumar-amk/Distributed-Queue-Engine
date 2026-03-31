import { Redis } from 'ioredis';
import { CronExpressionParser } from 'cron-parser';
import { Queue } from './Queue';
import { RepeatableJobDef } from './types';
import { cronKey } from './keys';

/**
 * Scheduler polls cron job definitions and enqueues a new job
 * whenever a cron expression's next run time has passed.
 * 
 * Duplicate prevention: uses a Redis SET NX lock so that even if  
 * multiple Scheduler instances run in parallel, only one wins the race.
 */
export class Scheduler {
  private redis: Redis;
  private queues: Queue[];
  private pollIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(redis: Redis, queues: Queue[], pollIntervalMs = 500) {
    this.redis = redis;
    this.queues = queues;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** Start the scheduler poll loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[Scheduler] Started — polling every ${this.pollIntervalMs}ms`);
    this.timer = setInterval(() => {
      this.tick().catch(err => {
        console.error('[Scheduler] Tick error:', err.message);
      });
    }, this.pollIntervalMs);
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    console.log('[Scheduler] Stopped.');
  }

  /**
   * One polling tick: checks all queues for due cron jobs.
   * For each repeatable job definition where nextRunAt <= now:
   *   1. Acquire a short-lived SET NX lock to prevent duplicate enqueue
   *   2. Enqueue the job into the waiting set
   *   3. Compute the next run time and update the definition in Redis
   */
  private async tick(): Promise<void> {
    const now = Date.now();

    for (const queue of this.queues) {
      const queueName = queue.getName();
      const ck = cronKey(queueName);

      // Read all cron definitions for this queue
      const raw = await this.redis.hgetall(ck);
      if (!raw || Object.keys(raw).length === 0) continue;

      for (const [jobName, rawDef] of Object.entries(raw)) {
        const def: RepeatableJobDef = JSON.parse(rawDef);

        // Check if this job is due
        if (def.nextRunAt > now) continue;

        // Acquire a dedup lock: SET queue:{name}:cron-lock:{jobName} 1 NX PX <pollInterval * 2>
        // This prevents two Scheduler instances from enqueuing the same cron job
        const lockKey = `queue:${queueName}:cron-lock:${jobName}`;
        const lockAcquired = await this.redis.set(lockKey, '1', 'PX', this.pollIntervalMs * 2, 'NX');

        if (!lockAcquired) {
          // Another Scheduler instance already handled this — skip
          continue;
        }

        // Enqueue the job
        await queue.add(def.name, def.data, def.options || {});
        console.log(`[Scheduler] ⏰ Cron job "${jobName}" fired on queue "${queueName}"`);

        // Compute next run time from the cron expression
        const interval = CronExpressionParser.parse(def.cron);
        const nextRunAt = interval.next().toDate().getTime();

        // Update the definition with new nextRunAt
        const updatedDef: RepeatableJobDef = { ...def, nextRunAt };
        await this.redis.hset(ck, jobName, JSON.stringify(updatedDef));
      }
    }
  }
}
