import {
  simulateDay,
  SIM_STEP_MS,
  type Forecast,
  type SimAccount,
} from "./capacity-plan";
import type { DayPlan, PlanContext } from "./day-plan";
import { tempoRate } from "./tempo";
import type { AccountUsage, PlanningSettings } from "./types";
import { freshUsage } from "./usage";
import { sameReset } from "./usage-rollups";
import { WINDOW_MS } from "./work-hours";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
// A warm-up this recent counts at its planned time: the keeper's tick starts
// it a little late.
const ON_TIME_MS = 2 * MINUTE_MS;
const iso = (time: number) => new Date(time).toISOString();

export interface LiveSetup {
  from: number;
  to: number;
  accounts: SimAccount[];
  rate: (time: number) => number;
  active?: string;
}
export interface LiveInput {
  plan: DayPlan;
  settings: PlanningSettings;
  context: PlanContext;
  usage: Record<string, AccountUsage>;
  /** The account Claude Desktop uses now; ignored unless it is planned. */
  activeId?: string;
  now: number;
  /** Today's pace multiplier for the tempo (default 1). */
  factor?: number;
  /** accountId → next window start: an open window restarts then, a closed one starts then. */
  schedule?: Record<string, number>;
  /** Live times exactly as read: none counts as the plan's own nearby time. */
  exact?: boolean;
}

/**
 * The simulation inputs for the rest of today's work from live usage: what
 * happens if work goes on at the planned tempo (times `factor`). Accounts
 * with fresh usage start from their open window (weekly limit used up: out of
 * reach); the others from the plan's window chain with a full quota. With
 * `autoStart` a closed window starts when the keeper would start it (now, or
 * when the account's active range begins), else at first use; a `schedule`
 * entry holds an open window's restart, or starts a closed window, at its time
 * (now, if that has passed). Before work the day runs from now with no demand
 * until the work starts, so warm-ups and resets on the way happen as they
 * would; the account in use then does not count. During work the account in
 * use is read as of now: what the work since its read used (at the same
 * pace) comes off, so a read minutes old leaves no quota that is gone. A
 * window the keeper may not restart yet (it resets before the account's
 * active range) restarts when that range begins. Live times within a tick of
 * the plan's own windows (a warm-up just started, a reset within the reported
 * jitter) count as planned, unless `exact`. Shared with the adaptive search.
 */
export function liveSetup({
  plan,
  settings,
  context,
  usage,
  activeId,
  now,
  factor,
  schedule,
  exact,
}: LiveInput): LiveSetup | undefined {
  const interval = plan.interval;
  if (!interval || now >= interval.end || !plan.accounts.length) return;
  const early = now < interval.start;
  // Steps on the work start's five-minute grid, so the demand begins exactly
  // then (nothing happens between this and now).
  const from = early
    ? interval.start -
      Math.ceil((interval.start - now) / SIM_STEP_MS) * SIM_STEP_MS
    : now;
  const keepAlive = settings.autoStart;
  const base = tempoRate(
    context.tempo,
    interval.weekend,
    settings.timeZone,
    early ? interval.start : from,
    interval.end,
    SIM_STEP_MS,
  );
  const rate =
    factor === undefined || factor === 1
      ? base
      : (time: number) => factor * base(time);
  const active =
    !early && plan.accounts.some((a) => a.accountId === activeId)
      ? activeId
      : undefined;
  /** Pro units the work used from `checked` (or the work start) to now. */
  const usedSince = (checked: number) => {
    let units = 0;
    for (
      let time = Math.max(checked, interval.start);
      time < now;
      time += MINUTE_MS
    )
      units += (rate(time) * Math.min(MINUTE_MS, now - time)) / HOUR_MS;
    return units;
  };
  const accounts: SimAccount[] = plan.accounts.map((p) => {
    const capacity = context.capacities[p.accountId] ?? 1;
    const next = schedule?.[p.accountId];
    // The plan's own window boundary nearest `time`: the warm-up at
    // activeFrom, then every five hours.
    const planned = (time: number) =>
      p.activeFrom +
      Math.max(0, Math.round((time - p.activeFrom) / WINDOW_MS)) * WINDOW_MS;
    // The keeper starts a due window right away (inside its active range); a
    // scheduled start already past starts it now, too.
    const due = () => {
      if (now < p.activeFrom) return p.activeFrom;
      const start = planned(now);
      return !exact && start <= now && now - start < ON_TIME_MS ? start : now;
    };
    const closed = {
      warmUp:
        next !== undefined
          ? Math.max(now, next)
          : keepAlive && now < p.activeUntil
            ? due()
            : undefined,
    };
    const u = usage[p.accountId];
    if (freshUsage(u, now)) {
      const reported = Date.parse(u.fiveHour?.resetsAt ?? "");
      const open = Number.isFinite(reported) && reported > now;
      const used = open ? (u.fiveHour?.usedPercent ?? 0) : 0;
      const end = planned(reported);
      const reset =
        !exact &&
        end > Math.max(now, p.activeFrom) &&
        sameReset(iso(reported), iso(end))
          ? end
          : reported;
      const restartAt =
        next ?? (keepAlive && reset < p.activeFrom ? p.activeFrom : undefined);
      const left = 100 * capacity * Math.max(0, 1 - used / 100);
      return {
        id: p.accountId,
        capacity,
        keepAlive,
        remaining:
          open && p.accountId === active
            ? Math.max(0, left - usedSince(Date.parse(u.checkedAt!)))
            : left,
        blocked: (u.sevenDay?.usedPercent ?? 0) >= 100,
        ...(open
          ? {
              firstReset: reset,
              ...(restartAt === undefined ? {} : { restartAt }),
            }
          : closed),
      };
    }
    const current = p.windows.find((w) => w.start <= now && w.end > now);
    return {
      id: p.accountId,
      capacity,
      keepAlive,
      remaining: 100 * capacity,
      ...(current
        ? {
            firstReset: current.end,
            ...(next === undefined ? {} : { restartAt: next }),
          }
        : closed),
    };
  });
  return {
    from,
    to: interval.end,
    accounts,
    rate: early ? (time) => (time < interval.start ? 0 : rate(time)) : rate,
    ...(active ? { active } : {}),
  };
}

/** The rest of today's work from live usage, simulated from `liveSetup`. */
export function liveForecast(input: LiveInput): Forecast | undefined {
  const setup = liveSetup(input);
  return setup && simulateDay(setup);
}
