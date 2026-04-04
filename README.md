<div align="center">

<h1>⚡ Distributed Queue Engine</h1>

<p>A production-grade, horizontally scalable job queue system built with <strong>Node.js</strong>, <strong>TypeScript</strong>, and <strong>Redis</strong>.</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Redis](https://img.shields.io/badge/Redis-7%2B-red?logo=redis)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)](https://www.docker.com/)

[Features](#-features) · [Architecture](#-architecture) · [Quick Start](#-quick-start) · [API Reference](#-api-reference) · [Configuration](#-configuration) · [Contributing](#-contributing)

</div>

---

## 🧠 What Is This?

**Distributed Queue Engine** is a self-hostable, open-source background job processing system — similar in spirit to BullMQ or Sidekiq, but written from scratch with full transparency into every layer.

It lets you offload slow or resource-intensive work (emails, reports, data processing) into a fault-tolerant queue that multiple workers process concurrently. Everything is backed by Redis using atomic Lua scripts, so the system is safe to run at scale across many machines.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔀 **Multi-Queue** | Workers subscribe to one or many queues simultaneously |
| 🎯 **Job Priority** | `high`, `normal`, `low` — lower score runs first |
| ⏰ **Delayed Jobs** | Schedule jobs to execute at a future timestamp |
| 🔁 **Cron / Repeatable Jobs** | Register cron expressions; the Scheduler fires them automatically |
| 🛡 **Idempotency** | Deduplicate jobs using a user-supplied key (24h window) |
| 📈 **Rate Limiting** | Distributed sliding-window limiter — per queue, per worker |
| 🔄 **Auto-Retry + Backoff** | Fixed or exponential backoff on failure |
| 💓 **Heartbeat & Watchdog** | Stalled job detection and automatic recovery |
| 🧹 **Auto-Cleanup** | Prune old completed/failed/cancelled jobs by age or count |
| 🏳️ **Pause / Resume** | Pause a queue without stopping workers |
| 📊 **Latency Percentiles** | Real-time p50 / p95 / p99 processing duration |
| 🌐 **Dashboard** | React-based UI for real-time monitoring and control |
| 🔌 **Socket.IO Events** | Live job-event streaming to dashboard clients |
| 🐳 **Docker-first** | Full `docker-compose` stack: Redis + 3 Workers + Dashboard |
| ✅ **Graceful Shutdown** | Workers drain active jobs before exiting on SIGTERM / SIGINT |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Application                      │
│              queue.add("emails", data, options)              │
└──────────────────────────┬──────────────────────────────────┘
                           │  enqueue.lua (atomic)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                          Redis                               │
│                                                             │
│  queue:{name}:waiting    → Sorted Set (priority score)      │
│  queue:{name}:delayed    → Sorted Set (future timestamp)    │
│  queue:{name}:active     → Hash      (jobId → heartbeat ts) │
│  queue:{name}:completed  → Sorted Set (completedAt)         │
│  queue:{name}:failed     → Sorted Set (failedAt)            │
│  queue:{name}:cancelled  → Sorted Set (cancelledAt)         │
│  queue:{name}:jobs:{id}  → Hash      (full job metadata)    │
│  queue:{name}:cron       → Hash      (repeatable job defs)  │
│  queue:{name}:latency    → Sorted Set (duration scores)     │
│  queue:{name}:workers:*  → Hash      (worker heartbeats)    │
└──────┬───────────────────────────┬───────────────────────────┘
       │  moveToActive.lua          │  Events (Pub/Sub)
       ▼                           ▼
┌──────────────┐         ┌──────────────────────┐
│   Worker(s)  │         │   Dashboard + API    │
│  (N replicas)│         │  (Socket.IO relay)   │
└──────────────┘         └──────────────────────┘
       ▲
       │  cron tick
┌──────────────┐
│  Scheduler   │
└──────────────┘
```

### Key Components

**Queue** (`src/Queue.ts`) — High-level interface for enqueuing jobs, querying metrics, managing repeatable jobs, pausing/resuming, and running cleanup.

**Worker** (`src/Worker.ts`) — Polls one or more queues via `moveToActive.lua`, executes user-supplied processor functions concurrently, reports heartbeats, and handles graceful shutdown.

**Scheduler** (`src/Scheduler.ts`) — Polls cron definitions on a configurable interval, acquires a distributed lock, and enqueues the next run. Safe to run as multiple replicas.

**Lua Scripts** (`src/lua/`) — All critical state transitions (enqueue, move-to-active, complete, fail, cancel, heartbeat, cleanup, stall recovery) are implemented as atomic Redis Lua scripts to prevent race conditions.

**API** (`src/api.ts`) — Express router exposing full REST control over every queue feature.

**Dashboard** (`dashboard/`) — React SPA that consumes the REST API and receives real-time events via Socket.IO.

---

## 🚀 Quick Start

### Docker Compose (Recommended)

The fastest way to run the full stack:

```bash
git clone https://github.com/dhanushkumar-amk/Distributed-Queue-Engine.git
cd Distributed-Queue-Engine

cp .env.example .env

docker-compose up -d
```

This starts:
- **Redis 7** on port `6379`
- **3 Worker** replicas (no API, no scheduler)
- **Dashboard + API + Scheduler** on port `3002`

Open **http://localhost:3002** for the real-time dashboard.

### Local Development

**Prerequisites:** Node.js 20+, Redis 7+

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Edit .env and set REDIS_URL=redis://localhost:6379

# Build TypeScript
npm run build

# Start a worker
node dist/server.js  # with DISABLE_API=true DISABLE_SCHEDULER=true

# Start the dashboard/API
node dist/server.js  # with DISABLE_WORKERS=true
```

---

## ⚙️ Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | *(required)* | Redis connection string |
| `PORT` | `3000` | HTTP server port |
| `QUEUE_DEFAULT_CONCURRENCY` | `1` | Jobs a worker processes simultaneously |
| `HEARTBEAT_INTERVAL_MS` | `5000` | How often active jobs emit heartbeats |
| `STALL_THRESHOLD_MS` | `30000` | How long before a job is considered stalled |
| `SCHEDULER_POLL_MS` | `500` | Cron scheduler polling frequency |
| `DISABLE_WORKERS` | `false` | Set `true` on dashboard-only instances |
| `DISABLE_API` | `false` | Set `true` on worker-only instances |
| `DISABLE_SCHEDULER` | `false` | Set `true` on worker-only instances |

---

## 📜 API Reference

### Jobs

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/queues/:name/jobs` | Enqueue a new job |
| `GET` | `/api/queues/:name/jobs/:id` | Get job by ID |
| `DELETE` | `/api/queues/:name/jobs/:id` | Cancel a job |
| `POST` | `/api/queues/:name/jobs/:id/retry` | Retry a failed job |

**Enqueue a job:**
```http
POST /api/queues/emails/jobs
Content-Type: application/json

{
  "name": "send-welcome",
  "data": { "to": "user@example.com" },
  "options": {
    "priority": "high",
    "delay": 5000,
    "attempts": 3,
    "backoff": { "type": "exponential", "delay": 1000 },
    "idempotencyKey": "welcome-user-42"
  }
}
```

### Queue Management

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/queues` | List all queues |
| `GET` | `/api/queues/:name/metrics` | Depth, latency percentiles |
| `GET` | `/api/queues/:name/jobs?status=failed&limit=20` | List jobs by status |
| `POST` | `/api/queues/:name/pause` | Pause a queue |
| `DELETE` | `/api/queues/:name/pause` | Resume a queue |
| `GET` | `/api/queues/:name/pause` | Check if paused |
| `POST` | `/api/queues/:name/retry-all` | Re-queue all failed jobs |
| `DELETE` | `/api/queues/:name/jobs/completed` | Clear old completed jobs |
| `POST` | `/api/queues/:name/cleanup` | Prune by age/count |
| `GET` | `/api/queues/:name/throughput` | Throughput (10-minute buckets) |

### Workers & Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/workers` | Live worker status |
| `GET` | `/api/health` | System health check |

---

## 🛠️ Programmatic Usage

Register queues and workers in your Node.js app:

```typescript
import { Queue, Worker } from './src';
import redis from './src/redis';

// Define a queue
const emailQueue = new Queue('emails', redis);

// Enqueue a job
await emailQueue.add('send-welcome', { to: 'user@example.com' }, {
  priority: 'high',
  attempts: 3,
  idempotencyKey: 'welcome-user-42',
});

// Enqueue a delayed job (runs in 30 seconds)
await emailQueue.add('send-reminder', { to: 'user@example.com' }, {
  delay: 30_000,
});

// Register a cron job (every 10 seconds)
await emailQueue.addRepeatable('daily-digest', { type: 'digest' }, '*/10 * * * * *');

// Create a worker
const worker = new Worker('emails', async (job) => {
  console.log('Processing:', job.name, job.data);
  await job.updateProgress?.(50);
  // do your work here
  await job.updateProgress?.(100);
}, redis, { concurrency: 3 });

worker.on('completed', (job) => console.log(`✅ ${job.id} done`));
worker.on('failed', (job, err) => console.error(`❌ ${job.id}:`, err.message));

await worker.start();
```

---

## 🧪 Testing

```bash
# Run all unit + integration tests
npm test

# Run with Redis in Docker (via testcontainers — no local Redis needed)
npm test

# Idempotency test
npm run test:idempotency

# Graceful shutdown test
npm run test:graceful-shutdown
```

Tests use [testcontainers](https://testcontainers.com/) to spin up a real Redis instance — no mocking.

---

## 🔬 Areas for Improvement

> Contributions welcome! Here are known gaps and potential enhancements:

### Reliability
- [ ] **Dead Letter Queue (DLQ)** — jobs that exhaust all retries should flow into a permanent DLQ for manual inspection, not just the `failed` set
- [ ] **At-least-once guarantee audit** — verify the `moveToActive` → `complete`/`fail` path is fully atomic under all crash scenarios
- [ ] **Worker deregistration** — currently relies on TTL expiry; explicit deregistration on clean shutdown would be cleaner

### Observability
- [ ] **OpenTelemetry tracing** — add trace spans across enqueue → active → complete lifecycle
- [ ] **Prometheus metrics endpoint** — expose queue depths and throughput as `/metrics` for Grafana scraping
- [ ] **Structured error logging** — include job ID, queue name, attempt number in every log line

### Features
- [ ] **Job dependencies** — allow a job to declare that it should only run after another job completes
- [ ] **Bulk enqueue** — a `addBulk(jobs[])` method to add many jobs in a single pipeline call
- [ ] **Job progress webhooks** — optionally POST progress updates to a user-configured URL
- [ ] **Queue-level rate limits via API** — currently rate limits are set in worker config; expose them via the API and persist in Redis
- [ ] **Dashboard authentication** — the dashboard currently has no auth; add at minimum a basic token check
- [ ] **Dashboard search** — search jobs by ID or data field
- [ ] **Multi-tenant namespacing** — support a top-level prefix so multiple apps can share one Redis instance safely

### Code Quality
- [ ] **Stronger TypeScript generics** — `Queue<T>` is typed but `hydrateJob` loses type safety during Redis deserialization
- [ ] **E2E test coverage** — the test suite covers core paths but lacks end-to-end Docker-compose tests
- [ ] **`enqueue.lua` stores partial metadata** — the job hash written in Lua omits some fields that are only present on the in-memory `Job` object; a full re-hydration from `data` field patch is needed for correctness

---

## 📁 Project Structure

```
distributed-queue-engine/
├── src/
│   ├── server.ts          # Entry point — wires everything together
│   ├── Queue.ts           # Queue class — enqueue, metrics, cleanup, cron
│   ├── Worker.ts          # Worker class — polling, processing, heartbeat
│   ├── Scheduler.ts       # Cron scheduler — distributed lock + tick
│   ├── api.ts             # Express REST router
│   ├── shutdown.ts        # Graceful shutdown orchestrator
│   ├── scripts.ts         # Lua script loader (ioredis defineCommand)
│   ├── keys.ts            # Redis key naming conventions
│   ├── types.ts           # Shared TypeScript interfaces
│   ├── config.ts          # Env var validation
│   ├── redis.ts           # Redis singleton
│   ├── logger.ts          # JSON structured logging
│   └── lua/               # Atomic Redis Lua scripts
│       ├── enqueue.lua
│       ├── moveToActive.lua
│       ├── complete.lua
│       ├── fail.lua
│       ├── cancel.lua
│       ├── heartbeat.lua
│       ├── cleanStalled.lua
│       ├── cleanup.lua
│       └── updateProgress.lua
├── dashboard/             # React frontend (Vite)
├── tests/                 # Jest test suite (testcontainers)
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push to the branch: `git push origin feat/your-feature`
5. Open a Pull Request

Please make sure `npm test` passes before submitting. For large features, open an issue first to discuss the approach.

---

## 📄 License

MIT © [dhanushkumar-amk](https://github.com/dhanushkumar-amk)

---

<div align="center">

**Built with ❤️ using Node.js · TypeScript · Redis · Socket.IO · React**

</div>
