import type { Account, AccountUsage, WorkdaySettings } from "./types";
import { maxUsedPercent, quotaWindows } from "./usage";

export type PlanningReason =
  | "not-selected"
  | "auth-required"
  | "identity-mismatch"
  | "duplicate-identity"
  | "cooldown"
  | "usage-not-fresh"
  | "usage-incomplete"
  | "reserve"
  | "already-active"
  | "outside-workday";
export interface AccountRanking {
  accountId: string;
  capacity: number;
  score: number;
  remainingPercent?: number;
  reason?: PlanningReason;
}
export interface WorkdaySlot {
  accountId: string;
  scheduledAt: string;
  expectedResetAt: string;
  reason?: PlanningReason;
}
export interface WorkdayPlan {
  date?: string;
  startsAt?: string;
  endsAt?: string;
  rankings: AccountRanking[];
  slots: WorkdaySlot[];
  approximate: true;
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dateFormatters.set(timeZone, f);
  }
  return f;
}
function localParts(time: number, timeZone: string) {
  return Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(time))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
}
export function localDate(time: number, timeZone: string) {
  const p = localParts(time, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
function nextDate(date: string, delta = 1) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + delta * DAY)
    .toISOString()
    .slice(0, 10);
}
// Resolve wall times using the zone's actual offsets on either side of a DST
// transition. A nonexistent time is skipped; an ambiguous time uses its first
// occurrence so no quota-consuming job can run twice in the repeated hour.
export function wallTime(date: string, clock: string, timeZone: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)
  )
    return;
  const nominal = Date.parse(`${date}T${clock}:00Z`);
  if (!Number.isFinite(nominal)) return;
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = nominal + delta * HOUR;
    const p = localParts(probe, timeZone);
    offsets.add(
      Date.parse(
        `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
      ) - probe,
    );
  }
  const matches = [...offsets]
    .map((offset) => nominal - offset)
    .filter((candidate) => {
      const p = localParts(candidate, timeZone);
      return (
        `${p.year}-${p.month}-${p.day}` === date &&
        `${p.hour}:${p.minute}` === clock
      );
    });
  return matches.length ? Math.min(...matches) : undefined;
}
export function validWorkday(w: WorkdaySettings) {
  try {
    formatter(w.timeZone);
    return (
      /^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(w.end) &&
      w.weekdays.every(
        (day) => Number.isInteger(day) && day >= 0 && day <= 6,
      ) &&
      Number.isInteger(w.reservePercent) &&
      w.reservePercent >= 0 &&
      w.reservePercent <= 50 &&
      Number.isInteger(w.staggerMinutes) &&
      w.staggerMinutes >= 0 &&
      w.staggerMinutes <= 300 &&
      (!w.routineEnabled ||
        new Set(w.accountIds).size <= 1 ||
        w.staggerMinutes >= 1) &&
      Number.isInteger(w.warmupLeadMinutes) &&
      w.warmupLeadMinutes >= 0 &&
      w.warmupLeadMinutes <= 300
    );
  } catch {
    return false;
  }
}
export function planningIdentity(a: Account) {
  if (!a.auth?.loggedIn || !a.auth.accountUuid || !a.auth.orgId) return;
  if (
    a.desktop &&
    (a.auth.accountUuid !== a.desktop.accountUuid ||
      a.auth.orgId !== a.desktop.orgId)
  )
    return;
  return `${a.auth.accountUuid}:${a.auth.orgId}`;
}
export function planCapacity(a: Account) {
  switch (a.planning?.plan) {
    case "pro":
      return 1;
    case "max5":
      return 5;
    case "max20":
      return 20;
    default: {
      const weight = a.planning?.capacityWeight ?? 1;
      return Number.isFinite(weight) ? Math.min(100, Math.max(1, weight)) : 1;
    }
  }
}
export function quotaPlanningReason(
  a: Account,
  u: AccountUsage | undefined,
  reserve: number,
  now: number,
): PlanningReason | undefined {
  if (!a.auth?.loggedIn || !a.auth.accountUuid || !a.auth.orgId)
    return "auth-required";
  if (!planningIdentity(a)) return "identity-mismatch";
  if (
    a.cooldownUntil &&
    (!Number.isFinite(Date.parse(a.cooldownUntil)) ||
      Date.parse(a.cooldownUntil) > now)
  )
    return "cooldown";
  if (
    !u ||
    u.accountId !== a.id ||
    u.status !== "ready" ||
    u.stale ||
    !u.checkedAt ||
    !Number.isFinite(Date.parse(u.checkedAt)) ||
    Date.parse(u.checkedAt) > now ||
    now - Date.parse(u.checkedAt) >= 5 * 60_000
  )
    return "usage-not-fresh";
  const windows = quotaWindows(u);
  if (
    !windows?.every(
      (window) =>
        Number.isFinite(window.usedPercent) &&
        window.usedPercent >= 0 &&
        window.usedPercent <= 100,
    )
  )
    return "usage-incomplete";
  // A started window must expose its future reset; an unused one may omit it.
  for (const window of windows) {
    if (window.resetsAt === undefined) {
      if (window.usedPercent > 0) return "usage-incomplete";
    } else if (
      !Number.isFinite(Date.parse(window.resetsAt)) ||
      Date.parse(window.resetsAt) <= now
    )
      return "usage-not-fresh";
  }
  if (100 - maxUsedPercent(u)! <= reserve) return "reserve";
}
export function workdayPlan(
  accounts: Account[],
  usage: Record<string, AccountUsage>,
  workday: WorkdaySettings,
  now = Date.now(),
): WorkdayPlan {
  const plan: WorkdayPlan = { rankings: [], slots: [], approximate: true };
  if (!validWorkday(workday)) return plan;
  const selected = new Set(workday.accountIds);
  const identities = new Set<string>();
  // The stable account order determines duplicate identity ownership, not a
  // score that can change when usage is refreshed.
  plan.rankings = accounts
    .map((a) => {
      let reason: PlanningReason | undefined = selected.has(a.id)
        ? quotaPlanningReason(a, usage[a.id], workday.reservePercent, now)
        : "not-selected";
      const identity = planningIdentity(a);
      if (selected.has(a.id) && identity) {
        if (identities.has(identity)) reason = "duplicate-identity";
        identities.add(identity);
      }
      const capacity = planCapacity(a);
      const remainingPercent = !reason
        ? 100 - maxUsedPercent(usage[a.id])!
        : undefined;
      // Without a reported weekly reset there is no expiring weekly allowance to
      // prefer; a full week keeps the boost neutral.
      const weeklyReset = usage[a.id]?.sevenDay?.resetsAt;
      const daysToReset = !reason
        ? weeklyReset
          ? (Date.parse(weeklyReset) - now) / DAY
          : 7
        : 0;
      // Heuristic units: capacity ratio × usable fraction with a bounded boost
      // for weekly capacity that expires soon. These are not tokens or dollars.
      const score = !reason
        ? capacity *
          ((remainingPercent! - workday.reservePercent) / 100) *
          (1 + 1 / (1 + daysToReset))
        : 0;
      return { accountId: a.id, capacity, score, remainingPercent, reason };
    })
    .sort(
      (a, b) => b.score - a.score || a.accountId.localeCompare(b.accountId),
    );
  const today = localDate(now, workday.timeZone);
  // Look back one anchor day for overnight shifts and forward far enough for
  // every selected weekday. Warm-up belongs to the shift's anchor date.
  for (let delta = -1; delta <= 8; delta++) {
    const date = nextDate(today, delta);
    if (!workday.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()))
      continue;
    const start = wallTime(date, workday.start, workday.timeZone);
    const end = wallTime(
      workday.end <= workday.start ? nextDate(date) : date,
      workday.end,
      workday.timeZone,
    );
    if (start === undefined || end === undefined || end <= now || end <= start)
      continue;
    const first = start - workday.warmupLeadMinutes * 60_000;
    if (delta === -1 && now < first) continue;
    plan.date = date;
    plan.startsAt = new Date(start).toISOString();
    plan.endsAt = new Date(end).toISOString();
    // Plan order follows explicit selection so refreshed usage cannot move a
    // scheduled start from one account to another during the day.
    for (const [slot, id] of [...new Set(workday.accountIds)].entries()) {
      const ranking = plan.rankings.find((r) => r.accountId === id);
      if (!ranking) continue;
      const scheduled = first + slot * workday.staggerMinutes * 60_000;
      plan.slots.push({
        accountId: id,
        scheduledAt: new Date(scheduled).toISOString(),
        expectedResetAt: new Date(scheduled + 5 * HOUR).toISOString(),
        reason:
          ranking.reason ??
          (scheduled >= end
            ? "outside-workday"
            : usage[id].fiveHour?.resetsAt
              ? "already-active"
              : undefined),
      });
    }
    break;
  }
  return plan;
}
