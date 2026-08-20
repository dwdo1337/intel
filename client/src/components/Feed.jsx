import './feed-card.css';
import { useState, useEffect } from 'react';
import { fmt } from '../App';
import { CHAIN_LAUNCHPADS } from './Filters';
import { CHIPS } from './Filters';
import { gmgnUrl, gmgnWalletUrl } from '../lib/gmgn';

export function fmtPrice(p) {
  if (p == null) return '—';
  if (p >= 0.01) return p.toFixed(4);
  // Avoid JS's default scientific notation for tiny memecoin prices;
  // show leading zeros the way traders actually read them.
  const str = p.toFixed(12).replace(/0+$/, '');
  return str;
}

function fmtRelTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}



/** Split text around every occurrence of `address`, so the CA can be
 *  highlighted in place. Case-insensitive because EVM addresses get pasted in
 *  mixed case (checksummed) while our stored CA may not be. */
export function splitOnAddress(text, address) {
  if (!address) return [{ t: text, isCa: false }];
  const hay = text.toLowerCase();
  const needle = address.toLowerCase();
  const parts = [];
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) { parts.push({ t: text.slice(i), isCa: false }); break; }
    if (at > i) parts.push({ t: text.slice(i, at), isCa: false });
    parts.push({ t: text.slice(at, at + address.length), isCa: true });
    i = at + address.length;
  }
  return parts.filter(p => p.t);
}

/**
 * What people said back to the call.
 *
 * Replies are captured by matching a message's reply target against the
 * message that carried the CA, and chaining through reply-to-reply, so a whole
 * thread lands here. This is frequently where the actual signal is: "aped",
 * "dev already sold", "this is the guy who rugged X" — reactions that no
 * market-data provider can give you.
 *
 * Only replies made while the app was running can be seen; history is not
 * backfilled. Bot replies are dropped by the same guard that silences echo
 * bots as callers.
 */
export function Replies({ replies, count }) {
  const [open, setOpen] = useState(false);
  if (!replies || !replies.length) return null;
  const shown = open ? replies : replies.slice(-3);
  const hidden = replies.length - shown.length;

  return (
    <div className="fc-row">
      <span className="fc-key">
        {count === 1 ? 'Reply' : 'Replies'} <b className="fc-key-n">{count}</b>
      </span>
      <div className="fc-val replies">
      <div className="replies-head">
        {hidden > 0 && (
          <button className="replies-more" onClick={e => { e.stopPropagation(); setOpen(true); }}>
            show {hidden} earlier
          </button>
        )}
        {open && replies.length > 3 && (
          <button className="replies-more" onClick={e => { e.stopPropagation(); setOpen(false); }}>
            collapse
          </button>
        )}
      </div>
      {shown.map((r, i) => (
        <div key={`${r.author}-${r.at}-${i}`} className="reply">
          <span className="reply-author">@{r.author}</span>
          <span className="reply-text">{r.text}</span>
          {/* A message in a forum topic technically replies to the topic root.
              That is weaker evidence than someone deliberately hitting reply,
              so it is marked rather than presented as a direct response. */}
          {r.viaTopic && <span className="reply-topic" title="Posted in the topic, not a direct reply">topic</span>}
        </div>
      ))}
      </div>
    </div>
  );
}

/**
 * WHO HOLDS IT — captured at scan, re-checked on refresh.
 *
 * The single most decision-relevant row on the card for someone hunting alpha,
 * so it sits above the message and reads left to right in order of what a
 * trader asks: is smart money in it, and are KOLs in it.
 *
 * Renders nothing when the check has not run (null) rather than a row of
 * zeroes -- "not checked" and "nobody is in it" are different facts, and only
 * one of them is a reason not to buy.
 */
/** "50" from a page of 50 means "at least 50". Rendering it bare turned a
 *  truncation artifact into what looked like an exact measurement. */
function countLabel(n, capped) {
  return capped ? `${n}+` : String(n);
}

/** Prefer the live reading once a refresh has produced one, else the frozen
 *  scan value, else an honest dash. Never renders 0 for "not measured". */
function liveOr(live, scan) {
  const v = live ?? scan;
  return v == null ? '—' : `$${fmt(v)}`;
}

function pctDelta(from, to) {
  if (!from) return '';
  return `${(((to / from) - 1) * 100).toFixed(1)}%`;
}

/**
 * Wallet intelligence, ONE POPULATION PER ROW.
 *
 * The previous layout put holders and traders in one row and KOL and smart
 * money in another, so a card showed two different "SMART" numbers and two
 * different "KOL" numbers with wallets and handles interleaved between them —
 * unreadable at a glance, and genuinely ambiguous about which number meant
 * what.
 *
 * Now each row is one kind of wallet, and every row reads the same way:
 *
 *   SMART MONEY   24 holding   0x92…ca82  @zatchbell85  0x63…d757
 *   KOL           17 holding   @hzjxhcyy  @feibo03  @XIGUA0903
 *
 * "holding" means a live position right now — wallets that traded the token
 * and exited are excluded, because the row's label is a claim about the
 * present.
 */
export function WalletRows({ holders, chain, dexPaid }) {
  const h = holders;
  const has = v => v != null && v > 0;

  // Only point-in-time holders remain. `holders` being null means the check
  // never ran (unsupported chain, or not enriched yet) and must render nothing
  // -- "we did not look" is not "nobody is in it".
  const anyHolders = has(h?.smartMoney) || has(h?.kols);
  if (!h) return null;

  // A checked token with nobody notable in it is a real finding, stated once.
  // If notable wallets HAVE been in it and left, say that instead — "nobody is
  // in this" and "three KOLs bought this and dumped it" are very different
  // findings, and the second one only exists because the holding filter
  // separates them.
  const out = (h.kolsOut || 0) + (h.smartOut || 0);
  if (!anyHolders) {
    return (
      <div className="fc-row wrow wrow-empty">
        <span className="fc-key">Wallets</span>
        <div className="fc-val">
          <span className="wrow-none">
            {out > 0
              ? `${out} notable wallet${out === 1 ? '' : 's'} traded this and sold out — none holding now`
              : 'no KOL or smart money among top holders'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="wrows">
      {/* ── SMART MONEY / KOL ──
          Deliberately reduced to ONE fact per row: how many are holding it
          right now, and who they are.

          The previous version also carried "N traded ▲x ▼y", "N in before the
          call" and a net-USD figure. Those describe the rolling trade window,
          which answers a different question, over a different time base, from a
          different source — so the row asked the reader to hold four framings
          at once to extract the only thing they wanted: is anyone good in this,
          and who. The trade-flow detail still exists in the Inspector, where
          there is room to label it properly. */}
      {has(h?.smartMoney) && (
        <div className="fc-row wrow wrow-smart">
          <span className="fc-key" title="Wallets with a statistically proven profitable record, ranked by GMGN on realised P&L. Holding this token as of the last scan or refresh.">Smart money</span>
          <div className="fc-val wrow-body">
          <span className="wrow-stat">
            <b>{countLabel(h.smartMoney, h.smartCapped)}</b> holding
          </span>
          <WalletLinks handles={[]} wallets={h?.smartWallets || []} chain={chain} />
          </div>
        </div>
      )}

      {has(h?.kols) && (
        <div className="fc-row wrow wrow-kol">
          <span className="fc-key" title="Publicly known influencer wallets. Influence is reach, not a profitable record — that is SMART MONEY. Holding this token as of the last scan or refresh.">KOL</span>
          <div className="fc-val wrow-body">
          <span className="wrow-stat">
            <b>{countLabel(h.kols, h.kolsCapped)}</b> holding
          </span>
          {/* `named` now carries unnamed KOL holders too, so WalletLinks routes
              each entry by whether it has a handle: X profile if it does, GMGN
              wallet page if it does not. */}
          <WalletLinks handles={h?.named || []} wallets={[]} chain={chain} />
          {h?.checkedAt && (
            <span className="wrow-when" title={`Wallet data read ${new Date(h.checkedAt).toLocaleTimeString()}. Press ↻ to re-check.`}>
              {fmtRelTime(h.checkedAt)}
            </span>
          )}
          </div>
        </div>
      )}

      {/* The LAUNCH row is gone. It carried bundler and sniper exposure, both
          of which saturated the 50-wallet fetch page on nearly every token — so
          "50+ wallets" described the page size, not the launch, and the
          share-of-supply figure only covered the wallets that fit on that page.
          DEX Paid had already moved up beside the ticker.

          The "checked N ago" stamp moved onto the KOL row above, so the card
          still says how fresh its holder data is. */}
    </div>
  );
}

/**
 * Per-caller track record, shown beside their handle.
 *
 * Fetched once for the whole feed and shared, rather than per card — 150 cards
 * each requesting the same aggregate would be 150 identical round trips.
 *
 * Deliberately silent unless the record means something: at least 3 scored
 * calls and a third of their calls measured. Below that the honest answer is
 * nothing, not a confident-looking median from two data points.
 */
let _callersCache = null;
let _callersAt = 0;
const _callersWaiters = [];

function useCallerRecord(author) {
  const [rec, setRec] = useState(null);
  useEffect(() => {
    if (!author) return;
    let alive = true;
    const apply = (data) => {
      if (!alive || !data) return;
      const key = String(author).toLowerCase();
      setRec((data.callers || []).find(c => String(c.author).toLowerCase() === key) || null);
    };
    if (_callersCache && Date.now() - _callersAt < 60_000) { apply(_callersCache); return () => { alive = false; }; }
    _callersWaiters.push(apply);
    if (_callersWaiters.length === 1) {
      fetch('/api/callers').then(r => r.json()).then(d => {
        _callersCache = d; _callersAt = Date.now();
        while (_callersWaiters.length) _callersWaiters.shift()(d);
      }).catch(() => { _callersWaiters.length = 0; });
    }
    return () => { alive = false; };
  }, [author]);
  return rec;
}

function CallerRecord({ author }) {
  const rec = useCallerRecord(author);
  if (!rec || rec.scored < 3 || rec.coverage < 0.34 || rec.medianMult == null) return null;
  const m = rec.medianMult;
  const tone = m >= 1.5 ? 'good' : m >= 0.9 ? 'mid' : 'bad';
  return (
    <span className={`caller-rec ${tone}`}
          title={`@${rec.author}: median ${m.toFixed(2)}x across ${rec.scored} scored calls (of ${rec.calls}). `
               + `${Math.round((rec.winRate || 0) * 100)}% held or gained, ${Math.round((rec.rugRate || 0) * 100)}% fell below 0.2x`
               + (rec.best ? `. Best: ${rec.best.symbol} ${rec.best.mult.toFixed(1)}x` : '')}>
      {m.toFixed(2)}× med
      <span className="caller-rec-n">{rec.scored}</span>
    </span>
  );
}

/** Handles link to X, anonymous wallets to their GMGN page. Kept in one place
 *  so both rows render identity the same way. */
function WalletLinks({ handles, wallets, chain }) {
  // An entry WITH a handle links to X; the same entry without one links to its
  // GMGN wallet page. Both are "who is in this", so they render in one list
  // rather than as two separate groups -- and an unnamed wallet is no longer
  // dropped, which is what used to make a row of "17 holding" show three names
  // and nothing else.
  const seen = new Set();
  const items = [];
  for (const k of [...handles, ...wallets]) {
    if (!k) continue;
    const id = k.handle || k.wallet;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const supply = k.pct != null && k.pct > 0 ? `${k.pct.toFixed(2)}% of supply` : null;
    const pnl = k.profit ? ` · realised P&L $${Math.round(k.profit)}` : '';
    if (k.handle) {
      items.push({
        key: id, label: '@' + k.handle, href: `https://x.com/${k.handle}`,
        title: `${k.name ? k.name + ' — ' : ''}${supply || 'holding'}${pnl} — opens X profile`,
        cls: 'wrow-handle',
      });
    } else if (k.wallet) {
      items.push({
        key: id, label: `${k.wallet.slice(0, 4)}…${k.wallet.slice(-4)}`,
        href: gmgnWalletUrl(chain, k.wallet),
        title: `${supply || 'wallet'}${pnl} — opens this wallet on GMGN`,
        cls: 'wrow-wallet',
      });
    }
  }
  const MAX = 6;
  const shown = items.slice(0, MAX);
  const rest = items.length - shown.length;
  if (!shown.length) return null;
  return (
    <span className="wrow-ids">
      {shown.map(i => (
        <a key={i.key} className={i.cls} href={i.href} target="_blank" rel="noreferrer"
           onClick={e => e.stopPropagation()} title={i.title}>{i.label}</a>
      ))}
      {rest > 0 && <span className="wrow-more" title="Only the largest positions are fetched">+{rest}</span>}
    </span>
  );
}

/* AlphaRow removed 2026-08-03. It was an earlier one-line version of the
 * wallet row, superseded by WalletRows, and nothing rendered it — but it
 * still carried the bundler/sniper chips, so it would have been the last
 * place those reappeared from. */


/**
 * KOL and Smart Money activity seen while the app was watching.
 *
 * Renders NOTHING when `kols` is null. That is deliberate: null means the
 * watcher never observed this token, which is not the same as "no notable
 * wallet touched it" — showing a zero would be inventing a fact. The header
 * says "since watching" for the same reason: the feed is a rolling window and
 * cannot see a KOL who bought before the app started.
 *
 * KOL and Smart Money stay visually separate because GMGN treats them as
 * different populations: KOLs are public influencers (social signal), Smart
 * Money is a proven profitable record (alpha signal).
 */
export function NotableWallets({ kols, flow }) {
  const groups = kols ? [
    { key: 'kol', label: 'KOL', data: kols.kol },
    { key: 'smart', label: 'SMART', data: kols.smart },
  ].filter(g => g.data && g.data.count > 0) : [];
  if (!groups.length && !flow) return null;

  // Aggregate net flow, from a source independent of the named-wallet feed.
  if (!groups.length && flow) {
    return (
      <div className="notable-row">
        <FlowChip flow={flow} />
        <span className="notable-since">tracked smart-money wallets</span>
      </div>
    );
  }

  return (
    <div className="notable-row" title={`Observed since ${new Date(kols.watchedSince).toLocaleTimeString()} — rolling window, not a complete history`}>
      {groups.map(g => {
        const net = g.data.netUsd;
        const dir = net > 0 ? 'buying' : net < 0 ? 'selling' : 'flat';
        return (
          <div key={g.key} className={`notable-chip notable-${dir}`}>
            <span className="notable-label">{g.label}</span>
            <b>{g.data.count}</b>
            <span className="notable-split">
              {g.data.buyers}▲ {g.data.sellers}▼
            </span>
            {/* "already in" is the number that matters when the alert fires;
                "since" is what matters afterwards. Shown separately because
                they answer different questions and a single total hides
                whether smart money led the call or followed it. */}
            {g.data.alreadyIn > 0 && (
              <span className="notable-prior" title="Were already trading this before your chat called it">
                {g.data.alreadyIn} in
              </span>
            )}
            {g.data.sinceCall > 0 && g.data.alreadyIn > 0 && (
              <span className="notable-split" title="Traded it after the call">
                +{g.data.sinceCall} since
              </span>
            )}
            <span className="notable-net">
              {net > 0 ? '+' : ''}{Math.abs(net) >= 1000 ? (net / 1000).toFixed(1) + 'K' : net}
            </span>
          </div>
        );
      })}
      {/* Named wallets only -- Smart Money is frequently anonymous, and a
          truncated 0x address tells the eye nothing. */}
      <div className="notable-names">
        {[...(kols.kol.wallets || []), ...(kols.smart.wallets || [])]
          .filter(w => w.handle)
          .slice(0, 3)
          .map(w => (
            <a key={w.handle} className="notable-name"
               href={`https://x.com/${w.handle}`} target="_blank" rel="noreferrer"
               onClick={e => e.stopPropagation()}
               title={`${w.name || w.handle} — ${w.buys} buy / ${w.sells} sell, net $${w.netUsd}`}>
              @{w.handle}
            </a>
          ))}
      </div>
      <FlowChip flow={flow} />
      {/* Says which window the counts actually cover: since the call when we
          were already watching then, otherwise since the app started. */}
      <span className="notable-since">{kols.scopedToCall ? 'since call' : 'since watching'}</span>
    </div>
  );
}

/**
 * Aggregate smart-money net flow (Binance Web3 — keyless, so this works even
 * with no GMGN key configured).
 *
 * `acceleration` is the last hour measured against the average hour of the
 * last day: 12.75 means money arrived 12.75x faster in the last hour than it
 * has been all day. It is only shown when the backend could compute it against
 * a meaningful base — a ratio against near-zero flow is noise, not a signal.
 */
function FlowChip({ flow }) {
  if (!flow || flow.inflow24h == null) return null;
  const v = flow.inflow24h;
  // Magnitude only -- the sign is rendered separately, and using the raw value
  // here printed "−$-30" for outflows.
  const abs = Math.abs(v);
  const usd = abs >= 1000 ? (abs / 1000).toFixed(1) + 'K' : Math.round(abs);
  const hot = flow.acceleration != null && flow.acceleration >= 2;
  return (
    // Label spells out what the number is. "FLOW +$1.4K / 24x accelerating"
    // told you nothing about whose money, over what period, or what the
    // multiplier compared against.
    <div className={`notable-chip ${v >= 0 ? 'notable-buying' : 'notable-selling'}`}
         title={`${flow.traders ?? '?'} smart-money wallets traded this in 24h. Money in minus money out: 1h $${Math.round(flow.inflow1h ?? 0)} · 4h $${Math.round(flow.inflow4h ?? 0)} · 24h $${Math.round(v)}. Source: ${flow.source}.`}>
      {/* Lead with HOW MANY wallets. A bare "-$30 net" is unreadable: it could
          be one wallet trimming or thirty wallets leaving, and those are
          opposite signals. The dollar figure is secondary context. */}
      {flow.traders > 0 && (
        <>
          <b className="notable-count">{flow.traders}</b>
          <span className="notable-label">SMART {flow.traders === 1 ? 'WALLET' : 'WALLETS'} TRADED</span>
        </>
      )}
      {!flow.traders && <span className="notable-label">SMART MONEY</span>}
      <span className="notable-net">{v >= 0 ? '+' : '−'}${usd} net</span>
      <span className="notable-split">24h</span>
      {flow.acceleration != null && (
        <span className={`notable-accel${hot ? ' notable-accel-hot' : ''}`}
              title="Last hour's inflow compared with the average hour of the last 24h">
          {flow.acceleration}× vs avg hr
        </span>
      )}
    </div>
  );
}

/** The original chat message that carried the CA, with the address
 *  highlighted. Always renders something: a call that is nothing but a
 *  contract address says so, rather than leaving a blank gap on the card. */
export function MessageQuote({ body, address }) {
  const text = (body || '').trim();
  if (!text) {
    return <div className="msg-quote msg-quote-none">No message text with this call</div>;
  }
  // Decided with the SAME matcher that renders below. It used to be
  // `text.split(address)`, which is case-sensitive: a message carrying a
  // checksummed `0xAbC…` against a lowercased stored CA did not register as
  // "just the address", fell through to the renderer -- which DOES match
  // case-insensitively -- and drew a lone green CA chip directly beneath the
  // card's own contract-address row. The same address twice, in two different
  // treatments, with no words between them.
  const parts = splitOnAddress(text, address);
  const withoutCa = parts.filter(p => !p.isCa).map(p => p.t).join('').trim();
  if (!withoutCa) {
    return <div className="msg-quote msg-quote-none">Contract address only — no message text</div>;
  }
  return (
    <div className="msg-quote" title={text}>
      {parts.map((p, i) => (
        p.isCa
          ? <mark key={i} className="msg-ca" title={p.t}>{p.t.slice(0, 6)}…{p.t.slice(-4)}</mark>
          : <span key={i}>{p.t}</span>
      ))}
    </div>
  );
}

// gmgnUrl lives in ../lib/gmgn -- one shared definition for the feed, the
// in-app toast and the Electron toast.

function chainSlug(raw) {
  const c = (raw || 'solana').toLowerCase();
  if (c === 'sol' || c === 'solana') return 'solana';
  if (c === 'base') return 'base';
  if (c === 'eth' || c === 'ethereum' || c === 'erc20') return 'eth';
  if (c === 'bsc' || c === 'bnb' || c === 'binance') return 'bsc';
  if (c === 'robinhood' || c === 'rh') return 'robinhood';
  return c;
}

function chainLabelOf(chain, raw) {
  if (chain === 'solana') return 'Solana';
  if (chain === 'base') return 'Base';
  if (chain === 'eth') return 'Ethereum';
  if (chain === 'bsc') return 'BSC';
  if (chain === 'robinhood') return 'Robinhood';
  return (raw || 'SOL').toUpperCase();
}

function xSearchUrl(address) {
  return `https://x.com/search?q=${encodeURIComponent(address)}`;
}

function launchpadUrl(chain, launchpad, address) {
  const lp = (launchpad || '').toLowerCase();
  const c = chainSlug(chain);
  if (lp.includes('pump')) return `https://pump.fun/coin/${address}`;
  if (lp.includes('bonk')) return `https://letsbonk.fun/token/${address}`;
  if (lp.includes('hood')) return `https://hood.fun/token/${address}`;
  if (lp.includes('noxa')) return `https://noxa.fun/token/${address}`;
  if (lp.includes('pons')) return `https://pons.digital/${address}`;
  if (lp.includes('clanker')) return c === 'base' ? `https://clanker.world/base/${address}` : `https://clanker.world/eth/${address}`;
  if (lp.includes('four')) return `https://four.meme/token/${address}`;
  if (lp.includes('zora')) return `https://zora.co/collect/base:${address}`;
  // No known launchpad page: GMGN's token page if it covers this chain, else
  // DexScreener. Never a guessed chain -- that produces a blank page.
  return gmgnUrl(c, address) || `https://dexscreener.com/${c}/${address}`;
}

export function Feed({ events, selected, onSelect, filter, setFilter }) {
  const chip = filter?.chips || 'All';
  const setChip = id => setFilter?.(p => ({ ...p, chips: id }));

  const visible = events;

  return (
    <div className="dash-col">
      <div className="dash-col-head">Command deck · {visible.length} events</div>
      <div className="feed-col">
        <div className="feed-head">
          <div className="feed-title">Live feed</div>
          <div className="feed-chips">
            {CHIPS.map(c => (
              <span key={c.id} className={`chip ${chip === c.id ? 'active' : ''}`}
                    onClick={() => setChip(c.id)}>{c.label}</span>
            ))}
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="feed-empty">
            <span className="feed-empty-pulse" />
            {/* An active filter with no matches is NOT the same as no signals.
                The tab selection persists, so it is entirely possible to open
                the app on an empty Watchlist and conclude the whole thing is
                broken -- which is exactly what happened while testing this. */}
            {chip === 'Watchlist' ? (
              <>
                <div className="feed-empty-title">YOUR WATCHLIST IS EMPTY</div>
                <div className="feed-empty-sub">
                  Press the ☆ on any card to track it here. Signals are still
                  arriving — switch to <b>All signals</b> to see them.
                </div>
              </>
            ) : chip === 'Follow-ups' ? (
              <>
                <div className="feed-empty-title">NOTHING CALLED TWICE YET</div>
                <div className="feed-empty-sub">
                  This tab shows tokens that <b>different people</b> called more
                  than once. Switch to <b>All signals</b> for everything.
                </div>
              </>
            ) : (
              <>
                <div className="feed-empty-title">WATCHING — NOTHING CAPTURED YET</div>
                <div className="feed-empty-sub">New calls from your monitored Telegram &amp; Discord sources will appear here in real time.</div>
              </>
            )}
          </div>
        ) : visible.map((ev, i) => (
          <MsgCard key={ev.id} event={ev} active={selected?.id === ev.id} onClick={() => onSelect(ev.id)} index={i} />
        ))}
      </div>
    </div>
  );
}

function MsgCard({ event, active, onClick, index = 0 }) {
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // A failed refresh used to be indistinguishable from a successful one: the
  // response was discarded, so "DexScreener has no pair for this token" and
  // "re-read everything" both rendered as the spinner stopping with the same
  // numbers on screen. That is what makes a refresh look like it silently does
  // nothing. The outcome is now reported.
  const [refreshErr, setRefreshErr] = useState(null);

  const refreshCard = async (e) => {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    setRefreshErr(null);
    try {
      const res = await fetch('/api/refresh/' + encodeURIComponent(event.token.address), { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setRefreshErr(data?.error || `refresh failed (${res.status})`);
      }
      // On success the card re-renders from the socket 'ca_update' events the
      // server emits -- one per provider as the deep re-scan lands.
    } catch (err) {
      setRefreshErr(err.message || 'could not reach the backend');
    } finally {
      // Held slightly longer than the request so the deep re-scan running
      // behind it is visibly still in progress rather than claiming to be done.
      setTimeout(() => setRefreshing(false), 900);
    }
  };

  // Optimistic local state so the star responds instantly; the server's
  // ca_update is the source of truth and overwrites it a moment later.
  const [watchOverride, setWatchOverride] = useState(null);
  const watched = watchOverride != null ? watchOverride : !!event.watched;

  const toggleWatch = async (e) => {
    e.stopPropagation();
    const next = !watched;
    setWatchOverride(next);
    try {
      await fetch('/api/watch/' + encodeURIComponent(event.token.address), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watched: next }),
      });
    } catch (_) {
      setWatchOverride(!next);            // put the star back if it did not save
    }
  };
  if (!event || !event.token) return null;
  const m = event.metrics || {};
  const s = event.safety || {};
  const initials = (event.token.name || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
  const platformColor = event.platform === 'tg' ? '#3b82f6' : '#a855f7';
  const color = event.platform === 'tg' ? '#4fe3a0' : '#a855f7';
  const chain = chainSlug(event.token.chain);
  const chainLabel = chainLabelOf(chain, event.token.chain);
  const chainDef = CHAIN_LAUNCHPADS.find(c => c.id === chain);
  // Chain colour is identity, not emphasis: it tells you WHAT this is, and
  // with a handful of chains it works as a legend rather than a highlight.
  const chainColor = chainDef?.color || 'var(--muted)';
  const address = event.token.address || '';
  // The message a caller actually typed. Previously the CA was STRIPPED out
  // of it -- but 19 of 28 real calls are nothing but the bare CA, so
  // stripping left an empty string and the whole quote block silently
  // disappeared on most cards. The address is now highlighted in place
  // instead, and a CA-only message says so explicitly rather than vanishing.
  const rawBody = (event.body || '').replace(/\n{3,}/g, '\n\n').trim();

  const quickUrl = gmgnUrl(chain, address);
  const dexUrl = event.links?.pair || `https://dexscreener.com/${chain}/${address}`;
  const lpUrl = launchpadUrl(event.token.chain, event.launchpad, address);
  const xUrl = xSearchUrl(address);

  const safeChg5m = typeof m.chg5m === 'number' ? m.chg5m : null;
  const sourceName = event.sourceName || 'Unknown';
  const platformLabel = event.platform === 'tg' ? 'Telegram' : event.platform === 'dc' ? 'Discord' : 'Source';
  // Real launchpad if RugCheck/heuristic identified one; otherwise the DEX
  // name, clearly labelled as a DEX rather than implying a launchpad.
  const hasLaunchpad = !!event.launchpad;
  const venueLabel = event.launchpad || event.dex || null;
  // A launchpad token with no pool is pre-graduation: still on the bonding
  // curve, so there is nothing for an AMM to report yet.
  const bondingCurve = hasLaunchpad && (m.liveLiq ?? m.liq) == null;

  // "Since call" is the multiplier against the mcap captured at first
  // detection -- NOT the 5m price change, which is a completely different
  // number and was previously mislabelled as "since call".
  // These exist only once the user has actually refreshed this card.
  const refreshedPct = typeof m.changeSinceScan === 'number' ? m.changeSinceScan : null;
  const mult = typeof m.multiplier === 'number' ? m.multiplier : null;
  const sinceCallPct = mult != null ? (mult - 1) * 100 : null;

  const mentionCount = Array.isArray(event.mentions) ? event.mentions.length : 0;
  const isFollowup = event.type === 'followup';

  return (
    <div
      className={`msg-card ${isFollowup ? 'followup' : ''} ${active ? 'selected' : ''} ${watched ? 'watched' : ''} ${event.token.banner ? 'has-banner' : ''}`}
      style={{ borderLeft: `3px solid ${platformColor}`, animationDelay: `${Math.min(index, 8) * 30}ms` }}
      onClick={onClick}
    >
      {event.token.banner && (
        <div className="msg-banner" style={{ backgroundImage: `url(${event.token.banner})` }} />
      )}

      {/* ── identity: image, name, ticker, chain, venue, time ── */}
      <div className="msg-head">
        {event.token.image ? (
          <img className="msg-av-real" src={event.token.image} alt="" onError={e => { e.target.style.display='none'; const fb=e.target.nextSibling; if(fb) fb.style.display='flex'; }} />
        ) : null}
        {/* Tinted by source, not by token: a flat tile per platform reads as a
            category, where the old per-token gradient was noise. */}
        <div className="msg-av"
             style={{ background: `${color}1f`, color,
                      display: event.token.image ? 'none' : 'flex' }}>{initials}</div>
        <div className="msg-meta-head">
          <div className="msg-line1">
            <span className="msg-token">{event.token.name || 'Unknown'}</span>
            <span className="msg-ticker">{event.token.symbol || '—'}</span>
            {/* DEX Paid belongs with the token's identity, not buried in the
                launch row: it is the fastest read on whether anyone spent money
                presenting this token. Reflects the last scan or refresh.
                null = never checked, and renders as nothing rather than as
                "No" -- an unchecked profile is not a finding. */}
            {event.safety?.dexPaid === true && (
              <span className="msg-dexpaid" title="Paid, approved DexScreener token profile — checked at the last scan or refresh">
                DEX PAID
              </span>
            )}
            {event.safety?.dexPaid === false && (
              <span className="msg-dexpaid no" title="No approved paid DexScreener profile as of the last scan or refresh">
                NO DEX PAID
              </span>
            )}
          </div>
          <div className="msg-venue-row">
            <span className="venue-chip chain"
                  style={{ background: `${chainColor}1c`, color: chainColor }}>
              <span className="venue-dot" style={{ background: chainColor }} />
              {chainLabel}
            </span>
            {venueLabel && (
              <span className={`venue-chip ${hasLaunchpad ? 'launchpad' : 'dex'}`}>
                {hasLaunchpad ? venueLabel : `${venueLabel} (DEX)`}
              </span>
            )}
            {isFollowup && mentionCount > 1 && (
              <span className="venue-chip repeat">↻ called {mentionCount}×</span>
            )}
          </div>
        </div>
        <div className="msg-time">{fmtRelTime(event.time)}</div>
      </div>

      {/* ── headline metrics ──
          BEFORE a refresh these are the frozen scan snapshot, which is the
          point: the card shows what was true when the call fired.

          AFTER a refresh they show the LIVE reading, with the call-time value
          as the sub-label. Previously the headline stayed frozen forever and
          only a small strip at the bottom carried the live market cap, while
          LIQUIDITY and VOLUME had no live display at all — `liveLiq` was sent
          by the server and never rendered. So pressing refresh visibly changed
          almost nothing, which is indistinguishable from refresh being broken.

          The stored `scan_*` fields are still never overwritten; this is purely
          about which of the two the card leads with once both exist. */}
      <div className="msg-kpis">
        <Kpi
          label="Market cap"
          value={liveOr(m.liveMcap, m.mcap)}
          sub={refreshedPct == null ? 'at time of call'
            : `${refreshedPct >= 0 ? '+' : ''}${refreshedPct.toFixed(1)}% · was $${fmt(m.mcap)} at call`}
          tone={refreshedPct == null ? null : refreshedPct >= 0 ? 'up' : 'down'}
        />
        <Kpi
          label="Liquidity"
          value={liveOr(m.liveLiq, m.liq)}
          sub={(m.liveLiq ?? m.liq) == null
            // "no pool data" reads like a fetch that failed. Measured against
            // DexScreener, every Solana token missing this figure genuinely has
            // no pool: it is still on its launchpad's bonding curve and no AMM
            // pair exists yet. Naming that is useful information -- an early
            // entry -- rather than an apology for missing data.
            ? (bondingCurve ? 'bonding curve · no pair yet' : 'not reported by DEX')
            : m.liveLiq != null && m.liq != null && m.liveLiq !== m.liq
              ? `${m.liveLiq >= m.liq ? '+' : ''}${pctDelta(m.liq, m.liveLiq)} · was $${fmt(m.liq)}`
              // Where the figure came from, when it did not come from the
              // provider every other number on this card came from. A bonding
              // curve's real depth and an AMM pool's are different
              // measurements, and a row that shows one while implying the other
              // is the kind of quiet wrongness this app exists not to do.
              : m.liqSource === 'pumpfun-curve' ? 'bonding curve reserves'
              : m.liqSource === 'gmgn-pool' ? 'pool reserves · GMGN'
              : `${chainLabel} pair`}
          tone={m.liveLiq != null && m.liq != null && m.liveLiq !== m.liq
            ? (m.liveLiq >= m.liq ? 'up' : 'down') : null}
        />
        {/* Holder count comes from RugCheck on Solana and GMGN elsewhere, and
            is re-read on every refresh. */}
        <Kpi
          label="Holders"
          value={m.holders == null ? '—' : fmt(m.holders)}
          sub={m.holders == null
            ? (chain === 'solana' ? 'not indexed yet' : 'not indexed yet')
            : (m.top10 != null ? `top10 ${m.top10.toFixed(0)}%` : 'holder count')}
          tone={m.top10 != null && m.top10 > 80 ? 'down' : null}
        />
      </div>

      {/* ── contract address ──
          On the same gutter as every row below it. It was the one block with
          no label, which left it floating between the metrics and the source
          row with nothing tying it to either. */}
      {address && (
        <div className="fc-row msg-ca-row" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(address); }}>
          <span className="fc-key">Contract</span>
          <div className="fc-val fc-val-ca">
            <span className="msg-ca-text">{shortCa(address)}</span>
            <span className="msg-ca-copy">COPY<IconCopy size={11} /></span>
          </div>
        </div>
      )}

      {/* ── who / where / when ──
          From here down every section is a LABEL + BODY row sharing one
          gutter. Previously each block set its own indent -- the KPI grid, the
          address strip's inner padding, the quote's border-left, the wallet
          rows' box padding -- so six sections started at six different x
          positions and the card had no vertical edge to read down. */}
      <div className="fc-row">
        <span className="fc-key">Source</span>
        <div className="fc-val msg-attrib">
          <span className={`attrib-src ${event.platform === 'tg' ? 'tg' : 'dc'}`}>
            {event.platform === 'tg' ? <IconTelegram size={12} /> : <IconDiscord size={12} />}
            {platformLabel}
          </span>
          <span className="attrib-chat" title={sourceName}>{sourceName}</span>
          {event.author && <span className="attrib-author">@{event.author}</span>}
          {/* The caller's track record, right next to their name — the point of
              measuring it at all. Rendered only when enough of their calls have
              a real outcome; a median built on one scored call out of thirty is
              noise wearing a number's clothes. */}
          <CallerRecord author={event.author} />
        </div>
      </div>

      {/* EVERY caller, not just the first.
          The card showed one name while the badge said "called 2x", which
          reads as a bug -- the second caller existed but was invisible, and
          on a follow-up "who else called it" is the entire point. Each entry
          is a DISTINCT person (bot echoes and repeat posts are already
          filtered out upstream), listed oldest first so you can see who was
          early and who piled in. */}
      {Array.isArray(event.mentions) && event.mentions.length > 1 && (
        <div className="fc-row">
          <span className="fc-key">Callers <b className="fc-key-n">{event.mentions.length}</b></span>
          <div className="fc-val callers-row">
            {[...event.mentions]
              .sort((a, b) => new Date(a.detectedAt) - new Date(b.detectedAt))
              .slice(0, 6)
              .map((mn, i) => (
                <span key={(mn.author || '') + i} className={`caller-chip${i === 0 ? ' caller-first' : ''}`}
                      title={`${mn.chats?.join(', ') || mn.chatName || ''} — ${mn.detectedAt ? new Date(mn.detectedAt).toLocaleTimeString() : ''}`}>
                  @{mn.author || 'unknown'}
                  {i === 0 && <span className="caller-tag">first</span>}
                </span>
              ))}
          </div>
        </div>
      )}

      {/* WHERE it has been called. The callers row above answers "who", which
          is a different question once a CA starts spreading: the same token
          turning up in a second group and then in a Discord server you also
          watch is the signal, and it was invisible because the API collapsed
          mentions by author. Only shown once it has reached more than one room --
          on a single-room call it would just repeat the Source row. */}
      {Array.isArray(event.mentionLog) && event.mentionLog.length > 1 && (
        <div className="fc-row">
          <span className="fc-key">Called in <b className="fc-key-n">{event.mentionLog.length}</b></span>
          <div className="fc-val rooms-col">
            {event.mentionLog.slice(0, 5).map((r, i) => (
              <div key={(r.source || '') + r.chatName + i} className="room-line">
                <span className={`room-src room-${r.source === 'discord' ? 'dc' : 'tg'}`}>
                  {r.source === 'discord' ? 'DC' : 'TG'}
                </span>
                <span className="room-name" title={r.chatName}>{r.chatName}</span>
                <span className="room-who">
                  {r.callers.slice(0, 3).map(c => '@' + (c.author || '?')).join(' ')}
                  {r.callers.length > 3 && ` +${r.callers.length - 3}`}
                </span>
                {i === 0 && <span className="room-tag">first</span>}
              </div>
            ))}
            {event.mentionLog.length > 5 && (
              <div className="room-more">+{event.mentionLog.length - 5} more rooms</div>
            )}
          </div>
        </div>
      )}

      <div className="fc-row">
        <span className="fc-key">Message</span>
        <div className="fc-val"><MessageQuote body={rawBody} address={address} /></div>
      </div>

      <Replies replies={event.replies} count={event.replyCount} />
      <WalletRows holders={event.holders} chain={chain} dexPaid={s.dexPaid} />

      <div className="msg-expander" onClick={e => { e.stopPropagation(); setExpanded(x => !x); }}>
        {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        <span>{expanded ? 'Hide extra metrics' : 'Show more metrics'}</span>
      </div>

      <div className="msg-extra" style={{ maxHeight: expanded ? 460 : 0, opacity: expanded ? 1 : 0 }}>
        <div className="extra-grid">
          <ExtraMetric label="Price" value={m.price == null ? '—' : `$${fmtPrice(m.price)}`} />
          <ExtraMetric label="24h vol" value={m.vol == null ? '—' : `$${fmt(m.vol)}`} />
          <ExtraMetric label="Entry mcap" value={m.entryMcap == null ? '—' : `$${fmt(m.entryMcap)}`} />
          <ExtraMetric label="Multiplier" value={mult == null ? '—' : `${mult.toFixed(2)}×`} sign={mult == null ? null : mult >= 1 ? 'buy' : 'sell'} />
          <ExtraMetric label="Buys" value={m.buys == null ? '—' : fmt(m.buys)} />
          <ExtraMetric label="Sells" value={m.sells == null ? '—' : fmt(m.sells)} />
          <ExtraMetric label="Net buy" value={m.netBuy == null ? '—' : fmt(Math.abs(m.netBuy))}
                       sign={m.netBuy == null ? null : m.netBuy >= 0 ? 'buy' : 'sell'} />
          <ExtraMetric label="TXs" value={m.txs == null ? '—' : fmt(m.txs)} />
          <ExtraMetric label="Age" value={m.ageLabel || '—'} />
          <ExtraMetric label="5m" value={safeChg5m == null ? '—' : `${safeChg5m.toFixed(1)}%`} sign={safeChg5m == null ? null : safeChg5m >= 0 ? 'buy' : 'sell'} />
          <ExtraMetric label="1h" value={m.chg1h == null ? '—' : `${m.chg1h.toFixed(1)}%`} sign={m.chg1h == null ? null : m.chg1h >= 0 ? 'buy' : 'sell'} />
          <ExtraMetric label="24h" value={m.chg24h == null ? '—' : `${m.chg24h.toFixed(1)}%`} sign={m.chg24h == null ? null : m.chg24h >= 0 ? 'buy' : 'sell'} />
          <ExtraMetric label="Top 10 hold" value={m.top10 == null ? 'unknown' : `${m.top10.toFixed(1)}%`} sign={m.top10 != null && m.top10 > 80 ? 'warn' : null} />
          <ExtraMetric label="Dev hold" value={s.devPct == null ? 'unknown' : `${s.devPct}%`} sign={s.devPct != null && s.devPct > 10 ? 'warn' : null} />
          <ExtraMetric label="Rug score" value={s.rugRisk == null ? 'unknown' : `${s.rugRisk}`} sign={s.rugRisk != null && s.rugRisk > 40 ? 'warn' : null} />
          <ExtraMetric label="Insiders" value={s.insiderHolders == null ? 'unknown' : `${s.insiderHolders}`} sign={s.insiderHolders > 0 ? 'warn' : null} />
        </div>
        {/* Name only what is genuinely missing. GMGN covers EVM safety
            (honeypot, taxes, LP, renounced, top-10); it is the RugCheck
            fields -- rug score, insider clusters, dev wallet -- that are
            Solana-only. The old blanket "EVM unavailable" was shown next to
            real EVM safety data that had just been fetched. */}
        {s.source && (
          <div className="extra-source">
            safety data · {s.source}
            {chain !== 'solana' && ' — rug score, insiders and dev wallet are Solana-only'}
          </div>
        )}
      </div>

      {/* The live-market-cap strip that used to sit here is gone. It read
          "now $42.1K \u00b7 1.00\u00d7 \u00b7 from $42.1K at call" in a filled bar at the
          foot of the card \u2014 which is now exactly what MARKET CAP says at the
          top, since the KPIs lead with the live value and carry "was $X at
          call" beneath. The same number twice, in two different visual idioms,
          at opposite ends of one card, invites the reader to hunt for a
          difference between them. The multiplier is still under "Show more
          metrics" with the other derived figures. */}
      {refreshErr && (
        <div className="msg-refresh-error" title={refreshErr}>
          Refresh failed &mdash; {refreshErr}
        </div>
      )}

      <div className="msg-actions">
        {/* Watchlist toggle. Optimistic: the star flips immediately and the
            socket update confirms it, because waiting on a round-trip for a
            bookmark feels broken. */}
        <button
          className={`btn-watch ${watched ? 'on' : ''}`}
          onClick={toggleWatch}
          title={watched ? 'Remove from watchlist' : 'Add to watchlist \u2014 see it in the Watchlist tab'}
        >
          {watched ? '\u2605' : '\u2606'}
        </button>
        <button className={`btn-refresh ${refreshing ? 'busy' : ''}`} onClick={refreshCard}
                title="Re-scan: price, liquidity, holders, safety and who is holding it">
          {refreshing ? '\u2026' : '\u21bb'}
        </button>
        {/* GMGN has no page for some chains. Rather than send the user to a
            blank page on the wrong chain (which is what a 'sol' fallback did
            to every Robinhood token), fall back to the DEX pair. */}
        <a className="btn-buy" href={quickUrl || dexUrl} target="_blank" rel="noreferrer"
           title={quickUrl ? 'Buy on GMGN' : `GMGN has no ${chainLabel} page — opening the DEX pair instead`}
           onClick={e => e.stopPropagation()}>
          {quickUrl ? 'QUICK BUY' : 'OPEN PAIR'}
        </a>
        {address && <>
          <a className="link" href={lpUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{venueLabel || 'Launchpad'} <IconArrowUpRight size={12} /></a>
          <a className="link" href={xUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>X <IconArrowUpRight size={12} /></a>
          <a className="link" href={dexUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>DEXSCREENER <IconArrowUpRight size={12} /></a>
        </>}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone === 'up' ? 'up' : tone === 'down' ? 'down' : ''}`}>{value}</div>
      <div className={`kpi-sub ${tone === 'up' ? 'up' : tone === 'down' ? 'down' : ''}`}>{sub}</div>
    </div>
  );
}

function ExtraMetric({ label, value, sign }) {
  const style = sign === 'buy' ? { color: 'var(--buy)' } : sign === 'sell' ? { color: 'var(--sell)' } : sign === 'warn' ? { color: 'var(--warn)' } : {};
  const unknown = value === 'unknown' || value === '—';
  return (
    <div className="extra-metric">
      <span className="extra-label">{label}</span>
      <span className={`extra-value ${unknown ? 'unknown' : ''}`} style={unknown ? {} : style}>{value}</span>
    </div>
  );
}

function shortCa(addr) {
  return addr.slice(0, 6) + '…' + addr.slice(-6);
}

function IconArrowUpRight({ size = 12 }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ display:'inline-block', verticalAlign:'middle', marginLeft:2 }}><path d="M2 10L10 2M10 2H4M10 2V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function IconChevronUp({ size = 12 }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ display:'inline-block', verticalAlign:'middle', marginLeft:2 }}><path d="M2 8L6 4L10 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function IconChevronDown({ size = 12 }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ display:'inline-block', verticalAlign:'middle', marginLeft:2 }}><path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function IconCopy({ size = 12 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display:'inline-block', verticalAlign:'middle', marginLeft:4 }}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
}
function IconTelegram({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display:'inline-block', verticalAlign:'middle', marginRight:4 }}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>;
}
function IconDiscord({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display:'inline-block', verticalAlign:'middle', marginRight:4 }}><path d="M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M5.5 4h13c.8 0 1.5.7 1.5 1.5v13c0 .8-.7 1.5-1.5 1.5h-3.8l-1.2-1.2-1.2 1.2H10l-1.2-1.2-1.2 1.2H5.5c-.8 0-1.5-.7-1.5-1.5v-13C4 4.7 4.7 4 5.5 4z"/></svg>;
}
