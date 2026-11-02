import type { Account, AccountUsage, AuthFlow, UsageIssue } from "./types";

/**
 * The usage issue every surface shows: the one the last read reported, else a connection to renew.
 * The status, the banners, the usage card, the mascot and the window keeper all read it, so they cannot disagree.
 */
export function displayedIssue(
  usage?: AccountUsage,
): UsageIssue | "renewal-required" | undefined {
  return (
    usage?.issue ??
    (usage?.connectionRenewalRequired ? "renewal-required" : undefined)
  );
}

export function cliNeedsReconnect(account: Account, usage?: AccountUsage) {
  return (
    !account.auth?.loggedIn ||
    ["expired", "credentials-missing", "scope", "identity-mismatch"].includes(
      usage?.issue ?? "",
    )
  );
}

export function duplicateCliAccount(account: Account, accounts: Account[]) {
  const identity = account.auth;
  if (!identity?.loggedIn || !identity.accountUuid || !identity.orgId) return;
  return accounts.find(
    (other) =>
      other.id !== account.id &&
      other.auth?.loggedIn &&
      other.auth.accountUuid === identity.accountUuid &&
      other.auth.orgId === identity.orgId,
  );
}

export function desktopCliMismatch(account: Account) {
  return (
    !!account.desktop &&
    !!account.auth?.loggedIn &&
    ((!!account.auth.accountUuid &&
      account.auth.accountUuid !== account.desktop.accountUuid) ||
      (!!account.auth.orgId && account.auth.orgId !== account.desktop.orgId))
  );
}

export function pendingAuth(flow?: AuthFlow) {
  return !!flow && ["starting", "waiting", "verifying"].includes(flow.status);
}
