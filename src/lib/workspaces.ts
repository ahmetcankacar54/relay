import type { Account } from "../../shared/types";

type T = (tr: string, en: string) => string;

export interface WorkspaceOption {
  id: string;
  /** The organization name Relay knows for the id, else "Çalışma alanı N"; never the raw id. */
  label: string;
  /** The id's first 8 characters, for muted text at most. */
  short: string;
}

/**
 * The Code workspaces (folders named by organization id) as the pickers show them. A name comes
 * from a usage sign-in that reported the same organization; the rest are numbered in order.
 */
export function workspaceOptions(
  ids: readonly string[],
  accounts: readonly Account[],
  t: T,
): WorkspaceOption[] {
  let unnamed = 0;
  return ids.map((id) => {
    const name = accounts.find(
      (a) => a.auth?.orgName && a.auth.orgId?.toLowerCase() === id.toLowerCase(),
    )?.auth?.orgName;
    if (!name) unnamed += 1;
    return {
      id,
      label: name ?? t(`Çalışma alanı ${unnamed}`, `Workspace ${unnamed}`),
      short: id.slice(0, 8),
    };
  });
}

/** The workspace a link saves: the one chosen while it still exists, else the only one. */
export function targetWorkspace(
  organizations: readonly string[] | undefined,
  chosen: string,
): string {
  if (!organizations) return "";
  if (organizations.includes(chosen)) return chosen;
  return organizations.length === 1 ? organizations[0] : "";
}
