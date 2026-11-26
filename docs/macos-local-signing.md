# Stable local macOS signing

macOS remembers permissions (Accessibility for automatic continuation) by an app's
code identity. An ad-hoc signature changes with every build, so each update looked
like a new app and asked again. Signing every build with the same certificate
keeps one identity, so a permission granted once survives rebuilds and updates.

Usage limits no longer depend on Relay's signature at all: Relay reads each
profile's CLI credential through `/usr/bin/security`, the tool the Claude CLI used
to store it, so no Keychain dialog appears for those reads.

## One-time setup

The certificate **Relay Local Code Signing** already exists in the login Keychain
(public SHA-1 `32508C2B9B3423E1F36CB671C5F8285BB33F5E0A`, pinned in
`config/local-signing.json`). `codesign` needs permission to use its private key
once. Do one of these yourself:

- Run `npm run install:mac` in Terminal. When macOS asks whether `codesign` may
  use the key, enter your login password and choose **Always Allow**.
- Or, in Keychain Access → login → My Certificates → *Relay Local Code Signing* →
  expand → private key → Get Info → Access Control, add `/usr/bin/codesign`.

Run it from a normal logged-in Terminal session (not SSH). `errSecInternalComponent`
means the key permission was not granted.

## Build, sign and install

```sh
npm run install:mac
```

This builds `Relay.app` with `tauri build`, adds the `desktop-automation` helper
(`Contents/MacOS`), the `relay` CLI (`Contents/Resources/bin/relay`) and the
`RelayWidget.appex` widget, signs them inside out with the pinned certificate (no
timestamp server; hardened runtime with the exceptions in
`build/entitlements.mac.plist`, the widget with its own), verifies every
designated requirement is certificate based, and replaces
`/Applications/Relay.app`. Without `--install` (`npm run dist:mac:local`) the
signed bundle stays in the output folder, as `mac-arm64/Relay.app` (`mac/` for
Intel).

After the first certificate-signed install, grant Accessibility to Relay once in
System Settings → Privacy & Security → Accessibility (remove any older Relay
entries first). Later installs keep that permission, the move from Relay 0.x to
1.0 included: the bundle id, the helper's identifier and the certificate are the
same.

Verify an existing bundle:

```sh
node scripts/stable-signing.mjs --verify /Applications/Relay.app
```

## Sharing a build with another Mac

```sh
npm run dist:mac:share
```

This writes both disk images in one run: `release/share/Relay-<version>-arm64.dmg`
for Apple silicon Macs and `release/share/Relay-<version>-x64.dmg` for Intel Macs
(Apple menu → About This Mac shows which: "Chip Apple M…" or "Processor Intel").
Both hold the same certificate-signed app; the `desktop-automation` helper is a
universal binary. One architecture alone: add `--arch arm64` or `--arch x64` to
`node scripts/stable-signing.mjs --dmg --output release/share`.

`npm run release` builds both the same way and attaches them to the GitHub
release (docs/development.md, "Releasing"). Other Macs can also install the
release with Homebrew: `brew install --cask ahmetcankacar54/tap/relay`; the
"Open Anyway" step below is still needed once.

Each architecture is a separate `tauri build` for its Rust target
(`aarch64-apple-darwin`, `x86_64-apple-darwin`), so the Intel build needs
`rustup target add x86_64-apple-darwin` once.

The certificate is local and the app is not notarized by Apple, so the other Mac
blocks the first launch of a downloaded copy:

1. Open the DMG and drag Relay into Applications.
2. Open Relay. macOS says it cannot verify the app; choose **Done**.
3. System Settings → Privacy & Security → "Relay was blocked…" → **Open Anyway**,
   then confirm with the Mac's password. This is needed only once.

A newer download may ask for this step again. Because every build uses the same
certificate, the Accessibility permission granted there is kept. Skipping the
step entirely needs a paid Apple Developer ID certificate and notarization.

The other Mac needs macOS 14 or later, Claude Desktop and, for usage limits, the
native Claude Code CLI 2.1.296+. Node.js, Rust and Xcode are only needed to build.
