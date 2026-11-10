import type { Account } from "../../shared/types";
import {
  sameIdentity,
  terminalIdentities,
  type TerminalStatus,
} from "../../shared/terminal-identity";

type T = (tr: string, en: string) => string;

/** Where an account stands with the terminal's Claude Code sign-in, and what to do next. */
export interface TerminalGuide {
  tone: "ok" | "warn" | "off";
  label: string;
  detail?: string;
  steps?: string[];
  /** "link": Relay signs the terminal in to the account; "settings": the fix is the step's setting. */
  action?: "link" | "settings";
}

export function terminalGuide(
  account: Account,
  status: TerminalStatus | undefined,
  t: T,
  language: "tr" | "en",
): TerminalGuide {
  if (!status) return { tone: "off", label: t("Kontrol ediliyor…", "Check in progress…") };
  if (status.mode === "off")
    return {
      tone: "off",
      label: t("Kapalı", "Off"),
      detail: t("Relay terminale dokunmaz.", "Relay does not change the terminal."),
      action: "settings",
    };
  const ids = terminalIdentities(account);
  if (!ids.length)
    return {
      tone: "off",
      label: t("Önce Claude uygulaması girişini kaydet.", "Save the Claude app sign-in first."),
    };
  const current = status.current;
  const here =
    current?.state === "signed-in" &&
    !current.mismatch &&
    !!current.accountUuid &&
    !!current.orgId &&
    ids.some((x) => sameIdentity(x, { accountUuid: current.accountUuid!, orgId: current.orgId! }));
  const saved = status.saved.find((s) => ids.some((x) => sameIdentity(x, s)));
  if (here || saved) {
    const date = saved
      ? new Date(saved.savedAt).toLocaleDateString(language === "tr" ? "tr-TR" : "en-GB", {
          day: "numeric",
          month: "short",
        })
      : undefined;
    return {
      tone: "ok",
      label: here ? t("Bağlı, şu an bu hesapta", "Linked, on this account now") : t("Bağlı", "Linked"),
      ...(here
        ? {}
        : {
            detail: t(
              `Kayıt: ${date}. Bu hesaba geçince terminaldeki “claude” da bu hesaba geçer.`,
              `Saved ${date}. “claude” in the terminal follows when you switch to this account.`,
            ),
          }),
    };
  }
  const email = account.desktop?.email ?? account.auth?.email;
  return {
    tone: "warn",
    label: t("Giriş kayıtlı değil", "No sign-in saved"),
    steps: [
      email
        ? t(`“Bağla”ya bas; tarayıcıda açılan sayfada ${email} ile onayla.`, `Select “Link” and approve with ${email} on the page that opens in your browser.`)
        : t("“Bağla”ya bas; tarayıcıda açılan sayfada bu hesapla onayla.", "Select “Link” and approve with this account on the page that opens in your browser."),
    ],
    detail: t(
      "Terminaldeki şimdiki giriş değişmez; bu hesaba geçince terminaldeki “claude” da geçer. Terminalde claude kullanmıyorsan bu adım gerekmez.",
      "The terminal keeps its current sign-in; “claude” in the terminal follows when you switch to this account. Skip this if you do not use claude in a terminal.",
    ),
    action: "link",
  };
}
