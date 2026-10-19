import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import {
  DESKTOP_CACHE_MS,
  DesktopManager,
  DesktopSwitchRefused,
  type DesktopHost,
} from "../electron/core/desktop";
import type { DesktopRestartEvent } from "../shared/types";
import { localizeError } from "../src/messages";
import type { DraftJob, DraftResult } from "../electron/draft-job";
import {
  CONVERSATION_DRAFT_PREFIX,
  NEW_SESSION_DRAFT,
} from "../electron/core/drafts";
import {
  duplicateSessions,
  readObject,
  writeBytes,
  jsonBytes,
  planHistory,
  safeFile,
} from "../electron/core/desktop-files";
async function fixture(t: any) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-core-"));
  const root = path.join(temp, "Claude");
  await fs.mkdir(root);
  const store = new Store(path.join(temp, "Relay"));
  let running = false,
    starts = 0,
    quits = 0,
    failQuit = false;
  const host: DesktopHost = {
    available: async () => true,
    running: async () => running,
    quit: async () => {
      quits++;
      if (failQuit) throw new Error("still running");
      running = false;
    },
    launch: async () => {
      running = true;
      starts++;
    },
    seal: (s) =>
      Buffer.from("TEST-ENCRYPTED:" + Buffer.from(s).toString("base64")),
    unseal: (b) => Buffer.from(b.toString().slice(15), "base64").toString(),
    // Swept at startup: never the real os.tmpdir().
    draftScratchDir: path.join(temp, "tmp"),
  };
  const transcriptRoot = path.join(temp, ".claude");
  const manager = new DesktopManager(root, store, host, transcriptRoot);
  await manager.initialize();
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  async function account(name: string, group?: string) {
    const a = store.create({ name, kind: group ? "work" : "personal", group });
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
    await fs.mkdir(
      path.join(root, "claude-code-sessions", accountUuid, orgId),
      { recursive: true },
    );
    await writeBytes(root, "Cookies", Buffer.from(`cookie-${name}`));
    await manager.capture(a.id, orgId);
    return store.account(a.id);
  }
  return {
    temp,
    root,
    transcriptRoot,
    store,
    host,
    manager,
    account,
    setFailQuit: () => {
      failQuit = true;
    },
    setRunning: (value: boolean) => {
      running = value;
    },
    starts: () => starts,
    quits: () => quits,
  };
}
async function session(root: string, a: any, id = randomUUID(), extra = {}) {
  const relative = `claude-code-sessions/${a.desktop.accountUuid}/${a.desktop.orgId}/local_${id}.json`;
  await writeBytes(
    root,
    relative,
    jsonBytes({
      sessionId: `local_${id}`,
      cliSessionId: id,
      cwd: root,
      title: "Fixture",
      lastActivityAt: 42,
      remoteMcpServersConfig: ["source-secret"],
      alwaysAllowedReasons: ["grant"],
      permissionMode: "bypassPermissions",
      ...extra,
    }),
  );
  return { id, relative };
}
test("Claude's uptime comes from the host, and is unknown without one", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.manager.claudeUptimeMs(), undefined);
  f.host.claudeUptimeMs = async () => 21_000;
  assert.equal(await f.manager.claudeUptimeMs(), 21_000);
  f.host.claudeUptimeMs = async () => undefined;
  assert.equal(await f.manager.claudeUptimeMs(), undefined);
});
test("every switch tells onSwitched once it ends, after Desktop is free, even when it fails", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // B is open in Claude
  const busyWhenTold: boolean[] = [];
  f.manager.onSwitched = () => busyWhenTold.push(f.manager.isBusy);
  await f.manager.switchTo(a.id);
  assert.deepEqual(busyWhenTold, [false]);
  // A closed-only switch, as automatic switching makes it.
  f.setRunning(false);
  await f.manager.switchTo(b.id, {
    closedOnly: true,
    expectedActiveProfileId: a.id,
  });
  assert.deepEqual(busyWhenTold, [false, false]);
  // A switch that fails late may still have changed the account: it is told too.
  f.setRunning(true);
  await assert.rejects(
    f.manager.switchTo(a.id, { canProceed: () => false }),
    /cancelled before restart/,
  );
  assert.deepEqual(busyWhenTold, [false, false, false]);
  // A listener that throws never changes how a switch ends.
  f.manager.onSwitched = () => {
    throw new Error("listener");
  };
  await f.manager.switchTo(a.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  await assert.rejects(
    f.manager.switchTo(b.id, { canProceed: () => false }),
    /cancelled before restart/,
  );
});
test("onSwitchedTo names the account after a restarting or a closed-only switch, never after a failed one", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // B is open in Claude
  const told: { id: string; busy: boolean; relaunched: boolean }[] = [];
  f.manager.onSwitchedTo = (id) =>
    told.push({ id, busy: f.manager.isBusy, relaunched: f.starts() > 0 });
  // A restarting switch: the menu bar, the panel, the Accounts page and continue at quota.
  await f.manager.switchTo(a.id);
  assert.deepEqual(told, [{ id: a.id, busy: false, relaunched: true }]);
  // A closed-only switch, as the switch after Claude quits makes it.
  f.setRunning(false);
  await f.manager.switchTo(b.id, {
    closedOnly: true,
    expectedActiveProfileId: a.id,
  });
  assert.deepEqual(
    told.map((x) => x.id),
    [a.id, b.id],
  );
  // A failed switch tells nothing.
  f.setRunning(true);
  await assert.rejects(
    f.manager.switchTo(a.id, { canProceed: () => false }),
    /cancelled before restart/,
  );
  assert.equal(told.length, 2);
  // A listener that throws never changes how a switch ends.
  f.manager.onSwitchedTo = () => {
    throw new Error("listener");
  };
  await f.manager.switchTo(a.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
});
test("a changed continuation guard blocks restart before Claude is asked to quit", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  await f.manager.switchTo(a.id);
  f.setRunning(true);
  const quits = f.quits();
  await assert.rejects(
    f.manager.switchTo(b.id, { canProceed: () => false }),
    (error) =>
      error instanceof DesktopSwitchRefused &&
      /cancelled before restart/.test(error.message),
  );
  // A `beforeQuit` refusal reaches the caller as it was thrown.
  const refusal = new DesktopSwitchRefused("work-started");
  await assert.rejects(
    f.manager.switchTo(b.id, {
      canProceed: () => true,
      beforeQuit: async () => {
        throw refusal;
      },
    }),
    (error) => error === refusal,
  );
  assert.equal(f.quits(), quits);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  assert.equal((await f.manager.snapshot()).running, true);
  // A guard that refuses only after the quit is an ordinary failure, not a refusal.
  let checks = 0;
  await assert.rejects(
    f.manager.switchTo(b.id, { canProceed: () => ++checks <= 2 }),
    (error) =>
      error instanceof Error &&
      !(error instanceof DesktopSwitchRefused) &&
      /conditions changed/.test(error.message),
  );
  assert.equal(f.quits(), quits + 1);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
});
test("only Desktop's own refusal shows as its error; a beforeQuit refusal is the caller's to tell", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  await f.manager.switchTo(a.id);
  f.setRunning(true);
  const quits = f.quits();
  // Auto-switch and a single continuation give no other reason than this sentence.
  await assert.rejects(
    f.manager.switchTo(b.id, { canProceed: () => false }),
    DesktopSwitchRefused,
  );
  const cancelled = (await f.manager.snapshot()).error;
  assert.equal(cancelled, "Automatic Desktop switch was cancelled before restart.");
  assert.notEqual(localizeError(cancelled!, "en"), cancelled);
  // The fleet waits and says so itself: no raw "work-started" banner, and the old one is gone.
  await assert.rejects(
    f.manager.switchTo(b.id, {
      canProceed: () => true,
      beforeQuit: async () => {
        throw new DesktopSwitchRefused("work-started");
      },
    }),
    DesktopSwitchRefused,
  );
  assert.equal((await f.manager.snapshot()).error, undefined);
  // A caller's check that fails rather than refuses is still Desktop's error.
  await assert.rejects(
    f.manager.switchTo(b.id, {
      canProceed: () => true,
      beforeQuit: async () => {
        throw new Error("The process list could not be read.");
      },
    }),
    (error) => !(error instanceof DesktopSwitchRefused),
  );
  assert.equal(
    (await f.manager.snapshot()).error,
    "The process list could not be read.",
  );
  assert.equal(f.quits(), quits);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
});
test("real Desktop file switch A → B → A preserves config, cookies, history and refreshes saved credentials", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const s = await session(f.root, a);
  const b = await f.account("B");
  await f.manager.switchTo(a.id);
  assert.equal(
    (await readObject(f.root, "config.json"))!.lastKnownAccountUuid,
    a.desktop!.accountUuid,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "Cookies"), "utf8"),
    "cookie-A",
  );
  await writeBytes(
    f.root,
    "config.json",
    jsonBytes({
      ...(await readObject(f.root, "config.json")),
      "oauth:tokenCacheV2": "refreshed-A",
    }),
  );
  await f.manager.switchTo(b.id);
  assert.equal(
    await fs.readFile(path.join(f.root, "Cookies"), "utf8"),
    "cookie-B",
  );
  const transferred = await readObject(
    f.root,
    `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}/local_${s.id}.json`,
  );
  assert.equal(transferred!.permissionMode, "default");
  assert.deepEqual(transferred!.remoteMcpServersConfig, []);
  assert.equal(
    (await readObject(f.root, s.relative))!.permissionMode,
    "bypassPermissions",
  );
  await f.manager.switchTo(a.id);
  assert.equal(
    (await readObject(f.root, "config.json"))!["oauth:tokenCacheV2"],
    "refreshed-A",
  );
  assert.equal(
    (await readObject(f.root, "config.json"))!.preference,
    "preserved",
  );
  assert((await f.manager.snapshot()).lastBackup);
});
test("Desktop sign-in is idempotent; cancelling restores previous account even after a new sign-in", async (t) => {
  const f = await fixture(t),
    a = await f.account("A");
  const b = f.store.create({ name: "B", kind: "personal" });
  await f.manager.beginLogin(b.id);
  await f.manager.beginLogin(b.id);
  assert.equal((await f.manager.snapshot()).pendingProfileId, b.id);
  await assert.rejects(
    f.manager.capture(a.id, a.desktop!.orgId),
    /Finish or cancel/,
  );
  assert.equal(
    (await readObject(f.root, "config.json"))!.lastKnownAccountUuid,
    undefined,
  );
  await assert.rejects(f.manager.switchTo(a.id), /Finish or cancel/);
  await writeBytes(
    f.root,
    "config.json",
    jsonBytes({
      "oauth:tokenCacheV2": "new-encrypted",
      lastKnownAccountUuid: randomUUID(),
    }),
  );
  await f.manager.cancelLogin();
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  assert.equal((await f.manager.snapshot()).pendingProfileId, undefined);
});
test("work histories cross only the selected sharing group, tombstones prevent resurrection", async (t) => {
  const f = await fixture(t);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "same-group";
  });
  const a = await f.account("A", "team"),
    b = await f.account("B", "team"),
    c = await f.account("C", "other");
  const s = await session(f.root, a);
  await f.manager.switchTo(c.id);
  assert.equal(
    await readObject(
      f.root,
      `claude-code-sessions/${c.desktop!.accountUuid}/${c.desktop!.orgId}/local_${s.id}.json`,
    ),
    null,
  );
  await f.manager.switchTo(b.id);
  const dest = `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}`;
  assert(await readObject(f.root, `${dest}/local_${s.id}.json`));
  await fs.rm(path.join(f.root, dest, `local_${s.id}.json`));
  await writeBytes(f.root, `${dest}/deleted_${s.id}`, Buffer.from(""));
  await f.manager.switchTo(a.id);
  await f.manager.switchTo(b.id);
  assert.equal(await readObject(f.root, `${dest}/local_${s.id}.json`), null);
});
test("unknown account and live process guards leave Desktop sign-in untouched", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const cfg = {
    "oauth:tokenCacheV2": "unknown",
    lastKnownAccountUuid: randomUUID(),
  };
  await writeBytes(f.root, "config.json", jsonBytes(cfg));
  await assert.rejects(f.manager.switchTo(a.id), /Save the current/);
  assert.deepEqual(await readObject(f.root, "config.json"), cfg);
  await writeBytes(
    f.root,
    "config.json",
    jsonBytes({
      ...cfg,
      lastKnownAccountUuid: a.desktop!.accountUuid,
    }),
  );
  const beforeQuit = await readObject(f.root, "config.json");
  f.setFailQuit();
  await assert.rejects(f.manager.switchTo(a.id), /still running/);
  assert.deepEqual(await readObject(f.root, "config.json"), beforeQuit);
});
test("failed multi-file switch rolls back and crash journal offers recovery", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const before = await fs.readFile(path.join(f.root, "config.json"));
  // Inject a one-time disk failure after config replacement, during cookie cleanup.
  const originalRm = fs.rm;
  let failed = false;
  fs.rm = (async (p: any, ...args: any[]) => {
    if (!failed && p === path.join(f.root, "Cookies-journal")) {
      failed = true;
      throw new Error("disk failure");
    }
    return (originalRm as any)(p, ...args);
  }) as any;
  try {
    await assert.rejects(f.manager.switchTo(a.id), /disk failure/);
  } finally {
    fs.rm = originalRm;
  }
  assert.equal(
    (await fs.readFile(path.join(f.root, "config.json"))).toString(),
    before.toString(),
  );
  assert.equal((await f.manager.snapshot()).recoveryRequired, false);
  assert.equal(
    await fs.readFile(path.join(f.root, "Cookies"), "utf8"),
    "cookie-B",
  );
  const vault = path.join(f.store.root, "desktop-vault"),
    backup = randomUUID();
  await writeBytes(
    vault,
    `backups/${backup}.bin`,
    f.host.seal(
      JSON.stringify({
        files: { "config.json": before.toString("base64") },
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  await writeBytes(vault, "journal.json", jsonBytes({ backup }));
  await writeBytes(f.root, "config.json", jsonBytes({ broken: true }));
  assert.equal((await f.manager.snapshot()).recoveryRequired, true);
  await assert.rejects(f.manager.switchTo(b.id), /Restore/);
  const restarts: DesktopRestartEvent[] = [];
  f.manager.onRestart = (event) => void restarts.push(event);
  await f.manager.recover();
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.deepEqual(restarts, [
    { phase: "start", kind: "restore" },
    { phase: "end", kind: "restore", ok: true },
  ]);
});
test("project merge preserves target organization bindings and rejects symlink paths", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const src = `local-agent-mode-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}/spaces.json`;
  await writeBytes(
    f.root,
    src,
    jsonBytes({
      spaces: [
        {
          id: "one",
          name: "Work",
          folders: [f.root],
          projects: ["private-remote"],
          migration: { org: "private" },
        },
      ],
    }),
  );
  const plan = await planHistory(f.root, b.desktop!, [a.desktop!]);
  const copied = JSON.parse([...plan.values()][0]!.toString());
  assert.equal(copied.spaces[0].projects, undefined);
  assert.equal(copied.spaces[0].migration, undefined);
  await fs.symlink(
    f.temp,
    path.join(f.root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(safeFile(f.root, "escape/file"), /symbolic links/);
  await assert.rejects(safeFile(f.root, "../outside"), /Invalid/);
});
test("50 profiles and 64-character company groups persist without overflow or merging unrelated accounts", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 50; i++)
    f.store.create({
      name: `Account ${i}`,
      kind: "work",
      group: i % 2 ? "x".repeat(64) : undefined,
    });
  const restored = new Store(f.store.root);
  assert.equal(restored.state.accounts.length, 50);
  assert.equal(new Set(restored.state.accounts.map((a) => a.group)).size, 26);
  assert.throws(() => f.store.create({ name: "51", kind: "personal" }), /50/);
});

test("reconnecting an existing Desktop profile keeps its identity and refuses a different account", async (t) => {
  const f = await fixture(t),
    a = await f.account("A");
  await f.manager.beginLogin(a.id);
  assert.equal((await f.manager.snapshot()).pendingProfileId, a.id);
  await writeBytes(
    f.root,
    "config.json",
    jsonBytes({
      "oauth:tokenCacheV2": "refreshed",
      lastKnownAccountUuid: a.desktop!.accountUuid,
    }),
  );
  await f.manager.capture(a.id, a.desktop!.orgId);
  assert.equal((await f.manager.snapshot()).pendingProfileId, undefined);
  await f.manager.beginLogin(a.id);
  const other = randomUUID();
  await writeBytes(
    f.root,
    "config.json",
    jsonBytes({ "oauth:tokenCacheV2": "other", lastKnownAccountUuid: other }),
  );
  await fs.mkdir(
    path.join(f.root, "claude-code-sessions", other, a.desktop!.orgId),
    { recursive: true },
  );
  await assert.rejects(
    f.manager.capture(a.id, a.desktop!.orgId),
    /another Desktop account/,
  );
  await f.manager.cancelLogin();
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
});
test("an unreadable history record is skipped and left untouched instead of blocking every switch", async (t) => {
  const f = await fixture(t),
    a = await f.account("A"),
    b = await f.account("B");
  const id = randomUUID();
  const broken = `claude-code-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}/local_${id}.json`;
  await writeBytes(f.root, broken, Buffer.from("{incomplete"));
  const good = await session(f.root, a);
  await f.manager.switchTo(a.id);
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(
    (await fs.readFile(path.join(f.root, broken))).toString(),
    "{incomplete",
  );
  const dest = `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}`;
  assert.equal(await readObject(f.root, `${dest}/local_${id}.json`), null);
  assert(await readObject(f.root, `${dest}/local_${good.id}.json`));
});

test("dismissed Desktop errors stay dismissed across polls; a new attempt remains visible", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  f.setFailQuit();
  await assert.rejects(f.manager.beginLogin(a.id), /still running/);
  const first = await f.manager.snapshot();
  assert.equal(first.error, "still running");
  f.manager.dismissError(first.errorRevision);
  for (let i = 0; i < 3; i++)
    assert.equal((await f.manager.snapshot()).error, undefined);
  await assert.rejects(f.manager.beginLogin(a.id), /still running/);
  const second = await f.manager.snapshot();
  assert.equal(second.error, "still running");
  assert(second.errorRevision > first.errorRevision);
  f.manager.dismissError(first.errorRevision);
  assert.equal((await f.manager.snapshot()).error, "still running");
  f.manager.dismissError(second.errorRevision);
  assert.equal((await f.manager.snapshot()).error, undefined);
});

test("repeated capture of an already connected profile does not restart Claude or rewrite its vault", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const file = path.join(
    f.store.root,
    "desktop-vault/accounts",
    a.desktop!.accountUuid + ".bin",
  );
  const before = await fs.readFile(file);
  const starts = f.starts();
  f.setFailQuit();
  await f.manager.capture(a.id, a.desktop!.orgId);
  assert.equal(f.starts(), starts);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await f.manager.snapshot()).error, undefined);
});

test("known CLI account and organization mismatches block capture before Claude quits", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = f.store.create({ name: "B", kind: "personal" });
  const before = await fs.readFile(path.join(f.root, "config.json"));
  const quits = f.quits();
  const starts = f.starts();
  f.store.update((s) => {
    s.accounts.find((x) => x.id === b.id)!.auth = {
      loggedIn: true,
      accountUuid: randomUUID(),
      email: "same@example.test",
      orgId: a.desktop!.orgId,
      checkedAt: new Date().toISOString(),
    };
  });
  await assert.rejects(
    f.manager.capture(b.id, a.desktop!.orgId),
    /different Claude account/,
  );
  f.store.update((s) => {
    s.accounts.find((x) => x.id === b.id)!.auth!.accountUuid =
      a.desktop!.accountUuid;
    s.accounts.find((x) => x.id === b.id)!.auth!.orgId = randomUUID();
  });
  await assert.rejects(
    f.manager.capture(b.id, a.desktop!.orgId),
    /different Claude organization/,
  );
  assert.equal(f.quits(), quits);
  assert.equal(f.starts(), starts);
  assert.deepEqual(await fs.readFile(path.join(f.root, "config.json")), before);
  assert.equal(f.store.account(b.id).desktop, undefined);
});

test("wrong CLI reconnect identity cannot replace or switch a saved Desktop association", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const before = await fs.readFile(path.join(f.root, "config.json"));
  const quits = f.quits();
  f.store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      accountUuid: randomUUID(),
      orgId: a.desktop!.orgId,
      email: "different@example.test",
      checkedAt: new Date().toISOString(),
    };
  });
  await assert.rejects(f.manager.beginLogin(a.id), /different Claude account/);
  await assert.rejects(f.manager.switchTo(a.id), /different Claude account/);
  assert.equal(f.quits(), quits);
  assert.deepEqual(f.store.account(a.id).desktop, a.desktop);
  assert.deepEqual(await fs.readFile(path.join(f.root, "config.json")), before);
  assert.equal((await f.manager.snapshot()).pendingProfileId, undefined);
});

test("matching verified CLI identity supplies a readable email to a saved Desktop profile", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  f.store.update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      accountUuid: a.desktop!.accountUuid,
      orgId: a.desktop!.orgId,
      email: "matched@example.test",
      checkedAt: new Date().toISOString(),
    };
  });
  await f.manager.beginLogin(a.id);
  await writeBytes(
    f.root,
    "config.json",
    jsonBytes({
      "oauth:tokenCacheV2": "refreshed-fixture",
      lastKnownAccountUuid: a.desktop!.accountUuid,
    }),
  );
  await f.manager.capture(a.id, a.desktop!.orgId);
  assert.equal(f.store.account(a.id).desktop?.email, "matched@example.test");
  assert.equal(
    new Store(f.store.root).account(a.id).desktop?.email,
    "matched@example.test",
  );
});

test("Desktop operations acquire their lock before availability checks yield", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = f.store.create({ name: "B", kind: "personal" });
  let release!: (value: boolean) => void;
  const available = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  f.host.available = () => available;
  const first = f.manager.beginLogin(b.id);
  await assert.rejects(
    f.manager.capture(a.id, a.desktop!.orgId),
    /operation is already in progress/,
  );
  release(true);
  await first;
  assert.equal((await f.manager.snapshot()).pendingProfileId, b.id);
});

test("every Desktop operation that marks Desktop busy is counted, failed ones too", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  const start = f.manager.operations;
  await f.manager.switchTo(a.id);
  assert.equal(f.manager.operations, start + 1);
  await assert.rejects(f.manager.switchTo(b.id, { canProceed: () => false }));
  assert.equal(f.manager.operations, start + 2);
  // An operation refused because another is running never marked Desktop busy.
  let release!: (value: boolean) => void;
  f.host.available = () => new Promise<boolean>((resolve) => (release = resolve));
  const first = f.manager.switchTo(b.id);
  await assert.rejects(f.manager.switchTo(a.id), /operation is already in progress/);
  release(true);
  await first;
  assert.equal(f.manager.operations, start + 3);
});

test("an unknown current Desktop account is rejected before any restart", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = f.store.create({ name: "B", kind: "personal" });
  await writeBytes(
    f.root,
    "config.json",
    jsonBytes({
      "oauth:tokenCacheV2": "unknown-fixture",
      lastKnownAccountUuid: randomUUID(),
    }),
  );
  const quits = f.quits();
  await assert.rejects(
    f.manager.beginLogin(b.id),
    /Save the current Desktop account/,
  );
  await assert.rejects(
    f.manager.switchTo(a.id),
    /Save the current Desktop account/,
  );
  assert.equal(f.quits(), quits);
});

test("Desktop does not report a profile active when its saved Code organization is missing", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await fs.rm(
    path.join(
      f.root,
      "claude-code-sessions",
      a.desktop!.accountUuid,
      a.desktop!.orgId,
    ),
    { recursive: true },
  );
  const snapshot = await f.manager.snapshot();
  assert.equal(snapshot.currentAccountUuid, a.desktop!.accountUuid);
  assert.equal(snapshot.activeProfileId, undefined);
});

test("dismissal does not clear recovery requirements or repeatedly report the same unreadable data", async (t) => {
  const f = await fixture(t);
  await writeBytes(f.root, "config.json", Buffer.from("invalid JSON"));
  const first = await f.manager.snapshot();
  assert(first.error);
  f.manager.dismissError(first.errorRevision);
  assert.equal((await f.manager.snapshot()).error, undefined);
  await writeBytes(f.root, "config.json", jsonBytes({}));
  await f.manager.snapshot();
  await writeBytes(f.root, "config.json", Buffer.from("invalid JSON"));
  assert((await f.manager.snapshot()).error);
  await writeBytes(
    path.join(f.store.root, "desktop-vault"),
    "journal.json",
    jsonBytes({ backup: randomUUID() }),
  );
  const recovery = await f.manager.snapshot();
  f.manager.dismissError(recovery.errorRevision);
  assert.equal((await f.manager.snapshot()).recoveryRequired, true);
});

test("history transfer off leaves each account's session index intact on capture and switch", async (t) => {
  const f = await fixture(t);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "off";
  });
  const a = await f.account("A"),
    sa = await session(f.root, a);
  const b = await f.account("B"),
    sb = await session(f.root, b);
  const aBefore = await fs.readFile(path.join(f.root, sa.relative));
  const bBefore = await fs.readFile(path.join(f.root, sb.relative));
  const bCopy = `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}/local_${sa.id}.json`;
  assert.equal(await readObject(f.root, bCopy), null);
  await f.manager.switchTo(a.id);
  await f.manager.switchTo(b.id);
  assert.equal(await readObject(f.root, bCopy), null);
  assert.deepEqual(await fs.readFile(path.join(f.root, sa.relative)), aBefore);
  assert.deepEqual(await fs.readFile(path.join(f.root, sb.relative)), bBefore);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "same-group";
  });
  await f.manager.switchTo(a.id);
  await f.manager.switchTo(b.id);
  assert.ok(await readObject(f.root, bCopy));
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "off";
  });
  await f.manager.switchTo(a.id);
  await f.manager.switchTo(b.id);
  assert.ok(
    await readObject(f.root, bCopy),
    "disabling transfer must not delete previously merged history",
  );
});

test("explicitly selected accounts share Code history across organizations while unselected histories and transcripts stay untouched", async (t) => {
  const f = await fixture(t);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "off";
  });
  const personal = await f.account("Personal"),
    work = await f.account("Work", "company-one"),
    otherWork = await f.account("Other work", "company-two"),
    excluded = await f.account("Excluded", "company-three");
  const cwd = path.join(f.temp, "shared_project");
  const prior = randomUUID();
  const p = await session(f.root, personal, undefined, {
    cwd,
    originCwd: cwd,
    priorCliSessionIds: [prior],
    archived: true,
  });
  const w = await session(f.root, work, undefined, { cwd });
  const o = await session(f.root, otherWork, undefined, { cwd });
  const x = await session(f.root, excluded, undefined, { cwd });
  const sourceBefore = await fs.readFile(path.join(f.root, p.relative));
  const slug = cwd.replace(/[/_.]/g, "-");
  const transcript = `projects/${slug}/${p.id}.jsonl`;
  const agentTranscript = `projects/${slug}/${p.id}/subagents/agent-fixture.jsonl`;
  const transcriptBytes = Buffer.from(
    '{"type":"user","message":"fixture conversation"}\n',
  );
  const agentBytes = Buffer.from(
    '{"type":"assistant","message":"fixture subagent"}\n',
  );
  await writeBytes(f.transcriptRoot, transcript, transcriptBytes);
  await writeBytes(f.transcriptRoot, agentTranscript, agentBytes);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "selected";
    s.settings.desktopHistoryAccounts = [personal.id, work.id, otherWork.id];
  });
  await f.manager.switchTo(work.id);
  const workDir = `claude-code-sessions/${work.desktop!.accountUuid}/${work.desktop!.orgId}`;
  const copy = await readObject(f.root, `${workDir}/local_${p.id}.json`);
  assert.equal(copy!.cliSessionId, p.id);
  assert.deepEqual(copy!.priorCliSessionIds, [prior]);
  assert.equal(copy!.archived, true);
  assert.ok(await readObject(f.root, `${workDir}/local_${o.id}.json`));
  assert.equal(await readObject(f.root, `${workDir}/local_${x.id}.json`), null);
  await f.manager.switchTo(personal.id);
  const personalDir = `claude-code-sessions/${personal.desktop!.accountUuid}/${personal.desktop!.orgId}`;
  assert.ok(await readObject(f.root, `${personalDir}/local_${w.id}.json`));
  assert.ok(await readObject(f.root, `${personalDir}/local_${o.id}.json`));
  assert.equal(
    await readObject(f.root, `${personalDir}/local_${x.id}.json`),
    null,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.root, p.relative)),
    sourceBefore,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.transcriptRoot, transcript)),
    transcriptBytes,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.transcriptRoot, agentTranscript)),
    agentBytes,
  );
  await f.manager.switchTo(excluded.id);
  const excludedDir = `claude-code-sessions/${excluded.desktop!.accountUuid}/${excluded.desktop!.orgId}`;
  assert.equal(
    await readObject(f.root, `${excludedDir}/local_${p.id}.json`),
    null,
  );
});

test("newer shared project records refresh local folders and names while preserving destination server bindings", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const relative = (account: typeof a) =>
    `local-agent-mode-sessions/${account.desktop!.accountUuid}/${account.desktop!.orgId}/spaces.json`;
  await writeBytes(
    f.root,
    relative(a),
    jsonBytes({
      spaces: [
        {
          id: "shared-space",
          name: "New name",
          folders: [path.join(f.temp, "new")],
          updatedAt: 200,
          projects: ["source-server-project"],
          migration: { organization: "source" },
        },
      ],
    }),
  );
  await writeBytes(
    f.root,
    relative(b),
    jsonBytes({
      retained: "target",
      spaces: [
        {
          id: "shared-space",
          name: "Old name",
          folders: [path.join(f.temp, "old")],
          updatedAt: 100,
          projects: ["target-server-project"],
          migration: { organization: "target" },
        },
      ],
    }),
  );
  const before = await fs.readFile(path.join(f.root, relative(b)));
  const plan = await planHistory(f.root, b.desktop!, [a.desktop!]);
  const updated = JSON.parse(plan.get(relative(b))!.toString());
  assert.equal(updated.spaces.length, 1);
  assert.equal(updated.spaces[0].name, "New name");
  assert.deepEqual(updated.spaces[0].folders, [path.join(f.temp, "new")]);
  assert.deepEqual(updated.spaces[0].projects, ["target-server-project"]);
  assert.deepEqual(updated.spaces[0].migration, { organization: "target" });
  assert.equal(updated.retained, "target");
  assert.deepEqual(
    await fs.readFile(path.join(f.root, relative(b))),
    before,
    "planning must not write Desktop files",
  );
});

test("a project deleted in its destination is not resurrected on a later account switch", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "selected";
    s.settings.desktopHistoryAccounts = [a.id, b.id];
  });
  const relative = (account: typeof a) =>
    `local-agent-mode-sessions/${account.desktop!.accountUuid}/${account.desktop!.orgId}/spaces.json`;
  await writeBytes(
    f.root,
    relative(a),
    jsonBytes({
      spaces: [
        { id: "shared", name: "Project", folders: [f.root], updatedAt: 100 },
      ],
    }),
  );
  await f.manager.syncHistory(b.id);
  assert.equal((await readObject(f.root, relative(b)))!.spaces.length, 1);
  await writeBytes(f.root, relative(b), jsonBytes({ spaces: [] }));
  await f.manager.switchTo(a.id);
  await f.manager.switchTo(b.id);
  assert.deepEqual((await readObject(f.root, relative(b)))!.spaces, []);
  assert.equal(
    (await readObject(f.root, relative(a)))!.spaces.length,
    1,
    "destination deletion must not remove the source project",
  );
  const seen = await readObject(
    path.join(f.store.root, "desktop-vault"),
    "history-seen.json",
  );
  assert.deepEqual(seen![`${b.desktop!.accountUuid}/${b.desktop!.orgId}`], [
    "shared",
  ]);
});

test("newest conversation lineage keeps destination archive and permission choices and removes copied stale errors", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const id = randomUUID(),
    latestCliId = randomUUID(),
    prior = randomUUID();
  await session(f.root, a, id, {
    cliSessionId: latestCliId,
    priorCliSessionIds: [prior],
    lastActivityAt: 200,
    archived: false,
    pinned: false,
    error: "stale quota",
    errorAt: 100,
    priorErrorMark: "old",
    chromePermissionMode: "allow_all",
    promptAppendSnapshot: "source instructions",
  });
  await session(f.root, b, id, {
    lastActivityAt: 100,
    archived: true,
    pinned: true,
    lastFocusedAt: 90,
    permissionMode: "acceptEdits",
    chromePermissionMode: "always_ask",
  });
  const newRecord = await session(f.root, a);
  const plan = await planHistory(f.root, b.desktop!, [a.desktop!]);
  const destDir = `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}`;
  const updated = JSON.parse(
    plan.get(`${destDir}/local_${id}.json`)!.toString(),
  );
  assert.equal(updated.cliSessionId, latestCliId);
  assert.deepEqual(updated.priorCliSessionIds, [prior]);
  assert.equal(updated.archived, true);
  assert.equal(updated.pinned, true);
  assert.equal(updated.lastFocusedAt, 90);
  assert.equal(updated.permissionMode, "acceptEdits");
  assert.equal(updated.chromePermissionMode, "always_ask");
  for (const key of [
    "error",
    "errorAt",
    "priorErrorMark",
    "promptAppendSnapshot",
  ])
    assert.equal(key in updated, false);
  const copied = JSON.parse(
    plan.get(`${destDir}/local_${newRecord.id}.json`)!.toString(),
  );
  assert.equal(copied.chromePermissionMode, "always_ask");
});

test("history summary checks shared transcript presence without treating an index or unknown path encoding as resumability", async (t) => {
  const f = await fixture(t),
    a = await f.account("A");
  const cwd = path.join(f.temp, "actual_project"),
    originCwd = path.join(f.temp, "original_project");
  const found = await session(f.root, a, undefined, {
    cwd,
    originCwd,
    archived: true,
  });
  await session(f.root, a, undefined, { cwd });
  await session(f.root, a, undefined, {
    cwd,
    cliSessionId: "unknown-version-id",
  });
  await session(f.root, a, undefined, { cwd: path.join(f.temp, "şirket") });
  const deleted = await session(f.root, a, undefined, { cwd });
  const dir = `claude-code-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}`;
  await writeBytes(
    f.root,
    `${dir}/deleted_${deleted.id.toUpperCase()}`,
    Buffer.from(""),
  );
  const transcript = `projects/${cwd.replace(/[/_.]/g, "-")}/${found.id}.jsonl`;
  const bytes = Buffer.from('{"type":"user","message":"fixture"}\n');
  await writeBytes(f.transcriptRoot, transcript, bytes);
  const spaces = `local-agent-mode-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}/spaces.json`;
  await writeBytes(
    f.root,
    spaces,
    jsonBytes({ spaces: [{ id: "project", name: "Fixture" }] }),
  );
  const desktopBefore = await fs.readFile(path.join(f.root, "config.json"));
  const starts = f.starts(),
    quits = f.quits();
  const summary = await f.manager.historySummary(a.id);
  assert.equal(summary.indexed, 4);
  assert.equal(summary.archived, 1);
  assert.equal(summary.projects, 1);
  assert.equal(
    summary.transcriptsFound,
    1,
    "the current cwd must be probed when originCwd differs",
  );
  assert.equal(summary.missingTranscripts, 1);
  assert.equal(summary.unknownTranscripts, 2);
  assert.equal(f.starts(), starts);
  assert.equal(f.quits(), quits);
  assert.deepEqual(
    await fs.readFile(path.join(f.root, "config.json")),
    desktopBefore,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.transcriptRoot, transcript)),
    bytes,
  );
});

test("transcript symlinks are unknown and history sync refuses an inactive account before restart", async (t) => {
  const f = await fixture(t),
    a = await f.account("A"),
    b = await f.account("B");
  const cwd = path.join(f.temp, "project");
  const s = await session(f.root, b, undefined, { cwd });
  const slug = cwd.replace(/[/_.]/g, "-");
  await fs.mkdir(path.join(f.transcriptRoot, "projects", slug), {
    recursive: true,
  });
  const outside = path.join(f.temp, "outside.jsonl");
  await fs.writeFile(outside, "fixture");
  await fs.symlink(
    outside,
    path.join(f.transcriptRoot, "projects", slug, `${s.id}.jsonl`),
  );
  const summary = await f.manager.historySummary(b.id);
  assert.equal(summary.unknownTranscripts, 1);
  assert.equal(summary.missingTranscripts, 0);
  const starts = f.starts(),
    quits = f.quits();
  await assert.rejects(
    f.manager.syncHistory(a.id),
    /Switch to this Desktop account/,
  );
  assert.equal(f.starts(), starts);
  assert.equal(f.quits(), quits);
});

test("Claude opening after the first switch write retains recovery without rolling back live files", async (t) => {
  const f = await fixture(t),
    a = await f.account("A"),
    b = await f.account("B");
  f.setRunning(false);
  const starts = f.starts(),
    quits = f.quits();
  const originalRename = fs.rename;
  let opened = false;
  fs.rename = (async (from: any, to: any) => {
    await originalRename(from, to);
    if (!opened && to === path.join(f.root, "config.json")) {
      opened = true;
      f.setRunning(true);
    }
  }) as any;
  try {
    await assert.rejects(
      f.manager.switchTo(a.id, {
        closedOnly: true,
        expectedActiveProfileId: b.id,
        canProceed: () => true,
      }),
      /Claude opened during/,
    );
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(opened, true);
  assert.equal(f.starts(), starts);
  assert.equal(f.quits(), quits);
  assert.equal(
    (await readObject(f.root, "config.json"))!.lastKnownAccountUuid,
    a.desktop!.accountUuid,
    "the transaction must not undo a completed write while Claude is live",
  );
  assert.equal((await f.manager.snapshot()).recoveryRequired, true);
  await assert.rejects(f.manager.switchTo(b.id), /Restore the interrupted/);
  f.setRunning(false);
  await f.manager.recover();
  assert.equal((await f.manager.snapshot()).recoveryRequired, false);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
});

test("a cancelled closed-app switch rolls back both merged history and deletion tracking", async (t) => {
  const f = await fixture(t),
    a = await f.account("A"),
    b = await f.account("B");
  const sourceSpaces = `local-agent-mode-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}/spaces.json`;
  const targetSpaces = `local-agent-mode-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}/spaces.json`;
  await writeBytes(
    f.root,
    sourceSpaces,
    jsonBytes({ spaces: [{ id: "copy", name: "Fixture", updatedAt: 100 }] }),
  );
  await f.manager.switchTo(a.id);
  f.setRunning(false);
  const vault = path.join(f.store.root, "desktop-vault");
  const trackingBefore = await fs.readFile(
    path.join(vault, "history-seen.json"),
  );
  const originalRename = fs.rename;
  let authorized = true;
  fs.rename = (async (from: any, to: any) => {
    await originalRename(from, to);
    if (to === path.join(vault, "history-seen.json")) authorized = false;
  }) as any;
  try {
    await assert.rejects(
      f.manager.switchTo(b.id, {
        closedOnly: true,
        expectedActiveProfileId: a.id,
        canProceed: () => authorized,
      }),
      /conditions changed/,
    );
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(await readObject(f.root, targetSpaces), null);
  assert.deepEqual(
    await fs.readFile(path.join(vault, "history-seen.json")),
    trackingBefore,
  );
  assert.equal((await f.manager.snapshot()).recoveryRequired, false);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
});

test("the same conversation under different aliases produces one card per account", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const cli = randomUUID(),
    older = randomUUID();
  // A's original alias, later adopted by B's Desktop as local_<cli> and copied back.
  await session(f.root, a, older, {
    cliSessionId: cli,
    lastActivityAt: 100,
    permissionMode: "auto",
  });
  await session(f.root, a, cli, {
    lastActivityAt: 300,
    permissionMode: "auto",
  });
  await session(f.root, b, cli, {
    lastActivityAt: 200,
    permissionMode: "default",
    lastFocusedAt: 77,
  });
  await session(f.root, b, older, { cliSessionId: cli, lastActivityAt: 100 });
  assert.deepEqual(await duplicateSessions(f.root, b.desktop!), [
    [`local_${cli}.json`, `local_${older}.json`].sort(),
  ]);
  const plan = await planHistory(f.root, b.desktop!, [a.desktop!]);
  const dest = `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}`;
  assert.equal(plan.get(`${dest}/local_${older}.json`), null);
  const kept = JSON.parse(plan.get(`${dest}/local_${cli}.json`)!.toString());
  assert.equal(kept.lastActivityAt, 300);
  assert.equal(kept.lastFocusedAt, 77);
  // The conversation keeps its Auto mode on the other account.
  assert.equal(kept.permissionMode, "auto");
  assert.equal(plan.size, 2);
});

test("a stale alias superseded by a resumed lineage collapses into the live conversation", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const stale = randomUUID(),
    live = randomUUID(),
    first = randomUUID(),
    rotated = randomUUID();
  await session(f.root, a, stale, { cliSessionId: first, lastActivityAt: 10 });
  await session(f.root, a, live, {
    cliSessionId: rotated,
    priorCliSessionIds: [first],
    lastActivityAt: 50,
  });
  const plan = await planHistory(f.root, b.desktop!, [a.desktop!]);
  const dest = `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}`;
  assert.deepEqual([...plan.keys()], [`${dest}/local_${live}.json`]);
  // Unrelated conversations in the same folder stay separate.
  const other = await session(f.root, a, randomUUID(), { lastActivityAt: 5 });
  const again = await planHistory(f.root, b.desktop!, [a.desktop!]);
  assert(again.get(`${dest}/local_${other.id}.json`));
  assert.equal(again.size, 2);
});

test("bypass mode never travels and a conversation deleted under any alias stays deleted", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const bypass = await session(f.root, a, randomUUID(), {
    permissionMode: "bypassPermissions",
  });
  const cli = randomUUID(),
    alias = randomUUID();
  await session(f.root, a, alias, { cliSessionId: cli, lastActivityAt: 90 });
  const dest = `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}`;
  await writeBytes(f.root, `${dest}/deleted_${cli}`, Buffer.from(""));
  await session(f.root, b, cli, { lastActivityAt: 10 });
  const plan = await planHistory(f.root, b.desktop!, [a.desktop!]);
  assert.equal(plan.has(`${dest}/local_${alias}.json`), false);
  assert.equal(plan.has(`${dest}/local_${cli}.json`), false);
  const copied = JSON.parse(
    plan.get(`${dest}/local_${bypass.id}.json`)!.toString(),
  );
  assert.equal(copied.permissionMode, "default");
});
test("verifying saved sign-ins decrypts each one without touching Claude", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A"),
    b = await f.account("B");
  const quits = f.quits(),
    starts = f.starts();
  const config = await fs.readFile(path.join(f.root, "config.json"));
  await f.manager.verifySavedLogins();
  assert.equal(f.quits(), quits);
  assert.equal(f.starts(), starts);
  assert.deepEqual(await fs.readFile(path.join(f.root, "config.json")), config);
  await fs.rm(
    path.join(
      f.store.root,
      "desktop-vault",
      "accounts",
      `${b.desktop!.accountUuid}.bin`,
    ),
  );
  await assert.rejects(
    f.manager.verifySavedLogins(),
    /Connect this account again/,
  );
  assert.ok(a.desktop);
});
test("a Desktop switch reports the Claude restart it causes", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  const events: DesktopRestartEvent[] = [];
  f.manager.onRestart = (event) => void events.push(event);
  await f.manager.switchTo(a.id);
  assert.deepEqual(events, [
    { phase: "start", kind: "switch", profileId: a.id },
    { phase: "end", kind: "switch", profileId: a.id, ok: true },
  ]);
});

test("Desktop operations that never quit Claude report nothing", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  const events: DesktopRestartEvent[] = [];
  f.manager.onRestart = (event) => void events.push(event);
  // B is open and already saved: saving it again changes nothing.
  await f.manager.capture(b.id, b.desktop!.orgId);
  // Refused before Claude is asked to quit.
  await assert.rejects(f.manager.switchTo(a.id, { canProceed: () => false }), /cancelled before restart/);
  // No sign-in to cancel.
  await f.manager.cancelLogin();
  // Claude is closed: the files are prepared without a restart.
  f.setRunning(false);
  await f.manager.switchTo(a.id, { closedOnly: true, expectedActiveProfileId: b.id });
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  // Opening Claude is not a Desktop operation.
  await f.manager.open();
  assert.deepEqual(events, []);
});

test("a Desktop operation that fails after asking Claude to quit reports a failed end", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  const events: DesktopRestartEvent[] = [];
  f.manager.onRestart = (event) => void events.push(event);
  f.setFailQuit();
  await assert.rejects(f.manager.switchTo(a.id), /still running/);
  assert.deepEqual(events, [
    { phase: "start", kind: "switch", profileId: a.id },
    { phase: "end", kind: "switch", profileId: a.id, ok: false },
  ]);
});

test("each restarting Desktop operation reports its own kind", async (t) => {
  const f = await fixture(t);
  const events: DesktopRestartEvent[] = [];
  f.manager.onRestart = (event) => void events.push(event);
  const a = await f.account("A");
  const c = f.store.create({ name: "C", kind: "personal" });
  await f.manager.beginLogin(c.id);
  await f.manager.cancelLogin();
  await f.manager.syncHistory(a.id);
  assert.deepEqual(
    events.map((e) => [e.phase, e.kind, e.profileId, e.phase === "end" ? e.ok : undefined]),
    [
      ["start", "save", a.id, undefined],
      ["end", "save", a.id, true],
      ["start", "link", c.id, undefined],
      ["end", "link", c.id, true],
      ["start", "cancel-link", undefined, undefined],
      ["end", "cancel-link", undefined, true],
      ["start", "merge", a.id, undefined],
      ["end", "merge", a.id, true],
    ],
  );
});

test("a failing restart listener never breaks the Desktop operation", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.manager.onRestart = () => {
    throw new Error("listener");
  };
  await f.manager.switchTo(a.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
});

// Gives the fixture's Claude a Local Storage and its host a draft helper that records each job,
// answering with `read`. Launches are recorded too, to see what happens in which order.
async function withDraftHelper(
  f: Awaited<ReturnType<typeof fixture>>,
  read: (job: DraftJob) => Promise<DraftResult> = async () => ({
    ok: true,
    drafts: {},
  }),
) {
  const leveldb = path.join(f.root, "Local Storage", "leveldb");
  await fs.mkdir(leveldb, { recursive: true });
  await fs.writeFile(path.join(leveldb, "CURRENT"), "MANIFEST-000001\n");
  const jobs: DraftJob[] = [];
  const events: string[] = [];
  f.host.readDrafts = async (job) => {
    jobs.push(job);
    events.push("readDrafts:start");
    try {
      return await read(job);
    } finally {
      events.push("readDrafts:end");
    }
  };
  const launch = f.host.launch;
  f.host.launch = async () => {
    events.push("launch");
    await launch();
  };
  f.host.claudeElectron = async () => "44.7.2";
  // The draft step's scratch dirs, instead of the real os.tmpdir().
  const tmp = path.join(f.temp, "tmp");
  await fs.mkdir(tmp);
  f.host.draftScratchDir = tmp;
  const vault = path.join(f.store.root, "desktop-vault");
  return {
    jobs,
    events,
    leveldb,
    tmp,
    vault,
    last: () => readObject(vault, "drafts/last.json"),
    drafts: async () => fs.readdir(path.join(vault, "drafts")).catch(() => []),
  };
}

// An unsent draft as Claude keeps it in Local Storage.
const draftOf = (owner: string, text: string, files: string[] = []) =>
  JSON.stringify({ text, files, snippets: [], owner });
const UNSENT = "an unsent draft, word for word";

// A switch from A, open in Claude, to B, sharing one conversation. B's card of it is the newest
// and is called "Fix login"; A has an unsent draft there and one on the new-session screen.
async function sharedConversation(t: any) {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A"); // A is open in Claude
  const shared = randomUUID();
  await session(f.root, a, shared, { lastActivityAt: 100, title: "A's title" });
  await session(f.root, b, shared, { lastActivityAt: 300, title: "Fix login" });
  const d = await withDraftHelper(f, async () => ({
    ok: true,
    drafts: {
      [CONVERSATION_DRAFT_PREFIX + shared]: draftOf(a.desktop!.accountUuid, UNSENT),
      [NEW_SESSION_DRAFT]: draftOf(a.desktop!.accountUuid, "a new start", ["f"]),
      // B's own draft somewhere else is not A's to carry.
      [CONVERSATION_DRAFT_PREFIX + randomUUID()]: draftOf(b.desktop!.accountUuid, "B's"),
    },
  }));
  return { f, a, b, shared, d };
}

test("an A→B switch captures A's draft of a shared conversation for B", async (t) => {
  const { f, a, b, shared, d } = await sharedConversation(t);

  await f.manager.switchTo(b.id);

  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  const records = await f.manager.pendingDraftRecords();
  assert.equal(records.length, 2);
  const [conversation, newSession] = records;
  const { id, capturedAt, ...rest } = conversation;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(capturedAt)));
  assert.deepEqual(rest, {
    to: b.desktop!.accountUuid,
    targetAlias: shared,
    title: "Fix login",
    text: UNSENT,
    attachments: false,
    state: "pending",
  });
  // The title is the one on B's card of the conversation, after the merge.
  assert.equal(
    (await readObject(
      f.root,
      `claude-code-sessions/${b.desktop!.accountUuid}/${b.desktop!.orgId}/local_${shared}.json`,
    ))!.title,
    "Fix login",
  );
  assert.equal(newSession.newSession, true);
  assert.equal(newSession.text, "a new start");
  assert.equal(newSession.attachments, true);
  assert.equal(newSession.to, b.desktop!.accountUuid);

  const { at, ...last } = (await d.last())!;
  assert.ok(!Number.isNaN(Date.parse(at)));
  assert.deepEqual(last, {
    from: a.desktop!.accountUuid,
    to: b.desktop!.accountUuid,
    status: "captured",
    count: 2,
  });
  // The text is only in the sealed vault file, and only sealed.
  assert.deepEqual((await d.drafts()).sort(), ["last.json", "pending.bin"]);
  for (const file of ["last.json", "pending.bin"]) {
    const raw = await fs.readFile(path.join(d.vault, "drafts", file), "utf8");
    assert.ok(!raw.includes(UNSENT), file);
  }
  assert.deepEqual(await fs.readdir(d.tmp), []);
});

test("a capture is logged with its slots and lengths, never its text", async (t) => {
  const { f, a, b, shared } = await sharedConversation(t);
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  f.manager.onDraftEvent = (event, fields) => void events.push([event, fields]);

  await f.manager.switchTo(b.id);

  assert.deepEqual(events.filter(([event]) => event === "capture"), [
    [
      "capture",
      {
        from: a.desktop!.accountUuid.slice(0, 8),
        to: b.desktop!.accountUuid.slice(0, 8),
        status: "captured",
        count: 2,
        drafts: `${shared.slice(0, 8)}:${UNSENT.length},new:${"a new start".length}`,
      },
    ],
  ]);
  const logged = JSON.stringify(events);
  // Ids are cut to 8 characters: the log holds no full account id.
  assert.doesNotMatch(logged, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.ok(!logged.includes(UNSENT));
  assert.ok(!logged.includes("a new start"));
});

test("a capture that fails or is skipped is logged with its reason, and a log that throws changes nothing", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A");
  await withDraftHelper(f, async () => {
    throw new Error(`Unexpected token 'x', "${UNSENT}" is not valid JSON`);
  });
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  f.manager.onDraftEvent = (event, fields) => {
    events.push([event, fields]);
    throw new Error("the log failed");
  };

  await f.manager.switchTo(b.id);

  // The switch ends as it would, and the message that quotes data is not logged as it is.
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.deepEqual(events, [
    [
      "capture",
      {
        from: a.desktop!.accountUuid.slice(0, 8),
        to: b.desktop!.accountUuid.slice(0, 8),
        status: "failed",
        count: 0,
        error: "parse-error",
        drafts: "",
      },
    ],
  ]);
  assert.ok(!JSON.stringify(events).includes(UNSENT));
  // Claude open when the copy would be made skips the step, and says why.
  const g = await fixture(t);
  const second = await g.account("B");
  await g.account("A");
  await withDraftHelper(g);
  g.host.draftsBlocked = async () => "Drafts are not supported here";
  const skipped: Array<[string, Record<string, unknown> | undefined]> = [];
  g.manager.onDraftEvent = (event, fields) => void skipped.push([event, fields]);
  await g.manager.switchTo(second.id);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0][1]!.status, "skipped");
  assert.equal(skipped[0][1]!.reason, "Drafts are not supported here");
});

test("a switch whose history policy forbids drafts logs that no capture was tried", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A");
  await withDraftHelper(f);
  f.store.update((state) => {
    state.settings.desktopHistoryTransfer = "off";
  });
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  f.manager.onDraftEvent = (event, fields) => void events.push([event, fields]);

  await f.manager.switchTo(b.id);

  assert.deepEqual(events, [
    [
      "capture",
      {
        from: a.desktop!.accountUuid.slice(0, 8),
        to: b.desktop!.accountUuid.slice(0, 8),
        status: "not-run",
        reason: "history-off",
      },
    ],
  ]);
});

test("the draft methods work by id, and summaries carry no text", async (t) => {
  const { f, b, d } = await sharedConversation(t);
  await f.manager.switchTo(b.id);
  const [conversation, newSession] = await f.manager.pendingDraftRecords();

  const summaries = await f.manager.pendingDrafts();
  assert.ok(!JSON.stringify(summaries).includes(UNSENT));
  assert.deepEqual(summaries[0], {
    id: conversation.id,
    to: b.desktop!.accountUuid,
    title: "Fix login",
    newSession: false,
    attachments: false,
    state: "pending",
    capturedAt: conversation.capturedAt,
  });
  assert.equal(await f.manager.draftText(conversation.id), UNSENT);
  assert.equal(await f.manager.draftText(randomUUID()), undefined);

  await f.manager.markDraft(conversation.id, "needs-copy", "accessibility");
  const [marked] = await f.manager.pendingDrafts();
  assert.equal(marked.state, "needs-copy");
  assert.equal(marked.reason, "accessibility");

  await f.manager.dismissDraft(conversation.id);
  assert.deepEqual(
    (await f.manager.pendingDrafts()).map((summary) => summary.id),
    [newSession.id],
  );
  await f.manager.dismissDraft(newSession.id);
  assert.deepEqual(await f.manager.pendingDrafts(), []);
  assert.deepEqual(await d.drafts(), ["last.json"]);
});

test("a later capture that finds no draft drops the stale one", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A"); // A is open in Claude
  const shared = randomUUID();
  await session(f.root, a, shared, { lastActivityAt: 100 });
  await session(f.root, b, shared, { lastActivityAt: 300, title: "Fix login" });
  let drafts: Record<string, string> = {
    [CONVERSATION_DRAFT_PREFIX + shared]: draftOf(a.desktop!.accountUuid, UNSENT),
    [NEW_SESSION_DRAFT]: draftOf(a.desktop!.accountUuid, "a new start"),
  };
  const d = await withDraftHelper(f, async () => ({ ok: true, drafts }));
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.pendingDraftRecords()).length, 2);

  // Back on A, the user sends the draft and clears the new-session screen, then switches again.
  drafts = {};
  await f.manager.switchTo(a.id);
  await f.manager.switchTo(b.id);

  // What would have been re-typed is no longer A's draft: it is gone, the file with it.
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.deepEqual(await f.manager.pendingDraftRecords(), []);
  assert.deepEqual(await d.drafts(), ["last.json"]);
  assert.equal((await d.last())!.count, 0);
});

test("initialize removes stale draft scratch dirs, and keeps fresh ones", async (t) => {
  const f = await fixture(t);
  const tmp = f.host.draftScratchDir!;
  await fs.mkdir(tmp, { recursive: true });
  // What a Relay that stopped mid-step left: its copy and the helper's text-bearing result.
  const stale = await fs.mkdtemp(path.join(tmp, "relay-drafts-"));
  await fs.mkdir(path.join(stale, "copy", "leveldb"), { recursive: true });
  await fs.writeFile(path.join(stale, "result.json"), UNSENT);
  // Younger than ten minutes: it may belong to a step still running.
  const fresh = await fs.mkdtemp(path.join(tmp, "relay-drafts-"));
  // Not a scratch dir, however old.
  const other = path.join(tmp, "someone-else");
  await fs.mkdir(other);
  const eleven = new Date(Date.now() - 11 * 60_000);
  await fs.utimes(stale, eleven, eleven);
  await fs.utimes(other, eleven, eleven);

  await new DesktopManager(f.root, f.store, f.host, f.transcriptRoot).initialize();

  await assert.rejects(fs.lstat(stale), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(tmp)).sort(), [
    path.basename(fresh),
    "someone-else",
  ].sort());
});

test("an A→B switch runs the draft helper once, on a private copy", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);

  await f.manager.switchTo(b.id);

  assert.equal(d.jobs.length, 1);
  const [job] = d.jobs;
  // A copy in the step's own scratch dir, never anything in Claude's directory.
  assert.equal(path.dirname(job.scratch), d.tmp);
  assert.equal(job.storage, path.join(job.scratch, "copy"));
  assert.ok(!job.storage.startsWith(f.root + path.sep));
  assert.equal(job.claudeElectron, "44.7.2");
  assert.deepEqual(await fs.readdir(path.join(f.root, "Local Storage")), [
    "leveldb",
  ]);
  assert.deepEqual(await fs.readdir(d.tmp), []);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal((await d.last())!.status, "captured");
  assert.equal((await d.last())!.count, 0);
  assert.deepEqual(await f.manager.pendingDraftRecords(), []);
});

test("Claude relaunches only after the draft helper finished", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ok: true, drafts: {} };
  });
  await f.manager.switchTo(b.id);
  assert.deepEqual(d.events, ["readDrafts:start", "readDrafts:end", "launch"]);
});

test("a throwing helper still switches", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A");
  const d = await withDraftHelper(f, async (job) => {
    await fs.writeFile(path.join(job.storage, "leveldb", "CURRENT"), "x");
    throw new Error("helper crashed");
  });
  const starts = f.starts();

  await f.manager.switchTo(b.id);

  const state = await f.manager.snapshot();
  assert.equal(state.activeProfileId, b.id);
  assert.equal(state.error, undefined);
  assert.equal(state.recoveryRequired, false);
  assert.equal(f.starts(), starts + 1);
  assert.equal(
    await fs.readFile(path.join(d.leveldb, "CURRENT"), "utf8"),
    "MANIFEST-000001\n",
  );
  const { at, ...last } = (await d.last())!;
  assert.ok(!Number.isNaN(Date.parse(at)));
  assert.deepEqual(last, {
    from: a.desktop!.accountUuid,
    to: b.desktop!.accountUuid,
    status: "failed",
    error: "helper crashed",
  });
  assert.deepEqual(await f.manager.pendingDraftRecords(), []);
  assert.deepEqual(await fs.readdir(d.tmp), []);
});

test("a draft step that cannot seal its drafts still switches", async (t) => {
  const { f, b, d } = await sharedConversation(t);
  const seal = f.host.seal;
  // Saved sign-ins still seal; only the drafts cannot.
  f.host.seal = (text) => {
    if (text.includes(UNSENT))
      throw new Error("System encryption is unavailable.");
    return seal(text);
  };

  await f.manager.switchTo(b.id);

  const state = await f.manager.snapshot();
  assert.equal(state.activeProfileId, b.id);
  assert.equal(state.error, undefined);
  assert.equal((await d.last())!.status, "failed");
  assert.equal((await d.last())!.error, "System encryption is unavailable.");
  assert.deepEqual(await f.manager.pendingDraftRecords(), []);
  assert.deepEqual(await d.drafts(), ["last.json"]);
});

test("no drafts are captured when history transfer is off", async (t) => {
  const { f, b, d } = await sharedConversation(t);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "off";
  });
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal(await d.last(), null);
  assert.deepEqual(await d.drafts(), []);
  assert.deepEqual(await f.manager.pendingDraftRecords(), []);
});

test("no drafts are captured when the pair is not allowed", async (t) => {
  const f = await fixture(t);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "same-group";
  });
  const b = await f.account("B", "other");
  await f.account("A", "team");
  const d = await withDraftHelper(f);
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal(await d.last(), null);
  assert.deepEqual(await f.manager.pendingDraftRecords(), []);
});

test("no drafts are captured when switching to the same account", async (t) => {
  const { f, a, d } = await sharedConversation(t);
  await f.manager.switchTo(a.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  assert.equal(d.jobs.length, 0);
  assert.deepEqual(d.events, ["launch"]);
  assert.deepEqual(await f.manager.pendingDraftRecords(), []);
});

test("the closedOnly switch captures drafts too", async (t) => {
  const { f, a, b, d } = await sharedConversation(t);
  f.setRunning(false);
  await f.manager.switchTo(b.id, {
    closedOnly: true,
    expectedActiveProfileId: a.id,
  });
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 1);
  assert.equal((await d.last())!.from, a.desktop!.accountUuid);
  assert.equal((await d.last())!.to, b.desktop!.accountUuid);
  assert.equal((await f.manager.pendingDraftRecords()).length, 2);
  // Claude stays closed.
  assert.deepEqual(d.events, ["readDrafts:start", "readDrafts:end"]);
});

test("a host that cannot read drafts records why and captures nothing", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  const reason = "Claude Desktop runs Electron 45.0.0, Relay 44.7.0";
  f.host.draftsBlocked = async () => reason;
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal((await d.last())!.status, "skipped");
  assert.equal((await d.last())!.reason, reason);
  assert.deepEqual(await d.drafts(), ["last.json"]);
});

test("drafts are not captured once Claude is running again", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  // Claude is opened right after the switch's files are written: a copy made now could be torn.
  f.host.draftsBlocked = async () => {
    f.setRunning(true);
    return undefined;
  };
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal((await d.last())!.reason, "Claude is running");
  assert.deepEqual(await d.drafts(), ["last.json"]);
  assert.deepEqual(await fs.readdir(d.tmp), []);
});

test("Claude opening once the copy is under way stops the step before the helper", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  // Asked after the first running check, so only the one after the copy sees Claude open.
  f.host.claudeElectron = async () => {
    f.setRunning(true);
    return "44.7.2";
  };
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal((await d.last())!.reason, "Claude is running");
  assert.deepEqual(await fs.readdir(d.tmp), []);
});

test("a host that cannot read Claude's Electron version captures nothing", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  f.host.claudeElectron = async () => undefined;
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal(
    (await d.last())!.reason,
    "Claude Desktop's Electron version is unknown",
  );
  assert.deepEqual(await d.drafts(), ["last.json"]);
});

test("what the helper wrote to its copy never reaches Claude's leveldb", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f, async (job) => {
    await fs.writeFile(
      path.join(job.storage, "leveldb", "CURRENT"),
      "MANIFEST-000002\n",
    );
    return { ok: true, drafts: {} };
  });
  await f.manager.switchTo(b.id);
  assert.deepEqual(d.events, ["readDrafts:start", "readDrafts:end", "launch"]);
  assert.equal(
    await fs.readFile(path.join(d.leveldb, "CURRENT"), "utf8"),
    "MANIFEST-000001\n",
  );
  assert.deepEqual(await fs.readdir(path.join(f.root, "Local Storage")), [
    "leveldb",
  ]);
  // No backup of Claude's Local Storage is made any more: only last.json.
  assert.deepEqual(await d.drafts(), ["last.json"]);
  assert.equal((await d.last())!.status, "captured");
});

test("a failure deciding whether drafts can be read never reaches the switch", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  f.host.draftsBlocked = async () => {
    throw new Error("plutil failed");
  };
  await f.manager.switchTo(b.id);
  const state = await f.manager.snapshot();
  assert.equal(state.activeProfileId, b.id);
  assert.equal(state.error, undefined);
  assert.equal(d.jobs.length, 0);
  assert.equal((await d.last())!.reason, "plutil failed");
  assert.deepEqual(d.events, ["launch"]);
});

test("no drafts are captured between accounts that are not both selected", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A");
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "selected";
    s.settings.desktopHistoryAccounts = [a.id];
  });
  const d = await withDraftHelper(f);
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal(await d.last(), null);
});

test("the draft helper runs on the switched files, after the switch is complete", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const vault = path.join(f.store.root, "desktop-vault");
  const seen: { account?: string; journal: boolean }[] = [];
  await withDraftHelper(f, async () => {
    seen.push({
      account: (await readObject(f.root, "config.json"))?.lastKnownAccountUuid,
      journal: !!(await readObject(vault, "journal.json")),
    });
    return { ok: true, drafts: {} };
  });
  await f.manager.switchTo(b.id);
  assert.deepEqual(seen, [{ account: b.desktop!.accountUuid, journal: false }]);
});

test("a switch whose files fail to apply runs no draft step", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  const originalRm = fs.rm;
  let failed = false;
  fs.rm = (async (p: any, ...args: any[]) => {
    if (!failed && p === path.join(f.root, "Cookies-journal")) {
      failed = true;
      throw new Error("disk failure");
    }
    return (originalRm as any)(p, ...args);
  }) as any;
  try {
    await assert.rejects(f.manager.switchTo(b.id), /disk failure/);
  } finally {
    fs.rm = originalRm;
  }
  assert.equal(failed, true);
  assert.equal(d.jobs.length, 0);
  assert.equal(await d.last(), null);
  // Claude still comes back.
  assert.deepEqual(d.events, ["launch"]);
});

test("saving an account and syncing history never capture drafts", async (t) => {
  const f = await fixture(t);
  await f.account("B");
  const d = await withDraftHelper(f);
  const a = await f.account("A"); // a capture that changes the open account
  await session(f.root, a);
  await f.manager.syncHistory(a.id);
  assert.equal(d.jobs.length, 0);
  assert.equal(await d.last(), null);
});

test("Claude relaunches only after a slow draft helper that then fails", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f, async (job) => {
    await fs.writeFile(path.join(job.storage, "leveldb", "CURRENT"), "x");
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ok: false, error: "verification failed" };
  });
  await f.manager.switchTo(b.id);
  assert.deepEqual(d.events, ["readDrafts:start", "readDrafts:end", "launch"]);
  assert.equal(
    await fs.readFile(path.join(d.leveldb, "CURRENT"), "utf8"),
    "MANIFEST-000001\n",
  );
  assert.equal((await d.last())!.status, "failed");
  assert.equal((await d.last())!.error, "verification failed");
});

test("initialize removes the first design's plaintext backups, and keeps the rest", async (t) => {
  const f = await fixture(t);
  const drafts = path.join(f.store.root, "desktop-vault", "drafts");
  for (const stamp of ["2026-10-16T09-08-07-654Z", "2026-10-15T23-00-00-000Z"]) {
    await fs.mkdir(path.join(drafts, stamp, "leveldb"), { recursive: true });
    await fs.writeFile(
      path.join(drafts, stamp, "leveldb", "000003.log"),
      "a plaintext draft",
    );
  }
  await fs.writeFile(path.join(drafts, "last.json"), "{}");
  await fs.writeFile(path.join(drafts, "pending.bin"), "sealed");

  await new DesktopManager(f.root, f.store, f.host, f.transcriptRoot).initialize();

  assert.deepEqual((await fs.readdir(drafts)).sort(), [
    "last.json",
    "pending.bin",
  ]);
  assert.equal(await fs.readFile(path.join(drafts, "pending.bin"), "utf8"), "sealed");
});

/** A manager on the fixture's files whose host counts the process checks it makes. */
async function counted(f: Awaited<ReturnType<typeof fixture>>) {
  const clock = { now: 1_000_000 };
  const checks = { running: 0, seems: 0 };
  let hold: Promise<void> | undefined;
  const host: DesktopHost = {
    ...f.host,
    // Each check sees Claude as it was when the check began.
    running: async () => {
      checks.running++;
      const running = await f.host.running();
      await hold;
      return running;
    },
    seemsRunning: async () => {
      checks.seems++;
      const running = await f.host.running();
      await hold;
      return running;
    },
  };
  const manager = new DesktopManager(
    f.root,
    f.store,
    host,
    f.transcriptRoot,
    () => clock.now,
  );
  await manager.initialize();
  return {
    manager,
    clock,
    checks,
    holdReads: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

test("concurrent observers share one Desktop read, reused for a short while", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const c = await counted(f);
  const release = c.holdReads();
  const reads = Promise.all([
    c.manager.cachedSnapshot(),
    c.manager.cachedSnapshot(),
    c.manager.cachedSnapshot(),
  ]);
  release();
  for (const state of await reads) assert.equal(state.activeProfileId, a.id);
  assert.deepEqual(c.checks, { running: 0, seems: 1 });
  c.clock.now += DESKTOP_CACHE_MS - 1;
  await c.manager.cachedSnapshot();
  assert.equal(c.checks.seems, 1);
  c.clock.now += 1;
  await c.manager.cachedSnapshot();
  assert.equal(c.checks.seems, 2);
});

test("decisions read Desktop fresh, and every Desktop operation drops the shared reading", async (t) => {
  const f = await fixture(t);
  await f.account("A");
  const c = await counted(f);
  // snapshot() is for decisions: it always reads, with the full process check.
  await c.manager.snapshot();
  await c.manager.snapshot();
  assert.deepEqual(c.checks, { running: 2, seems: 0 });
  // Claude closed in the meantime: the shared reading still says it runs…
  f.setRunning(false);
  assert.equal((await c.manager.cachedSnapshot()).running, true);
  // …but opening Claude, an operation, is seen at once.
  await c.manager.open();
  assert.equal((await c.manager.cachedSnapshot()).running, true);
  assert.equal(c.checks.seems, 1);
  f.setRunning(false);
  await c.manager.recover();
  assert.equal((await c.manager.cachedSnapshot()).running, false);
  assert.equal(c.checks.seems, 2);
});

test("a read that began before a Desktop operation is not kept for later observers", async (t) => {
  const f = await fixture(t);
  await f.account("A");
  const c = await counted(f);
  const release = c.holdReads();
  const early = c.manager.cachedSnapshot();
  f.setRunning(false);
  await c.manager.open();
  release();
  await early;
  assert.equal((await c.manager.cachedSnapshot()).running, true);
  assert.equal(c.checks.seems, 2);
});

test("a failed Desktop read is not kept: the next observer reads again", async (t) => {
  const f = await fixture(t);
  await f.account("A");
  const c = await counted(f);
  const running = f.host.running;
  let fail = true;
  const manager = new DesktopManager(
    f.root,
    f.store,
    {
      ...f.host,
      seemsRunning: async () => {
        c.checks.seems++;
        if (fail) throw new Error("The process list could not be read.");
        return running();
      },
    },
    f.transcriptRoot,
    () => c.clock.now,
  );
  await manager.initialize();
  await assert.rejects(manager.cachedSnapshot(), /process list/);
  fail = false;
  assert.equal((await manager.cachedSnapshot()).running, true);
  assert.equal(c.checks.seems, 2);
});

test("every Desktop operation ensures the operation lock and releases it, even when it fails", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  f.manager.operationLock = {
    ensure: (kind) => {
      calls.push(`+${kind}`);
      return () => calls.push(`-${kind}`);
    },
  };
  const a = await f.account("A"),
    b = await f.account("B");
  calls.length = 0;
  await f.manager.switchTo(a.id);
  f.setFailQuit();
  await assert.rejects(f.manager.switchTo(b.id));
  assert.deepEqual(calls, ["+switch", "-switch", "+switch", "-switch"]);
});

test("a busy operation lock refuses before Claude is quit", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  const quits = f.quits();
  f.manager.operationLock = {
    ensure: () => {
      throw new Error("Relay (a terminal) is busy with switch");
    },
  };
  await assert.rejects(f.manager.switchTo(a.id), /busy with switch/);
  assert.equal(f.quits(), quits);
  assert.equal(f.manager.isBusy, false);
});

test("a sign-in begun by another manager on the same vault is seen", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  const otherStore = new Store(f.store.root);
  const other = new DesktopManager(f.root, otherStore, f.host, f.transcriptRoot);
  await other.initialize();
  const c = otherStore.create({ name: "C", kind: "personal" });
  await other.beginLogin(c.id);
  assert.equal((await f.manager.snapshot()).pendingProfileId, c.id);
  await assert.rejects(f.manager.switchTo(a.id), /Finish or cancel/);
  await other.cancelLogin();
  assert.equal((await f.manager.snapshot()).pendingProfileId, undefined);
  void b;
});

test("carriedCount reports the conversations the switch wrote into the target", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // B is open in Claude
  await session(f.root, b);
  await session(f.root, b);
  await f.manager.switchTo(a.id);
  assert.equal(f.manager.carriedCount, 2);
});
