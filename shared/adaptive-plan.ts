import type { Account, PlanningSettings } from "./types";
import { planCapacity } from "./planning";
import { tempoAt, type Tempo } from "./tempo";
import {
  MAX_USAGE_GAP_MS,
  identityOwners,
  type UsageSample,
} from "./usage-statistics";
import { sameReset, validWindow } from "./usage-rollups";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** How far back today's pace is measured. */
export const PACE_WINDOW_MS = HOUR_MS;
/** The plan never assumes more than three times its tempo. */
export const MAX_PACE = 3;
// Under this much observed time a rate would be noise, not a pace.
const MIN_OBSERVED_MS = 30 * MINUTE_MS;
const PLANNED_STEP_MS = 5 * MINUTE_MS;

/**
 * Pro units per hour in [from, to): increases over each five-hour window's
 * high-water mark between samples at most 35 minutes apart (the statistics
 * rule), times the owning account's plan capacity. Observed time is the
 * longest any identity was observed; under 30 minutes there is no rate.
 */
export function observedRate({
  samples,
  accounts,
  from,
  to,
}: {
  samples: UsageSample[];
  accounts: Account[];
  from: number;
  to: number;
}): number | undefined {
  const owners = identityOwners(accounts);
  const byIdentity = new Map<string, UsageSample[]>();
  for (const sample of samples) {
    const time = Date.parse(sample.checkedAt);
    if (!(time >= from && time < to) || !owners.has(sample.identity)) continue;
    const list = byIdentity.get(sample.identity) ?? [];
    list.push(sample);
    byIdentity.set(sample.identity, list);
  }
  let units = 0;
  let observedMs = 0;
  for (const [identity, list] of byIdentity) {
    list.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
    const capacity = planCapacity(owners.get(identity)!);
    let covered = 0;
    let high: { reset: string; used: number } | undefined;
    for (let i = 0; i < list.length; i++) {
      const sample = list[i];
      const previous = list[i - 1];
      const gap = previous
        ? Date.parse(sample.checkedAt) - Date.parse(previous.checkedAt)
        : Infinity;
      if (!validWindow(sample)) {
        high = undefined;
        continue;
      }
      const reset = sample.fiveHour!.resetsAt!;
      const used = sample.fiveHour!.usedPercent;
      if (gap <= MAX_USAGE_GAP_MS) covered += gap;
      if (gap <= MAX_USAGE_GAP_MS && high && sameReset(high.reset, reset)) {
        units += Math.max(0, used - high.used) * capacity;
        high = { reset, used: Math.max(high.used, used) };
      } else {
        // A new window, or a sample after a gap: only a new baseline.
        high = { reset, used };
      }
    }
    observedMs = Math.max(observedMs, covered);
  }
  if (observedMs < MIN_OBSERVED_MS) return;
  return units / (observedMs / HOUR_MS);
}

/** Mean Pro units per hour the tempo plans for [from, to), sampled every 5 minutes. */
export function plannedRate(
  tempo: Tempo,
  settings: PlanningSettings,
  from: number,
  to: number,
): number {
  let total = 0;
  let count = 0;
  for (let time = from; time < to; time += PLANNED_STEP_MS) {
    total += tempoAt(tempo, settings, time);
    count++;
  }
  return count ? total / count : 0;
}

/**
 * How many times faster than planned today is going: 1 (no faster, no
 * measurement, or nothing planned) up to MAX_PACE, in tenths.
 */
export function paceFactor(
  observed: number | undefined,
  planned: number,
): number {
  if (observed === undefined || planned < 1) return 1;
  return (
    Math.round(Math.min(MAX_PACE, Math.max(1, observed / planned)) * 10) / 10
  );
}
