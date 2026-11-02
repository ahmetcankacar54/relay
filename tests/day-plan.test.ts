import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  WINDOW_MS,
  clearPlanCache,
  cyclePhases,
  dayPlan,
  dayStart,
  nextPlannedStart,
  planCacheStats,
  planContext,
  shiftDate,
  shouldHaveWindow,
  workInterval,
} from "../shared/day-plan";
import { planCapacity, wallTime } from "../shared/planning";
import { presetTempo, tempoRate, type Tempo } from "../shared/tempo";
import { optimizeStarts, SIM_STEP_MS } from "../shared/capacity-plan";
import { planningAccount } from "./planning-fixtures";
import { DEFAULT_PLANNING, type PlanningSettings } from "../shared/types";

const ZONE = "Europe/Istanbul";
const H = 3_600_000;
const at = (date: string, clock: string) => wallTime(date, clock, ZONE)!;
const TUESDAY = "2026-10-13";
const SATURDAY = "2026-10-17";
const A = randomUUID(),
  B = randomUUID(),
  C = randomUUID();
const accounts = [A, B, C].map((id) => planningAccount(id));
const context = (tempo: Tempo = presetTempo("medium")) =>
  planContext(accounts, tempo);
/** Five-hour windows from `first` while they start before `end`. */
const chain = (first: number, end: number) => {
  const starts: number[] = [];
  for (let start = first; start < end; start += WINDOW_MS) starts.push(start);
  return starts;
};
function settings(patch: Partial<PlanningSettings> = {}): PlanningSettings {
  return {
    ...DEFAULT_PLANNING,
    timeZone: ZONE,
    weekday: { enabled: true, start: "09:00", end: "21:00" },
    weekend: { enabled: false, start: "11:00", end: "18:00" },
    accounts: [{ id: A }],
    ...patch,
  };
}

test("phases spread resets evenly over the five-hour cycle", () => {
  assert.deepEqual(cyclePhases([undefined]), [2.5 * H]);
  assert.deepEqual(cyclePhases([undefined, undefined]), [1.25 * H, 3.75 * H]);
  assert.deepEqual(cyclePhases([undefined, undefined, undefined]), [
    50 * 60_000,
    150 * 60_000,
    250 * 60_000,
  ]);
});

test("fixed phases stay and the others fill the widest gaps", () => {
  assert.deepEqual(cyclePhases([0, undefined]), [0, 2.5 * H]);
  assert.deepEqual(cyclePhases([1 * H, undefined, undefined]), [
    1 * H,
    3.5 * H,
    2.25 * H,
  ]);
  assert.deepEqual(cyclePhases([6 * H, undefined]), [1 * H, 3.5 * H]);
});

test("two accounts spread evenly at 05:15 and 07:45 and roll every five hours until work ends", () => {
  const plan = dayPlan(
    TUESDAY,
    settings({ accounts: [{ id: A }, { id: B }] }),
    context(),
  );
  assert.equal(plan.interval?.start, at(TUESDAY, "09:00"));
  assert.equal(plan.interval?.end, at(TUESDAY, "21:00"));
  const [a, b] = plan.accounts;
  assert.equal(a.evenStart, at(TUESDAY, "05:15"));
  assert.equal(b.evenStart, at(TUESDAY, "07:45"));
  assert.deepEqual(
    a.windows.map((w) => w.start),
    chain(a.firstStart, at(TUESDAY, "21:00")),
  );
  assert.deepEqual(
    b.windows.map((w) => w.start),
    chain(b.firstStart, at(TUESDAY, "21:00")),
  );
  assert.ok(a.windows.every((w) => w.end - w.start === WINDOW_MS));
  assert.equal(a.activeFrom, a.firstStart);
  assert.equal(a.activeUntil, at(TUESDAY, "21:00"));
  assert.equal(a.manual, false);
});

test("a manual first start keeps its time and the others move around it", () => {
  const plan = dayPlan(
    TUESDAY,
    settings({ accounts: [{ id: A, firstStart: "07:00" }, { id: B }] }),
    context(),
  );
  assert.equal(plan.accounts[0].firstStart, at(TUESDAY, "07:00"));
  assert.equal(plan.accounts[0].evenStart, at(TUESDAY, "07:00"));
  assert.equal(plan.accounts[0].manual, true);
  // A resets at 12:00 (phase 3 h); evenly B goes half a cycle away (phase 0.5 h).
  assert.equal(plan.accounts[1].evenStart, at(TUESDAY, "04:30"));
  assert.equal(plan.accounts[1].manual, false);
  // A clock outside (start − 5 h, end) keeps its rhythm and warms up before
  // work: 22:30 with 09:00–21:00 → 07:30 (07:30, 12:30, 17:30, 22:30 …).
  const late = dayPlan(
    TUESDAY,
    settings({ accounts: [{ id: A, firstStart: "22:30" }] }),
    context(),
  );
  assert.equal(late.accounts[0].firstStart, at(TUESDAY, "07:30"));
  assert.equal(late.accounts[0].manual, true);
});

test("night shifts take a manual time after midnight as the same night", () => {
  const night = settings({
    weekday: { enabled: true, start: "22:00", end: "06:00" },
    accounts: [{ id: A, firstStart: "00:30" }],
  });
  const plan = dayPlan(TUESDAY, night, context());
  assert.equal(plan.accounts[0].firstStart, at("2026-10-14", "00:30"));
  assert.equal(
    shouldHaveWindow(A, at(TUESDAY, "12:00"), night, context()),
    false,
  );
  assert.equal(
    shouldHaveWindow(A, at("2026-10-14", "01:00"), night, context()),
    true,
  );
  // A clock that is useless for the shift keeps its rhythm before work.
  const noon = dayPlan(
    TUESDAY,
    settings({
      weekday: { enabled: true, start: "22:00", end: "06:00" },
      accounts: [{ id: A, firstStart: "12:00" }],
    }),
    context(),
  );
  assert.equal(noon.accounts[0].firstStart, at(TUESDAY, "17:00"));
});

test("a manual clock that does not exist on a DST day is skipped, keeping the rhythm", () => {
  const zone = "Europe/Berlin";
  const plan = dayPlan(
    "2026-03-29",
    {
      ...DEFAULT_PLANNING,
      timeZone: zone,
      weekend: { enabled: true, start: "06:00", end: "14:00" },
      accounts: [{ id: A, firstStart: "02:30" }],
    },
    context(),
  );
  assert.equal(
    plan.accounts[0].firstStart,
    wallTime("2026-03-29", "01:30", zone),
  );
});

test("a day starts at its first existing minute when midnight is skipped", () => {
  const zone = "Africa/Cairo";
  assert.equal(wallTime("2026-04-24", "00:00", zone), undefined);
  assert.equal(
    dayStart("2026-04-24", zone),
    wallTime("2026-04-24", "01:00", zone),
  );
  assert.equal(dayStart(TUESDAY, ZONE), at(TUESDAY, "00:00"));
});

test("weekend hours apply on Saturday; disabled days and empty plans have no interval", () => {
  assert.equal(workInterval(SATURDAY, settings()), undefined);
  const weekend = settings({
    weekend: { enabled: true, start: "11:00", end: "18:00" },
  });
  assert.equal(workInterval(SATURDAY, weekend)?.start, at(SATURDAY, "11:00"));
  assert.equal(workInterval(SATURDAY, weekend)?.weekend, true);
  const none = settings({
    weekday: { enabled: false, start: "09:00", end: "21:00" },
  });
  assert.equal(workInterval(TUESDAY, none), undefined);
  assert.deepEqual(dayPlan(TUESDAY, none, context()).accounts, []);
  assert.equal(dayPlan(TUESDAY, none, context()).forecast, undefined);
  assert.equal(
    nextPlannedStart(A, at(TUESDAY, "10:00"), none, context()),
    undefined,
  );
  const empty = dayPlan(TUESDAY, settings({ accounts: [] }), context());
  assert.deepEqual(empty.accounts, []);
  assert.equal(empty.forecast, undefined);
  assert.equal(empty.evenForecast, undefined);
});

test("overnight and full-day intervals", () => {
  const night = settings({
    weekday: { enabled: true, start: "22:00", end: "04:00" },
  });
  assert.equal(workInterval(TUESDAY, night)?.end, at("2026-10-14", "04:00"));
  const full = settings({
    weekday: { enabled: true, start: "00:00", end: "00:00" },
  });
  const interval = workInterval(TUESDAY, full)!;
  assert.equal(interval.end - interval.start, 24 * H);
});

test("a window should run from the first warm-up until work ends, including after midnight", () => {
  const s = settings();
  const first = dayPlan(TUESDAY, s, context()).accounts[0].firstStart;
  assert.ok(first <= at(TUESDAY, "09:00"));
  assert.equal(shouldHaveWindow(A, first - 60_000, s, context()), false);
  assert.equal(shouldHaveWindow(A, first, s, context()), true);
  assert.equal(shouldHaveWindow(A, at(TUESDAY, "20:59"), s, context()), true);
  assert.equal(shouldHaveWindow(A, at(TUESDAY, "21:00"), s, context()), false);
  assert.equal(shouldHaveWindow(C, at(TUESDAY, "12:00"), s, context()), false);
  const night = settings({
    weekday: { enabled: true, start: "22:00", end: "04:00" },
  });
  assert.equal(
    shouldHaveWindow(A, at("2026-10-14", "02:00"), night, context()),
    true,
  );
});

test("the next planned start is the following day's warm-up", () => {
  assert.equal(
    nextPlannedStart(A, at(TUESDAY, "22:00"), settings(), context()),
    dayPlan("2026-10-14", settings(), context()).accounts[0].firstStart,
  );
});

test("a live reset continues the chain from the actual window", () => {
  const plan = dayPlan(TUESDAY, settings(), context(), {
    [A]: at(TUESDAY, "12:00"),
  });
  assert.ok(plan.accounts[0].firstStart < at(TUESDAY, "12:00"));
  assert.deepEqual(
    plan.accounts[0].windows.map((w) => [w.start, w.end]),
    [
      [at(TUESDAY, "07:00"), at(TUESDAY, "12:00")],
      [at(TUESDAY, "12:00"), at(TUESDAY, "17:00")],
      [at(TUESDAY, "17:00"), at(TUESDAY, "17:00") + WINDOW_MS],
    ],
  );
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

// The capacity scenario: Max 5×, Team (weight 2) and Pro on a busy Wednesday.
const WEDNESDAY = "2026-10-14";
const FRIDAY = "2026-10-16";
const busyHours: Record<number, number> = {
  9: 220,
  10: 242,
  11: 242,
  12: 110,
  13: 198,
  14: 242,
  15: 242,
  16: 220,
  17: 154,
};
const busyTempo: Tempo = {
  source: "learned",
  weekday: Array.from({ length: 24 }, (_, hour) => busyHours[hour] ?? 205),
  weekend: Array.from({ length: 24 }, () => 205),
  rate: { weekday: 205, weekend: 205 },
  days: { weekday: 15, weekend: 2 },
};
const max = planningAccount("max", "max5");
const team = planningAccount("vertex", "team");
team.planning!.capacityWeight = 2;
const pro = planningAccount("pro", "pro");
const scenario = (patch: Partial<PlanningSettings> = {}) =>
  settings({
    weekday: { enabled: true, start: "09:00", end: "18:00" },
    accounts: [{ id: max.id }, { id: team.id }, { id: pro.id }],
    ...patch,
  });
const scenarioContext = () => planContext([max, team, pro], busyTempo);
const clockOf = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clocks = (times: number[]) => times.map((time) => clockOf.format(time));

test("capacities and tempo pick the first starts that leave no demand unmet", () => {
  const plan = dayPlan(WEDNESDAY, scenario(), scenarioContext());
  assert.deepEqual(clocks(plan.accounts.map((a) => a.firstStart)), [
    "06:15",
    "08:15",
    "06:30",
  ]);
  assert.deepEqual(clocks(plan.accounts.map((a) => a.evenStart)), [
    "04:50",
    "06:30",
    "08:10",
  ]);
  assert.ok(plan.accounts.every((a) => !a.manual));
  assert.equal(plan.forecast?.unmet, 0);
  assert.equal(plan.forecast?.switches, 3);
  assert.equal(plan.evenForecast?.outageMinutes, 32);
  // Windows and the active range follow the chosen first start.
  const [first] = plan.accounts;
  assert.equal(first.activeFrom, first.firstStart);
  assert.deepEqual(
    first.windows.map((w) => w.start),
    chain(first.firstStart, at(WEDNESDAY, "18:00")),
  );
});

test("a manual first start stays exactly while the others are optimized", () => {
  const plan = dayPlan(
    WEDNESDAY,
    scenario({
      accounts: [
        { id: max.id, firstStart: "07:10" },
        { id: team.id },
        { id: pro.id },
      ],
    }),
    scenarioContext(),
  );
  assert.equal(plan.accounts[0].firstStart, at(WEDNESDAY, "07:10"));
  assert.equal(plan.accounts[0].evenStart, at(WEDNESDAY, "07:10"));
  assert.equal(plan.accounts[0].manual, true);
  assert.deepEqual(
    plan.accounts.map((a) => a.manual),
    [true, false, false],
  );
  assert.ok(plan.forecast && plan.evenForecast);
  assert.ok(plan.forecast.unmet <= plan.evenForecast.unmet);
});

test("the same input returns the same plan and a capacity change replans", () => {
  const first = dayPlan(WEDNESDAY, scenario(), scenarioContext());
  const again = dayPlan(WEDNESDAY, scenario(), scenarioContext());
  assert.deepEqual(again, first);
  // The optimized starts are cached and shared.
  assert.equal(again.forecast, first.forecast);
  const smaller = scenarioContext();
  smaller.capacities[max.id] = 1;
  const replanned = dayPlan(WEDNESDAY, scenario(), smaller);
  assert.notEqual(replanned.forecast, first.forecast);
  assert.notDeepEqual(replanned.forecast, first.forecast);
  assert.ok(replanned.forecast!.unmet > first.forecast!.unmet);
});

test("a planned account without a known capacity counts as one Pro account", () => {
  const unknown = randomUUID();
  const s = settings({ accounts: [{ id: A }, { id: unknown }] });
  const ctx = planContext([accounts[0]], presetTempo("heavy"));
  assert.equal(ctx.capacities[unknown], undefined);
  const plan = dayPlan(TUESDAY, s, ctx);
  assert.equal(plan.accounts.length, 2);
  assert.deepEqual(
    plan,
    dayPlan(TUESDAY, s, {
      ...ctx,
      capacities: { ...ctx.capacities, [unknown]: 1 },
    }),
  );
  assert.equal(shouldHaveWindow(unknown, at(TUESDAY, "12:00"), s, ctx), true);
});

test("a night shift is simulated across midnight with the start day's profile", () => {
  // Demand only between 22:00 and 06:00 on weekdays; none on weekends, so the
  // Saturday hours of a Friday night count only through the weekday profile.
  const nightTempo: Tempo = {
    ...busyTempo,
    weekday: Array.from({ length: 24 }, (_, hour) =>
      hour >= 22 || hour < 6 ? 100 : 0,
    ),
    weekend: Array.from({ length: 24 }, () => 0),
  };
  const night = settings({
    weekday: { enabled: true, start: "22:00", end: "06:00" },
    accounts: [{ id: A }],
  });
  const plan = dayPlan(FRIDAY, night, planContext(accounts, nightTempo));
  assert.equal(plan.interval?.weekend, false);
  const forecast = plan.forecast!;
  assert.equal(forecast.segments[0].from, at(FRIDAY, "22:00"));
  assert.equal(forecast.segments.at(-1)!.to, at("2026-10-17", "06:00"));
  // Eight hours at 100 Pro units/h, a Pro window holds 100: three windows
  // touch the night, the other 500 units are unmet.
  assert.equal(forecast.unmet, 500);
  assert.equal(plan.accounts[0].firstStart, at(FRIDAY, "19:00"));
});

test("the keeper's checks agree with the capacity-aware plan", () => {
  const s = scenario();
  const ctx = scenarioContext();
  const tomorrow = dayPlan(WEDNESDAY, s, ctx);
  for (const account of tomorrow.accounts) {
    assert.equal(
      nextPlannedStart(account.accountId, at(TUESDAY, "22:00"), s, ctx),
      account.firstStart,
    );
    assert.equal(
      shouldHaveWindow(account.accountId, account.firstStart - 60_000, s, ctx),
      false,
    );
    assert.equal(
      shouldHaveWindow(account.accountId, account.firstStart, s, ctx),
      true,
    );
  }
});

test("the default tempo plans a lone Pro and two Pro accounts at fixed times", () => {
  const hours = { enabled: true, start: "09:00", end: "18:00" };
  // Nine hours at 50 Pro units/h, 100 per window: only a 06:00 warm-up uses
  // three whole windows (09:00–11:00, 11:00–13:00, 16:00–18:00).
  const lone = dayPlan(TUESDAY, settings({ weekday: hours }), context());
  assert.deepEqual(clocks(lone.accounts.map((a) => a.firstStart)), ["06:00"]);
  assert.equal(lone.forecast?.unmet, 150);
  const two = dayPlan(
    TUESDAY,
    settings({ weekday: hours, accounts: [{ id: A }, { id: B }] }),
    context(),
  );
  // 450 Pro units of demand, 100 per window: no gap with two switches.
  assert.deepEqual(clocks(two.accounts.map((a) => a.firstStart)), [
    "07:00",
    "08:00",
  ]);
  assert.equal(two.forecast?.unmet, 0);
  assert.equal(two.forecast?.switches, 2);
});

test("plans shared across dates equal plans optimized for each date alone", () => {
  // Hour-shaped demand, so the profile's alignment with the work start matters.
  const shaped: Tempo = {
    ...busyTempo,
    weekday: Array.from({ length: 24 }, (_, hour) => 40 + hour * 7),
    weekend: Array.from({ length: 24 }, (_, hour) => 120 - hour * 3),
  };
  // Night shifts in Berlin span both DST changes (2026-03-29, 2026-10-25),
  // with a manual clock after the change.
  const night = settings({
    timeZone: "Europe/Berlin",
    weekday: { enabled: true, start: "22:00", end: "06:00" },
    weekend: { enabled: true, start: "22:00", end: "06:00" },
    accounts: [
      { id: max.id },
      { id: team.id },
      { id: pro.id, firstStart: "03:30" },
    ],
  });
  const days = (from: string, count: number) =>
    Array.from({ length: count }, (_, i) => shiftDate(from, i));
  const cases = [
    {
      s: scenario(),
      ctx: scenarioContext(),
      dates: days("2026-10-12", 3),
    },
    {
      s: night,
      ctx: planContext([max, team, pro], shaped),
      dates: [...days("2026-03-26", 6), ...days("2026-10-22", 6)],
    },
  ];
  for (const { s, ctx, dates } of cases) {
    clearPlanCache();
    const warm = dates.map((date) => dayPlan(date, s, ctx));
    const cold = dates.map((date) => {
      clearPlanCache();
      return dayPlan(date, s, ctx);
    });
    assert.deepEqual(warm, cold);
    // The same as optimizing the day in absolute time.
    for (const plan of warm) {
      const interval = plan.interval!;
      const direct = optimizeStarts({
        interval,
        accounts: plan.accounts.map((a) => ({
          id: a.accountId,
          capacity: ctx.capacities[a.accountId] ?? 1,
          ...(a.manual ? { manual: a.firstStart } : {}),
        })),
        even: plan.accounts.map((a) => a.evenStart),
        rate: tempoRate(
          ctx.tempo,
          interval.weekend,
          s.timeZone,
          interval.start,
          interval.end,
          SIM_STEP_MS,
        ),
      });
      assert.deepEqual(
        {
          starts: plan.accounts.map((a) => a.firstStart),
          forecast: plan.forecast,
          evenForecast: plan.evenForecast,
        },
        direct,
        plan.date,
      );
    }
  }
});

test("a week of plans optimizes each distinct day shape once", () => {
  const four = [max, team, pro, planningAccount("pro2", "pro")];
  const s = settings({
    weekday: { enabled: true, start: "09:00", end: "21:00" },
    weekend: { enabled: true, start: "11:00", end: "17:00" },
    accounts: four.map(({ id }) => ({ id })),
  });
  const ctx = planContext(four, busyTempo);
  const week = Array.from({ length: 7 }, (_, i) => shiftDate("2026-10-12", i));
  clearPlanCache();
  assert.equal(planCacheStats().optimizations, 0);
  for (const date of week) dayPlan(date, s, ctx);
  // One weekday shape and one weekend shape.
  assert.equal(planCacheStats().optimizations, 2);
  for (const date of week) dayPlan(date, s, ctx);
  assert.equal(planCacheStats().optimizations, 2);
  clearPlanCache();
  assert.equal(planCacheStats().optimizations, 0);
});
