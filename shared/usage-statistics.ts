import type { Account, AccountUsage, UsageWindow } from "./types";

export const USAGE_HISTORY_DAYS = 30;
export const MAX_USAGE_SAMPLES = 10_000;
export const MAX_USAGE_GAP_MS = 35 * 60_000;
const DAY_MS = 86_400_000;

export interface UsageSample {
  accountId: string;
  identity: string;
  checkedAt: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}
export interface UsageStatisticsPeriod {
  days: 7 | 30;
  observedFiveHourPoints: number;
  windowsObserved: number;
  samples: number;
  coveredMinutes: number;
  coveragePercent: number;
  firstAt?: string;
  lastAt?: string;
  partial: true;
}
export interface AccountUsageStatistics {
  accountId: string;
  status: "available" | "unavailable";
  periods: {
    sevenDay: UsageStatisticsPeriod;
    thirtyDay: UsageStatisticsPeriod;
  };
}

// A verified UUID survives an email/name change; the organization remains part
// of its quota identity. Legacy accounts fall back to normalized email.
export function usageIdentity(account: Account): string | undefined {
  if (!account.auth?.loggedIn) return;
  const uuid = account.auth.accountUuid ?? account.desktop?.accountUuid;
  const email = account.auth.email?.trim().toLowerCase();
  const org = account.auth.orgId ?? account.desktop?.orgId ?? "";
  // Email alone proves a user, not which organization's quota was observed.
  // A legacy profile needs reconnecting before it can build a reliable ledger.
  if (!org || (!uuid && !email)) return;
  return JSON.stringify([uuid ? "uuid" : "email", uuid ?? email, org]);
}

function normalizedWindow(
  window: UsageWindow | undefined,
): UsageWindow | undefined {
  if (!window) return;
  if (
    !Number.isFinite(window.usedPercent) ||
    window.usedPercent < 0 ||
    window.usedPercent > 100
  )
    return;
  if (
    window.resetsAt !== undefined &&
    !Number.isFinite(Date.parse(window.resetsAt))
  )
    return;
  return {
    usedPercent: window.usedPercent,
    ...(window.resetsAt
      ? { resetsAt: new Date(window.resetsAt).toISOString() }
      : {}),
  };
}

export function usageSample(
  account: Account,
  usage: AccountUsage,
): UsageSample | undefined {
  const identity = usageIdentity(account);
  if (
    !identity ||
    usage.accountId !== account.id ||
    usage.status !== "ready" ||
    usage.stale ||
    usage.issue ||
    !usage.checkedAt ||
    !Number.isFinite(Date.parse(usage.checkedAt))
  )
    return;
  const fiveHour = normalizedWindow(usage.fiveHour);
  const sevenDay = normalizedWindow(usage.sevenDay);
  if (!fiveHour && !sevenDay) return;
  return {
    accountId: account.id,
    identity,
    checkedAt: new Date(usage.checkedAt).toISOString(),
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

export function summarizeUsageSamples(
  account: Account,
  samples: readonly UsageSample[],
  now: number,
  available = true,
): AccountUsageStatistics {
  const identity = usageIdentity(account);
  const checkedTimes = new Set<number>();
  const current = identity
    ? samples
        .filter((s) => s.accountId === account.id && s.identity === identity)
        .filter(
          (s) =>
            Number.isFinite(Date.parse(s.checkedAt)) &&
            Date.parse(s.checkedAt) <= now,
        )
        .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt))
        .filter((sample) => {
          const checkedAt = Date.parse(sample.checkedAt);
          if (checkedTimes.has(checkedAt)) return false;
          checkedTimes.add(checkedAt);
          return true;
        })
    : [];
  const period = (days: 7 | 30): UsageStatisticsPeriod => {
    const cutoff = now - days * DAY_MS;
    const points = current.filter((s) => Date.parse(s.checkedAt) >= cutoff);
    const windows = new Set<string>();
    let observed = 0,
      coveredMs = 0;
    let previous: UsageSample | undefined;
    const highWaters = new Map<string, number>();
    for (const sample of current) {
      const checkedAt = Date.parse(sample.checkedAt);
      const reset = sample.fiveHour?.resetsAt;
      const valid =
        !!reset &&
        Date.parse(reset) > checkedAt &&
        Date.parse(reset) <= checkedAt + 5 * 60 * 60_000;
      if (valid && checkedAt >= cutoff) windows.add(reset!);
      const gap = previous
        ? checkedAt - Date.parse(previous.checkedAt)
        : Infinity;
      const sameWindow = valid && previous?.fiveHour?.resetsAt === reset;
      const highWater =
        highWaters.get(reset ?? "") ?? sample.fiveHour?.usedPercent ?? 0;
      if (sameWindow && gap > 0 && gap <= MAX_USAGE_GAP_MS) {
        const inPeriod = Date.parse(previous!.checkedAt) >= cutoff;
        if (inPeriod) coveredMs += gap;
        // Corrections/drops do not establish a lower baseline and inflate the
        // next increase. The first observation after a gap is not counted;
        // keeping the high-water mark also prevents counting a rebound twice.
        if (inPeriod)
          observed += Math.max(0, sample.fiveHour!.usedPercent - highWater);
      }
      if (valid)
        highWaters.set(
          reset!,
          Math.max(highWater, sample.fiveHour!.usedPercent),
        );
      previous = valid ? sample : undefined;
    }
    return {
      days,
      observedFiveHourPoints: Math.round(observed * 100) / 100,
      windowsObserved: windows.size,
      samples: points.length,
      coveredMinutes: Math.round(coveredMs / 60_000),
      coveragePercent: Math.round((coveredMs / (days * DAY_MS)) * 10_000) / 100,
      firstAt: points[0]?.checkedAt,
      lastAt: points.at(-1)?.checkedAt,
      partial: true,
    };
  };
  return {
    accountId: account.id,
    status: available ? "available" : "unavailable",
    periods: { sevenDay: period(7), thirtyDay: period(30) },
  };
}
