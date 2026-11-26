//! Port of tests/appearance-settings.test.ts.

use std::fs;

use relay_core::appearance::theme_source;
use relay_core::shared::types::{Appearance, default_settings};
use relay_core::store::{Store, StoreOptions, settings_patch_schema};
use serde_json::{Value, json};

#[test]
fn appearance_defaults_to_system_and_old_registries_migrate() {
    assert_eq!(default_settings().appearance, Appearance::System);
    let root = tempfile::Builder::new()
        .prefix("relay-appearance-")
        .tempdir()
        .unwrap();
    let mut settings = serde_json::to_value(default_settings()).unwrap();
    settings.as_object_mut().unwrap().shift_remove("appearance");
    fs::write(
        root.path().join("state.json"),
        json!({ "version": 1, "settings": settings, "accounts": [], "pinned": [], "importEnabled": false, "lineage": {} })
            .to_string(),
    )
    .unwrap();
    let store = Store::open(root.path(), StoreOptions::default()).unwrap();
    assert_eq!(store.state().settings.appearance, Appearance::System);
}

#[test]
fn appearance_patches_accept_only_the_three_modes_and_map_to_the_theme_source() {
    let patch = |value: Value| settings_patch_schema().parse(&value);
    assert!(patch(json!({ "appearance": "dark" })).is_ok());
    assert!(patch(json!({ "appearance": "sepia" })).is_err());
    assert_eq!(
        patch(json!({ "usageWarnings": false })).unwrap(),
        json!({ "usageWarnings": false })
    );
    assert_eq!(theme_source(Appearance::Light), Appearance::Light);
    assert_eq!(theme_source(Appearance::System), Appearance::System);
}
