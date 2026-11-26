//! The registry-schema and Store cases of the settings test files, one module per TS file; the
//! other cases of those files belong to the shared, electron and UI ports (see each module).

use std::fs;
use std::path::Path;

use relay_core::shared::planning::{default_planning, system_time_zone};
use relay_core::shared::types::{
    DesktopHistoryTransfer, RelaySettings, default_planning_settings, default_settings,
};
use relay_core::store::{Store, StoreOptions, settings_patch_schema, settings_schema};
use serde_json::{Map, Value, json};

/// `DEFAULT_SETTINGS` as the JSON object the TS spreads.
fn defaults() -> Map<String, Value> {
    match serde_json::to_value(default_settings()).unwrap() {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

fn defaults_with(key: &str, value: Value) -> Value {
    let mut map = defaults();
    map.insert(key.into(), value);
    Value::Object(map)
}

fn defaults_without(keys: &[&str]) -> Map<String, Value> {
    let mut map = defaults();
    for key in keys {
        map.shift_remove(*key);
    }
    map
}

fn parse_settings(value: &Value) -> Value {
    settings_schema().parse(value).unwrap()
}

fn patch(value: Value) -> Result<Value, relay_core::store::schema::SchemaError> {
    settings_patch_schema().parse(&value)
}

fn folder(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
}

/// A registry saved by an older Relay: `settings` as given, or none.
fn write_state(root: &Path, settings: Option<Value>) {
    let mut state = json!({ "version": 1, "accounts": [], "pinned": [], "importEnabled": false, "lineage": {} });
    if let Some(settings) = settings {
        state["settings"] = settings;
    }
    fs::write(root.join("state.json"), state.to_string()).unwrap();
}

fn open(root: &Path) -> Store {
    Store::open(root, StoreOptions::default()).unwrap()
}

/// `{ ...DEFAULT_SETTINGS, planning: defaultPlanning(), desktopHistoryTransfer: "all" }`.
fn migrated_defaults() -> RelaySettings {
    RelaySettings {
        planning: default_planning(),
        desktop_history_transfer: DesktopHistoryTransfer::All,
        ..default_settings()
    }
}

/// tests/appearance-settings.test.ts; `themeSource` is electron/core/appearance.
mod appearance_settings {
    use super::*;

    #[test]
    fn appearance_defaults_to_system_and_old_registries_migrate() {
        assert_eq!(defaults()["appearance"], json!("system"));
        let root = folder("relay-appearance-");
        write_state(
            root.path(),
            Some(Value::Object(defaults_without(&["appearance"]))),
        );
        assert_eq!(
            serde_json::to_value(open(root.path()).state().settings.appearance).unwrap(),
            json!("system")
        );
    }

    #[test]
    fn appearance_patches_accept_only_the_three_modes_and_map_to_the_theme_source() {
        assert!(patch(json!({ "appearance": "dark" })).is_ok());
        assert!(patch(json!({ "appearance": "sepia" })).is_err());
        assert_eq!(
            patch(json!({ "usageWarnings": false })).unwrap(),
            json!({ "usageWarnings": false })
        );
    }
}

/// tests/history-policy.test.ts: the schema halves of the first two cases (their
/// `historySources` halves are in shared_history_policy.rs) and the Store cases.
mod history_policy {
    use super::*;

    #[test]
    fn history_stays_within_the_sharing_group_by_default_all_accounts_share_only_when_chosen() {
        let legacy = defaults_without(&[
            "desktopHistoryAccounts",
            "autoSwitchMode",
            "autoSwitchAccounts",
        ]);
        let settings = parse_settings(&Value::Object(legacy));
        assert_eq!(settings["autoSwitchMode"], json!("off"));
        assert_eq!(settings["autoSwitchAccounts"], json!([]));
        assert_eq!(settings["desktopHistoryTransfer"], json!("same-group"));
        // Defaults apply on loading only, never to unrelated fields in an IPC patch.
        assert_eq!(
            patch(json!({ "usageWarnings": false })).unwrap(),
            json!({ "usageWarnings": false })
        );
    }

    #[test]
    fn selected_history_requires_both_endpoints_and_excludes_every_unselected_or_unbound_account() {
        let mut selected = defaults();
        selected.insert("desktopHistoryTransfer".into(), json!("selected"));
        let mut live = selected.clone();
        live.insert("autoSwitchMode".into(), json!("live"));
        assert!(settings_schema().parse(&Value::Object(live)).is_err());
        let mut bad = selected;
        bad.insert("desktopHistoryAccounts".into(), json!(["../anything"]));
        assert!(settings_schema().parse(&Value::Object(bad)).is_err());
    }

    #[test]
    fn a_registry_from_before_shared_by_default_moves_from_the_old_group_default_once_explicit_choices_stay()
     {
        for (saved, expected) in [
            ("same-group", DesktopHistoryTransfer::All),
            ("selected", DesktopHistoryTransfer::Selected),
            ("off", DesktopHistoryTransfer::Off),
        ] {
            let root = folder("relay-history-");
            let mut old = defaults_without(&["historyPolicyVersion"]);
            old.insert("desktopHistoryTransfer".into(), json!(saved));
            write_state(root.path(), Some(Value::Object(old)));
            let store = open(root.path());
            assert_eq!(store.state().settings.desktop_history_transfer, expected);
            assert_eq!(store.state().settings.history_policy_version, Some(2));
            // A later deliberate group choice is not migrated again.
            store
                .update(|s| s.settings.desktop_history_transfer = DesktopHistoryTransfer::SameGroup)
                .unwrap();
            assert_eq!(
                open(root.path()).state().settings.desktop_history_transfer,
                DesktopHistoryTransfer::SameGroup
            );
        }
    }

    #[test]
    fn a_new_install_keeps_company_and_personal_code_history_apart() {
        // `historySources` itself is covered in shared_history_policy.rs.
        let root = folder("relay-history-");
        let store = open(root.path());
        assert_eq!(
            store.state().settings.desktop_history_transfer,
            DesktopHistoryTransfer::SameGroup
        );
        assert_eq!(store.state().settings.history_policy_version, Some(2));
        store
            .create(&relay_core::shared::types::CreateAccount {
                name: "Kişisel".into(),
                kind: relay_core::shared::types::AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap();
        // The first write does not change the mode, and the next start keeps it.
        assert_eq!(
            open(root.path()).state().settings.desktop_history_transfer,
            DesktopHistoryTransfer::SameGroup
        );
    }

    #[test]
    fn an_existing_install_keeps_the_history_mode_it_stored() {
        for mode in ["all", "same-group", "selected", "off"] {
            let root = folder("relay-history-");
            let mut old = defaults();
            old.insert("desktopHistoryTransfer".into(), json!(mode));
            old.insert("historyPolicyVersion".into(), json!(2));
            write_state(root.path(), Some(Value::Object(old)));
            let read = |store: &Store| {
                serde_json::to_value(store.state().settings.desktop_history_transfer).unwrap()
            };
            assert_eq!(read(&open(root.path())), json!(mode), "{mode}");
            assert_eq!(read(&open(root.path())), json!(mode), "{mode}");
        }
    }

    #[test]
    fn a_stored_registry_without_the_history_mode_keeps_the_old_default_all_accounts() {
        // Settings that never wrote the field.
        for version in [Some(2), None] {
            let root = folder("relay-history-");
            let mut rest = defaults_without(&["desktopHistoryTransfer", "historyPolicyVersion"]);
            if let Some(version) = version {
                rest.insert("historyPolicyVersion".into(), json!(version));
            }
            write_state(root.path(), Some(Value::Object(rest)));
            let store = open(root.path());
            assert_eq!(
                store.state().settings.desktop_history_transfer,
                DesktopHistoryTransfer::All
            );
            assert_eq!(
                open(root.path()).state().settings.desktop_history_transfer,
                DesktopHistoryTransfer::All
            );
            assert_eq!(
                store.state().settings.usage_refresh_minutes,
                default_settings().usage_refresh_minutes
            );
        }
        // No settings at all.
        let root = folder("relay-history-");
        write_state(root.path(), None);
        let store = open(root.path());
        assert_eq!(store.state().settings, migrated_defaults());
    }

    fn optional_never_defaulted(key: &str, kept: Value, patched: Value, bad: Value) {
        let stored = parse_settings(&Value::Object(defaults()));
        assert_eq!(stored.get(key), None);
        assert_eq!(parse_settings(&defaults_with(key, kept.clone()))[key], kept);
        assert_eq!(
            patch(json!({ key: patched })).unwrap(),
            json!({ key: patched })
        );
        assert_eq!(
            patch(json!({ "appearance": "dark" })).unwrap().get(key),
            None
        );
        assert!(patch(json!({ key: bad })).is_err());
    }

    #[test]
    fn the_menu_bar_animation_setting_is_optional_and_never_defaulted() {
        optional_never_defaulted("menuBarAnimation", json!(false), json!(false), json!("yes"));
    }

    #[test]
    fn the_switch_window_setting_is_optional_and_never_defaulted() {
        optional_never_defaulted("switchWindow", json!(false), json!(false), json!("no"));
    }

    #[test]
    fn the_panda_pranks_setting_is_optional_and_never_defaulted() {
        optional_never_defaulted("pranks", json!("rarely"), json!("off"), json!("never"));
    }

    #[test]
    fn the_draft_re_typing_setting_is_optional_never_defaulted_and_off_when_missing() {
        assert_eq!(defaults().get("draftRetype"), None);
        optional_never_defaulted("draftRetype", json!(true), json!(true), json!("yes"));
        assert_eq!(
            patch(json!({ "draftRetype": false })).unwrap(),
            json!({ "draftRetype": false })
        );
    }
}

/// tests/global-shortcuts.test.ts: the schema case; the rest is electron and UI.
mod global_shortcuts {
    use super::*;

    #[test]
    fn a_choice_is_saved_only_as_relays_own_spelling_a_stored_one_never_rejects_the_registry() {
        assert!(
            patch(
                json!({ "shortcuts": { "openPanel": "Control+Alt+K", "switchToSuggested": "" } })
            )
            .is_ok()
        );
        assert!(patch(json!({ "updateChannel": "beta" })).is_ok());
        for bad in [
            json!({ "openPanel": "ctrl+alt+k" }),
            json!({ "openPanel": "K" }),
            json!({ "other": "Alt+K" }),
            json!({ "openPanel": 4 }),
        ] {
            assert!(patch(json!({ "shortcuts": bad })).is_err(), "{bad}");
        }
        assert!(patch(json!({ "updateChannel": "nightly" })).is_err());
        assert!(settings_schema().accepts(&defaults_with(
            "shortcuts",
            json!({ "openPanel": "Hyper+K" })
        )));
    }
}

/// tests/notification-settings.test.ts: the schema case; the rest is UI.
mod notification_settings {
    use super::*;

    #[test]
    fn the_saved_settings_and_a_patch_take_the_group_and_refuse_unknown_types() {
        let notifications = json!({ "limitFiveHour": false, "limitReset": "all" });
        assert_eq!(
            parse_settings(&defaults_with("notifications", notifications.clone()))["notifications"],
            notifications
        );
        assert_eq!(
            parse_settings(&Value::Object(defaults())).get("notifications"),
            None
        );
        assert_eq!(
            patch(json!({ "notifications": notifications })).unwrap(),
            json!({ "notifications": notifications })
        );
        assert!(patch(json!({ "notifications": { "limitReset": "sometimes" } })).is_err());
        assert!(patch(json!({ "notifications": { "gateway": false } })).is_err());
    }
}

/// tests/planning-settings.test.ts; the DST case is in shared_planning_settings.rs.
mod planning_settings {
    use super::*;
    use relay_core::shared::types::{PlanningAccount, PlanningHours, PlanningSettings};
    use relay_core::store::{planning_from_workday, planning_patch_schema, planning_schema};

    fn default_planning_value() -> Map<String, Value> {
        match serde_json::to_value(default_planning_settings()).unwrap() {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn uuid() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    #[test]
    fn a_legacy_workday_becomes_weekday_weekend_hours_with_its_accounts_and_routine_choice() {
        let (a, b) = (uuid(), uuid());
        let planning = planning_from_workday(Some(&json!({
            "timeZone": "Europe/Istanbul",
            "start": "09:00",
            "end": "21:00",
            "weekdays": [1, 2, 3, 4, 5],
            "accountIds": [a, "not-a-uuid", b, a],
            "routineEnabled": true,
        })));
        let hours = |enabled| PlanningHours {
            enabled,
            start: "09:00".into(),
            end: "21:00".into(),
        };
        assert_eq!(
            planning,
            PlanningSettings {
                auto_start: true,
                time_zone: "Europe/Istanbul".into(),
                weekday: hours(true),
                weekend: hours(false),
                accounts: vec![
                    PlanningAccount {
                        id: a,
                        first_start: None
                    },
                    PlanningAccount {
                        id: b,
                        first_start: None
                    }
                ],
                tempo: None,
                adaptive: None,
            }
        );
        // No workday was ever saved: a new install's planning, in the system's time zone.
        assert_eq!(planning_from_workday(None), default_planning());
        assert_eq!(
            planning_from_workday(Some(&json!({ "start": "09:00", "timeZone": "Not/AZone" })))
                .time_zone,
            system_time_zone()
        );
    }

    #[test]
    fn a_registry_without_planning_settings_is_migrated_on_load() {
        let root = folder("relay-planning-");
        let id = uuid();
        let mut settings = defaults_without(&["planning"]);
        settings.insert(
            "workday".into(),
            json!({
                "timeZone": "Europe/Istanbul",
                "reservePercent": 10,
                "staggerMinutes": 60,
                "warmupLeadMinutes": 0,
                "routineEnabled": false,
                "start": "00:00",
                "end": "00:00",
                "weekdays": [0, 1, 2, 3, 4, 5, 6],
                "accountIds": [id],
            }),
        );
        write_state(root.path(), Some(Value::Object(settings)));
        let planning = open(root.path()).state().settings.planning;
        assert!(planning.weekday.enabled);
        assert!(planning.weekend.enabled);
        assert_eq!(planning.weekday.start, "00:00");
        assert_eq!(
            planning.accounts,
            [PlanningAccount {
                id,
                first_start: None
            }]
        );
        assert!(!planning.auto_start);
    }

    #[test]
    fn planning_settings_reject_duplicates_bad_clocks_bad_zones_and_unknown_keys() {
        let id = uuid();
        let base = default_planning_value();
        assert!(planning_schema().accepts(&Value::Object(base.clone())));
        let with = |key: &str, value: Value| {
            let mut map = base.clone();
            map.insert(key.into(), value);
            Value::Object(map)
        };
        for bad in [
            with("accounts", json!([{ "id": id }, { "id": id }])),
            with(
                "weekday",
                json!({ "enabled": true, "start": "9:00", "end": "18:00" }),
            ),
            with("timeZone", json!("Mars/Olympus")),
            with("accounts", json!([{ "id": id, "firstStart": "24:00" }])),
            with("extra", json!(true)),
        ] {
            assert!(!planning_schema().accepts(&bad), "{bad}");
        }
    }

    #[test]
    fn a_registry_that_has_both_planning_and_a_legacy_workday_keeps_planning() {
        let root = folder("relay-planning-");
        let id = uuid();
        let planning = PlanningSettings {
            accounts: vec![PlanningAccount {
                id,
                first_start: Some("07:00".into()),
            }],
            ..default_planning_settings()
        };
        let mut settings = defaults();
        settings.insert("planning".into(), serde_json::to_value(&planning).unwrap());
        settings.insert("workday".into(), json!({ "start": "09:00" }));
        write_state(root.path(), Some(Value::Object(settings)));
        let store = open(root.path());
        assert_eq!(store.state().settings.planning, planning);
        let written: Value = serde_json::from_slice(&fs::read(&store.file).unwrap()).unwrap();
        assert_eq!(written["settings"].get("workday"), None);
    }

    #[test]
    fn an_untouched_legacy_workday_becomes_the_new_default_hours_not_a_24_hour_day() {
        let planning = planning_from_workday(Some(&json!({
            "timeZone": "Europe/Berlin",
            "start": "00:00",
            "end": "00:00",
            "weekdays": [0, 1, 2, 3, 4, 5, 6],
            "accountIds": [],
            "reservePercent": 10,
            "staggerMinutes": 60,
            "warmupLeadMinutes": 0,
            "routineEnabled": false,
        })));
        assert_eq!(
            planning,
            PlanningSettings {
                time_zone: "Europe/Berlin".into(),
                ..default_planning_settings()
            }
        );
    }

    fn valid() -> Map<String, Value> {
        let mut map = default_planning_value();
        map.shift_remove("tempo");
        map
    }

    fn valid_with(key: &str, value: Value) -> Value {
        let mut map = valid();
        map.insert(key.into(), value);
        Value::Object(map)
    }

    /// `{ ...stored, ...patch }`.
    fn spread(stored: &Value, patch: &Value) -> Map<String, Value> {
        let mut out = stored.as_object().unwrap().clone();
        for (k, v) in patch.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
        out
    }

    #[test]
    fn the_tempo_choice_is_optional_validated_and_kept_by_a_patch_that_omits_it() {
        assert_eq!(
            planning_schema()
                .parse(&valid_with("tempo", json!("medium")))
                .unwrap()["tempo"],
            "medium"
        );
        assert_eq!(
            planning_schema()
                .parse(&Value::Object(valid()))
                .unwrap()
                .get("tempo"),
            None
        );
        assert!(
            planning_schema()
                .parse(&valid_with("tempo", json!("fast")))
                .is_err()
        );
        let patch = planning_patch_schema()
            .parse(&json!({ "autoStart": true }))
            .unwrap();
        assert_eq!(patch.get("tempo"), None);
        let stored = planning_schema()
            .parse(&valid_with("tempo", json!("heavy")))
            .unwrap();
        assert_eq!(spread(&stored, &patch)["tempo"], "heavy");
        assert_eq!(default_planning_value()["tempo"], "auto");
    }

    #[test]
    fn adaptation_is_optional_validated_and_kept_by_a_patch_that_omits_it() {
        assert_eq!(
            planning_schema()
                .parse(&valid_with("adaptive", json!(false)))
                .unwrap()["adaptive"],
            false
        );
        // A registry without the field parses without it: missing means on.
        assert_eq!(
            planning_schema()
                .parse(&Value::Object(valid()))
                .unwrap()
                .get("adaptive"),
            None
        );
        assert!(
            planning_schema()
                .parse(&valid_with("adaptive", json!("off")))
                .is_err()
        );
        let patch = planning_patch_schema()
            .parse(&json!({ "autoStart": true }))
            .unwrap();
        assert_eq!(patch.get("adaptive"), None);
        let stored = planning_schema()
            .parse(&valid_with("adaptive", json!(false)))
            .unwrap();
        assert_eq!(spread(&stored, &patch)["adaptive"], false);
    }

    #[test]
    fn a_new_registry_plans_in_the_systems_time_zone_a_saved_one_keeps_its_own() {
        let root = folder("relay-planning-");
        let store = open(root.path());
        let planning = store.state().settings.planning;
        assert_eq!(planning.time_zone, system_time_zone());
        assert_eq!(
            PlanningSettings {
                time_zone: "Europe/Istanbul".into(),
                ..planning
            },
            default_planning_settings()
        );
        // The default itself is never changed.
        assert_eq!(default_settings().planning.time_zone, "Europe/Istanbul");
    }

    #[test]
    fn planning_changes_only_through_its_own_call_never_a_settings_patch() {
        assert!(patch(json!({ "planning": default_planning_value() })).is_err());
        assert_eq!(
            patch(json!({ "usageWarnings": false })).unwrap(),
            json!({ "usageWarnings": false })
        );
    }
}

/// tests/meters.test.ts: the schema case; readers, service and UI belong to their ports.
mod meters {
    use super::*;

    #[test]
    fn the_meters_setting_is_optional_each_meter_once_and_a_patch_can_carry_it() {
        assert_eq!(
            parse_settings(&Value::Object(defaults())).get("meters"),
            None
        );
        let both = json!(["copilot", "gemini-cli"]);
        assert_eq!(
            parse_settings(&defaults_with("meters", both.clone()))["meters"],
            both
        );
        assert!(
            !settings_schema().accepts(&defaults_with("meters", json!(["copilot", "copilot"])))
        );
        assert!(!settings_schema().accepts(&defaults_with("meters", json!(["made-up"]))));
        assert_eq!(
            patch(json!({ "meters": ["cursor"] })).unwrap(),
            json!({ "meters": ["cursor"] })
        );
    }
}

/// tests/proxy-gateway-settings.test.ts: the registry cases; the status, key and patch cases
/// belong to the gateway port.
mod proxy_gateway_settings {
    use super::*;

    #[test]
    fn a_new_installs_settings_hold_a_stopped_gateway_on_8317() {
        assert_eq!(
            defaults()["proxy"],
            json!({ "enabled": false, "port": 8317, "host": "127.0.0.1", "affinityTtlSeconds": 3600, "routingStrategy": "soonest-reset" })
        );
        assert!(settings_schema().accepts(&Value::Object(defaults())));
        let root = folder("relay-proxy-store-");
        let proxy = open(root.path()).state().settings.proxy.unwrap();
        assert!(!proxy.enabled);
        assert_eq!(proxy.port, 8317);
    }

    #[test]
    fn a_registry_saved_before_the_gateway_still_reads_and_the_gateway_settings_are_validated() {
        let saved = defaults_without(&["proxy"]);
        assert_eq!(
            parse_settings(&Value::Object(saved.clone())).get("proxy"),
            None
        );
        let proxy = defaults()["proxy"].clone();
        let with = |key: &str, value: Value| {
            let mut bad = proxy.clone();
            bad[key] = value;
            bad
        };
        for bad in [
            with("port", json!(0)),
            with("port", json!(70_000)),
            with("host", json!("http://evil/")),
            with("host", json!("a b")),
            with("extra", json!(true)),
        ] {
            let mut settings = saved.clone();
            settings.insert("proxy".into(), bad.clone());
            assert!(
                settings_schema().parse(&Value::Object(settings)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn update_settings_never_sets_the_gateway_it_has_its_own_calls() {
        assert_eq!(patch(json!({})).unwrap(), json!({}));
        let mut proxy = defaults()["proxy"].clone();
        proxy["host"] = json!("0.0.0.0");
        assert!(patch(json!({ "proxy": proxy })).is_err());
    }
}

/// tests/remote-notify.test.ts: the settings half of the URL case; `remoteNotifyUrl` is in
/// shared_remote_notify.rs and the sender belongs to its port.
mod remote_notify {
    use super::*;

    #[test]
    fn only_https_or_http_to_this_computer_without_a_user_name_or_password_is_a_target() {
        let events = json!({ "limit": true, "reset": false, "autoSwitch": true, "signIn": true });
        assert!(patch(json!({ "remoteNotify": { "url": "https://ntfy.sh/relay", "kind": "ntfy", "events": events } })).is_ok());
        assert!(patch(json!({ "remoteNotify": { "kind": "webhook", "events": events } })).is_ok());
        assert!(patch(json!({ "remoteNotify": { "url": "http://example.com/relay", "kind": "ntfy", "events": events } })).is_err());
        assert!(patch(json!({ "remoteNotify": { "kind": "slack", "events": events } })).is_err());
        assert!(
            patch(json!({ "remoteNotify": { "kind": "ntfy", "events": { "limit": true } } }))
                .is_err()
        );
    }
}

/// tests/risk-consent.test.ts: the registry cases; the gate's source text and the dialog are not
/// ported here.
mod risk_consent {
    use super::*;

    #[test]
    fn main_gates_every_risky_switch_and_only_acknowledge_risk_records_an_acceptance() {
        // Only the schema assertion; the rest reads main-process source text.
        assert!(patch(json!({ "riskAcknowledged": { "gateway-claude": 1 } })).is_err());
    }

    #[test]
    fn a_registry_from_before_the_risk_notes_has_accepted_none_and_an_unknown_risk_is_refused() {
        let old = defaults_without(&["riskAcknowledged"]);
        let with = |value: Value| {
            let mut map = old.clone();
            map.insert("riskAcknowledged".into(), value);
            Value::Object(map)
        };
        assert_eq!(
            parse_settings(&Value::Object(old.clone()))["riskAcknowledged"],
            json!({})
        );
        assert_eq!(
            parse_settings(&with(json!({ "omp-binding": 1 })))["riskAcknowledged"],
            json!({ "omp-binding": 1 })
        );
        assert!(!settings_schema().accepts(&with(json!({ "made-up": 1 }))));
        assert!(!settings_schema().accepts(&with(json!({ "omp-binding": 0 }))));
    }
}

/// tests/switch-strategy.test.ts: the schema case; `switchAtPercent` is in shared_switch_strategy.rs.
mod switch_strategy {
    use super::*;
    use relay_core::store::account_schema;

    #[test]
    fn the_strategy_and_the_line_are_saved_only_as_whole_known_values() {
        for strategy in ["best", "weekly-first", "consume-first"] {
            assert_eq!(
                patch(json!({ "autoSwitchStrategy": strategy })).unwrap(),
                json!({ "autoSwitchStrategy": strategy })
            );
        }
        assert!(patch(json!({ "autoSwitchStrategy": "round-robin" })).is_err());
        let schema = account_schema();
        let line = schema.field("switchAtPercent").unwrap();
        assert_eq!(line.parse(&json!(80)).unwrap(), json!(80));
        for bad in [json!(49), json!(101), json!(85.5), json!("80")] {
            assert!(line.parse(&bad).is_err(), "{bad}");
        }
        assert_eq!(defaults()["autoSwitchStrategy"], "best");
    }
}

/// tests/usage.test.ts: the registry case; the usage cases belong to the usage port.
mod usage {
    use super::*;

    #[test]
    fn legacy_preferences_migrate_without_losing_accounts_and_updates_survive_reload() {
        let root = folder("relay-usage-");
        let store = open(root.path());
        let a = store
            .create(&relay_core::shared::types::CreateAccount {
                name: "A".into(),
                kind: relay_core::shared::types::AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap();
        let mut old: Value = serde_json::from_slice(&fs::read(&store.file).unwrap()).unwrap();
        old.as_object_mut().unwrap().remove("settings");
        fs::write(&store.file, old.to_string()).unwrap();
        let migrated = open(root.path());
        // Preferences that were never saved keep sharing across all accounts, as they did;
        // planning starts in the system's time zone.
        assert_eq!(migrated.state().settings, migrated_defaults());
        assert_eq!(migrated.account(&a.id).unwrap().name, "A");
        migrated
            .update(|s| {
                s.settings.desktop_history_transfer = DesktopHistoryTransfer::Off;
                s.settings.usage_refresh_minutes = 15;
            })
            .unwrap();
        assert_eq!(
            open(root.path()).state().settings.desktop_history_transfer,
            DesktopHistoryTransfer::Off
        );
        assert_eq!(open(root.path()).state().settings.usage_refresh_minutes, 15);
        let partial = settings_schema().partial();
        assert!(partial.parse(&json!({ "usageRefreshMinutes": 1 })).is_err());
        assert!(partial.parse(&json!({ "autoSwitch": true })).is_err());
    }
}

/// tests/proxy-router.test.ts: the registry half of "the move is recorded beside the registry…";
/// the router and proxyExtrasSchema belong to the gateway port.
mod proxy_router {
    use relay_core::store::proxy_config_schema;
    use serde_json::json;

    #[test]
    fn the_move_is_recorded_beside_the_registry_which_stays_readable_by_older_versions() {
        let schema = proxy_config_schema();
        assert!(schema.parse(&json!({ "enabled": true, "port": 8317, "host": "127.0.0.1", "affinityRevision": 1 })).is_err());
        assert!(
            schema
                .parse(&json!({ "enabled": true, "port": 8317, "host": "127.0.0.1" }))
                .is_ok()
        );
    }
}
