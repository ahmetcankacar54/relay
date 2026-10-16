import test from "node:test";
import assert from "node:assert/strict";
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

type Status = DesktopAutomationSnapshot["status"];
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
}

/**
 * A fake Desktop: one composer per conversation, the view on one of them, a clock that only
 * `sleep` moves. Its write refuses like the helper does: a moved view, a non-empty composer.
 */
function harness(
  options: {
    records?: DraftRecord[];
    account?: string;
    running?: boolean;
    uptime?: number;
    noUptime?: boolean;
    lockBusy?: boolean;
    shown?: string;
    composers?: Record<string, string>;
    statuses?: Record<string, Status>;
  } = {},
) {
  let clock = 1_000_000;
  let account: string | undefined = options.account ?? ACCOUNT;
  let records = (options.records ?? [record(1)]).map((r) => ({ ...r }));
  let shown: string | undefined = "shown" in options ? options.shown : HOME;
  let held = false;
  let inspects = 0;
  let writes = 0;
  let pendingReads = 0;
  let uptimeReads = 0;
  const composers = new Map(Object.entries(options.composers ?? {}));
  const statuses = new Map(Object.entries(options.statuses ?? {}));
  const calls: string[] = [];
  const sleeps: number[] = [];
  const marks: Array<[string, DraftState, string | undefined]> = [];
  const removed: string[] = [];
  const notes: Array<{ restored: number; left: number }> = [];
  const outsideLock: string[] = [];
  const hooks: Hooks = {};
  const view = (): DesktopAutomationSnapshot => {
    const text = shown ? composers.get(shown) : undefined;
    return {
      observedAt: clock,
      pid: 456,
      ...(shown ? { localSessionId: shown } : {}),
      accountLabel: "Test User",
      permissionMode: "Auto",
      status: (shown && statuses.get(shown)) || "stopped",
      quotaStopped: false,
      composerEmpty: !text,
      sendEnabled: !!text,
      contextFingerprint: (shown ?? "none").slice(-12).padStart(64, "0"),
      coverage: "active-conversation-only",
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
        if (!shown || guard.localSessionId !== shown)
          throw issue("context-changed");
        if (composers.get(shown)) throw issue("composer-not-empty");
        composers.set(shown, text);
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
      if (options.lockBusy) return undefined;
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
    calls,
    sleeps,
    marks,
    removed,
    notes,
    outsideLock,
    composers,
    statuses,
    opens: () => calls.filter((c) => c.startsWith("open:")),
    writes: () => calls.filter((c) => c.startsWith("write:")),
    get inspects() {
      return inspects;
    },
    setShown(id: string | undefined) {
      shown = id;
    },
    setAccount(id: string | undefined) {
      account = id;
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
  // Relay holds its Desktop lock for every step it takes in Desktop.
  assert.deepEqual(h.outsideLock, []);
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

test("the rewrite needs the same conversation, stopped, with an empty composer", async () => {
  // The user moved to another conversation during the re-check.
  const moved = harness();
  moved.hooks.sleep = (ms) => {
    if (ms === 5_000) moved.setShown(HOME);
  };
  await restoreDrafts(moved.deps);
  assert.equal(moved.writes().length, 1);
  assert.deepEqual(moved.marks, [["draft-1", "needs-copy", "context-changed"]]);
  // The composer emptied because the conversation started running: perhaps the user sent it.
  const sent = harness();
  sent.hooks.sleep = (ms) => {
    if (ms === 5_000) {
      sent.composers.delete(target(1));
      sent.statuses.set(target(1), "running");
    }
  };
  await restoreDrafts(sent.deps);
  assert.equal(sent.writes().length, 1);
  assert.deepEqual(sent.marks, [["draft-1", "needs-copy", "busy"]]);
});

test("a re-check with no composer on screen is not taken as restored", async () => {
  // The helper reads a missing composer as not empty, with an unknown status.
  const h = harness();
  h.hooks.sleep = (ms) => {
    if (ms === 5_000) h.statuses.set(target(1), "unknown");
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 0,
    left: 1,
  });
  assert.equal(h.writes().length, 1);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "busy"]]);
});

test("context-changed leaves the record for copy and continues with the next", async () => {
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

test("the conditions are read again under the lock", async () => {
  // A switch relaunched Claude between the first look and the lock: Desktop's wipe is not over.
  const relaunched = harness();
  relaunched.hooks.uptime = (n) => (n === 1 ? 20_000 : 3_000);
  assert.deepEqual(await restoreDrafts(relaunched.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
  });
  assert.deepEqual(relaunched.calls, []);
  // The switch left Desktop on another account: nothing is this account's any more.
  const switched = harness();
  switched.hooks.uptime = () => {
    switched.setAccount(OTHER);
    return 20_000;
  };
  assert.equal((await restoreDrafts(switched.deps)).status, "idle");
  assert.deepEqual(switched.calls, []);
});

test("a failed read of the drafts or the account leaves everything waiting", async () => {
  for (const n of [1, 2]) {
    const h = harness();
    h.hooks.pending = (read) =>
      read === n ? new Error("vault unreadable") : undefined;
    assert.equal((await restoreDrafts(h.deps)).status, "waiting");
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.marks, []);
  }
  // The account read before each draft fails: the restore stops there.
  const h = harness({ records: [record(1), record(2)] });
  let reads = 0;
  h.deps.currentAccount = async () => {
    if (++reads > 3) throw new Error("config unreadable");
    return ACCOUNT;
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 1,
    left: 1,
  });
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
});

test("a busy Desktop (withLock gives undefined) does nothing", async () => {
  const h = harness({ lockBusy: true });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 1,
  });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.notes, []);
});

test("the new-session draft goes straight to copy", async () => {
  const h = harness({
    records: [
      record(3, { targetAlias: undefined, newSession: true }),
      record(4, { text: "x".repeat(16_385) }),
      record(5, { text: "y".repeat(16_384) }),
    ],
  });
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "done",
    restored: 1,
    left: 2,
  });
  assert.deepEqual(h.marks, [
    ["draft-3", "needs-copy", "manual"],
    ["draft-4", "needs-copy", "manual"],
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
  });
  assert.ok(h.sleeps.every((ms) => ms === 500));
  assert.equal(
    h.sleeps.reduce((a, b) => a + b, 0),
    60_000,
  );
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
  const shownWait = h.sleeps.slice(0, h.sleeps.indexOf(5_000));
  assert.equal(
    shownWait.reduce((a, b) => a + b, 0),
    30_000,
  );
  assert.deepEqual(h.writes(), [`write:${target(2)}`]);
});

test("Claude quitting mid-restore stops, and the rest stay pending", async () => {
  const h = harness({ records: [record(1), record(2), record(3)] });
  h.hooks.open = (id) =>
    id === target(2) ? issue("claude-not-running") : undefined;
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 1,
    left: 2,
  });
  assert.deepEqual(h.removed, ["draft-1"]);
  assert.deepEqual(h.marks, []);
  assert.equal(h.calls.at(-1), `open:${target(2)}`);
  assert.deepEqual(h.notes, []);
});

test("Claude quitting during a write leaves that draft for copy, never for a blind retry", async () => {
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.write = () => issue("claude-not-running");
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 0,
    left: 2,
  });
  assert.deepEqual(h.marks, [["draft-1", "needs-copy", "claude-not-running"]]);
  assert.equal(h.calls.at(-1), `write:${target(1)}`);
});

test("a switch of Desktop's account mid-restore stops at the next draft", async () => {
  const h = harness({ records: [record(1), record(2)] });
  h.hooks.vault = (op) => {
    if (op === "remove") h.setAccount(OTHER);
  };
  assert.deepEqual(await restoreDrafts(h.deps), {
    status: "waiting",
    restored: 1,
    left: 1,
  });
  assert.deepEqual(h.removed, ["draft-1"]);
  assert.deepEqual(h.opens(), [`open:${target(1)}`]);
  assert.deepEqual(h.marks, []);
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
    vaultErrors: 2,
  });
  assert.deepEqual(h.writes(), [`write:${target(2)}`, `write:${target(3)}`]);
  assert.deepEqual(h.removed, ["draft-3"]);
  assert.equal(h.notes.length, 1);
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
