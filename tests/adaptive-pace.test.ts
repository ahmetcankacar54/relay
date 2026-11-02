import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PACE,
  PACE_DEAD_BAND,
  PACE_WINDOW_MS,
  paceFactor,
  plannedRate,
  todaysPace,
} from "../shared/adaptive-plan";
import { wallTime } from "../shared/planning";
import type { Tempo } from "../shared/tempo";
import { usageIdentity, type UsageSample } from "../shared/usage-statistics";
import {
  DEFAULT_PLANNING,
  type Account,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
const minute = 60_000;
const settings: PlanningSettings = {
  ...DEFAULT_PLANNING,
  timeZone: ZONE,
  weekday: { enabled: true, start: "09:00", end: "18:00" },
  weekend: { enabled: false, start: "11:00", end: "17:00" },
};
const at = (clock: string) => wallTime("2026-10-14", clock, ZONE)!;
const pro = planningAccount("pro", "pro");
const max5 = planningAccount("max", "max5");
const PRO = usageIdentity(pro)!;
const MAX = usageIdentity(max5)!;
const accounts = [pro, max5];
// Samples at 09:00, 09:05 … 10:00 are the last hour; `to` lies just past 10:00.
const FROM = at("09:00");
const TO = at("10:00") + 1;

/** One sample per `used` value, `step` minutes apart from `start`. */
function series(
  account: Account,
  start: number,
  used: number[],
  { reset = "2026-10-14T09:30:00.000Z", step = 5 } = {},
): UsageSample[] {
  return used.map((usedPercent, i) => ({
    accountId: account.id,
    identity: usageIdentity(account)!,
    checkedAt: new Date(start + i * step * minute).toISOString(),
    fiveHour: { usedPercent, resetsAt: reset },
  }));
}
/** 0 → `top` in 12 equal steps over the hour from 09:00 to 10:00. */
const hour = (account: Account, top: number, reset?: string) =>
  series(
    account,
    FROM,
    Array.from({ length: 13 }, (_, i) => (top * i) / 12),
    reset ? { reset } : undefined,
  );
const near = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${actual} is not ${expected}`,
  );
/** Every hour at `perHour` Pro units. */
const flatTempo = (perHour: number): Tempo => ({
  source: "learned",
  weekday: Array<number>(24).fill(perHour),
  weekend: Array<number>(24).fill(perHour),
  rate: { weekday: perHour, weekend: perHour },
  days: { weekday: 15, weekend: 2 },
});
const rate = (samples: UsageSample[], from = FROM, to = TO) =>
  todaysPace({
    samples,
    accounts,
    tempo: flatTempo(50),
    settings,
    from,
    to,
  }).observed;

test("a Pro account rising 30% in an hour is 30 Pro units an hour, a Max 5x 150", () => {
  assert.equal(rate(hour(pro, 30)), 30);
  assert.equal(rate(hour(max5, 30)), 150);
});

test("identities add their units but not their observed time", () => {
  assert.equal(rate([...hour(pro, 30), ...hour(max5, 30)]), 180);
});

test("a drop and a rise in one window count only above the high-water mark", () => {
  // 0, 10, 20, drop to 10, back to 15 (below the mark), then 25 (5 above).
  const samples = series(
    pro,
    FROM,
    [0, 10, 20, 10, 15, 25, 25, 25, 25, 25, 25, 25, 25],
  );
  assert.equal(rate(samples), 25);
});

test("a changed window is a new baseline, not a negative or a jump", () => {
  const first = series(pro, FROM, [0, 5, 10, 15, 15, 15, 15], {
    reset: "2026-10-14T09:30:00.000Z",
  });
  const next = (used: number[]) =>
    series(pro, FROM + 35 * minute, used, {
      reset: "2026-10-14T11:00:00.000Z",
    });
  // 15 units in the first window and 5 in the second, over 60 observed
  // minutes. A second window opening at 60% is not a jump of 45; one opening
  // at 2% is not a negative step that hides the 5 it then rises.
  assert.equal(rate([...first, ...next([60, 61, 62, 63, 64, 65])]), 20);
  assert.equal(rate([...first, ...next([2, 3, 4, 5, 6, 7])]), 20);
});

test("a reset time that drifts by under two minutes stays one window", () => {
  const samples = hour(pro, 30).map((sample, i) => ({
    ...sample,
    fiveHour: {
      ...sample.fiveHour!,
      resetsAt: new Date(
        Date.parse("2026-10-14T10:00:00.000Z") + (i % 2) * 90_000,
      ).toISOString(),
    },
  }));
  assert.equal(rate(samples), 30);
});

test("a gap of more than 35 minutes adds neither time nor units", () => {
  // 08:00–08:30 rises 30 over 30 minutes; the jump to 70 at 09:10 follows a
  // 40-minute gap; 09:10–09:40 rises 10 over 30 more minutes.
  const samples = [
    ...series(pro, at("08:00"), [0, 5, 10, 15, 20, 25, 30]),
    ...series(pro, at("09:10"), [70, 72, 74, 76, 78, 79, 80]),
  ];
  // 40 units over 60 observed minutes; the gap is neither time nor units.
  assert.equal(rate(samples, at("08:00"), at("10:00")), 40);
});

test("a gap of exactly 35 minutes still counts", () => {
  const samples = [
    ...series(pro, FROM, [0, 10]),
    ...series(pro, FROM + 40 * minute, [20, 30]),
  ];
  // 09:00 → 09:05 (+10), 09:05 → 09:40 (+10 above the mark), 09:40 → 09:45
  // (+10): 45 observed minutes, 30 units.
  assert.equal(rate(samples, FROM, FROM + 80 * minute), 30 / 0.75);
});

test("under 30 observed minutes there is no rate, at 30 there is", () => {
  assert.equal(rate(series(pro, FROM, [0, 5, 10, 15, 20, 25])), undefined);
  assert.equal(rate(series(pro, FROM, [0, 5, 10, 15, 20, 25, 30])), 60);
  assert.equal(rate([]), undefined);
});

test("only samples inside [from, to) are read", () => {
  const samples = hour(pro, 30);
  // A late sample past `to` and an early one before `from` change nothing.
  samples.push(...series(pro, at("10:30"), [90, 100]));
  samples.unshift(...series(pro, at("08:00"), [0, 40]));
  assert.equal(rate(samples), 30);
  // `to` is exclusive: the 09:50 sample, which would add 55 units, is out.
  const spike = series(pro, FROM, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 100]);
  assert.equal(rate(spike, FROM, at("09:50")), 60);
});

test("an identity with no current account is ignored", () => {
  const stranger = planningAccount("gone", "max20");
  assert.equal(rate(hour(stranger, 50)), undefined);
  assert.equal(rate([...hour(stranger, 50), ...hour(pro, 30)]), 30);
});

test("a sample without a usable window breaks the baseline but still counts as observed time", () => {
  const samples = series(pro, FROM, [0, 10, 12, 90, 95, 100, 100, 100]);
  // 09:10 reports a reset that already passed.
  samples[2] = {
    ...samples[2],
    fiveHour: { usedPercent: 12, resetsAt: "2026-10-14T05:00:00.000Z" },
  };
  // 0 → 10 counts; the 12 → 90 step is not seen as an increase, 90 → 100
  // counts. Every 5-minute gap is observed: 20 units over 35 minutes.
  near(rate(samples), (20 * 60) / 35);
});

test("an hour that turns from idle to active uses the whole hour as observed time", () => {
  // 09:00–09:25 idle (the window has no reset yet), then 09:30–10:00 rising
  // from 10 to 40. The first active sample is a baseline, so 30 units over
  // the 60 observed minutes (not over the 30 active ones).
  const idle = series(pro, FROM, [0, 0, 0, 0, 0, 0]).map((sample) => ({
    ...sample,
    fiveHour: { usedPercent: 0 },
  }));
  const active = series(pro, at("09:30"), [10, 15, 20, 25, 30, 35, 40]);
  assert.equal(rate([...idle, ...active]), 30);
});

test("the pace factor is 1 below 1.2 times the plan, then at most 3, in tenths", () => {
  assert.equal(PACE_WINDOW_MS, 3_600_000);
  assert.equal(MAX_PACE, 3);
  assert.equal(PACE_DEAD_BAND, 1.2);
  assert.equal(paceFactor(undefined, 50), 1);
  assert.equal(paceFactor(80, 0.5), 1);
  assert.equal(paceFactor(40, 50), 1);
  // Within the dead band whole-percent reads and timing are noise, not a pace.
  assert.equal(paceFactor(57, 50), 1);
  assert.equal(paceFactor(59.9, 50), 1);
  assert.equal(paceFactor(60, 50), 1.2);
  assert.equal(paceFactor(80, 50), 1.6);
  assert.equal(paceFactor(500, 50), 3);
  assert.equal(paceFactor(63.3, 50), 1.3);
  // Anything that is not a finite measurement against a plan is no pace.
  assert.equal(paceFactor(NaN, 50), 1);
  assert.equal(paceFactor(Infinity, 50), 1);
  assert.equal(paceFactor(80, NaN), 1);
});

test("the planned rate is the tempo's exact mean over the stretches given", () => {
  const profile = Array<number>(24).fill(0);
  profile[9] = 220;
  profile[10] = 242;
  const tempo: Tempo = {
    source: "learned",
    weekday: profile,
    weekend: profile,
    rate: { weekday: 242, weekend: 242 },
    days: { weekday: 10, weekend: 0 },
  };
  const planned = (...spans: [number, number][]) =>
    plannedRate(
      tempo,
      settings,
      spans.map(([from, to]) => ({ from, to })),
    );
  assert.equal(planned([at("09:00"), at("10:00")]), 220);
  near(planned([at("09:30"), at("10:30")]), 231);
  // Two stretches with a gap between them: only their minutes count.
  near(planned([at("09:00"), at("09:30")], [at("10:00"), at("10:30")]), 231);
  // Seconds past the minute, across the work start: 25 min 5 s at 220 of 30 min.
  const second = 1000;
  near(
    planned([at("08:55") + 5 * second, at("09:25") + 5 * second]),
    (220 * (25 * 60 + 5)) / (30 * 60),
  );
  // Nothing to average.
  assert.equal(planned(), 0);
  assert.equal(planned([at("10:00"), at("10:00")]), 0);
});

test("the planned rate follows each minute's own day type across midnight", () => {
  const weekday = Array<number>(24).fill(0);
  const weekend = Array<number>(24).fill(0);
  weekday[23] = 60;
  weekday[0] = 30;
  weekend[0] = 120;
  const tempo: Tempo = {
    source: "learned",
    weekday,
    weekend,
    rate: { weekday: 60, weekend: 120 },
    days: { weekday: 10, weekend: 4 },
  };
  const span = (date: string, next: string) => [
    {
      from: wallTime(date, "23:30", ZONE)!,
      to: wallTime(next, "00:30", ZONE)!,
    },
  ];
  // Friday 23:30 to Saturday 00:30: half an hour of each day's profile.
  assert.equal(
    plannedRate(tempo, settings, span("2026-10-16", "2026-10-17")),
    90,
  );
  // Tuesday to Wednesday: the weekday profile on both sides of midnight.
  assert.equal(
    plannedRate(tempo, settings, span("2026-10-13", "2026-10-14")),
    45,
  );
});

/**
 * One account's five-hour use read every five minutes, `offset` past the
 * minute, from `wake` until `until`, in whole percent: it serves `tempo` from
 * the work start at 09:00 (nothing before), in windows from 08:45 renewed every
 * five hours; the Mac sleeps through `sleep`.
 */
function calmReads(
  account: Account,
  tempo: Tempo,
  {
    wake,
    until,
    offset,
    sleep,
  }: { wake: number; until: number; offset: number; sleep?: [number, number] },
): UsageSample[] {
  const capacity = { pro: 1, max5: 5, max20: 20 }[
    account.planning!.plan as string
  ]!;
  const windowStart = (time: number) =>
    at("08:45") +
    Math.floor((time - at("08:45")) / (5 * 60 * minute)) * 5 * 60 * minute;
  const out: UsageSample[] = [];
  for (let time = wake + offset; time <= until; time += 5 * minute) {
    if (sleep && time >= sleep[0] && time < sleep[1]) continue;
    const start = windowStart(time);
    const units =
      plannedRate(tempo, settings, [
        { from: Math.max(start, at("09:00")), to: time },
      ]) *
      (Math.max(0, time - Math.max(start, at("09:00"))) / (60 * minute));
    out.push({
      accountId: account.id,
      identity: usageIdentity(account)!,
      checkedAt: new Date(time).toISOString(),
      fiveHour: {
        usedPercent: Math.min(100, Math.round(units / capacity)),
        resetsAt: new Date(start + 5 * 60 * minute).toISOString(),
      },
    });
  }
  return out;
}
/** A busy day's shape from 09:00 to 18:00, nothing outside, times `scale`. */
function busyTempo(scale: number): Tempo {
  const busy: Record<number, number> = {
    9: 180,
    10: 230,
    11: 250,
    12: 80,
    13: 170,
    14: 240,
    15: 230,
    16: 200,
    17: 140,
  };
  const profile = Array.from({ length: 24 }, (_, h) => (busy[h] ?? 0) * scale);
  return {
    source: "learned",
    weekday: profile,
    weekend: profile,
    rate: { weekday: 250 * scale, weekend: 250 * scale },
    days: { weekday: 15, weekend: 2 },
  };
}

test("today's pace compares the observed rate with the plan over the same stretches", () => {
  // Awake from 08:55, a Pro used at the planned 120 an hour from 09:00.
  const p = planningAccount("p", "pro");
  const tempo = flatTempo(120);
  tempo.weekday = tempo.weekday.map((r, h) => (h >= 9 && h < 18 ? r : 0));
  const now = at("09:25");
  const pace = todaysPace({
    samples: calmReads(p, tempo, { wake: at("08:55"), until: now, offset: 0 }),
    accounts: [p],
    tempo,
    settings,
    from: now - PACE_WINDOW_MS,
    to: now + 1,
  });
  // 50 units over the 30 observed minutes, as planned over those 30 minutes
  // (25 of them at 120), not over the whole hour.
  assert.deepEqual(pace, { observed: 100, planned: 100, factor: 1 });
  // Under 30 observed minutes: no observed rate, and the plan's pace.
  const early = todaysPace({
    samples: calmReads(p, tempo, { wake: at("09:00"), until: now, offset: 0 }),
    accounts: [p],
    tempo,
    settings,
    from: now - PACE_WINDOW_MS,
    to: now + 1,
  });
  assert.equal(early.observed, undefined);
  assert.equal(early.factor, 1);
});

test("use above the plan by no more than a percent of each window that rose is no pace", () => {
  // A Max 20× planned at 180 an hour from 09:00, read every five minutes
  // overnight. By 09:10 the plan has used 30 Pro units (1.5%).
  const x = planningAccount("x", "max20");
  const tempo = flatTempo(180);
  tempo.weekday = tempo.weekday.map((r, h) => (h >= 9 && h < 18 ? r : 0));
  const now = at("09:10");
  const reads = (late: number[]) =>
    series(x, at("08:10"), [...Array<number>(11).fill(0), ...late], {
      reset: "2026-10-14T10:45:00.000Z",
    });
  const pace = (samples: UsageSample[]) =>
    todaysPace({
      samples,
      accounts: [x],
      tempo,
      settings,
      from: now - PACE_WINDOW_MS,
      to: now + 1,
    });
  // Read as 2% (40 units, 1.33 times the plan): a percent is 20 units, so
  // the 10 above the plan are rounding.
  assert.deepEqual(pace(reads([1, 2])), {
    observed: 40,
    planned: 30,
    factor: 1,
  });
  // 3% (60 units) is 30 above: twice the plan.
  assert.deepEqual(pace(reads([2, 3])), {
    observed: 60,
    planned: 30,
    factor: 2,
  });
});

test("calm use read every five minutes in whole percent keeps the pace at 1, minute by minute", () => {
  const cases: [Account, number][] = [
    [planningAccount("p", "pro"), 0.1],
    [planningAccount("p", "pro"), 0.11],
    [planningAccount("m", "max5"), 0.45],
    [planningAccount("m", "max5"), 0.5],
    [planningAccount("x", "max20"), 1],
    [planningAccount("x", "max20"), 2],
  ];
  const nights: [string, number, [number, number]?][] = [
    ["overnight", at("03:00")],
    ["awake from 08:30", at("08:30")],
    ["awake from 08:40", at("08:40")],
    ["awake from 08:50", at("08:50")],
    ["asleep over lunch", at("03:00"), [at("12:00"), at("13:00")]],
  ];
  for (const [account, scale] of cases)
    for (const [label, wake, sleep] of nights)
      for (const offset of [0, 1, 2, 3, 4].map((m) => m * minute + 5_000)) {
        const tempo = busyTempo(scale);
        const samples = calmReads(account, tempo, {
          wake,
          until: at("15:00"),
          offset,
          sleep,
        });
        for (let now = at("09:00"); now <= at("15:00"); now += minute) {
          if (sleep && now >= sleep[0] && now < sleep[1]) continue;
          const pace = todaysPace({
            samples: samples.filter((s) => Date.parse(s.checkedAt) <= now),
            accounts: [account],
            tempo,
            settings,
            from: now - PACE_WINDOW_MS,
            to: now + 1,
          });
          assert.equal(
            pace.factor,
            1,
            `${account.planning!.plan} ×${scale} ${label} +${offset / 1000}s at ${new Date(now).toISOString()}: ${pace.observed} / ${pace.planned}`,
          );
        }
      }
});
