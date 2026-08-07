import { useEffect, useState } from 'react';
import './connect.css';

/* Brand marks, drawn inline so they render offline and can be tinted by
   connection state. Both are the official glyph shapes. */
function TelegramMark({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M21.94 4.6l-3.02 14.26c-.23 1.01-.83 1.26-1.68.78l-4.65-3.43-2.24 2.16c-.25.25-.46.46-.94.46l.33-4.74 8.63-7.8c.38-.33-.08-.52-.58-.19l-10.67 6.72-4.6-1.44c-1-.31-1.02-1 .21-1.48l17.99-6.93c.83-.31 1.56.19 1.22 1.63z"/>
    </svg>
  );
}

function DiscordMark({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M20.32 5.56A17.6 17.6 0 0016 4.23a12.3 12.3 0 00-.56 1.15 16.3 16.3 0 00-4.87 0A12.3 12.3 0 0010 4.23a17.6 17.6 0 00-4.33 1.33C2.9 9.66 2.15 13.66 2.52 17.6a17.7 17.7 0 005.36 2.71c.43-.59.81-1.22 1.14-1.88a11.5 11.5 0 01-1.8-.86c.15-.11.3-.23.44-.35a12.6 12.6 0 0010.68 0c.14.12.29.24.44.35-.57.34-1.18.63-1.8.87.33.65.71 1.28 1.14 1.87a17.6 17.6 0 005.36-2.71c.44-4.56-.75-8.53-3.16-12.04zM8.68 15.2c-1.05 0-1.92-.96-1.92-2.15s.84-2.16 1.92-2.16 1.94.97 1.92 2.16c0 1.19-.85 2.15-1.92 2.15zm6.64 0c-1.05 0-1.92-.96-1.92-2.15s.84-2.16 1.92-2.16 1.94.97 1.92 2.16c0 1.19-.84 2.15-1.92 2.15z"/>
    </svg>
  );
}

export function ConnectScreen({ onClose }) {
  const [status, setStatus] = useState({ telegram: { connected: false, session: false, chats: 0 }, discord: { connected: false, token: null, guilds: 0 }, lastFetch: null, error: null });
  const [phase, setPhase] = useState('idle');
  const [phone, setPhone] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [discordToken, setDiscordToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [dcMsg, setDcMsg] = useState(null);
  // GMGN was the one credential with no UI — it had to be hand-edited into
  // config.json inside %APPDATA%, a path the app never told you about.
  const [gmgnKey, setGmgnKey] = useState('');
  const [gmgnMsg, setGmgnMsg] = useState(null);
  const [outcome, setOutcome] = useState({ running: false, progress: null, msg: null });

  const saveGmgnKey = async () => {
    setBusy(true); setGmgnMsg(null);
    try {
      const r = await fetch('/api/gmgn/key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: gmgnKey.trim() }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'could not save the key');
      setGmgnKey('');
      setGmgnMsg(d.configured ? 'Key saved — GMGN enrichment is on.' : 'Key cleared.');
      loadStatus();
    } catch (e) { setGmgnMsg(e.message); }
    finally { setBusy(false); }
  };

  // Re-price every stored token so caller track records can be computed.
  // DexScreener only — keyless and free, so this costs no GMGN budget — and
  // explicitly user-triggered, never a timer.
  const refreshOutcomes = async () => {
    setOutcome(o => ({ ...o, msg: null }));
    try {
      const r = await fetch('/api/outcomes/refresh', { method: 'POST' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'could not start');
      setOutcome({ running: true, progress: { done: 0, total: d.tokens }, msg: null });
      const poll = setInterval(async () => {
        try {
          const s = await (await fetch('/api/outcomes/status')).json();
          if (s.running) setOutcome(o => ({ ...o, running: true, progress: s.progress }));
          else {
            clearInterval(poll);
            setOutcome({ running: false, progress: null, msg: 'Done — caller records updated.' });
          }
        } catch { clearInterval(poll); setOutcome(o => ({ ...o, running: false })); }
      }, 2000);
    } catch (e) { setOutcome({ running: false, progress: null, msg: e.message }); }
  };

  const loadStatus = async () => {
    try {
      const r = await fetch('/api/source/status');
      const d = r.ok ? await r.json() : {};
      setStatus(d);
      // Prefill credentials the backend already stored so a returning user
      // doesn't have to dig them out of my.telegram.org again.
      if (d.telegram?.apiId) setApiId(prev => prev || String(d.telegram.apiId));
      if (d.telegram?.phone) setPhone(prev => prev || d.telegram.phone);
      // Only jump to logged_in from an idle state. The 4s status poll used to
      // clobber an IN-PROGRESS login: you'd request a code, the poll would see
      // the (then socket-based) connected flag, and the code entry screen would
      // vanish before you could paste anything.
      if (d.telegram?.connected) {
        setPhase(p => (p === 'code_sent' || p === 'password_needed') ? p : 'logged_in');
      }
    } catch (e) {
      setStatus(s => ({ ...s, error: e.message }));
    }
  };

  useEffect(() => {
    loadStatus();
    const iv = setInterval(loadStatus, 4000);
    return () => clearInterval(iv);
  }, []);

  const sendCode = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/telegram/login/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, apiId, apiHash }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Failed to send code');
      setPhase('code_sent');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const confirmCode = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/telegram/login/code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Invalid code');
      if (d.step === 'password_needed') setPhase('password_needed');
      else { setPhase('logged_in'); loadStatus(); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const confirmPassword = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/telegram/login/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Wrong password');
      setPhase('logged_in'); loadStatus();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const saveDiscordToken = async () => {
    if (!discordToken.trim()) return;
    setBusy(true); setDcMsg(null); setErr(null);
    try {
      const r = await fetch('/api/discord/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: discordToken.trim() }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Failed to save token');
      setDcMsg('Token saved — connecting…');
      setDiscordToken('');
      loadStatus();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const disconnectDiscord = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/discord/logout', { method: 'POST' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Failed');
      loadStatus();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const tgConnected = status.telegram?.connected;
  const dcConnected = status.discord?.connected;
  const anyConnected = tgConnected || dcConnected;

  return (
    <div className="cs">
      <header className="cs-head">
        <div>
          <h2>Sources</h2>
          <p>Connect the chats you want watched. Status below is read live from the backend — nothing cached.</p>
        </div>
        <span className={`cs-overall ${anyConnected ? 'on' : ''}`}>
          <span className="cs-overall-dot" />
          {anyConnected ? 'Watching' : 'Nothing connected'}
        </span>
      </header>

      <div className="cs-grid">
        {/* ── TELEGRAM ─────────────────────────────────────────── */}
        <section className={`cs-card tg ${tgConnected ? 'on' : ''}`}>
          <div className="cs-card-head">
            <span className="cs-brand tg"><TelegramMark /></span>
            <div className="cs-card-title">
              <h3>Telegram</h3>
              <span className="cs-card-sub">Groups &amp; channels you're already in</span>
            </div>
            <span className={`cs-pill ${tgConnected ? 'ok' : ''}`}>
              <span className="cs-pill-dot" />
              {tgConnected ? 'Connected' : 'Offline'}
            </span>
          </div>

          <div className="cs-stats">
            <div className="cs-stat">
              <span className="cs-stat-v">{status.telegram?.chats ?? 0}</span>
              <span className="cs-stat-k">chats watched</span>
            </div>
            <div className="cs-stat">
              <span className="cs-stat-v">{status.telegram?.session ? 'Yes' : 'No'}</span>
              <span className="cs-stat-k">session saved</span>
            </div>
          </div>

          {tgConnected ? (
            <div className="cs-done">
              <IconCheck /> Listening for contract addresses
            </div>
          ) : (
            <div className="cs-form">
              {phase === 'idle' && (
                <>
                  {/* API credentials are REQUIRED by GramJS. The backend
                      falls back to config.telegram, but that is empty on a
                      fresh install -- so without these fields SendCode fired
                      with apiId: NaN and login always failed. */}
                  <label className="cs-label">API ID</label>
                  <input
                    className="cs-input"
                    placeholder="12345678"
                    value={apiId}
                    onChange={e => setApiId(e.target.value)}
                  />

                  <label className="cs-label">API hash</label>
                  <input
                    className="cs-input"
                    type="password"
                    placeholder="Your api_hash"
                    value={apiHash}
                    onChange={e => setApiHash(e.target.value)}
                  />

                  <a className="cs-link" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
                    Get these from my.telegram.org/apps
                  </a>

                  <label className="cs-label">Phone number</label>
                  <input
                    className="cs-input"
                    placeholder="+45 5272 3094"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && phone && apiId && apiHash && !busy && sendCode()}
                  />
                  <button className="cs-btn tg" disabled={busy || !phone || !apiId || !apiHash} onClick={sendCode}>
                    {busy ? 'Sending…' : 'Send login code'}
                  </button>
                  <p className="cs-note">Telegram sends a code to your app. Your session is stored locally and never leaves this machine.</p>
                </>
              )}
              {phase === 'code_sent' && (
                <>
                  <label className="cs-label">Login code</label>
                  <input
                    className="cs-input code"
                    placeholder="12345"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && code && !busy && confirmCode()}
                    autoFocus
                  />
                  <button className="cs-btn tg" disabled={busy || !code} onClick={confirmCode}>
                    {busy ? 'Confirming…' : 'Confirm code'}
                  </button>
                  <button className="cs-link" onClick={() => { setPhase('idle'); setCode(''); }}>Use a different number</button>
                </>
              )}
              {phase === 'password_needed' && (
                <>
                  <label className="cs-label">Two-factor password</label>
                  <input
                    className="cs-input"
                    type="password"
                    placeholder="Your 2FA password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && password && !busy && confirmPassword()}
                    autoFocus
                  />
                  <button className="cs-btn tg" disabled={busy || !password} onClick={confirmPassword}>
                    {busy ? 'Confirming…' : 'Confirm password'}
                  </button>
                </>
              )}
              {err && <div className="cs-err">{err}</div>}
            </div>
          )}
        </section>

        {/* ── DISCORD ──────────────────────────────────────────── */}
        <section className={`cs-card dc ${dcConnected ? 'on' : ''}`}>
          <div className="cs-card-head">
            <span className="cs-brand dc"><DiscordMark /></span>
            <div className="cs-card-title">
              <h3>Discord</h3>
              <span className="cs-card-sub">Servers you're a member of</span>
            </div>
            <span className={`cs-pill ${dcConnected ? 'ok' : ''}`}>
              <span className="cs-pill-dot" />
              {dcConnected ? 'Connected' : 'Offline'}
            </span>
          </div>

          <div className="cs-stats">
            <div className="cs-stat">
              <span className="cs-stat-v">{status.discord?.guilds ?? 0}</span>
              <span className="cs-stat-k">servers watched</span>
            </div>
            <div className="cs-stat">
              <span className="cs-stat-v">{status.discord?.token ? 'Yes' : 'No'}</span>
              <span className="cs-stat-k">token saved</span>
            </div>
          </div>

          {dcConnected ? (
            <div className="cs-form">
              <div className="cs-done"><IconCheck /> Listening for contract addresses</div>
              <button className="cs-link danger" onClick={disconnectDiscord} disabled={busy}>Disconnect</button>
            </div>
          ) : (
            <div className="cs-form">
              {/* The tutorial sits ON the label row, above the input, because
                  "how do I even get this?" is the question you have BEFORE you
                  paste -- not after. Opens in the real browser via the
                  window-open handler in main.cjs, which allows http(s) only. */}
              <div className="cs-label-row">
                <label className="cs-label">User token</label>
                <a
                  className="cs-tutorial"
                  href="https://www.youtube.com/watch?v=Qr_iR9oZy4c"
                  target="_blank"
                  rel="noreferrer"
                  title="How to find your Discord user token (opens YouTube)"
                >
                  <IconPlay /> Tutorial
                </a>
              </div>
              <input
                className="cs-input"
                type="password"
                placeholder="Paste your Discord token"
                value={discordToken}
                onChange={e => setDiscordToken(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && discordToken.trim() && !busy && saveDiscordToken()}
                disabled={busy}
              />
              <button className="cs-btn dc" disabled={busy || !discordToken.trim()} onClick={saveDiscordToken}>
                {busy ? 'Saving…' : 'Save & connect'}
              </button>
              {/* This is a real risk and the user should see it before pasting,
                  not discover it later. */}
              <p className="cs-note warn">
                <IconWarn /> A user token logs in as your account, which is against Discord's ToS. Stored locally only.
              </p>
              {dcMsg && <div className="cs-ok">{dcMsg}</div>}
            </div>
          )}
        </section>

        {/* GMGN — the only optional credential, and the one that decides
            whether EVM safety, artwork, holder counts and wallet composition
            exist at all. Worth stating what is lost without it rather than
            just offering an empty box. */}
        <section className="cs-card">
          <div className="cs-card-head">
            <div className="cs-card-title">GMGN <span className="cs-optional">optional</span></div>
            {status.gmgn?.configured
              ? <span className="cs-badge on">Key set</span>
              : <span className="cs-badge">Not set</span>}
          </div>
          <div className="cs-form">
            <label className="cs-label">API key</label>
            <input
              className="cs-input"
              type="password"
              placeholder={status.gmgn?.configured ? 'Replace the stored key' : 'Paste your GMGN API key'}
              value={gmgnKey}
              onChange={e => setGmgnKey(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && gmgnKey.trim() && !busy && saveGmgnKey()}
              disabled={busy}
            />
            <button className="cs-btn" disabled={busy || !gmgnKey.trim()} onClick={saveGmgnKey}>
              {busy ? 'Saving…' : 'Save key'}
            </button>
            <p className="cs-note">
              From gmgn.ai → settings → API. Without it the app still runs:
              DexScreener market data on every chain and RugCheck safety on
              Solana. You lose EVM safety checks, holder counts on EVM, some
              artwork, and KOL / smart-money holders.
            </p>
            {gmgnMsg && <div className="cs-ok">{gmgnMsg}</div>}
          </div>
        </section>

        {/* Caller track records need a CURRENT price for every token, and the
            app deliberately never re-reads prices on a timer. This is the
            explicit way to go and get them. */}
        <section className="cs-card">
          <div className="cs-card-head">
            <div className="cs-card-title">Caller track record</div>
          </div>
          <div className="cs-form">
            <p className="cs-note">
              Re-prices every stored token so each caller's median multiple can
              be measured. Uses DexScreener only — free, keyless, and no GMGN
              budget. A record is shown on a card only once enough of that
              person's calls have a real outcome.
            </p>
            <button className="cs-btn" disabled={outcome.running} onClick={refreshOutcomes}>
              {outcome.running
                ? `Pricing ${outcome.progress?.done ?? 0}/${outcome.progress?.total ?? '…'}…`
                : 'Update caller records'}
            </button>
            {outcome.msg && <div className="cs-ok">{outcome.msg}</div>}
          </div>
        </section>
      </div>

      <footer className="cs-foot">
        <button className="cs-btn ghost" onClick={() => loadStatus()} disabled={busy}>Refresh</button>
        {onClose && <button className="cs-btn solid" onClick={onClose}>Done</button>}
        {status.error && <div className="cs-err">{status.error}</div>}
      </footer>
    </div>
  );
}

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function IconWarn() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
      <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}
