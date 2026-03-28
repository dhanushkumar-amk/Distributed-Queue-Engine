import express from 'express';
import redis from './redis';
import { loadScripts } from './scripts';
import { Queue } from './Queue';
import { Worker } from './Worker';
import { createQueueRouter } from './api';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

async function main() {
  // Step 1: Load all Lua scripts into Redis
  await loadScripts(redis);
  console.log('✅ Lua scripts loaded.');

  // Step 2: Register your queues here
  const queues: Record<string, Queue> = {
    'emails':       new Queue('emails', redis),
    'notifications': new Queue('notifications', redis),
    'reports':      new Queue('reports', redis),
  };

  // Step 3: Example workers (in production these would be in separate processes)
  const emailWorker = new Worker('emails', async (job) => {
    console.log(`[Email Worker] Processing: ${job.name}`, job.data);
    await new Promise(r => setTimeout(r, 300)); // simulate work
  }, redis, { concurrency: 3 });

  const multiWorker = new Worker(
    ['notifications', 'reports'],
    async (job) => {
      console.log(`[MultiWorker] Processing [${job.queueName}]: ${job.name}`);
      await new Promise(r => setTimeout(r, 200));
    },
    redis,
    { concurrency: 2 }
  );

  await emailWorker.start();
  await multiWorker.start();
  console.log('✅ Workers started.');

  // Step 4: Start auto-cleanup on all queues
  Object.values(queues).forEach(q => {
    q.startCleanup({ maxCount: 500, maxAge: 24 * 60 * 60 * 1000, intervalMs: 60_000 });
    q.startWatchdog(30_000, 60_000);
  });

  // Step 5: Build Express app
  const app = express();
  app.use(express.json());

  // Mount the queue API under /api
  app.use('/api', createQueueRouter(queues));

  // Root welcome route
  app.get('/', (_req, res) => {
    res.json({
      name: 'Distributed Queue Engine',
      version: '1.0.0',
      docs: 'GET /api/health | GET /api/queues | GET /api/queues/:name/metrics',
    });
  });

  // Global error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error('API Error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  });

  app.listen(PORT, () => {
    console.log(`\n🚀 Queue Dashboard API running at http://localhost:${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health`);
    console.log(`   Queues:  http://localhost:${PORT}/api/queues`);
    console.log(`   Metrics: http://localhost:${PORT}/api/queues/emails/metrics`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await emailWorker.stop();
    await multiWorker.stop();
    Object.values(queues).forEach(q => { q.stopCleanup(); q.stopWatchdog(); });
    redis.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
