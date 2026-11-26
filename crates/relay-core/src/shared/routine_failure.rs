//! Port of `shared/routine-failure.ts`: why the keeper could not start an account's limit period,
//! in words. The planning panel and the notification main shows both read them.

use relay_i18n::{Args, Locale, translate};

const ROUTINE_FAILURES: [(&str, &str); 8] = [
    (
        "routine-policy-unverified",
        "routineFailure.administratorPolicyOrIdentityNot",
    ),
    (
        "routine-policy-check-failed",
        "routineFailure.administratorPolicyCheckFailedRelay",
    ),
    (
        "routine-cli-unavailable",
        "routineFailure.claudeCliNotFound",
    ),
    (
        "routine-cli-unsupported",
        "routineFailure.claudeCliVersionNotSupported",
    ),
    (
        "routine-credentials-unavailable",
        "routineFailure.usageSignInExpired",
    ),
    (
        "routine-platform-unsupported",
        "routineFailure.notSupportedOnThisSystem",
    ),
    ("routine-settings-changed", "routineFailure.settingsChanged"),
    ("interrupted", "routineFailure.relayQuit"),
];

/// The message id for a keeper failure reason; `None` for a reason without a label.
pub fn routine_failure(reason: Option<&str>) -> Option<&'static str> {
    let reason = reason.unwrap_or("");
    ROUTINE_FAILURES
        .iter()
        .find(|(key, _)| *key == reason)
        .map(|(_, id)| *id)
}

/// The notification when an account's limit period could not start; an unlabelled reason is left
/// out.
pub fn routine_failure_notice(name: &str, reason: &str, language: Locale) -> String {
    match routine_failure(Some(reason)) {
        Some(words) => translate(
            language,
            "routineFailure.limitPeriodDidNotStartReason",
            &Args::new()
                .set("name", name)
                .set("reason", translate(language, words, &Args::new())),
        ),
        None => translate(
            language,
            "routineFailure.limitPeriodDidNotStart",
            &Args::new().set("name", name),
        ),
    }
}
