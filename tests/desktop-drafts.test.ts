import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
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
