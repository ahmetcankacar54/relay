# Developing Relay

Technical notes that used to live in the README: building and signing, icons, how switching and usage reading work, and what runs on Linux.

Relay 1.0 is a Tauri 2 app: the Rust core in `crates/` (`relay-core`,
`relay-gateway`, `relay-cli`, and `relay-app`, the Tauri shell) and the React UI
in `src/` and `shared/`, which stays TypeScript. The native macOS parts are Swift
sources in `native/`: `desktop-automation.swift` (the Accessibility helper),
`widget/` (the WidgetKit extension) and the WidgetCenter Swift package.

## Install and run

Requirements to build: Node.js 22.12+, Rust (the toolchain `rust-toolchain.toml`
pins, through rustup, with the `x86_64-apple-darwin` target for the Intel build),
and on macOS the Xcode Command Line Tools. On Linux, Tauri's build dependencies
(`libwebkit2gtk-4.1-dev` and friends). To run Relay: macOS 14+, Windows 10/11
with WebView2 (part of Windows 11), or Linux with webkit2gtk-4.1 (Ubuntu 22.04+);
and Claude Desktop.
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
document explains the one-time "Open Anyway" step. On Windows and Linux,
`npm run dist` builds the NSIS installer `Relay-Setup-<version>-x64.exe` or the
AppImage `Relay-<version>-x86_64.AppImage` in `release/`.

Development: `npm run dev` runs `tauri dev` (through `@tauri-apps/cli`): the UI
from Vite on `127.0.0.1:5173` with hot reload, inside the Rust app.
`npm run dev:ui` is the browser preview with sample data (`?demo=50` for 50
accounts). `npm run build` is `npm run build:ui` (typecheck and `vite build`)
followed by `tauri build` (`scripts/tauri-build.mjs`).

Tests: `npm test` runs the UI and `shared/` tests (`tests/*.test.ts`), and
`npm run typecheck` the TypeScript. The Rust side has
`cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`.
`npm run test:boot` (`scripts/smoke-boot.mjs`) is the boot smoke CI runs on every
platform: it builds nothing and starts `target/debug/relay-app`, built with
`cargo build -p relay-app --features smoke` (`--app <path>` for another binary),
with a fresh profile in a temp folder; the app exits by itself once its main
page has loaded the app's state, and the smoke fails on a non-zero exit, an error
in `main-errors.log` or no exit within 120 s. `cargo test -p relay-app --features
smoke` (`crates/relay-app/tests/desktop_smoke.rs`) is the deeper desktop test.

Code health: `npm run lint` (ESLint, `eslint.config.mjs`) and `npm run format:check`
(Prettier on the files a change adds since `origin/main`; older files are hand-formatted
and left as they are, so fix a reported file with `npx prettier --write <file>`, not
`npm run format`). `npm run test:e2e` starts `npm run dev:ui`
and runs `e2e/preview.spec.ts` in Chromium (`npx playwright install chromium`
once): an axe scan of the main pages that fails on serious or critical WCAG 2.1
AA violations, and screenshots compared with `e2e/__snapshots__`. The baselines
are macOS renders, so the screenshots are compared on macOS only (CI's
`macos-latest`; up to 2 % of pixels may differ). After a deliberate UI change,
`npm run test:e2e -- --update-snapshots` on a Mac and commit the new PNGs.

App layout: `crates/relay-app/src/lib.rs` (`run`) starts the Tauri app; `boot/`
holds one module per startup step in the order they run, `services/` one per
domain (gateway, updates, notifications, backup…), `ipc/` the commands the UI
calls, one file per group, and `windows/` the window, menu-bar panel and switch
windows. Everything that does not need Tauri (switching, history merging, usage
reading, the vault, updates) lives in `relay-core`, so the CLI and the app share
it.

Icon sources: `assets/icon-artwork.png` (Imagegen ribbon R artwork),
`assets/icon.svg` (vector companion), `assets/relay-mark.svg` (standalone mark)
and `assets/trayTemplate.svg` (menu-bar silhouette). Run `npm run icons` to
regenerate 16–1024px PNGs, `assets/icon.icns`, 1×/2×/3× template and color tray
PNGs, the bundled tray representations and `assets/icons/preview.png`.
The Tauri bundle takes its icons from `assets/` (`tauri.conf.json`); macOS
template mode adapts the menu-bar icon to light and dark appearances.

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

- Relay's data lives in `~/Library/Application Support/Relay` on macOS,
  `%APPDATA%\Relay` on Windows and `~/.config/Relay` on Linux
  (`$XDG_CONFIG_HOME/Relay` when set). Saved Desktop sign-ins are encrypted with
  AES-256-GCM under a vault key kept in the macOS Keychain (the OS keyring on
  Windows and Linux). Claude's files are only changed while Claude is closed,
  after an encrypted backup and a write journal; an interrupted switch can be
  restored from the app.
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
  carry-over, menu bar panel or widget; it is untested on a real machine
  ([the checklist that would change that](windows-verification.md)).
- The `relay` CLI installs on macOS, Linux and Windows. Reading commands
  (`status`, `list`, `usage`, `tokens`, `history`, `run`, `connect`, `proxy`,
  `doctor`, `statusline`) work everywhere; saving and switching Claude app
  accounts (`add`, `switch`, `recover`, `history sync`, `reset-vault`) open the
  vault through the macOS Keychain and say "macOS only" elsewhere.
- `relay statusline` puts the account in use, its 5-hour and weekly use and the
  next renewal in Claude Code's status line. Relay writes
  `<userData>/statusline.json` on every limit read, gateway answer and token
  tick; the command reads only that file, Claude Code's stdin and
  `.claude.json`, on a fast path the Rust binary (`crates/relay-cli`) takes
  before any other start-up, so it answers in a few milliseconds.
  `relay statusline install` (or Settings → Advanced) sets `statusLine` in
  `~/.claude/settings.json` to an absolute command (the CLI writes its own
  binary's path; the app writes
  the `relay` that `relay_core::relay_cli_path` finds on PATH, in the
  usual npm/Homebrew/Volta/pnpm/nvm folders, else through `$SHELL -ilc` with a
  2 s deadline) and keeps any earlier one in
  `<userData>/claude-statusline-previous.json` until `uninstall` puts it back.
  Without an installed relay the Settings switch stays off and offers
  `npm i -g @ahmetcankacar/relay` to copy.
- The CLI is the Rust `relay` binary (`crates/relay-cli`). npm ships it as
  `@ahmetcankacar/relay`, a small Node launcher (`cli/launcher.js`) with one
  optional dependency per platform (`cli/npm/platforms/*`) holding the binary;
  `node scripts/build-cli-packages.mjs` builds and stages them in
  `cli/npm/dist/`, and a `cli-v<version>` tag publishes them
  (`.github/workflows/cli-release.yml`) with the bare binaries as archives on
  that GitHub release. The app carries the same binary in its resources,
  `bin/relay` (`Relay.app/Contents/Resources/bin/relay` on macOS, which the
  Homebrew cask links as `relay`; `bin/relay.exe` on Windows):
  `node scripts/relay-binary.mjs` builds it for the platform and architecture,
  and `scripts/stable-signing.mjs` signs it as `dev.relay.workspace.relay-cli`.
- The Proxy Gateway runs inside the app: `relay_gateway::ProxyServer` on its own
  tokio runtime (`crates/relay-app/src/services/gateway.rs`), so there is no
  separate gateway process. `relay proxy` in the CLI runs the same server.

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
  Relay reads a copy of Claude's Local Storage with its own LevelDB reader.

macOS only:

- Switch and continue at quota, and re-typing drafts into Claude: both need
  macOS Accessibility.
- The menu bar panel, the panda and usage in the menu bar title, and the widget.
- Saving and switching Claude app accounts from the `relay` CLI.

## Resource use

`npm run perf:idle` (`node scripts/perf-idle.mjs`) starts the release build,
`target/release/relay-app` (build it first with
`npm run build:ui && cargo build -p relay-app --release --features smoke`: the
`smoke` feature lets it take the temp folders below; `--app <path>` for another
binary), hidden in the menu bar, with a fresh profile in a temp folder and a
temp `HOME`, so it sees no Claude app, no Claude Code sign-in and none of your
accounts. Every Keychain call goes to a fake tool (`RELAY_SECURITY_TOOL`) that
only logs it, so the real Keychain is never asked. After it settles (20 s,
`--settle`), it samples Relay's processes with `ps`: the app, everything it
started and, on macOS, the WebKit helpers (WebContent, GPU, Networking) launchd
runs for its web views, which are not its children: the new ones macOS holds the
same process responsible for (`responsibility_get_pid_responsible_for_pid`).

- **CPU** is the CPU time they used over the window divided by its length, not
  `ps`'s decaying `%cpu`.
- **Memory** is the sum of their RSS; the peak and the mean are printed. Shared
  pages count once per process, so the sum is an upper bound.
- **Keychain calls** while idle are counted; an idle Relay must make none.

It exits 1 over budget (`--budget-cpu 1` percent and `--budget-rss-mb 250` by
default) or after any Keychain call while idle. Relay 1.0 on an Apple silicon
Mac (2026-11-26, window closed): 0.03 % CPU, 213 MB RSS peak (186 MB mean), no
Keychain call while idle.

The panda's idle motions play only now and then (`src/mascot/idle-motion.ts`: a
blink every 8 to 14 s, the tail, wave, look and nod together every 1.5 to
2.5 min), since a moving SVG part repaints the window every frame; out of focus
or hidden, the panda holds still. With accounts, each usage read (every
`usageRefreshMinutes`) also reads that account's Claude Code sign-in through
`/usr/bin/security`, the tool Claude Code itself trusts, so macOS shows no
prompt for it.

## Releasing

A release has signed macOS DMGs for Apple silicon and Intel, a Windows installer,
a Linux AppImage, and a `SHA256SUMS.txt` with its Ed25519 signature
`SHA256SUMS.txt.sig`. The DMGs need the local certificate, so they are built on
the Mac; GitHub Actions builds the rest.

One-time setup:

- `node scripts/update-signing.mjs init` creates the update signing key in
  `~/.config/relay-release/update-signing-ed25519.pem` (mode 600; another path
  through `RELAY_UPDATE_SIGNING_KEY_FILE`). Back it up. Its public half is in
  `crates/relay-core/src/update_signing_key.rs`; a new key means a new public key
  there, and Relays built with the old one no longer accept updates on Windows
  and Linux.
- Add the PEM's contents as the repository secret `RELAY_UPDATE_SIGNING_KEY`, so
  the workflow signs too. Without it, the workflow's sums stay unsigned until the
  Mac step signs them.

Each version:

1. Bump the version, commit on `main`, then `git tag v<version> && git push origin main v<version>`.
2. The **Release** workflow (`.github/workflows/release.yml`) runs typecheck and
   tests on Windows and Linux, builds `Relay-Setup-<version>-x64.exe` (with
   `latest.yml`) and `Relay-<version>-x86_64.AppImage` (with
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

A beta is versioned `X.Y.Z-beta.N` (tag `vX.Y.Z-beta.N`; other pre-release tags
are refused, because Relay 0.x's updater follows only the `alpha` and `beta`
channels). The same steps publish it as a GitHub **pre-release**; its Windows
and Linux updater files are `beta.yml` and `beta-linux.yml`, which
`npm run release` requires instead of the `latest` ones, and no Homebrew cask is
written. Only Relays with Settings → Updates → "Get pre-releases" on install it.

The version is `crates/relay-app/tauri.conf.json`'s; both the workflow and
`npm run release` refuse a tag that differs from it.

- Windows and Linux: `npm run dist` (`scripts/tauri-build.mjs`) runs
  `tauri build`, renames the NSIS installer and the AppImage to the names above
  and writes `latest.yml` / `latest-linux.yml` (`beta.yml` / `beta-linux.yml`
  for a beta). The relay CLI is in the app's resources, `bin/relay(.exe)`. The
  installer is per user (`%LOCALAPPDATA%\Relay`). Relay updates itself by
  running the installer with `/S /UPDATE /R`; `/R` reopens Relay afterwards.
- macOS: `npm run dist:mac:local` / `install:mac` / `dist:mac:share`
  (`scripts/stable-signing.mjs`) run `tauri build` for the app, add
  `desktop-automation` (`Contents/MacOS`), the relay CLI
  (`Contents/Resources/bin/relay`; the cask links it) and the widget
  (`Contents/PlugIns/RelayWidget.appex`), sign them inside out with the pinned
  certificate and, with `--dmg`, make `Relay-<version>-<arch>.dmg`. `--ad-hoc`
  builds an ad-hoc signed copy for checking only (no `--install`).
- The relay CLI is built into `target/cli`: `tauri build` writes the app as
  `target/<triple>/<profile>/Relay`, which a case-insensitive disk takes for
  the CLI's `relay`.

Upgrading from Relay 0.x: 0.x was an Electron app, and it updates in place to
1.0 through its own updater, keeping every account and setting. For that, each
release still publishes the electron-updater files (`latest.yml`,
`latest-linux.yml`, written by `scripts/electron-update-yml.mjs`; a full
download, without a blockmap). On Windows the 1.0 installer's hook
(`crates/relay-app/windows/installer-hooks.nsh`) silently runs the old Electron
install's uninstaller first, which removes its Installed apps entry and keeps
`%APPDATA%\Relay`. On macOS the bundle id, app name, certificate and DMG names
are the 0.x ones, so the 0.x updater installs the 1.0 DMG in place.

How the updates are trusted:

- macOS: Relay downloads the DMG for its own architecture, checks it against
  `SHA256SUMS.txt`, and installs it only when it is signed with the same
  certificate as the running app.
- Windows and Linux: Relay requires a valid Ed25519 signature on
  `SHA256SUMS.txt` under the embedded key, and the installer's SHA-256 listed
  there under its own name for that version. Otherwise the download is deleted
  and nothing is installed.

Dependencies: `npm audit --audit-level=high` runs over the whole npm tree in the
Check workflow, and Dependabot (`.github/dependabot.yml`) opens weekly grouped
minor and patch updates for npm and GitHub Actions.
