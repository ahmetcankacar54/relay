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
  /** "check": Relay should look again after the sign-in; "settings": the fix is the step's setting. */
  action?: "check" | "settings";
}

export function terminalGuide(
  account: Account,
  status: TerminalStatus | undefined,
  t: T,
  language: "tr" | "en",
): TerminalGuide {
  if (!status) return { tone: "off", label: t("Kontrol ediliyor…", "Checking…") };
  if (status.mode === "off")
    return {
      tone: "off",
      label: t("Kapalı · Relay terminale dokunmaz.", "Off · Relay does not touch the terminal."),
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
      label: here
        ? t("Bağlı · terminal şu an bu hesapta", "Linked · the terminal is on this account now")
        : t(`Bağlı · ${date} kaydedildi`, `Linked · saved ${date}`),
      ...(here
        ? {}
        : {
            detail: t(
              "Bu hesaba geçince terminaldeki “claude” da bu hesaba geçer.",
              "Switching to this account moves the terminal’s “claude” too.",
            ),
          }),
    };
  }
  const email = account.desktop?.email ?? account.auth?.email;
  return {
    tone: "warn",
    label: t("Bağlı değil · terminal girişi kayıtlı değil", "Not linked · no terminal sign-in saved"),
    steps: [
      email
        ? t(`Terminalde “claude auth login” çalıştır ve ${email} ile gir.`, `Run “claude auth login” in a terminal and sign in with ${email}.`)
        : t("Terminalde “claude auth login” çalıştır ve bu hesapla gir.", "Run “claude auth login” in a terminal and sign in with this account."),
      t("“Kontrol et”e bas; Relay bağlar.", "Press “Check”; Relay links it."),
    ],
    detail: t(
      "İstersen bu adımı atla: terminalde claude kullanmıyorsan gerekmez.",
      "You can skip this if you do not use claude in a terminal.",
    ),
    action: "check",
  };
}
