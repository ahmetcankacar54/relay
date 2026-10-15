import test from "node:test";
import assert from "node:assert/strict";
import { TrayMascot, motionAllowed, readDesktopForTray } from "../electron/core/tray-mascot";
import type { MascotInput } from "../shared/mascot";
import type { Account, AccountUsage, DesktopState } from "../shared/types";

const NOW = Date.parse("2026-10-15T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const account = (id: string) =>
  ({ id, name: id, kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW) }) as Account;
const usage = (id: string, five: number): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, resetsAt: iso(NOW + 3_600_000) },
});
const desktop = (extra: Partial<DesktopState> = {}): DesktopState => ({
  available: true, running: true, organizations: [], activeProfileId: "a", busy: false,
  recoveryRequired: false, errorRevision: 0, ...extra,
});
const input = (d: Partial<DesktopState> = {}): MascotInput => ({
  accounts: [account("a"), account("b")], usage: { a: usage("a", 20), b: usage("b", 10) }, desktop: desktop(d),
});

function recorder() {
  const poses: string[] = [];
  let destroyed = false;
  const mascot = new TrayMascot(
    { update: (pose) => void poses.push(pose), destroy: () => void (destroyed = true) },
    () => NOW,
  );
  return { mascot, poses, destroyed: () => destroyed };
}

test("each tray snapshot becomes a pose", () => {
  const r = recorder();
  r.mascot.next(input());
  r.mascot.next(input({ busy: true }));
  r.mascot.next(input({ activeProfileId: "b" }));
  assert.deepEqual(r.poses, ["idle", "away", "idle"]);
});

test("an unreadable snapshot rests on idle", () => {
  const r = recorder();
  r.mascot.next(input({ busy: true }));
  r.mascot.unavailable();
  assert.deepEqual(r.poses, ["away", "idle"]);
});

test("a Desktop read that overlapped an operation counts as busy", async () => {
  const world = { busy: false, operations: 4 };
  const read = (during: () => void) =>
    readDesktopForTray({
      read: async () => {
        during();
        return "state";
      },
      busy: () => world.busy,
      operations: () => world.operations,
    });
  assert.deepEqual(await read(() => {}), { state: "state", busy: false });
  // Began and ended during the read: the state may predate the switch.
  assert.deepEqual(await read(() => void world.operations++), { state: "state", busy: true });
  // Busy when the read began, finished before it ended.
  world.busy = true;
  assert.deepEqual(await read(() => void (world.busy = false)), { state: "state", busy: true });
  // Began during the read and still running.
  assert.deepEqual(
    await read(() => {
      world.operations++;
      world.busy = true;
    }),
    { state: "state", busy: true },
  );
});

test("destroy stops the player", () => {
  const r = recorder();
  r.mascot.destroy();
  assert.equal(r.destroyed(), true);
});

test("motion needs the setting on and Reduce motion off, and survives a failing system read", () => {
  const reduce = (prefersReducedMotion: boolean) => () => ({ prefersReducedMotion });
  assert.equal(motionAllowed({}, reduce(false)), true);
  assert.equal(motionAllowed({ menuBarAnimation: true }, reduce(false)), true);
  assert.equal(motionAllowed({ menuBarAnimation: false }, reduce(false)), false);
  assert.equal(motionAllowed({}, reduce(true)), false);
  assert.equal(motionAllowed({}, () => { throw new Error("unsupported"); }), true);
});
