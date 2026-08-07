# How to put this on GitHub

Step by step. Read §1 before running anything.

---

## 1. Before the first push — the safety check

This app stores a Telegram `api_hash`, a login **session** (which is a working
login, not just a password), a Discord user token, and a GMGN key. All of it
lives in `config.json`.

**Git history is permanent.** A credential pushed once and deleted in the next
commit is still in the history, still on GitHub's servers, and still scrapeable.
Bots scan new public repos for exactly this within minutes.

Run this in the folder you are about to push. It must print `CLEAN`:

```bash
# nothing sensitive staged or present
git ls-files | grep -E '(^|/)(config\.json|\.env|.*\.session|data/)' && echo "STOP" || echo "CLEAN"
```

And confirm `.gitignore` contains at least:

```
node_modules
client/node_modules
client/dist
dist-electron/
dist-server/
config.json
.env
.env.local
*.session
*.session-journal
data/
*.log
```

> If you ever do push a credential: treat it as leaked. Revoke it —
> **Telegram:** terminate the session in Settings → Devices.
> **Discord:** change your password, which invalidates all tokens.
> **GMGN:** rotate the key. Deleting the commit is not enough.

---

## 2. Create the repository

**With the GitHub CLI** (easiest):

```bash
cd github-release
git init
git add .
git commit -m "intel. Command Deck"
gh repo create intel --public --source=. --push
```

**Without the CLI:** create an empty repo on github.com (no README, no
.gitignore — you already have both), then:

```bash
cd github-release
git init
git add .
git commit -m "intel. Command Deck"
git branch -M main
git remote add origin https://github.com/dwdo1337/intel.git
git push -u origin main
```

Choose **public** or **private** deliberately. Public means anyone can read
every file you push, forever.

---

## 3. Publish the installers as a Release

Binaries do not belong in git — they bloat the repo and every clone. Attach them
to a Release instead.

Build them first:

```bash
cd ../app        # or wherever your working copy is
npm run electron:pack
```

That produces in `dist-electron/`:

- `intel-Command-Deck-Setup-0.2.0.exe` — the installer wizard
- `intel-Command-Deck-Portable-0.2.0.exe` — the portable build

**Scan both before uploading.** This is not optional — an earlier build of this
app was deleted for shipping with real credentials baked in:

```bash
# should print 0 for every field you have set
strings "dist-electron/intel-Command-Deck-Setup-0.2.0.exe" | grep -c "<your api_hash>"
```

Then upload:

```bash
gh release create v0.2.0 \
  "dist-electron/intel-Command-Deck-Setup-0.2.0.exe" \
  "dist-electron/intel-Command-Deck-Portable-0.2.0.exe" \
  --title "v0.2.0" \
  --notes "Installer and portable builds. Windows x64. Unsigned — SmartScreen will warn on first run."
```

Or drag both files onto the Release page in the browser.

---

## 4. Repository settings worth setting

- **About** — description, and a link to the landing page if you host one.
- **Topics** — `electron`, `telegram`, `discord`, `solana`, `trading`,
  `memecoin`, `desktop-app`.
- **Secret scanning + push protection** — Settings → Code security. Free on
  public repos, and it blocks a credential push before it lands.
- **Releases** — pin the latest so the download is the first thing visitors see.
- **Issues** — leave on if you want reports; off if you don't want the inbox.

---

## 5. Optional: host the landing page

`landing/index.html` is a single self-contained file. GitHub Pages will serve
it for free:

```bash
git subtree push --prefix landing origin gh-pages
```

Then Settings → Pages → Source: `gh-pages` branch. It appears at
`https://dwdo1337.github.io/intel/`.

Its download buttons already point at this repo's Releases page, so they work
as soon as you publish a release.

---

## 6. Keeping it updated

```bash
git add -A
git commit -m "what changed"
git push
```

For a new version: bump `version` in `package.json`, rebuild, then
`gh release create vX.Y.Z ...` with the new binaries. The installer's artifact
name carries the version automatically.
