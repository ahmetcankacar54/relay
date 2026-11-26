//! Port of the `shared/shortcuts` cases of tests/global-shortcuts.test.ts. The registrar
//! (electron/core/global-shortcuts), store schema, main-source and Settings UI cases belong to
//! their own ports or are source-text/UI checks.

use relay_core::shared::shortcuts::{
    KeyPress, accelerator_from_keys, default_shortcut, format_accelerator, normalize_accelerator,
    shortcut_for,
};
use relay_core::shared::types::{ShortcutAction, ShortcutSettings};

fn press(code: &str, meta: bool, ctrl: bool, alt: bool, shift: bool) -> KeyPress {
    KeyPress {
        code: code.into(),
        meta_key: meta,
        ctrl_key: ctrl,
        alt_key: alt,
        shift_key: shift,
    }
}

#[test]
fn accelerators_are_normalized_to_one_spelling_and_need_cmd_ctrl_alt_or_super() {
    let n = |text: &str| normalize_accelerator(text);
    assert_eq!(
        n("cmdorctrl+shift+option+space").as_deref(),
        Some("CommandOrControl+Alt+Shift+Space")
    );
    assert_eq!(n("Shift+Ctrl+k").as_deref(), Some("Control+Shift+K"));
    assert_eq!(n("Super+Esc").as_deref(), Some("Super+Escape"));
    assert_eq!(n("Ctrl++").as_deref(), Some("Control+Plus"));
    assert_eq!(n("Alt+Enter").as_deref(), Some("Alt+Return"));
    assert_eq!(n("F13").as_deref(), Some("F13"));
    let open = default_shortcut(ShortcutAction::OpenPanel);
    assert_eq!(n(open).as_deref(), Some(open));
    // A global key without a modifier, or with Shift alone, would take a letter from typing.
    for bad in [
        "R",
        "Shift+R",
        "",
        "Ctrl",
        "Ctrl+Ctrl+R",
        "Ctrl+R+T",
        "Hyper+R",
        "Ctrl+Enterr",
        "Ctrl+ +R",
    ] {
        assert_eq!(n(bad), None, "{bad}");
    }
}

#[test]
fn a_key_press_records_by_the_key_s_place_cmd_on_a_mac_and_ctrl_elsewhere_read_as_command_or_control()
 {
    // Option+R types "®" on a Mac: the recorder reads the key's code, not its character.
    assert_eq!(
        accelerator_from_keys(&press("KeyR", true, false, true, false), "darwin").as_deref(),
        Some("CommandOrControl+Alt+R")
    );
    assert_eq!(
        accelerator_from_keys(&press("KeyR", false, true, true, false), "win32").as_deref(),
        Some("CommandOrControl+Alt+R")
    );
    assert_eq!(
        accelerator_from_keys(&press("KeyR", false, true, false, false), "darwin").as_deref(),
        Some("Control+R")
    );
    assert_eq!(
        accelerator_from_keys(&press("Digit5", true, false, false, false), "linux").as_deref(),
        Some("Super+5")
    );
    assert_eq!(
        accelerator_from_keys(&press("ArrowUp", false, true, false, true), "linux").as_deref(),
        Some("CommandOrControl+Shift+Up")
    );
    assert_eq!(
        accelerator_from_keys(&press("Space", true, false, true, true), "darwin").as_deref(),
        Some(default_shortcut(ShortcutAction::OpenPanel))
    );
    assert_eq!(
        accelerator_from_keys(&press("Comma", false, false, true, false), "win32").as_deref(),
        Some("Alt+,")
    );
    assert_eq!(
        accelerator_from_keys(&press("F5", false, false, false, false), "win32").as_deref(),
        Some("F5")
    );
    // Only modifiers down yet, Shift alone, or a key Electron cannot name: nothing recorded.
    assert_eq!(
        accelerator_from_keys(&press("ShiftLeft", false, false, false, true), "darwin"),
        None
    );
    assert_eq!(
        accelerator_from_keys(&press("KeyA", false, false, false, true), "darwin"),
        None
    );
    assert_eq!(
        accelerator_from_keys(&press("IntlBackslash", false, true, false, false), "win32"),
        None
    );
}

#[test]
fn accelerators_read_as_the_platform_writes_them() {
    let open = default_shortcut(ShortcutAction::OpenPanel);
    assert_eq!(format_accelerator(open, "darwin"), "⌥⇧⌘Space");
    assert_eq!(format_accelerator("Control+Alt+R", "darwin"), "⌃⌥R");
    assert_eq!(format_accelerator(open, "win32"), "Ctrl+Alt+Shift+Space");
    assert_eq!(format_accelerator("Super+Up", "win32"), "Win+Up");
    assert_eq!(format_accelerator("Super+Up", "linux"), "Super+Up");
}

#[test]
fn a_missing_choice_means_the_default_opening_relay_has_one_switching_starts_off() {
    assert_eq!(
        shortcut_for(None, ShortcutAction::OpenPanel),
        default_shortcut(ShortcutAction::OpenPanel)
    );
    assert_eq!(shortcut_for(None, ShortcutAction::SwitchToSuggested), "");
    let off = ShortcutSettings {
        open_panel: Some(String::new()),
        switch_to_suggested: None,
    };
    assert_eq!(shortcut_for(Some(&off), ShortcutAction::OpenPanel), "");
}
