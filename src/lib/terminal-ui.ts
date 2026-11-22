import type { Account } from "../../shared/types";
import {
  sameIdentity,
  terminalIdentities,
  type TerminalStatus,
} from "../../shared/terminal-identity";
import { FORMAT_LOCALE, type Locale } from "../../shared/i18n/locales";
import type { T } from "../../shared/i18n/translate";


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
  language: Locale,
): TerminalGuide {
  if (!status) return { tone: "off", label: t("common.checkInProgress") };
  if (status.mode === "off")
    return {
      tone: "off",
      label: t("common.off"),
      detail: t("terminalUi.relayDoesNotChangeTheTerminal"),
      action: "settings",
    };
  const ids = terminalIdentities(account);
  if (!ids.length)
    return {
      tone: "off",
      label: t("terminalUi.saveTheClaudeAppSignIn"),
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
      ? new Date(saved.savedAt).toLocaleDateString(FORMAT_LOCALE[language], {
          day: "numeric",
          month: "short",
        })
      : undefined;
    return {
      tone: "ok",
      label: here ? t("terminalUi.linkedOnThisAccountNow") : t("terminalUi.linked"),
      ...(here
        ? {}
        : {
            detail: t("terminalUi.savedClaudeInTheTerminalFollows", { date }),
          }),
    };
  }
  const email = account.desktop?.email ?? account.auth?.email;
  return {
    tone: "warn",
    label: t("terminalUi.noSignInSaved"),
    steps: [
      email
        ? t("terminalUi.selectLinkAndApproveWithOn", { email })
        : t("terminalUi.selectLinkAndApproveWithThis"),
    ],
    detail: t("terminalUi.theTerminalKeepsItsCurrentSign"),
    action: "link",
  };
}
