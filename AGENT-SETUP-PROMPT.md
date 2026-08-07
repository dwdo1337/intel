# Setup brief — install and verify intel. Command Deck

Hand this file to a coding agent (or a new contributor). It is self-contained:
everything needed to go from a fresh clone to a verified, running app.

---

## Your task

Install this repository, get it running, and **prove** it works. Do not report
success until you have completed the verification in §5 and can paste the actual
output.

---

## 0. Rules

1. **Never print, commit, or paste the contents of `config.json`.** It holds a
   Telegram `api_hash`, a login session, and a Discord user token in plaintext.
   Report *whether* a field is set, never its value.
2. **Never commit `config.json`, `data/`, `node_modules/`, or anything in
   `dist*/`.** They are git-ignored; keep it that way.
3. **The user enters their own credentials.** Do not ask them to paste a token
   into the chat, and do not enter credentials on their behalf. Point them at
   the Settings screen in the app.
4. If a step fails, **read the error and fix the cause.** Do not skip a step and
   describe the remainder as done.

---

## 1. Prerequisites

| | Version | Check |
| --- | --- | --- |
| Node.js | **20 or newer** | `node --version` |
| npm | 9+ | `npm --version` |
| OS | Windows 10/11 for the packaged app | — |
| Git | any | `git --version` |

The backend and UI run on macOS/Linux too, but the desktop notification layer
and the packaging targets are Windows-only.

---

## 2. Install

```bash
npm install
cd client && npm install && cd ..
```

Two `package.json` files — the root (Electron + backend) and `client/` (the
React UI). Installing only the root leaves the UI unbuildable, which surfaces
much later as a blank window.

---

## 3. Build

```bash
npm run build          # React UI  -> client/dist
npm run build:server   # backend bundle (esbuild) -> dist-server
```

`npm run build` must finish with a `dist/` listing. If it errors on a missing
module, `client/` dependencies were not installed — go back to §2.

---

## 4. Run

**Development** (fastest loop, no packaging):

```bash
node server/index.js
```

Then open **http://127.0.0.1:5050**. That is the real interface; the desktop app
loads the same bundle inside Electron.

**Packaged app** (required to test desktop notifications — they are separate
Electron windows and do not exist in a browser):

```bash
npm run electron:pack
```

Produces in `dist-electron/`:
- `intel-Command-Deck-Setup-<version>.exe` — installer wizard, per-user, no admin
- `intel-Command-Deck-Portable-<version>.exe` — no install, unpacks per launch

---

## 5. Verification — do all of it

### 5.1 Backend is alive

```bash
curl -s http://127.0.0.1:5050/api/health
```

Expect JSON containing `status.telegram` and `status.discord`. Both will show
`connected: false` until the user adds credentials — that is correct, not a
failure.

### 5.2 The UI renders

Open `http://127.0.0.1:5050`. You should see a three-column deck: filters on the
left, feed in the middle, inspector on the right. Each column must scroll
independently — if the whole page scrolls as one, the build is stale.

### 5.3 The pipeline actually works

This is the real test. It needs no credentials:

```bash
curl -X POST http://127.0.0.1:5050/api/test-hit \
  -H 'Content-Type: application/json' \
  -d '{"ca":"So11111111111111111111111111111111111111112","chain":"solana",
       "source":"telegram","chat_name":"setup-test","author":"tester",
       "text":"verification"}'
```

Then confirm the token was ingested and enriched:

```bash
curl -s http://127.0.0.1:5050/api/react-feed | head -c 400
```

A card with a real symbol, market cap and liquidity means ingest → enrichment →
store → API is working end to end.

For a livelier test, pick a fresh address from
`https://api.dexscreener.com/token-profiles/latest/v1`.

### 5.4 Notifications (packaged app only)

Launch the packaged exe, then fire a `/api/test-hit` for a token on an **enabled
chain** and watch the bottom-right of the screen.

If no toast appears, check which chains are armed **before** assuming a bug:

```bash
curl -s http://127.0.0.1:5050/api/notify-prefs
```

Each chain pill in the UI has a **bell** next to it: the pill filters the feed,
the bell controls desktop alerts. A muted chain is the single most common reason
for "no notifications", and the log records every decision:

```
%APPDATA%\intel-command-deck\backend.log
```

Look for `[notify] RAISED` and `[notify] SUPPRESSED` lines — a suppression line
names the chain and the allow-list, so it tells you exactly why.

### 5.5 Report

Paste: the `/api/health` output, the first ~400 chars of `/api/react-feed` after
the test hit, and confirmation that the UI's three columns scroll independently.

---

## 6. Connecting real sources (user-driven)

Direct the user to the app's **Settings** screen. Do not edit `config.json` by
hand unless they ask — the app writes it, and hand-edits get overwritten.

- **Telegram** — needs `api_id` + `api_hash` from https://my.telegram.org, then a
  phone-code login. Creates a user session stored locally.
- **Discord** — needs a user token. There is a **Tutorial** button next to the
  field. Note plainly, once: user tokens violate Discord's ToS and log in as the
  user's account. It is their decision.
- **GMGN** — optional API key. Without it the app runs on DexScreener + RugCheck
  and loses EVM safety, EVM holder counts, some artwork, and KOL/smart-money data.

Then in **Sources**, pick what to watch: Telegram chats, and Discord servers
(whole server, or specific channels within it). Member allow/block lists are
available per source.

---

## 7. Where things live

| Path | What |
| --- | --- |
| `server/index.js` | ingest, filtering, enrichment, REST + Socket.IO |
| `server/gmgn.js` | GMGN via the `gmgn-cli` child process, rate-limited |
| `server/kol.js`, `server/flow.js` | KOL / smart-money and aggregate flow |
| `electron/main.cjs` | spawns the backend, decides which alerts fire |
| `electron/toast.html` | the notification window (self-contained HTML/CSS/JS) |
| `client/src/` | React UI |
| `%APPDATA%\intel-command-deck\` | config.json, data/, backend.log |

---

## 8. Known gotchas

- **Packaging:** anything `asarUnpack`ed must have everything it resolves by
  relative path unpacked too. Verify packaged behaviour by **launching the exe**,
  never by reading source.
- **`npm run build` writes `client/dist`, but a running packaged app serves its
  own copy from inside the asar.** After a UI change you must re-package to see
  it in the desktop app; refreshing the browser is not the same test.
- **Toast rendering:** `contextIsolation` must stay `true` in `electron/toast.cjs`.
  The preload publishes its IPC bridge with `contextBridge`, which silently does
  nothing when isolation is off — the toast then shows its opening snapshot and
  ignores every update.
- **First launch is ~15 seconds.** Not a hang.
- **SmartScreen** warns because the binary is unsigned. Expected.
