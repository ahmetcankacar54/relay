# UX review: first run, switching and Settings (2026-11-07)

Feedback from new users (2026-11-06): the app feels confusing. They cannot tell where a setting
lives or what it does. This review walks Relay 0.16.0 in the browser preview (scenarios
`first-run`, `macos`, `mixed-connections`; the main window at 1200×820 and the menu bar panel at
380 px) and reads the code behind each screen. Problems are ranked by how many users hit them and
how badly they block or confuse.

## What works

- The menu bar panel (`src/panel`) is the clearest screen in the app: the open account with two
  rings, the other accounts, one click to an inline "the Claude app closes and reopens … Cancel /
  Switch" confirmation. Keep it as the model for the rest.
- The glossary (`docs/ux/glossary.md`) already gives each thing one name. Most copy follows it.
- The three automation choices are written as "who acts" (I switch myself / when I quit the Claude
  app / when the limit is reached). That is the right framing.

## Problems, ranked by impact

### P1. An account has four "connections", and first run introduces only two

The Accounts table, the account page and Settings all show four connections per account: the
Claude app sign-in, the usage sign-in, the browser extension and the terminal. The add-account
dialog walks through the first two only ("1 · Claude app · 2 · Usage sign-in · 3 · Ready"). The
other two appear later as orange dots and "0 / 4 ready" on the account page, with three-step
guides ("Sign out in the extension. Sign in with account2@… Select Check."). A new user reads
"0 / 4 ready" as "this account is broken", even when the extension and the terminal are optional
and off.

- `src/pages/accounts/AccountDetail.tsx`: "Bağlantılar 0 / 4 hazır" counts optional steps.
- `src/pages/accounts/AccountsTable.tsx`: the Connections column is four bare icons with coloured
  dots; the only legend is "hazır · adım gerekiyor · yok" at the bottom of the table.
- `src/lib/extension-ui.ts`: 8 different extension states, each with its own label and steps.

### P2. Settings mixes actions, status, setup and preferences in six tabs

`Settings` has six tabs: Automation, What comes along, Planning, Notifications, Appearance,
Advanced. Users cannot predict which tab holds a setting because the tabs are not split by one
rule:

- **Actions live in Settings.** Automation opens with a "Now → Next · Switch now" card that
  duplicates the Overview. What comes along has "Merge into the open account…", "Check", "Sync
  now" and "Copy recipe". A user looking for a preference finds buttons that quit the Claude app
  or the browser.
- **Cross-tab dependency.** "Suggest another account" (Automation) is disabled while "Mark
  accounts near their limit" (Notifications) is off. Nothing on the Automation tab says where the
  other switch is.
- **Mislabelled tab.** "Refresh limits automatically" sits under Notifications; it is not a
  notification.
- **Panda in two places.** Panda pranks are under Appearance → Appearance; panda animations and
  the switch window are under Appearance → Menu bar.
- **Planning is a feature, not a setting.** The Planning tab is a full scheduler (a day chart,
  work hours, pace, time zone, per-account capacity). It is the longest tab, and the Overview
  "Today" card links into it.
- **"1 · When to switch?"** carries a step number with no step 2.

### P3. "Advanced" means two different things

There is an Advanced tab, and inside What comes along each card has its own "Advanced" disclosure
(history scope note, extension browser profile + Sync now + saved accounts, terminal saved
accounts + Sync now). Users told to "look under Advanced" open the wrong one. The disclosures also
hide status users need (which accounts are missing an extension or terminal sign-in), while the
Advanced tab shows paths most users never need.

### P4. Jargon and labels that contradict their values

| Where | Copy | Problem |
| --- | --- | --- |
| Everywhere | "Limit okuma girişi" / "usage sign-in" | Users do not know it is a separate sign-in from the Claude app, or why it expires. |
| What comes along | "Eklenti de geçsin: Sadece haber ver" | The label says "the extension follows", the value says it does not. Same pattern for the terminal ("Terminal de geçsin: Dokunma"). |
| Planning | "Tempo · ≈ 50 Pro birimi/sa", "Göreli kapasite", "Uyarla" | Internal model terms on screen. |
| Advanced | "HTTP/3 olmadan aç" | Network term; the real symptom is "grey screen after a switch". |
| What comes along | "Kenar çubuğu bölümleri · Talimatı kopyala" | Not clear what the recipe is for or where to paste it. |
| Accounts table | "Bağlantılar" column | Icons only. |
| Settings tab | "Geçişte taşınanlar" | Awkward; users expect "What switches along". |

### P5. The same action appears three times on one screen

On an account whose usage sign-in expired, the account page shows "Limit okuma girişini yenile"
in the top banner, again under the Limits card, and a third time as "Yenile" in the connections
list. Three buttons for one action read as three different problems.

### P6. First-run checklist disappears too early

`SetupChecklist` (Overview) shows "Before you start" until the Claude app is found, the CLI is
present and the Code tab was opened. Then it vanishes. Nothing guides the user to add a second
account (the whole point of Relay), choose when to switch, or decide about the extension and the
terminal. The add-account dialog also truncates its step labels at 1200 px ("1 · Claude
uygulamas…").

### P7. The Overview "Automation" card lists the browser extension

`src/pages/overview/AutomationCard.tsx` shows Automatic switching, Early start and Browser
extension under "Otomasyon". The extension is not automation; it is something that follows a
switch. It links to Settings → What comes along.

### P8. Experimental options in main paths

"Re-type drafts" (marked Experimental) sits between the extension and the sidebar on What comes
along. "Separate Claude windows (experimental)" and its warnings sit in Advanced next to the
diagnostics, which is fine, but drafts should join it.

### P9. Navigation has six sidebar items for three ideas

Overview, Accounts, then a "Usage" group with Limits, Tokens and cost, Pins, then Settings. The
three usage pages are fine for power users, but new users see six destinations before they have
one account.

## Proposed information architecture

Principles: one rule per section; actions stay on the Overview, the account page and the panel;
Settings holds preferences only; optional and experimental things are marked as such and live
under one Advanced; nothing says "0 / 4" when two of the four are optional.

### Settings: six tabs → four

| New tab | Holds | From |
| --- | --- | --- |
| **Geçiş / Switching** | 1. When to switch (the three mode cards + eligible accounts). 2. What switches along: Code history (scope), browser extension (mode), terminal (on/off), each a single row with a one-line status. 3. Near the limit: mark accounts, threshold, suggest an account (together, so the dependency is visible). | Automation, What comes along, Notifications |
| **Planlama / Planning** | Unchanged content (early start, hours, pace, accounts). | Planning |
| **Genel / General** | Language, theme, refresh limits automatically, updates; Menu bar items; Panda (pranks, animations, switch window) as one group. | Appearance, Notifications, Advanced → Updates |
| **Gelişmiş / Advanced** | System (Claude app, CLI, diagnostics), Troubleshooting (grey screen → "open without HTTP/3"), Experimental (separate windows, re-type drafts, sidebar section recipe), extension and terminal details (browser profile, saved accounts, Sync now), Privacy. | Advanced + the per-card "Advanced" disclosures |

Removed from Settings: the "Now → Next · Switch now" card (the Overview and the panel already
have it), and the numbered "1" badge. The in-card "Advanced" disclosures go away; their content
moves to the Advanced tab, so "Advanced" means one place.

Old hashes keep working: `#/ayarlar/otomasyon` and `#/ayarlar/tasinanlar` open Switching,
`#/ayarlar/bildirimler` opens Switching (near-the-limit), `#/ayarlar/gorunum` opens General,
`#/gecis` opens Switching.

### First run: a guided checklist that stays until Relay is useful

The Overview checklist becomes "Set up Relay" with these rows, each with one button, and stays
until the required rows are done (optional rows can be skipped):

1. Claude app found (existing).
2. Code tab opened (existing; covers the CLI).
3. First account added (opens Add account).
4. Second account added (Relay switches between at least two).
5. Choose when to switch (opens Settings → Switching; done once the user picks a mode, even
   "I switch myself").
6. Optional: browser extension follows the account.
7. Optional: terminal follows the account.

### Accounts and the account page

- Connections count only required steps: "2 / 2 ready" plus optional rows labelled "Optional"
  ("İsteğe bağlı") when the extension or terminal mode is off.
- One action per problem: the usage sign-in renew button appears once (in the connection row);
  the banner and the Limits card point to it instead of repeating it.
- The Accounts table's Connections icons get tooltips naming each connection and its state.
- The add-account step labels do not truncate.

### Copy

- "Eklenti de geçsin" → "Tarayıcı eklentisi" / "Browser extension"; "Terminal de geçsin" →
  "Terminal"; the mode value says what happens.
- "HTTP/3 olmadan aç" → row titled "Claude uygulaması gri ekranda kalıyorsa" / "If the Claude app
  stays on a grey screen", with the HTTP/3 detail in the description.
- Keep "limit okuma girişi" (glossary) but add one sentence the first time it appears in the
  add-account dialog: it is a separate, read-only sign-in that Claude Code uses to read limits.

### Not in this pass

- Merging the three Usage pages into one page with tabs (P9): worth doing, but it touches the
  sidebar shortcuts (⌘1–⌘5) and the widget's deep links; propose separately.
- Simplifying the extension's eight states (P1, `extension-ui.ts`): the states are real; the fix
  here is to hide them behind "Optional" until the user turns the extension on.

## What was implemented (approved 2026-11-07)

- Settings has four tabs: Geçiş / Switching, Planlama / Planning, Genel / General, Gelişmiş /
  Advanced (`src/app/routes.ts`, `src/pages/Settings.tsx`, `src/pages/settings/SwitchingTabs.tsx`).
  The "Now → Next · Switch now" card and the "1" badge are gone. The near-the-limit switches
  sit together, with the suggestion saying what it needs while it is off. Old hashes
  (`otomasyon`, `tasinanlar`, `bildirimler`, `gorunum`, `#/gecis`) open the new tabs, and every
  "Settings → …" sentence in errors, notices and the CLI names the new tab.
- General holds language, theme, the refresh interval, the menu bar, one Panda group and updates.
  Advanced holds System, Troubleshooting ("If the Claude app stays on a grey screen"),
  Experimental (separate windows, draft re-typing, the sidebar recipe) and Privacy.
- The Overview checklist is "Set up Relay": the prerequisites, then first account, second
  account, when to switch, and on macOS the optional extension (`setupState` in
  `src/lib/onboarding.ts`). The later steps open one at a time. Choose and Skip are remembered in
  `localStorage` (`relay.setup.v1`). The list hides once done, or with Hide once Relay is ready.
- The account page counts only the Claude app sign-in and the usage sign-in ("2 / 2 ready"). The
  extension and terminal rows carry an "Optional" badge. Its sign-in problem shows once, on the
  connection row: no banner for this account, and the Limits card points to Connections.
- The Accounts table legend names each icon and marks the extension and the terminal optional.
  The add-account step labels wrap instead of truncating. Step 2 says what the usage sign-in is.
- The extension and terminal rows read "At a switch: <mode>" instead of "The extension follows:
  Only tell me".

Deviations from the proposal:

- The extension and terminal details (browser profile, Sync now, saved accounts) stay in their
  cards, under a disclosure renamed from "Gelişmiş" to "Ayrıntılar" / "Details". Moving them to
  the Advanced tab would split a reconnect across two tabs. The card opens that disclosure by
  itself when a profile must be chosen or Sync now can help. "Advanced" now means only the tab.
- "Merge into the open account…" and "Check" stay on the Switching tab next to the setting they
  act on.
- No terminal step in the setup list: the terminal follows the account by default, so the step
  would always be ticked.
- P7 (the extension row on the Overview automation card) is not changed in this pass.
