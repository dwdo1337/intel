# intel. Command Deck — complete technical description

Version 0.2.0 · ~7,200 lines of application code · Windows desktop (Electron)

---

## 1. What it is, in one paragraph

You are already in dozens of Telegram groups and Discord servers where people
post memecoin contract addresses all day. Most of that volume is noise: scanner
bots echoing every address, the same person broadcasting to five of their own
channels, tokens with no liquidity. **intel. Command Deck logs into those chats
as you, watches every message, and turns the raw firehose into a ranked feed of
signals with market data, safety checks and desktop alerts** — without you
reading a single message.

It is a local desktop application. Your chat sessions, credentials and signal
history never leave your machine.

---

## 2. Why it exists — the problem in concrete terms

A single genuine call produces, within seconds:

| Message | Author | Should it count? |
| --- | --- | --- |
| `EPXWa7...x2nJBY` | @dxM4M4 (human) | **yes — the actual call** |
| Same CA + chart | Rick (bot) | no — an echo |
| Same CA + stats | Phanes (bot) | no — an echo |
| Same CA in 4 other groups | @dxM4M4 again | no — one opinion, not five |

Counted naively, that one call reads as "called 7×" — so *every* token looks
hot and the number means nothing. Removing that illusion is the core of the
product; most of the logic below exists to answer **"did a genuinely new person
call this?"**

---

## 3. Architecture

Three processes, one machine:

```
┌─────────────────────────────────────────────────────────────┐
│ Electron main process              electron/main.cjs        │
│  · window, tray, single-instance lock                       │
│  · spawns the backend as a child                            │
│  · listens on Socket.IO, fires desktop toasts               │
└───────────────┬──────────────────────────┬──────────────────┘
                │ spawns                   │ toast windows
                ▼                          ▼
┌──────────────────────────────┐  ┌────────────────────────────┐
│ Backend                      │  │ Toast renderer             │
│  dev:      server/index.js   │  │  electron/toast.html       │
│  packaged: dist-server/*.cjs │  │  · borderless BrowserWindow│
│  · Telegram (GramJS)         │  │  · max 4 stacked, 14s each │
│  · Discord gateway (ws)      │  └────────────────────────────┘
│  · enrichment pipeline       │
│  · Express API + Socket.IO   │
│  · serves the React UI       │◄──── renderer loads 127.0.0.1:5050
│  · JSON persistence          │
└──────────────────────────────┘
```

**Why a separate backend process** rather than running in Electron's main
process: the ingest layer holds long-lived sockets to Telegram and Discord and
does blocking-ish enrichment work. Keeping it out of the UI process means a
stall or crash there never freezes the window, and the same server runs
unchanged in development via `npm run server`.

### Module map

| File | Lines | Responsibility |
| --- | --- | --- |
| `server/index.js` | ~1,890 | ingest, filtering, enrichment orchestration, API, Socket.IO |
| `server/gmgn.js` | ~640 | GMGN OpenAPI via CLI — security, token info, holders, dev history |
| `server/safety.js` | ~265 | RugCheck (Solana) — holders, insiders, rug score, creator |
| `server/kol.js` | ~215 | chain-wide KOL / smart-money trade feed, indexed per token |
| `server/flow.js` | ~160 | keyless aggregate smart-money flow (Binance Web3) |
| `server/persistence.js` | ~113 | atomic debounced JSON store |
| `server/gmgn-cli-shim.cjs` | small | strips `process.versions.electron` so commander parses argv correctly |
| `server/tools/backfill-wallets.js` | ~180 | one-shot correction pass over stored holder counts |
| `build-server.mjs` | ~120 | esbuild — emits `dist-server/`, what the packaged app actually runs |
| `electron/main.cjs` | ~290 | app lifecycle, backend supervision, tray, notifications |
| `electron/toast.cjs` | ~255 | toast window stacking, positioning, click routing |
| `client/` | ~2,700 | React UI |

---

## 4. Ingest layer

### Telegram
GramJS with a **user session** (`StringSession`), not a bot. Bots cannot read
arbitrary group history; you can, so the app authenticates as you. Login is
phone → SMS code → optional 2FA password, handled in-app; the resulting session
string is stored locally and reused on every start.

Chat titles are resolved once per chat and cached — a busy group would otherwise
cost an API call per message.

### Discord
A raw WebSocket to `wss://gateway.discord.gg/?v=10&encoding=json`, authenticating
with a **user token**. Channel names come free from the `GUILD_CREATE` payload,
so naming a channel costs no REST call. Heartbeat and reconnect are handled
manually; reconnection is skipped entirely when no token is configured.

### Detection
Two regexes over every message body:

- EVM — `\b0x[a-fA-F0-9]{40}\b`
- Solana — `\b[1-9A-HJ-NP-Za-km-z]{32,44}\b`

**Deduplicated per message.** A call almost always contains the CA twice (plain
text plus a pump.fun or DexScreener link); without dedupe a single message
registered as two mentions, so a brand-new token showed "called 2×" the instant
it appeared.

### Address normalisation

EVM addresses are **case-insensitive** — `0xABC…` and `0xabc…` are one contract,
and both forms get pasted (checksummed from an explorer, lowercase from a bot).
Every EVM address is lowercased at extraction so the store cannot hold one token
twice. **Solana mints are base58 and ARE case-sensitive**, so they are never
touched; lowercasing one would corrupt it into a different address.

Before this rule, seven tokens existed as duplicate records with their mentions
and entry market caps split between them.

---

## 5. Noise filtering — the core logic

Applied in order, before anything is stored or displayed.

**1. Per-chat sender rules.** An allow-list narrows a group to specific callers;
a block-list silences individuals. Block always wins over allow.

**2. Echo-bot guard.** 15 known scanner names (`rick`, `phanes`, `maestro`,
`bullx`, `trojan`, `photon`, `gmgn`, `bubblemaps`, `banana`, …) matched
case-insensitively as substrings, so `PhanesGoldBot` and `RickBot` both match.
Their messages are **dropped outright** — a scanner reacting to a human is never
an original call. They are still recorded in the raw store for debugging and
counted separately as `echoCount`.

**3. Distinct-caller rule.** A follow-up only counts when a *different human*
calls the same CA. The same person posting to five of their own groups is one
opinion. Every chat a caller posted in is preserved on their entry, so reach is
still visible without inflating conviction.

The feed's "called N×" therefore means **N different people**, not N messages.

---

## 6. Enrichment pipeline

Staged, **fail-open**, each stage emitting its own update so the card fills in
progressively rather than waiting on the slowest provider. A provider being
down, rate-limited or not covering a chain leaves fields `null` — it never
blocks or drops the signal.

| # | Stage | Chains | Provides | When |
| --- | --- | --- | --- | --- |
| 1 | **DexScreener** | all | name, symbol, mcap, liquidity, price, volume, price changes, socials, pair URL, launchpad, image | always, blocking |
| 2 | **DexScreener orders** | all | **DEX Paid** — an `approved` order of type `tokenProfile` | async, once per token |
| 3 | **GMGN token info** | sol/bsc/base/eth/robinhood/arc/stable | **logo, banner, holder count** | async, first if artwork missing |
| 4 | **RugCheck** | Solana | holders, top-10 %, insiders, rug score, **creator wallet**, LP, token image, metadata URI | async |
| 5 | **Token metadata JSON** | Solana | artwork straight from the source the launchpad renders | async, last resort |
| 6 | **GMGN security** | sol/bsc/base | honeypot, buy/sell tax, LP burned, renounced, top-10 | async |
| 7 | **GMGN holders** | sol / bsc / robinhood | **KOL and smart-money holders (live positions only)** | async, and on every refresh |
| 8 | **GMGN dev history** | Solana | tokens created, survival rate, best-ever token | **on demand only** |

Artwork is fetched **first** when missing. Every GMGN call shares one serial
queue with a 1.2 s floor, and that queue also carries the background watcher —
with the image fetched late, a new card sat on grey initials for many seconds.
A priority scheduler serves signal-critical calls (artwork, security) ahead of
background sweeps.

**Why stage 5 is on demand.** It is the most expensive call, and GMGN's limiter
escalates — retrying during a cooldown extends the ban up to 5 minutes. Firing
it per signal starved the cheap lookups every card needs. It is exposed at
`GET /api/token/:chain/:ca/dev` and cached per **creator wallet**, so every
token after the first from the same dev is free.

### Launchpad detection

Two independent routes, deliberately conservative:

1. **Mint suffix** (Solana) — pump.fun and letsbonk.fun vanity-grind mints
   ending in `pump` / `bonk`. Exact.
2. **DEX id** (all chains) — when a launchpad runs its own AMM, DexScreener's
   `dexId` identifies it (`pumpswap`, `launchlab`, `flapsh`, `fourmeme`,
   `clanker`, `zora`, …). All pairs are checked, not just the deepest, because a
   graduated token's deepest pair is the AMM it migrated *to*.

**What it refuses to do:** launchpads deploying onto a shared AMM are not
detectable. A Robinhood-chain token returns `dexId: uniswap`, which identifies
the AMM, not whether it launched via hood.fun, NOXA or PONS. Those stay `null`
and their filter pills stay disabled, because guessing would invent a fact.

---

## 7. The signal record

Every tracked CA is one object. The fields that carry the most design intent:

**Scan snapshot vs live.** On first successful enrichment, `scan_mcap_usd`,
`scan_liquidity_usd`, `scan_volume_24h_usd`, `scan_price_usd` and `scan_at` are
frozen and **never overwritten**. The card shows what was true when the call
fired. `live_*` fields exist only after you explicitly hit refresh — so a
first-time call can never display a "since call" delta against itself.

**Entry mcap and multiplier.** `entry_mcap_usd` is recorded once, on the first
enrichment that produces a market cap; `multiplier = mcap / entry_mcap`. This is
the number that answers "was this call any good?", and it is precisely why
persistence matters: losing it silently reset every token's performance to 1×.

**Refresh is a re-scan, not a price poll.** A manual refresh re-asks every
provider and overwrites what they return — safety, holder count, concentration,
artwork, launchpad, socials, wallet exposure — bypassing the 5-minute response
caches, since serving the cached value would return exactly the reading the user
asked to replace. The frozen `scan_*` fields and `entry_mcap_usd` are the
explicit exception and are never touched.

This exists because enrichment stages are otherwise *gap-fill only*: they skip
any field that already has a value, which is right at scan time and was, for a
while, the only path a card had. A provider that was down when a token was first
seen left its fields `null` permanently, and refresh could not repair them
because it never invoked that chain at all. On Solana one exception survives the
overwrite: GMGN does not replace a field RugCheck owns, because the two measure
top-10 concentration differently and swapping them changes what the number
*means* rather than updating it.

**Honesty contract.** `null` means *we don't know* and renders as "unknown" —
never as a passing score. The "CLEAN" badge appears only from a real fetched
`rug_risk_pct ≤ 20`. Robinhood-chain tokens have no safety provider at all and
say so.

---

## 8. Persistence

`data/signals.json`, written through `persistence.js`: debounced, atomic
(temp file + rename), flushed on `SIGINT`/`SIGTERM`. Restored on boot.

In a packaged build the store lives in `%APPDATA%\intel-command-deck\` —
the app directory is a read-only archive.

---

## 9. API surface

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Telegram/Discord connection state |
| GET | `/api/react-feed` | the feed, shaped for the UI |
| GET | `/api/logs` | ring buffer, last 250 entries |
| GET | `/api/source/status` | credential/session state (never echoes secrets) |
| GET/POST | `/api/sources` | monitored chats, guilds, per-chat rules |
| GET | `/api/telegram/chats` | pick-list of your groups |
| GET | `/api/discord/channels` | guilds + channels from the gateway cache |
| POST | `/api/telegram/login/{start,code,password}` | login flow |
| POST | `/api/discord/{token,logout}` | Discord credentials |
| GET | `/api/token/:chain/:ca/dev` | dev-wallet history, on demand |
| POST | `/api/refresh/:ca` | **full re-scan**: market data, safety, holders, artwork, wallet exposure — every provider, all caches bypassed |
| GET | `/api/callers` | per-caller track record, with `coverage` |
| POST | `/api/outcomes/refresh` | re-price every token (DexScreener only, keyless) so records can be scored |
| GET | `/api/outcomes/status` | progress of the outcome pass |
| POST | `/api/gmgn/key` | set or clear the GMGN API key |
| POST | `/api/watch/:ca` | add/remove from the watchlist |
| GET | `/api/token/:chain/:ca/wallets` | KOL and smart-money holders |
| GET/POST | `/api/notify-prefs` | which chains may raise a desktop alert |
| POST | `/api/test-hit` | inject a signal — loopback-only, CA-validated, kill-switch |

**Realtime:** Socket.IO emits `ca` (new signal), `ca_update` (enrichment landed
or refresh) and `log`. The UI also polls every 15 s as a safety net.

**Access control:** CORS is an explicit allow-list (app origins + Vite dev).
`/api/test-hit` additionally refuses non-loopback callers, so nothing on your LAN
can inject fabricated signals.

---

## 10. User interface

**Dashboard** — three columns: filters, live feed, inspector. Opens directly;
there is no login gate, and settings are reachable from the top bar.

**Feed card** — token identity (logo, symbol, chain, launchpad), market cap
*at time of call*, liquidity, holders with top-10 %, copyable CA, the source row
(platform / chat / author), and the caller's own message with the contract
address highlighted in place. A call containing no words says so explicitly
rather than leaving a gap. Expanding reveals price, 24h volume, entry mcap,
multiplier, buys/sells/net/txs, age, 5m/1h/24h changes, top-10, dev holdings,
rug score and insider count, plus the safety source. Actions: refresh, quick buy
(GMGN, token page with referral), launchpad, X search, DexScreener.

**Wallet rows** — one population per row, each reading the same way, so the
same field can be compared down a stack of cards:

```
SMART MONEY  5 holding · 8 traded 24h ▲8 ▼0 · 7 in before the call · +$13.2K net
KOL          1 holding · 3 traded 24h ▲2 ▼1 · @XIGUA0903
LAUNCH       BUNDLED 13.97% 13 wallets · SNIPED 9.22% 21 wallets · NO DEX PAID
```

An earlier layout mixed holders with traders and KOL with smart money, so one
card showed two different "SMART" numbers and two "KOL" numbers with identities
floating between them. "Holding" (point-in-time holder list) and "traded"
(rolling trade feed) are now labelled rather than left as bare numbers that look
like they disagree. Handles link to X; anonymous smart-money wallets link to
their GMGN page.

**Callers** — every distinct person who called the CA, oldest first, the first
one marked. A card asserting "called 3×" has to show what makes up the three.

**Replies** — what people said back, as a scrollable thread under the message.

**Filters** — signal type (All / Called again / Watchlist), seven chains, and
per-chain launchpad pills. Unsupported combinations are visibly disabled rather
than silently inert. **Chain selections also gate desktop alerts**, so switching
a chain off stops both the cards and the notifications. A filter with no matches
explains itself instead of showing a blank column.

**Watchlist** — a star on every card; starred tokens get their own tab and an
amber edge in the main feed. Persists across restarts.

**Inspector** — deeper per-token view; dev-wallet history and full wallet
analysis load here on an explicit click, because together they are ~6 GMGN calls
and would otherwise starve the per-signal lookups every card needs.

**Signal history** — in-app panel of past alerts, since Windows toasts
auto-dismiss after 14 s.

---

## 11. Desktop notifications

Native Windows toasts cannot carry the buttons this needs, so the app draws its
own: a borderless, always-on-top `BrowserWindow` rendering `toast.html`.

- Stacks bottom-right, **max 4**, clamped to the work area so it can never
  overflow the screen.
- 14-second lifetime, queued beyond the visible limit.
- Shows logo, symbol, chain, launchpad, source and caller, market metrics,
  safety line, and the original message with the CA highlighted.
- Actions: Copy CA, DexScreener, Quick buy — all opening in your **real
  browser**, with your wallet session, never a sandboxed webview.
- Clicking the body focuses the app; the action buttons deliberately do not,
  and open through the main process rather than relying on `target="_blank"`.
- **Updates in place.** Holder counts and the DEX-Paid result take a few seconds
  longer than the alert itself, so rather than delaying the toast it fills in
  while still on screen.
- **Chain-gated.** The emitted signal carries a transient `_notify` hint derived
  from your chain filters; the toast layer obeys it.
- A toast is only ever raised by a genuine detection; there is no demo alert,
  because an alert that sometimes means nothing teaches you to ignore it.

---

## 12. Packaging and distribution

Portable single-file `.exe` (~73 MB) via electron-builder; no installer, no
admin rights. `START-INTEL.bat` at the workspace root launches the newest build.

**Packaging is the subtlest part of the system.** The server is ESM and runs as a
child process, which interacts badly with Electron's asar archive. The rule
learned the hard way: *once anything is unpacked, everything it resolves by
relative path must be unpacked with it.* Concretely — `server/`, `node_modules/`
and `client/dist/` are all `asarUnpack`ed; `server/package.json` declares
`"type": "module"` locally because the root manifest stays inside the archive;
the backend is spawned with `ELECTRON_RUN_AS_NODE=1` because `process.execPath`
is the Electron binary, not Node; and writable paths come from Electron's
`userData` because the app directory is read-only.

**A second packaged-only trap:** the backend runs as `electron.exe
--run-as-node`, so every child it spawns is Electron too. `gmgn-cli` parses
arguments with `commander`, which special-cases Electron and mis-slices `argv`
in a packaged app — reading the script path as a command name. **Every GMGN call
failed in the `.exe` while working perfectly in dev.** `server/gmgn-cli-shim.cjs`
makes the child look like plain node before handing over.

**Since 2026-08-05 the backend is bundled with esbuild** into
`dist-server/server.cjs`, so `node_modules` is not shipped at all. The unpacked
payload dropped from ~280 MB and thousands of files to **6 MB and 31 files**,
and cold start from ~60 s to **14 s**.

`gmgn-cli` is bundled separately to `dist-server/vendor/gmgn-cli/dist/index.mjs`
because it is *spawned* as its own process and therefore needs its own
resolvable dependencies — the vendor nesting exists so its runtime
`require("../package.json")` and `require("../../package.json")` both land
inside our tree.

Dev still runs `server/index.js` directly, so source edits need no rebuild.

**Diagnostics:** backend spawn, exit code, stdout and stderr always append to
`%APPDATA%\intel-command-deck\backend.log`. This is unconditional by design — it
was silence on this path that hid a chain of packaging failures.

---

## 13. Security and privacy

- Everything is local. No telemetry, no server, no account.
- Credentials live in `config.json`, git-ignored and **explicitly excluded from
  the build**. Each release is byte-scanned for the api_hash, session string,
  Discord token and GMGN key before shipping.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`.
- Every external link opens in the system browser; in-app navigation is
  restricted to the app's own origin.
- The Discord user token is stored in plaintext JSON — acceptable for a local
  app, and the reason that file must never be shared.

---

## 14. Coverage matrix

| Capability | Solana | BSC | Base | ETH | Robinhood |
| --- | --- | --- | --- | --- | --- |
| Detection + market data | ✅ | ✅ | ✅ | ✅ | ✅ |
| Token image / logo | ✅ | ✅ | ✅ | ✅ | ✅ |
| DEX Paid (paid profile) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Holder count | ✅ | ✅ | ✅ | ✅ | ✅ |
| Honeypot / tax / LP / renounced | ✅ | ✅ | ✅ | ❌ | ❌ |
| Insiders, rug score, creator wallet | ✅ | ❌ | ❌ | ❌ | ❌ |
| Dev history / survival rate | ✅ | ❌ | ❌ | ❌ | ❌ |
| Launchpad identification | ✅ | ✅ | ✅ | partial | ❌ |
| Named KOL / Smart Money wallets | ✅ | ✅ | ❌ | ❌ | ✅ |
| Aggregate smart-money flow (keyless) | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## 15. Rate limiting

GMGN's limiter is ~10 QPS with **escalating punishment** — retrying during a
cooldown extends the ban by 5 s each time, up to 5 minutes. The client therefore
uses a strict serial queue, a 1.2 s floor between calls, a 5-minute response
cache, and a hard 60–90 s stop on a genuine 429 rather than any retry.

One historical trap worth preserving: the limiter used to be triggered by a
regex over the whole response body, and `429` appears by coincidence inside fee
amounts and image URLs in a 77 KB payload — so **successful responses were being
discarded as rate limits**, and that self-inflicted cooldown then blocked
everything else. Responses are now parsed first and classified second.

---

## 15b. KOL and Smart Money (built)

Two independent sources, kept separate all the way to the screen:

**Named wallets — `server/kol.js`.** Polls GMGN's `track kol` and
`track smartmoney` across five chains every 60 s and indexes a chain-wide trade
firehose *by token*, which is what turns it into the question a card asks: "did
anyone notable touch this, and which way?" Six-hour rolling window, one entry
per wallet rather than per trade. Surfaces Twitter identity, buy/sell split, net
USD and a cluster count.

**Aggregate flow — `server/flow.js`.** Binance's public Web3 API: **free and
keyless**, giving net smart-money inflow per token across 1 h / 4 h / 24 h. This
is the only smart-money signal available with no GMGN key, and it keeps working
through a GMGN rate-limit cooldown because the two share no budget. Acceleration
compares the last hour against the average hour of the day — `12.75×` means
money is arriving 12.75 times faster right now than it has been.

**Risk wallets.** `GET /api/token/:chain/:ca/wallets` also reports
KOL and smart-money holders that still hold a live position. The bundler,
sniper and rat-trader tags were removed on 2026-08-03: all three saturated the 50-wallet
fetch page on nearly every token, so the count described the page limit rather
than the launch.

What these deliberately do **not** claim: the watcher only sees trades made
while the app is running (labelled *"since watching"*), and the holder lookup
only sees the largest positions (labelled *"top holders — not a complete
count"*). Neither is a complete KOL count.

## 16. What is deliberately not claimed
- **Callout counts** (`papi.gmgn.ai/callout`) need partner AK/SK credentials the
  Agent API key does not unlock.
- **X/Twitter mentions** — Inspector placeholder.
- **EVM dev history** — needs a block-explorer deployer lookup not yet built.
- **Landing page** demo — outlined, not built.

---

## 17. KOL research findings (2026-08-02)

Tested live against the GMGN API rather than inferred from documentation.
**KOL data is available on every chain the app supports**, with real identities:

| Chain | Distinct KOLs in a 40-trade sample | Identity attached |
| --- | --- | --- |
| BSC | 18 | @money_let7, @Christina_BNB, … |
| ETH | 18 | @dev_enjoys, @0xjvrsky, … |
| Base | 13 | @sadd_asd77675, @oooooyoung11, … |
| Robinhood | 10 | @dev_enjoys, @0xSpanny, … |
| Solana | 4 | @daumenxyz, @Sunnyikes, … |

Each record carries `twitter_username`, `twitter_name`, `avatar`, `tags`, trade
side, USD size, token address, symbol, logo and launchpad.

Two complementary sources, with different honest meanings:

**A — `track kol` (per chain, global feed).** Most recent KOL trades across the
whole chain. Polling one call per chain per minute stays far inside the rate
limit and builds a rolling token → KOLs index, giving a live *"KOLs are buying
this now"* signal. Limitation: it only sees trades that happen while the app is
watching, so it must be labelled as such.

**B — `token traders` (per token, on demand).** Returns top traders for one CA;
those with a `twitter_username` are KOLs. Verified: `@makupnl` surfaced on a
KOL-traded token. Limitation: top-N by position size only, so a small KOL
position is invisible — the honest label is *"KOLs among top holders"*, not
"all KOLs".

Recommended build: **B in the Inspector** (accurate, on demand) and **A as a
live feed badge** (timely), each labelled for what it actually measures. Neither
should be presented as a complete KOL count, because neither is.

---

## 18. Roadmap, in order of value

Items 1, 2 and 5 of the previous roadmap — caller accuracy scoring, esbuild
bundling, and GMGN key entry in the UI — all shipped on 2026-08-05. What remains
is provider-limited rather than a matter of effort:

1. **Surface `image_dup_count`** — how many other tokens reuse the same artwork.
   A genuine copycat indicator, already captured, not shown because no
   defensible threshold exists yet.
2. **EVM dev history** via a block-explorer deployer lookup. RugCheck supplies
   the creator wallet on Solana only, so dev survival rate stops at the chain
   boundary.
3. **EVM artwork gap** — DexScreener and GMGN both miss some BSC/Base tokens and
   ERC-20 has no metadata-URI standard to fall back on. Would need per-launchpad
   scraping; deliberately not done.
4. **Launchpad URL formats** for Flap and similar were never verified; they fall
   back to GMGN rather than risk a dead link.
5. **Callout counts** need GMGN partner AK/SK credentials the Agent key does not
   unlock.
6. **Landing page** with the interactive demo.
