# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue, pull request or discussion for a security problem.

Include the Relay version, the operating system, what an attacker can do, and the
steps to reproduce it. You will get an answer in the private advisory; a fix is
released before the advisory is published.

## Supported versions

Only the latest release gets security fixes. Relay updates itself; update before
reporting, and check that the problem is still there.

## What Relay stores and where

- **App data:** `~/Library/Application Support/Relay` on macOS, `~/.config/Relay`
  on Linux (`$XDG_CONFIG_HOME/Relay` when set), `%APPDATA%\Relay` on Windows. It
  holds the account list, settings, encrypted backups taken before Claude's files
  are changed, and the switch journal.
- **Saved Claude Desktop sign-ins:** sealed files in the app data's
  `desktop-vault` folder. On macOS they are encrypted with a random key kept in
  the login Keychain as the item "Relay Vault Key", which the `relay` CLI reads
  too. On Linux they are sealed through the Secret Service or KWallet, on Windows
  through DPAPI.
- **Usage credentials:** each account has an isolated Claude Code CLI profile.
  Relay reads its credential with `/usr/bin/security` on macOS and from the
  profile's `.credentials.json` on Linux. Credentials never reach the UI.
- **Provider gateway key:** kept in Relay's settings and, while a tool is bound to
  the gateway, written into that tool's own configuration
  (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.omp/agent/models.yml`)
  with file mode `0600`. The gateway listens on `127.0.0.1` unless you choose a
  Tailscale address.
- Code history transcripts in `~/.claude` are shared by all accounts and are
  never copied or rewritten.

## Threat model

Relay protects your accounts from other users of the machine and from the
network. It does not protect them from programs running as your own user:

- The vault key's Keychain item trusts `/usr/bin/security`, so neither Relay nor
  the CLI is prompted after an update. Any process running as you can read it
  the same way and open the saved sign-ins.
- The gateway key is readable by anything that can read your home folder's
  tool configurations; the `0600` mode keeps out other users only.
- The usage credentials in each CLI profile are as exposed as Claude Code's own.

Reports that need code already running as the same user, physical access to an
unlocked session, or a compromised operating system are outside this model.
Builds are signed with a local self-signed certificate and are not notarized.
