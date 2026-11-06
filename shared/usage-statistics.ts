import type { Account, AccountUsage, UsageWindow } from "./types";

export const USAGE_HISTORY_DAYS = 14;
export const MAX_USAGE_SAMPLES = 50_000;
export const MAX_USAGE_GAP_MS = 35 * 60_000;

export interface UsageSample {
  accountId: string;
  identity: string;
  checkedAt: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}
// A verified UUID survives an email/name change; the organization remains part
// of its quota identity. Legacy accounts fall back to normalized email.
// Samples are recorded only under a signed-in account's identity: its Claude Code
// sign-in's, else (read through the Claude app's sign-in) the Claude app's.
export function usageIdentity(account: Account): string | undefined {
  if (account.auth?.loggedIn) return historyIdentity(account);
  return desktopIdentity(account);
}

function desktopIdentity(account: Account): string | undefined {
  if (!account.desktop) return;
  return JSON.stringify(["uuid", account.desktop.accountUuid, account.desktop.orgId]);
}

/**
 * The identity an account's recorded usage is filed under, also while it is
 * signed out: a sign-out keeps the last verified UUID and organization.
 */
export function historyIdentity(account: Account): string | undefined {
  if (!account.auth) return desktopIdentity(account);
  const uuid = account.auth.accountUuid ?? account.desktop?.accountUuid;
  const email = account.auth.email?.trim().toLowerCase();
  const org = account.auth.orgId ?? account.desktop?.orgId ?? "";
  // Email alone proves a user, not which organization's quota was observed.
  // A legacy profile needs reconnecting before it can build a reliable ledger.
  if (!org || (!uuid && !email)) return;
  return JSON.stringify([uuid ? "uuid" : "email", uuid ?? email, org]);
}

/** Identity → owning account: the first signed-in account sharing it, else the first. */
export function identityOwners(accounts: Account[]): Map<string, Account> {
  const owner = new Map<string, Account>();
  for (const account of accounts) {
    const identity = historyIdentity(account);
    if (!identity) continue;
    const current = owner.get(identity);
    if (!current || (!current.auth?.loggedIn && account.auth?.loggedIn))
      owner.set(identity, account);
  }
  return owner;
}

function normalizedWindow(
  window: UsageWindow | undefined,
): UsageWindow | undefined {
  if (!window) return;
  if (
    !Number.isFinite(window.usedPercent) ||
    window.usedPercent < 0 ||
    window.usedPercent > 100
  )
    return;
  if (
    window.resetsAt !== undefined &&
    !Number.isFinite(Date.parse(window.resetsAt))
  )
    return;
  return {
    usedPercent: window.usedPercent,
    ...(window.resetsAt
      ? { resetsAt: new Date(window.resetsAt).toISOString() }
      : {}),
  };
}

export function usageSample(
  account: Account,
  usage: AccountUsage,
): UsageSample | undefined {
  const identity = usageIdentity(account);
  if (
    !identity ||
    usage.accountId !== account.id ||
    usage.status !== "ready" ||
    usage.stale ||
    usage.issue ||
    !usage.checkedAt ||
    !Number.isFinite(Date.parse(usage.checkedAt))
  )
    return;
  const fiveHour = normalizedWindow(usage.fiveHour);
  const sevenDay = normalizedWindow(usage.sevenDay);
  if (!fiveHour && !sevenDay) return;
  return {
    accountId: account.id,
    identity,
    checkedAt: new Date(usage.checkedAt).toISOString(),
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}
