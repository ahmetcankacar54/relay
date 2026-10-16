import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
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
} from "../electron/core/draft-storage";

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
    // Bigger than a single copy chunk, like a real table file.
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
  await fs.symlink(outside, path.join(drafts, "2026-09-01T12-00-00-000Z"));
  await pruneDraftBackups(vault);
  assert.equal(
    await fs.readFile(path.join(outside, "precious"), "utf8"),
    "mine",
  );
  assert.equal(
    (await fs.readdir(drafts)).includes("2026-10-01T12-00-00-000Z"),
    false,
  );
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
