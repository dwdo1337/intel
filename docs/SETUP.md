# Setup

Everything needed to get intel. Command Deck running on Windows.

---

## 1. Credentials you need

Three sets. Only the first is mandatory.

### Telegram (required) — free, from [my.telegram.org/auth](https://my.telegram.org/auth)

Log in with your phone number, open **API development tools**, and copy:

| Field | Looks like |
| --- | --- |
| `api_id` | a number, e.g. `12345678` |
| `api_hash` | a 32-character string |
| `phone` | your Telegram number, e.g. `+4512345678` |
| `password` | your 2FA password, or `""` if you do not use 2FA |

The app logs in as **you**, not as a bot — a bot cannot read arbitrary group
history. The resulting session string is saved locally and reused on every start.

### Discord (optional) — your user token

Open Discord in a browser → F12 → Application → Local Storage →
`https://discord.com` → copy the `token` value.

A real token is roughly 70+ characters. If you paste a truncated one, Discord
rejects the connection with code 4004; the app now says so explicitly in the
logs and stops retrying rather than looping silently.

### GMGN (optional but strongly recommended) — from [gmgn.ai](https://gmgn.ai) settings → API

The config key is **`gmgn.api_key`**. That exact name — the server reads
`config.gmgn.api_key` and silently skips all GMGN enrichment if it is missing
or spelled differently.

Without it you still get DexScreener market data everywhere, RugCheck safety on
Solana, and keyless aggregate smart-money flow. You lose: EVM safety data
(honeypot, taxes, LP, renounced), holder counts on EVM, token artwork on chains
DexScreener has no image for, and named KOL/smart-money holders.

---

## 2. Write the config

Copy `app/config.example.json` to `app/config.json` and fill it in:

```json
{
  "telegram": {
    "api_id": 12345678,
    "api_hash": "paste_your_32_char_hash",
    "phone": "+4512345678",
    "password": "",
    "monitored_chats": []
  },
  "discord": {
    "user_token": "",
    "monitored_guilds": []
  },
  "gmgn": {
    "api_key": ""
  }
}
```

Leave `monitored_chats` and `monitored_guilds` empty — you pick the chats
inside the app, which is easier than looking up numeric ids by hand.

> ### Where the packaged app actually reads this from
>
> `app/config.json` is what the **development** server reads.
>
> The packaged `.exe` reads from **`%APPDATA%\intel-command-deck\config.json`**,
> because the app directory inside a portable build is a read-only archive.
> On first run the app creates that folder; edits you make in the repo after
> that point have no effect on the `.exe`.
>
> The folder is named `intel-command-deck` (from the app's internal `name`),
> not "intel. Command Deck".

---

## 3. Run it

Double-click `START-INTEL.bat` in the workspace root.

- First launch takes **~60 seconds** while the portable executable unpacks.
- It is unsigned, so **SmartScreen** warns once — *More info → Run anyway*.
- The dashboard opens directly. There is no login gate.

---

## 4. Connect and choose sources, in the app

1. Click the **gear** icon (top right) to open Settings.
2. Telegram: enter the SMS code when prompted, then your 2FA password if you
   use one.
3. Click the **groups** icon to pick which chats and channels to watch. You can
   narrow any group to specific people (allow-list) or silence individuals
   (block-list).

The GMGN key is the one field with **no UI yet** — it still needs a manual edit
of `config.json` in `%APPDATA%\intel-command-deck\`.

---

## 5. Build from source

Requires Node.js 18+.

```bash
cd app
npm install
npm run build            # builds the React client
npm run electron:pack    # produces the portable .exe in dist-electron/
```

Other scripts: `npm run dev` (backend + Vite dev server), `npm run server`
(backend only), `npm run client` (Vite only).

---

## Troubleshooting

**Start here:** `%APPDATA%\intel-command-deck\backend.log`. Backend spawn, exit
code, stdout and stderr are always written there, packaged or not. This is
deliberately unconditional — it was silence on this path that once hid an
entire chain of packaging failures.

| Symptom | Cause |
| --- | --- |
| Window opens black / empty | Backend did not start. Read `backend.log`. |
| Telegram never sends a code | `api_id` / `api_hash` wrong, or config not valid JSON. |
| Discord stays offline | Token expired or was truncated on paste. `backend.log` names a 4004 rejection explicitly. |
| Safety fields all say "unknown" on BSC/Base | No GMGN key, or it is under the wrong config name. It must be `gmgn.api_key`. |
| Rug score / insiders / dev wallet unknown on EVM | Expected. RugCheck is Solana-only and there is no EVM equivalent. |
| A token shows no liquidity | Often genuine — DexScreener reports no pool for some pairs, and the card shows `—` rather than inventing a number. |
| Nothing appears in the feed | No monitored chats selected, or every message is being dropped by the echo-bot guard and distinct-caller rule — which is the app working as intended. |

Pressing **refresh** on a card re-reads everything: price, liquidity, holders,
safety, and who is holding it. It bypasses every cache, so it is the right tool
when a card looks stale or a provider failed at scan time.
