import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
} from "../shared/types";
import {
  continuationTargetScore,
  rankContinuationTargets,
} from "../shared/continuation-target-ranking";
import { chooseTarget } from "../electron/core/fleet-continuation";
import { suggestedAccount } from "../shared/usage";
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

// The switch rule with a context: soonest reset among accounts that hold half
// an hour at the current tempo (else 10% left), closed windows after them.
const NOW = Date.parse("2026-10-13T06:00:00Z");
const MINUTE = 60_000,
  HOUR = 3_600_000;
/** `left`% of the five-hour window left, open until `resetsIn` (closed without). */
function windowUsage(
  account: Account,
  left: number,
  resetsIn?: number,
): AccountUsage {
  return {
    ...planningUsage(account, NOW),
    fiveHour: {
      usedPercent: 100 - left,
      ...(resetsIn === undefined
        ? {}
        : { resetsAt: new Date(NOW + resetsIn).toISOString() }),
    },
    sevenDay: {
      usedPercent: 0,
      resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
    },
  };
}
const order = (ranked: { account: Account }[]) =>
  ranked.map(({ account }) => account.name);

test("with the tempo the open window that resets soonest leads when it holds half an hour", () => {
  const max5 = planningAccount("max5", "max5");
  const pro = planningAccount("pro", "pro");
  const candidates = [
    { account: max5, usage: windowUsage(max5, 50, 4 * HOUR) },
    { account: pro, usage: windowUsage(pro, 80, 1 * HOUR) },
  ];
  // Without a context: capacity × remaining (250 vs 80 Pro units).
  assert.deepEqual(order(rankContinuationTargets(candidates)), ["max5", "pro"]);
  // 80 Pro units cover half an hour at 60 units/h and are lost at the reset.
  assert.deepEqual(
    order(rankContinuationTargets(candidates, { now: NOW, rate: 60 })),
    ["pro", "max5"],
  );
});

test("accounts short of half an hour are skipped and closed windows follow every open one", () => {
  const short = planningAccount("short", "pro");
  const max5 = planningAccount("max5", "max5");
  const late = planningAccount("late", "pro");
  const max20 = planningAccount("max20", "max20");
  const closedPro = planningAccount("closed-pro", "pro");
  const expired = planningAccount("expired", "pro");
  const tiny = planningAccount("tiny", "max5");
  const candidates = [
    { account: max20, usage: windowUsage(max20, 100) },
    { account: closedPro, usage: windowUsage(closedPro, 100) },
    { account: late, usage: windowUsage(late, 90, 4 * HOUR) },
    // 20 Pro units < 30 (half an hour at 60/h), although it resets first.
    { account: short, usage: windowUsage(short, 20, 10 * MINUTE) },
    { account: max5, usage: windowUsage(max5, 40, 3 * HOUR) },
    // A reset already in the past is a closed window.
    { account: expired, usage: windowUsage(expired, 60, -MINUTE) },
    // 25 Pro units: short as well.
    { account: tiny, usage: windowUsage(tiny, 5, 2 * HOUR) },
  ];
  assert.deepEqual(
    order(rankContinuationTargets(candidates, { now: NOW, rate: 60 })),
    // Open by reset; closed by capacity × remaining; the short ones last by
    // capacity × remaining.
    ["max5", "late", "max20", "closed-pro", "expired", "tiny", "short"],
  );
});

test("when nobody holds half an hour the order is capacity × remaining", () => {
  const short = planningAccount("short", "pro");
  const max5 = planningAccount("max5", "max5");
  const full = planningAccount("full", "pro");
  const candidates = [
    { account: short, usage: windowUsage(short, 20, 10 * MINUTE) },
    { account: full, usage: windowUsage(full, 100) },
    { account: max5, usage: windowUsage(max5, 40, 3 * HOUR) },
  ];
  // 600 units/h needs 300 left: 200, 100 and 20 all fall short.
  const ranked = rankContinuationTargets(candidates, { now: NOW, rate: 600 });
  assert.deepEqual(order(ranked), ["max5", "full", "short"]);
  assert.deepEqual(ranked, rankContinuationTargets(candidates));
});

test("without a tempo an account needs 10% left to lead", () => {
  const max20 = planningAccount("max20", "max20");
  const pro = planningAccount("pro", "pro");
  const closed = planningAccount("closed", "pro");
  const candidates = [
    // 8% of Max 20× is 160 Pro units and resets first, but 8% < 10%.
    { account: max20, usage: windowUsage(max20, 8, 5 * MINUTE) },
    { account: pro, usage: windowUsage(pro, 10, 4 * HOUR) },
  ];
  assert.deepEqual(order(rankContinuationTargets(candidates)), [
    "max20",
    "pro",
  ]);
  assert.deepEqual(order(rankContinuationTargets(candidates, { now: NOW })), [
    "pro",
    "max20",
  ]);
  // A closed window with 10% left still leads over 8% in an open one.
  const withClosed = [
    candidates[0],
    { account: closed, usage: windowUsage(closed, 10) },
  ];
  assert.deepEqual(order(rankContinuationTargets(withClosed, { now: NOW })), [
    "closed",
    "max20",
  ]);
});

test("a zero or invalid tempo behaves like no tempo", () => {
  const max20 = planningAccount("max20", "max20");
  const pro = planningAccount("pro", "pro");
  const max5 = planningAccount("max5", "max5");
  const candidates = [
    { account: max20, usage: windowUsage(max20, 8, 5 * MINUTE) },
    { account: max5, usage: windowUsage(max5, 40, 3 * HOUR) },
    { account: pro, usage: windowUsage(pro, 10, 30 * MINUTE) },
  ];
  const expected = rankContinuationTargets(candidates, { now: NOW });
  assert.deepEqual(order(expected), ["pro", "max5", "max20"]);
  for (const rate of [0, -5, NaN])
    assert.deepEqual(
      rankContinuationTargets(candidates, { now: NOW, rate }),
      expected,
    );
});

/** An account Claude Desktop is signed in to, as the continuation and suggestion checks require. */
function enrolledAccount(
  name: string,
  plan: NonNullable<Account["planning"]>["plan"],
): Account {
  const account = planningAccount(randomUUID(), plan);
  const accountUuid = randomUUID(),
    orgId = randomUUID();
  return {
    ...account,
    name,
    desktop: { accountUuid, orgId, savedAt: new Date(NOW).toISOString() },
    auth: { ...account.auth!, accountUuid, orgId },
  };
}

test("fleet switching and the suggestion pick the account the ranking puts first", () => {
  const source = enrolledAccount("source", "max5");
  const max5 = enrolledAccount("max5", "max5");
  const pro = enrolledAccount("pro", "pro");
  const short = enrolledAccount("short", "pro");
  const max20 = enrolledAccount("max20", "max20");
  const accounts = [source, max5, pro, short, max20];
  const usage: Record<string, AccountUsage> = {
    [source.id]: windowUsage(source, 5, 2 * HOUR),
    [max5.id]: windowUsage(max5, 50, 4 * HOUR),
    [pro.id]: windowUsage(pro, 80, 1 * HOUR),
    [short.id]: windowUsage(short, 20, 10 * MINUTE),
    [max20.id]: windowUsage(max20, 100),
  };
  const candidates = accounts
    .filter((account) => account !== source)
    .map((account) => ({ account, usage: usage[account.id] }));
  const firsts = [undefined, 60, 400].map((rate) => {
    const ranked = rankContinuationTargets(candidates, { now: NOW, rate })[0]
      .account;
    assert.equal(
      chooseTarget(source, accounts, DEFAULT_SETTINGS, usage, NOW, rate),
      ranked,
    );
    assert.equal(
      suggestedAccount(source, accounts, usage, DEFAULT_SETTINGS, NOW, rate),
      ranked,
    );
    return ranked.name;
  });
  // 10% left; 30 Pro units at 60/h; 200 Pro units at 400/h.
  assert.deepEqual(firsts, ["short", "pro", "max5"]);
});

test("the weekly window binds the threshold when it has less left", () => {
  const max5 = planningAccount("max5", "max5");
  const pro = planningAccount("pro", "pro");
  // 80% of the five-hour window but only 5% of the week: 25 Pro units.
  const weeklyShort = {
    ...windowUsage(max5, 80, 10 * MINUTE),
    sevenDay: {
      usedPercent: 95,
      resetsAt: new Date(NOW + 86_400_000).toISOString(),
    },
  };
  const candidates = [
    { account: max5, usage: weeklyShort },
    { account: pro, usage: windowUsage(pro, 50, 4 * HOUR) },
  ];
  for (const rate of [undefined, 60])
    assert.deepEqual(
      order(rankContinuationTargets(candidates, { now: NOW, rate })),
      ["pro", "max5"],
    );
  // Its five-hour window alone would have led.
  const fiveHourOnly = [
    { account: max5, usage: { ...weeklyShort, sevenDay: undefined } },
    candidates[1],
  ];
  assert.deepEqual(
    order(rankContinuationTargets(fiveHourOnly, { now: NOW, rate: 60 })),
    ["max5", "pro"],
  );
});
