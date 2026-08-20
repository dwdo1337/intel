/**
 * GMGN OpenAPI integration (gmgn-cli wrapper).
 *
 * WHAT THIS ADDS
 *  1. EVM safety data (honeypot / tax / top-10 / open-source / blacklist).
 *     RugCheck (safety.js) is Solana-only, so BSC and Base hits had none.
 *  2. Dev wallet history -- how many tokens this creator launched, how many
 *     survived, and their all-time best. A wallet with 1777 launches and a
 *     1.7% survival rate is a serial rugger, stated in numbers.
 *  3. Real DEX Paid (`dexscr_ad`), replacing a hardcoded `false`.
 *
 * ==========================================================================
 * FIELD RELIABILITY -- VERIFIED BY CROSS-CHECKING THREE REAL TOKENS
 * ==========================================================================
 * Do not widen this mapping without re-running the same comparison. Several
 * GMGN fields return plausible-looking DEFAULTS rather than real analysis,
 * and wiring those straight through would fabricate safety signals.
 *
 * `lock_summary` -- DO NOT USE. Returned byte-identical
 *   (`percent: 0.95, is_blackhole: true, pool: 0x000...0`) for a BSC
 *   memecoin, BSC USDT, and a Solana pump.fun token. An EVM-format 0x pool
 *   address on a Solana mint proves it is a placeholder. Using it for
 *   lp_burned_pct would show a fake "95% LP burned" on literally everything.
 *
 * `burn_ratio` -- REAL. 0 on both BSC tokens, 1 on the Solana pump token
 *   (whose LP genuinely is burned). This is the correct LP-burn source.
 *
 * `renounced_mint` / `renounced_freeze_account` -- SOLANA ONLY. On Solana
 *   these are true/false and correct (cross-checked against RugCheck's
 *   mintAuthority). On EVM they came back `false` for every token including
 *   BSC USDT, because EVM has no Solana-style mint/freeze authority. `false`
 *   there means "not applicable", NOT "mintable" -- mapping it to
 *   is_mintable:true would put a false red flag on every EVM token.
 *
 * `top_10_holder_rate` -- REAL but methodology differs from RugCheck
 *   (GMGN said 31.13% where RugCheck said 42.12% for the same mint; GMGN
 *   appears to exclude LP/burn addresses). Also returned "0" for BSC USDT,
 *   which is not a real 0% concentration -- so 0 is treated as unknown.
 *
 * `is_honeypot` / `is_renounced` / `is_open_source` / `is_blacklist` --
 *   REAL on EVM, and GMGN correctly returns null for them on Solana, so
 *   they can be passed through as-is.
 *
 * HARD CONSTRAINTS
 *  - Rate limit ~10 QPS leaky bucket, and retrying during a cooldown
 *    EXTENDS the ban by 5s each time up to 5 minutes. Hence: strict serial
 *    queue, floor gap, and a hard stop (never a retry) on 429.
 *  - Chains: sol / bsc / base only. Ethereum partial, Robinhood unsupported.
 *  - The API key is read at call time and never logged.
 *
 * HONESTY CONTRACT: null means "we don't know", never "fine". Every failure
 * path returns null and lets the signal through unblocked.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, sep } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Call the CLI's JS entry directly with the current Node binary instead of
// the .bin shim. On Windows that shim is a .cmd, and since Node's
// CVE-2024-27980 fix, spawning .cmd/.bat without shell:true throws EINVAL --
// and shell:true would route contract addresses through a shell, which is an
// injection surface we have no reason to open.
// .replace() handles the packaged case: a file inside app.asar has no real
// path on disk and cannot be spawned, so point at the asarUnpack'd copy.
// No-op in dev, where the path contains no 'app.asar' segment.
// Two locations, because the backend runs from two different places:
//   dev       -> server/,      CLI at ../node_modules/gmgn-cli/dist/index.js
//   packaged  -> dist-server/, CLI bundled beside it as gmgn-cli.mjs
// The bundled copy exists because gmgn-cli runs as its OWN process and needs
// its OWN dependency tree — shipping the package alone failed with
// "Cannot find package 'undici'". Bundling it is what lets node_modules be
// dropped from the build entirely.
const CLI_BUNDLED = join(__dirname, 'vendor', 'gmgn-cli', 'dist', 'index.mjs')
  .replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const CLI_FROM_MODULES = join(__dirname, '..', 'node_modules', 'gmgn-cli', 'dist', 'index.js')
  .replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const CLI_ENTRY = existsSync(CLI_BUNDLED) ? CLI_BUNDLED : CLI_FROM_MODULES;

// The CLI is launched THROUGH a shim rather than directly. gmgn-cli parses
// args with commander, which special-cases Electron and mis-slices argv in a
// packaged build, so every call died with "unknown command <path>". The shim
// makes the child look like plain node first. See gmgn-cli-shim.cjs.
const CLI_SHIM = join(__dirname, 'gmgn-cli-shim.cjs')
  .replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

const CALL_TIMEOUT_MS = 20000;
const MIN_GAP_MS = 1200;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 400;
const RATE_LIMIT_BACKOFF_MS = 90 * 1000;

// How many wallets we request per tag. Exported because the caller has to know
// it: a result of exactly this length is truncated, so the count is a floor
// rather than a total, and the UI must say so.
export const WALLET_PAGE = 50;

const CHAIN_MAP = {
  solana: 'sol', sol: 'sol',
  bsc: 'bsc', bnb: 'bsc', binance: 'bsc',
  base: 'base',
};

let _apiKey = null;
let _lastCallAt = 0;
let _rateLimitedUntil = 0;

const _cache = new Map();

// Returned by runCli when the call failed for a reason that says nothing about
// the token: rate limit cooldown, timeout, spawn failure, unparseable output.
// These must NEVER be cached -- doing so turned a momentary 429 into five
// minutes of "GMGN unavailable" for a wallet whose data was fetching fine one
// second later, and the retry didn't even reach the API to find out.
// A genuine empty answer from GMGN is a different thing and stays cacheable.
const TRANSIENT = Symbol('gmgn-transient-failure');

export function isTransient(v) { return v === TRANSIENT; }

/**
 * Milliseconds remaining on the rate-limit cooldown, or 0.
 *
 * During a cooldown `runCli` returns TRANSIENT *immediately* rather than
 * waiting — correct for live enrichment, where a signal on screen must not
 * block on a stalled provider. But it means a bulk caller cannot tell "GMGN
 * said no" from "we did not ask", and will burn through its whole worklist in
 * seconds recording failures. A maintenance sweep hit exactly that: 317 of 324
 * tokens "failed" during one 90s cooldown.
 *
 * Exposed so a batch job can wait the cooldown out instead.
 */
export function gmgnCooldownMs() {
  return Math.max(0, _rateLimitedUntil - Date.now());
}

export function configureGmgn(apiKey) {
  _apiKey = apiKey || null;
}

export function isGmgnConfigured() {
  return !!_apiKey;
}

export function gmgnChain(chain) {
  if (!chain) return null;
  return CHAIN_MAP[String(chain).toLowerCase()] || null;
}

// `token info` covers more chains than `token security` does. Kept as a
// SEPARATE map on purpose: widening CHAIN_MAP would silently start firing
// security lookups on chains whose safety data has never been verified, and
// unverified safety numbers are exactly what this project refuses to show.
// Descriptive metadata (name/logo) carries no such risk.
const INFO_CHAIN_MAP = {
  ...CHAIN_MAP,
  eth: 'eth', ethereum: 'eth', erc20: 'eth',
  robinhood: 'robinhood', rh: 'robinhood',
  arc: 'arc',
  stable: 'stable',
};

export function gmgnInfoChain(chain) {
  if (!chain) return null;
  return INFO_CHAIN_MAP[String(chain).toLowerCase()] || null;
}

/**
 * Chains where `token holders` actually returns data.
 *
 * A THIRD map, for the same reason the second one exists. Tested directly
 * against the live API, untagged, on tokens that unquestionably have holders:
 *
 *   bsc        BSC-USDT   -> rows
 *   sol        real memecoins -> rows
 *   robinhood  WOJAK      -> rows (19 KOLs)
 *   base       DEGEN, BRETT -> []
 *   eth        PEPE, USDT   -> []
 *
 * Base and Ethereum return an EMPTY LIST rather than an error, which is the
 * dangerous part: the caller cannot tell "this chain is not covered" from "we
 * looked and nobody notable holds it", and was recording the second. Every
 * Base and ETH card therefore asserted a measured zero for KOLs, smart money,
 * bundlers and snipers on a chain that reports none of it.
 *
 * Unsupported chains now return null (unknown) before a call is even made,
 * which also saves four GMGN calls per Base/ETH signal.
 */
const HOLDER_CHAINS = new Set(['sol', 'bsc', 'robinhood']);

export function gmgnHolderChain(chain) {
  const c = gmgnInfoChain(chain);
  return c && HOLDER_CHAINS.has(c) ? c : null;
}

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) { _cache.delete(key); return undefined; }
  return e.value;
}

function cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { at: Date.now(), value });
}

function runCli(args, log, priority = GMGN_PRIORITY.ONDEMAND) {
  const task = async () => {
    if (!_apiKey) return null;
    if (Date.now() < _rateLimitedUntil) return TRANSIENT;

    const gap = Date.now() - _lastCallAt;
    if (gap < MIN_GAP_MS) await new Promise(r => setTimeout(r, MIN_GAP_MS - gap));
    _lastCallAt = Date.now();

    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI_SHIM, CLI_ENTRY, ...args, '--raw'],
        {
          timeout: CALL_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            GMGN_API_KEY: _apiKey,
            // MUST be set explicitly, not inherited.
            //
            // When packaged, this server is itself running as
            // `electron.exe --run-as-node`, so process.execPath is the ELECTRON
            // binary. Electron REMOVES ELECTRON_RUN_AS_NODE from process.env
            // once it has consumed it, precisely so children don't inherit it
            // -- which means spawning the CLI without setting it again starts
            // Electron in APP mode and the CLI never runs:
            //   error: unknown command '...\gmgn-cli\dist\index.js'
            //
            // Every GMGN call failed this way in the packaged build while
            // working perfectly in dev (where execPath is node). Symptom was
            // silent: no KOL data, no smart money, no GMGN artwork, and a KOL
            // watcher reporting tokensIndexed: 0.
            ELECTRON_RUN_AS_NODE: '1',
          },
        },
        (err, stdout, stderr) => {
          // PARSE FIRST, CLASSIFY ERRORS SECOND.
          //
          // This used to run /RATE_LIMIT|429/i over stdout+stderr *before*
          // looking at whether the call had succeeded. A successful
          // `portfolio created-tokens` response is ~77KB of JSON, and "429"
          // occurs incidentally all over it -- inside fee amounts
          // ("total_fee":"1.80185429844"), pool liquidity ("4896.46701429098")
          // and logo URLs (".../344294317a7c..."). So a perfectly valid
          // response was thrown away AND set a 90s global cooldown that then
          // blocked every cheap security lookup too. That single line is why
          // dev history could never be verified end-to-end: it was never
          // actually rate limited.
          //
          // A real answer parses as JSON. Anything that parses is an answer.
          const text = String(stdout || '').trim();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              // GMGN reports errors as a JSON envelope too, so still check the
              // parsed shape -- but only its own error fields, never free text.
              const code = parsed && (parsed.code ?? parsed.status ?? null);
              const msg = String((parsed && (parsed.msg || parsed.message || parsed.error)) || '');
              if (Number(code) === 429 || /RATE_LIMIT/i.test(msg)) {
                _rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
                log?.('enrichment', 'GMGN rate limited, pausing calls', {
                  resumeInSec: Math.round(RATE_LIMIT_BACKOFF_MS / 1000),
                });
                return resolve(TRANSIENT);
              }
              if (/AUTH_KEY_INVALID|AUTH_INVALID/i.test(msg)) {
                log?.('error', 'GMGN API key rejected -- disabling GMGN enrichment');
                _apiKey = null;
                return resolve(null);
              }
              if (/AUTH_IP_BLOCKED/i.test(msg)) {
                log?.('error', 'GMGN: this IP is not on the API key whitelist');
                _apiKey = null;
                return resolve(null);
              }
              return resolve(parsed);
            } catch {
              // Not JSON -- fall through to the plain-text error classifier.
            }
          }

          // Non-JSON output: now free-text matching is safe, because there is
          // no payload to produce a false positive.
          const blob = `${text}${stderr || ''}`;
          if (/RATE_LIMIT|\b429\b/i.test(blob)) {
            _rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
            log?.('enrichment', 'GMGN rate limited, pausing calls', {
              resumeInSec: Math.round(RATE_LIMIT_BACKOFF_MS / 1000),
            });
            return resolve(TRANSIENT);
          }
          if (/AUTH_KEY_INVALID|AUTH_INVALID/i.test(blob)) {
            log?.('error', 'GMGN API key rejected -- disabling GMGN enrichment');
            _apiKey = null;
            return resolve(null);
          }
          if (/AUTH_IP_BLOCKED/i.test(blob)) {
            log?.('error', 'GMGN: this IP is not on the API key whitelist');
            _apiKey = null;
            return resolve(null);
          }
          // err covers timeout and spawn failure -- the token is blameless,
          // so this is transient, not "no data".
          //
          // These paths used to return null with no log at all, which is why
          // "GMGN unavailable" was indistinguishable from a rate limit for so
          // long. Say which failure it actually was.
          if (err && !stdout) {
            log?.('error', 'GMGN CLI call failed', {
              cmd: args[0] + ' ' + args[1],
              killed: err.killed === true,          // true => hit CALL_TIMEOUT_MS
              code: err.code ?? null,
              detail: String(err.message || '').slice(0, 200),
              stderr: String(stderr || '').slice(0, 200),
            });
            return resolve(TRANSIENT);
          }
          if (!stdout) {
            log?.('error', 'GMGN CLI returned no output', {
              cmd: args[0] + ' ' + args[1], stderr: String(stderr || '').slice(0, 200),
            });
            return resolve(TRANSIENT);
          }
          try { resolve(JSON.parse(stdout.trim())); }
          catch {
            log?.('error', 'GMGN CLI output was not JSON', {
              cmd: args[0] + ' ' + args[1], head: String(stdout).slice(0, 200),
            });
            resolve(TRANSIENT);
          }
        }
      );
    });
  };

  return schedule(task, priority);
}

/**
 * Serial scheduler with priorities.
 *
 * Every GMGN call shares one queue with a 1.2s floor between calls, because
 * the API punishes bursts by extending its cooldown. That part is necessary.
 * What was wrong was making it strictly FIFO: the KOL watcher issues ten calls
 * a minute in a burst, so a signal arriving mid-sweep waited behind all of
 * them before it could fetch its own artwork -- the one thing a person needs
 * immediately to recognise the token.
 *
 * Lower number = served first. Ties fall back to arrival order, so nothing
 * starves within a priority level.
 *
 *   0  artwork / security for a signal on screen  (someone is looking at it)
 *   1  holder + dev lookups                       (a click is waiting)
 *   2  background watcher sweeps                  (nobody is waiting)
 */
export const GMGN_PRIORITY = { SIGNAL: 0, ONDEMAND: 1, BACKGROUND: 2 };

const _pending = [];
let _seq = 0;
let _draining = false;

function schedule(task, priority) {
  return new Promise((resolve, reject) => {
    _pending.push({ task, resolve, reject, priority, seq: _seq++ });
    drain();
  });
}

async function drain() {
  if (_draining) return;
  _draining = true;
  try {
    while (_pending.length) {
      // Re-sorted every iteration on purpose: a high-priority call queued
      // while a sweep is draining should go next, not after the sweep.
      _pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const item = _pending.shift();
      try { item.resolve(await item.task()); }
      catch (e) { item.reject(e); }
    }
  } finally {
    _draining = false;
  }
}

export function gmgnQueueDepth() {
  return _pending.length;
}

/** GMGN returns rates as decimal strings ("0.6958" = 69.58%). */
function pctFromRate(v, { zeroIsUnknown = false } = {}) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (zeroIsUnknown && n === 0) return null;
  return Number((n * 100).toFixed(2));
}

function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null;
}

export async function fetchGmgnSecurity(ca, chain, log, { force = false } = {}) {
  const c = gmgnChain(chain);
  if (!c || !_apiKey) return null;

  const key = `sec:${c}:${ca}`;
  // A manual refresh means "tell me what is true NOW". Serving it from the
  // 5-minute cache would return the very numbers the user just asked us to
  // re-check, which is indistinguishable from the refresh doing nothing.
  if (!force) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }

  const j = await runCli(['token', 'security', '--chain', c, '--address', ca], log, GMGN_PRIORITY.SIGNAL);
  if (isTransient(j)) return null;                       // do not cache a non-answer
  if (!j || typeof j !== 'object') { cacheSet(key, null); return null; }

  const isSolana = c === 'sol';

  // Mint/freeze authority is a Solana concept. On EVM these come back false
  // for every token (verified on BSC USDT), meaning "N/A" -- so we only read
  // them on Solana and leave them unknown elsewhere.
  const isMintable = isSolana ? (typeof j.renounced_mint === 'boolean' ? !j.renounced_mint : null) : null;
  const isFreezable = isSolana ? (typeof j.renounced_freeze_account === 'boolean' ? !j.renounced_freeze_account : null) : null;

  // LP burn comes from burn_ratio ONLY. lock_summary is a fixed placeholder
  // (see the reliability notes at the top of this file).
  const lpBurned = pctFromRate(j.burn_ratio);

  const out = {
    // 0 from GMGN means "not computed" far more often than a genuine 0%
    // concentration, so it is treated as unknown.
    top10_holder_pct: pctFromRate(j.top_10_holder_rate, { zeroIsUnknown: true }),
    is_honeypot: boolOrNull(j.is_honeypot),
    is_contract_renounced: boolOrNull(j.is_renounced),
    is_mintable: isMintable,
    is_freezable: isFreezable,
    buy_tax_pct: pctFromRate(j.buy_tax),
    sell_tax_pct: pctFromRate(j.sell_tax),
    lp_burned_pct: lpBurned,
    is_open_source: boolOrNull(j.is_open_source),
    is_blacklisted: boolOrNull(j.is_blacklist),
    safety_source: 'gmgn',
    safety_checked_at: new Date().toISOString(),
  };
  cacheSet(key, out);
  return out;
}

/**
 * Descriptive token metadata: logo, banner, holder count.
 *
 * This is the ONLY image source that covers EVM. DexScreener only serves an
 * image for tokens with a paid/enhanced profile, and RugCheck is Solana-only,
 * so BSC/Base/Robinhood tokens had no artwork at all. `token info` has a
 * `logo` for every chain GMGN supports -- verified live on bsc, sol and
 * robinhood.
 *
 * NOTE ON THE IMAGE URLs: gmgn.ai/external-res/... is behind Cloudflare and
 * returns 403 to a plain HTTP client, but loads normally in a browser engine.
 * The renderer is Chromium, so <img src> works -- verified. Do not "fix" this
 * by proxying it through the backend; fetching it server-side is what fails.
 */
export async function fetchGmgnTokenInfo(ca, chain, log, { force = false } = {}) {
  const c = gmgnInfoChain(chain);
  if (!c || !_apiKey) return null;

  const key = `info:${c}:${ca}`;
  if (!force) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }

  const j = await runCli(['token', 'info', '--chain', c, '--address', ca], log, GMGN_PRIORITY.SIGNAL);
  if (isTransient(j)) return null;                       // do not cache a non-answer
  if (!j || typeof j !== 'object') { cacheSet(key, null); return null; }

  const httpUrl = v => (typeof v === 'string' && /^https?:\/\//i.test(v)) ? v : null;
  const out = {
    image_url: httpUrl(j.logo),
    header_url: httpUrl(j.banner),
    holder_count: Number.isFinite(Number(j.holder_count)) && Number(j.holder_count) > 0
      ? Number(j.holder_count) : null,
    // How many OTHER tokens reuse this exact image. A copycat launch reusing a
    // known project's art scores high here. Captured because it is a real
    // signal, but it is NOT surfaced in the UI yet -- deciding what counts as
    // suspicious needs data we don't have.
    image_dup_count: Number.isFinite(Number(j.image_dup_count)) ? Number(j.image_dup_count) : null,
  };
  cacheSet(key, out);
  return out;
}

/**
 * Recent KOL or Smart Money trades for a whole chain.
 *
 * `kind` is 'kol' or 'smartmoney' -- GMGN treats these as two DIFFERENT wallet
 * lists and its own docs are explicit that one must never be substituted for
 * the other:
 *   kol         = wallets tagged `renowned`; publicly known influencers. Their
 *                 trades carry social/marketing signal, not necessarily alpha.
 *   smartmoney  = wallets tagged `smart_degen`; a statistically proven
 *                 profitable record. A stronger alpha signal than KOL.
 *
 * This is a chain-wide feed, not a per-token query -- there is no endpoint that
 * answers "which KOLs hold token X" directly from trade flow. The watcher in
 * kol.js indexes this stream by token to answer that.
 */
export async function fetchGmgnWalletTrades(kind, chain, limit, log) {
  const c = gmgnInfoChain(chain);
  if (!c || !_apiKey) return null;
  if (kind !== 'kol' && kind !== 'smartmoney') return null;

  const j = await runCli(['track', kind, '--chain', c, '--limit', String(limit || 100)], log, GMGN_PRIORITY.BACKGROUND);
  if (isTransient(j) || !j) return null;
  const list = Array.isArray(j) ? j : (j.list || j.data || []);
  if (!Array.isArray(list)) return null;

  return list.map(t => {
    const mi = t.maker_info || {};
    const bt = t.base_token || {};
    return {
      kind,
      wallet: t.maker || null,
      handle: mi.twitter_username || null,
      name: mi.twitter_name || mi.name || null,
      avatar: mi.avatar || null,
      tags: Array.isArray(mi.tags) ? mi.tags : [],
      ca: t.base_address || null,
      symbol: bt.symbol || null,
      // `side` is the direct buy/sell. is_open_or_close is NOT a duplicate of
      // it and its meaning is INVERTED versus follow-wallet: for kol and
      // smartmoney, 0 = position opened/added, 1 = position closed/reduced.
      side: t.side || null,
      opened: t.is_open_or_close === 0,
      usd: Number.isFinite(Number(t.amount_usd)) ? Number(t.amount_usd) : null,
      // Ratio of price change SINCE the trade: 6.66 means the token is now
      // 6.66x what this wallet paid. Lets a trade be judged on how it aged.
      priceChange: Number.isFinite(Number(t.price_change)) ? Number(t.price_change) : null,
      at: Number.isFinite(Number(t.timestamp)) ? Number(t.timestamp) * 1000 : Date.now(),
    };
  }).filter(x => x.ca);
}

/**
 * KOL / Smart Money exposure for ONE token, from its holder list.
 *
 * Complements the trade feed: the feed only sees trades that happen while we
 * are watching, whereas this sees positions held right now regardless of when
 * they were opened. Limited to the top holders by position size, so a small
 * KOL position is invisible -- the UI must say "among top holders", never
 * "all KOLs".
 */
export async function fetchGmgnTokenWallets(ca, chain, tag, log, { force = false } = {}) {
  // gmgnHolderChain, NOT gmgnInfoChain: Base and Ethereum resolve fine for
  // token *info* but return an empty holder list for every token. Returning
  // null here keeps "unsupported chain" distinct from "nobody holds it".
  const c = gmgnHolderChain(chain);
  if (!c || !_apiKey) return null;

  const key = `wallets:${tag}:${c}:${ca}`;
  // A manual refresh means "tell me what is true NOW". Serving it from a
  // 5-minute cache made the refresh button silently useless for wallet data:
  // press it, watch the market cap update, and see the same KOL count that
  // was already there. Automatic enrichment still uses the cache, which is
  // what keeps a burst of mentions from costing a call each.
  if (!force) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }

  const j = await runCli(
    ['token', 'holders', '--chain', c, '--address', ca, '--limit', String(WALLET_PAGE), '--tag', tag],
    log
  );
  if (isTransient(j)) return null;                       // do not cache a non-answer
  if (!j) { cacheSet(key, null); return null; }
  const list = Array.isArray(j) ? j : (j.list || j.data || []);
  if (!Array.isArray(list)) { cacheSet(key, null); return null; }

  // `token holders` is NOT a list of current holders. It returns every wallet
  // with this tag that has TRADED the token, and reports `balance: 0` for the
  // ones that have fully exited. Verified live on a Solana call: a KOL with
  // buy_amount_cur 6,531,299 and sell_amount_cur 6,531,299 -- bought and sold
  // the identical amount, held for 21 seconds, balance 0 -- was being counted
  // as "holding". `isHolding` is therefore carried on every entry and the
  // caller decides; the raw list length means "touched it", never "holds it".
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const out = list.map(h => {
    const balance = num(h.balance);
    const amountCur = num(h.amount_cur);
    const pct = num(h.amount_percentage);
    return {
      wallet: h.address || h.account_address || null,
      handle: h.twitter_username || null,
      name: h.twitter_name || h.name || null,
      avatar: h.avatar || null,
      tags: Array.isArray(h.tags) ? h.tags : [],
      pctOfSupply: pct != null ? pct * 100 : null,
      usdValue: num(h.usd_value),
      realizedProfit: num(h.realized_profit),
      // Current position. Any one of these being positive is a real holding;
      // requiring all three would drop wallets whose position is too small to
      // register as a share of supply.
      balance,
      isHolding: (balance != null && balance > 0)
        || (amountCur != null && amountCur > 0)
        || (pct != null && pct > 0),
      // Sold everything they bought -- the specific shape behind "shows KOLs
      // who traded it but are not holding".
      soldOut: (balance === 0 || amountCur === 0)
        && num(h.sell_amount_cur) > 0,
    };
  }).filter(x => x.wallet);

  cacheSet(key, out);
  return out;
}

/**
 * Developer wallet history -- the headline signal. Answers "has this dev
 * rugged before?" with measurable numbers.
 */
export async function fetchGmgnDevHistory(devWallet, chain, log) {
  const c = gmgnChain(chain);
  if (!c || !_apiKey || !devWallet) return null;

  const key = `dev:${c}:${devWallet}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const j = await runCli(
    ['portfolio', 'created-tokens', '--chain', c, '--wallet', devWallet,
     '--order-by', 'token_ath_mc', '--direction', 'desc'],
    log
  );
  if (isTransient(j)) return null;                       // do not cache a non-answer
  if (!j || typeof j !== 'object') { cacheSet(key, null); return null; }

  const created = Number(j.inner_count);
  const stillOpen = Number(j.open_count);
  const ath = j.creator_ath_info || {};
  const tokens = Array.isArray(j.tokens) ? j.tokens : [];

  let survivalPct = null;
  if (j.open_ratio != null && Number.isFinite(Number(j.open_ratio))) {
    survivalPct = pctFromRate(j.open_ratio);
  } else if (Number.isFinite(created) && created > 0 && Number.isFinite(stillOpen)) {
    survivalPct = Number(((stillOpen / created) * 100).toFixed(2));
  }

  const out = {
    dev_tokens_created: Number.isFinite(created) ? created : null,
    dev_tokens_still_open: Number.isFinite(stillOpen) ? stillOpen : null,
    dev_survival_pct: survivalPct,
    dev_best_token_symbol: ath.token_symbol || null,
    dev_best_token_ath_mc: ath.ath_mc != null ? Number(ath.ath_mc) : null,
    dev_best_token_address: ath.ath_token || null,
    dev_recent_tokens: tokens.slice(0, 8).map(t => ({
      symbol: t.symbol,
      address: t.token_address,
      athMc: t.token_ath_mc != null ? Number(t.token_ath_mc) : null,
      mcap: t.market_cap != null ? Number(t.market_cap) : null,
      holders: t.holders ?? null,
      isOpen: !!t.is_open,
      launchpad: t.launchpad_platform || null,
      dexPaid: !!t.dexscr_ad,
      bundlerPct: t.bundler_rate != null ? pctFromRate(t.bundler_rate) : null,
      ctoFlag: !!t.cto_flag,
    })),
    dev_checked_at: new Date().toISOString(),
    // Lookup covering EVERY token in the response, not just the 8 shown.
    // dev_recent_tokens is ordered by ATH mcap and truncated for display, so
    // matching a CA against it failed for any token outside the creator's top
    // 8 -- which is most of them, and always the fresh low-mcap ones a signal
    // is actually about. Real DEX Paid then silently read as false.
    //
    // Prefixed with _ and stripped by the caller before this is merged into a
    // hit, so a 257-token creator doesn't bloat every card in signals.json.
    _token_extras: Object.fromEntries(
      tokens
        .filter(t => t && t.token_address)
        .map(t => [t.token_address, {
          dex_paid: !!t.dexscr_ad,
          bundler_pct: t.bundler_rate != null ? pctFromRate(t.bundler_rate) : null,
          cto_flag: !!t.cto_flag,
        }])
    ),
  };
  cacheSet(key, out);
  return out;
}

/**
 * Real DEX Paid + bundler concentration for one token, read out of its
 * creator's token list (the only place GMGN exposes dexscr_ad).
 */
export function extractTokenExtrasFromDevHistory(devHistory, ca) {
  if (!devHistory) return null;
  // Full map first; fall back to the display slice for a cached object built
  // before _token_extras existed.
  const fromMap = devHistory._token_extras && devHistory._token_extras[ca];
  if (fromMap) return { ...fromMap };
  if (!Array.isArray(devHistory.dev_recent_tokens)) return null;
  const match = devHistory.dev_recent_tokens.find(t => t.address === ca);
  if (!match) return null;
  return {
    dex_paid: match.dexPaid,
    bundler_pct: match.bundlerPct,
    cto_flag: match.ctoFlag,
  };
}

/**
 * Liquidity pool for one token.
 *
 * The reason this exists: DexScreener returns no `liquidity` object at all for a
 * bonding-curve pair, which on a live store was 212 of the 245 tokens showing a
 * blank Liquidity figure. `token pool` answers for every chain GMGN covers,
 * bonding curves included -- verified on both a pump.fun curve and a uniswap v3
 * pool on robinhood.
 *
 * Returns the RAW payload. Turning reserves into a number is a decision about
 * what liquidity means, and that decision lives in liquidity.js where it can be
 * tested without a network.
 *
 * BACKGROUND priority: nothing is waiting on this the way someone waits on
 * artwork, and the queue is shared with the KOL watcher.
 */
export async function fetchGmgnPool(ca, chain, log, { force = false } = {}) {
  // gmgnInfoChain, NOT gmgnChain. CHAIN_MAP is the SECURITY map and is narrow on
  // purpose -- widening it would start firing safety lookups on chains whose
  // safety data has never been verified. That reasoning does not apply to a
  // liquidity pool, which is a market-data reading with nothing to get wrong.
  //
  // Using the narrow map here made this function return null for ethereum,
  // robinhood, arc and stable without a single log line: verified against live
  // tokens, including USDT, which unquestionably has a pool. Four of seven
  // chains silently had no liquidity source at all.
  const c = gmgnInfoChain(chain);
  if (!c || !_apiKey) return null;

  const key = `pool:${c}:${ca}`;
  if (!force) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }

  const j = await runCli(['token', 'pool', '--chain', c, '--address', ca], log, GMGN_PRIORITY.BACKGROUND);
  if (isTransient(j)) return null;                       // do not cache a non-answer
  if (!j || typeof j !== 'object') { cacheSet(key, null); return null; }

  cacheSet(key, j);
  return j;
}

/**
 * Candles for one token over one window.
 *
 * This is how a call's PEAK is recovered. The scoreboard used to score a call by
 * what the token is worth now, so a token called at $10,587 that touched $21,018
 * and fell to $2,166 was recorded as a 0.20x loss. The per-candle `high` is the
 * run that actually happened, whether or not anyone was watching at the time.
 *
 * `resolution` is chosen by the caller from the window length (see
 * peak.js/klineResolution) rather than fixed: a three-week window at 1m is
 * ~30,000 candles, and a provider that truncates that would hand back the peak of
 * whichever slice arrived -- a wrong answer wearing the shape of a right one.
 *
 * Never cached. A window ending "now" is a different question every time it is
 * asked, and caching it would pin the peak to whenever it was first fetched.
 *
 * @returns {Array|null} [{ time: msEpoch, open, close, high, low, volume }]
 */
export async function fetchGmgnKline(ca, chain, log, { fromTs, toTs, resolution = '1h' } = {}) {
  // Same reasoning as fetchGmgnPool: candles are market data, not a safety
  // claim, so they use the wider map. The narrow one silently excluded
  // ethereum, robinhood, arc and stable.
  const c = gmgnInfoChain(chain);
  if (!c || !_apiKey) return null;
  if (!Number.isFinite(Number(fromTs)) || !Number.isFinite(Number(toTs))) return null;

  const j = await runCli([
    'market', 'kline', '--chain', c, '--address', ca,
    '--resolution', String(resolution),
    '--from', String(Math.floor(Number(fromTs))),
    '--to', String(Math.floor(Number(toTs))),
  ], log, GMGN_PRIORITY.BACKGROUND);

  if (isTransient(j) || !j) return null;
  const list = Array.isArray(j) ? j : (Array.isArray(j.list) ? j.list : null);
  return list && list.length ? list : null;
}
