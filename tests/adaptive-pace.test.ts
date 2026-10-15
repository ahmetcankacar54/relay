import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PACE,
  PACE_WINDOW_MS,
  observedRate,
  paceFactor,
  plannedRate,
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
const rate = (samples: UsageSample[], from = FROM, to = TO) =>
  observedRate({ samples, accounts, from, to });

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

test("the pace factor is at least 1, at most 3, in tenths", () => {
  assert.equal(PACE_WINDOW_MS, 3_600_000);
  assert.equal(MAX_PACE, 3);
  assert.equal(paceFactor(undefined, 50), 1);
  assert.equal(paceFactor(80, 0.5), 1);
  assert.equal(paceFactor(40, 50), 1);
  assert.equal(paceFactor(80, 50), 1.6);
  assert.equal(paceFactor(500, 50), 3);
  assert.equal(paceFactor(63.3, 50), 1.3);
  // Anything that is not a finite measurement against a plan is no pace.
  assert.equal(paceFactor(NaN, 50), 1);
  assert.equal(paceFactor(Infinity, 50), 1);
  assert.equal(paceFactor(80, NaN), 1);
});

test("the planned rate is the mean of the tempo every five minutes", () => {
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
  assert.equal(plannedRate(tempo, settings, at("09:00"), at("10:00")), 220);
  assert.equal(plannedRate(tempo, settings, at("09:30"), at("10:30")), 231);
  // Nothing to average.
  assert.equal(plannedRate(tempo, settings, at("10:00"), at("10:00")), 0);
});
