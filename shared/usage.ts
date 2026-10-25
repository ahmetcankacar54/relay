import type {
  Account,
  AccountUsage,
  RelaySettings,
  UsageIssue,
  UsageWindow,
} from "./types";
import { displayedIssue } from "./account-state";
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
/** Issues after which the last reading still stands: the usage service could not be reached for a while. */
const PASSING_ISSUES: ReadonlySet<UsageIssue> = new Set(["rate-limited", "unavailable"]);

/**
 * A reading that may still be shown as last known once `freshUsage` no longer accepts it: it was
 * read (not in the future), has a window, and nothing but a passing issue (no network, rate limited,
 * the service down) or its age keeps it from being fresh. A sign-in problem never leaves one: those
 * limits stay unknown until the user acts. Which windows still hold is `windowHolds`'s call.
 */
export function lastKnownUsage(
  u: AccountUsage | undefined,
  now = Date.now(),
): u is AccountUsage {
  const checked = Date.parse(u?.checkedAt ?? "");
  if (!u || !Number.isFinite(checked) || checked > now + 60_000) return false;
  if (!u.fiveHour && !u.sevenDay) return false;
  const issue = displayedIssue(u);
  return !issue || PASSING_ISSUES.has(issue);
}

/** A window of a last known reading that has not reset since: its percent can only have grown. */
export function windowHolds(
  w: UsageWindow | undefined,
  now = Date.now(),
): w is UsageWindow {
  return (
    !!w &&
    Number.isFinite(w.usedPercent) &&
    (!w.resetsAt || Date.parse(w.resetsAt) > now)
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
