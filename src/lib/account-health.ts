import type { Account, AccountUsage, ModelWindow } from "../../shared/types";
import {
  cliNeedsReconnect,
  desktopCliMismatch,
  displayedIssue,
  readsThroughApp,
} from "../../shared/account-state";
import { clockLocative } from "../../shared/tr-dative";
import { modelLimitFull } from "@/data/selectors";
import { formatClock } from "@/lib/time";
import { macWording } from "@/data/platform";
import { FORMAT_LOCALE, type Locale } from "../../shared/i18n/locales";
import type { MessageId, T } from "../../shared/i18n/translate";

// The helper lives in shared/ so the tray and the keeper read it too; the app keeps importing it from here.
export { displayedIssue };

/** The key of the row action (`rowActions`) that fixes the problem. */
export type AccountFix = "desktop-link" | "cli" | "renew";

export interface AccountHealth {
  tone: "ok" | "warn" | "crit" | "off";
  label: string;
  /** The same state in at most three words, for a list's status column (`accountStatus`). */
  short: string;
  /** The status is a model's own limit used up, not a sign-in: `accountStatus` words it from the limits. */
  limit?: boolean;
  /** Names both sign-ins and their states. */
  detail: string;
  fix?: AccountFix;
}

/** Codex, Antigravity and Gemini accounts sign in with their own key or OAuth, never through the Claude app. */
export const isClaudeAccount = (account: Account) => (account.provider ?? "claude") === "claude";

/** Each status's short form, for a list's status column; a status not listed is short already. */
const SHORT: Partial<Record<MessageId, MessageId>> = {
  "accountHealth.noUsageDataYet": "accountHealth.notReadYet",
  "accountRow.noClaudeAppSignIn": "accountHealth.noAppSignIn",
  "accountHealth.usageSignInNeeded": "planningPanel.signInNeeded",
  "accountHealth.keychainAccessNeeded": "accountHealth.keychainAccess",
  "accountHealth.keyringAccessNeeded": "accountHealth.keyringAccess",
  "accountHealth.connectionNeedsRenewing": "accountHealth.needsRenewing",
  "accountHealth.noUsageSignIn": "accountHealth.noUsageSignInShort",
  "accountRow.usageDataIsOutOfDate": "accountStatus.oldReading",
  "accountHealth.coolingDown": "accountHealth.coolingDownShort",
};

/** Where the status is read: `now` and the planning time zone default to the clock and the system zone. */
type HealthContext = {
  active: boolean;
  desktopRunning: boolean;
  waiting: boolean;
  /** The language the status is read in: the weekday of a model limit's reopening (`modelLimitWords`). */
  language: Locale;
  now?: number;
  zone?: string;
  /** Relay's platform (`diagnostics.platform`): the Keychain on macOS, the keyring elsewhere. */
  platform?: string;
};

/** A locked Keychain (Linux: keyring) as a status. */
const keychainNeeded = (platform?: string): MessageId =>
  macWording(platform) ? "accountHealth.keychainAccessNeeded" : "accountHealth.keyringAccessNeeded";

/**
 * A model's own limit used up on an account that still works (Fable's week, an Antigravity model):
 * "Fable limiti dolu · Pzt 05:00’te açılır". The other models still answer, so it is a warning,
 * never "full"; with several spent the first to open sets the time. Beyond a day the reopening
 * names its weekday ("Pzt 05:00" / "Mon 05:00"), within one the clock alone.
 */
export function modelLimitWords(spent: ModelWindow[], now: number, language: Locale, t: T, zone?: string): string | undefined {
  if (!spent.length) return undefined;
  const count = spent.length;
  const names = spent.map((w) => w.label).join(", ");
  const first = Math.min(...spent.map((w) => Date.parse(w.resetsAt ?? "")).filter(Number.isFinite));
  if (!Number.isFinite(first)) return t("accountHealth.modelLimitFull", { count, names });
  const clock = formatClock(first, language, zone);
  const day =
    first - now < 86_400_000
      ? ""
      : `${new Intl.DateTimeFormat(FORMAT_LOCALE[language], { weekday: "short", timeZone: zone }).format(first)} `;
  return t("accountHealth.modelLimitFullOpens", { count, names, at: `${day}${clock}`, atLocative: `${day}${clockLocative(clock)}` });
}

/**
 * What the usage connection waits for the user to do, when only a prompting refresh (`renew`) can clear it:
 * allow the Keychain, or renew the connection however it was reported. While the service is rate-limited
 * or down, a renewal cannot run, so a flag left from before does not count.
 */
export function renewalIssue(
  usage: AccountUsage | undefined,
): "keychain-locked" | "renewal-required" | undefined {
  const issue = displayedIssue(usage);
  return issue === "keychain-locked" || issue === "renewal-required"
    ? issue
    : undefined;
}

/**
 * The usage sign-in's own state; `accountHealth`'s detail and the sheet's usage row both read it.
 * A usage sign-in of another account than the Claude app sign-in reads the wrong limits: it is needed again.
 */
function signInState(account: Account, usage: AccountUsage | undefined) {
  // No Claude Code sign-in: the Claude app's own sign-in reads the limits where it can.
  if (readsThroughApp(account, usage)) {
    if (cliNeedsReconnect(account, usage)) return "needed";
    return renewalIssue(usage) === "keychain-locked" ? "keychain" : "app";
  }
  if (!account.auth) return "none";
  if (cliNeedsReconnect(account, usage) || desktopCliMismatch(account))
    return "needed";
  const renewal = renewalIssue(usage);
  if (renewal === "keychain-locked") return "keychain";
  return renewal ? "renewing" : "connected";
}

const SIGN_IN_WORDS = {
  none: "accountHealth.none",
  needed: "accountHealth.needed",
  renewing: "accountHealth.needsRenewing",
  // The sign-in itself is fine; the Keychain has to be allowed to read it.
  keychain: "addAccountDialog.connected",
  connected: "addAccountDialog.connected",
  // No usage sign-in of its own: the Claude app's sign-in reads the limits.
  app: "accountHealth.throughTheClaudeApp",
} as const satisfies Record<ReturnType<typeof signInState>, MessageId>;

/**
 * The tone and short status of the usage sign-in, for its row in the details sheet. It follows the same
 * state as `accountHealth`, so the header and the row never contradict each other.
 */
export function usageSignInStatus(
  account: Account,
  usage: AccountUsage | undefined,
  waiting: boolean,
  t: T,
  platform?: string,
): { tone: AccountHealth["tone"]; label: string } {
  if (waiting) return { tone: "warn", label: t("connectionPanels.approveInTheBrowser") };
  if (!isClaudeAccount(account))
    return account.auth?.loggedIn
      ? { tone: "ok", label: t("accountHealth.signInSaved") }
      : { tone: "warn", label: t("accountHealth.none") };
  const state = signInState(account, usage);
  switch (state) {
    case "connected":
    case "app":
      return { tone: "ok", label: t(SIGN_IN_WORDS[state]) };
    case "needed":
      return { tone: "crit", label: t(SIGN_IN_WORDS[state]) };
    case "keychain":
      return {
        tone: "warn",
        label: t(macWording(platform) ? "accountHealth.connectedKeychainAccessNeeded" : "accountHealth.connectedKeyringAccessNeeded"),
      };
    default:
      return { tone: "warn", label: t(SIGN_IN_WORDS[state]) };
  }
}

/**
 * A Codex, Antigravity or Gemini account: no Claude app or Claude Code sign-in applies, so only its own
 * sign-in, a cooldown and the freshness of its limits count. A signed-in account is ready for the gateway.
 */
function otherProviderHealth(
  account: Account,
  usage: AccountUsage | undefined,
  context: HealthContext,
  t: T,
): AccountHealth {
  const signedIn = account.auth?.loggedIn === true;
  // The detail stays short: what the gateway can do with this account.
  const detail = signedIn
    ? t("accountHealth.theGatewayCanUseThisAccount")
    : t("accountHealth.theGatewayCannotUseThisAccount");
  const result = (tone: AccountHealth["tone"], id: MessageId): AccountHealth => ({
    tone,
    label: t(id),
    short: t(SHORT[id] ?? id),
    detail,
  });
  if (context.waiting) return result("warn", "connectionPanels.approveInTheBrowser");
  if (!signedIn) return result("off", "poolCard.notSignedIn");
  const now = context.now ?? Date.now();
  const cooldown = account.cooldownUntil ? Date.parse(account.cooldownUntil) : NaN;
  if (Number.isFinite(cooldown) && cooldown > now)
    return result("warn", "accountHealth.coolingDown");
  if (usage && usage.issue !== "unsupported" && (usage.stale || usage.status === "error"))
    return result("warn", "accountRow.usageDataIsOutOfDate");
  const spent = modelLimitWords(modelLimitFull(usage, now), now, context.language, t, context.zone);
  if (spent) return { tone: "warn", label: spent, short: spent, detail, limit: true };
  return result("ok", "common.ready");
}

/**
 * The one status an account shows, in the table and in the details sheet. The first problem found wins,
 * in this order: a browser approval in progress, no Claude app sign-in, a usage sign-in that must be
 * renewed (or belongs to another account), a locked Keychain, a connection to renew, no usage sign-in,
 * a usage read that failed or is out of date, a model's own limit used up (`modelLimitWords`).
 * Otherwise the account is running in Claude, or ready. The Overview and the panel rows
 * (`accountRowSubtitle`) read this same status.
 */
export function accountHealth(
  account: Account,
  usage: AccountUsage | undefined,
  context: HealthContext,
  t: T,
): AccountHealth {
  if (!isClaudeAccount(account)) return otherProviderHealth(account, usage, context, t);
  const state = signInState(account, usage);
  const renewal = renewalIssue(usage);
  const running = context.active && context.desktopRunning;

  const app: MessageId = !account.desktop
    ? "accountHealth.none"
    : running
      ? "accountHealth.running"
      : "body.saved";
  const detail = t("accountHealth.claudeAppSignInUsageSign", { app: t(app), signIn: t(SIGN_IN_WORDS[state]) });
  const result = (
    tone: AccountHealth["tone"],
    id: MessageId,
    fix?: AccountFix,
  ): AccountHealth => ({ tone, label: t(id), short: t(SHORT[id] ?? id), detail, fix });

  if (context.waiting) return result("warn", "connectionPanels.approveInTheBrowser");
  // Without a saved Claude app sign-in the row action is "save", never "reconnect".
  if (!account.desktop) return result("off", "accountRow.noClaudeAppSignIn", "desktop-link");
  if (state === "needed") return result("crit", "accountHealth.usageSignInNeeded", "cli");
  // A plain refresh cannot clear these: the renewal has to be allowed to prompt.
  if (renewal === "keychain-locked") return result("warn", keychainNeeded(context.platform), "renew");
  if (renewal === "renewal-required") return result("warn", "accountHealth.connectionNeedsRenewing", "renew");
  if (state === "none") return result("warn", "accountHealth.noUsageSignIn", "cli");
  // A failed or old read is not "Ready": the limits shown are not current (a transient error
  // keeps the previous limits, marked stale). The Overview names it the same way.
  if (usage && (usage.stale || usage.status === "error"))
    return result("warn", "accountRow.usageDataIsOutOfDate");
  // Never read (idle, or the first read still loading): neither "Ready" nor "out of date".
  if (!usage?.checkedAt) return result("off", "accountHealth.noUsageDataYet");
  // Fable's week spent is not "Ready": the account answers other models only, so the status says so.
  const now = context.now ?? Date.now();
  const spent = modelLimitWords(modelLimitFull(usage, now), now, context.language, t, context.zone);
  if (spent) return { tone: "warn", label: spent, short: spent, detail, limit: true };
  return result("ok", running ? "accountHealth.running" : "common.ready");
}
