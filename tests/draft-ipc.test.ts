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

/** A scheduler over fake drafts, a fake 10 s timer and a scripted restore. */
function harness(
  over: {
    drafts?: DraftSummary[];
    restore?: (deps: RestorerDeps) => Promise<RestoreResult>;
  } = {},
) {
  const state = {
    clock: 0,
    drafts: over.drafts ?? [summary("one")],
    results: [] as (RestoreResult | Error)[],
    runs: 0,
    marks: [] as [string, string, string | undefined][],
    notices: [] as { restored: number; left: number }[],
    changed: 0,
    armed: 0,
    cancelled: 0,
    tick: undefined as (() => void) | undefined,
    /** Runs inside the scripted restore, as the restorer changing the vault. */
    during: undefined as (() => void) | undefined,
    /** What fails: reading the drafts, marking one, the notification, telling the panel. */
    fail: new Set<"read" | "mark" | "notify" | "changed">(),
  };
  const restorer = {
    currentAccount: async () => ACCOUNT,
    mark: async (id: string, next: DraftSummary["state"], reason?: string) => {
      state.marks.push([id, next, reason]);
      if (state.fail.has("mark")) throw new Error("EIO");
      state.drafts = state.drafts.map((draft) =>
        draft.id === id ? { ...draft, state: next, reason } : draft,
      );
    },
    notify: (notice: { restored: number; left: number }) => {
      state.notices.push(notice);
      if (state.fail.has("notify")) throw new Error("notification");
    },
    now: () => state.clock,
  } as unknown as RestorerDeps;
  const scheduler = new DraftScheduler({
    restorer,
    drafts: async () => {
      if (state.fail.has("read")) throw new Error("EIO");
      return state.drafts;
    },
    changed: () => {
      state.changed++;
      if (state.fail.has("changed")) throw new Error("renderer");
    },
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
      assert.equal(ms, 10_000);
      state.armed++;
      state.tick = fn;
      return () => {
        state.cancelled++;
        state.tick = undefined;
      };
    },
  });
  return { scheduler, state };
}

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
    for (let i = 0; i < 4; i++) await scheduler.tick();
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
    /const desktopLock = new DesktopLock\(\(\) => void tray\?\.update\(\)\);/,
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
    /const draft = draftActions\(\{\s*drafts: desktop,\s*writeClipboard: \(text\) => clipboard\.writeText\(text\),\s*changed: broadcastChanged,\s*\}\);/,
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
