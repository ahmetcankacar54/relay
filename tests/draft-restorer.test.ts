import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DesktopAutomationError,
  type DesktopAutomationIssue,
  type DesktopAutomationSnapshot,
  type DesktopDraftGuard,
} from "../electron/core/desktop-continuation-host";
import type { DraftRecord, DraftState } from "../electron/core/draft-vault";
import {
  restoreDrafts,
  type RestorerDeps,
} from "../electron/core/draft-restorer";
import { DraftScheduler } from "../electron/core/draft-main";

const ACCOUNT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const alias = (n: number) =>
  `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const target = (n: number) => `local_${alias(n)}`;
/** The conversation the user is on when the restore starts. */
const HOME = "local_ffffffff-ffff-4fff-8fff-ffffffffffff";
/** A conversation the user moves to by hand. */
const ELSEWHERE = "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** Code's new-session screen, as the fake shows it and its calls name it. */
const NEW = "new-session";

function record(n: number, over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: `draft-${n}`,
    to: ACCOUNT,
    targetAlias: alias(n),
    title: `Conversation ${n}`,
    text: `draft ${n}`,
    attachments: false,
    capturedAt: new Date(0).toISOString(),
    state: "pending",
    ...over,
  };
}
/** The draft of a session that does not exist yet, for the new-session screen. */
const fresh = (n: number, over: Partial<DraftRecord> = {}): DraftRecord =>
  record(n, { targetAlias: undefined, newSession: true, title: "", ...over });
const issue = (name: DesktopAutomationIssue) =>
  new DesktopAutomationError(name);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

type Snapshot = DesktopAutomationSnapshot;
type Status = Snapshot["status"];
interface Hooks {
  /** Runs before the nth inspect; an error is thrown from it. */
  inspect?: (n: number) => Error | void;
  /** Runs before an open; an error is thrown, "ignored" leaves the view where it is. */
  open?: (id: string) => Error | "ignored" | void;
  /** Runs before the nth write; an error is thrown from it before anything is typed. */
  write?: (n: number) => Error | void;
  sleep?: (ms: number) => void;
  vault?: (op: "mark" | "remove", id: string) => Error | void;
  /** Replaces the uptime, for the nth read of it. */
  uptime?: (n: number) => number | undefined;
  /** Desktop's wipe marker, at the nth read of it; none without. */
  wipedAt?: (n: number) => number | undefined;
  /** Runs before the nth read of the records; an error is thrown from it. */
  pending?: (n: number) => Error | void;
  /** True when the nth lock is held by another Desktop operation. */
  busy?: (n: number) => boolean;
  /** True when another Desktop operation waits for the lock the restore holds. */
  yielding?: () => boolean;
}

/** The helper's fingerprint: a hash of the snapshot's stable fields. */
const fingerprint = (stable: Record<string, unknown>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(stable)
          .sort()
          .map((k) => [k, stable[k]]),
      ),
    )
    .digest("hex");

/**
 * A fake Desktop: one composer per conversation and one for the new-session screen (NEW),
 * the view on one of them, a clock that only `sleep` moves. It reports what the helper
 * reports: a missing composer is not empty, the new-session screen has no conversation id,
 * and a write must match the screen's pid, conversation or new-session screen, account,
 * mode and fingerprint, with the screen stopped and its composer there and empty.
 */
function harness(
  options: {
    records?: DraftRecord[];
    running?: boolean;
    /** Claude's uptime when the restore starts; it grows with the clock. */
    uptime?: number;
    noUptime?: boolean;
    lockBusy?: boolean;
    shown?: string;
    composers?: Record<string, string>;
    statuses?: Record<string, Status>;
    noComposer?: string[];
  } = {},
) {
  const begin = 1_000_000;
  let clock = begin;
  let account: string | undefined = ACCOUNT;
  let records = (options.records ?? [record(1)]).map((r) => ({ ...r }));
  let shown: string | undefined = "shown" in options ? options.shown : HOME;
  let pid = 456;
  let held = false;
  let inspects = 0;
  let writes = 0;
  let locks = 0;
  let pendingReads = 0;
  let uptimeReads = 0;
  let wipeReads = 0;
  const composers = new Map(Object.entries(options.composers ?? {}));
  const statuses = new Map(Object.entries(options.statuses ?? {}));
  const noComposer = new Set(options.noComposer ?? []);
  /** Fields forced onto every snapshot. */
  const patch: Partial<Snapshot> = {};
  /** Fields forced onto the snapshots of one screen, after `patch`. */
  const screenPatch = new Map<string, Partial<Snapshot>>();
  /**
   * Whether Claude is in front, how long the user has been idle and how long no key has been
   * pressed. Outside the fingerprint, as in the helper. By default the user lets Relay act.
   */
  const activity: Partial<
    Pick<Snapshot, "frontmost" | "idleMs" | "keyIdleMs">
  > = {
    frontmost: true,
    idleMs: 60_000,
    keyIdleMs: 60_000,
  };
  const calls: string[] = [];
  /** The options of each openSession and openNewSession call, in order. */
  const openOptions: unknown[] = [];
  /** Every guard a write was given, in order. */
  const guards: DesktopDraftGuard[] = [];
  /** The options of each write, in order. */
  const writeOptions: unknown[] = [];
  const sleeps: number[] = [];
  const marks: Array<[string, DraftState, string | undefined]> = [];
  const removed: string[] = [];
  const notes: Array<{ restored: number; left: number }> = [];
  const outsideLock: string[] = [];
  /** Every event the restorer logged, in order, as the log would hold it. */
  const logs: Array<Record<string, unknown>> = [];
  const hooks: Hooks = {};
  const view = (): Snapshot => {
    const present = !!shown && !noComposer.has(shown);
    const text = shown ? composers.get(shown) : undefined;
    const stable = {
      pid,
      ...(shown === NEW
        ? { newSession: true }
        : shown
          ? { localSessionId: shown }
          : {}),
      accountLabel: "Test User",
      permissionMode: "Auto",
      status:
        (shown && statuses.get(shown)) || (present ? "stopped" : "unknown"),
      composerPresent: present,
      // As the helper: no composer reads as not empty.
      composerEmpty: present && !text,
      sendEnabled: present && !!text,
      ...patch,
      ...(shown ? screenPatch.get(shown) : {}),
    } as Omit<
      Snapshot,
      "observedAt" | "quotaStopped" | "coverage" | "contextFingerprint"
    >;
    return {
      ...stable,
      observedAt: clock,
      quotaStopped: false,
      coverage: "active-conversation-only",
      contextFingerprint: fingerprint(stable),
      ...activity,
    };
  };
  const touch = (call: string) => {
    calls.push(call);
    if (!held) outsideLock.push(call);
  };
  /** Desktop following a link to `id`, a conversation or NEW. */
  const follow = async (
    id: string,
    options: { requireIdle?: boolean } | undefined,
  ) => {
    touch(`open:${id}`);
    openOptions.push(options);
    const outcome = hooks.open?.(id);
    if (outcome instanceof Error) throw outcome;
    // As the helper, asked to, refuses before it opens anything while the user is active.
    if (
      options?.requireIdle &&
      !(activity.frontmost === true && (activity.idleMs ?? 0) >= 3_000)
    )
      throw issue("user-active");
    if (outcome !== "ignored") shown = id;
  };
  const deps: RestorerDeps = {
    automation: {
      inspect: async () => {
        inspects++;
        touch("inspect");
        const error = hooks.inspect?.(inspects);
        if (error) throw error;
        return view();
      },
      openSession: (id, options) => follow(id, options),
      openNewSession: (options) => follow(NEW, options),
      writeDraft: async (guard, text, options) => {
        writes++;
        guards.push(guard);
        writeOptions.push(options);
        const newSession = "newSession" in guard;
        touch(`write:${newSession ? NEW : guard.localSessionId}`);
        const error = hooks.write?.(writes);
        if (error) throw error;
        // As the helper validates a guard before it types anything. The new-session screen
        // is named without an id, and its mode matches when absent on both sides.
        const now = view();
        if (
          guard.pid !== now.pid ||
          (newSession
            ? now.newSession !== true || now.localSessionId !== undefined
            : guard.localSessionId !== now.localSessionId) ||
          guard.accountLabel !== now.accountLabel ||
          guard.permissionMode !== now.permissionMode ||
          guard.contextFingerprint !== now.contextFingerprint
        )
          throw issue("context-changed");
        if (now.status !== "stopped") throw issue("desktop-work-active");
        if (!now.composerPresent) throw issue("desktop-ui-unsupported");
        if (!now.composerEmpty) throw issue("composer-not-empty");
        // As the helper refuses, before it types, while the user is active: a key pressed
        // within `keysIdleMs` when given, any input within 3 s otherwise.
        const keys = options?.keysIdleMs;
        if (
          !(
            now.frontmost === true &&
            (keys !== undefined
              ? (now.keyIdleMs ?? 0) >= keys
              : (now.idleMs ?? 0) >= 3_000)
          )
        )
          throw issue("user-active");
        composers.set(shown!, text);
        return view();
      },
    },
    pending: async () => {
      const error = hooks.pending?.(++pendingReads);
      if (error) throw error;
      return records.map((r) => ({ ...r }));
    },
    mark: async (id, state, reason) => {
      const error = hooks.vault?.("mark", id);
      if (error) throw error;
      marks.push([id, state, reason]);
      records = records.map((r) =>
        r.id === id ? { ...r, state, ...(reason ? { reason } : {}) } : r,
      );
    },
    remove: async (id) => {
      const error = hooks.vault?.("remove", id);
      if (error) throw error;
      removed.push(id);
      records = records.filter((r) => r.id !== id);
    },
    currentAccount: async () => account,
    running: async () => options.running ?? true,
    uptimeMs: async () => {
      uptimeReads++;
      if (hooks.uptime) return hooks.uptime(uptimeReads);
      return options.noUptime
        ? undefined
        : (options.uptime ?? 20_000) + (clock - begin);
    },
    wipedAt: async () => hooks.wipedAt?.(++wipeReads),
    withLock: async (fn) => {
      locks++;
      if (options.lockBusy || hooks.busy?.(locks)) return undefined;
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    },
    yielding: () => hooks.yielding?.() ?? false,
    notify: (summary) => {
      notes.push(summary);
    },
    log: (event, fields) => {
      logs.push({ event, ...fields });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      hooks.sleep?.(ms);
    },
    now: () => clock,
  };
  return {
    deps,
    hooks,
    patch,
    screenPatch,
    activity,
    calls,
    openOptions,
    guards,
    writeOptions,
    sleeps,
    marks,
    removed,
    notes,
    outsideLock,
    logs,
    composers,
    statuses,
    noComposer,
    opens: () => calls.filter((c) => c.startsWith("open:")),
    writes: () => calls.filter((c) => c.startsWith("write:")),
    /** Desktop actions taken without the lock. Only inspecting may happen outside it. */
    actionsOutsideLock: () => outsideLock.filter((c) => c !== "inspect"),
    get inspects() {
      return inspects;
    },
    get wipeReads() {
      return wipeReads;
    },
    get uptimeReads() {
      return uptimeReads;
    },
    get shown() {
      return shown;
    },
    now: () => clock,
    setShown(id: string | undefined) {
      shown = id;
    },
    setAccount(id: string | undefined) {
      account = id;
    },
    setPid(value: number) {
      pid = value;
    },
  };
}

test("idle when nothing is pending for this account", async () => {
  const h = harness({
    records: [
      record(1, { to: OTHER }),
      record(2, { state: "needs-copy", reason: "manual" }),
    ],
  });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "idle",
    restored: 0,
    left: 0,
  });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.notes, []);
  // Without a Desktop account nothing is anyone's.
  const signedOut = harness();
  signedOut.setAccount(undefined);
  assert.equal((await restoreDrafts(signedOut.deps)).status, "idle");
  assert.deepEqual(signedOut.calls, []);
});

test("an account matches whatever its case", async () => {
  const h = harness({ records: [record(1, { to: ACCOUNT.toUpperCase() })] });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(h.removed, ["draft-1"]);
});

test("a run waits until Claude has been up 15 s; without Claude or its uptime it does not", async () => {
  for (const options of [{ noUptime: true }, { running: false }]) {
    const h = harness(options);
    assert.deepEqual(await restoreDrafts(h.deps), {
      status: "waiting",
      restored: 0,
      left: 1,
    });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(h.marks, []);
    assert.deepEqual(h.removed, []);
  }
  const ready = harness({ uptime: 15_000 });
  assert.equal((await restoreDrafts(ready.deps)).status, "done");
  assert.deepEqual(ready.removed, ["draft-1"]);
  // Up 10 s: the run waits the 5 s left, touching nothing of Desktop's meanwhile, and reads
  // the uptime once for it rather than running ps every 500 ms.
  const early = harness({ uptime: 10_000 });
  const start = early.now();
  let firstLook: { at: number; uptimeReads: number } | undefined;
  early.hooks.inspect = (n) => {
    if (n === 1) firstLook = { at: early.now(), uptimeReads: early.uptimeReads };
  };
  assert.equal((await restoreDrafts(early.deps)).restored, 1);
  assert.deepEqual(firstLook, { at: start + 5_000, uptimeReads: 1 });
  assert.ok(early.sleeps.slice(0, 10).every((ms) => ms === 500));
});

test("Desktop's wipe marker from after Claude started makes it ready before 15 s", async () => {
  /** When a run first looks at Desktop's UI, from its start; undefined when it never does. */
  const firstLook = async (
    h: ReturnType<typeof harness>,
  ): Promise<number | undefined> => {
    const start = h.now();
    let at: number | undefined;
    h.hooks.inspect = (n) => {
      if (n === 1) at = h.now() - start;
    };
    await restoreDrafts(h.deps);
    return at;
  };
  // Up 2 s, the wipe finished 1 s ago: at once, and the lock's own check needs no 15 s.
  const now = harness({ uptime: 2_000 });
  const wiped = now.now() - 1_000;
  now.hooks.wipedAt = () => wiped;
  assert.equal(await firstLook(now), 0);
  assert.deepEqual(now.removed, ["draft-1"]);
  assert.deepEqual(now.logs[0], {
    event: "restore-start",
    account: ACCOUNT.slice(0, 8),
    records: 1,
    all: 1,
    ready: true,
    wiped: true,
    waitedMs: 0,
  });
  // The marker comes 3 s in: the run goes on then.
  const later = harness({ uptime: 1_000 });
  const begun = later.now();
  later.hooks.wipedAt = () =>
    later.now() - begun >= 3_000 ? begun + 2_900 : undefined;
  assert.equal(await firstLook(later), 3_000);
  assert.deepEqual(later.removed, ["draft-1"]);
  // A marker up to 1 s before the start Relay works out still counts: ps counts whole seconds.
  const rounded = harness({ uptime: 2_000 });
  const early = rounded.now() - 2_000 - 1_000;
  rounded.hooks.wipedAt = () => early;
  assert.equal(await firstLook(rounded), 0);
  // The last Claude's wipe, from before this one started, and a marker that cannot be read,
  // are no marker: 15 s of uptime it is.
  const old = harness({ uptime: 2_000 });
  const before = old.now() - 2_000 - 1_001;
  old.hooks.wipedAt = () => before;
  assert.equal(await firstLook(old), 13_000);
  const unreadable = harness({ uptime: 2_000 });
  unreadable.hooks.wipedAt = () => {
    throw new Error("EACCES");
  };
  assert.equal(await firstLook(unreadable), 13_000);
  assert.deepEqual(unreadable.removed, ["draft-1"]);
  // Up 15 s already: the marker is not read at all.
  const up = harness();
  up.hooks.wipedAt = () => assert.fail("not read");
  assert.equal(await firstLook(up), 0);
  assert.equal(up.wipeReads, 0);
});

test("right after a switch, a run waits up to 10 s for Claude to start", async () => {
  // Claude starts 3 s after the switch; Desktop's wipe is done 2 s after that.
  const h = harness();
  const switched = h.now();
  const startsAt = switched + 3_000;
  h.deps.running = async () => h.now() >= startsAt;
  h.hooks.uptime = () => h.now() - startsAt;
  h.hooks.wipedAt = () => (h.now() >= startsAt + 2_000 ? startsAt + 2_000 : undefined);
  let at: number | undefined;
  h.hooks.inspect = (n) => {
    if (n === 1) at = h.now() - switched;
  };
  assert.equal(
    (await restoreDrafts(h.deps, { launching: true })).restored,
    1,
  );
  assert.equal(at, 5_000);
  // Without `launching`, a Claude not running yet is not waited for.
  const later = harness({ running: false });
  assert.equal((await restoreDrafts(later.deps)).status, "waiting");
  assert.deepEqual(later.sleeps, []);
  // A Claude that never starts: 10 s, then the drafts wait for the next run.
  const never = harness({ running: false });
  assert.deepEqual(await restoreDrafts(never.deps, { launching: true }), {
    status: "waiting",
    restored: 0,
    left: 1,
  });
  assert.equal(sum(never.sleeps), 10_000);
  assert.deepEqual(never.calls, []);
});

test("restores one draft and returns to the user's conversation", async () => {
  const h = harness();
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(h.opens(), [`open:${target(1)}`, `open:${HOME}`]);
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
  assert.equal(h.composers.get(target(1)), "draft 1");
  assert.deepEqual(h.removed, ["draft-1"]);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.notes, [{ restored: 1, left: 0 }]);
  // The text is checked again 5 s after it was written.
  assert.ok(h.sleeps.includes(5_000));
  // Only the wait for Desktop's UI inspects outside the lock; every action is under it.
  assert.deepEqual(h.outsideLock, ["inspect"]);
});

test("a non-empty composer is never written", async () => {
  const h = harness({ composers: { [target(1)]: "the user is typing" } });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 0,
    left: 1,
  });
  assert.deepEqual(h.writes(), []);
  assert.equal(h.composers.get(target(1)), "the user is typing");
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "composer-not-empty"]]);
  assert.deepEqual(h.notes, [{ restored: 0, left: 1 }]);
  // The user typing between the look and the write: the helper refuses, and once is enough.
  const raced = harness();
  raced.hooks.write = () => issue("composer-not-empty");
  await restoreDrafts(raced.deps);
  assert.deepEqual(raced.writes(), [`write:${target(1)}`]);
  assert.deepEqual(raced.marks, [
    ["draft-1", "needs-copy", "composer-not-empty"],
  ]);
  // A composer with text is not waited on for a guard: nothing will be typed there anyway.
  // (2026-10-19 09:26: 30 s of looks every 500 ms at a composer the user had typed into.)
  const unguarded = harness({
    shown: target(1),
    composers: { [target(1)]: "the user's own words" },
  });
  unguarded.screenPatch.set(target(1), { permissionMode: undefined });
  await restoreDrafts(unguarded.deps);
  assert.deepEqual(unguarded.marks, [
    ["draft-1", "needs-copy", "composer-not-empty"],
  ]);
  assert.deepEqual(unguarded.sleeps, []);
});

test("a busy conversation is never written", async () => {
  for (const status of ["running", "waiting"] as const) {
    const h = harness({ statuses: { [target(1)]: status } });
    assert.equal((await restoreDrafts(h.deps)).left, 1);
    assert.deepEqual(h.writes(), []);
    assert.deepEqual(h.marks, [["draft-1", "needs-copy", "busy"]]);
  }
});

test("a conversation shown without a composer is never written", async () => {
  // "Claude finished the response" is on screen, so the helper says stopped.
  const h = harness({
    noComposer: [target(1)],
    statuses: { [target(1)]: "stopped" },
  });
  assert.equal((await restoreDrafts(h.deps)).left, 1);
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "no-composer"]]);
  // It is given the full 30 s to show its composer.
  assert.equal(sum(h.sleeps), 30_000);
  // An older helper that does not report composerPresent proves no composer either.
  const older = harness();
  older.patch.composerPresent = undefined;
  await restoreDrafts(older.deps);
  assert.deepEqual(older.writes(), []);
  assert.deepEqual(older.marks, [["draft-1", "needs-copy", "no-composer"]]);
});

test("missing accessibility stops at once", async () => {
  const h = harness({
    records: [
      record(1),
      record(2),
      record(3, { targetAlias: undefined, newSession: true }),
    ],
  });
  h.hooks.inspect = () => issue("accessibility-permission-required");
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 0,
    left: 3,
  });
  assert.equal(h.inspects, 1);
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual(h.opens(), []);
  assert.deepEqual(h.marks, [
    ["draft-1", "needs-copy", "accessibility"],
    ["draft-2", "needs-copy", "accessibility"],
    ["draft-3", "needs-copy", "accessibility"],
  ]);
  assert.deepEqual(h.notes, [{ restored: 0, left: 3 }]);
});

test("accessibility lost mid-restore stops at once and leaves the rest for copy", async () => {
  const h = harness({ records: [record(1), record(2), record(3)] });
  h.hooks.write = (n) =>
    n === 2 ? issue("accessibility-permission-required") : undefined;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 2,
  });
  assert.deepEqual(h.removed, ["draft-1"]);
  // Without accessibility the helper could not touch the UI, so nothing was typed: both stay
  // retryable once access is granted.
  assert.deepEqual(h.marks, [
    ["draft-2", "needs-copy", "accessibility"],
    ["draft-3", "needs-copy", "accessibility"],
  ]);
  // Nothing more is tried in Desktop: no third conversation, no return.
  assert.equal(h.calls.at(-1), `write:${target(2)}`);
});

test("accessibility revoked at the re-check after a write leaves that draft maybe-typed, so a grant moves back only the rest", async () => {
  const h = harness({ records: [record(1), record(2), record(3)] });
  let revoked = false;
  h.hooks.sleep = (ms) => {
    if (ms === 5_000) revoked = true;
  };
  h.hooks.inspect = () =>
    revoked ? issue("accessibility-permission-required") : undefined;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 0,
    left: 3,
  });
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
  assert.deepEqual(h.marks, [
    ["draft-1", "needs-copy", "maybe-typed"],
    ["draft-2", "needs-copy", "accessibility"],
    ["draft-3", "needs-copy", "accessibility"],
  ]);
  // Granted again: the draft that may be in its composer is never typed a second time.
  const scheduler = new DraftScheduler({
    restorer: h.deps,
    drafts: async () =>
      (await h.deps.pending()).map((r) => ({
        id: r.id,
        to: r.to,
        title: r.title,
        newSession: !!r.newSession,
        attachments: r.attachments,
        state: r.state,
        reason: r.reason,
        capturedAt: r.capturedAt,
      })),
    changed: () => {},
    // Re-typing on: only then does a grant move drafts back.
    retype: () => true,
    every: () => () => {},
  });
  assert.equal(await scheduler.retryAccessibility(), 2);
  assert.deepEqual(h.marks.slice(3), [
    ["draft-2", "pending", undefined],
    ["draft-3", "pending", undefined],
  ]);
  assert.deepEqual(
    (await h.deps.pending()).map((r) => [r.id, r.state]),
    [
      ["draft-1", "needs-copy"],
      ["draft-2", "pending"],
      ["draft-3", "pending"],
    ],
  );
});

test("text wiped after writing is written once more, then left for copy", async () => {
  const h = harness();
  // Desktop's wipe empties the composer during every re-check.
  h.hooks.sleep = (ms) => {
    if (ms === 5_000) h.composers.delete(target(1));
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 0,
    left: 1,
  });
  assert.deepEqual(h.writes(), [`write:${target(1)}`, `write:${target(1)}`]);
  assert.equal(h.sleeps.filter((ms) => ms === 5_000).length, 2);
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "lost"]]);
  assert.deepEqual(h.removed, []);
});

test("text wiped once is written once more and kept", async () => {
  const h = harness();
  let wiped = false;
  h.hooks.sleep = (ms) => {
    if (ms === 5_000 && !wiped) {
      wiped = true;
      h.composers.delete(target(1));
    }
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.equal(h.writes().length, 2);
  assert.equal(h.composers.get(target(1)), "draft 1");
  assert.deepEqual(h.removed, ["draft-1"]);
});

test("a re-check that cannot confirm the text leaves it for copy and never writes again", async () => {
  const cases: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    // The reviewer's probe: no composer, "finished" on screen, so stopped and not empty.
    [
      "no composer, stopped",
      (h) => {
        h.composers.delete(target(1));
        h.noComposer.add(target(1));
        h.statuses.set(target(1), "stopped");
      },
    ],
    [
      "no composer, unknown",
      (h) => {
        h.noComposer.add(target(1));
      },
    ],
    ["running with text", (h) => void h.statuses.set(target(1), "running")],
    ["waiting with text", (h) => void h.statuses.set(target(1), "waiting")],
    [
      "emptied while running: perhaps sent",
      (h) => {
        h.composers.delete(target(1));
        h.statuses.set(target(1), "running");
      },
    ],
    ["another conversation", (h) => h.setShown(ELSEWHERE)],
    ["another Claude process", (h) => h.setPid(789)],
  ];
  for (const [name, change] of cases) {
    const h = harness();
    h.hooks.sleep = (ms) => {
      if (ms === 5_000) change(h);
    };
    assert.deepEqual(
      await restoreDrafts(h.deps),
      { status: "done", restored: 0, left: 1 },
      name,
    );
    assert.equal(h.writes().length, 1, name);
    assert.deepEqual(h.removed, [], name);
    // It was typed, perhaps it is still there: the panel says to look before pasting.
    assert.deepEqual(h.marks, [["draft-1", "needs-copy", "maybe-typed"]], name);
  }
});

test("a re-check inspect that fails leaves the draft as maybe typed and goes on", async () => {
  const h = harness({ records: [record(1), record(2)] });
  let failNext = false;
  h.hooks.sleep = (ms) => {
    if (ms === 5_000 && h.writes().length === 1) failNext = true;
  };
  h.hooks.inspect = () => {
    if (!failNext) return;
    failNext = false;
    return issue("desktop-ui-unsupported");
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 1,
  });
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "maybe-typed"]]);
  assert.deepEqual(h.removed, ["draft-2"]);
});

test("context-changed leaves the record for copy and continues with the next", async () => {
  // The screen still shows the conversation Relay opened: it goes on.
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.write = (n) => (n === 1 ? issue("context-changed") : undefined);
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 1,
  });
  assert.deepEqual(h.writes(), [`write:${target(1)}`, `write:${target(2)}`]);
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "maybe-typed"]]);
  assert.deepEqual(h.removed, ["draft-2"]);
  assert.deepEqual(h.opens(), [
    `open:${target(1)}`,
    `open:${target(2)}`,
    `open:${HOME}`,
  ]);
  assert.deepEqual(h.notes, [{ restored: 1, left: 1 }]);
  // The context changed because the user moved: it stops there and leaves them be.
  const moved = harness({ records: [record(1), record(2)] });
  moved.hooks.write = (n) => {
    if (n !== 1) return;
    moved.setShown(ELSEWHERE);
    return issue("context-changed");
  };
  assert.deepEqual(await restoreDrafts(moved.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "moved",
  });
  assert.deepEqual(moved.marks, [["draft-1", "needs-copy", "maybe-typed"]]);
  assert.deepEqual(moved.opens(), [`open:${target(1)}`]);
});

test("a write that may have typed something is never retried", async () => {
  for (const name of [
    "delivery-ambiguous",
    "desktop-ui-unsupported",
    "desktop-work-active",
  ] as const) {
    const h = harness();
    h.hooks.write = () => issue(name);
    await restoreDrafts(h.deps);
    assert.equal(h.writes().length, 1);
    assert.deepEqual(h.marks, [["draft-1", "needs-copy", "maybe-typed"]]);
  }
});

test("once a write was tried, a draft left for copy is maybe typed, unless lost or the composer was not empty", async () => {
  for (const name of [
    "context-changed",
    "delivery-ambiguous",
    "desktop-ui-unsupported",
    "desktop-work-active",
    "exact-session-not-observed",
    "permission-mode-mismatch",
    "desktop-observation-incomplete",
  ] as const) {
    const h = harness();
    h.hooks.write = () => issue(name);
    assert.equal((await restoreDrafts(h.deps)).left, 1, name);
    assert.deepEqual(h.marks, [["draft-1", "needs-copy", "maybe-typed"]], name);
  }
  // The helper saw text in the composer and typed nothing: it says so.
  const full = harness();
  full.hooks.write = () => issue("composer-not-empty");
  await restoreDrafts(full.deps);
  assert.deepEqual(full.marks, [["draft-1", "needs-copy", "composer-not-empty"]]);
  // Typed twice and wiped twice: it is not there, and the panel says so.
  const wiped = harness();
  wiped.hooks.sleep = (ms) => {
    if (ms === 5_000) wiped.composers.delete(target(1));
  };
  await restoreDrafts(wiped.deps);
  assert.deepEqual(wiped.marks, [["draft-1", "needs-copy", "lost"]]);
  // Before any write the reason is kept as it is.
  const busy = harness({ statuses: { [target(1)]: "running" } });
  await restoreDrafts(busy.deps);
  assert.deepEqual(busy.marks, [["draft-1", "needs-copy", "busy"]]);
  // Claude quitting during the re-check of a typed draft: the run stops, and that draft is maybe typed.
  const quit = harness({ records: [record(1), record(2)] });
  quit.hooks.sleep = (ms) => {
    if (ms === 5_000)
      quit.hooks.inspect = () => issue("claude-not-running");
  };
  assert.deepEqual(await restoreDrafts(quit.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "claude-not-running",
  });
  assert.deepEqual(quit.marks, [["draft-1", "needs-copy", "maybe-typed"]]);
});

test("the user moving between drafts stops the restore and is never sent back", async () => {
  // After the first draft the user opens another conversation.
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.vault = (op) => {
    if (op === "remove") h.setShown(ELSEWHERE);
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 1,
    left: 1,
    reason: "moved",
  });
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.notes, [{ restored: 1, left: 0 }]);
  // After the last draft: it is done, and does not take the user back.
  const last = harness();
  last.hooks.vault = (op) => {
    if (op === "remove") last.setShown(ELSEWHERE);
  };
  assert.deepEqual(await restoreDrafts(last.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(last.opens(), [`open:${target(1)}`]);
  // A look at the screen that fails counts as the user moving.
  const unseen = harness({ records: [record(1), record(2)] });
  let failNext = false;
  unseen.hooks.vault = (op) => {
    if (op === "remove") failNext = true;
  };
  unseen.hooks.inspect = () => {
    if (!failNext) return;
    failNext = false;
    return issue("desktop-ui-unsupported");
  };
  assert.deepEqual(await restoreDrafts(unseen.deps), {
    status: "waiting",
    restored: 1,
    left: 1,
    reason: "moved",
  });
  assert.deepEqual(unseen.opens(), [`open:${target(1)}`]);
  // The screen changing between the wait for the UI and the first lock, as while Desktop
  // loads, is no move: Relay has done nothing yet, and brings the user back to where the
  // first lock found them.
  const early = harness();
  let looks = 0;
  // The ready look sees HOME; by the first lock's look the user is elsewhere.
  early.hooks.inspect = () => {
    if (++looks === 2) early.setShown(ELSEWHERE);
  };
  assert.deepEqual(await restoreDrafts(early.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(early.opens(), [`open:${target(1)}`, `open:${ELSEWHERE}`]);
});

test("the conditions are read again under each lock", async () => {
  const changes: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ["the account", (h) => h.setAccount(OTHER)],
    ["Claude's pid", (h) => h.setPid(789)],
    [
      "Claude's uptime",
      (h) => {
        h.hooks.uptime = () => 3_000;
      },
    ],
  ];
  for (const [name, change] of changes) {
    const h = harness({ records: [record(1), record(2)] });
    h.hooks.vault = (op) => {
      if (op === "remove") change(h);
    };
    assert.deepEqual(
      await restoreDrafts(h.deps),
      { status: "waiting", restored: 1, left: 1, reason: "changed" },
      name,
    );
    assert.deepEqual(h.opens(), [`open:${target(1)}`], name);
  }
  // A switch relaunched Claude between the first look and the first lock.
  const relaunched = harness();
  relaunched.hooks.uptime = (n) => (n === 1 ? 20_000 : 3_000);
  assert.deepEqual(await restoreDrafts(relaunched.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "changed",
  });
  assert.deepEqual(relaunched.opens(), []);
});

test("a failed read before or under the lock leaves the drafts pending", async () => {
  const h = harness();
  h.hooks.pending = () => new Error("vault unreadable");
  assert.equal((await restoreDrafts(h.deps)).status, "waiting");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.marks, []);
  // The account read under the second lock fails.
  const later = harness({ records: [record(1), record(2)] });
  let reads = 0;
  later.deps.currentAccount = async () => {
    if (++reads > 2) throw new Error("config unreadable");
    return ACCOUNT;
  };
  assert.deepEqual(await restoreDrafts(later.deps), {
    status: "waiting",
    restored: 1,
    left: 1,
    reason: "changed",
  });
  assert.deepEqual(later.opens(), [`open:${target(1)}`]);
});

test("a busy Desktop (withLock gives undefined) does nothing", async () => {
  const h = harness({ lockBusy: true });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "busy",
  });
  // It may have looked at the screen; it took no action in Desktop or the vault.
  assert.deepEqual(h.opens(), []);
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.notes, []);
  // A switch takes the lock after the first draft: the rest stay pending.
  const switching = harness({ records: [record(1), record(2), record(3)] });
  switching.hooks.busy = (n) => n === 2;
  assert.deepEqual(await restoreDrafts(switching.deps), {
    status: "waiting",
    restored: 1,
    left: 2,
    reason: "busy",
  });
  assert.deepEqual(switching.opens(), [`open:${target(1)}`]);
  assert.deepEqual(switching.marks, []);
  assert.deepEqual(switching.notes, [{ restored: 1, left: 0 }]);
});

test("the whole restore stops after 5 minutes", async () => {
  // No conversation ever shows, so each draft takes its full 30 s.
  const h = harness({
    records: Array.from({ length: 12 }, (_, i) => record(i + 1)),
  });
  h.hooks.open = () => "ignored";
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 12,
    reason: "budget",
  });
  assert.equal(h.marks.length, 10);
  assert.ok(
    h.marks.every(([, , reason]) => reason === "exact-session-not-observed"),
  );
  assert.equal(sum(h.sleeps), 300_000);
});

test("a target shown without a guard stops the restore and leaves the rest as unsupported", async () => {
  const h = harness({ records: [record(1), record(2), record(3)] });
  h.patch.accountLabel = undefined;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 0,
    left: 3,
  });
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.marks, [
    ["draft-1", "needs-copy", "unsupported"],
    ["draft-2", "needs-copy", "unsupported"],
    ["draft-3", "needs-copy", "unsupported"],
  ]);
});

test("drafts too long, with a NUL or without a valid alias go straight to copy", async () => {
  const h = harness({
    records: [
      fresh(3, { text: "x".repeat(16_385) }),
      record(4, { text: "x".repeat(16_385) }),
      record(6, { targetAlias: "../not-a-uuid" }),
      record(5, { text: "y".repeat(16_384) }),
      fresh(7, { text: "a\0b" }),
    ],
  });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 4,
  });
  assert.deepEqual(h.marks, [
    ["draft-3", "needs-copy", "manual"],
    ["draft-4", "needs-copy", "manual"],
    ["draft-6", "needs-copy", "manual"],
    ["draft-7", "needs-copy", "manual"],
  ]);
  // Only the draft that fits is typed; the limit is inclusive.
  assert.deepEqual(h.writes(), [`write:${target(5)}`]);
  assert.deepEqual(h.opens(), [`open:${target(5)}`, `open:${HOME}`]);
  // Nothing to open, nothing to return from.
  const alone = harness({ records: [fresh(3, { text: "x".repeat(16_385) })] });
  await restoreDrafts(alone.deps);
  assert.deepEqual(alone.opens(), []);
  assert.deepEqual(alone.marks, [["draft-3", "needs-copy", "manual"]]);
});

test("the new-session draft is typed into the new-session screen, and the user is taken back", async () => {
  const h = harness({ records: [fresh(3)] });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(h.opens(), [`open:${NEW}`, `open:${HOME}`]);
  assert.deepEqual(h.writes(), [`write:${NEW}`]);
  assert.equal(h.composers.get(NEW), "draft 3");
  assert.deepEqual(h.removed, ["draft-3"]);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.notes, [{ restored: 1, left: 0 }]);
  // It is read again 5 s later, as a conversation's is.
  assert.ok(h.sleeps.includes(5_000));
  // Every link asks the helper to check the user right before it opens.
  assert.deepEqual(h.openOptions, [
    { requireIdle: true },
    { requireIdle: true },
  ]);
  // Only the wait for Desktop's UI inspects outside the lock.
  assert.deepEqual(h.outsideLock, ["inspect"]);
  // Its guard names the screen, never a conversation.
  assert.equal("localSessionId" in h.guards[0], false);
  assert.equal((h.guards[0] as { newSession?: true }).newSession, true);
});

test("a new-session draft goes in with the conversations' drafts, one screen after another", async () => {
  const h = harness({ records: [record(1), fresh(3), record(2)] });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 3,
    left: 0,
  });
  assert.deepEqual(h.opens(), [
    `open:${target(1)}`,
    `open:${NEW}`,
    `open:${target(2)}`,
    `open:${HOME}`,
  ]);
  assert.deepEqual(h.writes(), [
    `write:${target(1)}`,
    `write:${NEW}`,
    `write:${target(2)}`,
  ]);
  assert.deepEqual(h.removed, ["draft-1", "draft-3", "draft-2"]);
});

test("on the new-session screen already, the draft is typed where the user is", async () => {
  const h = harness({ records: [fresh(3)], shown: NEW });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(h.opens(), []);
  assert.deepEqual(h.writes(), [`write:${NEW}`]);
  // A user who started there is taken back there after a conversation's draft.
  const back = harness({ records: [record(1)], shown: NEW });
  assert.equal((await restoreDrafts(back.deps)).restored, 1);
  assert.deepEqual(back.opens(), [`open:${target(1)}`, `open:${NEW}`]);
  assert.equal(back.shown, NEW);
});

test("a new-session composer with the user's own text is never written", async () => {
  for (const shown of [HOME, NEW]) {
    const h = harness({
      records: [fresh(3)],
      shown,
      composers: { [NEW]: "a session the user is starting" },
    });
    assert.deepEqual(await restoreDrafts(h.deps), {
      status: "done",
      restored: 0,
      left: 1,
    });
    assert.deepEqual(h.writes(), []);
    assert.equal(h.composers.get(NEW), "a session the user is starting");
    assert.deepEqual(h.marks, [
      ["draft-3", "needs-copy", "composer-not-empty"],
    ]);
  }
});

test("the new-session screen needs no permission mode, but its account", async () => {
  // The mode may not be read there: the guard is built without it.
  const modeless = harness({ records: [fresh(3)] });
  modeless.screenPatch.set(NEW, { permissionMode: undefined });
  assert.equal((await restoreDrafts(modeless.deps)).restored, 1);
  assert.deepEqual(Object.keys(modeless.guards[0]).sort(), [
    "accountLabel",
    "contextFingerprint",
    "newSession",
    "pid",
  ]);
  // Without its account no guard can be built: only that draft is left for copy, after the
  // 30 s it is given to show one, and the conversations' drafts go on.
  const h = harness({ records: [fresh(3), record(1)] });
  h.screenPatch.set(NEW, { accountLabel: undefined });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 1,
  });
  assert.deepEqual(h.marks, [["draft-3", "needs-copy", "unsupported"]]);
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
  assert.deepEqual(h.opens(), [
    `open:${NEW}`,
    `open:${target(1)}`,
    `open:${HOME}`,
  ]);
  assert.equal(sum(h.sleeps.slice(0, h.sleeps.indexOf(5_000))), 30_000);
});

test("a new-session screen that never shows is left for copy after 30 s, with the link sent every 5 s", async () => {
  const h = harness({ records: [fresh(3), record(1)] });
  h.hooks.open = (id) => (id === NEW ? "ignored" : undefined);
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 1,
  });
  assert.deepEqual(h.marks, [
    ["draft-3", "needs-copy", "exact-session-not-observed"],
  ]);
  assert.equal(h.opens().filter((c) => c === `open:${NEW}`).length, 6);
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
});

test("text wiped from the new-session composer is written once more; a screen that changed is maybe typed", async () => {
  const h = harness({ records: [fresh(3)] });
  let wiped = false;
  h.hooks.sleep = (ms) => {
    if (ms === 5_000 && !wiped) {
      wiped = true;
      h.composers.delete(NEW);
    }
  };
  assert.equal((await restoreDrafts(h.deps)).restored, 1);
  assert.deepEqual(h.writes(), [`write:${NEW}`, `write:${NEW}`]);
  assert.equal(h.composers.get(NEW), "draft 3");
  // Wiped twice: not there, and the panel says so.
  const lost = harness({ records: [fresh(3)] });
  lost.hooks.sleep = (ms) => {
    if (ms === 5_000) lost.composers.delete(NEW);
  };
  await restoreDrafts(lost.deps);
  assert.deepEqual(lost.marks, [["draft-3", "needs-copy", "lost"]]);
  // A conversation on screen at the re-check: typed, perhaps still there; never typed again.
  const moved = harness({ records: [fresh(3)] });
  moved.hooks.sleep = (ms) => {
    if (ms === 5_000) moved.setShown(ELSEWHERE);
  };
  await restoreDrafts(moved.deps);
  assert.equal(moved.writes().length, 1);
  assert.deepEqual(moved.marks, [["draft-3", "needs-copy", "maybe-typed"]]);
  // The guard lost at the re-check, then the composer emptied: typed once, maybe still there.
  const unguarded = harness({ records: [fresh(3)] });
  unguarded.hooks.sleep = (ms) => {
    if (ms !== 5_000) return;
    unguarded.composers.delete(NEW);
    unguarded.screenPatch.set(NEW, { accountLabel: undefined });
  };
  await restoreDrafts(unguarded.deps);
  assert.equal(unguarded.writes().length, 1);
  assert.deepEqual(unguarded.marks, [["draft-3", "needs-copy", "maybe-typed"]]);
});

test("the user active leaves the new-session draft pending, and the helper refusing its link opens nothing", async () => {
  const h = harness({ records: [fresh(3)] });
  h.activity.idleMs = 1_000;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "active",
  });
  assert.deepEqual(h.opens(), []);
  assert.deepEqual(h.marks, []);
  // The user starts typing between Relay's look and the helper's own, just before it opens.
  const racing = harness({ records: [fresh(3)] });
  racing.hooks.open = (id) => (id === NEW ? issue("user-active") : undefined);
  assert.deepEqual(await restoreDrafts(racing.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "active",
  });
  assert.deepEqual(racing.opens(), [`open:${NEW}`]);
  assert.equal(racing.shown, HOME);
  assert.deepEqual(racing.writes(), []);
  assert.deepEqual(racing.marks, []);
  // A write refused because the user is active: still pending, nothing typed.
  const typing = harness({ records: [fresh(3)] });
  typing.hooks.write = () => issue("user-active");
  assert.equal((await restoreDrafts(typing.deps)).reason, "active");
  assert.equal(typing.composers.get(NEW), undefined);
  assert.deepEqual(typing.marks, []);
});

test("the user going to the new-session screen while a conversation loads has moved, and is left there", async () => {
  // The link is sent, and before Desktop follows it the user opens the new-session screen.
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.open = (id) => {
    if (id !== target(1)) return;
    h.setShown(NEW);
    return "ignored";
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "moved",
  });
  // No second link, nothing typed, and no return.
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.marks, []);
  assert.equal(h.shown, NEW);
  // The user goes there 4 s into a slow load: the 5 s re-send never comes.
  const late = harness();
  late.hooks.open = () => "ignored";
  let slept = 0;
  late.hooks.sleep = (ms) => {
    if (ms === 500 && ++slept === 8) late.setShown(NEW);
  };
  assert.equal((await restoreDrafts(late.deps)).reason, "moved");
  assert.deepEqual(late.opens(), [`open:${target(1)}`]);
  // And from the new-session screen's wait to a conversation, the same.
  const away = harness({ records: [fresh(3)] });
  away.hooks.open = (id) => {
    if (id !== NEW) return;
    away.setShown(ELSEWHERE);
    return "ignored";
  };
  assert.equal((await restoreDrafts(away.deps)).reason, "moved");
  assert.deepEqual(away.opens(), [`open:${NEW}`]);
  assert.equal(away.shown, ELSEWHERE);
  // Between drafts, too: after the first, the user opens the new-session screen.
  const between = harness({ records: [record(1), record(2)] });
  between.hooks.vault = (op) => {
    if (op === "remove") between.setShown(NEW);
  };
  assert.deepEqual(await restoreDrafts(between.deps), {
    status: "waiting",
    restored: 1,
    left: 1,
    reason: "moved",
  });
  assert.deepEqual(between.opens(), [`open:${target(1)}`]);
});

test("a UI that is not ready in 60 s leaves every draft pending", async () => {
  const h = harness();
  h.hooks.inspect = () => issue("desktop-ui-unsupported");
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "not-ready",
  });
  assert.ok(h.sleeps.every((ms) => ms === 500));
  assert.equal(sum(h.sleeps), 60_000);
  // The wait holds no lock and takes no action.
  assert.deepEqual(h.actionsOutsideLock(), []);
  assert.deepEqual(h.opens(), []);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.notes, []);
});

test("a conversation that never shows is left for copy after 30 s", async () => {
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.open = (id) => (id === target(1) ? "ignored" : undefined);
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 1,
  });
  assert.deepEqual(h.marks, [
    ["draft-1", "needs-copy", "exact-session-not-observed"],
  ]);
  // The link is sent again every 5 s, for up to 30 s.
  assert.equal(h.opens().filter((c) => c === `open:${target(1)}`).length, 6);
  assert.equal(sum(h.sleeps.slice(0, h.sleeps.indexOf(5_000))), 30_000);
  assert.deepEqual(h.writes(), [`write:${target(2)}`]);
});

test("an open that fails without halting is sent again", async () => {
  const h = harness();
  let opens = 0;
  h.hooks.open = () =>
    ++opens === 1 ? issue("desktop-ui-unsupported") : undefined;
  assert.equal((await restoreDrafts(h.deps)).restored, 1);
  assert.deepEqual(h.opens().slice(0, 2), [
    `open:${target(1)}`,
    `open:${target(1)}`,
  ]);
  // One that always fails is left for copy once the 30 s are over.
  const never = harness();
  never.hooks.open = (id) =>
    id === target(1) ? issue("desktop-ui-unsupported") : undefined;
  await restoreDrafts(never.deps);
  assert.deepEqual(never.marks, [
    ["draft-1", "needs-copy", "exact-session-not-observed"],
  ]);
  assert.deepEqual(never.writes(), []);
});

test("Claude quitting mid-restore stops, and the rest stay pending", async () => {
  const h = harness({ records: [record(1), record(2), record(3)] });
  h.hooks.open = (id) =>
    id === target(2) ? issue("claude-not-running") : undefined;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 1,
    left: 2,
    reason: "claude-not-running",
  });
  assert.deepEqual(h.removed, ["draft-1"]);
  assert.deepEqual(h.marks, []);
  assert.equal(h.calls.at(-1), `open:${target(2)}`);
  // What was restored is still told.
  assert.deepEqual(h.notes, [{ restored: 1, left: 0 }]);
});

test("Claude quitting during a write leaves that draft for copy, never for a blind retry", async () => {
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.write = () => issue("claude-not-running");
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "claude-not-running",
  });
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "maybe-typed"]]);
  assert.equal(h.calls.at(-1), `write:${target(1)}`);
});

test("a vault that fails to mark or remove does not stop the other drafts", async () => {
  const h = harness({
    records: [record(1), record(2), record(3)],
    composers: { [target(1)]: "user text" },
  });
  h.hooks.vault = (op, id) =>
    (op === "mark" && id === "draft-1") || (op === "remove" && id === "draft-2")
      ? new Error("vault unreadable")
      : undefined;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 2,
    left: 1,
  });
  assert.deepEqual(h.writes(), [`write:${target(2)}`, `write:${target(3)}`]);
  assert.deepEqual(h.removed, ["draft-3"]);
  // The draft the vault would not mark is not in the panel, so it is not told as left there.
  assert.deepEqual(h.notes, [{ restored: 2, left: 0 }]);
});

test("the return point is used only when it was seen and differs from the last conversation", async () => {
  // Where the user is cannot be told, as on Claude's start screen after a switch: Relay takes
  // them to the drafts all the same, and they stay at the last one.
  const unseen = harness({ shown: undefined, records: [record(1), fresh(2)] });
  const result = await restoreDrafts(unseen.deps);
  assert.equal(result.restored, 2);
  assert.deepEqual(unseen.opens(), [`open:${target(1)}`, "open:new-session"]);
  assert.deepEqual(unseen.writes(), [`write:${target(1)}`, "write:new-session"]);
  // Without visits, as once the first two minutes are over, it waits for the user instead.
  const later = harness({ shown: undefined, records: [record(1), fresh(2)] });
  assert.deepEqual(await restoreDrafts(later.deps, { visits: false }), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "elsewhere",
  });
  assert.deepEqual(later.opens(), []);
  assert.deepEqual(later.writes(), []);
  assert.deepEqual(later.marks, []);
  assert.deepEqual(later.notes, []);
  // The user was already on the draft's conversation: nothing is opened at all.
  const same = harness({ shown: target(1) });
  assert.equal((await restoreDrafts(same.deps)).restored, 1);
  assert.deepEqual(same.opens(), []);
  // A failed return is ignored.
  const failed = harness();
  failed.hooks.open = (id) =>
    id === HOME ? issue("desktop-ui-unsupported") : undefined;
  assert.deepEqual(await restoreDrafts(failed.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  // Desktop busy at the return: the drafts are done, the user stays where they are.
  const busy = harness();
  busy.hooks.busy = (n) => n === 2;
  assert.deepEqual(await restoreDrafts(busy.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(busy.opens(), [`open:${target(1)}`]);
});

test("the user moving before the target shows stops the restore, and is never taken back", async () => {
  // The reviewer's run: the link is sent, and before Desktop follows it the user opens C.
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.open = (id) => {
    if (id !== target(1)) return;
    h.setShown(ELSEWHERE);
    return "ignored";
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "moved",
  });
  // No second link, nothing typed, and no return to where the user was.
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.marks, []);
  assert.equal(h.shown, ELSEWHERE);
  // The user moves 4 s into a slow load: the 5 s re-send never comes.
  const late = harness();
  late.hooks.open = () => "ignored";
  let slept = 0;
  late.hooks.sleep = (ms) => {
    if (ms === 500 && ++slept === 8) late.setShown(ELSEWHERE);
  };
  assert.equal((await restoreDrafts(late.deps)).reason, "moved");
  assert.deepEqual(late.opens(), [`open:${target(1)}`]);
  assert.deepEqual(late.writes(), []);
  assert.deepEqual(late.marks, []);
});

test("a target already on screen is not opened", async () => {
  const h = harness({ shown: target(1) });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(h.opens(), []);
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
});

test("a draft whose place is on screen is typed there with 1 s of quiet keys, whatever the mouse does", async () => {
  for (const shown of [target(1), NEW]) {
    const records = shown === NEW ? [fresh(1)] : [record(1)];
    const h = harness({ shown, records });
    // The mouse is in use; no key has been pressed for 1 s.
    h.activity.idleMs = 0;
    h.activity.keyIdleMs = 1_000;
    assert.deepEqual(await restoreDrafts(h.deps), {
      status: "done",
      restored: 1,
      left: 0,
    });
    assert.deepEqual(h.opens(), [], shown);
    assert.deepEqual(h.writes(), [`write:${shown}`], shown);
    assert.deepEqual(h.removed, ["draft-1"], shown);
  }
  // Every write asks the helper to check, right before it types, that no key came for 1 s.
  const visit = harness({ records: [record(1), record(2)] });
  assert.equal((await restoreDrafts(visit.deps)).restored, 2);
  assert.deepEqual(visit.writeOptions, [
    { keysIdleMs: 1_000 },
    { keysIdleMs: 1_000 },
  ]);
  // A key between the look and the write: the helper refuses, and the draft waits.
  const late = harness({ shown: target(1) });
  late.hooks.write = () => {
    late.activity.keyIdleMs = 50;
  };
  assert.deepEqual(await restoreDrafts(late.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "active",
  });
  assert.equal(late.composers.get(target(1)), undefined);
  assert.deepEqual(late.marks, []);
});

test("the draft of the place on screen goes first, and the user is brought back there", async () => {
  const h = harness({ records: [record(1), record(2), record(3)], shown: target(2) });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 3,
    left: 0,
  });
  assert.deepEqual(h.writes(), [
    `write:${target(2)}`,
    `write:${target(1)}`,
    `write:${target(3)}`,
  ]);
  assert.deepEqual(h.opens(), [
    `open:${target(1)}`,
    `open:${target(3)}`,
    `open:${target(2)}`,
  ]);
  assert.equal(h.shown, target(2));
});

test("without visits only the draft on screen is typed, and the rest wait as elsewhere", async () => {
  const h = harness({ records: [record(1), record(2), fresh(3)], shown: target(2) });
  assert.deepEqual(await restoreDrafts(h.deps, { visits: false }), {
    status: "waiting",
    restored: 1,
    left: 2,
    reason: "elsewhere",
  });
  assert.deepEqual(h.opens(), []);
  assert.deepEqual(h.writes(), [`write:${target(2)}`]);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.notes, [{ restored: 1, left: 0 }]);
  assert.deepEqual(
    h.logs.filter((e) => e.event === "skip"),
    [
      { event: "skip", id: "draft-1", visits: false, returnKnown: true, screen: null },
      { event: "skip", id: "draft-3", visits: false, returnKnown: true, screen: null },
    ],
  );
  // Nothing on screen of theirs: nothing is opened, typed or told.
  const none = harness({ records: [record(1)] });
  assert.deepEqual(await restoreDrafts(none.deps, { visits: false }), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "elsewhere",
  });
  assert.deepEqual(none.calls.filter((c) => c !== "inspect"), []);
  assert.deepEqual(none.notes, []);
  // An idle user changes nothing about it.
  const idle = harness({ records: [record(1)] });
  idle.activity.idleMs = 600_000;
  assert.equal(
    (await restoreDrafts(idle.deps, { visits: false })).reason,
    "elsewhere",
  );
  assert.deepEqual(idle.opens(), []);
});

test("while the screen shows where the user was, or is loading, the link is sent again every 5 s", async () => {
  const h = harness();
  const start = h.now();
  const sent: number[] = [];
  h.hooks.open = (id) => {
    if (id !== target(1)) return;
    sent.push(h.now() - start);
    // Desktop follows the third link. After the second the screen is loading.
    if (sent.length === 2) h.setShown(undefined);
    if (sent.length < 3) return "ignored";
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(sent, [0, 5_000, 10_000]);
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
});

test("Claude not in front, or the user active, leaves every draft pending and opens nothing", async () => {
  type Activity = ReturnType<typeof harness>["activity"];
  // Taking the user to the first draft's conversation needs 3 s without any input.
  const away: Array<[string, (a: Activity) => void]> = [
    ["Claude is not frontmost", (a) => void (a.frontmost = false)],
    ["the user was active 1 s ago", (a) => void (a.idleMs = 1_000)],
    ["no frontmost field", (a) => void delete a.frontmost],
    ["no idleMs field", (a) => void delete a.idleMs],
    [
      "neither field",
      (a) => {
        delete a.frontmost;
        delete a.idleMs;
      },
    ],
  ];
  // With the first draft's conversation already on screen, nothing but the lock's own look
  // stands between Relay and a write: Claude in front, and no key for 1 s.
  const here: Array<[string, (a: Activity) => void]> = [
    ["Claude is not frontmost", (a) => void (a.frontmost = false)],
    ["a key was pressed 999 ms ago", (a) => void (a.keyIdleMs = 999)],
    ["no frontmost field", (a) => void delete a.frontmost],
    [
      "a helper that tells no keys apart, and input 1 s ago",
      (a) => {
        delete a.keyIdleMs;
        a.idleMs = 1_000;
      },
    ],
    [
      "no field",
      (a) => {
        delete a.frontmost;
        delete a.idleMs;
        delete a.keyIdleMs;
      },
    ],
  ];
  for (const [shown, cases] of [
    [HOME, away],
    [target(1), here],
  ] as const)
    for (const [name, change] of cases) {
      const h = harness({ records: [record(1), record(2)], shown });
      change(h.activity);
      assert.deepEqual(
        await restoreDrafts(h.deps),
        { status: "waiting", restored: 0, left: 2, reason: "active" },
        name,
      );
      assert.deepEqual(h.opens(), [], name);
      assert.deepEqual(h.writes(), [], name);
      assert.deepEqual(h.marks, [], name);
      assert.deepEqual(h.notes, [], name);
    }
  // 3 s without input is enough.
  const idle = harness();
  idle.activity.idleMs = 3_000;
  assert.equal((await restoreDrafts(idle.deps)).restored, 1);
  // The user turning active between drafts stops the run before the next open.
  const between = harness({ records: [record(1), record(2)] });
  between.hooks.vault = (op) => {
    if (op === "remove") between.activity.idleMs = 0;
  };
  assert.deepEqual(await restoreDrafts(between.deps), {
    status: "waiting",
    restored: 1,
    left: 1,
    reason: "active",
  });
  assert.deepEqual(between.opens(), [`open:${target(1)}`]);
  // And before the return: the drafts are done, and the user stays where they are.
  const end = harness();
  end.hooks.vault = (op) => {
    if (op === "remove") end.activity.frontmost = false;
  };
  assert.deepEqual(await restoreDrafts(end.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(end.opens(), [`open:${target(1)}`]);
});

test("the user turning active while the target loads stops the run before the link is sent again", async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => void (h.activity.idleMs = 200),
    (h: ReturnType<typeof harness>) => void (h.activity.frontmost = false),
  ]) {
    const h = harness();
    h.hooks.open = () => "ignored";
    let slept = 0;
    h.hooks.sleep = (ms) => {
      if (ms === 500 && ++slept === 6) change(h);
    };
    assert.deepEqual(await restoreDrafts(h.deps), {
      status: "waiting",
      restored: 0,
      left: 1,
      reason: "active",
    });
    assert.deepEqual(h.opens(), [`open:${target(1)}`]);
    assert.deepEqual(h.writes(), []);
    assert.deepEqual(h.marks, []);
  }
});

test("a write refused because the user is active leaves the draft pending, never for copy", async () => {
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.write = () => issue("user-active");
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "active",
  });
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.notes, []);
  // The user starts typing as the target shows: the helper's own fresh look refuses.
  const typing = harness();
  typing.hooks.inspect = () => {
    if (typing.shown !== target(1)) return;
    typing.activity.idleMs = 100;
    typing.activity.keyIdleMs = 100;
  };
  assert.deepEqual(await restoreDrafts(typing.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "active",
  });
  assert.equal(typing.composers.get(target(1)), undefined);
  assert.deepEqual(typing.marks, []);
  assert.deepEqual(typing.opens(), [`open:${target(1)}`]);
});

test("a target is waited for until a guard can be built from it", async () => {
  const h = harness();
  // Desktop shows the conversation and its composer before its permission mode.
  h.patch.permissionMode = undefined;
  let slept = 0;
  h.hooks.sleep = (ms) => {
    if (ms === 500 && ++slept === 3) delete h.patch.permissionMode;
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(h.writes(), [`write:${target(1)}`]);
  assert.deepEqual(h.marks, []);
  // Waiting on the target itself sends no new link.
  assert.deepEqual(h.opens(), [`open:${target(1)}`, `open:${HOME}`]);
});

test("a Desktop operation waiting for the lock stops the restore before Relay opens again or types", async () => {
  // It asks while Relay waits for the target to show.
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.open = () => "ignored";
  let waiter = false;
  let slept = 0;
  h.hooks.sleep = (ms) => {
    if (ms === 500 && ++slept === 2) waiter = true;
  };
  h.hooks.yielding = () => waiter;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "busy",
  });
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.marks, []);
  assert.equal(slept, 2);
  // It asks as the target shows, just before the first write.
  const late = harness();
  let asked = false;
  late.hooks.inspect = () => {
    if (late.shown === target(1)) asked = true;
  };
  late.hooks.yielding = () => asked;
  assert.deepEqual(await restoreDrafts(late.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "busy",
  });
  assert.deepEqual(late.writes(), []);
  assert.deepEqual(late.marks, []);
  assert.equal(late.composers.get(target(1)), undefined);
  // During the 5 s re-check it does not hold back the one rewrite a wipe needs.
  const rewrite = harness();
  let wiped = false;
  rewrite.hooks.sleep = (ms) => {
    if (ms === 5_000 && !wiped) {
      wiped = true;
      rewrite.composers.delete(target(1));
    }
  };
  rewrite.hooks.yielding = () => wiped;
  assert.equal((await restoreDrafts(rewrite.deps)).restored, 1);
  assert.equal(rewrite.writes().length, 2);
});

test("every link the restorer sends asks the helper to check the user right before opening", async () => {
  const h = harness({ records: [record(1), record(2)] });
  // The first link does not take, so it is sent again; then the user is taken back.
  let first = true;
  h.hooks.open = (id) => {
    if (id !== target(1) || !first) return;
    first = false;
    return "ignored";
  };
  assert.equal((await restoreDrafts(h.deps)).restored, 2);
  assert.deepEqual(h.opens(), [
    `open:${target(1)}`,
    `open:${target(1)}`,
    `open:${target(2)}`,
    `open:${HOME}`,
  ]);
  assert.deepEqual(
    h.openOptions,
    h.opens().map(() => ({ requireIdle: true })),
  );
});

test("the helper refusing a link because the user is active stops the run with nothing typed", async () => {
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.open = () => issue("user-active");
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "active",
  });
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.notes, []);
  // The user starts typing between Relay's look and the helper's own, just before it opens.
  const racing = harness();
  racing.hooks.open = () => {
    racing.activity.idleMs = 50;
  };
  assert.equal((await restoreDrafts(racing.deps)).reason, "active");
  assert.equal(racing.shown, HOME);
  assert.deepEqual(racing.writes(), []);
  assert.deepEqual(racing.marks, []);
  // At the return the drafts are done: a refusal leaves the user where they are.
  const back = harness();
  back.hooks.open = (id) => (id === HOME ? issue("user-active") : undefined);
  assert.deepEqual(await restoreDrafts(back.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
});

test("once the target has appeared, any other conversation means the user moved, and no link is sent again", async () => {
  // The target shows before it can be guarded; the user goes back to where they were.
  const h = harness();
  h.patch.permissionMode = undefined;
  let slept = 0;
  h.hooks.sleep = (ms) => {
    if (ms === 500 && ++slept === 2) h.setShown(HOME);
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "moved",
  });
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.writes(), []);
  assert.deepEqual(h.marks, []);
  assert.equal(h.shown, HOME);
  // The screen loads again after the target appeared: Relay waits, and never sends it again.
  const reloading = harness();
  reloading.patch.permissionMode = undefined;
  let naps = 0;
  reloading.hooks.sleep = (ms) => {
    if (ms === 500 && ++naps === 2) reloading.setShown(undefined);
  };
  await restoreDrafts(reloading.deps);
  assert.deepEqual(reloading.opens(), [`open:${target(1)}`]);
  assert.deepEqual(reloading.marks, [
    ["draft-1", "needs-copy", "exact-session-not-observed"],
  ]);
});

// --- The diagnosis log: what the restorer says, and never a draft's text -------------

/** Drafts whose words no id, state or reason could contain by chance. */
const SECRET = "quartz zebra marmalade ONE";
const SECRET_NEW = "lantern pickle walrus TWO";
const SECRET_WORDS = [...SECRET.split(" "), ...SECRET_NEW.split(" ")].filter(
  (word) => word.length >= 5,
);
const names = (logs: Array<Record<string, unknown>>) =>
  logs.map((entry) => entry.event);
const entry = (logs: Array<Record<string, unknown>>, event: string) => {
  const found = logs.filter((e) => e.event === event);
  assert.equal(found.length, 1, `exactly one ${event}`);
  return found[0];
};
/** Every value of every logged event holds neither a draft's text nor a word of it. */
function assertNoText(logs: Array<Record<string, unknown>>) {
  assert.ok(logs.length > 0);
  for (const logged of logs)
    for (const [key, value] of Object.entries(logged)) {
      assert.notEqual(key.toLowerCase(), "text");
      const shown = String(value);
      for (const secret of [SECRET, SECRET_NEW])
        assert.ok(!shown.includes(secret), `${key}: ${shown}`);
      for (const word of SECRET_WORDS)
        assert.ok(!shown.includes(word), `${key}: ${shown}`);
      // Only plain values: a nested one could hold anything.
      assert.ok(
        ["string", "number", "boolean"].includes(typeof value) || value === null,
        key,
      );
    }
  assert.ok(!JSON.stringify(logs).includes(SECRET));
  assert.ok(!JSON.stringify(logs).includes(SECRET_NEW));
}

test("a restored draft logs each step of its run, and no text", async () => {
  const h = harness({
    records: [
      record(1, { text: SECRET }),
      fresh(2, { text: SECRET_NEW }),
    ],
  });
  assert.equal((await restoreDrafts(h.deps)).restored, 2);

  assert.deepEqual(names(h.logs), [
    "restore-start",
    "record-start",
    "shown",
    "write",
    "recheck",
    "restored",
    "record-start",
    "shown",
    "write",
    "recheck",
    "restored",
    "restore-end",
  ]);
  assert.deepEqual(h.logs[0], {
    event: "restore-start",
    account: ACCOUNT.slice(0, 8),
    records: 2,
    all: 2,
    ready: true,
    wiped: false,
    waitedMs: 0,
  });
  assert.deepEqual(h.logs[1], {
    event: "record-start",
    id: "draft-1",
    target: "00000001",
    newSession: false,
  });
  assert.deepEqual(h.logs[2], {
    event: "shown",
    id: "draft-1",
    matched: true,
    status: "stopped",
    composerPresent: true,
    composerEmpty: true,
    // The helper's reason, count and page shape; this fake's snapshots carry none.
    composerEmptyAs: null,
    composerChars: null,
    screen: null,
    panes: null,
    paneFound: null,
    accountLabel: true,
    permissionMode: "Auto",
    frontmost: true,
    idleMs: 60_000,
    guardable: true,
    sessionMatches: true,
  });
  assert.deepEqual(h.logs[3], { event: "write", id: "draft-1", ok: true, attempt: 1 });
  assert.deepEqual(h.logs[4], {
    event: "recheck",
    id: "draft-1",
    composerPresent: true,
    composerEmpty: false,
    status: "stopped",
    pidSame: true,
    sessionMatches: true,
  });
  assert.deepEqual(h.logs[5], { event: "restored", id: "draft-1", removed: true });
  // The new-session draft has no alias to name, and is on its own screen.
  assert.deepEqual(h.logs[6], {
    event: "record-start",
    id: "draft-2",
    target: null,
    newSession: true,
  });
  assert.equal(h.logs[7].sessionMatches, true);
  assert.deepEqual(h.logs.at(-1), {
    event: "restore-end",
    status: "done",
    restored: 2,
    left: 0,
    reason: null,
  });
  assertNoText(h.logs);
});

test("a write the helper refuses logs the issue, the leave and the end, and no text", async () => {
  const h = harness({ records: [record(1, { text: SECRET })] });
  h.hooks.write = () => issue("delivery-ambiguous");
  assert.equal((await restoreDrafts(h.deps)).left, 1);

  assert.deepEqual(names(h.logs), [
    "restore-start",
    "record-start",
    "shown",
    "write",
    "leave",
    "restore-end",
  ]);
  assert.deepEqual(h.logs[3], {
    event: "write",
    id: "draft-1",
    ok: false,
    attempt: 1,
    issue: "delivery-ambiguous",
  });
  assert.deepEqual(h.logs[4], {
    event: "leave",
    id: "draft-1",
    reason: "maybe-typed",
    marked: true,
  });
  assert.deepEqual(h.logs[5], {
    event: "restore-end",
    status: "done",
    restored: 0,
    left: 1,
    reason: null,
  });
  assertNoText(h.logs);
});

test("a text wiped after writing logs both writes and both re-checks", async () => {
  const h = harness({ records: [record(1, { text: SECRET })] });
  h.hooks.sleep = (ms) => {
    if (ms === 5_000) h.composers.delete(target(1));
  };
  await restoreDrafts(h.deps);
  assert.deepEqual(
    h.logs.filter((e) => e.event === "write" || e.event === "recheck").map((e) => [e.event, e.attempt ?? e.composerEmpty]),
    [
      ["write", 1],
      ["recheck", true],
      ["write", 2],
      ["recheck", true],
    ],
  );
  assert.deepEqual(entry(h.logs, "leave"), {
    event: "leave",
    id: "draft-1",
    reason: "lost",
    marked: true,
  });
  assertNoText(h.logs);
});

test("a conversation that never shows logs the timeout with the last view", async () => {
  const h = harness({ records: [record(1, { text: SECRET })] });
  h.hooks.open = () => "ignored";
  await restoreDrafts(h.deps);

  assert.deepEqual(entry(h.logs, "shown-timeout"), {
    event: "shown-timeout",
    id: "draft-1",
    sessionMatches: false,
    seen: HOME.slice(6, 14),
    status: "stopped",
    composerPresent: true,
  });
  assert.equal(h.logs.some((e) => e.event === "shown"), false);
  assert.equal(entry(h.logs, "leave").reason, "exact-session-not-observed");
  assertNoText(h.logs);
});

test("a stop logs what leaves, and why", async () => {
  // The user moves to another conversation after the first draft.
  const moved = harness({
    records: [record(1, { text: SECRET }), record(2, { text: SECRET_NEW })],
  });
  moved.hooks.vault = (op) => {
    if (op === "remove") moved.setShown(ELSEWHERE);
  };
  await restoreDrafts(moved.deps);
  assert.deepEqual(entry(moved.logs, "stop"), {
    event: "stop",
    leaves: "pending",
    reason: "moved",
    wrote: false,
    phase: "records",
  });
  assert.deepEqual(moved.logs.at(-1), {
    event: "restore-end",
    status: "waiting",
    restored: 1,
    left: 1,
    reason: "moved",
  });
  assertNoText(moved.logs);

  // Accessibility lost: every draft is left for copy.
  const blind = harness({
    records: [record(1, { text: SECRET }), record(2, { text: SECRET_NEW })],
  });
  blind.hooks.write = () => issue("accessibility-permission-required");
  await restoreDrafts(blind.deps);
  assert.deepEqual(entry(blind.logs, "stop"), {
    event: "stop",
    leaves: "copy",
    reason: "accessibility",
    wrote: false,
    phase: "records",
  });
  assert.deepEqual(
    blind.logs.filter((e) => e.event === "leave").map((e) => [e.id, e.reason]),
    [
      ["draft-1", "accessibility"],
      ["draft-2", "accessibility"],
    ],
  );
  assert.equal(entry(blind.logs, "write").issue, "accessibility-permission-required");
  assertNoText(blind.logs);
});

test("a re-check that cannot look is logged without a view", async () => {
  const h = harness({ records: [record(1, { text: SECRET })] });
  h.hooks.sleep = (ms) => {
    if (ms === 5_000) h.hooks.inspect = () => issue("desktop-ui-unsupported");
  };
  await restoreDrafts(h.deps);
  assert.deepEqual(entry(h.logs, "recheck"), {
    event: "recheck",
    id: "draft-1",
    inspected: false,
    issue: "desktop-ui-unsupported",
  });
  assert.equal(entry(h.logs, "leave").reason, "maybe-typed");
  assertNoText(h.logs);
});

test("a run that finds Claude not ready logs it, and one with nothing to restore logs why", async () => {
  const early = harness({ running: false, records: [record(1, { text: SECRET })] });
  await restoreDrafts(early.deps);
  assert.deepEqual(early.logs, [
    { event: "restore-start", account: ACCOUNT.slice(0, 8), records: 1, all: 1, ready: false },
    { event: "restore-end", status: "waiting", restored: 0, left: 1, reason: null },
  ]);
  // Pending drafts of another account: Desktop is not on theirs.
  const other = harness({ records: [record(1, { to: OTHER, text: SECRET })] });
  await restoreDrafts(other.deps);
  assert.deepEqual(other.logs, [
    { event: "restore-start", account: ACCOUNT.slice(0, 8), records: 0, all: 1, ready: null },
    { event: "restore-end", status: "idle", restored: 0, left: 0, reason: null },
  ]);
  // No Desktop account at all.
  const signedOut = harness({ records: [record(1, { text: SECRET })] });
  signedOut.setAccount(undefined);
  await restoreDrafts(signedOut.deps);
  assert.deepEqual(signedOut.logs[0], {
    event: "restore-start",
    account: null,
    records: 0,
    all: null,
    ready: null,
  });
  assertNoText([...early.logs, ...other.logs, ...signedOut.logs]);
  // The account is logged by its short id only.
  assert.doesNotMatch(
    JSON.stringify([...early.logs, ...other.logs]),
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
});

test("a restore that throws logs its end with the error's name, never its message", async () => {
  const h = harness({ records: [record(1, { text: SECRET })] });
  h.deps.withLock = async () => {
    throw new Error(`the lock failed on ${SECRET}`);
  };
  await assert.rejects(restoreDrafts(h.deps), /the lock failed/);
  assert.deepEqual(h.logs.at(-1), {
    event: "restore-end",
    status: "threw",
    error: "Error",
  });
  assertNoText(h.logs);
});

test("a log that throws never disturbs a restore", async () => {
  const h = harness({ records: [record(1, { text: SECRET })] });
  h.deps.log = () => {
    throw new Error("the log failed");
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 0,
  });
  assert.deepEqual(h.removed, ["draft-1"]);
  // And a restorer without a log is the one every other test runs.
  const bare = harness();
  delete bare.deps.log;
  assert.equal((await restoreDrafts(bare.deps)).restored, 1);
});

test("the restorer never sends and waits only through its deps", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "../electron/core/draft-restorer.ts"),
    "utf8",
  );
  for (const forbidden of [
    ".send(",
    "hasRequestMarker",
    "setTimeout",
    "setInterval",
    "Date.now",
    "console.",
  ])
    assert.equal(source.includes(forbidden), false, forbidden);
});

test("nothing is opened or typed while Claude's page has not booted", async () => {
  const h = harness({ shown: undefined, records: [record(1)] });
  h.deps.pageBooted = async () => false;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "loading",
  });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.marks, []);
  assert.ok(h.logs.some((l) => l.event === "page-loading"));
  // Booted, or a log that cannot tell: the run goes on as before.
  for (const booted of [true, undefined]) {
    const next = harness({ shown: undefined, records: [record(1)] });
    next.deps.pageBooted = async () => booted;
    assert.equal((await restoreDrafts(next.deps)).restored, 1);
  }
});

test("a conversation that shows without its composer yet keeps its draft pending", async () => {
  const h = harness({ shown: undefined, records: [record(1)] });
  // Its URL is on screen, but its content never loads while the run waits.
  h.noComposer.add(target(1));
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "loading",
  });
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.writes(), []);
});
