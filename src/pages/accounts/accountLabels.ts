import type { Account } from "../../../shared/types";

type T = (tr: string, en: string) => string;

const PLAN_LABELS: Partial<Record<string, string>> = {
  pro: "Pro",
  max5: "Max 5×",
  max20: "Max 20×",
  team: "Team",
};

/** Short plan name for badges; undefined when the plan has not been chosen. */
export const planLabel = (account: Account): string | undefined =>
  PLAN_LABELS[account.planning?.plan ?? ""];

/** History-sharing group shown to the user. */
export const groupName = (account: Account, t: T) =>
  account.kind === "personal"
    ? t("Kişisel", "Personal")
    : account.group === `work:${account.id}`
      ? t("Ayrı çalışma alanı", "Separate workspace")
      : account.group.slice(5);

export type AccountFilter = "all" | "connected" | "personal" | "work";

export function filterAccounts(
  accounts: Account[],
  query: string,
  filter: AccountFilter,
  language: string,
) {
  const t: T = (tr, en) => (language === "tr" ? tr : en);
  const needle = query.trim().toLocaleLowerCase(language);
  return accounts.filter(
    (a) =>
      `${a.name} ${a.auth?.email ?? ""} ${a.desktop?.email ?? ""} ${a.auth?.orgName ?? ""} ${groupName(a, t)}`
        .toLocaleLowerCase(language)
        .includes(needle) &&
      (filter === "all" ||
        filter === a.kind ||
        (filter === "connected" && !!a.desktop)),
  );
}

/** Avatar colours keyed by `Account.color`. */
export const avatarClass: Record<string, string> = {
  terra: "bg-[#efded2] text-[#9e5f40]",
  olive: "bg-[#e2e8ce] text-[#6b7950]",
  blue: "bg-[#dce7e8] text-[#597886]",
  plum: "bg-[#e8dfeb] text-[#87638a]",
};
