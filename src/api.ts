import { Router, Request, Response } from 'express';
import { Queue } from './Queue';
import { CleanupOptions } from './types';

/**
 * Creates an Express router that exposes all queue management endpoints.
 *
 * Usage:
 *   const registry = { emails: new Queue('emails', redis) };
 *   app.use('/api', createQueueRouter(registry));
 */
export function createQueueRouter(registry: Record<string, Queue>): Router {
  const router = Router();

  // Helpers — cast Express 5 union params to plain strings
  const p = (req: Request, key: string): string => String((req.params as any)[key]);



  function resolveQueue(res: Response, name: string): Queue | null {
    const queue = registry[name];
    if (!queue) {
      res.status(404).json({ error: `Queue '${name}' not found.` });
      return null;
    }
    return queue;
  }

  // ─── GET /queues ──────────────────────────────────────────
  router.get('/queues', (_req: Request, res: Response) => {
    res.json({ queues: Object.keys(registry) });
  });

  // ─── GET /queues/:name/metrics ────────────────────────────
  router.get('/queues/:name/metrics', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const metrics = await queue.getMetrics();
      res.json({ queue: name, metrics });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/jobs?status=failed&limit=20 ────────
  router.get('/queues/:name/jobs', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;

    const status = String(req.query.status || 'waiting');
    const start = Math.max(parseInt(String(req.query.start || '0')), 0);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20')), 1), 100);
    const valid = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];

    if (!valid.includes(status)) {
      res.status(400).json({ error: `Invalid status. Use: ${valid.join(', ')}` });
      return;
    }

    try {
      const ids = await queue.getJobsByStatus(status, start, limit);
      const jobs = (await Promise.all(ids.map(id => queue.getJob(id)))).filter(Boolean);
      res.json({ queue: name, status, start, limit, count: jobs.length, jobs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/jobs/:id ───────────────────────────
  router.get('/queues/:name/jobs/:id', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const id = p(req, 'id');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const job = await queue.getJob(id);
      if (!job) { res.status(404).json({ error: `Job '${id}' not found.` }); return; }
      res.json({ job });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/jobs ──────────────────────────────
  router.post('/queues/:name/jobs', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;

    const { name: jobName, data, options } = req.body;
    if (!jobName || data === undefined) {
      res.status(400).json({ error: 'Body must include: { name, data, options? }' });
      return;
    }
    try {
      const job = await queue.add(jobName, data, options || {});
      res.status(201).json({ message: 'Job added.', job });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/jobs/:id/retry ────────────────────
  router.post('/queues/:name/jobs/:id/retry', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const id = p(req, 'id');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const ok = await queue.retry(id);
      if (!ok) { res.status(404).json({ error: `Job '${id}' not found in failed set.` }); return; }
      res.json({ message: `Job '${id}' re-queued.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── DELETE /queues/:name/jobs/:id ────────────────────────
  router.delete('/queues/:name/jobs/:id', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const id = p(req, 'id');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const ok = await queue.cancel(id);
      if (!ok) { res.status(404).json({ error: `Job '${id}' could not be cancelled.` }); return; }
      res.json({ message: `Job '${id}' cancelled.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/cleanup ───────────────────────────
  router.post('/queues/:name/cleanup', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;

    const options: CleanupOptions = { maxAge: req.body.maxAge, maxCount: req.body.maxCount };
    if (!options.maxAge && !options.maxCount) {
      res.status(400).json({ error: 'Provide maxAge (ms) and/or maxCount.' });
      return;
    }
    try {
      const result = await queue.runCleanup(options);
      const total = result.completed + result.failed + result.cancelled;
      res.json({ message: `Pruned ${total} job(s).`, details: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /health ──────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), queues: Object.keys(registry).length });
  });

  return router;
}
