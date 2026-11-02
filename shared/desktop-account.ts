import type { Account } from "./types";

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The Relay account whose Claude app sign-in is `known`, the account the Claude app had open. The
 * organization decides only when both sides know it.
 */
export function desktopAccountFor(
  known: { accountUuid: string; orgId?: string },
  accounts: readonly Account[],
): Account | undefined {
  return accounts.find((account) => {
    const desktop = account.desktop;
    if (
      !desktop?.accountUuid ||
      !sameId(desktop.accountUuid, known.accountUuid)
    )
      return false;
    return !known.orgId || !desktop.orgId || sameId(desktop.orgId, known.orgId);
  });
}
