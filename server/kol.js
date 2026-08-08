/**
 * KOL and Smart Money tracking.
 *
 * WHY A WATCHER AND NOT A LOOKUP
 * GMGN exposes recent KOL/Smart-Money trades as a CHAIN-WIDE feed. There is no
 * "which KOLs traded token X" endpoint on the trade side. So this module polls
 * each chain's feed on an interval and indexes it BY TOKEN, which turns a
 * firehose into the question a signal card actually asks: "did anyone notable
 * touch this, and which way?"
 *
 * WHAT THIS CAN AND CANNOT SEE -- read before displaying any of it
 * The feed is a rolling window of RECENT trades. It therefore sees only trades
 * that happen while the app is running and watching. A KOL who bought an hour
 * before you launched the app is invisible here. That is why every number this
 * module produces is labelled "since we started watching" in the UI, and why
 * `fetchGmgnTokenWallets` (holders, point-in-time) exists alongside it: the two
 * answer genuinely different questions and neither is a complete KOL count.
 *
 * KOL vs SMART MONEY -- deliberately kept separate all the way to the UI.
 * GMGN's own documentation is explicit that these are different wallet lists:
 * KOLs (`renowned`) are public influencers whose trades carry social signal;
 * Smart Money (`smart_degen`) is a statistically proven profitable record and a
 * stronger alpha signal. Merging them into one "notable wallets" number would
 * destroy the distinction that makes either of them useful.
 */

import { fetchGmgnWalletTrades, isGmgnConfigured, gmgnInfoChain } from './gmgn.js';

// Chains worth polling. Each chain costs one call per kind per tick.
const CHAINS = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const KINDS = ['kol', 'smartmoney'];

const POLL_MS = 60_000;        // per full sweep
const WINDOW_MS = 6 * 60 * 60 * 1000;  // how long a trade stays relevant
const TRADES_PER_CALL = 100;

// `${chain}:${caLower}` -> { kol: Map(walletKey -> rec), smartmoney: Map(...) }
const _byToken = new Map();
let _watching = false;
let _timer = null;
let _startedAt = null;
let _onActivity = null;   // called with (ca) when a tracked token gets a trade

/** Chains MUST be normalised through GMGN's own naming before being used as a
 *  key. The watcher sweeps 'sol', but a stored signal records DexScreener's
 *  'solana' — keyed raw, every lookup would silently miss and the feature
 *  would look like "no KOL ever touches anything we track". */
function tokenKey(chain, ca) {
  const c = gmgnInfoChain(chain) || String(chain || '').toLowerCase();
  return `${c}:${String(ca || '').toLowerCase()}`;
}

/** One entry per WALLET, not per trade -- a KOL scalping in and out ten times
 *  is one wallet with an opinion, not ten endorsements. Same reasoning as the
 *  distinct-caller rule that governs the feed itself. */
function record(bucket, t) {
  const key = t.handle ? `@${t.handle.toLowerCase()}` : (t.wallet || '').toLowerCase();
  if (!key) return false;
  const prev = bucket.get(key);
  const isNew = !prev;
  const e = prev || {
    handle: t.handle, name: t.name, avatar: t.avatar, wallet: t.wallet,
    tags: t.tags, buys: 0, sells: 0, usdBought: 0, usdSold: 0,
    firstAt: t.at, lastAt: t.at, lastPriceChange: null,
  };
  const buying = t.side === 'buy' || (t.side == null && t.opened);
  if (buying) { e.buys += 1; e.usdBought += t.usd || 0; }
  else { e.sells += 1; e.usdSold += t.usd || 0; }
  e.lastAt = Math.max(e.lastAt, t.at);
  e.firstAt = Math.min(e.firstAt, t.at);
  if (t.priceChange != null) e.lastPriceChange = t.priceChange;
  if (!e.handle && t.handle) { e.handle = t.handle; e.name = t.name; e.avatar = t.avatar; }
  bucket.set(key, e);
  return isNew;
}

async function sweep(log) {
  for (const chain of CHAINS) {
    for (const kind of KINDS) {
      if (!_watching) return;
      let trades;
      try {
        trades = await fetchGmgnWalletTrades(kind, chain, TRADES_PER_CALL, log);
      } catch (e) {
        log?.('error', 'KOL sweep threw', { chain, kind, error: e.message });
        continue;
      }
      if (!trades || !trades.length) continue;

      const touched = new Set();
      for (const t of trades) {
        const k = tokenKey(chain, t.ca);
        let entry = _byToken.get(k);
        if (!entry) { entry = { kol: new Map(), smartmoney: new Map() }; _byToken.set(k, entry); }
        if (record(entry[kind], t)) touched.add(t.ca);
      }
      if (touched.size && _onActivity) for (const ca of touched) _onActivity(ca);
    }
  }
  prune();
}

/** Drop wallets whose last trade fell out of the window, and tokens left with
 *  nothing -- otherwise this grows without bound over a long session, the same
 *  mistake the mention list originally made. */
function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, entry] of _byToken) {
    for (const kind of KINDS) {
      for (const [w, rec] of entry[kind]) if (rec.lastAt < cutoff) entry[kind].delete(w);
    }
    if (entry.kol.size === 0 && entry.smartmoney.size === 0) _byToken.delete(k);
  }
}

export function startKolWatcher(log, onActivity) {
  if (_watching || !isGmgnConfigured()) {
    if (!isGmgnConfigured()) log?.('system', 'KOL watcher skipped: no GMGN API key');
    return;
  }
  _watching = true;
  _startedAt = Date.now();
  _onActivity = onActivity || null;
  log?.('system', 'KOL / Smart Money watcher started', {
    chains: CHAINS.length, everySec: POLL_MS / 1000, windowHours: WINDOW_MS / 3600000,
  });
  sweep(log).catch(() => {});
  _timer = setInterval(() => sweep(log).catch(() => {}), POLL_MS);
  if (_timer.unref) _timer.unref();
}

export function stopKolWatcher() {
  _watching = false;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/**
 * What notable wallets did with this token inside the watch window.
 * Returns null when the watcher never saw it -- which means "not observed",
 * NOT "no KOL interest". The UI must not render an absence as a zero.
 */
export function getKolActivity(ca, chain, sinceIso) {
  if (!_watching) return null;
  const entry = _byToken.get(tokenKey(chain, ca));
  if (!entry) return null;

  // TWO DIFFERENT QUESTIONS, BOTH WORTH ANSWERING.
  //
  //   alreadyIn -- notable wallets that were trading this token BEFORE your
  //                chat called it. This is what matters at the moment the
  //                alert fires: "smart money is already in this."
  //   sinceCall -- wallets that traded it AFTER the call. This is what
  //                matters afterwards: "the call was followed."
  //
  // Reporting only `sinceCall` (the first implementation) meant the count was
  // necessarily 0 at notification time, because the call had only just
  // happened -- the number was structurally useless in the one place it was
  // most wanted. `count` is the whole window, so a toast always has something
  // truthful to show.
  const cut = sinceIso ? new Date(sinceIso).getTime() : 0;

  const shape = (bucket) => {
    const all = [...bucket.values()].sort((a, b) => b.lastAt - a.lastAt);
    const list = all;
    const buyers = list.filter(w => w.buys > 0 && w.usdBought >= w.usdSold);
    return {
      count: list.length,
      // Split by when they acted, relative to the call.
      alreadyIn: cut ? all.filter(w => w.firstAt < cut).length : 0,
      sinceCall: cut ? all.filter(w => w.lastAt >= cut).length : list.length,
      buyers: buyers.length,
      sellers: list.filter(w => w.sells > 0 && w.usdSold > w.usdBought).length,
      netUsd: Math.round(list.reduce((s, w) => s + (w.usdBought - w.usdSold), 0)),
      wallets: list.slice(0, 12).map(w => ({
        handle: w.handle, name: w.name, avatar: w.avatar,
        wallet: w.wallet ? w.wallet.slice(0, 4) + '…' + w.wallet.slice(-4) : null,
        buys: w.buys, sells: w.sells,
        netUsd: Math.round(w.usdBought - w.usdSold),
        priceChangeSince: w.lastPriceChange,
        lastAt: new Date(w.lastAt).toISOString(),
      })),
    };
  };

  const kol = shape(entry.kol);
  const smart = shape(entry.smartmoney);
  if (!kol.count && !smart.count) return null;

  return {
    kol, smart,
    // Cluster signal: several independent notable wallets buying the same
    // token in the same window is a stronger read than any single trade.
    // Reported as a raw count -- no threshold is applied here, because what
    // counts as "consensus" is a judgment we have no data to defend yet.
    clusterBuyers: kol.buyers + smart.buyers,
    // The later of the two: we cannot report activity from before the call,
    // nor from before we started watching. Whichever is more recent is the
    // honest start of the measurement window, and the UI shows it.
    countedSince: new Date(Math.max(_startedAt, cut || 0)).toISOString(),
    watchedSince: new Date(_startedAt).toISOString(),
    scopedToCall: !!cut && cut >= _startedAt,
    source: 'gmgn-track',
  };
}

export function kolWatcherStatus() {
  return {
    running: _watching,
    startedAt: _startedAt ? new Date(_startedAt).toISOString() : null,
    tokensIndexed: _byToken.size,
    chains: CHAINS,
    windowHours: WINDOW_MS / 3600000,
  };
}
