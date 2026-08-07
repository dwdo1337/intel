/**
 * Smart-money flow via Binance's public Web3 API.
 *
 * WHY THIS EXISTS ALONGSIDE gmgn track
 * The two answer different questions and have different failure modes:
 *
 *   gmgn track kol/smartmoney -> NAMED wallets, individual trades, needs an
 *                                API key, tight escalating rate limit.
 *   this                      -> AGGREGATE net inflow per token, multiple time
 *                                windows, FREE and keyless.
 *
 * The keyless part matters: without a GMGN key the app previously had no
 * smart-money signal at all. This gives every user one, and it survives a GMGN
 * cooldown because it shares no budget with it.
 *
 * Source: adapter pattern taken from Bob-QoQ/smart-money-tracker (MIT), which
 * documented these endpoints. No code was copied -- the endpoints, payload
 * shape and chain ids were verified directly against the live API before use.
 */

const BASE = 'https://web3.binance.com/bapi/defi';

// Binance's own chain ids. Solana is 'CT_501', not a number.
const CHAIN_IDS = { sol: 'CT_501', solana: 'CT_501', bsc: '56', eth: '1', ethereum: '1', base: '8453' };

// Windows fetched every sweep. 1h vs 24h is what makes acceleration visible:
// a token pulling its whole daily inflow in the last hour is behaving very
// differently from one that bled it in evenly.
const PERIODS = ['1h', '4h', '24h'];
const SWEEP_MS = 120_000;
const STALE_MS = 15 * 60 * 1000;

// `${chainKey}:${caLower}` -> { periods: { '1h': {...} }, at }
const _flow = new Map();
let _timer = null;
let _running = false;
let _onFlow = null;

function key(chain, ca) {
  const c = CHAIN_IDS[String(chain || '').toLowerCase()] || String(chain || '').toLowerCase();
  return `${c}:${String(ca || '').toLowerCase()}`;
}

async function fetchInflow(chainId, period) {
  const res = await fetch(`${BASE}/v1/public/wallet-direct/tracker/wallet/token/inflow/rank/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
    body: JSON.stringify({ chainId, period, tagType: 2 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j?.data) ? j.data : [];
}

async function sweep(log) {
  const chains = [...new Set(Object.values(CHAIN_IDS))];
  const touched = new Set();

  for (const chainId of chains) {
    for (const period of PERIODS) {
      if (!_running) return;
      let rows;
      try {
        rows = await fetchInflow(chainId, period);
      } catch (e) {
        log?.('error', 'Binance flow fetch failed', { chainId, period, error: e.message });
        continue;
      }
      for (const r of rows) {
        if (!r || !r.ca) continue;
        const k = `${chainId}:${String(r.ca).toLowerCase()}`;
        let entry = _flow.get(k);
        if (!entry) { entry = { periods: {}, at: Date.now() }; _flow.set(k, entry); }
        entry.at = Date.now();
        entry.periods[period] = {
          inflowUsd: Number(r.inflow) || 0,
          // HOW MANY smart-money wallets touched it. This is the number a
          // trader actually reads; a net USD figure like "-$30" is noise
          // without knowing whether that came from one wallet or thirty.
          traders: Number(r.traders) || 0,
          buys: Number(r.countBuy) || 0,
          sells: Number(r.countSell) || 0,
          // Binance's own risk grading. -1 shows up for unscored tokens, so it
          // is treated as unknown rather than "safest".
          riskLevel: Number.isFinite(Number(r.tokenRiskLevel)) && Number(r.tokenRiskLevel) >= 0
            ? Number(r.tokenRiskLevel) : null,
          holders: Number(r.holders) || null,
          top10Pct: Number(r.holdersTop10Percent) || null,
        };
        touched.add(String(r.ca));
      }
      await new Promise(r => setTimeout(r, 250));   // be polite to a free API
    }
  }

  for (const [k, v] of _flow) if (Date.now() - v.at > STALE_MS) _flow.delete(k);
  if (touched.size && _onFlow) for (const ca of touched) _onFlow(ca);
}

export function startFlowWatcher(log, onFlow) {
  if (_running) return;
  _running = true;
  _onFlow = onFlow || null;
  log?.('system', 'Smart-money flow watcher started (Binance Web3, keyless)', {
    chains: [...new Set(Object.values(CHAIN_IDS))].length, periods: PERIODS, everySec: SWEEP_MS / 1000,
  });
  sweep(log).catch(() => {});
  _timer = setInterval(() => sweep(log).catch(() => {}), SWEEP_MS);
  if (_timer.unref) _timer.unref();
}

export function stopFlowWatcher() {
  _running = false;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/**
 * Net smart-money flow for one token, plus whether it is accelerating.
 * Returns null when the token is not in any ranking -- which means "not among
 * the tokens smart money is moving", not "zero inflow".
 */
export function getFlow(ca, chain) {
  if (!_running) return null;
  const entry = _flow.get(key(chain, ca));
  if (!entry) return null;

  const p = entry.periods;
  const h1 = p['1h']?.inflowUsd ?? null;
  const h4 = p['4h']?.inflowUsd ?? null;
  const h24 = p['24h']?.inflowUsd ?? null;

  // ACCELERATION: compare the last hour against the average hour of the last
  // day. >1 means money is arriving faster now than it has been. Only computed
  // when the daily figure is positive and meaningful -- a ratio against a
  // negative or near-zero base is noise dressed up as a number.
  let acceleration = null;
  if (h1 != null && h24 != null && h24 > 1000) {
    acceleration = Number((h1 / (h24 / 24)).toFixed(2));
  }

  const latest = p['24h'] || p['4h'] || p['1h'] || {};
  return {
    inflow1h: h1, inflow4h: h4, inflow24h: h24,
    // Distinct smart-money wallets that traded it in the last 24h.
    traders: latest.traders || null,
    acceleration,
    buys24h: latest.buys ?? null,
    sells24h: latest.sells ?? null,
    riskLevel: latest.riskLevel,
    source: 'binance-web3',
    at: new Date(entry.at).toISOString(),
  };
}

export function flowWatcherStatus() {
  return { running: _running, tokensRanked: _flow.size, periods: PERIODS };
}
