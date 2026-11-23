// The cross-platform boot smoke, run by Electron through scripts/smoke-boot.mjs.
// It proves only that Relay starts, that its sandboxed window reaches the main process over IPC,
// and that a normal quit ends the process. No account, Claude install, network or user data:
// everything Relay writes goes to the test folder in RELAY_SMOKE_ROOT.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = process.env.RELAY_SMOKE_ROOT;
if (!root) {
  console.error("RELAY_SMOKE_ROOT is not set: run this through scripts/smoke-boot.mjs.");
  process.exit(1);
}
const result = path.join(root, "boot-result.json");
const report = (data) => fs.writeFileSync(result, JSON.stringify(data, null, 2));

// The logs folder is outside userData on macOS (~/Library/Logs), and Crashpad keeps its own
// folder: both move into the test folder so main-errors.log and minidumps can be checked there.
for (const name of ["userData", "appData", "logs", "crashDumps"]) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  app.setPath(name, dir);
}
// macOS keeps the vault key in the Keychain; a fake `security` keeps it in the test folder
// instead, as in scripts/smoke.cjs. Windows (DPAPI) and Linux (Secret Service) seal through
// safeStorage and need nothing here.
if (process.platform === "darwin") {
  const security = path.join(root, "fake-security");
  fs.writeFileSync(
    security,
    `#!/bin/sh
dir="${root}"
if [ "$1" = "-i" ]; then
  value="$(cat | grep add-generic-password | sed -E 's/.* -w ([^ ]+).*/\\1/' | head -1)"
  [ -f "$dir/vault-key" ] || printf '%s' "$value" > "$dir/vault-key"
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  [ -f "$dir/vault-key" ] || exit 44
  cat "$dir/vault-key"; echo
  exit 0
fi
exit 9
`,
    { mode: 0o700 },
  );
  process.env.RELAY_SECURITY_TOOL = security;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls `fn` every 100 ms until it is truthy; a slow CI machine gets `seconds` to boot. */
async function eventually(what, fn, seconds = 60) {
  for (let i = 0; i < seconds * 10; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

const started = Date.now();
app.on("quit", (_event, exitCode) => {
  console.log(`BOOT_SMOKE_QUIT ${exitCode}`);
});
require(process.env.RELAY_SMOKE_MAIN || "../dist-electron/main.cjs");

app.whenReady().then(async () => {
  try {
    let win;
    await eventually("the main window", () => {
      // The macOS menu bar panel and the switch window are extra windows; pick the main one.
      win = BrowserWindow.getAllWindows().find(
        (w) => !/(panel|switch)\.html$/.test(w.webContents.getURL()),
      );
      return win && win.webContents.getURL() && !win.webContents.isLoading();
    });
    const page = (code) => win.webContents.executeJavaScript(code);
    await eventually("the preload bridge", async () => Boolean(await page("Boolean(window.relay)")));
    // The page is sandboxed: no Node in the renderer, only the preload's API.
    assert.equal(await page("typeof require"), "undefined");
    assert.equal(await page("typeof process"), "undefined");
    // A round trip through the main process: an empty first launch.
    const snapshot = await page("window.relay.snapshot()");
    assert.equal(snapshot.accounts.length, 0, "a fresh profile has no accounts");
    const booted = Date.now() - started;
    report({ booted: true, bootMs: booted, platform: process.platform, electron: process.versions.electron });
    console.log(`BOOT_SMOKE_READY ${booted} ms`);
    // A normal quit, the one the tray and the menu use: Relay's own before-quit and will-quit
    // handlers run and must let the process end by itself.
    app.quit();
  } catch (error) {
    console.error(error);
    report({ booted: false, error: String(error?.stack ?? error) });
    app.exit(1);
  }
});
