# Brief: marketing materials for **intel. Command Deck**

You are designing marketing material for a real, working Windows desktop app.
Everything you produce must look like **the app that exists**, because the
product's credibility *is* the pitch.

Repo: https://github.com/dwdo1337/intel · Landing: https://dwdo1337.github.io/intel/

---

## 0. The two rules that override everything

> **1. You may not invent the product's appearance.**
> Every pixel of app UI must be a screenshot you captured from the running app,
> or markup you built by copying the app's real components and CSS tokens.
>
> **2. You may not show real people or real rooms.**
> The owner's live feed contains genuine chat names and genuine caller handles.
> Those must never appear. Use the seeded demo data in §3.

A previous attempt failed on rule 1: it was built from a *description* of the
app and produced a generic "crypto SaaS" look the product does not have.
Measured afterwards: **0 of 10** pages used the app's accent colour, and **7 of
10** made claims the product does not support. That work is archived in
`_archive-superseded/` — read its README before you start, it is a list of
exactly how this goes wrong.

**Run the app and look at it before you design anything.**

---

## 1. What the product is

You are in twenty Telegram and Discord rooms and you have one set of eyes.
intel. signs into those chats as you, reads them continuously, throws out the
scanner bots and the same person posting five times, and pushes the calls that
survive to your desktop — enriched with market data, safety checks, which known
wallets are already holding, and every room the call has spread to.

### The locked angle

> **The desk watches the rooms so you don't have to sit in front of them.**

The promise is **freedom of attention**, not "more data". The reader should
feel: *I can go hunt my own plays, work a chart, sleep, do my job — and I will
not miss the call.* Anything that makes intel. sound like **another feed to
babysit is off-brief**, however good the line is.

Supporting beats, in priority order:

1. **All your rooms, one desk** — Telegram + Discord, dozens of servers,
   hundreds of channels, one stream you did not have to read.
2. **The noise is already gone** — bots dropped, one human = one call.
3. **The notification is the product** — it arrives enriched and keeps filling in.
4. **You can watch a call spread** — the same CA reaching a second group, then a
   Discord server, is the signal.

---

## 2. Run the app

```bash
cd app
npm install && cd client && npm install && cd ..
npm run build
node server/index.js          # UI on http://127.0.0.1:5050
```

That URL **is** the real interface — the desktop app loads the same bundle
inside Electron.

For notifications you need the packaged build (`npm run electron:pack`, then
launch from `dist-electron/win-unpacked/`). The toast is a **separate borderless
Electron window** and will not appear in a browser screenshot.

---

## 3. Seed the demo data — MANDATORY before any capture

Never screenshot the owner's real feed. Seed your own calls with invented rooms
and callers against **real** tokens, so the market data is genuine and the
identities are not.

```bash
# NOTE the </dev/null — curl otherwise eats the loop's stdin and only the
# first item of each batch is ever sent. This wasted two attempts.
post(){ curl -s </dev/null -X POST http://127.0.0.1:5050/api/test-hit \
  -H 'Content-Type: application/json' \
  -d "{\"ca\":\"$1\",\"chain\":\"$2\",\"source\":\"$3\",\"chat_name\":\"$4\",\"author\":\"$5\",\"text\":\"$6\"}" >/dev/null; sleep 1; }

CA=<a real token address>
post $CA solana telegram "Alpha Signals"         "degenmike"   "early on this one, chart looks clean"
post $CA solana telegram "Alpha Signals"         "sol_sniper"  "confirming, im in"
post $CA solana telegram "Moonshot Lounge"       "kryptokate"  "same call here, sending it"
post $CA solana discord  "Trench Club / #calls"  "0xharvest"   "picked this up too"
```

Pick addresses from `https://api.dexscreener.com/token-profiles/latest/v1` or
`/token-boosts/latest/v1` — take ones that have a pair, artwork **and**
liquidity, or the card renders half-empty.

**Approved fictional names** (reuse these for consistency across all material):

| Rooms | Callers |
| --- | --- |
| Alpha Signals *(TG)* · Moonshot Lounge *(TG)* · Trench Club / #calls *(DC)* · Trench Club / #alpha *(DC)* | degenmike · sol_sniper · kryptokate · 0xharvest · vaultrunner · nightcrawler · zerofrost · whale_watcher |

Then **isolate them**: type a room name or token symbol into the app's top
search box. The feed filters to matching cards only, so nothing real is on
screen. Verify before every capture:

```bash
curl -s http://127.0.0.1:5050/api/react-feed | grep -c "Manifesting Riches\|The Calbal\|Inner Circle"   # must be 0 in shot
```

---

## 4. Capture list

At 2× where possible. The app window is 1400×900 by default.

| # | Shot | Notes |
| --- | --- | --- |
| 1 | Full deck, filtered to demo data | the hero |
| 2 | Single feed card, tight crop | one with **CALLED IN** showing 3 rooms |
| 3 | The **CALLED IN** row alone | the cross-source story |
| 4 | Desktop notification | see below — the money shot |
| 5 | Watchlist re-alert toast | violet pill, "★ WATCHLIST · CALLED 2×" |
| 6 | Inspector, holder distribution | right column |
| 7 | Sources → Discord, a server expanded | proof of reach |
| 8 | Chain rail with bell toggles | the two-control idea |
| 9 | Settings / connect screen | shows "local only" |
| 10 | Caller track record on a card | median × / win rate |

**Toast capture:** fire a `test-hit` on an enabled chain, then **wait ~3
seconds**. It opens with market data and fills in — DEX Paid resolves, artwork
loads, holders and KOL handles arrive. A shot at t=0 says "DEX Paid · checking…"
and undersells the whole product. Hover to pause the 14 s auto-close.

**Capture safely:** verify the app is the foreground window before shooting. A
naive capture grabbed a fullscreen game instead, twice.

---

## 5. The real design system — copy, do not approximate

From `app/client/src/index.css`:

```
--bg #07080c   --surface #0c0e14   --surface2 #11131c
--line #1d2230 --line2 #2a3043
--text #f0f2f7 --muted #7d879b --dim #4f5a70
--accent #4fe3a0   --accent2 #7ff8c2   --accent-dim rgba(79,227,168,.14)
--buy #22c55e  --sell #ef4444  --warn #f59e0b
--tg #3b82f6 (Telegram)   --dc #a855f7 (Discord)
Solana #9945FF  Robinhood #00C805  Base #0052FF  BSC #F0B90B  Ethereum #627EEA
```

- **Inter** for UI. Labels 9–11px, uppercase, `letter-spacing:.05em`, `--muted`.
- **JetBrains Mono** for every number, ticker and address. Non-negotiable.
- Radii 12px cards / 8px inner / 999px pills. **1px hairline** borders.
- Cards use a grid label gutter: `grid-template-columns: 84px minmax(0,1fr)`.
  That alignment is what makes it feel engineered — reproduce it.
- Density is the aesthetic. Terminal / trading desk, **not** consumer SaaS.
  No stock photos, no 3D coins, no purple gradient meshes, no whitespace-heavy
  hero sections.

Source files worth reading: `client/src/components/Feed.jsx`,
`components/feed-card.css`, `electron/toast.html`, `client/src/index.css`,
`components/Inspector.jsx`, `components/Filters.jsx`.

---

## 6. Verified claims — use these, invent nothing

Measured on a live install:

- **500 tokens** across **6 chains** (Solana, Robinhood, BSC, Base, Ethereum, Unichain)
- **18 Discord servers / 1,295 channels** reachable from one account
- **205 of 500** tokens called by more than one person
- DEX-paid resolved on **500 of 500**
- Enrichment lands **50–460 ms** after the alert fires
- Cold start **~14 s**; portable `.exe` or a per-user installer, no admin needed
- Fully local — no account, no server, no telemetry

### Never say

❌ "Never miss a signal again" (fear-based, every bot says it) · ❌ "real-time
alpha firehose" (a firehose is the problem this removes) · ❌ anything framing it
as another feed to monitor · ❌ "no API keys needed" (GMGN needs one) · ❌ X /
4chan / Farcaster / Truth Social as sources (**only Telegram and Discord**) ·
❌ GoPlus (never integrated) · ❌ "native toasts" (deliberately not native) ·
❌ ticker matching (contract addresses only) · ❌ any price, plan or trial ·
❌ invented metrics, fake testimonials, fake user counts

**Never photoshop a better number into a screenshot.** Where the real UI shows
`unknown` or `—`, leave it. The honesty is a selling point.

---

## 7. Deliverables

Where a count is given, they must be **genuinely different concepts** — different
visual idea *and* different headline — not one layout recoloured.

### A · Core visuals
1. **Hero images ×4** — 1600×900 + 1080×1080. Concepts: deck at rest with one
   toast arriving · split "wall of unread chats | one calm card" · over-the-
   shoulder, desk working while the owner is elsewhere · the notification alone at 2×.
2. **Product shot ×1** — the deck, annotated with numbered callouts.
3. **Notification hero ×2** — the toast at 2×, one fresh signal, one watchlist re-alert.
4. **Feature sections ×8** — one per capability, real UI crop + headline + one
   sentence: all-rooms ingest · bot filtering · the notification · cross-source
   spread · frozen entry & multiplier · KOL/smart-money holders · safety &
   DEX-paid · caller track record.

### B · Social
5. **X/Twitter posts ×12** — 1200×675. Mix: single-stat cards, real card crops
   with one line, before/after attention framings. **≥4 must feature the toast.**
6. **Vertical cards ×6** — 1080×1350 for IG/TG.
7. **X thread ×2** — 6–8 tweets each, one narrative ("I closed every chat
   window"), one technical (how the filtering works).
8. **Telegram announcement post ×3** — short, image + copy, for posting in groups.
9. **Profile kit** — X banner 1500×500, avatar, TG channel header.

### C · Motion
10. **Demo storyboard ×1** — 6–10 frames for a ≤30 s screen recording: call lands
    → intel. filters it → toast appears → enrichment fills in live → one click to
    the chart. **Frame 1 establishes the person is not watching the chats.**
11. **Loop GIF specs ×3** — toast filling in · CALLED IN row growing · chain
    filter muting a chain.

### D · Long form
12. **Landing page ×1** — hero · problem · notification · deck · cross-source ·
    sources · safety · local-by-design · download. Built from real component markup.
13. **README hero block** — banner + badge row for the repo.
14. **One-pager PDF ×1** — A4, for sending to someone directly.
15. **Comparison table ×1** — vs. "sitting in 20 chats" and vs. generic scanner
    bots. Honest: name what intel. does *not* do.
16. **FAQ card set ×6** — the real objections: is this against ToS? · does it
    touch my keys? · what if I have no GMGN key? · why unsigned? · does it trade
    for me? (no) · where does my data go?

### E · Brand
17. **Brand kit ×1** — logo usage, the palette above, type scale, do/don't.
18. **Icon set** — the chain/platform marks as used in-app.

Deliver as self-contained HTML in `design/promo/` (inline CSS, images as data
URIs) plus exported PNGs.

---

## 8. Voice

Terse, technical, confident. The reader is an experienced trader sick of being
marketed at. Short declaratives. Concrete numbers over adjectives.

> "Twenty rooms. One set of eyes. Now neither is the bottleneck."
> "'Called 7×' usually means one person and six bots. This counts people."
> "Close the chats. Go hunt. The calls will find you."

Never promise profit, returns, or that a call is good.

---

## 9. Before you ship

Answer in writing:

1. Did I run the app and capture these myself? Which shots, when?
2. **Does any screenshot contain a real chat name or caller handle?** (Must be no.)
3. Open a material beside the running app — same colours, fonts, spacing, labels?
4. Is every number traceable to §6 or to a screenshot?
5. Does every headline serve *"the desk watches so you don't have to"*, or did
   some drift into "more data, more alerts"?
6. Mono for every numeral?
7. Any invented UI — a button, panel or field the app does not have? Remove it.
8. Does at least one material make a viewer understand, without reading, that
   **they can walk away from the screen**?

If you cannot answer #1 and #2 with specifics, you have not done the job.

---

**Copywriting doctrine, the three-phase campaign (pre-launch / launch / post-launch),
the full motion list and the package structure are in
[CAMPAIGN-BRIEF.md](CAMPAIGN-BRIEF.md) — read it as Part Two.**
