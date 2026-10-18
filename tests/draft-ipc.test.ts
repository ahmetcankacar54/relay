import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../electron/core/store";
import { DesktopManager, type DesktopHost } from "../electron/core/desktop";
import { DraftVault, type DraftSummary } from "../electron/core/draft-vault";
import type { RestorerDeps, RestoreResult } from "../electron/core/draft-restorer";
import { DesktopAutomationError } from "../electron/core/desktop-continuation-host";
import {
  DraftScheduler,
  draftActions,
  draftNotice,
  draftSummaries,
  tallyStalls,
} from "../electron/core/draft-main";

const ACCOUNT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ALIAS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEXT = "an unsent draft, word for word";
const NEW_TEXT = "a new start, also unsent";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");
/** One `handle("name", …)` registration in main, up to the next registration. */
function handler(main: string, name: string) {
  const start = main.indexOf(`handle("${name}",`);
  assert.ok(start >= 0, name);
  const rest = main.slice(start + 1);
  const end = rest.search(/\n {2}(?:handle\(|ipcMain\.)/);
  return main.slice(start, start + 1 + (end < 0 ? rest.length : end));
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A real DesktopManager whose sealed vault holds a conversation draft and a new-session one. */
async function vaultFixture(t: any) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "relay-draft-ipc-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const store = new Store(path.join(temp, "Relay"));
  const seal = (s: string) =>
    Buffer.from("TEST-ENCRYPTED:" + Buffer.from(s).toString("base64"));
  const unseal = (b: Buffer) =>
    Buffer.from(b.toString().slice(15), "base64").toString();
  const host: DesktopHost = {
    available: async () => true,
    running: async () => false,
    quit: async () => {},
    launch: async () => {},
    seal,
    unseal,
    // Swept at startup: never the real os.tmpdir().
    draftScratchDir: path.join(temp, "tmp"),
  };
  const manager = new DesktopManager(
    path.join(temp, "Claude"),
    store,
    host,
    path.join(temp, ".claude"),
  );
  await manager.initialize();
  const vault = path.join(store.root, "desktop-vault");
  await new DraftVault(vault, seal, unseal).add(ACCOUNT, [
    { targetAlias: ALIAS, title: "Fix login", text: TEXT, attachments: false },
    { newSession: true, title: "", text: NEW_TEXT, attachments: true },
  ]);
  const records = await manager.pendingDraftRecords();
  assert.equal(records.length, 2);
  return { manager, records, vault };
}

test("the snapshot carries draft summaries without text", async (t) => {
  const f = await vaultFixture(t);
  const drafts = await draftSummaries(f.manager);
  assert.deepEqual(
    drafts.map((draft) => [draft.id, draft.title, draft.state]),
    f.records.map((record) => [record.id, record.title, "pending"]),
  );
  const serialized = JSON.stringify({ accounts: [], warnings: [], drafts });
  assert.ok(!serialized.includes(TEXT));
  assert.ok(!serialized.includes(NEW_TEXT));
  assert.ok(drafts.every((draft) => !("text" in draft)));
  // A vault that cannot be read shows no drafts rather than failing the snapshot.
  assert.deepEqual(
    await draftSummaries({
      pendingDrafts: () => Promise.reject(new Error("EIO")),
    }),
    [],
  );
  const main = source("../electron/main.ts");
  for (const name of ["panel-snapshot", "snapshot"])
    assert.match(handler(main, name), /drafts: await draftSummaries\(desktop\),/);
});

test("copy-draft writes the clipboard in main and removes the record", async (t) => {
  const f = await vaultFixture(t);
  const clipboard: string[] = [];
  let changed = 0;
  const actions = draftActions({
    drafts: f.manager,
    writeClipboard: (text) => clipboard.push(text),
    changed: () => changed++,
  });
  const [conversation, newSession] = f.records;
  await f.manager.markDraft(conversation.id, "needs-copy", "moved");
  await f.manager.markDraft(newSession.id, "needs-copy", "manual");

  // Nothing comes back for the renderer: the text stays in main.
  assert.equal(await actions.copy(conversation.id), undefined);
  assert.deepEqual(clipboard, [TEXT]);
  assert.deepEqual(
    (await f.manager.pendingDrafts()).map((draft) => draft.id),
    [newSession.id],
  );
  assert.equal(changed, 1);

  // A record that is gone copies nothing, and says so.
  await assert.rejects(actions.copy(conversation.id), /no longer/);
  await assert.rejects(actions.dismiss(conversation.id), /no longer/);
  assert.deepEqual(clipboard, [TEXT]);
  assert.equal(changed, 3);

  assert.equal(await actions.dismiss(newSession.id), undefined);
  assert.deepEqual(await f.manager.pendingDrafts(), []);
  assert.deepEqual(clipboard, [TEXT]);
  assert.equal(changed, 4);
});

test("copy and dismiss leave a draft still waiting to be restored alone", async (t) => {
  const f = await vaultFixture(t);
  const clipboard: string[] = [];
  const actions = draftActions({
    drafts: f.manager,
    writeClipboard: (text) => clipboard.push(text),
    changed: () => {},
  });
  for (const record of f.records) {
    await assert.rejects(actions.copy(record.id), /still waiting/);
    await assert.rejects(actions.dismiss(record.id), /still waiting/);
  }
  assert.deepEqual(clipboard, []);
  assert.deepEqual(
    (await f.manager.pendingDrafts()).map((draft) => [draft.id, draft.state]),
    f.records.map((record) => [record.id, "pending"]),
  );
});

/** Fake drafts with one record left for copy, recording each step. */
function fakeDrafts(steps: string[], over: { dismiss?: () => Promise<void> } = {}) {
  return {
    pendingDrafts: async () => {
      steps.push("list");
      return [summary(DRAFT_ID, { state: "needs-copy", reason: "moved" })];
    },
    draftText: async (id: string) => {
      steps.push(`read ${id}`);
      return TEXT;
    },
    dismissDraft:
      over.dismiss ??
      (async (id: string) => {
        steps.push(`dismiss ${id}`);
      }),
  };
}
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

test("copy writes the clipboard before the record goes, and keeps it when the clipboard fails", async () => {
  const steps: string[] = [];
  let fail = false;
  const actions = draftActions({
    drafts: fakeDrafts(steps),
    writeClipboard: (text) => {
      if (fail) throw new Error("clipboard");
      steps.push(`write ${text}`);
    },
    changed: () => steps.push("changed"),
  });
  await actions.copy(DRAFT_ID);
  assert.deepEqual(steps, [
    "list",
    `read ${DRAFT_ID}`,
    `write ${TEXT}`,
    `dismiss ${DRAFT_ID}`,
    "changed",
  ]);
  steps.length = 0;
  fail = true;
  await assert.rejects(actions.copy(DRAFT_ID), /clipboard/);
  assert.deepEqual(steps, ["list", `read ${DRAFT_ID}`, "changed"]);
});

test("copy and dismiss take only a draft id", async () => {
  const steps: string[] = [];
  let changed = 0;
  const actions = draftActions({
    drafts: fakeDrafts(steps),
    writeClipboard: () => assert.fail("nothing is copied"),
    changed: () => changed++,
  });
  for (const bad of ["../pending.bin", "", 42, undefined, { id: ALIAS }]) {
    await assert.rejects(actions.copy(bad));
    await assert.rejects(actions.dismiss(bad));
  }
  assert.deepEqual(steps, []);
  assert.equal(changed, 0);
});

test("a vault that cannot be read or changed is a normal error, never a crash", async (t) => {
  const f = await vaultFixture(t);
  await f.manager.markDraft(f.records[0].id, "needs-copy", "moved");
  // The sealed file turns into something that cannot be read.
  await fs.rm(path.join(f.vault, "drafts", "pending.bin"));
  await fs.mkdir(path.join(f.vault, "drafts", "pending.bin"));
  const clipboard: string[] = [];
  let changed = 0;
  const actions = draftActions({
    drafts: f.manager,
    writeClipboard: (text) => clipboard.push(text),
    changed: () => changed++,
  });
  await assert.rejects(actions.copy(f.records[0].id), Error);
  await assert.rejects(actions.dismiss(f.records[0].id), Error);
  assert.deepEqual(clipboard, []);
  assert.equal(changed, 2);
  assert.deepEqual(await draftSummaries(f.manager), []);
  // The vault's own change failing is an ordinary rejection too.
  const steps: string[] = [];
  const failing = draftActions({
    drafts: fakeDrafts(steps, {
      dismiss: () => Promise.reject(new Error("EIO")),
    }),
    writeClipboard: () => {},
    changed: () => {},
  });
  await assert.rejects(failing.copy(DRAFT_ID), /EIO/);
  await assert.rejects(failing.dismiss(DRAFT_ID), /EIO/);
});

function summary(id: string, over: Partial<DraftSummary> = {}): DraftSummary {
  return {
    id,
    to: ACCOUNT,
    title: `Conversation ${id}`,
    newSession: false,
    attachments: false,
    state: "pending",
    capturedAt: new Date(0).toISOString(),
    ...over,
  };
}
const stopped = (reason: string, restored = 0): RestoreResult => ({
  status: "waiting",
  restored,
  left: 1,
  reason,
});

test("a draft is counted only by runs that tried it and moved nothing", () => {
  const mine = summary("mine");
  const theirs = summary("theirs", { to: OTHER });
  const copied = summary("copied", { state: "needs-copy" });
  const all = [mine, theirs, copied];
  const run = (counts: ReadonlyMap<string, number>, result: RestoreResult, account = ACCOUNT) =>
    tallyStalls(counts, { before: all, after: all, account, result });

  // A stop counts the pending drafts of the account the run was for, and only them.
  let tally = run(new Map(), stopped("moved"));
  assert.deepEqual([...tally.counts], [["mine", 1]]);
  assert.deepEqual(tally.giveUp, []);
  tally = run(tally.counts, stopped("not-ready"), ACCOUNT.toUpperCase());
  assert.deepEqual([...tally.counts], [["mine", 2]]);
  // A run that tried nothing (Claude closed or just started: no reason) changes no count.
  tally = run(tally.counts, { status: "waiting", restored: 0, left: 1 });
  assert.deepEqual([...tally.counts], [["mine", 2]]);
  tally = run(tally.counts, { status: "idle", restored: 0, left: 0 });
  assert.deepEqual([...tally.counts], [["mine", 2]]);
  tally = tallyStalls(tally.counts, {
    before: all,
    after: all,
    account: undefined,
    result: stopped("moved"),
  });
  assert.deepEqual([...tally.counts], [["mine", 2]]);
  // The third stop in a row gives the draft up.
  tally = run(tally.counts, stopped("moved"));
  assert.deepEqual(tally.giveUp, ["mine"]);
  assert.deepEqual([...tally.counts], []);
});

test("a run that moves any draft starts every count again", () => {
  const one = summary("one");
  const two = summary("two");
  const counts = new Map([
    ["one", 2],
    ["two", 2],
  ]);
  // `two` restored, so gone.
  let tally = tallyStalls(counts, {
    before: [one, two],
    after: [one],
    account: ACCOUNT,
    result: stopped("moved", 1),
  });
  assert.deepEqual([...tally.counts], []);
  assert.deepEqual(tally.giveUp, []);
  // `two` left for copy.
  tally = tallyStalls(counts, {
    before: [one, two],
    after: [one, { ...two, state: "needs-copy" }],
    account: ACCOUNT,
    result: stopped("moved"),
  });
  assert.deepEqual([...tally.counts], []);
  assert.deepEqual(tally.giveUp, []);
  // A draft captured during the run is not counted, and one gone is forgotten.
  tally = tallyStalls(new Map([["gone", 2]]), {
    before: [one],
    after: [one, summary("fresh")],
    account: ACCOUNT,
    result: stopped("moved"),
  });
  assert.deepEqual([...tally.counts], [["one", 1]]);
});

test("a busy lock or an active user never counts; every other stop, and a restore that throws, does", () => {
  const mine = summary("mine");
  const run = (reason: string) =>
    tallyStalls(new Map([["mine", 2]]), {
      before: [mine],
      after: [mine],
      account: ACCOUNT,
      result: stopped(reason),
    });
  // Another Desktop operation held the lock, or the user was working in Claude: the draft
  // was never tried.
  for (const reason of ["busy", "active"]) {
    const tally = run(reason);
    assert.deepEqual(tally.giveUp, [], reason);
    assert.deepEqual([...tally.counts], [["mine", 2]], reason);
  }
  for (const reason of [
    "not-ready",
    "moved",
    "changed",
    "claude-not-running",
    "budget",
    "error",
  ]) {
    const tally = run(reason);
    assert.deepEqual(tally.giveUp, ["mine"], reason);
    assert.deepEqual([...tally.counts], [], reason);
  }
});

/** A scheduler over fake drafts, a fake 10 s or 60 s timer and a scripted restore. */
function harness(
  over: {
    drafts?: DraftSummary[];
    restore?: (deps: RestorerDeps) => Promise<RestoreResult>;
    /** Whether drafts are re-typed; on unless a test turns it off. */
    retype?: boolean;
  } = {},
) {
  const state = {
    clock: 0,
    drafts: over.drafts ?? [summary("one")],
    /** Desktop's current account, as config.json says. */
    account: ACCOUNT as string | undefined,
    /** How often the current account and the drafts were read. */
    accountReads: 0,
    reads: 0,
    retype: over.retype ?? true,
    results: [] as (RestoreResult | Error)[],
    runs: 0,
    marks: [] as [string, string, string | undefined][],
    notices: [] as { restored: number; left: number }[],
    changed: 0,
    armed: 0,
    cancelled: 0,
    /** The armed timer's period: 10 s or 60 s, undefined while none is armed. */
    every: undefined as number | undefined,
    tick: undefined as (() => void) | undefined,
    /** Runs inside the scripted restore, as the restorer changing the vault. */
    during: undefined as (() => void) | undefined,
    /** Runs right after a mark changed a draft. */
    afterMark: undefined as ((id: string) => void | Promise<void>) | undefined,
    /** What fails: reading the drafts, marking one, the notification, telling the panel. */
    fail: new Set<"read" | "mark" | "notify" | "changed">(),
    /** The drafts whose mark fails, one by one. */
    failMark: new Set<string>(),
    /** Every event the scheduler and the restorer's deps logged, in order. */
    logs: [] as Array<Record<string, unknown>>,
  };
  const restorer = {
    currentAccount: async () => {
      state.accountReads++;
      return state.account;
    },
    mark: async (id: string, next: DraftSummary["state"], reason?: string) => {
      state.marks.push([id, next, reason]);
      if (state.fail.has("mark") || state.failMark.has(id))
        throw new Error("EIO");
      state.drafts = state.drafts.map((draft) =>
        draft.id === id ? { ...draft, state: next, reason } : draft,
      );
      await state.afterMark?.(id);
    },
    notify: (notice: { restored: number; left: number }) => {
      state.notices.push(notice);
      if (state.fail.has("notify")) throw new Error("notification");
    },
    now: () => state.clock,
    log: (event: string, fields?: Record<string, unknown>) => {
      state.logs.push({ event, ...fields });
    },
  } as unknown as RestorerDeps;
  const scheduler = new DraftScheduler({
    restorer,
    drafts: async () => {
      state.reads++;
      if (state.fail.has("read")) throw new Error("EIO");
      return state.drafts;
    },
    changed: () => {
      state.changed++;
      if (state.fail.has("changed")) throw new Error("renderer");
    },
    retype: () => state.retype,
    restore:
      over.restore ??
      (async (deps) => {
        state.runs++;
        await deps.currentAccount();
        state.during?.();
        const next = state.results.shift() ?? {
          status: "idle",
          restored: 0,
          left: 0,
        };
        if (next instanceof Error) throw next;
        return next;
      }),
    every: (fn, ms) => {
      assert.ok(ms === 10_000 || ms === 60_000, String(ms));
      // One timer at a time: a new one only after the last was cancelled.
      assert.equal(state.tick, undefined);
      state.armed++;
      state.every = ms;
      state.tick = fn;
      return () => {
        state.cancelled++;
        state.every = undefined;
        state.tick = undefined;
      };
    },
  });
  return { scheduler, state };
}

test("each run logs its stall tally, and a give-up logs the draft and why", async () => {
  const { scheduler, state } = harness();
  state.results.push(stopped("changed"), stopped("moved"), stopped("moved"));
  await scheduler.afterSwitch();
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(
    state.logs.filter((e) => e.event === "stalls" || e.event === "give-up"),
    [
      { event: "stalls", giveUp: 0, reason: "changed", status: "waiting" },
      { event: "stalls", giveUp: 0, reason: "moved", status: "waiting" },
      { event: "stalls", giveUp: 1, reason: "moved", status: "waiting" },
      { event: "give-up", id: "one", reason: "moved", marked: true },
    ],
  );
  // A draft that cannot be marked is logged as given up and not marked.
  const failing = harness();
  failing.state.failMark.add("one");
  failing.state.results.push(stopped("moved"), stopped("moved"), stopped("moved"));
  await failing.scheduler.afterSwitch();
  await failing.scheduler.tick();
  await failing.scheduler.tick();
  assert.deepEqual(failing.state.logs.find((e) => e.event === "give-up"), {
    event: "give-up",
    id: "one",
    reason: "moved",
    marked: false,
  });
});

test("an idle run, and one that threw, log their tally with a fixed reason", async () => {
  const idle = harness();
  await idle.scheduler.afterSwitch();
  assert.deepEqual(idle.state.logs, [
    { event: "stalls", giveUp: 0, reason: null, status: "idle" },
  ]);
  const threw = harness();
  threw.state.results.push(new Error("a message that must never be logged"));
  await threw.scheduler.afterSwitch();
  assert.deepEqual(threw.state.logs, [
    { event: "stalls", giveUp: 0, reason: "error", status: "waiting" },
  ]);
});

test("each retry after accessibility logs how many drafts it moved", async () => {
  const { scheduler, state } = harness({ drafts: [forAccess("a"), forAccess("b")] });
  await scheduler.retryAccessibility();
  await scheduler.retryAccessibility({ once: true });
  assert.deepEqual(
    state.logs.filter((e) => e.event === "retry-accessibility"),
    [
      { event: "retry-accessibility", moved: 2, once: false },
      { event: "retry-accessibility", moved: 0, once: true },
    ],
  );
  // A scheduler without a log is the one every other test runs, and a log that throws is fine.
  const bare = harness({ drafts: [forAccess("a")] });
  (bare.scheduler as any).deps.restorer.log = () => {
    throw new Error("the log failed");
  };
  assert.equal(await bare.scheduler.retryAccessibility(), 1);
  await bare.scheduler.afterSwitch();
});

test("copy and dismiss log the draft's id and how they ended, never its text", async () => {
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const actions = draftActions({
    drafts: fakeDrafts([]),
    writeClipboard: () => {},
    changed: () => {},
    log: (event, fields) => void logs.push([event, fields]),
  });
  await actions.copy(DRAFT_ID);
  await actions.dismiss(DRAFT_ID);
  assert.deepEqual(logs, [
    ["draft-copy", { id: DRAFT_ID.slice(0, 8), ok: true }],
    ["draft-dismiss", { id: DRAFT_ID.slice(0, 8), ok: true }],
  ]);
  // A refusal by this code says why; any other failure is a fixed word, never its message.
  const refused = draftActions({
    drafts: {
      pendingDrafts: async () => [summary(DRAFT_ID)],
      draftText: async () => TEXT,
      dismissDraft: async () => {
        throw new Error(`EIO ${TEXT}`);
      },
    },
    writeClipboard: () => {},
    changed: () => {},
    log: (event, fields) => void logs.push([event, fields]),
  });
  logs.length = 0;
  await assert.rejects(refused.copy(DRAFT_ID), /still waiting/);
  await assert.rejects(refused.dismiss(DRAFT_ID), /still waiting/);
  const broken = draftActions({
    drafts: {
      pendingDrafts: async () => [summary(DRAFT_ID, { state: "needs-copy" })],
      draftText: async () => TEXT,
      dismissDraft: async () => {
        throw new Error(`EIO ${TEXT}`);
      },
    },
    writeClipboard: () => {},
    changed: () => {},
    log: (event, fields) => {
      logs.push([event, fields]);
      throw new Error("the log failed");
    },
  });
  await assert.rejects(broken.copy(DRAFT_ID), /EIO/);
  const id = DRAFT_ID.slice(0, 8);
  assert.deepEqual(logs, [
    ["draft-copy", { id, ok: false, reason: "This draft is still waiting to be restored." }],
    ["draft-dismiss", { id, ok: false, reason: "This draft is still waiting to be restored." }],
    ["draft-copy", { id, ok: false, reason: "failed" }],
  ]);
  assert.ok(!JSON.stringify(logs).includes(TEXT));
});

test("restores never overlap", async () => {
  let active = 0;
  let most = 0;
  let calls = 0;
  const gates: (() => void)[] = [];
  const { scheduler } = harness({
    restore: async () => {
      calls++;
      active++;
      most = Math.max(most, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      return { status: "waiting", restored: 0, left: 1 };
    },
  });
  const first = scheduler.afterSwitch();
  await flush();
  assert.equal(calls, 1);
  // Ticks and a second switch while the run is in flight start nothing alongside it.
  const ticks = [scheduler.tick(), scheduler.tick()];
  const second = scheduler.afterSwitch();
  await flush();
  assert.equal(calls, 1);
  gates.shift()!();
  await flush();
  // The switch asked for a run of its own: it comes after, never alongside.
  assert.equal(calls, 2);
  gates.shift()!();
  await Promise.all([first, second, ...ticks]);
  assert.equal(calls, 2);
  assert.equal(most, 1);
  // Once idle, a tick runs again.
  const third = scheduler.tick();
  await flush();
  assert.equal(calls, 3);
  gates.shift()!();
  await third;
});

test("a draft stopped three runs in a row is left for Copy with the last reason", async () => {
  const { scheduler, state } = harness();
  state.results.push(stopped("changed"), stopped("moved"), stopped("moved"));
  await scheduler.afterSwitch();
  assert.equal(state.armed, 1);
  state.tick!();
  await flush();
  await scheduler.tick();
  assert.equal(state.runs, 3);
  assert.deepEqual(state.marks, [["one", "needs-copy", "moved"]]);
  assert.deepEqual(state.notices, [{ restored: 0, left: 1 }]);
  assert.equal(state.changed, 1);
  // Nothing pending is left: the 10 s retries stop, and nothing more runs.
  assert.equal(state.cancelled, 1);
  await scheduler.tick();
  assert.equal(state.runs, 3);
});

test("after Desktop's UI never answered, retries wait 2 minutes, but a switch does not", async () => {
  const { scheduler, state } = harness();
  state.results.push(stopped("not-ready"), stopped("not-ready"));
  await scheduler.afterSwitch();
  assert.equal(state.runs, 1);
  state.clock = 60_000;
  await scheduler.tick();
  state.clock = 119_999;
  await scheduler.tick();
  assert.equal(state.runs, 1);
  state.clock = 120_000;
  await scheduler.tick();
  assert.equal(state.runs, 2);
  state.clock = 130_000;
  await scheduler.tick();
  assert.equal(state.runs, 2);
  await scheduler.afterSwitch();
  assert.equal(state.runs, 3);
  // A switch means a new Claude: the retries after it wait no more either.
  await scheduler.tick();
  assert.equal(state.runs, 4);
});

test("after a run the user was active in, retries wait 60 s, but a switch does not", async () => {
  const { scheduler, state } = harness();
  state.results.push(stopped("active"), stopped("active"));
  await scheduler.afterSwitch();
  assert.equal(state.runs, 1);
  state.clock = 10_000;
  await scheduler.tick();
  state.clock = 59_999;
  await scheduler.tick();
  assert.equal(state.runs, 1);
  state.clock = 60_000;
  await scheduler.tick();
  assert.equal(state.runs, 2);
  // Active again: another 60 s from that run.
  state.clock = 119_999;
  await scheduler.tick();
  assert.equal(state.runs, 2);
  await scheduler.afterSwitch();
  assert.equal(state.runs, 3);
  // The backoff never gives a draft up, and the retries stay on.
  assert.deepEqual(state.marks, []);
  assert.equal(state.cancelled, 0);
});

test("the 10 s retries run only while a draft is pending", async () => {
  // Nothing pending at launch: no timer, no restore.
  let h = harness({ drafts: [summary("copied", { state: "needs-copy" })] });
  await h.scheduler.start();
  assert.equal(h.state.armed, 0);
  await h.scheduler.afterSwitch();
  assert.equal(h.state.runs, 0);
  assert.equal(h.state.armed, 0);

  // A draft pending at launch: retries until the restore leaves none pending.
  h = harness();
  await h.scheduler.start();
  assert.equal(h.state.armed, 1);
  assert.equal(h.state.runs, 0);
  await h.scheduler.tick();
  assert.equal(h.state.runs, 1);
  assert.equal(h.state.cancelled, 0);
  h.state.results.push({ status: "done", restored: 1, left: 0 });
  h.state.during = () => {
    h.state.drafts = [];
  };
  await h.scheduler.tick();
  assert.equal(h.state.cancelled, 1);
  assert.equal(h.state.changed, 1);

  // A switch that leaves a draft pending turns them on again; stop turns everything off.
  h.state.during = undefined;
  h.state.drafts = [summary("next")];
  await h.scheduler.afterSwitch();
  assert.equal(h.state.runs, 3);
  assert.equal(h.state.armed, 2);
  h.scheduler.stop();
  assert.equal(h.state.cancelled, 2);
  await h.scheduler.afterSwitch();
  await h.scheduler.tick();
  assert.equal(h.state.runs, 3);
  assert.equal(h.state.armed, 2);
});

test("a restore that throws ends its run, and three in a row leave the draft for Copy", async () => {
  const { scheduler, state } = harness();
  state.results.push(new Error("unexpected"), stopped("moved"));
  await scheduler.afterSwitch();
  await scheduler.tick();
  assert.equal(state.runs, 2);
  assert.deepEqual(state.marks, []);
  // A failure that repeats is given up rather than retried every 10 s for a week.
  state.results.push(new Error("unexpected"));
  await scheduler.tick();
  assert.deepEqual(state.marks, [["one", "needs-copy", "error"]]);
  assert.equal(state.cancelled, 1);
});

test("busy runs never give a draft up, however many there are", async () => {
  for (const reason of ["busy", "active"]) {
    const { scheduler, state } = harness();
    for (let i = 0; i < 5; i++) state.results.push(stopped(reason));
    await scheduler.afterSwitch();
    for (let i = 0; i < 4; i++) {
      // Past any backoff, so every tick runs.
      state.clock += 60_000;
      await scheduler.tick();
    }
    assert.equal(state.runs, 5, reason);
    assert.deepEqual(state.marks, [], reason);
    assert.equal(state.cancelled, 0, reason);
  }
});

test("a run that finds nothing pending turns the retries off before anything else", async () => {
  const { scheduler, state } = harness();
  await scheduler.start();
  assert.equal(state.armed, 1);
  // The last pending draft went another way, between two ticks.
  state.drafts = [summary("one", { state: "needs-copy" })];
  await scheduler.tick();
  assert.equal(state.cancelled, 1);
  assert.equal(state.runs, 0);
  // A vault that cannot be read holds nothing to run for either.
  state.drafts = [summary("two")];
  await scheduler.afterSwitch();
  assert.equal(state.armed, 2);
  state.fail.add("read");
  await scheduler.tick();
  assert.equal(state.runs, 1);
  assert.equal(state.cancelled, 2);
});

test("a mark that fails keeps the draft pending, and a failing notice or refresh changes nothing", async () => {
  const { scheduler, state } = harness();
  state.fail.add("mark");
  state.results.push(stopped("moved"), stopped("moved"), stopped("moved"));
  await scheduler.afterSwitch();
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(state.marks, [["one", "needs-copy", "moved"]]);
  // Nothing was left for copy: no notice, nothing changed, and the retries go on.
  assert.deepEqual(state.notices, []);
  assert.equal(state.changed, 0);
  assert.equal(state.cancelled, 0);

  state.fail.clear();
  state.fail.add("notify");
  state.fail.add("changed");
  state.results.push(stopped("moved"), stopped("moved"), stopped("moved"));
  for (let i = 0; i < 3; i++) await scheduler.tick();
  assert.deepEqual(state.marks.at(-1), ["one", "needs-copy", "moved"]);
  assert.deepEqual(state.notices, [{ restored: 0, left: 1 }]);
  assert.equal(state.changed, 1);
  // The draft is left for copy all the same, and the retries stop.
  assert.equal(state.drafts[0].state, "needs-copy");
  assert.equal(state.cancelled, 1);
});

test("stop during a run drops the run a switch asked for after it", async () => {
  let calls = 0;
  const gates: (() => void)[] = [];
  const { scheduler } = harness({
    restore: async () => {
      // Only the first run waits, so a run that should not happen shows instead of hanging.
      if (++calls === 1)
        await new Promise<void>((resolve) => gates.push(resolve));
      return { status: "waiting", restored: 0, left: 1 };
    },
  });
  const first = scheduler.afterSwitch();
  await flush();
  const second = scheduler.afterSwitch();
  scheduler.stop();
  gates.shift()!();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("a run that fails where nothing should leaves the scheduler able to run again", async () => {
  const { scheduler, state } = harness();
  // Not a list: reading it throws inside the run itself.
  state.drafts = null as unknown as DraftSummary[];
  await scheduler.afterSwitch();
  assert.equal(state.runs, 0);
  state.drafts = [summary("one")];
  await scheduler.afterSwitch();
  assert.equal(state.runs, 1);
});

const forAccess = (id: string) =>
  summary(id, { state: "needs-copy", reason: "accessibility" });

test("a granted accessibility permission sets the drafts it left for Copy back to pending", async () => {
  const { scheduler, state } = harness({
    drafts: [
      forAccess("a"),
      summary("m", { state: "needs-copy", reason: "manual" }),
      forAccess("b"),
    ],
  });
  assert.equal(await scheduler.retryAccessibility(), 2);
  // Only the accessibility ones moved, the reason is gone with the state, and the panel is told.
  assert.deepEqual(state.marks, [
    ["a", "pending", undefined],
    ["b", "pending", undefined],
  ]);
  assert.deepEqual(
    state.drafts.map((d) => [d.id, d.state, d.reason]),
    [
      ["a", "pending", undefined],
      ["m", "needs-copy", "manual"],
      ["b", "pending", undefined],
    ],
  );
  assert.equal(state.changed, 1);
  // The 10 s retries are on, and the next one runs a restore.
  assert.equal(state.armed, 1);
  assert.equal(state.runs, 0);
  state.tick!();
  await flush();
  assert.equal(state.runs, 1);
  // With none left for it, a second call moves nothing and says nothing.
  assert.equal(await scheduler.retryAccessibility(), 0);
  assert.equal(state.changed, 1);
});

test("the drafts moved back start with no stops counted", async () => {
  const { scheduler, state } = harness();
  state.results.push(stopped("moved"), stopped("moved"), stopped("moved"));
  await scheduler.afterSwitch();
  await scheduler.tick();
  // Two stops are counted. The draft is then left for Copy some other way, and moved back.
  state.drafts = [forAccess("one")];
  assert.equal(await scheduler.retryAccessibility(), 1);
  // One more stop is the first again, not the third.
  await scheduler.tick();
  assert.equal(state.runs, 3);
  assert.deepEqual(state.marks, [["one", "pending", undefined]]);
  assert.equal(state.drafts[0].state, "pending");
});

test("retrying after accessibility never throws and moves nothing it cannot", async () => {
  // A vault that cannot be read: no drafts, none moved.
  let h = harness({ drafts: [forAccess("one")] });
  h.state.fail.add("read");
  assert.equal(await h.scheduler.retryAccessibility(), 0);
  assert.deepEqual(h.state.marks, []);
  assert.equal(h.state.changed, 0);
  assert.equal(h.state.armed, 0);

  // A change that fails leaves that draft for Copy, and the others go on.
  h = harness({ drafts: [forAccess("a"), forAccess("b")] });
  h.state.fail.add("mark");
  assert.equal(await h.scheduler.retryAccessibility(), 0);
  assert.equal(h.state.changed, 0);
  assert.equal(h.state.armed, 0);
  assert.deepEqual(
    h.state.drafts.map((d) => d.state),
    ["needs-copy", "needs-copy"],
  );

  // A panel that cannot be told changes nothing about the drafts.
  h = harness({ drafts: [forAccess("one")] });
  h.state.fail.add("changed");
  assert.equal(await h.scheduler.retryAccessibility(), 1);
  assert.equal(h.state.armed, 1);

  // Once stopped, nothing is retried.
  h = harness({ drafts: [forAccess("one")] });
  h.scheduler.stop();
  assert.equal(await h.scheduler.retryAccessibility(), 0);
  assert.deepEqual(h.state.marks, []);
});

test("retrying after accessibility leaves the retries on when a run in flight turns them off", async () => {
  const { scheduler, state } = harness({
    drafts: [summary("p"), forAccess("q")],
  });
  state.results.push(stopped("moved"), stopped("moved"), stopped("moved"));
  await scheduler.afterSwitch();
  await scheduler.tick();
  assert.equal(state.armed, 1);
  // The third stop gives `p` up. While that is written, the permission is granted: `q` is set
  // pending, and the run, which read the drafts before, then finds nothing pending.
  let retry: Promise<number> | undefined;
  state.afterMark = async (id) => {
    if (id !== "p") return;
    retry = scheduler.retryAccessibility();
    await flush();
  };
  await scheduler.tick();
  assert.equal(await retry, 1);
  assert.deepEqual(state.marks.at(-1), ["q", "pending", undefined]);
  assert.equal(state.drafts.find((d) => d.id === "q")?.state, "pending");
  // The run turned the retries off, and the retry turned them on again after it.
  assert.equal(state.cancelled, 1);
  assert.equal(state.armed, 2);
  assert.ok(state.tick);
});

test("granting accessibility, or coming back to Relay with it granted, retries the drafts left for Copy", () => {
  const main = source("../electron/main.ts");
  const request = handler(main, "request-desktop-accessibility");
  const granted = request.indexOf("const granted =");
  const retry = request.search(
    /if \(granted\)\s*void draftRestore\.retryAccessibility\(\s*\);/,
  );
  assert.ok(granted >= 0 && retry > granted);
  assert.ok(retry < request.indexOf("return granted;"));
  // The explicit grant always retries: no `once`.
  assert.doesNotMatch(request, /once/);

  // A window or the panel gaining focus, on macOS only, looks without asking. Only once it is
  // trusted is the 30 s throttle read, and only a retry it makes stamps it.
  const focus = main.slice(
    main.indexOf("function retryDraftsOnFocus"),
    main.indexOf('app.on("browser-window-focus"'),
  );
  assert.ok(focus.length > 0);
  const order = [
    /process\.platform !== "darwin" \|\| !initialized\) return;/,
    /try\s*\{\s*trusted = systemPreferences\.isTrustedAccessibilityClient\(\s*false\s*\);\s*\}\s*catch/,
    /if \(trusted !== true\) return;/,
    /now - accessibilityRetriedAt < ACCESSIBILITY_RETRY_MS\) return;/,
    /accessibilityRetriedAt = now;/,
    /void draftRestore\?\.retryAccessibility\(\{\s*once:\s*true\s*\}\);/,
  ].map((pattern) => focus.search(pattern));
  assert.ok(
    order.every((at) => at >= 0),
    String(order),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.equal(focus.match(/accessibilityRetriedAt = /g)?.length, 1);
  assert.match(main, /const ACCESSIBILITY_RETRY_MS = 30_000;/);
  assert.match(main, /app\.on\("browser-window-focus", retryDraftsOnFocus\);/);
  // The only call that asks is the explicit request in the handler.
  assert.equal(
    main.match(/isTrustedAccessibilityClient\(\s*true\s*\)/g)?.length,
    1,
  );
  assert.match(request, /isTrustedAccessibilityClient\(\s*true\s*\)/);
  assert.equal(
    main.match(/isTrustedAccessibilityClient\(\s*false\s*\)/g)?.length,
    1,
  );
});

test("a retry from focus moves a draft back once a run; the explicit grant always does", async () => {
  const { scheduler, state } = harness({ drafts: [forAccess("a")] });
  assert.equal(await scheduler.retryAccessibility({ once: true }), 1);
  // A run left it for Copy for want of access again, and another draft with it.
  state.drafts = [forAccess("a"), forAccess("b")];
  assert.equal(await scheduler.retryAccessibility({ once: true }), 1);
  assert.deepEqual(
    state.marks.map(([id]) => id),
    ["a", "b"],
  );
  state.drafts = [forAccess("a"), forAccess("b")];
  assert.equal(await scheduler.retryAccessibility({ once: true }), 0);
  assert.equal(state.marks.length, 2);
  // The grant retries both, and what it moved counts as moved this run.
  assert.equal(await scheduler.retryAccessibility(), 2);
  state.drafts = [forAccess("c")];
  assert.equal(await scheduler.retryAccessibility(), 1);
  state.drafts = [forAccess("c")];
  assert.equal(await scheduler.retryAccessibility({ once: true }), 0);
  assert.deepEqual(
    state.marks.map(([id]) => id),
    ["a", "b", "a", "b", "c"],
  );
});

test("two retries at once move each draft once, and the second finds none", async () => {
  for (const options of [undefined, { once: true }]) {
    const { scheduler, state } = harness({
      drafts: [forAccess("a"), forAccess("b")],
    });
    const both = await Promise.all([
      scheduler.retryAccessibility(options),
      scheduler.retryAccessibility(options),
    ]);
    assert.deepEqual(both, [2, 0], String(options?.once));
    assert.deepEqual(
      state.marks,
      [
        ["a", "pending", undefined],
        ["b", "pending", undefined],
      ],
      String(options?.once),
    );
    assert.equal(state.changed, 1);
    assert.equal(state.armed, 1);
  }
});

test("retrying after accessibility never moves a draft that may be typed, waits for its composer, or is pending", async () => {
  const { scheduler, state } = harness({
    drafts: [
      summary("typed", { state: "needs-copy", reason: "maybe-typed" }),
      summary("full", { state: "needs-copy", reason: "composer-not-empty" }),
      // Pending already, with a reason left from before.
      summary("stale", { state: "pending", reason: "accessibility" }),
    ],
  });
  assert.equal(await scheduler.retryAccessibility(), 0);
  assert.deepEqual(state.marks, []);
  assert.equal(state.changed, 0);
  assert.equal(state.armed, 0);
});

test("retrying after accessibility keeps the stop count of a draft it did not move", async () => {
  const { scheduler, state } = harness({ drafts: [summary("p")] });
  state.results.push(stopped("moved"), stopped("moved"), stopped("moved"));
  await scheduler.afterSwitch();
  await scheduler.tick();
  // `p` has two stops counted. `q` is moved back beside it.
  state.drafts = [summary("p"), forAccess("q")];
  assert.equal(await scheduler.retryAccessibility(), 1);
  // The next stop is `p`'s third: it is given up, and `q`, at its first, waits on.
  await scheduler.tick();
  assert.deepEqual(state.marks, [
    ["q", "pending", undefined],
    ["p", "needs-copy", "moved"],
  ]);
  assert.equal(state.drafts.find((d) => d.id === "q")?.state, "pending");
});

test("one draft that cannot be moved back leaves the others moved, and is not counted", async () => {
  const { scheduler, state } = harness({
    drafts: [forAccess("a"), forAccess("b"), forAccess("c")],
  });
  state.failMark.add("b");
  assert.equal(await scheduler.retryAccessibility(), 2);
  assert.deepEqual(
    state.drafts.map((d) => [d.id, d.state]),
    [
      ["a", "pending"],
      ["b", "needs-copy"],
      ["c", "pending"],
    ],
  );
  assert.equal(state.changed, 1);
  assert.equal(state.armed, 1);
  // It was not moved, so a retry from focus still tries it.
  state.failMark.clear();
  assert.equal(await scheduler.retryAccessibility({ once: true }), 1);
  assert.deepEqual(state.marks.at(-1), ["b", "pending", undefined]);
});

test("with re-typing off, every pending draft is left for Copy at once, whatever its account", async () => {
  const { scheduler, state } = harness({
    retype: false,
    drafts: [
      summary("mine"),
      summary("theirs", { to: OTHER }),
      summary("done", { state: "needs-copy", reason: "lost" }),
    ],
  });
  await scheduler.afterSwitch();
  // No restore, and no need to know Desktop's account.
  assert.equal(state.runs, 0);
  assert.equal(state.accountReads, 0);
  assert.deepEqual(state.marks, [
    ["mine", "needs-copy", "manual"],
    ["theirs", "needs-copy", "manual"],
  ]);
  assert.deepEqual(state.notices, [{ restored: 0, left: 2 }]);
  assert.equal(state.changed, 1);
  assert.equal(state.armed, 0);
  assert.ok(state.logs.some((e) => e.event === "retype-off" && e.left === 2));
  // Nothing is pending any more: a tick or another switch finds nothing to do.
  await scheduler.tick();
  await scheduler.afterSwitch();
  assert.equal(state.marks.length, 2);
  assert.equal(state.notices.length, 1);
  assert.equal(state.armed, 0);
});

test("with re-typing off, drafts waiting from before go to Copy at launch", async () => {
  const { scheduler, state } = harness({
    retype: false,
    drafts: [summary("old", { to: OTHER })],
  });
  await scheduler.start();
  assert.deepEqual(state.marks, [["old", "needs-copy", "manual"]]);
  assert.deepEqual(state.notices, [{ restored: 0, left: 1 }]);
  assert.equal(state.runs, 0);
  assert.equal(state.armed, 0);
});

test("with re-typing off, a draft whose mark fails stays pending and the next pass tries again", async () => {
  const { scheduler, state } = harness({
    retype: false,
    drafts: [summary("a"), summary("b", { to: OTHER })],
  });
  state.failMark.add("b");
  await scheduler.afterSwitch();
  assert.deepEqual(
    state.drafts.map((d) => d.state),
    ["needs-copy", "pending"],
  );
  assert.deepEqual(state.notices, [{ restored: 0, left: 1 }]);
  assert.equal(state.every, 10_000);
  state.failMark.clear();
  await scheduler.tick();
  assert.deepEqual(state.marks.at(-1), ["b", "needs-copy", "manual"]);
  assert.deepEqual(state.notices.at(-1), { restored: 0, left: 1 });
  assert.equal(state.every, undefined);
  assert.equal(state.runs, 0);
});

test("with re-typing off, nothing reaches Desktop: no restore, readiness check or automation", async () => {
  const calls: string[] = [];
  const automation = new Proxy({} as RestorerDeps["automation"], {
    get: (_target, name) => async () => {
      calls.push(`automation.${String(name)}`);
      throw new DesktopAutomationError("accessibility-permission-required");
    },
  });
  const make = (retype: boolean) => {
    let drafts: DraftSummary[] = [
      summary("mine"),
      summary("theirs", { to: OTHER }),
      summary("denied", { state: "needs-copy", reason: "accessibility" }),
    ];
    const called =
      <T>(name: string, value: T) =>
      async () => {
        calls.push(name);
        return value;
      };
    const scheduler = new DraftScheduler({
      // The real restorer: only its deps are fakes.
      restorer: {
        automation,
        pending: async () => {
          calls.push("pending");
          return drafts.map((d) => ({
            ...d,
            targetAlias: ALIAS,
            text: TEXT,
          })) as unknown as Awaited<ReturnType<RestorerDeps["pending"]>>;
        },
        mark: async (id, state, reason) => {
          drafts = drafts.map((d) => (d.id === id ? { ...d, state, reason } : d));
        },
        remove: called("remove", undefined),
        currentAccount: called("currentAccount", ACCOUNT),
        running: called("running", true),
        uptimeMs: called("uptimeMs", 60_000),
        withLock: async (fn) => {
          calls.push("withLock");
          return fn();
        },
        yielding: () => {
          calls.push("yielding");
          return false;
        },
        notify: () => {},
        sleep: called("sleep", undefined),
        now: () => 0,
      },
      drafts: async () => drafts,
      changed: () => {},
      retype: () => retype,
      every: () => () => {},
    });
    return { scheduler, drafts: () => drafts };
  };

  const off = make(false);
  await off.scheduler.start();
  await off.scheduler.afterSwitch();
  await off.scheduler.tick();
  await off.scheduler.retypeChanged();
  await off.scheduler.retryAccessibility();
  await off.scheduler.retryAccessibility({ once: true });
  // A copy, so the assertion does not narrow `calls` for the checks below.
  assert.deepEqual([...calls], []);
  assert.deepEqual(
    off.drafts().map((d) => [d.id, d.state, d.reason]),
    [
      ["mine", "needs-copy", "manual"],
      ["theirs", "needs-copy", "manual"],
      ["denied", "needs-copy", "accessibility"],
    ],
  );

  // The same scheduler with re-typing on reaches all of them, so the check above can fail.
  const on = make(true);
  await on.scheduler.afterSwitch();
  for (const name of ["currentAccount", "pending", "running", "uptimeMs", "automation.inspect"])
    assert.ok(calls.includes(name), name);
});

test("turning re-typing off leaves the drafts still pending for Copy on the next pass", async () => {
  // Waiting only for another account: the 60 s check is armed.
  const { scheduler, state } = harness({ drafts: [summary("theirs", { to: OTHER })] });
  await scheduler.afterSwitch();
  assert.equal(state.runs, 1);
  assert.equal(state.every, 60_000);
  state.retype = false;
  await scheduler.retypeChanged();
  assert.deepEqual(state.marks, [["theirs", "needs-copy", "manual"]]);
  assert.deepEqual(state.notices, [{ restored: 0, left: 1 }]);
  assert.equal(state.every, undefined);
  assert.equal(state.runs, 1);
});

test("re-typing turned off during a run leaves what that run left pending for Copy right after it", async () => {
  let calls = 0;
  const gates: (() => void)[] = [];
  const { scheduler, state } = harness({
    restore: async () => {
      calls++;
      await new Promise<void>((resolve) => gates.push(resolve));
      return stopped("moved");
    },
  });
  const run = scheduler.afterSwitch();
  await flush();
  state.retype = false;
  const change = scheduler.retypeChanged();
  gates.shift()!();
  await Promise.all([run, change]);
  assert.equal(calls, 1);
  assert.deepEqual(state.marks, [["one", "needs-copy", "manual"]]);
  assert.equal(state.every, undefined);
});

test("with re-typing off, retrying after accessibility moves nothing back", async () => {
  const { scheduler, state } = harness({
    retype: false,
    drafts: [forAccess("a"), forAccess("b")],
  });
  assert.equal(await scheduler.retryAccessibility(), 0);
  assert.equal(await scheduler.retryAccessibility({ once: true }), 0);
  assert.deepEqual(state.marks, []);
  assert.equal(state.reads, 0);
  assert.equal(state.changed, 0);
  assert.equal(state.armed, 0);
});

test("the 10 s retries arm only for a draft for Desktop's account; others get a 60 s look at the account", async () => {
  const { scheduler, state } = harness({ drafts: [summary("theirs", { to: OTHER })] });
  await scheduler.afterSwitch();
  assert.equal(state.runs, 1);
  assert.equal(state.every, 60_000);
  // The 60 s check reads Desktop's account only: no drafts, no restore.
  const { reads, accountReads } = state;
  state.tick!();
  await flush();
  assert.equal(state.accountReads, accountReads + 1);
  assert.equal(state.reads, reads);
  assert.equal(state.runs, 1);
  assert.equal(state.every, 60_000);
  // Desktop is on the draft's account now, however it got there: a full pass, then 10 s retries.
  state.account = OTHER.toUpperCase();
  state.tick!();
  await flush();
  assert.equal(state.runs, 2);
  assert.equal(state.every, 10_000);
  // With nothing pending, nothing is armed.
  state.drafts = [];
  await scheduler.tick();
  assert.equal(state.every, undefined);
  assert.equal(state.runs, 2);
});

test("once Desktop's account has no draft pending, the 10 s retries give way to the 60 s check", async () => {
  const { scheduler, state } = harness({
    drafts: [summary("mine"), summary("theirs", { to: OTHER })],
  });
  await scheduler.afterSwitch();
  assert.equal(state.every, 10_000);
  state.results.push({ status: "done", restored: 1, left: 0 });
  state.during = () => {
    state.drafts = state.drafts.filter((d) => d.id !== "mine");
  };
  await scheduler.tick();
  assert.equal(state.every, 60_000);
  assert.equal(state.cancelled, 1);
});

test("at launch, drafts waiting only for other accounts arm the 60 s check, not the 10 s retries", async () => {
  let h = harness({ drafts: [summary("theirs", { to: OTHER })] });
  await h.scheduler.start();
  assert.equal(h.state.every, 60_000);
  assert.equal(h.state.runs, 0);
  // Desktop signed out: no draft is for its account either.
  h = harness();
  h.state.account = undefined;
  await h.scheduler.start();
  assert.equal(h.state.every, 60_000);
  assert.equal(h.state.runs, 0);
  // Signed in to the draft's account: a full pass.
  h.state.account = ACCOUNT;
  h.state.tick!();
  await flush();
  assert.equal(h.state.runs, 1);
  assert.equal(h.state.every, 10_000);
});

test("main gives the scheduler the re-typing setting, off unless turned on, and a change of it runs a pass", () => {
  const main = source("../electron/main.ts");
  assert.match(
    main,
    /const draftRetype = \(\) =>\s*service\.store\.state\.settings\.draftRetype === true;/,
  );
  const deps = main.slice(
    main.indexOf("draftRestore = new DraftScheduler("),
    main.indexOf("desktop.onSwitched"),
  );
  assert.match(deps, /retype: draftRetype,/);
  const update = handler(main, "update-settings");
  const order = [
    update.search(/const retype = draftRetype\(\);/),
    update.indexOf("service.store.update("),
    update.search(/if \(draftRetype\(\) !== retype\) void draftRestore\.retypeChanged\(\);/),
    update.indexOf("return service.store.state.settings;"),
  ];
  assert.ok(order.every((at) => at >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("the accessibility request asks only while a feature that needs it is on", () => {
  const main = source("../electron/main.ts");
  const request = handler(main, "request-desktop-accessibility");
  const guard = request.search(/if \(!accessibilityWanted\(\)\) return false;/);
  assert.ok(guard >= 0);
  assert.ok(guard < request.indexOf("isTrustedAccessibilityClient(true)"));
  assert.ok(guard < request.indexOf("requestAccessibility?.()"));
  assert.ok(guard < request.indexOf("shell.openExternal("));
  // Draft re-typing, or continuing conversations at the limit; with them off nothing asks.
  assert.match(
    main,
    /function accessibilityWanted\(\) \{\s*return (?:draftRetype\(\) \|\| fleet\.enabled \|\| continuation\.snapshot\(\)\.enabled|\(\s*draftRetype\(\) \|\|\s*fleet\.enabled \|\|\s*continuation\.snapshot\(\)\.enabled\s*\));\s*\}/,
  );
});

test("the quit notice addresses the user as sen", () => {
  const main = source("../electron/main.ts");
  assert.doesNotMatch(main, /çıkabilirsiniz/);
  assert.match(main, /İşlem tamamlandıktan sonra yeniden çıkabilirsin\./);
});

test("setting a draft back to pending removes its reason in the vault", async (t) => {
  const f = await vaultFixture(t);
  const [conversation, newSession] = f.records;
  await f.manager.markDraft(conversation.id, "needs-copy", "accessibility");
  await f.manager.markDraft(newSession.id, "needs-copy", "manual");
  await f.manager.markDraft(conversation.id, "pending");
  const drafts = await f.manager.pendingDrafts();
  const back = drafts.find((d) => d.id === conversation.id)!;
  assert.equal(back.state, "pending");
  assert.ok(!("reason" in back));
  assert.deepEqual(
    drafts.find((d) => d.id === newSession.id)?.reason,
    "manual",
  );
  // Its text is as it was captured.
  assert.equal(await f.manager.draftText(conversation.id), TEXT);
});

test("the restore notification counts drafts and never names them", () => {
  assert.equal(draftNotice({ restored: 2, left: 0 }, "tr"), "2 taslak geri yazıldı");
  assert.equal(draftNotice({ restored: 1, left: 0 }, "en"), "1 draft restored");
  assert.equal(draftNotice({ restored: 2, left: 0 }, "en"), "2 drafts restored");
  assert.equal(draftNotice({ restored: 0, left: 1 }, "tr"), "1 taslak panelde bekliyor");
  assert.equal(draftNotice({ restored: 0, left: 1 }, "en"), "1 draft waiting in the panel");
  assert.equal(draftNotice({ restored: 0, left: 3 }, "en"), "3 drafts waiting in the panel");
  assert.equal(
    draftNotice({ restored: 2, left: 1 }, "tr"),
    "2 taslak geri yazıldı · 1 taslak panelde bekliyor",
  );
  assert.equal(
    draftNotice({ restored: 1, left: 2 }, "en"),
    "1 draft restored · 2 drafts waiting in the panel",
  );
  assert.equal(draftNotice({ restored: 0, left: 0 }, "tr"), undefined);
  // Main shows only that text, in the tray's language.
  const main = source("../electron/main.ts");
  const notify = main.slice(main.indexOf("function notifyDrafts"));
  assert.match(
    notify.slice(0, notify.indexOf("\n}")),
    /const body = draftNotice\(summary, trayLanguage\);[\s\S]*new Notification\(\{ title: "Relay", body \}\)\.show\(\);/,
  );
});

test("every switch schedules a restore through one hook, on the Desktop lock", () => {
  const main = source("../electron/main.ts");
  assert.match(main, /desktop\.onSwitched = \(\) => void draftRestore\.afterSwitch\(\);/);
  assert.match(main, /void draftRestore\.start\(\);/);
  assert.match(main, /draftRestore\?\.stop\(\);/);
  const deps = main.slice(
    main.indexOf("draftRestore = new DraftScheduler("),
    main.indexOf("desktop.onSwitched"),
  );
  assert.match(deps, /pending: \(\) => desktop\.pendingDraftRecords\(\),/);
  assert.match(deps, /notify: notifyDrafts,/);
  assert.match(
    deps,
    /withLock: \(fn\) => desktopLock\.restore\(fn, \(\) => !desktop\.isBusy\),/,
  );
  // Another caller waiting behind the restore's own hold makes it yield.
  assert.match(deps, /yielding: \(\) => desktopLock\.callers > 1,/);
});

test("main runs every Desktop operation on one lock, and a restore record refuses none of the user's actions", () => {
  const main = source("../electron/main.ts");
  assert.match(
    main,
    /const desktopLock = new DesktopLock\(\(\) => void tray\?\.update\(\), \{\s*acquire: \(kind\) => operationLock\?\.tryAcquire\(kind\),\s*release: \(\) => operationLock\?\.release\(\),\s*\}\);/,
  );
  assert.match(
    main,
    /function withDesktopLock<T>\(action: \(\) => Promise<T>\): Promise<T> \{\s*return desktopLock\.run\(action\);\s*\}/,
  );
  assert.match(
    main,
    /function manualDesktopLock<T>\(action: \(\) => Promise<T>\): Promise<T> \{\s*return desktopLock\.manual\(action, \(\) =>\s*usageCredentialRefresher\?\.anyActive/,
  );
  assert.doesNotMatch(
    main,
    /desktopTransactionActive|desktopTransactions|desktopLockCallers/,
  );
  // While a restore holds the lock, preferences, sign-in and quitting are not refused,
  // and neither the windows nor the menu bar show Desktop as busy.
  for (const name of ["account-planning", "update-settings", "update-planning", "login"])
    assert.match(handler(main, name), /if \((?:desktop\.isBusy \|\| )?desktopLock\.busy\)/, name);
  assert.match(handler(main, "desktop-snapshot"), /desktop\.isBusy \|\|\s*desktopLock\.busy \|\|/);
  assert.match(
    main.slice(main.indexOf('app.on("before-quit"')),
    /if \(desktop\?\.isBusy \|\| desktopLock\.busy\) \{/,
  );
  assert.match(
    main,
    /busy: \(\) => desktop\.isBusy \|\| desktopLock\.busy,\s*operations: \(\) => desktopLock\.operations \+ desktop\.operations,/,
  );
});

test("no IPC handler returns draft text", () => {
  const main = source("../electron/main.ts");
  // Text is read in one place in main: the restorer's deps, outside every handler.
  assert.equal(main.match(/pendingDraftRecords\(/g)?.length, 1);
  assert.equal(main.match(/draftText\(/g), null);
  const ipc = main.slice(
    main.indexOf("function bindIPC"),
    main.indexOf('app.on("activate"'),
  );
  assert.doesNotMatch(ipc, /pendingDraftRecords|draftText|\.text\b/);
  // Copy and Dismiss go through the trusted wrapper and resolve with nothing.
  assert.match(
    ipc,
    /const draft = draftActions\(\{\s*drafts: desktop,\s*writeClipboard: \(text\) => clipboard\.writeText\(text\),\s*changed: broadcastChanged,\s*log: logDraftEvent,\s*\}\);/,
  );
  assert.match(handler(main, "copy-draft"), /^handle\("copy-draft", \(draftId\) => draft\.copy\(draftId\)\);/);
  assert.match(handler(main, "dismiss-draft"), /^handle\("dismiss-draft", \(draftId\) =>\s*draft\.dismiss\(draftId\),?\s*\);/);
  const preload = source("../electron/preload.ts");
  assert.match(preload, /copyDraft: \(id\) => ipcRenderer\.invoke\("relay:copy-draft", id\),/);
  assert.match(preload, /dismissDraft: \(id\) => ipcRenderer\.invoke\("relay:dismiss-draft", id\),/);
  const types = source("../shared/types.ts");
  assert.match(types, /copyDraft\(id: string\): Promise<void>;/);
  assert.match(types, /dismissDraft\(id: string\): Promise<void>;/);
  assert.match(types, /drafts\?: DraftSummary\[\];/);
});
