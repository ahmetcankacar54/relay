Relay 0.15.0 — account switcher for the Claude app (Claude Desktop)
Unofficial personal tool; not an Anthropic product.

INSTALL
1) Relay-0.15.0-arm64.dmg is for Apple silicon Macs (M1 and later).
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
   Görünüm (Appearance) → Arayüz dili (Interface language) → English.

START WITH OVERVIEW
The "Before you start" list on the Overview page shows what is missing:
• Claude app: must be installed.
• Code tab opened: "Open Code" opens Claude in Code. While doing so the Claude
  app downloads the Claude Code that Relay reads limits with; you do not need
  to install the CLI yourself.

ADD AN ACCOUNT
Accounts → "Add account". Three steps, one confirmation at the start:
1) Claude sign-in: if an account is open in Claude, "Add this account…",
   otherwise "Open Claude on sign-in…". Sign in to Claude with that
   account and open Code once; Relay saves the sign-in by itself. Claude
   restarts once or twice meanwhile.
2) Usage access: starts by itself and opens in Relay's own window. Sign in to
   Claude with the same account and allow access. If Google sign-in does not
   open, sign in with email or use "Open in browser". You can also choose
   "Do it later".
3) Ready: a name, type and group are suggested; change them and click
   "Save and finish".
You can rename the account or change its type later from its "…" menu.

PROMPTS YOU MAY SEE
• Keychain: Relay encrypts its saved sign-ins with a key named
  "Relay Vault Key" and creates it on first launch; usually nothing is asked.
  When updating from an older Relay, macOS may ask for your Mac password once.
  Enter it and choose "Always Allow".
• Automation: on the first switch macOS may ask "Relay wants to control
  Claude". Choose Allow; Relay uses it to quit and reopen Claude.
• Accessibility: not needed with the default settings. Relay asks for it with
  a button only if you turn on "When the limit is reached" in
  Settings → Automation, or experimental draft typing in
  Settings → What comes along.

SETTINGS
Every setting is in one place: Settings → Automation, What comes along (Code
history, browser extension, terminal, drafts), Planning, Notifications,
Appearance, Advanced. The interface language (English or Turkish) is under
Appearance.

GOOD TO KNOW
• Switching accounts quits and reopens the Claude app. Do not switch while a
  reply is still running.
• ⌘Q only closes the Relay window. To quit completely, use ⌥⌘Q or "Quit" in
  the panel.

TWO ACCOUNTS AT ONCE (EXPERIMENTAL, macOS)
Settings → Advanced → "Separate Claude windows". Then "Open in a separate
window" on an account (its "…" menu, or the window button on Overview) opens
it in a second Claude app with its own sign-in and conversations, while the
main Claude stays on its account. Close it from the same place.
• While it is open, the main Claude cannot switch to that account, and Relay
  does not switch by itself.
• Claude in Chrome works only in the main Claude.
• Claude does not officially support this; a Claude update may break it.

TROUBLESHOOTING
Relay → Settings → Advanced → Diagnostics files → "Show in Finder".
From the folder that opens, send only draft-events.json and usage-issues.json.
They contain no text, emails or passwords; only short account IDs. Do not send
the rest of the folder; it holds your saved sign-ins.
