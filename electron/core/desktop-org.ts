/**
 * Which of an account's Code workspaces (organizations) the Claude app is in now.
 *
 * One Claude account can belong to several organizations, and the app keeps a Code workspace
 * folder for each it has ever opened. Relay must bind a profile to the one the app is using:
 * the usage sign-in names that organization, and a profile bound to another can never match it.
 * The app's `config.json` says which it is, in two places Relay only reads:
 *
 * - a remembered answer that pairs `accountUuid` with `orgUuid` (today
 *   `sshTransportFlagLastAnswer`); any top-level object with both fields counts, so a renamed
 *   key still reads;
 * - `dxt:allowlistLastUpdated:<org>`, which the app refreshes for the organization it has open.
 *
 * Both are the app's own bookkeeping, not an interface, so the answer is a hint with a
 * confidence, never a fact Relay writes anywhere without the workspace also existing on disk.
 */
export interface OrgHint {
  orgId: string;
  /**
   * The app names this organization for the account outright, or refreshed it after `since`.
   * Otherwise it is only the most recently used of the candidates.
   */
  certain: boolean;
}

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : undefined);

export function activeOrgHint(
  config: unknown,
  accountUuid: string,
  orgs: readonly string[],
  /** When the sign-in being saved began (ms); a refresh after it belongs to this sign-in. */
  since?: number,
): OrgHint | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config) || orgs.length < 2) return;
  const known = new Map(orgs.map((org) => [org.toLowerCase(), org]));
  const entries = Object.entries(config as Record<string, unknown>);
  for (const [, value] of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const pair = value as Record<string, unknown>;
    if (lower(pair.accountUuid) !== accountUuid.toLowerCase()) continue;
    const named = known.get(lower(pair.orgUuid) ?? "");
    if (named) return { orgId: named, certain: true };
  }
  let newest: { orgId: string; at: number } | undefined;
  for (const [key, value] of entries) {
    const match = /^dxt:allowlistLastUpdated:(.+)$/.exec(key);
    const org = match && known.get(match[1].toLowerCase());
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (!org || !Number.isFinite(at)) continue;
    if (!newest || at > newest.at) newest = { orgId: org, at };
  }
  if (!newest) return;
  return { orgId: newest.orgId, certain: since !== undefined && newest.at >= since };
}
