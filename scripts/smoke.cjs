// Runs real Electron + preload IPC + native PTY against a local CLI fixture.
// No real accounts, credentials, browser login, model calls, or user history are used.
const { app, BrowserWindow, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root =
  process.env.RELAY_SMOKE_ROOT ||
  fs.mkdtempSync(path.join(os.tmpdir(), "relay-desktop-test-"));
const project = path.join(root, "project with spaces");
fs.mkdirSync(project);
const fixture = path.join(root, "claude-fixture");
const node = process.env.npm_node_execpath;
if (!node || process.platform === "win32") {
  console.error(
    "Desktop integration fixture requires macOS/Linux and npm. Windows is covered by core tests and build CI.",
  );
  app.exit(1);
}
fs.writeFileSync(
  fixture,
  `#!${node}\n` +
    String.raw`
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const root = process.env.CLAUDE_CONFIG_DIR;
if (args[0] === '--version') { console.log('2.1.296 (Relay fixture)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: !fs.existsSync(path.join(root, 'logged-out')), authMethod: 'claude.ai', email: 'fixture@example.test', subscriptionType: 'max' })); process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'login') { console.log('FIXTURE_LOGIN_OK'); setTimeout(() => process.exit(0), 100); }
else {
 const id = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1];
 const projects = path.join(root, 'projects'); fs.mkdirSync(projects, { recursive: true });
 const folder = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
 const dir = path.join(projects, folder); fs.mkdirSync(dir, { recursive: true });
 const file = path.join(dir, id + '.jsonl');
 if (args.includes('--resume') && !fs.existsSync(file)) { console.error('RESUME_NOT_FOUND'); process.exit(2); }
 const row = { type: 'user', uuid: require('node:crypto').randomUUID(), sessionId: id, cwd: process.cwd(), message: { role: 'user', content: 'Fixture working session' } };
 fs.appendFileSync(file, JSON.stringify(row) + '\n');
 console.log('FIXTURE_READY');
 fs.writeFileSync(path.join(root, 'observed.json'), JSON.stringify({ args, config: root, key: process.env.ANTHROPIC_API_KEY, cwd: process.cwd() }));
 process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.on('data', data => process.stdout.write('ECHO:' + data.toString()));
 process.on('SIGHUP', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
}
`,
  { mode: 0o700 },
);
app.setPath("userData", path.join(root, "app"));
fs.mkdirSync(path.join(root, "appdata"));
app.setPath("appData", path.join(root, "appdata"));
dialog.showOpenDialog = async (_window, options) => ({
  canceled: false,
  filePaths: [options.properties.includes("openDirectory") ? project : fixture],
});
require(process.env.RELAY_SMOKE_MAIN || "../dist-electron/main.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for fixture.");
}
app.whenReady().then(async () => {
  let win;
  try {
    await eventually(() => {
      // The macOS menu bar panel is a second window; pick the main one.
      win = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().endsWith("panel.html"),
      );
      return win && win.webContents.getURL() && !win.webContents.isLoading();
    });
    const call = (method, ...args) =>
      win.webContents.executeJavaScript(
        `window.relay[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
      );
    await eventually(async () =>
      Boolean(await win.webContents.executeJavaScript("Boolean(window.relay)")),
    );
    assert.equal(
      await win.webContents.executeJavaScript("typeof require"),
      "undefined",
    );
    assert.equal(
      await win.webContents.executeJavaScript("typeof process"),
      "undefined",
    );
    assert.equal((await call("snapshot")).accounts.length, 0);
    if (process.platform === "darwin") {
      let panel;
      await eventually(() => {
        panel = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().endsWith("panel.html"),
        );
        return panel && !panel.webContents.isLoading();
      });
      assert.equal(panel.isVisible(), false, "the panel starts hidden");
      assert.equal(
        await panel.webContents.executeJavaScript("typeof require"),
        "undefined",
      );
      // The panel opens a page in the main window.
      await panel.webContents.executeJavaScript(
        'window.relay.openPage("planlama")',
      );
      await eventually(
        async () =>
          (await win.webContents.executeJavaScript("location.hash")) ===
          "#/planlama",
      );
      await assert.rejects(
        panel.webContents.executeJavaScript('window.relay.openPage("nope")'),
      );
      // Panel sizing is accepted only from the panel itself.
      await panel.webContents.executeJavaScript(
        "window.relay.setPanelHeight(333)",
      );
      await eventually(() => panel.getContentSize()[1] === 333);
      await call("setPanelHeight", 300);
      await delay(300);
      assert.equal(
        panel.getContentSize()[1],
        333,
        "the main window cannot resize the panel",
      );
      await call("openPage", "genel");
      await eventually(
        async () =>
          (await win.webContents.executeJavaScript("location.hash")) ===
          "#/genel",
      );
    }
    const initialContinuation = (await call("panelSnapshot")).continuation;
    assert.equal(initialContinuation.status, "off");
    assert.equal(initialContinuation.enabled, false);
    assert.equal(initialContinuation.canArm, false);
    // Invalid IPC fails before invoking the native observer on the real device.
    await assert.rejects(
      call("armContinuation", "invalid-account", "guarded-native-at-most-once"),
    );
    await assert.rejects(
      call("armContinuation", randomUUID(), "implicit-consent"),
    );
    await call(
      "dismissDesktopError",
      (await call("desktopSnapshot")).errorRevision,
    );
    assert.equal((await call("desktopSnapshot")).error, undefined);
    await assert.rejects(call("dismissDesktopError", -1));
    assert.equal((await call("panelSnapshot")).settings.usageRefreshMinutes, 5);
    await call("updateSettings", {
      usageRefreshMinutes: 0,
      desktopHistoryTransfer: "off",
    });
    assert.equal(
      (await call("panelSnapshot")).settings.desktopHistoryTransfer,
      "off",
    );
    await assert.rejects(call("updateSettings", { autoSwitch: true }));
    await assert.rejects(call("refreshUsage", "../../invalid"));
    await call("pickExecutable");
    const a = await call("createAccount", {
      name: "Test Max A",
      kind: "personal",
    });
    const b = await call("createAccount", {
      name: "Test Max B",
      kind: "personal",
    });
    const work = await call("createAccount", {
      name: "Separate company",
      kind: "work",
    });
    await call("setTrayLanguage", "en");
    assert.equal(await call("consumeTraySwitchRequest"), null);
    await assert.rejects(call("setTrayLanguage", "invalid"));
    const initialPlanning = (await call("panelSnapshot")).settings.planning;
    assert.equal(initialPlanning.autoStart, false);
    assert.deepEqual(initialPlanning.accounts, []);
    const planAccount = await call("updateAccountPlanning", a.id, {
      plan: "max5",
      capacityWeight: 5,
    });
    assert.equal(planAccount.planning.plan, "max5");
    await assert.rejects(
      call("updateAccountPlanning", a.id, { plan: "max5", capacityWeight: 0 }),
    );
    await assert.rejects(
      call("updateAccountPlanning", randomUUID(), {
        plan: "pro",
        capacityWeight: 1,
      }),
    );
    const planning = await call("updatePlanning", {
      weekday: { enabled: true, start: "22:00", end: "06:00" },
      accounts: [{ id: a.id }, { id: b.id, firstStart: "07:00" }],
    });
    assert.equal(planning.weekday.end, "06:00");
    assert.deepEqual(planning.accounts, [
      { id: a.id },
      { id: b.id, firstStart: "07:00" },
    ]);
    await call("updateSettings", { usageWarnings: false });
    const planningSnapshot = await call("panelSnapshot");
    assert.deepEqual(planningSnapshot.settings.planning, planning);
    assert.equal(planningSnapshot.planning.enabled, false);
    assert.equal(planningSnapshot.usageStatistics, undefined);
    const statistics = await call("usageStatistics", { range: 30 });
    assert.equal(statistics.range, 30);
    assert.ok(["available", "empty"].includes(statistics.status));
    assert.equal(statistics.heatmap.length, 7);
    await assert.rejects(call("usageStatistics", { range: 14 }));
    await assert.rejects(
      call("usageStatistics", { range: 30, accountId: "../../invalid" }),
    );
    await assert.rejects(call("updatePlanning", { timeZone: "invalid" }));
    await assert.rejects(
      call("updatePlanning", { accounts: [{ id: randomUUID() }] }),
    );
    win.close();
    assert.equal(
      win.isDestroyed(),
      false,
      "window close preserves the tray process",
    );
    assert.equal(win.isVisible(), false);
    app.emit("activate");
    assert.equal(
      win.isVisible(),
      true,
      "activation reopens the same Relay window",
    );
    assert.equal((await call("panelSnapshot")).autoSwitch.status, "off");
    await call("updateSettings", {
      desktopHistoryTransfer: "selected",
      desktopHistoryAccounts: [a.id, work.id],
      autoSwitchAccounts: [a.id, b.id],
    });
    await call("updateSettings", { usageWarnings: false });
    const preservedSettings = (await call("panelSnapshot")).settings;
    assert.deepEqual(preservedSettings.desktopHistoryAccounts, [a.id, work.id]);
    assert.deepEqual(preservedSettings.autoSwitchAccounts, [a.id, b.id]);
    assert.equal(preservedSettings.autoSwitchMode, "off");
    await assert.rejects(
      call("updateSettings", { autoSwitchAccounts: [randomUUID()] }),
    );
    await assert.rejects(
      call("updateSettings", { desktopHistoryAccounts: [a.id, a.id] }),
    );
    await assert.rejects(call("desktopHistorySummary", "../../invalid"));
    await assert.rejects(call("syncDesktopHistory", "../../invalid"));
    await call("updateSettings", { desktopHistoryTransfer: "off" });
    assert.equal((await call("refreshUsage", a.id)).issue, "connect-cli");
    assert.equal((await call("checkAuth", a.id)).auth.loggedIn, true);
    const login = await call("login", a.id);
    assert.equal((await call("login", a.id)).id, login.id);
    await eventually(
      async () =>
        (await call("snapshot")).authFlows.find((f) => f.id === login.id)
          ?.status === "connected",
    );
    assert.equal((await call("snapshot")).runs.length, 0);
    assert.equal(
      (await call("snapshot")).accounts.find((x) => x.id === a.id).auth
        .loggedIn,
      true,
    );
    await assert.rejects(
      call("terminalBuffer", login.id),
      /Terminal bulunamadı/,
    );
    const runA = await call("launch", { accountId: a.id, cwd: project });
    await eventually(async () =>
      (await call("terminalBuffer", runA.id)).data.includes("FIXTURE_READY"),
    );
    const observed = JSON.parse(
      fs.readFileSync(
        path.join(root, "app", "profiles", a.id, "observed.json"),
      ),
    );
    assert.equal(observed.cwd, fs.realpathSync(project));
    assert.equal(observed.key, undefined);
    assert(observed.args.includes("--session-id"));
    await call("terminalWrite", runA.id, "hello");
    await eventually(async () =>
      (await call("terminalBuffer", runA.id)).data.includes("ECHO:hello"),
    );
    let snapshot = await call("snapshot");
    const original = snapshot.sessions.find((s) => s.accountId === a.id);
    assert(original);
    assert.equal(original.messages, 1);
    await call("setPinned", original.key, true);
    assert.equal(
      (await call("snapshot")).sessions.find((s) => s.key === original.key)
        .pinned,
      true,
    );
    assert.equal(
      (await call("transcript", original.key))[0].text,
      "Fixture working session",
    );
    await assert.rejects(
      call("launch", { accountId: b.id, sessionKey: original.key }),
      /çalışan oturumu/,
    );
    await assert.rejects(
      call("switchAccount", runA.id, work.id),
      /paylaşım grubunda/,
    );
    assert.equal(
      (await call("snapshot")).runs.find((r) => r.id === runA.id).status,
      "running",
    );
    fs.writeFileSync(
      path.join(root, "app", "profiles", b.id, "logged-out"),
      "",
    );
    await assert.rejects(
      call("switchAccount", runA.id, b.id),
      /Hedef hesaba giriş/,
    );
    assert.equal(
      (await call("snapshot")).runs.find((r) => r.id === runA.id).status,
      "running",
    );
    fs.unlinkSync(path.join(root, "app", "profiles", b.id, "logged-out"));
    const runB = await call("switchAccount", runA.id, b.id);
    await eventually(async () =>
      (await call("terminalBuffer", runB.id)).data.includes("FIXTURE_READY"),
    );
    snapshot = await call("snapshot");
    assert.equal(snapshot.runs.find((r) => r.id === runA.id).status, "exited");
    const copied = snapshot.sessions.find((s) => s.accountId === b.id);
    assert.equal(copied.messages, 2);
    assert.equal(copied.forkedFrom, original.key);
    assert.notEqual(copied.id, original.id);
    const runBack = await call("switchAccount", runB.id, a.id);
    await eventually(async () =>
      (await call("terminalBuffer", runBack.id)).data.includes("FIXTURE_READY"),
    );
    await call("stop", runBack.id);
    snapshot = await call("snapshot");
    assert.equal(snapshot.sessions.length, 3);
    assert.equal(
      snapshot.sessions.find((s) => s.key === original.key).messages,
      1,
    );
    assert.equal(
      snapshot.sessions.find((s) => s.key === runBack.sessionKey).messages,
      3,
    );
    await call("setCooldown", b.id, 5);
    await assert.rejects(
      call("launch", { accountId: b.id, sessionKey: copied.key }),
      /beklemede/,
    );
    await call("setCooldown", b.id, 0);
    await assert.rejects(
      call("launch", { accountId: work.id, sessionKey: copied.key }),
      /paylaşım grubunda/,
    );
    await assert.rejects(
      call("launch", { accountId: a.id, cwd: project, desktop: true }),
      /doğrula/,
    );
    await assert.rejects(
      call("launch", { accountId: "../../invalid", cwd: project }),
    );
    fs.mkdirSync(path.join(__dirname, "../output"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "../output/desktop-integration.json"),
      JSON.stringify(
        {
          passed: true,
          runtime: process.versions.electron,
          checks: [
            "sandboxed preload",
            "empty first launch",
            "Desktop error dismissal IPC",
            "persistent settings IPC and validation",
            "tray language and queued review IPC",
            "close-to-tray and same-window reopen",
            "plan-aware account metadata and planning IPC",
            "default-off window keeper and empty usage statistics",
            "quota IPC with disconnected account",
            "packaged native helper execution without Keychain access",
            "profile creation",
            "hidden login completion",
            "duplicate login idempotence",
            "login excluded from terminal registry",
            "auth status",
            "native PTY input/output",
            "resume",
            "pin",
            "preview",
            "active writer rejection",
            "company boundary",
            "unauthenticated target preserves running process",
            "A to B to A handoff",
            "cooldown",
            "desktop consent",
            "IPC validation",
          ],
          sessionsPreserved: 3,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS: Electron IPC + real PTY integration, A → B → A, 3 preserved branches, auth and company boundaries.",
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error("Fixture directory:", root);
    app.exit(1);
  }
});
