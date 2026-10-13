import test from "node:test";
import assert from "node:assert/strict";
import type { Account, AccountUsage } from "../shared/types";
import {
  planCapacity,
  workdayPlan,
  wallTime,
  validWorkday,
} from "../shared/planning";
import {
  planningAccount,
  planningUsage,
  planningSettings,
} from "./planning-fixtures";
const NOW = Date.parse("2026-10-13T05:59:45Z");
test("preview and saved schedule agree that minute and reserve controls require whole numbers", () => {
  for (const key of [
    "reservePercent",
    "staggerMinutes",
    "warmupLeadMinutes",
  ] as const) {
    assert.equal(validWorkday({ ...planningSettings(), [key]: 1.5 }), false);
  }
});
test("plan weights are ratios, Team and unknown need their explicit manual capacity", () => {
  for (const [plan, expected] of [
    ["pro", 1],
    ["max5", 5],
    ["max20", 20],
  ] as const) {
    const a = planningAccount("a", plan);
    a.planning!.capacityWeight = 99;
    assert.equal(planCapacity(a), expected);
  }
  const a = planningAccount("a", "team");
  assert.equal(planCapacity(a), 1);
  a.planning!.capacityWeight = 12;
  assert.equal(planCapacity(a), 12);
  a.planning!.capacityWeight = NaN;
  assert.equal(planCapacity(a), 1);
});
test("rankings compare quota after reserve, account capacity and imminent weekly reset", () => {
  const a = planningAccount("a"),
    b = planningAccount("b", "max5"),
    c = planningAccount("c", "max20");
  const usage = Object.fromEntries(
    [a, b, c].map((x) => [x.id, planningUsage(x)]),
  );
  const plan = workdayPlan(
    [a, b, c],
    usage,
    planningSettings([a.id, b.id, c.id]),
    NOW,
  );
  assert.deepEqual(
    plan.rankings.map((r) => r.accountId),
    ["c", "b", "a"],
  );
  assert.equal(plan.rankings[0].score / plan.rankings[2].score, 20);
  usage.a.sevenDay!.resetsAt = new Date(NOW + 60_000).toISOString();
  const urgent = workdayPlan([a], usage, planningSettings(), NOW).rankings[0]
    .score;
  assert.ok(urgent > plan.rankings[2].score);
  usage.c.sevenDay!.usedPercent = 99;
  assert.equal(
    workdayPlan([c], usage, planningSettings([c.id]), NOW).rankings[0].reason,
    "reserve",
  );
});
test("stale, incomplete, expired, future-dated and mismatched quotas cannot rank", () => {
  const cases: [string, (a: Account, u: AccountUsage) => void][] = [
    [
      "usage-not-fresh",
      (_, u) => {
        u.checkedAt = new Date(NOW - 300_000).toISOString();
      },
    ],
    [
      "usage-not-fresh",
      (_, u) => {
        u.checkedAt = new Date(NOW + 1).toISOString();
      },
    ],
    [
      "usage-incomplete",
      (_, u) => {
        u.sevenDay = undefined;
      },
    ],
    [
      "usage-incomplete",
      (_, u) => {
        u.fiveHour!.usedPercent = NaN;
      },
    ],
    [
      "usage-not-fresh",
      (_, u) => {
        u.sevenDay!.resetsAt = new Date(NOW).toISOString();
      },
    ],
    [
      "usage-incomplete",
      (_, u) => {
        u.fiveHour!.usedPercent = 20;
      },
    ],
    [
      "cooldown",
      (a) => {
        a.cooldownUntil = new Date(NOW + 1).toISOString();
      },
    ],
    [
      "auth-required",
      (a) => {
        a.auth!.loggedIn = false;
      },
    ],
    [
      "identity-mismatch",
      (a) => {
        a.desktop = { accountUuid: "wrong", orgId: "wrong", savedAt: "" };
      },
    ],
  ];
  for (const [reason, change] of cases) {
    const a = planningAccount(),
      u = planningUsage(a);
    change(a, u);
    const rank = workdayPlan([a], { a: u }, planningSettings(), NOW)
      .rankings[0];
    assert.equal(rank.reason, reason);
    assert.equal(rank.score, 0);
  }
});
test("duplicate saved profiles for one identity never plan two eligible messages", () => {
  const a = planningAccount(),
    b = { ...a, id: "b" };
  const plan = workdayPlan(
    [a, b],
    { a: planningUsage(a), b: planningUsage(b) },
    planningSettings(["a", "b"]),
    NOW,
  );
  assert.equal(
    plan.rankings.find((r) => r.accountId === "b")!.reason,
    "duplicate-identity",
  );
});
test("staggered times remain stable if another account becomes ineligible", () => {
  const a = planningAccount(),
    b = planningAccount("b");
  const u = { a: planningUsage(a), b: planningUsage(b) };
  const settings = planningSettings(["a", "b"]);
  settings.warmupLeadMinutes = 300;
  const before = workdayPlan([a, b], u, settings, NOW);
  assert.equal(before.slots[0].scheduledAt, "2026-10-13T01:00:00.000Z");
  assert.equal(before.slots[0].expectedResetAt, "2026-10-13T06:00:00.000Z");
  a.auth!.loggedIn = false;
  const after = workdayPlan([a, b], u, settings, NOW);
  assert.equal(
    after.slots.find((s) => s.accountId === "b")!.scheduledAt,
    before.slots[1].scheduledAt,
  );
});
test("overnight weekdays belong to the start day, and equal times form a 24h day", () => {
  const a = planningAccount(),
    settings = planningSettings();
  settings.start = "22:00";
  settings.end = "06:00";
  settings.weekdays = [1];
  const now = Date.parse("2026-10-13T00:00:00Z");
  const plan = workdayPlan([a], { a: planningUsage(a, now) }, settings, now);
  assert.equal(plan.date, "2026-10-12");
  assert.equal(plan.startsAt, "2026-10-12T19:00:00.000Z");
  assert.equal(plan.endsAt, "2026-10-13T03:00:00.000Z");
  settings.start = settings.end = "00:00";
  settings.weekdays = [0, 1, 2, 3, 4, 5, 6];
  const full = workdayPlan([a], { a: planningUsage(a, now) }, settings, now);
  assert.equal(
    Date.parse(full.endsAt!) - Date.parse(full.startsAt!),
    86_400_000,
  );
});
test("DST uses the first repeated clock time, skips nonexistent times and uses local dates", () => {
  assert.equal(wallTime("2026-03-08", "02:30", "America/New_York"), undefined);
  assert.equal(
    wallTime("2026-11-01", "01:30", "America/New_York"),
    Date.parse("2026-11-01T05:30:00Z"),
  );
  assert.equal(
    wallTime("2026-10-13", "00:00", "Pacific/Kiritimati"),
    Date.parse("2026-10-12T10:00:00Z"),
  );
  const a = planningAccount(),
    settings = planningSettings();
  settings.timeZone = "America/New_York";
  settings.start = settings.end = "00:00";
  const now = Date.parse("2026-03-08T12:00:00Z");
  const plan = workdayPlan([a], { a: planningUsage(a, now) }, settings, now);
  assert.equal(
    Date.parse(plan.endsAt!) - Date.parse(plan.startsAt!),
    23 * 3_600_000,
  );
});
test("an observed server window is labelled active and its reset is not replaced by the estimate", () => {
  const a = planningAccount(),
    u = planningUsage(a);
  u.fiveHour!.resetsAt = new Date(NOW + 10_000).toISOString();
  const plan = workdayPlan([a], { a: u }, planningSettings(), NOW);
  assert.equal(plan.slots[0].reason, "already-active");
  assert.equal(u.fiveHour!.resetsAt, new Date(NOW + 10_000).toISOString());
});
