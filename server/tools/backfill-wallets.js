/**
 * One-shot: re-read KOL / smart-money holders for every stored token.
 *
 * WHY THIS EXISTS
 * Until 2026-08-03 the holder count was `list.length` from GMGN's token-holders
 * endpoint — which returns every tagged wallet that has *traded* the token,
 * reporting balance 0 for those who exited. So a card could read "17 KOL
 * holding" when none of them still held a position. The live path was fixed,
 * but stored records keep their old counts until the token is refreshed, and
 * the raw lists were never persisted so nothing can be recomputed offline.
 * A re-fetch is the only way to correct them.
 *
 * RUN WITH THE APP CLOSED. It writes the store directly; a running backend
 * holds the same file in memory and would overwrite this on its next persist.
 *
 *   node server/tools/backfill-wallets.js            # correct every token
 *   node server/tools/backfill-wallets.js --dry-run  # report, change nothing
 *   node server/tools/backfill-wallets.js --limit 20
 *
 * Cost: 2 GMGN calls per token, serialised behind gmgn.js's 1.2s floor.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { configureGmgn, fetchGmgnTokenWallets, gmgnHolderChain, gmgnCooldownMs, WALLET_PAGE } from '../gmgn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.INTEL_DATA_DIR
  || join(process.env.APPDATA || join(process.env.HOME || '', '.config'), 'intel-command-deck');
const STORE = join(ROOT, 'data', 'signals.json');
const CONFIG = join(ROOT, 'config.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) || Infinity : Infinity;
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PACE_MS = (() => {
  const i = args.indexOf('--pace');
  return i >= 0 ? parseInt(args[i + 1], 10) || 900 : 900;
})();

const log = (kind, msg, extra) =>
  console.log(`[${kind}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

if (!existsSync(STORE)) { console.error('No store at', STORE); process.exit(1); }
if (!existsSync(CONFIG)) { console.error('No config at', CONFIG); process.exit(1); }

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
if (!cfg.gmgn?.api_key) { console.error('config.gmgn.api_key missing — nothing to do'); process.exit(1); }
configureGmgn(cfg.gmgn.api_key);

const store = JSON.parse(readFileSync(STORE, 'utf8'));
const hits = Array.isArray(store.hits) ? store.hits : Object.values(store.hits || store);

// Only chains GMGN actually returns holder rows for. Base and Ethereum answer
// with an empty list rather than an error, so calling them would write a
// measured zero for data that does not exist.
const targets = hits.filter(h => h && h.ca && gmgnHolderChain(h.chain)).slice(0, LIMIT);

console.log(`store    : ${STORE}`);
console.log(`tokens   : ${hits.length} total, ${targets.length} on chains GMGN covers`);
console.log(`mode     : ${DRY ? 'DRY RUN — no writes' : 'live'}`);
console.log(`estimate : ~${Math.round(targets.length * 2 * 1.2 / 60)} min\n`);

let corrected = 0, unchanged = 0, failed = 0, i = 0;
const changes = [];

for (const hit of targets) {
  i++;
  const chain = hit.chain;
  const beforeKol = hit.kol_holder_count ?? null;
  const beforeSmart = hit.smart_holder_count ?? null;

  try {
    // A rate-limit cooldown makes every call return null INSTANTLY rather than
    // waiting, so a naive loop marks its entire worklist failed in seconds --
    // observed on the first run: 317 of 324 "failed" inside one 90s cooldown.
    // Wait the cooldown out, then retry the same token.
    let kols = null, smart = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cd = gmgnCooldownMs();
      if (cd > 0) {
        process.stdout.write(`  … rate limited, waiting ${Math.ceil(cd / 1000)}s
`);
        await sleep(cd + 1500);
      }
      // force: bypass the 5-minute response cache — this is a correction pass,
      // and a cached value is exactly the number we are trying to replace.
      kols = await fetchGmgnTokenWallets(hit.ca, chain, 'renowned', log, { force: true });
      smart = await fetchGmgnTokenWallets(hit.ca, chain, 'smart_degen', log, { force: true });
      if (kols != null || smart != null) break;
      if (gmgnCooldownMs() === 0) break;   // a real empty answer, not a cooldown
    }

    if (kols == null && smart == null) { failed++; continue; }

    // Same rule as the live path: a live position, not "has traded".
    const holding = l => (Array.isArray(l) ? l.filter(w => w.isHolding) : null);
    const kh = holding(kols), sh = holding(smart);
    const capped = l => !!(l && l.length >= WALLET_PAGE);

    if (Array.isArray(kh)) {
      hit.kol_holder_count = kh.length;
      hit.kol_capped = capped(kols);
      hit.kol_holders = kh.slice()
        .sort((a, b) => (!!b.handle !== !!a.handle) ? (b.handle ? 1 : -1)
          : (b.pctOfSupply || 0) - (a.pctOfSupply || 0))
        .slice(0, 6)
        .map(k => ({ handle: k.handle || null, name: k.name, pct: k.pctOfSupply, wallet: k.wallet }));
    }
    if (Array.isArray(sh)) {
      hit.smart_holder_count = sh.length;
      hit.smart_capped = capped(smart);
      hit.smart_holders = sh.slice()
        .sort((a, b) => (b.pctOfSupply || 0) - (a.pctOfSupply || 0))
        .slice(0, 6)
        .map(w => ({ wallet: w.wallet, handle: w.handle, pct: w.pctOfSupply, profit: w.realizedProfit }));
    }
    if (Array.isArray(kols)) hit.kol_sold_out_count = kols.filter(w => w.soldOut).length;
    if (Array.isArray(smart)) hit.smart_sold_out_count = smart.filter(w => w.soldOut).length;

    // Bundler/sniper were removed from the product; clear them so restored
    // records stop carrying fields nothing reads.
    for (const k of ['bundler_count', 'bundler_pct', 'bundler_capped',
                     'sniper_count', 'sniper_pct', 'sniper_capped']) delete hit[k];

    hit.wallets_checked_at = new Date().toISOString();

    const moved = hit.kol_holder_count !== beforeKol || hit.smart_holder_count !== beforeSmart;
    if (moved) {
      corrected++;
      changes.push({
        sym: hit.token_symbol, chain,
        kol: `${beforeKol ?? '-'}->${hit.kol_holder_count}`,
        smart: `${beforeSmart ?? '-'}->${hit.smart_holder_count}`,
        touched: `${Array.isArray(kols) ? kols.length : '-'}/${Array.isArray(smart) ? smart.length : '-'}`,
      });
    } else unchanged++;

    if (i % 10 === 0 || moved) {
      console.log(
        String(i).padStart(4) + '/' + targets.length,
        String(hit.token_symbol || '?').slice(0, 12).padEnd(13),
        String(chain).padEnd(10),
        `kol ${beforeKol ?? '-'}->${hit.kol_holder_count}`.padEnd(16),
        `smart ${beforeSmart ?? '-'}->${hit.smart_holder_count}`,
        moved ? '  CORRECTED' : ''
      );
    }
  } catch (e) {
    failed++;
    console.log(`  ! ${hit.token_symbol}: ${e.message}`);
  }

  // Pacing on top of gmgn.js's own 1.2s floor. The floor is tuned for live
  // enrichment interleaved with the KOL watcher; a back-to-back bulk pass is a
  // burst pattern the limiter punishes, and its backoff escalates.
  await sleep(PACE_MS);
}

console.log('\n──────────── summary ────────────');
console.log('corrected :', corrected);
console.log('unchanged :', unchanged);
console.log('failed    :', failed);

const inflated = changes.filter(c => {
  const [a, b] = c.kol.split('->').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b < a;
});
if (inflated.length) {
  console.log(`\n${inflated.length} tokens were OVERSTATING KOL holders. Worst:`);
  for (const c of inflated.sort((x, y) => {
    const d = a => { const [p, q] = a.kol.split('->').map(Number); return p - q; };
    return d(y) - d(x);
  }).slice(0, 12)) {
    console.log(`   ${String(c.sym).padEnd(12)} ${String(c.chain).padEnd(10)} kol ${c.kol.padEnd(10)} smart ${c.smart.padEnd(10)} (touched ${c.touched})`);
  }
}

if (DRY) { console.log('\nDRY RUN — store not written.'); process.exit(0); }

copyFileSync(STORE, STORE + '.bak-walletsweep');
if (Array.isArray(store.hits)) store.hits = hits;
writeFileSync(STORE, JSON.stringify(store));
console.log('\nstore written. backup at signals.json.bak-walletsweep');
