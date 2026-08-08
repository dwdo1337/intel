import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';
import { HitStorePersistence } from './persistence.js';
import { fetchSafety, isSolanaAddress, fetchImageFromMetadata } from './safety.js';
import { configureGmgn, isGmgnConfigured, fetchGmgnSecurity, fetchGmgnDevHistory, extractTokenExtrasFromDevHistory, fetchGmgnTokenInfo, fetchGmgnTokenWallets, gmgnHolderChain, WALLET_PAGE } from './gmgn.js';
import { startKolWatcher, getKolActivity, kolWatcherStatus } from './kol.js';
import { startFlowWatcher, getFlow, flowWatcherStatus } from './flow.js';
import { passesAlertFilters, sanitizeThresholds } from './alert-filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The React build sits at ../client/dist from the SOURCE (server/), and at the
// same relative place from the esbuild BUNDLE (dist-server/) — both are one
// level below the app root, so this resolves in either. Stated explicitly
// because "the UI is served from a sibling of the server" is precisely the
// assumption that broke when asarUnpack first moved server/ (see AGENTS.md:
// express served nothing and the window rendered black).
const STATIC_DIR = join(__dirname, '..', 'client', 'dist');

// WRITABLE ROOT.
// In a packaged build the server runs from inside app.asar, which is
// read-only -- writing config.json there fails, so a Telegram login could
// never be saved and the signal store could never persist. Electron passes a
// real writable directory (its userData path) via INTEL_DATA_DIR. In dev the
// variable is unset and everything stays in the repo, as before.
const DATA_ROOT = process.env.INTEL_DATA_DIR || join(__dirname, '..');
const CONFIG_PATH = join(DATA_ROOT, 'config.json');
const DATA_DIR = join(DATA_ROOT, 'data');
const STORE_PATH = join(DATA_DIR, 'signals.json');
mkdirSync(DATA_DIR, { recursive: true });
const PORT = process.env.PORT || 5050;

const app = express();

// ALLOWED ORIGINS
// The packaged app serves the UI from the backend itself, so the renderer's
// origin is http://127.0.0.1:<PORT> -- NOT the Vite dev origin. Allowing only
// the dev origin silently broke Socket.IO in the packaged build: the handshake
// was rejected, the live feed fell back to the 15s poll, and toasts kept
// working only because main.cjs connects from Node (which sends no Origin
// header), which made the breakage very easy to miss.
//
// Requests with no Origin (Electron's Node-side socket, curl, the app's own
// server-rendered loads) are allowed. Anything else must match this list, so a
// random website still cannot reach localhost:5050.
const CORS_ORIGINS = [
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) : []),
];
function corsOrigin(origin, callback) {
  if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
  callback(new Error('origin not allowed'));
}
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());
const server = createServer(app);
const io = new SocketIOServer(server, { path: '/socket.io', cors: { origin: CORS_ORIGINS, credentials: true } });

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { telegram: {}, discord: {}, gmgn: {} };
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { log('system', 'config parse failed', { error: e.message }); return { telegram: {}, discord: {}, gmgn: {} }; }
}
function saveConfig(cfg) { writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
let config = loadConfig();
configureGmgn(config.gmgn?.api_key);

const MENTIONS_MAX = 30;
const LOGS = [];
const MAX_LOGS = 250;

function log(category, message, data) {
  const entry = { t: new Date().toISOString(), c: category, m: String(message), d: data || null };
  LOGS.push(entry);
  if (LOGS.length > MAX_LOGS) LOGS.shift();
  console.log(`[${category}]`, message, data ? JSON.stringify(data) : '');
  io.emit('log', entry);
}

// ── Persistent signal store ──────────────────────────────────────────────
// Restored from disk on boot so a restart/crash doesn't wipe signal
// history -- critically including entry_mcap_usd, which anchors every
// token's multiplier. Losing that silently reset all performance to 1x.
const persistence = new HitStorePersistence(STORE_PATH, log);
const restored = persistence.load();
const HITS = restored.hits;
const HIT_ORDER = restored.order;

function persist() { persistence.save(HITS, HIT_ORDER); }

app.get('/api/logs', (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
  res.json(LOGS.slice(-limit));
});

// ── Echo bots ───────────────────────────────────────────────────────────
// Rick, Phanes and friends auto-reply with the same CA moments after a human
// posts it. Verified in real data: a human called "The First Crypto Dog" at
// 10:02:11 and Rick echoed the identical CA 1.2s later, with Phanes following.
// Counting those as re-calls made almost every token show "called 2x" or
// "3x" within seconds of a single genuine call, which destroyed the meaning
// of the follow-up signal entirely.
//
// These names are matched case-insensitively as substrings, so Phanes_bot,
// PhanesGoldBot and RickBot all match.
// Matched case-insensitively as SUBSTRINGS, so Phanes_bot, PhanesGoldBot,
// RickBot etc. all match. Every name here was observed re-posting a CA
// seconds after a human in the same chat.
const DEFAULT_ECHO_BOTS = [
  'rick', 'phanes', 'tokenscan', 'dexscreener', 'soul_sniper',
  'bubblemaps', 'safeguard', 'maestro', 'banana', 'trojan',
  'photon', 'bullx', 'gmgn', 'pepeboost', 'sol_trending',
];

function isEchoBot(author, extra = []) {
  const a = (author || '').toLowerCase();
  if (!a) return false;
  const list = [...DEFAULT_ECHO_BOTS, ...extra.map(x => String(x).toLowerCase())];
  return list.some(bot => bot && a.includes(bot));
}

/** Should this mention count as a genuine NEW call of an already-seen CA?
 *
 *  A real follow-up means someone ELSE, or somewhere else, called it again --
 *  not a bot echoing it back, and not the same person posting twice in a row.
 */
function isGenuineFollowup(hit, mention, ignoredBots) {
  if (isEchoBot(mention.author, ignoredBots)) return false;

  const prior = hit.mentions || [];
  // Ignore bot echoes when deciding who "already" called it.
  const humanPrior = prior.filter(m => !isEchoBot(m.author, ignoredBots));
  if (humanPrior.length === 0) return false; // the original call was a bot echo

  // DISTINCT CALLER RULE -- the same person posting the same CA again is a
  // repeat regardless of which chat it lands in. Someone broadcasting to
  // five of their own groups is one opinion, not five calls. A follow-up
  // must come from a genuinely different person.
  const sameAuthor = humanPrior.some(
    m => (m.author || '').toLowerCase() === (mention.author || '').toLowerCase()
  );
  if (sameAuthor) return false;

  return true;
}

function upsertHit(ca, chain, partial, mention) {
  let hit = HITS.get(ca);
  const now = mention.detected_at || new Date().toISOString();
  if (!hit) {
    hit = {
      ca, chain, token_name: '', token_symbol: '', image_url: null, header_url: null,
      launchpad: null, dex: null, pair_label: null,
      mcap_usd: null, liquidity_usd: null, price_usd: null, volume_24h_usd: null,
      price_change_5m: null, price_change_1h: null, price_change_24h: null,
      pair_created_at: null, pair_url: null, twitter_url: null, website_url: null, telegram_url: null,
      dev_holder_pct: null, rug_risk_pct: null, is_honeypot: null, lp_burned_pct: null,
      is_mintable: null, is_freezable: null, is_contract_renounced: null,
      transfer_fee_pct: null, buy_tax_pct: null, sell_tax_pct: null,
      buys_24h: null, sells_24h: null, top10_holder_pct: null, holder_count: null,
      dex_paid: null, dex_boosts: null, dex_paid_checked_at: null,
      kol_count: null, smart_wallet_count: null,
      entry_mcap_usd: null, multiplier: null,
      // SCAN SNAPSHOT -- frozen at first enrichment, never overwritten.
      scan_mcap_usd: null, scan_liquidity_usd: null, scan_volume_24h_usd: null,
      scan_price_usd: null, scan_at: null,
      // Live readings, only set by an explicit user refresh.
      live_mcap_usd: null, live_liquidity_usd: null, live_volume_24h_usd: null,
      live_price_usd: null, refreshed_at: null,
      // Safety fields (RugCheck, Solana only). null == unknown, never "safe".
      rugged: null, dev_wallet: null, insider_holder_count: null,
      graph_insiders_detected: null, total_lp_providers: null,
      safety_risks: null, safety_source: null, safety_checked_at: null,
      mentions: [], is_followup: false, source: mention.source, chat_name: mention.chat_name,
      author: mention.author, last_mentioned_at: now, message_text: mention.text || '',
    };
    HITS.set(ca, hit);
    HIT_ORDER.unshift(ca);
  } else {
    // A follow-up means a genuinely DIFFERENT person called it again.
    //
    // This used to flag every repeat unconditionally, so one person posting
    // the same CA twice marked the token "called again" and put it in the
    // Called-again tab with a single caller on the card -- contradicting the
    // distinct-caller rule the whole feed is built on. isGenuineFollowup was
    // written for exactly this and had simply never been wired up. Checked
    // BEFORE the new mention is appended, which is what it expects.
    const ignoredAuthors = (config.filters && config.filters.ignored_authors) || [];
    if (isGenuineFollowup(hit, mention, ignoredAuthors)) hit.is_followup = true;
    hit.last_mentioned_at = now;
    // Move the CA back to the top of the feed on every repeat mention.
    const idx = HIT_ORDER.indexOf(ca);
    if (idx > 0) {
      HIT_ORDER.splice(idx, 1);
      HIT_ORDER.unshift(ca);
    }
  }
  hit.mentions.push(mention);
  if (hit.mentions.length > MENTIONS_MAX) hit.mentions = hit.mentions.slice(-MENTIONS_MAX);
  Object.assign(hit, partial);
  // Record entry mcap once, on the first enrichment that actually has one.
  if (hit.entry_mcap_usd == null && hit.mcap_usd != null && hit.mcap_usd > 0) {
    hit.entry_mcap_usd = hit.mcap_usd;
  }
  // Freeze the full snapshot the first time we have real numbers. Later
  // enrichments must NOT move these -- the card is meant to show what was
  // true when the call fired, not a silently drifting live value.
  if (hit.scan_at == null && hit.mcap_usd != null) {
    hit.scan_mcap_usd = hit.mcap_usd;
    hit.scan_liquidity_usd = hit.liquidity_usd;
    hit.scan_volume_24h_usd = hit.volume_24h_usd;
    hit.scan_price_usd = hit.price_usd;
    hit.scan_at = new Date().toISOString();
  }
  // Compute multiplier against the latest mcap.
  if (hit.entry_mcap_usd != null && hit.mcap_usd != null && hit.entry_mcap_usd > 0) {
    hit.multiplier = hit.mcap_usd / hit.entry_mcap_usd;
  }
  return hit;
}
function recent(limit) { return HIT_ORDER.slice(0, limit).map(ca => HITS.get(ca)).filter(Boolean); }

const SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/g;

/** Strict CA shape validation -- used to reject junk at the API boundary. */
function isValidCA(ca) {
  if (typeof ca !== 'string') return false;
  return /^0x[a-fA-F0-9]{40}$/.test(ca) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca);
}

/**
 * Canonical form of a contract address, used for EVERY key and lookup.
 *
 * EVM addresses are case-insensitive: `0xABC…` and `0xabc…` are the same
 * contract, and people paste both (EIP-55 checksummed from a block explorer,
 * lowercase from a bot). Keying the store on the raw string therefore created
 * TWO records for one token -- verified in live data: POOCOIN, ASSTEROID,
 * PRAY and four others each existed twice, with their mentions split, two
 * different entry market caps (so at least one multiplier was wrong), and a
 * duplicate toast per call.
 *
 * Solana mints are base58 and ARE case-sensitive -- lowercasing one would
 * corrupt it into a different (invalid) address. Only EVM is normalised.
 */
function normalizeCA(ca) {
  if (typeof ca !== 'string') return ca;
  return /^0x[a-fA-F0-9]{40}$/.test(ca) ? ca.toLowerCase() : ca;
}

function extractCAs(text, hintChain) {
  if (!text) return [];
  const out = [];
  // Dedupe: a call message almost always contains the CA more than once
  // (plain text + a pump.fun/dexscreener link). Without this, ONE message
  // registered as two or more separate mentions, so a brand-new token showed
  // "called 2x"/"called 4x" the instant it first appeared.
  const seen = new Set();
  for (const raw of text.match(EVM_RE) || []) {
    const m = normalizeCA(raw);          // 0xABC… and 0xabc… are one token
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ ca: m, chain: 'evm-unknown' });
  }
  for (const m of text.match(SOL_RE) || []) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ ca: m, chain: 'solana' });
  }
  if (hintChain) {
    const normalized = hintChain.toLowerCase();
    for (const o of out) {
      if (o.chain === 'evm-unknown' && normalized !== 'solana') o.chain = normalized;
    }
  }
  return out;
}

/**
 * Identify which launchpad a token came from.
 *
 * Two independent detection routes, because they work differently per chain:
 *
 * 1. MINT SUFFIX (Solana only). pump.fun and letsbonk.fun vanity-grind their
 *    mint addresses to end in "pump"/"bonk". Exact and reliable.
 *
 * 2. DEX ID (every chain). DexScreener reports `dexId` per pair. When a
 *    launchpad runs its OWN AMM, that dexId identifies it directly --
 *    verified live: a BSC token returns dexId "flapsh" (Flapstock).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * Launchpads that deploy onto a SHARED AMM are not detectable this way. A
 * Robinhood-chain token returns dexId "uniswap" -- which tells us the AMM,
 * not whether it launched via hood.fun, NOXA or PONS, since all of them
 * deploy to Uniswap. Guessing a launchpad from a shared dexId would invent
 * a fact. Those stay null (= unknown) and their filter pills stay disabled.
 */
function detectLaunchpad(ca, chainId, dexId, allPairs) {
  const chain = (chainId || '').toLowerCase();
  const dex = (dexId || '').toLowerCase();
  const addr = (ca || '').toLowerCase();

  // ── route 1: Solana mint suffix ──────────────────────────────────────
  if (chain === 'solana') {
    if (addr.endsWith('pump')) return 'pump.fun';
    if (addr.endsWith('bonk')) return 'letsbonk.fun';
  }

  // ── route 2: launchpad-operated AMMs, keyed by DexScreener dexId ─────
  // Only entries where the dexId belongs to the launchpad ITSELF. Generic
  // AMMs (uniswap, pancakeswap, raydium, orca, meteora...) are absent on
  // purpose -- they carry no launchpad information.
  const DEX_TO_LAUNCHPAD = {
    // Solana
    pumpswap: 'pump.fun',
    pumpfun: 'pump.fun',
    launchlab: 'Raydium LaunchLab',
    moonshot: 'Moonshot',
    bags: 'Bags',
    jupiterstudio: 'Jupiter Studio',
    // BSC / BNB Chain -- dexIds verified against live DexScreener data.
    // 'flapsh' is Flap (flap.sh), NOT Flapstock (a Robinhood-chain platform).
    flapsh: 'Flap',
    flap: 'Flap',
    fourmeme: 'Four.meme',
    'four-meme': 'Four.meme',
    grafun: 'GraFun',
    bakeryswap: 'BakerySwap',
    // Base / Ethereum
    clanker: 'Clanker',
    zora: 'Zora',
  };
  if (DEX_TO_LAUNCHPAD[dex]) return DEX_TO_LAUNCHPAD[dex];

  // The pair handed in is the DEEPEST one, which for a graduated token is
  // the AMM it migrated to -- not the launchpad. The launchpad's own pair
  // still exists with far less liquidity, so check them all before giving up.
  if (Array.isArray(allPairs)) {
    for (const p of allPairs) {
      const d = (p && p.dexId ? String(p.dexId) : '').toLowerCase();
      if (DEX_TO_LAUNCHPAD[d]) return DEX_TO_LAUNCHPAD[d];
    }
  }

  return null; // unknown, never guessed
}

/**
 * Is this token's DexScreener profile actually paid for?
 *
 * The app was reporting "DEX Paid · No" on tokens that HAVE paid, because
 * `dex_paid` defaulted to `false` and was only ever filled by the on-demand
 * dev-history call -- which almost never runs. A default was being displayed
 * as a finding.
 *
 * This is the authoritative source: DexScreener's own orders endpoint. An
 * `approved` order of type `tokenProfile` is exactly what "DEX paid" means.
 * Also returns boost count, which is a separate paid product.
 *
 * Returns null (= unknown) on any failure, never false, because "we could not
 * check" and "they did not pay" are different facts.
 */
async function fetchDexPaid(ca, chainId) {
  if (!ca || !chainId) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/orders/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(ca)}`);
    if (!res.ok) return null;
    const j = await res.json();
    const orders = Array.isArray(j?.orders) ? j.orders : (Array.isArray(j) ? j : null);
    if (!orders) return null;
    const approved = orders.filter(o => o && o.status === 'approved');
    return {
      dex_paid: approved.some(o => o.type === 'tokenProfile'),
      dex_paid_types: [...new Set(approved.map(o => o.type).filter(Boolean))],
      dex_boosts: Array.isArray(j?.boosts) ? j.boosts.length : null,
      dex_paid_checked_at: new Date().toISOString(),
    };
  } catch (e) {
    log('enrichment', 'DEX paid check failed', { ca, error: e.message });
    return null;
  }
}

async function enrichDexscreener(ca) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    return {
      chain: p.chainId,
      token_name: p.baseToken?.name || '',
      token_symbol: p.baseToken?.symbol || '',
      image_url: p.info?.imageUrl || null,
      header_url: p.info?.header || null,
      dex: p.dexId || null,
      pair_label: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      mcap_usd: p.marketCap ?? p.fdv ?? null,
      liquidity_usd: p.liquidity?.usd ?? null,
      price_usd: p.priceUsd ? Number(p.priceUsd) : null,
      volume_24h_usd: p.volume?.h24 ?? null,
      price_change_5m: p.priceChange?.m5 ?? null,
      price_change_1h: p.priceChange?.h1 ?? null,
      price_change_24h: p.priceChange?.h24 ?? null,
      pair_created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
      pair_url: p.url || null,
      twitter_url: (p.info?.socials || []).find(s => s.type === 'twitter')?.url || null,
      website_url: (p.info?.websites || [])[0]?.url || null,
      telegram_url: (p.info?.socials || []).find(s => s.type === 'telegram')?.url || null,
      buys_24h: p.txns?.h24?.buys ?? null,
      sells_24h: p.txns?.h24?.sells ?? null,
      launchpad: detectLaunchpad(ca, p.chainId, p.dexId, pairs),
    };
  } catch (e) {
    log('enrichment', 'dexscreener enrich failed for ' + ca, { error: e.message });
    return null;
  }
}

async function handleMention({ ca, chain, source, chat_name, chat_id_hint, author, text, dex_paid, kol_count, smart_wallet_count, message_id, chat_key }) {
  if (!isValidCA(ca)) return;
  ca = normalizeCA(ca);

  // PER-GROUP SENDER RULES
  // Applied per source chat: an allow-list narrows a group to specific
  // callers, a block-list silences individuals. Block always wins over allow,
  // because the point of blocking someone is to silence them unconditionally.
  {
    const rules = (config.filters && config.filters.chat_rules) || {};
    // Looked up most specific first: this channel, then the SERVER it belongs
    // to. A Discord server is two levels deep, so "only take calls from these
    // people" has to be expressible once for the whole server rather than
    // retyped into all 400 of its channels -- while a channel-specific rule
    // still wins where one exists.
    const guildId = DC_CHANNEL_GUILD.get(String(chat_id_hint || '')) || null;
    const r = rules[String(chat_name)]
      || rules[String(chat_id_hint || '')]
      || (guildId ? (rules[guildId] || rules[DC_GUILD_NAMES.get(guildId)]) : null)
      || null;
    if (r) {
      const a = (author || '').toLowerCase().replace(/^@/, '');
      const allowed = (r.allowed || []).map(x => String(x).toLowerCase().replace(/^@/, ''));
      const blocked = (r.blocked || []).map(x => String(x).toLowerCase().replace(/^@/, ''));
      if (blocked.length && blocked.includes(a)) {
        log('signal', 'Blocked sender', { author, chat: chat_name });
        return;
      }
      if (allowed.length && !allowed.includes(a)) {
        log('signal', 'Sender not in allow-list', { author, chat: chat_name });
        return;
      }
    }
  }

  // ECHO BOT GUARD -- Rick / Phanes and friends re-post every CA moments
  // after a human does, on BOTH Telegram and Discord. Previously they could
  // still CREATE a signal (and fire a toast) whenever they happened to be
  // first, and their echoes kept bumping cards. They are scanners reacting to
  // people, never an original call, so their messages are dropped outright.
  {
    const ignored = (config.filters && config.filters.ignored_authors) || [];
    if (isEchoBot(author, ignored)) {
      log('signal', 'Ignored echo bot', { author, ca });
      return;
    }
  }
  const mention = { source, chat_name, author, detected_at: new Date().toISOString(), text };
  const isNew = !HITS.has(ca);
  log('signal', `Mention ${isNew ? 'new' : 'repeat'}`, { ca, source, author, chat: chat_name });
  const enrichment = await enrichDexscreener(ca);
  if (!enrichment && isNew) { log('enrichment', 'No DexScreener pair, ignored', { ca }); return; }
  if (enrichment) {
    if (dex_paid != null) enrichment.dex_paid = dex_paid;
    if (kol_count != null) enrichment.kol_count = kol_count;
    if (smart_wallet_count != null) enrichment.smart_wallet_count = smart_wallet_count;
  }
  const hit = upsertHit(ca, enrichment?.chain || chain, enrichment || {}, mention);

  // Remember which message carried this CA, so replies to it can be tied
  // back to the token later.
  indexMessage(chat_key, message_id, ca);

  // Attach notable-wallet counts BEFORE the signal is emitted, so the desktop
  // toast can show them on the alert itself rather than a dash. The watcher
  // updates them again later if new trades land; this just uses what is
  // already indexed at the moment of the call.
  {
    const seen = getKolActivity(ca, hit.chain, hit.scan_at || hit.last_mentioned_at);
    if (seen) {
      // The TOTAL seen in the window, not the since-the-call slice. At the
      // instant an alert fires nothing can have happened "since the call"
      // yet, so scoping the toast number that way guaranteed a zero. What a
      // trader wants on the alert is "are notable wallets already in this?".
      hit.kol_count = seen.kol.count;
      hit.smart_wallet_count = seen.smart.count;
      hit.kol_already_in = seen.kol.alreadyIn + seen.smart.alreadyIn;
    }
  }

  log('enrichment', 'Hit enriched', { ca, symbol: hit.token_symbol, name: hit.token_name, mcap: hit.mcap_usd });
  // `_notify` rides along on the socket payload only -- it is a routing hint
  // for the Electron toast layer, not token data, so it is never persisted.
  // `ca` is the ALERT channel (the Electron layer raises a toast for it);
  // `ca_update` only refreshes what is already on screen.
  //
  // A repeat mention used to be `ca_update` unconditionally, so a token you
  // explicitly starred could be called five more times in your chats and you
  // would never hear about it -- the one set of tokens you said you cared about
  // was the one set that could not alert you twice.
  if (isNew) {
    emitAlert(hit, 'new');
  } else if (hit.watched) {
    // Carry the mention that TRIGGERED this alert. Without it the toast shows
    // the ORIGINAL call -- the author and room from days ago -- which is the
    // opposite of what a "called again" alert is for. You need to know who just
    // called it, where, and what they said.
    emitAlert(hit, 'watchlist-mention', {
      author: mention.author,
      source: mention.source,
      chat_name: mention.chat_name,
      text: mention.text || '',
      at: mention.detected_at,
      // How many DISTINCT rooms it has now been called in -- the spread signal.
      room_count: new Set(
        hit.mentions
          .filter(m => !isEchoBot(m.author, (config.filters && config.filters.ignored_authors) || []))
          .map(m => (m.source || '') + ' ' + (m.chat_name || ''))
      ).size,
    });
  } else {
    io.emit('ca_update', hit);
  }
  persist();

  // Safety enrichment runs AFTER the hit is already on screen -- it's a
  // second network call and must never delay the signal itself. Solana
  // only; EVM hits keep null safety fields (shown as "unknown" in the UI,
  // never as a passing score).
  enrichSafetyAsync(ca, hit.chain);
}

/** Fire-and-forget enrichment for safety + dev history. Emits ca_update
 *  as each provider lands, so the card fills in progressively rather than
 *  waiting on the slowest call.
 *
 *  Provider order and why:
 *    1. RugCheck (Solana only) -- free, keyless, gives real holder_count,
 *       insider flags and the creator wallet. Preferred on Solana.
 *    2. GMGN -- the only source we have for EVM safety (bsc/base). On
 *       Solana it only fills gaps RugCheck left null, never overwrites.
 *    3. GMGN dev history -- needs a creator wallet, which today only
 *       RugCheck supplies, so this is Solana-only in practice. EVM
 *       deployer lookup would need a block-explorer call we don't do yet.
 *
 *  Every stage is fail-open: a provider being down, rate limited, or
 *  simply not covering this chain leaves fields null (= unknown) and never
 *  blocks or drops the signal.
 */
async function enrichSafetyAsync(ca, chain, { force = false } = {}) {
  const hit = HITS.get(ca);
  if (!hit) return;
  const chainName = chain || hit.chain;

  // GAP-FILL vs RE-SCAN.
  // At scan time every stage below is skipped when the field it produces is
  // already populated -- cheapest possible enrichment, and correct, because
  // nothing has had time to change.
  //
  // That guard was ALSO the only path a manual refresh had, which made refresh
  // structurally unable to fix a token whose enrichment failed the first time.
  // Observed live on BUDDY (bsc): GMGN security never landed at scan, so
  // safety_source/top10/honeypot stayed null -- and every refresh afterwards
  // skipped the stage precisely BECAUSE they were null-and-already-visited,
  // leaving the card permanently blank with no way to recover short of
  // deleting the record. `force` re-asks every provider and overwrites.
  const wants = (currentValue) => force || currentValue == null;

  // ---- 0a. Is the DexScreener profile paid for? -----------------------
  // Cheap, keyless, and from the provider that actually knows. Runs before the
  // GMGN stages because it needs nothing from them.
  if (wants(hit.dex_paid_checked_at)) {
    const paid = await fetchDexPaid(ca, hit.chain);
    if (paid) {
      Object.assign(hit, paid);
      log('enrichment', 'DEX paid checked', { ca, symbol: hit.token_symbol, paid: paid.dex_paid });
      io.emit('ca_update', hit);
      persist();
    }
  }

  // ---- 0. ARTWORK FIRST, when DexScreener gave us none ----------------
  // Ordering matters more than it looks. Every GMGN call shares one serial
  // queue with a 1.2s floor, and that queue also carries the KOL watcher and
  // four wallet lookups per signal. With the image fetched third, a brand-new
  // card sat on grey initials for many seconds while less visible data went
  // first. The picture is the fastest thing a person recognises a token by,
  // so it now jumps the queue -- one call, only when actually missing.
  if (!hit.image_url) {
    try {
      const early = await fetchGmgnTokenInfo(ca, chainName, log, { force });
      if (early && early.image_url) {
        hit.image_url = early.image_url;
        if (!hit.header_url && early.header_url) hit.header_url = early.header_url;
        if (hit.holder_count == null && early.holder_count != null) hit.holder_count = early.holder_count;
        log('enrichment', 'Artwork attached', { ca, symbol: hit.token_symbol });
        io.emit('ca_update', hit);
        persist();
      }
    } catch (e) {
      log('error', 'Early artwork fetch threw', { ca, error: e.message });
    }
  }

  // ---- 1. RugCheck (Solana) ------------------------------------------
  let devWallet = null;
  if (isSolanaAddress(ca)) {
    try {
      const safety = await fetchSafety(ca, log, { force });
      if (safety) {
        // image_url is a FALLBACK only. DexScreener's curated image wins when
        // it exists; RugCheck's token-metadata image fills the gap for the
        // many pump.fun launches DexScreener has no picture for.
        const { image_url: metadataImage, metadata_uri: metadataUri, ...safetyFields } = safety;
        Object.assign(hit, safetyFields);
        if (metadataUri) hit._metadata_uri = metadataUri;
        if (!hit.image_url && metadataImage) {
          hit.image_url = metadataImage;
          log('enrichment', 'Image recovered from token metadata', { ca, symbol: hit.token_symbol });
        }
        devWallet = safety.dev_wallet || null;
        log('enrichment', 'RugCheck safety attached', {
          ca, risk: safety.rug_risk_pct, holders: safety.holder_count, top10: safety.top10_holder_pct,
        });
        io.emit('ca_update', hit);
        persist();
      }
    } catch (e) {
      log('error', 'RugCheck enrichment threw', { ca, error: e.message });
    }
  }

  if (!isGmgnConfigured()) return;

  // ---- 2. GMGN security ----------------------------------------------
  // On EVM this is the ONLY safety source. On Solana it is gap-fill only:
  // RugCheck's numbers are cross-checked and its holder_count is real,
  // whereas GMGN's top-10 uses a different (LP-excluding) methodology, so
  // overwriting would silently change the meaning of a displayed number.
  try {
    const g = await fetchGmgnSecurity(ca, chainName, log, { force });
    if (g) {
      let changed = false;
      for (const [k, v] of Object.entries(g)) {
        if (v === null || v === undefined) continue;
        if (k === 'safety_source' || k === 'safety_checked_at') continue;
        // On a forced re-scan GMGN's answer wins outright, EXCEPT on Solana
        // where RugCheck already supplied the field. That exception is not
        // caution about staleness -- the two providers measure top-10
        // concentration differently (GMGN excludes LP), so overwriting would
        // silently change what the displayed number MEANS rather than update it.
        const rugcheckOwnsIt = isSolanaAddress(ca)
          && String(hit.safety_source || '').includes('rugcheck');
        if (force && !rugcheckOwnsIt) {
          if (hit[k] !== v) { hit[k] = v; changed = true; }
        } else if (hit[k] === null || hit[k] === undefined) {
          hit[k] = v; changed = true;
        }
      }
      if (force) {
        hit.safety_checked_at = g.safety_checked_at;
        changed = true;
      }
      if (hit.safety_source == null) {
        hit.safety_source = g.safety_source;
        hit.safety_checked_at = g.safety_checked_at;
        changed = true;
      } else if (hit.safety_source && !String(hit.safety_source).includes('gmgn')) {
        hit.safety_source = `${hit.safety_source}+gmgn`;
        changed = true;
      }
      if (changed) {
        log('enrichment', 'GMGN safety attached', {
          ca, chain: chainName, top10: g.top10_holder_pct, honeypot: g.is_honeypot,
        });
        io.emit('ca_update', hit);
        persist();
      }
    }
  } catch (e) {
    log('error', 'GMGN security threw', { ca, error: e.message });
  }

  // ---- 3. Token metadata: the only image source that covers EVM --------
  // Only called when something is actually missing, so a token DexScreener
  // already gave us artwork for costs nothing. Holder count is gap-filled
  // too: it was showing "EVM: unavailable" on every BSC/Base/Robinhood card
  // because RugCheck, its only source until now, is Solana-only.
  const needsImage = !hit.image_url;
  // Holder count is a live measurement, not an identity -- on a refresh it is
  // re-read even when we already have one, because "351 holders" going stale
  // is exactly the kind of wrong number this refresh exists to correct.
  const needsHolders = force || hit.holder_count == null;
  if (needsImage || needsHolders || force) {
    try {
      const info = await fetchGmgnTokenInfo(ca, chainName, log, { force });
      if (info) {
        let changed = false;
        if (needsImage && info.image_url) { hit.image_url = info.image_url; changed = true; }
        if (!hit.header_url && info.header_url) { hit.header_url = info.header_url; changed = true; }
        if (needsHolders && info.holder_count != null && hit.holder_count !== info.holder_count) {
          hit.holder_count = info.holder_count; changed = true;
        }
        if ((force || hit.image_dup_count == null) && info.image_dup_count != null) {
          hit.image_dup_count = info.image_dup_count;
          changed = true;
        }
        if (changed) {
          log('enrichment', 'GMGN token info attached', {
            ca, chain: chainName, image: !!info.image_url, holders: info.holder_count,
          });
          io.emit('ca_update', hit);
          persist();
        }
      }
    } catch (e) {
      log('error', 'GMGN token info threw', { ca, error: e.message });
    }
  }

  // ---- 3b. Straight from the token's own metadata ---------------------
  // Every provider above serves a COPY of the artwork and each has gaps:
  // DexScreener only for paid profiles, RugCheck only what it has cached,
  // GMGN only what it has indexed. The metadata JSON is what the launchpad
  // itself renders from, so it is the one source that is right by definition.
  // Reached only when all three came back empty, which keeps it to roughly a
  // couple of tokens an hour rather than a fetch per signal.
  if (!hit.image_url && hit._metadata_uri) {
    try {
      const fromSource = await fetchImageFromMetadata(hit._metadata_uri, log);
      if (fromSource) {
        hit.image_url = fromSource.image_url;
        if (!hit.header_url && fromSource.header_url) hit.header_url = fromSource.header_url;
        log('enrichment', 'Artwork recovered from token metadata', {
          ca, symbol: hit.token_symbol,
        });
        io.emit('ca_update', hit);
        persist();
      }
    } catch (e) {
      log('error', 'Metadata artwork fetch threw', { ca, error: e.message });
    }
  }

  // ---- 4. Who is actually holding it, right now -----------------------
  // Point-in-time holder tags, as opposed to the watcher's rolling trade
  // window. This is the only way to see a KOL who opened a position before
  // the app was running and is sitting on it quietly -- which is exactly the
  // case a trader cares about when an alert fires.
  //
  // Cost is 4 GMGN calls per NEW signal. That looked expensive until measured
  // against the KOL watcher, which spends ~600 calls/hour; at the observed
  // signal rate this is well under 10% of that. Follow-ups skip it because the
  // answer is already on the hit and the 5-minute cache would serve it anyway.
  await attachWalletExposure(hit, chainName, { force });

  // ---- 5. Dev history is deliberately NOT fetched here ----------------
  // It is the most expensive GMGN call and it only matters when someone is
  // actually looking at the token. Firing it per-signal burned the rate
  // limit (which escalates: retrying during cooldown extends the ban up to
  // 5 minutes), starving the cheap security lookups that every card needs.
  // It is exposed on-demand via GET /api/token/:chain/:ca/dev instead, and
  // cached per DEV WALLET so many tokens from the same creator cost one call.
}
// ── Replies to a call ───────────────────────────────────────────────────
// `${chatKey}:${messageId}` -> ca. Built as calls are detected, so that a
// later message replying to one can be tied back to the token it is about.
//
// The reply's OWN id is added to the index too, which is what makes a whole
// thread work: A calls a CA, B replies to A, C replies to B -- C is still
// talking about the same token, and without chaining we would only ever catch
// the first level.
const MSG_INDEX = new Map();
const MSG_INDEX_MAX = 8000;
const REPLIES_MAX = 40;

function indexMessage(chatKey, messageId, ca) {
  if (!chatKey || !messageId || !ca) return;
  const k = `${chatKey}:${messageId}`;
  if (MSG_INDEX.has(k)) return;
  MSG_INDEX.set(k, ca);
  // Map preserves insertion order, so the oldest entry is the first key.
  if (MSG_INDEX.size > MSG_INDEX_MAX) MSG_INDEX.delete(MSG_INDEX.keys().next().value);
}

/** Did this message reply to (or continue a thread from) a tracked call?
 *  `refIds` are every id worth checking: the direct reply target, a Discord
 *  thread's parent, a Telegram topic root. */
function handleReply({ chatKey, refIds, messageId, author, text, source, chatName, viaTopic }) {
  if (!chatKey || !Array.isArray(refIds)) return false;

  // Bots reply to calls constantly (Rick posting stats under every CA). They
  // are silenced here for the same reason they are silenced as callers: a
  // scanner reacting is not a person reacting.
  const ignored = (config.filters && config.filters.ignored_authors) || [];
  if (isEchoBot(author, ignored)) return false;

  let ca = null;
  for (const id of refIds) {
    if (!id) continue;
    const found = MSG_INDEX.get(`${chatKey}:${id}`);
    if (found) { ca = found; break; }
  }
  if (!ca) return false;

  const hit = HITS.get(ca);
  if (!hit) return false;

  const body = String(text || '').trim();
  if (!body) return false;                    // a bare sticker/image tells us nothing

  if (!Array.isArray(hit.replies)) hit.replies = [];
  hit.replies.push({
    author: author || 'unknown',
    text: body.slice(0, 400),
    at: new Date().toISOString(),
    source, chat_name: chatName,
    via_topic: !!viaTopic,
  });
  if (hit.replies.length > REPLIES_MAX) hit.replies = hit.replies.slice(-REPLIES_MAX);

  // Chain: replies to THIS reply are still about the same token.
  indexMessage(chatKey, messageId, ca);

  log('signal', 'Reply to call', { ca, symbol: hit.token_symbol, author, replies: hit.replies.length });
  io.emit('ca_update', hit);
  persist();
  return true;
}

/**
 * Who holds this token right now, by wallet reputation.
 *
 * Two tags, kept separate because they answer different questions:
 *   renowned    -- KOLs. Public influencers; social signal.
 *   smart_degen -- Smart money. Proven profitable; alpha signal.
 *
 * Only wallets with a LIVE POSITION are counted. GMGN's holders endpoint
 * returns everyone who has traded the token, with balance 0 for those who
 * exited, so an unfiltered count reports people who bought and dumped as
 * "holding".
 *
 * `bundler` and `sniper` were removed 2026-08-03. Both saturated the 50-wallet
 * page on nearly every token, so the count described the fetch limit rather
 * than the token, and the share-of-supply figure only covered the wallets that
 * fit on that page. Dropping them also halves the GMGN calls per signal.
 */
async function attachWalletExposure(hit, chainName, { force = false } = {}) {
  if (!isGmgnConfigured()) return false;
  // Base and Ethereum have no holder data at GMGN -- they return an empty list
  // for every token rather than an error. Bail out before spending four calls
  // on an answer that is structurally always []. `wallets_checked_at` stays
  // unset, so the UI treats it as unknown and renders no wallet block, rather
  // than showing a measured "0 KOL, 0 smart money" that was never measured.
  if (!gmgnHolderChain(chainName || hit.chain)) {
    log('enrichment', 'Wallet exposure unavailable on this chain', {
      ca: hit.ca, symbol: hit.token_symbol, chain: chainName || hit.chain,
    });
    return false;
  }
  const ca = hit.ca;
  try {
    const pct = list => (list && list.length)
      ? Number(list.reduce((s, w) => s + (w.pctOfSupply || 0), 0).toFixed(2))
      : null;

    // BUNDLER AND SNIPER ARE NOT FETCHED. Removed 2026-08-03 at the user's
    // request, and the data was not worth its cost: both counts hit the
    // 50-wallet page cap on nearly every token, so "50+" was a fetch artifact
    // rather than a measurement, and the share-of-supply figure only covered
    // the wallets that fit on that page. Dropping them halves the GMGN calls
    // per signal, from four to two.
    const kols = await fetchGmgnTokenWallets(ca, chainName, 'renowned', log, { force });
    const smart = await fetchGmgnTokenWallets(ca, chainName, 'smart_degen', log, { force });

    if (kols == null && smart == null) return false;

    // A tag that came back null is a FAILED LOOKUP, not an empty result --
    // fetchGmgnTokenWallets returns null on a timeout, a rate-limit cooldown or
    // a chain it does not cover, and an empty array when it genuinely found
    // nobody. Writing null over a previously good count meant one transient
    // GMGN blip during a refresh erased "17 KOL holding" and left the row
    // rendering nothing, which reads as "no KOLs" rather than "we could not
    // ask". Each population is therefore only overwritten when its own lookup
    // actually answered.
    // HOLDING, not "has traded". GMGN's token-holders endpoint returns every
    // tagged wallet that ever touched the token, with balance 0 for the ones
    // that sold out -- so counting the raw list put KOLs on the card who had
    // bought and fully dumped, under a label reading "holding". Verified on a
    // live call: both listed KOLs held 0% and one had exited 21 seconds after
    // buying.
    //
    const holding = list => Array.isArray(list) ? list.filter(w => w.isHolding) : null;
    const kolsHolding = holding(kols);
    const smartHolding = holding(smart);

    const keep = (list, current) => Array.isArray(list) ? list.length : (current ?? null);
    hit.kol_holder_count = keep(kolsHolding, hit.kol_holder_count);
    hit.smart_holder_count = keep(smartHolding, hit.smart_holder_count);
    // Kept separately: a KOL who bought and dumped inside a minute is real
    // information, it is just not "holding". Not surfaced on the card yet.
    if (Array.isArray(kols)) hit.kol_sold_out_count = kols.filter(w => w.soldOut).length;
    if (Array.isArray(smart)) hit.smart_sold_out_count = smart.filter(w => w.soldOut).length;
    // The wallet address travels with each entry so the UI can link straight
    // to that wallet's GMGN page. For KOLs the handle is the useful identity;
    // for smart money there is no handle at all, and the wallet page is the
    // only way to actually inspect who it is -- so both are kept.
    // Named handles first (an @ is the most recognisable identity), then the
    // unnamed ones by position size. Previously anything without a handle was
    // FILTERED OUT ENTIRELY, so a token could say "17 KOL holding" and list
    // three -- the other fourteen had no representation at all and the row
    // looked like it was under-reporting its own count. Every KOL now has a
    // link, to X where there is a handle and to their GMGN wallet page where
    // there is not.
    // The NAMES must come from the same filtered set as the count, or the row
    // says "0 holding" and then lists two handles underneath -- which is how
    // this was reported: "KOLs who have been in the coin and are sold out are
    // still shown as KOLs holding".
    if (Array.isArray(kolsHolding)) {
      hit.kol_holders = kolsHolding
        .slice()
        .sort((a, b) => {
          if (!!b.handle !== !!a.handle) return b.handle ? 1 : -1;
          return (b.pctOfSupply || 0) - (a.pctOfSupply || 0);
        })
        .slice(0, 6)
        .map(k => ({ handle: k.handle || null, name: k.name, pct: k.pctOfSupply, wallet: k.wallet }));
    }
    // Biggest positions first: a smart wallet holding 3% is worth a look, one
    // holding 0.001% is dust.
    if (Array.isArray(smartHolding)) {
      hit.smart_holders = smartHolding
        .slice()
        .sort((a, b) => (b.pctOfSupply || 0) - (a.pctOfSupply || 0))
        .slice(0, 6)
        .map(w => ({ wallet: w.wallet, handle: w.handle, pct: w.pctOfSupply, profit: w.realizedProfit }));
    }
    // WALLET_PAGE is the per-tag fetch limit. A list that comes back exactly
    // full is truncated, so the count is a FLOOR ("50+"), not a total -- and
    // the share of supply only covers the wallets we could see, so the real
    // figure is at least this. Showing a capped 50 as an exact number made a
    // truncation artifact look like a measurement.
    // Capped is judged on the RAW page — a full page means GMGN truncated the
    // result, so the holder count derived from it is a floor regardless of how
    // many of those wallets still hold.
    const capped = list => !!(list && list.length >= WALLET_PAGE);
    if (Array.isArray(kols)) hit.kol_capped = capped(kols);
    if (Array.isArray(smart)) hit.smart_capped = capped(smart);
    hit.wallets_checked_at = new Date().toISOString();

    // Bundler/sniper fields are deliberately cleared, not just left stale --
    // otherwise a record enriched before their removal keeps rendering them.
    for (const k of ['bundler_count', 'bundler_pct', 'bundler_capped',
                     'sniper_count', 'sniper_pct', 'sniper_capped']) delete hit[k];

    // `answered` names which lookup actually returned. Without it a partial
    // result is indistinguishable from a complete one in the log, and
    // "kols: null" reads as "no KOLs" rather than "GMGN did not reply".
    const answered = [
      Array.isArray(kols) && 'kol', Array.isArray(smart) && 'smart',
    ].filter(Boolean).join('+') || 'none';
    log('enrichment', 'Wallet exposure attached', {
      ca, symbol: hit.token_symbol, answered,
      // "holding / touched" makes the filter visible in the log: 2/9 means
      // nine KOLs traded it and two still hold a position.
      kols: `${hit.kol_holder_count ?? '-'}/${Array.isArray(kols) ? kols.length : '-'}`,
      smart: `${hit.smart_holder_count ?? '-'}/${Array.isArray(smart) ? smart.length : '-'}`,
    });
    io.emit('ca_update', hit);
    persist();
    return true;
  } catch (e) {
    log('error', 'Wallet exposure threw', { ca, error: e.message });
    return false;
  }
}

/**
 * Fill gaps on signals restored from disk.
 *
 * Enrichment only ever ran on a NEW mention, so anything that failed at the
 * time -- a provider being briefly down, a rate-limit cooldown, or simply a
 * build that predated a provider being added -- stayed permanently blank. The
 * store then needed a manual script to repair, which is not something a user
 * can be expected to do. Restored signals with missing artwork or holder
 * counts are now topped up in the background on every boot.
 *
 * Paced deliberately slowly: this is cleanup of old records and must never
 * compete with enrichment of a signal arriving right now.
 */
/**
 * Merge tokens that were split across two records by address casing.
 *
 * Runs once on boot. Fixing normalizeCA stops NEW splits; it cannot repair
 * records already on disk, where mentions are divided between two entries and
 * each carries its own entry market cap (so at least one multiplier is wrong).
 *
 * The EARLIEST record wins the anchors -- entry_mcap_usd and the scan
 * snapshot must reflect the first time the token was actually called, which is
 * the whole basis of the multiplier.
 */
function mergeCaseDuplicates() {
  const groups = new Map();
  for (const ca of [...HITS.keys()]) {
    const k = normalizeCA(ca);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(ca);
  }

  let merged = 0;
  for (const [canonical, keys] of groups) {
    if (keys.length < 2) continue;

    const records = keys.map(k => HITS.get(k)).filter(Boolean);
    // Oldest first mention = the real call.
    records.sort((a, b) => {
      const at = new Date(a.mentions?.[0]?.detected_at || a.last_mentioned_at || 0).getTime();
      const bt = new Date(b.mentions?.[0]?.detected_at || b.last_mentioned_at || 0).getTime();
      return at - bt;
    });

    const base = records[0];
    for (const dup of records.slice(1)) {
      // Union the mentions, de-duplicated on author+timestamp.
      const seen = new Set((base.mentions || []).map(m => `${m.author}|${m.detected_at}`));
      for (const m of dup.mentions || []) {
        const key = `${m.author}|${m.detected_at}`;
        if (!seen.has(key)) { base.mentions.push(m); seen.add(key); }
      }
      base.mentions.sort((a, b) => new Date(a.detected_at) - new Date(b.detected_at));
      if (base.mentions.length > MENTIONS_MAX) base.mentions = base.mentions.slice(-MENTIONS_MAX);

      if (Array.isArray(dup.replies) && dup.replies.length) {
        base.replies = [...(base.replies || []), ...dup.replies].slice(-REPLIES_MAX);
      }
      // Take any field the older record simply never got.
      for (const [k, v] of Object.entries(dup)) {
        if (v === null || v === undefined) continue;
        if (['ca', 'mentions', 'replies', 'entry_mcap_usd', 'scan_at', 'scan_mcap_usd'].includes(k)) continue;
        if (base[k] === null || base[k] === undefined) base[k] = v;
      }
      if (dup.watched) base.watched = true;

      base.is_followup = (base.mentions || []).length > 1;
      HITS.delete(dup.ca);
      const i = HIT_ORDER.indexOf(dup.ca);
      if (i !== -1) HIT_ORDER.splice(i, 1);
      merged++;
    }

    // Re-key onto the canonical (lowercase) address.
    if (base.ca !== canonical) {
      HITS.delete(base.ca);
      const i = HIT_ORDER.indexOf(base.ca);
      base.ca = canonical;
      HITS.set(canonical, base);
      if (i !== -1) HIT_ORDER[i] = canonical;
    }
    if (base.entry_mcap_usd != null && base.mcap_usd != null && base.entry_mcap_usd > 0) {
      base.multiplier = base.mcap_usd / base.entry_mcap_usd;
    }
  }

  if (merged) {
    persist();
    log('system', 'Merged duplicate tokens split by address casing', { merged, tokens: groups.size });
  }

  // Recompute is_followup from the mentions actually on record. Existing hits
  // were flagged by the old rule (any repeat, including the same person twice
  // and bot echoes), so the Called-again tab contained tokens only one person
  // ever called. Distinct non-bot authors is the definition the UI states.
  const ignoredAuthors = (config.filters && config.filters.ignored_authors) || [];
  let relabelled = 0;
  for (const hit of HITS.values()) {
    const callers = new Set(
      (hit.mentions || [])
        .filter(m => !isEchoBot(m.author, ignoredAuthors))
        .map(m => (m.author || '').toLowerCase())
    );
    const shouldBe = callers.size > 1;
    if (!!hit.is_followup !== shouldBe) { hit.is_followup = shouldBe; relabelled++; }
  }
  if (relabelled) {
    persist();
    log('system', 'Corrected follow-up flags to distinct-caller rule', { relabelled });
  }
}

async function backfillRestored() {
  // ---- migrate wallet counts stored before the "capped" flag existed --
  // A tag list that came back exactly WALLET_PAGE long was truncated, so the
  // count is a floor. Older records have no flag and render a bare "50",
  // which reads as an exact measurement. We cannot recover the true number
  // without re-fetching, but we can stop presenting a page size as a fact.
  {
    let marked = 0;
    for (const hit of recent(500)) {
      for (const [countKey, flagKey] of [
        ['kol_holder_count', 'kol_capped'], ['smart_holder_count', 'smart_capped'],
      ]) {
        if (hit[flagKey] === undefined && hit[countKey] >= WALLET_PAGE) { hit[flagKey] = true; marked++; }
      }
    }
    if (marked) { persist(); log('system', 'Marked truncated wallet counts as capped', { fields: marked }); }
  }

  // ---- migrate the old `dex_paid: false` default ----------------------
  // Signals stored before DEX-paid was actually checked carry a hard `false`
  // that was never a finding, only a default -- and the UI reported it as
  // "DEX Paid · No" on tokens that HAD paid. Anything without a check
  // timestamp is reset to unknown and then genuinely checked. This call is
  // keyless and cheap, so it runs regardless of whether GMGN is configured.
  {
    const stale = recent(500).filter(h => h.dex_paid_checked_at == null);
    if (stale.length) {
      log('system', 'Checking DEX-paid status for restored signals', { count: stale.length });
      let paidFound = 0;
      for (const hit of stale) {
        hit.dex_paid = null;                       // unknown until proven
        const paid = await fetchDexPaid(hit.ca, hit.chain);
        if (paid) {
          Object.assign(hit, paid);
          if (paid.dex_paid) paidFound++;
          io.emit('ca_update', hit);
        }
        await new Promise(r => setTimeout(r, 250));   // polite to a free API
      }
      persist();
      log('system', 'DEX-paid check complete', { checked: stale.length, paid: paidFound });
    }
  }

  if (!isGmgnConfigured()) return;
  const gaps = recent(500).filter(h => !h.image_url || h.holder_count == null);
  if (!gaps.length) return;
  log('system', 'Backfilling restored signals', { count: gaps.length });

  let fixed = 0;
  for (const hit of gaps) {
    try {
      const info = await fetchGmgnTokenInfo(hit.ca, hit.chain, log);
      let changed = false;
      if (info) {
        if (!hit.image_url && info.image_url) { hit.image_url = info.image_url; changed = true; }
        if (!hit.header_url && info.header_url) { hit.header_url = info.header_url; changed = true; }
        if (hit.holder_count == null && info.holder_count != null) { hit.holder_count = info.holder_count; changed = true; }
      }
      // Same last resort as the live path: if no provider has the artwork,
      // read the token's own published metadata. Solana tokens only, since
      // that is where the URI comes from.
      if (!hit.image_url && isSolanaAddress(hit.ca)) {
        if (!hit._metadata_uri) {
          const safety = await fetchSafety(hit.ca, log);
          if (safety?.metadata_uri) hit._metadata_uri = safety.metadata_uri;
          if (!hit.image_url && safety?.image_url) { hit.image_url = safety.image_url; changed = true; }
        }
        if (!hit.image_url && hit._metadata_uri) {
          const fromSource = await fetchImageFromMetadata(hit._metadata_uri, log);
          if (fromSource) {
            hit.image_url = fromSource.image_url;
            if (!hit.header_url && fromSource.header_url) hit.header_url = fromSource.header_url;
            changed = true;
          }
        }
      }
      if (changed) { fixed++; io.emit('ca_update', hit); }
    } catch (e) {
      log('error', 'Backfill failed for a token', { ca: hit.ca, error: e.message });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (fixed) { persist(); log('system', 'Backfill complete', { fixed, of: gaps.length }); }
}

// channelId -> "Server / #channel". Populated from the gateway's own payloads,
// so naming a channel costs no extra REST call.
const DC_CHANNEL_NAMES = new Map();
// guildId -> "Server", and channelId -> guildId. Both are needed to answer
// "is this channel part of a server the user selected?".
const DC_GUILD_NAMES = new Map();
const DC_CHANNEL_GUILD = new Map();

/**
 * Index one guild's text channels by id.
 *
 * Called for guilds found in READY (user tokens) and in GUILD_CREATE (bot
 * tokens, plus lazily-loaded guilds). Guilds listed as `unavailable` carry no
 * channel array and are skipped -- they arrive properly via GUILD_CREATE later.
 */
function indexDiscordGuild(g) {
  if (!g || g.unavailable) return;
  if (g.id) DC_GUILD_NAMES.set(String(g.id), g.name || String(g.id));
  for (const ch of (g.channels || [])) {
    // 0 = text, 5 = announcement, 11/12 = threads. Voice and category entries
    // have no messages and would only pad the Settings list.
    if (!ch || !ch.id || !ch.name) continue;
    if (ch.type != null && ![0, 5, 11, 12].includes(ch.type)) continue;
    DC_CHANNEL_NAMES.set(String(ch.id), g.name ? g.name + ' / #' + ch.name : '#' + ch.name);
    if (g.id) DC_CHANNEL_GUILD.set(String(ch.id), String(g.id));
  }
}

/**
 * Should this Discord message be watched?
 *
 * Mirrors how Telegram works -- you pick a source, then optionally narrow it --
 * except a Discord server has two levels, so "pick a source" can mean either.
 *
 *   server selected, no channels picked  -> the WHOLE server
 *   server selected, channels picked     -> only those channels
 *   channel picked, server not selected  -> just that channel
 *   nothing configured at all            -> everything (unchanged default)
 *
 * `monitored_channels` was previously SAVED by Settings and then never read:
 * the only filter was `monitored_guilds`, which the UI never wrote. So picking
 * channels in Settings had no effect whatsoever on what was watched.
 */
function discordWatches(guildId, channelId) {
  const dc = config.discord || {};
  const guilds = new Set((dc.monitored_guilds || []).map(String));
  const channels = new Set((dc.monitored_channels || []).map(String));
  if (!guilds.size && !channels.size) return true;      // nothing chosen yet

  const gid = String(guildId || '');
  const cid = String(channelId || '');
  if (channels.has(cid)) return true;                   // explicitly picked

  if (guilds.has(gid)) {
    // Whole-server selection, unless this server has specific channels chosen --
    // in which case the narrower choice is the one the user meant.
    for (const c of channels) {
      if (DC_CHANNEL_GUILD.get(c) === gid) return false;
    }
    return true;
  }
  return false;
}

let discordConnected = false;
let discordShouldRun = false;
let discordWs = null;
// Set when Discord rejects the token outright, so the UI can show an
// actionable "your token is invalid" instead of a permanent "connecting…".
let discordAuthFailed = false;
function startDiscord() {
  const token = config.discord?.user_token;
  // No guild snapshot is taken here on purpose. It used to be captured once at
  // connect, so changing your selection in Settings did nothing until the app
  // was restarted. `discordWatches` reads the live config on every message.
  discordAuthFailed = false;               // a fresh attempt clears the last verdict
  if (!token) { log('system', 'Discord skipped: no user_token in config'); return; }
  discordShouldRun = true;
  let ws, heartbeatInterval, seq = null;
  // A rejected token used to reconnect every 5s forever. Discord closes an
  // invalid session with 4004 immediately, so that produced ~17 log lines a
  // minute permanently -- 6 KB of backend.log in one session, all of it noise,
  // burying the real diagnostics this file exists to preserve. An auth failure
  // is terminal: retrying the SAME bad token cannot succeed, so we stop and
  // say why. Genuine drops still reconnect, with backoff.
  let dcAttempts = 0;
  function connect() {
    if (!discordShouldRun) return;
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    discordWs = ws;
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.s != null) seq = msg.s;
      switch (msg.op) {
        case 10:
          heartbeatInterval = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), msg.d.heartbeat_interval);
          ws.send(JSON.stringify({ op: 2, d: { token, properties: { os: 'windows', browser: 'chrome', device: '' }, compress: false } }));
          break;
        case 0:
          if (msg.t === 'READY') {
            discordConnected = true;
            dcAttempts = 0;                  // a good connection clears the backoff
            // A USER token receives its full guild list -- channels included --
            // inside READY itself, and may never send a GUILD_CREATE at all.
            // Reading channels only from GUILD_CREATE therefore left
            // DC_CHANNEL_NAMES empty forever: the gateway said "connected", the
            // Settings screen said "no Discord source yet", and both were
            // telling the truth about different things.
            const readyGuilds = Array.isArray(msg.d.guilds) ? msg.d.guilds : [];
            for (const g of readyGuilds) indexDiscordGuild(g);
            log('system', 'Discord connected', {
              user: msg.d.user?.username,
              guilds: readyGuilds.length,
              channels: DC_CHANNEL_NAMES.size,
            });
          }
          // Still handled: bot tokens, and guilds that arrive lazily or become
          // available after READY listed them as unavailable.
          if (msg.t === 'GUILD_CREATE') indexDiscordGuild(msg.d);
          if (msg.t === 'MESSAGE_CREATE') {
            const m = msg.d;
            if (!discordWatches(m.guild_id, m.channel_id)) return;
            const chatName = DC_CHANNEL_NAMES.get(String(m.channel_id)) || m.channel_id;
            const author = m.author?.username || 'unknown';
            const found = extractCAs(m.content, 'discord');

            if (!found.length) {
              // Two ways a Discord message continues a call:
              //   message_reference.message_id -- an explicit reply
              //   channel_id                   -- a thread STARTED from that
              //     message, because such a thread's id IS the message id
              // The guild id is used as the chat key for both, since a thread
              // has a different channel_id from where the call was posted.
              const replyTo = m.message_reference?.message_id
                ? String(m.message_reference.message_id) : null;
              handleReply({
                chatKey: String(m.guild_id || m.channel_id),
                refIds: [replyTo, String(m.channel_id)],
                messageId: String(m.id),
                author, text: m.content,
                source: 'discord', chatName,
              });
              return;
            }

            for (const { ca, chain } of found) {
              handleMention({
                ca, chain, source: 'discord', chat_name: chatName,
                chat_id_hint: m.channel_id, author, text: m.content,
                message_id: String(m.id), chat_key: String(m.guild_id || m.channel_id),
              });
            }
          }
          break;
      }
    });
    ws.on('close', (code) => {
      discordConnected = false;
      clearInterval(heartbeatInterval);
      discordWs = null;
      if (!discordShouldRun) return;

      // 4004 = authentication failed. The token is wrong, expired, or was
      // truncated on paste. No amount of retrying fixes that, and it is the
      // one Discord failure the user can actually act on -- so it is stated
      // once, plainly, and the loop stops instead of hiding in a log flood.
      if (code === 4004) {
        discordShouldRun = false;
        discordAuthFailed = true;
        log('error', 'Discord rejected the user token (4004). Not retrying — ' +
          'paste a current token in Settings. A real token is ~70 characters; ' +
          `this one is ${String(token).length}.`);
        return;
      }

      // Anything else is a genuine drop worth retrying, but with backoff so a
      // sustained outage costs a handful of lines instead of hundreds.
      dcAttempts += 1;
      const delay = Math.min(5000 * 2 ** (dcAttempts - 1), 5 * 60 * 1000);
      // Only the first few reconnects are logged individually; past that only
      // every tenth, so a long outage stays visible without flooding.
      if (dcAttempts <= 3 || dcAttempts % 10 === 0) {
        log('system', `Discord disconnected (code ${code}), reconnecting in ${Math.round(delay / 1000)}s`, { attempt: dcAttempts });
      }
      setTimeout(connect, delay);
    });
    ws.on('error', e => log('error', 'Discord WebSocket error', { error: e.message }));
  }
  connect();
}
function stopDiscord() {
  discordShouldRun = false;
  if (discordWs) { try { discordWs.close(); } catch (e) {} }
  discordWs = null;
}

// chatId -> human-readable group/channel title. Resolving costs an API call,
// and a busy group fires constantly, so each chat is resolved once and reused.
const TG_CHAT_TITLES = new Map();

async function tgChatTitle(msg, chatId) {
  if (TG_CHAT_TITLES.has(chatId)) return TG_CHAT_TITLES.get(chatId);
  let title = chatId;
  try {
    const chat = await msg.getChat();
    // Groups/channels expose 	itle; a DM exposes username/first name.
    title = chat?.title || chat?.username || chat?.firstName || chatId;
  } catch (_) {
    // Fall back to the raw id rather than dropping the signal.
  }
  TG_CHAT_TITLES.set(chatId, title);
  return title;
}

let tgClient = null;
let tgLoginState = null;
// 	gClient.connected only means the TCP socket to Telegram is open -- that
// becomes true the moment we request a login code, long before the user has
// authenticated. Reporting it as "Connected" told users they were logged in
// when they were not (and showed "session saved: No" alongside it, which was
// the contradiction that gave it away). This flag tracks actual authorization.
let tgAuthorized = false;

async function startTelegramIfSessionExists() {
  const session = config.telegram?.session;
  if (!session) { log('system', 'Telegram skipped: no GramJS session saved yet'); return; }
  await connectTelegramWithSession(session);
}
async function connectTelegramWithSession(sessionStr) {
  tgClient = new TelegramClient(new StringSession(sessionStr), Number(config.telegram.api_id), config.telegram.api_hash, { connectionRetries: 5 });
  await tgClient.connect();
  attachTelegramHandler();
  tgAuthorized = true;
  log('system', 'Telegram connected using saved session');
}
function attachTelegramHandler() {
  const monitored = new Set((config.telegram.monitored_chats || []).map(String));
  tgClient.addEventHandler(async (event) => {
    const msg = event.message;
    const chatId = String(msg.chatId || msg.peerId?.channelId || msg.peerId?.chatId || '');
    if (monitored.size && !monitored.has(chatId)) return;
    const chatTitle = await tgChatTitle(msg, chatId);
    const sender = await msg.getSender().catch(() => null);
    const author = sender?.username || sender?.firstName || 'unknown';

    const found = extractCAs(msg.message, 'telegram');

    // A message with no CA can still be a REPLY to one -- that is the whole
    // point, so this runs before the early exit rather than only alongside a
    // detection.
    if (!found.length) {
      const r = msg.replyTo;
      if (r) {
        // replyToTopId is the forum-topic root. Both are checked, and a match
        // on the topic root is flagged: everything posted in a topic replies
        // to it structurally, which is weaker evidence than a direct reply.
        const direct = r.replyToMsgId ? String(r.replyToMsgId) : null;
        const topRoot = r.replyToTopId ? String(r.replyToTopId) : null;
        handleReply({
          chatKey: chatId,
          refIds: [direct, topRoot],
          messageId: String(msg.id),
          author, text: msg.message,
          source: 'telegram', chatName: chatTitle,
          viaTopic: !!(r.forumTopic && !direct),
        });
      }
      return;
    }

    for (const { ca, chain } of found) {
      handleMention({
        ca, chain, source: 'telegram', chat_name: chatTitle, chat_id_hint: chatId,
        author, text: msg.message,
        message_id: String(msg.id), chat_key: chatId,
      });
    }
  }, new NewMessage({}));
  log('signal', 'Telegram listening', { chats: monitored.size });
}

app.post('/api/telegram/login/start', async (req, res) => {
  try {
    const { phone, apiId, apiHash } = req.body;
    const useApiId = Number(apiId || config.telegram?.api_id);
    const useApiHash = apiHash || config.telegram?.api_hash;
    tgClient = new TelegramClient(new StringSession(''), useApiId, useApiHash, { connectionRetries: 5 });
    await tgClient.connect();
    const result = await tgClient.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId: useApiId, apiHash: useApiHash, settings: new Api.CodeSettings({}),
    }));
    tgLoginState = { phone, phoneCodeHash: result.phoneCodeHash, apiId: useApiId, apiHash: useApiHash };
    config.telegram = { ...config.telegram, api_id: useApiId, api_hash: useApiHash, phone };
    saveConfig(config);
    res.json({ ok: true, step: 'code_sent' });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/telegram/login/code', async (req, res) => {
  try {
    if (!tgLoginState) return res.status(400).json({ ok: false, error: 'no login in progress' });
    const { code } = req.body;
    try {
      await tgClient.invoke(new Api.auth.SignIn({ phoneNumber: tgLoginState.phone, phoneCodeHash: tgLoginState.phoneCodeHash, phoneCode: code }));
    } catch (e) {
      if (e.message?.includes('SESSION_PASSWORD_NEEDED')) return res.json({ ok: true, step: 'password_needed' });
      throw e;
    }
    config.telegram.session = tgClient.session.save();
    saveConfig(config);
    tgLoginState = null;
    tgAuthorized = true;
    res.json({ ok: true, step: 'logged_in' });
    attachTelegramHandler();
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/telegram/login/password', async (req, res) => {
  try {
    const { password } = req.body;
    await tgClient.signInWithPassword({ apiId: tgLoginState.apiId, apiHash: tgLoginState.apiHash }, {
      password: async () => password, onError: (e) => log('error', 'Telegram 2FA error', { error: e.message }),
    });
    config.telegram.session = tgClient.session.save();
    saveConfig(config);
    tgLoginState = null;
    tgAuthorized = true;
    res.json({ ok: true, step: 'logged_in' });
    attachTelegramHandler();
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Dev-only: manually inject a mention to verify the full pipeline
// (extraction -> enrichment -> safety -> store -> /api/react-feed shape)
// without waiting for a real Telegram/Discord message.
//
// Hardened: rejects malformed CAs, and refuses non-loopback callers so a
// device on the same LAN can't inject fabricated signals into the feed.
const TEST_HIT_ENABLED = process.env.INTEL_ENABLE_TEST_HIT !== 'false';
app.post('/api/test-hit', async (req, res) => {
  if (!TEST_HIT_ENABLED) return res.status(403).json({ ok: false, error: 'test endpoint disabled' });
  const remote = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (remote !== '127.0.0.1' && remote !== '::1') {
    return res.status(403).json({ ok: false, error: 'localhost only' });
  }
  const { ca, text, chain, source, chat_name, author, dex_paid, kol_count, smart_wallet_count } = req.body;
  if (!isValidCA(ca)) return res.status(400).json({ ok: false, error: 'valid ca required (base58 mint or 0x address)' });
  log('signal', 'Manual test hit', { ca });
  await handleMention({ ca, chain: chain || 'unknown', source: source || 'discord', chat_name: chat_name || 'manual-test', author: author || 'sir', text: text || '',
    dex_paid, kol_count, smart_wallet_count });
  res.json({ ok: true });
});

// Dev-only companion to /api/test-hit: drives the reply path without waiting
// for someone to actually reply in a monitored chat. Same guards -- disabled
// by the same env flag, loopback callers only -- because it writes to the
// signal store.
app.post('/api/test-reply', (req, res) => {
  if (!TEST_HIT_ENABLED) return res.status(403).json({ ok: false, error: 'test endpoint disabled' });
  const remote = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (remote !== '127.0.0.1' && remote !== '::1') {
    return res.status(403).json({ ok: false, error: 'localhost only' });
  }
  const { ca, author, text, chat_key, reply_to_id, message_id } = req.body || {};
  if (!isValidCA(ca)) return res.status(400).json({ ok: false, error: 'valid ca required' });
  if (!HITS.has(ca)) return res.status(404).json({ ok: false, error: 'ca not tracked' });

  const chatKey = String(chat_key || 'test-chat');
  const rootId = String(reply_to_id || 'test-root');
  // Registering the target is OPT-IN. Doing it unconditionally made every
  // simulated reply match by construction, which silently turned the
  // "replying to a message we never saw" case into a false pass.
  if (req.body.register_root) indexMessage(chatKey, rootId, ca);

  const attached = handleReply({
    chatKey,
    refIds: [rootId],
    messageId: String(message_id || Date.now()),
    author: author || 'tester',
    text: text || '',
    source: 'telegram',
    chatName: 'reply-test',
  });
  res.json({ ok: true, attached });
});

app.post('/api/discord/token', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({ ok: false, error: 'token required' });
  config.discord = { ...config.discord, user_token: token };
  saveConfig(config);
  stopDiscord();
  startDiscord();
  res.json({ ok: true });
});
/**
 * GMGN API key. Previously the ONE credential with no UI — it had to be typed
 * into config.json inside %APPDATA%, which is fine for the developer and a wall
 * for anyone else, especially since the app never says which file or where.
 *
 * The key is never echoed back; `/api/source/status` reports only whether one
 * is set, the same contract the Telegram and Discord fields follow.
 */
app.post('/api/gmgn/key', (req, res) => {
  const { key } = req.body || {};
  if (typeof key !== 'string') return res.status(400).json({ ok: false, error: 'key required' });
  const trimmed = key.trim();
  config.gmgn = { ...(config.gmgn || {}), api_key: trimmed || undefined };
  if (!trimmed) delete config.gmgn.api_key;
  saveConfig(config);
  configureGmgn(trimmed || null);
  log('system', trimmed ? 'GMGN key updated' : 'GMGN key cleared');
  res.json({ ok: true, configured: !!trimmed });
});

app.post('/api/discord/logout', (req, res) => {
  stopDiscord();
  if (config.discord) config.discord.user_token = '';
  saveConfig(config);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: { telegram: { connected: tgAuthorized }, discord: { connected: discordConnected } },
    kolWatcher: kolWatcherStatus(),
    flowWatcher: flowWatcherStatus(),
  });
});
app.get('/api/source/status', (req, res) => {
  const tg = config.telegram || {}, dc = config.discord || {};
  res.json({
    telegram: { connected: tgAuthorized, session: !!tg.session, chats: (tg.monitored_chats || []).length,
      // Echoed back so the connect form can prefill on a return visit.
      // api_hash is deliberately NOT echoed -- it is a secret; the client
      // only needs to know whether one is already stored.
      apiId: tg.api_id || null, phone: tg.phone || '', hasApiHash: !!tg.api_hash },
    discord: {
      connected: discordConnected, token: !!dc.user_token,
      guilds: (dc.monitored_guilds || []).length,
      // Distinguishes "not connected yet" from "connected attempt refused".
      // Without this the settings panel showed the same neutral state for a
      // token that was simply wrong, so there was nothing telling the user to
      // replace it.
      authFailed: discordAuthFailed,
    },
    // Whether a key is set — never the key itself, same as hasApiHash above.
    gmgn: { configured: isGmgnConfigured() },
    lastFetch: null, error: null,
  });
});

// ── Dev wallet history (on-demand) ──────────────────────────────────────
// Deliberately NOT part of the automatic enrichment chain. This is the
// most expensive GMGN call, and GMGN's limiter escalates -- retrying during
// a cooldown extends the ban by 5s each time, up to 5 minutes. Firing it
// per-signal starved the cheap per-token security lookups that every card
// needs. Fetching it only when a card is actually inspected keeps the
// budget for what's always visible.
//
// Results are cached per DEV WALLET (inside gmgn.js), so every token from
// the same creator after the first is free.
app.get('/api/token/:chain/:ca/dev', async (req, res) => {
  const { chain } = req.params;
  const ca = normalizeCA(req.params.ca);
  if (!isValidCA(ca)) return res.status(400).json({ available: false, error: 'invalid ca' });

  const hit = HITS.get(ca);
  // The creator wallet comes from RugCheck, which is Solana-only. EVM
  // deployer lookup would need a block-explorer call we don't make yet, so
  // EVM tokens honestly report that this is unavailable rather than
  // silently returning an empty result that looks like "clean dev".
  const devWallet = hit?.dev_wallet || null;
  if (!devWallet) {
    return res.json({
      available: false,
      reason: isSolanaAddress(ca)
        ? 'creator wallet not resolved yet -- safety check may still be running'
        : 'dev history is Solana-only right now (creator wallet comes from RugCheck)',
    });
  }

  if (!isGmgnConfigured()) {
    return res.json({ available: false, reason: 'GMGN API key not configured' });
  }

  try {
    const dev = await fetchGmgnDevHistory(devWallet, chain || hit?.chain, log);
    if (!dev) {
      return res.json({ available: false, reason: 'GMGN unavailable or rate limited -- try again shortly' });
    }
    // _token_extras is the full creator-wide lookup. It is used to resolve
    // THIS token's flags and then dropped -- merging it would write a serial
    // rugger's entire catalogue onto every one of their tokens in signals.json.
    const { _token_extras, ...devPublic } = dev;
    if (hit) {
      Object.assign(hit, devPublic);
      const extras = extractTokenExtrasFromDevHistory(dev, ca);
      if (extras) Object.assign(hit, extras);
      io.emit('ca_update', hit);
      persist();
    }
    log('enrichment', 'Dev history fetched on demand', {
      ca, created: dev.dev_tokens_created, survivalPct: dev.dev_survival_pct,
    });
    // devPublic, not dev -- the client needs this token's resolved flags, not
    // the creator's whole catalogue.
    res.json({ available: true, ...devPublic, ...(extractTokenExtrasFromDevHistory(dev, ca) || {}) });
  } catch (e) {
    log('error', 'Dev history endpoint threw', { ca, error: e.message });
    res.status(500).json({ available: false, error: e.message });
  }
});

// ── KOL / Smart Money exposure for one token (on demand) ────────────────
// Complements the live watcher: this reads the token's CURRENT holder list,
// so it sees positions opened before the app was running. Limited to top
// holders by size, which the response states explicitly so the UI cannot
// present it as a complete count.
app.get('/api/token/:chain/:ca/wallets', async (req, res) => {
  const { chain } = req.params;
  const ca = normalizeCA(req.params.ca);
  if (!isValidCA(ca)) return res.status(400).json({ available: false, error: 'invalid ca' });
  if (!isGmgnConfigured()) return res.json({ available: false, reason: 'GMGN API key not configured' });

  const hit = HITS.get(ca);
  // Same chain gate as the automatic path. Without it this endpoint returned
  // `available: true` with four zeroes on Base and Ethereum -- a confident
  // "nobody notable is in this token" produced by a provider that has no
  // holder data for those chains at all.
  if (!gmgnHolderChain(chain || hit?.chain)) {
    return res.json({
      available: false,
      reason: `GMGN has no holder data for ${chain || hit?.chain || 'this chain'} — KOL and smart-money holders are unavailable here`,
    });
  }
  const useChain = chain || hit?.chain;
  try {
    // Sequential, not Promise.all: gmgn.js runs a strict serial queue anyway,
    // and firing five at once just fills it while the UI waits on the slowest.
    // The two reputation tags come first because they are what the panel leads
    // with; risk tags fill in behind them.
    // `force` because this endpoint only runs when a user opens the panel --
    // that is an explicit "show me now", and serving it from the 5-minute
    // cache meant refreshing a card and then opening the Inspector showed the
    // pre-refresh numbers.
    const kols = await fetchGmgnTokenWallets(ca, useChain, 'renowned', log, { force: true });
    const smart = await fetchGmgnTokenWallets(ca, useChain, 'smart_degen', log, { force: true });
    // Bundler, sniper and rat-trader tags are no longer fetched -- see the note
    // in attachWalletExposure. Both counts saturated the 50-wallet page on
    // nearly every token, which made them a property of the fetch limit rather
    // than of the token.
    if (kols == null && smart == null) {
      return res.json({ available: false, reason: 'GMGN unavailable or rate limited -- try again shortly' });
    }

    // HOLDING only, same rule as the card. This endpoint returned the raw
    // lists, so the Inspector kept listing KOLs who had bought and fully sold
    // even after the card beside it had been corrected — the second surface
    // showing "KOLs who traded it" under a heading that means "who holds it".
    const holdingOnly = list => Array.isArray(list) ? list.filter(w => w.isHolding) : null;

    res.json({
      available: true,
      scope: 'top holders by position size — not a complete count',
      kols: holdingOnly(kols) || [],
      smartMoney: holdingOnly(smart) || [],
      live: getKolActivity(ca, useChain, hit?.scan_at || hit?.last_mentioned_at),
    });
  } catch (e) {
    log('error', 'Wallet exposure endpoint threw', { ca, error: e.message });
    res.status(500).json({ available: false, error: e.message });
  }
});

// ── Which chains are allowed to raise a desktop alert ───────────────────
// The chain toggles used to be purely cosmetic: they filtered the rendered
// list in the browser, while toasts were fired by the Electron process from
// the backend socket, which had never heard of them. Switching Solana off
// therefore hid Solana from the feed and kept alerting about it -- the exact
// opposite of what the control implies.
//
// An empty/missing list means "every chain", so behaviour is unchanged until
// the user actually narrows it.
function notifyChainsAllowed() {
  const list = config.filters && config.filters.notify_chains;
  // null/undefined = never configured = alert on everything.
  // An ARRAY is always honoured, INCLUDING an empty one. Previously
  // `list.length ? ... : null` collapsed `[]` into "no preference", so a user
  // who switched every chain off got alerts for every chain -- the exact
  // opposite of what they asked for, and unreachable by any other setting.
  if (!Array.isArray(list)) return null;
  return new Set(list.map(c => String(c).toLowerCase()));
}

function chainNotifyAllowed(chain) {
  const allowed = notifyChainsAllowed();
  if (!allowed) return true;
  // Same comparison the UI does: the raw chain id, lowercased.
  return allowed.has(String(chain || '').toLowerCase());
}

/**
 * May this hit raise a desktop alert?
 *
 * TWO independent gates, and it takes the whole hit rather than just a chain
 * because the second one needs the metrics:
 *
 *   1. the CHAIN, from the bell on each chain pill;
 *   2. the METRIC thresholds, only when the user has switched on
 *      "only alert on calls matching my filters".
 *
 * (2) is why this changed shape. The left-rail filters used to reach the feed
 * and nothing else, so a Market cap max of 6000 emptied the feed while toasts
 * kept arriving for tokens far above it. Gate (2) is off unless explicitly
 * enabled -- looking at a range is not the same as agreeing to be interrupted
 * by it, which is the same reason the pill and the bell are separate controls.
 */
function shouldNotify(hit) {
  if (!chainNotifyAllowed(hit && hit.chain)) return false;
  return passesAlertFilters(hit, config.filters && config.filters.alert_filters);
}

/**
 * Emit on the ALERT channel, tagged with why it fired.
 *
 * `kind` is a routing/labelling hint for the toast layer and is NOT persisted
 * -- same rule as `_notify`. Kinds:
 *   new                -- first time this CA has been seen
 *   watchlist-mention  -- a token you starred was called again
 *   watchlist-refresh  -- a token you starred was re-scanned
 *
 * The chain filter still applies to every kind. Starring a token says "tell me
 * more about this one", not "override the chains I muted".
 */
function emitAlert(hit, kind, trigger) {
  io.emit('ca', {
    ...hit,
    // The whole hit, not just the chain -- the metric gate needs the numbers.
    _notify: shouldNotify(hit),
    _alert_kind: kind,
    // The event that caused THIS alert (a new mention, say). Underscored and
    // never persisted -- it describes the alert, not the token.
    _trigger: trigger || null,
  });
}

app.get('/api/notify-prefs', (req, res) => {
  res.json({
    chains: (config.filters && config.filters.notify_chains) || null,
    alertFilters: (config.filters && config.filters.alert_filters) || { enabled: false, thresholds: {} },
  });
});

/**
 * Change whether the metric filters also gate desktop alerts, and with what
 * thresholds.
 *
 * REQUIRES `intent: "user-toggle"`, for the same reason `/api/notify-prefs`
 * does: this is a preference a renderer must never write on mount. The filter
 * state lives in localStorage and differs per window, so without the guard a
 * stale tab could push its own thresholds over yours and start suppressing
 * alerts you never asked to suppress -- silently, because the UI would show
 * its own state as if you had chosen it.
 *
 * Thresholds are sanitised to the known keys, so the renderer's search text,
 * chain sets and chip selection never leak into config.json.
 */
app.post('/api/alert-filters', (req, res) => {
  const { enabled, thresholds, intent } = req.body || {};
  if (intent !== 'user-toggle') {
    log('error', 'Refused alert-filter write without user intent', {
      from: (req.socket.remoteAddress || '').replace('::ffff:', ''),
      keeping: config.filters?.alert_filters?.enabled ? 'on' : 'off',
    });
    return res.status(400).json({
      ok: false,
      error: 'alert filters may only be changed by an explicit user toggle (intent: "user-toggle")',
    });
  }
  const clean = { enabled: !!enabled, thresholds: sanitizeThresholds(thresholds) };
  config.filters = { ...(config.filters || {}), alert_filters: clean };
  saveConfig(config);
  log('system', 'Alert filters updated', {
    enabled: clean.enabled,
    set: Object.keys(clean.thresholds).length
      ? Object.entries(clean.thresholds).map(([k, v]) => `${k}=${v}`).join(' ')
      : 'none',
  });
  // Same reasoning as the chain preference: tell the toast layer rather than
  // making it poll, or a threshold just set keeps alerting until reconnect —
  // which looks exactly like the filter not working.
  io.emit('notify_prefs', {
    chains: config.filters.notify_chains ?? null,
    alertFilters: clean,
  });
  res.json({ ok: true, alertFilters: clean });
});

/**
 * Change which chains may raise a desktop alert.
 *
 * REQUIRES `intent: "user-toggle"`. This is not ceremony -- it is the guard
 * that stops this preference being widened by anything other than a person
 * clicking the control.
 *
 * The failure it prevents, observed twice: a renderer that writes this on
 * mount. Any stale tab, cached bundle, or second window then silently resets
 * alerts to whatever its own local state happened to be, and because the UI
 * shows that state as if it were chosen, there is nothing to notice except
 * alerts arriving for a chain the user muted. Verified from the log -- a
 * client POSTed all seven chains at 11:11:45 with no human involved.
 *
 * A write without the flag is refused and logged loudly, so the next time
 * something tries this it shows up as an error instead of a silent reset.
 */
app.post('/api/notify-prefs', (req, res) => {
  const { chains, intent } = req.body || {};
  if (intent !== 'user-toggle') {
    log('error', 'Refused alert-chain write without user intent', {
      from: (req.socket.remoteAddress || '').replace('::ffff:', ''),
      sent: Array.isArray(chains) ? chains.length : String(chains),
      keeping: config.filters?.notify_chains ?? 'all',
    });
    return res.status(400).json({
      ok: false,
      error: 'alert chains may only be changed by an explicit user toggle (intent: "user-toggle")',
    });
  }
  if (chains != null && !Array.isArray(chains)) {
    return res.status(400).json({ ok: false, error: 'chains must be an array or null' });
  }
  config.filters = { ...(config.filters || {}), notify_chains: chains ? chains.map(String) : null };
  saveConfig(config);
  log('system', 'Alert chains updated', {
    chains: chains ? (chains.length ? chains.join(',') : 'none') : 'all',
  });
  // The Electron toast layer caches this, so tell it rather than making it
  // poll -- otherwise a chain switched off keeps alerting until the next
  // reconnect, which looks exactly like the filter not working.
  io.emit('notify_prefs', { chains: config.filters.notify_chains });
  res.json({ ok: true, chains: config.filters.notify_chains });
});

// ── Watchlist ───────────────────────────────────────────────────────────
// Deliberately NOT the same thing as the "Follow-ups" filter, which shows
// tokens several different people called. This is a token YOU chose to keep
// an eye on. Both were called "follow" in conversation and conflating them in
// the UI is exactly why a watchlist looked like it already existed.
//
// Stored on the hit, so it survives restarts with the rest of the store.
app.post('/api/watch/:ca', (req, res) => {
  const ca = normalizeCA(req.params.ca);
  if (!isValidCA(ca)) return res.status(400).json({ ok: false, error: 'invalid ca' });
  const hit = HITS.get(ca);
  if (!hit) return res.status(404).json({ ok: false, error: 'not tracked' });

  // Explicit value when given, otherwise toggle -- so the button works with
  // one click and the state can still be set precisely by anything else.
  hit.watched = typeof req.body?.watched === 'boolean' ? req.body.watched : !hit.watched;
  hit.watched_at = hit.watched ? new Date().toISOString() : null;
  persist();
  io.emit('ca_update', hit);
  log('signal', hit.watched ? 'Added to watchlist' : 'Removed from watchlist', {
    ca, symbol: hit.token_symbol,
  });
  res.json({ ok: true, watched: hit.watched });
});

// Re-read live market data for ONE token, on demand. This is the only
// thing that populates live_* -- so a card shows a delta only when the user
// has actually asked for a fresh reading.
app.post('/api/refresh/:ca', async (req, res) => {
  const ca = normalizeCA(req.params.ca);
  const hit = HITS.get(ca);
  if (!hit) return res.status(404).json({ ok: false, error: 'not tracked' });
  try {
    const fresh = await enrichDexscreener(ca);
    if (!fresh) {
      // A dead pair is a real answer, not a failed request -- say which, so
      // the card can tell the user instead of appearing to do nothing.
      log('enrichment', 'Refresh found no DexScreener pair', { ca, symbol: hit.token_symbol });
      return res.json({ ok: false, error: 'DexScreener has no pair for this token right now' });
    }
    hit.live_mcap_usd = fresh.mcap_usd;
    hit.live_liquidity_usd = fresh.liquidity_usd;
    hit.live_volume_24h_usd = fresh.volume_24h_usd;
    hit.live_price_usd = fresh.price_usd;
    hit.refreshed_at = new Date().toISOString();
    // Keep price-action fields current too; they are inherently "now" values.
    hit.price_change_5m = fresh.price_change_5m;
    hit.price_change_1h = fresh.price_change_1h;
    hit.price_change_24h = fresh.price_change_24h;
    hit.buys_24h = fresh.buys_24h;
    hit.sells_24h = fresh.sells_24h;
    // Identity CAN change after the call: a launchpad token migrating to its
    // AMM changes dexId (and therefore the detected launchpad), and teams
    // rename tokens. These were frozen at scan, so a renamed token kept
    // showing its original name forever.
    if (fresh.token_name) hit.token_name = fresh.token_name;
    if (fresh.token_symbol) hit.token_symbol = fresh.token_symbol;
    if (fresh.launchpad) hit.launchpad = fresh.launchpad;
    if (fresh.dex) hit.dex = fresh.dex;
    if (fresh.pair_url) hit.pair_url = fresh.pair_url;
    if (fresh.pair_label) hit.pair_label = fresh.pair_label;
    // Socials are frequently added days after launch, so a token called early
    // kept showing no links forever even once the team had published them.
    if (fresh.twitter_url) hit.twitter_url = fresh.twitter_url;
    if (fresh.website_url) hit.website_url = fresh.website_url;
    if (fresh.telegram_url) hit.telegram_url = fresh.telegram_url;
    if (fresh.image_url) hit.image_url = fresh.image_url;
    if (fresh.header_url) hit.header_url = fresh.header_url;
    // The frozen scan_* snapshot and entry_mcap_usd are deliberately NOT
    // touched. They are what makes the multiplier and the "since call" delta
    // mean anything; overwriting them on refresh would reset every token's
    // measured performance to 1.00x, which is the exact bug persistence.js
    // was written to prevent.
    persist();
    io.emit('ca_update', hit);

    // Refresh means "tell me what is true NOW" -- price, safety, holders and
    // who is in it. Fire-and-forget so market data returns immediately; each
    // provider emits its own ca_update as it lands.
    enrichSafetyAsync(ca, hit.chain, { force: true }).catch(e =>
      log('error', 'Forced re-enrichment threw', { ca, error: e.message }));

    const pct = hit.scan_mcap_usd ? ((fresh.mcap_usd / hit.scan_mcap_usd) - 1) * 100 : null;
    log('enrichment', 'Manual refresh', { ca, scan: hit.scan_mcap_usd, live: fresh.mcap_usd, pct });
    // A re-scan of a WATCHED token raises an alert carrying the fresh numbers,
    // so the answer arrives on the desktop instead of only in the card you have
    // to be looking at. Deliberately watchlist-only: re-alerting on every manual
    // refresh would fire a toast for the card you are already staring at.
    if (hit.watched) emitAlert(hit, 'watchlist-refresh');
    res.json({
      ok: true, scanMcap: hit.scan_mcap_usd, liveMcap: fresh.mcap_usd, changePct: pct,
      // The deep re-scan is still running; the UI uses this to keep the
      // spinner honest rather than claiming completion at the market-data step.
      rescanning: true,
    });
  } catch (e) {
    log('error', 'Refresh failed', { ca, error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CALLER TRACK RECORD ────────────────────────────────────────────────
//
// "Did this person's calls go anywhere?" — the one question the store could
// always answer and never did. Every ingredient was already on disk:
// entry_mcap_usd, the author of every call, and a current market cap.
//
// THE HONESTY PROBLEM, AND WHY OUTCOMES ARE REFRESHED SEPARATELY.
// `multiplier` is mcap / entry_mcap, and mcap is the FROZEN scan value — so
// for any token that was never refreshed it is exactly 1.00x. Measured on a
// real store: 41 of 324 tokens had a live reading, meaning 87% would have
// contributed a fabricated "1.00x" to their caller's average. Scoring that
// produces a table where everyone looks break-even, which is worse than no
// table at all.
//
// So a caller's record is computed ONLY over calls with a real outcome, the
// coverage is reported alongside it, and there is an explicit endpoint to go
// and fetch those outcomes. It uses DexScreener only — keyless, free, one call
// per token, no GMGN budget — and it is user-triggered, never a timer.

let outcomeRun = null;   // { total, done, startedAt } while a pass is running

app.post('/api/outcomes/refresh', async (req, res) => {
  if (outcomeRun) return res.json({ ok: false, error: 'already running', progress: outcomeRun });

  const targets = [...HITS.values()].filter(h => h && h.ca && h.entry_mcap_usd > 0);
  outcomeRun = { total: targets.length, done: 0, updated: 0, startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true, tokens: targets.length });

  log('system', 'Outcome refresh started', { tokens: targets.length });
  for (const hit of targets) {
    try {
      const fresh = await enrichDexscreener(hit.ca);
      if (fresh && fresh.mcap_usd != null) {
        hit.live_mcap_usd = fresh.mcap_usd;
        hit.live_price_usd = fresh.price_usd;
        hit.outcome_at = new Date().toISOString();
        // The multiplier that the track record is built on. Measured against
        // the market cap at first detection, which is why that value is frozen.
        hit.multiplier = fresh.mcap_usd / hit.entry_mcap_usd;
        outcomeRun.updated++;
      } else if (fresh === null) {
        // No pair at all any more. For a memecoin that is itself an outcome —
        // the token is effectively dead — but it is recorded as its own state
        // rather than silently folded in as a 0x.
        hit.outcome_dead = true;
        hit.outcome_at = new Date().toISOString();
        outcomeRun.updated++;
      }
    } catch (e) {
      log('error', 'Outcome refresh failed for a token', { ca: hit.ca, error: e.message });
    }
    outcomeRun.done++;
    // DexScreener is free but not a punching bag.
    await new Promise(r => setTimeout(r, 220));
  }
  persist();
  log('system', 'Outcome refresh complete', { updated: outcomeRun.updated, of: outcomeRun.total });
  io.emit('outcomes_done', { updated: outcomeRun.updated, total: outcomeRun.total });
  outcomeRun = null;
});

app.get('/api/outcomes/status', (req, res) => res.json({ running: !!outcomeRun, progress: outcomeRun }));

/**
 * Per-caller track record.
 *
 * Only calls with a MEASURED outcome count toward the numbers. `coverage` says
 * how many of that person's calls those were, so a 3-for-40 record cannot be
 * mistaken for a complete one.
 */
app.get('/api/callers', (req, res) => {
  const ignored = (config.filters && config.filters.ignored_authors) || [];
  const byAuthor = new Map();

  for (const hit of HITS.values()) {
    if (!hit || !Array.isArray(hit.mentions)) continue;
    // One entry per DISTINCT caller per token — the same rule the feed's
    // "called Nx" uses. Without it, a person who posted the same CA three
    // times would have it counted three times in their own record.
    const seen = new Set();
    for (const m of hit.mentions) {
      const author = (m.author || '').trim();
      if (!author || isEchoBot(author, ignored)) continue;
      const key = author.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      if (!byAuthor.has(key)) {
        byAuthor.set(key, { author, calls: 0, scored: 0, dead: 0, mults: [], best: null, chats: new Set() });
      }
      const rec = byAuthor.get(key);
      rec.calls++;
      if (m.chatName || m.chat_name) rec.chats.add(m.chatName || m.chat_name);

      if (hit.outcome_dead) { rec.scored++; rec.dead++; rec.mults.push(0); continue; }
      const mult = (hit.entry_mcap_usd > 0 && hit.live_mcap_usd > 0)
        ? hit.live_mcap_usd / hit.entry_mcap_usd : null;
      if (mult == null) continue;              // no outcome — excluded, not zeroed
      rec.scored++;
      rec.mults.push(mult);
      if (!rec.best || mult > rec.best.mult) {
        rec.best = { mult, symbol: hit.token_symbol, ca: hit.ca };
      }
    }
  }

  const median = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), i = Math.floor(s.length / 2);
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
  };

  const callers = [...byAuthor.values()].map(r => ({
    author: r.author,
    calls: r.calls,
    scored: r.scored,
    // The share of their calls we can actually judge. A record built on 2 of
    // 30 calls is not a record, and the UI needs to be able to say so.
    coverage: r.calls ? r.scored / r.calls : 0,
    // MEDIAN leads, not mean: one 40x on a memecoin drags an average into
    // nonsense and would rank a lucky caller above a consistent one.
    medianMult: median(r.mults),
    avgMult: r.mults.length ? r.mults.reduce((a, b) => a + b, 0) / r.mults.length : null,
    winRate: r.mults.length ? r.mults.filter(x => x >= 1).length / r.mults.length : null,
    rugRate: r.mults.length ? r.mults.filter(x => x <= 0.2).length / r.mults.length : null,
    dead: r.dead,
    best: r.best,
    chats: [...r.chats].slice(0, 4),
  })).sort((a, b) => (b.medianMult ?? -1) - (a.medianMult ?? -1) || b.scored - a.scored);

  const totalCalls = callers.reduce((n, c) => n + c.calls, 0);
  const totalScored = callers.reduce((n, c) => n + c.scored, 0);

  res.json({
    callers,
    coverage: {
      tokens: HITS.size,
      calls: totalCalls,
      scored: totalScored,
      pct: totalCalls ? totalScored / totalCalls : 0,
      // Stated plainly so the UI never has to imply a complete record.
      note: 'Only calls with a re-read market cap can be scored. Run an outcome refresh to raise coverage.',
    },
  });
});

// ── SOURCE MANAGEMENT ROUTES ──────────────────────────────────────────

// Every Telegram group/channel this account can see, so the UI can offer a
// real pick-list instead of asking the user to paste numeric ids.
app.get('/api/telegram/chats', async (req, res) => {
  if (!tgClient || !tgAuthorized) return res.json({ ok: false, error: 'Telegram not connected', chats: [] });
  try {
    const dialogs = await tgClient.getDialogs({ limit: 300 });
    const chats = dialogs
      .filter(d => d && (d.isGroup || d.isChannel))
      .map(d => ({
        id: String(d.id),
        name: d.title || d.name || String(d.id),
        kind: d.isChannel && !d.isGroup ? 'channel' : 'group',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, chats });
  } catch (e) {
    log('error', 'Failed to list Telegram chats', { error: e.message });
    res.json({ ok: false, error: e.message, chats: [] });
  }
});

// Discord guilds + their text channels, straight from the gateway cache
// populated on GUILD_CREATE -- no REST calls needed.
app.get('/api/discord/channels', (req, res) => {
  const guilds = new Map();
  for (const [id, label] of DC_CHANNEL_NAMES.entries()) {
    const [guildName, channelName] = String(label).includes(' / #')
      ? String(label).split(' / #')
      : ['Direct / other', String(label).replace(/^#/, '')];
    if (!guilds.has(guildName)) guilds.set(guildName, { id: null, channels: [] });
    const g = guilds.get(guildName);
    g.channels.push({ id, name: channelName });
    // The guild id is what selection and sender rules key on -- a name is not
    // unique and can be renamed out from under a saved setting.
    if (!g.id) g.id = DC_CHANNEL_GUILD.get(String(id)) || null;
  }
  const out = [...guilds.entries()]
    .map(([name, g]) => ({
      id: g.id, name,
      channels: g.channels.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ok: true, connected: discordConnected, guilds: out });
});

// Persist monitored lists + per-chat sender rules.
app.post('/api/sources', (req, res) => {
  const { telegram_chats, discord_guilds, discord_channels, chat_rules } = req.body || {};
  if (Array.isArray(telegram_chats)) {
    config.telegram = { ...config.telegram, monitored_chats: telegram_chats.map(String) };
  }
  if (Array.isArray(discord_guilds)) {
    config.discord = { ...config.discord, monitored_guilds: discord_guilds.map(String) };
  }
  if (Array.isArray(discord_channels)) {
    config.discord = { ...config.discord, monitored_channels: discord_channels.map(String) };
  }
  if (chat_rules && typeof chat_rules === 'object') {
    config.filters = { ...(config.filters || {}), chat_rules };
  }
  saveConfig(config);
  log('system', 'Sources updated', {
    tgChats: (config.telegram?.monitored_chats || []).length,
    dcGuilds: (config.discord?.monitored_guilds || []).length,
    rules: Object.keys((config.filters && config.filters.chat_rules) || {}).length,
  });
  res.json({ ok: true });
});

// Current source selection, for populating the UI.
app.get('/api/sources', (req, res) => {
  res.json({
    telegram_chats: config.telegram?.monitored_chats || [],
    discord_guilds: config.discord?.monitored_guilds || [],
    discord_channels: config.discord?.monitored_channels || [],
    chat_rules: (config.filters && config.filters.chat_rules) || {},
  });
});

app.get('/api/react-feed', (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 150));
  const events = recent(limit).map(d => {
    const buys = d.buys_24h || 0, sells = d.sells_24h || 0;
    let ageMinutes = null;
    if (d.pair_created_at) {
      const diff = (Date.now() - new Date(d.pair_created_at).getTime()) / 60000;
      if (!Number.isNaN(diff)) ageMinutes = diff;
    }
    const rawName = (d.token_name || '').trim(), rawSym = (d.token_symbol || '').trim();
    const displayName = rawName || (d.ca.slice(0, 4) + '...' + d.ca.slice(-4));
    const displaySym = rawSym || d.ca.slice(0, 6).toUpperCase();
    return {
      id: d.ca, type: d.is_followup ? 'followup' : 'new', platform: d.source === 'telegram' ? 'tg' : 'dc',
      sourceName: d.chat_name, author: d.author, time: d.last_mentioned_at, body: d.message_text || '',
      // Only a real, fetched safety score can produce this badge now.
      badges: (d.rug_risk_pct != null && d.rug_risk_pct <= 20) ? ['CLEAN'] : [],
      launchpad: d.launchpad, dex: d.dex, pairLabel: d.pair_label,
      token: { name: displayName, symbol: displaySym, chain: d.chain || 'solana', address: d.ca, image: d.image_url, banner: d.header_url },
      metrics: {
        // Default view = the frozen scan snapshot. Falls back to the live
        // field only for records created before snapshots existed.
        mcap: d.scan_mcap_usd ?? d.mcap_usd,
        liq: d.scan_liquidity_usd ?? d.liquidity_usd,
        price: d.scan_price_usd ?? d.price_usd,
        vol: d.scan_volume_24h_usd ?? d.volume_24h_usd,
        holders: d.holder_count,
        scanAt: d.scan_at,
        // Present ONLY after an explicit refresh, so a first-time call can
        // never display a "since call" delta against itself.
        liveMcap: d.live_mcap_usd,
        liveLiq: d.live_liquidity_usd,
        liveVol: d.live_volume_24h_usd,
        livePrice: d.live_price_usd,
        refreshedAt: d.refreshed_at,
        changeSinceScan: (d.live_mcap_usd != null && d.scan_mcap_usd)
          ? ((d.live_mcap_usd / d.scan_mcap_usd) - 1) * 100
          : null,
        multiplierSinceScan: (d.live_mcap_usd != null && d.scan_mcap_usd)
          ? d.live_mcap_usd / d.scan_mcap_usd
          : null,
        entryMcap: d.entry_mcap_usd, multiplier: d.multiplier, buys, sells, netBuy: buys - sells, txs: buys + sells,
        ageMinutes, ageLabel: ageMinutes != null ? (ageMinutes < 60 ? `${Math.floor(ageMinutes)}m` : `${(ageMinutes / 60).toFixed(1)}h`) : null,
        chg1h: d.price_change_1h, chg5m: d.price_change_5m, chg24h: d.price_change_24h, top10: d.top10_holder_pct,
      },
      safety: {
        devPct: d.dev_holder_pct, rugRisk: d.rug_risk_pct, isHoneypot: d.is_honeypot, lpBurned: d.lp_burned_pct,
        mintRevoked: d.is_mintable == null ? null : d.is_mintable === false, freezeable: d.is_freezable, contractRenounced: d.is_contract_renounced,
        transferFee: d.transfer_fee_pct, buyTax: d.buy_tax_pct, sellTax: d.sell_tax_pct,
        // Real RugCheck-sourced fields (Solana only; null on EVM = unknown).
        rugged: d.rugged, devWallet: d.dev_wallet, insiderHolders: d.insider_holder_count,
        graphInsiders: d.graph_insiders_detected, lpProviders: d.total_lp_providers,
        risks: d.safety_risks || [], source: d.safety_source, checkedAt: d.safety_checked_at,
        // null = never checked, which is NOT the same as "they did not pay".
        dexPaid: d.dex_paid, dexBoosts: d.dex_boosts, dexPaidAt: d.dex_paid_checked_at,
      },
      links: { pair: d.pair_url, twitter: d.twitter_url, website: d.website_url, telegram: d.telegram_url },
      // null (not an empty object) when the watcher never saw this token, so
      // the UI can distinguish "no notable wallet touched it" from "we were
      // not watching when they did".
      // Your watchlist flag, distinct from `type: 'followup'` which only means
      // several people called it.
      watched: !!d.watched,
      watchedAt: d.watched_at || null,
      kols: getKolActivity(d.ca, d.chain, d.scan_at || d.last_mentioned_at),
      // Aggregate smart-money flow. Independent of GMGN: keyless, and it keeps
      // working through a GMGN rate-limit cooldown.
      flow: getFlow(d.ca, d.chain),
      // Who HOLDS it, captured at scan and refreshed on demand. Distinct from
      // `kols` above, which is trade flow inside a rolling window.
      holders: (d.wallets_checked_at) ? {
        kols: d.kol_holder_count, smartMoney: d.smart_holder_count,
        named: d.kol_holders || [],
        smartWallets: d.smart_holders || [],
        kolsCapped: !!d.kol_capped, smartCapped: !!d.smart_capped,
        // Notable wallets that bought and fully exited. Kept apart from the
        // holding count on purpose -- "3 KOLs are in this" and "3 KOLs were in
        // this and dumped it" are close to opposite readings, and merging them
        // is the bug that made the holding count wrong in the first place.
        kolsOut: d.kol_sold_out_count ?? null,
        smartOut: d.smart_sold_out_count ?? null,
        checkedAt: d.wallets_checked_at,
      } : null,
      // Bot echoes are kept in the raw store (useful for debugging) but are
      // NOT surfaced as mentions -- otherwise Rick/Phanes auto-replies make
      // every token look like it was called 2-3x seconds after one real call.
      // One entry per DISTINCT caller (earliest sighting kept), so the card's
      // "called Nx" means N different people -- not N messages. Every chat a
      // caller posted in is preserved on their entry, so the UI can still
      // show reach without inflating conviction.
      mentions: (() => {
        const ignored = (config.filters && config.filters.ignored_authors) || [];
        const byAuthor = new Map();
        for (const m of d.mentions) {
          if (isEchoBot(m.author, ignored)) continue;
          const key = (m.author || '').toLowerCase();
          if (!byAuthor.has(key)) {
            byAuthor.set(key, {
              source: m.source, chatName: m.chat_name, author: m.author,
              detectedAt: m.detected_at, chats: [m.chat_name],
            });
          } else {
            const e = byAuthor.get(key);
            if (!e.chats.includes(m.chat_name)) e.chats.push(m.chat_name);
          }
        }
        return [...byAuthor.values()];
      })(),
      // WHERE it has been called, in time order.
      //
      // The array above is deduped by AUTHOR, which is right for "called 3x"
      // and for caller scoring, but it throws away the thing you actually want
      // when a CA spreads: the same token showing up in a second Telegram group
      // and then in a Discord server you also watch. It also dropped the message
      // text, which was stored all along.
      //
      // Grouped by room so two calls in one server read as one room with two
      // callers, rather than two identical-looking rows.
      mentionLog: (() => {
        const ignored = (config.filters && config.filters.ignored_authors) || [];
        const rooms = new Map();
        for (const m of d.mentions) {
          if (isEchoBot(m.author, ignored)) continue;
          const room = m.chat_name || 'unknown';
          const key = (m.source || '') + ' ' + room;
          if (!rooms.has(key)) {
            rooms.set(key, {
              source: m.source, chatName: room,
              firstAt: m.detected_at, lastAt: m.detected_at,
              callers: [],
            });
          }
          const e = rooms.get(key);
          e.lastAt = m.detected_at;
          // One entry per person per room; a repost by the same person in the
          // same room is not new information.
          if (!e.callers.some(c => (c.author || '').toLowerCase() === (m.author || '').toLowerCase())) {
            e.callers.push({ author: m.author, at: m.detected_at, text: m.text || '' });
          }
        }
        return [...rooms.values()].sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
      })(),
      // What people said back. Newest last, so the card reads as a
      // conversation rather than a reversed one.
      replies: (d.replies || []).slice(-12).map(r => ({
        author: r.author, text: r.text, at: r.at,
        source: r.source, chatName: r.chat_name, viaTopic: !!r.via_topic,
      })),
      replyCount: (d.replies || []).length,
      totalPosts: d.mentions.filter(m => !isEchoBot(m.author, (config.filters && config.filters.ignored_authors) || [])).length,
      echoCount: d.mentions.filter(m => isEchoBot(m.author, (config.filters && config.filters.ignored_authors) || [])).length,
    };
  });
  res.json(events);
});

app.use(express.static(STATIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  const index = join(STATIC_DIR, 'index.html');
  if (existsSync(index)) res.sendFile(index); else next();
});

// Flush the store to disk on shutdown so the last few seconds of signals
// aren't lost to the save debounce.
function shutdown(signal) {
  log('system', `Shutting down (${signal}), flushing signal store`);
  try { persistence.flush(HITS, HIT_ORDER); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
  log('system', `intel backend listening on http://localhost:${PORT}`);
  log('system', 'startup complete', { restoredHits: HITS.size });
  // Repair casing-split tokens before anything else reads the store.
  mergeCaseDuplicates();

  startDiscord();
  startTelegramIfSessionExists();

  // Chain-wide KOL / Smart Money feed, indexed by token. When a notable wallet
  // trades something we already track, the card updates live -- that is the
  // whole point: knowing a KOL just bought the thing your chat called.
  startKolWatcher(log, (rawCa) => {
    // GMGN returns EVM addresses in whatever casing it stored them in, while
    // the store is keyed lowercase -- an un-normalised lookup here misses
    // silently and the feature looks dead while appearing correctly wired.
    const ca = normalizeCA(rawCa);
    const hit = HITS.get(ca);
    if (!hit) return;                       // not a token we track; ignore
    const activity = getKolActivity(ca, hit.chain, hit.scan_at || hit.last_mentioned_at);
    if (!activity) return;
    const before = (hit.kol_count || 0) + (hit.smart_wallet_count || 0);
    hit.kol_count = activity.kol.count;
    hit.smart_wallet_count = activity.smart.count;
    const after = activity.kol.count + activity.smart.count;
    log('signal', 'Notable wallet activity', {
      ca, symbol: hit.token_symbol, kols: activity.kol.count, smart: activity.smart.count,
    });

    // "A KOL just bought the thing your chat called" is the most actionable
    // event this app can observe, and until now it only ever updated a card you
    // had to already be looking at. For a token you STARRED, that is worth an
    // alert.
    //
    // Watchlist-only and increase-only, deliberately. This watcher fires on
    // every poll for every tracked token, so alerting on all of them -- or
    // re-alerting when a count merely re-reports -- would turn the one signal
    // worth interrupting you for into noise you learn to ignore.
    if (hit.watched && after > before) {
      emitAlert(hit, 'watchlist-wallet');
    } else {
      io.emit('ca_update', hit);
    }
    persist();
  });

  // Repair gaps in restored signals, after a delay so live traffic wins the
  // GMGN queue on startup.
  setTimeout(() => { backfillRestored().catch(e => log('error', 'Backfill threw', { error: e.message })); }, 20_000);

  // Keyless aggregate flow, so smart-money signal exists even with no GMGN key.
  startFlowWatcher(log, (rawCa) => {
    const ca = normalizeCA(rawCa);
    const hit = HITS.get(ca);
    if (!hit) return;
    const f = getFlow(ca, hit.chain);
    if (!f) return;
    // Only emit when something a user would notice actually changed.
    if (hit.flow_inflow_24h === f.inflow24h && hit.flow_acceleration === f.acceleration) return;
    hit.flow_inflow_24h = f.inflow24h;
    hit.flow_acceleration = f.acceleration;
    io.emit('ca_update', hit);
  });
});
