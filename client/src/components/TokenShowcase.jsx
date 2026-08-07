import { useEffect, useMemo, useState } from 'react';

const SHOWCASE_ADDRESSES = [
  { id: 'cashcat', address: '0x020bfc650a365f8bb26819deaabf3e21291018b4', chain: 'robinhood' },
  { id: 'marketcat', address: 'G8ModkdDYTuUWLTVR4FAV8orFyZKXccZPhtUvvLBpump', chain: 'solana' },
  { id: 'catecoin', address: 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump', chain: 'solana' },
  { id: 'pons', address: '0x39dbed3a2bd333467115de45665cc57f813c4571', chain: 'robinhood' },
];

function chainColor(chain) {
  switch ((chain || '').toLowerCase()) {
    case 'solana': return '#9945FF';
    case 'robinhood': return '#00C805';
    case 'base': return '#0052FF';
    case 'ethereum': return '#627EEA';
    case 'bsc': return '#F0B90B';
    default: return '#4fe3a0';
  }
}

function fmtN(n) {
  if (n == null || Number.isNaN(n)) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function formatAge(ms) {
  if (!ms) return null;
  const d = Math.max(0, Date.now() - ms);
  const days = Math.floor(d / 86400000);
  const hrs = Math.floor((d % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hrs}h`;
  return `${hrs}h`;
}

function aggregatePairs(pairs) {
  if (!pairs?.length) return {};
  // Pick the pair with the highest USD liquidity as the canonical data source.
  const best = pairs.reduce((a, b) => (a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b);
  const totalVol = pairs.reduce((sum, p) => sum + (p.volume?.h24 || 0), 0);
  const totalLiq = pairs.reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0);
  const totalBuys = pairs.reduce((sum, p) => sum + (p.txns?.h24?.buys || 0), 0);
  const totalSells = pairs.reduce((sum, p) => sum + (p.txns?.h24?.sells || 0), 0);
  return {
    name: best.baseToken?.name,
    symbol: best.baseToken?.symbol,
    image: best.info?.imageUrl,
    banner: best.info?.header,
    priceUsd: Number(best.priceUsd),
    mcap: best.marketCap,
    fdv: best.fdv,
    liq: totalLiq,
    vol24: totalVol,
    buys: totalBuys,
    sells: totalSells,
    changeM5: best.priceChange?.m5,
    changeH1: best.priceChange?.h1,
    changeH6: best.priceChange?.h6,
    changeH24: best.priceChange?.h24,
    dex: best.dexId,
    pairAddress: best.pairAddress,
    pairCreatedAt: best.pairCreatedAt,
    url: best.url,
    website: best.info?.websites?.[0]?.url,
    x: best.info?.socials?.find(s => s.type === 'twitter')?.url,
    tg: best.info?.socials?.find(s => s.type === 'telegram')?.url,
  };
}

export function TokenShowcase({ onPick }) {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    (async () => {
      const next = {};
      for (const item of SHOWCASE_ADDRESSES) {
        try {
          const url = item.chain === 'solana'
            ? `https://api.dexscreener.com/latest/dex/tokens/${item.address}`
            : `https://api.dexscreener.com/latest/dex/search/?q=${item.address}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(res.statusText);
          const json = await res.json();
          const pairs = (json.pairs || []).filter(p =>
            p.baseToken?.address?.toLowerCase() === item.address.toLowerCase()
          );
          next[item.id] = aggregatePairs(pairs.length ? pairs : json.pairs || []);
        } catch (e) {
          next[item.id] = { error: true };
        }
        await new Promise(r => setTimeout(r, 250));
      }
      if (mounted) { setData(next); setLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);

  const items = useMemo(() => SHOWCASE_ADDRESSES.map(cfg => ({
    ...cfg,
    ...data[cfg.id],
  })), [data]);

  return (
    <div className="showcase">
      <div className="showcase-head">
        <div className="showcase-title">
          <span className="live-pulse" />
          Live token showcase
          <span className="showcase-sub">Real data from DexScreener · no placeholders</span>
        </div>
        <div className="showcase-actions">
          <button className="btn btn-ghost" onClick={() => window.location.reload()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {loading && items.every(i => !i.symbol) && (
        <div className="showcase-loading">
          <div className="boot-spinner" />
          <span>Reading live token data…</span>
        </div>
      )}

      <div className="showcase-grid">
        {items.map(token => (
          <TokenCard key={token.id} token={token} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function TokenCard({ token, onPick }) {
  const accent = chainColor(token.chain);
  const pct = token.changeH24;
  const isUp = pct != null && pct >= 0;
  const age = formatAge(token.pairCreatedAt);

  return (
    <div className="showcase-card" style={{ '--chain-color': accent }}>
      <div className="showcase-card-banner" style={{ backgroundImage: token.banner ? `url(${token.banner})` : 'none' }}>
        <div className="showcase-card-banner-overlay" />
        <div className="showcase-card-top">
          <div className="showcase-chain" style={{ borderColor: accent, color: accent }}>
            <span className="chain-dot" style={{ background: accent }} />
            {token.chain}
          </div>
          {token.image ? (
            <img className="showcase-logo" src={token.image} alt={token.symbol} />
          ) : (
            <div className="showcase-logo-fallback">{(token.symbol || '?')[0]}</div>
          )}
        </div>
        <div className="showcase-card-banner-text">
          <div className="showcase-name">{token.name || 'Unknown token'}</div>
          <div className="showcase-symbol">{token.symbol || token.address.slice(0, 8)}</div>
        </div>
      </div>

      <div className="showcase-body">
        <div className="showcase-price-row">
          <div className="showcase-price">
            {token.priceUsd != null ? `$${fmtN(token.priceUsd)}` : <span className="dim">No price</span>}
            {pct != null && (
              <span className={`showcase-change ${isUp ? 'up' : 'down'}`}>
                {isUp ? '▲' : '▼'} {fmtPct(pct)}
              </span>
            )}
          </div>
        </div>

        <div className="showcase-metrics">
          {token.mcap != null && <Metric label="Market cap" value={`$${fmtN(token.mcap)}`} />}
          {token.fdv != null && token.fdv !== token.mcap && <Metric label="FDV" value={`$${fmtN(token.fdv)}`} />}
          {token.liq != null && <Metric label="Liquidity" value={`$${fmtN(token.liq)}`} />}
          {token.vol24 != null && <Metric label="Volume 24h" value={`$${fmtN(token.vol24)}`} />}
          {token.buys != null && token.sells != null && (
            <Metric
              label="Buy / Sell 24h"
              value={`${fmtN(token.buys)} / ${fmtN(token.sells)}`}
              sub={`net ${fmtN(token.buys - token.sells)}`}
            />
          )}
          {token.changeH1 != null && <Metric label="1h change" value={fmtPct(token.changeH1)} accent={token.changeH1 >= 0} />}
          {token.changeH6 != null && <Metric label="6h change" value={fmtPct(token.changeH6)} accent={token.changeH6 >= 0} />}
          {age && <Metric label="Pair age" value={age} />}
          {token.dex && <Metric label="Top DEX" value={token.dex} />}
        </div>

        <div className="showcase-ca" onClick={() => navigator.clipboard?.writeText(token.address)} title="Click to copy">
          <span className="showcase-ca-text">{token.address}</span>
          <span className="showcase-ca-copy">Copy</span>
        </div>

        <div className="showcase-links">
          {token.url && (
            <a className="showcase-link primary" href={token.url} target="_blank" rel="noreferrer">DexScreener</a>
          )}
          {token.x && (
            <a className="showcase-link" href={token.x} target="_blank" rel="noreferrer">X / Twitter</a>
          )}
          {token.tg && (
            <a className="showcase-link" href={token.tg} target="_blank" rel="noreferrer">Telegram</a>
          )}
          {token.website && (
            <a className="showcase-link" href={token.website} target="_blank" rel="noreferrer">Website</a>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent }) {
  const cls = accent === true ? 'up' : accent === false ? 'down' : '';
  return (
    <div className="showcase-metric">
      <div className="showcase-metric-label">{label}</div>
      <div className={`showcase-metric-value ${cls}`}>{value}</div>
      {sub && <div className="showcase-metric-sub">{sub}</div>}
    </div>
  );
}
