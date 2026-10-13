import type { PlanningSettings } from "./types";
import { localDate, wallTime } from "./planning";

/** A Claude usage window lasts five hours from its first message. */
export const WINDOW_MS = 5 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface WorkInterval {
  date: string;
  start: number;
  end: number;
  weekend: boolean;
}
export interface PlannedWindow {
  start: number;
  end: number;
}
export interface AccountDayPlan {
  accountId: string;
  /** Warm-up time of the day's first window. */
  firstStart: number;
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
}

export function shiftDate(date: string, delta: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + delta * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
export function isWeekend(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
/** Work hours that start on `date`; an end at or before the start is the next day. */
export function workInterval(
  date: string,
  settings: PlanningSettings,
): WorkInterval | undefined {
  const weekend = isWeekend(date);
  const hours = weekend ? settings.weekend : settings.weekday;
  if (!hours.enabled) return;
  const start = wallTime(date, hours.start, settings.timeZone);
  const end = wallTime(
    hours.end <= hours.start ? shiftDate(date, 1) : date,
    hours.end,
    settings.timeZone,
  );
  if (start === undefined || end === undefined || end <= start) return;
  return { date, start, end, weekend };
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
/** A manual clock later than one window after work start means the evening before. */
function manualStart(
  date: string,
  clock: string,
  interval: WorkInterval,
  zone: string,
) {
  const same = wallTime(date, clock, zone);
  if (same !== undefined && same <= interval.start + WINDOW_MS) return same;
  return wallTime(shiftDate(date, -1), clock, zone);
}
export function dayPlan(
  date: string,
  settings: PlanningSettings,
  liveResets: Record<string, number | undefined> = {},
): DayPlan {
  const interval = workInterval(date, settings);
  if (!interval || !settings.accounts.length)
    return { date, interval, accounts: [] };
  const manual = settings.accounts.map((account) =>
    account.firstStart
      ? manualStart(date, account.firstStart, interval, settings.timeZone)
      : undefined,
  );
  const phases = cyclePhases(
    manual.map((start) =>
      start === undefined ? undefined : start + WINDOW_MS - interval.start,
    ),
  );
  return {
    date,
    interval,
    accounts: settings.accounts.map((account, index) => {
      const firstStart =
        manual[index] ?? interval.start + phases[index] - WINDOW_MS;
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
  deltas: number[],
) {
  const today = localDate(now, settings.timeZone);
  return deltas.map((delta) => dayPlan(shiftDate(today, delta), settings));
}
/** Whether Relay should keep a window running for this account now. */
export function shouldHaveWindow(
  accountId: string,
  now: number,
  settings: PlanningSettings,
) {
  return plansAround(now, settings, [-1, 0, 1]).some((plan) =>
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
) {
  const starts = plansAround(now, settings, [0, 1, 2, 3, 4, 5, 6, 7]).flatMap(
    (plan) =>
      plan.accounts
        .filter((a) => a.accountId === accountId && a.activeFrom > now)
        .map((a) => a.activeFrom),
  );
  return starts.length ? Math.min(...starts) : undefined;
}
