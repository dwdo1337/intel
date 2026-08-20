import { useState, useEffect } from 'react';
import './best-calls.css';

/**
 * Which calls actually ran, and which rooms produce runners.
 *
 * THE NUMBER THIS BOARD EXISTS FOR
 *
 * Every scoreboard in the app used to score a call by what the token is worth
 * NOW. A memecoin's whole life is a spike, so that is the one number that is
 * almost never the interesting one: a token called at $10,587 that touched
 * $21,018 and fell back to $2,166 was recorded as a 0.20x loss. It was a 2x.
 *
 * So peak leads here. But the current value is never dropped, because "it ran
 * 10x" and "you would have nothing left if you held" are both true, and a board
 * that shows only the first one is a board that flatters every rug.
 */
export function BestCalls({ onPick }) {
  const [by, setBy] = useState('call');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    fetch(`/api/best-calls?by=${by}&limit=60`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(j => { if (alive) setData(j); })
      .catch(e => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [by]);

  const cov = data && data.coverage;

  return (
    <div className="bc">
      <div className="bc-head">
        <div className="bc-tabs">
          {[['call', 'Best calls'], ['room', 'By room'], ['caller', 'By caller']].map(([id, label]) => (
            <button key={id} className={`bc-tab${by === id ? ' on' : ''}`} onClick={() => setBy(id)}>
              {label}
            </button>
          ))}
        </div>
        {/* Coverage is stated, always. A leaderboard built on 20 of 500 tokens
            is not a leaderboard, and the only thing worse than not knowing that
            is not being told. */}
        {cov && (
          <div className="bc-cov">
            {cov.withPeak} of {cov.tokens} measured
            <span className="bc-cov-note">
              {cov.withPeak < cov.tokens
                ? ' · run an outcome refresh to raise this'
                : ' · complete'}
            </span>
          </div>
        )}
      </div>

      {err && <div className="bc-empty">Could not load: {err}</div>}
      {!err && !data && <div className="bc-empty">Reading peaks…</div>}

      {data && by === 'call' && (
        data.calls.length === 0
          ? <div className="bc-empty">
              No measured peaks yet. Run an outcome refresh — until a call has a
              peak it is excluded rather than counted as break-even.
            </div>
          : <CallList calls={data.calls} onPick={onPick} />
      )}

      {data && by !== 'call' && (
        data.groups.length === 0
          ? <div className="bc-empty">Nothing measured yet.</div>
          : <GroupList groups={data.groups} by={by} onPick={onPick} />
      )}
    </div>
  );
}

const fmtUsd = v => {
  if (v == null) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
};
const fmtMult = v => (v == null ? '—' : v >= 10 ? v.toFixed(0) + 'x' : v.toFixed(2) + 'x');
const fmtMins = m => {
  if (m == null) return null;
  if (m < 60) return Math.round(m) + 'm';
  if (m < 1440) return (m / 60).toFixed(1) + 'h';
  return Math.round(m / 1440) + 'd';
};

/**
 * Only a 5x or better gets colour.
 *
 * The threshold was 2x, which lit up most of the board -- and a highlight that
 * applies to half the rows is not a highlight, it is a background. 5x is the
 * point where a call was worth having seen.
 */
const HIGHLIGHT_AT = 5;
const tone = m => (m == null ? '' : m >= 10 ? ' huge' : m >= HIGHLIGHT_AT ? ' good' : '');

function CallList({ calls, onPick }) {
  return (
    <div className="bc-list">
      {calls.map((c, i) => {
        const mins = fmtMins(c.minutesToPeak);
        return (
          <div className="bc-row" key={c.ca + c.caller + i} onClick={() => onPick && onPick(c.ca)}>
            <div className="bc-rank">{i + 1}</div>
            <div className="bc-tok">
              <div className="bc-sym">
                {c.symbol || '—'}
                <span className={`bc-chain ${c.chain}`}>{c.chain}</span>
                {c.launchpad && <span className="bc-lp">{c.launchpad}</span>}
              </div>
              {/* WHO FOUND IT, and where. One row per token now, credited to
                  whoever called it first -- everyone after them had the benefit
                  of the first call. The rest are counted, not listed. */}
              <div className="bc-who">
                <span className="bc-firstlabel">first</span>
                <b>@{c.caller}</b>
                {c.room ? <> · {c.room}</> : null}
                {c.alsoCalled > 0 && (
                  <span className="bc-also" title={`Called by ${c.alsoCalled} more across ${c.roomCount} room${c.roomCount === 1 ? '' : 's'}`}>
                    +{c.alsoCalled} more
                  </span>
                )}
              </div>
            </div>

            <div className="bc-run">
              <div className={`bc-mult${tone(c.peakMult)}`}>{fmtMult(c.peakMult)}</div>
              <div className="bc-sub">
                {fmtUsd(c.entryMcap)} → {fmtUsd(c.peakMcap)}
                {/* How the peak was established. An observed high-water mark
                    and a reconstruction from candles are different qualities of
                    evidence and the row says which it is. */}
                <span className="bc-src" title={
                  c.peakSource === 'kline' ? 'Reconstructed from candles since the call'
                  : c.peakSource === 'pumpfun' ? "pump.fun's own all-time high, dated after the call"
                  : 'Highest value actually observed while running'
                }>{c.peakSource}</span>
              </div>
            </div>

            <div className="bc-now">
              {/* Never hidden. A 10x that round-tripped to zero must not read
                  the same as one that held. */}
              <div className={`bc-nowmult${c.dead ? ' dead' : ''}`}>
                {c.dead ? 'dead' : fmtMult(c.nowMult)}
              </div>
              <div className="bc-sub">{mins ? `peak +${mins}` : 'now'}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GroupList({ groups, by, onPick }) {
  return (
    <div className="bc-list">
      {groups.map((g, i) => (
        <div className="bc-row group" key={g.key + i}>
          <div className="bc-rank">{i + 1}</div>
          <div className="bc-tok">
            <div className="bc-sym">{by === 'room' ? g.key : '@' + g.key}</div>
            <div className="bc-who">
              {g.calls} scored call{g.calls === 1 ? '' : 's'} · {g.chains.join(', ')}
            </div>
          </div>

          <div className="bc-run">
            {/* MEDIAN leads, not best. One lucky 40x would otherwise crown
                whichever room happened to catch it once. */}
            <div className={`bc-mult${tone(g.medianPeakMult)}`}>{fmtMult(g.medianPeakMult)}</div>
            <div className="bc-sub">median peak</div>
          </div>

          <div className="bc-now">
            <div className="bc-rates">
              <span>{Math.round(g.hitRate2x * 100)}%<i>2x</i></span>
              <span>{Math.round(g.hitRate10x * 100)}%<i>10x</i></span>
            </div>
            {g.best && (
              <div className="bc-sub bc-best" onClick={() => onPick && onPick(g.best.ca)}>
                best {fmtMult(g.best.peakMult)} · {g.best.symbol || '—'}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
