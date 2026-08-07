# intel. Command Deck — where development stands

Last updated 2026-08-06. See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for what the app
does, [OVERVIEW.md](OVERVIEW.md) for architecture, [../app/AGENTS.md](../app/AGENTS.md)
for the full engineering log.

---

## Current operating state

| | |
| --- | --- |
| Telegram | connected |
| Discord | **no token** — the stored one was truncated and removed; paste a new one in Settings |
| GMGN key | set, working |
| Tokens tracked | ~480 |
| **Alert chains** | user-controlled per chain — read the live value from `/api/notify-prefs`, never assume |
| Caller-record coverage | decays as new calls arrive; refresh from Settings |

**Before treating "no toasts" as a bug, check which chains are muted.** The
token mix is heavily skewed — solana 323, robinhood 117, bsc 41 — so muting
Solana and Robinhood silences **~91% of all incoming signals**, and a near-silent
desktop is the correct outcome of that setting.

That is exactly what happened on 2026-08-06: 135 suppressed vs 5 raised, with
both chains switched off at 17:23 the previous run. The toast path itself was
verified working end to end. Diagnostic commands are in
[../app/AGENT-BRIEF.md](../app/AGENT-BRIEF.md) §7.

Alerts are toggled by the **bell** on each chain pill; the pill itself only
filters the feed.

---

## Where we are

**The app works end to end**, verified in the packaged `.exe` running on live
Telegram chats: it filters the noise, enriches from five providers, tells you
who holds the token, alerts you, and ships as a portable executable.

At the start of this work it **crashed on launch and had never once run
packaged**.

| | Before | Now |
| --- | --- | --- |
| Packaged app | crashed instantly | runs, verified end to end |
| Backend in the `.exe` | never started | starts, binds, Telegram connects |
| **All GMGN features in the `.exe`** | **silently failed on every call** | working (193 tokens indexed) |
| Login / history persistence | impossible (read-only path) | works |
| Live updates in the `.exe` | CORS-blocked, silent 15s poll | real-time |
| Token images | 14 of 28 blank | 161 of 161, four-source chain |
| EVM holder counts | "unavailable" everywhere | real numbers |
| DEX Paid | hardcoded `false` on everything | checked on 161/161 (88 paid) |
| Quick buy links | wrong chain / dead page | correct per chain, verified |
| Caller's message | deleted from the card | shown, CA highlighted, scrollable |
| KOL / smart money | did not exist | holders at scan + live trade feed |
| Toast buttons | dead (render crashed mid-way) | working |
| Duplicate tokens | 7 split by address casing | merged, 0 duplicates |
| "Called again" | any repeat, incl. same person twice | genuinely different callers only |
| Chain filters | hid from feed, still alerted | gate alerts too |
| Diagnostics | discarded when packaged | always written to disk |
| **Refresh** | **re-read price only; a card that failed enrichment could never be repaired** | full re-scan of every provider |
| Inspector | could show a token not in the filtered feed | follows the filter |
| Unknown safety values | rendered as a green, measured `0%` | render as `unknown`, uncoloured |
| Invalid Discord token | reconnected every 5 s forever, flooding the log | reported once, backs off |
| Checksummed EVM address on the API | 404 — no route normalised it | resolves |
| **Chain alert filter** | **silently reset itself to "alert on everything" whenever the renderer started fresh** | stored server-side, only a real toggle writes it |
| Switching off *every* chain | alerted on every chain | alerts on none |
| Notification history | recorded muted chains too | obeys the same filter |
| Feed card layout | six different left edges, five nested container styles | one label gutter, hairline rows |
| Wallet rows | names thrown to the far right, wide empty band | names sit next to their count |
| Contract address | rendered twice when the message was only the CA | once |
| **Chain alerts** | **one pill gated both the feed and alerts, so browsing a chain re-armed its toasts** | two controls: pill = feed, bell = alerts |
| Alert preference | any client could overwrite it silently | only an explicit toggle, everything else refused + logged |
| Electron main-process log | dev-only, so packaged builds had no record of alert decisions | always written to backend.log |
| Alert KOL/smart counts | fell back to the trade-window number under the holder label | holder counts only; blank until known |
| Wallet data on a GMGN blip | a failed lookup wiped a good count | only overwritten when that lookup answered |
| **"KOL holding"** | **counted every KOL who ever traded it — BUDDY said "17 holding" with zero actually holding** | wallets with a live position only |
| Inspector wallet panel | third surface still listing sold-out KOLs, from a stale cache | filtered + cache-bypassed |
| Base / ETH wallet data | GMGN returns an empty list — recorded as a measured zero | reported as unavailable |
| Bundler / sniper | saturated the 50-wallet fetch page on nearly every token | removed everywhere |
| Alert wallet info | bare counts | KOL and smart-money handles |
| **"unknown" everywhere** | **fields that do not exist on a chain were labelled unknown — 2 phantom unknowns on all 226 Solana cards** | not-applicable-on-this-chain fields are absent, with one line saying why |
| **Caller track record** | **did not exist** | median multiple, win rate and rug rate per caller, on the card |
| GMGN API key | manual `config.json` edit, no UI | Settings field |
| Stored wallet counts | 250+ tokens overstating KOL/smart holders | corrected by a one-shot sweep |
| **Toast IPC bridge** | **dead — `contextBridge` needs `contextIsolation:true`, which was off, so toasts never updated after opening** | live; DEX-paid, artwork, holders and KOLs fill in |
| Toast risk score | plumbed through and never drawn | shown, null-guarded |
| Toast caller record | not shown | median multiple + win rate, hidden below 3 scored calls |
| Toast artwork | `<img>` rebuilt on every one of ~12 updates, restarting the download each time | rebuilt only when the URL changes |
| **Discord channel list** | **empty — built only from `GUILD_CREATE`, which a user token never sends** | 19 guilds / 1295 channels |
| **Column scrolling** | **height chain uncapped (71550px page) + two nested `.feed-col` scrollers, so one wheel moved everything** | each column scrolls alone |
| Launchpad on non-Solana chains | "unknown" on 121/122 Robinhood tokens | "not detectable on <chain>" |
| Empty liquidity | "no pool data" — read as a failed fetch | "bonding curve · no pair yet" (verified 10/10 genuinely have no pool) |
| **Discord channel picking** | **saved to config and never read — the filter used a guild list the UI never wrote** | server-level, channel-level, or both |
| Discord member rules | per-channel only (retype into all 434 channels of a server) | per server, keyed by guild id |
| Sender-rule inputs | committed on blur — typing a name then clicking Save lost it | committed on change |
| Discord source list | 1297 channels in one flat wall | servers collapsed, counts, search, select-all |
| Alert reason | every toast said "new signal" | new / watchlist called-again / rescanned / smart-money-in |
| Watchlist re-alerts | a starred token could be called again in silence | alerts, labelled |
| Toast window | fixed 430px, buttons clipped when KOL handles landed | resizes to content (260-640) |
| **Cold start** | **~60 s, ~280 MB left in `%TEMP%` every launch** | **14 s, 6 MB — server bundled with esbuild** |

---

## What is built and verified

**Ingest & filtering** — Telegram (GramJS user session) + Discord gateway.
Echo-bot guard, distinct-caller rule, per-chat allow/block lists. "Called 3×"
means three different people, and the card lists them with the first marked.

**Enrichment** — DexScreener → DEX-paid check → artwork → RugCheck → GMGN
security → GMGN holders, staged and fail-open, each updating the card as it
lands. Priority queue so a signal on screen is served before background sweeps.

**Wallet intelligence** — KOL and smart-money holders fetched at scan and on
every refresh, counting only wallets with a live position; a live KOL/smart
trade feed split into
"already in" vs "since call"; keyless aggregate smart-money flow with
acceleration. Rendered one population per row.

**Replies** — messages replying to a call are captured on both platforms,
including reply-to-reply chains and Discord threads.

**Watchlist** — star any token to keep it in its own tab. Distinct from the
"Called again" filter; the watchlist is only what *you* chose. Persists.

**Alerts** — custom borderless toast: metrics, message with CA highlighted,
KOL/smart counts and handles, working Copy CA / DexScreener /
Quick buy. Updates in place as enrichment lands. Chain filters gate which
tokens are allowed to raise one.

**Packaging** — portable `.exe`, credentials excluded and byte-verified absent,
self-healing migrations on boot, `backend.log` always written.

---

## What is NOT done

Ordered by what would matter most.

### 1. EVM tokens can still lack artwork
The metadata-URI fallback is Solana-only, because that URI comes from RugCheck.
ERC-20 has no equivalent standard, so BSC/Base tokens that DexScreener and GMGN
both lack would need per-launchpad scraping — fragile, deliberately not done.

### 2. Smaller gaps
- **Launchpad links** for Flap and similar fall back to GMGN; their URL formats
  were never verified, and inventing one produces dead links.
- **Free-form chatter** about a token isn't captured — only actual replies.
  Ticker matching would work but throws false positives on symbols like `UP`.
- **Callout counts** need GMGN partner credentials (AK/SK).
- **Landing page** demo in `design/promo/landing/` is outlined, not built.
  Briefed in [../design/promo/DESIGN-AGENT-PROMPT.md](../design/promo/DESIGN-AGENT-PROMPT.md),
  which supersedes the earlier `AGENT-PROMPT.md` (that one produced generic
  material because it described the app instead of requiring screenshots of it).
- **New chains arrive without a filter pill.** `unichain` appeared in the feed
  on 2026-08-06: detected and priced, but no safety provider, no GMGN holder
  data, and no pill — so it cannot be muted from the UI. Same gap Stable and Arc
  have. Add to `CHAIN_LAUNCHPADS` in `Filters.jsx` when one starts producing
  real volume.
- **`image_dup_count`** is collected (how many other tokens reuse the same art —
  a copycat signal) but not surfaced, because no defensible threshold exists.

---

## Known limits that are permanent, not bugs

- The live wallet feed only sees trades made **while the app is running**;
  labelled "since watching" / "in before the call" rather than implied complete.
- Holder lookups see the **top 50 by position size**, so a small KOL position is
  invisible and a full page renders as `50+`, never a bare `50`.
- Rug score, insider clusters and dev wallet are **Solana-only** (RugCheck).
- **Robinhood chain** has no safety provider at all.
- Launchpads deploying to a shared AMM **cannot** be identified; left blank.
- Pump.fun tokens still on the bonding curve have **no liquidity figure** —
  DexScreener genuinely reports none, so the card shows `—`.

---

## If you only do one more thing

Nothing structural is outstanding. What remains is provider-limited: EVM
artwork has no reliable source, launchpad URL formats for Flap and similar were
never verified, and callout counts need GMGN partner credentials.

The one habit worth keeping: run **Settings → Update caller records** after a
spell away. A caller's median is computed only over calls whose outcome has
actually been re-priced, and nothing re-prices on a timer — so coverage decays
as new calls arrive.

---

## Publishing

`github-release/` is an upload-ready copy of the source: app code, docs, an
example config, licence, `.gitignore`, the landing page, and two agent briefs.
It contains **no credentials, no `data/`, no build output and no machine-specific
paths** — verified by scanning every real credential value from the live config
against every file in the directory.

- [../github-release/README.md](../github-release/README.md) — the public README
- [../github-release/PUBLISHING.md](../github-release/PUBLISHING.md) — how to push and cut a release
- [../github-release/AGENT-SETUP-PROMPT.md](../github-release/AGENT-SETUP-PROMPT.md) — hand to an agent to install and verify

The app now builds **two** Windows artifacts (`npm run electron:pack`):

| artifact | what |
| --- | --- |
| `intel-Command-Deck-Setup-<v>.exe` | NSIS wizard, per-user, no admin/UAC, keeps AppData on uninstall |
| `intel-Command-Deck-Portable-<v>.exe` | single file, unpacks per launch |

Both are byte-scanned for credentials before release.

---

## Marketing material — cleaned out 2026-08-07

The old promo pack was archived to `_archive-superseded/`, not edited, because
it advertised a product that does not exist. Measured before archiving:

- **0 of 10** promo pages used the app's accent colour `#4fe3a0` — they did not
  match the interface at all.
- **7 of 10** carried claims from the "do not use" table in
  [../design/promo/COPY-TEXTS.md](../design/promo/COPY-TEXTS.md): 4chan /
  Farcaster / Truth Social as sources (only Telegram and Discord exist), GoPlus
  (never integrated), "Native toast" (deliberately not native), "Never miss",
  and a "7-day trial" for a product with no payment system.

Also archived: 17 pre-build UI mockups, screenshots predating the card and
toast redesigns, the brief that produced the false material
(`AGENT-PROMPT.md`), and `public-repo/` (superseded by `github-release/`).

`_archive-superseded/README.md` records exactly why each item went and can be
deleted wholesale once reviewed.

**What survives is current:** `DESIGN-AGENT-PROMPT.md` (real tokens, mandatory
screenshot procedure, verified claims), `COPY-TEXTS.md`, the landing page, and
the brand assets.

**Still outstanding:** the replacement material itself. It requires screenshots
of the running app, which needs the app in the foreground — attempted and
abandoned on 2026-08-07 because a fullscreen game held focus and the capture
grabbed the wrong window. The brief is ready; the pages are not built.
