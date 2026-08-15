# Changelog

Notable changes to the app. Landing-page and documentation work is not listed
unless it changes what the product does or claims.

Dates are when the change landed in the repository. The version headings mark
what was actually published to [Releases](../../releases) — code sitting under
**Unreleased** is in the repo but **not** in any downloadable build.

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
