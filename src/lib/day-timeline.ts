// Pure day-timeline maths shared by the Planning page and the Overview "Bugün" card.
import type {
  Account,
  AccountUsage,
  KeeperSnapshot,
  PlanningSettings,
} from "../../shared/types";
import {
  dayPlan,
  dayStart,
  shiftDate,
  type PlannedWindow,
  type WorkInterval,
} from "../../shared/day-plan";
import { localDate } from "../../shared/planning";

/** Planned settings without deleted accounts; deleted accounts take no slot, exactly as in the window keeper. */
export function plannedSettings(
  settings: PlanningSettings,
  accounts: Account[],
): PlanningSettings {
  return {
    ...settings,
    accounts: settings.accounts.filter(({ id }) =>
      accounts.some((a) => a.id === id),
    ),
  };
}

/** Windows that touch the day, first occurrence of each start only (neighbouring days can repeat one). */
export function windowsInDay(
  lists: PlannedWindow[][],
  dayBegin: number,
  dayEnd: number,
): PlannedWindow[] {
  return lists
    .flat()
    .filter(
      (w, i, all) =>
        w.end > dayBegin &&
        w.start < dayEnd &&
        all.findIndex((x) => x.start === w.start) === i,
    );
}

export interface DayTimeline {
  date: string;
  dayBegin: number;
  dayEnd: number;
  /** Position of a time within the day, 0–100. */
  pct(time: number): number;
  /** Work intervals (from yesterday, today and tomorrow) that touch the day. */
  intervals: WorkInterval[];
  rows: { account: Account; windows: PlannedWindow[] }[];
  /** Whether `now` falls on the shown day (only on today's view). */
  showNow: boolean;
}

/** The day `offset` days from today in the planning zone; live resets apply to today only. */
export function dayTimeline({
  settings,
  accounts,
  usage,
  now,
  offset = 0,
}: {
  settings: PlanningSettings;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  now: number;
  offset?: number;
}): DayTimeline {
  const zone = settings.timeZone;
  const planned = plannedSettings(settings, accounts);
  const date = shiftDate(localDate(now, zone), offset);
  const dayBegin = dayStart(date, zone);
  const dayEnd = dayStart(shiftDate(date, 1), zone);
  const pct = (time: number) =>
    Math.min(100, Math.max(0, ((time - dayBegin) / (dayEnd - dayBegin)) * 100));
  const live = Object.fromEntries(
    Object.entries(usage).map(([id, u]) => [
      id,
      Date.parse(u.fiveHour?.resetsAt ?? "") || undefined,
    ]),
  );
  const plans = [-1, 0, 1].map((d) =>
    dayPlan(shiftDate(date, d), planned, offset === 0 ? live : {}),
  );
  const intervals = plans
    .map((p) => p.interval)
    .filter(
      (i): i is WorkInterval => !!i && i.end > dayBegin && i.start < dayEnd,
    );
  const rows = planned.accounts
    .map(({ id }) => accounts.find((a) => a.id === id))
    .filter((a): a is Account => !!a)
    .map((account) => ({
      account,
      windows: windowsInDay(
        plans.map((p) =>
          p.accounts
            .filter((a) => a.accountId === account.id)
            .flatMap((a) => a.windows),
        ),
        dayBegin,
        dayEnd,
      ),
    }));
  return {
    date,
    dayBegin,
    dayEnd,
    pct,
    intervals,
    rows,
    showNow: offset === 0 && now >= dayBegin && now < dayEnd,
  };
}

/** The next planned start: the keeper's live view (actual resets) first, else the plan for the coming week. */
export function nextPlannedWindow(
  settings: PlanningSettings,
  accounts: Account[],
  keeper: KeeperSnapshot | undefined,
  now: number,
): { accountId: string; at: string } | undefined {
  if (keeper?.next) return keeper.next;
  const planned = plannedSettings(settings, accounts);
  const today = localDate(now, settings.timeZone);
  return [0, 1, 2, 3, 4, 5, 6, 7]
    .flatMap((d) => dayPlan(shiftDate(today, d), planned).accounts)
    .flatMap((a) =>
      a.windows.map((w) => ({ accountId: a.accountId, at: w.start })),
    )
    .filter((w) => w.at > now)
    .sort((a, b) => a.at - b.at)
    .map((w) => ({ ...w, at: new Date(w.at).toISOString() }))[0];
}
