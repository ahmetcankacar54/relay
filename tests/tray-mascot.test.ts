import test from "node:test";
import assert from "node:assert/strict";
import { TrayMascot, motionAllowed } from "../electron/core/tray-mascot";
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
  const calls: unknown[][] = [];
  let destroyed = false;
  const mascot = new TrayMascot(
    {
      update: (...args) => void calls.push(args.filter((x) => x !== undefined)),
      destroy: () => void (destroyed = true),
    },
    () => NOW,
  );
  return { mascot, calls, destroyed: () => destroyed };
}

test("each tray snapshot becomes a pose and, after the first, maybe a cue", () => {
  const { mascot, calls } = recorder();
  mascot.next(input());
  mascot.next(input({ busy: true }));
  mascot.next(input({ activeProfileId: "b" }));
  assert.deepEqual(calls, [["idle"], ["away", "leave"], ["idle", "return"]]);
});

test("an unreadable snapshot rests on idle and keeps the memory for the next one", () => {
  const { mascot, calls } = recorder();
  mascot.next(input());
  mascot.next(input({ busy: true }));
  mascot.unavailable();
  mascot.next(input({ activeProfileId: "b" }));
  assert.deepEqual(calls, [["idle"], ["away", "leave"], ["idle"], ["idle", "return"]]);
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
