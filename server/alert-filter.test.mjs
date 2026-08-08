/**
 * Tests for the alert metric gate.
 *
 * Run:  node server/alert-filter.test.mjs
 *
 * The bug these exist for: the left-rail metric filters were applied only to
 * the feed, in the renderer. A Market cap max of 6000 emptied the feed and
 * changed nothing about which calls raised a desktop alert, because the alert
 * path only ever consulted the chain.
 *
 * The rule that matters most here is that this gate agrees with the FEED's
 * `inRange` exactly. If it is stricter or looser, a toast appears for a token
 * that is not in the feed (or vice versa) -- which is the same class of bug
 * wearing a different hat.
 */
import { passesAlertFilters } from './alert-filter.js';

let failures = 0, count = 0;
function check(name, actual, expected) {
  count++;
  const ok = actual === expected;
  if (!ok) { failures++; console.error(`  FAIL  ${name}\n        expected ${expected}, got ${actual}`); }
  else console.log(`  ok    ${name}`);
}

const hit = (over = {}) => ({ chain: 'solana', mcap_usd: 44400, ...over });

console.log('\nalert-filter\n');

// ── the toggle itself ──────────────────────────────────────────────────
check('disabled: passes even when a threshold would block',
  passesAlertFilters(hit(), { enabled: false, thresholds: { capMax: 6000 } }), true);

check('enabled with no thresholds set: passes',
  passesAlertFilters(hit(), { enabled: true, thresholds: {} }), true);

check('no prefs at all: passes (alerts unaffected by default)',
  passesAlertFilters(hit(), null), true);

check('empty-string thresholds are ignored, not read as 0',
  passesAlertFilters(hit(), { enabled: true, thresholds: { capMax: '', capMin: '' } }), true);

// ── the reported bug ───────────────────────────────────────────────────
check('capMax 6000 blocks a 44,400 mcap call',
  passesAlertFilters(hit(), { enabled: true, thresholds: { capMax: 6000 } }), false);

check('capMax 6000 allows a 5,000 mcap call',
  passesAlertFilters(hit({ mcap_usd: 5000 }), { enabled: true, thresholds: { capMax: 6000 } }), true);

check('capMax 6000 allows a call exactly at 6000 (max is inclusive, as in the feed)',
  passesAlertFilters(hit({ mcap_usd: 6000 }), { enabled: true, thresholds: { capMax: 6000 } }), true);

check('capMin 1000 blocks a 500 mcap call',
  passesAlertFilters(hit({ mcap_usd: 500 }), { enabled: true, thresholds: { capMin: 1000 } }), false);

// ── agreement with the feed ────────────────────────────────────────────
check('unknown mcap PASSES a capMax, exactly as the feed inRange does',
  passesAlertFilters(hit({ mcap_usd: null }), { enabled: true, thresholds: { capMax: 6000 } }), true);

check('prefers the frozen scan snapshot over the live value, as the feed does',
  passesAlertFilters(hit({ scan_mcap_usd: 5000, mcap_usd: 999999 }),
    { enabled: true, thresholds: { capMax: 6000 } }), true);

check('falls back to the live value when there is no snapshot',
  passesAlertFilters(hit({ scan_mcap_usd: null, mcap_usd: 999999 }),
    { enabled: true, thresholds: { capMax: 6000 } }), false);

// ── the other metrics ──────────────────────────────────────────────────
check('liqMin blocks a thin pair',
  passesAlertFilters(hit({ scan_liquidity_usd: 900 }), { enabled: true, thresholds: { liqMin: 5000 } }), false);

check('holdersMin blocks a token below the floor',
  passesAlertFilters(hit({ holder_count: 12 }), { enabled: true, thresholds: { holdersMin: 100 } }), false);

check('top10Max blocks a concentrated token',
  passesAlertFilters(hit({ top10_holder_pct: 82 }), { enabled: true, thresholds: { top10Max: 40 } }), false);

check('volMax blocks a high-volume token',
  passesAlertFilters(hit({ scan_volume_24h_usd: 3_000_000 }), { enabled: true, thresholds: { volMax: 100000 } }), false);

check('devPctMax blocks a heavy dev bag',
  passesAlertFilters(hit({ dev_holder_pct: 30 }), { enabled: true, thresholds: { devPctMax: 5 } }), false);

// Age has no field on the hit -- it is derived from pair_created_at, exactly as
// the feed does at render time. A gate reading a non-existent `age_minutes`
// would wave everything through and the filter would silently do nothing.
check('ageMax blocks a pair older than the ceiling',
  passesAlertFilters(hit({ pair_created_at: new Date(Date.now() - 600 * 60000).toISOString() }),
    { enabled: true, thresholds: { ageMax: 60 } }), false);

check('ageMax allows a pair minted minutes ago',
  passesAlertFilters(hit({ pair_created_at: new Date(Date.now() - 5 * 60000).toISOString() }),
    { enabled: true, thresholds: { ageMax: 60 } }), true);

check('unknown age passes an ageMax, as in the feed',
  passesAlertFilters(hit({ pair_created_at: null }), { enabled: true, thresholds: { ageMax: 60 } }), true);

check('an unparseable pair_created_at does not block',
  passesAlertFilters(hit({ pair_created_at: 'not a date' }), { enabled: true, thresholds: { ageMax: 60 } }), true);

// rugRisk is the ONE field the feed treats differently: an UNKNOWN risk is
// blocked rather than allowed, because a missing score must never read as a
// passing one. The gate has to reproduce that asymmetry.
check('rugRiskMax blocks a token whose risk is unknown (feed does the same)',
  passesAlertFilters(hit({ rug_risk_pct: null }), { enabled: true, thresholds: { rugRiskMax: 20 } }), false);

check('rugRiskMax allows a token under the ceiling',
  passesAlertFilters(hit({ rug_risk_pct: 8 }), { enabled: true, thresholds: { rugRiskMax: 20 } }), true);

check('rugRiskMax blocks a token over the ceiling',
  passesAlertFilters(hit({ rug_risk_pct: 55 }), { enabled: true, thresholds: { rugRiskMax: 20 } }), false);

// The feed coerces trade counts with `|| 0`, so "no data" is zero here, not
// unknown -- and a floor must therefore block it rather than wave it through.
check('txsMin blocks a token with no trade data at all (|| 0, as in the feed)',
  passesAlertFilters(hit({ buys_24h: null, sells_24h: null }),
    { enabled: true, thresholds: { txsMin: 50 } }), false);

check('txsMin allows a token above the floor',
  passesAlertFilters(hit({ buys_24h: 40, sells_24h: 30 }),
    { enabled: true, thresholds: { txsMin: 50 } }), true);

check('netBuyMin blocks a token selling off',
  passesAlertFilters(hit({ buys_24h: 10, sells_24h: 90 }),
    { enabled: true, thresholds: { netBuyMin: 0 } }), false);

// ── several at once ────────────────────────────────────────────────────
check('all thresholds must pass, not any',
  passesAlertFilters(hit({ scan_mcap_usd: 5000, scan_liquidity_usd: 100 }),
    { enabled: true, thresholds: { capMax: 6000, liqMin: 5000 } }), false);

console.log(`\n${count - failures}/${count} passed\n`);
process.exit(failures ? 1 : 0);
