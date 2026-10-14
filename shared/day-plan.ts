import type { Account, PlanningSettings } from "./types";
import { localDate, planCapacity, wallTime } from "./planning";
import {
  optimizeStarts,
  SIM_STEP_MS,
  type Forecast,
  type StartPlan,
} from "./capacity-plan";
import { tempoRate, type Tempo } from "./tempo";
import {
  WINDOW_MS,
  shiftDate,
  workInterval,
  type WorkInterval,
} from "./work-hours";

export {
  WINDOW_MS,
  shiftDate,
  isWeekend,
  workInterval,
  dayStart,
  type WorkInterval,
} from "./work-hours";

export interface PlannedWindow {
  start: number;
  end: number;
}
export interface AccountDayPlan {
  accountId: string;
  /** Warm-up time of the day's first window. */
  firstStart: number;
  /** The evenly spread warm-up the capacity-aware plan is compared with. */
  evenStart: number;
  manual: boolean;
  windows: PlannedWindow[];
  /** Relay keeps a window running between these times. */
  activeFrom: number;
  activeUntil: number;
}
export interface DayPlan {
  date: string;
  interval?: WorkInterval;
  accounts: AccountDayPlan[];
  /** The day simulated with the chosen first starts (shared; never mutate). */
  forecast?: Forecast;
  /** The day simulated with the even spread (shared; never mutate). */
  evenForecast?: Forecast;
}
/** What the plan needs beyond the settings: how big each account is and how fast quota goes. */
export interface PlanContext {
  /** planCapacity per account id; a missing id counts as 1. */
  capacities: Record<string, number>;
  tempo: Tempo;
}
export function planContext(accounts: Account[], tempo: Tempo): PlanContext {
  return {
    capacities: Object.fromEntries(
      accounts.map((a) => [a.id, planCapacity(a)]),
    ),
    tempo,
  };
}

const cycle = (value: number) => ((value % WINDOW_MS) + WINDOW_MS) % WINDOW_MS;
/**
 * Reset phases within the five-hour cycle. Without fixed phases they are spread
 * evenly; otherwise each free account takes the middle of the widest gap.
 */
export function cyclePhases(fixed: (number | undefined)[]): number[] {
  const count = fixed.length;
  if (fixed.every((phase) => phase === undefined))
    return fixed.map((_, index) => (WINDOW_MS * (index + 0.5)) / count);
  const phases = fixed.map((phase) =>
    phase === undefined ? undefined : cycle(phase),
  );
  const placed = phases
    .filter((phase): phase is number => phase !== undefined)
    .sort((a, b) => a - b);
  for (const [index, phase] of phases.entries()) {
    if (phase !== undefined) continue;
    let gapStart = 0,
      gap = -1;
    for (const [k, point] of placed.entries()) {
      const next =
        k + 1 < placed.length ? placed[k + 1] : placed[0] + WINDOW_MS;
      if (next - point > gap) {
        gap = next - point;
        gapStart = point;
      }
    }
    const chosen = cycle(gapStart + gap / 2);
    phases[index] = chosen;
    placed.push(chosen);
    placed.sort((a, b) => a - b);
  }
  return phases as number[];
}
const clockMinutes = (clock: string) =>
  Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
/**
 * A manual first start is the occurrence of its clock between five hours
 * before work and the end of work (earliest first), so a night shift's 00:30 is
 * that night. A clock with no useful occurrence — or one skipped by DST — keeps
 * its five-hour rhythm and warms up in the five hours before work.
 */
function manualStart(
  date: string,
  clock: string,
  interval: WorkInterval,
  startClock: string,
  zone: string,
) {
  const useful = [-1, 0, 1]
    .map((delta) => wallTime(shiftDate(date, delta), clock, zone))
    .filter(
      (time): time is number =>
        time !== undefined &&
        time > interval.start - WINDOW_MS &&
        time < interval.end,
    );
  if (useful.length) return Math.min(...useful);
  const phase = cycle(
    (clockMinutes(clock) - clockMinutes(startClock)) * 60_000,
  );
  return interval.start + phase - WINDOW_MS;
}
// Optimizing is the expensive part. It does not depend on live resets, and a
// day solved relative to its work start serves every date of the same shape:
// the same length, demand per simulation step, accounts and start offsets.
const CACHE_SIZE = 32;
/** Plans by day shape, in times relative to the work start. */
const shapeCache = new Map<string, StartPlan>();
/** Plans by date in absolute times, so a repeated call returns the same object. */
const dateCache = new Map<string, StartPlan>();
function remember(cache: Map<string, StartPlan>, key: string, plan: StartPlan) {
  cache.set(key, plan);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}
/** Forgets every cached optimization (tests compare cached and fresh plans). */
export function clearPlanCache() {
  shapeCache.clear();
  dateCache.clear();
}
const shifted = (forecast: Forecast, by: number): Forecast => ({
  ...forecast,
  segments: forecast.segments.map((s) => ({
    ...s,
    from: s.from + by,
    to: s.to + by,
  })),
  exhaustedAt: Object.fromEntries(
    Object.entries(forecast.exhaustedAt).map(([id, times]) => [
      id,
      times.map((time) => time + by),
    ]),
  ),
});
function plannedStarts(
  interval: WorkInterval,
  settings: PlanningSettings,
  context: PlanContext,
  manual: (number | undefined)[],
  even: number[],
): StartPlan {
  const accounts = settings.accounts.map((a, i) => ({
    id: a.id,
    capacity: context.capacities[a.id] ?? 1,
    ...(manual[i] !== undefined ? { manual: manual[i] } : {}),
  }));
  const profile = interval.weekend
    ? context.tempo.weekend
    : context.tempo.weekday;
  const dateKey = JSON.stringify([
    interval.start,
    interval.end,
    settings.timeZone,
    accounts,
    even,
    profile,
  ]);
  const known = dateCache.get(dateKey);
  if (known) return known;
  const origin = interval.start;
  const duration = interval.end - origin;
  // Demand per step from the work start; it carries the zone's offsets (DST).
  const rate = tempoRate(
    context.tempo,
    interval.weekend,
    settings.timeZone,
    origin,
    interval.end,
    SIM_STEP_MS,
  );
  const steps: number[] = [];
  for (let time = origin; time < interval.end; time += SIM_STEP_MS)
    steps.push(rate(time));
  const relative = accounts.map((a) =>
    a.manual === undefined ? a : { ...a, manual: a.manual - origin },
  );
  const offsets = even.map((start) => start - origin);
  const shapeKey = JSON.stringify([duration, steps, relative, offsets]);
  let shape = shapeCache.get(shapeKey);
  if (!shape) {
    shape = optimizeStarts({
      interval: { start: 0, end: duration },
      accounts: relative,
      even: offsets,
      rate: (time) => steps[Math.floor(time / SIM_STEP_MS)] ?? 0,
    });
    remember(shapeCache, shapeKey, shape);
  }
  const plan: StartPlan = {
    starts: shape.starts.map((start) => start + origin),
    forecast: shifted(shape.forecast, origin),
    evenForecast: shifted(shape.evenForecast, origin),
  };
  remember(dateCache, dateKey, plan);
  return plan;
}
/**
 * The day's warm-ups and windows per planned account. Automatic first starts
 * come from simulating the day by capacity and tempo; manual ones stay.
 */
export function dayPlan(
  date: string,
  settings: PlanningSettings,
  context: PlanContext,
  liveResets: Record<string, number | undefined> = {},
): DayPlan {
  const interval = workInterval(date, settings);
  if (!interval || !settings.accounts.length)
    return { date, interval, accounts: [] };
  const manual = settings.accounts.map((account) =>
    account.firstStart
      ? manualStart(
          date,
          account.firstStart,
          interval,
          (interval.weekend ? settings.weekend : settings.weekday).start,
          settings.timeZone,
        )
      : undefined,
  );
  const phases = cyclePhases(
    manual.map((start) =>
      start === undefined ? undefined : start + WINDOW_MS - interval.start,
    ),
  );
  const even = settings.accounts.map(
    (_, i) => manual[i] ?? interval.start + phases[i] - WINDOW_MS,
  );
  const planned = plannedStarts(interval, settings, context, manual, even);
  return {
    date,
    interval,
    forecast: planned.forecast,
    evenForecast: planned.evenForecast,
    accounts: settings.accounts.map((account, index) => {
      const firstStart = planned.starts[index];
      const windows: PlannedWindow[] = [];
      let cursor = firstStart;
      const live = liveResets[account.id];
      if (
        live !== undefined &&
        live > firstStart &&
        live - WINDOW_MS < interval.end
      ) {
        for (; cursor + WINDOW_MS <= live - WINDOW_MS; cursor += WINDOW_MS)
          windows.push({ start: cursor, end: cursor + WINDOW_MS });
        cursor = live - WINDOW_MS;
      }
      for (; cursor < interval.end; cursor += WINDOW_MS)
        windows.push({ start: cursor, end: cursor + WINDOW_MS });
      return {
        accountId: account.id,
        firstStart,
        evenStart: even[index],
        manual: manual[index] !== undefined,
        windows,
        activeFrom: firstStart,
        activeUntil: interval.end,
      };
    }),
  };
}
function plansAround(
  now: number,
  settings: PlanningSettings,
  context: PlanContext,
  deltas: number[],
) {
  const today = localDate(now, settings.timeZone);
  return deltas.map((delta) =>
    dayPlan(shiftDate(today, delta), settings, context),
  );
}
/** Whether Relay should keep a window running for this account now. */
export function shouldHaveWindow(
  accountId: string,
  now: number,
  settings: PlanningSettings,
  context: PlanContext,
) {
  return plansAround(now, settings, context, [-1, 0, 1]).some((plan) =>
    plan.accounts.some(
      (account) =>
        account.accountId === accountId &&
        now >= account.activeFrom &&
        now < account.activeUntil,
    ),
  );
}
export function nextPlannedStart(
  accountId: string,
  now: number,
  settings: PlanningSettings,
  context: PlanContext,
) {
  const starts = plansAround(
    now,
    settings,
    context,
    [0, 1, 2, 3, 4, 5, 6, 7],
  ).flatMap((plan) =>
    plan.accounts
      .filter((a) => a.accountId === accountId && a.activeFrom > now)
      .map((a) => a.activeFrom),
  );
  return starts.length ? Math.min(...starts) : undefined;
}
