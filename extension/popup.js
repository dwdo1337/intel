import { getSettings, setSettings } from './settings.js';

const $ = id => document.getElementById(id);

// The connection state is ASKED for, not assumed. A popup that always says
// "connected" is worse than one that says nothing.
chrome.runtime.sendMessage({ type: 'status' }, (r) => {
  const ok = !!(r && r.connected);
  $('dot').classList.toggle('on', ok);
  $('conn').textContent = ok ? 'connected' : 'deck offline (localhost:5050)';
});

getSettings().then(s => {
  $('enabled').checked = s.enabled;
  $('seconds').value = s.seconds;
});

$('enabled').onchange = e => setSettings({ enabled: e.target.checked });
$('seconds').onchange = e => {
  const n = Math.max(4, Math.min(60, Number(e.target.value) || 15));
  e.target.value = n;
  setSettings({ seconds: n });
};
$('test').onclick = () => chrome.runtime.sendMessage({ type: 'test' });
$('open').onclick = () => chrome.runtime.sendMessage({ type: 'open' });
