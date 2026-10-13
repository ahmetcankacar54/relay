import {
  localDate,
  planningIdentity,
  validWorkday,
  wallTime,
} from "./planning";
import type { PlanningReason, WorkdayPlan } from "./planning";
import type { Account, AccountUsage, WorkdaySettings } from "./types";

const MINUTE = 60_000;
const DAY = 86_400_000;
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export interface ScheduleSegment {
  startMinute: number;
  endMinute: number;
  startsAt: string;
  endsAt: string;
}
export interface ScheduleEndpoint {
  at: string;
  clock: string;
  dayOffset: number;
}
export interface ScheduleProposal {
  start: ScheduleEndpoint;
  reset: ScheduleEndpoint;
  segments: ScheduleSegment[];
  reason?: PlanningReason;
}
export interface ScheduleLane {
  accountId: string;
  name: string;
  color: string;
  proposal?: ScheduleProposal;
  actualReset?: ScheduleEndpoint & { minute?: number };
}
export interface ScheduleDay {
  valid: boolean;
  date?: string;
  timeZone: string;
  isToday: boolean;
  startsAt?: string;
  endsAt?: string;
  elapsedHours?: number;
  nowMinute?: number;
  working: ScheduleSegment[];
  lanes: ScheduleLane[];
}

function shiftDate(date: string, delta: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + delta * DAY)
    .toISOString()
    .slice(0, 10);
}
function validDate(date: string) {
  const time = Date.parse(`${date}T12:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === date
  );
}
function parts(time: number, timeZone: string) {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    clockFormatters.set(timeZone, formatter);
  }
  return Object.fromEntries(
    formatter
      .formatToParts(new Date(time))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
}
function wallMinute(time: number, timeZone: string) {
  const p = parts(time, timeZone);
  return Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60;
}
function offset(time: number, timeZone: string) {
  const p = parts(time, timeZone);
  return (
    Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    ) -
    Math.floor(time / 1_000) * 1_000
  );
}
// Some zones advance their clocks at midnight. Find the first real minute of
// the civil day rather than borrowing the host machine's timezone.
function dayStart(date: string, timeZone: string) {
  for (let minute = 0; minute < 1_440; minute++) {
    const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const time = wallTime(date, clock, timeZone);
    if (time !== undefined) return time;
  }
}
function endpoint(
  time: number,
  date: string,
  timeZone: string,
): ScheduleEndpoint {
  const p = parts(time, timeZone);
  const civilDate = `${p.year}-${p.month}-${p.day}`;
  return {
    at: new Date(time).toISOString(),
    clock: `${p.hour}:${p.minute}`,
    dayOffset: Math.round(
      (Date.parse(`${civilDate}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) /
        DAY,
    ),
  };
}

// Each segment moves forward on a 00–24 wall-clock axis. Split at clock changes
// so a repeated hour overlaps honestly and a skipped hour is not fabricated.
export function projectDayInterval(
  startsAt: number,
  endsAt: number,
  date: string,
  timeZone: string,
): ScheduleSegment[] {
  try {
    if (
      !validDate(date) ||
      !Number.isFinite(startsAt) ||
      !Number.isFinite(endsAt) ||
      endsAt <= startsAt
    )
      return [];
    const lower = dayStart(date, timeZone);
    const upper = dayStart(shiftDate(date, 1), timeZone);
    if (lower === undefined || upper === undefined) return [];
    const start = Math.max(startsAt, lower);
    const end = Math.min(endsAt, upper);
    if (end <= start) return [];
    const cuts = [start];
    for (let probe = start; probe < end;) {
      const next = Math.min(end, probe + 60 * MINUTE);
      if (offset(probe, timeZone) !== offset(next, timeZone)) {
        let left = probe;
        let right = next;
        while (right - left > 1) {
          const middle = Math.floor((left + right) / 2);
          if (offset(middle, timeZone) === offset(probe, timeZone))
            left = middle;
          else right = middle;
        }
        if (right < end && right > cuts.at(-1)!) cuts.push(right);
      }
      probe = next;
    }
    cuts.push(end);
    return cuts.slice(0, -1).flatMap((startTime, index) => {
      const endTime = cuts[index + 1];
      const startMinute =
        startTime === lower
          ? wallMinute(lower, timeZone)
          : wallMinute(startTime, timeZone);
      // Use the previous offset at a transition. Looking at the transition's
      // new clock would stretch or reverse the preceding segment.
      const endMinute =
        endTime === upper
          ? 1_440
          : wallMinute(endTime - 1_000, timeZone) + 1 / 60;
      return endMinute > startMinute
        ? [
            {
              startMinute,
              endMinute,
              startsAt: new Date(startTime).toISOString(),
              endsAt: new Date(endTime).toISOString(),
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

function freshReset(
  account: Account,
  usage: AccountUsage | undefined,
  now: number,
) {
  if (
    !planningIdentity(account) ||
    !usage ||
    usage.accountId !== account.id ||
    usage.status !== "ready" ||
    usage.stale ||
    usage.issue ||
    !usage.checkedAt ||
    !usage.fiveHour?.resetsAt ||
    !Number.isFinite(usage.fiveHour.usedPercent) ||
    usage.fiveHour.usedPercent < 0 ||
    usage.fiveHour.usedPercent > 100
  )
    return;
  const checked = Date.parse(usage.checkedAt);
  const reset = Date.parse(usage.fiveHour.resetsAt);
  if (
    !Number.isFinite(checked) ||
    checked > now ||
    now - checked >= 5 * MINUTE ||
    !Number.isFinite(reset) ||
    reset <= now
  )
    return;
  return reset;
}

export function dailySchedule(
  accounts: Account[],
  usage: Record<string, AccountUsage>,
  workday: WorkdaySettings,
  plan: WorkdayPlan,
  now = Date.now(),
  displayDate?: string,
): ScheduleDay {
  const empty: ScheduleDay = {
    valid: false,
    timeZone: workday.timeZone,
    isToday: false,
    working: [],
    lanes: [],
  };
  try {
    if (
      !validWorkday(workday) ||
      !workday.weekdays.length ||
      !Number.isFinite(now)
    )
      return empty;
    if (displayDate !== undefined && !validDate(displayDate)) return empty;
    const today = localDate(now, workday.timeZone);
    // An overnight plan can be anchored yesterday. The graphic remains on
    // today's calendar day; a future plan instead reveals its next anchor day.
    const date =
      displayDate ??
      (plan.date && validDate(plan.date) && plan.date > today
        ? plan.date
        : today);
    const lower = dayStart(date, workday.timeZone);
    const upper = dayStart(shiftDate(date, 1), workday.timeZone);
    if (lower === undefined || upper === undefined || upper <= lower)
      return empty;
    const working: ScheduleSegment[] = [];
    for (const anchor of [shiftDate(date, -1), date]) {
      if (
        !workday.weekdays.includes(new Date(`${anchor}T12:00:00Z`).getUTCDay())
      )
        continue;
      const start = wallTime(anchor, workday.start, workday.timeZone);
      const end = wallTime(
        workday.end <= workday.start ? shiftDate(anchor, 1) : anchor,
        workday.end,
        workday.timeZone,
      );
      if (start !== undefined && end !== undefined)
        working.push(...projectDayInterval(start, end, date, workday.timeZone));
    }
    const lanes = [...new Set(workday.accountIds)].flatMap((id) => {
      const account = accounts.find((a) => a.id === id);
      if (!account) return [];
      const lane: ScheduleLane = {
        accountId: id,
        name: account.name,
        color: account.color,
      };
      const slot = plan.slots.find((s) => s.accountId === id);
      if (slot) {
        const start = Date.parse(slot.scheduledAt);
        const reset = Date.parse(slot.expectedResetAt);
        if (Number.isFinite(start) && Number.isFinite(reset) && reset > start)
          lane.proposal = {
            start: endpoint(start, date, workday.timeZone),
            reset: endpoint(reset, date, workday.timeZone),
            segments: projectDayInterval(start, reset, date, workday.timeZone),
            reason: slot.reason,
          };
      }
      const reset = freshReset(account, usage[id], now);
      if (reset !== undefined) {
        lane.actualReset = endpoint(reset, date, workday.timeZone);
        if (reset >= lower && reset < upper)
          lane.actualReset.minute = wallMinute(reset, workday.timeZone);
      }
      return [lane];
    });
    return {
      valid: true,
      date,
      timeZone: workday.timeZone,
      isToday: date === today,
      startsAt: new Date(lower).toISOString(),
      endsAt: new Date(upper).toISOString(),
      elapsedHours: (upper - lower) / (60 * MINUTE),
      nowMinute: date === today ? wallMinute(now, workday.timeZone) : undefined,
      working,
      lanes,
    };
  } catch {
    return empty;
  }
}
