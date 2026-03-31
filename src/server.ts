import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';
import redis from './redis';
import { loadScripts } from './scripts';
import { Queue } from './Queue';
import { Worker } from './Worker';
import { Scheduler } from './Scheduler';
import { createQueueRouter } from './api';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

async function main() {
  // Step 1: Load all Lua scripts into Redis
  await loadScripts(redis);
  console.log('✅ Lua scripts loaded.');

  // Create a dedicated Redis client for Pub/Sub
  const subRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null
  });

  // Step 2: Register your queues here
  const queues: Record<string, Queue> = {
    'emails':       new Queue('emails', redis),
    'notifications': new Queue('notifications', redis),
    'reports':      new Queue('reports', redis),
  };

  // Step 3: Example workers (in production these would be in separate processes)
  const emailWorker = new Worker('emails', async (job) => {
    // Phase 36 test: random duration so p50/p95/p99 are meaningfully different
    const delay = Math.floor(Math.random() * 1950) + 50; // 50ms – 2000ms
    console.log(`[Email Worker] Processing: ${job.name} (simulated ${delay}ms)`, job.data);
    await new Promise(r => setTimeout(r, delay));
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

  // Step 4: Start auto-cleanup/watchdog on all queues
  Object.values(queues).forEach(q => {
    q.startCleanup({ maxCount: 500, maxAge: 24 * 60 * 60 * 1000, intervalMs: 60_000 });
    q.startWatchdog(30_000, 60_000);
  });

  // Step 4b: Start Scheduler for cron/repeatable jobs
  const scheduler = new Scheduler(redis, Object.values(queues), 500);
  scheduler.start();

  // Register a sample repeatable job — runs every 10 seconds (for testing)
  // Expression "*/10 * * * * *" = every 10 seconds (6-field with seconds)
  await queues['reports'].addRepeatable(
    'daily-summary',
    { type: 'summary', time: 'auto' },
    '*/10 * * * * *',       // every 10 seconds — change to "0 0 * * *" for daily
    { attempts: 2, priority: 'normal' }
  );

  // Step 5: Build Express & Socket.IO app
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*", // Adjust for production
      methods: ["GET", "POST"]
    }
  });

  app.use(express.json());

  // Mount the queue API under /api
  app.use('/api', createQueueRouter(queues, redis));

  // Root welcome route
  app.get('/', (_req, res) => {
    res.json({
      name: 'Distributed Queue Engine',
      version: '1.0.0',
      docs: 'GET /api/health | GET /api/queues | GET /api/queues/:name/metrics',
    });
  });

  // Socket.IO Connection Logic
  io.on('connection', (socket) => {
    console.log(`📡 Dashboard client connected: ${socket.id}`);
    socket.on('disconnect', () => console.log(`🔌 Dashboard client disconnected: ${socket.id}`));
  });

  // Step 6: Relay Redis events to Socket.IO
  // We subscribe to all queue events using p-subscribe or multiple subscribe
  // For simplicity, let's join the event channels
  const channels = Object.keys(queues).map(name => `queue:${name}:events`);
  if (channels.length > 0) {
    await subRedis.subscribe(...channels);
    subRedis.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);
        // Broadcast to all connected web clients
        io.emit('job-event', { ...data, channel });
      } catch (e) {
        console.error('Failed to parse Redis event message', e);
      }
    });
    console.log(`📢 Subscribed to events for: ${Object.keys(queues).join(', ')}`);
  }

  // Global error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error('API Error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  });

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 Queue Dashboard + Real-time Socket Server running at http://localhost:${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health`);
    console.log(`   Queues:  http://localhost:${PORT}/api/queues`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    scheduler.stop();
    await emailWorker.stop();
    await multiWorker.stop();
    Object.values(queues).forEach(q => { q.stopCleanup(); q.stopWatchdog(); });
    subRedis.disconnect();
    redis.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
