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
 *   node server/alert-filter.e2e.mjs 5077 [ca...]
 *
 * Point it at a SCRATCH INTEL_DATA_DIR. It posts test hits, which write to the
 * signal store, and it changes alert-filter and notify-chain preferences.
 *
 * -- WHAT THIS FILE GOT WRONG BEFORE, AND WHY IT MATTERS ----------------
 *
 * The previous version starred its token up front and then asserted that a
 * `capMax` below the token's market cap produced `_notify === false`. That was
 * true when it was written and became false in 0.3.0, when watchlist kinds were
 * given a bypass (`isWatchlistKind` / `shouldNotify` in server/index.js): a
 * starred token is EXACTLY the token a market-cap ceiling must not silence.
 *
 * So the harness was asserting the old behaviour against the new code, and the
 * two cases -- gated and bypassing -- were collapsed into one that could only
 * ever describe one of them. They are separate tests here.
 *
 * It also hardcoded a single mint, which has since lost its DexScreener pair
 * and no longer enriches, so the whole file timed out rather than failing with
 * a reason. Tokens are now DISCOVERED live and only fall back to an argument.
 */
import { io } from 'socket.io-client';

const PORT = process.argv[2] || 5077;
const BASE = `http://127.0.0.1:${PORT}`;

const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures++; console.error(`  FAIL  ${name}\n        expected ${expected}, got ${actual}`); }
  else console.log(`  ok    ${name}`);
}

/**
 * Find live Solana mints with a real pair and a market cap far above any
 * ceiling this test sets.
 *
 * Discovered rather than hardcoded because the hardcoded mint died and took the
 * whole suite with it -- it timed out with no explanation rather than saying
 * so. A memecoin is not a fixture: it has a lifespan.
 */
async function discoverTokens(minMcap, want, exclude) {
  const seen = new Map();
  for (const q of ['SOL/USDC', 'pump', 'bonk']) {
    if (seen.size >= want) break;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`).then(x => x.json());
      for (const p of r.pairs || []) {
        if (p.chainId !== 'solana') continue;
        const mc = p.marketCap || p.fdv;
        const liq = (p.liquidity || {}).usd || 0;
        // A liquidity floor so the pair is real enough to keep enriching for
        // the length of the run, not a dust pool that vanishes mid-test.
        if (!mc || mc < minMcap || liq < 20000) continue;
        const ca = p.baseToken && p.baseToken.address;
        // Skip anything the store has already seen. Every unstarred assertion
        // needs a token on its FIRST call, and a warm store silently turns that
        // into a `ca_update` the harness never hears -- which is a 30s timeout
        // rather than a failure, on a re-run of a suite that just passed.
        if (ca && !seen.has(ca) && !exclude.has(ca.toLowerCase())) seen.set(ca, Math.round(mc));
      }
    } catch { /* fall through to the guard below */ }
  }
  return [...seen.entries()].slice(0, want).map(([ca, mcap]) => ({ ca, mcap }));
}

/** Fire a test hit and resolve with the whole `ca` payload. */
function fireAndCapture(socket, ca, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('ca', onCa);
      reject(new Error(`no ca event for ${ca} within ${timeoutMs}ms -- it probably has no DexScreener pair`));
    }, timeoutMs);
    function onCa(hit) {
      if (String(hit && hit.ca).toLowerCase() !== String(ca).toLowerCase()) return;
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

const setGate = (enabled, thresholds) =>
  post('/api/alert-filters', { enabled, thresholds, intent: 'user-toggle' });
const setChains = chains =>
  post('/api/notify-prefs', { chains, intent: 'user-toggle' });

// -- pick tokens -------------------------------------------------------
//
// A FRESH mint is needed for every unstarred assertion. A repeat mention of an
// unstarred token emits `ca_update`, not `ca` -- it is not a new call, so it is
// not a new alert. Correct behaviour, but it means an unstarred token can only
// be tested on its very first fire, once per store.
const CLI = process.argv.slice(3);

/** CAs the store already tracks, so discovery can avoid them. */
async function trackedCAs() {
  try {
    const feed = await fetch(`${BASE}/api/react-feed`).then(r => r.json());
    return new Set((feed || [])
      .map(e => String((e.token && e.token.address) || e.id || '').toLowerCase())
      .filter(Boolean));
  } catch { return new Set(); }
}

const tokens = CLI.length
  ? CLI.map(ca => ({ ca, mcap: null }))
  : await discoverTokens(60000, 4, await trackedCAs());

if (tokens.length < 3) {
  console.error('\n  Cannot run: could not find 3 live Solana tokens with a pair.');
  console.error('  Pass mints explicitly:  node server/alert-filter.e2e.mjs <port> <ca> <ca> <ca>\n');
  process.exit(2);
}

const socket = io(BASE, { path: '/socket.io', transports: ['websocket'] });
await new Promise((r, j) => { socket.on('connect', r); socket.on('connect_error', j); });
console.log('\nalert-filter e2e -- connected');
console.log(`  using ${tokens.length} discovered mints\n`);

const pool = [...tokens];
const fresh = () => pool.shift();

try {
  // -- baseline: gate OFF, everything alerts ---------------------------
  await setChains(null);
  await setGate(false, {});
  const t0 = fresh();
  const before = await fireAndCapture(socket, t0.ca);
  const mcap = before.scan_mcap_usd != null ? before.scan_mcap_usd : before.mcap_usd;
  console.log(`  (${t0.ca.slice(0, 8)}... enriched at mcap = ${mcap == null ? 'unknown' : Math.round(mcap).toLocaleString()})`);
  if (mcap == null) {
    console.error('\n  Cannot run: the token did not enrich (no pair / no network).\n');
    socket.close(); process.exit(2);
  }
  check('gate off: _notify is true', before._notify, true);

  // -- the original bug: an UNSTARRED token above the ceiling ----------
  //
  // This is the case the metric gate exists for -- narrowing a firehose of
  // tokens you have never seen. Fresh mint, so this is its first fire.
  const t1 = fresh();
  await setGate(true, { capMax: 6000 });
  const gated = await fireAndCapture(socket, t1.ca);
  check('unstarred + capMax 6000: _notify is false', gated._notify, false);

  // -- 4.6: a STARRED token above the same ceiling still alerts --------
  //
  // Starring is an instruction about THAT token and outranks a range written
  // about strangers. A market-cap max of 6,000 silencing a token you starred
  // the moment it runs past 6,000 is the exact event you starred it for.
  // ORDER MATTERS, and getting it wrong looks exactly like the bypass being
  // broken. `/api/watch/:ca` 404s with "not tracked" for a mint the store has
  // never seen, so a token cannot be starred before its first call -- and the
  // first call is `isNew`, which is kind `new`, which the gate applies to even
  // for a token that is somehow already starred. That is not a hole: you star
  // a token off a card, and the card only exists because it was called.
  //
  // So: call it once to create it, THEN star it, THEN call it again.
  const t2 = fresh();
  await setGate(false, {});
  await fireAndCapture(socket, t2.ca);                       // creates the hit
  const star = await post(`/api/watch/${t2.ca}`, { watched: true });
  check('the token is actually starred', star.watched, true);  // guards the 404
  await setGate(true, { capMax: 6000 });

  const starred = await fireAndCapture(socket, t2.ca);
  check('starred + capMax 6000: _notify is true (watchlist bypass)', starred._notify, true);
  check('starred repeat is kind watchlist-mention', starred._alert_kind, 'watchlist-mention');

  // A starred token re-fires as `watchlist-mention` every time, so unlike the
  // unstarred cases this one can be asserted repeatedly on the same mint.
  const starredAgain = await fireAndCapture(socket, t2.ca);
  check('starred, called again + capMax 6000: still true', starredAgain._notify, true);
  check('starred repeat is tiered as a note, not a signal', starredAgain._alert_tier, 'note');

  // -- the asymmetry: a muted CHAIN still silences a starred token -----
  //
  // shouldNotify checks the chain BEFORE the watchlist bypass, deliberately.
  // "Tell me more about this one" is not "override the channels I switched
  // off". If this ever flips, a muted chain starts speaking again.
  await setChains(['bsc']);           // solana muted, bsc left on
  const muted = await fireAndCapture(socket, t2.ca);
  check('starred on a MUTED chain: _notify is false', muted._notify, false);
  await setChains(null);              // restore: all chains alert

  // -- the live settings, which had never been tested ------------------
  //
  // config.json ships enabled:true with capMax 20000. The gate had only ever
  // been exercised at the 6000 this file invents.
  await setGate(true, { capMax: 20000 });
  const t3 = fresh();
  if (t3) {
    const live = await fireAndCapture(socket, t3.ca);
    check('unstarred at the live capMax 20000: _notify is false', live._notify, false);
  }
  const liveStarred = await fireAndCapture(socket, t2.ca);
  check('starred at the live capMax 20000: _notify is true', liveStarred._notify, true);

  // -- switching the gate off restores previous behaviour --------------
  await setGate(false, { capMax: 6000 });
  const off = await fireAndCapture(socket, t2.ca);
  check('gate off with a blocking threshold still stored: _notify is true', off._notify, true);
} finally {
  // Never leave the server muted or gated because an assertion threw.
  await setChains(null).catch(() => {});
  await setGate(false, {}).catch(() => {});
}

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
socket.close();
process.exit(failures ? 1 : 0);
