import test from "node:test";
import assert from "node:assert/strict";
import { dayPlan, planContext } from "../shared/day-plan";
import { liveForecast, liveSetup } from "../shared/live-forecast";
import type { Forecast } from "../shared/capacity-plan";
import { wallTime } from "../shared/planning";
import { presetTempo, type Tempo } from "../shared/tempo";
import {
  DEFAULT_PLANNING,
  type AccountUsage,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
const WEDNESDAY = "2026-10-14";
const MINUTE = 60_000;
const at = (clock: string) => wallTime(WEDNESDAY, clock, ZONE)!;
const clockOf = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** Segments as "account from-to"; "-" is an outage. */
const lane = (forecast: Forecast) =>
  forecast.segments.map(
    (s) =>
      `${s.accountId ?? "-"} ${clockOf.format(s.from)}-${clockOf.format(s.to)}`,
  );

// The capacity scenario of the day plan: Max 5×, Team (weight 2) and Pro on a
// busy Wednesday, 09:00–18:00 in Istanbul.
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
const flatTempo = (rate: number): Tempo => ({
  ...presetTempo("medium"),
  weekday: Array.from({ length: 24 }, () => rate),
  weekend: Array.from({ length: 24 }, () => rate),
  rate: { weekday: rate, weekend: rate },
});
const max = planningAccount("max", "max5");
const team = planningAccount("vertex", "team");
team.planning!.capacityWeight = 2;
const pro = planningAccount("pro", "pro");
function settings(patch: Partial<PlanningSettings> = {}): PlanningSettings {
  return {
    ...DEFAULT_PLANNING,
    autoStart: true,
    timeZone: ZONE,
    weekday: { enabled: true, start: "09:00", end: "18:00" },
    weekend: { enabled: false, start: "11:00", end: "18:00" },
    accounts: [{ id: max.id }, { id: team.id }, { id: pro.id }],
    ...patch,
  };
}
const context = (tempo: Tempo = presetTempo("medium")) =>
  planContext([max, team, pro], tempo);
// Windows: max 06:15–11:15–16:15, vertex 08:15–13:15, pro 06:30–11:30–16:30.
const plan = dayPlan(WEDNESDAY, settings(), context(busyTempo));

/** Usage read five minutes before `now`; the five-hour window is open until `resets`. */
function fresh(
  id: string,
  now: number,
  used: number,
  resets?: string,
  weekly = 20,
): AccountUsage {
  return {
    accountId: id,
    status: "ready",
    stale: false,
    checkedAt: new Date(now - 5 * MINUTE).toISOString(),
    fiveHour: {
      usedPercent: used,
      ...(resets ? { resetsAt: new Date(at(resets)).toISOString() } : {}),
    },
    sevenDay: {
      usedPercent: weekly,
      resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
    },
  };
}

test("the scenario plan's windows are the ones the live forecast falls back on", () => {
  const windows = (id: string) =>
    plan.accounts
      .find((a) => a.accountId === id)!
      .windows.map((w) => clockOf.format(w.start));
  assert.deepEqual(windows("max"), ["06:15", "11:15", "16:15"]);
  assert.deepEqual(windows("vertex"), ["08:15", "13:15"]);
  assert.deepEqual(windows("pro"), ["06:30", "11:30", "16:30"]);
});

test("live usage goes on from now with the active account; stale accounts follow the plan's chain", () => {
  const now = at("10:00");
  const usage = {
    max: fresh("max", now, 80, "11:15"),
    vertex: fresh("vertex", now, 0, "12:00"),
    // Stale data is ignored, even when it says the window is used up.
    pro: { ...fresh("pro", now, 100, "13:00"), stale: true },
  };
  const input = { plan, settings: settings(), usage, activeId: "max", now };
  const medium = liveForecast({ ...input, context: context() })!;
  assert.deepEqual(medium.segments[0], {
    accountId: "max",
    from: now,
    to: at("18:00"),
  });
  assert.equal(medium.unmet, 0);
  // At 120 Pro units/h max's 100 units last until 10:50. Pro's planned window
  // (06:30–11:30) resets before vertex's (12:00), so pro goes next with a full
  // quota: 80 units until 11:30, then a fresh window until 12:20.
  const heavy = liveForecast({
    ...input,
    context: context(presetTempo("heavy")),
  })!;
  assert.deepEqual(lane(heavy), [
    "max 10:00-10:50",
    "pro 10:50-12:20",
    "max 12:20-18:00",
  ]);
  assert.equal(heavy.switches, 2);
  assert.equal(heavy.unmet, 0);
});

test("an active account outside the plan, or none, starts with the soonest reset", () => {
  const now = at("10:00");
  // Pro has no usage at all: its planned window resets at 11:30.
  const usage = {
    max: fresh("max", now, 80, "13:00"),
    vertex: fresh("vertex", now, 0, "12:00"),
  };
  const input = { plan, settings: settings(), context: context(), usage, now };
  const outside = liveForecast({ ...input, activeId: "not-planned" })!;
  assert.deepEqual(lane(outside), ["pro 10:00-13:30", "vertex 13:30-18:00"]);
  assert.deepEqual(liveForecast(input), outside);
  assert.equal(
    liveForecast({ ...input, activeId: "max" })!.segments[0].accountId,
    "max",
  );
});

test("an account whose weekly limit is used up never serves", () => {
  const now = at("10:00");
  const usage = {
    max: fresh("max", now, 80, "11:15"),
    vertex: fresh("vertex", now, 0, "12:00"),
  };
  // 300 Pro units/h runs through every open window before 11:15.
  const input = {
    plan,
    settings: settings(),
    context: context(flatTempo(300)),
    activeId: "vertex",
    now,
  };
  const open = liveForecast({ ...input, usage })!;
  assert.equal(open.segments[0].accountId, "vertex");
  const blocked = liveForecast({
    ...input,
    usage: { ...usage, vertex: fresh("vertex", now, 0, "12:00", 100) },
  })!;
  assert.ok(blocked.segments.every((s) => s.accountId !== "vertex"));
  assert.equal(blocked.segments[0].accountId, "max");
  assert.ok(blocked.unmet > open.unmet);
});

test("after work there is nothing to forecast; before work it starts at the work start", () => {
  const input = { plan, settings: settings(), context: context(), usage: {} };
  for (const clock of ["18:00", "20:00"])
    assert.equal(liveForecast({ ...input, now: at(clock) }), undefined);
  // A day off and a plan without accounts have nothing to forecast either.
  const saturday = dayPlan("2026-10-17", settings(), context());
  assert.equal(saturday.interval, undefined);
  assert.equal(
    liveForecast({ ...input, plan: saturday, now: at("10:00") }),
    undefined,
  );
  const empty = dayPlan(WEDNESDAY, settings({ accounts: [] }), context());
  assert.equal(
    liveForecast({ ...input, plan: empty, now: at("10:00") }),
    undefined,
  );
  const early = liveForecast({ ...input, now: at("08:00") })!;
  assert.equal(early.segments[0].from, at("09:00"));
  assert.equal(early.segments.at(-1)!.to, at("18:00"));
  // With the plan's own tempo and windows kept as planned it is the plan's forecast.
  assert.deepEqual(
    liveForecast({ ...input, context: context(busyTempo), now: at("08:00") }),
    plan.forecast,
  );
});

test("without auto start a closed window opens at first use, not at its planned warm-up", () => {
  const now = at("10:00");
  const usage = {
    // 100 Pro units until 12:00; the window resets at 17:30.
    max: fresh("max", now, 80, "17:30"),
    vertex: fresh("vertex", now, 0, "12:00", 100),
    // No window open; the plan warms pro up at 11:30.
    pro: fresh("pro", now, 0),
  };
  const input = { plan, context: context(), usage, activeId: "max", now };
  // Pro's window starts when it takes over at 12:00, so it resets at 17:00.
  const firstUse = liveForecast({
    ...input,
    settings: settings({ autoStart: false }),
  })!;
  assert.deepEqual(lane(firstUse), [
    "max 10:00-12:00",
    "pro 12:00-14:00",
    "- 14:00-17:00",
    "pro 17:00-18:00",
  ]);
  assert.equal(firstUse.outageMinutes, 180);
  // With auto start the keeper starts it right away (its planned window is
  // due), so it resets at 15:00 and again at 20:00; max is back at 17:30.
  const warmed = liveForecast({ ...input, settings: settings() })!;
  assert.deepEqual(lane(warmed), [
    "max 10:00-12:00",
    "pro 12:00-14:00",
    "- 14:00-15:00",
    "pro 15:00-17:00",
    "- 17:00-17:30",
    "max 17:30-18:00",
  ]);
  assert.equal(warmed.outageMinutes, 90);
});

test("with auto start a closed window warms now, as the keeper starts a due window", () => {
  const now = at("10:00");
  const usage = {
    max: fresh("max", now, 80, "17:30"),
    vertex: fresh("vertex", now, 0, "12:00", 100),
  };
  const input = {
    plan,
    settings: settings(),
    context: context(),
    activeId: "max",
    now,
  };
  // No window open forecasts like a window opened right now.
  const opened = liveForecast({
    ...input,
    usage: { ...usage, pro: fresh("pro", now, 0, "15:00") },
  });
  assert.deepEqual(
    liveForecast({ ...input, usage: { ...usage, pro: fresh("pro", now, 0) } }),
    opened,
  );
});

test("a window that resets between now and the work start counts as closed and full", () => {
  const now = at("08:00");
  const blocked = (id: string) => fresh(id, now, 0, undefined, 100);
  const input = {
    plan,
    settings: settings(),
    context: context(presetTempo("heavy")),
    now,
  };
  // 90% used, but the window resets at 08:30, before work starts at 09:00.
  const reset = liveForecast({
    ...input,
    usage: {
      max: fresh("max", now, 90, "08:30"),
      vertex: blocked("vertex"),
      pro: blocked("pro"),
    },
  })!;
  // A full Max 5× window from 09:00 (500 Pro units at 120/h) lasts until
  // 13:10 and comes back at 14:00, five hours after the work start.
  assert.deepEqual(lane(reset), [
    "max 09:00-13:10",
    "- 13:10-14:00",
    "max 14:00-18:00",
  ]);
  assert.deepEqual(
    liveForecast({
      ...input,
      usage: {
        max: fresh("max", now, 0),
        vertex: blocked("vertex"),
        pro: blocked("pro"),
      },
    }),
    reset,
  );
});

test("a pace factor scales the demand; one or none leaves the forecast alone", () => {
  const now = at("10:00");
  const usage = {
    max: fresh("max", now, 80, "11:15"),
    vertex: fresh("vertex", now, 0, "12:00"),
    pro: { ...fresh("pro", now, 100, "13:00"), stale: true },
  };
  const input = {
    plan,
    settings: settings(),
    context: context(presetTempo("heavy")),
    usage,
    activeId: "max",
    now,
  };
  // Max's 100 units last until 10:50 at 120 an hour; twice as fast, 25 minutes.
  const steady = liveForecast(input)!;
  assert.equal(lane(steady)[0], "max 10:00-10:50");
  assert.deepEqual(liveForecast({ ...input, factor: 1 }), steady);
  const faster = liveForecast({ ...input, factor: 2 })!;
  assert.equal(lane(faster)[0], "max 10:00-10:25");
  assert.ok(faster.exhaustedAt.max[0] < steady.exhaustedAt.max[0]);
});

test("a schedule restarts an open window later and starts a closed one at its time", () => {
  const duo = dayPlan(
    WEDNESDAY,
    settings({ accounts: [{ id: max.id }, { id: pro.id }] }),
    context(flatTempo(100)),
  );
  const now = at("10:00");
  const input = {
    plan: duo,
    settings: settings(),
    context: context(flatTempo(100)),
    activeId: "max",
    now,
  };
  // Pro's open window resets at 10:30; max (500 units) serves until 15:00.
  const open = {
    max: fresh("max", now, 0, "20:00"),
    pro: fresh("pro", now, 0, "10:30"),
  };
  // Restarting at once, pro resets at 15:30 and serves on until 16:30.
  assert.deepEqual(lane(liveForecast({ ...input, usage: open })!), [
    "max 10:00-15:00",
    "pro 15:00-16:30",
    "- 16:30-18:00",
  ]);
  // Held to 11:30, its window resets at 16:30: an hour of quota, a wait, an hour more.
  const held = liveForecast({
    ...input,
    usage: open,
    schedule: { pro: at("11:30") },
  })!;
  assert.deepEqual(lane(held), [
    "max 10:00-15:00",
    "pro 15:00-16:00",
    "- 16:00-16:30",
    "pro 16:30-17:30",
    "- 17:30-18:00",
  ]);
  // A restart scheduled at the reset itself holds nothing.
  assert.deepEqual(
    liveForecast({ ...input, usage: open, schedule: { pro: at("10:30") } }),
    liveForecast({ ...input, usage: open }),
  );

  // The plan's window chain (pro's planned window resets at 13:45) is held
  // the same way for an account with stale usage.
  assert.deepEqual(
    liveSetup({
      ...input,
      usage: { max: open.max, pro: { ...open.pro, stale: true } },
      schedule: { pro: at("14:45") },
    })!.accounts[1],
    {
      id: "pro",
      capacity: 1,
      keepAlive: true,
      remaining: 100,
      firstReset: at("13:45"),
      restartAt: at("14:45"),
    },
  );

  // A closed window is started now by the keeper, so it resets at 15:00.
  const closed = { max: open.max, pro: fresh("pro", now, 0) };
  assert.deepEqual(lane(liveForecast({ ...input, usage: closed })!), [
    "max 10:00-15:00",
    "pro 15:00-16:00",
    "- 16:00-18:00",
  ]);
  // Started at 12:00 as scheduled, it resets at 17:00.
  assert.deepEqual(
    lane(
      liveForecast({
        ...input,
        usage: closed,
        schedule: { pro: at("12:00") },
      })!,
    ),
    ["max 10:00-15:00", "pro 15:00-16:00", "- 16:00-17:00", "pro 17:00-18:00"],
  );
});

test("a closed window scheduled before now starts now, not at the past time", () => {
  const duo = dayPlan(
    WEDNESDAY,
    settings({ accounts: [{ id: max.id }, { id: pro.id }] }),
    context(flatTempo(100)),
  );
  const now = at("10:00");
  const input = {
    plan: duo,
    settings: settings(),
    context: context(flatTempo(100)),
    usage: { max: fresh("max", now, 0, "20:00"), pro: fresh("pro", now, 0) },
    activeId: "max",
    now,
  };
  // Started at 07:00, pro's window would reset at 12:00 and again at 17:00.
  const past = { ...input, schedule: { pro: at("07:00") } };
  assert.equal(liveSetup(past)!.accounts[1].warmUp, now);
  assert.deepEqual(liveForecast(past), liveForecast(input));
});
