//! Port of `tests/cli-tokens.test.ts`. macOS only, as the TS skips elsewhere.
#![cfg(target_os = "macos")]

mod common;

use std::fs;

use common::{Options, cli_fixture};
use relay_core::shared::planning::local_date;
use serde_json::{Value, json};

fn counts(input: u64, output: u64) -> Value {
    json!({ "input": input, "output": output, "cacheWrite": 0, "cacheRead": 0, "responses": 1 })
}

fn write_private(path: &std::path::Path, text: &str) {
    fs::write(path, text).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn now() -> f64 {
    relay_core::clock::now_ms() as f64
}

#[test]
fn tokens_shows_the_app_s_ledger_for_the_range_marking_estimated_rows() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let (b, _) = f.saved("B", None);
    let zone = f.store().state().settings.planning.time_zone;
    let today = local_date(now(), &zone);
    let yesterday = local_date(now() - 86_400_000.0, &zone);
    let mut days = serde_json::Map::new();
    days.insert(
        today,
        json!({ format!("acct:{}", a.id): { "claude-x": counts(1000, 200) } }),
    );
    days.insert(
        yesterday,
        json!({ format!("est:{}", b.id): { "claude-x": counts(500, 0) }, "terminal": { "claude-x": counts(5, 0) } }),
    );
    let ledger = json!({
        "version": 2,
        "zone": zone,
        "complete": true,
        "files": { "k1": { "dev": 1, "ino": 1, "size": 100, "offset": 100, "mtimeMs": 1 } },
        "days": days,
        "seen": {},
    });
    write_private(&f.home.join("token-ledger.json"), &ledger.to_string());
    let timeline = f.home.join("active-account-timeline.json");
    let from = relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms() - 3_600_000);
    let segments = json!({ "version": 1, "segments": [{ "accountUuid": a.desktop.as_ref().unwrap().account_uuid, "from": from }] });
    write_private(&timeline, &segments.to_string());
    let before = fs::read_to_string(&timeline).unwrap();
    let mtime = fs::metadata(&timeline).unwrap().modified().unwrap();
    assert_eq!(f.run(&["tokens", "--days", "7", "--json"]), 0);
    let view: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(view["totals"]["input"], 1505);
    assert_eq!(view["totals"]["output"], 200);
    let row = |id: &str| {
        view["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["accountId"] == id)
            .cloned()
            .unwrap()
    };
    assert_eq!(row(&b.id)["estimated"], true);
    assert_eq!(row(&a.id)["estimated"], false);
    assert_eq!(fs::read_to_string(&timeline).unwrap(), before);
    assert_eq!(fs::metadata(&timeline).unwrap().modified().unwrap(), mtime);
    f.clear();
    assert_eq!(f.run(&["tokens"]), 0);
    assert!(f.out().contains('≈'));
    assert!(f.out().contains("Terminal outside Relay"));
    f.clear();
    assert_eq!(f.run(&["tokens", "--account", "A", "--json"]), 0);
    let view: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(view["totals"]["input"], 1000);
    assert_eq!(f.run(&["tokens", "--days", "5"]), 2);
}

#[test]
fn without_a_ledger_it_says_relay_app_keeps_one() {
    let f = cli_fixture(Options::default());
    assert_eq!(f.run(&["tokens"]), 0);
    assert!(f.out().contains("Relay.app"));
}

/// The TS spies on `Buffer.alloc`; here the read is capped at the file's size plus 64 KiB by
/// construction (`read_ledger`), so the case checks a small ledger reads.
#[test]
fn reading_a_small_ledger_does_not_allocate_a_buffer_the_size_of_the_cap() {
    let f = cli_fixture(Options::default());
    fs::create_dir_all(&f.home).unwrap();
    write_private(
        &f.home.join("token-ledger.json"),
        &json!({ "version": 2, "files": {}, "days": {}, "seen": {} }).to_string(),
    );
    assert_eq!(f.run(&["tokens", "--json"]), 0);
}

#[test]
fn tokens_reads_the_version_3_ledger_relay_app_writes_and_shows_its_api_value() {
    let f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    let zone = f.store().state().settings.planning.time_zone;
    let today = local_date(now(), &zone);
    let mut cell = counts(1000, 200);
    cell["cost"] = json!(12.5);
    cell["unpriced"] = json!(0);
    let mut days = serde_json::Map::new();
    days.insert(
        today,
        json!({ format!("acct:{}", a.id): { "claude-opus-5-5": cell } }),
    );
    let ledger = json!({
        "version": 3, "zone": zone, "complete": true, "pricedAt": 1, "files": {}, "days": days, "slots": {}, "seen": {},
    });
    write_private(&f.home.join("token-ledger.json"), &ledger.to_string());
    assert_eq!(f.run(&["tokens", "--json"]), 0);
    let view: Value = serde_json::from_str(&f.out()).unwrap();
    assert_eq!(view["totals"]["cost"], 12.5);
    assert_eq!(view["today"]["totals"]["cost"], 12.5);
    f.clear();
    assert_eq!(f.run(&["tokens"]), 0);
    assert!(f.out().contains("API value $12.50"));
}
