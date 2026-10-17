import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
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
  selectDrafts,
  type CapturedDraft,
} from "../electron/core/drafts";
import {
  LEVELDB,
  LOCAL_STORAGE,
  copyLocalStorage,
  removeLegacyDraftBackups,
  sweepDraftLeftovers,
} from "../electron/core/draft-storage";
import {
  awaitHelper,
  captureDrafts,
  draftsBlockedReason,
  electronMismatch,
  helperOutcome,
  runHelper,
  type HelperExit,
} from "../electron/core/draft-transfer";
import {
  DraftVault,
  summarize,
  type DraftRecord,
  type DraftSlots,
} from "../electron/core/draft-vault";
import {
  DRAFT_WORKER_FLAG,
  EMPTY_STORAGE,
  assertLocalStorage,
  draftJobPath,
  helperElectronMismatch,
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

// selectDrafts: a pure choice of which of A's unsent drafts are worth keeping.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const draft = (
  owner: string,
  text = "t",
  extra: Record<string, unknown> = {},
) => JSON.stringify({ text, files: [], snippets: [], ...extra, owner });
const carried = (
  targetAlias: string,
  ...members: [string, string][]
): CarriedConversation => ({
  targetAlias,
  members: members.map(([alias, accountUuid]) => ({ alias, accountUuid })),
});
// A's draft as it is kept for a conversation.
const kept = (targetAlias: string, text = "t", title = "") => ({
  targetAlias,
  title,
  text,
  attachments: false,
});
const select = (
  drafts: Record<string, string>,
  conversations: CarriedConversation[],
  titles: Record<string, string> = {},
  from = A,
) => selectDrafts({ drafts, from, conversations, titles });

test("a draft at the target alias is kept", () => {
  assert.deepEqual(
    select({ [P + "x"]: draft(A, "hello") }, [carried("x", ["x", A])]),
    [kept("x", "hello")],
  );
});

test("a draft at another member alias is kept under the target alias", () => {
  assert.deepEqual(select({ [P + "x"]: draft(A) }, [carried("y", ["x", A])]), [
    kept("y"),
  ]);
});

test("A's draft is kept even when B has one for the same conversation", () => {
  assert.deepEqual(
    select({ [P + "y"]: draft(B, "old"), [P + "x"]: draft(A, "new") }, [
      carried("y", ["x", A], ["y", B]),
    ]),
    [kept("y", "new")],
  );
});

test("without A's draft nothing is kept", () => {
  assert.deepEqual(
    select({ [P + "y"]: draft(B, "theirs") }, [
      carried("y", ["x", A], ["y", B]),
    ]),
    [],
  );
});

test("two A drafts in one conversation keep the one at the target alias", () => {
  assert.deepEqual(
    select({ [P + "x"]: draft(A, "from x"), [P + "y"]: draft(A, "from y") }, [
      carried("y", ["x", A], ["y", A]),
    ]),
    [kept("y", "from y")],
  );
});

test("two A drafts, neither at the target alias, keep the lexically first", () => {
  assert.deepEqual(
    select({ [P + "b"]: draft(A, "from b"), [P + "a"]: draft(A, "from a") }, [
      carried("y", ["b", A], ["a", A]),
    ]),
    [kept("y", "from a")],
  );
});

test("a repeated member does not duplicate the draft", () => {
  assert.deepEqual(
    select({ [P + "x"]: draft(A, "x"), [P + "y"]: draft(A, "y") }, [
      carried("y", ["x", A], ["x", A], ["y", A], ["y", A]),
    ]),
    [kept("y", "y")],
  );
});

test("another account's drafts and conversations outside the plan are ignored", () => {
  assert.deepEqual(
    select(
      {
        [P + "x"]: draft(C, "theirs"),
        [P + "z"]: draft(A, "elsewhere"),
        "composer-draft:other": draft(A),
      },
      [carried("x", ["x", A])],
    ),
    [],
  );
});

test("an upper-case owner is still A's", () => {
  const from = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
  // Upper-case drafts for a lower-case `from`, then the other way round.
  for (const [owner, given] of [
    [from.toUpperCase(), from],
    [from, from.toUpperCase()],
  ]) {
    assert.deepEqual(
      select(
        {
          [P + "x"]: draft(owner, "c"),
          [NEW_SESSION_DRAFT]: draft(owner, "n"),
        },
        [carried("y", ["x", given])],
        {},
        given,
      ),
      [
        kept("y", "c"),
        { newSession: true, title: "", text: "n", attachments: false },
      ],
      owner,
    );
  }
});

test("the new-session draft is kept only from A", () => {
  assert.deepEqual(select({ [NEW_SESSION_DRAFT]: draft(A, "hello") }, []), [
    { newSession: true, title: "", text: "hello", attachments: false },
  ]);
  assert.deepEqual(select({ [NEW_SESSION_DRAFT]: draft(C, "theirs") }, []), []);
  // It comes after the conversation drafts, and neither is mistaken for the other.
  assert.deepEqual(
    select(
      { [NEW_SESSION_DRAFT]: draft(A, "new"), [P + "x"]: draft(A, "conv") },
      [carried("x", ["x", A])],
    ),
    [
      kept("x", "conv"),
      { newSession: true, title: "", text: "new", attachments: false },
    ],
  );
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
    assert.deepEqual(
      select({ [P + "x"]: value }, [carried("y", ["x", A])]),
      [],
      value,
    );
    assert.deepEqual(select({ [NEW_SESSION_DRAFT]: value }, []), [], value);
  }
});

test("a malformed draft does not stop a good one in the same conversation", () => {
  assert.deepEqual(
    select({ [P + "x"]: "not json", [P + "y"]: draft(A, "good") }, [
      carried("y", ["x", A], ["y", A]),
    ]),
    [kept("y", "good")],
  );
});

test("a malformed draft at the target key skips the conversation", () => {
  assert.deepEqual(
    select({ [P + "y"]: "garbage", [P + "x"]: draft(A, "mine") }, [
      carried("y", ["x", A], ["y", B]),
    ]),
    [],
  );
});

test("a malformed target draft does not hold back another conversation", () => {
  assert.deepEqual(
    select(
      {
        [P + "y"]: "garbage",
        [P + "x"]: draft(A, "stays"),
        [P + "q"]: draft(A, "moves"),
      },
      [carried("y", ["x", A], ["y", B]), carried("q", ["q", A])],
    ),
    [kept("q", "moves")],
  );
});

test("A's draft is kept over a third account's draft at the target key", () => {
  // The target key is shared by every account that has that alias, so it holds
  // one draft whoever wrote it last.
  assert.deepEqual(
    select({ [P + "y"]: draft(C, "theirs"), [P + "x"]: draft(A, "mine") }, [
      carried("y", ["x", A], ["y", B]),
    ]),
    [kept("y", "mine")],
  );
});

test("two carried conversations do not interact", () => {
  assert.deepEqual(
    select(
      {
        [P + "x"]: draft(A, "first"),
        [P + "m"]: draft(A, "second"),
        [P + "n"]: draft(B, "theirs"),
      },
      [carried("y", ["x", A]), carried("n", ["m", A], ["n", B])],
    ),
    [kept("y", "first"), kept("n", "second")],
  );
});

test("a draft is kept for one conversation only", () => {
  // Guards an input the real merge cannot produce: `x` is a member of both conversations.
  assert.deepEqual(
    select({ [P + "x"]: draft(A) }, [
      carried("y", ["x", A]),
      carried("z", ["x", A]),
    ]),
    [kept("y")],
  );
});

test("the target alias is scanned even when it is not a member", () => {
  assert.deepEqual(select({ [P + "x"]: draft(A) }, [carried("x")]), [
    kept("x"),
  ]);
});

test("the text is kept exactly", () => {
  const text = "  first line\n\n\tsecond line \n";
  assert.deepEqual(
    select({ [P + "x"]: draft(A, text) }, [carried("x", ["x", A])]),
    [kept("x", text)],
  );
});

test("the title comes from B's record", () => {
  const drafts = { [P + "x"]: draft(A, "one"), [P + "q"]: draft(A, "two") };
  const conversations = [carried("y", ["x", A]), carried("n", ["q", A])];
  assert.deepEqual(
    select(drafts, conversations, { y: "Fix login", unrelated: "Other" }),
    [kept("y", "one", "Fix login"), kept("n", "two", "")],
  );
  // The new-session draft belongs to no conversation, so it has no title.
  assert.equal(
    select({ [NEW_SESSION_DRAFT]: draft(A) }, [], { y: "Fix login" })[0].title,
    "",
  );
  // A name that is only inherited is not a title.
  assert.equal(
    select({ [P + "constructor"]: draft(A) }, [carried("constructor")])[0]
      .title,
    "",
  );
});

test("attachments are flagged", () => {
  const flagged = (extra: Record<string, unknown>) =>
    select({ [P + "x"]: draft(A, "t", extra) }, [carried("x", ["x", A])])[0]
      .attachments;
  assert.equal(flagged({ files: [{ name: "a.png" }] }), true);
  assert.equal(flagged({ snippets: [{ id: 1 }] }), true);
  assert.equal(
    flagged({ files: [{ name: "a.png" }], snippets: [{ id: 1 }] }),
    true,
  );
  assert.equal(flagged({}), false);
  // Absent, empty or not a list: nothing is attached.
  assert.equal(flagged({ files: undefined, snippets: undefined }), false);
  assert.equal(flagged({ files: "a.png", snippets: {} }), false);
  assert.equal(
    selectDrafts({
      drafts: { [NEW_SESSION_DRAFT]: draft(A, "t", { files: [1] }) },
      from: A,
      conversations: [],
      titles: {},
    })[0].attachments,
    true,
  );
});

test("an empty draft is not captured", () => {
  const empty = [
    draft(A, ""),
    draft(A, "  \n\t "),
    // No text at all, or text that is not a string.
    JSON.stringify({ files: [], snippets: [], owner: A }),
    draft(A, 5 as unknown as string),
    // Attachments alone are not worth keeping: only text is re-typed.
    draft(A, "", { files: [{ name: "a.png" }] }),
  ];
  for (const value of empty) {
    assert.deepEqual(
      select({ [P + "x"]: value }, [carried("x", ["x", A])]),
      [],
      value,
    );
    assert.deepEqual(select({ [NEW_SESSION_DRAFT]: value }, []), [], value);
  }
  // An empty draft never takes the place of one with text, wherever it sits.
  assert.deepEqual(
    select({ [P + "y"]: draft(A, ""), [P + "x"]: draft(A, "real") }, [
      carried("y", ["x", A], ["y", A]),
    ]),
    [kept("y", "real")],
  );
});

// --- Copying Local Storage, and sweeping what the first design left --------------

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
  // Stands in for os.tmpdir(), so the draft step never touches the real one.
  const tmp = path.join(base, "tmp");
  await fs.mkdir(tmp);
  return { base, root, vault, leveldb, files, tmp };
}

// Every entry under `dir`, relative, with its bytes (files), its target (links) or null
// (directories).
async function snapshot(dir: string) {
  const out: Record<string, string | null> = {};
  async function walk(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[rel] = null;
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        out[rel] = `-> ${await fs.readlink(full)}`;
      } else {
        assert.ok(entry.isFile(), `${rel} is a plain file`);
        out[rel] = (await fs.readFile(full)).toString("base64");
      }
    }
  }
  await walk(dir);
  return out;
}

// Where a test asks for a copy: a new dir in a scratch dir of its own, as the draft step does.
async function copyTarget(fx: { base: string }) {
  const scratch = await fs.mkdtemp(path.join(fx.base, "scratch-"));
  return path.join(scratch, "copy");
}

test("a copy of leveldb is byte-exact and private, and Claude's stays as it was", async (t) => {
  const fx = await storageFixture(t);
  const { root, leveldb, files } = fx;
  const before = await snapshot(path.join(root, LOCAL_STORAGE));
  const storage = await copyTarget(fx);

  assert.equal(await copyLocalStorage(root, storage), true);

  assert.deepEqual(await fs.readdir(storage), ["leveldb"]);
  const copy = path.join(storage, "leveldb");
  assert.deepEqual(await snapshot(copy), await snapshot(leveldb));
  assert.equal((await fs.stat(path.join(copy, "LOCK"))).size, 0);
  assert.equal((await fs.stat(path.join(copy, "nested/empty"))).size, 0);
  for (const [name, bytes] of Object.entries(files))
    assert.deepEqual(await fs.readFile(path.join(copy, name)), bytes, name);
  assert.equal((await fs.stat(storage)).mode & 0o777, 0o700);
  // Nothing was made or changed beside Claude's leveldb.
  assert.deepEqual(await snapshot(path.join(root, LOCAL_STORAGE)), before);
  // A directory that already exists is never copied into.
  await assert.rejects(copyLocalStorage(root, storage), { code: "EEXIST" });
});

test("a link anywhere in leveldb fails the copy", async (t) => {
  // Chromium's leveldb holds none. Followed from the copy, a link could reach Claude's own files,
  // so not even one that stays inside is copied.
  const cases: [string, string, string][] = [
    ["link", "LOCK", "Local Storage/leveldb/link"],
    ["nested/up", "../CURRENT", "Local Storage/leveldb/nested/up"],
    ["link", "ABSOLUTE", "Local Storage/leveldb/link"],
    ["link", "../outside", "Local Storage/leveldb/link"],
    ["nested/escape", "../../escape", "Local Storage/leveldb/nested/escape"],
  ];
  for (const [name, target, shown] of cases) {
    const fx = await storageFixture(t);
    await fs.symlink(
      target === "ABSOLUTE" ? path.join(fx.leveldb, "CURRENT") : target,
      path.join(fx.leveldb, name),
    );
    const before = await snapshot(path.join(fx.root, LOCAL_STORAGE));
    await assert.rejects(
      copyLocalStorage(fx.root, await copyTarget(fx)),
      { message: `${shown} is a symbolic link.` },
      `${name} -> ${target}`,
    );
    assert.deepEqual(
      await snapshot(path.join(fx.root, LOCAL_STORAGE)),
      before,
      target,
    );
  }
});

test("a missing leveldb gives no copy", async (t) => {
  const fx = await storageFixture(t);
  const storage = await copyTarget(fx);
  await fs.rm(fx.leveldb, { recursive: true });
  assert.equal(await copyLocalStorage(fx.root, storage), false);
  await fs.rm(path.join(fx.root, LOCAL_STORAGE), { recursive: true });
  assert.equal(await copyLocalStorage(fx.root, storage), false);
  await fs.rm(fx.root, { recursive: true });
  assert.equal(await copyLocalStorage(fx.root, storage), false);
  // Nothing was made where the copy would have gone.
  await assertGone(storage);
});

test("a linked or misshapen Local Storage or leveldb is refused", async (t) => {
  const linked = await storageFixture(t);
  const real = path.join(linked.base, "real-leveldb");
  await fs.rename(linked.leveldb, real);
  await fs.symlink(real, linked.leveldb);
  await assert.rejects(
    copyLocalStorage(linked.root, await copyTarget(linked)),
    /^Error: Local Storage\/leveldb is a symbolic link\.$/,
  );

  const file = await storageFixture(t);
  await fs.rm(file.leveldb, { recursive: true });
  await fs.writeFile(file.leveldb, "not a directory");
  await assert.rejects(
    copyLocalStorage(file.root, await copyTarget(file)),
    /^Error: Local Storage\/leveldb is not a directory\.$/,
  );

  const storage = await storageFixture(t);
  const elsewhere = path.join(storage.base, "real-storage");
  await fs.rename(path.join(storage.root, LOCAL_STORAGE), elsewhere);
  await fs.symlink(elsewhere, path.join(storage.root, LOCAL_STORAGE));
  const target = await copyTarget(storage);
  await assert.rejects(
    copyLocalStorage(storage.root, target),
    /^Error: Local Storage is a symbolic link\.$/,
  );
  await assertGone(target);
});

// A root user ignores file modes, so the chmod-based tests prove nothing there.
const needsPermissions = {
  skip: process.getuid?.() === 0 && "root can read a mode 0 file",
};

test(
  "an unreadable leveldb file fails the copy",
  needsPermissions,
  async (t) => {
    const fx = await storageFixture(t);
    const file = path.join(fx.leveldb, "000003.log");
    await fs.chmod(file, 0);
    try {
      await assert.rejects(copyLocalStorage(fx.root, await copyTarget(fx)), {
        code: "EACCES",
      });
    } finally {
      await fs.chmod(file, 0o600);
    }
    assert.deepEqual(await fs.readdir(path.join(fx.root, LOCAL_STORAGE)), [
      "leveldb",
    ]);
  },
);

test("the sweep removes only unfinished copies, and only while leveldb is in place", async (t) => {
  const { root, leveldb } = await storageFixture(t);
  const storage = path.join(root, LOCAL_STORAGE);
  const before = await snapshot(leveldb);
  // Claude's own earlier leveldb, set aside by the first design: never deleted.
  const old = path.join(storage, `leveldb.relay-old-${randomUUID()}`);
  await fs.cp(leveldb, old, { recursive: true });
  const plant = async () => {
    await fs.mkdir(path.join(storage, `leveldb.relay-${randomUUID()}`));
    await fs.mkdir(
      path.join(storage, `.relay-work-${randomUUID()}`, "leveldb"),
      {
        recursive: true,
      },
    );
  };
  await plant();

  await sweepDraftLeftovers(root);

  assert.deepEqual((await fs.readdir(storage)).sort(), [
    "leveldb",
    path.basename(old),
  ]);
  assert.deepEqual(await snapshot(old), before);
  assert.deepEqual(await snapshot(leveldb), before);

  // With leveldb gone, what is beside it may be the only copy of Claude's data: all of it stays.
  await fs.rm(leveldb, { recursive: true });
  await plant();
  const left = (await fs.readdir(storage)).sort();
  assert.equal(left.length, 3);
  await sweepDraftLeftovers(root);
  assert.deepEqual((await fs.readdir(storage)).sort(), left);
});

test("the sweep never reaches through a symlinked Local Storage", async (t) => {
  const fx = await storageFixture(t);
  const storage = path.join(fx.root, LOCAL_STORAGE);
  const elsewhere = path.join(fx.base, "elsewhere");
  await fs.rename(storage, elsewhere);
  await fs.mkdir(path.join(elsewhere, "leveldb.relay-1234"));
  await fs.mkdir(path.join(elsewhere, ".relay-work-5678"));
  await fs.symlink(elsewhere, storage);

  await sweepDraftLeftovers(fx.root);

  assert.deepEqual((await fs.readdir(elsewhere)).sort(), [
    ".relay-work-5678",
    "leveldb",
    "leveldb.relay-1234",
  ]);
});

test("the first design's plaintext backups are removed, and nothing else", async (t) => {
  const { vault, base } = await storageFixture(t);
  const drafts = path.join(vault, "drafts");
  for (const stamp of ["2026-10-16T09-08-07-654Z", "2025-12-31T23-59-59-999Z"]) {
    await fs.mkdir(path.join(drafts, stamp, "leveldb"), { recursive: true });
    await fs.writeFile(path.join(drafts, stamp, "leveldb", "000003.log"), "x");
  }
  await fs.writeFile(path.join(drafts, "last.json"), "{}");
  await fs.writeFile(path.join(drafts, "pending.bin"), "sealed");
  await fs.mkdir(path.join(drafts, "not-a-stamp"));
  // Named like a backup, but a file.
  await fs.writeFile(path.join(drafts, "2026-10-01T00-00-00-000Z"), "file");
  // Named like a backup, but a link: neither it nor what it leads to is removed.
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "precious"), "mine");
  await fs.symlink(outside, path.join(drafts, "2026-11-01T12-00-00-000Z"));
  // Outside <vault>/drafts, however it is named.
  await fs.mkdir(path.join(vault, "backups", "2026-01-01T00-00-00-000Z"), {
    recursive: true,
  });

  await removeLegacyDraftBackups(vault);

  assert.deepEqual((await fs.readdir(drafts)).sort(), [
    "2026-10-01T00-00-00-000Z",
    "2026-11-01T12-00-00-000Z",
    "last.json",
    "not-a-stamp",
    "pending.bin",
  ]);
  assert.equal(await fs.readFile(path.join(drafts, "pending.bin"), "utf8"), "sealed");
  assert.equal(await fs.readFile(path.join(outside, "precious"), "utf8"), "mine");
  assert.ok(
    (await fs.lstat(path.join(drafts, "2026-11-01T12-00-00-000Z"))).isSymbolicLink(),
  );
  assert.deepEqual(await fs.readdir(path.join(vault, "backups")), [
    "2026-01-01T00-00-00-000Z",
  ]);
});

test("the backup cleanup never follows a linked drafts dir", async (t) => {
  const { vault, base } = await storageFixture(t);
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(outside, "2026-10-01T12-00-00-000Z"), {
    recursive: true,
  });
  await fs.symlink(outside, path.join(vault, "drafts"));
  await removeLegacyDraftBackups(vault);
  assert.deepEqual(await fs.readdir(outside), ["2026-10-01T12-00-00-000Z"]);
  // A vault without drafts is left as it is.
  await fs.rm(path.join(vault, "drafts"));
  await removeLegacyDraftBackups(vault);
  assert.deepEqual(await fs.readdir(vault), []);
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
    storage: "/tmp/relay-drafts-job/copy",
    scratch: "/tmp/relay-drafts-job",
    result: "/tmp/relay-drafts-job/result.json",
    claudeElectron: "44.7.2",
  };
}

// A page backed by a plain object, recording what the runner asks of it. `size` is how many
// keys the whole origin holds: Claude keeps plenty besides drafts, so it defaults to a non-empty
// origin. A DraftPage has no way to write, so neither has this one.
function fakePage(
  initial: Record<string, string>,
  options: {
    size?: number;
    failAt?: "size" | "read";
    failWith?: unknown;
  } = {},
) {
  const store = { ...initial };
  const calls: string[] = [];
  const trip = (at: "size" | "read") => {
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
  };
  return { page, store, calls };
}

test("runDraftJob only reads: it answers with the drafts the page holds", async () => {
  // Raw values pass through as they are, even ones nobody could parse.
  const initial = {
    [P + ALIAS_X]: draft(A, "from A"),
    [P + ALIAS_Y]: draft(B, "B's own"),
    [NEW_SESSION_DRAFT]: "not json",
  };
  const fake = fakePage(initial);
  assert.deepEqual(await runDraftJob(job(), fake.page), {
    ok: true,
    drafts: initial,
  });
  assert.deepEqual(fake.store, initial);
  // Check the origin has data, then read once. There is nothing else to ask of the page.
  assert.deepEqual(fake.calls, ["size", "read"]);
  // No drafts at all is not an error.
  assert.deepEqual(await runDraftJob(job(), fakePage({}).page), {
    ok: true,
    drafts: {},
  });
});

test("an empty origin is a failure, not a success", async () => {
  // Chromium rebuilt or could not open Claude's database: nothing to read, and nothing to trust.
  const fake = fakePage({}, { size: 0 });
  assert.deepEqual(await runDraftJob(job(), fake.page), {
    ok: false,
    error: "Claude's Local Storage opened empty",
  });
  assert.equal(EMPTY_STORAGE, "Claude's Local Storage opened empty");
  // The helper stops there: it reads nothing.
  assert.deepEqual(fake.calls, ["size"]);
});

test("a page that throws is reported, not thrown", async () => {
  for (const failAt of ["size", "read"] as const) {
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
  // Unknown fields are not carried along, the ones an older Relay wrote included.
  assert.deepEqual(
    parseDraftJob({ ...good, extra: 1, from: A, to: B, conversations: [] }),
    good,
  );
  const bad = (change: Record<string, unknown>) =>
    assert.throws(() => parseDraftJob({ ...good, ...change }), Error);
  for (const key of ["storage", "scratch", "result", "claudeElectron"]) {
    bad({ [key]: undefined });
    bad({ [key]: "" });
    bad({ [key]: 7 });
  }
  // Relative paths would resolve against whatever directory the helper starts in.
  for (const key of ["storage", "scratch", "result"])
    bad({ [key]: "relative/dir" });
  for (const value of [null, undefined, "job", 3, []])
    assert.throws(() => parseDraftJob(value), Error);
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

test("the helper refuses to run under another Electron major than Claude's", () => {
  assert.equal(helperElectronMismatch("44.7.2", "44.7.0"), undefined);
  assert.equal(helperElectronMismatch("44", "44.7.0"), undefined);
  assert.equal(helperElectronMismatch("44.7.2\n", "44.7.0"), undefined);
  for (const claude of ["45.0.0", "4.7.0", "abc", "v44.7.2", ".44"])
    assert.equal(
      helperElectronMismatch(claude, "44.7.0"),
      `helper Electron 44.7.0 differs from Claude Desktop ${claude}`,
      claude,
    );
  assert.equal(
    helperElectronMismatch("44.7.2", undefined),
    "helper Electron undefined differs from Claude Desktop 44.7.2",
  );
});

test("the helper checks its Electron before it opens a session", async () => {
  const worker = (
    await fs.readFile(
      path.join(import.meta.dirname, "../electron/draft-worker.ts"),
      "utf8",
    )
  ).replace(/\s+/g, "");
  const check = worker.indexOf(
    "helperElectronMismatch(job.claudeElectron,process.versions.electron",
  );
  assert.ok(check > 0, "the helper compares the versions");
  assert.ok(check < worker.indexOf("session.fromPath("), "before fromPath");
});

test("the helper and its job never write to Local Storage", async () => {
  // The helper only reads: Claude Desktop wipes drafts itself after an account change.
  for (const file of ["draft-worker.ts", "draft-job.ts"]) {
    const source = await fs.readFile(
      path.join(import.meta.dirname, "../electron", file),
      "utf8",
    );
    for (const write of ["setItem", "removeItem", "flushStorageData"])
      assert.ok(
        !source.includes(write),
        `electron/${file} must not contain ${write}`,
      );
  }
});

test("the smoke test uses the real draft-worker flag", async () => {
  // A stale copy would start a whole Relay instead of the helper.
  const smoke = await fs.readFile(
    path.join(import.meta.dirname, "../scripts/smoke.cjs"),
    "utf8",
  );
  assert.ok(
    smoke.includes(JSON.stringify(DRAFT_WORKER_FLAG)),
    `scripts/smoke.cjs must contain ${JSON.stringify(DRAFT_WORKER_FLAG)}`,
  );
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
// The Electron version the gate read from Claude.app.
const CLAUDE_ELECTRON = "44.7.2";
// Text that must never reach last.json, or survive the step outside the vault.
const UNSENT = "an unsent draft, word for word";
const NEW_SESSION_TEXT = "the start of a new session";

// What the helper reads from the copy: A's drafts of X and of a new session, and B's own draft.
const HELPER_DRAFTS = {
  [P + ALIAS_X]: draft(A, UNSENT),
  [P + ALIAS_Y]: draft(B, "B's own draft"),
  [NEW_SESSION_DRAFT]: draft(A, NEW_SESSION_TEXT, { files: ["a.png"] }),
};
const READ: DraftResult = { ok: true, drafts: HELPER_DRAFTS };
// What the step keeps of them for B.
const CAPTURED: CapturedDraft[] = [
  { targetAlias: ALIAS_X, title: "Fix login", text: UNSENT, attachments: false },
  { newSession: true, title: "", text: NEW_SESSION_TEXT, attachments: true },
];
// The slots a successful read covers for B: each carried conversation, and the new session.
const READ_SLOTS: DraftSlots = { aliases: [ALIAS_X, ALIAS_Y], newSession: true };

async function lastOutcome(vault: string) {
  return JSON.parse(
    await fs.readFile(path.join(vault, "drafts", "last.json"), "utf8"),
  );
}

// What Claude's Local Storage directory holds, sorted.
async function storageNames(fx: { root: string }) {
  return (await fs.readdir(path.join(fx.root, LOCAL_STORAGE))).sort();
}

const inside = (dir: string, target: string) => {
  const relative = path.relative(dir, target);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

// A stand-in for the helper. It leaves its scratch dir the way the real one does: a root whose
// "Local Storage" links to the job's storage, a userData, and a result file holding the drafts
// it read, text and all. Then it answers with `answer`, or with what `answer(job)` gives.
function fakeRun(
  answer: DraftResult | ((job: DraftJob) => Promise<DraftResult>) = READ,
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
    await fs.writeFile(job.result, JSON.stringify(READ));
    return typeof answer === "function" ? answer(job) : answer;
  };
  return { run, jobs };
}

// What a helper's Chromium may do to the leveldb it was given.
async function rewrite(job: DraftJob) {
  const leveldb = path.join(job.storage, "leveldb");
  await fs.writeFile(path.join(leveldb, "000005.ldb"), "rewritten");
  await fs.writeFile(path.join(leveldb, "000009.log"), "new");
  await fs.rm(path.join(leveldb, "LOCK"), { force: true });
}

// Runs the step for an A→B switch that carries X (A's and B's) and Y (B's only). B calls X
// "Fix login". Returns the outcome and what was handed to `store`.
async function capture(
  fx: { root: string; vault: string; tmp: string },
  run: (job: DraftJob) => Promise<DraftResult>,
  extra: Partial<Parameters<typeof captureDrafts>[0]> = {},
) {
  const stored: { to: string; drafts: CapturedDraft[]; slots: DraftSlots }[] =
    [];
  const outcome = await captureDrafts({
    root: fx.root,
    from: A,
    to: B,
    conversations: [
      carried(ALIAS_X, [ALIAS_X, A], [ALIAS_X, B]),
      carried(ALIAS_Y, [ALIAS_Y, B]),
    ],
    titles: { [ALIAS_X]: "Fix login", [ALIAS_Y]: "B's work" },
    run,
    store: async (to, drafts, slots) => {
      stored.push({ to, drafts, slots });
    },
    lastJson: path.join(fx.vault, "drafts", "last.json"),
    now: NOW,
    claudeElectron: CLAUDE_ELECTRON,
    tmp: fx.tmp,
    ...extra,
  });
  return { outcome, stored };
}

async function assertGone(target: string) {
  await assert.rejects(fs.lstat(target), { code: "ENOENT" }, target);
}

// Makes `fs.cp` copy and then fail on the given calls (1-based), until the returned undo:
// a copy that broke at the very end leaves a whole-looking directory behind.
function failCopies(...failing: number[]) {
  const original = fs.cp;
  let calls = 0;
  fs.cp = (async (from: any, to: any, options: any) => {
    calls += 1;
    await original(from, to, options);
    if (failing.includes(calls))
      throw Object.assign(new Error(`injected copy failure ${calls}`), {
        code: "EIO",
      });
  }) as typeof fs.cp;
  return () => {
    fs.cp = original;
  };
}

test("captures A's drafts and never changes Claude's leveldb", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(path.join(fx.root, LOCAL_STORAGE));
  const { run, jobs } = fakeRun(async (job) => {
    // Whatever the helper's Chromium does to its copy stays in the copy.
    await rewrite(job);
    return READ;
  });

  const { outcome, stored } = await capture(fx, run);

  assert.deepEqual(outcome, { status: "captured", count: 2 });
  // With every slot the step read: the carried conversations and the new-session draft.
  assert.deepEqual(stored, [{ to: B, drafts: CAPTURED, slots: READ_SLOTS }]);
  assert.equal(jobs.length, 1);
  // Byte for byte as it was, and nothing was made beside it.
  assert.deepEqual(await snapshot(path.join(fx.root, LOCAL_STORAGE)), before);
  assert.deepEqual(await storageNames(fx), ["leveldb"]);
  // The scratch dir, with the copy and the text-bearing result file, is gone.
  await assertGone(jobs[0].scratch);
  assert.deepEqual(await fs.readdir(fx.tmp), []);
});

test("the helper sees only the private copy", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  let problem: unknown;
  const { run, jobs } = fakeRun(async (job) => {
    // The step turns what a run throws into an outcome, so a failed check is raised below.
    try {
      assert.equal(path.dirname(job.scratch), fx.tmp);
      assert.match(path.basename(job.scratch), /^relay-drafts-/);
      assert.equal(job.storage, path.join(job.scratch, "copy"));
      assert.ok(inside(fx.tmp, job.storage));
      assert.ok(!inside(fx.root, job.storage));
      assert.equal(job.result, path.join(job.scratch, "result.json"));
      assert.equal(job.claudeElectron, CLAUDE_ELECTRON);
      // The job names only where to read: no accounts, no conversations.
      assert.deepEqual(Object.keys(job).sort(), [
        "claudeElectron",
        "result",
        "scratch",
        "storage",
      ]);
      // A copy of Claude's leveldb, and nothing was made in Claude's dir for it.
      assert.deepEqual(
        await snapshot(path.join(job.storage, "leveldb")),
        before,
      );
      assert.deepEqual(await storageNames(fx), ["leveldb"]);
    } catch (error) {
      problem = error;
    }
    return READ;
  });

  assert.equal((await capture(fx, run)).outcome.status, "captured");
  assert.equal(problem, undefined);
  assert.equal(jobs.length, 1);
});

test("a failed run stores nothing and leaves no scratch", async (t) => {
  const cases: [string, Parameters<typeof fakeRun>[0], string][] = [
    ["ok false", { ok: false, error: "verification failed" }, "verification failed"],
    ["empty origin", { ok: false, error: EMPTY_STORAGE }, EMPTY_STORAGE],
    [
      "a throw",
      async () => {
        throw new Error("helper crashed");
      },
      "helper crashed",
    ],
    ["no answer", async () => undefined as unknown as DraftResult, "no result"],
  ];
  for (const [name, answer, error] of cases) {
    const fx = await storageFixture(t);
    const before = await snapshot(path.join(fx.root, LOCAL_STORAGE));
    const { run, jobs } = fakeRun(answer);

    const { outcome, stored } = await capture(fx, run);

    assert.deepEqual(outcome, { status: "failed", error }, name);
    assert.deepEqual(stored, [], name);
    assert.equal(jobs.length, 1, name);
    // The fake left the text it read in its result file: that is gone with the scratch dir.
    await assertGone(jobs[0].scratch);
    assert.deepEqual(await fs.readdir(fx.tmp), [], name);
    assert.deepEqual(
      await snapshot(path.join(fx.root, LOCAL_STORAGE)),
      before,
      name,
    );
    assert.deepEqual(
      await lastOutcome(fx.vault),
      { at: NOW.toISOString(), from: A, to: B, status: "failed", error },
      name,
    );
  }
});

test("a store that fails is a failure, and leaves no scratch", async (t) => {
  const fx = await storageFixture(t);
  const { run, jobs } = fakeRun();

  const { outcome } = await capture(fx, run, {
    store: async () => {
      throw new Error("System encryption is unavailable.");
    },
  });

  const expected = {
    status: "failed",
    error: "System encryption is unavailable.",
  };
  assert.deepEqual(outcome, expected);
  await assertGone(jobs[0].scratch);
  assert.deepEqual(await lastOutcome(fx.vault), {
    at: NOW.toISOString(),
    from: A,
    to: B,
    ...expected,
  });
});

test("blocked or no Electron version skips", async (t) => {
  const unknown = "Claude Desktop's Electron version is unknown";
  const cases: [string, Partial<Parameters<typeof captureDrafts>[0]>, string][] = [
    [
      "blocked",
      { blocked: "drafts move only on macOS" },
      "drafts move only on macOS",
    ],
    ["running", { blocked: "Claude is running" }, "Claude is running"],
    ["no Electron version", { claudeElectron: undefined }, unknown],
  ];
  for (const [name, extra, reason] of cases) {
    const fx = await storageFixture(t);
    const storage = path.join(fx.root, LOCAL_STORAGE);
    // What the sweeps would remove, had the step gone on.
    await fs.mkdir(path.join(storage, "leveldb.relay-1234"));
    await fs.mkdir(path.join(storage, ".relay-work-5678"));
    const stale = await fs.mkdtemp(path.join(fx.tmp, "relay-drafts-"));
    const eleven = new Date(Date.now() - 11 * 60_000);
    await fs.utimes(stale, eleven, eleven);
    const before = await snapshot(storage);
    const { run, jobs } = fakeRun();

    const { outcome, stored } = await capture(fx, run, extra);

    assert.deepEqual(outcome, { status: "skipped", reason }, name);
    assert.equal(jobs.length, 0, name);
    assert.deepEqual(stored, [], name);
    // Nothing is swept, copied or made.
    assert.deepEqual(await snapshot(storage), before, name);
    assert.deepEqual(await fs.readdir(fx.tmp), [path.basename(stale)], name);
    assert.deepEqual(
      await lastOutcome(fx.vault),
      { at: NOW.toISOString(), from: A, to: B, status: "skipped", reason },
      name,
    );
  }
});

test("last.json holds no text", async (t) => {
  const fx = await storageFixture(t);

  assert.equal((await capture(fx, fakeRun().run)).outcome.status, "captured");

  const drafts = path.join(fx.vault, "drafts");
  const raw = await fs.readFile(path.join(drafts, "last.json"), "utf8");
  for (const text of [UNSENT, NEW_SESSION_TEXT, "B's own draft"])
    assert.ok(!raw.includes(text), raw);
  // Counts and reasons only.
  assert.deepEqual(JSON.parse(raw), {
    at: NOW.toISOString(),
    from: A,
    to: B,
    status: "captured",
    count: 2,
  });
  // Private to Relay, like the directory made for it.
  assert.equal((await fs.stat(drafts)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(drafts, "last.json"))).mode & 0o777,
    0o600,
  );
});

test("stale scratch is swept, relay-old is never touched", async (t) => {
  const fx = await storageFixture(t);
  const storage = path.join(fx.root, LOCAL_STORAGE);
  // What a crashed helper left: a scratch dir whose link leads to a Claude dir.
  const claude = path.join(fx.base, "fake-claude");
  await fs.mkdir(path.join(claude, "leveldb"), { recursive: true });
  await fs.writeFile(path.join(claude, "leveldb", "CURRENT"), "MANIFEST-1\n");
  const stale = await fs.mkdtemp(path.join(fx.tmp, "relay-drafts-"));
  await fs.mkdir(path.join(stale, "root"));
  await fs.symlink(claude, path.join(stale, "root", "Local Storage"));
  // Younger than ten minutes: it may belong to a step still running.
  const fresh = await fs.mkdtemp(path.join(fx.tmp, "relay-drafts-"));
  // Not a scratch dir, however old.
  const other = path.join(fx.tmp, "someone-else");
  await fs.mkdir(other);
  const eleven = new Date(Date.now() - 11 * 60_000);
  await fs.utimes(stale, eleven, eleven);
  await fs.utimes(other, eleven, eleven);
  // What the first design left in Claude's Local Storage: a leveldb it set aside, which is
  // never deleted, and a working dir and an unfinished copy, which are.
  const old = path.join(storage, "leveldb.relay-old-0123");
  await fs.cp(fx.leveldb, old, { recursive: true });
  const kept = await snapshot(old);
  await fs.mkdir(path.join(storage, `.relay-work-${randomUUID()}`, "leveldb"), {
    recursive: true,
  });
  await fs.mkdir(path.join(storage, `leveldb.relay-${randomUUID()}`));

  assert.equal((await capture(fx, fakeRun().run)).outcome.status, "captured");

  await assertGone(stale);
  assert.ok((await fs.lstat(fresh)).isDirectory());
  assert.ok((await fs.lstat(other)).isDirectory());
  assert.equal(
    await fs.readFile(path.join(claude, "leveldb", "CURRENT"), "utf8"),
    "MANIFEST-1\n",
  );
  assert.deepEqual(await storageNames(fx), [
    "leveldb",
    "leveldb.relay-old-0123",
  ]);
  assert.deepEqual(await snapshot(old), kept);

  // Without leveldb, what is beside it may be all that is left of Claude's data: it all stays.
  await fs.mkdir(path.join(storage, ".relay-work-5678"));
  await fs.rename(fx.leveldb, path.join(fx.base, "elsewhere"));
  assert.deepEqual((await capture(fx, fakeRun().run)).outcome, {
    status: "skipped",
    reason: "no Local Storage",
  });
  assert.deepEqual(await storageNames(fx), [
    ".relay-work-5678",
    "leveldb.relay-old-0123",
  ]);
  assert.deepEqual(await snapshot(old), kept);
});

test("no Local Storage → skipped, run not called", async (t) => {
  const fx = await storageFixture(t);
  await fs.rm(fx.leveldb, { recursive: true });
  const { run, jobs } = fakeRun();

  const { outcome, stored } = await capture(fx, run);

  assert.deepEqual(outcome, { status: "skipped", reason: "no Local Storage" });
  assert.equal(jobs.length, 0);
  assert.deepEqual(stored, []);
  assert.deepEqual(await fs.readdir(fx.tmp), []);
  assert.deepEqual(await lastOutcome(fx.vault), {
    at: NOW.toISOString(),
    from: A,
    to: B,
    status: "skipped",
    reason: "no Local Storage",
  });
});

test("a leveldb that cannot be copied fails, and the helper never runs", async (t) => {
  const { run, jobs } = fakeRun();

  const linked = await storageFixture(t);
  const real = path.join(linked.base, "real-leveldb");
  await fs.rename(linked.leveldb, real);
  await fs.symlink(real, linked.leveldb);
  assert.deepEqual((await capture(linked, run)).outcome, {
    status: "failed",
    error: "Local Storage/leveldb is a symbolic link.",
  });
  assert.deepEqual(await fs.readdir(linked.tmp), []);

  const broken = await storageFixture(t);
  const undo = failCopies(1);
  t.after(undo);
  const { outcome } = await capture(broken, run);
  undo();
  assert.deepEqual(outcome, {
    status: "failed",
    error: "injected copy failure 1",
  });
  // The half copy went with the scratch dir.
  assert.deepEqual(await fs.readdir(broken.tmp), []);
  assert.deepEqual(await storageNames(broken), ["leveldb"]);
  assert.equal(
    (await lastOutcome(broken.vault)).error,
    "injected copy failure 1",
  );

  assert.equal(jobs.length, 0);
});

test("without drafts worth keeping, no draft is stored but the slots read are", async (t) => {
  const fx = await storageFixture(t);
  const { run } = fakeRun({
    ok: true,
    drafts: { [P + ALIAS_Y]: draft(B, "B's own draft"), [P + ALIAS_X]: draft(A, " ") },
  });

  const { outcome, stored } = await capture(fx, run);

  assert.deepEqual(outcome, { status: "captured", count: 0 });
  // So the vault can drop an older draft A no longer has in them.
  assert.deepEqual(stored, [{ to: B, drafts: [], slots: READ_SLOTS }]);
  assert.equal((await lastOutcome(fx.vault)).count, 0);
});

test("Claude opening after the copy stops the step before the run", async (t) => {
  // Asked once, after the copy. A check that throws counts as running.
  const cases: [string, () => Promise<boolean>][] = [
    ["running", async () => true],
    [
      "unknown",
      async () => {
        throw new Error("ps failed");
      },
    ],
  ];
  for (const [name, running] of cases) {
    const fx = await storageFixture(t);
    const before = await snapshot(path.join(fx.root, LOCAL_STORAGE));
    const seen: string[][] = [];
    const { run, jobs } = fakeRun();

    const { outcome, stored } = await capture(fx, run, {
      running: async () => {
        // What the step's scratch dir holds when it asks.
        for (const scratch of await fs.readdir(fx.tmp))
          seen.push(await fs.readdir(path.join(fx.tmp, scratch)));
        return running();
      },
    });

    const expected = { status: "skipped", reason: "Claude is running" };
    assert.deepEqual(outcome, expected, name);
    // Asked once, with the copy made.
    assert.deepEqual(seen, [["copy"]], name);
    assert.equal(jobs.length, 0, name);
    assert.deepEqual(stored, [], name);
    // The copy is gone, and Claude's leveldb is as it was.
    assert.deepEqual(await fs.readdir(fx.tmp), [], name);
    assert.deepEqual(
      await snapshot(path.join(fx.root, LOCAL_STORAGE)),
      before,
      name,
    );
    assert.deepEqual(
      await lastOutcome(fx.vault),
      { at: NOW.toISOString(), from: A, to: B, ...expected },
      name,
    );
  }
  // Still closed: the run goes ahead.
  const fx = await storageFixture(t);
  const { run, jobs } = fakeRun();
  const { outcome } = await capture(fx, run, { running: async () => false });
  assert.equal(outcome.status, "captured");
  assert.equal(jobs.length, 1);
});

test("a link inside leveldb fails the step, and the helper never runs", async (t) => {
  const fx = await storageFixture(t);
  await fs.symlink("LOCK", path.join(fx.leveldb, "link"));
  const { run, jobs } = fakeRun();

  const { outcome } = await capture(fx, run);

  assert.deepEqual(outcome, {
    status: "failed",
    error: "Local Storage/leveldb/link is a symbolic link.",
  });
  assert.equal(jobs.length, 0);
  assert.deepEqual(await fs.readdir(fx.tmp), []);
});

test("a long error is cut to 300 characters", async (t) => {
  const fx = await storageFixture(t);
  const long = "e".repeat(299) + "Ω" + "tail".repeat(250);
  const { run } = fakeRun({ ok: false, error: long });

  const { outcome } = await capture(fx, run);

  assert.deepEqual(outcome, { status: "failed", error: long.slice(0, 300) });
  assert.equal((await lastOutcome(fx.vault)).error, long.slice(0, 300));
  // A blocked reason, which may be any error Relay caught, is cut the same way.
  const blocked = await storageFixture(t);
  const { outcome: skipped } = await capture(blocked, fakeRun().run, {
    blocked: long,
  });
  assert.deepEqual(skipped, { status: "skipped", reason: long.slice(0, 300) });
  assert.equal((await lastOutcome(blocked.vault)).reason, long.slice(0, 300));
});

test("last.json is never written through a linked drafts dir", async (t) => {
  const fx = await storageFixture(t);
  const target = path.join(fx.base, "outside");
  await fs.mkdir(target);
  await fs.symlink(target, path.join(fx.vault, "drafts"));

  assert.equal((await capture(fx, fakeRun().run)).outcome.status, "captured");

  assert.deepEqual(await fs.readdir(target), []);
});

// --- The sealed draft vault -------------------------------------------------------

// A stand-in for safeStorage: the text is base64 behind a marker, so it never shows as is.
const seal = (text: string) =>
  Buffer.from("SEALED:" + Buffer.from(text).toString("base64"));
const unseal = (data: Buffer) => {
  const text = data.toString();
  if (!text.startsWith("SEALED:")) throw new Error("not sealed");
  return Buffer.from(text.slice(7), "base64").toString();
};
const DAY = 24 * 60 * 60_000;

async function vaultFixture(t: any) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "relay-draft-vault-"));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  let clock = NOW.getTime();
  const now = () => clock;
  return {
    vault,
    file: path.join(vault, "drafts", "pending.bin"),
    drafts: new DraftVault(vault, seal, unseal, now),
    // Another vault on the same files, as after a restart of Relay.
    reopen: () => new DraftVault(vault, seal, unseal, now),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const conversationDraft = (targetAlias: string, text = UNSENT): CapturedDraft => ({
  targetAlias,
  title: `Title of ${targetAlias}`,
  text,
  attachments: false,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("the vault gives back what it was given, sealed in between", async (t) => {
  const v = await vaultFixture(t);
  const newSession: CapturedDraft = {
    newSession: true,
    title: "",
    text: NEW_SESSION_TEXT,
    attachments: true,
  };

  await v.drafts.add(B, [conversationDraft(ALIAS_X), newSession]);

  const records = await v.reopen().list();
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.match(record.id, UUID);
    assert.equal(record.to, B);
    assert.equal(record.capturedAt, NOW.toISOString());
    assert.equal(record.state, "pending");
    assert.equal("reason" in record, false);
  }
  assert.notEqual(records[0].id, records[1].id);
  const strip = ({ id, to, capturedAt, state, ...draft }: DraftRecord) => draft;
  assert.deepEqual(records.map(strip), [conversationDraft(ALIAS_X), newSession]);
  // A summary for the panel: everything but the text and the alias.
  assert.deepEqual(summarize(records[0]), {
    id: records[0].id,
    to: B,
    title: `Title of ${ALIAS_X}`,
    newSession: false,
    attachments: false,
    state: "pending",
    capturedAt: NOW.toISOString(),
  });
  assert.equal(summarize(records[1]).newSession, true);
  assert.ok(!JSON.stringify(records.map(summarize)).includes(UNSENT));
  // The file is private to Relay.
  assert.equal((await fs.stat(v.file)).mode & 0o777, 0o600);
});

test("the vault's file does not hold the text", async (t) => {
  const v = await vaultFixture(t);
  await v.drafts.add(B, [conversationDraft(ALIAS_X)]);
  const raw = await fs.readFile(v.file);
  assert.ok(raw.toString().startsWith("SEALED:"));
  assert.ok(!raw.includes(Buffer.from(UNSENT)));
  assert.ok(!raw.includes(Buffer.from(`Title of ${ALIAS_X}`)));
});

test("the vault keeps at most 20 records, the newest", async (t) => {
  const v = await vaultFixture(t);
  const aliases = Array.from({ length: 25 }, () => randomUUID());
  for (const alias of aliases) {
    await v.drafts.add(B, [conversationDraft(alias)]);
    v.advance(1000);
  }
  const records = await v.drafts.list();
  assert.equal(records.length, 20);
  // Newest first.
  assert.deepEqual(
    records.map((record) => record.targetAlias),
    aliases.slice(5).reverse(),
  );
  // A batch bigger than the cap keeps its first 20.
  const batch = Array.from({ length: 21 }, () => conversationDraft(randomUUID()));
  await v.drafts.add(C, batch);
  assert.deepEqual(
    (await v.drafts.list()).map((record) => record.targetAlias),
    batch.slice(0, 20).map((draft) => draft.targetAlias),
  );
});

test("the newest capture wins per account and conversation", async (t) => {
  const v = await vaultFixture(t);
  const newSession = (text: string): CapturedDraft => ({
    newSession: true,
    title: "",
    text,
    attachments: false,
  });
  await v.drafts.add(B, [conversationDraft(ALIAS_X, "older"), newSession("old start")]);
  const [olderX] = await v.drafts.list();
  await v.drafts.update(olderX.id, { state: "needs-copy", reason: "lost" });
  v.advance(1000);
  await v.drafts.add(B, [conversationDraft(ALIAS_X, "newer"), newSession("new start")]);
  // The same conversation for another account, and another conversation, stay.
  await v.drafts.add(C, [conversationDraft(ALIAS_X, "C's")]);
  await v.drafts.add(B, [conversationDraft(ALIAS_Y, "Y's")]);

  const records = await v.drafts.list();
  const view = records.map((record) => [record.to, record.targetAlias, record.text, record.state]);
  assert.deepEqual(view.sort(), [
    [B, ALIAS_X, "newer", "pending"],
    [B, ALIAS_Y, "Y's", "pending"],
    [B, undefined, "new start", "pending"],
    [C, ALIAS_X, "C's", "pending"],
  ].sort());
  assert.ok(!records.some((record) => record.id === olderX.id));
});

test("records older than seven days are dropped", async (t) => {
  const v = await vaultFixture(t);
  await v.drafts.add(B, [conversationDraft(ALIAS_X)]);
  v.advance(DAY);
  await v.drafts.add(B, [conversationDraft(ALIAS_Y)]);

  v.advance(6 * DAY);
  // X is exactly seven days old: kept.
  assert.equal((await v.drafts.list()).length, 2);
  v.advance(1);
  assert.deepEqual(
    (await v.drafts.list()).map((record) => record.targetAlias),
    [ALIAS_Y],
  );
  // Dropped from the file too, not only from the answer.
  const sealed = JSON.parse(unseal(await fs.readFile(v.file)));
  assert.equal(sealed.length, 1);
  v.advance(DAY);
  assert.deepEqual(await v.drafts.list(), []);
  await assertGone(v.file);
});

test("a record's state changes and the record goes, by id", async (t) => {
  const v = await vaultFixture(t);
  await v.drafts.add(B, [conversationDraft(ALIAS_X), conversationDraft(ALIAS_Y)]);
  const [x, y] = await v.drafts.list();

  await v.drafts.update(x.id, { state: "needs-copy", reason: "accessibility" });
  let [first] = await v.reopen().list();
  assert.equal(first.state, "needs-copy");
  assert.equal(first.reason, "accessibility");
  // The text and the rest are as they were.
  assert.deepEqual({ ...first, state: x.state, reason: undefined }, { ...x, reason: undefined });
  // A patch without a reason keeps it; one that clears it removes it.
  await v.drafts.update(x.id, { state: "pending" });
  [first] = await v.drafts.list();
  assert.equal(first.reason, "accessibility");
  await v.drafts.update(x.id, { state: "needs-copy", reason: undefined });
  [first] = await v.drafts.list();
  assert.equal("reason" in first, false);
  // An unknown id changes nothing.
  const before = await fs.readFile(v.file);
  await v.drafts.update(randomUUID(), { state: "needs-copy" });
  await v.drafts.remove(randomUUID());
  assert.deepEqual(await fs.readFile(v.file), before);

  await v.drafts.remove(x.id);
  assert.deepEqual((await v.drafts.list()).map((record) => record.id), [y.id]);
  // The last one takes the file with it.
  await v.drafts.remove(y.id);
  assert.deepEqual(await v.drafts.list(), []);
  await assertGone(v.file);
});

test("a corrupt vault file reads as empty", async (t) => {
  const v = await vaultFixture(t);
  await fs.mkdir(path.dirname(v.file), { recursive: true });
  const valid = {
    id: randomUUID(),
    to: B,
    targetAlias: ALIAS_X,
    title: "",
    text: UNSENT,
    attachments: false,
    capturedAt: NOW.toISOString(),
    state: "pending",
  };
  for (const contents of [
    Buffer.from("not sealed at all"),
    seal("not json"),
    seal("null"),
    seal('{"records":[]}'),
    seal(JSON.stringify([{ ...valid, state: "sent" }])),
    seal(JSON.stringify([{ ...valid, text: 7 }])),
    seal(JSON.stringify([{ ...valid, capturedAt: "yesterday" }])),
    seal(JSON.stringify([{ ...valid, targetAlias: undefined }])),
    seal(JSON.stringify([{ ...valid, newSession: true }])),
  ]) {
    await fs.writeFile(v.file, contents);
    assert.deepEqual(await v.drafts.list(), [], contents.toString());
  }
  // Only the records that are wrong are left out.
  await fs.writeFile(
    v.file,
    seal(JSON.stringify([valid, { ...valid, id: "" }, "junk", null])),
  );
  assert.deepEqual(await v.drafts.list(), [valid]);
  // A corrupt file does not stop the next capture.
  await fs.writeFile(v.file, "garbage");
  await v.drafts.add(B, [conversationDraft(ALIAS_Y)]);
  assert.deepEqual(
    (await v.drafts.list()).map((record) => record.targetAlias),
    [ALIAS_Y],
  );
});

/** A vault on `v`'s files that tells its diagnosis hooks' calls to `calls`. */
function watchedVault(v: { vault: string }, unsealWith = unseal) {
  const calls = {
    errors: [] as Array<[string, string]>,
    rejected: [] as number[],
    listed: [] as number[],
  };
  const drafts = new DraftVault(v.vault, seal, unsealWith, undefined, {
    onReadError: (stage, message) => calls.errors.push([stage, message]),
    onRecordRejected: (index) => calls.rejected.push(index),
    onList: (count) => calls.listed.push(count),
  });
  return { drafts, calls };
}
const validRecord = () => ({
  id: randomUUID(),
  to: B,
  targetAlias: ALIAS_X,
  title: "",
  text: UNSENT,
  attachments: false,
  capturedAt: NOW.toISOString(),
  state: "pending",
});

test("onReadError says whether the file could not be unsealed or parsed, with a label that holds no text", async (t) => {
  const v = await vaultFixture(t);
  await fs.mkdir(path.dirname(v.file), { recursive: true });
  const { drafts, calls } = watchedVault(v);
  // Unsealing throws.
  await fs.writeFile(v.file, Buffer.from("not sealed at all"));
  assert.deepEqual(await drafts.list(), []);
  assert.deepEqual(calls.errors, [["unseal", "unseal-failed"]]);
  // The same failure on the next read is not told again.
  await drafts.list();
  assert.equal(calls.errors.length, 1);
  // Bad JSON. The parser's own message quotes the data, so a fixed label is told instead.
  await fs.writeFile(v.file, seal(`not json, ${UNSENT}`));
  await drafts.list();
  assert.deepEqual(calls.errors.at(-1), ["parse", "invalid-json"]);
  // Valid JSON that is not a list.
  await fs.writeFile(v.file, seal(JSON.stringify({ text: UNSENT })));
  await drafts.list();
  assert.deepEqual(calls.errors.at(-1), ["parse", "not-an-array"]);
  await fs.writeFile(v.file, seal("null"));
  await drafts.list();
  assert.equal(calls.errors.length, 3);
  // A read that works starts it over: the same failure after it is told again.
  await fs.writeFile(v.file, seal(JSON.stringify([validRecord()])));
  assert.equal((await drafts.list()).length, 1);
  await fs.writeFile(v.file, seal("not json"));
  await drafts.list();
  assert.equal(calls.errors.length, 4);
  assert.equal(JSON.stringify(calls).includes(UNSENT), false);
});

test("onReadError never carries the message of an unseal that throws, or of a read that fails", async (t) => {
  const v = await vaultFixture(t);
  await v.drafts.add(B, [conversationDraft(ALIAS_X)]);
  // An unseal whose message quotes what it was given.
  const quoting = watchedVault(v, (data) => {
    throw new Error(`cannot unseal ${data.toString()} ${UNSENT}`);
  });
  await quoting.drafts.list();
  assert.deepEqual(quoting.calls.errors, [["unseal", "unseal-failed"]]);
  assert.equal(JSON.stringify(quoting.calls).includes(UNSENT), false);
  // Without system encryption the label says so.
  const locked = watchedVault(v, () => {
    throw new Error("System encryption is unavailable.");
  });
  await locked.drafts.list();
  assert.deepEqual(locked.calls.errors, [["unseal", "encryption-unavailable"]]);
  // A file that cannot be read at all: the errno, never the message with its path.
  const unreadable = watchedVault(v);
  const readFile = fs.readFile;
  t.after(() => {
    fs.readFile = readFile;
  });
  fs.readFile = (async (target: any, ...rest: any[]) => {
    if (target === v.file)
      throw Object.assign(new Error(`EIO: injected, open '${v.file}'`), {
        code: "EIO",
      });
    return (readFile as any)(target, ...rest);
  }) as typeof fs.readFile;
  assert.deepEqual(await unreadable.drafts.list(), []);
  await assert.rejects(unreadable.drafts.remove("x"), { code: "EIO" });
  assert.deepEqual(unreadable.calls.errors, [["read", "EIO"]]);
  fs.readFile = readFile;
});

test("onRecordRejected is told the index of each entry that is not a record, once per change", async (t) => {
  const v = await vaultFixture(t);
  await fs.mkdir(path.dirname(v.file), { recursive: true });
  const { drafts, calls } = watchedVault(v);
  const valid = validRecord();
  await fs.writeFile(
    v.file,
    seal(JSON.stringify([valid, { ...valid, id: "" }, "junk", { ...valid, state: "sent" }, null])),
  );
  assert.deepEqual(await drafts.list(), [valid]);
  assert.deepEqual(calls.rejected, [1, 2, 3, 4]);
  // The next read of the same file says nothing more.
  await drafts.list();
  assert.deepEqual(calls.rejected, [1, 2, 3, 4]);
  assert.deepEqual(calls.errors, []);
  // A file with every entry valid, and then a malformed one again, is told again.
  await fs.writeFile(v.file, seal(JSON.stringify([valid])));
  await drafts.list();
  await fs.writeFile(v.file, seal(JSON.stringify([valid, 7])));
  await drafts.list();
  assert.deepEqual(calls.rejected, [1, 2, 3, 4, 1]);
  assert.equal(JSON.stringify(calls).includes(UNSENT), false);
});

test("onList is told the count only when it differs from the last one told", async (t) => {
  const v = await vaultFixture(t);
  const { drafts, calls } = watchedVault(v);
  await drafts.list();
  await drafts.list();
  assert.deepEqual(calls.listed, [0]);
  await drafts.add(B, [conversationDraft(ALIAS_X)]);
  await drafts.list();
  await drafts.list();
  assert.deepEqual(calls.listed, [0, 1]);
  await drafts.add(B, [conversationDraft(ALIAS_Y)]);
  await drafts.list();
  assert.deepEqual(calls.listed, [0, 1, 2]);
  const [record] = await drafts.list();
  await drafts.remove(record.id);
  await drafts.list();
  assert.deepEqual(calls.listed, [0, 1, 2, 1]);
});

test("a hook that throws never disturbs the vault", async (t) => {
  const v = await vaultFixture(t);
  const boom = () => {
    throw new Error("diagnosis failed");
  };
  const drafts = new DraftVault(v.vault, seal, unseal, undefined, {
    onReadError: boom,
    onRecordRejected: boom,
    onList: boom,
  });
  await drafts.add(B, [conversationDraft(ALIAS_X)]);
  assert.equal((await drafts.list()).length, 1);
  await fs.writeFile(v.file, "garbage");
  assert.deepEqual(await drafts.list(), []);
});

test("a vault file that cannot be read is never overwritten", async (t) => {
  const v = await vaultFixture(t);
  await v.drafts.add(B, [conversationDraft(ALIAS_X)]);
  const before = await fs.readFile(v.file);
  const [record] = await v.drafts.list();
  // The read fails for a reason that says nothing about what the file holds.
  const readFile = fs.readFile;
  t.after(() => {
    fs.readFile = readFile;
  });
  fs.readFile = (async (target: any, ...rest: any[]) => {
    if (target === v.file)
      throw Object.assign(new Error("injected read failure"), { code: "EIO" });
    return (readFile as any)(target, ...rest);
  }) as typeof fs.readFile;

  await assert.rejects(v.drafts.add(B, [conversationDraft(ALIAS_Y)]), {
    code: "EIO",
  });
  await assert.rejects(v.drafts.update(record.id, { state: "needs-copy" }), {
    code: "EIO",
  });
  await assert.rejects(v.drafts.remove(record.id), { code: "EIO" });
  // A read for the panel or the restorer shows nothing and changes nothing.
  assert.deepEqual(await v.drafts.list(), []);
  fs.readFile = readFile;

  assert.deepEqual(await fs.readFile(v.file), before);
  assert.deepEqual(await v.drafts.list(), [record]);
});

test("a capture that read a slot and found nothing drops the stale draft there", async (t) => {
  const v = await vaultFixture(t);
  const newSession: CapturedDraft = {
    newSession: true,
    title: "",
    text: NEW_SESSION_TEXT,
    attachments: false,
  };
  const alias = randomUUID();
  await v.drafts.add(B, [
    conversationDraft(ALIAS_X),
    conversationDraft(ALIAS_Y),
    conversationDraft(alias),
    newSession,
  ]);
  // The same slots for another account, which a capture for B never touches.
  await v.drafts.add(C, [conversationDraft(ALIAS_X), newSession]);
  // Y waits to be copied by hand: it is never re-typed, so it is not stale.
  const y = (await v.drafts.list()).find(
    (record) => record.to === B && record.targetAlias === ALIAS_Y,
  )!;
  await v.drafts.update(y.id, { state: "needs-copy", reason: "lost" });
  v.advance(1000);
  const slots = (records: DraftRecord[]) =>
    records
      .map((record) => `${record.to === B ? "B" : "C"}/${record.targetAlias ?? "new"}`)
      .sort();

  // A conversation the capture read and A had no draft in.
  await v.drafts.add(B, [], { aliases: [ALIAS_X, ALIAS_Y], newSession: false });
  assert.deepEqual(slots(await v.drafts.list()), [
    `B/${ALIAS_Y}`,
    `B/${alias}`,
    "B/new",
    `C/${ALIAS_X}`,
    "C/new",
  ].sort());

  // The new-session screen, read and found empty.
  await v.drafts.add(B, [conversationDraft(alias, "newer")], {
    aliases: [alias],
    newSession: true,
  });
  const records = await v.drafts.list();
  assert.deepEqual(slots(records), [`B/${ALIAS_Y}`, `B/${alias}`, `C/${ALIAS_X}`, "C/new"].sort());
  assert.equal(
    records.find((record) => record.to === B && record.targetAlias === alias)!.text,
    "newer",
  );
  // A capture that read nothing (no slots given) drops nothing.
  const file = await fs.readFile(v.file);
  await v.drafts.add(B, []);
  assert.deepEqual(await fs.readFile(v.file), file);
});

test("vault changes made at the same time all land", async (t) => {
  const v = await vaultFixture(t);
  await Promise.all([
    v.drafts.add(B, [conversationDraft(ALIAS_X)]),
    v.drafts.add(B, [conversationDraft(ALIAS_Y)]),
    v.drafts.add(C, [conversationDraft(ALIAS_X)]),
  ]);
  assert.equal((await v.drafts.list()).length, 3);
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
  // Killed is not gone: until it exits it may still have the copy and its result file open.
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

// --- Starting the helper process --------------------------------------------------

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await pause(5);
  assert.ok(condition(), "timed out waiting");
}

// runHelper with a real scratch dir, recording what it spawns, writes and reads.
async function startHelper(
  t: any,
  options: {
    packaged?: boolean;
    env?: NodeJS.ProcessEnv;
    existingJob?: boolean;
  } = {},
) {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-drafts-spawn-"),
  );
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  if (options.existingJob)
    await fs.writeFile(path.join(scratch, "job.json"), "planted");
  const helperJob = {
    ...job(),
    scratch,
    result: path.join(scratch, "result.json"),
  };
  const spawned: { command: string; args: string[]; options: SpawnOptions }[] =
    [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const writes: unknown[][] = [];
  const reads: string[] = [];
  const env = options.env ?? { PATH: "/usr/bin" };
  const outcome = runHelper(helperJob, {
    execPath: "/Applications/Relay.app/Contents/MacOS/Relay",
    packaged: options.packaged ?? true,
    dir: "/relay/dist-electron",
    env,
    spawn: (command, args, spawnOptions) => {
      spawned.push({ command, args: [...args], options: spawnOptions });
      const fake = fakeChild();
      children.push(fake);
      return fake.child;
    },
    writeFile: async (file, data, writeOptions) => {
      writes.push([file, data, writeOptions]);
      await fs.writeFile(file, data, writeOptions);
    },
    readFile: async (file, encoding) => {
      reads.push(file);
      return fs.readFile(file, encoding);
    },
  });
  const jobFile = path.join(scratch, "job.json");
  return {
    job: helperJob,
    outcome,
    spawned,
    children,
    writes,
    reads,
    env,
    jobFile,
    flag: DRAFT_WORKER_FLAG + jobFile,
  };
}

// What a helper reports: every composer draft, as Claude stored it.
const reported = {
  [P + ALIAS_X]: draft(A, "an unsent draft"),
  [NEW_SESSION_DRAFT]: draft(A, "a new session"),
};
const success = JSON.stringify({ ok: true, drafts: reported });

test("packaged, the helper is Relay itself with only the job flag", async (t) => {
  const h = await startHelper(t, { packaged: true });
  await until(() => h.spawned.length === 1);
  assert.equal(
    h.spawned[0].command,
    "/Applications/Relay.app/Contents/MacOS/Relay",
  );
  assert.deepEqual(h.spawned[0].args, [h.flag]);
  assert.equal(h.spawned[0].options.stdio, "ignore");
  await fs.writeFile(h.job.result, success);
  h.children[0].emitter.emit("exit", 0, null);
  assert.deepEqual(await h.outcome, { ok: true, drafts: reported });
});

test("in development, the helper script is given before the job flag", async (t) => {
  const h = await startHelper(t, { packaged: false });
  await until(() => h.spawned.length === 1);
  assert.deepEqual(h.spawned[0].args, [
    path.join("/relay/dist-electron", "draft-worker.cjs"),
    h.flag,
  ]);
  h.children[0].emitter.emit("exit", 1, null);
  assert.deepEqual(await h.outcome, { ok: false, error: "no result" });
});

test("the helper's environment never runs Electron as Node", async (t) => {
  const env = { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", KEEP: "me" };
  const h = await startHelper(t, { env });
  await until(() => h.spawned.length === 1);
  const given = h.spawned[0].options.env!;
  assert.equal("ELECTRON_RUN_AS_NODE" in given, false);
  assert.equal(given.KEEP, "me");
  assert.equal(given.PATH, "/usr/bin");
  // Relay's own environment is left as it was.
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  h.children[0].emitter.emit("exit", 1, null);
  await h.outcome;
});

test("the job file is written new and private before the helper starts", async (t) => {
  const h = await startHelper(t);
  await until(() => h.spawned.length === 1);
  assert.deepEqual(h.writes, [
    [h.jobFile, JSON.stringify(h.job), { mode: 0o600, flag: "wx" }],
  ]);
  assert.equal((await fs.stat(h.jobFile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(h.jobFile, "utf8")), h.job);
  h.children[0].emitter.emit("exit", 1, null);
  await h.outcome;
});

test("a job file that already exists is not reused, and nothing is started", async (t) => {
  const h = await startHelper(t, { existingJob: true });
  await assert.rejects(h.outcome, { code: "EEXIST" });
  assert.deepEqual(h.spawned, []);
  assert.equal(await fs.readFile(h.jobFile, "utf8"), "planted");
});

test("the result is read only after the helper exited", async (t) => {
  const h = await startHelper(t);
  await until(() => h.spawned.length === 1);
  // The result is already there, but the helper has not exited yet.
  await fs.writeFile(h.job.result, success);
  await pause(30);
  assert.deepEqual(h.reads, []);
  h.children[0].emitter.emit("exit", 0, null);
  assert.deepEqual(await h.outcome, { ok: true, drafts: reported });
  assert.deepEqual(h.reads, [h.job.result]);
});

test("the result file is removed right after it is read", async (t) => {
  // It holds the drafts' text, so it must not wait for the scratch dir to go.
  const h = await startHelper(t);
  await until(() => h.spawned.length === 1);
  await fs.writeFile(h.job.result, success);
  h.children[0].emitter.emit("exit", 0, null);
  assert.deepEqual(await h.outcome, { ok: true, drafts: reported });
  await assertGone(h.job.result);
  // A failed helper's result goes the same way.
  const failed = await startHelper(t);
  await until(() => failed.spawned.length === 1);
  await fs.writeFile(failed.job.result, "not json");
  failed.children[0].emitter.emit("exit", 1, null);
  assert.deepEqual(await failed.outcome, { ok: false, error: "no result" });
  await assertGone(failed.job.result);
});

test("a result over 16 MiB is never read", async (t) => {
  const limit = 16 * 1024 * 1024;
  // Exactly the limit is read: JSON may end in spaces.
  const h = await startHelper(t);
  await until(() => h.spawned.length === 1);
  await fs.writeFile(h.job.result, success.padEnd(limit, " "));
  h.children[0].emitter.emit("exit", 0, null);
  assert.deepEqual(await h.outcome, { ok: true, drafts: reported });
  assert.deepEqual(h.reads, [h.job.result]);

  // One byte more is no result, and is still removed.
  const big = await startHelper(t);
  await until(() => big.spawned.length === 1);
  await fs.writeFile(big.job.result, success.padEnd(limit + 1, " "));
  big.children[0].emitter.emit("exit", 0, null);
  assert.deepEqual(await big.outcome, { ok: false, error: "no result" });
  assert.deepEqual(big.reads, []);
  await assertGone(big.job.result);
});

test("a result file that is not a plain file is not read", async (t) => {
  const h = await startHelper(t);
  await until(() => h.spawned.length === 1);
  const elsewhere = path.join(h.job.scratch, "elsewhere.json");
  await fs.writeFile(elsewhere, success);
  await fs.symlink(elsewhere, h.job.result);
  h.children[0].emitter.emit("exit", 0, null);
  assert.deepEqual(await h.outcome, { ok: false, error: "no result" });
  assert.deepEqual(h.reads, []);
  // The link goes, never what it leads to.
  await assertGone(h.job.result);
  assert.equal(await fs.readFile(elsewhere, "utf8"), success);

  const dir = await startHelper(t);
  await until(() => dir.spawned.length === 1);
  await fs.mkdir(dir.job.result);
  dir.children[0].emitter.emit("exit", 0, null);
  assert.deepEqual(await dir.outcome, { ok: false, error: "no result" });
  assert.deepEqual(dir.reads, []);
});

// --- Reading the helper's answer --------------------------------------------------

const exited = (
  code: number | null,
  signal: NodeJS.Signals | null = null,
): HelperExit => ({ code, signal, timedOut: false });

test("a written success counts only with exit code 0", () => {
  assert.deepEqual(helperOutcome(exited(0), success), {
    ok: true,
    drafts: reported,
  });
  assert.deepEqual(helperOutcome(exited(1), success), {
    ok: false,
    error: "the helper exited with code 1",
  });
  assert.deepEqual(helperOutcome(exited(null, "SIGTERM"), success), {
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
    drafts: reported,
    moved: 1,
    text: "an unsent draft",
  });
  assert.deepEqual(helperOutcome(exited(0), extra), {
    ok: true,
    drafts: reported,
  });
});

test("a helper that timed out failed, whatever it wrote", () => {
  assert.deepEqual(
    helperOutcome({ code: null, signal: "SIGKILL", timedOut: true }, success),
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
    '{"ok":"yes","drafts":{}}',
    // The old answer, from before the helper only read.
    '{"ok":true,"moved":1,"owned":0,"skipped":0}',
    // The drafts are a map from composer-draft keys to strings, and nothing else.
    '{"ok":true,"drafts":null}',
    '{"ok":true,"drafts":[]}',
    '{"ok":true,"drafts":"x"}',
    '{"ok":true,"drafts":["composer-draft:a"]}',
    '{"ok":true,"drafts":{"composer-draft:a":1}}',
    '{"ok":true,"drafts":{"composer-draft:a":null}}',
    '{"ok":true,"drafts":{"composer-draft:a":{"text":"t"}}}',
    '{"ok":true,"drafts":{"other:a":"x"}}',
    '{"ok":true,"drafts":{"":"x"}}',
    '{"ok":true,"drafts":{"__proto__":"x"}}',
    '{"ok":true,"drafts":{"composer-draft:a":"x","other:b":"y"}}',
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

test("no drafts is a valid answer", () => {
  assert.deepEqual(helperOutcome(exited(0), '{"ok":true,"drafts":{}}'), {
    ok: true,
    drafts: {},
  });
});

test("an answer is limited to 500 drafts and 4 MiB", () => {
  const answer = (drafts: Record<string, string>) =>
    helperOutcome(exited(0), JSON.stringify({ ok: true, drafts }));
  const keys = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`composer-draft:${i}`, "t"]),
    );
  assert.equal(answer(keys(500)).ok, true);
  assert.deepEqual(answer(keys(501)), { ok: false, error: "no result" });

  // Keys count as well as values: the limit is on the total length.
  const key = "composer-draft:a";
  const limit = 4 * 1024 * 1024;
  assert.deepEqual(answer({ [key]: "x".repeat(limit - key.length) }), {
    ok: true,
    drafts: { [key]: "x".repeat(limit - key.length) },
  });
  assert.deepEqual(answer({ [key]: "x".repeat(limit - key.length + 1) }), {
    ok: false,
    error: "no result",
  });
  // Several drafts add up.
  const half = "x".repeat(limit / 2 - 16);
  assert.equal(
    answer({ "composer-draft:a": half, "composer-draft:b": half }).ok,
    true,
  );
  assert.deepEqual(
    answer({ "composer-draft:a": half, "composer-draft:b": half + "x" }),
    { ok: false, error: "no result" },
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
