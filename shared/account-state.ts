import type { Account, AccountUsage, AuthFlow } from "./types";

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
