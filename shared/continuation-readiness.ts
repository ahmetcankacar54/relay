import { allowedHistoryPair } from "./history-policy";
import { quotaWindows } from "./usage";
import type {
  Account,
  AccountUsage,
  RelaySettings,
  UsageWindow,
} from "./types";

export type ContinuationTargetReadinessReason =
  | "source-not-enrolled"
  | "identity-not-enrolled"
  | "duplicate-identity"
  | "history-boundary"
  | "quota-not-fresh"
  | "five-hour-unavailable"
  | "quota-window-invalid"
  | "target-quota-unavailable"
  | "target-cooldown";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enrolled(account: Account | undefined): account is Account & {
  desktop: NonNullable<Account["desktop"]>;
} {
  return (
    !!account &&
    UUID.test(account.id) &&
    UUID.test(account.desktop?.accountUuid ?? "") &&
    UUID.test(account.desktop?.orgId ?? "") &&
    account.auth?.loggedIn === true &&
    account.auth.accountUuid?.toLowerCase() ===
      account.desktop?.accountUuid.toLowerCase() &&
    account.auth.orgId?.toLowerCase() === account.desktop?.orgId.toLowerCase()
  );
}

function validWindow(window: UsageWindow, now: number) {
  return (
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    ((window.usedPercent === 0 && window.resetsAt === undefined) ||
      (Number.isFinite(Date.parse(window.resetsAt ?? "")) &&
        Date.parse(window.resetsAt!) > now))
  );
}

/**
 * Read-only preparation information for a currently enrolled target. Matches
 * the target gates in continuationPolicyReason; it is not handoff authority.
 * The manager additionally verifies the source's exhausted quota, exact stopped
 * turn, frozen enrollment, permission mode and quiescence at execution time.
 */
export function continuationTargetReadinessReason(
  source: Account | undefined,
  target: Account,
  usage: AccountUsage | undefined,
  settings: RelaySettings,
  now = Date.now(),
): ContinuationTargetReadinessReason | undefined {
  if (!enrolled(source)) return "source-not-enrolled";
  if (!enrolled(target)) return "identity-not-enrolled";
  if (
    source.id === target.id ||
    (source.desktop.accountUuid.toLowerCase() ===
      target.desktop.accountUuid.toLowerCase() &&
      source.desktop.orgId.toLowerCase() === target.desktop.orgId.toLowerCase())
  )
    return "duplicate-identity";
  if (
    !["same-group", "selected"].includes(settings.desktopHistoryTransfer) ||
    !Array.isArray(settings.desktopHistoryAccounts) ||
    !settings.desktopHistoryAccounts.every(
      (id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id),
    ) ||
    !allowedHistoryPair(source, target, settings)
  )
    return "history-boundary";
  const checkedAt = Date.parse(usage?.checkedAt ?? "");
  if (
    !usage ||
    usage.accountId !== target.id ||
    usage.status !== "ready" ||
    usage.stale !== false ||
    !!usage.issue ||
    !Number.isFinite(checkedAt) ||
    checkedAt > now ||
    now - checkedAt > 300_000
  )
    return "quota-not-fresh";
  const windows = quotaWindows(usage);
  if (!windows) return "five-hour-unavailable";
  if (!windows.every((w) => validWindow(w, now)))
    return "quota-window-invalid";
  if (windows.some((w) => w.usedPercent >= 90))
    return "target-quota-unavailable";
  if (
    target.cooldownUntil &&
    (!Number.isFinite(Date.parse(target.cooldownUntil)) ||
      Date.parse(target.cooldownUntil) > now)
  )
    return "target-cooldown";
  return undefined;
}
