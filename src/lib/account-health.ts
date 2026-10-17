import type { Account, AccountUsage } from "../../shared/types";
import { cliNeedsReconnect } from "../../shared/account-state";

/** The key of the row action (`rowActions`) that fixes the problem. */
export type AccountFix =
  "desktop-link" | "desktop-reconnect" | "cli" | "refresh";

export interface AccountHealth {
  tone: "ok" | "warn" | "crit" | "off";
  label: string;
  /** Names both sign-ins and their states. */
  detail: string;
  fix?: AccountFix;
}

type T = (tr: string, en: string) => string;
type Words = readonly [tr: string, en: string];

/**
 * The one status an account shows, in the table and in the details sheet. The first problem found wins,
 * in this order: a browser approval in progress, no Claude app sign-in, a usage sign-in that must be
 * renewed, a locked Keychain, a connection to renew, no usage sign-in. Otherwise the account is ready.
 */
export function accountHealth(
  account: Account,
  usage: AccountUsage | undefined,
  context: { active: boolean; desktopRunning: boolean; waiting: boolean },
  t: T,
): AccountHealth {
  const needsSignIn = !!account.auth && cliNeedsReconnect(account, usage);
  const renewing =
    usage?.issue === "renewal-required" || !!usage?.connectionRenewalRequired;
  const running = context.active && context.desktopRunning;

  const app: Words = !account.desktop
    ? ["Yok", "None"]
    : running
      ? ["Açık", "Running"]
      : ["Kayıtlı", "Saved"];
  const signIn: Words = !account.auth
    ? ["Yok", "None"]
    : needsSignIn
      ? ["Gerekli", "Needed"]
      : renewing
        ? ["Yenilenmeli", "Needs renewing"]
        : ["Bağlı", "Connected"];
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
  // Without a saved Claude app sign-in the row action is "save", never "renew".
  if (!account.desktop)
    return result(
      "off",
      ["Claude uygulaması girişi yok", "No Claude app sign-in"],
      "desktop-link",
    );
  if (needsSignIn)
    return result(
      "crit",
      ["Limit okuma girişi gerekli", "Usage sign-in needed"],
      "cli",
    );
  if (usage?.issue === "keychain-locked")
    return result(
      "warn",
      ["Anahtarlık izni gerekli", "Keychain access needed"],
      "refresh",
    );
  if (renewing)
    return result(
      "warn",
      ["Bağlantı yenilenmeli", "Connection needs renewing"],
      "refresh",
    );
  if (!account.auth)
    return result(
      "warn",
      ["Limit okuma girişi yok", "No usage sign-in"],
      "cli",
    );
  return result("ok", running ? ["Açık", "Running"] : ["Hazır", "Ready"]);
}
