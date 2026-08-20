import { useEffect, useState } from 'react';
import { fmt } from '../App';
import { fmtPrice } from './Feed';

export function Inspector({ event }) {
  // GMGN direct REST is Cloudflare-blocked from the browser, but the BACKEND
  // now proxies it through gmgn-cli, so there are two real on-demand routes:
  //   /api/token/:chain/:ca/dev      -> creator's launch history
  //   /api/token/:chain/:ca/wallets  -> KOL / smart money / risk wallets
  // Both are loaded on an explicit click rather than on selection: together
  // they are ~6 GMGN calls, and GMGN's limiter escalates, so firing them every
  // time a card is clicked would starve the per-signal lookups every card
  // needs. See <WalletIntel/> at the bottom of this file.

  if (!event || !event.token) return (
    <div className="dash-col">
      <div className="dash-col-head">Inspector</div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Select a token.</div>
    </div>
  );

  const m = event.metrics || {};
  const s = event.safety || {};
  const color = event.platform === 'tg' ? '#3b82f6' : '#a855f7';
  const initials = (event.token.name || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
  const chainName = event.token.chain || 'SOLANA';
  // Which safety concepts even EXIST on this chain. Mint/freeze authority is
  // Solana's model; honeypot, "renounced ownership" and taxes are EVM's. The
  // panel used to print every field on every chain and label the inapplicable
  // ones "unknown", which is a different claim from "does not apply here".
  const isSol = String(chainName).toLowerCase().startsWith('sol');
  const chainLabel = String(chainName).toLowerCase() === 'bsc' ? 'BSC'
    : String(chainName).charAt(0).toUpperCase() + String(chainName).slice(1);
  // Chains no safety provider covers at all: RugCheck is Solana-only, GMGN
  // security is sol/bsc/base. On these there is nothing to show, and listing
  // five "unknown" rows reads as five failed lookups rather than one absent
  // provider. Judged on the chain, not on `s.source` being null, so a token
  // that simply has not been enriched yet still shows its fields as pending.
  const SAFETY_CHAINS = ['solana', 'sol', 'bsc', 'base'];
  const noSafetyProvider = !SAFETY_CHAINS.includes(String(chainName).toLowerCase());
  // Same distinction for the launchpad -- but the reason given here was wrong.
  // Launchpad identification does NOT come from RugCheck. It comes from
  // detectLaunchpad(), which reads DexScreener's dexId, plus the Solana mint
  // suffix. That works on four chains, not one: BSC resolves Four.meme, Flap,
  // GraFun and BakerySwap, and Base/Ethereum resolve Clanker and Zora -- all
  // present in the live store. Calling those "not detectable" told the user we
  // had not looked when we had looked and found nothing.
  //
  // Mirrors the chains GET /api/launchpads publishes at least one launchpad for.
  const launchpadsDetectable =
    ['solana', 'bsc', 'base', 'ethereum', 'robinhood'].includes(String(chainName).toLowerCase());
  const address = event.token.address || '';
  const banner = event.token.banner;
  const image = event.token.image;

  return (
    <div className="dash-col">
      <div className="dash-col-head">Inspector</div>
      <div className="in-col">
        <div className="in-card">
          {banner && (
            <div className="in-banner" style={{ backgroundImage: `url(${banner})` }}>
              <div className="in-banner-overlay" />
              <div className="in-banner-info">
                {image ? (
                  <img className="in-banner-logo" src={image} alt="" onError={e => e.target.style.display='none'} />
                ) : (
                  <div className="in-banner-logo" style={{ display:'flex',alignItems:'center',justifyContent:'center',background:`linear-gradient(135deg,${color},#000)`,color:'#fff',fontSize:18,fontWeight:800 }}>{initials}</div>
                )}
                <div>
                  <div className="in-banner-name">{event.token.name || 'Unknown'}</div>
                  <div className="in-banner-symbol">{event.token.symbol || '—'} · {chainName}</div>
                </div>
              </div>
            </div>
          )}
          {!banner && (
            <div className="in-card-title">Selected token</div>
          )}
          {!banner && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              {image ? (
                <img src={image} alt="" width={44} height={44} style={{ borderRadius:10,objectFit:'cover',border:'1px solid var(--line)' }} onError={e=> e.target.style.display='none'} />
              ) : (
                <div style={{ width: 44, height: 44, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: '#fff', background: `linear-gradient(135deg,${color},#000)` }}>{initials}</div>
              )}
              <div>
                <div style={{ fontSize: 16, fontWeight: 800 }}>{event.token.name || 'Unknown'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{event.token.symbol || '—'} · {chainName}</div>
              </div>
            </div>
          )}
          {/* `(m.chg24h || 0) >= 0` painted an UNKNOWN 24h change green, so a
              token with no price history read as up. Same unknown-as-good trap
              as the safety grid below; no data now means no colour. */}
          <div className={`in-price ${m.chg24h == null ? '' : m.chg24h >= 0 ? 'up' : 'down'}`}>${fmt(m.mcap)}</div>
          <div className="in-subline">
            <span>Entry <b>${fmt(m.entryMcap)}</b></span>
            <span>Multi <b>{m.multiplier ? `${m.multiplier.toFixed(2)}×` : '—'}</b></span>
            <span>24h <b style={{ color: m.chg24h == null ? 'var(--muted)' : m.chg24h >= 0 ? 'var(--buy)' : 'var(--sell)' }}>{m.chg24h == null ? '—' : m.chg24h.toFixed(1) + '%'}</b></span>
          </div>
          <div className="in-ca">
            <span>{address || '—'}</span>
            {address && <span style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => navigator.clipboard.writeText(address)}>COPY</span>}
          </div>
        </div>

        <div className="in-card">
          <div className="in-card-title">Recent data</div>
          <div className="in-grid">
            {/* "unknown" implies we looked and could not tell, so it is only
                shown on chains where we CAN look. See launchpadsDetectable
                above: detection is dexId-based and covers four chains, not just
                Solana as this note used to claim. */}
            <Stat
              label="Launchpad"
              value={event.launchpad || (launchpadsDetectable ? 'unknown' : 'not detectable on ' + chainName)}
              accent={!!event.launchpad}
            />
            <Stat label="Chain" value={chainName} />
            <Stat label="DEX" value={event.dex || '—'} />
            <Stat label="Pair" value={event.pairLabel || '—'} />
            <Stat label="Price" value={m.price ? `$${fmtPrice(m.price)}` : '—'} />
            <Stat label="Mkt Cap" value={`$${fmt(m.mcap)}`} />
            <Stat label="Entry" value={`$${fmt(m.entryMcap)}`} />
            <Stat label="Multi" value={m.multiplier ? `${m.multiplier.toFixed(2)}×` : '—'} />
            <Stat label="Liquidity" value={`$${fmt(m.liq)}`} />
            <Stat label="Volume" value={`$${fmt(m.vol)}`} />
            <Stat label="5m" value={m.chg5m == null ? '—' : `${m.chg5m.toFixed(1)}%`} sign={m.chg5m >= 0 ? 'buy' : 'sell'} />
            <Stat label="1h" value={m.chg1h == null ? '—' : `${m.chg1h.toFixed(1)}%`} sign={m.chg1h >= 0 ? 'buy' : 'sell'} />
            <Stat label="24h" value={m.chg24h == null ? '—' : `${m.chg24h.toFixed(1)}%`} sign={m.chg24h >= 0 ? 'buy' : 'sell'} />
          </div>
        </div>

        {/* ── Supply & tokenomics ──
            ONLY FIELDS THAT APPLY TO THIS CHAIN.

            Measured across 299 stored tokens: `is_honeypot` and
            `is_contract_renounced` were unknown on 275 of them — including all
            226 Solana tokens. Not because the lookup failed, but because
            **those are EVM concepts**. Verified against live GMGN: on Solana it
            returns `is_honeypot: null` and `is_renounced: null`, while
            returning `renounced_mint: true, renounced_freeze_account: true` —
            mint/freeze authority IS the Solana equivalent, and the app already
            has it.

            Likewise rug score, insiders and dev wallet come from RugCheck,
            which is Solana-only, so every BSC/Robinhood card listed four
            unknowns for data that was never obtainable.

            "Not applicable on this chain" and "we failed to measure it" are
            different facts. The app's own rule says show the second honestly —
            it was showing the first as if it were the second, which made the
            panel read as broken. Inapplicable fields are now simply absent. */}
        <div className="in-card">
          <div className="in-card-title">Supply &amp; tokenomics</div>
          {noSafetyProvider ? (
            /* No provider covers this chain at all — RugCheck is Solana-only and
               GMGN security covers sol/bsc/base. On Robinhood that produced a
               grid of five "unknown" rows, which reads as five failed lookups
               rather than one absent provider. Stated once instead. */
            <div className="in-note">
              No safety provider covers {chainLabel}. RugCheck is Solana-only and
              GMGN security covers Solana, BSC and Base — so honeypot, taxes, LP
              and contract status cannot be checked for this token by any source
              the app has. Market data, holders and wallet composition above are
              unaffected.
            </div>
          ) : (
            <>
              <div className="in-grid">
                {isSol ? (
                  <>
                    <Stat label="Mint" value={s.mintRevoked == null ? 'unknown' : s.mintRevoked ? 'revoked' : 'active'} sign={s.mintRevoked == null ? null : s.mintRevoked ? 'buy' : 'sell'} />
                    <Stat label="Freeze" value={s.freezeable == null ? 'unknown' : s.freezeable ? 'yes' : 'no'} sign={s.freezeable == null ? null : s.freezeable ? 'sell' : 'buy'} />
                  </>
                ) : (
                  <>
                    <Stat label="Renounced" value={s.contractRenounced == null ? 'unknown' : s.contractRenounced ? 'yes' : 'no'} sign={s.contractRenounced == null ? null : s.contractRenounced ? 'buy' : 'warn'} />
                    <Stat label="Honeypot" value={s.isHoneypot == null ? 'unknown' : s.isHoneypot ? 'yes' : 'no'}
                          sign={s.isHoneypot == null ? null : s.isHoneypot ? 'sell' : 'buy'} />
                  </>
                )}
                <Stat label="LP burned %" value={pct(s.lpBurned)}
                      sign={s.lpBurned == null ? null : s.lpBurned >= 80 ? 'buy' : 'warn'} />
                <Stat label="Buy tax" value={pct(s.buyTax)} />
                <Stat label="Sell tax" value={pct(s.sellTax)} />
                {/* RugCheck-only. Absent rather than "unknown" on every other chain. */}
                {isSol && (
                  <Stat label="Rug risk" value={pct(s.rugRisk)}
                        sign={s.rugRisk == null ? null : s.rugRisk <= 20 ? 'buy' : 'warn'} />
                )}
              </div>
              {!isSol && (
                <div className="in-note">
                  Rug score, insider clusters and dev wallet come from RugCheck,
                  which covers Solana only — not measurable on {chainLabel}.
                </div>
              )}
            </>
          )}
        </div>

        <div className="in-card">
          <div className="in-card-title">Links</div>
          <div className="in-list">
            {event.links?.twitter && <a href={event.links.twitter} target="_blank" rel="noreferrer" className="in-link">Twitter / X <IconArrow/></a>}
            {event.links?.website && <a href={event.links.website} target="_blank" rel="noreferrer" className="in-link">Website <IconArrow/></a>}
            {event.links?.telegram && <a href={event.links.telegram} target="_blank" rel="noreferrer" className="in-link">Telegram <IconArrow/></a>}
            {event.links?.pair && <a href={event.links.pair} target="_blank" rel="noreferrer" className="in-link">DexScreener <IconArrow/></a>}
            {!event.links?.twitter && !event.links?.website && !event.links?.telegram && !event.links?.pair && <div style={{ color: 'var(--muted)', fontSize: 12 }}>No social links available.</div>}
          </div>
        </div>

        <div className="in-card">
          <div className="in-card-title">Holder distribution</div>
          <div className="in-grid">
            <Stat label="Total holders" value={fmt(m.holders)} />
            <Stat label="Top 10 %" value={pct(m.top10)}
                  sign={m.top10 == null ? null : m.top10 > 60 ? 'warn' : null} />
            {/* Dev holding comes from RugCheck (Solana only), so on every other
                chain it was a permanent "unknown" — and before that a green
                "0%", because `null <= 10` is true. Absent off Solana. */}
            {isSol && (
              <Stat label="Dev %" value={pct(s.devPct)}
                    sign={s.devPct == null ? null : s.devPct <= 10 ? 'buy' : 'sell'} />
            )}
          </div>
          {m.top10 != null && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                <span>Top 10%</span>
                <span>{m.top10}%</span>
              </div>
              <div className="in-bar"><div className="in-bar-fill" style={{ width: `${Math.min(m.top10, 100)}%`, background: m.top10 > 60 ? 'var(--warn)' : 'var(--accent)' }} /></div>
            </div>
          )}
        </div>

        <div className="in-card">
          <div className="in-card-title">Mention history · {event.mentions?.length || 0}</div>
          <div className="in-list">
            {(event.mentions && event.mentions.length > 0) ? event.mentions.slice().reverse().map((men, i) => (
              <div className="in-item" key={i}>
                {/* Telegram blue, Discord blurple -- the two sources are told
                    apart at a glance instead of by reading two letters. */}
                <div className="in-item-avatar"
                     style={men.source === 'telegram'
                       ? { background: 'rgba(59,130,246,0.16)', color: '#7fb3ff' }
                       : { background: 'rgba(88,101,242,0.18)', color: '#a5adf8' }}>
                  {men.source === 'telegram' ? 'TG' : 'DC'}</div>
                <div className="in-item-body">
                  <div className="in-item-title">{men.chatName || 'Unknown chat'}</div>
                  <div className="in-item-sub">{men.author ? `@${men.author}` : 'unknown author'} · {men.detectedAt ? fmtRelTime(men.detectedAt) : '—'}</div>
                </div>
                <div className="in-item-val" style={{ color: 'var(--accent)' }}>{men.detectedAt ? new Date(men.detectedAt).toLocaleTimeString() : '—'}</div>
              </div>
            )) : <div style={{ color: 'var(--muted)', fontSize: 12 }}>No mention history yet.</div>}
          </div>
        </div>

      <WalletIntel event={event} />

      {/* Holder & dev concentration -- every value here is REAL, from
          RugCheck (Solana) or GMGN (EVM). The previous two cards in this
          slot ("Smart wallets & KOLs", "Dev wallet & insiders") rendered six
          rows of "awaiting data source" for features with no backend behind
          them. Rows that cannot be filled were removed rather than shown as
          permanently pending: KOL callouts and smart-wallet buys need a paid
          provider, and sniper activity needs per-block RPC indexing we do
          not do. */}
      <div className="in-card">
        <div className="in-card-title">Holders &amp; dev</div>
        <div className="in-kv">
          <Kv label="Holders" value={m.holders != null ? fmt(m.holders) : null} />
          <Kv label="Top 10 hold" value={m.top10 != null ? m.top10.toFixed(1) + '%' : null}
              warn={m.top10 != null && m.top10 > 80} />
          {/* Dev holding, insiders, LP providers and the deployer all come from
              RugCheck, which covers Solana only. Off Solana they were four
              permanent "unknown" rows for data no provider we have can give —
              which is what made the panel look mostly empty on BSC and
              Robinhood. Absent rather than unknown; the note below says why. */}
          {isSol && <>
            <Kv label="Dev holding" value={s.devPct != null ? s.devPct + '%' : null}
                warn={s.devPct != null && s.devPct > 10} />
            <Kv label="Insider holders" value={s.insiderHolders != null ? String(s.insiderHolders) : null}
                warn={s.insiderHolders > 0} />
            <Kv label="Insider clusters" value={s.graphInsiders != null ? String(s.graphInsiders) : null}
                warn={s.graphInsiders > 0} />
            <Kv label="LP providers" value={s.lpProviders != null ? String(s.lpProviders) : null} />
            <Kv label="Deployer" value={s.devWallet ? shortCa(s.devWallet) : null} mono />
          </>}
        </div>
        {s.source && (
          <div className="in-src">
            data: {s.source}
          </div>
        )}
        {!isSol && (
          <div className="in-note">
            Dev holding, insider clusters and the deployer wallet come from
            RugCheck, which covers Solana only — not available on {chainLabel}.
          </div>
        )}
      </div>

        <div className="in-card in-placeholder">
          <div className="in-card-title">Research links</div>
          <div className="in-list">
            {(event.xSignal?.posts?.length > 0) ? event.xSignal.posts.map((p, i) => (
              <div className="in-item" key={i}>
                <div className="in-item-avatar">X</div>
                <div className="in-item-body">
                  <div className="in-item-title">@{p.handle} · {p.engagement ?? 0} engagements</div>
                  <div className="in-item-sub">{p.text?.slice(0, 90) || '—'} · {fmtRelTime(p.postedAt)}</div>
                </div>
              </div>
            )) : [
              { label: 'X search', sub: 'Search this CA on X/Twitter', url: `https://x.com/search?q=${encodeURIComponent(address)}` },
              { label: 'DexScreener socials', sub: 'Token page + trending score', url: event.links?.pair || `https://dexscreener.com/${chainName}/${address}` },
              { label: 'Bubblemaps / Top10', sub: 'Visual holder clustering', url: `https://app.bubblemaps.io/${chainName}/token/${address}` },
            ].map((it, i) => (
              <div className="in-item dim" key={i}>
                <div className="in-item-avatar">·</div>
                <div className="in-item-body">
                  <div className="in-item-title">{it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.label} <IconArrow/></a> : it.label}</div>
                  <div className="in-item-sub">{it.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A percentage that admits when it was never measured.
 *  "we did not check" and "we checked and it is zero" are different facts and
 *  only one of them is a reason to buy -- so an absent value renders as
 *  "unknown", never as 0%. */
function pct(v) {
  if (v == null || Number.isNaN(Number(v))) return 'unknown';
  return `${Number(v)}%`;
}

function fmtRelTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function pastCalls(n) {
  if (n == null) return '—';
  return `${n} ${n === 1 ? 'call' : 'calls'}`;
}

/** One label/value row. A null value renders as an explicit "no data"
 *  rather than an empty cell, so a missing metric is visibly missing
 *  instead of looking like a blank the UI forgot to fill. */
function Kv({ label, value, warn = false, mono = false }) {
  return (
    <div className="in-kv-row">
      <span className="in-kv-label">{label}</span>
      <span className={'in-kv-value' + (value == null ? ' none' : '') + (warn ? ' warn' : '') + (mono ? ' mono' : '')}>
        {value == null ? 'no data' : value}
      </span>
    </div>
  );
}

function shortCa(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '…' + addr.slice(-6);
}

function Stat({ label, value, sign, accent }) {
  // Colour marks a DIRECTION, not a category. `accent` used to paint any
  // "interesting" field green -- the launchpad name, a revoked mint -- so the
  // inspector had a dozen green values and none of them meant up.
  let color = 'var(--text)';
  if (sign === 'buy') color = 'var(--buy)';
  else if (sign === 'sell') color = 'var(--sell)';
  else if (sign === 'warn') color = 'var(--warn)';
  return (
    <div className="in-stat">
      <div className="label">{label}</div>
      <div className="val" style={{ color }}>{value}</div>
    </div>
  );
}

/**
 * Wallet intelligence: who actually holds and trades this token.
 *
 * Loaded on click, never on selection. Together these two routes are about six
 * GMGN calls, and GMGN's limiter escalates on abuse (retrying during a cooldown
 * extends the ban), so auto-loading on every card click would starve the cheap
 * per-signal lookups that every card in the feed depends on.
 *
 * Every number here states its own scope. "Top holders" is not "all holders",
 * and the live watcher only sees trades made while the app was running — both
 * are labelled inline rather than in documentation nobody reads.
 */
function WalletIntel({ event }) {
  const ca = event.token.address;
  const chain = event.token.chain || 'solana';
  const [state, setState] = useState({ status: 'idle' });

  // Reset when the selected token changes, otherwise the panel would show the
  // previous token's wallets under the new token's name.
  useEffect(() => { setState({ status: 'idle' }); }, [ca]);

  const load = async () => {
    setState({ status: 'loading' });
    const get = (url) => fetch(url).then(r => r.json()).catch(() => null);
    const [wallets, dev] = await Promise.all([
      get(`/api/token/${encodeURIComponent(chain)}/${ca}/wallets`),
      get(`/api/token/${encodeURIComponent(chain)}/${ca}/dev`),
    ]);
    setState({ status: 'done', wallets, dev });
  };

  const live = event.kols;
  const { wallets, dev } = state;

  return (
    <div className="in-card">
      <div className="in-card-title">
        Wallet intelligence
        {state.status !== 'loading' && (
          <button className="in-load-btn" onClick={load}>
            {state.status === 'idle' ? 'Analyse' : 'Refresh'}
          </button>
        )}
      </div>

      {/* Live watcher data needs no click -- it is already in the feed payload. */}
      {live ? (
        <div className="in-kv">
          <Kv label="KOLs seen trading" value={String(live.kol.count)} />
          <Kv label="Smart money seen" value={String(live.smart.count)} />
          <Kv label="Net flow (notable)" value={`$${live.kol.netUsd + live.smart.netUsd}`} />
        </div>
      ) : (
        <div className="in-note">No notable wallet traded this while the app was watching.</div>
      )}

      {state.status === 'loading' && <div className="in-note">Loading wallet data…</div>}

      {state.status === 'done' && (
        <>
          {dev && dev.available ? (
            <div className="in-kv" style={{ marginTop: 8 }}>
              <Kv label="Dev launched" value={`${dev.dev_tokens_created} tokens`} />
              <Kv label="Still alive" value={`${dev.dev_tokens_still_open}`} />
              <Kv label="Survival rate" value={dev.dev_survival_pct != null ? dev.dev_survival_pct + '%' : null}
                  warn={dev.dev_survival_pct != null && dev.dev_survival_pct < 5} />
              <Kv label="Dev's best ever" value={dev.dev_best_token_symbol
                ? `${dev.dev_best_token_symbol} · ${fmt(dev.dev_best_token_ath_mc)}` : null} />
            </div>
          ) : dev ? (
            <div className="in-note">Dev history: {dev.reason || 'unavailable'}</div>
          ) : null}

          {wallets && wallets.available ? (
            <>
              <div className="in-kv" style={{ marginTop: 8 }}>
                {/* Bundler / sniper / rat-trader removed 2026-08-03. All three
                    saturated the 50-wallet fetch page on nearly every token, so
                    the count described the page limit rather than the token. */}
                <Kv label="KOLs holding" value={String(wallets.kols.length)} />
                <Kv label="Smart money holding" value={String(wallets.smartMoney.length)} />
              </div>

              {wallets.kols.filter(k => k.handle).length > 0 && (
                <div className="in-kol-list">
                  {wallets.kols.filter(k => k.handle).slice(0, 8).map(k => (
                    <a key={k.wallet} className="in-kol" href={`https://x.com/${k.handle}`}
                       target="_blank" rel="noreferrer"
                       title={`${k.pctOfSupply != null ? k.pctOfSupply.toFixed(2) + '% of supply' : ''}`}>
                      @{k.handle}
                    </a>
                  ))}
                </div>
              )}
              <div className="in-src">{wallets.scope}</div>
            </>
          ) : wallets ? (
            <div className="in-note">Holder analysis: {wallets.reason || 'unavailable'}</div>
          ) : null}
        </>
      )}
    </div>
  );
}

function IconArrow() {
  return <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ display:'inline', verticalAlign:'middle', marginLeft:2 }}><path d="M2 10L10 2M10 2H4M10 2V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
