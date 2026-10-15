import test from "node:test";
import assert from "node:assert/strict";
import { headFor, mascotPose, mascotStep, type MascotInput, type MascotMemory } from "../shared/mascot";
import { BLINK_FRAME, MASCOT_FRAMES, POSE_FRAME } from "../shared/mascot-frames";
import type { Account, AccountUsage, DesktopState, WindowAttempt } from "../shared/types";

const NOW = Date.parse("2026-10-15T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const account = (id: string) =>
  ({ id, name: id, kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW) }) as Account;
const usage = (id: string, five: number, week = 10, extra: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, resetsAt: iso(NOW + 3_600_000) },
  sevenDay: { usedPercent: week, resetsAt: iso(NOW + 86_400_000) },
  ...extra,
});
const desktop = (extra: Partial<DesktopState> = {}): DesktopState => ({
  available: true, running: true, organizations: [], activeProfileId: "a", busy: false,
  recoveryRequired: false, errorRevision: 0, ...extra,
});
const attempt = (id: string, status: WindowAttempt["status"], at = NOW - 30_000): WindowAttempt =>
  ({ id, accountId: "a", identityKey: "k", at: iso(at), status });
const input = (extra: Partial<MascotInput> = {}): MascotInput => ({
  accounts: [account("a"), account("b")],
  usage: { a: usage("a", 20), b: usage("b", 30) },
  desktop: desktop(),
  ...extra,
});
const events = (...inputs: MascotInput[]) => {
  let memory: MascotMemory | undefined;
  return inputs.map((i) => {
    const step = mascotStep(memory, i, NOW);
    memory = step.memory;
    return step.event;
  });
};
const busy = (extra: Partial<DesktopState> = {}) => input({ desktop: desktop({ busy: true, ...extra }) });
const at = (extra: Partial<DesktopState> = {}, desktopOperations?: number) =>
  input({ desktop: desktop(extra), desktopOperations });

test("the panda idles when nothing needs showing", () => {
  assert.equal(mascotPose(input(), NOW), "idle");
  assert.equal(mascotPose(input({ desktop: undefined }), NOW), "idle");
  assert.equal(mascotPose({ accounts: [], usage: {}, desktop: desktop({ activeProfileId: undefined }) }, NOW), "idle");
});

test("the panda gets hungry at the menu bar's rounded 90% warning, five-hour window only", () => {
  assert.equal(mascotPose(input({ usage: { a: usage("a", 89.4), b: usage("b", 30) } }), NOW), "idle");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 89.6), b: usage("b", 30) } }), NOW), "hungry");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 95, 10, { stale: true }), b: usage("b", 30) } }), NOW), "idle");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 20, 95), b: usage("b", 30) } }), NOW), "idle");
});

test("the panda sleeps only when every account is known to be full", () => {
  assert.equal(mascotPose(input({ usage: { a: usage("a", 100), b: usage("b", 40, 100) } }), NOW), "sleeping");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 100) } }), NOW), "hungry");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 100), b: usage("b", 100, 10, { stale: true }) } }), NOW), "hungry");
});

test("warming lasts while a start is under two minutes old", () => {
  assert.equal(mascotPose(input({ attempts: [attempt("1", "started")] }), NOW), "warming");
  assert.equal(mascotPose(input({ attempts: [attempt("1", "started", NOW - 2 * 60_000)] }), NOW), "idle");
  assert.equal(mascotPose(input({ attempts: [attempt("1", "verified")] }), NOW), "idle");
});

test("alert beats away, which beats warming, sleeping and hungry", () => {
  const full = { a: usage("a", 100), b: usage("b", 100) };
  const all = input({ desktop: desktop({ busy: true }), attempts: [attempt("1", "started")], usage: full });
  assert.equal(mascotPose(all, NOW), "away");
  assert.equal(mascotPose({ ...all, desktop: desktop({ busy: true, recoveryRequired: true }) }, NOW), "alert");
  assert.equal(mascotPose({ ...all, desktop: desktop({ busy: true, error: "Claude Desktop data could not be read." }) }, NOW), "alert");
  assert.equal(mascotPose(input({ desktop: desktop({ available: false }) }), NOW), "alert");
  assert.equal(mascotPose(input({ attempts: [attempt("1", "started")], usage: full }), NOW), "warming");
  assert.equal(mascotPose(input({ usage: full }), NOW), "sleeping");
});

test("only the active account needing sign-in raises the alert", () => {
  for (const extra of [
    { connectionRenewalRequired: true },
    { issue: "renewal-required" as const },
    { issue: "expired" as const },
    { issue: "identity-mismatch" as const },
  ])
    assert.equal(mascotPose(input({ usage: { a: usage("a", 20, 10, extra), b: usage("b", 30) } }), NOW), "alert");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 20), b: usage("b", 30, 10, { issue: "expired" }) } }), NOW), "idle");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 20, 10, { issue: "rate-limited" }), b: usage("b", 30) } }), NOW), "idle");
});

test("the panel head follows the pose", () => {
  assert.deepEqual(
    (["alert", "away", "warming", "sleeping", "hungry", "idle"] as const).map(headFor),
    ["alert", "idle", "idle", "sleep", "hungry", "idle"],
  );
});

test("the first step only remembers", () => {
  const step = mascotStep(undefined, busy(), NOW);
  assert.equal(step.pose, "away");
  assert.equal(step.event, undefined);
  assert.deepEqual(step.memory.busyFrom, { activeProfileId: "a", errorRevision: 0, recoveryRequired: false, unseen: true });
});

test("an operation already running when Relay opens reports nothing, then later operations report as usual", () => {
  assert.deepEqual(
    events(busy(), at({ activeProfileId: "b" }), busy({ activeProfileId: "b" }), at({ activeProfileId: "b" })),
    [undefined, undefined, "left", "back"],
  );
});

test("a switch leaves, then reports the new account even when it changed mid-switch", () => {
  assert.deepEqual(
    events(input(), busy(), busy({ activeProfileId: "b" }), at({ activeProfileId: "b" })),
    [undefined, "left", undefined, "switched"],
  );
});

test("an operation that keeps the account comes back", () => {
  assert.deepEqual(events(input(), busy(), input()), [undefined, "left", "back"]);
  assert.deepEqual(events(input(), busy(), at({ activeProfileId: undefined })), [undefined, "left", "back"]);
});

test("a new error or recovery fails the operation; an old error or a cleared read error does not", () => {
  assert.deepEqual(
    events(input(), busy(), at({ activeProfileId: "b", error: "Switch failed", errorRevision: 1 })),
    [undefined, "left", "failed"],
  );
  assert.deepEqual(events(input(), busy(), at({ recoveryRequired: true })), [undefined, "left", "failed"]);
  const old = { error: "Earlier failure", errorRevision: 3 };
  assert.deepEqual(
    events(at(old), busy(old), at({ ...old, activeProfileId: "b" })),
    [undefined, "left", "switched"],
  );
  assert.deepEqual(events(input(), busy({ errorRevision: 1 }), at({ errorRevision: 1 })), [undefined, "left", "back"]);
});

test("an operation between two polls still reports how it ended", () => {
  assert.deepEqual(events(at({}, 0), at({ activeProfileId: "b" }, 1)), [undefined, "switched"]);
  assert.deepEqual(events(at({}, 0), at({}, 1)), [undefined, "back"]);
  assert.deepEqual(events(at({}, 0), at({ error: "Switch failed", errorRevision: 1 }, 1)), [undefined, "failed"]);
});

test("an operation counted while Desktop is busy leaves, then ends as usual", () => {
  assert.deepEqual(
    events(at({}, 0), input({ desktop: desktop({ busy: true }), desktopOperations: 1 }), at({ activeProfileId: "b" }, 1)),
    [undefined, "left", "switched"],
  );
});

test("an account change without a Relay operation is no event", () => {
  assert.deepEqual(events(at({}, 2), at({}, 2), at({ activeProfileId: "b" }, 2)), [undefined, undefined, undefined]);
});

test("the first step with a counter only remembers it", () => {
  const step = mascotStep(undefined, at({}, 4), NOW);
  assert.equal(step.event, undefined);
  assert.equal(step.memory.desktopOperations, 4);
});

test("a snapshot without Desktop state keeps an operation open", () => {
  assert.deepEqual(
    events(input(), busy(), input({ desktop: undefined }), at({ activeProfileId: "b" })),
    [undefined, "left", undefined, "switched"],
  );
});

test("the menu bar has six head frames and every pose shows one", () => {
  assert.deepEqual([...MASCOT_FRAMES], ["idle", "blink", "hungry", "sleep", "alert", "away"]);
  assert.deepEqual(POSE_FRAME, {
    idle: "idle", warming: "idle", hungry: "hungry", sleeping: "sleep", alert: "alert", away: "away",
  });
  assert.equal(BLINK_FRAME, "blink");
});
