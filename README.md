# Distributed Queue Engine 🚀

A high-performance, production-grade distributed job queue system built with Node.js, TypeScript, and Redis. This engine supports horizontal scaling, job prioritization, rate limiting, and real-time observability.

## ✨ Features

- **Distributed Architecture**: Multiple workers and dashboard instances can run concurrently.
- **Support for Multi-Queue**: Workers can listen to multiple queues with different priorities.
- **Job Prioritization**: Native support for high, medium, and low priority jobs.
- **Delayed Jobs**: Schedule jobs to run at a specific time in the future.
- **Rate Limiting**: Distributed rate limiting to prevent overwhelming downstream services.
- **Idempotency**: Automatic deduplication using user-provided `jobId`.
- **Graceful Shutdown**: Workers finish active jobs before exiting.
- **Resilience**: Automated watchdog for recovering stalled jobs.
- **Observability**: Structured JSON logging and comprehensive health checks.
- **Dashboard**: Real-time monitoring and management interface.

## 🏗️ Architecture

- **Redis**: The heart of the system, storing jobs, queues, and metadata using Atomic Lua scripts.
- **Worker**: Processes jobs from one or more queues.
- **Dashboard**: Provides an API and a React-based UI for monitoring and control.
- **Watchdog**: Periodically scans for "stalled" jobs (workers that crashed mid-job) and recovers them.

## 🚀 Quick Start (Docker)

The easiest way to run the full stack is using Docker Compose:

```bash
# Clone the repository
git clone <repo-url>
cd distributed-queue-engine

# Start the stack (Redis, 3 Workers, Dashboard)
docker-compose up -d
```

Access the dashboard at [http://localhost:3002](http://localhost:3002).

## 🛠️ Local Development

### Prerequisites
- Node.js 20+
- Redis 7+

### Setup
```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

### Running Components
```bash
# Start a worker (API disabled)
npm start -- --worker --queues=emails,notifications --no-api

# Start the dashboard (API enabled)
npm start -- --dashboard --api
```

## 📊 Monitoring

- **Health Checks**:
    - Dashboard: `GET /api/health`
    - Workers: Internal port (found in `/tmp/health_port` inside containers)
- **Logs**: All logs are emitted in structured JSON format.

## 📜 API Documentation

### Job Management
- `POST /api/queues/:queueName/jobs`: Enqueue a new job.
- `GET /api/queues/:queueName/jobs/:jobId`: Get job status.
- `DELETE /api/queues/:queueName/jobs/:jobId`: Cancel a job.

### Queue Management
- `GET /api/queues/:queueName/metrics`: Get queue depths and status.
- `POST /api/queues/:queueName/pause`: Pause a queue.
- `POST /api/queues/:queueName/resume`: Resume a queue.

## 🤝 Contributing
Feel free to open issues or submit pull requests for any feature requests or bug fixes.

## 📄 License
MIT
