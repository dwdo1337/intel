import { Logo } from './Logo';
import { gmgnUrl } from '../lib/gmgn';

function fmtUsd(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v.toString().replace(/[^0-9.]/g, ''));
  if (Number.isNaN(n)) return v;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

function chainBadgeColor(chain) {
  const c = (chain || '').toLowerCase();
  if (c === 'solana' || c === 'sol') return '#9945FF';
  if (c === 'robinhood') return '#00C805';
  if (c === 'base') return '#0052FF';
  if (c === 'bsc') return '#F0B90B';
  if (c === 'ethereum' || c === 'eth') return '#627EEA';
  if (c === 'stable') return '#2fd6c8';
  if (c === 'arc') return '#8a8a8a';
  return '#4fe3a0';
}

function sourceBadge(t) {
  const s = (t.source || '').toLowerCase();
  if (s === 'telegram' || s === 'tg') return { label: 'Telegram', color: '#3b82f6' };
  if (s === 'discord' || s === 'dc') return { label: 'Discord', color: '#a855f7' };
  return { label: 'intel.', color: '#4fe3a0' };
}

function shortCa(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '…' + addr.slice(-6);
}

export function Toasts({ toasts, onClose }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <div className="toast-head">
            <Logo size={16} />
            <span className="toast-app">intel. · new signal</span>
            <button className="toast-close" onClick={() => onClose(t.id)} aria-label="Close">×</button>
          </div>

          <div className="toast-main">
            <div className="toast-media">
              {t.image ? <img src={t.image} alt="" /> : <div className="toast-media-fallback">{t.symbol?.[0] || '?'}</div>}
            </div>
            <div className="toast-info">
              <div className="toast-title-row">
                <span className="toast-name">{t.name || 'Unknown'}</span>
                <span className="toast-symbol">${t.symbol || '—'}</span>
              </div>
              <div className="toast-badges">
                <span className="toast-badge chain" style={{ background: chainBadgeColor(t.chain) + '22', color: chainBadgeColor(t.chain), borderColor: chainBadgeColor(t.chain) + '55' }}>{t.chainLabel || t.chain || 'Solana'}</span>
                {t.launchpad && t.launchpad !== 'unknown' && <span className="toast-badge lp">{t.launchpad}</span>}
                {(() => { const src = sourceBadge(t); return <span className="toast-badge src" style={{ background: src.color + '22', color: src.color }}>{src.label}</span>; })()}
              </div>
              <div className="toast-sender">
                {t.sender && t.sender !== 'unknown' && <span>@{t.sender}</span>}
                {t.chat && <span> · {t.chat}</span>}
              </div>
            </div>
          </div>

          {t.metrics && (t.metrics.mcap || t.metrics.liq || t.metrics.vol || t.metrics.chg) && (
            <div className="toast-metrics">
              {t.metrics.mcap && <div className="toast-metric"><span className="toast-m-label">MC</span><span className="toast-m-value">${fmtUsd(t.metrics.mcap)}</span></div>}
              {t.metrics.liq && <div className="toast-metric"><span className="toast-m-label">LIQ</span><span className="toast-m-value">${fmtUsd(t.metrics.liq)}</span></div>}
              {t.metrics.vol && <div className="toast-metric"><span className="toast-m-label">VOL</span><span className="toast-m-value">${fmtUsd(t.metrics.vol)}</span></div>}
              {t.metrics.chg && <div className="toast-metric"><span className="toast-m-label">24H</span><span className="toast-m-value" style={{ color: String(t.metrics.chg).startsWith('+') ? 'var(--buy)' : 'var(--sell)' }}>{t.metrics.chg}</span></div>}
            </div>
          )}

          {t.address && (
            <div className="toast-ca-row">
              <span className="toast-ca-text">{shortCa(t.address)}</span>
              <button className="toast-btn ghost" onClick={() => navigator.clipboard.writeText(t.address)}>Copy CA</button>
            </div>
          )}

          <div className="toast-actions">
            {t.address && <a className="toast-btn primary"
              href={gmgnUrl(t.chain, t.address) || `https://dexscreener.com/${t.chain}/${t.address}`}
              target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
              {gmgnUrl(t.chain, t.address) ? 'Quick buy' : 'Open pair'}</a>}
            {t.address && <a className="toast-btn ghost" href={`https://dexscreener.com/${t.chain}/${t.address}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>DexScreener</a>}
          </div>
        </div>
      ))}
    </div>
  );
}
