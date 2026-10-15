import type { Account, PlanningSettings } from "./types";
import { simulateDay, type Forecast, type SimAccount } from "./capacity-plan";
import { liveSetup, type LiveInput } from "./live-forecast";
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
// Every zone's local hours begin on a quarter hour, so the tempo is constant
// within each.
const QUARTER_MS = 15 * MINUTE_MS;
/** How far back today's pace is measured. */
export const PACE_WINDOW_MS = HOUR_MS;
/** The plan never assumes more than three times its tempo. */
export const MAX_PACE = 3;
/**
 * Under this many times the planned rate the day is on plan: whole-percent
 * reads and the minutes between them are this coarse.
 */
export const PACE_DEAD_BAND = 1.2;
// Under this much observed time a rate would be noise, not a pace.
const MIN_OBSERVED_MS = 30 * MINUTE_MS;

/** A stretch of time: `from` inclusive, `to` exclusive. */
export interface Span {
  from: number;
  to: number;
}
interface Observation {
  /** Pro units used. */
  units: number;
  /**
   * How far whole-percent reads may put `units` off: a percent of each
   * window whose use rose (its first and highest reads are each rounded).
   */
  resolution: number;
  /** How long any identity was observed. */
  observedMs: number;
  /** When any identity was observed, earliest first, apart. */
  spans: Span[];
}

/**
 * Pro units used in [from, to): increases over each five-hour window's
 * high-water mark between samples at most 35 minutes apart (the statistics
 * rule), times the owning account's plan capacity. Observed time is every gap
 * of at most 35 minutes between an identity's samples, whatever the window (a
 * read without a usable window too), counted once where identities overlap:
 * every unit falls within it.
 */
function observe({
  samples,
  accounts,
  from,
  to,
}: {
  samples: UsageSample[];
  accounts: Account[];
  from: number;
  to: number;
}): Observation {
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
  let resolution = 0;
  const gaps: Span[] = [];
  for (const [identity, list] of byIdentity) {
    list.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
    const capacity = planCapacity(owners.get(identity)!);
    let high: { reset: string; used: number; rose?: boolean } | undefined;
    // A run of one window ends: a percent of it, if its use rose.
    const end = () => {
      if (high?.rose) resolution += capacity;
    };
    for (let i = 0; i < list.length; i++) {
      const sample = list[i];
      const time = Date.parse(sample.checkedAt);
      const before = i ? Date.parse(list[i - 1].checkedAt) : -Infinity;
      const gap = time - before;
      if (gap <= MAX_USAGE_GAP_MS) gaps.push({ from: before, to: time });
      // Without a usable window there is no baseline, so no increase either
      // here or at the next sample.
      if (!validWindow(sample)) {
        end();
        high = undefined;
        continue;
      }
      const reset = sample.fiveHour!.resetsAt!;
      const used = sample.fiveHour!.usedPercent;
      if (gap <= MAX_USAGE_GAP_MS && high && sameReset(high.reset, reset)) {
        units += Math.max(0, used - high.used) * capacity;
        high = {
          reset,
          used: Math.max(high.used, used),
          rose: high.rose || used > high.used,
        };
      } else {
        // A new window, or a sample after a gap: only a new baseline.
        end();
        high = { reset, used };
      }
    }
    end();
  }
  const spans: Span[] = [];
  for (const gap of gaps.sort((a, b) => a.from - b.from)) {
    const last = spans.at(-1);
    if (last && gap.from <= last.to) last.to = Math.max(last.to, gap.to);
    else spans.push({ ...gap });
  }
  const observedMs = spans.reduce((sum, s) => sum + s.to - s.from, 0);
  return { units, resolution, observedMs, spans };
}

/**
 * Mean Pro units per hour the tempo plans over `spans` (0 for none), exact:
 * each minute at its own local hour and day type.
 */
export function plannedRate(
  tempo: Tempo,
  settings: PlanningSettings,
  spans: Span[],
): number {
  let units = 0;
  let ms = 0;
  for (const span of spans) {
    for (let time = span.from; time < span.to;) {
      const next = Math.min(
        span.to,
        (Math.floor(time / QUARTER_MS) + 1) * QUARTER_MS,
      );
      units += (tempoAt(tempo, settings, time) * (next - time)) / HOUR_MS;
      time = next;
    }
    ms += Math.max(0, span.to - span.from);
  }
  return ms > 0 ? units / (ms / HOUR_MS) : 0;
}

/**
 * How many times faster than planned today is going: 1 (under 1.2 times the
 * plan, no usable measurement, or nothing planned) up to MAX_PACE, in tenths.
 */
export function paceFactor(
  observed: number | undefined,
  planned: number,
): number {
  if (observed === undefined || !Number.isFinite(observed) || !(planned >= 1))
    return 1;
  const ratio = observed / planned;
  if (!(ratio >= PACE_DEAD_BAND)) return 1;
  return Math.round(Math.min(MAX_PACE, ratio) * 10) / 10;
}

export interface Pace {
  /** Pro units an hour observed; absent under 30 observed minutes. */
  observed?: number;
  /** Pro units an hour the tempo plans over the same stretches. */
  planned: number;
  factor: number;
}
/**
 * Today's pace in [from, to): Pro units an hour observed (see `observe`)
 * against the tempo's over exactly the stretches observed, so time without a
 * read counts on neither side; under 30 observed minutes there is no rate.
 * Use above the plan by no more than the reads' rounding is no pace either
 * (early in the work a percent of a large window can be most of it).
 */
export function todaysPace({
  samples,
  accounts,
  tempo,
  settings,
  from,
  to,
}: {
  samples: UsageSample[];
  accounts: Account[];
  tempo: Tempo;
  settings: PlanningSettings;
  from: number;
  to: number;
}): Pace {
  const seen = observe({ samples, accounts, from, to });
  const planned = plannedRate(tempo, settings, seen.spans);
  if (seen.observedMs < MIN_OBSERVED_MS) return { planned, factor: 1 };
  const hours = seen.observedMs / HOUR_MS;
  const observed = seen.units / hours;
  return {
    observed,
    planned,
    factor:
      seen.units - planned * hours <= seen.resolution
        ? 1
        : paceFactor(observed, planned),
  };
}

/** The search starts from the default; an adopted schedule is not an input. */
export interface ReplanInput extends Omit<LiveInput, "schedule"> {
  factor: number;
  /** Accounts the keeper cannot start now (identity, weekly limit, policy stop, daily limit, auto start off). */
  blocked: string[];
}
export interface Replan {
  /** Only accounts whose next start differs from the default. */
  schedule: Record<string, number>;
  forecast: Forecast;
  defaultForecast: Forecast;
}

const HALF_HOUR = 30 * MINUTE_MS;
// Later starts tried per account besides the default.
const CHOICES = 10;
const ceilHalfHour = (t: number) => Math.ceil(t / HALF_HOUR) * HALF_HOUR;
// Up to this many accounts every combination is tried; more descend.
const EXHAUSTIVE = 4;
const ROUNDS = 4;

/**
 * The default first (restart at the reset, or when the account's active range
 * begins if that is later; or start now / at the active range), then later
 * half hours.
 */
export function nextStartCandidates(
  a: SimAccount,
  from: number,
  to: number,
): number[] {
  const open = a.firstReset !== undefined && a.firstReset > from;
  const base = open
    ? Math.max(a.firstReset!, a.restartAt ?? a.firstReset!)
    : (a.warmUp ?? from);
  const first = open
    ? base + HALF_HOUR
    : ceilHalfHour(base) === base
      ? base + HALF_HOUR
      : ceilHalfHour(base);
  const out = [base];
  for (let k = 0; k < CHOICES; k++) out.push(first + k * HALF_HOUR);
  return out.filter((t) => t < to);
}

/**
 * Re-chooses each startable account's next window start for the rest of
 * today at today's pace. The default (restart at reset, start a closed
 * window now) is always scored, so the result is never worse.
 */
export function replanStarts(input: ReplanInput): Replan | undefined {
  // A schedule carried along anyway would become the default.
  const setup = liveSetup({ ...input, schedule: undefined });
  if (!setup) return;
  const searchable = setup.accounts
    .filter((a) => a.keepAlive && !a.blocked && !input.blocked.includes(a.id))
    .map((a) => ({ a, choices: nextStartCandidates(a, setup.from, setup.to) }))
    // An account with no other start before the work end has nothing to choose.
    .filter(({ choices }) => choices.length > 1);
  const choices = searchable.map((s) => s.choices);
  const simulate = (picks: number[]) =>
    simulateDay({
      ...setup,
      accounts: setup.accounts.map((a) => {
        const at = searchable.findIndex((s) => s.a === a);
        if (at < 0 || picks[at] === choices[at][0]) return a;
        return a.firstReset !== undefined && a.firstReset > setup.from
          ? { ...a, restartAt: picks[at] }
          : { ...a, warmUp: picks[at] };
      }),
    });
  const score = (picks: number[]) => {
    const forecast = simulate(picks);
    const moved = picks.filter((p, k) => p !== choices[k][0]);
    return {
      picks,
      forecast,
      key: [
        Math.round(forecast.unmet * 2) / 2,
        forecast.switches,
        moved.length,
        picks.reduce((sum, p, k) => sum + (p - choices[k][0]), 0) / MINUTE_MS,
      ],
    };
  };
  type Scored = ReturnType<typeof score>;
  const better = (a: Scored, b: Scored) => {
    for (let i = 0; i < a.key.length; i++)
      if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i];
    return false;
  };
  const fallback = score(choices.map((c) => c[0]));
  let best = fallback;
  if (searchable.length <= EXHAUSTIVE) {
    const pick = (k: number, picks: number[]) => {
      if (k === searchable.length) {
        const s = score([...picks]);
        if (better(s, best)) best = s;
        return;
      }
      for (const c of choices[k]) {
        picks[k] = c;
        pick(k + 1, picks);
      }
    };
    pick(0, []);
  } else
    for (let round = 0; round < ROUNDS; round++) {
      let moved = false;
      for (let k = 0; k < searchable.length; k++)
        for (const c of choices[k]) {
          if (c === best.picks[k]) continue;
          const s = score(best.picks.map((p, j) => (j === k ? c : p)));
          if (better(s, best)) {
            best = s;
            moved = true;
          }
        }
      if (!moved) break;
    }
  const schedule: Record<string, number> = {};
  best.picks.forEach((p, k) => {
    if (p !== choices[k][0]) schedule[searchable[k].a.id] = p;
  });
  return {
    schedule,
    forecast: best.forecast,
    defaultForecast: fallback.forecast,
  };
}
