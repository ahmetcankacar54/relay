import type { Account, RelaySettings } from "./types";

// A selected set is an explicit cross-organization sharing boundary. Both
// endpoints must be in it; account names and emails cannot grant access.
export function allowedHistoryPair(
  source: Account,
  target: Account,
  settings: RelaySettings,
): boolean {
  if (source.id === target.id) return false;
  return settings.desktopHistoryTransfer === "selected"
    ? settings.desktopHistoryAccounts.includes(source.id) &&
        settings.desktopHistoryAccounts.includes(target.id)
    : source.group === target.group;
}

export function historySources(
  target: Account,
  accounts: Account[],
  settings: RelaySettings,
): Account[] {
  if (settings.desktopHistoryTransfer === "off") return [];
  return accounts.filter(
    (source) =>
      !!source.desktop && allowedHistoryPair(source, target, settings),
  );
}
