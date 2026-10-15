import test from "node:test";
import assert from "node:assert/strict";
import { headFor, mascotPose, mascotStep, type MascotInput, type MascotMemory } from "../shared/mascot";
import {
  CUE_SEQUENCE, DISGUISES, MASCOT_FRAMES, POSE_FIDGETS, POSE_FRAME, POSE_LOOP, returnSequence,
  type MascotSequence,
} from "../shared/mascot-frames";
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
const cues = (...inputs: MascotInput[]) => {
  let memory: MascotMemory | undefined;
  return inputs.map((i) => {
    const step = mascotStep(memory, i, NOW);
    memory = step.memory;
    return step.cue;
  });
};
const busy = (extra: Partial<DesktopState> = {}) => input({ desktop: desktop({ busy: true, ...extra }) });

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
  const step = mascotStep(undefined, input({ desktop: desktop({ busy: true }), attempts: [attempt("1", "verified")] }), NOW);
  assert.equal(step.pose, "away");
  assert.equal(step.cue, undefined);
  assert.deepEqual(step.memory.busyFrom, { activeProfileId: "a" });
  assert.deepEqual(step.memory.attempts, { "1": "verified" });
});

test("a switch leaves through the door and returns, even when the account changed mid-switch", () => {
  assert.deepEqual(
    cues(input(), busy(), busy({ activeProfileId: "b" }), input({ desktop: desktop({ activeProfileId: "b" }) })),
    [undefined, "leave", undefined, "return"],
  );
});

test("an operation that keeps the account, or a failed switch, has no return", () => {
  assert.deepEqual(cues(input(), busy(), input()), [undefined, "leave", undefined]);
  assert.deepEqual(cues(input(), busy(), input({ desktop: desktop({ activeProfileId: undefined }) })), [undefined, "leave", undefined]);
  assert.deepEqual(
    cues(input(), busy(), input({ desktop: desktop({ activeProfileId: "b", error: "Switch failed" }) })),
    [undefined, "leave", "rise"],
  );
});

test("a switch shorter than the poll interval still returns", () => {
  const ops = (desktopOperations: number, extra: Partial<DesktopState> = {}) =>
    input({ desktop: desktop(extra), desktopOperations });
  assert.deepEqual(cues(ops(3), ops(4, { activeProfileId: "b" })), [undefined, "return"]);
  // Two operations between two polls count the same as one.
  assert.deepEqual(cues(ops(3), ops(5, { activeProfileId: "b" }), ops(5, { activeProfileId: "b" })), [undefined, "return", undefined]);
  // A fast switch that failed raises the alert instead.
  assert.deepEqual(cues(ops(3), ops(4, { activeProfileId: "b", error: "Switch failed" })), [undefined, "rise"]);
});

test("an operation shorter than the poll interval that keeps the account stays quiet", () => {
  const ops = (desktopOperations: number, extra: Partial<DesktopState> = {}) =>
    input({ desktop: desktop(extra), desktopOperations });
  assert.deepEqual(cues(ops(3), ops(4)), [undefined, undefined]);
  assert.deepEqual(cues(ops(3), ops(4, { activeProfileId: undefined })), [undefined, undefined]);
});

test("an operation counted while Desktop is busy leaves, then returns as usual", () => {
  const ops = (desktopOperations: number, extra: Partial<DesktopState> = {}) =>
    input({ desktop: desktop(extra), desktopOperations });
  assert.deepEqual(
    cues(ops(3), ops(4, { busy: true }), ops(4, { busy: true, activeProfileId: "b" }), ops(4, { activeProfileId: "b" })),
    [undefined, "leave", undefined, "return"],
  );
});

test("a counter that does not advance keeps the busy-only behaviour", () => {
  const ops = (desktopOperations: number, extra: Partial<DesktopState> = {}) =>
    input({ desktop: desktop(extra), desktopOperations });
  // The account changed with no Desktop operation (for example in Claude itself): no return.
  assert.deepEqual(cues(ops(3), ops(3, { activeProfileId: "b" })), [undefined, undefined]);
  assert.deepEqual(
    cues(ops(3), ops(3, { busy: true }), ops(3, { activeProfileId: "b" })),
    [undefined, "leave", "return"],
  );
  // A snapshot without a count neither starts nor forgets one.
  assert.deepEqual(cues(ops(3), input(), ops(4, { activeProfileId: "b" })), [undefined, undefined, "return"]);
});

test("the first step with a counter only remembers it", () => {
  const step = mascotStep(undefined, input({ desktop: desktop({ activeProfileId: "b" }), desktopOperations: 7 }), NOW);
  assert.equal(step.cue, undefined);
  assert.equal(step.memory.desktopOperations, 7);
});

test("a finished warm-up stretches once, even between two snapshots", () => {
  const done = input({ attempts: [attempt("1", "verified")] });
  assert.deepEqual(cues(input(), done, done), [undefined, "stretch", undefined]);
  assert.deepEqual(
    cues(input({ attempts: [attempt("1", "started")] }), input({ attempts: [attempt("1", "sent-unverified")] })),
    [undefined, "stretch"],
  );
  assert.deepEqual(cues(input(), input({ attempts: [attempt("1", "failed")] })), [undefined, undefined]);
});

test("a refilled limit munches bamboo, but a change of account does not", () => {
  const hungry = input({ usage: { a: usage("a", 95), b: usage("b", 30) } });
  const asleep = input({ usage: { a: usage("a", 100), b: usage("b", 100) } });
  assert.deepEqual(cues(input(), hungry, input()), [undefined, "rumble", "munch"]);
  assert.deepEqual(cues(input(), asleep, input()), [undefined, "curl", "munch"]);
  assert.deepEqual(cues(input(), hungry, input({ desktop: desktop({ activeProfileId: "b" }) })), [undefined, "rumble", undefined]);
});

test("usage that merely goes stale or fails does not munch", () => {
  const hungry = input({ usage: { a: usage("a", 95), b: usage("b", 30) } });
  const asleep = input({ usage: { a: usage("a", 100), b: usage("b", 100) } });
  for (const extra of [
    { checkedAt: iso(NOW - 36 * 60_000) },
    { stale: true },
    { status: "error" as const },
  ]) {
    assert.deepEqual(cues(input(), hungry, input({ usage: { a: usage("a", 95, 10, extra), b: usage("b", 30) } })), [undefined, "rumble", undefined], JSON.stringify(extra));
    assert.deepEqual(cues(input(), asleep, input({ usage: { a: usage("a", 100, 10, extra), b: usage("b", 100, 10, extra) } })), [undefined, "curl", undefined], JSON.stringify(extra));
  }
  // The other account going stale wakes the panda, but the active one is still full.
  const weekFull = input({ usage: { a: usage("a", 20, 100), b: usage("b", 100) } });
  assert.deepEqual(
    cues(input(), weekFull, input({ usage: { a: usage("a", 20, 100), b: usage("b", 100, 10, { stale: true }) } })),
    [undefined, "curl", undefined],
  );
});

test("a passed reset munches, from hunger and from sleep", () => {
  const passed = { resetsAt: iso(NOW - 1_000) };
  const hungry = input({ usage: { a: usage("a", 95), b: usage("b", 30) } });
  const asleep = input({ usage: { a: usage("a", 100), b: usage("b", 100) } });
  assert.deepEqual(
    cues(input(), hungry, input({ usage: { a: usage("a", 95, 10, { fiveHour: { usedPercent: 95, ...passed } }), b: usage("b", 30) } })),
    [undefined, "rumble", "munch"],
  );
  // The active account is full for the week; the other one's five hours reset.
  const weekAsleep = input({ usage: { a: usage("a", 20, 100), b: usage("b", 100) } });
  assert.deepEqual(
    cues(input(), weekAsleep, input({ usage: { a: usage("a", 20, 100), b: usage("b", 100, 10, { fiveHour: { usedPercent: 100, ...passed } }) } })),
    [undefined, "curl", "munch"],
  );
  const weekFull = input({ usage: { a: usage("a", 20, 100), b: usage("b", 30, 100) } });
  assert.deepEqual(
    cues(input(), weekFull, input({ usage: { a: usage("a", 20, 100, { sevenDay: { usedPercent: 100, ...passed } }), b: usage("b", 30, 100) } })),
    [undefined, "curl", "munch"],
  );
  // A passed reset of a window that was not full is no refill.
  assert.deepEqual(
    cues(input(), asleep, input({ usage: { a: usage("a", 100, 10, { sevenDay: { usedPercent: 10, ...passed } }), b: usage("b", 100) } })),
    [undefined, "curl", undefined],
  );
});

test("a fresh refill munches, from hunger and from sleep", () => {
  const hungry = input({ usage: { a: usage("a", 95), b: usage("b", 30) } });
  const weekAsleep = input({ usage: { a: usage("a", 20, 100), b: usage("b", 100) } });
  assert.deepEqual(cues(input(), hungry, input({ usage: { a: usage("a", 5), b: usage("b", 30) } })), [undefined, "rumble", "munch"]);
  assert.deepEqual(cues(input(), weekAsleep, input({ usage: { a: usage("a", 20, 100), b: usage("b", 0) } })), [undefined, "curl", "munch"]);
  assert.deepEqual(cues(input(), weekAsleep, input({ usage: { a: usage("a", 20, 0), b: usage("b", 100) } })), [undefined, "curl", "munch"]);
});

test("entering alert, sleep and hunger plays their one-off once", () => {
  const hungry = input({ usage: { a: usage("a", 95), b: usage("b", 30) } });
  const asleep = input({ usage: { a: usage("a", 100), b: usage("b", 100) } });
  const alert = input({ desktop: desktop({ recoveryRequired: true }) });
  assert.deepEqual(
    cues(input(), hungry, hungry, asleep, asleep, alert, alert),
    [undefined, "rumble", undefined, "curl", undefined, "rise", undefined],
  );
});

test("every sequence uses known frames and every frame is used", () => {
  assert.equal(MASCOT_FRAMES.length, 56);
  const known = new Set<string>(MASCOT_FRAMES);
  const sequences = [
    ...Object.values(POSE_LOOP),
    ...Object.values(CUE_SEQUENCE),
    ...DISGUISES.map(returnSequence),
    ...Object.values(POSE_FIDGETS).flat(),
  ].filter((s): s is MascotSequence => !!s);
  const used = new Set<string>([...sequences.flatMap((s) => s.frames), ...Object.values(POSE_FRAME)]);
  for (const frame of used) assert.ok(known.has(frame), frame);
  assert.deepEqual(MASCOT_FRAMES.filter((f) => !used.has(f)), []);
  assert.deepEqual(returnSequence("shades").frames, [
    "enter-shades-0", "enter-shades-1", "enter-shades-1", "enter-shades-1",
    "toss-shades-0", "toss-shades-1", "bow-0", "bow-1", "bow-1",
  ]);
});
