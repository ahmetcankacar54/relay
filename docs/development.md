# Developing Relay

Technical notes that used to live in the README: building and signing, icons, how switching and usage reading work, and what runs on Linux.

## Install and run

Requirements: macOS, Node.js 22.12+, Xcode Command Line Tools and Claude Desktop.
Usage limits are read with Claude Code: the copy Claude Desktop downloads for its
Code tab is enough, or a separately installed CLI (2.1.296+).

```sh
npm ci
npm run install:mac      # build, sign with the local certificate, install to /Applications
```

Signing every build with the same local certificate keeps macOS permissions
across updates. One-time setup: [macos-local-signing.md](macos-local-signing.md).
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
5. Settings → Switching → choose how Code history, the browser extension and the
   terminal follow a switch.

## How it works

- Relay's data lives in `~/Library/Application Support/Relay` on macOS and
  `~/.config/Relay` on Linux (`$XDG_CONFIG_HOME/Relay` when set). Saved Desktop
  sign-ins are encrypted with the operating system (`safeStorage`). Claude's files
  are only changed while Claude is closed, after an encrypted backup and a write
  journal; an interrupted switch can be restored from the app.
- Code history: `claude-code-sessions/<account>/<org>/local_*.json` index records
  are merged. Records of one conversation are grouped by alias, CLI session id and
  resumed lineage, and the newest wins. Transcripts in `~/.claude` are shared by
  all accounts and are never copied or rewritten. Deleted conversations stay
  deleted.
- Usage: each account has an isolated CLI profile. Relay reads its credential with
  `/usr/bin/security` on macOS (no Keychain dialog) and from the profile's
  `.credentials.json` on Linux, renews it near expiry with the official
  `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` login, and calls the OAuth profile/usage
  endpoints. Credentials never reach the UI.
- Settings → Advanced → Claude Code CLI wants the `claude` CLI (usually
  `~/.local/bin/claude`), not the Claude app: Relay refuses the app there and
  ignores it when an older version saved it.

## Limits

- Switching restarts Claude; a running reply or subagent is not moved to another
  account. Claude may warn that thinking from another organization cannot be
  reused; the conversation text still continues.
- Relay depends on Claude Desktop's private local file formats and, for automatic
  continuation, on its accessibility tree. A Claude update can break either.
- macOS is the main platform. The Windows installer (`.exe`) switches Claude
  Desktop by hand, reads usage limits and manages accounts, but has no automatic
  switch, continuation, draft re-typing, Claude extension or terminal `claude`
  carry-over, menu bar panel or widget; it is untested on a real machine.
- The `relay` CLI runs on macOS only.

## Linux

Relay works with the official Claude Desktop for Linux (`/usr/bin/claude-desktop`,
data in `~/.config/Claude`) and still finds the community packages and a Claude
AppImage in `~/Applications`; Settings → Advanced can point it at another one.
Saved sign-ins are sealed through the Secret Service or KWallet, so one of them
must be running and unlocked.

Works on Linux:

- Switching by hand, from the window or the tray, with Claude's own log telling
  when its page has loaded and when an account was signed out.
- Separate Claude windows (Settings → Advanced), each on its own data folder.
- Overview's **Open Code** (the `claude://code/new` link the package registers).
- The Claude extension in Chrome and the terminal's `claude` follow a switch.
- Automatic switching "when I quit the Claude app", and usage read from the
  Claude app's own session (KWallet or Secret Service; allowed once in Relay).
- Draft capture: drafts left in Claude at a switch are saved for you to copy back.
  Capture needs Claude and Relay on the same Electron major; it is skipped
  otherwise.

macOS only:

- Switch and continue at quota, and re-typing drafts into Claude: both need
  macOS Accessibility.
- The menu bar panel, the panda and usage in the menu bar title, and the widget.
- The `relay` CLI.

