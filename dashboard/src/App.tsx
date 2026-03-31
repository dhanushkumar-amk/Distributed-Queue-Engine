import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw,
  Search,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Timer,
  Activity,
  LogOut,
  Layers,
  Radio,
  X,
  Info,
  Calendar,
  Hash,
  Cpu,
  BarChart2,
  RotateCcw,
  ChevronDown,
  Clock,
  Pause,
  Play,
  SkipForward,
  Eraser,
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';

// ─── Types ────────────────────────────────────────────────────────────────────
interface MetricSnapshot {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  delayed: number;
  /** Phase 36: p50/p95/p99 latency in ms, null when no data */
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

interface JobData {
  id: string;
  name: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  data: any;
  progress: number;
  runAt: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  error?: { message: string; stack?: string } | string;
  priority: string;
  queueName?: string;
}

interface ThroughputBucket {
  time: string;
  completed: number;
  failed: number;
}

// Phase 38: Worker status data from Redis hash
interface WorkerInfo {
  pid: string;
  host: string;
  queues: string;
  startedAt: string;
  jobsProcessed: string;
  currentJob: string;
  lastHeartbeat: string;
  concurrency: string;
}


const PAGE_SIZE = 25;
const POLL_INTERVAL = 5000;
const THROUGHPUT_POLL = 30000;

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [queues, setQueues] = useState<string[]>([]);
  const [selectedQueue, setSelectedQueue] = useState<string>('');
  const [metrics, setMetrics] = useState<MetricSnapshot | null>(null);
  const [jobs, setJobs] = useState<JobData[]>([]);
  const [statusFilter, setStatusFilter] = useState('waiting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [selectedJob, setSelectedJob] = useState<JobData | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [throughput, setThroughput] = useState<ThroughputBucket[]>([]);
  const [showChart, setShowChart] = useState(false);
  // Phase 37 state
  const [isPaused, setIsPaused] = useState(false);
  const [isRetryingAll, setIsRetryingAll] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isTogglingPause, setIsTogglingPause] = useState(false);
  // Phase 38 state
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [showWorkers, setShowWorkers] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  // Fetch queue list on mount
  useEffect(() => {
    fetch('/api/queues')
      .then(r => r.json())
      .then(data => {
        if (data.queues?.length > 0) {
          setQueues(data.queues);
          setSelectedQueue(data.queues[0]);
        }
      })
      .catch(() => setError('Cluster API unreachable. Verify server status.'));
  }, []);

  // Phase 37: Poll pause state whenever queue changes
  useEffect(() => {
    if (!selectedQueue) return;
    const checkPause = () =>
      fetch(`/api/queues/${selectedQueue}/pause`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setIsPaused(d.paused); })
        .catch(() => {});
    checkPause();
    const t = setInterval(checkPause, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [selectedQueue]);

  // Phase 38: Poll /api/workers every 10s (independent of selected queue)
  useEffect(() => {
    const fetchWorkers = () =>
      fetch('/api/workers')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.workers) setWorkers(d.workers); })
        .catch(() => {});
    fetchWorkers();
    const t = setInterval(fetchWorkers, 10000);
    return () => clearInterval(t);
  }, []);

  // Fetch throughput data
  const fetchThroughput = useCallback(async () => {
    if (!selectedQueue) return;
    try {
      const res = await fetch(`/api/queues/${selectedQueue}/throughput`);
      if (res.ok) {
        const data = await res.json();
        setThroughput(data.buckets || []);
      }
    } catch {}
  }, [selectedQueue]);

  // Periodic throughput refresh
  useEffect(() => {
    fetchThroughput();
    const t = setInterval(fetchThroughput, THROUGHPUT_POLL);
    return () => clearInterval(t);
  }, [fetchThroughput]);

  const refreshDashboard = useCallback(async (isManual = false) => {
    if (!selectedQueue) return;
    if (isManual) setIsRefreshing(true);
    try {
      const [mRes, jRes] = await Promise.all([
        fetch(`/api/queues/${selectedQueue}/metrics`),
        fetch(`/api/queues/${selectedQueue}/jobs?status=${statusFilter}&limit=${PAGE_SIZE}&start=0`),
      ]);
      if (mRes.ok && jRes.ok) {
        const m = await mRes.json();
        const j = await jRes.json();
        setMetrics(m.metrics);
        setJobs(j.jobs || []);
        setHasMore((j.jobs || []).length === PAGE_SIZE);
        setLastUpdated(new Date());
        setError(null);
      }
    } catch {
      setError('Connection interrupted.');
    } finally {
      if (isManual) setIsRefreshing(false);
      setLoading(false);
    }
  }, [selectedQueue, statusFilter]);

  const loadMoreJobs = async () => {
    if (!selectedQueue || isRefreshing) return;
    setIsRefreshing(true);
    try {
      const res = await fetch(`/api/queues/${selectedQueue}/jobs?status=${statusFilter}&limit=${PAGE_SIZE}&start=${jobs.length}`);
      if (res.ok) {
        const data = await res.json();
        setJobs(prev => [...prev, ...(data.jobs || [])]);
        setHasMore((data.jobs || []).length === PAGE_SIZE);
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  // Socket.IO live feed
  useEffect(() => {
    const socket = io('http://localhost:3000');
    socketRef.current = socket;
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('job-event', (data: any) => {
      if (data.queueName !== selectedQueue) return;

      // Optimistic metric updates
      setMetrics(prev => {
        if (!prev) return null;
        const next = { ...prev };
        if (data.event === 'job:active')     { next.waiting = Math.max(0, next.waiting - 1); next.active++; }
        if (data.event === 'job:completed')  { next.active  = Math.max(0, next.active - 1);  next.completed++; }
        if (data.event === 'job:failed')     { next.active  = Math.max(0, next.active - 1);  next.failed++; }
        if (data.event === 'job:added')      { next.waiting++; }
        return next;
      });

      // Live increment current-minute throughput bucket on completion (Phase 35)
      if (data.event === 'job:completed' || data.event === 'job:failed') {
        setThroughput(prev => {
          if (!prev.length) return prev;
          const copy = [...prev];
          const last = { ...copy[copy.length - 1] };
          if (data.event === 'job:completed') last.completed++;
          else last.failed++;
          copy[copy.length - 1] = last;
          return copy;
        });
      }

      // Update job row in table
      setJobs(prev => prev.map(job => {
        if (job.id !== data.jobId) return job;
        const u = { ...job };
        if (data.event === 'job:progress')  u.progress = data.progress;
        if (data.event === 'job:active')    u.status = 'ACTIVE';
        if (data.event === 'job:completed') u.status = 'COMPLETED';
        if (data.event === 'job:failed')    { u.status = 'FAILED'; u.error = data.error; }
        return u;
      }));

      // Update open modal
      if (selectedJob?.id === data.jobId) {
        setSelectedJob(prev => {
          if (!prev) return null;
          const u = { ...prev };
          if (data.event === 'job:progress')  u.progress = data.progress;
          if (data.event === 'job:active')    u.status = 'ACTIVE';
          if (data.event === 'job:completed') u.status = 'COMPLETED';
          if (data.event === 'job:failed')    { u.status = 'FAILED'; u.error = data.error; }
          return u;
        });
      }

      setLastUpdated(new Date());
    });

    return () => { socket.disconnect(); };
  }, [selectedQueue, selectedJob]);

  // Periodic refresh
  useEffect(() => {
    if (!selectedQueue) return;
    refreshDashboard();
    const t = setInterval(refreshDashboard, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [selectedQueue, statusFilter, refreshDashboard]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const retryJob = async (jobId: string) => {
    if (!selectedQueue) return;
    try {
      const res = await fetch(`/api/queues/${selectedQueue}/jobs/${jobId}/retry`, { method: 'POST' });
      if (res.ok) {
        setSelectedJob(null);
        refreshDashboard(true);
      }
    } catch (err) {
      console.error('Retry failed:', err);
    }
  };

  const runCleanup = async () => {
    if (!confirm('This will purge older records. Continue?')) return;
    setIsCleaning(true);
    try {
      await fetch(`/api/queues/${selectedQueue}/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxCount: 1, maxAge: 1 }),
      });
      refreshDashboard(true);
    } finally {
      setIsCleaning(false);
    }
  };

  // Phase 37: Retry all failed jobs in one click
  const retryAllFailed = async () => {
    if (!selectedQueue) return;
    if (!confirm('Re-queue ALL failed jobs?')) return;
    setIsRetryingAll(true);
    try {
      const res = await fetch(`/api/queues/${selectedQueue}/retry-all`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        alert(`✅ Re-queued ${data.count} job(s)`);
        setStatusFilter('waiting');
        refreshDashboard(true);
      }
    } finally {
      setIsRetryingAll(false);
    }
  };

  // Phase 37: Clear completed jobs older than 1 hour
  const clearOldCompleted = async () => {
    if (!selectedQueue) return;
    if (!confirm('Clear completed jobs older than 1 hour?')) return;
    setIsClearing(true);
    try {
      const res = await fetch(`/api/queues/${selectedQueue}/jobs/completed`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        alert(`🗑️ Cleared ${data.count} job(s)`);
        refreshDashboard(true);
      }
    } finally {
      setIsClearing(false);
    }
  };

  // Phase 37: Toggle queue pause/resume
  const togglePause = async () => {
    if (!selectedQueue) return;
    setIsTogglingPause(true);
    try {
      const method = isPaused ? 'DELETE' : 'POST';
      const res = await fetch(`/api/queues/${selectedQueue}/pause`, { method });
      if (res.ok) {
        setIsPaused(!isPaused);
      }
    } finally {
      setIsTogglingPause(false);
    }
  };

  // ── Error state ────────────────────────────────────────────────────────────
  if (loading && !error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#F8FAFC]">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <Activity className="h-12 w-12 text-blue-600 animate-pulse" />
            <div className="absolute inset-0 bg-blue-400 blur-2xl opacity-20 animate-pulse"></div>
          </div>
          <span className="text-slate-500 font-bold tracking-[0.2em] text-xs uppercase animate-pulse">
            Link Established...
          </span>
        </div>
      </div>
    );
  }

  const errorMsg = typeof selectedJob?.error === 'object'
    ? selectedJob?.error?.message
    : selectedJob?.error as string | undefined;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 font-sans antialiased">

      {/* Header */}
      <header className="bg-white/80 backdrop-blur-xl border-b border-slate-200/60 h-20 sticky top-0 z-40 flex items-center shadow-sm">
        <div className="max-w-7xl mx-auto px-8 w-full flex justify-between items-center">
          <div className="flex items-center gap-5">
            <div className="bg-blue-600 h-11 w-11 rounded-[14px] flex items-center justify-center shadow-lg shadow-blue-500/20 rotate-3 transform hover:rotate-0 transition-all duration-300">
              <Layers className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-slate-800 leading-none mb-1.5 flex items-center gap-2">
                Q-ENGINE
                <span className="bg-slate-100 text-slate-400 text-[9px] px-1.5 py-0.5 rounded-md font-mono border border-slate-200">v1.3</span>
              </h1>
              <div className="flex items-center gap-2">
                <div className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]'}`}></div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest font-mono">
                  {isConnected ? 'LIVE FEED ACTIVE' : 'NODE DISCONNECTED'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 bg-slate-50 border border-slate-200/80 rounded-xl px-4 py-2 hover:border-slate-300 transition-colors cursor-pointer group">
              <Radio className="h-4 w-4 text-slate-400 group-hover:text-blue-500 transition-colors" />
              <select
                value={selectedQueue}
                onChange={e => setSelectedQueue(e.target.value)}
                className="bg-transparent text-sm font-bold text-slate-600 outline-none cursor-pointer appearance-none pr-4"
              >
                {queues.map(q => <option key={q} value={q}>{q}</option>)}
              </select>
            </div>

            {/* Toggle throughput chart */}
            <button
              onClick={() => setShowChart(v => !v)}
              className={`h-10 w-10 flex items-center justify-center rounded-xl border transition-all ${showChart ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-200 bg-white text-slate-400 hover:text-slate-900 hover:bg-slate-50'}`}
              title="Toggle throughput chart"
            >
              <BarChart2 className="h-5 w-5" />
            </button>

            {/* Phase 37 — Pause / Resume */}
            <button
              onClick={togglePause}
              disabled={isTogglingPause}
              title={isPaused ? 'Resume queue' : 'Pause queue'}
              className={`h-10 px-4 flex items-center gap-2 rounded-xl border text-xs font-black uppercase tracking-wider transition-all active:scale-95 disabled:opacity-50
                ${isPaused
                  ? 'bg-amber-500 border-amber-500 text-white shadow-lg shadow-amber-200'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-600'}`}
            >
              {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {isPaused ? 'Resume' : 'Pause'}
            </button>

            {/* Phase 37 — Retry All Failed */}
            <button
              onClick={retryAllFailed}
              disabled={isRetryingAll || !metrics?.failed}
              title="Retry all failed jobs"
              className="h-10 px-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-500 text-xs font-black uppercase tracking-wider hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-600 transition-all active:scale-95 disabled:opacity-40"
            >
              <SkipForward className="h-4 w-4" />
              Retry All
              {metrics?.failed ? <span className="bg-rose-100 text-rose-600 text-[9px] px-1.5 py-0.5 rounded-full font-mono">{metrics.failed}</span> : null}
            </button>

            {/* Phase 37 — Clear Completed */}
            <button
              onClick={clearOldCompleted}
              disabled={isClearing}
              title="Clear completed jobs older than 1 hour"
              className="h-10 px-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white text-slate-500 text-xs font-black uppercase tracking-wider hover:bg-rose-50 hover:border-rose-300 hover:text-rose-600 transition-all active:scale-95 disabled:opacity-40"
            >
              <Eraser className="h-4 w-4" />
              Clear Done
            </button>

            {/* Phase 38 — Toggle Workers Panel */}
            <button
              onClick={() => setShowWorkers(v => !v)}
              title="Toggle worker status panel"
              className={`h-10 px-4 flex items-center gap-2 rounded-xl border text-xs font-black uppercase tracking-wider transition-all active:scale-95
                ${showWorkers
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600'}`}
            >
              <Cpu className="h-4 w-4" />
              Workers
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono ${showWorkers ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{workers.length}</span>
            </button>

            <button
              onClick={() => refreshDashboard(true)}
              className={`h-10 w-10 flex items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm transition-all active:scale-95 ${isRefreshing ? 'text-blue-600' : 'text-slate-400 hover:text-slate-900 hover:bg-slate-50'}`}
            >
              <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>


      <main className="max-w-7xl mx-auto px-8 py-12">

        {/* Error banner */}
        {error && (
          <div className="bg-rose-50/50 border border-rose-200/50 p-6 rounded-[20px] mb-12 flex items-center gap-5">
            <div className="bg-rose-500/10 p-3 rounded-2xl">
              <AlertCircle className="h-6 w-6 text-rose-600" />
            </div>
            <div className="flex-1">
              <h3 className="text-rose-900 font-black text-sm uppercase tracking-wide">Protocol Violation</h3>
              <p className="text-rose-700/80 text-sm font-medium">{error}</p>
            </div>
          </div>
        )}

        {/* Metric cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-8">
          <StatCard label="WAITING"   value={metrics?.waiting}   color="amber"   icon={<Timer />} />
          <StatCard label="ACTIVE"    value={metrics?.active}    color="blue"    icon={<Activity />} />
          <StatCard label="COMPLETED" value={metrics?.completed} color="emerald" icon={<CheckCircle2 />} />
          <StatCard label="FAILED"    value={metrics?.failed}    color="rose"    icon={<LogOut />} />
        </div>

        {/* ── Phase 36: Latency Percentiles ───────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <LatencyCard label="P50 Latency" subtitle="Median" value={metrics?.p50 ?? null} color="violet" />
          <LatencyCard label="P95 Latency" subtitle="95th percentile" value={metrics?.p95 ?? null} color="orange" />
          <LatencyCard label="P99 Latency" subtitle="99th percentile" value={metrics?.p99 ?? null} color="rose" />
        </div>

        {/* ── Phase 38: Worker Status Panel ────────────────────────────────── */}
        {showWorkers && (
          <div className="bg-white rounded-[32px] border border-slate-200/60 shadow-xl shadow-slate-200/40 p-10 mb-12">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <div className="bg-blue-50 p-2.5 rounded-2xl">
                  <Cpu className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-800 uppercase tracking-tight">Worker Status Panel</h2>
                  <p className="text-[10px] text-slate-400 font-bold mt-0.5">Live — refreshes every 10s · green &lt;15s · yellow 15-30s · red &gt;30s</p>
                </div>
              </div>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{workers.length} worker{workers.length !== 1 ? 's' : ''} online</span>
            </div>
            {workers.length === 0 ? (
              <div className="h-32 flex items-center justify-center text-slate-400 text-sm font-bold">
                No active workers detected — start a worker process first
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {workers.map((w, i) => <WorkerCard key={`${w.pid}-${w.queues}-${i}`} worker={w} />)}
              </div>
            )}
          </div>
        )}

        {/* ── Phase 35: Throughput Chart ───────────────────────────────────── */}
        {showChart && (
          <div className="bg-white rounded-[32px] border border-slate-200/60 shadow-xl shadow-slate-200/40 p-10 mb-12">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <div className="bg-blue-50 p-2.5 rounded-2xl">
                  <BarChart2 className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-800 uppercase tracking-tight">Throughput — Last 10 Minutes</h2>
                  <p className="text-[10px] text-slate-400 font-bold mt-0.5">Jobs/min · auto-refreshes every 30s</p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-[10px] font-black uppercase tracking-widest">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400 inline-block"></span>Completed</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-400 inline-block"></span>Failed</span>
              </div>
            </div>

            {throughput.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm font-bold">
                No data yet — run some jobs first
              </div>
            ) : (
              <ThroughputChart buckets={throughput} />
            )}
          </div>
        )}

        {/* ── Job Table ──────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-[32px] border border-slate-200/60 shadow-2xl shadow-slate-200/40 overflow-hidden">
          {/* Toolbar */}
          <div className="px-10 py-8 flex flex-col xl:flex-row xl:items-center justify-between gap-8 border-b border-slate-100">
            <div className="flex flex-wrap gap-2 bg-slate-50 p-1.5 rounded-[20px] border border-slate-100">
              {['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'].map(status => (
                <button
                  key={status}
                  onClick={() => { setStatusFilter(status); setJobs([]); }}
                  className={`px-6 py-2.5 text-xs font-black rounded-2xl capitalize transition-all duration-300 ${
                    statusFilter === status
                      ? 'bg-white text-blue-600 shadow-xl shadow-blue-500/10 border border-slate-100'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  {status}
                  {status === 'waiting'   && metrics ? ` (${metrics.waiting})`   : ''}
                  {status === 'active'    && metrics ? ` (${metrics.active})`    : ''}
                  {status === 'completed' && metrics ? ` (${metrics.completed})` : ''}
                  {status === 'failed'    && metrics ? ` (${metrics.failed})`    : ''}
                  {status === 'delayed'   && metrics ? ` (${metrics.delayed})`   : ''}
                  {status === 'cancelled' && metrics ? ` (${metrics.cancelled})` : ''}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={runCleanup}
                disabled={isCleaning}
                className="flex items-center gap-2.5 px-6 h-11 bg-slate-900 text-white text-xs font-black rounded-2xl hover:bg-slate-800 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                PRUNE TRACE
              </button>
              <div className="h-10 px-4 flex items-center gap-3 bg-blue-50/50 border border-blue-100 text-[10px] font-black text-blue-600 rounded-2xl uppercase tracking-widest whitespace-nowrap">
                <Clock className="h-3 w-3" />
                {lastUpdated.toLocaleTimeString()}
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="pl-10 pr-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">ID</th>
                  <th className="px-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Job Name</th>
                  <th className="px-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-center">Status</th>
                  <th className="px-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Progress</th>
                  <th className="pl-4 pr-10 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.length === 0 && !isRefreshing ? (
                  <tr>
                    <td colSpan={5} className="py-32 text-center">
                      <div className="flex flex-col items-center opacity-40">
                        <Search className="h-10 w-10 mb-4 text-slate-400" />
                        <p className="text-sm font-black uppercase tracking-[0.1em]">No records found</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => (
                    <tr
                      key={job.id}
                      className="group cursor-pointer hover:bg-slate-50/80 transition-all duration-300"
                      onClick={() => setSelectedJob(job)}
                    >
                      <td className="pl-10 pr-4 py-6 font-mono text-[11px] text-slate-400 group-hover:text-slate-900 transition-colors">
                        #{job.id.substring(0, 8)}
                      </td>
                      <td className="px-4 py-6">
                        <div className="text-sm font-black text-slate-800 leading-none mb-1.5 uppercase tracking-tight">{job.name}</div>
                        <div className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200/50 inline-block">
                          {job.priority || 'normal'}
                        </div>
                      </td>
                      <td className="px-4 py-6 text-center">
                        <span className={`inline-flex items-center px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border-2 transition-all group-hover:scale-105 ${
                          job.status === 'ACTIVE'    ? 'bg-blue-50 text-blue-600 border-blue-100 shadow-lg shadow-blue-500/10' :
                          job.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                          job.status === 'FAILED'    ? 'bg-rose-50 text-rose-600 border-rose-100' :
                          job.status === 'CANCELLED' ? 'bg-slate-100 text-slate-500 border-slate-200' :
                          'bg-amber-50 text-amber-600 border-amber-100'
                        }`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="px-4 py-6">
                        <div className="flex items-center gap-4">
                          <div className="flex-1 bg-slate-100 h-3 rounded-full overflow-hidden max-w-[120px] border border-slate-200/50">
                            <div
                              className={`h-full transition-all duration-1000 ${
                                job.status === 'ACTIVE'    ? 'bg-blue-600 shadow-[0_0_12px_rgba(37,99,235,0.4)]' :
                                job.status === 'COMPLETED' ? 'bg-emerald-500' :
                                job.status === 'FAILED'    ? 'bg-rose-400' : 'bg-slate-300'
                              }`}
                              style={{ width: `${job.progress ?? 0}%` }}
                            ></div>
                          </div>
                          <span className="text-[11px] font-black text-slate-800 w-10">{job.progress ?? 0}%</span>
                        </div>
                      </td>
                      <td className="pl-4 pr-10 py-6 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="h-9 w-9 flex items-center justify-center rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                            title="View details"
                          >
                            <Info className="h-4 w-4" />
                          </button>
                          {job.status === 'FAILED' && (
                            <button
                              onClick={e => { e.stopPropagation(); retryJob(job.id); }}
                              className="h-9 w-9 flex items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-colors"
                              title="Retry job"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="px-10 py-10 flex justify-center border-t border-slate-100">
              <button
                onClick={loadMoreJobs}
                disabled={isRefreshing}
                className="px-12 h-12 bg-white border-2 border-slate-200 text-xs font-black text-slate-900 rounded-2xl hover:border-slate-800 transition-all flex items-center gap-3 active:scale-95 disabled:opacity-50"
              >
                {isRefreshing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
                FETCH NEXT SEGMENT
              </button>
            </div>
          )}
        </div>
      </main>

      {/* ── Job Detail Modal ──────────────────────────────────────────────────── */}
      {selectedJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" onClick={() => setSelectedJob(null)}></div>
          <div className="bg-white w-full max-w-2xl rounded-[32px] shadow-[0_32px_128px_rgba(15,23,42,0.4)] relative z-10 overflow-hidden">

            {/* Modal Header */}
            <div className="px-10 py-8 border-b border-slate-100 flex items-center justify-between bg-white sticky top-0">
              <div className="flex items-center gap-4">
                <div className="bg-slate-100 p-2.5 rounded-2xl">
                  <Cpu className="h-6 w-6 text-slate-900" />
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-800 leading-none mb-1.5 uppercase tracking-tighter">
                    {selectedJob.name}
                  </h2>
                  <p className="text-xs font-bold text-slate-400 font-mono tracking-widest">
                    {selectedJob.id}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedJob(null)}
                className="h-10 w-10 flex items-center justify-center rounded-full bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="px-10 py-10 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-6 mb-10">
                <MetaItem icon={<Calendar />} label="Queued At"   value={new Date(selectedJob.runAt).toLocaleString()} />
                <MetaItem icon={<Hash />}     label="Retries"     value={`${selectedJob.attempts} / ${selectedJob.maxAttempts}`} />
                <MetaItem icon={<Activity />} label="Status"      value={selectedJob.status} />
                <MetaItem icon={<Info />}     label="Priority"    value={selectedJob.priority || 'normal'} />
              </div>

              {/* Error block */}
              {selectedJob.error && (
                <div className="bg-rose-50 border border-rose-100 p-6 rounded-2xl mb-8">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="h-4 w-4 text-rose-600" />
                    <span className="text-[10px] font-black text-rose-600 uppercase tracking-widest">Execution Fault</span>
                  </div>
                  <p className="text-xs font-mono text-rose-800 break-words leading-relaxed">{errorMsg}</p>
                </div>
              )}

              {/* Data payload */}
              <div className="space-y-4">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">
                  Payload
                </span>
                <div className="bg-slate-900 rounded-3xl p-8 font-mono text-[13px] text-blue-100 leading-relaxed overflow-x-auto border-4 border-slate-800 shadow-2xl">
                  <pre>{JSON.stringify(selectedJob.data, null, 2)}</pre>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-10 py-8 bg-slate-50/50 border-t border-slate-100 flex justify-end gap-3">
              <button
                onClick={() => setSelectedJob(null)}
                className="px-8 h-12 text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors"
              >
                DISMISS
              </button>
              {selectedJob.status === 'FAILED' && (
                <button
                  onClick={() => retryJob(selectedJob.id)}
                  className="px-8 h-12 bg-blue-600 text-white text-xs font-black rounded-2xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 active:scale-95 flex items-center gap-2"
                >
                  <RotateCcw className="h-4 w-4" />
                  RE-TRIGGER
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WorkerCard (Phase 38) ────────────────────────────────────────────────────
function WorkerCard({ worker }: { worker: WorkerInfo }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const lastBeat   = parseInt(worker.lastHeartbeat || '0', 10);
  const age        = Math.floor((now - lastBeat) / 1000);

  // Color rules: green < 15s, yellow 15-30s, red > 30s
  const statusColor =
    age < 15  ? { dot: 'bg-emerald-500', border: 'border-emerald-100', ring: 'shadow-emerald-200/60', label: 'text-emerald-600', badge: 'bg-emerald-50 text-emerald-600' } :
    age < 30  ? { dot: 'bg-amber-400',   border: 'border-amber-100',   ring: 'shadow-amber-200/60',   label: 'text-amber-600',   badge: 'bg-amber-50 text-amber-600'   } :
                { dot: 'bg-rose-500',    border: 'border-rose-100',    ring: 'shadow-rose-200/60',    label: 'text-rose-600',    badge: 'bg-rose-50 text-rose-600'     };

  const startedAgo = Math.floor((now - parseInt(worker.startedAt || '0', 10)) / 1000);
  const uptimeFmt  = startedAgo < 60   ? `${startedAgo}s`
                   : startedAgo < 3600 ? `${Math.floor(startedAgo / 60)}m`
                   : `${Math.floor(startedAgo / 3600)}h ${Math.floor((startedAgo % 3600) / 60)}m`;

  return (
    <div className={`bg-white border ${statusColor.border} rounded-[20px] p-6 shadow-md ${statusColor.ring} hover:shadow-xl transition-all duration-300`}>
      {/* Header: PID + heartbeat dot */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className={`h-2.5 w-2.5 rounded-full ${statusColor.dot} shadow-[0_0_8px_currentColor] animate-pulse`} />
          <span className="text-xs font-black text-slate-700 font-mono">PID {worker.pid}</span>
        </div>
        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-lg ${statusColor.badge}`}>
          {age < 15 ? 'LIVE' : age < 30 ? 'STALE' : 'DEAD'}
        </span>
      </div>

      {/* Stats */}
      <div className="space-y-2.5">
        <Row label="Host"       value={worker.host} />
        <Row label="Queues"     value={worker.queues} />
        <Row label="Uptime"     value={uptimeFmt} />
        <Row label="Jobs Done"  value={worker.jobsProcessed || '0'} />
        <Row label="Concurrency" value={worker.concurrency || '1'} />
        {worker.currentJob && (
          <Row label="Current Job" value={worker.currentJob.length > 24 ? `${worker.currentJob.slice(0, 24)}\u2026` : worker.currentJob} />
        )}
      </div>

      {/* Last heartbeat footer */}
      <div className={`mt-4 text-[9px] font-bold uppercase tracking-widest ${statusColor.label}`}>
        Last heartbeat: {age < 5 ? 'just now' : `${age}s ago`}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{label}</span>
      <span className="text-[11px] font-bold text-slate-700 font-mono max-w-[60%] text-right truncate">{value}</span>
    </div>
  );
}

// ─── Throughput Chart (Phase 35) ──────────────────────────────────────────────
function ThroughputChart({ buckets }: { buckets: ThroughputBucket[] }) {
  const maxVal = Math.max(...buckets.flatMap(b => [b.completed, b.failed]), 1);

  return (
    <div className="h-52 flex items-end gap-2">
      {buckets.map((b, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div className="w-full flex flex-col items-center justify-end gap-0.5" style={{ height: '180px' }}>
            {/* Completed bar */}
            <div
              className="w-full rounded-t-md bg-emerald-400 transition-all duration-700"
              style={{ height: `${(b.completed / maxVal) * 160}px`, minHeight: b.completed > 0 ? 4 : 0 }}
              title={`${b.completed} completed`}
            />
            {/* Failed bar */}
            <div
              className="w-full rounded-b-md bg-rose-400 transition-all duration-700"
              style={{ height: `${(b.failed / maxVal) * 160}px`, minHeight: b.failed > 0 ? 4 : 0 }}
              title={`${b.failed} failed`}
            />
          </div>
          <span className="text-[9px] font-bold text-slate-400 whitespace-nowrap">{b.time}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Latency Card (Phase 36) ──────────────────────────────────────────────────
function LatencyCard({ label, subtitle, value, color }: {
  label: string;
  subtitle: string;
  value: number | null | undefined;
  color: string;
}) {
  const themes: Record<string, any> = {
    violet: { color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-100/60', accent: 'bg-violet-500/10', bar: 'bg-violet-400' },
    orange: { color: 'text-orange-500', bg: 'bg-orange-50', border: 'border-orange-100/60', accent: 'bg-orange-500/10', bar: 'bg-orange-400' },
    rose:   { color: 'text-rose-500',   bg: 'bg-rose-50',   border: 'border-rose-100/60',   accent: 'bg-rose-500/10',   bar: 'bg-rose-400'   },
  };
  const t = themes[color] || themes.violet;

  // Format ms -> readable string
  const fmt = (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined) return '--';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // Cap bar at 5000ms for visual purposes
  const pct = value != null ? Math.min((value / 5000) * 100, 100) : 0;

  return (
    <div className={`bg-white border ${t.border} rounded-[24px] p-7 shadow-sm hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-500 group`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{label}</p>
          <p className="text-[9px] font-bold text-slate-300 uppercase tracking-widest mt-0.5">{subtitle}</p>
        </div>
        <div className={`${t.accent} ${t.color} h-10 w-10 rounded-xl flex items-center justify-center text-[11px] font-black`}>
          p{label.replace(/[^0-9]/g, '')}
        </div>
      </div>
      <div className={`text-3xl font-black tracking-tighter ${t.color} mb-4`}>
        {fmt(value)}
      </div>
      {/* Gauge bar */}
      <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${t.bar}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[9px] font-bold text-slate-300 mt-1.5 text-right">
        {value != null ? `${Math.round(pct)}% of 5s scale` : 'no data yet'}
      </p>
    </div>
  );
}

// ─── Shared UI Components ─────────────────────────────────────────────────────
function StatCard({ label, value, color, icon }: any) {
  const themes: Record<string, any> = {
    amber:   { color: 'text-amber-500',   bg: 'bg-amber-50',   border: 'border-amber-100/50',   accent: 'bg-amber-500/10'   },
    blue:    { color: 'text-blue-600',    bg: 'bg-blue-50',    border: 'border-blue-100/50',    accent: 'bg-blue-600/10'    },
    emerald: { color: 'text-emerald-500', bg: 'bg-emerald-50', border: 'border-emerald-100/50', accent: 'bg-emerald-500/10' },
    rose:    { color: 'text-rose-500',    bg: 'bg-rose-50',    border: 'border-rose-100/50',    accent: 'bg-rose-500/10'    },
  };
  const theme = themes[color] || themes.blue;

  return (
    <div className={`bg-white border ${theme.border} rounded-[28px] p-8 shadow-sm hover:shadow-2xl hover:shadow-slate-200/50 transition-all duration-500 group relative overflow-hidden`}>
      <div className={`absolute -right-4 -top-4 h-24 w-24 rounded-full ${theme.bg} opacity-0 group-hover:opacity-100 scale-50 group-hover:scale-100 transition-all duration-700`}></div>
      <div className="flex items-center gap-5 mb-6 relative z-10">
        <div className={`${theme.accent} ${theme.color} h-12 w-12 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform duration-500`}>
          {React.cloneElement(icon, { size: 20, strokeWidth: 2.5 })}
        </div>
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{label}</span>
      </div>
      <div className="relative z-10 flex items-baseline gap-2">
        <span className={`text-4xl font-black tracking-tighter ${theme.color}`}>
          {value !== undefined ? value.toLocaleString() : '--'}
        </span>
        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">jobs</span>
      </div>
    </div>
  );
}

function MetaItem({ icon, label, value }: any) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-2xl border border-slate-100 bg-slate-50/30">
      <div className="text-slate-400 mt-0.5">{React.cloneElement(icon, { size: 16 })}</div>
      <div>
        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">{label}</div>
        <div className="text-xs font-bold text-slate-800">{value}</div>
      </div>
    </div>
  );
}
