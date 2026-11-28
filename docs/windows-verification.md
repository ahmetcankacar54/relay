# Verifying Relay on Windows

Relay's Windows build is labelled experimental because nobody has run it on a real
Windows machine yet. This checklist is the test that removes the label. **It has
not been run yet.** What runs today without a Windows machine is the boot smoke
in CI (see [What CI already covers](#what-ci-already-covers)).

Run it on a real Windows 11 x64 PC, or a full Windows 11 x64 virtual machine
(Hyper-V, VMware, Parallels). Wine and CrossOver do not count: Relay depends on
WebView2, DPAPI, the Windows login items, the NSIS installer and the real Claude app.

## Before you start

You need:

- Windows 11 x64, 23H2 or later, with a normal (non-administrator) user account.
  WebView2 comes with Windows 11; on Windows 10 the installer fetches it when it
  is missing.
- The Claude app for Windows from claude.ai/download, signed in to nothing yet,
  or signed out.
- Two Claude accounts you own (two emails). Pro or Max, so the limits show.
- The **previous** Relay release's installer (`Relay-Setup-<previous>-x64.exe`)
  and the release under test. Step 9 updates from one to the other.
- Optional: a Codex account, for the gateway's second provider.

Write down for the report: the Windows version (`winver`), the Claude app version
(Claude → Help → About) and the Relay version under test.

### Where things are

| What | Where |
| --- | --- |
| Relay (installed) | `%LOCALAPPDATA%\Relay` unless you chose another folder |
| Relay's data | `%APPDATA%\Relay` |
| Main-process errors | `%APPDATA%\Relay\logs\main-errors.log` |
| Usage-reading problems | `%APPDATA%\Relay\usage-issues.json` |
| Switch, draft and update events | `%APPDATA%\Relay\draft-events.json` |
| Gateway requests | `%APPDATA%\Relay\gateway-requests.jsonl` |
| Update downloads | `%APPDATA%\Relay\updates` |
| Claude app | `%LOCALAPPDATA%\AnthropicClaude` or `%LOCALAPPDATA%\Programs\Claude` |
| Claude app's data | `%APPDATA%\Claude` |

Paste a path into Explorer's address bar to open it. After every step, check that
`main-errors.log` has no new lines; a new line is a failure of that step even when
the screen looks right.

## The checklist

Each step: what to do, what must happen, and where to look when it does not.
Mark each one **pass**, **fail** or **not run** in the report.

### 1. Install

1. Download `Relay-Setup-<previous>-x64.exe` from the releases page and run it.
2. SmartScreen says "Windows protected your PC". Relay is not code-signed, so this
   is expected. Select **More info**, check that the app name is
   `Relay-Setup-<previous>-x64.exe` and the publisher is "Unknown publisher",
   then **Run anyway**.
3. The installer asks where to install; keep the default and finish.

Expected: the installer finishes without an error; Relay is in the Start menu and
in Settings → Apps → Installed apps; it starts when the installer's last page asks
it to. When `<previous>` is a 0.x release, installing the release under test over
it (step 9) removes the 0.x entry from Installed apps and keeps `%APPDATA%\Relay`:
only one Relay is listed afterwards.

Logs: the installer has none of its own; on a failure, take a screenshot of the
error.

### 2. First run

1. Start Relay from the Start menu.

Expected:

- One Relay window opens on Overview with the first-run checklist; a Relay icon
  appears in the notification area (tray, possibly under the `^` overflow).
- The window and the tray menu use the Windows display language when Relay has it
  (15 languages), otherwise English.
- Planning uses the time zone of this PC, not another one.
- Closing the window keeps Relay in the tray; the tray menu's Quit ends it
  (Task Manager shows no `Relay.exe` afterwards).
- Starting Relay a second time while it runs brings the same window forward; no
  second window, no second tray icon.

Logs: `main-errors.log`; on a crash, the Application Error entry for `Relay.exe`
in Event Viewer → Windows Logs → Application.

### 3. Add the first account (Claude app sign-in)

1. Open the Claude app, sign in with account A, open the **Code** tab once, then
   leave the app open.
2. In Relay: **Add account**.

Expected: Relay saves account A with its email and plan. The account card shows
"in use" (or the localized label). `%APPDATA%\Relay\desktop-vault` now holds
encrypted files only: open one in Notepad and check that no email or token is
readable.

Logs: `main-errors.log`, `draft-events.json`. If Relay says the system cannot
encrypt sign-ins, note it: that is DPAPI failing and blocks the rest.

### 4. Add the second account

1. In Relay: **Add account** again and choose to sign in with a new account.

Expected: Relay quits the Claude app and reopens it on its sign-in screen. Sign in
with account B and open the **Code** tab once; Relay saves account B by itself
and suggests its name, type and group. Account A's sign-in is still in the list.

Logs: `main-errors.log`, `draft-events.json`.

### 5. Switch by hand

1. Start a short conversation in the Claude app's Code tab as account B.
2. In Relay, switch to account A from its card. Then switch back to B from the
   tray menu.

Expected:

- Each switch closes the Claude app, reopens it signed in as the chosen account
  within about 30 seconds, and Relay shows the switch as complete.
- After switching back to B, the Code conversation from step 1 is still there,
  and with the default history setting it also shows under account A.
- No "Restore" banner remains. If a switch stops halfway, the banner's
  **Restore** puts back the account that was open, and the report says so.

Logs: `draft-events.json` (switch events), `main-errors.log`. The backup Relay
takes before each switch is under `%APPDATA%\Relay\desktop-vault`.

### 6. Limits

1. In Relay, start the usage sign-in for each account when Relay asks. On Windows
   it opens in the default browser.
2. Wait a minute, or use the refresh button on Overview.

Expected: each account shows its 5-hour and weekly use, close to what claude.ai's
Settings → Usage shows for that account (within a few percent), with the reset
times in this PC's time zone. Limit history starts filling after a few refreshes.

Logs: `usage-issues.json` lists every failed read with its reason;
`main-errors.log`.

### 7. Gateway and a request through it

1. Open **Gateway** and turn it on.
2. The risk dialog explains the terms; read it and confirm. Without confirming
   the gateway must stay off.
3. Copy the address (default `http://127.0.0.1:8317`) and the key (**Show key**).
4. In PowerShell (use `curl.exe`; plain `curl` is a different command there):

   ```powershell
   curl.exe -s http://127.0.0.1:8317/health
   curl.exe -s http://127.0.0.1:8317/v1/messages `
     -H "x-api-key: <key>" -H "content-type: application/json" `
     -H "anthropic-version: 2023-06-01" `
     -d '{\"model\":\"claude-haiku-4-5\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}]}'
   ```

5. Repeat the second request with a wrong key.

Expected: `/health` answers; the request with the right key returns a model reply
and Gateway shows "last request … · <account>"; the wrong key gets 401 and no
account is used. Windows Firewall asks nothing, because the gateway listens on
127.0.0.1 only. Turning the gateway off makes both requests fail to connect.

Logs: `gateway-requests.jsonl` (one line per request, no prompt text),
`main-errors.log`.

### 8. Launch at login

1. Settings → General → turn on **Open at login**.
2. Sign out of Windows and sign back in.

Expected: Relay starts in the tray without opening its window; Task Manager →
Startup apps lists Relay as enabled. Turning the setting off removes it from
Startup apps, and the next sign-in does not start Relay.

Logs: `main-errors.log` (a failure to change the login item is recorded there as
`launch-at-login`).

### 9. Update check (signed sums)

1. With `<previous>` installed (step 1), Settings → Updates → **Check now**.
2. Approve the download and the install when Relay offers them.

Expected: Relay finds the release under test, downloads it, and installs it only
after you approve. Relay restarts on the new version (Settings shows it) with the
accounts and settings from before. Relay checks the installer against the
release's `SHA256SUMS.txt` and its Ed25519 signature `SHA256SUMS.txt.sig`; a
release without a valid signature is refused and nothing installs. From a 0.x
`<previous>`, its built-in updater (still served by the release's `latest.yml`)
runs the 1.0 installer with its wizard: finish it with **Run Relay** checked; the
0.x entry leaves Installed apps and the accounts stay.

Logs: `draft-events.json` (update events), the download in
`%APPDATA%\Relay\updates` (a 0.x Relay downloads to
`%LOCALAPPDATA%\relay-workspace-updater`), `main-errors.log`.

### 10. Diagnostics export

1. Help → **Export Diagnostics…** (Settings → Advanced has the same button) and
   save the zip.
2. Open the zip in Explorer.

Expected: the zip holds the logs above. Search them for both accounts' emails and
names and for `sk-ant`: none appear.

Attach this zip to the report.

### 11. Uninstall and data reset

1. When the build has it, Settings → Advanced → reset Relay's data and confirm.
   Otherwise mark this part "not run".
2. Uninstall Relay from Settings → Apps → Installed apps.

Expected:

- The reset leaves `%APPDATA%\Relay` empty (apart from files Relay recreates
  while it runs), Relay starts as on a first run, and the Claude app stays
  signed in to the account that was open.
- The uninstaller removes the program folder, the Start menu entry and the
  Startup apps entry. The Claude app still opens, signed in.
- Without the reset, `%APPDATA%\Relay` stays after uninstalling: that is
  intended, so a reinstall keeps the accounts. Delete it by hand to remove
  everything.

Logs: on a failure, a screenshot and a listing of what is left
(`dir /s %APPDATA%\Relay`).

## Reporting the results

Open a **Windows verification** issue
(https://github.com/ahmetcankacar54/relay/issues/new?template=windows-verification.yml).
The form asks for the versions above and one line per step: pass, fail or not
run, with a note for every fail. Attach the diagnostics zip from step 10. Look
through screenshots for emails and account names before attaching them.

A failing step that is a bug gets its own bug report as well, linked from the
verification issue.

## When "experimental" comes off

All of these must hold:

1. Steps 1 to 10 pass on a real Windows 11 x64 machine or full VM, on a release
   built by the Release workflow (not a local build), reported through the form.
   Step 11's uninstall part passes; its reset part passes once the build has it.
2. No step left a new line in `main-errors.log` or a crash in Event Viewer.
3. The boot smoke passes on `windows-latest` in the Check workflow for that commit.
4. Bugs found during the run are fixed and the failing steps run again.

Then, in one change: the README badge and the Platforms table and note in
`README.md` and its translations (`README.*.md`), the Windows line under Limits
in `docs/development.md`, and the date and Relay version of the run at the top of
this file. Windows 10 stays "should work" until the checklist passes there too.

## What CI already covers

The Check workflow (`.github/workflows/check.yml`) runs on `windows-latest` and
`ubuntu-latest` as well as macOS: typecheck, the UI tests, `cargo test --workspace`,
the build, and an unsigned package. On Windows and Linux it also runs the boot
smoke, `npm run test:boot` (`scripts/smoke-boot.mjs`), on `target/debug/relay-app`
built with `cargo build -p relay-app --features smoke`. The smoke starts Relay with
a fresh profile in a temporary folder, waits until its main page has loaded the
app's state, lets it quit by itself and fails unless the process ends with exit
code 0 within 120 s and nothing in `main-errors.log`.

It does not cover anything that needs the Claude app, an account, the network,
the installer, SmartScreen, DPAPI with a real user profile, login items or
updates: those are what this checklist is for.
