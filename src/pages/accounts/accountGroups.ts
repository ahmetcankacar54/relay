import type { Account, AccountProvider, AccountUsage } from "../../../shared/types";
import { limitColumns, usedAt } from "../../../shared/quota-windows";
import { boardOrder } from "@/lib/limit-standing";
import { accountProvider, groupName, providerShortLabel } from "./accountLabels";
import type { T } from "../../../shared/i18n/translate";


/*
 * The Accounts list's sections: by provider (with work groups below a provider whose accounts span
 * more than one), by work group, or one flat list; and the order inside each. Pure, so the hierarchy
 * is tested without rendering.
 */

export type AccountGroupBy = "provider" | "workGroup" | "none";
export type AccountSort = "default" | "name" | "usage" | "reset";

/** The providers' order in a list: Claude first, then the gateway's. */
export const PROVIDER_ORDER = ["claude", "codex", "antigravity", "gemini"] as const;

export interface AccountSection {
  key: string;
  level: 0 | 1;
  label: string;
  provider?: AccountProvider;
  accounts: Account[];
  children: AccountSection[];
}

export type WorkGroupKey = "personal" | "separate" | `work:${string}`;

/** The work group an account shares history with: personal, a named group, or its own workspace. */
export function workGroupKey(a: Account): WorkGroupKey {
  if (a.kind === "personal") return "personal";
  if (a.group === `work:${a.id}`) return "separate";
  return a.group as `work:${string}`;
}

/** Personal first, the named groups alphabetically, the separate workspaces last. */
function workGroups(accounts: Account[], language: string, t: T): { key: WorkGroupKey; label: string; accounts: Account[] }[] {
  const byKey = new Map<WorkGroupKey, Account[]>();
  for (const a of accounts) {
    const key = workGroupKey(a);
    byKey.set(key, [...(byKey.get(key) ?? []), a]);
  }
  const rank = (key: WorkGroupKey) => (key === "personal" ? 0 : key === "separate" ? 2 : 1);
  return [...byKey]
    .map(([key, own]) => ({
      key,
      accounts: own,
      label:
        key === "personal"
          ? t("common.personal")
          : key === "separate"
            ? t("accountGroups.separateWorkspaces")
            : groupName(own[0], t),
    }))
    .sort((a, b) => rank(a.key) - rank(b.key) || (rank(a.key) === 1 ? a.label.localeCompare(b.label, language) : 0));
}

/** One run of accounts in the chosen order (default keeps the given order). */
export function sortLeaf(
  accounts: Account[],
  sort: AccountSort,
  usage: Record<string, AccountUsage | undefined>,
  now: number,
  language: string,
): Account[] {
  if (sort === "name") {
    // Case and accents only break ties, so "a" and "Ä" sit together and "a" comes first.
    const base = { sensitivity: "base" } as const;
    return [...accounts].sort((a, b) => a.name.localeCompare(b.name, language, base) || a.name.localeCompare(b.name, language));
  }
  if (sort === "reset") return boardOrder(accounts, usage, now);
  if (sort === "usage") {
    // As the row shows it: a window whose reset has passed is empty, whatever its last reading said.
    const used = (a: Account) => {
      const five = limitColumns(usage[a.id], now).five;
      return five ? usedAt(five, now) : Infinity;
    };
    return [...accounts].sort((a, b) => used(a) - used(b));
  }
  return accounts;
}

export function groupAccounts(
  accounts: Account[],
  o: { by: AccountGroupBy; sort: AccountSort; usage: Record<string, AccountUsage | undefined>; now: number; language: string; t: T },
): AccountSection[] {
  const leaf = (own: Account[]) => sortLeaf(own, o.sort, o.usage, o.now, o.language);
  if (o.by === "none") return [{ key: "all", level: 0, label: "", accounts: leaf(accounts), children: [] }];
  if (o.by === "workGroup")
    return workGroups(accounts, o.language, o.t).map((g) => ({
      key: `group:${g.key}`,
      level: 0,
      label: g.label,
      accounts: leaf(g.accounts),
      children: [],
    }));
  return PROVIDER_ORDER.flatMap((provider): AccountSection[] => {
    const own = accounts.filter((a) => accountProvider(a) === provider);
    if (!own.length) return [];
    const key = `provider:${provider}`;
    const groups = workGroups(own, o.language, o.t);
    const children: AccountSection[] =
      groups.length < 2
        ? []
        : groups.map((g) => ({ key: `${key}/group:${g.key}`, level: 1, label: g.label, accounts: leaf(g.accounts), children: [] }));
    return [{ key, level: 0, label: providerShortLabel(provider), provider, accounts: children.length ? [] : leaf(own), children }];
  });
}

/** How many accounts a section holds, its subsections' included. */
export const sectionCount = (s: AccountSection): number =>
  s.accounts.length + s.children.reduce((n, c) => n + sectionCount(c), 0);

/** Where the Accounts page keeps its grouping, order and closed sections. */
export const ACCOUNTS_VIEW_KEYS = {
  groupBy: "relay.accounts.groupBy",
  sort: "relay.accounts.sort",
  collapsed: "relay.accounts.collapsed",
} as const;

export interface AccountsView {
  groupBy: AccountGroupBy;
  sort: AccountSort;
  collapsed: string[];
}

const GROUP_BYS: readonly string[] = ["provider", "workGroup", "none"] satisfies AccountGroupBy[];
const SORTS: readonly string[] = ["default", "name", "usage", "reset"] satisfies AccountSort[];

/** The stored view; anything missing or unreadable falls back to provider groups in their own order, all open. */
export function readAccountsView(get: (key: string) => string | null): AccountsView {
  const view: AccountsView = { groupBy: "provider", sort: "default", collapsed: [] };
  try {
    const groupBy = get(ACCOUNTS_VIEW_KEYS.groupBy);
    if (groupBy && GROUP_BYS.includes(groupBy)) view.groupBy = groupBy as AccountGroupBy;
    const sort = get(ACCOUNTS_VIEW_KEYS.sort);
    if (sort && SORTS.includes(sort)) view.sort = sort as AccountSort;
    const collapsed: unknown = JSON.parse(get(ACCOUNTS_VIEW_KEYS.collapsed) ?? "[]");
    // Work groups under a provider have no heading of their own any more (their cards flow together),
    // so a closed one from an older view is dropped instead of kept for ever.
    if (Array.isArray(collapsed))
      view.collapsed = collapsed.filter((k): k is string => typeof k === "string" && !/^provider:[^/]+\/group:/.test(k));
  } catch {
    // No window (a static render), unreadable storage or a broken value: the defaults.
  }
  return view;
}
