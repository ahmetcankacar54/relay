//! Port of the `shared/automation-mode` cases of `tests/automation-mode.test.ts`. The two
//! `withDative` cases of that file are in `shared_automation_mode.rs` (the tr-dative port).

use relay_core::shared::automation_mode::{
    AUTOMATION_MODES, AutomationMode, AutomationModeWrites, automation_mode, automation_mode_writes,
};
use relay_core::shared::types::AutoSwitchMode;
use relay_i18n::{Args, Locale, translate};

#[test]
fn the_mode_comes_from_the_fleet_first_then_prepare_on_quit() {
    assert_eq!(
        automation_mode(AutoSwitchMode::AfterExit, Some(true)),
        AutomationMode::Quota
    );
    assert_eq!(
        automation_mode(AutoSwitchMode::Off, Some(true)),
        AutomationMode::Quota
    );
    assert_eq!(
        automation_mode(AutoSwitchMode::AfterExit, Some(false)),
        AutomationMode::AfterExit
    );
    assert_eq!(
        automation_mode(AutoSwitchMode::AfterExit, None),
        AutomationMode::AfterExit
    );
    assert_eq!(
        automation_mode(AutoSwitchMode::Off, None),
        AutomationMode::Off
    );
}

#[test]
fn each_mode_writes_both_records() {
    let writes = |fleet, auto_switch_mode| AutomationModeWrites {
        fleet,
        auto_switch_mode,
    };
    assert_eq!(
        automation_mode_writes(AutomationMode::Off),
        writes(false, AutoSwitchMode::Off)
    );
    assert_eq!(
        automation_mode_writes(AutomationMode::AfterExit),
        writes(false, AutoSwitchMode::AfterExit)
    );
    assert_eq!(
        automation_mode_writes(AutomationMode::Quota),
        writes(true, AutoSwitchMode::Off)
    );
    assert_eq!(
        serde_json::to_value(automation_mode_writes(AutomationMode::AfterExit)).unwrap(),
        serde_json::json!({ "fleet": false, "autoSwitchMode": "after-exit" })
    );
}

#[test]
fn every_mode_has_a_turkish_and_english_label_and_description() {
    assert_eq!(
        AUTOMATION_MODES.map(|mode| mode.value.as_str()),
        ["off", "after-exit", "quota"]
    );
    let both = |id: &str| {
        [
            translate(Locale::Tr, id, &Args::new()),
            translate(Locale::En, id, &Args::new()),
        ]
    };
    assert_eq!(
        AUTOMATION_MODES.map(|mode| both(mode.label)),
        [
            ["Kapalı", "Off"],
            ["Claude uygulaması kapanınca", "When the Claude app quits"],
            ["Limit dolunca", "When the limit is reached"],
        ]
    );
    let [off, after_exit, quota] = AUTOMATION_MODES;
    assert_eq!(
        both(off.description),
        [
            "Relay hesabı kendiliğinden değiştirmez.",
            "Relay does not switch accounts automatically."
        ]
    );
    assert_eq!(
        both(after_exit.description),
        [
            "Limit dolunca, kapattığında sıradaki hesabı hazırlar.",
            "At the limit, prepares the next account when you quit."
        ]
    );
    assert_eq!(
        both(quota.description),
        [
            "Sıradaki hesapla açar, duran konuşmaları sürdürür.",
            "Opens the next account and continues stopped conversations."
        ]
    );
}
