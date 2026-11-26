//! Port of tests/menu-bar-title.test.ts.

use std::fs;
use std::path::PathBuf;

use relay_core::menu_bar_title::MenuBarTitle;
use relay_core::shared::tray::menu_bar_preview;
use relay_core::shared::types::js::date_parse;
use relay_core::shared::types::{MenuBarItem, MenuBarTitleChoice};
use relay_i18n::Locale::{En, Tr};
use serde_json::{Value, json};

use MenuBarItem::{Account, Cost, FiveHour, Reset, Tokens, Week};

fn file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("relay-menu-bar-title-")
        .tempdir()
        .unwrap();
    let at = dir.path().join("Relay").join("menu-bar.json");
    (dir, at)
}

fn choice(items: &[MenuBarItem]) -> MenuBarTitleChoice {
    MenuBarTitleChoice {
        items: items.to_vec(),
    }
}

#[test]
fn the_menu_bar_title_starts_as_the_five_hour_percent_keeps_a_change_and_outlives_relay() {
    let (_dir, at) = file();
    let mut first = MenuBarTitle::new(&at);
    assert_eq!(first.current(), choice(&[FiveHour]));
    assert!(!at.exists());
    assert_eq!(
        first.set(&choice(&[Tokens, FiveHour, Cost])).unwrap(),
        choice(&[Tokens, FiveHour, Cost])
    );
    // Read again as Relay reads it at its next start; only the owner may read it.
    assert_eq!(
        MenuBarTitle::new(&at).current(),
        choice(&[Tokens, FiveHour, Cost])
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&at).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // The panda alone is a choice too.
    first.set(&choice(&[])).unwrap();
    assert_eq!(MenuBarTitle::new(&at).current(), choice(&[]));
}

#[test]
fn a_menu_bar_title_file_that_cannot_be_read_is_the_default_and_one_too_long_is_cut() {
    let (_dir, at) = file();
    fs::create_dir_all(at.parent().unwrap()).unwrap();
    fs::write(&at, "{not json").unwrap();
    assert_eq!(MenuBarTitle::new(&at).current(), choice(&[FiveHour]));
    fs::write(&at, json!({ "items": "tokens" }).to_string()).unwrap();
    assert_eq!(MenuBarTitle::new(&at).current(), choice(&[FiveHour]));
    let long = json!({ "items": ["week", "nope", "week", "reset", "tokens", "cost", "account"] });
    fs::write(&at, long.to_string()).unwrap();
    assert_eq!(
        MenuBarTitle::new(&at).current(),
        choice(&[Week, Reset, Tokens, Cost])
    );
    // What is kept is what `set` saves, whatever it was given.
    let mut title = MenuBarTitle::new(&at);
    assert_eq!(
        title.set(&choice(&[Account, Account, Cost])).unwrap(),
        choice(&[Account, Cost])
    );
    let saved: Value = serde_json::from_str(&fs::read_to_string(&at).unwrap()).unwrap();
    assert_eq!(saved, json!({ "items": ["account", "cost"] }));
    // The copy handed out is not the one kept.
    title.current().items.push(Week);
    assert_eq!(title.current(), choice(&[Account, Cost]));
}

#[test]
fn settings_previews_the_title_with_sample_figures() {
    let now = date_parse("2026-10-26T09:00:00Z");
    assert_eq!(menu_bar_preview(&[FiveHour], Tr, "Max", now), "%40");
    assert_eq!(
        menu_bar_preview(&[FiveHour, Reset, Cost], Tr, "Max", now),
        "%40 · 1:50 · $18,20"
    );
    assert_eq!(
        menu_bar_preview(&[Tokens, Week, Account], En, "Work", now),
        "12.4M · 35% · Work"
    );
    assert_eq!(
        menu_bar_preview(&[FiveHour, Week, Tokens, Cost], En, "Max", now),
        "40%\u{2009}·\u{2009}35%\u{2009}·\u{2009}12.4M\u{2009}·\u{2009}$18.20"
    );
    assert_eq!(menu_bar_preview(&[], Tr, "Max", now), "");
}
