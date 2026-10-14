import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AutoSwitchManager,
  autoSwitchDecision,
} from "../electron/core/auto-switch";
import { DesktopManager, type DesktopHost } from "../electron/core/desktop";
import { Store } from "../electron/core/store";
import {
  writeBytes,
  jsonBytes,
  readObject,
} from "../electron/core/desktop-files";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type DesktopState,
  type RelaySettings,
} from "../shared/types";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const reset = new Date(NOW + 3_600_000).toISOString();
function account(name: string, group = "personal"): Account {
  const accountUuid = randomUUID(),
    orgId = randomUUID();
  return {
    id: randomUUID(),
    name,
    kind: group === "personal" ? "personal" : "work",
    group,
    color: "olive",
    createdAt: new Date(NOW).toISOString(),
    desktop: { accountUuid, orgId, savedAt: new Date(NOW).toISOString() },
    auth: {
      loggedIn: true,
      accountUuid,
      orgId,
      checkedAt: new Date(NOW).toISOString(),
    },
  };
}
function quota(account: Account, fiveHour = 10, sevenDay = 20): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(NOW).toISOString(),
    fiveHour: { usedPercent: fiveHour, resetsAt: reset },
    sevenDay: { usedPercent: sevenDay, resetsAt: reset },
  };
}
function scenario() {
  const a = account("A"),
    b = account("B");
  const settings: RelaySettings = {
    ...DEFAULT_SETTINGS,
    autoSwitchMode: "after-exit",
    autoSwitchAccounts: [a.id, b.id],
  };
  const desktop: DesktopState = {
    available: true,
    running: false,
    currentAccountUuid: a.desktop!.accountUuid,
    activeProfileId: a.id,
    organizations: [a.desktop!.orgId],
    busy: false,
    recoveryRequired: false,
    errorRevision: 0,
  };
  const usage = { [a.id]: quota(a, 100), [b.id]: quota(b) };
  const decide = (pendingAuth = false, platformSupported = true) =>
    autoSwitchDecision(
      settings,
      [a, b],
      desktop,
      usage,
      NOW,
      pendingAuth,
      platformSupported,
    );
  return { a, b, settings, desktop, usage, decide };
}
test("automatic preparation is disabled by default and rejects unsupported platforms", () => {
  assert.equal(DEFAULT_SETTINGS.autoSwitchMode, "off");
  const f = scenario();
  f.settings.autoSwitchMode = "off";
  assert.equal(f.decide().state.reason, "disabled");
  f.settings.autoSwitchMode = "after-exit";
  assert.equal(f.decide(false, false).state.reason, "unsupported-platform");
});
test("a real exhausted window selects a verified target and waits while Claude runs", () => {
  const f = scenario();
  assert.equal(f.decide().state.reason, "quota-exhausted");
  assert.equal(f.decide().state.targetId, f.b.id);
  f.desktop.running = true;
  assert.equal(f.decide().state.reason, "claude-running");
  assert.equal(f.decide().state.status, "waiting");
  f.usage[f.a.id].fiveHour!.usedPercent = 99.99;
  assert.equal(f.decide().state.reason, "quota-available");
  f.usage[f.a.id].sevenDay!.usedPercent = 100;
  assert.equal(f.decide().state.reason, "claude-running");
});
test("source quota must be fresh with a valid future reset; missing weekly data alone does not hide 5h exhaustion", () => {
  const f = scenario();
  f.usage[f.a.id].sevenDay = undefined;
  assert.equal(f.decide().state.reason, "quota-exhausted");
  for (const checkedAt of [
    new Date(NOW - 5 * 60_000 - 1).toISOString(),
    new Date(NOW + 1).toISOString(),
    "invalid",
  ]) {
    f.usage[f.a.id].checkedAt = checkedAt;
    assert.equal(f.decide().state.reason, "usage-not-fresh");
  }
  f.usage[f.a.id].checkedAt = new Date(NOW).toISOString();
  for (const resetsAt of [undefined, "invalid", new Date(NOW).toISOString()]) {
    f.usage[f.a.id].fiveHour!.resetsAt = resetsAt;
    assert.equal(f.decide().state.reason, "usage-not-fresh");
  }
});
test("target requires known matching identities, both windows below 90%, and no cooldown", () => {
  const reject = (change: (f: ReturnType<typeof scenario>) => void) => {
    const f = scenario();
    change(f);
    assert.equal(f.decide().state.reason, "no-ready-target");
  };
  reject((f) => {
    f.b.auth!.loggedIn = false;
  });
  reject((f) => {
    f.b.auth!.accountUuid = undefined;
  });
  reject((f) => {
    f.b.auth!.orgId = randomUUID();
  });
  reject((f) => {
    f.usage[f.b.id].fiveHour = undefined;
  });
  reject((f) => {
    f.usage[f.b.id].fiveHour!.usedPercent = 90;
  });
  reject((f) => {
    f.usage[f.b.id].sevenDay!.usedPercent = 100;
  });
  reject((f) => {
    f.usage[f.b.id].fiveHour!.usedPercent = NaN;
  });
  reject((f) => {
    f.usage[f.b.id].checkedAt = new Date(NOW - 300_001).toISOString();
  });
  reject((f) => {
    f.usage[f.b.id].fiveHour!.resetsAt = "invalid";
  });
  reject((f) => {
    f.b.cooldownUntil = new Date(NOW + 1).toISOString();
  });
  reject((f) => {
    f.b.desktop = { ...f.a.desktop! };
    f.b.auth = { ...f.a.auth! };
  });
});
test("automatic account selection cannot cross an ungranted history boundary", () => {
  const f = scenario();
  f.settings.autoSwitchAccounts = [f.a.id];
  assert.equal(f.decide().state.reason, "no-ready-target");
  f.settings.autoSwitchAccounts = [f.b.id];
  assert.equal(f.decide().state.reason, "not-selected");
  f.settings.autoSwitchAccounts = [f.a.id, f.b.id];
  f.b.group = "work:private";
  f.settings.desktopHistoryTransfer = "same-group";
  assert.equal(f.decide().state.reason, "no-ready-target");
  f.settings.desktopHistoryTransfer = "all";
  assert.equal(f.decide().state.reason, "quota-exhausted");
  f.settings.desktopHistoryTransfer = "off";
  assert.equal(f.decide().state.reason, "no-ready-target");
  f.settings.desktopHistoryTransfer = "selected";
  f.settings.desktopHistoryAccounts = [f.b.id];
  assert.equal(f.decide().state.reason, "no-ready-target");
  f.settings.desktopHistoryAccounts = [f.a.id, f.b.id];
  assert.equal(f.decide().state.reason, "quota-exhausted");
});
test("sign-in, recovery, unknown active identity and overlapping Desktop operations block preparation", () => {
  const f = scenario();
  assert.equal(f.decide(true).state.reason, "browser-sign-in");
  f.desktop.pendingProfileId = f.b.id;
  assert.equal(f.decide().state.reason, "desktop-sign-in");
  f.desktop.pendingProfileId = undefined;
  f.desktop.recoveryRequired = true;
  assert.equal(f.decide().state.reason, "desktop-recovery");
  f.desktop.recoveryRequired = false;
  f.desktop.busy = true;
  assert.equal(f.decide().state.reason, "desktop-busy");
  f.desktop.busy = false;
  f.desktop.currentAccountUuid = randomUUID();
  assert.equal(f.decide().state.reason, "unknown-active");
});
async function managerFixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auto-switch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = scenario(),
    store = new Store(root);
  store.update((state) => {
    state.accounts = [f.a, f.b];
    state.settings = f.settings;
  });
  let now = NOW,
    snapshots = 0,
    calls = 0;
  let snapshotHook: (() => void) | undefined;
  let switchHook: ((options: any) => Promise<void>) | undefined;
  const desktop = {
    snapshot: async () => {
      snapshots++;
      snapshotHook?.();
      return structuredClone(f.desktop);
    },
    switchTo: async (id: string, options: any) => {
      calls++;
      assert.equal(id, f.b.id);
      assert.equal(options.closedOnly, true);
      assert.equal(options.expectedActiveProfileId, f.a.id);
      assert.equal(options.canProceed(), true);
      if (switchHook) await switchHook(options);
      else
        Object.assign(f.desktop, {
          activeProfileId: f.b.id,
          currentAccountUuid: f.b.desktop!.accountUuid,
          organizations: [f.b.desktop!.orgId],
        });
    },
  };
  const manager = new AutoSwitchManager(
    store,
    desktop,
    { snapshot: () => f.usage },
    { now: () => now, platformSupported: true },
  );
  return {
    ...f,
    store,
    manager,
    snapshots: () => snapshots,
    calls: () => calls,
    setSnapshotHook: (value: typeof snapshotHook) => {
      snapshotHook = value;
    },
    setSwitchHook: (value: typeof switchHook) => {
      switchHook = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    refresh: () => {
      for (const usage of Object.values(f.usage))
        usage.checkedAt = new Date(now).toISOString();
    },
    settle: async () => {
      await manager.tick();
      now += 10_001;
    },
  };
}
test("disabled mode does not inspect Desktop or invoke switches", async (t) => {
  const f = await managerFixture(t);
  f.store.update((state) => {
    state.settings.autoSwitchMode = "off";
  });
  await f.manager.tick();
  assert.equal(f.snapshots(), 0);
  assert.equal(f.calls(), 0);
  assert.equal(f.manager.snapshot().reason, "disabled");
});
test("re-enabling automatic preparation starts a new exit grace period", async (t) => {
  const f = await managerFixture(t);
  await f.settle();
  f.store.update((state) => {
    state.settings.autoSwitchMode = "off";
  });
  await f.manager.tick();
  f.store.update((state) => {
    state.settings.autoSwitchMode = "after-exit";
  });
  await f.manager.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.manager.snapshot().reason, "exit-settling");
  f.advance(9_999);
  await f.manager.tick();
  assert.equal(f.calls(), 0);
  f.advance(2);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
});
test("manager prepares after exit without repeating the same exhaustion episode", async (t) => {
  const f = await managerFixture(t);
  f.desktop.running = true;
  await f.manager.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.manager.snapshot().status, "waiting");
  f.desktop.running = false;
  await f.manager.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.manager.snapshot().reason, "exit-settling");
  f.advance(10_001);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.manager.snapshot().status, "switched");
  await f.manager.tick();
  assert.equal(f.manager.snapshot().status, "switched");
  Object.assign(f.desktop, {
    activeProfileId: f.a.id,
    currentAccountUuid: f.a.desktop!.accountUuid,
    organizations: [f.a.desktop!.orgId],
  });
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.manager.snapshot().reason, "already-switched");
});
test("completed exhaustion windows stay blocked after Relay restarts", async (t) => {
  const f = await managerFixture(t);
  await f.settle();
  await f.manager.tick();
  assert.equal(Object.keys(f.store.state.autoSwitchCompleted).length, 1);
  const restartedStore = new Store(f.store.root);
  const manager = new AutoSwitchManager(
    restartedStore,
    {
      snapshot: async () => ({
        ...f.desktop,
        activeProfileId: f.a.id,
        currentAccountUuid: f.a.desktop!.accountUuid,
        organizations: [f.a.desktop!.orgId],
      }),
      switchTo: async () => {
        assert.fail("completed episode must not dispatch");
      },
    },
    { snapshot: () => f.usage },
    { now: () => NOW + 10_001, platformSupported: true },
  );
  await manager.tick();
  assert.equal(manager.snapshot().reason, "already-switched");
});
test("a registry save failure does not falsely report or retry a completed Desktop switch", async (t) => {
  const f = await managerFixture(t);
  await f.settle();
  f.store.update = () => {
    throw new Error("fixture registry unavailable");
  };
  await f.manager.tick();
  assert.equal(f.manager.snapshot().status, "switched");
  assert.equal(f.manager.snapshot().reason, "ledger-unavailable");
  assert.equal(f.calls(), 1);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
});
test("settings, active identity and quota changes during snapshot prevent dispatch", async (t) => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof managerFixture>>) => {
      f.store.update((state) => {
        state.settings.autoSwitchMode = "off";
      });
    },
    (f: Awaited<ReturnType<typeof managerFixture>>) => {
      f.desktop.running = true;
    },
    (f: Awaited<ReturnType<typeof managerFixture>>) => {
      f.desktop.activeProfileId = f.b.id;
    },
    (f: Awaited<ReturnType<typeof managerFixture>>) => {
      f.usage[f.b.id].sevenDay!.usedPercent = 95;
    },
  ]) {
    const f = await managerFixture(t);
    await f.settle();
    f.setSnapshotHook(() => {
      if (f.snapshots() === 3) mutate(f);
    });
    await f.manager.tick();
    assert.equal(f.calls(), 0);
  }
});
test("policy changes after acquiring Desktop lock revoke per-write authorization", async (t) => {
  for (const disableMode of [false, true]) {
    const f = await managerFixture(t);
    await f.settle();
    f.setSwitchHook(async (options) => {
      f.store.update((state) => {
        if (disableMode) state.settings.autoSwitchMode = "off";
        else state.settings.autoSwitchAccounts = [f.a.id];
      });
      assert.equal(options.canProceed(), false);
      throw new Error("fixture authorization revoked");
    });
    await f.manager.tick();
    assert.equal(f.calls(), 1);
    assert.equal(f.manager.snapshot().status, disableMode ? "off" : "blocked");
  }
});
test("stopping the manager revokes a pending switch before writes", async (t) => {
  const f = await managerFixture(t);
  await f.settle();
  f.setSwitchHook(async (options) => {
    f.manager.stop();
    assert.equal(options.canProceed(), false);
    throw new Error("fixture manager stopped");
  });
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
});
test("overlapping ticks cannot dispatch overlapping switches", async (t) => {
  const f = await managerFixture(t);
  await f.settle();
  let resolve: () => void = () => {};
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  f.setSwitchHook(async () => {
    await gate;
  });
  const running = f.manager.tick();
  for (let i = 0; i < 10 && !f.calls(); i++) await Promise.resolve();
  assert.equal(f.calls(), 1);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  resolve();
  await running;
});
test("private-format errors back off and stop after three attempts in an episode", async (t) => {
  const f = await managerFixture(t);
  await f.settle();
  f.setSwitchHook(async () => {
    throw new Error("fixture invalid saved format");
  });
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.manager.snapshot().reason, "retry-backoff");
  for (let attempts = 2; attempts <= 3; attempts++) {
    f.advance(10 * 60_000);
    f.refresh();
    await f.manager.tick();
    assert.equal(f.calls(), attempts);
  }
  f.advance(10 * 60_000);
  f.refresh();
  await f.manager.tick();
  assert.equal(f.calls(), 3);
  assert.equal(f.manager.snapshot().reason, "switch-failed");
  assert.equal(f.manager.snapshot().retryAt, undefined);
});

async function closedDesktopFixture(t: any) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-closed-desktop-"),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "Claude"),
    store = new Store(path.join(temp, "Relay"));
  await fs.mkdir(root);
  const a = account("A"),
    b = account("B");
  store.update((state) => {
    state.accounts = [a, b];
  });
  for (const account of [a, b])
    await fs.mkdir(
      path.join(
        root,
        "claude-code-sessions",
        account.desktop!.accountUuid,
        account.desktop!.orgId,
      ),
      { recursive: true },
    );
  await writeBytes(
    root,
    "config.json",
    jsonBytes({
      lastKnownAccountUuid: a.desktop!.accountUuid,
      "oauth:tokenCacheV2": "fixture-A",
      preference: "keep",
    }),
  );
  await writeBytes(root, "Cookies", Buffer.from("fixture-cookie-A"));
  let running = false,
    starts = 0,
    quits = 0;
  const host: DesktopHost = {
    available: async () => true,
    running: async () => running,
    quit: async () => {
      quits++;
      throw new Error("must not quit");
    },
    launch: async () => {
      starts++;
      throw new Error("must not launch");
    },
    seal: (text) => Buffer.from(text),
    unseal: (bytes) => bytes.toString(),
  };
  const manager = new DesktopManager(root, store, host);
  await manager.initialize();
  await writeBytes(
    path.join(store.root, "desktop-vault"),
    `accounts/${b.desktop!.accountUuid}.bin`,
    host.seal(
      JSON.stringify({
        accountUuid: b.desktop!.accountUuid,
        auth: {
          lastKnownAccountUuid: b.desktop!.accountUuid,
          "oauth:tokenCacheV2": "fixture-B",
        },
        cookies: {
          Cookies: Buffer.from("fixture-cookie-B").toString("base64"),
        },
      }),
    ),
  );
  return {
    a,
    b,
    root,
    store,
    host,
    manager,
    setRunning: (value: boolean) => {
      running = value;
    },
    starts: () => starts,
    quits: () => quits,
  };
}
test("closed-only Desktop preparation switches fixture files without quitting or launching", async (t) => {
  const f = await closedDesktopFixture(t);
  await f.manager.switchTo(f.b.id, {
    closedOnly: true,
    expectedActiveProfileId: f.a.id,
    canProceed: () => true,
  });
  assert.equal(
    (await readObject(f.root, "config.json"))!.lastKnownAccountUuid,
    f.b.desktop!.accountUuid,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "Cookies"), "utf8"),
    "fixture-cookie-B",
  );
  assert.equal(f.starts(), 0);
  assert.equal(f.quits(), 0);
});
test("closed-only Desktop rejects running app, wrong active profile and revoked authorization", async (t) => {
  for (const mode of ["running", "wrong-profile", "revoked"] as const) {
    const f = await closedDesktopFixture(t);
    if (mode === "running") f.setRunning(true);
    await assert.rejects(
      f.manager.switchTo(f.b.id, {
        closedOnly: true,
        expectedActiveProfileId:
          mode === "wrong-profile" ? randomUUID() : f.a.id,
        canProceed: () => mode !== "revoked",
      }),
    );
    assert.equal(
      (await readObject(f.root, "config.json"))!.lastKnownAccountUuid,
      f.a.desktop!.accountUuid,
    );
    assert.equal(
      await fs.readFile(path.join(f.root, "Cookies"), "utf8"),
      "fixture-cookie-A",
    );
    assert.equal(f.starts(), 0);
    assert.equal(f.quits(), 0);
  }
});
test("an app starting before apply prevents automatic auth and history writes", async (t) => {
  const f = await closedDesktopFixture(t);
  let checks = 0;
  await assert.rejects(
    f.manager.switchTo(f.b.id, {
      closedOnly: true,
      expectedActiveProfileId: f.a.id,
      canProceed: () => {
        if (++checks === 3) f.setRunning(true);
        return true;
      },
    }),
  );
  assert.equal(
    (await readObject(f.root, "config.json"))!.lastKnownAccountUuid,
    f.a.desktop!.accountUuid,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "Cookies"), "utf8"),
    "fixture-cookie-A",
  );
  assert.equal(f.starts(), 0);
  assert.equal(f.quits(), 0);
});
test("history grant changes after planning revoke every source in the automatic transaction", async (t) => {
  for (const change of [
    "remove-source",
    "disable-history",
    "rebind-source",
    "change-source-group",
  ] as const) {
    const f = await closedDesktopFixture(t);
    const c = account("C", "work:third-source");
    f.store.update((state) => {
      state.accounts.push(c);
      state.settings = {
        ...DEFAULT_SETTINGS,
        autoSwitchMode: "after-exit",
        autoSwitchAccounts: [f.a.id, f.b.id],
        desktopHistoryTransfer: "selected",
        desktopHistoryAccounts: [f.a.id, f.b.id, c.id],
      };
    });
    const sessionId = randomUUID();
    const sessionFile = `local_${sessionId}.json`;
    const sourcePath = `claude-code-sessions/${c.desktop!.accountUuid}/${c.desktop!.orgId}/${sessionFile}`;
    const targetPath = `claude-code-sessions/${f.b.desktop!.accountUuid}/${f.b.desktop!.orgId}/${sessionFile}`;
    await writeBytes(
      f.root,
      sourcePath,
      jsonBytes({
        sessionId: `local_${sessionId}`,
        cliSessionId: sessionId,
        cwd: f.root,
        title: "Third-account private fixture",
        lastActivityAt: NOW,
      }),
    );
    const usage = { [f.a.id]: quota(f.a, 100), [f.b.id]: quota(f.b) };
    let now = NOW,
      revoked = false;
    const originalSeal = f.host.seal;
    f.host.seal = (value) => {
      const data = JSON.parse(value);
      if (data.files && !revoked) {
        // The encrypted backup is prepared after historyPlan has included C.
        assert.ok(targetPath in data.files);
        revoked = true;
        f.store.update((state) => {
          if (change === "remove-source")
            state.settings.desktopHistoryAccounts = [f.a.id, f.b.id];
          if (change === "disable-history")
            state.settings.desktopHistoryTransfer = "off";
          if (change === "rebind-source")
            state.accounts.find(
              (account) => account.id === c.id,
            )!.desktop!.orgId = randomUUID();
          if (change === "change-source-group")
            state.accounts.find((account) => account.id === c.id)!.group =
              "work:changed";
        });
      }
      return originalSeal(value);
    };
    const manager = new AutoSwitchManager(
      f.store,
      f.manager,
      { snapshot: () => usage },
      { now: () => now, platformSupported: true },
    );
    await manager.tick();
    now += 10_001;
    await manager.tick();
    assert.equal(revoked, true);
    assert.equal(manager.snapshot().status, "blocked");
    assert.equal(
      (await readObject(f.root, "config.json"))!.lastKnownAccountUuid,
      f.a.desktop!.accountUuid,
    );
    assert.equal(await readObject(f.root, targetPath), null);
    assert.equal(
      (await readObject(f.root, sourcePath))!.title,
      "Third-account private fixture",
    );
    assert.equal((await f.manager.snapshot()).recoveryRequired, false);
    assert.equal(f.starts(), 0);
    assert.equal(f.quits(), 0);
  }
});

test("the target is the soonest reset that holds half an hour at the tempo", async (t) => {
  const f = scenario();
  const c = account("C");
  f.b.planning = { plan: "max5", capacityWeight: 5 };
  c.planning = { plan: "pro", capacityWeight: 1 };
  f.settings.autoSwitchAccounts.push(c.id);
  // B: 80% of a Max 5× window (400 Pro units) until its reset in an hour.
  // C: 50 Pro units until its reset in 30 minutes; the old lowest-use rule
  // picked B.
  f.usage[f.b.id] = quota(f.b, 20, 20);
  f.usage[c.id] = {
    ...quota(c, 50, 20),
    fiveHour: {
      usedPercent: 50,
      resetsAt: new Date(NOW + 30 * 60_000).toISOString(),
    },
  };
  const decide = (rate?: number) =>
    autoSwitchDecision(
      f.settings,
      [f.a, f.b, c],
      f.desktop,
      f.usage,
      NOW,
      false,
      true,
      rate,
    ).state.targetId;
  assert.equal(decide(), c.id);
  // 50 Pro units cover half an hour at 60/h, not at 200/h.
  assert.equal(decide(60), c.id);
  assert.equal(decide(200), f.b.id);
  // The manager reads the rate from its dependency on every decision.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auto-switch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.update((state) => {
    state.accounts = [f.a, f.b, c];
    state.settings = f.settings;
  });
  f.desktop.running = true;
  let rate: number | undefined;
  const manager = new AutoSwitchManager(
    store,
    {
      snapshot: async () => structuredClone(f.desktop),
      switchTo: async () => assert.fail("Claude is still running"),
    },
    { snapshot: () => f.usage },
    { now: () => NOW, platformSupported: true, tempoRate: () => rate },
  );
  await manager.tick();
  assert.equal(manager.snapshot().reason, "claude-running");
  assert.equal(manager.snapshot().targetId, c.id);
  rate = 200;
  await manager.tick();
  assert.equal(manager.snapshot().targetId, f.b.id);
});
