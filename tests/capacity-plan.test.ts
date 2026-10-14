import test from "node:test";
import assert from "node:assert/strict";
import {
  SIM_STEP_MS,
  optimizeStarts,
  simulateDay,
  type Forecast,
  type SimAccount,
  type StartPlanInput,
} from "../shared/capacity-plan";
import { WINDOW_MS } from "../shared/work-hours";

const base = Date.parse("2026-10-14T00:00:00Z");
const H = 3_600_000;
const MIN = 60_000;
const S = base + 9 * H;
const E = base + 18 * H;
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

const profile: Record<number, number> = {
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
const rate = (time: number) => profile[Math.floor((time - base) / H)] ?? 0;
const scaled = (factor: number) => (time: number) => rate(time) * factor;
const flat = (perHour: number) => (time: number) =>
  time >= S && time < E ? perHour : 0;

const accounts = [
  { id: "max", capacity: 5 },
  { id: "vertex", capacity: 2 },
  { id: "pro", capacity: 1 },
];
const evenFor = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => S + (WINDOW_MS * (i + 0.5)) / count - WINDOW_MS,
  );
const withPro = (count: number) => [
  ...accounts,
  ...Array.from({ length: count }, (_, i) => ({
    id: `pro${i + 2}`,
    capacity: 1,
  })),
];
const even = evenFor(3);

const sim = (
  list: SimAccount[],
  perHour: (time: number) => number,
  active?: string,
) =>
  simulateDay({
    from: S,
    to: E,
    rate: perHour,
    accounts: list,
    ...(active ? { active } : {}),
  });
/** The score the optimizer ranks first: unmet (to 0.5), then switches. */
const score = (forecast: Forecast) => [
  Math.round(forecast.unmet * 2) / 2,
  forecast.switches,
];
const notWorse = (result: Forecast, reference: Forecast) => {
  const [a, b] = [score(result), score(reference)];
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
};
const view = (forecast: Forecast) =>
  forecast.segments.map(
    (s) => `${s.accountId ?? "outage"} ${hhmm(s.from)}-${hhmm(s.to)}`,
  );

test("the simulation step is five minutes", () => {
  assert.equal(SIM_STEP_MS, 300_000);
});

test("the optimizer spreads three accounts to leave no demand unmet", () => {
  const plan = optimizeStarts({
    interval: { start: S, end: E },
    accounts,
    rate,
    even,
  });
  assert.deepEqual(plan.starts.map(hhmm), ["06:15", "08:15", "06:30"]);
  assert.deepEqual(view(plan.forecast), [
    "max 09:00-11:09",
    "pro 11:09-11:55",
    "vertex 11:55-14:13",
    "max 14:13-18:00",
  ]);
  assert.equal(plan.forecast.unmet, 0);
  assert.equal(plan.forecast.switches, 3);
  assert.equal(plan.evenForecast.outageMinutes, 32);
  assert.deepEqual(
    plan.evenForecast.segments
      .filter((s) => !s.accountId)
      .map((s) => `${hhmm(s.from)}-${hhmm(s.to)}`),
    ["14:18-14:50"],
  );
  assert.equal(plan.evenForecast.switches, 5);
  assert.equal(plan.evenForecast.unmet, 130.3);
});

test("the account whose window resets soonest goes first", () => {
  const forecast = sim(
    [
      {
        id: "a",
        capacity: 1,
        firstReset: base + 11 * H,
        keepAlive: false,
        remaining: 100,
      },
      {
        id: "b",
        capacity: 5,
        firstReset: base + 13 * H,
        keepAlive: false,
        remaining: 500,
      },
    ],
    () => 60,
  );
  assert.equal(forecast.segments[0].accountId, "a");
  assert.equal(hhmm(forecast.segments[0].from), "09:00");
  // 100 units at 60 an hour: a lasts 100 minutes, then b takes over.
  assert.equal(hhmm(forecast.segments[0].to), "10:40");
  assert.equal(forecast.segments[1].accountId, "b");
});

test("a step that runs an account dry spills into the next account", () => {
  const forecast = sim(
    [
      {
        id: "a",
        capacity: 1,
        firstReset: base + 10 * H,
        keepAlive: false,
        remaining: 1,
      },
      {
        id: "b",
        capacity: 20,
        firstReset: base + 14 * H,
        keepAlive: false,
        remaining: 2000,
      },
    ],
    () => 120,
  );
  assert.deepEqual(forecast.exhaustedAt.a?.map(hhmm), ["09:01"]);
  assert.deepEqual(view(forecast).slice(0, 2), [
    "a 09:00-09:01",
    "b 09:01-18:00",
  ]);
  assert.equal(forecast.unmet, 0);
  assert.equal(forecast.outageMinutes, 0);
});

test("a spill consumes exactly the demand of the step", () => {
  // One hour at 120 an hour is 120 units; a holds 1 and b holds 109, so the
  // last 10 units (the final five minutes) are unmet.
  const forecast = simulateDay({
    from: S,
    to: S + H,
    rate: () => 120,
    accounts: [
      {
        id: "a",
        capacity: 1,
        firstReset: base + 10 * H,
        keepAlive: false,
        remaining: 1,
      },
      {
        id: "b",
        capacity: 1,
        firstReset: base + 14 * H,
        keepAlive: false,
        remaining: 109,
      },
    ],
  });
  assert.ok(Math.abs(forecast.unmet - 10) <= 0.1, `unmet ${forecast.unmet}`);
  assert.equal(forecast.outageMinutes, 5);
  assert.deepEqual(view(forecast), [
    "a 09:00-09:01",
    "b 09:01-09:55",
    "outage 09:55-10:00",
  ]);
});

test("a pro account refills at its reset and idles in the outage between", () => {
  const forecast = sim(
    [
      {
        id: "pro",
        capacity: 1,
        warmUp: S - 3 * H,
        keepAlive: true,
        remaining: 100,
      },
    ],
    () => 50,
  );
  assert.deepEqual(view(forecast), [
    "pro 09:00-13:00",
    "outage 13:00-16:00",
    "pro 16:00-18:00",
  ]);
  assert.equal(forecast.outageMinutes, 180);
  assert.equal(forecast.unmet, 150);
  assert.equal(forecast.switches, 0);
});

test("a closed window starts on first use and refills five hours later", () => {
  const forecast = sim(
    [{ id: "c", capacity: 1, keepAlive: false, remaining: 100 }],
    (time) => (time >= base + 10 * H && time < base + 16 * H ? 100 : 0),
  );
  // Used from 10:00, so the window ends 15:00 (not 14:00, five hours after 09:00).
  assert.deepEqual(view(forecast), [
    "c 09:00-11:00",
    "outage 11:00-15:00",
    "c 15:00-18:00",
  ]);
  assert.equal(forecast.outageMinutes, 240);
  assert.equal(forecast.unmet, 400);
});

test("time without demand is never an outage", () => {
  const forecast = sim(
    [
      {
        id: "a",
        capacity: 5,
        firstReset: base + 12 * H,
        keepAlive: true,
        remaining: 500,
        blocked: true,
      },
      {
        id: "b",
        capacity: 1,
        firstReset: base + 12 * H,
        keepAlive: false,
        remaining: 0,
      },
    ],
    () => 0,
  );
  assert.equal(forecast.outageMinutes, 0);
  assert.equal(forecast.unmet, 0);
  assert.equal(forecast.switches, 0);
});

test("a blocked account is never chosen", () => {
  const forecast = sim(
    [
      {
        id: "a",
        capacity: 5,
        firstReset: base + 10 * H,
        keepAlive: true,
        remaining: 500,
        blocked: true,
      },
      {
        id: "b",
        capacity: 1,
        firstReset: base + 14 * H,
        keepAlive: false,
        remaining: 100,
      },
    ],
    () => 60,
    "a",
  );
  assert.ok(forecast.segments.every((s) => s.accountId !== "a"));
  assert.deepEqual(
    forecast.segments.slice(0, 2).map((s) => s.accountId),
    ["b", undefined],
  );
  assert.ok(forecast.outageMinutes > 0);
  assert.equal(forecast.exhaustedAt.a, undefined);
});

test("a live active account stays first even when another resets sooner", () => {
  const list: SimAccount[] = [
    {
      id: "max",
      capacity: 5,
      firstReset: base + 14 * H,
      keepAlive: true,
      remaining: 100,
    },
    {
      id: "vertex",
      capacity: 2,
      firstReset: base + 11 * H,
      keepAlive: true,
      remaining: 200,
    },
  ];
  const live = sim(list, () => 60, "max");
  assert.equal(live.segments[0].accountId, "max");
  assert.equal(hhmm(live.segments[0].to), "10:40");
  assert.equal(live.segments[1].accountId, "vertex");
  assert.equal(sim(list, () => 60).segments[0].accountId, "vertex");
});

test("a single account is warmed up so its refill lands where demand is", () => {
  const plan = optimizeStarts({
    interval: { start: S, end: E },
    accounts: [{ id: "pro", capacity: 1 }],
    rate: () => 50,
    even: [S - 2.5 * H],
  });
  assert.deepEqual(plan.starts.map(hhmm), ["06:00"]);
  assert.equal(plan.forecast.outageMinutes, 180);
  assert.equal(plan.evenForecast.outageMinutes, 210);
  assert.ok(plan.forecast.outageMinutes <= plan.evenForecast.outageMinutes);
});

test("a manual start stays and the plan is never worse than even", () => {
  const plan = optimizeStarts({
    interval: { start: S, end: E },
    accounts: [{ ...accounts[0], manual: base + 7 * H }, ...accounts.slice(1)],
    rate,
    even,
  });
  assert.equal(hhmm(plan.starts[0]), "07:00");
  assert.ok(notWorse(plan.forecast, plan.evenForecast));
});

test("when every start is manual the even spread is returned as is", () => {
  const manual = even;
  const plan = optimizeStarts({
    interval: { start: S, end: E },
    accounts: accounts.map((a, i) => ({ ...a, manual: manual[i] })),
    rate,
    even,
  });
  assert.deepEqual(plan.starts, even);
  assert.deepEqual(plan.forecast, plan.evenForecast);
});

test("without demand every free start is the latest candidate", () => {
  const plan = optimizeStarts({
    interval: { start: S, end: E },
    accounts,
    rate: () => 0,
    even,
  });
  assert.deepEqual(plan.starts.map(hhmm), ["08:45", "08:45", "08:45"]);
  assert.equal(plan.forecast.switches, 0);
  assert.equal(plan.forecast.unmet, 0);
});

test("the result is never worse than the even spread on random days", () => {
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const capacities = [5, 2, 1];
  for (let day = 0; day < 20; day++) {
    const hourly = Array.from({ length: 9 }, () => Math.round(random() * 300));
    const count = 1 + Math.floor(random() * 3);
    const input: StartPlanInput = {
      interval: { start: S, end: E },
      accounts: capacities
        .slice(0, count)
        .map((capacity, i) => ({ id: `a${i}`, capacity })),
      rate: (time) => hourly[Math.floor((time - S) / H)] ?? 0,
      even: evenFor(count),
    };
    const plan = optimizeStarts(input);
    assert.ok(
      notWorse(plan.forecast, plan.evenForecast),
      `day ${day}: ${JSON.stringify(score(plan.forecast))} vs ${JSON.stringify(score(plan.evenForecast))}`,
    );
  }
});

test("equal input gives equal starts", () => {
  const input: StartPlanInput = {
    interval: { start: S, end: E },
    accounts,
    rate,
    even,
  };
  assert.deepEqual(optimizeStarts(input).starts, optimizeStarts(input).starts);
});

test("planning stays fast with three, four and six accounts", () => {
  const timed = (input: StartPlanInput) => {
    const began = performance.now();
    const plan = optimizeStarts(input);
    return { plan, took: performance.now() - began };
  };
  const input = (list: typeof accounts, factor: number): StartPlanInput => ({
    interval: { start: S, end: E },
    accounts: list,
    rate: scaled(factor),
    even: evenFor(list.length),
  });

  const three = timed(input(accounts, 1));
  assert.ok(three.took < 200, `three accounts took ${three.took} ms`);

  const four = timed(input(withPro(1), 1.15));
  assert.ok(four.took < 200, `four accounts took ${four.took} ms`);

  const sixInput = input(withPro(3), 1.15);
  const six = timed(sixInput);
  assert.ok(six.took < 500, `six accounts took ${six.took} ms`);
  assert.equal(six.plan.starts.length, 6);
  for (const start of six.plan.starts)
    assert.equal(
      (start - (S - WINDOW_MS)) % (15 * MIN),
      0,
      `${hhmm(start)} is off the 15-minute grid`,
    );
  assert.deepEqual(optimizeStarts(sixInput).starts, six.plan.starts);
});
