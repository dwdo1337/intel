/**
 * pump.fun's public coin endpoint.
 *
 * Keyless, free, no queue, and it answers the two questions DexScreener will not
 * for a token still on its bonding curve:
 *
 *   - what is actually in the curve       (real_sol_reserves -> liquidity)
 *   - how high did it ever get            (ath_market_cap)
 *
 * This is the source the Telegram call bots read for the same figures.
 *
 * SCOPE. Solana pump.fun mints only. Every other launchpad and every other chain
 * goes through GMGN `token pool` / `market kline`. Calling this for anything else
 * is not an error, it is a 404 -- so the mint suffix is checked first rather than
 * spending a request to be told no.
 *
 * The v1 host (frontend-api.pump.fun) now answers 530 and is gone; v3 is the
 * live one. Verified against three real mints.
 */

const BASE = 'https://frontend-api-v3.pump.fun';

// Plain fetch() is refused by the edge with a 403; a browser UA is served
// normally. Same class of thing as the gmgn.ai image host, and the same
// resolution: send what a browser sends. Not a workaround for a rate limit.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_MS = 8000;

/** A pump.fun mint always ends in `pump`. Cheap gate, no request spent. */
export function isPumpFunMint(ca) {
  return typeof ca === 'string' && /pump$/i.test(ca.trim());
}

/**
 * Fetch one coin.
 *
 * Returns the raw payload, or null for anything that is not a clean answer.
 * Fail-open like every other provider here: this filling in is a bonus, and a
 * pump.fun outage must never hold up or drop a signal.
 */
export async function fetchPumpFunCoin(ca, log) {
  if (!isPumpFunMint(ca)) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/coins/${encodeURIComponent(ca.trim())}`, {
      headers: { 'User-Agent': UA, accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j && typeof j === 'object' && j.mint) ? j : null;
  } catch (e) {
    if (log) log('enrichment', 'pump.fun lookup failed', { ca, error: e.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * All-time high market cap in USD, or null.
 *
 * ALL-TIME, not since-the-call, so it is an upper bound on a call's peak and a
 * free cross-check on the candle reconstruction -- never a replacement for it. A
 * token called after its high already happened would otherwise be credited with
 * a run that predates the call.
 *
 * The units are not guessed. `market_cap` is quoted in SOL and `usd_market_cap`
 * in dollars; measured across three live mints, `ath_market_cap` sat at 2.4-9.7x
 * the USD cap, and reading it as SOL would have implied $424k-$1.6M peaks for
 * tokens now worth $2k. It is dollars.
 */
export function athMarketCapUsd(coin) {
  const v = Number(coin && coin.ath_market_cap);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** When that high happened, ISO, or null. */
export function athAt(coin) {
  const ms = Number(coin && coin.ath_market_cap_timestamp);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** Has it left the curve for a real AMM pool? */
export function hasGraduated(coin) {
  return !!(coin && coin.complete === true);
}
