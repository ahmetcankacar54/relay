import type { PlanningSettings } from "./types";
import { localDate, wallTime } from "./planning";
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
