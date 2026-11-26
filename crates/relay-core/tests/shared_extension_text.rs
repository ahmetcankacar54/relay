//! Port of the `shared/extension-text` cases of tests/extension-ui.test.ts; the rest of that file
//! renders React UI (src/) and stays in TS.

use relay_core::shared::browser_extension::{
    ExtensionOutcome, ExtensionReason as R, ExtensionResult,
};
use relay_core::shared::extension_text::extension_line;
use relay_i18n::Locale;

fn outcome(result: ExtensionResult, reason: Option<R>) -> ExtensionOutcome {
    ExtensionOutcome {
        result,
        reason,
        saved: true,
        cleared: None,
        current: None,
        at: "2026-11-26T12:00:00.000Z".into(),
        restarted: false,
        reopened: None,
    }
}

fn line(o: &ExtensionOutcome, locale: Locale) -> String {
    extension_line(o, locale).unwrap_or_else(|| panic!("no line for {o:?}"))
}

#[test]
fn each_outcome_says_what_happened_or_nothing_when_there_is_nothing_to_say() {
    use ExtensionResult::*;
    let (en, tr) = (Locale::En, Locale::Tr);
    assert_eq!(
        extension_line(&outcome(Switched, None), en).as_deref(),
        Some("The extension sign-in changed.")
    );
    assert!(
        line(&outcome(Saved, Some(R::NoSavedLogin)), tr)
            .contains("Eklentinin önceki girişi kaydedildi")
    );
    assert!(
        line(&outcome(Unchanged, Some(R::NoSavedLogin)), en).contains("no saved extension sign-in")
    );
    assert_eq!(
        extension_line(&outcome(Unchanged, Some(R::AlreadyThere)), en),
        None
    );
    assert_eq!(extension_line(&outcome(Skipped, Some(R::Off)), en), None);
    assert_eq!(
        extension_line(&outcome(Skipped, Some(R::NotInstalled)), en),
        None
    );
    assert!(
        line(&outcome(Skipped, Some(R::BrowserRunning)), tr).contains("Tarayıcı açık olduğu için")
    );
    assert!(line(&outcome(Skipped, Some(R::BrowserDidNotQuit)), en).contains("did not quit"));
    assert!(line(&outcome(Skipped, Some(R::UnknownAccount)), en).contains("is not in Relay"));
    assert!(
        line(&outcome(Skipped, Some(R::ChooseInstance)), en).contains("several browser profiles")
    );
    assert!(
        line(&outcome(Skipped, Some(R::Unavailable)), en).contains(
            "In Relay.app, use Settings → Switching → Claude browser extension → Sync now"
        )
    );
    assert!(
        line(&outcome(Failed, Some(R::WriteFailed)), en)
            .contains("Relay put back the previous state")
    );
    assert!(line(&outcome(Failed, Some(R::Locked)), en).contains("open in another process"));
    assert!(line(&outcome(Failed, Some(R::RestoreFailed)), en).contains("extension-scratch"));
    assert!(
        line(&outcome(Failed, Some(R::Unreadable)), en)
            .contains("Relay cannot read the extension sign-in")
    );
    // A browser Relay quit and could not open again is said even when the step had nothing to say.
    let quit = |o: ExtensionOutcome| ExtensionOutcome {
        restarted: true,
        reopened: Some(false),
        ..o
    };
    assert!(
        line(&quit(outcome(Unchanged, Some(R::AlreadyThere))), en)
            .contains("Relay cannot open the browser again")
    );
    assert!(
        line(&quit(outcome(Switched, None)), tr)
            .contains("Eklenti girişi değişti. Tarayıcı yeniden açılamadı")
    );
}

#[test]
fn the_new_reasons_have_a_sentence_in_both_languages_and_none_names_a_token_or_a_cookie() {
    for reason in [
        R::GuideMismatch,
        R::AmbiguousOwner,
        R::SchemaChanged,
        R::JournalPending,
    ] {
        let o = outcome(ExtensionResult::Skipped, Some(reason));
        let text = format!("{}{}", line(&o, Locale::Tr), line(&o, Locale::En)).to_lowercase();
        for word in ["sessionkey", "token", "secret"] {
            assert!(!text.contains(word), "{reason:?}");
        }
    }
    assert!(
        line(
            &outcome(ExtensionResult::Failed, Some(R::SchemaChanged)),
            Locale::En
        )
        .contains("cookie format")
    );
    assert!(
        line(
            &outcome(ExtensionResult::Failed, Some(R::JournalPending)),
            Locale::En
        )
        .contains("did not close correctly")
    );
    // From "the guide for a profile whose extension was never opened…".
    let never = ExtensionOutcome {
        saved: false,
        ..outcome(ExtensionResult::Skipped, Some(R::NotOpened))
    };
    assert!(line(&never, Locale::En).contains("never opened"));
}
