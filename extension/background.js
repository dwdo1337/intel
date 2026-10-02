// Connects to the local deck and pushes alerts into whichever tab is in front.
//
// Ported from dex-paid-tracker/extension/background.js, with one deliberate
// simplification: this worker applies NO filtering of its own. The deck has
// already decided whether a signal is worth interrupting someone -- it owns
// the chain preferences and the thresholds, and it is the only place those are
// stored. The server only broadcasts what passed that gate, so everything
// arriving here is shown.
import { getSettings } from './settings.js';

const SERVER = 'http://localhost:5050';

let ws = null;
let connected = false;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(SERVER.replace('http', 'ws') + '/ws');
  } catch {
    return;
  }
  ws.onopen = () => { connected = true; paintBadge(); };
  ws.onclose = () => {
    connected = false;
    ws = null;
    paintBadge();
    // Fixed backoff rather than none: the deck is a local app the user starts
    // and stops, so being unreachable is ordinary, not an error state.
    setTimeout(connect, 3000);
  };
  ws.onerror = () => { /* onclose follows and does the work */ };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.kind === 'alert' && m.alert) show(m.alert);
  };
}

// A red OFF on the toolbar icon while the deck is unreachable. Without it,
// "no alerts" and "the deck is not running" look exactly the same, and the
// second one is the one you need to act on.
function paintBadge() {
  chrome.action.setBadgeText({ text: connected ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff4f6d' });
  chrome.action.setTitle({
    title: connected ? 'intel. — connected' : 'intel. — deck offline (localhost:5050)',
  });
}
paintBadge();

// MV3 workers sleep. The alarm wakes this one to reconnect, and the server's
// 20-second ping keeps an open socket busy enough to survive between alarms.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// Tabs opened before the extension was installed have no content script yet,
// so inject it on demand. Pages Chrome will not let us touch at all -- the new
// tab page, chrome://, the Web Store -- keep the alert queued for the next
// ordinary tab rather than dropping it.
const queued = [];
const QUEUE_MS = 2 * 60000;

async function sendToTab(tabId, payload, settings) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'intel-toast', payload, settings });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['toast.js', 'content.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'intel-toast', payload, settings });
      return true;
    } catch {
      return false;
    }
  }
}

async function show(alert) {
  const settings = await getSettings();
  if (!settings.enabled) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id && await sendToTab(tab.id, alert, settings)) return;
  queued.push({ payload: alert, at: Date.now() });
  // Five deep. A queue that remembers everything would dump a wall of stale
  // alerts the moment you open a normal tab, which is worse than losing them.
  while (queued.length > 5) queued.shift();
}

async function flushQueue(tabId) {
  const fresh = queued.splice(0).filter(q => Date.now() - q.at < QUEUE_MS);
  if (!fresh.length) return;
  const settings = await getSettings();
  for (const q of fresh) {
    if (!await sendToTab(tabId, q.payload, settings)) { queued.push(q); break; }
  }
}
chrome.tabs.onActivated.addListener(({ tabId }) => flushQueue(tabId));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) flushQueue(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'status') { reply({ connected, server: SERVER }); return; }
  if (msg.type === 'open') {
    // Focus the deck tab if one is already open rather than piling up copies
    // of the same app; the deck reads the token out of the hash.
    const url = SERVER + (msg.ca ? '#token=' + encodeURIComponent(msg.ca) : '');
    chrome.tabs.query({ url: SERVER + '/*' }).then(tabs => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true, url });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url });
      }
    }).catch(() => chrome.tabs.create({ url }));
    return;
  }
  if (msg.type === 'test') {
    getSettings().then(s => show({
      id: 'test', ca: 'So11111111111111111111111111111111111111112',
      symbol: 'TEST', name: 'Alert preview', image: null, mcap: 42000,
      chat_name: 'Your alpha chat', author: '@someone', tier: 'signal',
      x: { handle: 'intelcmddesk', name: 'intel.', avatar: null, followers: 1200 },
    }));
    reply({ ok: true });
    return;
  }
});
