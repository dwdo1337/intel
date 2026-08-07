const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// NOTE: `screen` is deliberately NOT destructured from require('electron')
// at module scope. Reading the `screen` property invokes Electron's internal
// createScreenIfNeeded() getter, which throws:
//   "The 'screen' module can't be used before the app 'ready' event"
// main.cjs requires this file at the top of the module (before
// app.whenReady()), so any module-level access to `screen` crashes every
// packaged launch. Always reach it lazily via getScreen() inside a function
// that can only run after the app is ready.
function getScreen() {
  return require('electron').screen;
}

const TOAST_WIDTH = 460;
// Sized for the tallest realistic toast: banner + identity + metrics +
// re-call strip + message + CA row + actions. At 340 the CA row and buttons
// were being clipped off the bottom edge.
// Starting height. The window is resized to its measured content once the
// renderer reports it (see resizeToast) -- this is only the opening size and
// the fallback when a measurement never arrives.
const TOAST_HEIGHT = 430;
const MIN_TOAST_HEIGHT = 260;
const MAX_TOAST_HEIGHT = 640;
const MARGIN_X = 18;
const MARGIN_Y = 18;
const GAP_Y = 14;
const DISPLAY_MS = 14000;
const MAX_VISIBLE = 4;

const toastQueue = [];
let activeToasts = [];
let nextY = null;
let displayListenerBound = false;

function bindDisplayListener() {
  if (displayListenerBound) return;
  displayListenerBound = true;
  try {
    getScreen().on('display-metrics-changed', () => repositionStack());
  } catch (_) {
    // Non-fatal: without this the stack just won't reflow on monitor changes.
  }
}

function calcMaxVisible() {
  const primary = getScreen().getPrimaryDisplay();
  const available = primary.workAreaSize.height - 2 * MARGIN_Y;
  return Math.max(1, Math.min(MAX_VISIBLE, Math.floor(available / (TOAST_HEIGHT + GAP_Y))));
}

function createToastWindow(data) {
  const primary = getScreen().getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;

  // Stack new toasts above previous ones from bottom-right.
  if (nextY == null) nextY = height - MARGIN_Y - TOAST_HEIGHT;
  else nextY -= TOAST_HEIGHT + GAP_Y;
  const x = width - MARGIN_X - TOAST_WIDTH;
  const y = Math.max(MARGIN_Y, nextY);

  const win = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: true,
    webPreferences: {
      // MUST stay true. `toast-preload.cjs` publishes the IPC bridge with
      // `contextBridge.exposeInMainWorld`, and contextBridge only works when
      // contextIsolation is ENABLED -- with it off, the call is a no-op and
      // `window.electronAPI` is never defined.
      //
      // That was the state of this file for a long time, and because the
      // renderer falls back to a stub of empty functions when the bridge is
      // missing, nothing ever errored: the toast rendered its opening snapshot
      // from the URL hash and then silently ignored EVERY update. "DEX Paid ·
      // checking…" that never resolved, artwork that resolved late and never
      // appeared, holder and KOL counts that never filled in -- all one bug.
      //
      // The renderer is pure DOM and uses no Node API, so nodeIntegration is
      // off too; it was only ever needed by the disabled-isolation setup.
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'toast-preload.cjs'),
    },
  });

  win.setIgnoreMouseEvents(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const file = `file://${path.join(__dirname, 'toast.html').replace(/\\/g, '/')}`;
  win.loadURL(file + '#' + encodeURIComponent(JSON.stringify(data)));

  win.webContents.once('dom-ready', () => {
    // Send the LIVE entry, not the `data` this function was called with.
    //
    // Enrichment lands fast -- measured 50-460 ms after the alert fires for the
    // DEX-paid check -- while `dom-ready` takes a few hundred ms. So the usual
    // order is: toast opens, updateToast() merges the real values into the
    // entry and calls send(), the renderer is NOT listening yet and that IPC
    // message is silently dropped, and then this handler overwrites everything
    // with the stale snapshot from alert time. dex_paid stuck on "checking…"
    // forever, and any artwork resolved after the alert never appeared, even
    // though the backend had both within half a second.
    //
    // There is no error anywhere in that sequence, which is why it survived:
    // both sends "succeed", they just race.
    const entry = activeToasts.find(t => t.win === win);
    win.webContents.send('toast-data', entry ? entry.data : data);
    win.ready = true;
    win.show();
    win.setOpacity(0);
    let op = 0;
    const fade = setInterval(() => {
      op += 0.12;
      if (op >= 1) { win.setOpacity(1); clearInterval(fade); }
      else win.setOpacity(op);
    }, 18);
  });

  // Auto close after DISPLAY_MS unless user is hovering (handled in renderer).
  let closeTimer = setTimeout(() => closeToast(win), DISPLAY_MS);

  function remove() {
    clearTimeout(closeTimer);
    activeToasts = activeToasts.filter(t => t.win !== win);
    repositionStack();
    processQueue();
    if (activeToasts.length === 0) nextY = null;
  }

  win.on('closed', remove);

  win.toastRemove = remove;
  activeToasts.push({ win, data });
  return win;
}

function closeToast(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('toast-action', { action: 'close-animate' });
  setTimeout(() => {
    if (!win.isDestroyed()) {
      try {
        win.setOpacity(0);
        win.close();
      } catch (_) {}
    }
  }, 260);
}

/** A toast's real height: what its content measured, else the default. */
function toastHeight(win) {
  return (win && win.contentHeight) || TOAST_HEIGHT;
}

function repositionStack() {
  let height;
  try { height = getScreen().getPrimaryDisplay().workAreaSize.height; }
  catch (_) { return; }
  // Walk from the bottom up using EACH toast's own height. Using the constant
  // for every toast made a stack overlap as soon as one of them grew.
  let y = height - MARGIN_Y;
  for (const { win } of activeToasts) {
    if (win.isDestroyed()) continue;
    y -= toastHeight(win);
    try { win.setPosition(win.getPosition()[0], Math.max(MARGIN_Y, y)); } catch (_) {}
    y -= GAP_Y;
  }
  nextY = activeToasts.length ? y + GAP_Y : null;
}

/**
 * Grow (or shrink) a toast to fit what it is actually showing.
 *
 * The window was a hard 430px with `overflow:hidden`, but the content is not
 * fixed: KOL and smart-money handles land a second after the alert opens and
 * wrap to a second line, and the caller's message varies. Anything past 430px
 * was simply cut off -- on a token with five KOL handles that meant the Quick
 * buy and DexScreener buttons were invisible, on the surface whose entire job
 * is to be actioned in a few seconds.
 *
 * Clamped: never smaller than the layout needs, never taller than a sane slice
 * of the screen.
 */
function resizeToast(win, contentHeight) {
  if (!win || win.isDestroyed()) return;
  const h = Math.max(MIN_TOAST_HEIGHT, Math.min(MAX_TOAST_HEIGHT, Math.ceil(contentHeight)));
  if (win.contentHeight === h) return;         // no-op keeps this off the render loop
  win.contentHeight = h;
  try {
    const [x, y] = win.getPosition();
    // Grow UPWARD: the bottom edge is the anchor, so the buttons do not slide
    // out from under the cursor as late enrichment lands.
    const [, oldH] = win.getSize();
    win.setBounds({ x, y: y + (oldH - h), width: TOAST_WIDTH, height: h });
  } catch (_) {}
  repositionStack();
}

/**
 * Push fresher data into a toast that is already on screen.
 *
 * A toast fires the instant a CA is detected, but the things a trader most
 * wants on it -- who holds the token, whether the DexScreener profile is paid
 * -- take a few more seconds to fetch. Delaying the alert to wait for them
 * would defeat the point of an alert. So the toast opens immediately with what
 * is known and fills in as the enrichment lands, while it is still on screen
 * (14 seconds, which is comfortably longer than the lookups take).
 *
 * Silently does nothing when no toast for that CA is open, which is the normal
 * case for the vast majority of ca_update events.
 */
function updateToast(data) {
  if (!data || !data.ca) return;
  if (process.env.INTEL_TOAST_DEBUG) {
    console.log('[toast-dbg] updateToast ca=%s open=%s keys=%s',
      data.ca, activeToasts.map(t => t && t.data && t.data.ca).join(','),
      Object.keys(data).filter(k => data[k] != null).join(','));
  }
  for (const entry of activeToasts) {
    if (!entry || !entry.data || entry.data.ca !== data.ca) continue;
    if (!entry.win || entry.win.isDestroyed()) continue;
    // Mutate in place rather than rebuilding the object. `showToast` captured
    // this exact reference, so replacing it here would leave the dom-ready
    // handler holding the pre-enrichment copy.
    //
    // Only overwrite with values that actually arrived. A spread would let a
    // provider blip null out a field the toast has already shown -- the same
    // "a failed lookup wipes a good count" bug fixed on the feed card.
    for (const [k, v] of Object.entries(data)) {
      if (v != null) entry.data[k] = v;
    }
    // Before dom-ready the renderer has no listener and send() is a silent
    // no-op; the merge above is what survives, and dom-ready flushes it.
    if (process.env.INTEL_TOAST_DEBUG) {
      console.log('[toast-dbg] MATCH ready=%s dex_paid=%s holders=%s',
        entry.win.ready, entry.data.dex_paid, entry.data.holder_count);
    }
    if (!entry.win.ready) continue;
    try { entry.win.webContents.send('toast-data', entry.data); } catch (_) {}
  }
}

function showToast(data) {
  bindDisplayListener();
  // Normalize fields from backend snake_case shape.
  const normalized = {
    ca: data.ca || '',
    token_name: data.token_name || '',
    token_symbol: data.token_symbol || '',
    chain: data.chain || 'solana',
    dex: data.dex || data.launchpad || 'DEX',
    launchpad: data.launchpad || null,
    source: data.source || 'intel.',
    chat_name: data.chat_name || 'alpha chat',
    author: data.author || 'collector',
    time: data.time || 'now',
    message_text: data.message_text || '',
    mention_count: data.mention_count || 1,
    first_chat_name: data.first_chat_name || null,
    first_author: data.first_author || null,
    image_url: data.image_url || null,
    // Wide banner art (DexScreener `info.header`). Was never forwarded to
    // the renderer before, which is why toasts never showed a banner.
    header_url: data.header_url || null,
    volume_24h_usd: data.volume_24h_usd ?? null,
    mcap_usd: data.mcap_usd ?? null,
    liquidity_usd: data.liquidity_usd ?? null,
    price_change_24h: data.price_change_24h ?? null,
    holder_count: data.holder_count ?? null,
    top10_holder_pct: data.top10_holder_pct ?? null,
    rug_risk_pct: data.rug_risk_pct ?? null,
    dex_paid: data.dex_paid ?? null,
    kol_count: data.kol_count ?? null,
    smart_wallet_count: data.smart_wallet_count ?? null,
    kol_holders: Array.isArray(data.kol_holders) ? data.kol_holders : null,
    smart_holders: Array.isArray(data.smart_holders) ? data.smart_holders : null,
    pair_url: data.pair_url || null,
    // Arrives shortly after the toast opens, via updateToast.
    caller_record: data.caller_record || null,
    alert_kind: data.alert_kind || 'new',
    watched: !!data.watched,
  };

  if (activeToasts.length >= calcMaxVisible()) {
    toastQueue.push(normalized);
    return;
  }
  createToastWindow(normalized);
}

function processQueue() {
  if (toastQueue.length && activeToasts.length < calcMaxVisible()) {
    showToast(toastQueue.shift());
  }
}

function focusMainWindow() {
  // Previously compared against an undefined `win` binding, which threw a
  // ReferenceError and silently swallowed every "focus app" toast click.
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    if (w.getTitle() === 'intel. Command Deck') {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      return;
    }
  }
}

ipcMain.on('toast-action', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (payload.action === 'close') {
    if (win && !win.isDestroyed()) closeToast(win);
    setTimeout(processQueue, 300);
  } else if (payload.action === 'measure' && payload.height > 0) {
    resizeToast(win, payload.height);
  } else if (payload.action === 'copy' && payload.ca) {
    const { clipboard } = require('electron');
    clipboard.writeText(payload.ca);
  } else if (payload.action === 'focus-app') {
    focusMainWindow();
  } else if (payload.action === 'open-url') {
    // Opened here rather than by the renderer, so a toast button cannot
    // silently fail if the window-open handler is not reached. http(s) only:
    // the URL is built from token data, and anything else (file:, data:) has
    // no business being handed to the OS shell.
    const url = String(payload.url || '');
    if (/^https?:\/\//i.test(url)) {
      const { shell } = require('electron');
      shell.openExternal(url);
    }
  }
});

module.exports = { showToast, updateToast };
