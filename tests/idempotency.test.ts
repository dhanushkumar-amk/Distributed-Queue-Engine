/**
 * Phase 42 — Idempotency Keys Test
 *
 * Run: npx ts-node -r dotenv/config tests/idempotency.test.ts
 *
 * Checks:
 *  1. Calling queue.add() 10× with the same idempotencyKey → only 1 job created
 *  2. Calling queue.add() without idempotencyKey → always creates a new job
 *  3. Simulated expiry: after deleting the idem key, the same key creates a fresh job
 */

import Redis from 'ioredis';
import { Queue } from '../src/Queue';
import { loadScripts } from '../src/scripts';

const QUEUE = 'idem-test';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ PASS  ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL  ${label}`);
    failed++;
  }
}

import { GenericContainer } from 'testcontainers';

async function main() {
  console.log('\n🔑 Phase 42 — Idempotency Keys Test\n');

  const container = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();
    
  const REDIS_URL = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  const redis = new Redis(REDIS_URL);
  await loadScripts(redis);

  // Flush only our test queue keys
  const staleKeys = await redis.keys(`queue:${QUEUE}:*`);
  if (staleKeys.length > 0) await redis.del(...staleKeys);

  const queue = new Queue(QUEUE, redis);

  // ─── Test 1: Same key 10 times → only 1 job ───────────────────────────────
  console.log('Test 1: 10 calls with the same idempotencyKey');
  const IDEM_KEY = 'order-payment-123';
  const jobs = [];

  for (let i = 0; i < 10; i++) {
    const job = await queue.add('charge', { amount: 99 }, { idempotencyKey: IDEM_KEY });
    jobs.push(job.id);
  }

  // All 10 calls must return the SAME job id
  const uniqueIds = new Set(jobs);
  assert(uniqueIds.size === 1, `All 10 calls returned the same job id (${[...uniqueIds][0].slice(-8)})`);

  // Only 1 job should be in the waiting set
  const waitingCount = await queue.getWaitingCount();
  assert(waitingCount === 1, `Waiting set has exactly 1 job (got ${waitingCount})`);

  // ─── Test 2: Different keys → different jobs ───────────────────────────────
  console.log('\nTest 2: Different idempotencyKeys → different jobs');
  const jobA = await queue.add('charge', { amount: 10 }, { idempotencyKey: 'key-A' });
  const jobB = await queue.add('charge', { amount: 20 }, { idempotencyKey: 'key-B' });
  const jobC = await queue.add('charge', { amount: 30 }, { idempotencyKey: 'key-A' }); // duplicate of A

  assert(jobA.id !== jobB.id, 'key-A and key-B produce different jobs');
  assert(jobC.id === jobA.id, 'Second call with key-A re-uses the first job');

  // ─── Test 3: No idempotencyKey → always new job ───────────────────────────
  console.log('\nTest 3: No idempotencyKey → always a fresh job');
  const noIdem1 = await queue.add('ping', {});
  const noIdem2 = await queue.add('ping', {});
  assert(noIdem1.id !== noIdem2.id, 'Without idempotencyKey two calls produce two separate jobs');

  // ─── Test 4: Simulated expiry (delete idem key manually) ──────────────────
  console.log('\nTest 4: Simulated 24h expiry → fresh job allowed');
  const EXPIRE_KEY = 'email-welcome-456';

  const original = await queue.add('welcome-email', { userId: 1 }, { idempotencyKey: EXPIRE_KEY });

  // Manually delete the idem key to simulate TTL expiry
  await redis.del(`queue:${QUEUE}:idem:${EXPIRE_KEY}`);

  const afterExpiry = await queue.add('welcome-email', { userId: 1 }, { idempotencyKey: EXPIRE_KEY });
  assert(original.id !== afterExpiry.id, 'After expiry, a brand-new job is created for the same key');

  // ─── Test 5: deduplicated event fires ─────────────────────────────────────
  console.log('\nTest 5: queue emits "deduplicated" event on a duplicate call');
  let eventFired = false;
  queue.once('deduplicated', () => { eventFired = true; });

  const EVENT_KEY = 'event-test-789';
  await queue.add('task', {}, { idempotencyKey: EVENT_KEY });          // first → creates
  await queue.add('task', {}, { idempotencyKey: EVENT_KEY });          // second → duplicate

  assert(eventFired, '"deduplicated" event was emitted on the second call');

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n─────────────────────────────────────`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`─────────────────────────────────────`);

  // Cleanup
  const keys = await redis.keys(`queue:${QUEUE}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
  await container.stop();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Test crashed:', err.message);
  process.exit(1);
});
