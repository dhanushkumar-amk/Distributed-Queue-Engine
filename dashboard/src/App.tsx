import React, { useState, useEffect, useCallback } from 'react';
import { 
  RefreshCw, 
  Search, 
  Trash2, 
  ArrowRight, 
  AlertCircle, 
  CheckCircle2, 
  Timer, 
  Activity, 
  LogOut,
  ChevronDown,
  Layers
} from 'lucide-react';

interface MetricSnapshot {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  delayed: number;
  rateLimitHit: number;
  throughput: number;
}

interface JobData {
  id: string;
  name: string;
  status: string;
  attempts: number;
  data: any;
  progress: number;
  runAt: number;
  processedOn?: number;
  finishedOn?: number;
  error?: string;
}

const POLL_INTERVAL = 3000;

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

  // Fetch queues list
  useEffect(() => {
    fetch('/api/queues')
      .then(r => r.json())
      .then(data => {
        if (data.queues && data.queues.length > 0) {
          setQueues(data.queues);
          setSelectedQueue(data.queues[0]);
        }
      })
      .catch(() => setError('Failed to connect to API server.'));
  }, []);

  // Main fetch function for dashboard
  const refreshData = useCallback(async (isManual = false) => {
    if (!selectedQueue) return;
    if (isManual) setIsRefreshing(true);

    try {
      const [mRes, jRes] = await Promise.all([
        fetch(`/api/queues/${selectedQueue}/metrics`),
        fetch(`/api/queues/${selectedQueue}/jobs?status=${statusFilter}&limit=50`)
      ]);

      if (mRes.ok && jRes.ok) {
        const m = await mRes.json();
        const j = await jRes.json();
        setMetrics(m.metrics);
        setJobs(j.jobs);
        setLastUpdated(new Date());
        setError(null);
      } else {
        setError(`Error: Failed to fetch data for ${selectedQueue}`);
      }
    } catch (err: any) {
      setError('Connection refused. Is the API server running?');
    } finally {
      if (isManual) setIsRefreshing(false);
      setLoading(false);
    }
  }, [selectedQueue, statusFilter]);

  // Polling loop
  useEffect(() => {
    if (!selectedQueue) return;
    refreshData();
    const timer = setInterval(refreshData, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [selectedQueue, statusFilter, refreshData]);

  // Actions
  const handleRetry = async (jobId: string) => {
    if (!confirm('Re-queue this failed job?')) return;
    await fetch(`/api/queues/${selectedQueue}/jobs/${jobId}/retry`, { method: 'POST' });
    refreshData(true);
  };

  const handleCancel = async (jobId: string) => {
    if (!confirm('Cancel this job?')) return;
    await fetch(`/api/queues/${selectedQueue}/jobs/${jobId}`, { method: 'DELETE' });
    refreshData(true);
  };

  if (loading && !error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <Activity className="h-10 w-10 text-blue-600 animate-pulse" />
          <span className="text-slate-600 font-medium">Connecting to Engine...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Navbar */}
      <header className="bg-white border-b border-slate-200 py-3 sticky top-0 z-10 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Layers className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">QueueControl</h1>
              <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                ACTIVE | CLUSTER MODE
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <select 
              value={selectedQueue} 
              onChange={e => setSelectedQueue(e.target.value)}
              className="bg-slate-100 border border-slate-200 text-sm rounded-md px-3 py-1.5 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            >
              {queues.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
            <button 
              onClick={() => refreshData(true)}
              className={`p-2 rounded-md transition-colors ${isRefreshing ? 'text-blue-600 animate-spin' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              <RefreshCw className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {error ? (
          <div className="bg-red-50 border border-red-100 text-red-700 p-4 rounded-lg flex items-center gap-3 mb-6">
            <AlertCircle className="h-5 w-5" />
            <p className="font-medium">{error}</p>
          </div>
        ) : null}

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          <StatCard label="Waiting" value={metrics?.waiting} color="amber" icon={<Timer />} />
          <StatCard label="Active" value={metrics?.active} color="blue" icon={<Activity />} />
          <StatCard label="Completed" value={metrics?.completed} color="emerald" icon={<CheckCircle2 />} />
          <StatCard label="Failed" value={metrics?.failed} color="rose" icon={<LogOut />} />
          <StatCard label="Delayed" value={metrics?.delayed} color="indigo" icon={<RefreshCw />} />
          <StatCard label="Throughput" value={metrics?.throughput || 0} unit="j/s" color="slate" icon={<ChevronDown className="rotate-180" />} />
        </div>

        {/* Jobs Section */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex gap-1 bg-slate-100 p-1 rounded-lg self-start">
              {['waiting', 'active', 'completed', 'failed', 'cancelled', 'delayed'].map(status => (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md capitalize transition-all ${
                    statusFilter === status 
                    ? 'bg-white text-blue-600 shadow-sm' 
                    : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>

            <div className="text-xs text-slate-400">
              Auto-refreshing every 3s • Last updated: {lastUpdated.toLocaleTimeString()}
            </div>
          </div>

          <div className="overflow-x-auto min-h-[400px]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50">
                  <th className="px-6 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Job ID</th>
                  <th className="px-6 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Name</th>
                  <th className="px-6 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider text-center">Status</th>
                  <th className="px-6 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Progress</th>
                  <th className="px-6 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-20 text-center text-slate-400 italic">
                      No jobs found in {statusFilter} state.
                    </td>
                  </tr>
                ) : (
                  jobs.map(job => (
                    <tr key={job.id} className="table-row-hover group">
                      <td className="px-6 py-4 text-xs font-mono text-slate-500">{job.id}</td>
                      <td className="px-6 py-4">
                        <div className="text-sm font-semibold capitalize">{job.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono truncate max-w-[200px]">
                          {JSON.stringify(job.data).substring(0, 40)}...
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`status-badge status-${job.status.toLowerCase()}`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                           <div className="flex-1 bg-slate-100 h-1.5 rounded-full overflow-hidden min-w-[80px]">
                              <div 
                                className={`h-full transition-all duration-500 ${job.status === 'ACTIVE' ? 'bg-blue-500' : 'bg-slate-300'}`}
                                style={{ width: `${job.progress}%` }}
                              ></div>
                           </div>
                           <span className="text-xs font-bold text-slate-500">{job.progress}%</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2">
                          {(job.status === 'WAITING' || job.status === 'ACTIVE') && (
                            <button 
                              onClick={() => handleCancel(job.id)}
                              className="p-1.5 rounded bg-slate-50 text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                              title="Cancel Job"
                            >
                              <ArrowRight className="h-4 w-4" />
                            </button>
                          )}
                          {job.status === 'FAILED' && (
                            <button 
                              onClick={() => handleRetry(job.id)}
                              className="p-1.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                              title="Retry Job"
                            >
                              <RefreshCw className="h-4 w-4" />
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
        </div>
      </main>
    </div>
  );
}

function StatCard({ label, value, color, unit, icon }: any) {
  const colors: Record<string, string> = {
    amber: 'bg-amber-100 text-amber-600 border-amber-200',
    blue: 'bg-blue-100 text-blue-600 border-blue-200',
    emerald: 'bg-emerald-100 text-emerald-600 border-emerald-200',
    rose: 'bg-rose-100 text-rose-600 border-rose-200',
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
    indigo: 'bg-indigo-100 text-indigo-600 border-indigo-200',
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:translate-y-[-2px] transition-all">
      <div className="flex justify-between items-start mb-2">
        <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
          {label}
        </span>
        <div className={`p-1.5 rounded-lg border ${colors[color] || colors.slate}`}>
          {React.cloneElement(icon, { size: 14 })}
        </div>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold">{value !== undefined ? value : '--'}</span>
        {unit && <span className="text-xs text-slate-400 font-medium">{unit}</span>}
      </div>
    </div>
  );
}
