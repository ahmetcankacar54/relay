//! Port of `tests/store-shared.test.ts`: the registry shared by the app and the CLI.

mod lock_child;

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use lock_child::hold_in_child;
use relay_core::process_lock::ProcessLockError;
use relay_core::shared::browser_extension::{
    BrowserApp, ExtensionMode, ExtensionSetting, ExtensionTarget,
};
use relay_core::shared::types::{AccountKind, CreateAccount};
use relay_core::store::{STATE_SCHEMA, Store, StoreError, StoreOptions, WriteRefusedReason};
use serde_json::{Value, json};

fn folder() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-store-shared-")
        .tempdir()
        .unwrap()
}
fn raw(dir: &Path) -> Value {
    serde_json::from_slice(&fs::read(dir.join("state.json")).unwrap()).unwrap()
}
fn write_raw(dir: &Path, value: &Value) {
    fs::write(
        dir.join("state.json"),
        serde_json::to_string(value).unwrap(),
    )
    .unwrap();
}
fn personal(name: &str) -> CreateAccount {
    CreateAccount {
        name: name.into(),
        kind: AccountKind::Personal,
        group: None,
        provider: None,
    }
}
fn app(dir: &Path) -> Store {
    Store::open(dir, StoreOptions::default()).unwrap()
}
fn cli(dir: &Path) -> Store {
    Store::open(dir, StoreOptions::cli()).unwrap()
}
fn names(store: &Store) -> Vec<String> {
    store.state().accounts.into_iter().map(|a| a.name).collect()
}

#[test]
fn two_stores_on_one_folder_never_lose_each_others_writes() {
    let dir = folder();
    let a = app(dir.path());
    let b = cli(dir.path());
    a.create(&personal("A")).unwrap();
    b.create(&personal("B")).unwrap();
    a.update(|s| s.accounts[0].name = "A2".into()).unwrap();
    assert_eq!(names(&app(dir.path())), ["A2", "B"]);
    assert!(!dir.path().join("state.lock").exists());
}

#[test]
fn reload_sees_another_processs_write_and_only_then_reports_a_change() {
    let dir = folder();
    let a = app(dir.path());
    let b = cli(dir.path());
    b.create(&personal("B")).unwrap();
    assert!(a.reload().unwrap());
    assert_eq!(a.state().accounts.len(), 1);
    assert!(!a.reload().unwrap());
}

#[test]
fn every_write_stamps_this_builds_schema_and_the_apps_default_options_stamp_a_schema_less_file_on_open()
 {
    let dir = folder();
    app(dir.path()).create(&personal("A")).unwrap();
    assert_eq!(raw(dir.path())["schema"], json!(STATE_SCHEMA));
    let mut old = raw(dir.path());
    old.as_object_mut().unwrap().remove("schema");
    write_raw(dir.path(), &old);
    let cli = Store::open(
        dir.path(),
        StoreOptions {
            adopt_unversioned: false,
            ..StoreOptions::cli()
        },
    )
    .unwrap();
    assert_eq!(cli.file_schema(), 1);
    assert_eq!(raw(dir.path()).get("schema"), None);
    let app = app(dir.path());
    assert_eq!(app.file_schema(), STATE_SCHEMA);
    assert_eq!(raw(dir.path())["schema"], json!(STATE_SCHEMA));
}

#[test]
fn a_newer_file_is_read_leniently_and_every_write_is_refused() {
    let dir = folder();
    app(dir.path()).create(&personal("A")).unwrap();
    let mut newer = raw(dir.path());
    newer["schema"] = json!(STATE_SCHEMA + 1);
    newer["settings"]["futureKey"] = json!(true);
    newer["settings"]["planning"]["futurePlanning"] = json!(1);
    newer["accounts"][0]["futureField"] = json!("x");
    write_raw(dir.path(), &newer);
    let before = fs::read_to_string(dir.path().join("state.json")).unwrap();
    let store = cli(dir.path());
    assert_eq!(store.state().accounts[0].name, "A");
    assert_eq!(store.file_schema(), STATE_SCHEMA + 1);
    match store.create(&personal("B")) {
        Err(StoreError::WriteRefused(e)) => assert_eq!(e.reason, WriteRefusedReason::NewerSchema),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("state.json")).unwrap(),
        before
    );
}

#[test]
fn an_unversioned_file_is_refused_when_adopt_unversioned_is_false() {
    let dir = folder();
    app(dir.path()).create(&personal("A")).unwrap();
    let mut old = raw(dir.path());
    old.as_object_mut().unwrap().remove("schema");
    write_raw(dir.path(), &old);
    let store = Store::open(
        dir.path(),
        StoreOptions {
            adopt_unversioned: false,
            ..StoreOptions::cli()
        },
    )
    .unwrap();
    match store.update(|_| {}) {
        Err(StoreError::WriteRefused(e)) => assert_eq!(e.reason, WriteRefusedReason::Unversioned),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_clis_options_skip_open_time_backups_and_migrations() {
    let dir = folder();
    app(dir.path()).create(&personal("A")).unwrap();
    let mut old = raw(dir.path());
    old["settings"]
        .as_object_mut()
        .unwrap()
        .remove("historyPolicyVersion");
    write_raw(dir.path(), &old);
    let backups = || {
        fs::read_dir(dir.path().join("state-backups"))
            .map(|d| d.count())
            .unwrap_or(0)
    };
    let count = backups();
    cli(dir.path());
    assert_eq!(backups(), count);
    assert_eq!(
        raw(dir.path())["settings"].get("historyPolicyVersion"),
        None
    );
}

#[test]
fn a_state_lock_held_by_another_process_makes_update_wait_then_throw_after_lock_wait_ms() {
    let dir = folder();
    let store = Store::open(
        dir.path(),
        StoreOptions {
            lock_wait_ms: 200,
            ..StoreOptions::cli()
        },
    )
    .unwrap();
    let _child = hold_in_child(&dir.path().join("state.lock"), "state", "cli", 0);
    let started = Instant::now();
    match store.create(&personal("A")) {
        Err(StoreError::Lock(ProcessLockError::Busy(_))) => {}
        other => panic!("{other:?}"),
    }
    assert!(started.elapsed() >= Duration::from_millis(200));
}

#[test]
fn a_schema_3_registry_with_a_browser_profile_opens_without_it_and_is_written_as_the_current_schema()
 {
    let dir = folder();
    app(dir.path()).create(&personal("A")).unwrap();
    let mut old = raw(dir.path());
    old["schema"] = json!(3);
    old["accounts"][0]["browser"] = json!({ "app": "brave", "profile": "Default", "name": "Work" });
    write_raw(dir.path(), &old);
    let store = app(dir.path());
    assert_eq!(STATE_SCHEMA, 8);
    assert_eq!(raw(dir.path())["schema"], json!(8));
    assert_eq!(raw(dir.path())["accounts"][0].get("browser"), None);
    // The rest of the account is as it was.
    assert_eq!(store.state().accounts[0].name, "A");
}

#[test]
fn the_claude_extension_setting_survives_a_round_trip_and_a_missing_one_means_the_default() {
    let dir = folder();
    let store = app(dir.path());
    assert_eq!(store.state().settings.claude_extension, None);
    let closed = ExtensionSetting {
        mode: ExtensionMode::Closed,
        browser: Some(ExtensionTarget {
            app: BrowserApp::Brave,
            profile: "Profile 1".into(),
        }),
    };
    let set = closed.clone();
    store
        .update(|s| s.settings.claude_extension = Some(set))
        .unwrap();
    assert_eq!(
        cli(dir.path()).state().settings.claude_extension,
        Some(closed)
    );
    store
        .update(|s| {
            s.settings.claude_extension = Some(ExtensionSetting {
                mode: ExtensionMode::Off,
                browser: None,
            })
        })
        .unwrap();
    assert_eq!(
        raw(dir.path())["settings"]["claudeExtension"],
        json!({ "mode": "off" })
    );
}

#[test]
fn an_extension_setting_with_an_unsafe_folder_an_unknown_browser_or_an_unknown_mode_is_refused() {
    // Unknown browsers, modes and keys cannot be built in Rust; the file schema refuses them.
    let dir = folder();
    let store = app(dir.path());
    for profile in ["../Default", "--flag"] {
        let setting = ExtensionSetting {
            mode: ExtensionMode::Restart,
            browser: Some(ExtensionTarget {
                app: BrowserApp::Brave,
                profile: profile.into(),
            }),
        };
        assert!(
            store
                .update(|s| s.settings.claude_extension = Some(setting))
                .is_err()
        );
    }
    let schema = relay_core::store::extension_setting_schema();
    for bad in [
        json!({ "mode": "restart", "browser": { "app": "safari", "profile": "Default" } }),
        json!({ "mode": "always" }),
        json!({ "mode": "restart", "extra": 1 }),
    ] {
        assert!(!schema.accepts(&bad), "{bad}");
    }
    assert_eq!(store.state().settings.claude_extension, None);
}

#[test]
fn a_schema_4_registrys_extension_mode_never_turns_into_one_that_writes_to_a_browser() {
    for (mode, expected) in [("restart", "guide"), ("closed", "guide"), ("off", "off")] {
        let dir = folder();
        app(dir.path()).create(&personal("A")).unwrap();
        let mut old = raw(dir.path());
        old["schema"] = json!(4);
        old["settings"]["claudeExtension"] =
            json!({ "mode": mode, "browser": { "app": "brave", "profile": "Default" } });
        write_raw(dir.path(), &old);
        let store = app(dir.path());
        let extension = store.state().settings.claude_extension.unwrap();
        assert_eq!(
            serde_json::to_value(extension.mode).unwrap(),
            json!(expected)
        );
        // The chosen browser profile stays.
        assert_eq!(
            extension.browser,
            Some(ExtensionTarget {
                app: BrowserApp::Brave,
                profile: "Default".into()
            })
        );
        assert_eq!(raw(dir.path())["schema"], json!(STATE_SCHEMA));
        assert_eq!(
            raw(dir.path())["settings"]["claudeExtension"]["mode"],
            json!(expected)
        );
    }
}

#[test]
fn a_schema_5_registry_keeps_the_modes_that_write_to_a_browser_and_accepts_guide() {
    for mode in [
        ExtensionMode::Restart,
        ExtensionMode::Closed,
        ExtensionMode::Guide,
        ExtensionMode::Off,
    ] {
        let dir = folder();
        let first = app(dir.path());
        first
            .update(|s| {
                s.settings.claude_extension = Some(ExtensionSetting {
                    mode,
                    browser: None,
                })
            })
            .unwrap();
        assert_eq!(raw(dir.path())["schema"], json!(STATE_SCHEMA));
        assert_eq!(
            app(dir.path())
                .state()
                .settings
                .claude_extension
                .map(|e| e.mode),
            Some(mode)
        );
    }
}

#[test]
fn a_0_18_registry_written_under_schema_6_opens_drops_the_removed_live_switch_setting_and_is_written_as_the_current_schema()
 {
    let dir = folder();
    app(dir.path()).create(&personal("A")).unwrap();
    let mut old = raw(dir.path());
    old["schema"] = json!(6);
    old["settings"]["cdpHotSwitch"] = json!(true);
    old["accounts"][0]["provider"] = json!("claude");
    write_raw(dir.path(), &old);
    let store = app(dir.path());
    assert_eq!(raw(dir.path())["schema"], json!(STATE_SCHEMA));
    assert_eq!(raw(dir.path())["settings"].get("cdpHotSwitch"), None);
    assert_eq!(store.state().accounts[0].name, "A");
}
