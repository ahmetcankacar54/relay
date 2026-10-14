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
  // b runs dry exactly at the end of a step; that is still an exhaustion.
  assert.deepEqual(forecast.exhaustedAt.b.map(hhmm), ["09:55"]);
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
  // 100 units at 50 an hour run out on a step boundary, window after window;
  // the last one lands exactly on the end of the day.
  assert.deepEqual(forecast.exhaustedAt.pro.map(hhmm), [
    "11:00",
    "13:00",
    "18:00",
  ]);
});

test("a run-out exactly on a step boundary is recorded once", () => {
  const forecast = simulateDay({
    from: S,
    to: S + 3 * H,
    rate: () => 100,
    accounts: [{ id: "c", capacity: 1, keepAlive: false, remaining: 100 }],
  });
  assert.deepEqual(forecast.exhaustedAt.c.map(hhmm), ["10:00"]);
  assert.deepEqual(view(forecast), ["c 09:00-10:00", "outage 10:00-12:00"]);
});

test("running out exactly at its own reset keeps the account, at any time scale", () => {
  // b serves 11:00–13:00 and its window resets at 13:00: no switch to a and
  // back, whether times are absolute or relative to the work start.
  const run = (origin: number) =>
    simulateDay({
      from: origin,
      to: origin + 9 * H,
      rate: () => 50,
      accounts: [
        {
          id: "a",
          capacity: 1,
          firstReset: origin + 3 * H,
          keepAlive: true,
          remaining: 100,
        },
        {
          id: "b",
          capacity: 1,
          firstReset: origin + 4 * H,
          keepAlive: true,
          remaining: 100,
        },
      ],
    });
  const absolute = run(S);
  assert.deepEqual(view(absolute), [
    "a 09:00-11:00",
    "b 11:00-15:00",
    "a 15:00-18:00",
  ]);
  assert.equal(absolute.switches, 2);
  const relative = run(0);
  assert.equal(relative.switches, 2);
  assert.deepEqual(
    relative.segments.map((s) => [s.accountId, s.from + S, s.to + S]),
    absolute.segments.map((s) => [s.accountId, s.from, s.to]),
  );
});

test("a window that reset during the step is available when the active one runs dry", () => {
  // a runs out at 09:02:30; b's window reset at 09:02, mid-step.
  const forecast = sim(
    [
      {
        id: "a",
        capacity: 1,
        firstReset: base + 14 * H,
        keepAlive: false,
        remaining: 5,
      },
      {
        id: "b",
        capacity: 20,
        firstReset: S + 2 * MIN,
        keepAlive: false,
        remaining: 0,
      },
    ],
    () => 120,
  );
  assert.equal(forecast.outageMinutes, 0);
  assert.equal(forecast.unmet, 0);
  assert.deepEqual(view(forecast), ["a 09:00-09:03", "b 09:03-18:00"]);
  assert.deepEqual(forecast.exhaustedAt.a.map(hhmm), ["09:03"]);
  assert.equal(forecast.switches, 1);
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
  assert.deepEqual(forecast.exhaustedAt.c.map(hhmm), ["11:00", "16:00"]);
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

test("a gap covers only unmet demand, and a refill over lunch takes over at its reset", () => {
  // 60 an hour from 11:00 with lunch from 12:20 to 13:00; everything runs out
  // at 12:10 and `a` refills at 12:40, in the middle of lunch.
  const lunch = (time: number) =>
    time >= base + 12 * H + 20 * MIN && time < base + 13 * H ? 0 : 60;
  const day = (list: SimAccount[]) =>
    simulateDay({
      from: base + 11 * H,
      to: base + 15 * H,
      rate: lunch,
      accounts: list,
    });
  const gapMinutes = (forecast: Forecast) =>
    forecast.segments
      .filter((s) => !s.accountId)
      .reduce((sum, s) => sum + (s.to - s.from) / MIN, 0);
  const a = (reset: number): SimAccount => ({
    id: "a",
    capacity: 2,
    firstReset: reset,
    keepAlive: false,
    remaining: 70,
  });

  const refilled = day([a(base + 12 * H + 40 * MIN)]);
  assert.deepEqual(view(refilled), [
    "a 11:00-12:10",
    "outage 12:10-12:20",
    "a 12:40-15:00",
  ]);
  assert.equal(refilled.outageMinutes, 10);
  assert.equal(gapMinutes(refilled), refilled.outageMinutes);
  assert.equal(refilled.unmet, 10);
  assert.equal(refilled.switches, 0);

  // Still nothing when work resumes: a second gap until the refill.
  const late = day([a(base + 13 * H + 10 * MIN)]);
  assert.deepEqual(view(late), [
    "a 11:00-12:10",
    "outage 12:10-12:20",
    "outage 13:00-13:10",
    "a 13:10-15:00",
  ]);
  assert.equal(late.outageMinutes, 20);
  assert.equal(gapMinutes(late), late.outageMinutes);

  // Another account refilling over lunch is the switch, at its reset.
  const other = day([
    { ...a(base + 18 * H), remaining: 70 },
    {
      id: "b",
      capacity: 2,
      firstReset: base + 12 * H + 40 * MIN,
      keepAlive: false,
      remaining: 0,
    },
  ]);
  assert.deepEqual(view(other), [
    "a 11:00-12:10",
    "outage 12:10-12:20",
    "b 12:40-15:00",
  ]);
  assert.equal(other.switches, 1);
  assert.equal(gapMinutes(other), other.outageMinutes);
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

test("planning stays bounded with three, four and six accounts", () => {
  // The simulation reads the demand once per step, so demand reads bound the
  // simulations: a whole simulated day is `steps` reads.
  const steps = (E - S) / SIM_STEP_MS;
  const counted = (list: typeof accounts, factor: number) => {
    let reads = 0;
    const input: StartPlanInput = {
      interval: { start: S, end: E },
      accounts: list,
      rate: (time) => {
        reads++;
        return scaled(factor)(time);
      },
      even: evenFor(list.length),
    };
    const plan = optimizeStarts(input);
    return { input, plan, simulations: reads / steps };
  };
  const began = performance.now();

  // Every 15-minute combination, plus the even spread.
  const three = counted(accounts, 1);
  assert.ok(three.simulations >= 1, `${three.simulations}`);
  assert.ok(three.simulations <= 20 ** 3 + 1, `${three.simulations}`);

  // Every 30-minute combination, then four descent rounds from the best 8.
  const four = counted(withPro(1), 1.15);
  assert.ok(
    four.simulations <= 10 ** 4 + 1 + 8 * 4 * 4 * 19,
    `${four.simulations}`,
  );

  // Descent only: from the even and the proportional spread, then fine.
  const six = counted(withPro(3), 1.15);
  assert.ok(six.simulations < 1_000, `${six.simulations}`);
  // A loose canary for a per-simulation slowdown, not a speed budget.
  const took = performance.now() - began;
  assert.ok(took < 2_000, `planning took ${took} ms`);

  const sixInput = six.input;
  assert.equal(six.plan.starts.length, 6);
  for (const start of six.plan.starts)
    assert.equal(
      (start - (S - WINDOW_MS)) % (15 * MIN),
      0,
      `${hhmm(start)} is off the 15-minute grid`,
    );
  assert.deepEqual(optimizeStarts(sixInput).starts, six.plan.starts);
});

test("stopping a losing candidate early changes no plan", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const randomDays = Array.from({ length: 6 }, (_, day): StartPlanInput => {
    const hourly = Array.from({ length: 9 }, () => Math.round(random() * 400));
    const list = withPro(day % 3).slice(0, 1 + (day % 4));
    return {
      interval: { start: S, end: E },
      accounts: list,
      rate: (time) => hourly[Math.floor((time - S) / H)] ?? 0,
      even: evenFor(list.length),
    };
  });
  const inputs: StartPlanInput[] = [
    { interval: { start: S, end: E }, accounts, rate, even },
    {
      interval: { start: S, end: E },
      accounts: withPro(1),
      rate: scaled(1.15),
      even: evenFor(4),
    },
    {
      interval: { start: S, end: E },
      accounts: withPro(3),
      rate: scaled(1.15),
      even: evenFor(6),
    },
    {
      interval: { start: S, end: E },
      accounts: [
        { ...accounts[0], manual: base + 7 * H },
        ...accounts.slice(1),
      ],
      rate,
      even,
    },
    {
      interval: { start: S, end: E },
      accounts: [{ id: "pro", capacity: 1 }],
      rate: () => 50,
      even: [S - 2.5 * H],
    },
    // A whole day around the clock.
    {
      interval: { start: S, end: S + 24 * H },
      accounts: withPro(1),
      rate: flat(150),
      even: evenFor(4),
    },
    ...randomDays,
  ];
  let stopped = 0,
    whole = 0;
  for (const [index, input] of inputs.entries()) {
    const counting = (count: () => void) => ({
      ...input,
      rate: (time: number) => {
        count();
        return input.rate(time);
      },
    });
    const early = optimizeStarts(counting(() => stopped++));
    const full = optimizeStarts({
      ...counting(() => whole++),
      earlyStop: false,
    });
    assert.deepEqual(early, full, `input ${index}`);
  }
  assert.ok(stopped < whole, `${stopped} demand reads vs ${whole}`);
});
