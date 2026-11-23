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
To give Relay to someone else, `npm run dist:mac:share` makes a DMG for Apple
silicon and one for Intel Macs (`--arch arm64` or `x64` for one); the same
document explains the one-time "Open Anyway" step.

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

## Releasing

A release has signed macOS DMGs for Apple silicon and Intel, a Windows installer,
a Linux AppImage, and a `SHA256SUMS.txt` with its Ed25519 signature
`SHA256SUMS.txt.sig`. The DMGs need the local certificate, so they are built on
the Mac; GitHub Actions builds the rest.

One-time setup:

- `node scripts/update-signing.mjs init` creates the update signing key in
  `~/.config/relay-release/update-signing-ed25519.pem` (mode 600; another path
  through `RELAY_UPDATE_SIGNING_KEY_FILE`). Back it up. Its public half is in
  `electron/core/update-signing-key.ts`; a new key means a new public key there,
  and Relays built with the old one no longer accept updates on Windows and Linux.
- Add the PEM's contents as the repository secret `RELAY_UPDATE_SIGNING_KEY`, so
  the workflow signs too. Without it, the workflow's sums stay unsigned until the
  Mac step signs them.

Each version:

1. Bump the version, commit on `main`, then `git tag v<version> && git push origin main v<version>`.
2. The **Release** workflow (`.github/workflows/release.yml`) runs typecheck and
   tests on Windows and Linux, builds `Relay-Setup-<version>-x64.exe` (with its
   blockmap and `latest.yml`) and `Relay-<version>-x86_64.AppImage` (with
   `latest-linux.yml`), and attaches them, `INSTALL.txt` and the sums to a
   **draft** release. It never changes a published release.
3. When it is done, on the Mac: `npm run release`. It builds and verifies both
   DMGs, merges their lines into the draft's `SHA256SUMS.txt` (the workflow's
   lines are kept when their signature verifies, otherwise their files are
   downloaded and hashed), signs the result, uploads, checks every listed file
   is attached and publishes the release. It refuses to publish while
   `latest.yml` or `latest-linux.yml` is missing; `--force` publishes without
   them, `--draft` leaves the release a draft, `--skip-build` reuses DMGs in
   `release/share/<version>`.
4. Homebrew: copy `release/homebrew/Casks/relay.rb` into the tap repository
   (see [packaging/homebrew/README.md](../packaging/homebrew/README.md)).

How the updates are trusted:

- macOS: Relay downloads the DMG for its own architecture (`process.arch`),
  checks it against `SHA256SUMS.txt`, and installs it only when it is signed with
  the same certificate as the running app.
- Windows and Linux: electron-updater checks the download against the SHA-512 in
  `latest.yml`, which comes from the same host. Relay then requires a valid
  signature on `SHA256SUMS.txt` under the embedded key, and the installer's
  SHA-256 listed there under its own name for that version. Otherwise the
  download is deleted and nothing is installed.

Dependencies: `npm audit --audit-level=high` runs over the whole tree in the
Check workflow (Electron is a devDependency but ships in the app), and
Dependabot (`.github/dependabot.yml`) opens weekly grouped minor and patch
updates for npm and GitHub Actions.
