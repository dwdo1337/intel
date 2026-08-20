/**
 * Tests for liquidity resolution.
 *
 * Run:  node server/liquidity.test.mjs
 *
 * The fixtures are real payloads, trimmed. `SCARLETT_POOL` and `SCARLETT_CURVE`
 * are the same token seen through GMGN `token pool` and pump.fun's v3 endpoint;
 * `ROBINHOOD_POOL` is the AMM token that proves the doubling convention agrees
 * with what GMGN itself reports for a normal pool.
 */
import { resolveLiquidity, liquidityFromPool, liquidityFromCurve, gmgnPoolChain }
  from './liquidity.js';

let failures = 0, count = 0;
function check(name, actual, expected) {
  count++;
  const a = typeof actual === 'object' ? JSON.stringify(actual) : actual;
  const e = typeof expected === 'object' ? JSON.stringify(expected) : expected;
  if (a !== e) { failures++; console.error(`  FAIL  ${name}\n        expected ${e}, got ${a}`); }
  else console.log(`  ok    ${name}`);
}
const near = (name, actual, expected, tol = 0.01) => {
  count++;
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol * Math.abs(expected || 1);
  if (!ok) { failures++; console.error(`  FAIL  ${name}\n        expected ~${expected}, got ${actual}`); }
  else console.log(`  ok    ${name}`);
};

// Real GMGN `token pool` output, pump.fun bonding curve.
const SCARLETT_POOL = {
  quote_symbol: 'SOL', liquidity: '4577.7124531992',
  base_reserve: '996198513.179141', quote_reserve: '0.10860598',
  base_reserve_value: '2157.7651825872', quote_reserve_value: '8.3648325796',
  exchange: 'pump',
};
// Real GMGN `token pool` output, uniswap v3 on robinhood.
const ROBINHOOD_POOL = {
  quote_symbol: 'WETH', liquidity: '10482.7349000334',
  quote_reserve: '2.735835021044', base_reserve_value: '7923.4622852389',
  quote_reserve_value: '5248.3954276340', exchange: 'uniswap_v3',
};
// Real pump.fun v3 output for the same Scarlett token.
const SCARLETT_CURVE = {
  complete: false,
  virtual_sol_reserves: 30099860306, real_sol_reserves: 99860306,
  market_cap: 28.145435705691014, usd_market_cap: 2166.2132931752208,
  ath_market_cap: 21017.991548749476,
};

console.log('\ngmgnPoolChain\n');
check('solana normalises to sol', gmgnPoolChain('solana'), 'sol');
check('ethereum normalises to eth', gmgnPoolChain('ethereum'), 'eth');
check('robinhood passes through', gmgnPoolChain('robinhood'), 'robinhood');
check('bsc passes through', gmgnPoolChain('bsc'), 'bsc');
check('arc and stable are supported', gmgnPoolChain('arc'), 'arc');
check('an unknown chain is refused, not guessed', gmgnPoolChain('dogechain'), null);
check('empty is refused', gmgnPoolChain(''), null);

console.log('\nliquidityFromPool\n');

// The convention check: on a REAL amm, doubling the quote side lands on GMGN's
// own liquidity figure. That agreement is what licences using it everywhere.
near('robinhood AMM: 2x quote agrees with GMGN\'s own liquidity field',
  liquidityFromPool(ROBINHOOD_POOL), 10482.73, 0.01);

// And the disagreement that forced the decision.
near('pump.fun curve: real depth is ~$16.73, not GMGN\'s $4,577',
  liquidityFromPool(SCARLETT_POOL), 16.7296, 0.001);
check('the curve figure is nowhere near the virtual one',
  liquidityFromPool(SCARLETT_POOL) < 100, true);

check('no pool -> null', liquidityFromPool(null), null);
check('a pool with no quote value -> null', liquidityFromPool({ liquidity: '999' }), null);
check('zero quote value -> null, not 0', liquidityFromPool({ quote_reserve_value: '0' }), null);

console.log('\nliquidityFromCurve\n');

// 0.099860306 SOL, SOL derived as 2166.2133/28.1454 = $76.965, doubled.
near('scarlett curve reserves price out at ~$15.37',
  liquidityFromCurve(SCARLETT_CURVE), 15.3707, 0.001);
check('virtual reserves are NOT used', liquidityFromCurve(SCARLETT_CURVE) < 100, true);
check('no coin -> null', liquidityFromCurve(null), null);
check('no reserves -> null', liquidityFromCurve({ market_cap: 28, usd_market_cap: 2166 }), null);
check('no sol price derivable -> null',
  liquidityFromCurve({ real_sol_reserves: 99860306, usd_market_cap: 2166 }), null);
check('zero market cap cannot derive a price -> null',
  liquidityFromCurve({ real_sol_reserves: 99860306, market_cap: 0, usd_market_cap: 2166 }), null);

console.log('\nresolveLiquidity\n');

check('DexScreener wins when it has a figure',
  resolveLiquidity({ dexscreener: 13987.44, pool: SCARLETT_POOL, curve: SCARLETT_CURVE }),
  { value: 13987.44, source: 'dexscreener' });

const viaPool = resolveLiquidity({ dexscreener: null, pool: SCARLETT_POOL, curve: SCARLETT_CURVE });
check('falls to the pool when DexScreener is blank', viaPool.source, 'gmgn-pool');
near('and carries the real-depth figure', viaPool.value, 16.7296, 0.001);

const viaCurve = resolveLiquidity({ dexscreener: null, pool: null, curve: SCARLETT_CURVE });
check('falls to the curve when there is no pool either', viaCurve.source, 'pumpfun-curve');

check('nothing anywhere -> null, and the card keeps saying unknown',
  resolveLiquidity({ dexscreener: null, pool: null, curve: null }), null);
check('no argument at all -> null', resolveLiquidity(), null);
check('a DexScreener zero is not a figure, it falls through',
  resolveLiquidity({ dexscreener: 0, pool: SCARLETT_POOL }).source, 'gmgn-pool');

console.log(`\n${count - failures}/${count} passed\n`);
process.exit(failures ? 1 : 0);
