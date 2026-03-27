/**
 * Consistent Redis key naming templates to prevent collisions 
 * between different queues and different components.
 */

// Prefix to separate the engine data from other application data
const PREFIX = "queue";

export function jobKey(queueName: string, jobId: string): string {
  return `${PREFIX}:${queueName}:jobs:${jobId}`;
}

export function waitingKey(queueName: string): string {
  return `${PREFIX}:${queueName}:waiting`;
}

export function delayedKey(queueName: string): string {
  return `${PREFIX}:${queueName}:delayed`;
}

export function limiterKey(queueName: string): string {
  return `${PREFIX}:${queueName}:limiter`;
}

export function activeKey(queueName: string): string {
  return `${PREFIX}:${queueName}:active`;
}

export function failedKey(queueName: string): string {
  return `${PREFIX}:${queueName}:failed`;
}

export function completedKey(queueName: string): string {
  return `${PREFIX}:${queueName}:completed`;
}

export function cancelledKey(queueName: string): string {
  return `${PREFIX}:${queueName}:cancelled`;
}

export function metricsKey(queueName: string): string {
  return `${PREFIX}:${queueName}:metrics`;
}

export function channelKey(queueName: string): string {
  return `${PREFIX}:${queueName}:events`;
}
