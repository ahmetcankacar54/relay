//! `shared/types.ts` shapes against JSON the TS side writes, and the JS rules in `types::js`.
//! Expected strings were produced by Node 24 (`JSON.stringify`, `settingsSchema.parse`, `Date.parse`).

use relay_core::shared::types::js::{self, JsMap};
use relay_core::shared::types::{
    Account, AccountUsage, AntigravityOAuthPoll, RelaySettings, Snapshot, default_settings,
};
use serde_json::json;

/// `JSON.stringify(settingsSchema.parse({...DEFAULT_SETTINGS, …every optional setting}))`.
const ZOD_SETTINGS: &str = r#"{"appearance":"system","proxy":{"enabled":false,"port":8317,"host":"127.0.0.1","affinityTtlSeconds":3600,"routingStrategy":"soonest-reset"},"planning":{"autoStart":false,"timeZone":"Europe/Istanbul","weekday":{"enabled":true,"start":"09:00","end":"18:00"},"weekend":{"enabled":false,"start":"11:00","end":"17:00"},"accounts":[],"tempo":"auto"},"usageRefreshMinutes":5,"usageWarningPercent":90,"usageWarnings":true,"suggestAccounts":true,"desktopHistoryTransfer":"same-group","desktopHistoryAccounts":[],"autoSwitchMode":"off","autoSwitchAccounts":[],"historyPolicyVersion":2,"menuBarAnimation":false,"switchWindow":true,"pranks":"rarely","draftRetype":true,"claudeExtension":{"mode":"restart"},"terminalCli":"follow","notifications":{"limitFiveHour":true,"limitReset":"all","updates":false},"launchAtLogin":false,"updateChannel":"stable","shortcuts":{"openPanel":"CommandOrControl+Shift+R"},"configSync":{"mcpServers":false,"skills":false,"settings":false,"claudeMd":false},"autoSwitchStrategy":"best","remoteNotify":{"url":"https://ntfy.sh/x","kind":"ntfy","events":{"limit":true,"reset":false,"autoSwitch":true,"signIn":false}},"meters":[],"riskAcknowledged":{}}"#;

/// `JSON.stringify(DEFAULT_SETTINGS)` (its literal's key order, not the schema's).
const DEFAULT_SETTINGS_JSON: &str = r#"{"appearance":"system","proxy":{"enabled":false,"port":8317,"host":"127.0.0.1","affinityTtlSeconds":3600,"routingStrategy":"soonest-reset"},"planning":{"autoStart":false,"timeZone":"Europe/Istanbul","weekday":{"enabled":true,"start":"09:00","end":"18:00"},"weekend":{"enabled":false,"start":"11:00","end":"17:00"},"accounts":[],"tempo":"auto"},"usageRefreshMinutes":5,"usageWarningPercent":90,"usageWarnings":true,"suggestAccounts":true,"desktopHistoryTransfer":"same-group","desktopHistoryAccounts":[],"autoSwitchMode":"off","autoSwitchAccounts":[],"historyPolicyVersion":2,"launchAtLogin":false,"updateChannel":"stable","autoSwitchStrategy":"best","configSync":{"mcpServers":false,"skills":false,"settings":false,"claudeMd":false},"riskAcknowledged":{}}"#;

#[test]
fn settings_round_trip_in_schema_order() {
    let settings: RelaySettings = serde_json::from_str(ZOD_SETTINGS).unwrap();
    assert_eq!(serde_json::to_string(&settings).unwrap(), ZOD_SETTINGS);
}

#[test]
fn default_settings_match_the_ts_defaults() {
    let parsed: RelaySettings = serde_json::from_str(DEFAULT_SETTINGS_JSON).unwrap();
    assert_eq!(parsed, default_settings());
    let ours: serde_json::Value = serde_json::to_value(default_settings()).unwrap();
    let theirs: serde_json::Value = serde_json::from_str(DEFAULT_SETTINGS_JSON).unwrap();
    assert_eq!(ours, theirs);
}

#[test]
fn settings_refuse_unknown_keys_and_fill_schema_defaults() {
    let mut value: serde_json::Value = serde_json::from_str(ZOD_SETTINGS).unwrap();
    value["browserLiveSwitch"] = json!(true);
    assert!(serde_json::from_value::<RelaySettings>(value).is_err());
    let mut value: serde_json::Value = serde_json::from_str(ZOD_SETTINGS).unwrap();
    value["planning"]["extra"] = json!(1);
    assert!(serde_json::from_value::<RelaySettings>(value).is_err());
    let mut value: serde_json::Value = serde_json::from_str(ZOD_SETTINGS).unwrap();
    for key in [
        "appearance",
        "desktopHistoryAccounts",
        "autoSwitchMode",
        "autoSwitchAccounts",
        "riskAcknowledged",
    ] {
        value.as_object_mut().unwrap().remove(key);
    }
    let settings: RelaySettings = serde_json::from_value(value).unwrap();
    assert_eq!(serde_json::to_string(&settings).unwrap(), ZOD_SETTINGS);
}

#[test]
fn accounts_keep_field_order_and_drop_unknown_keys() {
    let text = r##"{"id":"7b0f1c8e-1111-4c3a-9a55-000000000001","name":"Kişisel","kind":"personal","group":"Kişisel","color":"#7c3aed","createdAt":"2026-11-01T10:00:00.000Z","provider":"claude","cooldownUntil":"2026-11-02T10:00:00.000Z","planning":{"plan":"max5","capacityWeight":5},"switchAtPercent":85,"desktop":{"accountUuid":"a","orgId":"o","savedAt":"2026-11-01T10:00:00.000Z","email":"x@y.z","rejectedAt":"2026-11-03T10:00:00.000Z"},"auth":{"loggedIn":true,"email":"x@y.z","accountUuid":"a","orgId":"o","orgName":"Org","subscription":"max","plan":"max5","checkedAt":"2026-11-01T10:00:00.000Z","error":"e"}}"##;
    let account: Account = serde_json::from_str(text).unwrap();
    assert_eq!(serde_json::to_string(&account).unwrap(), text);
    let mut value: serde_json::Value = serde_json::from_str(text).unwrap();
    value["browserProfile"] = json!("Default");
    let account: Account = serde_json::from_value(value).unwrap();
    assert_eq!(serde_json::to_string(&account).unwrap(), text);
}

#[test]
fn usage_numbers_are_written_as_json_stringify_writes_them() {
    let usage: AccountUsage = serde_json::from_value(json!({
        "accountId": "a", "status": "ready",
        "fiveHour": { "usedPercent": 34.0, "resetsAt": "2026-11-26T15:00:00.000Z", "source": "official" },
        "sevenDay": { "usedPercent": 12.5 },
        "modelWindows": [{ "key": "seven_day_opus", "label": "Opus", "usedPercent": 100, "period": "seven_day" }],
        "stale": false,
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_string(&usage).unwrap(),
        r#"{"accountId":"a","status":"ready","fiveHour":{"usedPercent":34,"resetsAt":"2026-11-26T15:00:00.000Z","source":"official"},"sevenDay":{"usedPercent":12.5},"modelWindows":[{"key":"seven_day_opus","label":"Opus","usedPercent":100,"period":"seven_day"}],"stale":false}"#
    );
}

#[test]
fn a_minimal_snapshot_round_trips() {
    let snapshot = json!({
        "settings": serde_json::from_str::<serde_json::Value>(DEFAULT_SETTINGS_JSON).unwrap(),
        "usage": { "b": { "accountId": "b", "status": "idle", "stale": false }, "1": { "accountId": "1", "status": "idle", "stale": false } },
        "authFlows": [],
        "accounts": [],
        "sessions": [],
        "runs": [],
        "diagnostics": { "desktopSupported": true, "platform": "darwin", "dataDir": "/tmp/Relay" },
        "importEnabled": false,
        "warnings": [],
    });
    let parsed: Snapshot = serde_json::from_value(snapshot).unwrap();
    // Array-index keys come first, as in a JavaScript object.
    assert_eq!(parsed.usage.keys().collect::<Vec<_>>(), ["1", "b"]);
    let back = serde_json::to_value(&parsed).unwrap();
    assert_eq!(back["usage"]["b"]["status"], "idle");
    assert_eq!(back["diagnostics"]["dataDir"], "/tmp/Relay");
}

#[test]
fn tagged_unions_use_the_ts_discriminants() {
    let poll: AntigravityOAuthPoll =
        serde_json::from_value(json!({ "status": "error", "error": "denied" })).unwrap();
    assert_eq!(
        poll,
        AntigravityOAuthPoll::Error {
            error: "denied".into()
        }
    );
    assert_eq!(
        serde_json::to_value(AntigravityOAuthPoll::Wait).unwrap(),
        json!({ "status": "wait" })
    );
}

#[test]
fn js_map_orders_keys_as_javascript_objects_do() {
    let mut map: JsMap<u32> = JsMap::new();
    map.insert("b", 1);
    map.insert("10", 2);
    map.insert("a", 3);
    map.insert("2", 4);
    map.insert("01", 5);
    map.insert("b", 6);
    assert_eq!(
        map.keys().map(String::as_str).collect::<Vec<_>>(),
        ["2", "10", "b", "a", "01"]
    );
    assert_eq!(
        serde_json::to_string(&map).unwrap(),
        r#"{"2":4,"10":2,"b":6,"a":3,"01":5}"#
    );
    map.remove("10");
    assert_eq!(
        serde_json::to_string(&map).unwrap(),
        r#"{"2":4,"b":6,"a":3,"01":5}"#
    );
    let parsed: JsMap<u32> = serde_json::from_str(r#"{"x":1,"7":2,"x":3}"#).unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), r#"{"7":2,"x":3}"#);
}

#[test]
fn date_parse_follows_v8() {
    let cases: [(&str, f64); 20] = [
        ("2026-02-30", 1772409600000.0),
        ("2026-02-30T10:00:00Z", 1772445600000.0),
        ("2026-11-26T24:00:00Z", 1795737600000.0),
        ("2026-11-26 10:00:00Z", 1795687200000.0),
        ("2026-11-26T10:00:00+0300", 1795676400000.0),
        ("2026-11-26T10:00:00+03", f64::NAN),
        ("2026-11-26T10:00Z", 1795687200000.0),
        ("2026-11-26T10Z", f64::NAN),
        ("2026-11", 1793491200000.0),
        ("2026", 1767225600000.0),
        ("2026-11-26T10:00:00.123456789Z", 1795687200123.0),
        ("2026-11-26t10:00:00z", 1795687200000.0),
        ("x", f64::NAN),
        ("", f64::NAN),
        (" 2026-11-26T10:00:00Z", f64::NAN),
        ("2026-13-01", f64::NAN),
        ("2026-11-26T10:00:60Z", f64::NAN),
        ("+002026-11-26T10:00:00Z", 1795687200000.0),
        ("2026-11-26T10:00:00.Z", f64::NAN),
        ("2026-11-26T13:00:00.000+03:00", 1795687200000.0),
    ];
    for (text, expected) in cases {
        let got = js::date_parse(text);
        assert!(
            got == expected || (got.is_nan() && expected.is_nan()),
            "{text}: {got} != {expected}"
        );
    }
}

#[test]
fn numbers_print_as_javascript_prints_them() {
    assert_eq!(js::iso(1795687200123.0), "2026-11-26T10:00:00.123Z");
    assert_eq!(js::iso(-1.0), "1969-12-31T23:59:59.999Z");
    assert_eq!(js::number_string(1e21), "1e+21");
    assert_eq!(
        js::number_string(123456789012345680000.0),
        "123456789012345680000"
    );
    assert_eq!(js::number_string(0.000001), "0.000001");
    assert_eq!(js::number_string(1e-7), "1e-7");
    assert_eq!(js::number_string(-1.5), "-1.5");
    assert_eq!(js::number_string(-0.0), "0");
    assert_eq!(js::round(-2.5), -2.0);
    assert_eq!(js::round(2.5), 3.0);
    assert_eq!(js::round(0.49999999999999994), 0.0);
    assert_eq!(js::number_value(" 12 "), 12.0);
    assert_eq!(js::number_value(""), 0.0);
    assert!(js::number_value("1x").is_nan());
}
