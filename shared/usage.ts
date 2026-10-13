import type {
  Account,
  AccountUsage,
  RelaySettings,
  UsageWindow,
} from "./types";
import { allowedHistoryPair } from "./history-policy";
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
export function suggestedAccount(
  active: Account | undefined,
  accounts: Account[],
  usage: Record<string, AccountUsage>,
  settings: RelaySettings,
  now = Date.now(),
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
  return accounts
    .filter(
      (a) =>
        a.id !== active.id &&
        allowedHistoryPair(active, a, settings) &&
        a.desktop &&
        (!a.cooldownUntil || Date.parse(a.cooldownUntil) <= now) &&
        freshUsage(usage[a.id], now) &&
        usage[a.id].fiveHour &&
        usage[a.id].sevenDay &&
        Math.max(
          usage[a.id].fiveHour!.usedPercent,
          usage[a.id].sevenDay!.usedPercent,
        ) < settings.usageWarningPercent,
    )
    .sort(
      (a, b) =>
        Math.max(
          usage[a.id].fiveHour!.usedPercent,
          usage[a.id].sevenDay!.usedPercent,
        ) -
        Math.max(
          usage[b.id].fiveHour!.usedPercent,
          usage[b.id].sevenDay!.usedPercent,
        ),
    )[0];
}
