import { spawn }      from 'child_process';
import * as path      from 'path';
import * as fs        from 'fs';

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

function runWorkerScript(scriptPath: string, signal: NodeJS.Signals): Promise<RunResult> {
  return new Promise(resolve => {
    // scriptPath is relative to ROOT
    const child = spawn(
      'npx', ['ts-node', '-r', 'dotenv/config', scriptPath],
      { cwd: ROOT, env: { ...process.env }, shell: true }
    );

    let stdout  = '';
    let sigSent = false;
    const start = Date.now();

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);

      if (!sigSent && stdout.includes('READY')) {
        sigSent = true;
        console.log(`\n  [test] Worker is ready and will self-terminate...`);
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

// ─── Main ────────────────────────────────────────────────────────────────────

import { GenericContainer } from 'testcontainers';

async function main() {
  console.log('\n\n🔌 Phase 43 — Graceful Shutdown Tests (Static Files)\n');

  console.log('Starting Redis testcontainer...');
  const container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  process.env.REDIS_URL = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  console.log(`Redis started at ${process.env.REDIS_URL}`);

  // Test 1: 5s job
  console.log('══════════════════════════════════════════════');
  console.log('Test 1: 5s job — should complete before timeout (exit 0)');
  console.log('══════════════════════════════════════════════');

  const r1 = await runWorkerScript('tests/sh_worker_slow.ts', 'SIGTERM');

  console.log(`\n[test] Exit code: ${r1.exitCode} | Elapsed: ${(r1.elapsed / 1000).toFixed(1)}s`);
  assert(r1.exitCode === 0,            'Exit code is 0 (clean shutdown)');
  assert(r1.stdout.includes('job DONE'), 'Job completed before exit');
  assert(r1.elapsed < 30_000,           `Total elapsed < 30s`);

  // Test 2: 35s job
  console.log('\n══════════════════════════════════════════════');
  console.log('Test 2: 35s job — should force-exit after 30s (exit 1)');
  console.log('══════════════════════════════════════════════');

  const r2 = await runWorkerScript('tests/sh_worker_very_slow.ts', 'SIGTERM');

  console.log(`\n[test] Exit code: ${r2.exitCode} | Elapsed: ${(r2.elapsed / 1000).toFixed(1)}s`);
  assert(r2.exitCode === 1,                          'Exit code is 1 (force exit)');
  assert(!r2.stdout.includes('should NOT appear'),   'Job did NOT complete');
  assert(r2.elapsed >= 28_000,                      'Took at least 28s');

  console.log('\n─────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────\n');

  await container.stop();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Test harness crashed:', err.message);
  process.exit(1);
});
