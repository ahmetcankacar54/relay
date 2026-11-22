import type { ExtensionOutcome } from "./browser-extension";
import type { T } from "./i18n/translate";


/**
 * What an extension step says, Turkish first; undefined when there is nothing to say (the
 * feature is off, no extension is installed, or the extension is already on the account).
 */
export function extensionLine(outcome: ExtensionOutcome, t: T): string | undefined {
  const reopened =
    outcome.restarted && outcome.reopened === false
      ? t("extensionText.relayCannotOpenTheBrowserAgain")
      : "";
  const first = (() => {
    switch (outcome.result) {
      case "switched":
        return t("extensionText.theExtensionSignInChanged");
      case "saved":
        return t("extensionText.relaySavedThePreviousExtensionSign");
      case "unchanged":
        if (outcome.cleared)
          return t("extensionText.theExtensionWasOnThisAccount");
        return outcome.reason === "no-saved-login"
          ? t("extensionText.thisAccountHasNoSavedExtension")
          : undefined;
      case "skipped":
        switch (outcome.reason) {
          case "choose-instance":
            return t("extensionText.theClaudeExtensionIsInSeveral");
          case "unavailable":
            return t("extensionText.thisToolCannotChangeTheClaude");
          case "browser-running":
            return t("extensionText.theBrowserIsOpenSoRelay");
          case "browser-did-not-quit":
            return t("extensionText.theBrowserDidNotQuitSo");
          case "unknown-account":
            return t("extensionText.theExtensionOrTheClaudeAi");
          case "not-opened":
            return t("extensionText.theClaudeExtensionWasNeverOpened");
          case "guide-mismatch":
            return t("extensionText.theExtensionIsNotOnThis");
          case "ambiguous-owner":
            return t("extensionText.relayCannotTellWhichAccountThe");
          case "schema-changed":
            return t("extensionText.theBrowserCookieFormatIsNot");
          case "journal-pending":
            return t("extensionText.theBrowserCookieFileDidNot");
          case "login-expired":
            return t("extensionText.thisAccountSSavedClaudeAi");
          default:
            return undefined;
        }
      case "failed":
        switch (outcome.reason) {
          case "locked":
            return t("extensionText.theExtensionStorageOrTheBrowser");
          case "schema-changed":
            return t("extensionText.theBrowserCookieFormatIsNot");
          case "journal-pending":
            return t("extensionText.theBrowserCookieFileDidNot");
          case "write-failed":
          case "verify-failed":
            return t("extensionText.relayCannotWriteTheExtensionSign");
          case "restore-failed":
            return t("extensionText.relayCannotWriteTheExtensionSign2");
          default:
            return t("extensionText.relayCannotReadTheExtensionSign");
        }
    }
  })();
  if (first === undefined) return reopened.trim() || undefined;
  return first + reopened;
}
