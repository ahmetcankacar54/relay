import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DraftRecord, DraftSummary } from "../electron/core/draft-vault";
import type {
  RestoreOptions,
  RestorerDeps,
  RestoreResult,
} from "../electron/core/draft-restorer";
import {
  BACKSTOP_MS,
  DraftScheduler,
  NOT_OPENED,
  NUDGE_MS,
  VISIT_MS,
  WATCH_MS,
} from "../electron/core/draft-main";
import {
  nativeDesktopWatch,
  parseWatchLine,
  type DesktopWatchEnd,
  type DesktopWatchHandlers,
  type DesktopWatchState,
} from "../electron/core/desktop-watch";

const ACCOUNT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const alias = (n: number) =>
  `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const place = (n: number) => `local_${alias(n)}`;
const ELSEWHERE = "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Draft n, as the panel knows it: no text, no alias. */
function draft(n: number, over: Partial<DraftSummary> = {}): DraftSummary {
  return {
    id: `draft-${n}`,
    to: ACCOUNT,
    title: `Conversation ${n}`,
    newSession: false,
    attachments: false,
    state: "pending",
    capturedAt: new Date(0).toISOString(),
    ...over,
  };
}
/** A run that got past Claude's readiness and left the draft pending. */
const waiting = (reason: string): RestoreResult => ({
  status: "waiting",
  restored: 0,
  left: 1,
  reason,
});
/** A run that found Claude not ready. */
const notReady: RestoreResult = { status: "waiting", restored: 0, left: 1 };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush();
};

interface FakeWatch {
  handlers: DesktopWatchHandlers;
  /** Stopped by the scheduler. */
  stopped: boolean;
  /** Ended on its own, as the helper exiting. */
  ended: boolean;
}

/**
 * A scheduler over fake drafts, a scripted restore that records the options of each run, a
 * fake 10 s timer, fake one-shot timers and fake watches.
 */
function harness(drafts: DraftSummary[] = [draft(1)]) {
  const state = {
    clock: 0,
    drafts,
    account: ACCOUNT as string | undefined,
    accountReads: 0,
    results: [] as RestoreResult[],
    /** The options of each run, in order. */
    runs: [] as (RestoreOptions | undefined)[],
    marks: [] as [string, string, string | undefined][],
    notices: [] as { restored: number; left: number }[],
    changed: 0,
    retype: true,
    tick: undefined as (() => void) | undefined,
    timers: [] as { fn: () => void; ms: number; cancelled: boolean }[],
    watches: [] as FakeWatch[],
    logs: [] as Array<Record<string, unknown>>,
    /** Runs inside the scripted restore. */
    during: undefined as (() => void | Promise<void>) | undefined,
  };
  const records = (): DraftRecord[] =>
    state.drafts.map(({ newSession, ...d }) => ({
      ...d,
      text: "x",
      ...(newSession
        ? { newSession: true as const }
        : { targetAlias: alias(Number(d.id.slice("draft-".length))) }),
    }));
  const restorer = {
    currentAccount: async () => {
      state.accountReads++;
      return state.account;
    },
    pending: async () => records(),
    mark: async (id: string, next: DraftSummary["state"], reason?: string) => {
      state.marks.push([id, next, reason]);
      state.drafts = state.drafts.map((d) =>
        d.id === id ? { ...d, state: next, reason } : d,
      );
    },
    notify: (notice: { restored: number; left: number }) => {
      state.notices.push(notice);
    },
    now: () => state.clock,
    log: (event: string, fields?: Record<string, unknown>) => {
      state.logs.push({ event, ...fields });
    },
  } as unknown as RestorerDeps;
  const scheduler = new DraftScheduler({
    restorer,
    drafts: async () => state.drafts,
    changed: () => {
      state.changed++;
    },
    retype: () => state.retype,
    restore: async (deps, options) => {
      state.runs.push(options);
      await deps.currentAccount();
      await state.during?.();
      return state.results.shift() ?? waiting("elsewhere");
    },
    every: (fn) => {
      state.tick = fn;
      return () => {
        state.tick = undefined;
      };
    },
    later: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      state.timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    watch: (handlers) => {
      const watch: FakeWatch = { handlers, stopped: false, ended: false };
      state.watches.push(watch);
      return {
        stop() {
          watch.stopped = true;
        },
      };
    },
  });
  const live = () => state.watches.filter((w) => !w.stopped && !w.ended);
  /** The live watch ends on its own, for `reason`. */
  const end = (reason: DesktopWatchEnd) => {
    const watches = live();
    assert.equal(watches.length, 1, "one watch is on");
    watches[0].ended = true;
    watches[0].handlers.end(reason);
  };
  /** The live watch reports `over`: by default Claude in front, keys quiet, not idle. */
  const report = async (over: Partial<DesktopWatchState> = {}) => {
    const watches = live();
    assert.equal(watches.length, 1, "one watch is on");
    watches[0].handlers.state({
      pid: 456,
      frontmost: true,
      quiet: true,
      idle: false,
      ...over,
    });
    await settle();
  };
  /** Fires the one-shot timers not cancelled. */
  const fire = async () => {
    const due = state.timers.filter((t) => !t.cancelled);
    state.timers = [];
    for (const timer of due) timer.fn();
    await settle();
  };
  return { scheduler, state, live, report, fire, end };
}

test("a run that finds Claude ready starts one watch, for the places of the account's pending drafts", async () => {
  const h = harness([
    draft(1),
    draft(2, { newSession: true }),
    draft(3, { to: OTHER }),
    draft(4, { state: "needs-copy", reason: "manual" }),
  ]);
  // Not ready yet: no watch.
  h.state.results.push(notReady);
  await h.scheduler.afterSwitch();
  assert.equal(h.state.watches.length, 0);
  // Ready: one watch, looking for draft 1's conversation and the new-session screen.
  await h.scheduler.tick();
  assert.equal(h.live().length, 1);
  assert.deepEqual(
    h.state.logs.find((e) => e.event === "watch-start"),
    { event: "watch-start", places: 2 },
  );
  // More runs keep the one watch.
  h.state.clock = 10_000;
  await h.scheduler.tick();
  await h.scheduler.tick();
  assert.equal(h.state.watches.length, 1);
  // Drafts for another account only: none.
  const other = harness([draft(1, { to: OTHER })]);
  await other.scheduler.afterSwitch();
  await other.scheduler.tick();
  assert.equal(other.state.watches.length, 0);
});

test("the watch starts a run when a draft's place is on screen with Claude in front and no key for 1 s", async () => {
  const h = harness();
  await h.scheduler.afterSwitch();
  assert.equal(h.state.runs.length, 1);
  h.state.clock = 5_000;
  // Not its place, a key just pressed, or Claude behind: nothing.
  await h.report({ place: ELSEWHERE });
  await h.report({ place: place(1), quiet: false });
  await h.report({ place: place(1), frontmost: false });
  await h.report({});
  assert.equal(h.state.runs.length, 1);
  // Its place, quiet keys, Claude in front: a run, which may still take the user elsewhere.
  await h.report({ place: place(1) });
  assert.equal(h.state.runs.length, 2);
  assert.deepEqual(h.state.runs[1], { visits: true, launching: false });
  // The new-session screen is a place too.
  const fresh = harness([draft(7, { newSession: true })]);
  await fresh.scheduler.afterSwitch();
  fresh.state.clock = 5_000;
  await fresh.report({ place: "new-session" });
  assert.equal(fresh.state.runs.length, 2);
});

test("an idle user in front starts a run while visits are allowed; after 2 minutes only the draft's place does", async () => {
  const h = harness();
  await h.scheduler.afterSwitch();
  h.state.clock = 30_000;
  await h.report({ place: ELSEWHERE, idle: true });
  assert.equal(h.state.runs.length, 2);
  assert.equal(h.state.runs[1]?.visits, true);
  // An idle user behind Claude is no reason.
  h.state.clock = 40_000;
  await h.report({ place: ELSEWHERE, idle: true, frontmost: false });
  assert.equal(h.state.runs.length, 2);
  // The visit window closes 2 minutes after the first ready run.
  h.state.clock = VISIT_MS;
  await h.report({ place: ELSEWHERE, idle: false });
  await h.report({ place: ELSEWHERE, idle: true });
  assert.equal(h.state.runs.length, 2);
  await h.report({ place: place(1), idle: true });
  assert.equal(h.state.runs.length, 3);
  assert.equal(h.state.runs[2]?.visits, false);
  // A 10 s retry after it allows no visit either.
  h.state.clock = VISIT_MS + 10_000;
  h.state.tick!();
  await settle();
  assert.equal(h.state.runs.length, 4);
  assert.equal(h.state.runs[3]?.visits, false);
});

test("a report just after a run waits until 1 s after it; one during a run is weighed once it ends", async () => {
  const h = harness();
  await h.scheduler.afterSwitch();
  // 200 ms after the run: a timer for the 800 ms left, then the run.
  h.state.clock = 200;
  await h.report({ place: place(1) });
  assert.equal(h.state.runs.length, 1);
  assert.deepEqual(
    h.state.timers.map((t) => t.ms),
    [NUDGE_MS - 200],
  );
  // Two reports meanwhile set one timer.
  await h.report({ place: place(1), idle: true });
  assert.equal(h.state.timers.length, 1);
  h.state.clock = NUDGE_MS;
  await h.fire();
  assert.equal(h.state.runs.length, 2);
  // The timer finds the report no longer says go: nothing.
  h.state.clock = 1_100;
  await h.report({ place: place(1) });
  await h.report({ place: place(1), quiet: false });
  h.state.clock = 3_000;
  await h.fire();
  assert.equal(h.state.runs.length, 2);
  // A report while a run is in flight starts nothing alongside it, and is weighed after it.
  let open!: () => void;
  h.state.during = () => new Promise<void>((resolve) => (open = resolve));
  h.state.clock = 10_000;
  await h.report({ place: ELSEWHERE, idle: true });
  assert.equal(h.state.runs.length, 3);
  await h.report({ place: place(1) });
  assert.equal(h.state.runs.length, 3);
  h.state.during = undefined;
  h.state.clock = 12_000;
  open();
  await settle();
  assert.equal(h.state.runs.length, 3);
  assert.deepEqual(
    h.state.timers.filter((t) => !t.cancelled).map((t) => t.ms),
    [NUDGE_MS],
  );
  h.state.clock = 13_000;
  await h.fire();
  assert.equal(h.state.runs.length, 4);
});

test("with a watch on, a 10 s retry runs only while the watch says go, and otherwise reads the account alone", async () => {
  const h = harness();
  await h.scheduler.afterSwitch();
  h.state.clock = 10_000;
  await h.report({ place: ELSEWHERE, frontmost: false });
  const reads = h.state.accountReads;
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 1);
  assert.equal(h.state.accountReads, reads + 1);
  // The watch says go and its run stopped busy: the retry tries again.
  h.state.results.push(waiting("busy"));
  await h.report({ place: place(1) });
  assert.equal(h.state.runs.length, 2);
  h.state.clock = 20_000;
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 3);
  // Desktop on another account: the retry runs.
  await h.report({ place: ELSEWHERE, frontmost: false });
  h.state.clock = 30_000;
  h.state.account = OTHER;
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 4);
  // That run found no draft for Desktop's account: the watch ends.
  assert.equal(h.live().length, 0);
});

test("with a watch on, a 10 s retry still runs a minute after the last run, in case the watch missed the place", async () => {
  const h = harness();
  await h.scheduler.afterSwitch();
  await h.report({ place: ELSEWHERE, frontmost: false });
  h.state.clock = BACKSTOP_MS - 1;
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 1);
  h.state.clock = BACKSTOP_MS;
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 2);
  // Counted from that run.
  h.state.clock = 2 * BACKSTOP_MS - 1;
  await h.scheduler.tick();
  assert.equal(h.state.runs.length, 2);
});

test("a run begun before a switch opens no window for the Claude the switch started", async () => {
  const h = harness();
  let open!: () => void;
  h.state.during = () => new Promise<void>((resolve) => (open = resolve));
  // A retry is in flight when the switch comes.
  const first = h.scheduler.tick();
  await settle();
  h.state.clock = 50_000;
  const switched = h.scheduler.afterSwitch();
  h.state.during = undefined;
  open();
  await Promise.all([first, switched]);
  assert.equal(h.state.runs.length, 2);
  assert.deepEqual(h.state.runs[1], { visits: true, launching: true });
  // The windows date from the run after the switch: visits until 2 minutes after it.
  h.state.clock = 50_000 + VISIT_MS - 1;
  h.end("gone");
  await h.scheduler.tick();
  assert.equal(h.state.runs[2]?.visits, true);
});

test("the watch ends with the drafts, re-typing, a switch and stop; its own end lets the retries look again", async () => {
  // The draft is restored.
  const done = harness();
  await done.scheduler.afterSwitch();
  assert.equal(done.live().length, 1);
  done.state.during = () => {
    done.state.drafts = [];
  };
  done.state.results.push({ status: "done", restored: 1, left: 0 });
  done.state.clock = 10_000;
  await done.report({ place: place(1) });
  assert.equal(done.state.runs.length, 2);
  assert.equal(done.live().length, 0);
  assert.equal(done.state.watches[0].stopped, true);
  // Re-typing turned off.
  const off = harness();
  await off.scheduler.afterSwitch();
  off.state.retype = false;
  await off.scheduler.retypeChanged();
  assert.equal(off.live().length, 0);
  assert.deepEqual(off.state.marks, [["draft-1", "needs-copy", "manual"]]);
  // A switch: a new Claude, and the run after it starts a new watch.
  const switched = harness();
  await switched.scheduler.afterSwitch();
  await switched.scheduler.afterSwitch();
  assert.equal(switched.state.watches.length, 2);
  assert.equal(switched.state.watches[0].stopped, true);
  assert.equal(switched.live().length, 1);
  // stop.
  switched.scheduler.stop();
  assert.equal(switched.live().length, 0);
  // Claude quit: the watch ends, and the retries run as without one.
  const gone = harness();
  await gone.scheduler.afterSwitch();
  gone.end("gone");
  assert.deepEqual(gone.state.logs.at(-1), {
    event: "watch-end",
    reason: "gone",
  });
  gone.state.results.push(notReady);
  gone.state.clock = 10_000;
  await gone.scheduler.tick();
  assert.equal(gone.state.runs.length, 2);
  assert.equal(gone.state.watches.length, 1);
  // The helper's own 10 minutes: a new watch at once.
  const expired = harness();
  await expired.scheduler.afterSwitch();
  expired.end("expired");
  assert.equal(expired.live().length, 1);
  assert.equal(expired.state.watches.length, 2);
  // A report from a watch that ended is ignored.
  expired.state.watches[0].handlers.state({
    pid: 456,
    place: place(1),
    frontmost: true,
    quiet: true,
    idle: true,
  });
  await settle();
  assert.equal(expired.state.runs.length, 1);
});

test("30 minutes after Claude was ready, the account's drafts still pending are left for Copy as not-opened", async () => {
  const h = harness([draft(1), draft(2), draft(3, { to: OTHER })]);
  await h.scheduler.afterSwitch();
  assert.equal(h.live().length, 1);
  h.state.clock = WATCH_MS - 1;
  await h.scheduler.tick();
  assert.deepEqual(h.state.marks, []);
  h.state.clock = WATCH_MS;
  h.state.results.push({ status: "idle", restored: 0, left: 0 });
  await h.scheduler.tick();
  assert.deepEqual(h.state.marks, [
    ["draft-1", "needs-copy", NOT_OPENED],
    ["draft-2", "needs-copy", NOT_OPENED],
  ]);
  assert.deepEqual(h.state.notices, [{ restored: 0, left: 2 }]);
  assert.ok(h.state.changed >= 1);
  assert.equal(h.live().length, 0);
  assert.ok(h.state.logs.some((e) => e.event === "watch-over" && e.left === 2));
  // Desktop on another account when the window ends: its drafts wait for it.
  const away = harness();
  await away.scheduler.afterSwitch();
  away.state.account = OTHER;
  away.state.clock = WATCH_MS;
  await away.scheduler.tick();
  assert.deepEqual(away.state.marks, []);
  // A switch opens the windows again.
  const again = harness();
  await again.scheduler.afterSwitch();
  again.state.clock = WATCH_MS - 1_000;
  await again.scheduler.afterSwitch();
  again.state.clock = WATCH_MS;
  await again.scheduler.tick();
  assert.deepEqual(again.state.marks, []);
  assert.equal(again.state.runs.at(-1)?.visits, true);
});

test("the run after a switch waits for Claude to start; the windows open at the first ready run", async () => {
  const h = harness();
  h.state.results.push(notReady);
  await h.scheduler.afterSwitch();
  assert.deepEqual(h.state.runs[0], { visits: true, launching: true });
  // Not ready yet: the windows have not opened.
  h.state.clock = VISIT_MS + 5_000;
  await h.scheduler.tick();
  assert.deepEqual(h.state.runs[1], { visits: true, launching: false });
  // Ready from that run on: visits until 2 minutes after it.
  h.state.clock = 2 * VISIT_MS + 4_999;
  h.end("gone");
  await h.scheduler.tick();
  assert.equal(h.state.runs[2]?.visits, true);
  h.state.clock = 2 * VISIT_MS + 5_000;
  h.end("gone");
  await h.scheduler.tick();
  assert.equal(h.state.runs[3]?.visits, false);
});

test("the helper's watch lines are read strictly", () => {
  const id = place(1);
  assert.deepEqual(
    parseWatchLine(
      JSON.stringify({
        pid: 4,
        place: id,
        frontmost: true,
        quiet: false,
        idle: true,
      }),
    ),
    { state: { pid: 4, place: id, frontmost: true, quiet: false, idle: true } },
  );
  assert.deepEqual(
    parseWatchLine(
      JSON.stringify({
        pid: 4,
        place: null,
        frontmost: false,
        quiet: true,
        idle: true,
      }),
    ),
    { state: { pid: 4, frontmost: false, quiet: true, idle: true } },
  );
  assert.deepEqual(
    parseWatchLine(
      JSON.stringify({
        pid: 4,
        place: "new-session",
        frontmost: true,
        quiet: true,
        idle: false,
      }),
    ),
    {
      state: {
        pid: 4,
        place: "new-session",
        frontmost: true,
        quiet: true,
        idle: false,
      },
    },
  );
  assert.deepEqual(parseWatchLine('{"gone":true}'), { end: "gone" });
  assert.deepEqual(parseWatchLine('{"expired":true}'), { end: "expired" });
  assert.deepEqual(
    parseWatchLine('{"issue":"accessibility-permission-required"}'),
    { end: "accessibility-permission-required" },
  );
  assert.deepEqual(parseWatchLine('{"issue":"made-up"}'), {
    end: "desktop-ui-unsupported",
  });
  for (const line of [
    "",
    "not json",
    "[]",
    "null",
    JSON.stringify({
      pid: 0,
      place: null,
      frontmost: true,
      quiet: true,
      idle: true,
    }),
    JSON.stringify({
      pid: 4,
      place: "local_nope",
      frontmost: true,
      quiet: true,
      idle: true,
    }),
    JSON.stringify({
      pid: 4,
      place: "https://claude.ai",
      frontmost: true,
      quiet: true,
      idle: true,
    }),
    JSON.stringify({
      pid: 4,
      place: null,
      frontmost: "yes",
      quiet: true,
      idle: true,
    }),
    JSON.stringify({ pid: 4, place: null, frontmost: true, idle: true }),
    `{"pid":4,"place":null,"frontmost":true,"quiet":true,"idle":true,"pad":"${"x".repeat(5000)}"}`,
  ])
    assert.equal(parseWatchLine(line), undefined, line.slice(0, 60));
});

let scratch: string | undefined;
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test("the native watch runs the helper with its times, passes its states on, and ends once", async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "relay-watch-"));
  const helper = path.join(scratch, "helper");
  const argsFile = path.join(scratch, "args");
  // A stand-in helper: it notes its arguments, reports two states and a bad line, then
  // Claude quitting.
  await writeFile(
    helper,
    [
      "#!/bin/sh",
      `echo "$@" > '${argsFile}'`,
      `echo '{"pid":9,"place":null,"frontmost":false,"quiet":true,"idle":false}'`,
      "echo 'garbage'",
      `echo '{"pid":9,"place":"${place(1)}","frontmost":true,"quiet":true,"idle":true}'`,
      `echo '{"gone":true}'`,
    ].join("\n"),
  );
  await chmod(helper, 0o755);
  const states: DesktopWatchState[] = [];
  const ends: DesktopWatchEnd[] = [];
  await new Promise<void>((resolve) => {
    nativeDesktopWatch(
      helper,
      1_000,
      3_000,
    )({
      state: (s) => void states.push(s),
      end: (reason) => {
        ends.push(reason);
        resolve();
      },
    });
  });
  // `close` comes after the last line: still one end.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const { readFile } = await import("node:fs/promises");
  assert.equal((await readFile(argsFile, "utf8")).trim(), "watch 1000 3000");
  assert.deepEqual(states, [
    { pid: 9, frontmost: false, quiet: true, idle: false },
    { pid: 9, place: place(1), frontmost: true, quiet: true, idle: true },
  ]);
  assert.deepEqual(ends, ["gone"]);
  // A helper that keeps running until stopped: stop ends it, and says nothing.
  const waiter = path.join(scratch, "waiter");
  await writeFile(waiter, "#!/bin/sh\ncat > /dev/null\n");
  await chmod(waiter, 0o755);
  const stopEnds: DesktopWatchEnd[] = [];
  const watch = nativeDesktopWatch(
    waiter,
    1_000,
    3_000,
  )({
    state: () => {},
    end: (reason) => void stopEnds.push(reason),
  });
  watch.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(stopEnds, []);
  // A helper that is not there ends the watch as unsupported.
  const missing = await new Promise<DesktopWatchEnd>((resolve) => {
    nativeDesktopWatch(
      path.join(scratch!, "absent"),
      1_000,
      3_000,
    )({
      state: () => {},
      end: resolve,
    });
  });
  assert.equal(missing, "desktop-ui-unsupported");
});
