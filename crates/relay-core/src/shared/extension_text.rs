//! Port of `shared/extension-text.ts`.

use relay_i18n::{Args, Locale, translate};

use super::browser_extension::{ExtensionOutcome, ExtensionReason as R, ExtensionResult};

/// What an extension step says; `None` when there is nothing to say (the feature is off, no
/// extension is installed, or the extension is already on the account).
pub fn extension_line(outcome: &ExtensionOutcome, locale: Locale) -> Option<String> {
    let t = |id: &str| translate(locale, id, &Args::new());
    let reopened = if outcome.restarted && outcome.reopened == Some(false) {
        t("extensionText.relayCannotOpenTheBrowserAgain")
    } else {
        String::new()
    };
    let first = match outcome.result {
        ExtensionResult::Switched => Some(t("extensionText.theExtensionSignInChanged")),
        ExtensionResult::Saved => Some(t("extensionText.relaySavedThePreviousExtensionSign")),
        ExtensionResult::Unchanged => {
            if outcome.cleared == Some(true) {
                Some(t("extensionText.theExtensionWasOnThisAccount"))
            } else if outcome.reason == Some(R::NoSavedLogin) {
                Some(t("extensionText.thisAccountHasNoSavedExtension"))
            } else {
                None
            }
        }
        ExtensionResult::Skipped => match outcome.reason {
            Some(R::ChooseInstance) => Some(t("extensionText.theClaudeExtensionIsInSeveral")),
            Some(R::Unavailable) => Some(t("extensionText.thisToolCannotChangeTheClaude")),
            Some(R::BrowserRunning) => Some(t("extensionText.theBrowserIsOpenSoRelay")),
            Some(R::BrowserDidNotQuit) => Some(t("extensionText.theBrowserDidNotQuitSo")),
            Some(R::UnknownAccount) => Some(t("extensionText.theExtensionOrTheClaudeAi")),
            Some(R::NotOpened) => Some(t("extensionText.theClaudeExtensionWasNeverOpened")),
            Some(R::GuideMismatch) => Some(t("extensionText.theExtensionIsNotOnThis")),
            Some(R::AmbiguousOwner) => Some(t("extensionText.relayCannotTellWhichAccountThe")),
            Some(R::SchemaChanged) => Some(t("extensionText.theBrowserCookieFormatIsNot")),
            Some(R::JournalPending) => Some(t("extensionText.theBrowserCookieFileDidNot")),
            Some(R::LoginExpired) => Some(t("extensionText.thisAccountSSavedClaudeAi")),
            _ => None,
        },
        ExtensionResult::Failed => Some(match outcome.reason {
            Some(R::Locked) => t("extensionText.theExtensionStorageOrTheBrowser"),
            Some(R::SchemaChanged) => t("extensionText.theBrowserCookieFormatIsNot"),
            Some(R::JournalPending) => t("extensionText.theBrowserCookieFileDidNot"),
            Some(R::WriteFailed | R::VerifyFailed) => {
                t("extensionText.relayCannotWriteTheExtensionSign")
            }
            Some(R::RestoreFailed) => t("extensionText.relayCannotWriteTheExtensionSign2"),
            _ => t("extensionText.relayCannotReadTheExtensionSign"),
        }),
    };
    match first {
        None => {
            let trimmed = reopened.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Some(first) => Some(first + &reopened),
    }
}
