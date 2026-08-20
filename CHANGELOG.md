# Changelog

Notable changes to the app. Landing-page and documentation work is not listed
unless it changes what the product does or claims.

Dates are when the change landed in the repository. The version headings mark
what was actually published to [Releases](../../releases) — code sitting under
**Unreleased** is in the repo but **not** in any downloadable build.

---

## v0.3.0

Everything below had been sitting in the repository unbuilt. The 0.2.1 download
contained none of it — its own API said so, answering 404 for endpoints this
release adds.

### Added

- **Peak tracking, and a board for it.** Every scoreboard scored a call by what
  the token is worth *now*, which for a memecoin is almost never the interesting
  number: one called at $8,062 that touched $64,616 and died was recorded as a
  total loss. Peak is now a stored fact, from a free high-water mark on every
  market-cap read plus a candle backfill over the window since the call.
  `GET /api/best-calls` ranks calls and rooms by how far they RAN, one row per
  token credited to whoever called it first. The current value stays beside it —
  "it did 8x" and "it is worth nothing now" are both true.
- **A second liquidity source.** DexScreener returns no liquidity object at all
  for a bonding-curve pair; on a 500-signal store that was 212 of the 245 blank
  rows. GMGN `token pool` and pump.fun's curve reserves now fill the gap, always
  measured the same way (the quote side of the pool, doubled) so the column means
  one thing on every row. The card names the source when it is not DexScreener.
- **`GET /api/launchpads`.** The filter list is published from the server's own
  detection map, so a chip exists exactly when detection exists.
- **Watchlist notification tiers.** Watchlist events get a compact note — about
  60% the height of a signal card, a shorter dwell, per-kind accents, and
  coalescing so three mentions read "called again ×3" instead of opening three
  windows.

### Changed

- **Watchlist alerts bypass the metric filters.** A market-cap max used to
  silence a starred token the moment it ran past it — the exact event you starred
  it for. Chain mutes still apply: muting a chain is a statement about how you
  want to be interrupted at all.
- **A restrained visual system.** Measured before the pass: eleven elements were
  painted in an accent before a single signal arrived, across five hues. Panels
  now separate by elevation rather than outlines, there is one accent plus a
  muted red for negatives, chain identity is a monochrome dot and a label rather
  than seven brand colours, and numbers are white unless they are a measured
  positive delta.
- **The Watchlist tab is reachable.** The feed kept its own tab list without it,
  so the tab existed in the left rail and not above the feed — where the feed
  already carried a written empty-state nothing could reach.

### Fixed

- **Candle windows were silently truncated.** The provider caps a page at 100
  candles and returns the most recent ones, so a 24h window at 1m resolution came
  back covering only the last 13.6h — dropping the launch spike. Resolution is
  now chosen to fit the whole window in one page. One BSC token went from a
  recorded 1.00x to a measured 1.40x once it stopped being cut.
- **Liquidity and peak were dead on four chains.** Both went through the
  deliberately narrow *security* chain map, so ethereum, robinhood, arc and
  stable returned nothing — with no error and no log line.
- **An impossible holder count reached the card.** A token was stored with
  622,770 holders against a $39,135 market cap: six cents of market cap per
  holder, from a provider whose only validation was "> 0". Counts are now bounded
  at $1 of market cap per holder — across 430 cross-checked rows the lowest
  genuine value was $1.17.
- **The scan snapshot froze too early.** Every field was captured the instant
  market cap existed, so liquidity arriving later was frozen null forever. Each
  field is now captured when that field first appears.
- **The launchpad list failed silently and permanently.** It was fetched once on
  mount with no retry, and the renderer routinely starts before the backend, so
  every chain read "no launchpad detected" for the whole session.
- The inspector claimed launchpads were undetectable outside Solana and blamed
  the wrong provider. Detection is dexId-based and covers four chains.

---

## Unreleased

### Fixed

- **KOL and smart-money tracking was dead in the portable build.** The
  chain-wide wallet watcher failed on every poll — 2,580 times across recent
  runs, 329 in a single session — with
  `Cannot find module '…app.asar.unpacked/dist-server/gmgn-cli-shim.cjs'`.

  `asarUnpack` listed `dist-server/**` where the `files` array uses
  `dist-server/**/*`. That trailing `/*` matters: the **portable** build's
  self-extractor created `app.asar.unpacked/dist-server/` as an empty directory
  and put nothing in it, while `win-unpacked` extracted correctly. Checking the
  unpacked build therefore showed a healthy tree, which is how this survived —
  only the artifact people actually download was broken.

  Consequences while broken: no chain-wide "a KOL just bought this" detection,
  and the `watchlist-wallet` alert could never fire at all. Per-token wallet
  exposure still worked, so the feature looked partly alive.

  Verified by inspecting the portable extraction directory before and after,
  then confirming the failure rate went to zero and `Notable wallet activity`
  lines resumed.

---

## v0.2.1

Two fixes to behaviour people had already hit. Both were in the repository for a
while before this build existed, which is the gap this file now exists to make
visible.

### Fixed

- **The metric filters never reached desktop alerts.** Setting a Market cap max
  emptied the feed and changed nothing about which calls raised a notification.
  The thresholds lived in the renderer and were applied only when building the
  feed; the alert path asked one question — the chain — and no metric was
  consulted anywhere in it.

  There is now a second, **opt-in** gate: *"Only alert me about calls matching
  these filters"* in the left rail. Off by default, because narrowing the feed
  is looking and silencing an alert is a decision — the same reason the chain
  pill and the bell are separate controls. The thresholds persist server-side
  and are written only by an explicit toggle.

  The gate deliberately reproduces the feed's quirks rather than tidying them,
  so the two can never disagree: an unknown metric passes, an unknown rug risk
  is blocked, and trade counts read as `0` (and are therefore blocked by a
  floor) rather than as unknown.

- **The sticky `LIVE FEED` header let cards scroll past above it.** The feed
  column has 20px of padding and a sticky child anchors to the padding box, so a
  20px strip above the header showed card content in full view — a card's green
  QUICK BUY bar could appear above the title. Negative margins move the box but
  not the anchor; the header now paints its own cover strip.

---

## v0.2.0

First public release. Installer and portable build for Windows 10/11, 64-bit.

- Reads the Telegram groups and Discord servers you are already in, using your
  own sessions, and detects contract addresses in what it reads.
- Drops scanner bots, and counts one call per distinct person rather than per
  message.
- Enriches surviving calls from DexScreener, RugCheck and GMGN, and pushes them
  to the desktop as a notification that fills in as data lands.
- Records the market cap at the moment of the call, so the multiplier measures
  the call rather than drifting with the chart.
- Shows every room a contract has spread to, across both platforms, and who
  called it first.
- Counts only wallets holding a live position, not everyone who ever traded.
- Renders `unknown` where a value was not fetched, and never shows a passing
  badge it did not earn.
- Runs entirely on your machine: no account, no server, no telemetry, no
  auto-update.

**Known at release:** the build is unsigned, so SmartScreen warns once. Callout
counts need GMGN partner credentials. Some chains have no safety provider, and
say so rather than guessing.
