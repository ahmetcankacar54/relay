import type { Account, PlanningSettings, TempoChoice } from "./types";
import type { UsageRollups } from "./usage-rollups";
import { localDate, localHour, planCapacity } from "./planning";
import { identityOwners } from "./usage-statistics";
import { isWeekend, shiftDate, workInterval } from "./work-hours";

const HOUR_MS = 3_600_000;
export const TEMPO_PRESETS = { light: 20, medium: 50, heavy: 120 } as const;
const TEMPO_DAYS = 28;
const MIN_TEMPO_DAYS = 5;
const MIN_HOUR_COVERAGE = 15;
const BUSY_PERCENTILE = 0.75;

export interface Tempo {
  source: "learned" | "preset" | "default";
  /** 24 values, Pro units per hour by local clock hour. */
  weekday: number[];
  weekend: number[];
  /** Busy-day rate per day type. */
  rate: { weekday: number; weekend: number };
  /** Qualifying days used. */
  days: { weekday: number; weekend: number };
}

const flat = (rate: number) => Array.from({ length: 24 }, () => rate);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function presetTempo(
  choice: Exclude<TempoChoice, "auto">,
  source: Tempo["source"] = "preset",
  days: Tempo["days"] = { weekday: 0, weekend: 0 },
): Tempo {
  const rate = TEMPO_PRESETS[choice];
  return {
    source,
    weekday: flat(rate),
    weekend: flat(rate),
    rate: { weekday: rate, weekend: rate },
    days,
  };
}
/** What the renderer assumes until the main process reports a tempo. */
export function fallbackTempo(settings: PlanningSettings): Tempo {
  const choice = settings.tempo ?? "auto";
  return choice === "auto"
    ? presetTempo("medium", "default")
    : presetTempo(choice);
}

interface DaySample {
  rate: number;
  hours: Map<number, number>;
}

/**
 * Pro units per hour on a busy day (75th percentile of recent work days),
 * shaped by the hour of day. Unknown or thin history falls back to medium.
 * Hours outside the work interval carry the busy-day rate rather than 0, so a
 * just-edited interval never simulates zero demand before the tempo is
 * recomputed; the simulation only reads work hours.
 */
export function learnTempo({
  rollups,
  accounts,
  settings,
  now,
}: {
  rollups?: UsageRollups;
  accounts: Account[];
  settings: PlanningSettings;
  now: number;
}): Tempo {
  const choice = settings.tempo ?? "auto";
  if (choice !== "auto") return presetTempo(choice);
  const samples = rollups
    ? daySamples(rollups, accounts, settings, now)
    : { weekday: [], weekend: [] };
  const days = {
    weekday: samples.weekday.length,
    weekend: samples.weekend.length,
  };
  const learned = {
    weekday: profile(samples.weekday),
    weekend: profile(samples.weekend),
  };
  // A day type without its own profile runs flat at the other one's rate.
  const other = (p: { rate: number } | undefined) =>
    p && { rate: p.rate, values: flat(p.rate) };
  const weekday = learned.weekday ?? other(learned.weekend);
  const weekend = learned.weekend ?? other(learned.weekday);
  if (!weekday || !weekend) return presetTempo("medium", "default", days);
  return {
    source: "learned",
    weekday: weekday.values,
    weekend: weekend.values,
    rate: { weekday: weekday.rate, weekend: weekend.rate },
    days,
  };
}

function daySamples(
  rollups: UsageRollups,
  accounts: Account[],
  settings: PlanningSettings,
  now: number,
) {
  const capacity = new Map<string, number>();
  for (const [identity, account] of identityOwners(accounts))
    capacity.set(identity, planCapacity(account));
  // All identities polled together: Pro units add up, observed minutes do not.
  const merged = new Map<number, { units: number; covered: number }>();
  for (const [identity, hours] of Object.entries(rollups.hours)) {
    const cap = capacity.get(identity) ?? 1;
    for (const [key, hour] of Object.entries(hours)) {
      const time = Date.parse(key);
      if (!Number.isFinite(time)) continue;
      const entry = merged.get(time) ?? { units: 0, covered: 0 };
      entry.units += hour.points * cap;
      entry.covered = Math.max(entry.covered, hour.coveredMinutes);
      merged.set(time, entry);
    }
  }
  const out = { weekday: [] as DaySample[], weekend: [] as DaySample[] };
  const today = localDate(now, settings.timeZone);
  for (let back = 1; back <= TEMPO_DAYS; back++) {
    const interval = workInterval(shiftDate(today, -back), settings);
    if (!interval || interval.end > now) continue;
    let units = 0,
      covered = 0;
    const hours = new Map<number, number>();
    // UTC hour buckets whose middle falls inside the work interval.
    for (
      let time = Math.floor(interval.start / HOUR_MS) * HOUR_MS;
      time < interval.end;
      time += HOUR_MS
    ) {
      const middle = time + HOUR_MS / 2;
      if (middle < interval.start || middle >= interval.end) continue;
      const entry = merged.get(time);
      if (!entry) continue;
      units += entry.units;
      covered += entry.covered;
      if (entry.covered >= MIN_HOUR_COVERAGE)
        hours.set(
          localHour(middle, settings.timeZone),
          entry.units / (entry.covered / 60),
        );
    }
    if (covered < (interval.end - interval.start) / 60_000 / 2) continue;
    out[interval.weekend ? "weekend" : "weekday"].push({
      rate: units / (covered / 60),
      hours,
    });
  }
  return out;
}

function profile(samples: DaySample[]) {
  if (samples.length < MIN_TEMPO_DAYS) return;
  const rate = percentile(
    samples.map((s) => s.rate),
    BUSY_PERCENTILE,
  );
  if (rate < 1) return;
  const sums = Array<number>(24).fill(0),
    counts = Array<number>(24).fill(0);
  for (const s of samples) {
    if (s.rate <= 0) continue;
    for (const [hour, r] of s.hours) {
      sums[hour] += r / s.rate;
      counts[hour]++;
    }
  }
  const shape = sums.map((sum, h) => (counts[h] ? sum / counts[h] : undefined));
  const known = shape.filter((v): v is number => v !== undefined);
  const mean = known.length
    ? known.reduce((a, b) => a + b, 0) / known.length
    : 1;
  return {
    rate: round1(rate),
    values: shape.map((v) =>
      round1(rate * (v === undefined || mean <= 0 ? 1 : v / mean)),
    ),
  };
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = p * (sorted.length - 1);
  const low = Math.floor(position),
    high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Pro units per hour at `time`, by its local date's day type. */
export function tempoAt(
  tempo: Tempo,
  settings: PlanningSettings,
  time: number,
) {
  const weekend = isWeekend(localDate(time, settings.timeZone));
  return (
    (weekend ? tempo.weekend : tempo.weekday)[
      localHour(time, settings.timeZone)
    ] ?? 0
  );
}

/** Step-indexed rate lookup for a simulation starting at `from` (one Intl call per step, once). */
export function tempoRate(
  tempo: Tempo,
  weekend: boolean,
  zone: string,
  from: number,
  to: number,
  step: number,
) {
  const profile = weekend ? tempo.weekend : tempo.weekday;
  const table: number[] = [];
  for (let time = from; time < to; time += step)
    table.push(profile[localHour(time, zone)] ?? 0);
  return (time: number) =>
    table[Math.floor((time - from) / step)] ??
    profile[localHour(time, zone)] ??
    0;
}
