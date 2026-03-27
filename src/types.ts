export enum JobStatus {
  WAITING = "WAITING",
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  DELAYED = "DELAYED",
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
}

export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
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
    runAt: Date.now() + (options.delay || 0),
    createdAt: Date.now(),
    progress: 0,
  };
}
