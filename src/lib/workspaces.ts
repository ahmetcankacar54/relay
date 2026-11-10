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
 * `suggested`, the workspace the Claude app is in, comes first and says so: the numbers alone
 * give nothing to choose by.
 */
export function workspaceOptions(
  ids: readonly string[],
  accounts: readonly Account[],
  t: T,
  suggested?: string,
): WorkspaceOption[] {
  let unnamed = 0;
  const options = ids.map((id) => {
    const name = accounts.find(
      (a) => a.auth?.orgName && a.auth.orgId?.toLowerCase() === id.toLowerCase(),
    )?.auth?.orgName;
    if (!name) unnamed += 1;
    const label = name ?? t(`Çalışma alanı ${unnamed}`, `Workspace ${unnamed}`);
    const current = !!suggested && suggested.toLowerCase() === id.toLowerCase();
    return {
      id,
      label: current ? t(`${label} · Claude’da açık olan`, `${label} · open in Claude`) : label,
      short: id.slice(0, 8),
      current,
    };
  });
  return [
    ...options.filter((o) => o.current),
    ...options.filter((o) => !o.current),
  ].map(({ current: _current, ...option }) => option);
}

/**
 * The workspace a link saves: the one chosen while it still exists, else the only one, else the
 * one the Claude app is in (`suggested`).
 */
export function targetWorkspace(
  organizations: readonly string[] | undefined,
  chosen: string,
  suggested?: string,
): string {
  if (!organizations) return "";
  if (organizations.includes(chosen)) return chosen;
  if (organizations.length === 1) return organizations[0];
  return suggested && organizations.includes(suggested) ? suggested : "";
}
