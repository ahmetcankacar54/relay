import test from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveSchedule,
  NOTIFY_EVERY_MS,
  SEARCH_EVERY_MS,
  type AdaptiveInput,
} from "../electron/core/adaptive-schedule";
import {
  replanStarts,
  type Replan,
  type ReplanInput,
} from "../shared/adaptive-plan";
import { dayPlan, planContext } from "../shared/day-plan";
import { liveForecast } from "../shared/live-forecast";
import { wallTime } from "../shared/planning";
import type { Tempo } from "../shared/tempo";
import { usageIdentity, type UsageSample } from "../shared/usage-statistics";
import {
  DEFAULT_PLANNING,
  type Account,
  type AccountUsage,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
const WEDNESDAY = "2026-10-14";
const THURSDAY = "2026-10-15";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (clock: string, date = WEDNESDAY) => wallTime(date, clock, ZONE)!;

/** Every hour at `rate` Pro units. */
const flatTempo = (rate: number): Tempo => ({
  source: "learned",
  weekday: Array.from({ length: 24 }, () => rate),
  weekend: Array.from({ length: 24 }, () => rate),
  rate: { weekday: rate, weekend: rate },
  days: { weekday: 15, weekend: 2 },
});
function settingsFor(
  accounts: Account[],
  hours = { start: "09:00", end: "18:00" },
): PlanningSettings {
  return {
    ...DEFAULT_PLANNING,
    autoStart: true,
    timeZone: ZONE,
    weekday: { enabled: true, ...hours },
    weekend: { enabled: false, start: "11:00", end: "18:00" },
    accounts: accounts.map((a) => ({ id: a.id })),
  };
}
/** Usage read at `now`; the five-hour window is open until `resets` when given. */
function fresh(
  id: string,
  now: number,
  used: number,
  resets?: number,
): AccountUsage {
  return {
    accountId: id,
    status: "ready",
    stale: false,
    checkedAt: new Date(now).toISOString(),
    fiveHour: {
      usedPercent: used,
      ...(resets ? { resetsAt: new Date(resets).toISOString() } : {}),
    },
    sevenDay: {
      usedPercent: 20,
      resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
    },
  };
}
function input(
  accounts: Account[],
  rate: number,
  now: number,
  usage: Record<string, AccountUsage>,
  extra: Partial<AdaptiveInput> = {},
): AdaptiveInput {
  return {
    settings: settingsFor(accounts),
    accounts,
    usage,
    tempo: flatTempo(rate),
    recentSamples: [],
    blocked: [],
    now,
    ...extra,
  };
}
/** The live forecast the class sees for `value` with `schedule` (today's plan). */
function forecastWith(value: AdaptiveInput, schedule: Record<string, number>) {
  const context = planContext(value.accounts, value.tempo);
  return liveForecast({
    plan: dayPlan(WEDNESDAY, value.settings, context),
    settings: value.settings,
    context,
    usage: value.usage,
    activeId: value.activeId,
    now: value.now,
    schedule,
  })!;
}
/** Counts searches by their `now`; `pick` may replace what the real search found. */
function searching(
  pick?: (
    input: ReplanInput,
    replan: Replan | undefined,
    call: number,
  ) => Replan | undefined,
) {
  const calls: number[] = [];
  const search: typeof replanStarts = (value) => {
    calls.push(value.now);
    const replan = replanStarts(value);
    return pick ? pick(value, replan, calls.length) : replan;
  };
  return { calls, search };
}

const A = planningAccount("a", "team");
A.planning!.capacityWeight = 3;
const B = planningAccount("b", "pro");
/**
 * The hold scenario: from 09:30 `a` serves at 100 an hour on its last 250
 * Pro units (they last until its reset at 12:00) while `b`'s idle window
 * resets at 10:00. Holding b's restart to 11:00 removes an hour's outage.
 */
function hold(
  now: number,
  b = fresh("b", now, 0, at("10:00")),
  extra: Partial<AdaptiveInput> = {},
) {
  const used = 100 / 6 + (((now - at("09:30")) / HOUR) * 100) / 3;
  return input(
    [A, B],
    100,
    now,
    { a: fresh("a", now, used, at("12:00")), b },
    { activeId: "a", ...extra },
  );
}

const max = planningAccount("max", "max5");
const team = planningAccount("vertex", "team");
team.planning!.capacityWeight = 2;
const pro = planningAccount("pro", "pro");
/** The Mac wakes at `now` with every window closed and usage just refreshed. */
const wakeUp = (now: number) =>
  input(
    [max, team, pro],
    120,
    now,
    Object.fromEntries(
      [max, team, pro].map((a) => [a.id, fresh(a.id, now, 0)]),
    ),
  );

/** `a`'s five-hour use every five minutes over the last hour, as `used(time)` percent. */
function aSamples(now: number, used: (time: number) => number): UsageSample[] {
  const out: UsageSample[] = [];
  for (let time = now - HOUR; time <= now; time += 5 * MINUTE)
    if (time >= at("09:00"))
      out.push({
        accountId: "a",
        identity: usageIdentity(A)!,
        checkedAt: new Date(time).toISOString(),
        fiveHour: {
          usedPercent: used(time),
          resetsAt: new Date(at("12:00")).toISOString(),
        },
      });
  return out;
}
/**
 * The pace scenario, planned at 60 an hour: from 09:00 to 09:30 `a` spends 48
 * Pro units (96 an hour, 1.6 times the plan), then pauses; `b`'s idle window
 * resets at 10:00. At 1.6 times the pace holding b's restart to 11:00 removes
 * the outage; at the planned pace the default needs no hold.
 */
function pace(now: number, b = fresh("b", now, 0, at("10:00"))) {
  const used = (time: number) =>
    Math.min(16, ((time - at("09:00")) / (30 * MINUTE)) * 16);
  return input(
    [A, B],
    60,
    now,
    { a: fresh("a", now, used(now), at("12:00")), b },
    { activeId: "a", recentSamples: aSamples(now, used) },
  );
}

test("the search and notice intervals are 15 and 30 minutes", () => {
  assert.equal(SEARCH_EVERY_MS, 15 * MINUTE);
  assert.equal(NOTIFY_EVERY_MS, 30 * MINUTE);
});

test("adaptation off, auto start off or no work interval: no schedule at the planned pace", () => {
  const { calls, search } = searching();
  const adaptive = new AdaptiveSchedule({ search });
  const now = at("09:30");
  const fast = pace(now);
  for (const settings of [
    { ...fast.settings, adaptive: false },
    { ...fast.settings, autoStart: false },
  ])
    assert.deepEqual(adaptive.update({ ...fast, settings }), {
      schedule: {},
      factor: 1,
    });
  // Before the plan's first warm-up (Max at 08:00) and once work ends.
  for (const time of [at("07:30"), at("18:00")])
    assert.deepEqual(adaptive.update(wakeUp(time)), {
      schedule: {},
      factor: 1,
    });
  assert.equal(calls.length, 0);
});

test("turning adaptation off drops the schedule and says so; leaving work drops it quietly", () => {
  const adaptive = new AdaptiveSchedule();
  assert.deepEqual(adaptive.update(hold(at("09:30"))).schedule, {
    b: at("11:00"),
  });
  const off = hold(at("10:00"));
  assert.deepEqual(
    adaptive.update({
      ...off,
      settings: { ...off.settings, adaptive: false },
    }),
    { schedule: {}, factor: 1, notice: { kind: "normal", schedule: {} } },
  );
  // Within 30 minutes of the last notice it goes quietly, and is announced
  // once the 30 minutes are up.
  const quiet = new AdaptiveSchedule();
  quiet.update(hold(at("09:30")));
  const stopped = (now: number) => {
    const value = hold(now, fresh("b", now, 0));
    return { ...value, settings: { ...value.settings, autoStart: false } };
  };
  assert.deepEqual(quiet.update(stopped(at("09:40"))), {
    schedule: {},
    factor: 1,
  });
  assert.deepEqual(quiet.update(stopped(at("10:00"))), {
    schedule: {},
    factor: 1,
    notice: { kind: "normal", schedule: {} },
  });
  // Had the Mac slept from then until after the 11:00 start, nothing would
  // be left to tell: that start has passed.
  const slept = new AdaptiveSchedule();
  slept.update(hold(at("09:30")));
  slept.update(stopped(at("09:40")));
  assert.deepEqual(slept.update(stopped(at("11:05"))), {
    schedule: {},
    factor: 1,
  });
  // Outside the work interval (here the day was cut short to end at 10:00)
  // the schedule goes quietly too.
  const short = new AdaptiveSchedule();
  short.update(hold(at("09:30")));
  const after = hold(at("10:30"));
  assert.deepEqual(
    short.update({
      ...after,
      settings: settingsFor([A, B], { start: "09:00", end: "10:00" }),
    }),
    { schedule: {}, factor: 1 },
  );
});

test("holding a restart is adopted once and kept without searching again", () => {
  let clock = at("09:30");
  const { calls, search } = searching();
  const adaptive = new AdaptiveSchedule({ now: () => clock, search });
  const first = adaptive.update(hold(clock));
  assert.deepEqual(first, {
    schedule: { b: at("11:00") },
    factor: 1,
    since: at("09:30"),
    notice: { kind: "updated", schedule: { b: at("11:00") } },
  });
  clock = at("09:31");
  const second = adaptive.update(hold(clock));
  assert.deepEqual(second, {
    schedule: { b: at("11:00") },
    factor: 1,
    since: at("09:30"),
  });
  assert.deepEqual(calls, [at("09:30")]);
  // The last result without its notice.
  assert.deepEqual(adaptive.current(), second);
});

test("a search runs at most every 15 minutes while the forecast stays worse", () => {
  const { calls, search } = searching();
  const adaptive = new AdaptiveSchedule({ search });
  // Neither account can be started, so nothing improves and every update
  // finds the forecast an hour short of the plan.
  for (const clock of ["09:30", "09:35", "09:44", "09:45", "09:50"]) {
    const result = adaptive.update(
      hold(at(clock), undefined, { blocked: ["a", "b"] }),
    );
    assert.deepEqual(result, { schedule: {}, factor: 1 }, clock);
  }
  assert.deepEqual(calls, [at("09:30"), at("09:45")]);
});

test("an equally good alternative never replaces the adopted schedule", () => {
  // b's window resets at 10:15 here: held to 10:45 or to 11:15 it leaves 15
  // minutes without quota either way; the search prefers the shorter hold.
  const late = (now: number) => hold(now, fresh("b", now, 0, at("10:15")));
  const alternative = { b: at("11:15") };
  const { calls, search } = searching((value, replan, call) =>
    call === 1
      ? replan
      : {
          ...replan!,
          schedule: alternative,
          forecast: liveForecast({ ...value, schedule: alternative })!,
        },
  );
  const adaptive = new AdaptiveSchedule({ search });
  assert.deepEqual(adaptive.update(late(at("09:30"))).schedule, {
    b: at("10:45"),
  });
  const now = at("09:45");
  const adopted = forecastWith(late(now), { b: at("10:45") });
  const other = forecastWith(late(now), alternative);
  assert.equal(adopted.outageMinutes, 15);
  assert.deepEqual(
    [other.unmet, other.switches],
    [adopted.unmet, adopted.switches],
  );
  // Still 15 minutes short of the plan, so the search runs again.
  const result = adaptive.update(late(now));
  assert.equal(calls.length, 2);
  assert.deepEqual(result, {
    schedule: { b: at("10:45") },
    factor: 1,
    since: at("09:30"),
  });
});

test("today's pace scales the forecast: 1.6 times the plan adopts a hold", () => {
  const adaptive = new AdaptiveSchedule();
  const result = adaptive.update(pace(at("09:30")));
  assert.equal(result.factor, 1.6);
  assert.equal(result.observedRate, 96);
  assert.deepEqual(result.schedule, { b: at("11:00") });
  assert.equal(result.notice?.kind, "updated");
  // At the planned pace the same moment needs nothing.
  const calm = new AdaptiveSchedule().update({
    ...pace(at("09:30")),
    recentSamples: [],
  });
  assert.deepEqual(calm, { schedule: {}, factor: 1 });
});

test("a slower day clears the schedule once two reviews in a row agree, with one notice", () => {
  // The pace scenario at `perHour` over the last hour (a's samples only set
  // the pace); b's window has reset at 10:00 and waits for its hold.
  const paced = (now: number, perHour: number) => {
    const value = pace(now, now < at("10:00") ? undefined : fresh("b", now, 0));
    const used = (time: number) => 16 + ((time - now) / HOUR) * (perHour / 3);
    return { ...value, recentSamples: aSamples(now, used) };
  };
  const adaptive = new AdaptiveSchedule();
  const kinds: string[] = [];
  const run = (clock: string, perHour: number) => {
    const result = adaptive.update(paced(at(clock), perHour));
    if (result.notice) kinds.push(result.notice.kind);
    return result;
  };
  assert.equal(run("09:30", 96).factor, 1.6);
  const held = { b: at("11:00") };
  // 09:45: the planned pace, where the default does as well. One review is
  // not enough.
  assert.deepEqual(run("09:45", 60).schedule, held);
  // 10:00: fast again, the hold is better, and the count starts over.
  assert.deepEqual(run("10:00", 96).schedule, held);
  // 10:15 and 10:30: the planned pace twice in a row clears it.
  assert.deepEqual(run("10:15", 60).schedule, held);
  for (const clock of ["10:16", "10:29"])
    assert.deepEqual(run(clock, 60).schedule, held, clock);
  const cleared = run("10:30", 60);
  assert.deepEqual(cleared.schedule, {});
  assert.deepEqual(cleared.notice, { kind: "normal", schedule: {} });
  assert.deepEqual(kinds, ["updated", "normal"]);
});

test("a change inside the 30 minutes is announced only if it still stands", () => {
  const { calls, search } = searching();
  const adaptive = new AdaptiveSchedule({ search });
  adaptive.update(hold(at("09:30")));
  // Adaptation off at 09:40 and on again at 09:45: the same hold comes back,
  // so the user, who heard of it at 09:30, hears nothing more.
  const off = hold(at("09:40"));
  assert.deepEqual(
    adaptive.update({ ...off, settings: { ...off.settings, adaptive: false } }),
    { schedule: {}, factor: 1 },
  );
  assert.deepEqual(adaptive.update(hold(at("09:45"))), {
    schedule: { b: at("11:00") },
    factor: 1,
    since: at("09:45"),
  });
  assert.deepEqual(calls, [at("09:30"), at("09:45")]);
  for (const clock of ["10:00", "10:15"]) {
    const now = at(clock);
    assert.equal(
      adaptive.update(hold(now, fresh("b", now, 0))).notice,
      undefined,
      clock,
    );
  }
});

test("the Mac waking at 08:50 with every warm-up missed is re-planned before work", () => {
  const now = at("08:50");
  const { calls, search } = searching();
  const result = new AdaptiveSchedule({ search }).update(wakeUp(now));
  // No samples: the planned pace.
  assert.equal(result.factor, 1);
  assert.equal(result.observedRate, undefined);
  // Started now, all three would switch twice against the plan's once.
  assert.equal(forecastWith(wakeUp(now), {}).switches, 2);
  assert.deepEqual(result.schedule, { max: at("09:00"), pro: at("09:00") });
  assert.equal(forecastWith(wakeUp(now), result.schedule).switches, 1);
  assert.equal(result.notice?.kind, "updated");
  assert.deepEqual(calls, [now]);
  // Four Pros planned at 100 an hour warm up from 04:00. Started at 08:50
  // they leave 60 minutes without quota and 7 switches against the plan's
  // none and 4, so the search runs; but no later start does better (two
  // windows a Pro after 08:50 hold 800 of the 900 Pro units of demand).
  const pros = ["p1", "p2", "p3", "p4"].map((id) => planningAccount(id, "pro"));
  const usage = Object.fromEntries(
    pros.map((a) => [a.id, fresh(a.id, now, 0)]),
  );
  const four = input(pros, 100, now, usage);
  const fallback = forecastWith(four, {});
  assert.deepEqual([fallback.outageMinutes, fallback.switches], [60, 7]);
  const other = searching();
  assert.deepEqual(
    new AdaptiveSchedule({ search: other.search }).update(four),
    {
      schedule: {},
      factor: 1,
    },
  );
  assert.deepEqual(other.calls, [now]);
});

test("a calm morning that follows the plan never searches, before work or after its start", () => {
  const pros = ["p1", "p2", "p3", "p4"].map((id) => planningAccount(id, "pro"));
  for (const [accounts, rate] of [
    [[max, team, pro], 120],
    [pros, 100],
  ] as const) {
    const settings = settingsFor([...accounts]);
    const plan = dayPlan(
      WEDNESDAY,
      settings,
      planContext([...accounts], flatTempo(rate)),
    );
    const { calls, search } = searching();
    const adaptive = new AdaptiveSchedule({ search });
    for (const clock of [
      "04:00",
      "05:30",
      "06:30",
      "07:30",
      "08:00",
      "08:50",
      "09:00",
    ]) {
      const now = at(clock);
      // Every window warmed up when planned, and nothing is used before work.
      const usage = Object.fromEntries(
        plan.accounts.map((p) => {
          let reset = p.activeFrom;
          while (reset <= now) reset += 5 * HOUR;
          return [
            p.accountId,
            fresh(p.accountId, now, 0, p.activeFrom <= now ? reset : undefined),
          ];
        }),
      );
      assert.deepEqual(
        adaptive.update(input([...accounts], rate, now, usage)),
        { schedule: {}, factor: 1 },
        clock,
      );
    }
    assert.deepEqual(calls, []);
  }
});

test("a start whose time came is dropped quietly: the keeper starts the window", () => {
  const adaptive = new AdaptiveSchedule();
  adaptive.update(hold(at("09:30")));
  const now = at("11:00");
  // b's window reset at 10:00 and stayed closed.
  assert.deepEqual(adaptive.update(hold(now, fresh("b", now, 0))), {
    schedule: {},
    factor: 1,
  });
});

test("an adopted hold stays in force minute by minute through b's reset", () => {
  // The hold scenario updated every minute from 09:30 to b's reset at 10:00,
  // with a's usage recomputed each minute or read every five minutes in whole
  // percent. With 249 Pro units left at 09:30 instead of 250, a's quota runs
  // out within a minute of its 12:00 reset: the 10:00 read (34%) puts the
  // run-out a minute early, where the default does as well as the hold. One
  // such review does not clear it.
  for (const [left, reads] of [
    [250, "exact"],
    [250, "whole percent"],
    [249, "whole percent"],
  ] as const) {
    const adaptive = new AdaptiveSchedule();
    const kinds: string[] = [];
    let adopted: number | undefined;
    for (let now = at("09:30"); now <= at("10:00"); now += MINUTE) {
      const read =
        reads === "exact"
          ? now
          : at("09:30") +
            Math.floor((now - at("09:30")) / (5 * MINUTE)) * 5 * MINUTE;
      // a serves 100 Pro units an hour out of its 300.
      const used = (300 - left + ((read - at("09:30")) / HOUR) * 100) / 3;
      const value = hold(read);
      const result = adaptive.update({
        ...value,
        usage: {
          a: fresh(
            "a",
            read,
            reads === "exact" ? used : Math.round(used),
            at("12:00"),
          ),
          // Held, b's window stays closed once it resets at 10:00.
          b: now < at("10:00") ? value.usage.b : fresh("b", now, 0),
        },
        now,
      });
      const label = `${left} ${reads} ${now}`;
      if (result.notice) kinds.push(result.notice.kind);
      if (adopted === undefined && result.schedule.b !== undefined)
        adopted = now;
      if (adopted !== undefined)
        assert.deepEqual(result.schedule, { b: at("11:00") }, label);
    }
    assert.ok(adopted !== undefined, `${left} ${reads}`);
    assert.deepEqual(kinds, ["updated"], `${left} ${reads}`);
  }
});

test("the window open at the adoption is not mistaken for use when its reset is reported 90 s later", () => {
  // b's window opened at 09:29:30, half a minute before the adoption at 09:30.
  // (A search that holds its restart is injected: the verdict is not under test.)
  const opened = at("09:29") + 30_000;
  const held = { b: at("15:00") };
  const { search } = searching((_, replan) => ({
    ...replan!,
    schedule: held,
    forecast: { ...replan!.forecast, unmet: 0, switches: 0 },
  }));
  const adaptive = new AdaptiveSchedule({ search });
  const adoption = at("09:30");
  assert.deepEqual(
    adaptive.update(hold(adoption, fresh("b", adoption, 0, opened + 5 * HOUR)))
      .schedule,
    held,
  );
  const now = at("09:35");
  assert.deepEqual(
    adaptive.update(hold(now, fresh("b", now, 1, opened + 5 * HOUR + 90_000))),
    { schedule: held, factor: 1, since: adoption },
  );
});

test("a deferred account used by hand loses its deferral without a notice", () => {
  const adaptive = new AdaptiveSchedule();
  adaptive.update(hold(at("09:30")));
  // The window b had at the adoption is not a sign of use.
  let now = at("09:45");
  assert.deepEqual(adaptive.update(hold(now)).schedule, { b: at("11:00") });
  // At 10:10 b runs a window the user opened after its reset.
  now = at("10:10");
  assert.deepEqual(
    adaptive.update(
      hold(now, fresh("b", now, 5, at("15:10")), { activeId: "b" }),
    ),
    { schedule: {}, factor: 1 },
  );
});

test("a clock moved back starts the schedule over", () => {
  const { calls, search } = searching();
  const adaptive = new AdaptiveSchedule({ search });
  adaptive.update(hold(at("09:30")));
  const result = adaptive.update(hold(at("09:20")));
  // Adopted anew at once, and the user, who heard of it, hears nothing more.
  assert.deepEqual(calls, [at("09:30"), at("09:20")]);
  assert.deepEqual(result, {
    schedule: { b: at("11:00") },
    factor: 1,
    since: at("09:20"),
  });
  // The last notice counts as given at 09:20: the next one may come 30
  // minutes later, at 09:50, not only at 10:00.
  const off = hold(at("09:50"));
  assert.equal(
    adaptive.update({ ...off, settings: { ...off.settings, adaptive: false } })
      .notice?.kind,
    "normal",
  );
});

test("a new plan date starts over: its first update searches at once", () => {
  // Work runs around the clock, so Wednesday's interval ends as Thursday's starts.
  const accounts = [A, B];
  const day = (now: number): AdaptiveInput => ({
    ...input(
      accounts,
      100,
      now,
      {
        // Both are used up until 11:00 and neither can be started.
        a: fresh("a", now, 100, at("11:00", THURSDAY)),
        b: fresh("b", now, 100, at("11:00", THURSDAY)),
      },
      { blocked: ["a", "b"] },
    ),
    settings: settingsFor(accounts, { start: "09:00", end: "09:00" }),
  });
  const { calls, search } = searching();
  const adaptive = new AdaptiveSchedule({ search });
  for (const clock of ["08:50", "08:55", "09:00"])
    adaptive.update(day(at(clock, THURSDAY)));
  assert.deepEqual(calls, [at("08:50", THURSDAY), at("09:00", THURSDAY)]);
});

test("an overnight interval keeps the schedule across local midnight", () => {
  // The hold scenario 14 h 20 min later: work runs from 23:20 to 08:20, and at
  // 23:50 b's restart at 00:20 is held to 01:20.
  const night = (now: number, b: AccountUsage) => {
    const value = hold(now - 14 * HOUR - 20 * MINUTE, b);
    return {
      ...value,
      usage: {
        a: fresh(
          "a",
          now,
          value.usage.a.fiveHour!.usedPercent,
          at("02:20", THURSDAY),
        ),
        b,
      },
      settings: settingsFor([A, B], { start: "23:20", end: "08:20" }),
      now,
    };
  };
  const { calls, search } = searching();
  const adaptive = new AdaptiveSchedule({ search });
  const adoption = at("23:50");
  const first = adaptive.update(
    night(adoption, fresh("b", adoption, 0, at("00:20", THURSDAY))),
  );
  assert.deepEqual(first.schedule, { b: at("01:20", THURSDAY) });
  // Past midnight the local date is Thursday, but Wednesday's plan still runs.
  const now = at("00:01", THURSDAY);
  assert.deepEqual(
    adaptive.update(night(now, fresh("b", now, 0, at("00:20", THURSDAY)))),
    {
      schedule: { b: at("01:20", THURSDAY) },
      factor: 1,
      since: adoption,
    },
  );
  assert.deepEqual(calls, [adoption]);
});

test("an account taken out of the plan leaves the schedule at once and quietly", () => {
  const adaptive = new AdaptiveSchedule();
  adaptive.update(hold(at("09:30")));
  const without = (now: number) => ({
    ...hold(now, fresh("b", now, 0, at("10:00"))),
    settings: settingsFor([A]),
  });
  assert.deepEqual(adaptive.update(without(at("09:35"))), {
    schedule: {},
    factor: 1,
  });
  assert.equal(adaptive.update(without(at("09:59"))).notice, undefined);
});

test("current() leaves out starts whose time has come since the last update", () => {
  let clock = at("09:30");
  const adaptive = new AdaptiveSchedule({ now: () => clock });
  adaptive.update(hold(clock));
  clock = at("10:59");
  assert.deepEqual(adaptive.current(), {
    schedule: { b: at("11:00") },
    factor: 1,
    since: at("09:30"),
  });
  clock = at("11:00");
  assert.deepEqual(adaptive.current(), { schedule: {}, factor: 1 });
});
