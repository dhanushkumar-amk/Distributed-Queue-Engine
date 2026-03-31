/**
 * tests/gracefulShutdown.test.ts
 *
 * Phase 43 — Graceful Shutdown Tests
 *
 * Run: npm run test:shutdown
 *
 * Test 1: Worker processing a 5s job → SIGTERM sent → job finishes → exit 0
 * Test 2: Worker processing a 35s job → SIGTERM sent → 30s timeout → exit 1
 *
 * Each test spawns a child process running a tiny worker script so we can
 * send signals and observe the actual exit code and stdout.
 */

import { spawn }      from 'child_process';
import * as path      from 'path';

const ROOT = path.resolve(__dirname, '..');

// ─── tiny assert ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) { console.log(`  ✅ PASS  ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL  ${label}`); failed++; }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

interface RunResult {
  exitCode: number | null;
  stdout:   string;
  elapsed:  number;
}

/**
 * Spawns a ts-node child process, waits for a "READY" line in stdout
 * then sends the given signal.  Resolves when the child exits.
 */
function runWorkerScript(script: string, signal: NodeJS.Signals): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(
      'npx', ['ts-node', '-r', 'dotenv/config', script],
      { cwd: ROOT, env: { ...process.env }, shell: true }
    );

    let stdout  = '';
    let sigSent = false;
    const start = Date.now();

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text); // mirror to terminal

      // Send the signal as soon as the worker signals readiness
      if (!sigSent && stdout.includes('READY')) {
        sigSent = true;
        console.log(`\n  [test] Sending ${signal} to PID ${child.pid}…`);
        child.kill(signal);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, elapsed: Date.now() - start });
    });
  });
}

// ─── Worker scripts ─────────────────────────────────────────────────────────
// We write them inline into /tmp so we don't pollute the source tree.

import * as fs from 'fs';
import * as os from 'os';

function writeScript(name: string, content: string): string {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// Script A: processes a job that takes 5 s — should complete before the 30 s timeout
const SLOW_SCRIPT = writeScript('worker_slow.ts', `
import Redis from 'ioredis';
import { Queue }  from '${ROOT}/src/Queue';
import { Worker } from '${ROOT}/src/Worker';
import { loadScripts } from '${ROOT}/src/scripts';
import { registerShutdownHandlers } from '${ROOT}/src/shutdown';

const QUEUE = 'shutdown-test-slow';
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function main() {
  await loadScripts(redis);
  // Flush stale keys
  const stale = await redis.keys('queue:' + QUEUE + ':*');
  if (stale.length > 0) await redis.del(...stale);

  const queue  = new Queue(QUEUE, redis);
  const worker = new Worker(
    QUEUE,
    async (_job) => {
      console.log('[worker] job started (5s delay)');
      await new Promise(r => setTimeout(r, 5_000));
      console.log('[worker] job DONE');
    },
    redis,
    { concurrency: 1, pollInterval: 100 }
  );

  await worker.start();
  await queue.add('slow-job', {});

  registerShutdownHandlers({
    workers: [worker],
    redisClients: [redis],
    drainTimeoutMs: 30_000,
  });

  console.log('READY'); // signal to test harness
}
main().catch(err => { console.error(err); process.exit(1); });
`);

// Script B: processes a job that takes 35 s — should trigger the 30 s timeout
const VERY_SLOW_SCRIPT = writeScript('worker_very_slow.ts', `
import Redis from 'ioredis';
import { Queue }  from '${ROOT}/src/Queue';
import { Worker } from '${ROOT}/src/Worker';
import { loadScripts } from '${ROOT}/src/scripts';
import { registerShutdownHandlers } from '${ROOT}/src/shutdown';

const QUEUE = 'shutdown-test-long';
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function main() {
  await loadScripts(redis);
  const stale = await redis.keys('queue:' + QUEUE + ':*');
  if (stale.length > 0) await redis.del(...stale);

  const queue  = new Queue(QUEUE, redis);
  const worker = new Worker(
    QUEUE,
    async (_job) => {
      console.log('[worker] job started (35s delay)');
      await new Promise(r => setTimeout(r, 35_000));
      console.log('[worker] job DONE — should NOT appear in force-exit test');
    },
    redis,
    { concurrency: 1, pollInterval: 100 }
  );

  await worker.start();
  await queue.add('slow-job', {});

  registerShutdownHandlers({
    workers: [worker],
    redisClients: [redis],
    drainTimeoutMs: 30_000,
  });

  console.log('READY');
}
main().catch(err => { console.error(err); process.exit(1); });
`);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n\n🔌 Phase 43 — Graceful Shutdown Tests\n');

  // ─── Test 1: 5s job completes before 30s drain timeout ───────────────────
  console.log('══════════════════════════════════════════════');
  console.log('Test 1: 5s job — should complete before timeout (exit 0)');
  console.log('══════════════════════════════════════════════');

  const r1 = await runWorkerScript(SLOW_SCRIPT, 'SIGTERM');

  console.log(`\n[test] Exit code: ${r1.exitCode} | Elapsed: ${(r1.elapsed / 1000).toFixed(1)}s`);
  assert(r1.exitCode === 0,            'Exit code is 0 (clean shutdown)');
  assert(r1.stdout.includes('job DONE'), 'Job completed before exit');
  assert(r1.elapsed < 30_000,           `Total elapsed < 30s (was ${(r1.elapsed/1000).toFixed(1)}s)`);

  // ─── Test 2: 35s job hits the 30s timeout → force exit 1 ─────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('Test 2: 35s job — should force-exit after 30s (exit 1)');
  console.log('Note: this test takes ~30s to run. Please wait…');
  console.log('══════════════════════════════════════════════');

  const r2 = await runWorkerScript(VERY_SLOW_SCRIPT, 'SIGTERM');

  console.log(`\n[test] Exit code: ${r2.exitCode} | Elapsed: ${(r2.elapsed / 1000).toFixed(1)}s`);
  assert(r2.exitCode === 1,                          'Exit code is 1 (force exit on timeout)');
  assert(!r2.stdout.includes('should NOT appear'),   '35s job did NOT complete (force-exited)');
  // Allow a 5s window around the 30s mark (startup overhead)
  assert(r2.elapsed >= 28_000 && r2.elapsed < 60_000, `Elapsed in 28s–60s window (was ${(r2.elapsed/1000).toFixed(1)}s)`);

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Test harness crashed:', err.message);
  process.exit(1);
});
