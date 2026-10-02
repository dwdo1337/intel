import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Logo } from '../components/Logo';
import { Filters, CHAIN_LAUNCHPADS } from '../components/Filters';
import { Feed } from '../components/Feed';
import { Inspector } from '../components/Inspector';
import { LogsPanel } from '../components/LogsPanel';
import { BestCalls } from '../components/BestCalls';
import { fmt } from '../App';

const FILTER_STORAGE_KEY = 'intel.filters.v1';

// Every chain starts SELECTED, so the rail reads as "watching all of these"
// and clicking one turns it off. An empty set rendered as nothing being on,
// which left no affordance for disabling a chain at all.
const ALL_CHAIN_IDS = () => new Set(CHAIN_LAUNCHPADS.map(ch => ch.id));

const BLANK_FILTER = () => ({
  launchpads: new Set(),
  chains: ALL_CHAIN_IDS(),
  // Which chains may raise a DESKTOP ALERT. Separate from `chains`, which is
  // only what the feed displays. Defaults to all until the backend says
  // otherwise; the backend's stored value always wins on load.
  alertChains: ALL_CHAIN_IDS(),
  // Do the metric thresholds below also gate DESKTOP ALERTS? Off by default:
  // narrowing the feed is looking, silencing an alert is a decision, and the
  // two are deliberately separate controls -- same reason the chain pill and
  // the bell are. The backend's stored value wins on load.
  alertFiltersOn: false,
  chips: 'All',
  search: '',
  ageMin: '', ageMax: '',
  liqMin: '', liqMax: '',
  capMin: '', capMax: '',
  volMin: '', volMax: '',
  netBuyMin: '', netBuyMax: '',
  txsMin: '', txsMax: '',
  buysMin: '', buysMax: '',
  sellsMin: '', sellsMax: '',
  holdersMin: '', holdersMax: '',
  top10Min: '', top10Max: '',
  devPctMin: '', devPctMax: '',
  rugRiskMax: '',
});

// Sets don't survive JSON, so they persist as arrays and rehydrate here.
// Any failure falls back to defaults rather than leaving a broken state.
/**
 * Chains this build knows about, as of the last time the filter was saved.
 *
 * Without this, ADDING a chain pill hides that chain's tokens instead of
 * revealing them. `filter.chains` is a whitelist -- an unlisted chain fails
 * `chains.has(evChain)` and never reaches the feed -- and a saved selection
 * written before the chain existed cannot contain it. So the pill appears
 * switched off, and the tokens it was added to expose stay invisible.
 *
 * A blind union of the saved set with every known chain would fix that and
 * break something worse: a chain the user deliberately switched OFF is also
 * absent from the saved set, and would be switched back on behind them.
 *
 * The two cases are only distinguishable by remembering which chains had ever
 * been offered. A chain that is new to this BUILD was never a choice the user
 * made, so it is selected; a known chain that is absent was deselected on
 * purpose, so it is left alone.
 */
const KNOWN_CHAINS_KEY = FILTER_STORAGE_KEY + ':known-chains';

function loadFilter() {
  const base = BLANK_FILTER();
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    const chains = Array.isArray(saved.chains) ? new Set(saved.chains) : base.chains;

    // Adopt chains this build added since the filter was last written.
    let known;
    try { known = new Set(JSON.parse(localStorage.getItem(KNOWN_CHAINS_KEY) || 'null') || []); }
    catch { known = new Set(); }
    // First run after this migration ships: nothing was recorded, so seed from
    // the chains the PREVIOUS build actually offered. Inferring the seed from
    // `saved.chains` instead would be wrong -- a deselected chain is missing
    // from that set too, so every chain the user had switched off would read as
    // "new" and be switched back on. This list is a historical fact, not a
    // guess, which is the only reason the distinction can be made at all.
    if (known.size === 0) {
      known = new Set(['solana', 'robinhood', 'base', 'bsc', 'ethereum', 'stable', 'arc']);
    }
    for (const id of ALL_CHAIN_IDS()) if (!known.has(id)) chains.add(id);
    try { localStorage.setItem(KNOWN_CHAINS_KEY, JSON.stringify([...ALL_CHAIN_IDS()])); } catch { /* ignore */ }

    return {
      ...base,
      ...saved,
      chains,
      alertChains: Array.isArray(saved.alertChains) ? new Set(saved.alertChains) : base.alertChains,
      launchpads: Array.isArray(saved.launchpads) ? new Set(saved.launchpads) : new Set(),
    };
  } catch {
    return base;
  }
}

function saveFilter(f) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
      ...f,
      chains: [...(f.chains || [])],
      alertChains: [...(f.alertChains || [])],
      launchpads: [...(f.launchpads || [])],
    }));
  } catch { /* quota or private mode -- filters just won't persist */ }
}

/**
 * Push the chain selection to the backend, which is what gates DESKTOP ALERTS.
 *
 * THIS IS DELIBERATELY SEPARATE FROM saveFilter, AND IS ONLY CALLED WHEN THE
 * USER ACTUALLY TOGGLES A CHAIN.
 *
 * It used to run inside saveFilter, i.e. on every filter change of any kind,
 * including the very first render. That made an ephemeral renderer value
 * authoritative over a durable one, and silently reset alert preferences:
 *
 *   1. User switches Solana off -> backend stores the other six chains. Good.
 *   2. localStorage is later empty or unparseable -- a fresh build, cleared
 *      site data, a different origin, anything. loadFilter() falls back to
 *      BLANK_FILTER(), which selects ALL chains.
 *   3. The mount effect immediately POSTs that fallback, and because all
 *      chains are selected it sent `null` = "alert on everything".
 *   4. Solana alerts come back, while the UI shows every chain switched on --
 *      so it reads as intentional and there is nothing to notice.
 *
 * Confirmed live: localStorage held all 7 chains while config.json held
 * notify_chains: null, on an account where Solana had been switched off.
 *
 * The backend value is now the source of truth and is only written by an
 * explicit toggle.
 */
function pushNotifyChains(chains) {
  const list = [...(chains || [])];
  return fetch('/api/notify-prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `intent` is required by the backend. Only a deliberate bell click sends
    // it, so no other code path -- present or future, in this tab or a stale
    // one -- can widen the user's alert settings by accident.
    //
    // Always the explicit list, never null. `null` means "never configured",
    // and collapsing "the user selected all of them" into it threw away the
    // fact that they had chosen at all.
    body: JSON.stringify({ chains: list, intent: 'user-toggle' }),
  }).catch(() => {});
}

/**
 * Push "only alert on calls matching my filters" + the thresholds themselves.
 *
 * Same rules as pushNotifyChains above, for the same reason: this is a durable
 * preference and the renderer must never write it on mount. The metric filters
 * live in localStorage and differ per window, so an automatic write would let a
 * stale tab silently start (or stop) suppressing alerts.
 *
 * Only two things call this, and both are unambiguously a person acting: the
 * toggle itself, and editing a threshold while the toggle is already on.
 */
function pushAlertFilters(enabled, thresholds) {
  return fetch('/api/alert-filters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !!enabled, thresholds: thresholds || {}, intent: 'user-toggle' }),
  }).catch(() => {});
}

export function DashboardScreen({ feed, selected, onSelect, onOpenSettings, onOpenSources, onOpenHistory, openReq, showcase }) {
  const [filter, setFilter] = useState(() => loadFilter());
  const [logsOpen, setLogsOpen] = useState(false);
  const [bestOpen, setBestOpen] = useState(false);
  const [logCount, setLogCount] = useState(0);
  // The filter rail starts OPEN, because a deck whose filters are hidden on
  // first run reads as having none at all. Remembered per browser after that.
  const [sideOpen, setSideOpen] = useState(() => {
    try { return localStorage.getItem('intel.side') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('intel.side', sideOpen ? '1' : '0'); } catch { /* private mode */ }
  }, [sideOpen]);
  // Whether the socket is actually connected, so the header dot REPORTS the
  // live state rather than asserting it.
  const [connected, setConnected] = useState(false);
  // Whether the inspector sheet is OPEN, which is not the same as which token
  // is selected. The feed auto-selects the first event so the deck has a
  // current token; as a third column that was free, but as a sheet it meant
  // the app opened with a full-screen panel over the feed nobody asked for.
  // The sheet opens on a click and on a clicked alert, and on nothing else.
  const [sheetOpen, setSheetOpen] = useState(false);
  const openToken = (id) => { onSelect(id); setSheetOpen(true); };

  // Persist filters on every change so thresholds and chain picks survive
  // a reload instead of silently resetting to defaults. Local storage only --
  // alert preferences are pushed separately, by an explicit toggle.
  useEffect(() => { saveFilter(filter); }, [filter]);

  // ADOPT the backend's alert preference on mount, rather than overwriting it.
  // config.json outlives localStorage, so it is the durable record of what the
  // user chose; the renderer starting up is not evidence of a new decision.
  // It lands in `alertChains` and NEVER in `chains` -- writing it into the feed
  // filter is what previously coupled the two and let browsing a chain re-arm
  // its alerts.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/notify-prefs')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        // ADOPT the alert-filter switch too. Same argument as the chains: the
        // backend outlives localStorage, so it says whether alerts are gated by
        // the thresholds -- the renderer starting up does not.
        if (d && d.alertFilters) {
          const on = !!d.alertFilters.enabled;
          setFilter(p => (p.alertFiltersOn === on ? p : { ...p, alertFiltersOn: on }));
        }
        if (!Array.isArray(d?.chains)) return;
        const fromServer = new Set(d.chains.map(c => String(c).toLowerCase()));
        setFilter(p => {
          const cur = p.alertChains || new Set();
          const same = cur.size === fromServer.size && [...fromServer].every(c => cur.has(c));
          return same ? p : { ...p, alertChains: fromServer };
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // The ONLY writer of the alert preference: an explicit bell click.
  // The network call is made OUTSIDE the state updater — an updater must be
  // pure, and React invokes it more than once under StrictMode, which would
  // fire the write twice per click.
  const toggleAlertChain = (id) => {
    const next = new Set(filter.alertChains || []);
    if (next.has(id)) next.delete(id); else next.add(id);
    setFilter(prev => ({ ...prev, alertChains: next }));
    pushNotifyChains(next);
  };

  /**
   * The thresholds the backend needs, pulled out of the filter object.
   *
   * Only the numeric metric fields -- never `search`, `chains`, `chips` or the
   * launchpad set. Those are view state, and persisting them into config.json
   * would make it grow on every UI interaction.
   */
  const alertThresholdsFrom = (f) => {
    const out = {};
    // Derived from the shape rather than a second hardcoded list, so adding a
    // metric row can't leave the alert gate quietly out of date. The backend
    // sanitises to the keys it knows, so anything unrecognised is dropped
    // there rather than written into config.json.
    for (const k of Object.keys(f || {})) {
      if (!/(Min|Max)$/.test(k)) continue;
      if (f[k] !== '' && f[k] != null) out[k] = f[k];
    }
    return out;
  };

  // The switch itself.
  const toggleAlertFilters = () => {
    const next = !filter.alertFiltersOn;
    setFilter(prev => ({ ...prev, alertFiltersOn: next }));
    pushAlertFilters(next, alertThresholdsFrom(filter));
  };

  /**
   * A threshold was edited. Only re-pushes while the switch is ON -- otherwise
   * typing in the left rail would write a preference the user has not opted
   * into, which is precisely the automatic-write failure the intent guard on
   * the backend exists to catch.
   */
  const onThresholdChange = (nextFilter) => {
    if (!nextFilter.alertFiltersOn) return;
    pushAlertFilters(true, alertThresholdsFrom(nextFilter));
  };

  const safeFeed = useMemo(() => (feed || []).filter(ev => ev && ev.token), [feed]);

  useEffect(() => {
    fetch('/api/logs?limit=1').then(r => r.json()).then(data => { if (Array.isArray(data)) setLogCount(data.length); }).catch(() => {});
    const socket = io({ path: '/socket.io' });
    socket.on('log', () => setLogCount(c => c + 1));
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    return () => socket.close();
  }, []);

  const num = v => {
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const inRange = (val, min, max) => {
    const v = num(val);
    if (v == null) return true;
    const mn = num(min), mx = num(max);
    if (mn != null && v < mn) return false;
    if (mx != null && v > mx) return false;
    return true;
  };

  const filtered = useMemo(() => {
    const s = filter.search.toLowerCase().trim();
    return safeFeed.filter(ev => {
      const m = ev.metrics || {};
      const evChain = (ev.token?.chain || '').toLowerCase();
      const lp = (ev.launchpad || '').toLowerCase();

      if (filter.chips === 'Follow-ups' && ev.type !== 'followup') return false;
      // Your starred tokens only -- nothing to do with how many people called
      // it. This is the tab that answers "what am I actually watching?".
      if (filter.chips === 'Watchlist' && !ev.watched) return false;
      if (filter.chips === 'Clean' && !ev.badges?.includes('CLEAN')) return false;
      if (filter.chips === 'High signal' && (ev.smartMoney?.signals || 0) < 1) return false;
      if (filter.chains.size > 0 && !filter.chains.has(evChain)) return false;
      if (filter.launchpads.size > 0 && !filter.launchpads.has(`${evChain}:${lp}`)) return false;

      if (s) {
        const hay = [
          ev.token?.name, ev.token?.symbol, ev.token?.address,
          ev.sourceName, ev.author, ev.body
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(s)) return false;
      }

      if (!inRange(m.ageMinutes, filter.ageMin, filter.ageMax)) return false;
      if (!inRange(m.liq, filter.liqMin, filter.liqMax)) return false;
      if (!inRange(m.mcap, filter.capMin, filter.capMax)) return false;
      if (!inRange(m.vol, filter.volMin, filter.volMax)) return false;
      if (!inRange(m.netBuy, filter.netBuyMin, filter.netBuyMax)) return false;
      if (!inRange(m.txs, filter.txsMin, filter.txsMax)) return false;
      if (!inRange(m.buys, filter.buysMin, filter.buysMax)) return false;
      if (!inRange(m.sells, filter.sellsMin, filter.sellsMax)) return false;
      if (!inRange(m.holders, filter.holdersMin, filter.holdersMax)) return false;
      if (!inRange(m.top10, filter.top10Min, filter.top10Max)) return false;

      const sfty = ev.safety || {};
      if (!inRange(sfty.devPct, filter.devPctMin, filter.devPctMax)) return false;
      if (num(filter.rugRiskMax) != null && (sfty.rugRisk == null || sfty.rugRisk > num(filter.rugRiskMax))) return false;

      return true;
    });
  }, [safeFeed, filter]);

  // THE INSPECTOR MUST SHOW A TOKEN THAT IS ACTUALLY IN THE FEED.
  // `selected` is resolved against the UNFILTERED feed, so switching to the
  // Watchlist tab (or any filter) left the previously-selected token rendered
  // in the inspector while the feed beside it listed something else entirely.
  // Observed live: the Watchlist showed one BSC token while the inspector
  // still displayed a Solana token's launchpad, price and liquidity -- which
  // reads as "the watchlist token has wrong data" rather than as a stale
  // panel, because nothing on screen says the two are different tokens.
  const selectedVisible = useMemo(
    () => (selected && filtered.some(ev => ev.id === selected.id)) ? selected : null,
    [selected, filtered],
  );

  useEffect(() => {
    if (selected && !selectedVisible) {
      // Follow the filter rather than blanking the panel: land on the first
      // visible token, or clear when the filter matches nothing at all.
      onSelect(filtered.length ? filtered[0].id : null);
    }
  }, [selected, selectedVisible, filtered, onSelect]);

  // OPEN THE TOKEN A CLICKED TOAST ASKED FOR.
  //
  // This has to fight the effect directly above it. That one enforces "the
  // inspector only ever shows a token the feed is actually listing", which is
  // right -- but it means asking for a token the current filter hides would
  // snap straight to filtered[0] instead, and the click would look broken.
  //
  // So the filter is cleared first when, and only when, it is what is hiding
  // the token. Clearing it unconditionally would throw away a filter setup
  // every time a toast was clicked, and leaving it alone would make the
  // feature fail exactly when it is most useful -- a watch note firing for a
  // starred token that ran past your market-cap ceiling is the case the
  // watchlist bypass exists for, and by construction that token is outside
  // the filter. Metric thresholds are part of the reset for the same reason.
  const openN = openReq && openReq.n;
  // Which request has already been acted on. A ref, not state, so marking one
  // handled does not itself trigger another render pass.
  const handledOpen = useRef(null);
  useEffect(() => {
    if (!openReq || !openReq.ca || handledOpen.current === openN) return;
    const want = String(openReq.ca).toLowerCase();
    const match = safeFeed.find(ev => String(ev.id).toLowerCase() === want);
    // Not in the feed YET. This effect re-runs when the feed changes, so a
    // toast clicked before the deck has loaded its feed -- or one naming a
    // token that arrives a moment later -- is honoured when it turns up,
    // rather than being dropped on the one render where it was not there.
    if (!match) return;
    handledOpen.current = openN;
    if (!filtered.some(ev => ev.id === match.id)) {
      // Reset what the FEED shows, and nothing else. `alertChains` and
      // `alertFiltersOn` describe how you agreed to be interrupted, are owned
      // by the backend, and are only ever meant to change on an explicit
      // toggle. A blanket BLANK_FILTER() here would quietly re-arm every muted
      // chain in localStorage -- the exact coupling between looking and being
      // notified that the pill and the bell were split apart to end.
      setFilter(f => ({
        ...BLANK_FILTER(),
        alertChains: f.alertChains,
        alertFiltersOn: f.alertFiltersOn,
      }));
    }
    onSelect(match.id);
    setSheetOpen(true);
    // `filtered` is deliberately NOT a dependency: it changes on the very
    // reset this effect performs, and re-running would fight itself. The
    // handled-nonce guard is what makes depending on safeFeed safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openN, safeFeed]);

  // Which tab the header pill nav is on. This REPLACES the chips that used to
  // sit above the feed: in the reference the tabs ARE the primary navigation,
  // they live in the header, and they carry their own counts.
  const counts = useMemo(() => ({
    all: safeFeed.length,
    followups: safeFeed.filter(e => e.type === 'followup').length,
    watchlist: safeFeed.filter(e => e.watched).length,
  }), [safeFeed]);

  // The four numbers across the top. Every one is counted from the feed in
  // front of you -- nothing here is fetched, estimated or carried over, so a
  // KPI can never disagree with the cards underneath it.
  const kpis = useMemo(() => {
    const now = Date.now();
    const since = (ms) => safeFeed.filter(e => {
      const t = e.time ? new Date(e.time).getTime() : null;
      return t != null && !Number.isNaN(t) && now - t <= ms;
    });
    const lastHour = since(3600000);
    const day = since(86400000);
    // The best RUN, not the best current price: peakMult is how far a call
    // actually went after it was made. A token with no measured peak is left
    // out rather than counted as 1.00x, which would be a claim we cannot make.
    let best = null;
    for (const e of day) {
      const m = e.metrics && e.metrics.peakMult;
      if (m != null && (best == null || m > best.m)) best = { m, sym: e.token && e.token.symbol };
    }
    return {
      lastHour: lastHour.length,
      followups: lastHour.filter(e => e.type === 'followup').length,
      watching: counts.watchlist,
      best,
    };
  }, [safeFeed, counts.watchlist]);

  const TABS = [
    { id: 'All', label: 'Live feed', n: counts.all },
    { id: 'Follow-ups', label: 'Called again', n: counts.followups },
    { id: 'Watchlist', label: 'Watchlist', n: counts.watchlist },
  ];

  return (
    <div className="screen active">
      {/* The reference header: brand left, pill tabs centre, round buttons
          right. The old bar put a search field here and pushed navigation into
          a side rail, which is the single biggest reason the deck never read
          like the scanner no matter how the pills themselves were styled. */}
      <header className="top">
        <div className="top-in">
          <div className="brand">
            <div className="logo-mark"><Logo size={26} /></div>
            <div>
              <h1>intel.</h1>
              <div className="live">
                <i className={`dot${connected ? ' on' : ''}`} />
                <span>{connected ? 'live' : 'connecting...'}</span>
              </div>
            </div>
          </div>

          <nav className="tabs">
            {TABS.map(t => (
              <button key={t.id}
                      className={filter.chips === t.id ? 'on' : ''}
                      onClick={() => setFilter(p => ({ ...p, chips: t.id }))}>
                {t.label}<em>{t.n}</em>
              </button>
            ))}
          </nav>

          <button className={`round${sideOpen ? ' on' : ''}`} onClick={() => setSideOpen(v => !v)}
                  title="Show / hide filters">&#9881;</button>
          <button className="round" onClick={() => setLogsOpen(v => !v)} title="System logs">
            <IconLogs />{logCount > 0 && <span className="logs-badge">{logCount > 99 ? '99+' : logCount}</span>}
          </button>
          <button className={`round${bestOpen ? ' on' : ''}`} onClick={() => setBestOpen(v => !v)}
                  title="Best calls"><IconTrophy /></button>
          <button className="round" onClick={onOpenHistory} title="Notification history"><IconBell /></button>
          <button className="round" onClick={onOpenSources} title="Choose which groups to watch"><IconGroups /></button>
          <button className="round" onClick={onOpenSettings} title="Connect Telegram / Discord"><IconGear /></button>
        </div>
      </header>

      <main className={`wrap layout${sideOpen ? '' : ' no-side'}`}>
        {sideOpen && (
          <aside className="side">
            <Filters
              filter={filter}
              setFilter={setFilter}
              onAlertToggle={toggleAlertChain}
              onAlertFiltersToggle={toggleAlertFilters}
              onThresholdChange={onThresholdChange}
            />
          </aside>
        )}

        <div className="mainc">
          <section className="kpis">
            <div className="kpi"><span>Signals last hour</span><b>{kpis.lastHour}</b></div>
            <div className="kpi"><span>Called again (1h)</span><b>{kpis.followups}</b></div>
            <div className="kpi"><span>Watching</span><b>{kpis.watching}</b></div>
            {/* A dash, not a zero, when nothing in the last day has a measured
                peak. Zero would read as "every call went nowhere". */}
            <div className="kpi hot">
              <span>&#127942; Best run since call (24h)</span>
              <b>{kpis.best ? `${kpis.best.m.toFixed(2)}x ${kpis.best.sym ? '$' + kpis.best.sym : ''}` : '\u2014'}</b>
            </div>
          </section>

          {filtered.length === 0 ? showcase : null}
          <Feed events={filtered} selected={selectedVisible} onSelect={openToken}
                filter={filter} setFilter={setFilter} />
        </div>
      </main>

      {/* The inspector is a slide-over, not a permanent third column. As a
          column it was always on screen, competing with the card for the same
          facts at a third of the width. As a sheet it opens when you ask one
          token a question, and gets out of the way afterwards. */}
      {selectedVisible && sheetOpen && (
        <div className="sheet-bg" onClick={e => { if (e.target === e.currentTarget) setSheetOpen(false); }}>
          <aside className="sheet">
            <button className="s-x" onClick={() => setSheetOpen(false)} aria-label="Close">&times;</button>
            <Inspector event={selectedVisible} />
          </aside>
        </div>
      )}

      {logsOpen && <div className="logs-drawer"><LogsPanel /></div>}

      {bestOpen && (
        <div className="bc-overlay" onClick={e => { if (e.target === e.currentTarget) setBestOpen(false); }}>
          <div className="bc-panel">
            <div className="bc-panel-head">
              <span>Best calls</span>
              <button className="bc-close" onClick={() => setBestOpen(false)}>&times;</button>
            </div>
            <BestCalls onPick={ca => { setBestOpen(false); openToken(ca); }} />
          </div>
        </div>
      )}
    </div>
  );
}

function IconTrophy() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
    </svg>
  );
}

function IconBell() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>;
}

function IconGroups() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function IconGear() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>;
}

function IconLogs() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>;
}
