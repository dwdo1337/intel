/**
 * Where a liquidity figure comes from, and what it means.
 *
 * WHY THIS EXISTS
 *
 * Measured on a live 500-signal store: 245 rows had no liquidity while 500 of
 * 500 had a market cap. That is not a failed fetch -- verified against the live
 * API, DexScreener returns no `liquidity` object AT ALL for a pump.fun
 * bonding-curve pair, because there is no AMM pool yet. Every other field of the
 * same response (price, volume, dex, pair label) arrives normally.
 *
 * So this is a second source, not a bug fix.
 *
 * ONE DEFINITION, EVERYWHERE
 *
 * GMGN publishes its own `liquidity` field, and it is not one measurement.
 * Measured on two real tokens:
 *
 *   robinhood AMM   liquidity 10,482  ~=  2 x quote_reserve_value (10,496)
 *   pump.fun curve  liquidity  4,577  vs  2 x quote_reserve_value (16.70)
 *
 * A 270x disagreement, because on a bonding curve GMGN is pricing the VIRTUAL
 * reserves -- the imaginary 30 SOL the curve starts with to set an opening
 * price. Nobody can withdraw it. Taking that field as-is would make the
 * Liquidity column mean "money you could exit into" on some rows and "a number
 * from a pricing formula" on others, with nothing on screen to tell them apart.
 *
 * So liquidity is always computed the same way: the value of the quote side of
 * the pool, doubled. That is what DexScreener reports for an AMM (verified
 * against the same robinhood token), and on a curve it is the real, redeemable
 * SOL. The honest consequence is that a fresh curve reads $17 rather than
 * $4,577 -- which is the true depth, and is the number that would have told you
 * something before you bought.
 */

/** Chains GMGN will answer `token pool` for. */
const POOL_CHAINS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);

export function gmgnPoolChain(chain) {
  const c = String(chain || '').toLowerCase();
  const alias = { solana: 'sol', ethereum: 'eth', binance: 'bsc', bnb: 'bsc' };
  const id = alias[c] || c;
  return POOL_CHAINS.has(id) ? id : null;
}

const num = v => (v === null || v === undefined || v === '') ? NaN : Number(v);

/**
 * Liquidity from a GMGN `token pool` payload: the quote side, doubled.
 *
 * `quote_reserve_value` is already in USD. Doubling it is the standard AMM
 * convention -- a balanced pool holds equal value on both sides -- and it is
 * what makes this figure comparable with the DexScreener numbers already on
 * other cards. Without that, switching sources would move every number on the
 * screen and look like the market had moved.
 */
export function liquidityFromPool(pool) {
  if (!pool || typeof pool !== 'object') return null;
  const quote = num(pool.quote_reserve_value);
  if (!Number.isFinite(quote) || quote <= 0) return null;
  return quote * 2;
}

/**
 * Liquidity from a pump.fun bonding curve.
 *
 * `real_sol_reserves` is in lamports and is the SOL actually sitting in the
 * curve -- as opposed to `virtual_sol_reserves`, which is the pricing offset and
 * is not withdrawable by anyone. Doubled for the same reason as above.
 *
 * The SOL price is derived from the payload itself (`usd_market_cap` over
 * `market_cap`, which is the same cap quoted in SOL) rather than fetched. One
 * call, internally consistent, and it cannot drift against the market cap shown
 * beside it.
 */
export function liquidityFromCurve(coin) {
  if (!coin || typeof coin !== 'object') return null;
  const lamports = num(coin.real_sol_reserves);
  const mcSol = num(coin.market_cap);
  const mcUsd = num(coin.usd_market_cap);
  if (!Number.isFinite(lamports) || lamports <= 0) return null;
  if (!Number.isFinite(mcSol) || mcSol <= 0) return null;
  if (!Number.isFinite(mcUsd) || mcUsd <= 0) return null;

  const solUsd = mcUsd / mcSol;
  return (lamports / 1e9) * solUsd * 2;
}

/**
 * Pick the figure to show, and say where it came from.
 *
 * Order is deliberate. DexScreener first because it is already fetched, already
 * on the card, and is the source every other number on that row came from --
 * swapping it out for an equivalent from another provider would make the row
 * inconsistent for no gain. The other two only ever fill a hole.
 *
 * @returns {{value:number, source:'dexscreener'|'gmgn-pool'|'pumpfun-curve'}|null}
 */
export function resolveLiquidity({ dexscreener, pool, curve } = {}) {
  const ds = num(dexscreener);
  if (Number.isFinite(ds) && ds > 0) return { value: ds, source: 'dexscreener' };

  const p = liquidityFromPool(pool);
  if (p != null) return { value: p, source: 'gmgn-pool' };

  const c = liquidityFromCurve(curve);
  if (c != null) return { value: c, source: 'pumpfun-curve' };

  return null;
}
