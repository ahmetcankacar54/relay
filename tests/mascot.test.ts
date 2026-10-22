import test from "node:test";
import assert from "node:assert/strict";
import { HUNGRY_PERCENT, READING_MAX_AGE_MS, headFor, mascotPose, mascotRest, type MascotInput } from "../shared/mascot";
import { TRAY_RESET_FROM } from "../shared/tray";
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

test("the panda idles when nothing needs showing", () => {
  assert.equal(mascotPose(input(), NOW), "idle");
  assert.equal(mascotPose(input({ desktop: undefined }), NOW), "idle");
  assert.equal(mascotPose({ accounts: [], usage: {}, desktop: desktop({ activeProfileId: undefined }) }, NOW), "idle");
});

test("the panda gets hungry where the menu bar title starts counting down, 80 % of the five-hour window", () => {
  assert.equal(HUNGRY_PERCENT, TRAY_RESET_FROM);
  assert.equal(mascotPose(input({ usage: { a: usage("a", 79.9), b: usage("b", 30) } }), NOW), "idle");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 80), b: usage("b", 30) } }), NOW), "hungry");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 99.9), b: usage("b", 30) } }), NOW), "hungry");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 20, 95), b: usage("b", 30) } }), NOW), "idle");
});

test("a full five-hour window, or every account full, shows the full face", () => {
  assert.equal(mascotPose(input({ usage: { a: usage("a", 100) } }), NOW), "full");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 100), b: usage("b", 30) } }), NOW), "full");
  // Every account full, though the active one's five-hour window is not.
  assert.equal(mascotPose(input({ usage: { a: usage("a", 40, 100), b: usage("b", 100) } }), NOW), "full");
  // Only the active account's five-hour window counts on its own.
  assert.equal(mascotPose(input({ usage: { a: usage("a", 40), b: usage("b", 100) } }), NOW), "idle");
  assert.equal(mascotPose(input({ usage: { a: usage("a", 40, 100), b: usage("b", 100, 10, { stale: true }) } }), NOW), "idle");
});

test("the panda sleeps when Claude is closed or the active account's reading failed or is old", () => {
  assert.equal(mascotPose(input({ desktop: desktop({ running: false }) }), NOW), "sleeping");
  assert.equal(mascotRest(input({ desktop: desktop({ running: false }) }), NOW), "closed");
  const old = usage("a", 20, 10, { checkedAt: iso(NOW - READING_MAX_AGE_MS) });
  assert.equal(mascotPose(input({ usage: { a: old, b: usage("b", 30) } }), NOW), "sleeping");
  assert.equal(mascotRest(input({ usage: { a: old, b: usage("b", 30) } }), NOW), "unknown");
  const recent = usage("a", 20, 10, { checkedAt: iso(NOW - READING_MAX_AGE_MS + 60_000) });
  assert.equal(mascotPose(input({ usage: { a: recent, b: usage("b", 30) } }), NOW), "idle");
  for (const extra of [{ stale: true }, { status: "error" as const, issue: "rate-limited" as const }])
    assert.equal(mascotPose(input({ usage: { a: usage("a", 95, 10, extra), b: usage("b", 30) } }), NOW), "sleeping");
  // A refresh in progress keeps its reading; a first reading still to come, or a reset that passed, is no reason.
  assert.equal(mascotPose(input({ usage: { a: usage("a", 95, 10, { status: "loading" }), b: usage("b", 30) } }), NOW), "hungry");
  assert.equal(mascotPose(input({ usage: { b: usage("b", 30) } }), NOW), "idle");
  assert.equal(mascotPose(input({ usage: { a: { accountId: "a", status: "loading", stale: false }, b: usage("b", 30) } }), NOW), "idle");
  const reset = usage("a", 100, 10, { fiveHour: { usedPercent: 100, resetsAt: iso(NOW - 60_000) } });
  assert.equal(mascotPose(input({ usage: { a: reset, b: usage("b", 30) } }), NOW), "idle");
  // No saved account open, or no Desktop state yet: no reason either.
  assert.equal(mascotPose(input({ desktop: desktop({ activeProfileId: undefined }), usage: {} }), NOW), "idle");
});

test("warming lasts while a start is under two minutes old", () => {
  assert.equal(mascotPose(input({ attempts: [attempt("1", "started")] }), NOW), "warming");
  assert.equal(mascotPose(input({ attempts: [attempt("1", "started", NOW - 2 * 60_000)] }), NOW), "idle");
  assert.equal(mascotPose(input({ attempts: [attempt("1", "verified")] }), NOW), "idle");
});

test("alert beats away, which beats warming, sleeping, full and hungry", () => {
  const full = { a: usage("a", 100), b: usage("b", 100) };
  const all = input({ desktop: desktop({ busy: true }), attempts: [attempt("1", "started")], usage: full });
  assert.equal(mascotPose(all, NOW), "away");
  assert.equal(mascotPose({ ...all, desktop: desktop({ busy: true, recoveryRequired: true }) }, NOW), "alert");
  assert.equal(mascotPose({ ...all, desktop: desktop({ busy: true, error: "Claude Desktop data could not be read." }) }, NOW), "alert");
  assert.equal(mascotPose(input({ desktop: desktop({ available: false }) }), NOW), "alert");
  assert.equal(mascotPose(input({ attempts: [attempt("1", "started")], usage: full }), NOW), "warming");
  assert.equal(mascotPose(input({ usage: full }), NOW), "full");
  assert.equal(mascotPose(input({ usage: full, desktop: desktop({ running: false }) }), NOW), "sleeping");
  assert.equal(mascotPose({ ...all, desktop: desktop({ busy: true, running: false }) }, NOW), "away");
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

test("a connection flag left over from before is no alert while the service is rate-limited or down", () => {
  for (const issue of ["rate-limited", "unavailable"] as const)
    assert.equal(
      mascotPose(input({ usage: { a: usage("a", 20, 10, { issue, connectionRenewalRequired: true }), b: usage("b", 30) } }), NOW),
      "idle",
      issue,
    );
  // The flag alone, with no reported issue, still asks for a sign-in.
  assert.equal(
    mascotPose(input({ usage: { a: usage("a", 20, 10, { connectionRenewalRequired: true }), b: usage("b", 30) } }), NOW),
    "alert",
  );
  // A reported sign-in issue is an alert with or without the flag.
  assert.equal(
    mascotPose(input({ usage: { a: usage("a", 20, 10, { issue: "expired", connectionRenewalRequired: true }), b: usage("b", 30) } }), NOW),
    "alert",
  );
});

test("a usage sign-in that belongs to another account alerts on the active account, whatever the read says", () => {
  const stamp = iso(NOW);
  const desktopId = { accountUuid: "u-desktop", orgId: "o-1", savedAt: stamp };
  const mismatched = {
    ...account("a"),
    desktop: desktopId,
    auth: { loggedIn: true, accountUuid: "u-other", orgId: "o-1", checkedAt: stamp },
  } as Account;
  const matching = {
    ...account("a"),
    desktop: desktopId,
    auth: { loggedIn: true, accountUuid: "u-desktop", orgId: "o-1", checkedAt: stamp },
  } as Account;
  for (const extra of [{}, { issue: "keychain-locked" as const }, { issue: "rate-limited" as const }])
    assert.equal(
      mascotPose(input({ accounts: [mismatched, account("b")], usage: { a: usage("a", 20, 10, extra), b: usage("b", 30) } }), NOW),
      "alert",
      JSON.stringify(extra),
    );
  assert.equal(mascotPose(input({ accounts: [matching, account("b")] }), NOW), "idle");
  // A mismatch on an account that is not active is no alert.
  assert.equal(
    mascotPose(input({ accounts: [account("a"), { ...mismatched, id: "b", name: "b" }] }), NOW),
    "idle",
  );
});

test("a locked Keychain is a sign-in problem, with or without a retained flag", () => {
  for (const extra of [
    { issue: "keychain-locked" as const },
    { issue: "keychain-locked" as const, connectionRenewalRequired: true },
  ])
    assert.equal(
      mascotPose(input({ usage: { a: usage("a", 20, 10, extra), b: usage("b", 30) } }), NOW),
      "alert",
      JSON.stringify(extra),
    );
});

test("the panel head follows the pose", () => {
  assert.deepEqual(
    (["alert", "away", "warming", "sleeping", "full", "hungry", "idle"] as const).map(headFor),
    ["alert", "idle", "idle", "sleep", "hungry", "hungry", "idle"],
  );
});

test("the menu bar has seven head frames and every pose shows one", () => {
  assert.deepEqual([...MASCOT_FRAMES], ["idle", "blink", "hungry", "sleep", "alert", "away", "full"]);
  assert.deepEqual(POSE_FRAME, {
    idle: "idle", warming: "idle", hungry: "hungry", full: "full", sleeping: "sleep", alert: "alert", away: "away",
  });
  assert.equal(BLINK_FRAME, "blink");
});
