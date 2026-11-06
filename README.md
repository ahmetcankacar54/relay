# Relay — Claude Desktop account switcher

Relay is a small macOS menu-bar app for people with several Claude accounts
(personal Pro/Max and company Team/Enterprise). Your work stays in the official
**Claude Desktop** app and its **Code** tab; Relay only switches which account
Claude is signed in to, keeps your Code conversations available on every account
you choose, and shows how much of each account's quota is used. Turkish and English.
Independent tool, not an Anthropic product.

## Download

Get the latest build from [Releases](../../releases): a DMG for Apple silicon Macs
(M1 and later), a Windows installer and a Linux AppImage. The builds are not
notarized; `INSTALL.txt` in each release walks through macOS’s
one-time "Open Anyway" step.

## Screens

A sidebar (a 56 px icon rail in narrow windows) opens four pages; the keyboard
shortcuts are ⌘1–⌘3 and ⌘, for Settings.

- **Overview** (Genel) — the active account, setup steps, today's plan and automation status.
- **Accounts** (Hesaplar) — add accounts with a three-step wizard, see each account's
  connections (Claude app, usage access, browser extension, terminal) and edit them.
- **Usage** (Kullanım) — limits (full 5-hour periods, when you work, account balance,
  limit hits), tokens and API value, and pins.
- **Settings** (Ayarlar) — every setting in six tabs: Automation, What comes along,
  Planning, Notifications, Appearance and Advanced.

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
- **Usage limits** — five-hour and weekly quota used, with reset times for
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

Requirements: macOS, Node.js 22.12+, Xcode Command Line Tools and Claude Desktop.
Usage limits are read with Claude Code: the copy Claude Desktop downloads for its
Code tab is enough, or a separately installed CLI (2.1.296+).

```sh
npm ci
npm run install:mac      # build, sign with the local certificate, install to /Applications
```

Signing every build with the same local certificate keeps macOS permissions
across updates. One-time setup: [docs/macos-local-signing.md](docs/macos-local-signing.md).
To give Relay to someone else, `node scripts/stable-signing.mjs --dmg --arch arm64 --output release/share`
makes an Apple silicon DMG (`--arch x64`, `both` or `universal` for Intel Macs);
the same document explains the one-time "Open Anyway" step.

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

1. Open Claude Desktop, sign in, open the **Code** tab once (Overview's **Open Code**
   does it for you).
2. In Relay, **Add account**. Relay saves the account open in Claude, or restarts
   Claude on its sign-in screen; once you sign in and open Code it saves the
   sign-in by itself.
3. Usage access starts on its own in a Relay window with its own claude.ai session
   per account (official CLI sign-in in an isolated profile).
4. The last step suggests the account's name, type and group.
5. Settings → What comes along → choose how Code history, the browser extension
   and the terminal follow a switch.

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
- macOS is the main platform. The Windows installer (`.exe`) and the Linux
  AppImage switch Claude Desktop by hand, read usage limits and manage accounts,
  but have no automatic switch, continuation, draft re-typing, Claude extension
  or terminal `claude` carry-over, menu bar panel or widget. Planned limit
  periods run on Linux, not Windows. The Windows build is untested on a real
  machine; Linux has no official Claude Desktop, so Relay looks for the community
  packages.
- The `relay` CLI runs on macOS only.

