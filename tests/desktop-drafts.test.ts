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
} from "../electron/core/drafts";
import {
  LEVELDB,
  LOCAL_STORAGE,
  backupLocalStorage,
  discardWorkingCopy,
  makeWorkingCopy,
  PutBackFailed,
  pruneDraftBackups,
  swapInWorkingCopy,
  sweepDraftLeftovers,
  syncWorkingCopy,
} from "../electron/core/draft-storage";
import {
  awaitHelper,
  draftsBlockedReason,
  electronMismatch,
  helperOutcome,
  preserveDrafts,
  runHelper,
  type HelperExit,
} from "../electron/core/draft-transfer";
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

// --- Local Storage backup, working copy and swap ---------------------------------

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

test("a working copy is a byte-exact copy beside leveldb", async (t) => {
  const { root, leveldb } = await storageFixture(t);
  const before = await snapshot(leveldb);
  const work = await makeWorkingCopy(root);
  assert.equal(path.dirname(work), path.join(root, LOCAL_STORAGE));
  assert.match(
    path.basename(work),
    /^\.relay-work-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(await fs.readdir(work), ["leveldb"]);
  assert.deepEqual(await snapshot(path.join(work, "leveldb")), before);
  assert.deepEqual(await snapshot(leveldb), before);
  // Every copy gets its own directory.
  assert.notEqual(await makeWorkingCopy(root), work);
});

test("a relative symlink stays relative in the backup and the working copy", async (t) => {
  const { root, vault, leveldb } = await storageFixture(t);
  await fs.symlink("LOCK", path.join(leveldb, "link"));
  const backup = (await backupLocalStorage(root, vault, new Date()))!;
  assert.equal(await fs.readlink(path.join(backup, "leveldb", "link")), "LOCK");
  const work = await makeWorkingCopy(root);
  assert.equal(await fs.readlink(path.join(work, "leveldb", "link")), "LOCK");
});

test("a missing or linked leveldb gets no working copy", async (t) => {
  const { root, base, leveldb } = await storageFixture(t);
  const real = path.join(base, "real-leveldb");
  await fs.rename(leveldb, real);
  await fs.symlink(real, leveldb);
  await assert.rejects(makeWorkingCopy(root), /symbolic link/);
  await fs.rm(leveldb);
  await assert.rejects(makeWorkingCopy(root), /missing/);
  assert.deepEqual(await fs.readdir(path.join(root, LOCAL_STORAGE)), []);
});

// A root user ignores file modes, so the chmod-based tests prove nothing there.
const needsPermissions = {
  skip: process.getuid?.() === 0 && "root can read a mode 0 file",
};

test(
  "an unreadable leveldb file fails the working copy and leaves none behind",
  needsPermissions,
  async (t) => {
    const { root, leveldb } = await storageFixture(t);
    const file = path.join(leveldb, "000003.log");
    await fs.chmod(file, 0);
    try {
      await assert.rejects(makeWorkingCopy(root), { code: "EACCES" });
    } finally {
      await fs.chmod(file, 0o600);
    }
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

// A working copy the helper changed, beside the original leveldb.
async function changedCopy(t: any) {
  const fx = await storageFixture(t);
  const original = await snapshot(fx.leveldb);
  const work = await makeWorkingCopy(fx.root);
  const copy = path.join(work, "leveldb");
  await fs.writeFile(path.join(copy, "000005.ldb"), "rewritten");
  await fs.writeFile(path.join(copy, "000009.log"), "new");
  await fs.rm(path.join(copy, "LOCK"));
  const names = async () =>
    (await fs.readdir(path.join(fx.root, LOCAL_STORAGE))).sort();
  return { ...fx, work, original, changed: await snapshot(copy), names };
}

test("a swap puts the working copy in place and sets the old leveldb aside", async (t) => {
  const { root, leveldb, work, original, changed } = await changedCopy(t);
  await syncWorkingCopy(work);
  const old = await swapInWorkingCopy(root, work);
  assert.deepEqual(await snapshot(leveldb), changed);
  assert.equal(path.dirname(old), path.join(root, LOCAL_STORAGE));
  assert.match(path.basename(old), /^leveldb\.relay-old-[0-9a-f-]{36}$/);
  assert.deepEqual(await snapshot(old), original);
  // The working dir is left empty.
  assert.deepEqual(await fs.readdir(work), []);
});

test("a failure moving the live directory aside leaves it as it was", async (t) => {
  const { root, leveldb, work, original, changed, names } =
    await changedCopy(t);
  const seam = renameFailingOn(1);
  await assert.rejects(swapInWorkingCopy(root, work, seam.ops), {
    message: "injected failure 1",
  });
  assert.equal(seam.calls(), 1);
  assert.deepEqual(await snapshot(leveldb), original);
  assert.deepEqual(await snapshot(path.join(work, "leveldb")), changed);
  assert.deepEqual(await names(), [path.basename(work), "leveldb"]);
});

test("a failure putting the copy in place puts the original back", async (t) => {
  const { root, leveldb, work, original, changed, names } =
    await changedCopy(t);
  const seam = renameFailingOn(2);
  await assert.rejects(
    swapInWorkingCopy(root, work, seam.ops),
    (error: Error) =>
      error.message === "injected failure 2" &&
      !(error instanceof PutBackFailed),
  );
  assert.equal(seam.calls(), 3); // aside, copy in (fails), original back
  assert.deepEqual(await snapshot(leveldb), original);
  assert.deepEqual(await snapshot(path.join(work, "leveldb")), changed);
  // No old leveldb is left beside it.
  assert.deepEqual(await names(), [path.basename(work), "leveldb"]);
});

test("a failed put-back does not hide the error, and keeps both copies", async (t) => {
  const { root, leveldb, work, original, changed, names } =
    await changedCopy(t);
  const seam = renameFailingOn(2, 3);
  await assert.rejects(
    swapInWorkingCopy(root, work, seam.ops),
    (error: Error) =>
      error instanceof PutBackFailed && error.message === "injected failure 2",
  );
  await assert.rejects(fs.lstat(leveldb), { code: "ENOENT" });
  const [workName, oldName, ...rest] = await names();
  assert.equal(workName, path.basename(work));
  assert.match(oldName, /^leveldb\.relay-old-/);
  assert.deepEqual(rest, []);
  assert.deepEqual(
    await snapshot(path.join(root, LOCAL_STORAGE, oldName)),
    original,
  );
  assert.deepEqual(await snapshot(path.join(work, "leveldb")), changed);
});

test("a working copy is discarded only while leveldb is in place", async (t) => {
  const { root, leveldb, work, names } = await changedCopy(t);
  const aside = path.join(root, LOCAL_STORAGE, "leveldb.relay-old-1234");
  await fs.rename(leveldb, aside);
  // Without leveldb, the copy may be what is left of Claude's data.
  await discardWorkingCopy(root, work);
  assert.deepEqual(await names(), [path.basename(work), path.basename(aside)]);
  await fs.rename(aside, leveldb);
  await discardWorkingCopy(root, work);
  assert.deepEqual(await names(), ["leveldb"]);
});

test("the sweep removes only unfinished copies, and only while leveldb is in place", async (t) => {
  const { root, leveldb } = await storageFixture(t);
  const storage = path.join(root, LOCAL_STORAGE);
  const before = await snapshot(leveldb);
  // Claude's own earlier leveldb, set aside by a swap: never deleted.
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
    storage: "/claude/Local Storage/.relay-work-1234",
    scratch: "/tmp/relay-draft-job",
    result: "/tmp/relay-draft-job/result.json",
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
const NOW_STAMP = "2026-10-16T10-00-00-000Z";
// The Electron version the gate read from Claude.app.
const CLAUDE_ELECTRON = "44.7.2";
// Until captured drafts are stored, a run only reads: nothing is swapped in.
const CAPTURE_PENDING = "capture pending";

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

// What Claude's Local Storage directory holds, sorted.
async function storageNames(fx: { root: string }) {
  return (await fs.readdir(path.join(fx.root, LOCAL_STORAGE))).sort();
}

// A stand-in for the helper: it leaves its scratch dir the way the real one does (a root
// whose "Local Storage" links to the job's storage, and a userData), then does `effect` and
// answers.
function fakeRun(
  effect?: (job: DraftJob) => Promise<DraftResult | void>,
  answer: DraftResult = { ok: true, drafts: {} },
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

// What a helper does to the leveldb it was given. Returns what that leveldb then holds.
async function rewrite(job: DraftJob) {
  const leveldb = path.join(job.storage, "leveldb");
  await fs.writeFile(path.join(leveldb, "000005.ldb"), "rewritten");
  await fs.writeFile(path.join(leveldb, "000009.log"), "new");
  // Gone already when an earlier run's rewrite was swapped in.
  await fs.rm(path.join(leveldb, "LOCK"), { force: true });
  return snapshot(leveldb);
}

// Claude stays closed unless `running` says otherwise.
function transfer(
  fx: { root: string; vault: string; tmp: string },
  run: (job: DraftJob) => Promise<DraftResult>,
  extra: {
    now?: Date;
    blocked?: string;
    claudeElectron?: string;
    running?: () => Promise<boolean>;
  } = {},
) {
  return preserveDrafts({
    root: fx.root,
    vault: fx.vault,
    from: A,
    to: B,
    conversations: [carried(ALIAS_X, [ALIAS_X, A], [ALIAS_X, B])],
    run,
    now: NOW,
    claudeElectron: CLAUDE_ELECTRON,
    running: async () => false,
    tmp: fx.tmp,
    ...extra,
  });
}

// A `running` check that answers in turn from `answers` (true, false, or "throw"), then false.
function runningSequence(...answers: (boolean | "throw")[]) {
  let calls = 0;
  const running = async () => {
    const answer = answers[calls++] ?? false;
    if (answer === "throw") throw new Error("ps failed");
    return answer;
  };
  return { running, calls: () => calls };
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

test("a successful run never swaps: its working copy is dropped and the step is pending", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun(async (job) => {
    await rewrite(job);
    // What the read-only helper answers: the drafts' text must never reach last.json.
    return { ok: true, drafts: { [P + ALIAS_X]: draft(A, "an unsent draft") } };
  });

  const outcome = await transfer(fx, run);

  assert.deepEqual(outcome, { status: "skipped", reason: CAPTURE_PENDING });
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(path.dirname(job.scratch), fx.tmp);
  assert.equal(job.result, path.join(job.scratch, "result.json"));
  assert.equal(job.claudeElectron, CLAUDE_ELECTRON);
  // The job names only where to read: no accounts, no conversations.
  assert.deepEqual(Object.keys(job).sort(), [
    "claudeElectron",
    "result",
    "scratch",
    "storage",
  ]);
  // Claude's leveldb is as it was, and nothing is left beside it.
  assert.deepEqual(await snapshot(fx.leveldb), before);
  assert.deepEqual(await storageNames(fx), ["leveldb"]);
  assert.deepEqual(await backupsIn(fx.vault), [NOW_STAMP]);
  await assertGone(job.scratch);
  assert.deepEqual(await fs.readdir(fx.tmp), []);

  assert.deepEqual(await lastOutcome(fx.vault), {
    at: NOW.toISOString(),
    from: A,
    to: B,
    status: "skipped",
    reason: CAPTURE_PENDING,
  });
  const raw = await fs.readFile(
    path.join(fx.vault, "drafts", "last.json"),
    "utf8",
  );
  assert.ok(!raw.includes("an unsent draft"), raw);
});

test("the helper only ever sees the working copy", async (t) => {
  const fx = await storageFixture(t);
  const storage = path.join(fx.root, LOCAL_STORAGE);
  const before = await snapshot(fx.leveldb);
  const seen: string[] = [];
  let problem: unknown;
  const { run } = fakeRun(async (job) => {
    seen.push(job.storage);
    // A step ignores what a run throws, so a failed check is kept to be raised below.
    try {
      assert.notEqual(job.storage, storage);
      assert.equal(path.dirname(job.storage), storage);
      assert.match(path.basename(job.storage), /^\.relay-work-/);
      // A copy of Claude's leveldb, made after the backup.
      assert.deepEqual(
        await snapshot(path.join(job.storage, "leveldb")),
        before,
      );
      // While the run works on its copy, Claude's leveldb is as it was.
      await rewrite(job);
      assert.deepEqual(await snapshot(fx.leveldb), before);
    } catch (error) {
      problem = error;
    }
  });

  assert.equal((await transfer(fx, run)).status, "skipped");
  assert.equal(problem, undefined);
  assert.equal(seen.length, 1);
});

test("whatever the run answers, live stays byte-identical and the working copy is discarded", async (t) => {
  const answers: [string, () => Promise<DraftResult>][] = [
    ["ok", async () => ({ ok: true, drafts: {} })],
    ["ok false", async () => ({ ok: false, error: "verification failed" })],
    [
      "a throw",
      async () => {
        throw new Error("helper crashed");
      },
    ],
    ["no answer", async () => undefined as unknown as DraftResult],
  ];
  for (const [name, answer] of answers) {
    const fx = await storageFixture(t);
    const before = await snapshot(fx.leveldb);
    const helper = fakeRun(async (job) => {
      await rewrite(job);
    });
    const run = async (job: DraftJob) => {
      await helper.run(job);
      return answer();
    };

    const outcome = await transfer(fx, run);

    const expected = { status: "skipped", reason: CAPTURE_PENDING };
    assert.deepEqual(outcome, expected, name);
    assert.deepEqual(await snapshot(fx.leveldb), before, name);
    assert.deepEqual(await storageNames(fx), ["leveldb"], name);
    // The backup stays, in case it is ever needed by hand.
    assert.deepEqual(await backupsIn(fx.vault), [NOW_STAMP], name);
    await assertGone(helper.jobs[0].scratch);
    assert.deepEqual(
      await lastOutcome(fx.vault),
      { at: NOW.toISOString(), from: A, to: B, ...expected },
      name,
    );
  }
});

test("a working-copy failure skips and leaves nothing behind", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun();
  // The backup is the first copy, the working copy the second.
  const undo = failCopies(2);
  t.after(undo);

  const outcome = await transfer(fx, run);
  undo();

  assert.deepEqual(outcome, {
    status: "skipped",
    reason: "injected copy failure 2",
  });
  assert.equal(jobs.length, 0);
  assert.deepEqual(await snapshot(fx.leveldb), before);
  assert.deepEqual(await storageNames(fx), ["leveldb"]);
  assert.equal((await lastOutcome(fx.vault)).reason, "injected copy failure 2");
});

test("a relay-old dir from an earlier run is never deleted", async (t) => {
  const fx = await storageFixture(t);
  const storage = path.join(fx.root, LOCAL_STORAGE);
  const stray = path.join(storage, "leveldb.relay-old-0123");
  await fs.cp(fx.leveldb, stray, { recursive: true });
  const kept = await snapshot(stray);
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 10, minute));

  // A run that completes, and one that fails.
  assert.equal((await transfer(fx, fakeRun().run)).status, "skipped");
  assert.deepEqual(await storageNames(fx), [
    "leveldb",
    "leveldb.relay-old-0123",
  ]);
  const failing = fakeRun(async () => ({
    ok: false,
    error: "verification failed",
  }));
  assert.equal(
    (await transfer(fx, failing.run, { now: at(1) })).status,
    "skipped",
  );
  // And one that finds no leveldb.
  await fs.rename(fx.leveldb, path.join(fx.base, "elsewhere"));
  assert.equal(
    (await transfer(fx, fakeRun().run, { now: at(2) })).status,
    "skipped",
  );

  assert.deepEqual(await snapshot(stray), kept);
  assert.deepEqual(await storageNames(fx), ["leveldb.relay-old-0123"]);
});

test("a stale scratch dir is removed, but not what it links to", async (t) => {
  const fx = await storageFixture(t);
  // What a crashed helper left: a scratch dir whose link leads to a Claude dir.
  const claude = path.join(fx.base, "fake-claude");
  await fs.mkdir(path.join(claude, "leveldb"), { recursive: true });
  await fs.writeFile(path.join(claude, "leveldb", "CURRENT"), "MANIFEST-1\n");
  const stale = await fs.mkdtemp(path.join(fx.tmp, "relay-drafts-"));
  const fresh = await fs.mkdtemp(path.join(fx.tmp, "relay-drafts-"));
  // Not a scratch dir, however old.
  const other = path.join(fx.tmp, "someone-else");
  await fs.mkdir(other);
  await fs.mkdir(path.join(stale, "root"));
  await fs.symlink(claude, path.join(stale, "root", "Local Storage"));
  const eleven = new Date(Date.now() - 11 * 60_000);
  await fs.utimes(stale, eleven, eleven);
  await fs.utimes(other, eleven, eleven);

  assert.equal((await transfer(fx, fakeRun().run)).status, "skipped");

  await assertGone(stale);
  // Younger than ten minutes: it may belong to a step still running.
  assert.ok((await fs.lstat(fresh)).isDirectory());
  assert.ok((await fs.lstat(other)).isDirectory());
  assert.equal(
    await fs.readFile(path.join(claude, "leveldb", "CURRENT"), "utf8"),
    "MANIFEST-1\n",
  );
});

test("a prune that throws still backs up and runs", async (t) => {
  const fx = await storageFixture(t);
  // Three backups, so the prune before the new one removes the oldest, and that fails.
  for (const day of [1, 2, 3])
    await backupLocalStorage(
      fx.root,
      fx.vault,
      new Date(Date.UTC(2026, 9, day)),
    );
  const doomed = path.join(fx.vault, "drafts", "2026-10-01T00-00-00-000Z");
  const rm = fs.rm;
  t.after(() => {
    fs.rm = rm;
  });
  fs.rm = (async (target: any, ...rest: any[]) => {
    if (target === doomed)
      throw Object.assign(new Error("injected rm failure"), { code: "EPERM" });
    return (rm as any)(target, ...rest);
  }) as typeof fs.rm;
  const { run, jobs } = fakeRun();

  const outcome = await transfer(fx, run);
  fs.rm = rm;

  assert.equal(outcome.status, "skipped");
  assert.equal(jobs.length, 1);
  assert.ok((await backupsIn(fx.vault)).includes(NOW_STAMP));
  assert.ok((await backupsIn(fx.vault)).includes("2026-10-01T00-00-00-000Z"));
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

test("a run first sweeps what an earlier step left, but only while leveldb is in place", async (t) => {
  const fx = await storageFixture(t);
  const storage = path.join(fx.root, LOCAL_STORAGE);
  await fs.mkdir(path.join(storage, "leveldb.relay-5678"));
  await fs.mkdir(path.join(storage, ".relay-work-1234", "leveldb"), {
    recursive: true,
  });
  const seen: string[][] = [];
  const { run } = fakeRun(async (job) => {
    const names = await fs.readdir(storage);
    seen.push(names.filter((name) => name !== path.basename(job.storage)));
  });

  await transfer(fx, run);
  assert.deepEqual(seen, [["leveldb"]]);

  // With leveldb gone, what is beside it may be the only copy of Claude's data: it stays.
  await fs.rename(fx.leveldb, path.join(storage, "leveldb.relay-old-9999"));
  await fs.mkdir(path.join(storage, ".relay-work-5678", "leveldb"), {
    recursive: true,
  });
  assert.deepEqual(
    await transfer(fx, run, { now: new Date("2026-10-16T11:00:00.000Z") }),
    { status: "skipped", reason: "no Local Storage" },
  );
  assert.deepEqual(await storageNames(fx), [
    ".relay-work-5678",
    "leveldb.relay-old-9999",
  ]);
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

test("old backups are pruned before the new one, so at most three ever exist", async (t) => {
  const fx = await storageFixture(t);
  const during: number[] = [];
  const { run } = fakeRun(async (job) => {
    during.push((await backupsIn(fx.vault)).length);
    await rewrite(job);
  });
  const stamps: string[] = [];
  for (const day of [1, 2, 3, 4, 5]) {
    const outcome = await transfer(fx, run, {
      now: new Date(Date.UTC(2026, 9, day, 12)),
    });
    assert.equal(outcome.status, "skipped", `day ${day}`);
    stamps.push(`2026-10-0${day}T12-00-00-000Z`);
    // The two newest from before and this run's own backup, nothing else.
    assert.deepEqual(await backupsIn(fx.vault), stamps.slice(-3), `day ${day}`);
    assert.deepEqual(await storageNames(fx), ["leveldb"], `day ${day}`);
  }
  assert.deepEqual(during, [1, 2, 3, 3, 3]);
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
  assert.deepEqual(outcome, { status: "skipped", reason: CAPTURE_PENDING });
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

test("a skipped step never deletes anything in Claude's Local Storage", async (t) => {
  const { run, jobs } = fakeRun();
  const unknown = "Claude Desktop's Electron version is unknown";
  const cases: [string, Parameters<typeof transfer>[2], string][] = [
    [
      "blocked",
      { blocked: "drafts move only on macOS" },
      "drafts move only on macOS",
    ],
    ["no Electron version", { claudeElectron: undefined }, unknown],
    ["running", { running: async () => true }, "Claude is running"],
    ["unknown", runningSequence("throw"), "Claude is running"],
  ];
  for (const [name, extra, reason] of cases) {
    const fx = await storageFixture(t);
    const storage = path.join(fx.root, LOCAL_STORAGE);
    // What the sweep would remove, had the step gone on.
    await fs.mkdir(path.join(storage, "leveldb.relay-1234"));
    await fs.mkdir(path.join(storage, ".relay-work-5678"));
    const before = await snapshot(storage);
    assert.deepEqual(
      await transfer(fx, run, extra),
      { status: "skipped", reason },
      name,
    );
    assert.deepEqual(await snapshot(storage), before, name);
    assert.deepEqual(await backupsIn(fx.vault), [], name);
    assert.equal((await lastOutcome(fx.vault)).reason, reason, name);
  }
  assert.equal(jobs.length, 0);
});

test("Claude opening after the working copy is made stops the run", async (t) => {
  const fx = await storageFixture(t);
  const before = await snapshot(fx.leveldb);
  const { run, jobs } = fakeRun();
  // Closed at the start, open once the backup and the working copy are made.
  const check = runningSequence(false, true);

  assert.deepEqual(await transfer(fx, run, { running: check.running }), {
    status: "skipped",
    reason: "Claude is running",
  });

  assert.equal(check.calls(), 2);
  assert.equal(jobs.length, 0);
  assert.deepEqual(await snapshot(fx.leveldb), before);
  assert.deepEqual(await storageNames(fx), ["leveldb"]);
  assert.equal((await lastOutcome(fx.vault)).reason, "Claude is running");
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
