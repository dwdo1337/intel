# intel. Command Deck — what it does and how

A plain-English walkthrough of the whole app, in the order things actually
happen. For the engineering detail see [OVERVIEW.md](OVERVIEW.md); for the
build log and every known limitation see [../app/AGENTS.md](../app/AGENTS.md).

---

## The one-sentence version

It logs into your Telegram and Discord as **you**, reads every message in the
groups you choose, spots contract addresses, throws away the noise, checks who
is actually holding the token, and puts a desktop alert in front of you — so
you never have to read the chats.

---

## 1. It listens as you, not as a bot

A bot cannot read arbitrary group history. You can. So the app authenticates
with **your own** Telegram session (phone → SMS code → 2FA) and your Discord
user token. Everything stays on your machine: no server, no account, no
telemetry.

You pick which groups and channels to watch, and can narrow any group to
specific people (allow-list) or silence individuals (block-list).

---

## 2. It finds contract addresses

Every message is scanned for two patterns: `0x…` (40 hex) for EVM chains, and
base58 32–44 characters for Solana.

Addresses are **deduplicated per message**, because a call almost always
contains the CA twice — once as text and once inside a pump.fun or DexScreener
link. Without that, a single message registered as two calls and a brand-new
token appeared to be "called 2×" the instant it showed up.

---

## 3. It throws away the noise — this is the actual product

One genuine call produces this within seconds:

| Message | Who | Counted? |
| --- | --- | --- |
| `EPXWa7…x2nJBY` | a human | **yes — the real call** |
| same CA + chart | Rick (bot) | no |
| same CA + stats | Phanes (bot) | no |
| same CA in 4 other groups | the same human again | no |

Counted naively that reads as "called 7×", so every token looks hot and the
number means nothing. Three rules prevent it:

- **Echo bots are dropped entirely** — Rick, Phanes, Maestro, BullX, Trojan,
  Photon, GMGN bot and friends. A scanner reacting to a human is never an
  original call. They are still counted separately as `echoCount` so you can
  see the noise level.
- **One opinion per person.** The same caller posting to five of their own
  groups is one opinion. A follow-up must come from a genuinely *different*
  person.
- **Per-chat sender rules**, if you want a group narrowed further.

So **"called 3×" means three different people**, and the card lists all of them
with the first one highlighted.

---

## 4. It enriches, in stages, and never blocks on a slow provider

| Stage | Source | What you get |
| --- | --- | --- |
| 1 | DexScreener | name, symbol, market cap, liquidity, price, volume, socials, launchpad, image |
| 2 | DexScreener orders | **DEX Paid** — whether the profile is genuinely paid for |
| 3 | RugCheck *(Solana)* | holders, top-10 %, insiders, rug score, creator wallet |
| 4 | GMGN security *(sol/bsc/base)* | honeypot, buy/sell tax, LP burned, renounced |
| 5 | GMGN token info *(all chains)* | logo, banner, holder count |
| 6 | GMGN holders *(Solana, BSC, Robinhood)* | **who is holding it: KOLs and smart money** |

Each stage updates the card as it lands, so you see the signal immediately and
detail fills in behind it. If a provider is down, rate-limited, or doesn't
cover that chain, the field stays **unknown** — it never guesses.

---

## 5. It tells you who is in the coin

This is the part that matters when an alert fires, and it comes from two
independent sources that answer different questions:

**Who HOLDS it right now** — checked at scan and again whenever you refresh.
One row per kind of wallet, each stating a count and then who they actually are:

```
SMART MONEY  24 holding   0x92…ca82  @zatchbell85  0x63…d757  @HUHUHU69420
KOL          17 holding   @hzjxhcyy  @feibo03  @XIGUA0903  @aa_AFeng
```

- **holding** — wallets that hold the token *right now*, from the current
  holder list. This is what matters when an alert fires.
- Every name links out: a handle opens that person's X profile, an address
  opens that wallet on GMGN. Handles come first, then the largest positions.
- The row carries **nothing else on purpose**. It answers one question — who is
  in this, right now. Trade-flow statistics (how many traded, which direction,
  net USD, who was in before the call) answer a different question over a
  different time window, and interleaving them made the row harder to read
  rather than more informative. That detail lives in the Inspector.

**SMART MONEY and KOL are deliberately different rows.** Smart money is a
statistically proven profitable record; a KOL is social reach. Merging them into
one "notable wallets" number would destroy the distinction that makes either
useful — and an earlier layout that interleaved them was simply unreadable.

**"holding" means a live position right now.** GMGN's holder list contains every
tagged wallet that has *traded* the token, reporting a zero balance for those
who exited — so a KOL who bought and dumped is excluded rather than counted as
a holder.

**Solana, BSC and Robinhood only.** GMGN returns no holder data at all for Base
or Ethereum, so those cards show no wallet rows rather than a zero that was
never measured.

Named handles link to X; anonymous smart-money wallets link to their GMGN page.
A count of `50+` means the list was truncated at our fetch limit, not that
exactly 50 wallets exist.

---

## 6. It shows you the call, not just the token

The card carries the **caller's own message** with the contract address
highlighted inside it, every distinct caller listed with the first marked, and
the source chain — Telegram or Discord, which group, which person. When someone
just pasted an address with no words, it says so rather than leaving a gap.

---

---

## 6b. It shows what people said back

When someone **replies** to a call — on Telegram or Discord, including replies to
replies and Discord threads — that reply is attached to the token. This is often
where the real signal is: *"aped 2 sol"*, *"dev already sold"*, *"this is the guy
who rugged X"*. Bot replies are dropped by the same guard that silences echo
bots as callers.

Only replies made while the app is running can be seen; history is not
backfilled.

---

## 6b2. It tells you whether that caller is any good

Beside a caller's handle, once there is enough evidence, sits their record:

```
@someone   0.42× med  n9
```

That is the **median** multiple across their scored calls, and how many calls it
rests on. Median rather than average on purpose — one lucky 40× would otherwise
rank a one-hit caller above a consistently good one. Hovering shows the win rate,
how often their calls fell below 0.2×, and their best.

It is measured against the market cap **at the moment they called it**, which is
why that number is frozen and never drifts.

**A record only counts calls whose outcome has actually been re-read**, and the
app never re-prices on a timer. So run **Settings → Update caller records** now
and then; it re-prices every token via DexScreener (free, no API key) and takes
about a minute. Nothing is shown for a caller until at least 3 of their calls
are scored and a third of them are covered — a median built on two data points
is not a track record.

---

## 6c. You can keep a watchlist

A star on every card. Starred tokens get their own tab and an amber edge in the
main feed, and survive restarts. This is separate from **Called again**, which
means several *different people* called it — one is your choice, the other is
the crowd's.

---

## 7. It freezes the moment of the call

The market cap on the card is **what it was when the call fired**, and it never
drifts on its own. Until you refresh, every headline number is labelled
*at time of call*:

```
MARKET CAP  $492.5K          LIQUIDITY  $55.0K
            at time of call             Solana pair
```

Once you refresh, the card leads with what is true **now** and keeps the
call-time figure beside it as the reference:

```
MARKET CAP  $5.3K                LIQUIDITY  $9.1K
            −24.0% · was $6.9K              −12.9% · was $10.5K
```

That is also what makes the **multiplier** trustworthy — measured against the
market cap at first detection, persisted to disk so a restart cannot silently
reset every token's performance to 1×.

### When numbers are read — exactly twice

The app reads a token's metrics at **two** moments, and never on a timer:

1. **When a call is caught**, feeding the card and the desktop alert.
2. **When you press refresh** on that card.

Nothing re-scans in the background. A card therefore shows what was true when
it was captured until you ask for more — which is why refresh matters on
anything you starred days ago.

*(The KOL / smart-money trade feed does update live, but that is who is trading
the token right now, not a re-reading of the token's own metrics.)*

### What refresh actually does

Refresh is a full re-scan, not just a price check. One press re-asks **every**
provider, bypassing all caches:

| Re-read | Frozen, never touched |
| --- | --- |
| price, market cap, liquidity, volume | market cap at the call (`scan_*`) |
| holder count and top-10 concentration | entry market cap and multiplier |
| honeypot, taxes, LP burned, renounced | who called it, and when |
| rug score, insiders, dev wallet (Solana) | your watchlist star |
| KOL / smart-money holders | the caller's original message |
| name, symbol, launchpad, socials, artwork | |

This matters most for a token you starred days ago: a card can be stale in ways
that are invisible — holders leaving, concentration rising, a safety provider
that was simply down when the token was first seen. Refresh is what corrects it.

Each provider updates the card as it lands, so the numbers fill in over a few
seconds rather than all at once. If a refresh cannot complete — usually because
DexScreener has no pair for the token any more — the card says so instead of
leaving the old numbers looking freshly confirmed.

---

## 8. It alerts you

A custom borderless desktop toast (Windows' native toasts cannot carry buttons):
logo, symbol, chain, launchpad, source and caller, market metrics, the original
message with the CA highlighted, and **Copy CA / DexScreener / Quick buy** —
opening in your real browser with your wallet session, never a sandboxed
webview. Maximum four stacked, 14 seconds each, clicking one focuses the app.

The toast **fills in while it is on screen** — holder counts and the DEX-Paid
result take a few seconds longer than the alert itself, and delaying the alert to
wait for them would defeat the point.

**Your chain filters control alerts too.** Switching Solana off in the filter
panel stops Solana cards *and* Solana notifications.

A toast only ever means a genuine detection. There is no demo alert, because an
alert that sometimes means nothing teaches you to ignore it.

---

## 9. What it deliberately does not do

- **It does not guess a launchpad.** A Robinhood token trading on Uniswap tells
  you the AMM, not whether it launched via hood.fun, NOXA or PONS. Those stay
  blank and their filter pills stay disabled.
- **It does not invent safety data.** Rug score, insider clusters and dev wallet
  come from RugCheck, which is Solana-only. On EVM those read *unknown*, and the
  card says exactly which fields are missing rather than a blanket disclaimer.
- **It does not show a zero it cannot justify.** "We didn't check" and "nobody
  is in it" are different facts; only one is a reason not to buy.
- **It does not invent a liquidity figure.** A pump.fun token still on the
  bonding curve has no pool, so DexScreener reports none and the card shows `—`.
- **It cannot see trades from before it was running.** The live wallet feed is a
  rolling window, and the card labels it *since watching* or *since call* so you
  know which.

---

## Quick reference

| | |
| --- | --- |
| Launch | `START-INTEL.bat` (first run ~60s while it self-extracts) |
| Settings / login | gear icon in the top bar |
| Your data | `%APPDATA%\intel-command-deck\` |
| Diagnostics | `%APPDATA%\intel-command-deck\backend.log` |
| GMGN key | manual edit of `config.json` in that folder — no UI yet |
| Rebuild | `cd app && npm run electron:pack` |
