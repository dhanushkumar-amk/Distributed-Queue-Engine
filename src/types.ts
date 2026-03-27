export enum JobStatus {
  WAITING = "WAITING",
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  DELAYED = "DELAYED",
  CANCELLED = "CANCELLED",
}

export type BackoffType = "fixed" | "exponential";

export interface JobOptions {
  delay?: number;
  priority?: "low" | "normal" | "high";
  attempts?: number;
  backoff?: {
    type: BackoffType;
    delay: number;
  };
}

export interface Job<T = any> {
  id: string;
  name: string;
  data: T;
  status: JobStatus;
  priority: "low" | "normal" | "high";
  attempts: number;
  maxAttempts: number;
  backoff?: JobOptions["backoff"];
  runAt: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  error?: {
    message: string;
    stack?: string;
  };
  progress?: number;
  heartbeatAt?: number;
  updateProgress?(progress: number): Promise<void>;
  isCancelled?(): boolean;
}

export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  cancelled: number;
}

/**
 * Factory function to create a new Job object
 */
export function createJob<T>(
  id: string,
  name: string,
  data: T,
  options: JobOptions = {}
): Job<T> {
  return {
    id,
    name,
    data,
    status: (options.delay && options.delay > 0) ? JobStatus.DELAYED : JobStatus.WAITING,
    priority: options.priority || "normal",
    attempts: 0,
    maxAttempts: options.attempts || 3,
    backoff: options.backoff,
    runAt: Date.now() + (options.delay || 0),
    createdAt: Date.now(),
    progress: 0,
  };
}

/**
 * Reconstructs a Job object from its raw Redis Hash representation
 */
export function hydrateJob<T>(raw: Record<string, string>): Job<T> | null {
  if (!raw || Object.keys(raw).length === 0) return null;

  try {
    const job: Job<T> = JSON.parse(raw.data || "{}");
    job.status = (raw.status as any);
    
    if (raw.attempts) job.attempts = Number(raw.attempts);
    if (raw.maxAttempts) job.maxAttempts = Number(raw.maxAttempts);
    if (raw.runAt) job.runAt = Number(raw.runAt);
    if (raw.startedAt) job.startedAt = Number(raw.startedAt);
    if (raw.completedAt) job.completedAt = Number(raw.completedAt);
    if (raw.failedAt) job.failedAt = Number(raw.failedAt);
    if (raw.heartbeatAt) job.heartbeatAt = Number(raw.heartbeatAt);
    if (raw.progress) job.progress = Number(raw.progress);
    
    if (raw.error) {
      try {
        job.error = JSON.parse(raw.error);
      } catch {
        job.error = { message: raw.error };
      }
    }
    
    return job;
  } catch (err) {
    console.error("❌ Failed to hydrate job:", err);
    return null;
  }
}
