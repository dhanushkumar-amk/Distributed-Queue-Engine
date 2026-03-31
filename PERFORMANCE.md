# 🚀 Performance Analysis & Benchmarking

This document tracks the high-throughput performance characteristics of the Distributed-Queue Engine.

## Benchmark Environment
- **CPU:** Local Machine (Simulated 4-core load)
- **Redis:** Localhost (v7.x)
- **Node.js:** v20+
- **Job Count:** 10,000
- **Worker Concurrency:** 4 Workers (50 concurrent slots per worker = 200 total)

## 📊 Results Summary

| Task | Throughput (Jobs/sec) | Duration (Seconds) |
| :--- | :--- | :--- |
| **Ingestion** (Add Jobs) | ~3,350 | ~2.98s |
| **Processing** (No-op) | ~2,500 | ~4.00s |

### 1. Ingestion Performance
- **Throughput:** ~3,350 jobs/sec.
- **Notes:** Ingestion is extremely fast due to our Lua `enqueue` script, which minimizes round-trips to Redis. Each job is indexed in a `ZSET` for priority and a `LIST` for FIFO processing in a single atomic operation.

### 2. Processing Throughput
- **Throughput:** ~2,500 jobs/sec.
- **Notes:** Processing involves `moveToActive` (Lua), execution (JS), and `complete` (Lua). With 4 simulated workers on a single machine, we manage high throughput even with heartbeat overhead.

### 3. Dashboard Latency
- **Observation:** During heavy processing (10k jobs), the dashboard remained responsive.
- **Stats:** Metrics updates (Socket.IO) continued at ~1s intervals. API requests for job lists (`/jobs/completed`) with pagination were handled in <50ms.
- **Conclusion:** Our use of `ioredis` and efficient Redis indexing ensures that administrative queries do not block or lag during high throughput.

## 🛠️ Optimizations Used
- **Lua Scripts:** Atomicity and speed (0 RTT for middle operations).
- **Round Robin Polling:** Workers rotate through queues to prevent hot-spotting.
- **Selective Indexing:** We only track what's necessary (id/priority) in sets, keeping primary data in hashes.
