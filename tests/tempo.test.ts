import test from "node:test";
import assert from "node:assert/strict";
import {
  TEMPO_PRESETS,
  fallbackTempo,
  learnTempo,
  tempoAt,
  tempoRate,
} from "../shared/tempo";
import { localHour, wallTime } from "../shared/planning";
import { historyIdentity } from "../shared/usage-statistics";
import { emptyRollups, type UsageRollups } from "../shared/usage-rollups";
import { shiftDate } from "../shared/work-hours";
import {
  DEFAULT_PLANNING,
  type Account,
  type PlanningSettings,
} from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
const NOW = wallTime("2026-10-14", "10:00", ZONE)!;
const settings: PlanningSettings = {
  ...DEFAULT_PLANNING,
  timeZone: ZONE,
  weekday: { enabled: true, start: "09:00", end: "18:00" },
  weekend: { enabled: false, start: "11:00", end: "17:00" },
};
const base = planningAccount("pro", "pro");
const pro: Account = {
  ...base,
  auth: { ...base.auth!, loggedIn: true, accountUuid: "u", orgId: "o" },
};
const IDENTITY = historyIdentity(pro)!;
const max5: Account = { ...pro, planning: { plan: "max5", capacityWeight: 1 } };

// 2026-09-30 … 2026-10-13 without weekends (2026-10-14 is a Wednesday).
const WEEKDAYS: string[] = [];
for (let back = 1; WEEKDAYS.length < 10; back++) {
  const date = shiftDate("2026-10-14", -back);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day !== 0 && day !== 6) WEEKDAYS.push(date);
}

/** Writes one local-clock hour into the rollups of `identity`. */
function put(
  rollups: UsageRollups,
  identity: string,
  date: string,
  hour: number,
  points: number,
  coveredMinutes = 60,
) {
  const clock = `${String(hour).padStart(2, "0")}:00`;
  const key = new Date(wallTime(date, clock, ZONE)!).toISOString();
  (rollups.hours[identity] ??= {})[key] = {
    points,
    windows: 0,
    coveredMinutes,
  };
}
/** Day `i` (0 = the latest) spends 40 + 10·i points an hour from 09 to 17, hour 12 at half. */
function tenDays(identity = IDENTITY) {
  const rollups = emptyRollups();
  WEEKDAYS.forEach((date, i) => {
    for (let hour = 9; hour < 18; hour++)
      put(rollups, identity, date, hour, (40 + 10 * i) / (hour === 12 ? 2 : 1));
  });
  return rollups;
}
const learn = (rollups: UsageRollups, over: Partial<PlanningSettings> = {}) =>
  learnTempo({
    rollups,
    accounts: [pro],
    settings: { ...settings, ...over },
    now: NOW,
  });

test("ten weekdays give a learned busy-day rate shaped by the hour", () => {
  const tempo = learn(tenDays());
  assert.equal(tempo.source, "learned");
  assert.equal(tempo.rate.weekday, 101.5);
  assert.equal(tempo.weekday[9], 107.5);
  assert.equal(tempo.weekday[12], 53.8);
  // Outside work hours the busy-day rate is used instead of zero.
  assert.equal(tempo.weekday[20], 101.5);
  assert.deepEqual(tempo.days, { weekday: 10, weekend: 0 });
  assert.equal(tempo.weekday.length, 24);
  assert.deepEqual(tempo.weekend, Array(24).fill(101.5));
  assert.equal(tempo.rate.weekend, 101.5);
});

test("points are scaled to the observed minutes of each hour", () => {
  const rollups = emptyRollups();
  // 25 points over 30 observed minutes an hour: exactly half of every work
  // hour is covered (still enough to qualify), and the pace is 50 an hour.
  for (const date of WEEKDAYS)
    for (let hour = 9; hour < 18; hour++)
      put(rollups, IDENTITY, date, hour, 25, 30);
  const tempo = learn(rollups);
  assert.equal(tempo.source, "learned");
  assert.equal(tempo.rate.weekday, 50);
  assert.equal(tempo.weekday[10], 50);
  assert.equal(tempo.days.weekday, 10);
});

test("a day with under half of its work minutes observed is skipped", () => {
  const rollups = tenDays();
  // Keep only two of the nine hours (120 of 540 minutes) on the latest day.
  const date = WEEKDAYS[0];
  for (let hour = 11; hour < 18; hour++) {
    const clock = `${String(hour).padStart(2, "0")}:00`;
    delete rollups.hours[IDENTITY][
      new Date(wallTime(date, clock, ZONE)!).toISOString()
    ];
  }
  const tempo = learn(rollups);
  assert.equal(tempo.days.weekday, 9);
  assert.equal(tempo.source, "learned");
});

test("fewer than five qualifying weekdays fall back to the default tempo", () => {
  const rollups = emptyRollups();
  WEEKDAYS.slice(0, 4).forEach((date) => {
    for (let hour = 9; hour < 18; hour++)
      put(rollups, IDENTITY, date, hour, 80);
  });
  const tempo = learn(rollups);
  assert.equal(tempo.source, "default");
  assert.deepEqual(tempo.weekday, Array(24).fill(50));
  assert.deepEqual(tempo.weekend, Array(24).fill(50));
  assert.deepEqual(tempo.days, { weekday: 4, weekend: 0 });
});

test("a weekend-only schedule learns the weekend and uses its rate on weekdays", () => {
  // Six weekend days 09-26 … 10-11, 11:00–17:00, at 30 an hour and 60 at 13.
  const weekends: string[] = [];
  for (let back = 1; weekends.length < 6; back++) {
    const date = shiftDate("2026-10-14", -back);
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) weekends.push(date);
  }
  const rollups = emptyRollups();
  for (const date of weekends)
    for (let hour = 11; hour < 17; hour++)
      put(rollups, IDENTITY, date, hour, hour === 13 ? 60 : 30);
  const tempo = learn(rollups, {
    weekday: { enabled: false, start: "09:00", end: "18:00" },
    weekend: { enabled: true, start: "11:00", end: "17:00" },
  });
  assert.equal(tempo.source, "learned");
  assert.deepEqual(tempo.days, { weekday: 0, weekend: 6 });
  assert.deepEqual(tempo.rate, { weekday: 35, weekend: 35 });
  assert.equal(tempo.weekend[13], 60);
  assert.equal(tempo.weekend[11], 30);
  assert.equal(tempo.weekend[20], 35);
  assert.deepEqual(tempo.weekday, Array(24).fill(35));
  // Four weekend days are not enough either.
  const thin = emptyRollups();
  for (const date of weekends.slice(0, 4))
    for (let hour = 11; hour < 17; hour++) put(thin, IDENTITY, date, hour, 30);
  assert.equal(
    learn(thin, {
      weekday: { enabled: false, start: "09:00", end: "18:00" },
      weekend: { enabled: true, start: "11:00", end: "17:00" },
    }).source,
    "default",
  );
});

test("points count at the account's plan capacity, and unknown identities at 1", () => {
  const rollups = emptyRollups();
  for (const date of WEEKDAYS)
    for (let hour = 9; hour < 18; hour++)
      put(rollups, IDENTITY, date, hour, 60);
  assert.equal(learn(rollups).rate.weekday, 60);
  const big = learnTempo({ rollups, accounts: [max5], settings, now: NOW });
  assert.equal(big.rate.weekday, 300);
  assert.equal(big.weekday[10], 300);
  const stranger = learnTempo({ rollups, accounts: [], settings, now: NOW });
  assert.equal(stranger.rate.weekday, 60);
});

test("the tempo choice overrides learning, and the fallback follows the setting", () => {
  const heavy = learn(tenDays(), { tempo: "heavy" });
  assert.equal(heavy.source, "preset");
  assert.deepEqual(heavy.weekday, Array(24).fill(TEMPO_PRESETS.heavy));
  assert.deepEqual(heavy.weekend, Array(24).fill(120));
  assert.equal(heavy.rate.weekday, 120);
  const unset = fallbackTempo({ ...settings, tempo: undefined });
  assert.equal(unset.source, "default");
  assert.deepEqual(unset.weekday, Array(24).fill(50));
  const light = fallbackTempo({ ...settings, tempo: "light" });
  assert.equal(light.source, "preset");
  assert.deepEqual(light.weekday, Array(24).fill(20));
  assert.equal(fallbackTempo({ ...settings, tempo: "auto" }).source, "default");
});

test("an overnight interval is learned from the nights that have finished", () => {
  const night: Partial<PlanningSettings> = {
    weekday: { enabled: true, start: "22:00", end: "06:00" },
  };
  const rollups = emptyRollups();
  // Five finished nights starting 09-30 … 10-13 (weekdays only).
  WEEKDAYS.slice(0, 5).forEach((date) => {
    for (const hour of [22, 23]) put(rollups, IDENTITY, date, hour, 60);
    const next = shiftDate(date, 1);
    for (let hour = 0; hour < 6; hour++) put(rollups, IDENTITY, next, hour, 60);
  });
  // Tonight's interval (starts 10-14 22:00) is unfinished and holds noise.
  put(rollups, IDENTITY, "2026-10-14", 22, 999);
  const tempo = learn(rollups, night);
  assert.equal(tempo.source, "learned");
  assert.equal(tempo.rate.weekday, 60);
  assert.equal(tempo.weekday[23], 60);
  assert.equal(tempo.weekday[3], 60);
  // At 03:00 the 13th's night is still running, so only four nights count.
  const early = learnTempo({
    rollups,
    accounts: [pro],
    settings: { ...settings, ...night },
    now: wallTime("2026-10-14", "03:00", ZONE)!,
  });
  assert.equal(early.days.weekday, 4);
  assert.equal(early.source, "default");
});

test("tempoAt and tempoRate read the profile of the local day type and hour", () => {
  const tempo = learn(tenDays());
  const saturday = wallTime("2026-10-17", "12:00", ZONE)!;
  assert.equal(tempoAt(tempo, settings, saturday), tempo.weekend[12]);
  const wednesday = wallTime("2026-10-14", "12:00", ZONE)!;
  assert.equal(tempoAt(tempo, settings, wednesday), tempo.weekday[12]);
  const from = wallTime("2026-10-14", "09:00", ZONE)!;
  const to = wallTime("2026-10-14", "18:00", ZONE)!;
  const rate = tempoRate(tempo, false, ZONE, from, to, 300_000);
  for (let t = from; t < to; t += 300_000)
    assert.equal(rate(t), tempo.weekday[localHour(t, ZONE)]);
  const past = to + 2 * 3_600_000;
  assert.equal(rate(past), tempo.weekday[localHour(past, ZONE)]);
});
