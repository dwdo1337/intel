/**
 * How far a call actually ran.
 *
 * WHY THIS EXISTS
 *
 * The caller scoreboard scored every call as `live_mcap / entry_mcap` -- the
 * value at the moment somebody last pressed refresh. A memecoin's entire life is
 * a spike, so that is the one number that is almost never the interesting one.
 * Measured on the live store: a token called at $10,587 sits at $2,166 and was
 * scored 0.20x, a loss. It had touched $21,018. The call was a 2x and the app
 * recorded a failure.
 *
 * So peak is tracked as a first-class fact, from two directions:
 *
 *   OBSERVED  a high-water mark updated free of charge every time any code path
 *             already had a fresh market cap in its hands. Exact, but it only
 *             ever sees what it happened to look at.
 *   KLINE     candles from the call forward, whose per-candle `high` is the real
 *             peak whether or not anyone was watching. Costs one provider call.
 *
 * Both write the same fields. `peak_source` records which one won, because an
 * observation and a reconstruction are different qualities of evidence and the
 * card should not pretend otherwise.
 *
 * Everything here is pure. The network lives in gmgn.js and pumpfun.js.
 */

/**
 * Keep the higher of what we hold and what we just saw.
 *
 * @returns {{value:number|null, at:string|null, source:string|null, changed:boolean}}
 */
export function higherPeak(peak, peakAt, peakSource, mcap, at, source = 'observed') {
  // Number(null) is 0, not NaN -- so a plain Number() here would turn "no peak
  // recorded" into a peak of zero, and the caller would persist that 0 as if it
  // were a measurement. num() keeps absence absent.
  const num = v => (v === null || v === undefined || v === '') ? NaN : Number(v);
  const seen = num(mcap);
  const held = num(peak);
  const keep = { value: Number.isFinite(held) ? held : null, at: peakAt ?? null,
                 source: peakSource ?? null, changed: false };

  // A market cap of zero is not a peak, and a negative one is not a number.
  if (!Number.isFinite(seen) || seen <= 0) return keep;
  if (Number.isFinite(held) && held >= seen) return keep;

  return { value: seen, at: at ?? null, source, changed: true };
}

/**
 * How many candles one kline request will return, at most.
 *
 * MEASURED, not documented. Asking for a 24h window at 1m resolution returned
 * exactly 100 candles covering only the last 13.6 hours of it -- while the same
 * window at 15m returned 40 candles covering the full 14.8h the token had
 * existed for. So the provider caps a page at 100 and serves the MOST RECENT
 * ones, discarding the beginning of the window silently and with no error.
 *
 * For a memecoin the beginning of the window is the launch spike. A truncated
 * page is therefore not a slightly-worse answer, it is the wrong one -- and it
 * arrives looking exactly like a right one.
 */
export const KLINE_PAGE = 100;

const RESOLUTIONS = [
  ['1m', 60], ['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['1d', 86400],
];

/**
 * The finest resolution whose candles cover the WHOLE window in one page.
 *
 * The thing that makes this safe rather than a compromise: `max(high)` does not
 * change with resolution. The high of a 1d candle is the true maximum price
 * traded that day -- identical to the maximum of the 1,440 one-minute highs
 * inside it. Coarsening costs precision in `peak_at`, never in the peak itself.
 *
 * So the rule is: never truncate, coarsen instead. A 90-candle budget against a
 * 100-candle cap leaves room for the provider aligning candles to boundaries and
 * handing back one or two more than the arithmetic predicts.
 */
export function klineResolution(fromTs, toTs) {
  const secs = Math.max(0, Number(toTs) - Number(fromTs));
  if (!Number.isFinite(secs)) return '1d';
  const budget = KLINE_PAGE * 0.9;
  for (const [name, size] of RESOLUTIONS) {
    if (secs / size <= budget) return name;
  }
  // Past ~90 days even daily candles overflow a page. 1d is the coarsest the
  // provider offers, so this WILL be truncated -- fillPeak logs when it happens
  // rather than letting a partial window pass as a complete one.
  return '1d';
}

/**
 * Peak market cap since the call, reconstructed from candles.
 *
 * Scaled from a known (price, mcap) pair rather than multiplied by a supply
 * figure, because we do not store supply and it is not constant -- burns and
 * mint authority make "mcap = price x supply" a claim we cannot check. The ratio
 * of two prices for the SAME token needs no supply at all, and it stays correct
 * across a burn as long as both readings sit on the same side of it.
 *
 * The floor is the reference mcap itself. The call moment is inside the window,
 * so a token that only ever fell peaked at the price it was called at -- which
 * reads as 1.00x, meaning "the best it ever did was flat". That is a real
 * outcome, not a missing one.
 *
 * @param {Array} candles   [{ time: msEpoch, high: string|number }]
 * @param {number} refPrice price at the reference point
 * @param {number} refMcap  market cap at that same point
 * @returns {{mcap:number, at:string|null}|null}  null when it cannot be computed
 */
export function peakFromCandles(candles, refPrice, refMcap) {
  const p0 = Number(refPrice), m0 = Number(refMcap);
  if (!Number.isFinite(p0) || p0 <= 0) return null;
  if (!Number.isFinite(m0) || m0 <= 0) return null;
  if (!Array.isArray(candles) || !candles.length) return null;

  let best = null, bestAt = null;
  for (const c of candles) {
    const h = Number(c && c.high);
    if (!Number.isFinite(h) || h <= 0) continue;
    if (best === null || h > best) { best = h; bestAt = c.time ?? null; }
  }
  if (best === null) return null;

  const scaled = m0 * (best / p0);
  // Below the reference means the window never traded above the call.
  if (scaled <= m0) return { mcap: m0, at: null };

  const at = Number.isFinite(Number(bestAt)) ? new Date(Number(bestAt)).toISOString() : null;
  return { mcap: scaled, at };
}

/**
 * How many times the call's entry the peak was.
 *
 * null, never 1, when either side is unknown. A call with no measured outcome
 * has to be EXCLUDED from a scoreboard rather than scored as break-even -- on a
 * real store 87% of rows had no live reading, and defaulting those to 1.00x
 * produces a table where everybody looks average, which is worse than no table.
 */
export function peakMultiple(peakMcap, entryMcap) {
  const p = Number(peakMcap), e = Number(entryMcap);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (!Number.isFinite(e) || e <= 0) return null;
  return p / e;
}

/**
 * Minutes from the call to the peak.
 *
 * Shown because a 10x that happened in nine seconds and reversed is not the same
 * call as a 10x that took an hour, and a board that prints one number for both
 * is telling you they are.
 */
export function minutesToPeak(calledAt, peakAt) {
  const a = Date.parse(calledAt), b = Date.parse(peakAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const mins = (b - a) / 60000;
  return mins >= 0 ? mins : null;
}
