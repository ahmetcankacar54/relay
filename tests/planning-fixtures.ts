import {
  DEFAULT_WORKDAY,
  type Account,
  type AccountUsage,
  type WorkdaySettings,
} from "../shared/types";
const NOW = Date.parse("2026-10-13T05:59:45Z");
export function planningAccount(
  id = "a",
  plan: NonNullable<Account["planning"]>["plan"] = "pro",
): Account {
  return {
    id,
    name: id,
    kind: "personal",
    group: "personal",
    color: "olive",
    createdAt: new Date(NOW).toISOString(),
    planning: { plan, capacityWeight: 1 },
    auth: {
      loggedIn: true,
      accountUuid: id,
      orgId: `org-${id}`,
      subscription: "pro",
      checkedAt: new Date(NOW).toISOString(),
    },
  };
}
export function planningUsage(account: Account, now = NOW): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(now).toISOString(),
    fiveHour: { usedPercent: 0 },
    sevenDay: {
      usedPercent: 20,
      resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
    },
  };
}
export function planningSettings(ids = ["a"]): WorkdaySettings {
  return {
    ...DEFAULT_WORKDAY,
    start: "09:00",
    end: "18:00",
    timeZone: "Europe/Istanbul",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    accountIds: ids,
    routineEnabled: true,
    staggerMinutes: 60,
    warmupLeadMinutes: 0,
    reservePercent: 10,
  };
}
