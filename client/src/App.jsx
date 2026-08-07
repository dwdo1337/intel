import React, { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { BootScreen } from './screens/BootScreen';
import { ConnectScreen } from './screens/ConnectScreen';
import { SourcesManager } from './components/SourcesManager';
import { DashboardScreen } from './screens/DashboardScreen';
import { Toasts } from './components/Toasts';
import { NotificationPanel } from './components/NotificationPanel';
import { TokenShowcase } from './components/TokenShowcase';

// Toggle to one-line revert the premium UI redesign.
const V2_PREMIUM = true;

// TokenShowcase is intentionally NOT rendered. It displayed a hardcoded token
// list priced live from DexScreener -- real numbers, but tokens nobody actually
// called in the user's chats. Having no caller, no source chat and no follow-up
// state, it read as though the feed had lost its attribution, and it pushed real
// signals below the fold. A new user should see a true empty state until real
// signals arrive. The component is kept in the tree for possible reuse as an
// explicitly-labelled "explore" view later.

export default function App() {
  const [ready, setReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [feed, setFeed] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const loadFeed = async (keepSelection = true) => {
    try {
      const res = await fetch('/api/react-feed');
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const data = await res.json();
      const safe = Array.isArray(data) ? data.filter(ev => ev && ev.token) : [];
      setFeed(safe);
      if (!keepSelection && safe[0]) setSelectedId(safe[0].id);
    } catch (e) { console.error('feed error', e); }
  };

  useEffect(() => {
    const bootTimer = setTimeout(() => setReady(true), 900);
    const socket = io({ path: '/socket.io' });
    socket.on('ca', (hit) => {
      loadFeed(true);
      // IN-APP TOASTS DISABLED -- Electron already raises a real OS
      // notification for every signal, so showing one inside the window too
      // meant two alerts per event, with the in-app one covering the feed.
      //
      // The history panel is the record of ALERTS RAISED, so it obeys the same
      // chain filter the toast layer does. It previously recorded every signal
      // regardless, so a chain switched off still filled the notification bell
      // -- which reads as the filter being ignored, because from the user's
      // side that is indistinguishable from it.
      if (hit && hit._notify === false) return;
      setHistory(prev => [buildToast(hit), ...prev].slice(0, 50));
    });
    socket.on('ca_update', () => loadFeed(true));
    socket.on('ca_remove', () => loadFeed(true));
    loadFeed(false);
    return () => { clearTimeout(bootTimer); socket.close(); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    loadFeed(true);
    const iv = setInterval(() => loadFeed(true), 15000);
    return () => clearInterval(iv);
  }, [ready]);

  const selected = useMemo(() => feed.find(e => e && e.id === selectedId), [feed, selectedId]);

  const handleShowcasePick = (token) => {
    const ev = feed.find(e => e.token?.address === token.address);
    if (ev) setSelectedId(ev.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className={`app${V2_PREMIUM ? ' v2-premium' : ''}`}>
      {!ready && <BootScreen />}
      {ready && (
        <DashboardScreen
          feed={feed}
          selected={selected}
          onSelect={setSelectedId}
          onOpenSettings={() => setShowSettings(true)}
          onOpenSources={() => setShowSources(true)}
          onOpenHistory={() => setShowHistory(true)}
          showcase={null}
        />
      )}
      {ready && showSources && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowSources(false); }}>
          <SourcesManager onClose={() => setShowSources(false)} />
        </div>
      )}
      {ready && showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <ConnectScreen onClose={() => setShowSettings(false)} />
          </div>
        </div>
      )}
      {ready && showHistory && (
        <NotificationPanel
          history={history}
          onClose={() => setShowHistory(false)}
          onSelect={(ev) => { setSelectedId(ev.id); setShowHistory(false); }}
        />
      )}
      <Toasts toasts={toasts} onClose={id => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  );
}

function buildToast(hit) {
  const toastId = (hit && hit.ca) || Date.now();
  const chain = (hit?.chain || 'solana').toLowerCase();
  const chainLabel = chain === 'sol' || chain === 'solana' ? 'Solana' : chain === 'base' ? 'Base' : chain === 'eth' || chain === 'ethereum' ? 'Ethereum' : chain === 'bsc' || chain === 'bnb' ? 'BSC' : chain === 'robinhood' ? 'Robinhood' : chain === 'stable' ? 'Stable' : chain === 'arc' ? 'Arc' : 'Solana';
  const lp = hit?.launchpad || hit?.dex || 'unknown';
  const symbol = hit?.token_symbol || 'TOKEN';
  const name = hit?.token_name || symbol;
  const image = hit?.image_url || null;
  const address = hit?.ca || '';
  const mcap = hit?.mcap_usd ? fmt(hit.mcap_usd) : '—';
  const liq = hit?.liquidity_usd ? fmt(hit.liquidity_usd) : '—';
  const chg = hit?.price_change_24h != null ? (hit.price_change_24h > 0 ? '+' : '') + hit.price_change_24h.toFixed(0) + '%' : '—';
  const vol = hit?.volume_24h_usd ? fmt(hit.volume_24h_usd) : '—';
  const sender = hit?.author || 'unknown';
  const source = hit?.source || 'intel.';
  // Why this alert fired. The history panel is the record of alerts RAISED, so
  // it has to distinguish a first sighting from a watchlist token being called
  // again or re-scanned -- otherwise a re-alert reads as a fresh discovery
  // hours later, which is exactly the wrong conclusion to draw from a list.
  const kind = hit?._alert_kind || 'new';
  const kindLabel = kind === 'watchlist-refresh' ? 'intel. · watchlist rescan'
    : kind === 'watchlist-mention' ? 'intel. · watchlist called again'
    : kind === 'watchlist-wallet' ? 'intel. · smart money bought'
    : 'intel. · new signal';
  return {
    id: toastId,
    kind,
    app: kindLabel,
    name, symbol, chain, chainLabel, launchpad: lp, sender, source,
    chat: hit?.chat_name || '', address, image,
    // The caller's own message, so the history panel can show what was
    // actually said alongside the CA rather than just the token.
    message: hit?.message_text || '',
    metrics: {
      mcap: mcap.includes('—') ? null : mcap,
      liq: liq.includes('—') ? null : liq,
      vol: vol.includes('—') ? null : vol,
      chg: chg.includes('—') ? null : chg,
    },
  };
}

export function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}
