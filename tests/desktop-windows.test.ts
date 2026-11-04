import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import {
  DesktopManager,
  DesktopSwitchRefused,
  WINDOW_HOLDS_ACCOUNT,
  type DesktopHost,
} from "../electron/core/desktop";
import {
  DesktopWindows,
  WINDOW_DID_NOT_CLOSE,
  WINDOW_IS_MAIN,
  WINDOWS_OFF,
} from "../electron/core/desktop-windows";
import type { ClaudeWindowProcess } from "../electron/core/desktop-instances";
import { jsonBytes, readBytes, readObject, writeBytes } from "../electron/core/desktop-files";
import { localizeError } from "../src/messages";

/** A main Claude and its separate windows, as a fake host runs them. */
async function fixture(t: any) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "relay-windows-"));
  const root = path.join(temp, "Claude");
  await fs.mkdir(root);
  const store = new Store(path.join(temp, "Relay"));
  let running = false;
  const windows: ClaudeWindowProcess[] = [];
  const launched: { dir: string; quicOff?: boolean }[] = [];
  const quitPids: number[] = [];
  const shown: number[] = [];
  let nextPid = 500;
  /** A window that ignores its quit: Claude asks about work left running. */
  let stubborn = false;
  const host: DesktopHost = {
    available: async () => true,
    running: async () => running,
    quit: async () => {
      running = false;
    },
    launch: async () => {
      running = true;
    },
    seal: (s) => Buffer.from("TEST-ENCRYPTED:" + Buffer.from(s).toString("base64")),
    unseal: (b) => Buffer.from(b.toString().slice(15), "base64").toString(),
    draftScratchDir: path.join(temp, "tmp"),
    windows: async () => windows.map((w) => ({ ...w, pids: [...w.pids] })),
    windowsSeen: () => windows.length,
    launchWindow: async (dir, options) => {
      launched.push({ dir, ...(options?.quicOff ? { quicOff: true } : {}) });
      const pid = nextPid++;
      windows.push({ dir, pid, pids: [pid] });
    },
    quitWindow: async (pid) => {
      quitPids.push(pid);
      if (stubborn) return;
      windows.splice(
        windows.findIndex((w) => w.pid === pid),
        1,
      );
    },
    activateWindow: async (pid) => {
      shown.push(pid);
    },
  };
  const manager = new DesktopManager(root, store, host, path.join(temp, ".claude"));
  await manager.initialize();
  const events: [string, Record<string, unknown>][] = [];
  const desktopWindows = new DesktopWindows({
    folder: path.join(temp, "Relay", "claude-windows"),
    host,
    current: async () => {
      const config = await readObject(root, "config.json");
      return typeof config?.lastKnownAccountUuid === "string" ? config.lastKnownAccountUuid : undefined;
    },
    seed: (accountUuid, dir) => manager.seedWindow(accountUuid, dir),
    seal: (accountUuid, dir) => manager.sealWindow(accountUuid, dir),
    now: Date.now,
    sleep: async () => {},
    log: (event, fields) => events.push([event, fields]),
  });
  manager.windows = {
    openAccounts: () => desktopWindows.openAccounts(),
    anyOpen: () => desktopWindows.anyOpen(),
    folder: (accountUuid) => desktopWindows.folderOf(accountUuid),
  };
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  /** An account whose Claude app sign-in is saved; the main Claude is left on it. */
  async function account(name: string) {
    const a = store.create({ name, kind: "personal" });
    const accountUuid = randomUUID(),
      orgId = randomUUID();
    await writeBytes(
      root,
      "config.json",
      jsonBytes({
        "oauth:tokenCacheV2": `encrypted:${name}`,
        lastKnownAccountUuid: accountUuid,
        preference: "preserved",
      }),
    );
    await fs.mkdir(path.join(root, "claude-code-sessions", accountUuid, orgId), { recursive: true });
    await writeBytes(root, "Cookies", Buffer.from(`cookie-${name}`));
    await manager.capture(a.id, orgId);
    return store.account(a.id);
  }
  const vaultLogin = async (accountUuid: string) =>
    JSON.parse(
      host.unseal(
        (await readBytes(path.join(temp, "Relay", "desktop-vault"), `accounts/${accountUuid}.bin`))!,
      ),
    );
  return {
    temp,
    root,
    store,
    host,
    manager,
    desktopWindows,
    account,
    vaultLogin,
    windows,
    launched,
    quitPids,
    shown,
    events,
    setStubborn: (value: boolean) => {
      stubborn = value;
    },
  };
}

test("a window opens signed in with the vault's sign-in, and gives a renewed one back once closed", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B"); // The main Claude is on B.
  f.desktopWindows.setEnabled(true);
  assert.equal(await f.desktopWindows.open(a.desktop!.accountUuid), "opened");
  const dir = f.desktopWindows.dataDir(a.desktop!.accountUuid);
  assert.deepEqual(f.launched, [{ dir }]);
  const config = await readObject(dir, "config.json");
  assert.equal(config?.lastKnownAccountUuid, a.desktop!.accountUuid);
  assert.equal(config?.["oauth:tokenCacheV2"], "encrypted:A");
  assert.equal((await readBytes(dir, "Cookies"))?.toString(), "cookie-A");
  assert.deepEqual(await f.desktopWindows.openAccounts(), [a.desktop!.accountUuid]);
  // The main Claude is untouched.
  assert.equal((await readObject(f.root, "config.json"))?.["oauth:tokenCacheV2"], "encrypted:B");

  // Claude renews the token in the window; closing gives it back.
  await writeBytes(dir, "config.json", jsonBytes({ ...config, "oauth:tokenCacheV2": "encrypted:A-renewed" }));
  await f.desktopWindows.close(a.desktop!.accountUuid);
  assert.equal(f.quitPids.length, 1);
  assert.equal((await f.vaultLogin(a.desktop!.accountUuid)).auth["oauth:tokenCacheV2"], "encrypted:A-renewed");
  assert.deepEqual(await f.desktopWindows.openAccounts(), []);
  assert.deepEqual(
    f.events.map(([event]) => event),
    ["window-opened", "window-closed"],
  );
});

test("a window closed by hand gives its sign-in back on the next look; one signed out changes nothing", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const c = await f.account("C");
  await f.account("B");
  f.desktopWindows.setEnabled(true);
  await f.desktopWindows.open(a.desktop!.accountUuid);
  await f.desktopWindows.open(c.desktop!.accountUuid);
  const dirA = f.desktopWindows.dataDir(a.desktop!.accountUuid);
  const dirC = f.desktopWindows.dataDir(c.desktop!.accountUuid);
  await writeBytes(dirA, "config.json", jsonBytes({
    lastKnownAccountUuid: a.desktop!.accountUuid,
    "oauth:tokenCacheV2": "encrypted:A-2",
  }));
  // C was signed out in its window.
  await writeBytes(dirC, "config.json", jsonBytes({}));
  f.windows.splice(0, f.windows.length);
  assert.deepEqual(await f.desktopWindows.reconcile(), [a.desktop!.accountUuid]);
  assert.equal((await f.vaultLogin(a.desktop!.accountUuid)).auth["oauth:tokenCacheV2"], "encrypted:A-2");
  assert.equal((await f.vaultLogin(c.desktop!.accountUuid)).auth["oauth:tokenCacheV2"], "encrypted:C");
  // Nothing is left to give back.
  assert.deepEqual(await f.desktopWindows.reconcile(), []);
});

test("a sign-in that cannot be saved back now is tried again later", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.desktopWindows.setEnabled(true);
  await f.desktopWindows.open(a.desktop!.accountUuid);
  f.windows.splice(0, f.windows.length);
  // Another Desktop operation holds Desktop while the window's sign-in would be saved.
  const busy = f.manager.seedWindow(a.desktop!.accountUuid, path.join(f.temp, "other"));
  assert.deepEqual(await f.desktopWindows.reconcile(), []);
  await busy;
  assert.deepEqual(await f.desktopWindows.reconcile(), [a.desktop!.accountUuid]);
});

test("opening is refused while off, for the main Claude's own account, and brings an open one forward", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // The main Claude is on B.
  await assert.rejects(f.desktopWindows.open(a.desktop!.accountUuid), new RegExp(WINDOWS_OFF));
  f.desktopWindows.setEnabled(true);
  await assert.rejects(f.desktopWindows.open(b.desktop!.accountUuid), new RegExp(WINDOW_IS_MAIN));
  assert.equal(await f.desktopWindows.open(a.desktop!.accountUuid), "opened");
  assert.equal(await f.desktopWindows.open(a.desktop!.accountUuid), "shown");
  assert.equal(f.launched.length, 1);
  assert.deepEqual(f.shown, [f.windows[0].pid]);
  // The choice is kept beside the registry.
  const again = new DesktopWindows({
    folder: path.join(f.temp, "Relay", "claude-windows"),
    host: f.host,
    current: async () => undefined,
    seed: async () => {},
    seal: async () => false,
    now: Date.now,
  });
  assert.equal(again.enabled, true);
});

test("a window that does not close says so and keeps its sign-in", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.desktopWindows.setEnabled(true);
  await f.desktopWindows.open(a.desktop!.accountUuid);
  f.setStubborn(true);
  await assert.rejects(f.desktopWindows.close(a.desktop!.accountUuid), new RegExp(WINDOW_DID_NOT_CLOSE));
  assert.deepEqual(await f.desktopWindows.openAccounts(), [a.desktop!.accountUuid]);
});

test("the main Claude cannot switch to an account its window holds, and never switches by itself while one runs", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const c = await f.account("C");
  await f.account("B");
  f.desktopWindows.setEnabled(true);
  await f.desktopWindows.open(a.desktop!.accountUuid);
  await assert.rejects(f.manager.switchTo(a.id), new RegExp(WINDOW_HOLDS_ACCOUNT));
  await assert.rejects(
    f.manager.switchTo(c.id, { automatic: true }),
    (error: unknown) => error instanceof DesktopSwitchRefused,
  );
  assert.equal((await readObject(f.root, "config.json"))?.["oauth:tokenCacheV2"], "encrypted:B");
  // A person may switch to another account.
  await f.manager.switchTo(c.id);
  assert.equal((await readObject(f.root, "config.json"))?.["oauth:tokenCacheV2"], "encrypted:C");
  // The snapshot counts the window, so automation waits.
  assert.equal((await f.manager.snapshot()).windows, 1);
  assert.match(localizeError(WINDOW_HOLDS_ACCOUNT, "tr"), /ayrı bir Claude penceresinde/);
});

test("switching to an account takes over the conversations its closed window had", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.desktopWindows.setEnabled(true);
  await f.desktopWindows.open(a.desktop!.accountUuid);
  const dir = f.desktopWindows.dataDir(a.desktop!.accountUuid);
  const cliSessionId = randomUUID();
  const record = `claude-code-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}/local_${cliSessionId}.json`;
  await writeBytes(
    dir,
    record,
    jsonBytes({
      sessionId: `local_${cliSessionId}`,
      cliSessionId,
      cwd: f.temp,
      title: "From the window",
      lastActivityAt: 42,
    }),
  );
  // While the window runs its sessions are its own; once it closes, up to a while after their
  // last activity there.
  assert.deepEqual([...(await f.desktopWindows.sessionOwners())], [
    [cliSessionId, { accountUuid: a.desktop!.accountUuid, until: Number.POSITIVE_INFINITY }],
  ]);
  await f.desktopWindows.close(a.desktop!.accountUuid);
  assert.deepEqual([...(await f.desktopWindows.sessionOwners())], [
    [cliSessionId, { accountUuid: a.desktop!.accountUuid, until: 42 + 10 * 60_000 }],
  ]);
  await f.manager.switchTo(a.id);
  assert.equal((await readObject(f.root, record))?.title, "From the window");
});

test("with history transfer off, the main Claude still takes over its own account's window conversations", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "off";
  });
  f.desktopWindows.setEnabled(true);
  await f.desktopWindows.open(a.desktop!.accountUuid);
  const cliSessionId = randomUUID();
  const record = `claude-code-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}/local_${cliSessionId}.json`;
  await writeBytes(
    f.desktopWindows.dataDir(a.desktop!.accountUuid),
    record,
    jsonBytes({ sessionId: `local_${cliSessionId}`, cliSessionId, cwd: f.temp, title: "Own", lastActivityAt: 42 }),
  );
  await f.desktopWindows.close(a.desktop!.accountUuid);
  await f.manager.switchTo(a.id);
  assert.equal((await readObject(f.root, record))?.title, "Own");
});

test("a look while a window is still starting does not take it for closed", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.desktopWindows.setEnabled(true);
  // The listing shows the new app only after a reconcile ran in between.
  const launch = f.host.launchWindow!;
  let between: string[] | undefined;
  f.host.launchWindow = async (dir, options) => {
    between = await f.desktopWindows.reconcile();
    await launch(dir, options);
  };
  await f.desktopWindows.open(a.desktop!.accountUuid);
  assert.deepEqual(between, []);
  // Its record is kept, so a renewed sign-in still goes back once it closes.
  const dir = f.desktopWindows.dataDir(a.desktop!.accountUuid);
  await writeBytes(dir, "config.json", jsonBytes({
    lastKnownAccountUuid: a.desktop!.accountUuid,
    "oauth:tokenCacheV2": "encrypted:A-later",
  }));
  await f.desktopWindows.close(a.desktop!.accountUuid);
  assert.equal((await f.vaultLogin(a.desktop!.accountUuid)).auth["oauth:tokenCacheV2"], "encrypted:A-later");
});

test("a window sealing back leaves an earlier Desktop error to read", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.manager.reportVaultError("Earlier problem.");
  f.desktopWindows.setEnabled(true);
  await f.desktopWindows.open(a.desktop!.accountUuid);
  await f.desktopWindows.close(a.desktop!.accountUuid);
  assert.equal((await f.manager.snapshot()).error, "Earlier problem.");
});
