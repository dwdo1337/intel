/**
 * Tests for peak tracking.
 *
 * Run:  node server/peak.test.mjs
 *
 * The case that started this is in here by name. Scarlett
 * (6g8LSn6CZ1LHeWwUWL94rNSC6gP7EyNmt5dRE38wpump) was called at a $10,587 market
 * cap, sits at $2,166, and the scoreboard scored it 0.20x -- a loss. pump.fun's
 * own API reports its all-time high market cap as $21,018. The call was a 2x.
 * If `scarlett` ever fails, the feature has stopped doing the one thing it was
 * built for.
 */
import { higherPeak, klineResolution, peakFromCandles, peakMultiple, minutesToPeak, KLINE_PAGE }
  from './peak.js';

let failures = 0, count = 0;
function check(name, actual, expected) {
  count++;
  const a = typeof actual === 'object' ? JSON.stringify(actual) : actual;
  const e = typeof expected === 'object' ? JSON.stringify(expected) : expected;
  if (a !== e) { failures++; console.error(`  FAIL  ${name}\n        expected ${e}, got ${a}`); }
  else console.log(`  ok    ${name}`);
}
const near = (name, actual, expected, tol = 1e-6) => {
  count++;
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol * Math.abs(expected || 1);
  if (!ok) { failures++; console.error(`  FAIL  ${name}\n        expected ~${expected}, got ${actual}`); }
  else console.log(`  ok    ${name}`);
};

console.log('\nhigherPeak\n');

check('first observation becomes the peak',
  higherPeak(null, null, null, 5000, 'T1'),
  { value: 5000, at: 'T1', source: 'observed', changed: true });
check('a higher observation replaces it',
  higherPeak(5000, 'T1', 'observed', 50000, 'T2'),
  { value: 50000, at: 'T2', source: 'observed', changed: true });

// The whole point: the round trip must not erase the run.
check('falling back to the entry does NOT lower the peak',
  higherPeak(50000, 'T2', 'observed', 5000, 'T3'),
  { value: 50000, at: 'T2', source: 'observed', changed: false });
check('going to zero does not erase the peak',
  higherPeak(50000, 'T2', 'observed', 0, 'T4'),
  { value: 50000, at: 'T2', source: 'observed', changed: false });

check('an equal reading is not a change',
  higherPeak(5000, 'T1', 'observed', 5000, 'T2'),
  { value: 5000, at: 'T1', source: 'observed', changed: false });
check('a null reading changes nothing',
  higherPeak(5000, 'T1', 'observed', null, 'T2'),
  { value: 5000, at: 'T1', source: 'observed', changed: false });
check('a negative reading changes nothing',
  higherPeak(5000, 'T1', 'observed', -3, 'T2'),
  { value: 5000, at: 'T1', source: 'observed', changed: false });
check('a kline peak can overwrite an observed one and records its source',
  higherPeak(5000, 'T1', 'observed', 21018, 'T9', 'kline'),
  { value: 21018, at: 'T9', source: 'kline', changed: true });
check('nothing held and nothing seen stays unknown',
  higherPeak(null, null, null, null, null),
  { value: null, at: null, source: null, changed: false });

console.log('\nklineResolution\n');

const H = 3600;

// The rule under test: the whole window must fit inside ONE page of KLINE_PAGE
// candles. Measured against the live API, asking beyond that does not error --
// it silently returns the most recent 100 and drops the start of the window,
// which for a memecoin is the launch spike.
const CANDLE_SECS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
function fits(name, windowSecs) {
  count++;
  const n = windowSecs / CANDLE_SECS[klineResolution(0, windowSecs)];
  const ok = n <= KLINE_PAGE;
  if (!ok) { failures++; console.error(`  FAIL  ${name}
        ${klineResolution(0, windowSecs)} gives ${Math.round(n)} candles, over the ${KLINE_PAGE} cap`); }
  else console.log(`  ok    ${name} (${klineResolution(0, windowSecs)}, ~${Math.round(n)} candles)`);
}

check('an hour window -> 1m',          klineResolution(0, 1 * H), '1m');
check('90 minutes still fits 1m',      klineResolution(0, 1.5 * H), '1m');
// 24h at 1m is 1440 candles: the exact request that came back truncated.
check('24h coarsens past 1m',          klineResolution(0, 24 * H) !== '1m', true);
check('a week coarsens past 15m',      klineResolution(0, 24 * 7 * H) !== '15m', true);
check('a year -> 1d',                  klineResolution(0, 24 * 365 * H), '1d');
check('a nonsense window still answers', klineResolution('x', 'y'), '1d');

// Every realistic window must fit in one page.
fits('1 hour',   1 * H);
fits('6 hours',  6 * H);
fits('24 hours', 24 * H);
fits('3 days',   24 * 3 * H);
fits('7 days',   24 * 7 * H);
fits('30 days',  24 * 30 * H);
fits('89 days',  24 * 89 * H);

console.log('\npeakFromCandles\n');

const c = (time, high) => ({ time, high: String(high) });

// Scaling: mcap 10,000 at price 0.001. A high of 0.002 is double, so 20,000.
near('scales market cap by the price ratio',
  peakFromCandles([c(1, 0.001), c(2, 0.002), c(3, 0.0005)], 0.001, 10000).mcap, 20000);
check('reports when the peak happened',
  peakFromCandles([c(1000, 0.001), c(2000, 0.002)], 0.001, 10000).at,
  new Date(2000).toISOString());

// THE CASE. Called at $10,587 with price 1.0587e-5; high of 2.1018e-5 is the
// $21,018 pump.fun reports. Now worth $2,166 -- which must not appear here.
const scarlett = peakFromCandles(
  [c(1, 1.0587e-5), c(2, 2.1018e-5), c(3, 2.166e-6)], 1.0587e-5, 10587);
near('scarlett: the 2x is recovered from candles', scarlett.mcap, 21018, 1e-3);
near('scarlett: peak multiple is ~1.99x', peakMultiple(scarlett.mcap, 10587), 1.9853, 1e-3);
near('scarlett: the CURRENT value would have scored 0.20x',
  peakMultiple(2166, 10587), 0.2046, 1e-3);

check('a window that only fell peaks at the reference, not below it',
  peakFromCandles([c(1, 0.0005), c(2, 0.0002)], 0.001, 10000),
  { mcap: 10000, at: null });
check('no candles -> unknown', peakFromCandles([], 0.001, 10000), null);
check('null candles -> unknown', peakFromCandles(null, 0.001, 10000), null);
check('no reference price -> unknown', peakFromCandles([c(1, 0.002)], 0, 10000), null);
check('no reference mcap -> unknown', peakFromCandles([c(1, 0.002)], 0.001, null), null);
near('junk candles are skipped, not fatal',
  peakFromCandles([c(1, 'nope'), { time: 2 }, c(3, 0.002)], 0.001, 10000).mcap, 20000);

console.log('\npeakMultiple / minutesToPeak\n');

near('10x', peakMultiple(50000, 5000), 10);
check('unknown peak -> null, never 1', peakMultiple(null, 5000), null);
check('unknown entry -> null, never 1', peakMultiple(50000, null), null);
check('zero entry -> null, not Infinity', peakMultiple(50000, 0), null);

near('minutes to peak', minutesToPeak('2026-08-01T00:00:00Z', '2026-08-01T00:30:00Z'), 30);
check('a peak before the call is not a duration',
  minutesToPeak('2026-08-01T01:00:00Z', '2026-08-01T00:30:00Z'), null);
check('unparsable timestamps -> null', minutesToPeak('nope', 'also nope'), null);

console.log(`\n${count - failures}/${count} passed\n`);
process.exit(failures ? 1 : 0);
