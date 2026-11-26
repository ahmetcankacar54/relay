//! Port of `tests/routine-failure.test.ts`. Skipped: "the notification and the planning panel read
//! the same labels" (a source-text case over electron/main and src/features/PlanningPanel.tsx).

use relay_core::shared::routine_failure::{routine_failure, routine_failure_notice};
use relay_i18n::{Args, Locale, translate};

#[test]
fn a_known_reason_is_named_in_words_in_both_languages() {
    assert_eq!(
        routine_failure_notice("Studio", "routine-cli-unavailable", Locale::Tr),
        "Studio hesabının limit dönemi başlatılamadı (Claude CLI bulunamadı)."
    );
    assert_eq!(
        routine_failure_notice("Studio", "routine-cli-unavailable", Locale::En),
        "Studio’s limit period did not start (Claude CLI not found)."
    );
    let id = routine_failure(Some("interrupted")).unwrap();
    assert_eq!(
        [
            translate(Locale::Tr, id, &Args::new()),
            translate(Locale::En, id, &Args::new())
        ],
        ["Relay kapandı", "Relay quit"]
    );
}

#[test]
fn a_reason_without_a_label_is_left_out_never_shown_as_a_code() {
    for reason in [
        "routine-request-failed",
        "Wait for the account connection refresh to finish.",
        "",
    ] {
        assert_eq!(
            routine_failure_notice("Studio", reason, Locale::Tr),
            "Studio hesabının limit dönemi başlatılamadı."
        );
        assert_eq!(
            routine_failure_notice("Studio", reason, Locale::En),
            "Studio’s limit period did not start."
        );
    }
    assert_eq!(routine_failure(None), None);
}
