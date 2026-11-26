//! Port of the `shared/terminal-identity` cases of tests/terminal-identity.test.ts; the switcher,
//! Keychain and lock cases belong to the electron/core/terminal-identity port.

#[path = "common/shared_b.rs"]
mod helpers;

use helpers::uuid;
use relay_core::shared::terminal_identity::{
    TerminalIdentity, TerminalOutcome, TerminalReason, TerminalResult, terminal_identities,
    terminal_line,
};
use relay_i18n::Locale;

fn outcome(result: TerminalResult, reason: Option<TerminalReason>, saved: bool) -> TerminalOutcome {
    TerminalOutcome {
        result,
        reason,
        saved,
        unconfirmed: None,
        current: None,
        at: "2026-11-26T00:00:00.000Z".into(),
    }
}

#[test]
fn an_account_s_identities_are_its_desktop_one_and_its_own_lowercase_and_once() {
    let a = uuid();
    let o = uuid();
    let upper_a = a.to_uppercase();
    let upper_o = o.to_uppercase();
    assert_eq!(
        terminal_identities(Some((&upper_a, &o)), Some((Some(&a), Some(&upper_o)))),
        [TerminalIdentity {
            account_uuid: a.clone(),
            org_id: o.clone()
        }]
    );
    assert_eq!(terminal_identities(None, Some((Some(&a), None))), []);
}

#[test]
fn the_outcome_lines_name_the_account_and_what_to_do() {
    let en = Locale::En;
    assert!(
        terminal_line(
            &outcome(TerminalResult::Switched, None, true),
            en,
            Some("Work")
        )
        .unwrap()
        .contains("moved to Work")
    );
    assert!(
        terminal_line(
            &outcome(
                TerminalResult::Unchanged,
                Some(TerminalReason::NoSavedLogin),
                false
            ),
            en,
            Some("Work")
        )
        .unwrap()
        .contains("claude auth login")
    );
    assert_eq!(
        terminal_line(
            &outcome(TerminalResult::Skipped, Some(TerminalReason::Off), false),
            en,
            None
        ),
        None
    );
}

#[test]
fn a_step_that_cannot_run_here_or_fails_for_no_named_reason_says_so() {
    let en = Locale::En;
    assert!(
        terminal_line(
            &outcome(
                TerminalResult::Failed,
                Some(TerminalReason::Unsupported),
                false
            ),
            en,
            None
        )
        .unwrap()
        .contains("cannot manage the terminal sign-in")
    );
    assert!(
        terminal_line(&outcome(TerminalResult::Failed, None, false), en, None)
            .unwrap()
            .contains("cannot change the terminal sign-in")
    );
    assert!(
        terminal_line(
            &outcome(TerminalResult::Switched, None, true),
            en,
            Some("W")
        )
        .unwrap()
        .contains("Restart open terminal sessions")
    );
    // From "a copy saved while in use is put back flagged…": an unconfirmed sign-in asks for a login.
    let unconfirmed = TerminalOutcome {
        unconfirmed: Some(true),
        ..outcome(TerminalResult::Switched, None, true)
    };
    assert!(
        terminal_line(&unconfirmed, en, Some("A"))
            .unwrap()
            .contains("claude auth login")
    );
}
