import { Logo } from './Logo';
import { MessageQuote } from './Feed';

export function NotificationPanel({ history, onClose, onSelect }) {
  return (
    <div className="notification-panel">
      <div className="notification-panel-head">
        <span className="notification-panel-title">Signal history</span>
        <button className="notification-panel-close" onClick={onClose}>&times;</button>
      </div>
      <div className="notification-panel-list">
        {history.length === 0 && (
          <div className="notification-empty">No signals yet. They appear here when a new CA is detected.</div>
        )}
        {history.map((ev, i) => (
          <div key={`${ev.id}-${i}`} className="notification-item" onClick={() => onSelect(ev)}>
            <div className="notification-item-top">
              <span className="notification-item-chain">{ev.chainLabel}</span>
              <span className="notification-item-name">{ev.name} <span style={{ color: '#6b7588', fontWeight: 600 }}>{ev.symbol}</span></span>
              {ev.image && <img src={ev.image} alt="" width="22" height="22" style={{ borderRadius: 6, objectFit: 'cover' }} />}
            </div>
            <div className="notification-item-ca">{ev.address}</div>
            <MessageQuote body={ev.message} address={ev.address} />
            <div className="notification-item-meta">
              {ev.metrics?.mcap && <span>MC<b>{ev.metrics.mcap}</b></span>}
              {ev.metrics?.vol && <span>VOL<b>{ev.metrics.vol}</b></span>}
              {ev.metrics?.chg && <span>24H<b>{ev.metrics.chg}</b></span>}
              <span style={{ marginLeft: 'auto' }}>{ev.source} · {ev.sender}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
