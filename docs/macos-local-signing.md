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

This builds, signs the app and its `desktop-automation` helper with the pinned
certificate (no timestamp server, no hardened runtime for this local build),
verifies both designated requirements are certificate based, and replaces
`/Applications/Relay.app`. Without `--install` (`npm run dist`) the signed bundle
stays in `release/stable/mac-arm64/Relay.app`.

After the first certificate-signed install, grant Accessibility to Relay once in
System Settings → Privacy & Security → Accessibility (remove any older Relay
entries first). Later installs keep that permission.

Verify an existing bundle:

```sh
node scripts/stable-signing.mjs --verify /Applications/Relay.app
```
