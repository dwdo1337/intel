/**
 * End-to-end check of the alert metric gate against a RUNNING server.
 *
 * The unit tests prove the predicate. This proves the wiring: that the flag the
 * Electron toast layer actually reads (`_notify` on the `ca` socket event) flips
 * when the thresholds say it should. The reported bug lived entirely in the
 * wiring -- the predicate did not exist -- so testing only the predicate would
 * not have caught it.
 *
 * Usage:
 *   PORT=5077 INTEL_DATA_DIR=/tmp/intel-test-data node server/index.js &
 *   node server/alert-filter.e2e.mjs 5077
 *
 * Point it at a SCRATCH INTEL_DATA_DIR. It posts test hits, which write to the
 * signal store.
 */
import { io } from 'socket.io-client';

const PORT = process.argv[2] || 5077;
const BASE = `http://127.0.0.1:${PORT}`;

// A real Solana mint with a live pair, so enrichment produces a genuine mcap.
// Its actual market cap is far above the 6,000 ceiling used below -- which is
// the entire point of the test.
const CA = process.argv[3] || '5WMztsvfXWFRaAPQRV2Cgb3Fm4EFPHYbGmMKMKpump';

const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures++; console.error(`  FAIL  ${name}\n        expected ${expected}, got ${actual}`); }
  else console.log(`  ok    ${name}`);
}

/** Fire a test hit and resolve with the `_notify` flag off the socket event. */
function fireAndCapture(socket, ca, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('ca', onCa); reject(new Error('no ca event within timeout')); }, timeoutMs);
    function onCa(hit) {
      if (String(hit?.ca).toLowerCase() !== String(ca).toLowerCase()) return;
      clearTimeout(timer); socket.off('ca', onCa);
      resolve(hit);
    }
    socket.on('ca', onCa);
    post('/api/test-hit', {
      ca, chain: 'solana', source: 'telegram',
      chat_name: 'Alpha Signals', author: 'degenmike', text: 'early on this one',
    }).catch(reject);
  });
}

const socket = io(BASE, { path: '/socket.io', transports: ['websocket'] });
await new Promise((r, j) => { socket.on('connect', r); socket.on('connect_error', j); });
console.log('\nalert-filter e2e — connected\n');

// Star the token UP FRONT. A repeat mention of an unstarred token emits
// `ca_update`, not `ca` -- it is not a new call, so it is not a new alert.
// Correct behaviour, but it means only the very first fire of a run would
// produce an event, and none at all on a second run against a warm store.
// A starred token raises a `watchlist-mention` every time, through the same
// shouldNotify gate, so the thing under test is unchanged.
await post(`/api/watch/${CA}`, { watched: true });

// ── baseline: gate OFF, everything alerts ──────────────────────────────
await post('/api/alert-filters', { enabled: false, thresholds: {}, intent: 'user-toggle' });
const before = await fireAndCapture(socket, CA);
const mcap = before.scan_mcap_usd ?? before.mcap_usd;
console.log(`  (token enriched at mcap = ${mcap == null ? 'unknown' : Math.round(mcap).toLocaleString()})`);
if (mcap == null) {
  console.error('\n  Cannot run: the token did not enrich (no pair / no network). Pick another CA.\n');
  socket.close(); process.exit(2);
}
check('gate off: _notify is true', before._notify, true);

// ── the reported bug: capMax below the token's mcap ────────────────────
await post('/api/alert-filters', { enabled: true, thresholds: { capMax: 6000 }, intent: 'user-toggle' });
const gated = await fireAndCapture(socket, CA);
check(`capMax 6000 vs mcap ${Math.round(mcap).toLocaleString()}: _notify is false`, gated._notify, false);

// ── a ceiling above the token lets it through again ────────────────────
await post('/api/alert-filters', { enabled: true, thresholds: { capMax: Math.ceil(mcap) + 1000 }, intent: 'user-toggle' });
const allowed = await fireAndCapture(socket, CA);
check('capMax above the mcap: _notify is true again', allowed._notify, true);

// ── switching the gate off restores previous behaviour ─────────────────
await post('/api/alert-filters', { enabled: false, thresholds: { capMax: 6000 }, intent: 'user-toggle' });
const off = await fireAndCapture(socket, CA);
check('gate off with a blocking threshold still stored: _notify is true', off._notify, true);

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
socket.close();
process.exit(failures ? 1 : 0);
