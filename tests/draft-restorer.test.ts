import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DesktopAutomationError,
  type DesktopAutomationIssue,
  type DesktopAutomationSnapshot,
} from "../electron/core/desktop-continuation-host";
import type { DraftRecord, DraftState } from "../electron/core/draft-vault";
import {
  restoreDrafts,
  type RestorerDeps,
} from "../electron/core/draft-restorer";

const ACCOUNT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const alias = (n: number) =>
  `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const target = (n: number) => `local_${alias(n)}`;
/** The conversation the user is on when the restore starts. */
const HOME = "local_ffffffff-ffff-4fff-8fff-ffffffffffff";
/** A conversation the user moves to by hand. */
const ELSEWHERE = "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  /** Runs before the nth read of the records; an error is thrown from it. */
  pending?: (n: number) => Error | void;
  /** True when the nth lock is held by another Desktop operation. */
  busy?: (n: number) => boolean;
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
 * A fake Desktop: one composer per conversation, the view on one of them, a clock that only
 * `sleep` moves. It reports what the helper reports: a missing composer is not empty, and a
 * write must match the screen's pid, conversation, account, mode and fingerprint, with the
 * conversation stopped and its composer there and empty.
 */
function harness(
  options: {
    records?: DraftRecord[];
    running?: boolean;
    uptime?: number;
    noUptime?: boolean;
    lockBusy?: boolean;
    shown?: string;
    composers?: Record<string, string>;
    statuses?: Record<string, Status>;
    noComposer?: string[];
  } = {},
) {
  let clock = 1_000_000;
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
  const composers = new Map(Object.entries(options.composers ?? {}));
  const statuses = new Map(Object.entries(options.statuses ?? {}));
  const noComposer = new Set(options.noComposer ?? []);
  /** Fields forced onto every snapshot. */
  const patch: Partial<Snapshot> = {};
  const calls: string[] = [];
  const sleeps: number[] = [];
  const marks: Array<[string, DraftState, string | undefined]> = [];
  const removed: string[] = [];
  const notes: Array<{ restored: number; left: number }> = [];
  const outsideLock: string[] = [];
  const hooks: Hooks = {};
  const view = (): Snapshot => {
    const present = !!shown && !noComposer.has(shown);
    const text = shown ? composers.get(shown) : undefined;
    const stable = {
      pid,
      ...(shown ? { localSessionId: shown } : {}),
      accountLabel: "Test User",
      permissionMode: "Auto",
      status:
        (shown && statuses.get(shown)) || (present ? "stopped" : "unknown"),
      composerPresent: present,
      // As the helper: no composer reads as not empty.
      composerEmpty: present && !text,
      sendEnabled: present && !!text,
      ...patch,
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
    };
  };
  const touch = (call: string) => {
    calls.push(call);
    if (!held) outsideLock.push(call);
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
      openSession: async (id) => {
        touch(`open:${id}`);
        const outcome = hooks.open?.(id);
        if (outcome instanceof Error) throw outcome;
        if (outcome !== "ignored") shown = id;
      },
      writeDraft: async (guard, text) => {
        writes++;
        touch(`write:${guard.localSessionId}`);
        const error = hooks.write?.(writes);
        if (error) throw error;
        // As the helper validates a guard before it types anything.
        const now = view();
        if (
          guard.pid !== now.pid ||
          guard.localSessionId !== now.localSessionId ||
          guard.accountLabel !== now.accountLabel ||
          guard.permissionMode !== now.permissionMode ||
          guard.contextFingerprint !== now.contextFingerprint
        )
          throw issue("context-changed");
        if (now.status !== "stopped") throw issue("desktop-work-active");
        if (!now.composerPresent) throw issue("desktop-ui-unsupported");
        if (!now.composerEmpty) throw issue("composer-not-empty");
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
      return options.noUptime ? undefined : (options.uptime ?? 20_000);
    },
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
    notify: (summary) => {
      notes.push(summary);
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
    calls,
    sleeps,
    marks,
    removed,
    notes,
    outsideLock,
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

test("waits until Claude has been up 15 s", async () => {
  for (const options of [
    { uptime: 14_999 },
    { noUptime: true },
    { running: false },
  ]) {
    const h = harness(options);
    assert.deepEqual(await restoreDrafts(h.deps), {
      status: "waiting",
      restored: 0,
      left: 1,
    });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.marks, []);
    assert.deepEqual(h.removed, []);
  }
  const ready = harness({ uptime: 15_000 });
  assert.equal((await restoreDrafts(ready.deps)).status, "done");
  assert.deepEqual(ready.removed, ["draft-1"]);
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
  assert.deepEqual(h.marks, [
    ["draft-2", "needs-copy", "accessibility"],
    ["draft-3", "needs-copy", "accessibility"],
  ]);
  // Nothing more is tried in Desktop: no third conversation, no return.
  assert.equal(h.calls.at(-1), `write:${target(2)}`);
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
    assert.deepEqual(h.marks, [["draft-1", "needs-copy", "unconfirmed"]], name);
  }
});

test("a re-check inspect that fails leaves the draft unconfirmed and goes on", async () => {
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
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "unconfirmed"]]);
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
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "context-changed"]]);
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
  assert.deepEqual(moved.marks, [["draft-1", "needs-copy", "context-changed"]]);
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
    assert.deepEqual(h.marks, [["draft-1", "needs-copy", name]]);
  }
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
  // The user moving between the wait for the UI and the first lock: nothing is touched.
  const early = harness();
  let looks = 0;
  // The ready look sees HOME; by the first lock's look the user is elsewhere.
  early.hooks.inspect = () => {
    if (++looks === 2) early.setShown(ELSEWHERE);
  };
  assert.equal((await restoreDrafts(early.deps)).reason, "moved");
  assert.deepEqual(early.opens(), []);
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

test("the new-session draft goes straight to copy", async () => {
  const h = harness({
    records: [
      record(3, { targetAlias: undefined, newSession: true }),
      record(4, { text: "x".repeat(16_385) }),
      record(6, { targetAlias: "../not-a-uuid" }),
      record(5, { text: "y".repeat(16_384) }),
    ],
  });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 3,
  });
  assert.deepEqual(h.marks, [
    ["draft-3", "needs-copy", "manual"],
    ["draft-4", "needs-copy", "manual"],
    ["draft-6", "needs-copy", "manual"],
  ]);
  // Only the draft that fits is typed; the limit is inclusive.
  assert.deepEqual(h.writes(), [`write:${target(5)}`]);
  assert.deepEqual(h.opens(), [`open:${target(5)}`, `open:${HOME}`]);
  // Nothing to open, nothing to return from.
  const alone = harness({
    records: [record(3, { targetAlias: undefined, newSession: true })],
  });
  await restoreDrafts(alone.deps);
  assert.deepEqual(alone.opens(), []);
  assert.deepEqual(alone.marks, [["draft-3", "needs-copy", "manual"]]);
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
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "claude-not-running"]]);
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
  // No conversation was open when the restore started.
  const unseen = harness({ shown: undefined });
  await restoreDrafts(unseen.deps);
  assert.deepEqual(unseen.opens(), [`open:${target(1)}`]);
  // The user was already on the draft's conversation.
  const same = harness({ shown: target(1) });
  await restoreDrafts(same.deps);
  assert.deepEqual(same.opens(), [`open:${target(1)}`]);
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
