import type { Account, AccountProvider } from "../../../shared/types";

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

const SUBSCRIPTION_LABELS: Partial<Record<string, string>> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
};

/**
 * The Accounts table's plan: the plan picked for planning, else the subscription the usage sign-in
 * reported (`auth.subscription`), which the table shows muted. Undefined when neither is known.
 */
export function planColumn(
  account: Account,
): { label: string; source: "planning" | "subscription" } | undefined {
  const plan = planLabel(account);
  if (plan) return { label: plan, source: "planning" };
  const raw = account.auth?.subscription?.trim().replace(/^(?:claude|codex|openai|antigravity|gemini)\s+/i, "");
  const subscription = raw?.toLowerCase();
  if (!subscription || subscription === "unknown") return undefined;
  return {
    label:
      SUBSCRIPTION_LABELS[subscription] ??
      subscription.charAt(0).toUpperCase() + subscription.slice(1),
    source: "subscription",
  };
}

/** History-sharing group shown to the user. */
export const groupName = (account: Account, t: T) =>
  account.kind === "personal"
    ? t("Kişisel", "Personal")
    : account.group === `work:${account.id}`
      ? t("Ayrı çalışma alanı", "Separate workspace")
      : account.group.slice(5);


/** An account saved before providers existed is a Claude account. */
export const accountProvider = (account: { provider?: AccountProvider }): AccountProvider =>
  account.provider ?? "claude";

const PROVIDER_LABELS: Record<AccountProvider, string> = {
  claude: "Claude",
  codex: "OpenAI / Codex",
  antigravity: "Antigravity",
  gemini: "Gemini",
};
/** The provider's full name: `OpenAI / Codex`; the same in both languages. */
export const providerLabel = (provider: AccountProvider | undefined): string =>
  PROVIDER_LABELS[provider ?? "claude"];

const PROVIDER_SHORT_LABELS: Record<AccountProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  gemini: "Gemini",
};
/** The provider's short name for badges: `Codex`. */
export const providerShortLabel = (provider: AccountProvider | undefined): string =>
  PROVIDER_SHORT_LABELS[provider ?? "claude"];

/** How many accounts each provider has. */
export function providerCounts(accounts: { provider?: AccountProvider }[]): Record<AccountProvider, number> {
  const counts: Record<AccountProvider, number> = { claude: 0, codex: 0, antigravity: 0, gemini: 0 };
  for (const a of accounts) counts[accountProvider(a)] += 1;
  return counts;
}

export type AccountFilter = "all" | "connected" | "personal" | "work";
export type ProviderFilter = "all" | AccountProvider;

export function filterAccounts(
  accounts: Account[],
  query: string,
  filter: AccountFilter,
  language: string,
  provider: ProviderFilter = "all",
) {
  const t: T = (tr, en) => (language === "tr" ? tr : en);
  const needle = query.trim().toLocaleLowerCase(language);
  return accounts.filter(
    (a) =>
      (provider === "all" || accountProvider(a) === provider) &&
      `${a.name} ${a.auth?.email ?? ""} ${a.desktop?.email ?? ""} ${a.auth?.orgName ?? ""} ${groupName(a, t)}`
        .toLocaleLowerCase(language)
        .includes(needle) &&
      (filter === "all" ||
        filter === a.kind ||
        (filter === "connected" && !!a.desktop)),
  );
}

/** Avatar colours keyed by `Account.color`, with dark-mode variants. */
export const avatarClass: Record<string, string> = {
  terra: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  olive: "bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-200",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  plum: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
};
