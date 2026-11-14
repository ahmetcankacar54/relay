import type { Account, AccountProvider } from "../../../shared/types";

type T = (tr: string, en: string) => string;

/** An account's plan as every screen names it: the header, the table, the Overview, Planning. */
export interface AccountPlanInfo {
  /** The full name: "Max 5×", "ChatGPT Plus", "Google AI Pro". */
  label: string;
  /** Without the product family, for tight badges: "Plus", "AI Pro". */
  short: string;
  /** Read from the provider (sign-in or usage reading), or picked by the user for planning. */
  source: "detected" | "chosen";
  provider: AccountProvider;
}

type Name = [label: string, short?: string];

/** Claude's tiers, as planning counts them (`planning.plan`, `auth.plan`). */
const CLAUDE_TIERS: Record<string, string> = {
  pro: "Pro",
  max5: "Max 5×",
  max20: "Max 20×",
  team: "Team",
};

/** Claude Code's subscriptionType, which says Max but not 5× or 20×. */
const CLAUDE_SUBSCRIPTIONS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
};

/** The Google plan loadCodeAssist names (see parseAntigravityTier). */
const GOOGLE_PLANS: Record<string, Name> = {
  pro: ["Google AI Pro", "AI Pro"],
  ultra: ["Google AI Ultra", "AI Ultra"],
  free: ["Free"],
  standard: ["Code Assist Standard", "Standard"],
  legacy: ["Legacy"],
};

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A plan word a provider reported, named for the screen: Claude's subscriptionType, ChatGPT's
 * plan_type, the Google tier. Undefined when it is empty, "unknown" or the "Antigravity OAuth"
 * placeholder saved before the Google plan could be read.
 */
export function providerPlan(
  provider: AccountProvider | undefined,
  raw: string | undefined,
): AccountPlanInfo | undefined {
  const p = provider ?? "claude";
  const word = raw
    ?.trim()
    .toLowerCase()
    .replace(/^(?:claude|codex|openai|chatgpt|antigravity|gemini)\s+/, "");
  if (!word || word === "unknown" || word.includes("oauth")) return undefined;
  const named = (label: string, short = label): AccountPlanInfo => ({
    label,
    short,
    source: "detected",
    provider: p,
  });
  if (p === "codex") {
    // A Codex account added with an OpenAI API key bills the API, not a ChatGPT plan.
    if (word === "api key") return named("OpenAI API", "API");
    // plan_type is ChatGPT's own plan word (free, go, plus, pro, team, business, enterprise, edu).
    const name = capitalize(word.replace(/[_-]+/g, " "));
    return named(`ChatGPT ${name}`, name);
  }
  if (p === "antigravity" || p === "gemini") {
    // Any other tier id is Google's internal name, which no user would recognise.
    const google = GOOGLE_PLANS[word];
    return google && named(...google);
  }
  return named(CLAUDE_SUBSCRIPTIONS[word] ?? capitalize(word));
}

/**
 * The Claude tier read from the sign-in, while that sign-in holds. Planning follows it, so the
 * user is not asked to pick it.
 */
export const detectedClaudePlan = (account: Account) =>
  accountProvider(account) === "claude" && account.auth?.loggedIn ? account.auth.plan : undefined;

/**
 * An account's plan, the same everywhere. Claude: the tier read from the sign-in, else the one
 * picked for planning, else the subscription. Codex and Antigravity: the plan their usage reading
 * reported (`auth.subscription`); Claude's tiers never apply to them. Undefined when unknown.
 */
export function accountPlan(account: Account): AccountPlanInfo | undefined {
  const provider = accountProvider(account);
  const reported = providerPlan(provider, account.auth?.subscription);
  if (provider !== "claude") return reported;
  const picked = account.planning?.plan;
  const tier = detectedClaudePlan(account) ?? (picked !== "unknown" ? picked : undefined);
  // Claude Code gives an Enterprise seat Team's limits: only the subscription tells them apart.
  if (reported?.label === "Enterprise" && (!tier || tier === "team")) return reported;
  const label = tier && CLAUDE_TIERS[tier];
  if (!label) return reported;
  // A tier equal to the one the sign-in read was detected, even after that sign-in ended.
  const source = tier === account.auth?.plan ? "detected" : "chosen";
  return { label, short: label, source, provider };
}

/**
 * The plan planning counts with (a Claude tier), named as everywhere else; undefined when none is
 * set, so the planning hours card can show the capacity ("3×") instead.
 */
export function planLabel(account: Account): string | undefined {
  const picked = account.planning?.plan;
  const plan = accountPlan(account);
  return plan?.provider === "claude" && picked && picked !== "unknown" ? plan.label : undefined;
}

/** The plan badge's tooltip: where its plan came from. */
export function planTitle(account: Account, plan: AccountPlanInfo, t: T): string {
  if (plan.source === "chosen") return t("Planlama için seçildi", "Chosen for planning");
  // A Claude subscription without its tier (Max: 5× or 20×?) still leaves planning's plan to pick.
  if (plan.provider === "claude" && !planLabel(account))
    return t(
      "Abonelik · planlama için plan seçilmedi",
      "Subscription · no plan selected for planning",
    );
  return t("Hesaptan algılandı", "Detected from the account");
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
