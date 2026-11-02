import type { Account, AccountUsage } from "../../shared/types";
import {
  cliNeedsReconnect,
  desktopCliMismatch,
  displayedIssue,
} from "../../shared/account-state";

// The helper lives in shared/ so the tray and the keeper read it too; the app keeps importing it from here.
export { displayedIssue };

/** The key of the row action (`rowActions`) that fixes the problem. */
export type AccountFix = "desktop-link" | "cli" | "renew";

export interface AccountHealth {
  tone: "ok" | "warn" | "crit" | "off";
  label: string;
  /** Names both sign-ins and their states. */
  detail: string;
  fix?: AccountFix;
}

type T = (tr: string, en: string) => string;
type Words = readonly [tr: string, en: string];

/** An account with no usage reading yet, in the Accounts page, the Overview and the panel. */
const NO_USAGE_DATA: Words = ["Limit verisi yok", "No usage data yet"];

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
  if (!account.auth) return "none";
  if (cliNeedsReconnect(account, usage) || desktopCliMismatch(account))
    return "needed";
  const renewal = renewalIssue(usage);
  if (renewal === "keychain-locked") return "keychain";
  return renewal ? "renewing" : "connected";
}

const SIGN_IN_WORDS = {
  none: ["Yok", "None"],
  needed: ["Gerekli", "Needed"],
  renewing: ["Yenilenmeli", "Needs renewing"],
  // The sign-in itself is fine; the Keychain has to be allowed to read it.
  keychain: ["Bağlı", "Connected"],
  connected: ["Bağlı", "Connected"],
} as const satisfies Record<ReturnType<typeof signInState>, Words>;

/**
 * The tone and short status of the usage sign-in, for its row in the details sheet. It follows the same
 * state as `accountHealth`, so the header and the row never contradict each other.
 */
export function usageSignInStatus(
  account: Account,
  usage: AccountUsage | undefined,
  waiting: boolean,
  t: T,
): { tone: AccountHealth["tone"]; label: string } {
  if (waiting)
    return {
      tone: "warn",
      label: t("Tarayıcı onayı bekleniyor", "Waiting for browser approval"),
    };
  const state = signInState(account, usage);
  const [tr, en] = SIGN_IN_WORDS[state];
  switch (state) {
    case "connected":
      return { tone: "ok", label: t(tr, en) };
    case "needed":
      return { tone: "crit", label: t(tr, en) };
    case "keychain":
      return {
        tone: "warn",
        label: t(
          `${tr} · Anahtarlık izni gerekli`,
          `${en} · Keychain access needed`,
        ),
      };
    default:
      return { tone: "warn", label: t(tr, en) };
  }
}

/**
 * The one status an account shows, in the table and in the details sheet. The first problem found wins,
 * in this order: a browser approval in progress, no Claude app sign-in, a usage sign-in that must be
 * renewed (or belongs to another account), a locked Keychain, a connection to renew, no usage sign-in,
 * a usage read that failed or is out of date. Otherwise the account is running in Claude, or ready.
 * The Overview and the panel rows (`accountRowSubtitle`) read this same status.
 */
export function accountHealth(
  account: Account,
  usage: AccountUsage | undefined,
  context: { active: boolean; desktopRunning: boolean; waiting: boolean },
  t: T,
): AccountHealth {
  const state = signInState(account, usage);
  const renewal = renewalIssue(usage);
  const running = context.active && context.desktopRunning;

  const app: Words = !account.desktop
    ? ["Yok", "None"]
    : running
      ? ["Çalışıyor", "Running"]
      : ["Kayıtlı", "Saved"];
  const signIn = SIGN_IN_WORDS[state];
  const detail = t(
    `Claude uygulaması girişi: ${app[0]} · Limit okuma girişi: ${signIn[0]}`,
    `Claude app sign-in: ${app[1]} · Usage sign-in: ${signIn[1]}`,
  );
  const result = (
    tone: AccountHealth["tone"],
    [tr, en]: Words,
    fix?: AccountFix,
  ): AccountHealth => ({ tone, label: t(tr, en), detail, fix });

  if (context.waiting)
    return result("warn", [
      "Tarayıcı onayı bekleniyor",
      "Waiting for browser approval",
    ]);
  // Without a saved Claude app sign-in the row action is "save", never "reconnect".
  if (!account.desktop)
    return result(
      "off",
      ["Claude uygulaması girişi yok", "No Claude app sign-in"],
      "desktop-link",
    );
  if (state === "needed")
    return result(
      "crit",
      ["Limit okuma girişi gerekli", "Usage sign-in needed"],
      "cli",
    );
  // A plain refresh cannot clear these: the renewal has to be allowed to prompt.
  if (renewal === "keychain-locked")
    return result(
      "warn",
      ["Anahtarlık izni gerekli", "Keychain access needed"],
      "renew",
    );
  if (renewal === "renewal-required")
    return result(
      "warn",
      ["Bağlantı yenilenmeli", "Connection needs renewing"],
      "renew",
    );
  if (state === "none")
    return result(
      "warn",
      ["Limit okuma girişi yok", "No usage sign-in"],
      "cli",
    );
  // A failed or old read is not "Ready": the limits shown are not current (a transient error
  // keeps the previous limits, marked stale). The Overview names it the same way.
  if (usage && (usage.stale || usage.status === "error"))
    return result("warn", ["Limit verisi eski", "Usage data is out of date"]);
  // Never read (idle, or the first read still loading): neither "Ready" nor "out of date".
  if (!usage?.checkedAt) return result("off", NO_USAGE_DATA);
  return result("ok", running ? ["Çalışıyor", "Running"] : ["Hazır", "Ready"]);
}
