import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import { DesktopManager, type DesktopHost } from "../electron/core/desktop";
import type { DesktopRestartEvent } from "../shared/types";
import type { DraftJob, DraftResult } from "../electron/draft-job";
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
test("a changed continuation guard blocks restart before Claude is asked to quit", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  await f.manager.switchTo(a.id);
  f.setRunning(true);
  const quits = f.quits();
  await assert.rejects(
    f.manager.switchTo(b.id, { canProceed: () => false }),
    /cancelled before restart/,
  );
  assert.equal(f.quits(), quits);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  assert.equal((await f.manager.snapshot()).running, true);
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
// answering with `move`. Launches are recorded too, to see what happens in which order.
async function withDraftHelper(
  f: Awaited<ReturnType<typeof fixture>>,
  move: (job: DraftJob) => Promise<DraftResult> = async () => ({
    ok: true,
    moved: 0,
    owned: 0,
    skipped: 0,
  }),
) {
  const leveldb = path.join(f.root, "Local Storage", "leveldb");
  await fs.mkdir(leveldb, { recursive: true });
  await fs.writeFile(path.join(leveldb, "CURRENT"), "MANIFEST-000001\n");
  const jobs: DraftJob[] = [];
  const events: string[] = [];
  f.host.moveDrafts = async (job) => {
    jobs.push(job);
    events.push("moveDrafts:start");
    try {
      return await move(job);
    } finally {
      events.push("moveDrafts:end");
    }
  };
  const launch = f.host.launch;
  f.host.launch = async () => {
    events.push("launch");
    await launch();
  };
  const vault = path.join(f.store.root, "desktop-vault");
  return {
    jobs,
    events,
    leveldb,
    last: () => readObject(vault, "drafts/last.json"),
    drafts: async () => fs.readdir(path.join(vault, "drafts")).catch(() => []),
  };
}

test("an A→B switch moves drafts once with A, B and the carried conversations", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A"); // A is open in Claude
  const shared = randomUUID();
  await session(f.root, a, shared, { lastActivityAt: 300 });
  await session(f.root, b, shared, { lastActivityAt: 100 });
  const d = await withDraftHelper(f);

  await f.manager.switchTo(b.id);

  assert.equal(d.jobs.length, 1);
  const [job] = d.jobs;
  assert.equal(job.from, a.desktop!.accountUuid);
  assert.equal(job.to, b.desktop!.accountUuid);
  assert.equal(job.storage, path.join(f.root, "Local Storage"));
  assert.ok(job.conversations.length > 0);
  const conversation = job.conversations.find((c) => c.targetAlias === shared);
  assert.ok(conversation, "the shared conversation is carried");
  assert.deepEqual(
    conversation.members.map((m) => m.accountUuid).sort(),
    [a.desktop!.accountUuid, b.desktop!.accountUuid].sort(),
  );
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal((await d.last())!.status, "moved");
});

test("a switch that carries no conversation still runs the helper, with none", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  await f.manager.switchTo(b.id);
  assert.equal(d.jobs.length, 1);
  // The new-session draft can still change owner.
  assert.deepEqual(d.jobs[0].conversations, []);
});

test("Claude relaunches only after the draft helper finished", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ok: true, moved: 0, owned: 0, skipped: 0 };
  });
  await f.manager.switchTo(b.id);
  assert.deepEqual(d.events, ["moveDrafts:start", "moveDrafts:end", "launch"]);
});

test("a throwing moveDrafts still switches", async (t) => {
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
    restored: true,
  });
});

test("no drafts move when history transfer is off", async (t) => {
  const f = await fixture(t);
  f.store.update((s) => {
    s.settings.desktopHistoryTransfer = "off";
  });
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal(await d.last(), null);
  assert.deepEqual(await d.drafts(), []);
});

test("no drafts move when the pair is not allowed", async (t) => {
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
});

test("no drafts move when switching to the same account", async (t) => {
  const f = await fixture(t);
  await f.account("B");
  const a = await f.account("A");
  const d = await withDraftHelper(f);
  await f.manager.switchTo(a.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  assert.equal(d.jobs.length, 0);
  assert.deepEqual(d.events, ["launch"]);
});

test("the closedOnly switch moves drafts too", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  const a = await f.account("A");
  f.setRunning(false);
  const d = await withDraftHelper(f);
  await f.manager.switchTo(b.id, {
    closedOnly: true,
    expectedActiveProfileId: a.id,
  });
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 1);
  assert.equal(d.jobs[0].from, a.desktop!.accountUuid);
  assert.equal(d.jobs[0].to, b.desktop!.accountUuid);
  // Claude stays closed.
  assert.deepEqual(d.events, ["moveDrafts:start", "moveDrafts:end"]);
});

test("a host that cannot move drafts records why and moves nothing", async (t) => {
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
  // No backup was made.
  assert.deepEqual(await d.drafts(), ["last.json"]);
});

test("drafts are not moved once Claude is running again", async (t) => {
  const f = await fixture(t);
  const b = await f.account("B");
  await f.account("A");
  const d = await withDraftHelper(f);
  // Claude is opened right after the switch's files are written.
  f.host.draftsBlocked = async () => {
    f.setRunning(true);
    return undefined;
  };
  await f.manager.switchTo(b.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, b.id);
  assert.equal(d.jobs.length, 0);
  assert.equal((await d.last())!.reason, "Claude is running");
  assert.deepEqual(await d.drafts(), ["last.json"]);
});

test("a failure deciding whether drafts can move never reaches the switch", async (t) => {
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
