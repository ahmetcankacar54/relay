import test from "node:test";
import assert from "node:assert/strict";
import type { Account, AccountUsage } from "../shared/types";
import {
  continuationTargetScore,
  rankContinuationTargets,
} from "../shared/continuation-target-ranking";
import { planningAccount, planningUsage } from "./planning-fixtures";

function usageFor(
  account: Account,
  fiveHourUsed: number,
  sevenDayUsed: number,
): AccountUsage {
  return {
    ...planningUsage(account),
    fiveHour: { usedPercent: fiveHourUsed },
    sevenDay: { usedPercent: sevenDayUsed },
  };
}

test("continuation targets weigh both quota windows by relative plan capacity", () => {
  const pro = planningAccount("pro", "pro");
  const max5 = planningAccount("max5", "max5");
  const max20 = planningAccount("max20", "max20");
  assert.equal(continuationTargetScore(pro, usageFor(pro, 20, 50)), 0.5);
  assert.equal(continuationTargetScore(max5, usageFor(max5, 50, 20)), 2.5);
  assert.equal(continuationTargetScore(max20, usageFor(max20, 20, 50)), 10);
  assert.equal(continuationTargetScore(max20, usageFor(max20, 100, 0)), 0);
  assert.equal(continuationTargetScore(max20, usageFor(max20, 0, 100)), 0);
});

test("manual Team and unknown capacity reuse the planner's bounded weights", () => {
  for (const plan of ["team", "unknown"] as const) {
    const account = planningAccount(plan, plan);
    account.planning!.capacityWeight = 12;
    assert.equal(continuationTargetScore(account, usageFor(account, 50, 0)), 6);
    account.planning!.capacityWeight = 200;
    assert.equal(
      continuationTargetScore(account, usageFor(account, 0, 0)),
      100,
    );
    account.planning!.capacityWeight = NaN;
    assert.equal(continuationTargetScore(account, usageFor(account, 0, 0)), 1);
  }
});

test("unknown or invalid live quotas score zero rather than inferring capacity", () => {
  const account = planningAccount("max", "max20");
  assert.equal(continuationTargetScore(account, undefined), 0);
  const withoutFiveHour = usageFor(account, 0, 0);
  delete withoutFiveHour.fiveHour;
  assert.equal(continuationTargetScore(account, withoutFiveHour), 0);
  // A seat that reports no weekly window is scored by its five-hour window alone.
  const withoutWeekly = usageFor(account, 40, 0);
  delete withoutWeekly.sevenDay;
  assert.equal(
    continuationTargetScore(account, withoutWeekly),
    continuationTargetScore(account, usageFor(account, 40, 40)),
  );
  for (const window of ["fiveHour", "sevenDay"] as const) {
    for (const invalid of [NaN, Infinity, -1, 100.1]) {
      const usage = usageFor(account, 0, 0);
      usage[window]!.usedPercent = invalid;
      assert.equal(continuationTargetScore(account, usage), 0);
    }
  }
  for (const invalid of [
    { ...usageFor(account, 0, 0), stale: true },
    { ...usageFor(account, 0, 0), accountId: "another-account" },
    ...(["idle", "loading", "error"] as const).map((status) => ({
      ...usageFor(account, 0, 0),
      status,
    })),
  ])
    assert.equal(continuationTargetScore(account, invalid), 0);
  const historical: AccountUsage = {
    accountId: account.id,
    status: "error",
    stale: true,
    lastKnownResets: {
      fiveHour: {
        checkedAt: "2026-10-13T00:00:00Z",
        resetsAt: "2026-10-13T05:00:00Z",
      },
    },
  };
  assert.equal(continuationTargetScore(account, historical), 0);
});

test("ranking is descending capacity, then remaining quota, then account ID", () => {
  const larger = planningAccount("larger", "max20");
  const smaller = planningAccount("smaller", "max5");
  const a = planningAccount("a", "pro");
  const b = planningAccount("b", "pro");
  const candidates = [
    { account: b, usage: usageFor(b, 0, 0) },
    { account: smaller, usage: usageFor(smaller, 80, 0) },
    { account: larger, usage: usageFor(larger, 50, 0) },
    { account: a, usage: usageFor(a, 0, 0) },
  ];
  const ranked = rankContinuationTargets(candidates);
  assert.deepEqual(
    ranked.map(({ account }) => account.id),
    ["larger", "a", "b", "smaller"],
  );
  assert.deepEqual(
    ranked.map(({ score, remainingPercent }) => [score, remainingPercent]),
    [
      [10, 50],
      [1, 100],
      [1, 100],
      [1, 20],
    ],
  );
  assert.deepEqual(
    candidates.map(({ account }) => account.id),
    ["b", "smaller", "larger", "a"],
  );
  assert.deepEqual(rankContinuationTargets([]), []);
  assert.deepEqual(
    rankContinuationTargets([...candidates].reverse()).map(
      ({ account }) => account.id,
    ),
    ranked.map(({ account }) => account.id),
  );
});
