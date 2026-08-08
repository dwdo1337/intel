/**
 * THE METRIC GATE ON DESKTOP ALERTS.
 *
 * Why this exists
 * ---------------
 * The left-rail metric filters (Market cap, liquidity, volume, holders, ...)
 * lived entirely in the renderer: React state, persisted to localStorage,
 * applied in one `useMemo` that builds the feed. Nothing ever sent them to the
 * server, and the alert path only ever asked `shouldNotify(chain)`.
 *
 * So a Market cap max of 6000 emptied the feed and changed nothing about which
 * calls raised a toast. Reported as "I set 6000 as max but I still get notifs,
 * calls don't come on the feed" -- which is exactly the shape of the two
 * systems being disjoint, not of a threshold being read wrong.
 *
 * This is the mirror of the "One switch. Two jobs." bug in AGENTS.md. That one
 * was a single control driving both feed and alerts, and was fixed by splitting
 * it into the pill (feed) and the bell (alerts). The metric filters only ever
 * got the feed half; this is the missing alert half.
 *
 * The rule this module must not break
 * -----------------------------------
 * It has to agree with the feed's `inRange` EXACTLY. If it is stricter you get
 * silence for something sitting in the feed; if it is looser you get a toast
 * for a token the feed is hiding. Either way you are back to "the filter does
 * not work". The two asymmetries that must be copied rather than tidied up:
 *
 *   1. An UNKNOWN metric passes. `inRange` returns true when the value is
 *      null, so a token whose holder count never resolved is not silently
 *      dropped by a holders floor.
 *   2. An UNKNOWN rug risk is BLOCKED, alone among the fields, because a
 *      missing score must never read as a passing one.
 *
 * Opt-in by design
 * ----------------
 * `enabled` defaults to off. Filtering the feed is looking; muting an alert is
 * a decision. Keeping them separate is the same reason the chain pill and the
 * bell are two controls -- you can browse a range without agreeing to be
 * interrupted by it.
 */

/** Parse a threshold the way the renderer does: '' and null mean "not set". */
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Identical to the feed's `inRange`, including "unknown value passes". */
function inRange(val, min, max) {
  const v = num(val);
  if (v == null) return true;
  const mn = num(min), mx = num(max);
  if (mn != null && v < mn) return false;
  if (mx != null && v > mx) return false;
  return true;
}

/**
 * The metrics the feed compares against, read off a server-side hit.
 *
 * The feed reads `ev.metrics`, which is built in the /api/react-feed mapper.
 * These have to track that mapping -- notably the frozen scan snapshot winning
 * over the live value, so the alert is judged on the same number the card
 * shows rather than on a price that has moved since.
 */
function metricsOf(hit, now = Date.now()) {
  const h = hit || {};
  // There is no age field on a hit: the feed DERIVES it from pair_created_at
  // at render time. Reading a non-existent `h.age_minutes` would leave it
  // undefined, inRange would wave it through, and the age filter would
  // silently do nothing -- the same failure this whole module exists to fix.
  let age = null;
  if (h.pair_created_at) {
    const diff = (now - new Date(h.pair_created_at).getTime()) / 60000;
    if (!Number.isNaN(diff)) age = diff;
  }
  // The feed coerces these with `|| 0`, so a token with no trade counts reads
  // as zero rather than as unknown -- and is therefore BLOCKED by a `txsMin`
  // rather than waved through. Copied deliberately: the alternative is a toast
  // for a token the feed is hiding.
  const buys = h.buys_24h || 0, sells = h.sells_24h || 0;
  return {
    cap:     h.scan_mcap_usd        ?? h.mcap_usd,
    liq:     h.scan_liquidity_usd   ?? h.liquidity_usd,
    vol:     h.scan_volume_24h_usd  ?? h.volume_24h_usd,
    holders: h.holder_count,
    top10:   h.top10_holder_pct,
    devPct:  h.dev_holder_pct,
    age,
    buys, sells, netBuy: buys - sells, txs: buys + sells,
  };
}

/**
 * Should this hit be allowed to raise a desktop alert, on metrics alone?
 *
 * The chain check is separate and still applies -- see `shouldNotify`. This
 * answers only "does it match the thresholds the user asked to be alerted on".
 *
 * @param {object} hit    the enriched hit
 * @param {object|null} prefs  `{ enabled, thresholds }` from config.filters.alert_filters
 * @returns {boolean}
 */
export function passesAlertFilters(hit, prefs) {
  if (!prefs || !prefs.enabled) return true;      // opt-in: off means unchanged
  const t = prefs.thresholds || {};
  const m = metricsOf(hit);

  if (!inRange(m.cap,     t.capMin,     t.capMax))     return false;
  if (!inRange(m.liq,     t.liqMin,     t.liqMax))     return false;
  if (!inRange(m.vol,     t.volMin,     t.volMax))     return false;
  if (!inRange(m.holders, t.holdersMin, t.holdersMax)) return false;
  if (!inRange(m.top10,   t.top10Min,   t.top10Max))   return false;
  if (!inRange(m.devPct,  t.devPctMin,  t.devPctMax))  return false;
  if (!inRange(m.age,     t.ageMin,     t.ageMax))     return false;
  if (!inRange(m.netBuy,  t.netBuyMin,  t.netBuyMax))  return false;
  if (!inRange(m.txs,     t.txsMin,     t.txsMax))     return false;
  if (!inRange(m.buys,    t.buysMin,    t.buysMax))    return false;
  if (!inRange(m.sells,   t.sellsMin,   t.sellsMax))   return false;

  // The one field where unknown does NOT pass. Copied from the feed verbatim:
  //   if (rugRiskMax set && (rugRisk == null || rugRisk > max)) -> hide
  const rugMax = num(t.rugRiskMax);
  if (rugMax != null) {
    const risk = (hit || {}).rug_risk_pct;
    if (risk == null || risk > rugMax) return false;
  }

  return true;
}

/** The threshold keys that are meaningful here — anything else is ignored. */
export const ALERT_THRESHOLD_KEYS = [
  'capMin', 'capMax', 'liqMin', 'liqMax', 'volMin', 'volMax',
  'ageMin', 'ageMax', 'netBuyMin', 'netBuyMax', 'txsMin', 'txsMax',
  'buysMin', 'buysMax', 'sellsMin', 'sellsMax',
  'holdersMin', 'holdersMax', 'top10Min', 'top10Max',
  'devPctMin', 'devPctMax', 'rugRiskMax',
];

/**
 * Keep only recognised threshold keys, and only ones actually set.
 *
 * The renderer holds far more filter state than this (search text, chain sets,
 * chips). Storing the whole object in config.json would persist view state
 * into the durable record and quietly grow it on every UI change.
 */
export function sanitizeThresholds(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of ALERT_THRESHOLD_KEYS) {
    const v = num(input[k]);
    if (v != null) out[k] = v;
  }
  return out;
}
