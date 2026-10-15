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
 * would; the account in use then does not count.
 * Shared with the adaptive search.
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
  const accounts: SimAccount[] = plan.accounts.map((p) => {
    const capacity = context.capacities[p.accountId] ?? 1;
    const next = schedule?.[p.accountId];
    // The keeper starts a due window right away (inside its active range); a
    // scheduled start already past starts it now, too.
    const closed = {
      warmUp:
        next !== undefined
          ? Math.max(now, next)
          : keepAlive && now < p.activeUntil
            ? Math.max(now, p.activeFrom)
            : undefined,
    };
    const u = usage[p.accountId];
    if (freshUsage(u, now)) {
      const reset = Date.parse(u.fiveHour?.resetsAt ?? "");
      const open = Number.isFinite(reset) && reset > now;
      const used = open ? (u.fiveHour?.usedPercent ?? 0) : 0;
      return {
        id: p.accountId,
        capacity,
        keepAlive,
        remaining: 100 * capacity * Math.max(0, 1 - used / 100),
        blocked: (u.sevenDay?.usedPercent ?? 0) >= 100,
        ...(open
          ? {
              firstReset: reset,
              ...(next === undefined ? {} : { restartAt: next }),
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
  return {
    from,
    to: interval.end,
    accounts,
    rate: early ? (time) => (time < interval.start ? 0 : rate(time)) : rate,
    ...(activeId &&
    !early &&
    plan.accounts.some((a) => a.accountId === activeId)
      ? { active: activeId }
      : {}),
  };
}

/** The rest of today's work from live usage, simulated from `liveSetup`. */
export function liveForecast(input: LiveInput): Forecast | undefined {
  const setup = liveSetup(input);
  return setup && simulateDay(setup);
}
