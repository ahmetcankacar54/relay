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

/**
 * The account has no Claude Code sign-in and Relay reads its limits through its Claude app
 * sign-in instead (claude.ai's own usage page). Relay only does that where it can (macOS):
 * elsewhere the read reports `connect-cli` and names no source.
 */
export function readsThroughApp(account: Account, usage?: AccountUsage) {
  return (
    !account.auth?.loggedIn &&
    !!account.desktop &&
    usage?.source === "desktop"
  );
}

export function cliNeedsReconnect(account: Account, usage?: AccountUsage) {
  return (
    (!account.auth?.loggedIn && !readsThroughApp(account, usage)) ||
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
