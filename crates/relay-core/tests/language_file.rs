//! Port of tests/language-file.test.ts.

use std::fs;

use relay_core::language_file::{
    LANGUAGE_FILE, load_language_pref, read_language_pref, write_language_pref,
};
use relay_i18n::{LanguagePref, Locale};
use serde_json::{Value, json};

fn folder() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-language-")
        .tempdir()
        .unwrap()
}

#[test]
fn the_choice_is_written_to_language_json_readable_only_by_the_user_and_read_back() {
    let dir = folder();
    let dir = dir.path();
    write_language_pref(dir, LanguagePref::Locale(Locale::De)).unwrap();
    let text = fs::read_to_string(dir.join(LANGUAGE_FILE)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({ "pref": "de" })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join(LANGUAGE_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert_eq!(
        read_language_pref(dir),
        Some(LanguagePref::Locale(Locale::De))
    );
    write_language_pref(dir, LanguagePref::System).unwrap();
    assert_eq!(read_language_pref(dir), Some(LanguagePref::System));
    let names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, [LANGUAGE_FILE]);
}

#[test]
fn a_first_start_keeps_turkish_for_an_install_with_accounts_the_system_s_language_for_a_new_one() {
    let tr = LanguagePref::Locale(Locale::Tr);
    let existing = folder();
    assert_eq!(load_language_pref(existing.path(), true), tr);
    assert_eq!(read_language_pref(existing.path()), Some(tr));
    let fresh = folder();
    assert_eq!(
        load_language_pref(fresh.path(), false),
        LanguagePref::System
    );
    assert_eq!(read_language_pref(fresh.path()), Some(LanguagePref::System));
    // A saved choice wins over the migration.
    assert_eq!(load_language_pref(existing.path(), false), tr);
}

#[test]
fn a_missing_or_invalid_file_is_no_choice_and_the_migration_replaces_it() {
    let dir = folder();
    let dir = dir.path();
    assert_eq!(read_language_pref(dir), None);
    fs::write(dir.join(LANGUAGE_FILE), r#"{"pref":"xx"}"#).unwrap();
    assert_eq!(read_language_pref(dir), None);
    fs::write(dir.join(LANGUAGE_FILE), "not json").unwrap();
    let tr = LanguagePref::Locale(Locale::Tr);
    assert_eq!(load_language_pref(dir, true), tr);
    assert_eq!(read_language_pref(dir), Some(tr));
}
