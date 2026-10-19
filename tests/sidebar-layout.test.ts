import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LIST_LIMIT,
  MOVE_BATCH,
  UnsupportedSidebar,
  planSidebarGap,
  readSidebarStorage,
  sidebarRecipe,
  type SidebarGap,
} from "../electron/core/sidebar-layout";
import { SidebarGapVault } from "../electron/core/sidebar-vault";
import { sidebarActions } from "../electron/core/sidebar-main";
import { MAX_SIDEBAR_CHARS, SIDEBAR_KEYS } from "../electron/core/sidebar-keys";
import { helperOutcome } from "../electron/core/draft-transfer";
import { runDraftJob, type DraftJob } from "../electron/draft-job";
import type { CarriedConversation } from "../electron/core/desktop-files";

const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
const scopeOf = () => ({ accountUuid: randomUUID(), orgId: randomUUID() });
const key = (s: { accountUuid: string; orgId: string }) => `${s.accountUuid}/${s.orgId}`;
const code = (alias: string) => `code:local_${alias}`;
const section = (id: string, kind: string, name: string, order: number, extra = {}) => ({
  id,
  kind,
  v: 2,
  name,
  order,
  sortBy: "recency",
  ascending: false,
  show: { metadata: false, emptyGroups: false, sideChats: false },
  collapsed: false,
  shown: true,
  ...extra,
});
const builtins = (manual: object[] = []) => [
  section("pinned", "pinned", "", 0),
  section("routines", "routines", "", 1),
  ...manual,
  section("sessions", "sessions", "", 99, { groupBy: "folder" }),
];
const wrapped = (value: unknown) =>
  JSON.stringify({ value, tabId: "", timestamp: 1792400846879 });

/**
 * Local Storage values shaped like Claude Desktop's on 2026-10-19: `dframe-store` holds the
 * groups and sections, and the LSS copies lag behind it by one group.
 */
function storage(input: {
  scope: { accountUuid: string; orgId: string };
  groups: { id: string; name: string; members: string[] }[];
  lssDropsLast?: boolean;
  starred?: string[];
  storeVersion?: number;
}) {
  const groups = input.groups.map(({ id, name }) => ({ id, name }));
  const assignments = Object.fromEntries(
    input.groups.flatMap((g) => g.members.map((m) => [code(m), g.id])),
  );
  const order = Object.fromEntries(
    input.groups.filter((g) => g.members.length).map((g) => [g.id, g.members.map(code)]),
  );
  const sections = builtins(
    input.groups.map((g, i) =>
      section(g.id, "manual", g.name, 2 + i, { members: g.members.map(code) }),
    ),
  );
  const lssGroups = input.lssDropsLast ? groups.slice(0, -1) : groups;
  return {
    "dframe-store": JSON.stringify({
      state: {
        collapsed: false,
        pinnedOrder: [],
        customGroupsByScope: { [key(input.scope)]: { groups, assignments, order } },
        codeSidebarByScope: {
          [key(input.scope)]: { sections, migratedFrom: 1, prefsSeeded: true },
        },
      },
      version: input.storeVersion ?? 1,
      shared: 1,
    }),
    "LSS-persisted.dframe-group-scopes": wrapped({
      [key(input.scope)]: { groups: lssGroups, assignments, order },
    }),
    "LSS-persisted.dframe-code-sections": wrapped({
      [key(input.scope)]: {
        sections: sections.map((s) => ({ ...s, ...("members" in s ? { members: [] } : {}) })),
        migratedFrom: 1,
        prefsSeeded: true,
      },
    }),
    "LSS-persisted.starred-local-code-sessions": wrapped(
      (input.starred ?? []).map((a) => `local_${a}`),
    ),
  };
}

test("a scope's sections come from dframe-store, in sidebar order, with their sessions in order", () => {
  const scope = scopeOf();
  const [a, b, c] = ids(3);
  const raw = storage({
    scope,
    groups: [
      { id: "cg-1", name: "bidsorted", members: [b, a] },
      { id: "cg-2", name: " legesis ", members: [c] },
      { id: "cg-3", name: "bidsorted-landing", members: [] },
    ],
    // Desktop's own LSS copy lacked the newest, empty group: the sidebar still shows it.
    lssDropsLast: true,
  });
  assert.deepEqual(readSidebarStorage(raw).layout(scope), [
    { id: "cg-1", name: "bidsorted", members: [b, a] },
    { id: "cg-2", name: "legesis", members: [c] },
    { id: "cg-3", name: "bidsorted-landing", members: [] },
  ]);
});

test("the scope is found whatever the case of its key, and other scopes stay apart", () => {
  const scope = scopeOf();
  const [a] = ids(1);
  const raw = storage({ scope, groups: [{ id: "cg-1", name: "x", members: [a] }] });
  const upper = { accountUuid: scope.accountUuid.toUpperCase(), orgId: scope.orgId.toUpperCase() };
  assert.equal(readSidebarStorage(raw).layout(upper).length, 1);
  assert.deepEqual(readSidebarStorage(raw).layout(scopeOf()), []);
});

test("the LSS copies count only for a scope dframe-store does not have at all", () => {
  const scope = scopeOf();
  const [a] = ids(1);
  const raw = storage({ scope, groups: [{ id: "cg-1", name: "x", members: [a] }] });
  delete (raw as Record<string, string>)["dframe-store"];
  assert.deepEqual(readSidebarStorage(raw).layout(scope), [
    { id: "cg-1", name: "x", members: [a] },
  ]);
});

test("a group deleted, or filings undone, in dframe-store do not come back from the lagging LSS copy", () => {
  const scope = scopeOf();
  const [b] = ids(1);
  const raw = storage({
    scope,
    groups: [
      { id: "cg-1", name: "kept", members: [] },
      { id: "cg-2", name: "deleted", members: [b] },
    ],
  });
  const store = JSON.parse(raw["dframe-store"]);
  const groups = store.state.customGroupsByScope[key(scope)];
  // The user deleted "deleted" and unfiled everything; only dframe-store has caught up.
  groups.groups = groups.groups.filter((g: { id: string }) => g.id === "cg-1");
  groups.assignments = {};
  groups.order = {};
  const sections = store.state.codeSidebarByScope[key(scope)];
  sections.sections = sections.sections.filter((s: { id: string }) => s.id !== "cg-2");
  for (const s of sections.sections) if (s.members) s.members = [];
  raw["dframe-store"] = JSON.stringify(store);
  assert.deepEqual(readSidebarStorage(raw).layout(scope), [
    { id: "cg-1", name: "kept", members: [] },
  ]);
});

test("a section with no name of its own shows its group's", () => {
  const scope = scopeOf();
  const raw = storage({ scope, groups: [{ id: "cg-1", name: "from-group", members: [] }] });
  const store = JSON.parse(raw["dframe-store"]);
  store.state.codeSidebarByScope[key(scope)].sections[2].name = "";
  raw["dframe-store"] = JSON.stringify(store);
  assert.equal(readSidebarStorage(raw).layout(scope)[0].name, "from-group");
});

test("no sidebar keys at all read as no sections and no pins", () => {
  const read = readSidebarStorage({});
  assert.deepEqual(read.layout(scopeOf()), []);
  assert.deepEqual([...read.starred], []);
});

test("pins are read as lower-case aliases; a pin of another kind is ignored, one Relay cannot read refuses", () => {
  const [a, b] = ids(2);
  const pins = (list: unknown[]) =>
    readSidebarStorage({ "LSS-persisted.starred-local-code-sessions": wrapped(list) }).starred;
  assert.deepEqual([...pins([`local_${a.toUpperCase()}`, `code:local_${b}`, "routine_daily"])], [a, b]);
  // Read as unpinned, these would be moved, and a move unpins on every account.
  assert.throws(() => pins([42]), UnsupportedSidebar);
  assert.throws(() => pins([`cloud_${a}`]), UnsupportedSidebar);
  assert.throws(() => pins([`local_${a}_v2`]), UnsupportedSidebar);
});

test("a shape Relay does not know is refused, never guessed at", () => {
  const scope = scopeOf();
  const good = () => storage({ scope, groups: [{ id: "cg-1", name: "x", members: [] }] });
  const refused = (raw: Record<string, string>) =>
    assert.throws(() => readSidebarStorage(raw).layout(scope), UnsupportedSidebar);

  refused(storage({ scope, groups: [], storeVersion: 2 }));
  refused({ ...good(), "dframe-store": "{not json" });
  refused({ ...good(), "LSS-persisted.dframe-group-scopes": "[]" });
  const v3 = good();
  const store = JSON.parse(v3["dframe-store"]);
  store.state.codeSidebarByScope[key(scope)].sections[2].v = 3;
  v3["dframe-store"] = JSON.stringify(store);
  refused(v3);
  const badGroups = good();
  const store2 = JSON.parse(badGroups["dframe-store"]);
  store2.state.customGroupsByScope[key(scope)].groups = { id: "cg-1" };
  badGroups["dframe-store"] = JSON.stringify(store2);
  refused(badGroups);
});

// Two accounts sharing conversations, each by the same alias unless `rename` says otherwise.
function carried(
  pairs: { alias: string; from: string; to?: string }[],
  target: string,
): CarriedConversation[] {
  return pairs.map(({ alias, from, to }) => ({
    targetAlias: to ?? alias,
    members: [
      { alias, accountUuid: from },
      ...(to ? [{ alias: to, accountUuid: target }] : []),
    ],
  }));
}

test("the gap lists missing sections, empty ones too, with the target's aliases", () => {
  const A = randomUUID();
  const B = randomUUID();
  const [x, y, z, renamed] = ids(4);
  const gap = planSidebarGap({
    sources: [
      {
        accountUuid: A,
        layout: [
          { id: "cg-1", name: "bidsorted", members: [x, y] },
          { id: "cg-2", name: "landing", members: [] },
        ],
      },
    ],
    target: { accountUuid: B, layout: [] },
    conversations: carried([{ alias: x, from: A }, { alias: y, from: A, to: renamed }, { alias: z, from: A }], B),
    starred: new Set(),
  });
  assert.deepEqual(gap, {
    sections: [
      { name: "bidsorted", ids: [x, renamed] },
      { name: "landing", ids: [] },
    ],
    missingSections: 2,
    sessions: 2,
    from: [A],
  });
});

test("fill gaps only: what the target already has is never moved, and pins are left alone", () => {
  const A = randomUUID();
  const B = randomUUID();
  const [filed, pinned, open, uncarried] = ids(4);
  const gap = planSidebarGap({
    sources: [
      {
        accountUuid: A,
        layout: [
          { id: "cg-1", name: "kept", members: [filed, pinned, open, uncarried] },
          { id: "cg-2", name: "already-there", members: [] },
        ],
      },
    ],
    target: { accountUuid: B, layout: [
      { id: "cg-9", name: "already-there", members: [] },
      { id: "cg-8", name: "elsewhere", members: [filed] },
    ] },
    conversations: carried([{ alias: filed, from: A }, { alias: pinned, from: A }, { alias: open, from: A }], B),
    starred: new Set([pinned]),
  });
  // `filed` stays where the target put it; `pinned` would be unpinned everywhere if moved;
  // `uncarried` never reached the target; an existing empty section needs nothing.
  assert.deepEqual(gap, {
    sections: [{ name: "kept", ids: [open] }],
    missingSections: 1,
    sessions: 1,
    from: [A],
  });
});

test("a section the target has is listed only for the sessions to file in it", () => {
  const A = randomUUID();
  const [x] = ids(1);
  const gap = planSidebarGap({
    sources: [{ accountUuid: A, layout: [{ id: "cg-1", name: "same", members: [x] }] }],
    target: { accountUuid: randomUUID(), layout: [{ id: "cg-2", name: "same", members: [] }] },
    conversations: carried([{ alias: x, from: A }], randomUUID()),
    starred: new Set(),
  });
  assert.deepEqual(gap, {
    sections: [{ name: "same", ids: [x] }],
    missingSections: 0,
    sessions: 1,
    from: [A],
  });
});

test("nothing missing is no gap", () => {
  const A = randomUUID();
  const [x] = ids(1);
  assert.equal(
    planSidebarGap({
      sources: [{ accountUuid: A, layout: [{ id: "cg-1", name: "same", members: [x] }] }],
      target: { accountUuid: randomUUID(), layout: [{ id: "cg-2", name: "same", members: [x] }] },
      conversations: carried([{ alias: x, from: A }], randomUUID()),
      starred: new Set(),
    }),
    undefined,
  );
  assert.equal(
    planSidebarGap({ sources: [], target: { accountUuid: randomUUID(), layout: [] }, conversations: [], starred: new Set() }),
    undefined,
  );
});

test("the account being left comes first: it places sections and decides where a session goes", () => {
  const left = randomUUID();
  const other = randomUUID();
  const [x, y] = ids(2);
  const gap = planSidebarGap({
    sources: [
      { accountUuid: left, layout: [{ id: "cg-1", name: "mine", members: [x] }] },
      {
        accountUuid: other,
        layout: [
          { id: "cg-2", name: "theirs", members: [x, y] },
          { id: "cg-3", name: "mine", members: [y] },
        ],
      },
    ],
    target: { accountUuid: randomUUID(), layout: [] },
    conversations: [
      { targetAlias: x, members: [{ alias: x, accountUuid: left }, { alias: x, accountUuid: other }] },
      { targetAlias: y, members: [{ alias: y, accountUuid: other }] },
    ],
    starred: new Set(),
  });
  assert.deepEqual(gap?.sections, [
    { name: "mine", ids: [x] },
    { name: "theirs", ids: [y] },
  ]);
  assert.deepEqual(gap?.from, [left, other]);
});

test("a conversation the target had filed under an alias the merge replaced goes back to the target's section", () => {
  const A = randomUUID();
  const B = randomUUID();
  const [oldAlias, newAlias] = ids(2);
  const gap = planSidebarGap({
    sources: [{ accountUuid: A, layout: [{ id: "cg-1", name: "theirs", members: [newAlias] }] }],
    target: { accountUuid: B, layout: [{ id: "cg-9", name: "mine", members: [oldAlias] }] },
    // B's card `oldAlias` is replaced by A's newer `newAlias`.
    conversations: [
      {
        targetAlias: newAlias,
        members: [
          { alias: newAlias, accountUuid: A },
          { alias: oldAlias, accountUuid: B },
        ],
      },
    ],
    starred: new Set(),
  });
  assert.deepEqual(gap, {
    sections: [
      { name: "mine", ids: [newAlias] },
      { name: "theirs", ids: [] },
    ],
    missingSections: 1,
    sessions: 1,
    from: [A],
  });
});

test("a recipe that only restores the target's own filing names no source", () => {
  const text = sidebarRecipe(
    { sections: [{ name: "mine", ids: [randomUUID()] }], missingSections: 0, sessions: 1, from: [] },
    { to: "Alto", from: [] },
  );
  assert.match(text, /\(Alto\)\. They put sessions back where this account had filed them/);
});

test("the recipe names the accounts, keeps the order and the fill-gaps rules, and lists ids", () => {
  const [x, y] = ids(2);
  const gap: SidebarGap = {
    sections: [
      { name: "bidsorted", ids: [x, y] },
      { name: "landing", ids: [] },
    ],
    missingSections: 2,
    sessions: 2,
    from: [],
  };
  const text = sidebarRecipe(gap, { to: "Alto", from: ["Vertex"] });
  assert.match(text, /on this account \(Alto\)\. They come from Vertex/);
  assert.match(text, /list_sections, create_section, move_sessions/);
  // list_sessions lists 20 by default and leaves archived ones out.
  assert.match(text, new RegExp(`list_sessions with limit ${LIST_LIMIT} and include_archived true`));
  assert.ok(LIST_LIMIT >= 1000);
  assert.match(text, /the same name \(ignoring spaces at either end\)/);
  assert.match(text, new RegExp(`at most ${MOVE_BATCH} ids per call`));
  assert.match(text, /never pin or unpin anything/);
  assert.match(text, /one whose pinned is true/);
  assert.match(text, /one whose group is already another section/);
  assert.match(text, new RegExp(`### bidsorted\\n\\nlocal_${x} local_${y}\\n`));
  assert.match(text, /### landing\n\n\(no sessions: create the section only\)/);
  assert.ok(text.indexOf("### bidsorted") < text.indexOf("### landing"));
});

async function vaultDir(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-sidebar-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const someGap = (): SidebarGap => ({
  sections: [{ name: "x", ids: [randomUUID()] }],
  missingSections: 1,
  sessions: 1,
  from: [randomUUID()],
});

test("the vault keeps one offer, gives it back, and removes it only by its own id", async (t) => {
  const dir = await vaultDir(t);
  const vault = new SidebarGapVault(dir);
  assert.equal(await vault.get(), undefined);
  const to = randomUUID();
  const gap = someGap();
  const first = await vault.put(to, gap);
  assert.deepEqual(await vault.get(), first);
  assert.deepEqual(first.gap, gap);
  const second = await vault.put(to, someGap());
  await vault.remove(first.id);
  assert.deepEqual(await vault.get(), second);
  await vault.remove(second.id);
  assert.equal(await vault.get(), undefined);
});

test("an offer over 14 days old, or a file the vault did not write, reads as none", async (t) => {
  const dir = await vaultDir(t);
  let now = Date.parse("2026-10-19T12:00:00Z");
  const vault = new SidebarGapVault(dir, () => now);
  await vault.put(randomUUID(), someGap());
  now += 14 * 86_400_000;
  assert.ok(await vault.get());
  now += 1;
  assert.equal(await vault.get(), undefined);
  await fs.writeFile(path.join(dir, "sidebar", "pending.json"), "{oops");
  assert.equal(await vault.get(), undefined);
  await fs.writeFile(
    path.join(dir, "sidebar", "pending.json"),
    JSON.stringify({ id: "x", to: randomUUID(), at: new Date(now).toISOString(), gap: someGap() }),
  );
  assert.equal(await vault.get(), undefined);
});

test("the helper's sidebar answer is kept only when it is the sidebar keys as strings", () => {
  const exited = { code: 0, signal: null, timedOut: false };
  const sidebar = { "dframe-store": "{}", "LSS-persisted.starred-local-code-sessions": "{}" };
  assert.deepEqual(helperOutcome(exited, JSON.stringify({ ok: true, drafts: {}, sidebar })), {
    ok: true,
    drafts: {},
    sidebar,
  });
  // Off answers lose only the sidebar: the drafts still stand.
  for (const bad of [{ other: "{}" }, { "dframe-store": 1 }, [], "x"])
    assert.deepEqual(helperOutcome(exited, JSON.stringify({ ok: true, drafts: {}, sidebar: bad })), {
      ok: true,
      drafts: {},
    });
  const huge = { "dframe-store": "x".repeat(4 * 1024 * 1024) };
  assert.deepEqual(helperOutcome(exited, JSON.stringify({ ok: true, drafts: {}, sidebar: huge })), {
    ok: true,
    drafts: {},
  });
});

test("the helper job reads the sidebar after the drafts, and a sidebar that fails costs nothing", async () => {
  const job = {} as DraftJob;
  const page = (readSidebar?: () => Promise<Record<string, string>>) => ({
    size: async () => 3,
    read: async () => ({ "composer-draft:epitaxy-draft": "{}" }),
    ...(readSidebar ? { readSidebar } : {}),
  });
  assert.deepEqual(await runDraftJob(job, page(async () => ({ "dframe-store": "{}" }))), {
    ok: true,
    drafts: { "composer-draft:epitaxy-draft": "{}" },
    sidebar: { "dframe-store": "{}" },
  });
  assert.deepEqual(
    await runDraftJob(job, page(async () => {
      throw new Error("no");
    })),
    { ok: true, drafts: { "composer-draft:epitaxy-draft": "{}" } },
  );
  assert.deepEqual(await runDraftJob(job, page()), {
    ok: true,
    drafts: { "composer-draft:epitaxy-draft": "{}" },
  });  // A sidebar too large to fit beside the drafts is left out.
  assert.deepEqual(
    await runDraftJob(job, page(async () => ({ "dframe-store": "x".repeat(MAX_SIDEBAR_CHARS) }))),
    { ok: true, drafts: { "composer-draft:epitaxy-draft": "{}" } },
  );
});

test("the helper reads exactly the sidebar keys, and the worker never writes them", async () => {
  assert.deepEqual([...SIDEBAR_KEYS], [
    "dframe-store",
    "LSS-persisted.dframe-group-scopes",
    "LSS-persisted.dframe-code-sections",
    "LSS-persisted.starred-local-code-sessions",
  ]);
  const worker = await fs.readFile(new URL("../electron/draft-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /localStorage\.getItem\(key\)/);
  assert.doesNotMatch(worker, /setItem|removeItem|\.clear\(/);
});

test("Copy recipe writes the clipboard in main, resolves with nothing, and keeps the offer", async () => {
  const id = randomUUID();
  const clipboard: string[] = [];
  const events: string[] = [];
  let changed = 0;
  const actions = sidebarActions({
    gaps: {
      sidebarRecipe: async (asked) => (asked === id ? "the recipe" : undefined),
      dismissSidebarGap: async (asked) => void events.push(`dismiss:${asked}`),
    },
    writeClipboard: (text) => void clipboard.push(text),
    changed: () => void changed++,
    log: (event, fields) => void events.push(`${event}:${JSON.stringify(fields)}`),
  });
  assert.equal(await actions.copy(id), undefined);
  assert.deepEqual(clipboard, ["the recipe"]);
  await assert.rejects(actions.copy(randomUUID()), /no longer there/);
  await assert.rejects(actions.copy("not-an-id"));
  assert.deepEqual(clipboard, ["the recipe"]);
  assert.equal(await actions.dismiss(id), undefined);
  await assert.rejects(actions.dismiss("../x"));
  assert.ok(events.includes(`dismiss:${id}`));
  assert.ok(events.every((e) => !e.includes("the recipe")));
  assert.equal(changed, 3);
});
