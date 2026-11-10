Relay 0.21.0 — account switcher for the Claude app (Claude Desktop)
Unofficial personal tool; not an Anthropic product.

INSTALL
1) Relay-0.21.0-arm64.dmg is for Apple silicon Macs (M1 and later).
   Apple menu → About This Mac should say "Chip: Apple M…". Intel Macs are
   not supported by this build. Requires macOS 13 or later.
2) Open the DMG and drag Relay into the Applications folder. Do not run it
   from inside the DMG.
3) Open Relay. When macOS says "Apple could not verify…", click Done.
4) System Settings → Privacy & Security → "Relay was blocked" near the bottom
   → Open Anyway → enter your Mac password. This is needed once per version.
   If macOS asks again at every launch, Relay is being opened from the DMG or
   from Downloads: eject the DMG (⏏ in Finder), delete the DMG file, and open
   Relay only from Applications. Relay offers to move itself to Applications
   when it notices it runs from a DMG. If that does not help, run this in
   Terminal:
   xattr -dr com.apple.quarantine /Applications/Relay.app
5) Relay lives in the menu bar as a panda icon; the panel opens from there.
   "Open Relay" in the panel opens the main window.
6) Relay opens in Turkish. For English, go to Ayarlar (Settings) →
   Genel (General) → Arayüz dili (Interface language) → English.

START WITH OVERVIEW
The "Before you start" list on the Overview page shows what is missing:
• Claude app: must be installed.
• Code tab opened: "Open Code" opens Claude in Code. While doing so the Claude
  app downloads the Claude Code that Relay reads limits with; you do not need
  to install the CLI yourself.

ADD AN ACCOUNT
Accounts → "Add account".
• Found on this Mac: the dialog first lists the sign-ins it found that are not
  accounts yet (the account open in the Claude app, the Codex CLI's ChatGPT
  sign-in), ticked. "Add N accounts" adds them all at once with suggested
  names; rename them later from an account's "…" menu.
• Another Claude account: "Sign in with another Claude account" reopens the
  Claude app at its sign-in. Sign in and open Code once; Relay saves the
  account by itself. Then the Claude Code sign-in starts in Relay's own window:
  the gateway, the terminal and limit reading use it. "Do it later" skips it,
  but the gateway cannot use the account until it is done.
• OpenAI / Codex and Google Antigravity have their own entries under
  "Add another account".

PROMPTS YOU MAY SEE
• Keychain: Relay encrypts its saved sign-ins with a key named
  "Relay Vault Key" and creates it on first launch; usually nothing is asked.
  When updating from an older Relay, macOS may ask for your Mac password once.
  Enter it and choose "Always Allow".
• Automation: on the first switch macOS may ask "Relay wants to control
  Claude". Choose Allow; Relay uses it to quit and reopen Claude.
• Accessibility: not needed with the default settings. Relay asks for it with
  a button only if you turn on "When the limit is reached" on the Switching
  page, or experimental draft typing under Switching → What comes along.

SETTINGS
Switching (when to switch, what comes along, near the limit) and Planning are
pages of their own in the sidebar, under Accounts. Settings keeps General
(appearance, the interface language) and Advanced.
• E-mails and organizations are blurred until clicked, so a screen share does
  not give them away. Settings → General → "Blur account details" turns it
  off.

GOOD TO KNOW
• Switching accounts quits and reopens the Claude app. Do not switch while a
  reply is still running.
• ⌘Q only closes the Relay window. To quit completely, use ⌥⌘Q or "Quit" in
  the panel.

UPDATES
From 0.16.0 on, Relay looks for a new version by itself (at start and every
six hours). When one is downloaded and checked, a notification and a banner
say "Relay … is ready": click Update and Relay reopens as the new version in a
few seconds. Settings → Advanced → Updates has "Check now" and turns the
automatic check off. Versions before 0.16.0 must be updated by hand once.

TWO ACCOUNTS AT ONCE (EXPERIMENTAL, macOS)
Settings → Advanced → "Separate Claude windows". Then "Open in a separate
window" on an account (its "…" menu, or the window button on Overview) opens
it in a second Claude app with its own sign-in and conversations, while the
main Claude stays on its account. Close it from the same place.
• While it is open, the main Claude cannot switch to that account, and Relay
  does not switch by itself.
• Claude in Chrome works only in the main Claude.
• Claude does not officially support this; a Claude update may break it.

LOCAL API GATEWAY (PROXY)
"Proxy & Gateway" in the sidebar runs a local endpoint that spreads Claude
Code and Codex requests across your saved accounts. The page head has the
on/off switch, the address and the client key; below it are three tabs.
• Live: the pool in the order the gateway uses it, with each account's 5-hour
  and weekly limits, requests and cache use. Arrows reorder it (used by "In
  order"); the switch takes an account out of the pool without removing it.
  "N% expiring" marks weekly room that resets within two days unused.
  Recent requests show which account answered and when a full account (429)
  handed the request to the next one.
• Tools: "Connect" points Claude Code (~/.claude/settings.json) or the Codex
  CLI (~/.codex/config.toml) at the gateway; "Disconnect" puts the previous
  values back. A connected tool follows a new key or port by itself. A tool
  can only be connected when the pool has a signed-in account of its
  provider. Note: connecting Claude Code also routes the Claude app's Code
  tab sessions through the gateway. Other OpenAI-compatible tools are under
  "Other tools (manual setup)".
• Rules: which account a new session starts on ("Expiring first" is the
  default), how long a session stays on its account (prompt cache), and who
  may connect: this Mac only, your Tailscale network when one is found, or
  the whole local network.
• Using a Claude subscription outside Claude Code, from several machines at
  once, or signing in from a server or VPN can get an account restricted.
• Codex accounts: a ChatGPT sign-in from the Codex CLI on this Mac serves the
  Responses API; Chat Completions need an OpenAI API key, which Relay checks
  with OpenAI before saving it.
• Antigravity accounts: "Add account" → Google Antigravity → "Connect with
  Google". After Google, the browser returns to Relay. If it stops on a page
  starting with localhost:51121, paste that address into the dialog.
• Usage dashboards: the gateway also answers as a CLIProxyAPI hub, so T3 Code's
  Usage providers → CLI Proxy can read your Claude and Codex accounts' limits.
  Hub URL: the gateway's address; management key: the client key. It only
  sends an account's token to that provider's own usage requests.
• The terminal command `relay add` adds Claude accounts only.

GOING BACK TO AN OLDER VERSION
From 0.19.0 Relay keeps the gateway's pool order and connected tools in
proxy-pool.json beside the account list, so 0.18.2 still opens the account
list as it is; disconnect the tools first, since 0.18.2 cannot. Relay 0.17 opens it
read-only. Relay 0.18.0 and 0.18.1 cannot open it once an Antigravity account
was added.

TROUBLESHOOTING
Relay → Settings → Advanced → Diagnostics files → "Show in Finder".
From the folder that opens, send only draft-events.json and usage-issues.json.
They contain no text, emails or passwords; only short account IDs. Do not send
the rest of the folder; it holds your saved sign-ins.
