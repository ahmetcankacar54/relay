import type {
  Account,
  AccountUsage,
  RelaySettings,
  UsageWindow,
} from "./types";
import { allowedHistoryPair } from "./history-policy";
import { rankContinuationTargets } from "./continuation-target-ranking";
export function freshUsage(
  u: AccountUsage | undefined,
  now = Date.now(),
): u is AccountUsage {
  return (
    !!u &&
    u.status === "ready" &&
    !u.stale &&
    !!u.checkedAt &&
    now - Date.parse(u.checkedAt) < 35 * 60_000 &&
    [u.fiveHour, u.sevenDay].every(
      (w) => !w?.resetsAt || Date.parse(w.resetsAt) > now,
    )
  );
}
export function remaining(w?: UsageWindow) {
  return w ? Math.max(0, 100 - w.usedPercent) : undefined;
}
/**
 * Quota windows the provider reported. Team and Enterprise seats can omit the
 * weekly window: that means no weekly limit was reported, never an invented 0% or
 * 100%. The five-hour window is required before an account can be judged.
 */
export function quotaWindows(
  u: Pick<AccountUsage, "fiveHour" | "sevenDay"> | undefined,
): UsageWindow[] | undefined {
  if (!u?.fiveHour) return;
  return u.sevenDay ? [u.fiveHour, u.sevenDay] : [u.fiveHour];
}
/** Highest utilization across the reported windows (the binding limit). */
export function maxUsedPercent(
  u: Pick<AccountUsage, "fiveHour" | "sevenDay"> | undefined,
) {
  const windows = quotaWindows(u);
  return windows && Math.max(...windows.map((w) => w.usedPercent));
}
/**
 * The account to suggest once the active one passes the warning threshold,
 * ranked like automatic switching (`rate`: the tempo, Pro units per hour).
 */
export function suggestedAccount(
  active: Account | undefined,
  accounts: Account[],
  usage: Record<string, AccountUsage>,
  settings: RelaySettings,
  now = Date.now(),
  rate?: number,
) {
  if (
    !active ||
    !settings.suggestAccounts ||
    !freshUsage(usage[active.id], now)
  )
    return;
  const current = usage[active.id];
  if (
    !settings.usageWarnings ||
    ![current.fiveHour, current.sevenDay].some(
      (w) => w && w.usedPercent >= settings.usageWarningPercent,
    )
  )
    return;
  const eligible = accounts.filter(
    (a) =>
      a.id !== active.id &&
      allowedHistoryPair(active, a, settings) &&
      a.desktop &&
      (!a.cooldownUntil || Date.parse(a.cooldownUntil) <= now) &&
      freshUsage(usage[a.id], now) &&
      (maxUsedPercent(usage[a.id]) ?? 100) < settings.usageWarningPercent,
  );
  return rankContinuationTargets(
    eligible.map((a) => ({ account: a, usage: usage[a.id] })),
    { now, rate },
  )[0]?.account;
}
