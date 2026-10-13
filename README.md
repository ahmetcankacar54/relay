# Relay — Desktop account switcher

Relay 0.9.0 is a compact, local account panel for the **official Claude Desktop application**. Work stays in Claude. The UI supports Turkish and English. This is an independent, experimental integration, not an Anthropic product.

## Start

Node.js 22.12+ (recommended: 24), npm, and Claude Desktop are required. macOS builds also need Xcode Command Line Tools for the small read-only Keychain bridge. The optional CLI connection uses the [official native Claude Code CLI](https://code.claude.com/docs/en/setup).

```sh
npm ci
npm run build
npm start
```

Development: `npm run dev`. Browser preview: `npm run dev:ui`; `?demo=50` previews 50 sample profiles. The browser never performs real account operations. Native Relay preserves profiles created by v0.1.

## Menu bar, usage history and planning

Relay's menu bar / system tray icon shows the active account and remaining 5-hour and weekly allowance. Selecting a saved account opens its switch review in Relay; it still requires the existing restart acknowledgement. Closing the Relay window keeps it running in the tray. **Quit Relay** exits the process.

Settings now separates **Account switching**, **Usage**, and **Planning**. Usage shows local 7/30-day statistics: observed percentage-point consumption, quota windows and observation coverage. These are partial account-wide observations, not token counts, costs or exact historical totals. Recording starts with this version's first verified poll. Different plan percentages do not represent equal amounts of work.

Planning accepts any clock interval, overnight shifts and full 24-hour intervals (matching start/end), chosen weekdays and an IANA time zone. Select accounts and explicitly set Pro, Max 5×, Max 20× or a custom relative Team capacity. The recommendation considers both remaining quotas, capacity, reserved quota and weekly reset proximity. Routine slots use stable selection order; usage refreshes cannot silently reassign them. This is a scheduling heuristic, not a guaranteed optimal allocation of unknown model costs.

The daily 00–24 chart offers a compact timeline with an hourly ruler and a circular **24-hour clock** view. Both show the working band, proposed five-hour windows and separate fresh server-reset markers. Date navigation exposes windows crossing midnight; previous/next-day labels and DST notices keep calendar dates explicit. The chart reacts to the unsaved schedule without executing it. Account plan/capacity edits save immediately; schedule edits use **Save plan**.

The modern planner includes custom 24-hour time pickers with exact-minute entry and Apply/Cancel, plus a searchable IANA time-zone picker with current UTC offsets and an explicit system-zone shortcut. Partial time-zone queries never become settings. The light graphite/teal layout uses larger readable chart labels and keyboard-accessible controls. See [interface system](design-system/MASTER.md).

Optional **scheduled window starters** are default off and require a quota-consumption review before enabling. On supported macOS/Linux personal Pro/Max CLI profiles, one tools-disabled isolated message may be sent per selected identity and schedule day. Lead time and account spacing are configurable. Active windows, in-use accounts, sign-ins, recovery and mismatches block requests. Relay must remain open and the machine awake; missed slots are not replayed. A successful response is only marked verified after a new server reset timestamp is read.

Automatic starter execution currently refuses company/Team/Enterprise/unknown subscriptions, Windows, incompatible CLI flags and any detected administrator policy. Managed hooks cannot reliably be disabled through ordinary CLI flags. Those accounts can still be included in planning and statistics. This feature neither switches Desktop accounts nor resumes work. More detail and primary sources: [usage-planning.md](docs/usage-planning.md).

## Desktop workflow

1. Sign in to Claude Desktop and open its **Code** tab once.
2. Create or choose a Relay profile. **Add account** only creates a profile; it does not restart Claude. Each row shows its connected email, plan, Desktop readiness, and usage connection. **Details** exposes both connection paths and reconnect actions.
3. Choose **Connect Desktop** on that profile. Setup opens inside the same row. If Claude has an unregistered open account, link it to the matching profile; otherwise review the restart, complete normal sign-in in Claude, and open Code. Return to Relay to explicitly save the connection. Multiple organizations require choosing the matching workspace. Known CLI account/organization mismatches are rejected before Claude quits.
4. Use **Switch** beside a saved profile. Review the source and target and acknowledge that running work has finished. Relay then quits Claude, saves refreshed credentials, restores the selected sign-in, merges permitted local Code indexes, and restarts Claude. Desktop reconnect, setup completion, cancellation, and recovery also require a restart review. This is a restart-based switch, not uninterrupted in-memory hot switching.
5. In Settings → Shared Code history, choose a sharing group or **Between selected accounts**. The selected set explicitly allows local history sharing across organizations; both source and destination must be included. **Merge into current account…** reviews a restart to bring permitted records into the current account. Changing preferences alone never modifies Claude. An empty work group stays isolated under group mode.

**Desktop account setup and usage account setup are separate.** Use **Connect in browser / Reconnect** for usage limits. Official `claude auth login --claudeai` runs as a hidden child process. A progress panel replaces the terminal, supports browser reopening, cancellation, retries and manual authorization codes. Successful login is verified in the main process, independent of renderer lifecycle. It shows the connected identity and warns about duplicate profiles pointing to the same account and organization.

## History and projects

Desktop Code transcripts stay where Claude keeps them. Relay merges local `claude-code-sessions/<account>/<org>/local_*.json` indexes only from registered Desktop profiles in the permitted scope. Newer conversation lineage wins. Original source records and shared transcripts/subagent files are retained; destination archive and permission choices remain local. Deletion tombstones are respected. Newer local `spaces.json` names/folders are refreshed while destination server bindings remain intact, and previously seen projects deleted at the destination are not recreated.

Account details offer a read-only history check: index/project/archive counts and exact transcript-file presence. Finding a transcript is evidence of local availability, **not verification that a different organization's native UI can resume it**. Missing or ambiguous transcripts are shown separately. Relay does not fabricate conversations or copy credentials through history sharing.

The scope is local Code history. Server Chat conversations, Cowork VMs, cloud sessions, remote project knowledge and server-owned Projects/sidebar groups are not synchronized. Claude can replace local groups with server state, and missing scratch/worktree directories cannot be reconstructed from an index. The real Max ↔ Vertex test verified saved-login switches and replies in the same stopped conversation; it also exposed four newly duplicated native cards, still unresolved. See [the acceptance results](docs/max-vertex-acceptance-results.md). Existing conversation/task activity must finish before testing a restart.

## Automatic preparation after exit

On macOS, Settings offers an opt-in **After Claude exits** mode, default off, and a separate list of eligible accounts. Include both the current and target profile. When a verified source quota reaches 100% with a valid future reset, Relay waits for local Desktop processes to be absent for at least ten seconds. The target needs a saved Desktop connection, matching CLI account/organization, data checked within five minutes, more than 10% remaining in both quota windows, and permission under the sharing boundary. Unknown or missing target weekly usage blocks preparation. Relay must stay open; automatic quota refresh should be enabled.

This path never quits or launches Claude, installs hooks, submits messages or resumes a conversation. It saves the next local Desktop identity; the user reopens Claude and continues manually. An explicit 429 from the usage query service does not trigger rotation. Pending logins, recovery, unknown identity, stale data and busy operations block it. Policies, every planned history source and process absence are checked again before each write. A user launching Claude between a process check and file mutation remains a private-integration race; a detected launch leaves a recoverable journal, without rolling back live files.

Completed account/window episodes persist in Relay's registry to prevent repeated rotation after Relay restarts. Private-format errors have a ten-minute delay and at most three attempts in one Relay run. Cloud/SSH work can continue remotely and is not transferred. Running workers are never reassigned to a different subscription.

On macOS, **Switch and continue at quota** is a separate, default-off, one-shot opt-in for the currently selected local Code conversation. Relay captures its exact account, UUID, transcript and permission mode; a verified latest quota failure is required. Relay automatically chooses among identities enrolled when the watch was authorized, filtering current history rules, cooldowns and fresh limits in both windows, then ranking relative plan capacity and remaining quota. No eligible target means waiting. The chosen target is frozen for an interrupted attempt; it cannot be rerouted. It waits for other local engines, tools, approval waits and visible tasks before restarting Claude, reopening that conversation and sending one continuation message. It restores only the captured explicit mode, never copies per-tool permission grants or approves a tool dialog. A source conversation's own quota-reset timer may be taken over only after target/history checks and verified ownership. [Implementation and acceptance limits](docs/desktop-continuation-runtime.md).

The native sender uses macOS Accessibility and needs user permission. Its `guarded-native` contract explicitly lacks atomic UI locking and receiver idempotency: it records submission intent durably before one send, verifies a nonce and new assistant turn in the actual transcript, and never retries an ambiguous send. This is experimental, not a promise of uninterrupted work or exactly-once execution. The [continuation lab](docs/continuation-lab.md) remains synthetic A → B → A validation; it does not certify real account billing or all Claude versions.

Each profile's last verified five-hour and weekly reset dates survive switching, reconnect invalidation and Relay restarts. They are labeled historical when current server data omits a reset; automation and planning never treat them as fresh quota evidence.

## Local storage and recovery

- Relay's registry is `app.getPath('userData')/state.json` (macOS: `~/Library/Application Support/Relay`). v0.1 CLI profiles remain in `profiles/<id>` with separate `CLAUDE_CONFIG_DIR` values.
- Desktop sign-in snapshots include the existing native OAuth cache entries and cookie databases. Relay does not decrypt native Desktop OAuth tokens. Usage polling separately reads each Relay CLI profile’s credential and sends authenticated GET requests to Anthropic. When needed, a hidden official CLI authentication command can renew that isolated profile without a model request or changing Claude Desktop. The complete Desktop snapshot is encrypted again using Electron `safeStorage` / the operating system before being saved in `desktop-vault`. Encrypted snapshots are device/user-bound.
- Desktop files are touched only after Claude exits. Unregistered current accounts must be saved first. No force-kill fallback is used.
- Each multi-file change gets an encrypted backup and a write journal. Errors restore the backup when Claude is still closed; a detected concurrent launch or crash keeps the journal and blocks further switching until **Restore backup** succeeds. Backups are retained and are never automatically deleted.
- Original Desktop configuration keys are preserved except the three account keys involved in switching. Both root-level and `Network/` cookie paths and their SQLite sidecars are handled.
- No credential values, authorization URLs or authorization codes are exposed in snapshots, terminal buffers, app logs or renderer events.
- Window sandbox, context isolation, CSP, sender validation and a narrow typed IPC bridge remain enabled. File paths reject traversal and symlink ancestors. Relay adds no telemetry.

## Platforms and limits

macOS is the validated build target. The Windows native installer/CI configuration is present; the Desktop adapter includes classic `AnthropicClaude` and `Programs/Claude` installs. **Windows runtime and Microsoft Store installs are not validated; Store installs are not supported by this adapter.** Linux can preview the interface and use CLI core tools, but official Desktop switching is unavailable.

The v0.1 CLI session engine remains in the codebase and test API, using official Claude CLI processes with isolated profiles. Different accounts can run concurrently in different project directories. Its session-manager UI has been removed to keep Relay focused on Desktop account switching.

Quota cards show remaining 5-hour and weekly usage, reset times, and stale/unavailable states. CLI connection is required per profile, even when Desktop is already connected. On macOS, background reads explicitly forbid both modern and legacy Keychain prompts; an explicit **Allow Keychain access** action is offered when needed. For Claude Code 2.1.296 or later, Relay can renew credentials near expiry or after one authentication rejection using the official [refresh-token login mechanism](https://code.claude.com/docs/en/env-vars). On macOS a new CLI exchange requires clicking **Renew connection** for that invocation, because the official CLI can open a Keychain write dialog. Background checks keep using a still-valid access token and otherwise report renewal required without opening dialogs. Renewal keeps the enrolled UUID, organization and original scopes, verifies the saved replacement, and refuses an active Relay CLI session or Desktop transaction. Revoked credentials, an existing vendor refresh lock or an uncertain exchange can require browser reconnection. An uncertain rotation is never retried with the same credential pair; a fresh verified replacement reconciles its durable record on the next quota read. No macOS profile is probed with CLI `auth status` at startup; other platforms skip already verified profiles. Explicit user verification remains available. Native helper builds embed fixed identifiers and reuse binaries verified against their source/toolchain digest, reducing unnecessary permission churn. Changed native code in an ad-hoc release can still need renewed consent; stable certificate signing is required to preserve identity across such updates.

Preferences persist refresh cadence (manual/5/15/30 minutes), warning threshold, in-panel warnings, history-scope account suggestions, selected history sharing and after-exit automation. Legacy registries retain profiles and default automation to off. Updating one preference preserves unrelated selections. Disabling transfer affects future merges and does not delete previously copied history. Successful reconnect clears obsolete login-error waits, while 429 Retry-After remains enforced. Earlier requests cannot overwrite the newer login's quota. Quota reads run at most two accounts concurrently and do not lock unrelated account controls. Missing or expired windows never become invented percentages.

Suggestions require fresh data for both windows and use the selected history boundary; they do not initiate switching. Model-specific limits and extra usage balances are not displayed. See [the usage and automation review](docs/usage-and-automation.md) for architecture, research and priorities.

## Verification

```sh
npm test
npm run build
npm run test:desktop                 # real Electron/preload/PTY, fake CLI and temporary data
RELAY_PACKAGED_MAIN="$PWD/release/0.9.0/mac-arm64/Relay.app/Contents/Resources/app.asar/dist-electron/main.cjs" npm run test:desktop -- --packaged
npm run dist
```

Unit tests cover auth lifecycle, split OAuth links, cancellation, stale attempts, A→B→A files, refresh preservation, groups, tombstones, rollback, recovery, path boundaries and 50 profiles. Desktop smoke tests never sign in to real accounts or run inference. Test evidence and unverified boundaries: [docs/validation.md](docs/validation.md). Research and implementation review: [docs/desktop-review.md](docs/desktop-review.md).
