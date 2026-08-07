const { app, BrowserWindow, Tray, Menu, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const { io } = require('socket.io-client');
const { showToast, updateToast } = require('./toast.cjs');

const BACKEND_PORT = 5050; // must match server/index.js's PORT

// Enforce exactly one running instance. If another copy is started, bring
// the existing window forward and exit this process before it can spawn
// windows, trays, backends, or recursive child processes.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return;
}

let mainWindow = null;
let tray = null;
let backend = null;
let willQuit = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// A file inside app.asar has no real path on disk, so it cannot be spawned.
// electron-builder's asarUnpack writes a genuine copy alongside the archive in
// app.asar.unpacked; this points at that copy. No-op in dev.
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function startBackend() {
  // PACKAGED runs the esbuild bundle (dist-server/server.cjs); DEV runs the
  // ESM source directly, so editing server/ still takes effect without a
  // rebuild. The bundle exists to stop `node_modules` being unpacked out of
  // the asar — thousands of loose files written on every launch, which is
  // where the ~60s cold start and the ~280 MB %TEMP% leak came from.
  const serverPath = isDev
    ? path.join(__dirname, '..', 'server', 'index.js')
    : unpacked(path.join(__dirname, '..', 'dist-server', 'server.cjs'));
  backend = spawn(process.execPath, [serverPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: isDev ? 'development' : 'production',
      // In a packaged app process.execPath is the ELECTRON binary, not node.
      // Without this flag, spawning it with a script path launches a second
      // copy of the app instead of running the server -- and that copy then
      // exits on requestSingleInstanceLock(), so the backend never came up
      // and the window had nothing to load. This path only runs when
      // packaged (dev starts the server via npm), so it was never exercised.
      ELECTRON_RUN_AS_NODE: '1',
      // Writable location for config.json and data/. When packaged, the
      // server lives inside app.asar, which is READ-ONLY -- so a Telegram
      // login could never be saved and the signal store could never persist.
      // Empty in dev, where the repo directory is writable and expected.
      INTEL_DATA_DIR: app.getPath('userData'),
    },
  });
  // Backend output was previously discarded entirely when packaged, so a
  // backend that failed to start left NO trace anywhere -- the window simply
  // showed nothing and there was no way to find out why. Everything now goes
  // to <userData>/backend.log in every build.
  backendLog('spawned pid=' + backend.pid + ' path=' + serverPath);
  backend.on('error', e => backendLog('SPAWN FAILED: ' + e.message));
  backend.on('exit', (code, sig) => backendLog(`exited code=${code} signal=${sig}`));
  backend.stdout.on('data', d => { const s = d.toString().trim(); backendLog(s); if (isDev) console.log('[server]', s); });
  backend.stderr.on('data', d => { const s = d.toString().trim(); backendLog('ERR ' + s); if (isDev) console.error('[server]', s); });
}

/** Append one line to <userData>/backend.log. Never throws -- diagnostics must
 *  not be able to take down the app they exist to diagnose. */
function backendLog(line) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'backend.log'),
      `${new Date().toISOString()} ${line}\n`
    );
  } catch (_) {}
}

function waitForBackend(timeoutMs = 20000) {
  const url = `http://127.0.0.1:${BACKEND_PORT}/api/logs?limit=1`;
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      http.get(url, { timeout: 1200 }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) { res.resume(); resolve(true); }
        else { res.resume(); retry(); }
      }).on('error', retry).on('timeout', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) { resolve(false); return; }
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

/**
 * Main-process diagnostics. ALWAYS written to <userData>/backend.log, in every
 * build — never conditional on isDev.
 *
 * This used to be `if (isDev) console[level](...)`, which is the exact mistake
 * this file already documents for the backend-spawn path: in a packaged build
 * the output went nowhere. The consequence showed up when a user reported
 * desktop alerts arriving for a chain they had muted — every decision this
 * process makes about whether to raise a toast was logged through here, so
 * there was no record of what it decided, or why, on the only build that
 * matters. A chain filter that "does not work" and one whose preference was
 * silently reset are indistinguishable without it.
 *
 * `console` still gets the line in dev, where a terminal is attached.
 */
function log(level, ...args) {
  if (isDev) console[level]?.(...args);
  try {
    backendLog(`[main:${level}] ` + args.map(a =>
      typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
    ).join(' '));
  } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#08090d',
    title: 'intel. Command Deck',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    show: false,
    autoHideMenuBar: true,
  });

  const url = isDev ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${BACKEND_PORT}`;

  // If the renderer fails to reach the local backend (common on first packaged
  // launch while Node is still binding the port), retry instead of leaving a
  // permanent blank screen.
  let loadRetries = 0;
  const maxRetries = 8;
  const doLoad = () => { mainWindow.loadURL(url).catch(err => log('error', '[main] loadURL error:', err.message)); };
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log('warn', '[main] did-fail-load', errorCode, errorDescription);
    if (loadRetries < maxRetries && !isDev) { loadRetries++; setTimeout(doLoad, 600); }
  });

  doLoad();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('close', (e) => {
    if (!willQuit) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showFallbackNotification(title, body) {
  if (!title) return;
  log('info', '[notify fallback]', title, body);
}

/**
 * One place that maps a backend hit to the toast's shape, used by both the
 * initial alert and later in-place updates. Two copies of this mapping would
 * drift, and the update path would silently stop carrying new fields.
 */
function toastPayload(hit) {
  return {
    ca: hit.ca,
    token_name: hit.token_name,
    token_symbol: hit.token_symbol,
    chain: hit.chain || 'solana',
    dex: hit.dex || hit.launchpad,
    launchpad: hit.launchpad,
    source: hit.source,
    chat_name: hit.chat_name,
    author: hit.author,
    time: hit.first_seen_at ? new Date(hit.first_seen_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now',
    message_text: hit.message_text,
    mention_count: Array.isArray(hit.mentions) ? hit.mentions.length : 1,
    first_chat_name: Array.isArray(hit.mentions) && hit.mentions[0] ? hit.mentions[0].chat_name : null,
    first_author: Array.isArray(hit.mentions) && hit.mentions[0] ? hit.mentions[0].author : null,
    image_url: hit.image_url,
    header_url: hit.header_url,
    holder_count: hit.holder_count,
    top10_holder_pct: hit.top10_holder_pct,
    rug_risk_pct: hit.rug_risk_pct,
    volume_24h_usd: hit.volume_24h_usd,
    mcap_usd: hit.mcap_usd,
    liquidity_usd: hit.liquidity_usd,
    price_change_24h: hit.price_change_24h,
    dex_paid: hit.dex_paid,
    // HOLDER counts ONLY -- who is in this token right now.
    //
    // These used to fall back to `kol_count` / `smart_wallet_count`, which come
    // from the rolling TRADE watcher and measure something else entirely: how
    // many notable wallets were seen trading it in a six-hour window while the
    // app happened to be running. The holder lookup lands a few seconds AFTER
    // the alert fires, so at toast time the holder figure is still null and the
    // fallback always won -- every alert showed the trade number under a label
    // the card uses for the holder number.
    //
    // Observed: a Solana call alerted "Smart 1" while the card for the same
    // token, seconds later, correctly read "17 holding". Two different
    // measurements, one label, and the smaller one always shown first.
    //
    // `null` now means "not checked yet" and the toast renders nothing for it,
    // then fills in over `ca_update` when the holder lookup lands. An absent
    // row is honest; a substituted number is not.
    kol_count: hit.kol_holder_count ?? null,
    smart_wallet_count: hit.smart_holder_count ?? null,
    // The identities behind those counts. "KOL 3" is not actionable; three
    // handles are — same reasoning as the feed card, which lists them.
    kol_holders: Array.isArray(hit.kol_holders) ? hit.kol_holders : null,
    smart_holders: Array.isArray(hit.smart_holders) ? hit.smart_holders : null,
    pair_url: hit.pair_url,
    // Why this alert fired -- 'new' | 'watchlist-mention' | 'watchlist-refresh'.
    // Drives the pill so a re-alert on a starred token is never mistaken for a
    // fresh call.
    //
    // NULL when absent, never defaulted here. This same function builds the
    // payload for `ca_update`, and `updateToast` merges any non-null value --
    // so defaulting to 'new' meant the first enrichment update (~200 ms later)
    // silently overwrote 'watchlist-refresh' and the pill reverted to a plain
    // repeat-call label. The default belongs in `showToast`'s normalize, which
    // only runs when the toast is created.
    alert_kind: hit._alert_kind || null,
    watched: !!hit.watched,
  };
}

/**
 * The caller's track record, for the toast.
 *
 * On an alert the first question is not "what are this token's metrics" but
 * "who is calling it, and are they any good". The feed card has answered that
 * since caller scoring landed; the toast never did, so the one surface you read
 * under time pressure was the one missing the judgement.
 *
 * `/api/callers` recomputes over the whole store, so it is cached briefly --
 * a burst of calls in the same minute should cost one pass, not one each.
 */
let _callerCache = { at: 0, byAuthor: null };
async function callerRecord(author) {
  if (!author) return null;
  try {
    if (!_callerCache.byAuthor || Date.now() - _callerCache.at > 60000) {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/callers`);
      const json = await res.json();
      const map = new Map();
      for (const c of json.callers || []) map.set((c.author || '').toLowerCase(), c);
      _callerCache = { at: Date.now(), byAuthor: map };
    }
    const rec = _callerCache.byAuthor.get(String(author).trim().toLowerCase());
    // A median over one or two scored calls is not a record. Below that floor
    // the honest answer is nothing, not a confident-looking number.
    if (!rec || !rec.scored || rec.scored < 3 || rec.medianMult == null) return null;
    return { medianMult: rec.medianMult, winRate: rec.winRate, scored: rec.scored, calls: rec.calls };
  } catch (_) {
    return null;   // never let the record lookup take the alert down
  }
}

function notifySignal(hit) {
  // Rich borderless toast as primary notification.
  try {
    showToast(toastPayload(hit));
    // Fetched after the toast is up, then merged in like any other late
    // enrichment -- the alert must not wait on it.
    callerRecord(hit.author).then(rec => {
      if (rec) updateToast({ ca: hit.ca, caller_record: rec });
    });
  } catch (err) {
    log('warn', '[notify] rich toast failed, falling back', err.message);
    const ca = hit.ca || '';
    const symbol = hit.token_symbol || 'TOKEN';
    showFallbackNotification(`${hit.token_name || symbol} · $${symbol}`, `${hit.chain || 'solana'} · ${hit.launchpad || hit.dex || 'DEX'}
CA: ${ca.slice(0, 12)}…${ca.slice(-6)}`);
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('intel. Command Deck');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { willQuit = true; if (backend) backend.kill(); app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show());
}

app.whenReady().then(async () => {
  // Every http(s) link in ANY window opens in the user's real default browser.
  // Without this, clicking Quick Buy loaded GMGN *inside* the Electron app --
  // no address bar, no extensions, and critically no access to the user's
  // existing wallet session. A trading link is useless in a sandboxed webview.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const current = contents.getURL();
      // Allow in-app navigation only for the app's own dev/prod origin.
      const internal = url.startsWith('http://127.0.0.1:') || url.startsWith('file://');
      if (!internal && /^https?:\/\//i.test(url)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  });
  backendLog(`--- app start --- packaged=${app.isPackaged} isDev=${isDev} execPath=${process.execPath}`);
  if (!isDev) startBackend();
  const backendReady = await waitForBackend();
  backendLog('backend reachable after wait: ' + backendReady);
  if (!backendReady) console.warn('[main] backend did not respond in time; window will retry on did-fail-load');
  createWindow();
  createTray();

  // No startup/demo notification. A toast from intel. must always mean a
  // real CA was detected in a monitored chat -- otherwise the alert stops
  // meaning anything and you learn to ignore it.
});

app.on('window-all-closed', () => { });

app.on('second-instance', (event, argv, workingDirectory, additionalData) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Real Socket.IO connection to the actual backend -- 'ca' is what
// server/index.js genuinely emits on every new hit. The previous raw
// WebSocket to a '/ws' path and a 'notify' message type never matched
// anything this backend actually sends.
// A locally cached copy of the backend's alert-chain preference, refreshed on
// connect. This is a SECOND, independent check rather than trusting `_notify`
// alone: that flag is transient and computed per emit, so any path that ever
// emits a 'ca' without it would alert on everything. Belt and braces on a
// setting whose failure mode is "the user is spammed about a chain they
// explicitly switched off", which they then have to notice and re-report.
let notifyChains = null;              // null = no preference = allow all
async function refreshNotifyChains() {
  try {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/notify-prefs`);
    const data = await res.json();
    notifyChains = Array.isArray(data?.chains)
      ? new Set(data.chains.map(c => String(c).toLowerCase()))
      : null;
    log('info', '[notify-socket] alert chains:', notifyChains ? [...notifyChains].join(',') : 'all');
  } catch (e) {
    // Keep whatever we had; do not widen the filter because of a failed fetch.
    log('warn', '[notify-socket] could not read alert chains:', e.message);
  }
}

function chainAllowed(hit) {
  // An explicit flag from the backend always wins -- it saw the live config.
  if (hit && typeof hit._notify === 'boolean') return hit._notify;
  // No flag: decide from the cached preference rather than defaulting to yes.
  if (!notifyChains) return true;
  return notifyChains.has(String(hit?.chain || '').toLowerCase());
}

let notifySocket = null;
function connectNotifySocket() {
  notifySocket = io(`http://127.0.0.1:${BACKEND_PORT}`, { path: '/socket.io', reconnection: true, reconnectionDelay: 3000 });
  notifySocket.on('connect', () => {
    log('info', '[notify-socket] connected to backend, ready for live "ca" events');
    refreshNotifyChains();
  });
  notifySocket.on('ca', (hit) => {
    // Respect the chain filter. Without this the toast layer alerted on every
    // chain regardless of what was switched off in the UI.
    // Both outcomes are logged, not just the suppression. "No toast appeared"
    // and "no signal arrived" look identical from the outside, and telling
    // them apart is the whole question when someone reports the filter not
    // working.
    if (!chainAllowed(hit)) {
      log('info', `[notify] SUPPRESSED ${hit?.token_symbol || hit?.ca} (${hit?.chain}) —`,
        `_notify=${hit?._notify}`, `allowed=${notifyChains ? [...notifyChains].join('|') : 'all'}`);
      return;
    }
    // The KIND is logged, not just the fact. "A toast fired" and "a toast fired
    // because a watchlist token was re-scanned" are different events, and
    // telling them apart from the outside is otherwise guesswork.
    log('info', `[notify] RAISED ${hit?.token_symbol || hit?.ca} (${hit?.chain}) kind=${hit?._alert_kind || 'new'}`);
    notifySignal(hit);
  });
  // Pushed whenever the user toggles a chain, so the cache above never serves
  // a stale preference.
  notifySocket.on('notify_prefs', (d) => {
    notifyChains = Array.isArray(d?.chains)
      ? new Set(d.chains.map(c => String(c).toLowerCase()))
      : null;
    log('info', '[notify-socket] alert chains updated:', notifyChains ? [...notifyChains].join(',') || 'none' : 'all');
  });
  // Enrichment lands seconds after the alert fires. Rather than delay the
  // alert, an open toast for that token is topped up in place -- holders, KOL
  // and smart-money counts, and the DEX-paid result all arrive this way.
  notifySocket.on('ca_update', (hit) => updateToast(toastPayload(hit)));
  notifySocket.on('connect_error', (e) => log('warn', '[notify-socket] connect error:', e.message));
}
app.whenReady().then(() => setTimeout(connectNotifySocket, 1500));

app.on('before-quit', () => { willQuit = true; if (backend) { backend.kill(); } });

module.exports = { showFallbackNotification };
