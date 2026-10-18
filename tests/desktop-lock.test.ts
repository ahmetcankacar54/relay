import test from "node:test";
import assert from "node:assert/strict";
import { LockBusyError } from "../electron/core/process-lock";
import { DesktopLock } from "../electron/core/desktop-lock";
import { restoreDrafts } from "../electron/core/draft-restorer";
import type { DesktopAutomationSnapshot } from "../electron/core/desktop-continuation-host";
import type { DraftRecord } from "../electron/core/draft-vault";

const ACCOUNT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const HOME = "local_ffffffff-ffff-4fff-8fff-ffffffffffff";
const alias = (n: number) =>
  `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}
function record(n: number): DraftRecord {
  return {
    id: `draft-${n}`,
    to: ACCOUNT,
    targetAlias: alias(n),
    title: `Conversation ${n}`,
    text: `draft ${n}`,
    attachments: false,
    capturedAt: new Date(0).toISOString(),
    state: "pending",
  };
}

test("Desktop operations run one at a time in the order they ask, and each is told inside the lock", { timeout: 5_000 }, async () => {
  const told: string[] = [];
  const lock: DesktopLock = new DesktopLock(() =>
    told.push(lock.active ? "begin" : "end"),
  );
  const order: string[] = [];
  const first = gate();
  const one = lock.run(async () => {
    order.push("one");
    await first.closed;
  });
  const two = lock.run(async () => {
    order.push("two");
  });
  await flush();
  // The waiter is not told while it waits.
  assert.deepEqual(order, ["one"]);
  assert.deepEqual(told, ["begin"]);
  assert.equal(lock.callers, 2);
  assert.equal(lock.busy, true);
  first.open();
  await Promise.all([one, two]);
  assert.deepEqual(order, ["one", "two"]);
  assert.deepEqual(told, ["begin", "end", "begin", "end"]);
  assert.equal(lock.callers, 0);
  assert.equal(lock.active, false);
  assert.equal(lock.busy, false);
  assert.equal(lock.operations, 2);
  // A listener that throws changes nothing.
  const quiet = new DesktopLock(() => {
    throw new Error("listener");
  });
  assert.equal(await quiet.run(async () => 3), 3);
});

test("a manual action during another operation is refused, as before", { timeout: 5_000 }, async () => {
  const lock = new DesktopLock();
  const held = gate();
  const running = lock.run(() => held.closed);
  await flush();
  let ran = false;
  await assert.rejects(
    lock.manual(async () => {
      ran = true;
    }),
    /Finish the Desktop handoff before starting another Desktop operation\./,
  );
  held.open();
  await running;
  assert.equal(ran, false);
  assert.equal(await lock.manual(async () => 5), 5);
  // The caller's own reason refuses it too, after the lock's.
  await assert.rejects(
    lock.manual(
      async () => {
        ran = true;
      },
      () => new Error("Wait for the account connection refresh to finish."),
    ),
    /account connection refresh/,
  );
  assert.equal(ran, false);
  assert.equal(lock.callers, 0);
});

test("a manual action during a restore record waits for it, then runs, and the restore's next record sees busy", { timeout: 5_000 }, async () => {
  const lock = new DesktopLock();
  const record = gate();
  const order: string[] = [];
  const restoring = lock.restore(async () => {
    order.push("record");
    await record.closed;
    order.push("record done");
  });
  await flush();
  assert.equal(lock.active, true);
  assert.equal(lock.restoring, true);
  // A restore alone is not what the user sees as busy.
  assert.equal(lock.busy, false);
  assert.equal(lock.operations, 0);

  const manual = lock.manual(async () => {
    order.push("switch");
    assert.equal(lock.restoring, false);
    return "switched";
  });
  await flush();
  assert.deepEqual(order, ["record"]);
  assert.equal(lock.busy, true);
  // Another action while the switch waits is refused, as during any operation.
  await assert.rejects(lock.manual(async () => {}), /Finish the Desktop handoff/);
  // The restore's next record finds the lock taken, at once.
  assert.equal(
    await Promise.race([
      lock.restore(async () => assert.fail("not run")),
      new Promise((resolve) => setTimeout(() => resolve("waited"), 50)),
    ]),
    undefined,
  );
  record.open();
  assert.equal(await manual, "switched");
  await restoring;
  assert.deepEqual(order, ["record", "record done", "switch"]);
  assert.equal(lock.operations, 1);
  assert.equal(lock.callers, 0);
});

test("a switch asked for during a restored draft stops the restore after that draft, the rest pending", { timeout: 5_000 }, async () => {
  const lock = new DesktopLock();
  const views = new Map<string, string>();
  let shown = HOME;
  const calls: string[] = [];
  const view = (): DesktopAutomationSnapshot => ({
    observedAt: 0,
    pid: 7,
    localSessionId: shown,
    accountLabel: "Test User",
    permissionMode: "Auto",
    status: "stopped",
    quotaStopped: false,
    composerPresent: true,
    composerEmpty: !views.get(shown),
    sendEnabled: !!views.get(shown),
    contextFingerprint: `fp:${shown}:${views.get(shown) ?? ""}`,
    coverage: "active-conversation-only",
    frontmost: true,
    idleMs: 60_000,
  });
  let manual: Promise<string> | undefined;
  let waitedFor = false;
  // A switch takes a while: it still holds the lock when the restore asks for its next record.
  const switching = gate();
  const removed: string[] = [];
  const result = await restoreDrafts({
    automation: {
      inspect: async () => view(),
      openSession: async (id) => {
        calls.push(`open:${id}`);
        shown = id;
      },
      openNewSession: async () => assert.fail("no new-session draft"),
      writeDraft: async (_guard, text) => {
        calls.push(`write:${shown}`);
        views.set(shown, text);
        return view();
      },
    },
    pending: async () => [record(1), record(2)],
    mark: async () => assert.fail("nothing is left for copy"),
    remove: async (id) => {
      removed.push(id);
    },
    currentAccount: async () => ACCOUNT,
    running: async () => true,
    uptimeMs: async () => 60_000,
    withLock: (fn) => lock.restore(fn),
    yielding: () => lock.callers > 1,
    notify: () => {},
    sleep: async (ms) => {
      // The 5 s re-check of the first draft, inside its lock: the user asks for a switch.
      if (ms === 5_000 && !manual) {
        manual = lock.manual(async () => {
          calls.push("switch");
          await switching.closed;
          return "switched";
        });
        await flush();
        waitedFor = !calls.includes("switch");
      }
    },
    now: () => 0,
  });
  assert.equal(waitedFor, true);
  // It ran once the first draft was done with.
  assert.ok(calls.indexOf("switch") > calls.indexOf(`write:local_${alias(1)}`));
  switching.open();
  assert.equal(await manual, "switched");
  assert.deepEqual(result, {
    status: "waiting",
    restored: 1,
    left: 1,
    reason: "busy",
  });
  assert.deepEqual(removed, ["draft-1"]);
  // The second draft was never opened or typed.
  assert.ok(!calls.includes(`open:local_${alias(2)}`));
  assert.deepEqual(
    calls.filter((call) => call.startsWith("write:")),
    [`write:local_${alias(1)}`],
  );
  assert.equal(lock.callers, 0);
});

test("a switch asked for while the restore waits for its target is let through before anything is typed", { timeout: 5_000 }, async () => {
  const lock = new DesktopLock();
  const calls: string[] = [];
  const marks: string[] = [];
  let clock = 0;
  let manual: Promise<string> | undefined;
  const result = await restoreDrafts({
    automation: {
      // Desktop is slow to follow the link: the screen stays where the user was.
      inspect: async () => ({
        observedAt: 1,
        pid: 7,
        localSessionId: HOME,
        accountLabel: "Test User",
        permissionMode: "Auto",
        status: "stopped",
        quotaStopped: false,
        composerPresent: true,
        composerEmpty: true,
        sendEnabled: false,
        contextFingerprint: "fp",
        coverage: "active-conversation-only",
        frontmost: true,
        idleMs: 60_000,
      }),
      openSession: async (id) => {
        calls.push(`open:${id}`);
      },
      openNewSession: async () => assert.fail("no new-session draft"),
      writeDraft: async () => assert.fail("nothing is typed"),
    },
    pending: async () => [record(1), record(2)],
    mark: async (id) => {
      marks.push(id);
    },
    remove: async () => assert.fail("nothing is removed"),
    currentAccount: async () => ACCOUNT,
    running: async () => true,
    uptimeMs: async () => 60_000,
    withLock: (fn) => lock.restore(fn),
    yielding: () => lock.callers > 1,
    notify: () => {},
    sleep: async (ms) => {
      clock += ms;
      // The user asks for a switch while Relay waits for the first draft's conversation.
      if (ms === 500 && !manual) {
        manual = lock.manual(async () => {
          calls.push("switch");
          return "switched";
        });
        await flush();
      }
    },
    now: () => clock,
  });
  assert.deepEqual(result, {
    status: "waiting",
    restored: 0,
    left: 2,
    reason: "busy",
  });
  assert.equal(await manual, "switched");
  // One link, then the switch: no link sent again, nothing typed, nothing left for copy.
  assert.deepEqual(calls, [`open:local_${alias(1)}`, "switch"]);
  assert.deepEqual(marks, []);
  assert.equal(lock.callers, 0);
});

test("the restorer's lock is refused at once while Desktop is busy, and lets anything thrown through unchanged", { timeout: 5_000 }, async () => {
  const lock = new DesktopLock();
  let managerBusy = false;
  const withLock = <T>(fn: () => Promise<T>) =>
    lock.restore(fn, () => !managerBusy);
  assert.equal(await withLock(async () => 7), 7);

  // Another Desktop operation holds the lock: undefined at once, without running or waiting.
  const held = gate();
  const holding = lock.run(() => held.closed);
  let ran = false;
  const answer = await Promise.race([
    withLock(async () => {
      ran = true;
    }),
    new Promise((resolve) => setTimeout(() => resolve("waited"), 50)),
  ]);
  assert.equal(answer, undefined);
  assert.equal(ran, false);
  held.open();
  await holding;

  // DesktopManager runs an operation of its own.
  managerBusy = true;
  assert.equal(
    await withLock(async () => {
      ran = true;
    }),
    undefined,
  );
  assert.equal(ran, false);
  managerBusy = false;

  // What is thrown comes out as it went in, Error or not, and the lock is free after it.
  const stop = { leaves: "pending", reason: "changed" };
  await assert.rejects(
    withLock(async () => {
      throw stop;
    }),
    (thrown) => thrown === stop,
  );
  assert.equal(lock.callers, 0);
  assert.equal(lock.active, false);
  const error = new Error("helper");
  await assert.rejects(
    withLock(async () => {
      throw error;
    }),
    (thrown) => thrown === error,
  );
  assert.equal(lock.callers, 0);
  assert.equal(await withLock(async () => "again"), "again");
  // Restores are not counted as operations the menu bar must treat as racing its reads.
  assert.equal(lock.operations, 1);
});

test("the restorer's own stop passes through the lock", { timeout: 5_000 }, async () => {
  // Under the lock the account has changed: the restorer throws its Stop through withLock.
  const lock = new DesktopLock();
  let accountReads = 0;
  const result = await restoreDrafts({
    automation: {
      inspect: async () =>
        ({
          pid: 7,
          localSessionId: HOME,
          frontmost: true,
          idleMs: 60_000,
        }) as DesktopAutomationSnapshot,
      openSession: async () => assert.fail("nothing is opened"),
      openNewSession: async () => assert.fail("nothing is opened"),
      writeDraft: async () => assert.fail("nothing is typed"),
    },
    pending: async () => [record(1)],
    mark: async () => assert.fail("nothing is left for copy"),
    remove: async () => assert.fail("nothing is removed"),
    currentAccount: async () => (accountReads++ === 0 ? ACCOUNT : OTHER),
    running: async () => true,
    uptimeMs: async () => 60_000,
    withLock: (fn) => lock.restore(fn),
    yielding: () => lock.callers > 1,
    notify: () => assert.fail("nothing to tell"),
    sleep: async () => {},
    now: () => 0,
  });
  assert.deepEqual(result, {
    status: "waiting",
    restored: 0,
    left: 1,
    reason: "changed",
  });
  assert.equal(lock.callers, 0);
});

test("an operation whose file lock is busy rejects and frees the queue", async () => {
  const holder = { pid: 1, token: "t", by: "cli" as const, kind: "switch", startedAt: new Date().toISOString() };
  let busy = true;
  const taken: string[] = [];
  const lock = new DesktopLock(() => {}, {
    acquire: (kind) => {
      if (busy) throw new LockBusyError(holder);
      taken.push(`+${kind}`);
    },
    release: () => taken.push("-"),
  });
  let ran = false;
  await assert.rejects(
    lock.run(async () => {
      ran = true;
    }),
    LockBusyError,
  );
  assert.equal(ran, false);
  assert.equal(lock.busy, false);
  assert.equal(lock.active, false);
  busy = false;
  assert.equal(await lock.run(async () => 7), 7);
  assert.deepEqual(taken, ["+operation", "-"]);
});

test("a draft restore gives up when another process holds the file lock", async () => {
  const holder = { pid: 1, token: "t", by: "cli" as const, kind: "switch", startedAt: new Date().toISOString() };
  const lock = new DesktopLock(() => {}, {
    acquire: (kind) => {
      if (kind === "restore") throw new LockBusyError(holder);
    },
    release: () => {},
  });
  let ran = false;
  assert.equal(
    await lock.restore(async () => {
      ran = true;
      return 1;
    }),
    undefined,
  );
  assert.equal(ran, false);
  assert.equal(lock.callers, 0);
});
