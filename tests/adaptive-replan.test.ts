import test from "node:test";
import assert from "node:assert/strict";
import {
  nextStartCandidates,
  replanStarts,
  type ReplanInput,
} from "../shared/adaptive-plan";
import { SIM_STEP_MS, type SimAccount } from "../shared/capacity-plan";
import { dayPlan, planContext } from "../shared/day-plan";
import { liveSetup } from "../shared/live-forecast";
import { wallTime } from "../shared/planning";
import type { Tempo } from "../shared/tempo";
import {
  DEFAULT_PLANNING,
  type Account,
  type AccountUsage,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
const WEDNESDAY = "2026-10-14";
const MINUTE = 60_000;
const at = (clock: string) => wallTime(WEDNESDAY, clock, ZONE)!;

/** Every hour at `rate` Pro units. */
const flatTempo = (rate: number): Tempo => ({
  source: "learned",
  weekday: Array.from({ length: 24 }, () => rate),
  weekend: Array.from({ length: 24 }, () => rate),
  rate: { weekday: rate, weekend: rate },
  days: { weekday: 15, weekend: 2 },
});
function settings(accounts: Account[]): PlanningSettings {
  return {
    ...DEFAULT_PLANNING,
    autoStart: true,
    timeZone: ZONE,
    weekday: { enabled: true, start: "09:00", end: "18:00" },
    weekend: { enabled: false, start: "11:00", end: "18:00" },
    accounts: accounts.map((a) => ({ id: a.id })),
  };
}
/** Usage read at `now`; the five-hour window is open until `resets` when given. */
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
    checkedAt: new Date(now).toISOString(),
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
/** Today's plan for `accounts` at a flat `rate`, replanned at `now` at that same rate. */
function replanInput(
  accounts: Account[],
  rate: number,
  now: number,
  usage: Record<string, AccountUsage>,
  extra: Partial<ReplanInput> = {},
): ReplanInput {
  const daySettings = settings(accounts);
  const context = planContext(accounts, flatTempo(rate));
  return {
    plan: dayPlan(WEDNESDAY, daySettings, context),
    settings: daySettings,
    context,
    usage,
    now,
    factor: 1,
    blocked: [],
    ...extra,
  };
}

const max = planningAccount("max", "max5");
const team = planningAccount("vertex", "team");
team.planning!.capacityWeight = 2;
const pro = planningAccount("pro", "pro");
const trio = [max, team, pro];
/** The Mac wakes at 08:50: every window closed, usage just refreshed. */
const wakeUp = (accounts: Account[], rate: number) => {
  const now = at("08:50");
  return replanInput(
    accounts,
    rate,
    now,
    Object.fromEntries(accounts.map((a) => [a.id, fresh(a.id, now, 0)])),
  );
};

test("holding a restart until the busy account runs out removes the outage", () => {
  const a = planningAccount("a", "team");
  a.planning!.capacityWeight = 3;
  const b = planningAccount("b", "pro");
  const now = at("09:30");
  const replan = replanStarts(
    replanInput(
      [a, b],
      100,
      now,
      {
        // 250 of a's 300 Pro units are left: they last until 12:00 at 100 an hour.
        a: fresh("a", now, 100 / 6, "12:00"),
        b: fresh("b", now, 0, "10:00"),
      },
      { activeId: "a" },
    ),
  )!;
  // Restarted at 10:00, b's window is idle while a serves and resets at 15:00,
  // so its single hour runs out at 16:00 with a back only at 17:00. Held to
  // 11:00 it resets at 16:00, just as its first hour runs out.
  assert.deepEqual(replan.schedule, { b: at("11:00") });
  assert.equal(replan.forecast.outageMinutes, 0);
  assert.equal(replan.defaultForecast.outageMinutes, 60);
});

test("after a sleep with every window closed, staggered starts save a switch", () => {
  const input = wakeUp(trio, 120);
  const replan = replanStarts(input)!;
  assert.ok(
    replan.forecast.switches < replan.defaultForecast.switches,
    `${replan.forecast.switches} switches, ${replan.defaultForecast.switches} by default`,
  );
  assert.ok(replan.forecast.unmet <= replan.defaultForecast.unmet);
  const setup = liveSetup(input)!;
  const moved = Object.entries(replan.schedule);
  assert.ok(moved.length > 0);
  for (const [id, time] of moved) {
    const account = setup.accounts.find((a) => a.id === id)!;
    const candidates = nextStartCandidates(account, setup.from, setup.to);
    assert.ok(candidates.slice(1).includes(time), `${id} at ${time}`);
  }
});

test("a calm day keeps the default starts", () => {
  const replan = replanStarts(wakeUp(trio, 40))!;
  assert.deepEqual(replan.schedule, {});
  assert.deepEqual(replan.forecast, replan.defaultForecast);
});

test("accounts the keeper cannot start keep their default start", () => {
  const input = wakeUp(trio, 120);
  const moved = Object.keys(replanStarts(input)!.schedule);
  assert.ok(moved.length > 0);
  for (const id of moved)
    assert.ok(!(id in replanStarts({ ...input, blocked: [id] })!.schedule), id);
  // A weekly limit used up keeps an account out of the search as well.
  for (const id of moved) {
    const usage = {
      ...input.usage,
      [id]: fresh(id, input.now, 0, undefined, 100),
    };
    assert.ok(!(id in replanStarts({ ...input, usage })!.schedule), id);
  }
  const none = replanStarts({ ...input, blocked: trio.map((a) => a.id) })!;
  assert.deepEqual(none.schedule, {});
  assert.deepEqual(none.forecast, none.defaultForecast);
});

test("outside work there is nothing to replan", () => {
  assert.equal(
    replanStarts({ ...wakeUp(trio, 120), now: at("18:00") }),
    undefined,
  );
});

test("the next start candidates are the default, then later half hours before the work end", () => {
  const account: SimAccount = {
    id: "a",
    capacity: 1,
    keepAlive: true,
    remaining: 100,
  };
  const halfHours = (from: string, count: number) =>
    Array.from({ length: count }, (_, k) => at(from) + k * 30 * MINUTE);
  const end = at("18:00");
  // An open window restarts at its reset, or a half hour or more later.
  assert.deepEqual(
    nextStartCandidates(
      { ...account, firstReset: at("10:00") },
      at("09:30"),
      end,
    ),
    halfHours("10:00", 11),
  );
  // A closed window starts now, or at the next half hours.
  assert.deepEqual(
    nextStartCandidates({ ...account, warmUp: at("08:50") }, at("08:50"), end),
    [at("08:50"), ...halfHours("09:00", 10)],
  );
  assert.deepEqual(
    nextStartCandidates(account, at("09:00"), end),
    halfHours("09:00", 11),
  );
  // Nothing at or after the work end.
  assert.deepEqual(
    nextStartCandidates(
      { ...account, firstReset: at("16:00") },
      at("15:00"),
      end,
    ),
    halfHours("16:00", 4),
  );
  assert.deepEqual(
    nextStartCandidates(
      { ...account, firstReset: at("18:00") },
      at("15:00"),
      end,
    ),
    [],
  );
});

test("an account with no start left before the work end does not stop the others' search", () => {
  const a = planningAccount("a", "team");
  a.planning!.capacityWeight = 2;
  const x = planningAccount("x", "pro");
  const z = planningAccount("z", "team");
  z.planning!.capacityWeight = 3;
  const now = at("14:00");
  const replan = replanStarts(
    replanInput(
      [a, x, z],
      100,
      now,
      {
        // a's 100 Pro units last until 15:00; it resets only after work.
        a: fresh("a", now, 50, "18:10"),
        x: fresh("x", now, 100, "14:10"),
        z: fresh("z", now, 100, "14:20"),
      },
      { activeId: "a" },
    ),
  )!;
  // Restarted at 14:10, x resets before z and goes next at 15:00, running out
  // at 16:00 for z to finish the day. Held to 14:40 it resets after z, so z
  // serves 15:00–18:00 alone.
  assert.deepEqual(replan.schedule, { x: at("14:40") });
  assert.equal(replan.forecast.switches, 1);
  assert.equal(replan.defaultForecast.switches, 2);
});

/**
 * A flat tempo whose hourly rate counts every read: a simulation turns its
 * step's rate into a number exactly once a step, so reads ÷ steps is the
 * number of simulations.
 */
function countingTempo(rate: number) {
  const counter = { reads: 0 };
  const hour = {
    valueOf: () => {
      counter.reads++;
      return rate;
    },
  } as unknown as number;
  const tempo: Tempo = {
    ...flatTempo(rate),
    weekday: Array.from({ length: 24 }, () => hour),
    weekend: Array.from({ length: 24 }, () => hour),
  };
  return { tempo, counter };
}
/** Simulations one replan of `accounts` waking at 08:50 runs, and its result. */
function countSimulations(accounts: Account[], rate: number) {
  const input = wakeUp(accounts, rate);
  const { tempo, counter } = countingTempo(rate);
  const replan = replanStarts({
    ...input,
    context: { ...input.context, tempo },
  });
  // From the work start at 09:00 to its end at 18:00.
  const steps = (at("18:00") - at("09:00")) / SIM_STEP_MS;
  assert.equal(counter.reads % steps, 0);
  return { simulations: counter.reads / steps, replan, input };
}

test("up to four accounts try every combination of their candidates", () => {
  /** The default, then every combination of the candidates. */
  const combinations = (input: ReplanInput) => {
    const setup = liveSetup(input)!;
    return (
      1 +
      setup.accounts.reduce(
        (product, a) =>
          product * nextStartCandidates(a, setup.from, setup.to).length,
        1,
      )
    );
  };
  const three = countSimulations(trio, 120);
  assert.ok(three.simulations <= 11 ** 3 + 1);
  assert.equal(three.simulations, combinations(three.input));
  // Counting the reads does not change the search.
  assert.deepEqual(three.replan, replanStarts(three.input));
  const four = countSimulations([...trio, planningAccount("pro2", "pro")], 120);
  assert.ok(four.simulations <= 11 ** 4 + 1);
  assert.equal(four.simulations, combinations(four.input));
});

test("five or more accounts descend one account at a time, bounded and deterministic", () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((id) =>
    planningAccount(id, "pro"),
  );
  const first = countSimulations(six, 100);
  // The default, then up to four rounds of each account's ten other starts.
  assert.ok(first.simulations > 1);
  assert.ok(first.simulations <= 1 + 4 * 6 * 10, `${first.simulations}`);
  assert.ok(
    first.replan!.forecast.switches < first.replan!.defaultForecast.switches,
  );
  assert.ok(
    first.replan!.forecast.unmet <= first.replan!.defaultForecast.unmet,
  );
  const second = countSimulations(six, 100);
  assert.equal(second.simulations, first.simulations);
  assert.deepEqual(second.replan, first.replan);
  assert.deepEqual(first.replan, replanStarts(first.input));
});
