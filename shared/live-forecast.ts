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

/**
 * The rest of today's work from live usage: what happens if work goes on at
 * the planned tempo. Accounts with fresh usage start from their open window
 * (weekly limit used up: out of reach); the others from the plan's window
 * chain with a full quota. Closed windows warm up as planned when Relay keeps
 * them running (`autoStart`), else at first use.
 */
export function liveForecast({
  plan,
  settings,
  context,
  usage,
  activeId,
  now,
}: {
  plan: DayPlan;
  settings: PlanningSettings;
  context: PlanContext;
  usage: Record<string, AccountUsage>;
  /** The account Claude Desktop uses now; ignored unless it is planned. */
  activeId?: string;
  now: number;
}): Forecast | undefined {
  const interval = plan.interval;
  if (!interval || now >= interval.end || !plan.accounts.length) return;
  const from = Math.max(now, interval.start);
  const keepAlive = settings.autoStart;
  const accounts: SimAccount[] = plan.accounts.map((p) => {
    const capacity = context.capacities[p.accountId] ?? 1;
    const next = keepAlive
      ? p.windows.find((w) => w.start >= from)?.start
      : undefined;
    const closed = { warmUp: next };
    const u = usage[p.accountId];
    if (freshUsage(u, now)) {
      const reset = Date.parse(u.fiveHour?.resetsAt ?? "");
      const open = Number.isFinite(reset) && reset > from;
      const used = open ? (u.fiveHour?.usedPercent ?? 0) : 0;
      return {
        id: p.accountId,
        capacity,
        keepAlive,
        remaining: 100 * capacity * Math.max(0, 1 - used / 100),
        blocked: (u.sevenDay?.usedPercent ?? 0) >= 100,
        ...(open ? { firstReset: reset } : closed),
      };
    }
    const current = p.windows.find((w) => w.start <= from && w.end > from);
    return {
      id: p.accountId,
      capacity,
      keepAlive,
      remaining: 100 * capacity,
      ...(current ? { firstReset: current.end } : closed),
    };
  });
  return simulateDay({
    from,
    to: interval.end,
    accounts,
    rate: tempoRate(
      context.tempo,
      interval.weekend,
      settings.timeZone,
      from,
      interval.end,
      SIM_STEP_MS,
    ),
    ...(activeId && plan.accounts.some((a) => a.accountId === activeId)
      ? { active: activeId }
      : {}),
  });
}
