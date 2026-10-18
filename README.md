# Relay — Claude Desktop account switcher

Relay is a small macOS menu-bar app for people with several Claude accounts
(personal Pro/Max and company Team/Enterprise). Your work stays in the official
**Claude Desktop** app and its **Code** tab; Relay only switches which account
Claude is signed in to, keeps your Code conversations available on every account
you choose, and shows how much quota each account has left. Turkish and English.
Independent tool, not an Anthropic product.

## Screens

A sidebar (a 56 px icon rail in narrow windows) opens six pages; the keyboard
shortcuts are ⌘1–⌘5 and ⌘, for Settings.

- **Genel** (Overview) — the active account, today's plan and automation status.
- **Hesaplar** (Accounts) — search, add, link to Desktop and edit accounts.
- **Kullanım** (Usage) — 7/30-day usage statistics and limit warning settings.
- **Planlama** (Planning) — work hours, the day timeline and per-account start times.
- **Geçiş** (Switching) — switch preferences, shared history, continuation and fleet.
- **Ayarlar** (Settings) — appearance (system, light or dark), language and
  technical details.

## What it does

- **Accounts** — connect each Claude account once (normal sign-in inside Claude),
  see its email, organization and plan, reconnect when needed.
- **Switch** — from the window or the menu bar. Relay quits Claude, restores the
  saved sign-in of the target account and reopens Claude. It is a restart, not a
  hot swap: let running replies finish first.
- **Shared Code history** — conversations and local projects of the accounts you
  select (also across companies) are merged on every switch, so the same
  conversation is there after switching. The same conversation is never shown
  twice, and its permission mode (Manual/Auto/Plan/Accept edits) travels with it;
  Bypass never does. Chat, cloud and SSH sessions are not synchronized.
- **Usage limits** — remaining five-hour and weekly quota with reset times for
  every account, refreshed in the background. Team/Enterprise seats that report no
  weekly window show "no limit reported" and are judged by their five-hour window.
- **Statistics and planning** — 7/30-day observed usage; weekday and weekend work
  hours; Relay staggers each account's first window so resets spread over the
  day, lets you override any account's start time, and (optional) starts and
  keeps every planned account's five-hour window running during work hours.
- **Switch and continue at quota** (experimental, macOS, off by default) — once
  turned on it stays on for every local Code conversation. When the active
  account runs out of quota and nothing else is running, Relay picks the eligible
  account with the most usable quota, restarts Claude on it once and sends one
  continuation message to each conversation that stopped at the limit, keeping
  its permission mode. Later limits rotate again (A → B → A) but never back to an
  account that is still out of quota. Needs Accessibility permission. Never
  interrupts running work and never sends a message twice.

## Install and run

Requirements: macOS, Node.js 22.12+, Xcode Command Line Tools, Claude Desktop and
the native Claude Code CLI (2.1.296+) for usage limits.

```sh
npm ci
npm run install:mac      # build, sign with the local certificate, install to /Applications
```

Signing every build with the same local certificate keeps macOS permissions
across updates. One-time setup: [docs/macos-local-signing.md](docs/macos-local-signing.md).
To give Relay to someone else, `npm run dist:mac:share` makes the Apple silicon
and Intel DMGs in one run; the same document explains the one-time "Open Anyway"
step.

Runtime packages that Vite or esbuild bundle (React, Radix, zod…) are
`devDependencies`; only `node-pty`, which loads a native module at run time,
belongs in `dependencies`, because electron-builder copies those into the app.

Development: `npm run dev` (Electron + Vite), `npm run dev:ui` (browser preview
with sample data, `?demo=50` for 50 accounts), `npm test`, `npm run typecheck`.

Icon sources: `assets/icon-artwork.png` (Imagegen ribbon R artwork),
`assets/icon.svg` (vector companion), `assets/relay-mark.svg` (standalone mark)
and `assets/trayTemplate.svg` (menu-bar silhouette). Run `npm run icons` to
regenerate 16–1024px PNGs, `assets/icon.icns`, 1×/2×/3× template and color tray
PNGs, the bundled tray representations and `assets/icons/preview.png`.
The Electron build regenerates these assets automatically; macOS template mode
adapts the menu-bar icon to light and dark appearances.

## First use

1. Open Claude Desktop, sign in, open the **Code** tab once.
2. In Relay, **Add account**, then **Connect Desktop** to save the account that is
   open in Claude. For another account, Relay restarts Claude so you can sign in.
3. **Connect in browser** on each account to read its usage limits (official CLI
   sign-in in a hidden, isolated profile).
4. Settings → Shared Code history → choose the accounts that may share history.

## How it works

- Relay's data lives in `~/Library/Application Support/Relay`. Saved Desktop
  sign-ins are encrypted with the operating system (`safeStorage`). Claude's files
  are only changed while Claude is closed, after an encrypted backup and a write
  journal; an interrupted switch can be restored from the app.
- Code history: `claude-code-sessions/<account>/<org>/local_*.json` index records
  are merged. Records of one conversation are grouped by alias, CLI session id and
  resumed lineage, and the newest wins. Transcripts in `~/.claude` are shared by
  all accounts and are never copied or rewritten. Deleted conversations stay
  deleted.
- Usage: each account has an isolated CLI profile. Relay reads its credential with
  `/usr/bin/security` (no Keychain dialog), renews it near expiry with the official
  `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` login, and calls the OAuth profile/usage
  endpoints. Credentials never reach the UI.

## Limits

- Switching restarts Claude; a running reply or subagent is not moved to another
  account. Claude may warn that thinking from another organization cannot be
  reused; the conversation text still continues.
- Relay depends on Claude Desktop's private local file formats and, for automatic
  continuation, on its accessibility tree. A Claude update can break either.
- Windows packaging exists but is untested; Linux can only preview the UI.

Older design notes and acceptance records are in [docs](docs).
