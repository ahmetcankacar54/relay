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
  planContext,
  shiftDate,
  type PlannedWindow,
  type WorkInterval,
} from "../../shared/day-plan";
import { localDate } from "../../shared/planning";
import { fallbackTempo, type Tempo } from "../../shared/tempo";
import type { Forecast, ForecastSegment } from "../../shared/capacity-plan";
import { liveForecast } from "../../shared/live-forecast";

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

/** A stretch of the usage lane; no `accountId` is an outage, `live` comes from live usage. */
export interface LaneSegment {
  accountId?: string;
  from: number;
  to: number;
  live: boolean;
}

/** Segments clipped to `[from, to)`. */
const clip = (
  segments: ForecastSegment[],
  from: number,
  to: number,
  live: boolean,
): LaneSegment[] =>
  segments
    .filter((s) => s.to > from && s.from < to)
    .map((s) => ({
      ...(s.accountId ? { accountId: s.accountId } : {}),
      from: Math.max(s.from, from),
      to: Math.min(s.to, to),
      live,
    }));

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
  /**
   * Who works when: the plans' forecasts clipped to the day; on today the
   * work interval under way is forecast from `now` with live usage.
   */
  lane: LaneSegment[];
  /** The day's own plan against the even spread, when some account is automatic. */
  compare?: { plan: Forecast; even: Forecast };
}

/**
 * The day `offset` days from today in the planning zone; live resets and the
 * live forecast apply to today only. Without a tempo the settings' fallback
 * tempo plans the day.
 */
export function dayTimeline({
  settings,
  accounts,
  usage,
  now,
  offset = 0,
  tempo,
  activeId,
}: {
  settings: PlanningSettings;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  now: number;
  offset?: number;
  tempo?: Tempo;
  /** The account Claude Desktop uses now (the live forecast starts with it). */
  activeId?: string;
}): DayTimeline {
  const zone = settings.timeZone;
  const planned = plannedSettings(settings, accounts);
  const context = planContext(accounts, tempo ?? fallbackTempo(settings));
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
    dayPlan(shiftDate(date, d), planned, context, offset === 0 ? live : {}),
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
  // Today the work interval under way goes on from now as live usage says.
  const current =
    offset === 0
      ? plans.find(
          ({ interval }) =>
            interval && interval.start <= now && now < interval.end,
        )
      : undefined;
  const rest =
    current &&
    liveForecast({
      plan: current,
      settings: planned,
      context,
      usage,
      activeId,
      now,
    });
  const lane = plans.flatMap((plan) => {
    const segments = plan.forecast?.segments ?? [];
    if (plan !== current || !rest)
      return clip(segments, dayBegin, dayEnd, false);
    return [
      ...clip(segments, dayBegin, Math.min(now, dayEnd), false),
      ...clip(rest.segments, dayBegin, dayEnd, true),
    ];
  });
  const own = plans[1];
  const compare =
    own.forecast && own.evenForecast && own.accounts.some((a) => !a.manual)
      ? { plan: own.forecast, even: own.evenForecast }
      : undefined;
  return {
    date,
    dayBegin,
    dayEnd,
    pct,
    intervals,
    rows,
    showNow: offset === 0 && now >= dayBegin && now < dayEnd,
    lane,
    ...(compare ? { compare } : {}),
  };
}

/**
 * The next planned start: the keeper's live view (actual resets) first, else
 * the plan for the coming week with the keeper's tempo (or the fallback).
 */
export function nextPlannedWindow(
  settings: PlanningSettings,
  accounts: Account[],
  keeper: KeeperSnapshot | undefined,
  now: number,
): { accountId: string; at: string } | undefined {
  if (keeper?.next) return keeper.next;
  const planned = plannedSettings(settings, accounts);
  const context = planContext(
    accounts,
    keeper?.tempo ?? fallbackTempo(settings),
  );
  const today = localDate(now, settings.timeZone);
  return [0, 1, 2, 3, 4, 5, 6, 7]
    .flatMap((d) => dayPlan(shiftDate(today, d), planned, context).accounts)
    .flatMap((a) =>
      a.windows.map((w) => ({ accountId: a.accountId, at: w.start })),
    )
    .filter((w) => w.at > now)
    .sort((a, b) => a.at - b.at)
    .map((w) => ({ ...w, at: new Date(w.at).toISOString() }))[0];
}

/** Timeline window colours, cycled per planned account (theme variables `--tone-1..4`). */
export const WINDOW_TONES = [
  "bg-tone-1",
  "bg-tone-2",
  "bg-tone-3",
  "bg-tone-4",
] as const;
export const windowTone = (index: number) =>
  WINDOW_TONES[index % WINDOW_TONES.length];
