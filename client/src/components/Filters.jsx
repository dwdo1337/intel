import { useState, useMemo, useEffect } from 'react';
import './filters.css';

// The feed tabs. Exported because Feed.jsx used to keep its OWN list --
// ['All', 'Follow-ups'] -- so the Watchlist tab existed in the left rail and
// simply did not exist above the feed, which is where you actually look for it.
// Feed even carried a written empty-state for the Watchlist tab that nothing
// could reach. One list, one place.
export const CHIPS = [
  { id: 'All', label: 'All signals' },
  // "Follow-ups" = several DIFFERENT people called it. "Watchlist" = tokens
  // YOU starred. Two unrelated ideas that both got called "following", so the
  // labels spell out whose action each one reflects.
  { id: 'Follow-ups', label: 'Called again' },
  { id: 'Watchlist', label: 'Watchlist' },
];

// Chain identity: colour, label, logo. That is ALL this holds now.
//
// It used to carry a hand-written launchpad list per chain, and that list drifted
// away from reality in both directions at once. Measured against a live
// 500-signal store: five entries (hood.fun, Openfair, NOXA Fun, RobinPad, PONS)
// had never been detected once and were shown greyed with a "soon" tag -- an
// honest label on a chip that could only ever produce an empty feed -- while
// StonkFun and Meteora were being detected fine and had no chip at all, so their
// tokens could not be filtered for.
//
// The launchpads now come from GET /api/launchpads, which publishes the server's
// own detection map. A chip therefore exists exactly when detection exists,
// which is why there is no longer anything for "soon" to describe.
const CHAIN_LAUNCHPADS = [
  { id: 'solana', label: 'Solana', color: '#9945FF', logo: 'https://dd.dexscreener.com/ds-data/chains/solana.png' },
  { id: 'robinhood', label: 'Robinhood', color: '#00C805', logo: 'https://dd.dexscreener.com/ds-data/chains/robinhood.png' },
  { id: 'base', label: 'Base', color: '#0052FF', logo: 'https://dd.dexscreener.com/ds-data/chains/base.png' },
  { id: 'bsc', label: 'BSC', color: '#F0B90B', logo: 'https://dd.dexscreener.com/ds-data/chains/bsc.png' },
  { id: 'ethereum', label: 'ETH', color: '#627EEA', logo: 'https://dd.dexscreener.com/ds-data/chains/ethereum.png' },
  { id: 'stable', label: 'Stable', color: '#2fd6c8', logo: 'https://icons.llamao.fi/icons/chains/rsz_stable.jpg' },
  { id: 'arc', label: 'Arc', color: '#8a8a8a', logo: 'https://icons.llamao.fi/icons/chains/rsz_arc.jpg' },
];

export { CHAIN_LAUNCHPADS };

const METRIC_SECTIONS = [
  {
    id: 'market', label: 'Market',
    rows: [
      { key: 'cap', label: 'Market cap', unit: '$' },
      { key: 'liq', label: 'Liquidity', unit: '$' },
      { key: 'vol', label: 'Volume 24h', unit: '$' },
      { key: 'age', label: 'Age', unit: 'min' },
    ],
  },
  {
    id: 'flow', label: 'Trade flow',
    rows: [
      { key: 'netBuy', label: 'Net buys' },
      { key: 'txs', label: 'Total txs' },
      { key: 'buys', label: 'Buys' },
      { key: 'sells', label: 'Sells' },
    ],
  },
  {
    id: 'risk', label: 'Holders & risk',
    note: 'Solana only',
    rows: [
      { key: 'holders', label: 'Holders' },
      { key: 'top10', label: 'Top 10 hold', unit: '%' },
      { key: 'devPct', label: 'Dev holding', unit: '%' },
    ],
  },
];

export function Filters({ filter, setFilter, onAlertToggle, onAlertFiltersToggle, onThresholdChange }) {
  // Sections start collapsed. Twelve always-visible min/max pairs made the
  // rail an unreadable wall; you open the one you actually need.
  const [open, setOpen] = useState({ chains: true, market: false, flow: false, risk: false });
  const [search, setSearch] = useState('');

  const chainSet = filter.chains || new Set();
  // Which chains may raise a desktop alert. Deliberately a SEPARATE set from
  // `chains` above -- see the note at the chain pills.
  const alertSet = filter.alertChains || new Set();
  const lpSet = filter.launchpads || new Set(); // composite keys "chainId:lpId"

  // The launchpads the BACKEND can actually detect, keyed by chain. Fetched
  // rather than hard-coded so a chip can never exist for something detection
  // cannot produce -- which is what the old "soon" tag was apologising for.
  const [lpByChain, setLpByChain] = useState({});
  useEffect(() => {
    let alive = true;
    let timer = null;

    // RETRIES, because a single attempt on mount is not enough.
    //
    // The renderer routinely starts before the backend does -- electron/main.cjs
    // says so itself ("backend did not respond in time; window will retry on
    // did-fail-load"). Observed live: the window mounted first, this fetch
    // failed, and every launchpad section read "No launchpad detected on this
    // chain yet" for the rest of the session even though the API was serving a
    // full list seconds later. Failing quiet is right; failing quiet FOREVER is
    // not, because the result is indistinguishable from having no launchpads.
    const attempt = (n) => {
      if (!alive) return;
      fetch('/api/launchpads')
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then(j => {
          if (!alive) return;
          if (!j || !Array.isArray(j.chains) || j.chains.length === 0) throw new Error('empty');
          const map = {};
          for (const c of j.chains) map[c.chain] = c.launchpads || [];
          setLpByChain(map);
        })
        .catch(() => {
          // Backs off to 5s and keeps going. The cost of one small request a
          // few times a minute is nothing next to the filter being silently
          // dead, and it stops the moment a list arrives.
          if (!alive) return;
          timer = setTimeout(() => attempt(n + 1), Math.min(5000, 600 * (n + 1)));
        });
    };
    attempt(0);

    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  const toggleSection = id => setOpen(p => ({ ...p, [id]: !p[id] }));

  // FEED VISIBILITY ONLY. This no longer touches alert routing at all, which
  // is the whole point of splitting the two: browsing a chain must never
  // re-arm its notifications.
  const toggleChain = id => {
    setFilter(prev => {
      const nextChains = new Set(prev.chains);
      let nextLp = prev.launchpads;
      if (nextChains.has(id)) {
        nextChains.delete(id);
        nextLp = new Set([...(prev.launchpads || [])].filter(k => !k.startsWith(id + ':')));
      } else {
        nextChains.add(id);
      }
      return { ...prev, chains: nextChains, launchpads: nextLp };
    });
  };

  const toggleLp = (chainId, lpId) => {
    const key = `${chainId}:${lpId}`;
    setFilter(prev => {
      const next = new Set(prev.launchpads);
      if (next.has(key)) next.delete(key); else next.add(key);
      return { ...prev, launchpads: next };
    });
  };

  // Editing a threshold. If these ALSO gate desktop alerts, the backend has to
  // hear about it -- otherwise the switch would apply whatever numbers happened
  // to be set when it was flipped, and every edit after that would change the
  // feed while the alerts kept using the old ceiling.
  // Computed outside the updater on purpose: a setState updater must stay pure,
  // and StrictMode double-invokes it in dev -- which would fire the POST twice.
  const update = (key, value) => {
    const next = { ...filter, [key]: value };
    setFilter(next);
    onThresholdChange?.(next);
  };

  const activeCount = useMemo(() => {
    let n = 0;
    for (const s of METRIC_SECTIONS) {
      for (const r of s.rows) {
        if (filter[`${r.key}Min`] !== '' || filter[`${r.key}Max`] !== '') n++;
      }
    }
    if (filter.rugRiskMax !== '') n++;
    return n;
  }, [filter]);

  const sectionActive = section => {
    let n = 0;
    for (const r of section.rows) {
      if (filter[`${r.key}Min`] !== '' || filter[`${r.key}Max`] !== '') n++;
    }
    if (section.id === 'risk' && filter.rugRiskMax !== '') n++;
    return n;
  };

  const clearAll = () => {
    const next = { ...filter };
    for (const s of METRIC_SECTIONS) {
      for (const r of s.rows) { next[`${r.key}Min`] = ''; next[`${r.key}Max`] = ''; }
    }
    next.rugRiskMax = '';
    setFilter(next);
    // Clearing is an edit like any other: if alerts are gated by these, the
    // backend must be told they are now wide open, or it keeps suppressing on
    // numbers no longer visible anywhere in the UI.
    onThresholdChange?.(next);
  };

  return (
    <aside className="fx">
      <div className="fx-search">
        <IconSearch />
        <input
          placeholder="Search token, CA, chat…"
          value={search}
          onChange={e => { setSearch(e.target.value); update('q', e.target.value); }}
        />
        {search && <button className="fx-search-clear" onClick={() => { setSearch(''); update('q', ''); }}>×</button>}
      </div>

      <div className="fx-segment">
        {CHIPS.map(c => (
          <button
            key={c.id}
            className={`fx-seg-btn ${filter.chips === c.id ? 'on' : ''}`}
            onClick={() => update('chips', c.id)}
          >{c.label}</button>
        ))}
      </div>

      <Section
        id="chains"
        label="Chains"
        open={open.chains}
        count={chainSet.size}
        onToggle={() => toggleSection('chains')}
      >
        {/* TWO INDEPENDENT CONTROLS PER CHAIN.
            The pill filters the FEED. The bell decides whether that chain may
            raise a DESKTOP ALERT.

            They used to be the same control, which is why a muted chain kept
            coming back: turning Solana on to LOOK at a Solana token silently
            re-enabled Solana toasts, and muting toasts also hid the chain from
            the feed. One button, two different intentions, so satisfying one
            always broke the other. */}
        <div className="fx-chains">
          {CHAIN_LAUNCHPADS.map(c => {
            const on = chainSet.has(c.id);
            const alerts = alertSet.has(c.id);
            return (
              <div key={c.id} className={`fx-chain-wrap ${on ? 'on' : ''}`}
                   style={on ? { background: `${c.color}1c`, boxShadow: `inset 2px 0 0 ${c.color}` } : undefined}>
                <button
                  className={`fx-chain ${on ? 'on' : ''}`}
                  onClick={() => toggleChain(c.id)}
                  title={on ? `Hide ${c.label} from the feed` : `Show ${c.label} in the feed`}
                >
                  <ChainMark chain={c} />
                  <span className="fx-chain-name">{c.label}</span>
                </button>
                <button
                  className={`fx-bell ${alerts ? 'on' : 'off'}`}
                  onClick={e => { e.stopPropagation(); onAlertToggle && onAlertToggle(c.id); }}
                  aria-pressed={alerts}
                  title={alerts
                    ? `Alerts ON for ${c.label} — click to stop desktop alerts for this chain. Does not hide it from the feed.`
                    : `Alerts OFF for ${c.label} — no desktop alerts. It still appears in the feed.`}
                >
                  {alerts ? <IconBellOn /> : <IconBellOff />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="fx-chains-hint">
          Pill filters the feed · bell controls desktop alerts
        </div>

        {/* Launchpads appear only for chains you actually selected, so the
            rail doesn't carry 20 irrelevant pills at all times. */}
        {[...chainSet].map(chainId => {
          const def = CHAIN_LAUNCHPADS.find(c => c.id === chainId);
          if (!def) return null;
          const pads = lpByChain[chainId] || [];
          return (
            <div className="fx-lp" key={chainId} style={{ borderLeftColor: def.color }}>
              <div className="fx-lp-head">
                <span className="fx-dot" style={{ background: def.color }} />
                {def.label} launchpads
              </div>
              {pads.length === 0 ? (
                <div className="fx-lp-empty">No launchpad detected on this chain yet</div>
              ) : (
                <div className="fx-lp-pills">
                  {/* Every pill here is detectable by definition -- the server
                      only publishes what it can actually recognise -- so there
                      is no disabled state and no "soon". */}
                  {pads.map(lp => {
                    const key = `${chainId}:${lp.id}`;
                    return (
                      <button
                        key={key}
                        className={`fx-pill ${lpSet.has(key) ? 'on' : ''}`}
                        onClick={() => toggleLp(chainId, lp.id)}
                      >{lp.label}</button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {/* THE FILTERS BELOW ARE A VIEW, NOT A MUTE, UNLESS THIS IS ON.
          Without this switch the thresholds only ever reached the feed, so a
          Market cap max emptied the deck while toasts kept arriving for tokens
          far above it. Stated on the control itself, because "why am I still
          being notified" is not something anyone should have to work out. */}
      <button
        type="button"
        className={`fx-alertmatch${filter.alertFiltersOn ? ' on' : ''}`}
        onClick={() => onAlertFiltersToggle?.()}
        aria-pressed={!!filter.alertFiltersOn}
      >
        <span className="fx-am-box" aria-hidden="true">{filter.alertFiltersOn ? '✓' : ''}</span>
        <span className="fx-am-text">
          <b>Only alert me about calls matching these filters</b>
          <em>
            {filter.alertFiltersOn
              ? 'Desktop alerts obey the thresholds below.'
              : 'Filters affect the feed only — alerts still fire for everything.'}
          </em>
        </span>
      </button>

      {METRIC_SECTIONS.map(s => (
        <Section
          key={s.id}
          id={s.id}
          label={s.label}
          note={s.note}
          open={open[s.id]}
          count={sectionActive(s)}
          onToggle={() => toggleSection(s.id)}
        >
          <div className="fx-rows">
            {s.rows.map(r => (
              <RangeRow
                key={r.key}
                label={r.label}
                unit={r.unit}
                min={filter[`${r.key}Min`]}
                max={filter[`${r.key}Max`]}
                onMin={v => update(`${r.key}Min`, v)}
                onMax={v => update(`${r.key}Max`, v)}
              />
            ))}
            {s.id === 'risk' && (
              <RangeRow
                label="Max rug risk"
                unit="score"
                single
                max={filter.rugRiskMax}
                onMax={v => update('rugRiskMax', v)}
              />
            )}
          </div>
        </Section>
      ))}

      {activeCount > 0 && (
        <button className="fx-clear" onClick={clearAll}>
          Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
        </button>
      )}
    </aside>
  );
}

function Section({ label, note, open, count, onToggle, children }) {
  return (
    <div className={`fx-sec ${open ? 'open' : ''}`}>
      <button className="fx-sec-head" onClick={onToggle}>
        <IconChevron open={open} />
        <span className="fx-sec-label">{label}</span>
        {note && <span className="fx-sec-note">{note}</span>}
        {count > 0 && <span className="fx-sec-count">{count}</span>}
      </button>
      {open && <div className="fx-sec-body">{children}</div>}
    </div>
  );
}

function RangeRow({ label, unit, min, max, onMin, onMax, single = false }) {
  return (
    <div className="fx-row">
      <span className="fx-row-label">
        {label}
        {unit && <em>{unit}</em>}
      </span>
      <span className="fx-row-inputs">
        {!single && (
          <input
            type="number" placeholder="min" value={min}
            onChange={e => onMin(e.target.value)}
            className={min !== '' ? 'set' : ''}
          />
        )}
        <input
          type="number" placeholder={single ? 'any' : 'max'} value={max}
          onChange={e => onMax(e.target.value)}
          className={max !== '' ? 'set' : ''}
        />
      </span>
    </div>
  );
}

/* Chain mark: real logo when we have one, otherwise a coloured dot. Sized
   explicitly -- an unconstrained <img> here previously rendered at natural
   size and filled the entire rail with a solid blue square. */
function ChainMark({ chain }) {
  const [failed, setFailed] = useState(false);
  if (!chain.logo || failed) {
    return <span className="fx-chain-dot" style={{ background: chain.color }} />;
  }
  return <img className="fx-chain-img" src={chain.logo} alt="" onError={() => setFailed(true)} />;
}

function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" />
    </svg>
  );
}

function IconChevron({ open }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 12 12" fill="none"
      stroke="currentColor" strokeWidth="1.8"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .16s ease', flexShrink: 0 }}
    >
      <path d="M4 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* Alert state per chain. Two distinct glyphs rather than one dimmed glyph,
   because "muted" has to be readable at a glance next to six other pills --
   a lower opacity alone is not a state, it is just quieter. */
function IconBellOn() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconBellOff() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <path d="M18.63 13A17.9 17.9 0 0 1 18 8" />
      <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
      <path d="M18 8a6 6 0 0 0-9.33-5" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
