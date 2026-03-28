/**
 * verify-phase30.ts
 * Spins up the API server, exercises all endpoints via HTTP, then shuts down.
 */
import { createServer } from 'http';
import express from 'express';
import redis from '../src/redis';
import { loadScripts } from '../src/scripts';
import { Queue } from '../src/Queue';
import { createQueueRouter } from '../src/api';

const PORT = 3099; // use a test port to avoid collisions
const BASE = `http://localhost:${PORT}/api`;

async function get(path: string) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}

async function post(path: string, body?: any) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

async function del(path: string) {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  return { status: r.status, body: await r.json() };
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function verifyPhase30() {
  console.log("--- Verifying Phase 30: Queue Dashboard REST API ---\n");

  await loadScripts(redis);
  await redis.flushdb();

  const testQueue = new Queue('test-q', redis);
  const registry = { 'test-q': testQueue };

  const app = express();
  app.use(express.json());
  app.use('/api', createQueueRouter(registry));

  const server = createServer(app);
  await new Promise<void>(r => server.listen(PORT, r));
  console.log(`Test server started on port ${PORT}`);

  try {
    // ── 1. Health check ──────────────────────────────────
    let res = await get('/health');
    assert(res.status === 200, 'health 200');
    assert(res.body.status === 'ok', 'health ok');
    console.log('✅ GET /health');

    // ── 2. List queues ───────────────────────────────────
    res = await get('/queues');
    assert(res.status === 200, 'list queues 200');
    assert(res.body.queues.includes('test-q'), 'queues has test-q');
    console.log('✅ GET /queues');

    // ── 3. Add a job ─────────────────────────────────────
    res = await post('/queues/test-q/jobs', { name: 'send-email', data: { to: 'a@b.com' } });
    assert(res.status === 201, 'add job 201');
    const jobId: string = res.body.job.id;
    console.log(`✅ POST /queues/test-q/jobs  (id: ${jobId})`);

    // ── 4. Get metrics ────────────────────────────────────
    res = await get('/queues/test-q/metrics');
    assert(res.status === 200, 'metrics 200');
    assert(res.body.metrics.waiting >= 1, 'at least 1 waiting');
    console.log('✅ GET /queues/test-q/metrics');

    // ── 5. List waiting jobs ──────────────────────────────
    res = await get('/queues/test-q/jobs?status=waiting');
    assert(res.status === 200, 'list waiting 200');
    assert(res.body.count >= 1, 'at least 1 waiting job');
    console.log('✅ GET /queues/test-q/jobs?status=waiting');

    // ── 6. Get single job ─────────────────────────────────
    res = await get(`/queues/test-q/jobs/${jobId}`);
    assert(res.status === 200, 'get job 200');
    assert(res.body.job.id === jobId, 'correct job id');
    console.log(`✅ GET /queues/test-q/jobs/:id`);

    // ── 7. Cancel the job ─────────────────────────────────
    res = await del(`/queues/test-q/jobs/${jobId}`);
    assert(res.status === 200, 'cancel job 200');
    console.log(`✅ DELETE /queues/test-q/jobs/:id (cancel)`);

    // ── 8. Cleanup ────────────────────────────────────────
    res = await post('/queues/test-q/cleanup', { maxAge: 0, maxCount: 0 });
    assert(res.status === 400, 'cleanup 400 when no options');
    res = await post('/queues/test-q/cleanup', { maxCount: 100 });
    assert(res.status === 200, 'cleanup 200');
    console.log(`✅ POST /queues/test-q/cleanup`);

    // ── 9. 404 for unknown queue ──────────────────────────
    res = await get('/queues/ghost-queue/metrics');
    assert(res.status === 404, 'unknown queue 404');
    console.log(`✅ 404 for unknown queue`);

    // ── 10. 404 for unknown job ───────────────────────────
    res = await get('/queues/test-q/jobs/nonexistent-id');
    assert(res.status === 404, 'unknown job 404');
    console.log(`✅ 404 for unknown job`);

  } finally {
    server.close();
    redis.disconnect();
    console.log('\n--- Phase 30 Verification Successfully Passed ---');
  }
}

verifyPhase30().catch(err => {
  console.error('❌ Phase 30 Failed:', err.message);
  process.exit(1);
});
