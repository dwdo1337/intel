import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';

const CATEGORIES = [
  { id: 'system', label: 'System', color: '#6b7588' },
  { id: 'signal', label: 'Signals', color: '#4fe3a0' },
  { id: 'enrichment', label: 'Enrichment', color: '#3b82f6' },
  { id: 'error', label: 'Errors', color: '#ef4444' },
];

export function LogsPanel({ compact }) {
  const [logs, setLogs] = useState([]);
  const [active, setActive] = useState('all');

  useEffect(() => {
    let mounted = true;
    fetch('/api/logs?limit=120')
      .then(r => r.json())
      .then(data => { if (mounted) setLogs(Array.isArray(data) ? data.slice(-120) : []); })
      .catch(() => { if (mounted) setLogs([]); });
    const socket = io({ path: '/socket.io' });
    socket.on('log', entry => {
      if (!mounted) return;
      setLogs(prev => [entry, ...prev].slice(0, 200));
    });
    return () => { mounted = false; socket.close(); };
  }, []);

  const filtered = useMemo(() => {
    if (active === 'all') return logs;
    return logs.filter(l => l.c === active);
  }, [logs, active]);

  const counts = useMemo(() => {
    const c = { all: logs.length };
    CATEGORIES.forEach(cat => { c[cat.id] = logs.filter(l => l.c === cat.id).length; });
    return c;
  }, [logs]);

  return (
    <div className={`logs-panel ${compact ? 'compact' : ''}`}>
      {!compact && <div className="logs-head">
        <div className="logs-title">System logs</div>
        <div className="logs-tabs">
          <button className={active === 'all' ? 'active' : ''} onClick={() => setActive('all')}>All <span className="logs-count">{counts.all}</span></button>
          {CATEGORIES.map(cat => <button key={cat.id} className={active === cat.id ? 'active' : ''} style={{ '--cat': cat.color }} onClick={() => setActive(cat.id)}>{cat.label} <span className="logs-count">{counts[cat.id]}</span></button>)}
        </div>
      </div>}
      <div className="logs-body">
        {filtered.length === 0 && <div className="logs-empty">No logs yet.</div>}
        {filtered.map((l, i) => {
          const cat = CATEGORIES.find(c => c.id === l.c) || CATEGORIES[0];
          const t = l.t ? new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
          return (
            <div key={i} className="logs-row">
              <span className="logs-time">{t}</span>
              <span className="logs-cat" style={{ color: cat.color }}>{l.c}</span>
              <span className="logs-msg">{l.m}</span>
              {l.d && <span className="logs-data">{JSON.stringify(l.d)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
