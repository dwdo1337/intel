/**
 * Sanity bounds on provider numbers.
 *
 * A provider returning a number is not the same as the number being true. This
 * is where a value gets rejected for being impossible rather than for being
 * absent, and rejection always means `null` -- which the whole app already
 * reads as "unknown" and draws as a dash.
 *
 * WHY THIS EXISTS
 *
 * A robinhood token (0xa870f8c7cae9705194a141b0c2964b6c79ee3742) was stored and
 * shown with 622,770 holders against a $39,135 market cap: six cents of market
 * cap per holder. It came from GMGN `token info`, which was validated only with
 * `> 0`, on a chain where nothing cross-checks it -- RugCheck, the app's other
 * holder source, is Solana-only. 70 of 500 stored signals have a holder count
 * with no second opinion, so the bad value had nothing standing between it and
 * the card.
 */

/**
 * The floor, in USD of market cap per holder.
 *
 * Measured, not chosen. Across 430 RugCheck-verified rows in a live 500-signal
 * store the lowest genuine value was $1.17/holder; the distribution's 1st
 * percentile was $2.34 and its median $39.59. Exactly one row in 500 sat below
 * $1, and it was the bad one at $0.06 -- an order of magnitude clear of
 * anything real.
 *
 * Deliberately far below the observed floor rather than tight against it. This
 * is a garbage filter, not a judgement about which tokens are widely held, and
 * a token with genuinely many tiny holders should survive it.
 */
export const MIN_MCAP_PER_HOLDER = 1;

/**
 * A holder count, or null when it cannot be believed.
 *
 * @param {*} count       whatever the provider returned
 * @param {*} mcapUsd     market cap in USD, or null/0 when not known
 * @returns {number|null} the count, or null meaning "unknown"
 *
 * Fail-open on an unknown market cap. With no cap there is no ratio to test, so
 * there is no evidence against the count -- and discarding it there would throw
 * away good data on every bonding-curve token DexScreener reports no market cap
 * for. Absence of a cross-check is not grounds for rejection.
 */
export function plausibleHolderCount(count, mcapUsd) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;

  const mc = Number(mcapUsd);
  if (!Number.isFinite(mc) || mc <= 0) return n;   // nothing to judge it against

  // `<` not `<=`: a token sitting exactly on the floor is not evidence of
  // anything wrong, and the floor is already well below the observed minimum.
  if (mc / n < MIN_MCAP_PER_HOLDER) return null;

  return n;
}

/**
 * What the card's holder count should become, given a fresh provider reading.
 *
 * Lives here rather than inline at the call site so the decision can actually
 * be tested -- the interesting behaviour is not the bound itself but what
 * happens when the bound rejects the NEW reading while the OLD one is already
 * wrong. Getting that branch backwards either leaves the garbage on the card
 * forever, or wipes a good count because one provider answered badly once.
 *
 * @param {*} stored    what the card holds now
 * @param {*} incoming  what the provider just returned
 * @param {*} mcapUsd   market cap to judge both against
 * @param {{force?: boolean}} opts  force = the user asked for a re-scan
 * @returns {{value: number|null, changed: boolean}}
 */
export function resolveHolderCount(stored, incoming, mcapUsd, { force = false } = {}) {
  const fresh = plausibleHolderCount(incoming, mcapUsd);
  const keep = { value: stored ?? null, changed: false };

  if (fresh != null) {
    return fresh === stored ? keep : { value: fresh, changed: true };
  }

  // The new reading is not believable. Normally that changes nothing -- a bad
  // answer is not a reason to throw away what is already there.
  //
  // The exception is a user-driven re-scan where the STORED value is itself
  // impossible. That is the one moment the card is meant to self-correct, and
  // without it the number that started all this would survive every refresh
  // precisely BECAUSE its replacement was rejected. Re-testing the stored value
  // is what stops this clearing a good RugCheck count on a bad GMGN answer.
  if (force && stored != null && plausibleHolderCount(stored, mcapUsd) == null) {
    return { value: null, changed: true };
  }

  return keep;
}
