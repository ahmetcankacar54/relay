import type { PlanningSettings } from "./types";
import { wallTime } from "./planning";

/** A Claude usage window lasts five hours from its first message. */
export const WINDOW_MS = 5 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface WorkInterval {
  date: string;
  start: number;
  end: number;
  weekend: boolean;
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
/** The first existing instant of a calendar day; DST can skip midnight. */
export function dayStart(date: string, zone: string) {
  for (const clock of ["00:00", "00:30", "01:00"]) {
    const time = wallTime(date, clock, zone);
    if (time !== undefined) return time;
  }
  return Date.parse(`${date}T00:00:00Z`);
}
