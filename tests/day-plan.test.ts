import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  WINDOW_MS,
  cyclePhases,
  dayPlan,
  nextPlannedStart,
  shouldHaveWindow,
  workInterval,
} from "../shared/day-plan";
import { planCapacity, wallTime } from "../shared/planning";
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

test("two accounts warm up at 05:15 and 07:45 and roll every five hours until work ends", () => {
  const plan = dayPlan(TUESDAY, settings({ accounts: [{ id: A }, { id: B }] }));
  assert.equal(plan.interval?.start, at(TUESDAY, "09:00"));
  assert.equal(plan.interval?.end, at(TUESDAY, "21:00"));
  const [a, b] = plan.accounts;
  assert.equal(a.firstStart, at(TUESDAY, "05:15"));
  assert.equal(b.firstStart, at(TUESDAY, "07:45"));
  assert.deepEqual(
    a.windows.map((w) => w.start),
    ["05:15", "10:15", "15:15", "20:15"].map((c) => at(TUESDAY, c)),
  );
  assert.deepEqual(
    b.windows.map((w) => w.start),
    ["07:45", "12:45", "17:45"].map((c) => at(TUESDAY, c)),
  );
  assert.equal(a.activeFrom, a.firstStart);
  assert.equal(a.activeUntil, at(TUESDAY, "21:00"));
  assert.equal(a.manual, false);
});

test("a manual first start keeps its time and the others move around it", () => {
  const plan = dayPlan(
    TUESDAY,
    settings({ accounts: [{ id: A, firstStart: "07:00" }, { id: B }] }),
  );
  assert.equal(plan.accounts[0].firstStart, at(TUESDAY, "07:00"));
  assert.equal(plan.accounts[0].manual, true);
  // A resets at 12:00 (phase 3 h); B goes half a cycle away (phase 0.5 h).
  assert.equal(plan.accounts[1].firstStart, at(TUESDAY, "04:30"));
  // A clock later than one window after work start means the evening before.
  const late = dayPlan(
    TUESDAY,
    settings({ accounts: [{ id: A, firstStart: "22:30" }] }),
  );
  assert.equal(late.accounts[0].firstStart, at("2026-10-12", "22:30"));
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
  assert.deepEqual(dayPlan(TUESDAY, none).accounts, []);
  assert.equal(nextPlannedStart(A, at(TUESDAY, "10:00"), none), undefined);
  assert.deepEqual(dayPlan(TUESDAY, settings({ accounts: [] })).accounts, []);
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
  assert.equal(shouldHaveWindow(A, at(TUESDAY, "06:29"), s), false);
  assert.equal(shouldHaveWindow(A, at(TUESDAY, "06:30"), s), true);
  assert.equal(shouldHaveWindow(A, at(TUESDAY, "20:59"), s), true);
  assert.equal(shouldHaveWindow(A, at(TUESDAY, "21:00"), s), false);
  assert.equal(shouldHaveWindow(C, at(TUESDAY, "12:00"), s), false);
  const night = settings({
    weekday: { enabled: true, start: "22:00", end: "04:00" },
  });
  assert.equal(shouldHaveWindow(A, at("2026-10-14", "02:00"), night), true);
});

test("the next planned start is the following day's warm-up", () => {
  assert.equal(
    nextPlannedStart(A, at(TUESDAY, "22:00"), settings()),
    at("2026-10-14", "06:30"),
  );
});

test("a live reset continues the chain from the actual window", () => {
  const plan = dayPlan(TUESDAY, settings(), { [A]: at(TUESDAY, "12:00") });
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
