# Relay — Claude Desktop account switcher

Relay is a small macOS menu-bar app for people with several Claude accounts
(personal Pro/Max and company Team/Enterprise). Your work stays in the official
**Claude Desktop** app and its **Code** tab; Relay only switches which account
Claude is signed in to, keeps your Code conversations available on every account
you choose, and shows how much quota each account has left. Turkish and English.
Independent tool, not an Anthropic product.

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
- **Statistics and planning** — 7/30-day observed usage, a 24-hour work plan with
  time zone, plan capacities (Pro, Max 5×, Max 20×, custom Team weight) and optional
  routines that open a five-hour window ahead of your work day (off by default).
- **Switch and continue at quota** (experimental, macOS, off by default) — when the
  watched Code conversation stops at its usage limit and nothing else is running,
  Relay picks the eligible account with the most usable quota, restarts Claude on
  it, reopens the same conversation with the same permission mode and sends one
  continuation message. Needs Accessibility permission. Never interrupts running
  work and never sends a message twice.

## Install and run

Requirements: macOS, Node.js 22.12+, Xcode Command Line Tools, Claude Desktop and
the native Claude Code CLI (2.1.296+) for usage limits.

```sh
npm ci
npm run install:mac      # build, sign with the local certificate, install to /Applications
```

Signing every build with the same local certificate keeps macOS permissions
across updates. One-time setup: [docs/macos-local-signing.md](docs/macos-local-signing.md).

Development: `npm run dev` (Electron + Vite), `npm run dev:ui` (browser preview
with sample data, `?demo=50` for 50 accounts), `npm test`, `npm run typecheck`.

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
