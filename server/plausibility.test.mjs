/**
 * Tests for the holder-count plausibility bound.
 *
 * Run:  node server/plausibility.test.mjs
 *
 * The bug these exist for: a robinhood token
 * (0xa870f8c7cae9705194a141b0c2964b6c79ee3742) was stored and displayed with
 * 622,770 holders against a $39,135 market cap -- six cents of market cap per
 * holder. It came from GMGN `token info`, whose only validation was `> 0`, on a
 * chain where RugCheck cannot cross-check because RugCheck is Solana-only.
 *
 * The threshold is not invented. Across 430 RugCheck-verified rows in a live
 * 500-signal store, the LOWEST genuine value was $1.17 of market cap per
 * holder; exactly one row in 500 fell under $1, and it was the bad one at
 * $0.06. So $1 rejects the garbage with room to spare and clears every real
 * token measured.
 *
 * The rule that matters most: rejecting means null, which the whole app reads
 * as "unknown" and displays as a dash. It must never coerce to 0 -- "we cannot
 * trust this number" and "this token has no holders" are different facts, and
 * the second one would be a finding the app has not made.
 */
import { plausibleHolderCount, resolveHolderCount, MIN_MCAP_PER_HOLDER } from './plausibility.js';

let failures = 0, count = 0;
function check(name, actual, expected) {
  count++;
  const ok = actual === expected;
  if (!ok) { failures++; console.error(`  FAIL  ${name}\n        expected ${expected}, got ${actual}`); }
  else console.log(`  ok    ${name}`);
}

console.log('\nplausibility\n');

// ── the case this exists for ───────────────────────────────────────────
check('the live bad row: 622,770 holders on a $39,135 cap is rejected',
  plausibleHolderCount(622770, 39135), null);

// ── real rows from the same store must survive ─────────────────────────
check('AVA: 113,072 holders on a $14.4M cap is kept',
  plausibleHolderCount(113072, 14451807), 113072);
check('TOAD: 57,269 holders on a $9.9M cap is kept',
  plausibleHolderCount(57269, 9867981), 57269);
check('a small token: 475 holders on a $30k cap is kept',
  plausibleHolderCount(475, 30000), 475);
check('the lowest genuine ratio observed ($1.17/holder) is kept',
  plausibleHolderCount(1000, 1170), 1000);

// ── the boundary ───────────────────────────────────────────────────────
check('exactly at the floor is kept, not rejected',
  plausibleHolderCount(1000, 1000 * MIN_MCAP_PER_HOLDER), 1000);
check('a hair under the floor is rejected',
  plausibleHolderCount(1000, 1000 * MIN_MCAP_PER_HOLDER - 1), null);

// ── unknown market cap cannot judge anything ───────────────────────────
// Fail-open on purpose: with no cap there is no ratio, and throwing away a
// holder count we have no evidence against would lose good data on every
// bonding-curve token DexScreener reports no market cap for.
check('null market cap: the count is kept, not judged',
  plausibleHolderCount(622770, null), 622770);
check('zero market cap: the count is kept, not judged',
  plausibleHolderCount(500, 0), 500);
check('undefined market cap: the count is kept, not judged',
  plausibleHolderCount(500, undefined), 500);

// ── the shape rules the old `> 0` check was carrying ───────────────────
check('zero holders is unknown, not zero', plausibleHolderCount(0, 50000), null);
check('negative is rejected', plausibleHolderCount(-5, 50000), null);
check('null is rejected', plausibleHolderCount(null, 50000), null);
check('undefined is rejected', plausibleHolderCount(undefined, 50000), null);
check('NaN is rejected', plausibleHolderCount(NaN, 50000), null);
check('Infinity is rejected', plausibleHolderCount(Infinity, 50000), null);
check('a numeric string is read as a number', plausibleHolderCount('475', 30000), 475);
check('a non-numeric string is rejected', plausibleHolderCount('lots', 30000), null);

// ── it must reject, never substitute ───────────────────────────────────
check('rejection returns null and never 0',
  plausibleHolderCount(622770, 39135) === 0, false);

// ── resolveHolderCount: what the card ends up showing ──────────────────
const res = (stored, incoming, mcap, force) =>
  JSON.stringify(resolveHolderCount(stored, incoming, mcap, { force }));

console.log('\nresolveHolderCount\n');

check('a believable reading is taken',
  res(null, 475, 30000, false), JSON.stringify({ value: 475, changed: true }));
check('an unchanged reading reports no change',
  res(475, 475, 30000, false), JSON.stringify({ value: 475, changed: false }));
check('a believable reading updates a stale one',
  res(400, 475, 30000, false), JSON.stringify({ value: 475, changed: true }));

// The whole point of the exercise.
check('bad reading, bad stored, refresh: the card is cleared to unknown',
  res(622770, 622770, 39135, true), JSON.stringify({ value: null, changed: true }));
check('bad reading, bad stored, NO refresh: left alone',
  res(622770, 622770, 39135, false), JSON.stringify({ value: 622770, changed: false }));

// The mistake this branch is easy to make in reverse.
check('bad reading, GOOD stored, refresh: the good count survives',
  res(475, 999999, 30000, true), JSON.stringify({ value: 475, changed: false }));
check('bad reading, good stored, no refresh: the good count survives',
  res(475, 999999, 30000, false), JSON.stringify({ value: 475, changed: false }));

check('nothing stored, bad reading, refresh: stays unknown, no change flagged',
  res(null, 622770, 39135, true), JSON.stringify({ value: null, changed: false }));
check('unknown market cap on refresh: nothing is cleared, nothing is judged',
  res(622770, 622770, null, true), JSON.stringify({ value: 622770, changed: false }));

console.log(`\n${count - failures}/${count} passed\n`);
process.exit(failures ? 1 : 0);
