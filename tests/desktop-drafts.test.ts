import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  jsonBytes,
  planHistory,
  planHistoryDetailed,
  writeBytes,
  type CarriedConversation,
  type Scope,
} from "../electron/core/desktop-files";
import {
  CONVERSATION_DRAFT_PREFIX as P,
  NEW_SESSION_DRAFT,
  planDraftMoves,
} from "../electron/core/drafts";
import {
  LEVELDB,
  LOCAL_STORAGE,
  backupLocalStorage,
  pruneDraftBackups,
  restoreLocalStorage,
  sweepRestoreLeftovers,
} from "../electron/core/draft-storage";
import {
  awaitHelper,
  draftsBlockedReason,
  electronMismatch,
  helperOutcome,
  preserveDrafts,
  type HelperExit,
} from "../electron/core/draft-transfer";
import {
  DRAFT_WORKER_FLAG,
  EMPTY_STORAGE,
  assertLocalStorage,
  draftJobPath,
  parseDraftJob,
  runDraftJob,
  type DraftJob,
  type DraftPage,
  type DraftResult,
} from "../electron/draft-job";

// A fake Claude root with two accounts and nothing else: planHistory only reads
// `claude-code-sessions/<acct>/<org>/` records and the optional projects files.
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-drafts-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = (): Scope => ({
    accountUuid: randomUUID(),
    orgId: randomUUID(),
  });
  const a = scope(),
    b = scope();
  const dir = (s: Scope) =>
    `claude-code-sessions/${s.accountUuid}/${s.orgId}`;
  async function record(s: Scope, alias: string, extra = {}) {
    await writeBytes(
      root,
      `${dir(s)}/local_${alias}.json`,
      jsonBytes({
        sessionId: `local_${alias}`,
        cliSessionId: alias,
        cwd: root,
        title: "Fixture",
        lastActivityAt: 42,
        ...extra,
      }),
    );
  }
  return { root, a, b, dir, record };
}
const byAlias = (members: { alias: string; accountUuid: string }[]) =>
  [...members].sort((x, y) => x.alias.localeCompare(y.alias));

test("a conversation newest in the source keeps its alias in the target", async (t) => {
  const f = await fixture(t);
  const x = randomUUID(),
    y = randomUUID();
  await f.record(f.a, x, { cliSessionId: x, lastActivityAt: 200 });
  await f.record(f.b, y, { cliSessionId: x, lastActivityAt: 100 });
  const { writes, conversations } = await planHistoryDetailed(f.root, f.b, [
    f.a,
  ]);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].targetAlias, x);
  assert.deepEqual(
    byAlias(conversations[0].members),
    byAlias([
      { alias: x, accountUuid: f.a.accountUuid },
      { alias: y, accountUuid: f.b.accountUuid },
    ]),
  );
  // The reported alias is the card the target really ends up with.
  assert(writes.get(`${f.dir(f.b)}/local_${x}.json`));
  assert.equal(writes.get(`${f.dir(f.b)}/local_${y}.json`), null);
});

test("a conversation newest in the target keeps the target alias", async (t) => {
  const f = await fixture(t);
  const x = randomUUID(),
    y = randomUUID();
  await f.record(f.a, x, { cliSessionId: x, lastActivityAt: 100 });
  await f.record(f.b, y, { cliSessionId: x, lastActivityAt: 200 });
  const { writes, conversations } = await planHistoryDetailed(f.root, f.b, [
    f.a,
  ]);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].targetAlias, y);
  assert.deepEqual(
    byAlias(conversations[0].members),
    byAlias([
      { alias: x, accountUuid: f.a.accountUuid },
      { alias: y, accountUuid: f.b.accountUuid },
    ]),
  );
  assert.equal(writes.size, 0);
});

test("a duplicate target card the merge deletes is still a member", async (t) => {
  const f = await fixture(t);
  const cli = randomUUID(),
    older = randomUUID();
  await f.record(f.b, cli, { cliSessionId: cli, lastActivityAt: 300 });
  await f.record(f.b, older, { cliSessionId: cli, lastActivityAt: 100 });
  const { writes, conversations } = await planHistoryDetailed(f.root, f.b, [
    f.a,
  ]);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].targetAlias, cli);
  assert.deepEqual(
    byAlias(conversations[0].members),
    byAlias([
      { alias: cli, accountUuid: f.b.accountUuid },
      { alias: older, accountUuid: f.b.accountUuid },
    ]),
  );
  assert.equal(writes.get(`${f.dir(f.b)}/local_${older}.json`), null);
  assert.equal(writes.has(`${f.dir(f.b)}/local_${cli}.json`), false);
});

test("a tombstoned conversation is not listed", async (t) => {
  const f = await fixture(t);
  const x = randomUUID();
  await f.record(f.a, x, { cliSessionId: x, lastActivityAt: 200 });
  await writeBytes(f.root, `${f.dir(f.b)}/deleted_${x}`, Buffer.from(""));
  const { writes, conversations } = await planHistoryDetailed(f.root, f.b, [
    f.a,
  ]);
  assert.deepEqual(conversations, []);
  assert.equal(writes.size, 0);
});

test("planHistory still returns the same writes", async (t) => {
  const f = await fixture(t);
  const x = randomUUID(),
    y = randomUUID(),
    solo = randomUUID(),
    stale = randomUUID();
  await f.record(f.a, x, { cliSessionId: x, lastActivityAt: 200 });
  await f.record(f.b, y, { cliSessionId: x, lastActivityAt: 100 });
  await f.record(f.a, solo, { lastActivityAt: 50 });
  await f.record(f.b, stale, { cliSessionId: y, lastActivityAt: 10 });
  const plain = await planHistory(f.root, f.b, [f.a]);
  const detailed = await planHistoryDetailed(f.root, f.b, [f.a]);
  assert(plain.size > 0);
  assert.deepEqual(plain, detailed.writes);
});

// planDraftMoves: a pure transform from the drafts Claude holds to the keys to write and remove.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const draft = (owner: string, text = "t") =>
  JSON.stringify({ text, files: [], snippets: [], owner });
const carried = (
  targetAlias: string,
  ...members: [string, string][]
): CarriedConversation => ({
  targetAlias,
  members: members.map(([alias, accountUuid]) => ({ alias, accountUuid })),
});

test("the same alias changes owner in place", () => {
  const ops = planDraftMoves({
    drafts: { [P + "x"]: draft(A) },
    from: A,
    to: B,
    conversations: [carried("x", ["x", A])],
  });
  assert.deepEqual(JSON.parse(ops.set[P + "x"]), {
    text: "t",
    files: [],
    snippets: [],
    owner: B,
  });
  assert.deepEqual(ops.remove, []);
  assert.equal(ops.moved, 1);
});

test("a different target alias moves the key", () => {
  const ops = planDraftMoves({
    drafts: { [P + "x"]: draft(A) },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A])],
  });
  assert.equal(JSON.parse(ops.set[P + "y"]).owner, B);
  assert.equal(P + "x" in ops.set, false);
  assert.deepEqual(ops.remove, [P + "x"]);
  assert.equal(ops.moved, 1);
});

test("A's draft overwrites B's draft for the same conversation", () => {
  const ops = planDraftMoves({
    drafts: { [P + "y"]: draft(B, "old"), [P + "x"]: draft(A, "new") },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A], ["y", B])],
  });
  assert.equal(JSON.parse(ops.set[P + "y"]).text, "new");
  assert.equal(JSON.parse(ops.set[P + "y"]).owner, B);
  assert.deepEqual(ops.remove, [P + "x"]);
});

test("without A's draft, B's draft is untouched", () => {
  const ops = planDraftMoves({
    drafts: { [P + "y"]: draft(B, "keep") },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A], ["y", B])],
  });
  assert.deepEqual(ops.set, {});
  assert.deepEqual(ops.remove, []);
  assert.equal(ops.moved, 0);
});

test("two A drafts in one conversation keep the one at the target alias", () => {
  const ops = planDraftMoves({
    drafts: { [P + "x"]: draft(A, "from x"), [P + "y"]: draft(A, "from y") },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A], ["y", A])],
  });
  assert.equal(JSON.parse(ops.set[P + "y"]).text, "from y");
  assert.deepEqual(ops.remove, [P + "x"]);
  assert.equal(ops.moved, 1);
});

test("two A drafts, neither at the target alias, keep the lexically first", () => {
  const ops = planDraftMoves({
    drafts: { [P + "b"]: draft(A, "from b"), [P + "a"]: draft(A, "from a") },
    from: A,
    to: B,
    conversations: [carried("y", ["b", A], ["a", A])],
  });
  assert.equal(JSON.parse(ops.set[P + "y"]).text, "from a");
  assert.deepEqual([...ops.remove].sort(), [P + "a", P + "b"]);
  assert.equal(ops.moved, 1);
});

test("a repeated member does not duplicate or break the plan", () => {
  const ops = planDraftMoves({
    drafts: { [P + "x"]: draft(A), [P + "y"]: draft(A) },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A], ["x", A], ["y", A], ["y", A])],
  });
  assert.deepEqual(Object.keys(ops.set), [P + "y"]);
  assert.deepEqual(ops.remove, [P + "x"]);
  assert.equal(ops.moved, 1);
});

test("another account's drafts and conversations outside the plan are untouched", () => {
  const ops = planDraftMoves({
    drafts: {
      [P + "x"]: draft(C, "theirs"),
      [P + "z"]: draft(A, "elsewhere"),
      "composer-draft:other": draft(A),
    },
    from: A,
    to: B,
    conversations: [carried("x", ["x", A])],
  });
  assert.deepEqual(ops.set, {});
  assert.deepEqual(ops.remove, []);
  assert.equal(ops.moved, 0);
  assert.equal(ops.skipped, 0);
});

test("the new-session draft changes owner only from A", () => {
  const mine = planDraftMoves({
    drafts: { [NEW_SESSION_DRAFT]: draft(A, "hello") },
    from: A,
    to: B,
    conversations: [],
  });
  assert.deepEqual(JSON.parse(mine.set[NEW_SESSION_DRAFT]), {
    text: "hello",
    files: [],
    snippets: [],
    owner: B,
  });
  assert.equal(mine.owned, 1);
  assert.equal(mine.moved, 0);
  assert.deepEqual(mine.remove, []);

  const theirs = planDraftMoves({
    drafts: { [NEW_SESSION_DRAFT]: draft(C) },
    from: A,
    to: B,
    conversations: [],
  });
  assert.deepEqual(theirs.set, {});
  assert.equal(theirs.owned, 0);
});

test("only the owner changes, every other field is kept", () => {
  const value = {
    text: "t",
    files: [{ name: "a.png" }],
    snippets: [{ id: 1 }],
    extra: { nested: true },
    owner: A,
  };
  const ops = planDraftMoves({
    drafts: { [P + "x"]: JSON.stringify(value) },
    from: A,
    to: B,
    conversations: [carried("x", ["x", A])],
  });
  // Compared as strings so the field order is pinned too.
  assert.equal(ops.set[P + "x"], JSON.stringify({ ...value, owner: B }));
});

test("a malformed draft is skipped", () => {
  const bad = [
    "not json",
    JSON.stringify({ text: "t", owner: 7 }),
    JSON.stringify({ text: "t" }),
    JSON.stringify([{ owner: A }]),
    "null",
  ];
  for (const value of bad) {
    const conversation = planDraftMoves({
      drafts: { [P + "x"]: value },
      from: A,
      to: B,
      conversations: [carried("y", ["x", A])],
    });
    assert.deepEqual(conversation.set, {}, value);
    assert.deepEqual(conversation.remove, [], value);
    assert.equal(conversation.moved, 0, value);
    assert.equal(conversation.skipped, 1, value);

    const newSession = planDraftMoves({
      drafts: { [NEW_SESSION_DRAFT]: value },
      from: A,
      to: B,
      conversations: [],
    });
    assert.deepEqual(newSession.set, {}, value);
    assert.equal(newSession.owned, 0, value);
    assert.equal(newSession.skipped, 1, value);
  }
});

test("a malformed draft does not stop a good one in the same conversation", () => {
  const ops = planDraftMoves({
    drafts: { [P + "x"]: "not json", [P + "y"]: draft(A, "good") },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A], ["y", A])],
  });
  assert.equal(JSON.parse(ops.set[P + "y"]).text, "good");
  assert.deepEqual(ops.remove, []);
  assert.equal(ops.moved, 1);
  assert.equal(ops.skipped, 1);
});

test("from === to changes nothing", () => {
  const ops = planDraftMoves({
    drafts: {
      [P + "x"]: draft(A),
      [P + "bad"]: "not json",
      [NEW_SESSION_DRAFT]: draft(A),
    },
    from: A,
    to: A,
    conversations: [carried("y", ["x", A], ["bad", A])],
  });
  assert.deepEqual(ops, {
    set: {},
    remove: [],
    moved: 0,
    owned: 0,
    skipped: 0,
  });
});

test("a malformed draft at the target key leaves the conversation untouched", () => {
  const ops = planDraftMoves({
    drafts: { [P + "y"]: "garbage", [P + "x"]: draft(A, "mine") },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A], ["y", B])],
  });
  assert.deepEqual(ops.set, {});
  assert.deepEqual(ops.remove, []);
  assert.equal(ops.moved, 0);
  assert.equal(ops.skipped, 1);
});

test("a malformed target draft does not hold back another conversation", () => {
  const ops = planDraftMoves({
    drafts: {
      [P + "y"]: "garbage",
      [P + "x"]: draft(A, "stays"),
      [P + "q"]: draft(A, "moves"),
    },
    from: A,
    to: B,
    conversations: [
      carried("y", ["x", A], ["y", B]),
      carried("q", ["q", A]),
    ],
  });
  assert.deepEqual(Object.keys(ops.set), [P + "q"]);
  assert.deepEqual(ops.remove, []);
  assert.equal(ops.moved, 1);
  assert.equal(ops.skipped, 1);
});

test("A's draft overwrites a third account's draft at the target key", () => {
  // The target key is shared by every account that has that alias, so it holds
  // one draft whoever wrote it last.
  const ops = planDraftMoves({
    drafts: { [P + "y"]: draft(C, "theirs"), [P + "x"]: draft(A, "mine") },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A], ["y", B])],
  });
  assert.equal(JSON.parse(ops.set[P + "y"]).text, "mine");
  assert.equal(JSON.parse(ops.set[P + "y"]).owner, B);
  assert.deepEqual(ops.remove, [P + "x"]);
});

test("two carried conversations do not interact", () => {
  const ops = planDraftMoves({
    drafts: {
      [P + "x"]: draft(A, "first"),
      [P + "m"]: draft(A, "second"),
      [P + "n"]: draft(B, "kept"),
    },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A]), carried("n", ["m", A], ["n", B])],
  });
  assert.deepEqual(Object.keys(ops.set).sort(), [P + "n", P + "y"]);
  assert.equal(JSON.parse(ops.set[P + "y"]).text, "first");
  assert.equal(JSON.parse(ops.set[P + "n"]).text, "second");
  assert.deepEqual([...ops.remove].sort(), [P + "m", P + "x"]);
  assert.equal(ops.moved, 2);
  assert.equal(ops.skipped, 0);
});

test("a key written for one conversation is not removed for another", () => {
  // Guards an input the real merge cannot produce: two conversations that share an
  // alias (here `x` is a member of the first and the target of the second).
  const ops = planDraftMoves({
    drafts: { [P + "x"]: draft(A, "one"), [P + "q"]: draft(A, "two") },
    from: A,
    to: B,
    conversations: [carried("y", ["x", A]), carried("x", ["q", A])],
  });
  assert.equal(JSON.parse(ops.set[P + "y"]).text, "one");
  assert.equal(JSON.parse(ops.set[P + "x"]).text, "two");
  assert.deepEqual(ops.remove, [P + "q"]);
  assert.equal(ops.moved, 2);
});

test("the target alias is scanned even when it is not a member", () => {
  const ops = planDraftMoves({
    drafts: { [P + "x"]: draft(A) },
    from: A,
    to: B,
    conversations: [carried("x")],
  });
  assert.equal(JSON.parse(ops.set[P + "x"]).owner, B);
  assert.deepEqual(ops.remove, []);
  assert.equal(ops.moved, 1);
});

// --- Local Storage backup and restore -------------------------------------------

// A fake Claude root and vault, each with the pieces a real LevelDB directory has.
async function storageFixture(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "relay-drafts-store-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "Claude");
  const vault = path.join(base, "desktop-vault");
  const leveldb = path.join(root, LEVELDB);
  await fs.mkdir(path.join(leveldb, "nested"), { recursive: true });
  await fs.mkdir(vault, { recursive: true });
  const files: Record<string, Buffer> = {
    LOCK: Buffer.alloc(0),
    CURRENT: Buffer.from("MANIFEST-000001\n"),
    LOG: Buffer.from("2026/10/16-12:00:00.000 Delete type=3 #1\n"),
    "MANIFEST-000001": Buffer.from([0, 255, 1, 254, 2, 253, 0, 0]),
    "000003.log": randomBytes(4096),
    // A few MB, so a short or truncated copy cannot pass by accident.
    "000005.ldb": randomBytes(3 * 1024 * 1024),
    "nested/inner.bin": randomBytes(777),
    "nested/empty": Buffer.alloc(0),
  };
  for (const [name, bytes] of Object.entries(files))
    await fs.writeFile(path.join(leveldb, name), bytes);
  return { base, root, vault, leveldb, files };
}

// Every entry under `dir`, relative, with its bytes (files) or null (directories).
async function snapshot(dir: string) {
  const out: Record<string, string | null> = {};
  async function walk(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[rel] = null;
        await walk(full);
      } else {
        assert.ok(entry.isFile(), `${rel} is a plain file`);
        out[rel] = (await fs.readFile(full)).toString("base64");
      }
    }
  }
  await walk(dir);
  return out;
}

test("a backup is a byte-exact copy", async (t) => {
  const { root, vault, leveldb, files } = await storageFixture(t);
  const now = new Date("2026-10-16T09:08:07.654Z");
  const backup = await backupLocalStorage(root, vault, now);
  assert.equal(backup, path.join(vault, "drafts", "2026-10-16T09-08-07-654Z"));
  const copy = path.join(backup!, "leveldb");
  assert.deepEqual(await snapshot(copy), await snapshot(leveldb));
  assert.equal((await fs.stat(path.join(copy, "LOCK"))).size, 0);
  assert.equal((await fs.stat(path.join(copy, "nested/empty"))).size, 0);
  for (const [name, bytes] of Object.entries(files))
    assert.deepEqual(await fs.readFile(path.join(copy, name)), bytes, name);
  // The source is untouched.
  assert.equal(
    (await fs.readFile(path.join(leveldb, "000005.ldb"))).length,
    3 * 1024 * 1024,
  );
  // The vault directories are private to Relay.
  for (const dir of [path.join(vault, "drafts"), backup!])
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, dir);
});

test("restore puts the backup back exactly", async (t) => {
  const { root, vault, leveldb } = await storageFixture(t);
  const backup = (await backupLocalStorage(root, vault, new Date()))!;
  const before = await snapshot(leveldb);
  // What a helper that died mid-write could leave behind.
  await fs.writeFile(path.join(leveldb, "000005.ldb"), "truncated");
  await fs.writeFile(path.join(leveldb, "CURRENT"), "MANIFEST-000009\n");
  await fs.writeFile(path.join(leveldb, "000009.log"), "new");
  await fs.writeFile(path.join(leveldb, "nested/added"), "new");
  await fs.rm(path.join(leveldb, "LOCK"));
  await fs.rm(path.join(leveldb, "nested/inner.bin"));
  assert.notDeepEqual(await snapshot(leveldb), before);

  await restoreLocalStorage(root, backup);

  assert.deepEqual(await snapshot(leveldb), before);
  assert.equal((await fs.stat(path.join(leveldb, "LOCK"))).size, 0);
  // Nothing else is left in Local Storage beside leveldb.
  assert.deepEqual(await fs.readdir(path.join(root, LOCAL_STORAGE)), [
    "leveldb",
  ]);
  // The backup itself is still there to restore again.
  assert.deepEqual(await snapshot(path.join(backup, "leveldb")), before);
});

test("restore recreates a leveldb directory that is gone", async (t) => {
  const { root, vault, leveldb } = await storageFixture(t);
  const backup = (await backupLocalStorage(root, vault, new Date()))!;
  const before = await snapshot(leveldb);
  await fs.rm(path.join(root, LOCAL_STORAGE), { recursive: true });
  await restoreLocalStorage(root, backup);
  assert.deepEqual(await snapshot(leveldb), before);
});

test("restore from a backup without leveldb leaves the live directory alone", async (t) => {
  const { root, vault, leveldb, base } = await storageFixture(t);
  const before = await snapshot(leveldb);
  await assert.rejects(
    restoreLocalStorage(root, path.join(vault, "drafts", "nope")),
  );
  const empty = path.join(base, "empty-backup");
  await fs.mkdir(empty);
  await assert.rejects(restoreLocalStorage(root, empty));
  assert.deepEqual(await snapshot(leveldb), before);
});

test("restore refuses a backup whose leveldb is a symlink", async (t) => {
  const { root, leveldb, base } = await storageFixture(t);
  const before = await snapshot(leveldb);
  const backup = path.join(base, "linked-backup");
  await fs.mkdir(backup);
  await fs.symlink(leveldb, path.join(backup, "leveldb"));
  await assert.rejects(restoreLocalStorage(root, backup));
  assert.deepEqual(await snapshot(leveldb), before);
});

test("restore refuses a symlinked Local Storage", async (t) => {
  const { root, vault, base } = await storageFixture(t);
  const backup = (await backupLocalStorage(root, vault, new Date()))!;
  const elsewhere = path.join(base, "elsewhere");
  await fs.mkdir(path.join(elsewhere, "leveldb"), { recursive: true });
  await fs.writeFile(path.join(elsewhere, "leveldb", "keep"), "mine");
  await fs.rm(path.join(root, LOCAL_STORAGE), { recursive: true });
  await fs.symlink(elsewhere, path.join(root, LOCAL_STORAGE));
  await assert.rejects(restoreLocalStorage(root, backup));
  assert.equal(
    await fs.readFile(path.join(elsewhere, "leveldb", "keep"), "utf8"),
    "mine",
  );
});

test("restore refuses a backup directory that is a symlink", async (t) => {
  const { root, vault, leveldb, base } = await storageFixture(t);
  const backup = (await backupLocalStorage(root, vault, new Date()))!;
  await fs.writeFile(path.join(leveldb, "CURRENT"), "changed\n");
  const before = await snapshot(leveldb);
  const link = path.join(base, "backup-link");
  await fs.symlink(backup, link);
  await assert.rejects(restoreLocalStorage(root, link));
  assert.deepEqual(await snapshot(leveldb), before);
});

test("a relative symlink stays relative in the backup and after a restore", async (t) => {
  const { root, vault, leveldb } = await storageFixture(t);
  await fs.symlink("LOCK", path.join(leveldb, "link"));
  const backup = (await backupLocalStorage(root, vault, new Date()))!;
  assert.equal(await fs.readlink(path.join(backup, "leveldb", "link")), "LOCK");
  await fs.rm(path.join(leveldb, "link"));
  await restoreLocalStorage(root, backup);
  assert.equal(await fs.readlink(path.join(leveldb, "link")), "LOCK");
});

// A root user ignores file modes, so the chmod-based tests prove nothing there.
const needsPermissions = {
  skip: process.getuid?.() === 0 && "root can read a mode 0 file",
};

test(
  "restore from an unreadable backup leaves the live directory alone",
  needsPermissions,
  async (t) => {
    const { root, vault, leveldb } = await storageFixture(t);
    const backup = (await backupLocalStorage(root, vault, new Date()))!;
    await fs.writeFile(path.join(leveldb, "CURRENT"), "changed since\n");
    const before = await snapshot(leveldb);
    const file = path.join(backup, "leveldb", "000003.log");
    await fs.chmod(file, 0);
    try {
      await assert.rejects(restoreLocalStorage(root, backup), {
        code: "EACCES",
      });
    } finally {
      await fs.chmod(file, 0o600);
    }
    assert.deepEqual(await snapshot(leveldb), before);
    // The half-made copy is gone too.
    assert.deepEqual(await fs.readdir(path.join(root, LOCAL_STORAGE)), [
      "leveldb",
    ]);
  },
);

test(
  "an unreadable leveldb file fails the backup and leaves no stamp directory",
  needsPermissions,
  async (t) => {
    const { root, vault, leveldb } = await storageFixture(t);
    const file = path.join(leveldb, "000003.log");
    await fs.chmod(file, 0);
    try {
      await assert.rejects(backupLocalStorage(root, vault, new Date()), {
        code: "EACCES",
      });
    } finally {
      await fs.chmod(file, 0o600);
    }
    assert.deepEqual(await fs.readdir(path.join(vault, "drafts")), []);
  },
);

// A `rename` that fails on the given calls (1-based) and otherwise works.
function renameFailingOn(...failing: number[]) {
  let calls = 0;
  const rename: typeof fs.rename = async (from, to) => {
    calls += 1;
    if (failing.includes(calls))
      throw Object.assign(new Error(`injected failure ${calls}`), {
        code: "EIO",
      });
    return fs.rename(from, to);
  };
  return { ops: { rename }, calls: () => calls };
}

async function changedLive(t: any) {
  const fx = await storageFixture(t);
  const backup = (await backupLocalStorage(fx.root, fx.vault, new Date()))!;
  const backedUp = await snapshot(fx.leveldb);
  // What the helper left behind: live no longer matches the backup.
  await fs.writeFile(path.join(fx.leveldb, "000005.ldb"), "half written");
  await fs.writeFile(path.join(fx.leveldb, "000009.log"), "new");
  await fs.rm(path.join(fx.leveldb, "LOCK"));
  return { ...fx, backup, backedUp, damaged: await snapshot(fx.leveldb) };
}

test("a failure moving the live directory aside leaves it as it was", async (t) => {
  const { root, leveldb, backup, damaged } = await changedLive(t);
  const seam = renameFailingOn(1);
  await assert.rejects(restoreLocalStorage(root, backup, seam.ops), {
    message: "injected failure 1",
  });
  assert.equal(seam.calls(), 1);
  assert.deepEqual(await snapshot(leveldb), damaged);
  assert.deepEqual(await fs.readdir(path.join(root, LOCAL_STORAGE)), [
    "leveldb",
  ]);
});

test("a failure putting the copy in place puts the original back", async (t) => {
  const { root, leveldb, backup, damaged } = await changedLive(t);
  const seam = renameFailingOn(2);
  await assert.rejects(restoreLocalStorage(root, backup, seam.ops), {
    message: "injected failure 2",
  });
  assert.equal(seam.calls(), 3); // aside, copy in (fails), original back
  assert.deepEqual(await snapshot(leveldb), damaged);
  // Neither the copy nor the old directory is left beside it.
  assert.deepEqual(await fs.readdir(path.join(root, LOCAL_STORAGE)), [
    "leveldb",
  ]);
});

test("a failed put-back does not hide the error, and the next restore recovers", async (t) => {
  const { root, leveldb, backup, backedUp, damaged } = await changedLive(t);
  const storage = path.join(root, LOCAL_STORAGE);
  const seam = renameFailingOn(2, 3);
  await assert.rejects(restoreLocalStorage(root, backup, seam.ops), {
    message: "injected failure 2",
  });
  // Live is gone, but the original is intact beside it and the copy is deleted.
  const names = await fs.readdir(storage);
  assert.equal(names.length, 1);
  assert.match(names[0], /^leveldb\.relay-old-/);
  const old = path.join(storage, names[0]);
  assert.deepEqual(await snapshot(old), damaged);

  // Live was missing, so the only copy of the original is not swept away.
  await restoreLocalStorage(root, backup);
  assert.deepEqual(await snapshot(leveldb), backedUp);
  assert.deepEqual(await snapshot(old), damaged);
  // Once live is in place again, the next restore sweeps it.
  await restoreLocalStorage(root, backup);
  assert.deepEqual(await fs.readdir(storage), ["leveldb"]);
});

test("a restore with no live leveldb leaves a leftover sibling alone", async (t) => {
  const { root, leveldb, vault } = await storageFixture(t);
  const backup = (await backupLocalStorage(root, vault, new Date()))!;
  const backedUp = await snapshot(leveldb);
  const storage = path.join(root, LOCAL_STORAGE);
  // The only on-disk copy of something, left beside a leveldb that is gone.
  const leftover = path.join(storage, "leveldb.relay-old-0123");
  await fs.rename(leveldb, leftover);
  await fs.mkdir(path.join(storage, "leveldb.relay-4567"));

  await restoreLocalStorage(root, backup);

  assert.deepEqual(await snapshot(leveldb), backedUp);
  assert.deepEqual(await snapshot(leftover), backedUp);
  assert.deepEqual((await fs.readdir(storage)).sort(), [
    "leveldb",
    "leveldb.relay-4567",
    "leveldb.relay-old-0123",
  ]);
});

test(
  "a live directory that cannot be fully deleted is still replaced whole",
  needsPermissions,
  async (t) => {
    const { root, leveldb, backup, backedUp } = await changedLive(t);
    const storage = path.join(root, LOCAL_STORAGE);
    // A read-only subdirectory makes a recursive delete fail partway through.
    const locked = path.join(leveldb, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "inside"), "x");
    await fs.chmod(locked, 0o555);
    // So the temp dir can be removed wherever the directory ended up.
    const unlock = async () => {
      for (const name of await fs.readdir(storage))
        await fs
          .chmod(path.join(storage, name, "locked"), 0o755)
          .catch(() => {});
    };
    try {
      await restoreLocalStorage(root, backup);
      // Live is complete, even though the old directory could not be deleted.
      assert.deepEqual(await snapshot(leveldb), backedUp);
      const stray = (await fs.readdir(storage)).filter((n) => n !== "leveldb");
      assert.equal(stray.length, 1);
      assert.match(stray[0], /^leveldb\.relay-old-/);
    } finally {
      await unlock();
    }
    // The next restore sweeps the stray directory.
    await restoreLocalStorage(root, backup);
    assert.deepEqual(await snapshot(leveldb), backedUp);
    assert.deepEqual(await fs.readdir(storage), ["leveldb"]);
  },
);

test("a missing leveldb gives no backup", async (t) => {
  const { root, vault } = await storageFixture(t);
  await fs.rm(path.join(root, LEVELDB), { recursive: true });
  assert.equal(await backupLocalStorage(root, vault, new Date()), undefined);
  await fs.rm(path.join(root, LOCAL_STORAGE), { recursive: true });
  assert.equal(await backupLocalStorage(root, vault, new Date()), undefined);
  await fs.rm(root, { recursive: true });
  assert.equal(await backupLocalStorage(root, vault, new Date()), undefined);
  // A fresh install leaves no stray directories in the vault either.
  assert.deepEqual(await fs.readdir(vault), []);
});

test("a symlinked Local Storage or leveldb is refused", async (t) => {
  const { root, vault, base } = await storageFixture(t);
  const real = path.join(base, "real");
  await fs.rename(path.join(root, LEVELDB), real);
  await fs.symlink(real, path.join(root, LEVELDB));
  await assert.rejects(backupLocalStorage(root, vault, new Date()));

  await fs.rm(path.join(root, LOCAL_STORAGE), { recursive: true });
  const realStorage = path.join(base, "real-storage");
  await fs.mkdir(path.join(realStorage, "leveldb"), { recursive: true });
  await fs.symlink(realStorage, path.join(root, LOCAL_STORAGE));
  await assert.rejects(backupLocalStorage(root, vault, new Date()));
  assert.deepEqual(await fs.readdir(vault), []);
});

test("a leveldb that is not a directory is refused", async (t) => {
  const { root, vault } = await storageFixture(t);
  await fs.rm(path.join(root, LEVELDB), { recursive: true });
  await fs.writeFile(path.join(root, LEVELDB), "not a directory");
  await assert.rejects(backupLocalStorage(root, vault, new Date()));
  assert.deepEqual(await fs.readdir(vault), []);
});

test("a second backup in the same millisecond does not overwrite the first", async (t) => {
  const { root, vault } = await storageFixture(t);
  const now = new Date("2026-10-16T09:08:07.654Z");
  const first = (await backupLocalStorage(root, vault, now))!;
  const before = await snapshot(first);
  await assert.rejects(backupLocalStorage(root, vault, now));
  assert.deepEqual(await snapshot(first), before);
});

test("only the three newest backups stay", async (t) => {
  const { root, vault } = await storageFixture(t);
  // Out of order on purpose: pruning goes by the stamp, not by creation order.
  for (const day of [3, 1, 5, 2, 4])
    await backupLocalStorage(root, vault, new Date(Date.UTC(2026, 9, day, 12)));
  const drafts = path.join(vault, "drafts");
  await fs.writeFile(path.join(drafts, "last.json"), "{}");
  await fs.mkdir(path.join(drafts, "scratch"));
  await fs.writeFile(path.join(vault, "journal.json"), "[]");
  await fs.mkdir(path.join(vault, "backups", "2026-01-01T00-00-00-000Z"), {
    recursive: true,
  });

  await pruneDraftBackups(vault);

  assert.deepEqual((await fs.readdir(drafts)).sort(), [
    "2026-10-03T12-00-00-000Z",
    "2026-10-04T12-00-00-000Z",
    "2026-10-05T12-00-00-000Z",
    "last.json",
    "scratch",
  ]);
  assert.equal(await fs.readFile(path.join(drafts, "last.json"), "utf8"), "{}");
  // Nothing outside <vault>/drafts is touched.
  assert.deepEqual((await fs.readdir(vault)).sort(), [
    "backups",
    "drafts",
    "journal.json",
  ]);
  assert.deepEqual(await fs.readdir(path.join(vault, "backups")), [
    "2026-01-01T00-00-00-000Z",
  ]);
  // The surviving backups are whole.
  const kept = path.join(drafts, "2026-10-05T12-00-00-000Z", "leveldb");
  assert.equal(
    (await fs.stat(path.join(kept, "000005.ldb"))).size,
    3 * 1024 * 1024,
  );
});

test("pruning keeps what is under the limit and honours a smaller one", async (t) => {
  const { root, vault } = await storageFixture(t);
  await backupLocalStorage(root, vault, new Date("2026-10-01T00:00:00.000Z"));
  await backupLocalStorage(root, vault, new Date("2026-10-02T00:00:00.000Z"));
  await pruneDraftBackups(vault);
  assert.equal((await fs.readdir(path.join(vault, "drafts"))).length, 2);
  await pruneDraftBackups(vault, 1);
  assert.deepEqual(await fs.readdir(path.join(vault, "drafts")), [
    "2026-10-02T00-00-00-000Z",
  ]);
});

test("pruning a vault without drafts does nothing", async (t) => {
  const { vault } = await storageFixture(t);
  await pruneDraftBackups(vault);
  assert.deepEqual(await fs.readdir(vault), []);
});

test("pruning never follows a symlink that looks like a backup", async (t) => {
  const { vault, base } = await storageFixture(t);
  const drafts = path.join(vault, "drafts");
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "precious"), "mine");
  await fs.mkdir(drafts);
  for (const day of [1, 2, 3, 4])
    await fs.mkdir(path.join(drafts, `2026-10-0${day}T12-00-00-000Z`));
  // The newest stamp of all, so if it counted as a backup it would push a real
  // one out of the three kept, and it would be among those removed when it did not.
  const link = "2026-11-01T12-00-00-000Z";
  await fs.symlink(outside, path.join(drafts, link));
  await pruneDraftBackups(vault);
  assert.equal(
    await fs.readFile(path.join(outside, "precious"), "utf8"),
    "mine",
  );
  // The link itself is not a backup, so it is neither counted nor removed.
  assert.equal(
    (await fs.lstat(path.join(drafts, link))).isSymbolicLink(),
    true,
  );
  assert.deepEqual((await fs.readdir(drafts)).sort(), [
    "2026-10-02T12-00-00-000Z",
    "2026-10-03T12-00-00-000Z",
    "2026-10-04T12-00-00-000Z",
    link,
  ]);
});

test("pruning orders stamps across a year boundary and by the millisecond", async (t) => {
  const { root, vault } = await storageFixture(t);
  const drafts = path.join(vault, "drafts");
  const at = (iso: string) => backupLocalStorage(root, vault, new Date(iso));
  await at("2025-12-31T23:59:59.999Z");
  await at("2026-01-01T00:00:00.000Z");
  await pruneDraftBackups(vault, 1);
  assert.deepEqual(await fs.readdir(drafts), ["2026-01-01T00-00-00-000Z"]);

  await at("2026-10-16T08:00:00.000Z");
  await at("2026-10-16T08:00:00.001Z");
  await at("2026-10-16T07:59:59.999Z");
  await pruneDraftBackups(vault, 2);
  assert.deepEqual((await fs.readdir(drafts)).sort(), [
    "2026-10-16T08-00-00-000Z",
    "2026-10-16T08-00-00-001Z",
  ]);
});

test("a symlinked drafts directory is refused by backup and prune", async (t) => {
  const { root, vault, base } = await storageFixture(t);
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(outside, "2026-10-01T12-00-00-000Z"), {
    recursive: true,
  });
  await fs.symlink(outside, path.join(vault, "drafts"));
  await assert.rejects(backupLocalStorage(root, vault, new Date()));
  await assert.rejects(pruneDraftBackups(vault, 0));
  assert.deepEqual(await fs.readdir(outside), ["2026-10-01T12-00-00-000Z"]);
});

test("the job flag's value is the path after it", () => {
  assert.equal(DRAFT_WORKER_FLAG, "--relay-draft-worker=");
  assert.equal(
    draftJobPath(["/Relay", `${DRAFT_WORKER_FLAG}/tmp/relay-job/job.json`]),
    "/tmp/relay-job/job.json",
  );
  // A dev launch passes the script first; a path may contain "=".
  assert.equal(
    draftJobPath([
      "electron",
      "draft-worker.cjs",
      `${DRAFT_WORKER_FLAG}/a=b/job.json`,
    ]),
    "/a=b/job.json",
  );
});

test("no job flag means this is the normal app", () => {
  assert.equal(draftJobPath([]), undefined);
  assert.equal(
    draftJobPath(["/Relay", "--inspect", "/tmp/job.json"]),
    undefined,
  );
  assert.equal(
    draftJobPath(["/Relay", "--relay-draft-worker-other=/tmp/job.json"]),
    undefined,
  );
});

test("a job flag with an empty value is ignored", () => {
  assert.equal(draftJobPath(["/Relay", DRAFT_WORKER_FLAG]), undefined);
  assert.equal(
    draftJobPath([
      "/Relay",
      DRAFT_WORKER_FLAG,
      `${DRAFT_WORKER_FLAG}/tmp/job.json`,
    ]),
    "/tmp/job.json",
  );
});

// A job whose storage is never opened: runDraftJob only talks to the page.
const ALIAS_X = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ALIAS_Y = "bbbbbbbb-0000-4000-8000-0000000000b2";
function job(): DraftJob {
  return {
    storage: "/claude/Local Storage",
    scratch: "/tmp/relay-draft-job",
    result: "/tmp/relay-draft-job/result.json",
    from: A,
    to: B,
    conversations: [
      {
        targetAlias: ALIAS_Y,
        members: [
          { alias: ALIAS_X, accountUuid: A },
          { alias: ALIAS_Y, accountUuid: B },
        ],
      },
    ],
  };
}

// A page backed by a plain object, recording what the runner asks of it. `stuck` keys ignore
// being set or removed, like a write that never reached storage. `size` is how many keys the
// whole origin holds: Claude keeps plenty besides drafts, so it defaults to a non-empty origin.
function fakePage(
  initial: Record<string, string>,
  options: {
    stuck?: string[];
    size?: number;
    failAt?: "size" | "read" | "apply" | "flush";
    failWith?: unknown;
  } = {},
) {
  const store = { ...initial };
  const calls: string[] = [];
  const applied: unknown[] = [];
  const stuck = new Set(options.stuck ?? []);
  const trip = (at: "size" | "read" | "apply" | "flush") => {
    if (options.failAt === at)
      throw "failWith" in options
        ? options.failWith
        : new Error(`${at} failed`);
  };
  const page: DraftPage = {
    async size() {
      calls.push("size");
      trip("size");
      return options.size ?? Object.keys(store).length + 2;
    },
    async read() {
      calls.push("read");
      trip("read");
      return { ...store };
    },
    async apply(ops) {
      calls.push("apply");
      applied.push(ops);
      trip("apply");
      for (const [key, value] of Object.entries(ops.set))
        if (!stuck.has(key)) store[key] = value;
      for (const key of ops.remove) if (!stuck.has(key)) delete store[key];
    },
    async flush() {
      calls.push("flush");
      trip("flush");
    },
  };
  return { page, store, calls, applied };
}

test("the job applies the planned ops and reports the counts", async () => {
  const j = job();
  const initial = {
    [P + ALIAS_X]: draft(A, "from A"),
    [P + ALIAS_Y]: draft(B, "B's own"),
    "composer-draft:other-surface": draft(A, "never touched"),
  };
  const fake = fakePage(initial);
  const result = await runDraftJob(j, fake.page);
  assert.deepEqual(result, { ok: true, moved: 1, owned: 0, skipped: 0 });
  const planned = planDraftMoves({
    drafts: initial,
    from: A,
    to: B,
    conversations: j.conversations,
  });
  assert.equal(fake.applied.length, 1);
  assert.deepEqual(fake.applied[0], planned);
  assert.deepEqual(fake.store, {
    [P + ALIAS_Y]: draft(B, "from A"),
    "composer-draft:other-surface": draft(A, "never touched"),
  });
  // Check the origin has data, read, change, persist, then read again to verify.
  assert.deepEqual(fake.calls, ["size", "read", "apply", "flush", "read"]);
});

test("the new-session draft is counted as owned", async () => {
  const fake = fakePage({ [NEW_SESSION_DRAFT]: draft(A) });
  assert.deepEqual(await runDraftJob(job(), fake.page), {
    ok: true,
    moved: 0,
    owned: 1,
    skipped: 0,
  });
  assert.equal(fake.store[NEW_SESSION_DRAFT], draft(B));
});

test("with nothing to change the job applies nothing and is still ok", async () => {
  const fake = fakePage({
    [P + ALIAS_X]: draft(C),
    [P + ALIAS_Y]: "not json",
  });
  const before = { ...fake.store };
  const result = await runDraftJob(job(), fake.page);
  assert.deepEqual(result, { ok: true, moved: 0, owned: 0, skipped: 1 });
  assert.ok(!fake.calls.includes("apply"));
  assert.deepEqual(fake.store, before);
  // No drafts at all is not an error either.
  const empty = fakePage({});
  assert.deepEqual(await runDraftJob(job(), empty.page), {
    ok: true,
    moved: 0,
    owned: 0,
    skipped: 0,
  });
  assert.ok(!empty.calls.includes("apply"));
});

test("an empty origin is a failure, not a success", async () => {
  // Chromium rebuilt or could not open Claude's database: nothing to move, and nothing to trust.
  const fake = fakePage({}, { size: 0 });
  assert.deepEqual(await runDraftJob(job(), fake.page), {
    ok: false,
    error: "Claude's Local Storage opened empty",
  });
  assert.equal(EMPTY_STORAGE, "Claude's Local Storage opened empty");
  // The helper stops there: it reads and writes nothing.
  assert.deepEqual(fake.calls, ["size"]);
});

test("a value that did not stick fails verification", async () => {
  const fake = fakePage(
    { [P + ALIAS_X]: draft(A), [NEW_SESSION_DRAFT]: draft(A) },
    { stuck: [NEW_SESSION_DRAFT] },
  );
  assert.deepEqual(await runDraftJob(job(), fake.page), {
    ok: false,
    error: "verification failed",
  });
});

test("a key that was not removed fails verification", async () => {
  const fake = fakePage({ [P + ALIAS_X]: draft(A) }, { stuck: [P + ALIAS_X] });
  assert.deepEqual(await runDraftJob(job(), fake.page), {
    ok: false,
    error: "verification failed",
  });
});

test("a page that throws is reported, not thrown", async () => {
  for (const failAt of ["size", "read", "apply", "flush"] as const) {
    const fake = fakePage({ [P + ALIAS_X]: draft(A) }, { failAt });
    assert.deepEqual(
      await runDraftJob(job(), fake.page),
      { ok: false, error: `${failAt} failed` },
      failAt,
    );
  }
  // Something that is not an Error still becomes a message.
  const odd = fakePage({}, { failAt: "read", failWith: "plain string" });
  assert.deepEqual(await runDraftJob(job(), odd.page), {
    ok: false,
    error: "plain string",
  });
});

test("Local Storage is opened only when it and its leveldb are real directories", async (t) => {
  const { root, base, leveldb } = await storageFixture(t);
  const storage = path.join(root, LOCAL_STORAGE);
  assert.doesNotThrow(() => assertLocalStorage(storage));

  // Missing: Chromium would create it inside Claude's directory.
  assert.throws(
    () => assertLocalStorage(path.join(base, "nowhere")),
    /Local Storage is not a real directory/,
  );
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(outside, "leveldb"), { recursive: true });
  const link = path.join(base, "link");
  await fs.symlink(outside, link);
  assert.throws(() => assertLocalStorage(link), /Local Storage is not a real/);
  const plain = path.join(base, "plain-file");
  await fs.writeFile(plain, "x");
  assert.throws(() => assertLocalStorage(plain), /Local Storage is not a real/);

  // A Local Storage without a leveldb, a linked leveldb, a leveldb that is a file.
  const bare = path.join(base, "bare");
  await fs.mkdir(bare);
  assert.throws(
    () => assertLocalStorage(bare),
    /Local Storage\/leveldb is not a real directory/,
  );
  await fs.symlink(leveldb, path.join(bare, "leveldb"));
  assert.throws(() => assertLocalStorage(bare), /leveldb is not a real/);
  const filed = path.join(base, "filed");
  await fs.mkdir(filed);
  await fs.writeFile(path.join(filed, "leveldb"), "x");
  assert.throws(() => assertLocalStorage(filed), /leveldb is not a real/);
  // Nothing was created or changed by the checks.
  assert.deepEqual(await fs.readdir(bare), ["leveldb"]);
  assert.deepEqual(await fs.readdir(outside), ["leveldb"]);
});

test("a job file is checked before the helper uses it", () => {
  const good = { ...job() };
  assert.deepEqual(parseDraftJob(JSON.parse(JSON.stringify(good))), good);
  // Unknown fields are not carried along.
  assert.deepEqual(parseDraftJob({ ...good, extra: 1 }), good);
  const bad = (change: Record<string, unknown>) =>
    assert.throws(() => parseDraftJob({ ...good, ...change }), Error);
  for (const key of ["storage", "scratch", "result", "from", "to"]) {
    bad({ [key]: undefined });
    bad({ [key]: "" });
    bad({ [key]: 7 });
  }
  // Relative paths would resolve against whatever directory the helper starts in.
  for (const key of ["storage", "scratch", "result"])
    bad({ [key]: "relative/dir" });
  bad({ conversations: undefined });
  bad({ conversations: {} });
  bad({ conversations: [null] });
  bad({ conversations: [{ targetAlias: ALIAS_Y }] });
  bad({ conversations: [{ targetAlias: "", members: [] }] });
  bad({
    conversations: [{ targetAlias: ALIAS_Y, members: [{ alias: ALIAS_X }] }],
  });
  bad({
    conversations: [
      { targetAlias: ALIAS_Y, members: [{ alias: 1, accountUuid: A }] },
    ],
  });
  for (const value of [null, undefined, "job", 3, []])
    assert.throws(() => parseDraftJob(value), Error);
  assert.deepEqual(parseDraftJob({ ...good, conversations: [] }), {
    ...good,
    conversations: [],
  });
});

test("the build bundles the entry and the helper", async () => {
  const build = await fs.readFile(
    path.join(import.meta.dirname, "../scripts/build.mjs"),
    "utf8",
  );
  const list = /entryPoints:\s*\[([^\]]*)\]/.exec(build)?.[1] ?? "";
  const entries = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const entry of [
    "electron/main.ts",
    "electron/preload.ts",
    "electron/switch-preload.ts",
    "electron/entry.ts",
    "electron/draft-worker.ts",
  ])
    assert.ok(entries.includes(entry), `${entry} is built`);
});

test("the package runs the entry", async () => {
  const pkg = JSON.parse(
    await fs.readFile(
      path.join(import.meta.dirname, "../package.json"),
      "utf8",
    ),
  );
  assert.equal(pkg.main, "dist-electron/entry.cjs");
});

// --- The draft step of a switch ---------------------------------------------------

const NOW = new Date("2026-10-16T10:00:00.000Z");
const NOW_STAMP = "2026-10-16T10-00-00-000Z";

// The backup directories under <vault>/drafts, oldest first.
async function backupsIn(vault: string) {
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(vault, "drafts"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort();
}

async function lastOutcome(vault: string) {
  return JSON.parse(
    await fs.readFile(path.join(vault, "drafts", "last.json"), "utf8"),
  );
}

// A stand-in for the helper: it leaves its scratch dir the way the real one does (a root
// whose "Local Storage" links to Claude's, and a userData), then does `effect` and answers.
// The default answer carries a stray `text` field, which must never reach last.json.
function fakeRun(
  effect?: (job: DraftJob) => Promise<DraftResult | void>,
  answer = {
    ok: true,
    moved: 1,
    owned: 1,
    skipped: 0,
    text: "an unsent draft",
  } as DraftResult,
) {
  const jobs: DraftJob[] = [];
  const run = async (job: DraftJob): Promise<DraftResult> => {
    jobs.push(job);
    await fs.mkdir(path.join(job.scratch, "root"), { recursive: true });
    await fs.symlink(
      job.storage,
      path.join(job.scratch, "root", "Local Storage"),
    );
    await fs.mkdir(path.join(job.scratch, "userData"), { recursive: true });
    await fs.writeFile(path.join(job.scratch, "userData", "Preferences"), "{}");
    return (await effect?.(job)) ?? answer;
  };
  return { run, jobs };
}

function transfer(
  fx: { root: string; vault: string },
  run: (job: DraftJob) => Promise<DraftResult>,
  extra: { now?: Date; blocked?: string } = {},
) {
  return preserveDrafts({
    root: fx.root,
    vault: fx.vault,
    from: A,
    to: B,
    conversations: [carried(ALIAS_X, [ALIAS_X, A], [ALIAS_X, B])],
    run,
    now: NOW,
    ...extra,
  });
}

async function assertGone(target: string) {
  await assert.rejects(fs.lstat(target), { code: "ENOENT" }, target);
}

test("a successful run reports moved and keeps a backup", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun();

  const outcome = await transfer(fx, run);

  assert.deepEqual(outcome, {
    status: "moved",
    moved: 1,
    owned: 1,
    skipped: 0,
  });
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.storage, path.join(fx.root, LOCAL_STORAGE));
  assert.equal(path.dirname(job.scratch), os.tmpdir());
  assert.equal(job.result, path.join(job.scratch, "result.json"));
  assert.equal(job.from, A);
  assert.equal(job.to, B);
  assert.deepEqual(job.conversations, [
    carried(ALIAS_X, [ALIAS_X, A], [ALIAS_X, B]),
  ]);
  assert.deepEqual(await backupsIn(fx.vault), [NOW_STAMP]);
  assert.deepEqual(
    await snapshot(path.join(fx.vault, "drafts", NOW_STAMP, "leveldb")),
    before,
  );
  // The scratch dir is gone, and removing it did not follow its link into Claude's data.
  await assertGone(job.scratch);
  assert.deepEqual(await snapshot(fx.leveldb), before);

  const last = await lastOutcome(fx.vault);
  assert.deepEqual(last, {
    at: NOW.toISOString(),
    from: A,
    to: B,
    status: "moved",
    moved: 1,
    owned: 1,
    skipped: 0,
  });
  const raw = await fs.readFile(
    path.join(fx.vault, "drafts", "last.json"),
    "utf8",
  );
  assert.ok(!raw.includes("text"), raw);
  assert.ok(!raw.includes("an unsent draft"), raw);
});

test("a failed run restores Local Storage byte for byte", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun(async (job) => {
    const leveldb = path.join(job.storage, "leveldb");
    await fs.writeFile(path.join(leveldb, "000005.ldb"), "half written");
    await fs.writeFile(path.join(leveldb, "000009.log"), "new");
    await fs.rm(path.join(leveldb, "LOCK"));
    return { ok: false, error: "verification failed" };
  });

  const outcome = await transfer(fx, run);

  assert.deepEqual(outcome, {
    status: "failed",
    error: "verification failed",
    restored: true,
  });
  assert.deepEqual(await snapshot(fx.leveldb), before);
  assert.deepEqual(await fs.readdir(path.join(fx.root, LOCAL_STORAGE)), [
    "leveldb",
  ]);
  // The backup stays, in case it is ever needed by hand.
  assert.deepEqual(await backupsIn(fx.vault), [NOW_STAMP]);
  await assertGone(jobs[0].scratch);
  assert.deepEqual(await lastOutcome(fx.vault), {
    at: NOW.toISOString(),
    from: A,
    to: B,
    status: "failed",
    error: "verification failed",
    restored: true,
  });
});

test("a throwing run is a failed outcome", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun(async (job) => {
    await fs.writeFile(
      path.join(job.storage, "leveldb", "CURRENT"),
      "MANIFEST-000099\n",
    );
    throw new Error("helper crashed");
  });

  const outcome = await transfer(fx, run);

  assert.deepEqual(outcome, {
    status: "failed",
    error: "helper crashed",
    restored: true,
  });
  assert.deepEqual(await snapshot(fx.leveldb), before);
  await assertGone(jobs[0].scratch);
  assert.equal((await lastOutcome(fx.vault)).status, "failed");
});

test("a run that answers nothing is a failure and is restored", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun(async (job) => {
    await fs.writeFile(path.join(job.storage, "leveldb", "CURRENT"), "x");
  });
  const shrug = async (job: DraftJob) => {
    await run(job);
    return undefined as unknown as DraftResult;
  };

  assert.deepEqual(await transfer(fx, shrug), {
    status: "failed",
    error: "no result",
    restored: true,
  });
  assert.deepEqual(await snapshot(fx.leveldb), before);
  await assertGone(jobs[0].scratch);
});

test("no Local Storage → skipped, run not called", async (t) => {
  const fx = await storageFixture(t);
  await fs.rm(fx.leveldb, { recursive: true });
  const { run, jobs } = fakeRun();

  const outcome = await transfer(fx, run);

  assert.deepEqual(outcome, { status: "skipped", reason: "no Local Storage" });
  assert.equal(jobs.length, 0);
  assert.deepEqual(await backupsIn(fx.vault), []);
  assert.deepEqual(await lastOutcome(fx.vault), {
    at: NOW.toISOString(),
    from: A,
    to: B,
    status: "skipped",
    reason: "no Local Storage",
  });
});

test("a run first sweeps what an earlier restore left, but only while leveldb is in place", async (t) => {
  const fx = await storageFixture(t);
  const storage = path.join(fx.root, LOCAL_STORAGE);
  await fs.mkdir(path.join(storage, "leveldb.relay-old-1234"));
  await fs.mkdir(path.join(storage, "leveldb.relay-5678"));
  const seen: string[][] = [];
  const { run } = fakeRun(async (job) => {
    seen.push((await fs.readdir(job.storage)).sort());
  });

  await transfer(fx, run);
  assert.deepEqual(seen, [["leveldb"]]);

  // With leveldb gone, a leftover may be the only copy of Claude's data: it stays.
  await fs.rename(fx.leveldb, path.join(storage, "leveldb.relay-old-9999"));
  assert.deepEqual(
    await transfer(fx, run, { now: new Date("2026-10-16T11:00:00.000Z") }),
    { status: "skipped", reason: "no Local Storage" },
  );
  assert.deepEqual(await fs.readdir(storage), ["leveldb.relay-old-9999"]);
});

test("the sweep never reaches through a symlinked Local Storage", async (t) => {
  const fx = await storageFixture(t);
  const storage = path.join(fx.root, LOCAL_STORAGE);
  const elsewhere = path.join(fx.base, "elsewhere");
  await fs.rename(storage, elsewhere);
  await fs.mkdir(path.join(elsewhere, "leveldb.relay-old-1234"));
  await fs.symlink(elsewhere, storage);

  await sweepRestoreLeftovers(fx.root);

  assert.deepEqual((await fs.readdir(elsewhere)).sort(), [
    "leveldb",
    "leveldb.relay-old-1234",
  ]);
});

test("old backups are pruned before the new one, so at most three ever exist", async (t) => {
  const fx = await storageFixture(t);
  const counts: number[] = [];
  const { run } = fakeRun(async () => {
    counts.push((await backupsIn(fx.vault)).length);
  });
  for (const day of [1, 2, 3, 4, 5])
    await transfer(fx, run, { now: new Date(Date.UTC(2026, 9, day, 12)) });
  assert.deepEqual(counts, [1, 2, 3, 3, 3]);
  assert.deepEqual(await backupsIn(fx.vault), [
    "2026-10-03T12-00-00-000Z",
    "2026-10-04T12-00-00-000Z",
    "2026-10-05T12-00-00-000Z",
  ]);
});

test("the backup a run depends on survives a clock that went back", async (t) => {
  const fx = await storageFixture(t);
  // Three backups made while the clock was years ahead.
  for (const day of [1, 2, 3])
    await backupLocalStorage(
      fx.root,
      fx.vault,
      new Date(Date.UTC(2030, 0, day)),
    );
  const before = await snapshot(fx.leveldb);
  const during: string[][] = [];
  const { run } = fakeRun(async (job) => {
    during.push(await backupsIn(fx.vault));
    await fs.writeFile(path.join(job.storage, "leveldb", "CURRENT"), "x");
    return { ok: false, error: "verification failed" };
  });

  const outcome = await transfer(fx, run);

  const kept = [
    NOW_STAMP,
    "2030-01-02T00-00-00-000Z",
    "2030-01-03T00-00-00-000Z",
  ];
  assert.deepEqual(during, [kept]);
  assert.deepEqual(outcome, {
    status: "failed",
    error: "verification failed",
    restored: true,
  });
  assert.deepEqual(await snapshot(fx.leveldb), before);
  assert.deepEqual(await backupsIn(fx.vault), kept);
});

test("a backup that cannot be made is a skip, and the helper never runs", async (t) => {
  const { run, jobs } = fakeRun();

  // leveldb is a link.
  const linked = await storageFixture(t);
  const real = path.join(linked.base, "real-leveldb");
  await fs.rename(linked.leveldb, real);
  await fs.symlink(real, linked.leveldb);
  assert.deepEqual(await transfer(linked, run), {
    status: "skipped",
    reason: "Local Storage/leveldb is a symbolic link.",
  });
  assert.deepEqual(await backupsIn(linked.vault), []);
  assert.equal((await lastOutcome(linked.vault)).status, "skipped");

  // leveldb is a file.
  const file = await storageFixture(t);
  await fs.rm(file.leveldb, { recursive: true });
  await fs.writeFile(file.leveldb, "not a directory");
  assert.deepEqual(await transfer(file, run), {
    status: "skipped",
    reason: "Local Storage/leveldb is not a directory.",
  });

  // A backup with this stamp already exists.
  const taken = await storageFixture(t);
  await fs.mkdir(path.join(taken.vault, "drafts", NOW_STAMP), {
    recursive: true,
  });
  const outcome = await transfer(taken, run);
  assert.equal(outcome.status, "skipped");
  assert.match((outcome as { reason: string }).reason, /EEXIST/);
  assert.deepEqual(
    await fs.readdir(path.join(taken.vault, "drafts", NOW_STAMP)),
    [],
  );

  // The drafts directory is a link: nothing is written through it, last.json included.
  const outside = await storageFixture(t);
  const target = path.join(outside.base, "outside");
  await fs.mkdir(target);
  await fs.symlink(target, path.join(outside.vault, "drafts"));
  assert.equal((await transfer(outside, run)).status, "skipped");
  assert.deepEqual(await fs.readdir(target), []);

  assert.equal(jobs.length, 0);
});

// Makes `fs.rename` fail on the given calls (1-based) from now on, until the returned undo.
function failRenames(...failing: number[]) {
  const original = fs.rename;
  let calls = 0;
  fs.rename = (async (from: any, to: any) => {
    calls += 1;
    if (failing.includes(calls))
      throw Object.assign(new Error(`injected failure ${calls}`), {
        code: "EIO",
      });
    return original(from, to);
  }) as typeof fs.rename;
  return () => {
    fs.rename = original;
  };
}

test("a restore that leaves leveldb missing copies the backup straight back", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  let undo = () => {};
  t.after(() => undo());
  const { run } = fakeRun(async (job) => {
    await fs.writeFile(path.join(job.storage, "leveldb", "000005.ldb"), "half");
    // The restore moves live aside (1), then fails to put the copy in (2) and the original back (3).
    undo = failRenames(2, 3);
    return { ok: false, error: "verification failed" };
  });

  const outcome = await transfer(fx, run);
  undo();

  assert.equal(outcome.status, "failed");
  assert.equal((outcome as { restored: boolean }).restored, true);
  assert.match((outcome as { error: string }).error, /^verification failed/);
  assert.deepEqual(await snapshot(fx.leveldb), before);
  // The helper's leveldb waits beside it for the next run to sweep.
  const names = (await fs.readdir(path.join(fx.root, LOCAL_STORAGE))).sort();
  assert.equal(names.length, 2);
  assert.equal(names[0], "leveldb");
  assert.match(names[1], /^leveldb\.relay-old-/);
  assert.equal((await lastOutcome(fx.vault)).restored, true);
});

test("a restore that fails with leveldb still in place leaves it and is not restored", async (t) => {
  const fx = await storageFixture(t);
  let undo = () => {};
  t.after(() => undo());
  let damaged: Record<string, string | null> = {};
  const { run } = fakeRun(async (job) => {
    await fs.writeFile(path.join(job.storage, "leveldb", "000005.ldb"), "half");
    damaged = await snapshot(path.join(job.storage, "leveldb"));
    // The restore cannot even move live aside.
    undo = failRenames(1);
    return { ok: false, error: "verification failed" };
  });

  const outcome = await transfer(fx, run);
  undo();

  assert.equal(outcome.status, "failed");
  assert.equal((outcome as { restored: boolean }).restored, false);
  assert.match((outcome as { error: string }).error, /injected failure 1/);
  // Live is never overwritten by the last-resort copy.
  assert.deepEqual(await snapshot(fx.leveldb), damaged);
  assert.deepEqual(await backupsIn(fx.vault), [NOW_STAMP]);
  assert.equal((await lastOutcome(fx.vault)).restored, false);
});

test("a blocked step records why, without a backup or a run", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun();
  const reason = "Claude Desktop runs Electron 45.0.0, Relay 44.7.0";

  assert.deepEqual(await transfer(fx, run, { blocked: reason }), {
    status: "skipped",
    reason,
  });

  assert.equal(jobs.length, 0);
  assert.deepEqual(await backupsIn(fx.vault), []);
  assert.deepEqual(await snapshot(fx.leveldb), before);
  // last.json is private to Relay, and so is the directory made for it.
  const drafts = path.join(fx.vault, "drafts");
  assert.equal((await fs.stat(drafts)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(drafts, "last.json"))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(await lastOutcome(fx.vault), {
    at: NOW.toISOString(),
    from: A,
    to: B,
    status: "skipped",
    reason,
  });
});

// --- Waiting for the helper process -----------------------------------------------

// A child process that exits only when the test says so, and records the signals it gets.
// A child that never started has no pid.
function fakeChild(started = true) {
  const signals: string[] = [];
  const emitter = Object.assign(new EventEmitter(), {
    pid: started ? 4242 : undefined,
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  });
  return { child: emitter as unknown as ChildProcess, emitter, signals };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a helper that exits in time gives its code and signal", async () => {
  const { child, emitter, signals } = fakeChild();
  const exit = awaitHelper(child, 1000);
  emitter.emit("exit", 1, null);
  assert.deepEqual(await exit, { code: 1, signal: null, timedOut: false });
  assert.deepEqual(signals, []);
});

test("a helper past its time is killed, and waited for until it is gone", async () => {
  const { child, emitter, signals } = fakeChild();
  let settled = false;
  const exit = awaitHelper(child, 20).then((value) => {
    settled = true;
    return value;
  });
  await pause(80);
  assert.deepEqual(signals, ["SIGKILL"]);
  // Killed is not gone: until it exits it may still hold Claude's LevelDB lock.
  assert.equal(settled, false);
  emitter.emit("exit", null, "SIGKILL");
  assert.deepEqual(await exit, {
    code: null,
    signal: "SIGKILL",
    timedOut: true,
  });
});

test("a helper that never started is not waited for", async () => {
  const { child, emitter } = fakeChild(false);
  const exit = awaitHelper(child, 1000);
  emitter.emit("error", new Error("spawn ENOENT"));
  assert.deepEqual(await exit, {
    code: null,
    signal: null,
    timedOut: false,
    error: "spawn ENOENT",
  });
});

test("an error from a running helper does not end the wait", async () => {
  const { child, emitter } = fakeChild();
  let settled = false;
  const exit = awaitHelper(child, 1000).then((value) => {
    settled = true;
    return value;
  });
  emitter.emit("error", new Error("kill EPERM"));
  await pause(20);
  assert.equal(settled, false);
  emitter.emit("exit", 0, null);
  assert.deepEqual(await exit, { code: 0, signal: null, timedOut: false });
});

// --- Reading the helper's answer --------------------------------------------------

const written = JSON.stringify({ ok: true, moved: 2, owned: 1, skipped: 3 });
const exited = (
  code: number | null,
  signal: NodeJS.Signals | null = null,
): HelperExit => ({ code, signal, timedOut: false });

test("a written success counts only with exit code 0", () => {
  assert.deepEqual(helperOutcome(exited(0), written), {
    ok: true,
    moved: 2,
    owned: 1,
    skipped: 3,
  });
  assert.deepEqual(helperOutcome(exited(1), written), {
    ok: false,
    error: "the helper exited with code 1",
  });
  assert.deepEqual(helperOutcome(exited(null, "SIGTERM"), written), {
    ok: false,
    error: "the helper was stopped by SIGTERM",
  });
});

test("a written failure is passed on", () => {
  const failure = JSON.stringify({ ok: false, error: "verification failed" });
  for (const code of [0, 1])
    assert.deepEqual(helperOutcome(exited(code), failure), {
      ok: false,
      error: "verification failed",
    });
});

test("only the result's own fields are kept", () => {
  const extra = JSON.stringify({
    ok: true,
    moved: 1,
    owned: 0,
    skipped: 0,
    text: "an unsent draft",
  });
  assert.deepEqual(helperOutcome(exited(0), extra), {
    ok: true,
    moved: 1,
    owned: 0,
    skipped: 0,
  });
});

test("a helper that timed out failed, whatever it wrote", () => {
  assert.deepEqual(
    helperOutcome({ code: null, signal: "SIGKILL", timedOut: true }, written),
    { ok: false, error: "timed out" },
  );
});

test("a helper that could not start says why", () => {
  assert.deepEqual(
    helperOutcome(
      { code: null, signal: null, timedOut: false, error: "spawn ENOENT" },
      undefined,
    ),
    { ok: false, error: "spawn ENOENT" },
  );
});

test("a missing or invalid result is no result", () => {
  for (const text of [
    undefined,
    "",
    "not json",
    "null",
    "[]",
    '"ok"',
    '{"ok":true}',
    '{"ok":"yes","moved":1,"owned":0,"skipped":0}',
    '{"ok":true,"moved":"1","owned":0,"skipped":0}',
    '{"ok":true,"moved":-1,"owned":0,"skipped":0}',
    '{"ok":true,"moved":1.5,"owned":0,"skipped":0}',
    '{"ok":false}',
    '{"ok":false,"error":""}',
  ])
    for (const code of [0, 1])
      assert.deepEqual(
        helperOutcome(exited(code), text),
        { ok: false, error: "no result" },
        `${text} with code ${code}`,
      );
});

// --- Whether drafts can move on this machine --------------------------------------

test("drafts move only between the same Electron major version", () => {
  assert.equal(electronMismatch("44.7.2", "44.7.0"), undefined);
  assert.equal(electronMismatch("44.7.2\n", "44.7.0"), undefined);
  assert.equal(electronMismatch("44", "44.7.0"), undefined);
  assert.equal(
    electronMismatch("45.0.0", "44.7.0"),
    "Claude Desktop runs Electron 45.0.0, Relay 44.7.0",
  );
  assert.equal(
    electronMismatch("4.7.0", "44.7.0"),
    "Claude Desktop runs Electron 4.7.0, Relay 44.7.0",
  );
  for (const unknown of [undefined, "", "  ", "abc", "v44.7.2", ".44"])
    assert.equal(
      electronMismatch(unknown, "44.7.0"),
      "Claude Desktop's Electron version is unknown",
      String(unknown),
    );
  assert.equal(
    electronMismatch("44.7.2", undefined),
    "Relay's Electron version is unknown",
  );
});

test("drafts move only on macOS", () => {
  for (const platform of ["linux", "win32"])
    assert.equal(
      draftsBlockedReason(platform, "44.7.2", "44.7.0"),
      "drafts move only on macOS",
    );
  assert.equal(draftsBlockedReason("darwin", "44.7.2", "44.7.0"), undefined);
  assert.equal(
    draftsBlockedReason("darwin", undefined, "44.7.0"),
    "Claude Desktop's Electron version is unknown",
  );
});
