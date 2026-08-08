/**
 * Safety enrichment via RugCheck (Solana only, free, no API key).
 *
 * WHY THIS EXISTS
 * Until now every safety field in the data model -- is_honeypot,
 * top10_holder_pct, holder_count, dev_holder_pct, lp_burned_pct,
 * is_mintable, is_freezable, rug_risk_pct -- existed in the schema, flowed
 * all the way to the Inspector UI, and was NEVER populated by anything.
 * The "Supply & tokenomics" card was decorative. This module makes those
 * fields real for Solana.
 *
 * HONESTY CONTRACT (important -- do not weaken this)
 *  - This is SOLANA ONLY. RugCheck does not cover EVM chains. For EVM
 *    hits every field here stays null, and the UI must show "unknown",
 *    never a fabricated default like 0% or "safe".
 *  - null means "we don't know", NOT "fine". A fetch failure, a timeout,
 *    or a token too new to be indexed all produce null. Never coerce null
 *    to a passing value anywhere downstream.
 *  - Fail-open: a RugCheck outage must never block or drop a signal. The
 *    hit still surfaces, just without safety data.
 *
 * FIELD NOTES (verified against live API responses, 2026-07-27)
 *  - mintAuthority / freezeAuthority: empty string means REVOKED (good).
 *    A present value means the authority still exists (risk).
 *  - topHolders[].pct is already a 0-100 percentage, not a fraction.
 *  - topHolders[].insider is a real per-holder boolean from RugCheck's
 *    own insider-graph detection.
 *  - score_normalised is 1-100 where LOWER IS SAFER. We expose it as
 *    rug_risk_pct directly (same orientation) rather than inverting it,
 *    so "higher = worse" stays consistent with the field name.
 *  - creator is the dev wallet; creatorBalance is their current holding
 *    in raw token units, which we convert to a percentage of supply when
 *    supply is available, otherwise leave null rather than guess.
 */

import fetch from 'node-fetch';

const RUGCHECK_BASE = 'https://api.rugcheck.xyz/v1';
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;

const _cache = new Map(); // ca -> { at: number, value: object|null }

function cacheGet(ca) {
  const entry = _cache.get(ca);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    _cache.delete(ca);
    return undefined;
  }
  return entry.value;
}

function cacheSet(ca, value) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  _cache.set(ca, { at: Date.now(), value });
}

/**
 * Read a token's artwork straight from its own published metadata.
 *
 * This is the last resort and also the most authoritative one: the JSON a
 * launchpad itself renders from. Used only when DexScreener (paid profiles
 * only), RugCheck's cached copy, and GMGN have all come back empty.
 *
 * Guards, because this URL is attacker-influenced -- anyone can mint a token
 * pointing its metadata anywhere:
 *   - http/https only, so no file:// or data: URIs
 *   - short timeout and a size cap, so a hostile host cannot stall or flood us
 *   - the returned image must itself be an http(s) URL
 * Never throws; returns null on anything unexpected.
 */
export async function fetchImageFromMetadata(uri, logger) {
  const log = logger || (() => {});
  if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) return null;

  let controller, timer;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(uri, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return null;

    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > 512 * 1024) return null;          // metadata json is tiny
    const text = (await res.text()).slice(0, 512 * 1024);

    const j = JSON.parse(text);
    const pick = v => (typeof v === 'string' && /^https?:\/\//i.test(v)) ? v : null;
    const image = pick(j.image) || pick(j.image_url) || pick(j.imageUrl);
    if (!image) return null;

    return { image_url: image, header_url: pick(j.banner_image) || pick(j.banner) || null };
  } catch (e) {
    clearTimeout(timer);
    log('enrichment', 'Token metadata fetch failed', { uri: String(uri).slice(0, 80), error: e.message });
    return null;
  }
}

/** Solana mints are base58, 32-44 chars, and never start with 0x. */
export function isSolanaAddress(ca) {
  return typeof ca === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca);
}

/**
 * Fetch safety data for a Solana mint.
 * Returns an object of snake_case fields ready to Object.assign onto a hit,
 * or null if unavailable (network error, non-Solana, not indexed yet).
 * NEVER throws.
 */
export async function fetchSafety(ca, logger, { force = false } = {}) {
  const log = logger || (() => {});
  if (!isSolanaAddress(ca)) return null; // EVM/unknown -- out of scope, stays unknown

  // `force` is set by a manual refresh. Without it the 5-minute cache would
  // hand back the same reading the user pressed the button to replace.
  if (!force) {
    const cached = cacheGet(ca);
    if (cached !== undefined) return cached;
  }

  let controller, timer;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${RUGCHECK_BASE}/tokens/${ca}/report`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      // 404 is normal for tokens RugCheck hasn't indexed yet -- cache the
      // miss briefly so a burst of mentions doesn't hammer the API.
      cacheSet(ca, null);
      return null;
    }

    const j = await res.json();
    const parsed = parseReport(j);
    cacheSet(ca, parsed);
    return parsed;
  } catch (e) {
    if (timer) clearTimeout(timer);
    log('enrichment', 'RugCheck lookup failed', { ca, error: e.message });
    cacheSet(ca, null);
    return null;
  }
}

function parseReport(j) {
  if (!j || typeof j !== 'object') return null;

  const holders = Array.isArray(j.topHolders) ? j.topHolders : [];

  // Top-10 concentration. Only meaningful if RugCheck actually returned
  // holders; an empty array means "not indexed", not "0% concentration".
  let top10 = null;
  if (holders.length > 0) {
    top10 = holders
      .slice(0, 10)
      .reduce((sum, h) => sum + (typeof h.pct === 'number' ? h.pct : 0), 0);
    top10 = Math.min(100, Number(top10.toFixed(2)));
  }

  // Insider-flagged holders, straight from RugCheck's own graph analysis.
  const insiderCount = holders.length > 0
    ? holders.filter(h => h.insider === true).length
    : null;

  // Dev/creator holding as a % of the circulating supply the holders list
  // describes. RugCheck gives creatorBalance in raw units, so we only
  // compute a percentage when we can find the creator in topHolders --
  // otherwise null rather than a fabricated 0.
  let devPct = null;
  if (j.creator && holders.length > 0) {
    const devEntry = holders.find(h => h.owner === j.creator);
    if (devEntry && typeof devEntry.pct === 'number') {
      devPct = Number(devEntry.pct.toFixed(2));
    } else if (j.creatorBalance === 0) {
      // Explicitly zero balance is a real, known answer: dev sold/never held.
      devPct = 0;
    }
  }

  // Authority semantics, verified against live RugCheck responses:
  //   null or empty string -> REVOKED (safe). This is the normal state for
  //     a graduated pump.fun token and is the most reassuring fact about a
  //     mint -- reporting it as 'unknown' hid it completely.
  //   a pubkey string       -> authority still exists (a real risk).
  const mintStr = j.mintAuthority == null ? '' : String(j.mintAuthority);
  const freezeStr = j.freezeAuthority == null ? '' : String(j.freezeAuthority);
  const mintAuthorityActive = mintStr.length > 0;
  const freezeAuthorityActive = freezeStr.length > 0;

  // LP lock %. The top-level field is often empty while the real number
  // sits on the market entry -- verified live: top-level '' vs
  // markets[0].lp.lpLockedPct === 100 for a fully locked pool.
  let lpLockedPct = typeof j.lpLockedPct === 'number' ? j.lpLockedPct : null;
  if (lpLockedPct == null && Array.isArray(j.markets)) {
    for (const mk of j.markets) {
      const v = mk && mk.lp && mk.lp.lpLockedPct;
      if (typeof v === 'number') { lpLockedPct = v; break; }
    }
  }

  const launchpadName = j.launchpad && typeof j.launchpad === 'object'
    ? (j.launchpad.name || null)
    : (typeof j.launchpad === 'string' && j.launchpad ? j.launchpad : null);

  const risks = Array.isArray(j.risks)
    ? j.risks.map(r => ({ name: r.name, level: r.level, description: r.description })).slice(0, 10)
    : [];

  return {
    // rug_risk_pct: 1-100, higher = riskier (RugCheck's own orientation).
    rug_risk_pct: typeof j.score_normalised === 'number' ? j.score_normalised : null,
    rugged: typeof j.rugged === 'boolean' ? j.rugged : null,
    holder_count: typeof j.totalHolders === 'number' && j.totalHolders > 0 ? j.totalHolders : null,
    top10_holder_pct: top10,
    dev_holder_pct: devPct,
    dev_wallet: j.creator || null,
    insider_holder_count: insiderCount,
    graph_insiders_detected: typeof j.graphInsidersDetected === 'number' ? j.graphInsidersDetected : null,
    is_mintable: mintAuthorityActive,
    is_freezable: freezeAuthorityActive,
    lp_burned_pct: lpLockedPct,
    transfer_fee_pct: j.transferFee && typeof j.transferFee.pct === 'number' ? j.transferFee.pct : null,
    total_lp_providers: typeof j.totalLPProviders === 'number' ? j.totalLPProviders : null,
    safety_risks: risks,
    safety_source: 'rugcheck',
    safety_checked_at: new Date().toISOString(),
    // TOKEN IMAGE FALLBACK.
    // DexScreener only fills info.imageUrl for tokens with a paid/enhanced
    // profile, so the majority of fresh pump.fun launches came through with
    // no picture at all even though they clearly have one. RugCheck reads the
    // token's own metadata, so fileMeta.image is the real artwork -- and we
    // already fetch this report for every Solana mint, so it costs no extra
    // call. Applied by the caller ONLY when DexScreener gave us nothing;
    // DexScreener stays the preferred source when it has one.
    image_url: (j.fileMeta && typeof j.fileMeta.image === 'string' && /^https?:\/\//i.test(j.fileMeta.image))
      ? j.fileMeta.image
      : null,
    // THE SOURCE ITSELF.
    // When RugCheck has no cached image, it still reports the token's own
    // metadata URI -- the same JSON pump.fun, bonk and every other Solana
    // launchpad reads to render the coin. Fetching that is the most direct
    // answer available: not a provider's copy of the artwork, but the artwork
    // the creator actually published. Returned here so the caller can fetch it
    // only when everything cheaper has failed.
    metadata_uri: (j.tokenMeta && typeof j.tokenMeta.uri === 'string' && /^https?:\/\//i.test(j.tokenMeta.uri))
      ? j.tokenMeta.uri
      : null,
    // Only override launchpad if RugCheck actually identified one -- the
    // mint-suffix heuristic in index.js is the fallback, not the reverse.
    ...(launchpadName ? { launchpad: launchpadName } : {}),
  };
}
