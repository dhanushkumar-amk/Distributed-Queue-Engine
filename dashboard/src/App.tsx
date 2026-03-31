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
  Cpu
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';

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
  maxAttempts: number;
  data: any;
  progress: number;
  runAt: number;
  processedOn?: number;
  finishedOn?: number;
  error?: string;
  priority: string;
}

const PAGE_SIZE = 25;
const POLL_INTERVAL = 5000;

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
  
  const socketRef = useRef<Socket | null>(null);

  // Fetch initial queues
  useEffect(() => {
    fetch('/api/queues')
      .then(r => r.json())
      .then(data => {
        if (data.queues && data.queues.length > 0) {
          setQueues(data.queues);
          setSelectedQueue(data.queues[0]);
        }
      })
      .catch(() => setError('Cluster API unreachable. Verify server status.'));
  }, []);

  const refreshDashboard = useCallback(async (isManual = false) => {
    if (!selectedQueue) return;
    if (isManual) setIsRefreshing(true);

    try {
      const [mRes, jRes] = await Promise.all([
        fetch(`/api/queues/${selectedQueue}/metrics`),
        fetch(`/api/queues/${selectedQueue}/jobs?status=${statusFilter}&limit=${PAGE_SIZE}&start=0`)
      ]);

      if (mRes.ok && jRes.ok) {
        const m = await mRes.json();
        const j = await jRes.json();
        setMetrics(m.metrics);
        setJobs(j.jobs);
        setHasMore(j.jobs.length === PAGE_SIZE);
        setLastUpdated(new Date());
        setError(null);
      }
    } catch (err) {
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
        setJobs(prev => [...prev, ...data.jobs]);
        setHasMore(data.jobs.length === PAGE_SIZE);
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  // Socket sync
  useEffect(() => {
    const socket = io('http://localhost:3000');
    socketRef.current = socket;

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('job-event', (data: any) => {
      if (data.queueName !== selectedQueue) return;

      // Optimistic Metrics
      setMetrics(prev => {
        if (!prev) return null;
        const next = { ...prev };
        if (data.event === 'job:active') { next.waiting = Math.max(0, next.waiting - 1); next.active++; }
        if (data.event === 'job:completed') { next.active = Math.max(0, next.active - 1); next.completed++; }
        if (data.event === 'job:failed') { next.active = Math.max(0, next.active - 1); next.failed++; }
        if (data.event === 'job:added') { next.waiting++; }
        return next;
      });

      // Update local job list item
      setJobs(prev => prev.map(job => {
        if (job.id === data.jobId) {
          const u = { ...job };
          if (data.event === 'job:progress') u.progress = data.progress;
          if (data.event === 'job:active') u.status = 'ACTIVE';
          if (data.event === 'job:completed') u.status = 'COMPLETED';
          if (data.event === 'job:failed') { u.status = 'FAILED'; u.error = data.error; }
          return u;
        }
        return job;
      }));

      // Update highlighted job details if open
      if (selectedJob?.id === data.jobId) {
         setSelectedJob(prev => {
            if (!prev) return null;
            const u = { ...prev };
            if (data.event === 'job:progress') u.progress = data.progress;
            if (data.event === 'job:active') u.status = 'ACTIVE';
            if (data.event === 'job:completed') u.status = 'COMPLETED';
            if (data.event === 'job:failed') { u.status = 'FAILED'; u.error = data.error; }
            return u;
         });
      }

      setLastUpdated(new Date());
    });

    return () => { socket.disconnect(); };
  }, [selectedQueue, selectedJob]);

  // Periodic Refresh
  useEffect(() => {
    if (!selectedQueue) return;
    refreshDashboard();
    const t = setInterval(refreshDashboard, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [selectedQueue, statusFilter, refreshDashboard]);

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
        body: JSON.stringify({ maxCount: 1, maxAge: 1 }) // force prune all
      });
      refreshDashboard(true);
    } finally {
      setIsCleaning(false);
    }
  };

  if (loading && !error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#F8FAFC]">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <Activity className="h-12 w-12 text-blue-600 animate-pulse" />
            <div className="absolute inset-0 bg-blue-400 blur-2xl opacity-20 animate-pulse"></div>
          </div>
          <span className="text-slate-500 font-bold tracking-[0.2em] text-xs uppercase animate-pulse">Link Established...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 font-sans antialiased selection:bg-blue-100 selection:text-blue-700">
      <header className="bg-white/80 backdrop-blur-xl border-b border-slate-200/60 h-20 sticky top-0 z-40 flex items-center shadow-sm">
        <div className="max-w-7xl mx-auto px-8 w-full flex justify-between items-center">
          <div className="flex items-center gap-5">
            <div className="bg-blue-600 h-11 w-11 rounded-[14px] flex items-center justify-center shadow-lg shadow-blue-500/20 rotate-3 transform group hover:rotate-0 transition-all duration-300">
              <Layers className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-slate-800 leading-none mb-1.5 flex items-center gap-2">
                Q-ENGINE 
                <span className="bg-slate-100 text-slate-400 text-[9px] px-1.5 py-0.5 rounded-md font-mono border border-slate-200">v1.2</span>
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
        {error ? (
          <div className="bg-rose-50/50 border border-rose-200/50 p-6 rounded-[20px] mb-12 flex items-center gap-5 slide-up">
            <div className="bg-rose-500/10 p-3 rounded-2xl">
              <AlertCircle className="h-6 w-6 text-rose-600" />
            </div>
            <div className="flex-1">
              <h3 className="text-rose-900 font-black text-sm uppercase tracking-wide">Protocol Violation</h3>
              <p className="text-rose-700/80 text-sm font-medium">{error}</p>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
          <StatCard label="WAITING" value={metrics?.waiting} color="amber" icon={<Timer />} />
          <StatCard label="ACTIVE" value={metrics?.active} color="blue" icon={<Activity />} />
          <StatCard label="COMPLETED" value={metrics?.completed} color="emerald" icon={<CheckCircle2 />} />
          <StatCard label="FAILED" value={metrics?.failed} color="rose" icon={<LogOut />} />
        </div>

        <div className="bg-white rounded-[32px] border border-slate-200/60 shadow-2xl shadow-slate-200/40 overflow-hidden slide-up" style={{ animationDelay: '0.1s' }}>
          <div className="px-10 py-8 flex flex-col xl:flex-row xl:items-center justify-between gap-8 border-b border-slate-100 bg-white">
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
                <span className="h-2 w-2 rounded-full bg-blue-400 animate-ping"></span>
                Last Sync: {lastUpdated.toLocaleTimeString()}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="pl-10 pr-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Identifier</th>
                  <th className="px-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Process Object</th>
                  <th className="px-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-center">Status</th>
                  <th className="px-4 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Execution Vector</th>
                  <th className="pl-4 pr-10 py-5 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] text-right">Ops</th>
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
                  jobs.map((job, idx) => (
                    <tr key={job.id} 
                      className="group cursor-pointer hover:bg-slate-50/80 transition-all duration-300"
                      onClick={() => setSelectedJob(job)}
                      style={{ animationDelay: `${idx * 0.02}s` }}
                    >
                      <td className="pl-10 pr-4 py-6 font-mono text-[11px] text-slate-400 group-hover:text-slate-900 group-hover:translate-x-1 transition-all">
                        #{job.id.substring(0, 8)}
                      </td>
                      <td className="px-4 py-6">
                        <div className="text-sm font-black text-slate-800 leading-none mb-1.5 uppercase tracking-tight">{job.name}</div>
                        <div className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200/50 inline-block">
                           Priority: {job.priority || 'Normal'}
                        </div>
                      </td>
                      <td className="px-4 py-6 text-center">
                        <span className={`inline-flex items-center px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border-2 transition-all group-hover:scale-105 ${
                          job.status === 'ACTIVE' ? 'bg-blue-50 text-blue-600 border-blue-100 shadow-lg shadow-blue-500/10' :
                          job.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                          job.status === 'FAILED' ? 'bg-rose-50 text-rose-600 border-rose-100' :
                          'bg-slate-50 text-slate-400 border-slate-100'
                        }`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="px-4 py-6">
                        <div className="flex items-center gap-4">
                           <div className="flex-1 bg-slate-100 h-3 rounded-full overflow-hidden max-w-[120px] border border-slate-200/50">
                              <div 
                                className={`h-full transition-all duration-1000 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                                  job.status === 'ACTIVE' ? 'bg-blue-600 shadow-[0_0_12px_rgba(37,99,235,0.4)]' : 
                                  job.status === 'COMPLETED' ? 'bg-emerald-500' : 'bg-slate-300'
                                }`}
                                style={{ width: `${job.progress}%` }}
                              ></div>
                           </div>
                           <span className="text-[11px] font-black text-slate-800 w-10">{job.progress}%</span>
                        </div>
                      </td>
                      <td className="pl-4 pr-10 py-6 text-right">
                         <div className="flex justify-end gap-2 group-hover:translate-x-[-4px] transition-transform">
                            <button className="h-9 w-9 flex items-center justify-center rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-colors">
                              <Info className="h-4 w-4" />
                            </button>
                         </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

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

      {/* Detail Modal */}
      {selectedJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
           <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" onClick={() => setSelectedJob(null)}></div>
           <div className="bg-white w-full max-w-2xl rounded-[32px] shadow-[0_32px_128px_rgba(15,23,42,0.4)] relative z-10 overflow-hidden slide-up">
              <div className="px-10 py-8 border-b border-slate-100 flex items-center justify-between bg-white sticky top-0">
                 <div className="flex items-center gap-4">
                    <div className="bg-slate-100 p-2.5 rounded-2xl">
                       <Cpu className="h-6 w-6 text-slate-900" />
                    </div>
                    <div>
                      <h2 className="text-xl font-black text-slate-800 leading-none mb-1.5 uppercase tracking-tighter">Payload Analysis</h2>
                      <p className="text-xs font-bold text-slate-400 font-mono tracking-widest">{selectedJob.id}</p>
                    </div>
                 </div>
                 <button onClick={() => setSelectedJob(null)} className="h-10 w-10 flex items-center justify-center rounded-full bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-900 transition-colors">
                    <X className="h-5 w-5" />
                 </button>
              </div>

              <div className="px-10 py-10 max-h-[70vh] overflow-y-auto">
                 <div className="grid grid-cols-2 gap-6 mb-10">
                    <MetaItem icon={<Calendar />} label="Ingested On" value={new Date(selectedJob.runAt).toLocaleString()} />
                    <MetaItem icon={<Hash />} label="Retries" value={`${selectedJob.attempts} / ${selectedJob.maxAttempts}`} />
                 </div>

                 {selectedJob.error && (
                   <div className="bg-rose-50 border border-rose-100 p-6 rounded-2xl mb-8">
                      <div className="flex items-center gap-2 mb-3">
                         <AlertCircle className="h-4 w-4 text-rose-600" />
                         <span className="text-[10px] font-black text-rose-600 uppercase tracking-widest">Execution Fault</span>
                      </div>
                      <p className="text-xs font-mono text-rose-800 break-words leading-relaxed">{selectedJob.error}</p>
                   </div>
                 )}

                 <div className="space-y-4">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100">Schema Inspection</span>
                    <div className="bg-slate-900 rounded-3xl p-8 font-mono text-[13px] text-blue-100 leading-relaxed overflow-x-auto border-4 border-slate-800 shadow-2xl">
                       <pre>{JSON.stringify(selectedJob.data, null, 2)}</pre>
                    </div>
                 </div>
              </div>

              <div className="px-10 py-8 bg-slate-50/50 border-t border-slate-100 flex justify-end gap-3">
                 <button onClick={() => setSelectedJob(null)} className="px-8 h-12 text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors">DISMISS</button>
                 {selectedJob.status === 'FAILED' && (
                    <button className="px-8 h-12 bg-blue-600 text-white text-xs font-black rounded-2xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 active:scale-95">RE-TRIGGER EXECUTION</button>
                 )}
              </div>
           </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, icon }: any) {
  const themes: Record<string, any> = {
    amber: { color: 'text-amber-500', bg: 'bg-amber-50', border: 'border-amber-100/50', accent: 'bg-amber-500/10' },
    blue: { color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100/50', accent: 'bg-blue-600/10' },
    emerald: { color: 'text-emerald-500', bg: 'bg-emerald-50', border: 'border-emerald-100/50', accent: 'bg-emerald-500/10' },
    rose: { color: 'text-rose-500', bg: 'bg-rose-50', border: 'border-rose-100/50', accent: 'bg-rose-500/10' },
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
          <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">records</span>
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

function ChevronDown(props: any) {
  return <svg {...props} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
}
