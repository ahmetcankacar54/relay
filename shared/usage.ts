import type {
  Account,
  AccountUsage,
  RelaySettings,
  UsageWindow,
} from "./types";
import { allowedHistoryPair } from "./history-policy";
import { rankContinuationTargets } from "./continuation-target-ranking";
import { maxUsedPercent } from "./quota-windows";
export { maxUsedPercent, quotaWindows } from "./quota-windows";
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
/** How old a reading may be to confirm that the active account is out of quota. */
export const SOURCE_FRESH_MS = 15 * 60_000;

/** The usage service confirms the source is out of quota (any window or a model limit). */
export function sourceExhausted(usage: AccountUsage | undefined, now: number) {
  const checked = Date.parse(usage?.checkedAt ?? "");
  if (
    !usage ||
    usage.status !== "ready" ||
    usage.stale ||
    !Number.isFinite(checked) ||
    now - checked > SOURCE_FRESH_MS
  )
    return false;
  return (
    usage.otherLimitReached === true ||
    [usage.fiveHour, usage.sevenDay].some(
      (window) =>
        !!window &&
        window.usedPercent >= 100 &&
        (!window.resetsAt || Date.parse(window.resetsAt) > now),
    )
  );
}
export function remaining(w?: UsageWindow) {
  return w ? Math.max(0, 100 - w.usedPercent) : undefined;
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
