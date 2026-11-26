//! The `UsageHistory` cases of tests/usage-statistics.test.ts (`electron/core/usage-history`).
//! The `shared/usage-statistics`/`usage-rollups` cases are in `shared_usage_statistics.rs`, the
//! `UsageManager` cases in `usage_statistics_usage.rs`.

#[path = "common/p4services_usage_history.rs"]
mod helpers;

use std::fs;

use helpers::*;
use regex::Regex;
use relay_core::shared::types::{Account, AccountUsage};
use relay_core::shared::usage_rollups::UsageRollups;
use relay_core::shared::usage_statistics::{
    MAX_USAGE_SAMPLES, USAGE_HISTORY_DAYS, UsageSample, usage_identity, usage_sample,
};
use serde_json::json;

const RESET: &str = "2026-10-13T13:00:00.000Z";
const WEEK: &str = "2026-10-19T13:00:00.000Z";

fn start() -> f64 {
    ms("2026-10-13T08:00:00.000Z")
}
fn fixture() -> Account {
    account("account-slot-a", "terra", start())
}
fn usage_reset(when: f64, used_percent: f64, resets_at: &str) -> AccountUsage {
    usage_of(
        "account-slot-a",
        when,
        json!({ "usedPercent": used_percent, "resetsAt": resets_at }),
        json!({ "usedPercent": 15, "resetsAt": WEEK }),
    )
}
fn usage(when: f64, used_percent: f64) -> AccountUsage {
    usage_reset(when, used_percent, RESET)
}
fn sample(when: f64, used_percent: f64, resets_at: &str) -> UsageSample {
    usage_sample(&fixture(), &usage_reset(when, used_percent, resets_at)).unwrap()
}
/// The observed five-hour points of one identity, rounded to cents.
fn observed_five_hour_points(r: &UsageRollups, identity: &str) -> f64 {
    let sum: f64 = r
        .hours
        .get(identity)
        .map(|hours| hours.values().map(|h| h.points).sum())
        .unwrap_or(0.0);
    (sum * 100.0).round() / 100.0
}
fn private_words() -> Regex {
    Regex::new("token|message|credential|name|subscription").unwrap()
}

#[test]
fn history_persists_privately_reloads_and_rejects_duplicate_out_of_order_future_samples() {
    let dir = directory("relay-usage-statistics-");
    let root = &dir.root;
    let now = start() + 60.0 * MINUTE;
    let mut history = open_at(root, now);
    history.record(&fixture(), &usage(start(), 10.0));
    history.record(&fixture(), &usage(start() + 5.0 * MINUTE, 20.0));
    history.record(&fixture(), &usage(start() + 5.0 * MINUTE, 90.0));
    history.record(&fixture(), &usage(start() - MINUTE, 0.0));
    history.record(&fixture(), &usage(now + MINUTE, 100.0));
    let restored = open_at(root, now);
    assert!(restored.history_available);
    assert_eq!(restored.recent_samples(0.0).len(), 2);
    assert_eq!(lines(restored.file()).len(), 2);
    let identity = usage_identity(&fixture()).unwrap();
    assert_eq!(
        observed_five_hour_points(&restored.rollups().unwrap(), &identity),
        10.0
    );
    #[cfg(unix)]
    {
        assert_eq!(mode(history.file()), 0o600);
        assert_eq!(mode(root), 0o700);
    }
    let raw = fs::read_to_string(history.file()).unwrap();
    assert!(!private_words().is_match(&raw));
    let mut names: Vec<String> = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["usage-history.jsonl", "usage-rollups.json"]);
    assert!(
        !private_words().is_match(&fs::read_to_string(root.join("usage-rollups.json")).unwrap())
    );
}

#[test]
fn _14_day_retention_and_maximum_sample_count_are_bounded_in_memory_and_on_every_compaction() {
    let dir = directory("relay-usage-statistics-");
    let root = &dir.root;
    let clock = Clock::new(start());
    let oldest = start() - USAGE_HISTORY_DAYS * DAY;
    // 50,000 samples 20 seconds apart fit inside the retention window.
    let step = 20_000.0;
    let five_hours = 5.0 * 60.0 * MINUTE;
    let mut values: Vec<UsageSample> = (0..MAX_USAGE_SAMPLES)
        .map(|index| {
            let when = oldest + 5.0 * MINUTE + index as f64 * step;
            sample(
                when,
                10.0,
                &at(when - ((when - oldest) % five_hours) + five_hours),
            )
        })
        .collect();
    values[0].checked_at = at(oldest - 1.0);
    fs::write(
        root.join("usage-history.json"),
        serde_json::to_string(&json!({ "version": 1, "samples": values })).unwrap(),
    )
    .unwrap();
    let mut history = clock.open(root);
    let file = history.file().to_path_buf();
    let persisted = || json_lines(&file);
    // The expired sample was dropped when the old ledger was compacted in.
    assert_eq!(persisted().len(), MAX_USAGE_SAMPLES - 1);
    assert!(
        persisted()
            .iter()
            .all(|s| ms(s["checkedAt"].as_str().unwrap()) >= oldest)
    );
    history.record(&fixture(), &usage(clock.get(), 20.0));
    assert_eq!(persisted().len(), MAX_USAGE_SAMPLES);
    clock.add(MINUTE);
    history.record(&fixture(), &usage(clock.get(), 50.0));
    // The newest is appended; memory keeps the bound, the next compaction the file.
    assert_eq!(persisted().len(), MAX_USAGE_SAMPLES + 1);
    assert_eq!(history.recent_samples(0.0).len(), MAX_USAGE_SAMPLES);
    let reopened = clock.open(root);
    assert!(reopened.history_available);
    assert_eq!(persisted().len(), MAX_USAGE_SAMPLES);
    assert_eq!(reopened.recent_samples(0.0), history.recent_samples(0.0));
}

#[test]
fn corrupt_or_oversized_history_fails_safely_without_overwriting_the_evidence() {
    let dir = directory("relay-usage-statistics-");
    let file = dir.root.join("usage-history.json");
    let mut hostile = serde_json::to_value(sample(start(), 10.0, RESET)).unwrap();
    hostile["accessToken"] = json!("not-allowed");
    for content in [
        "broken JSON".to_string(),
        json!({ "version": 2, "samples": [] }).to_string(),
        json!({ "version": 1, "samples": [hostile] }).to_string(),
        "x".repeat(32 * 1024 * 1024 + 1),
    ] {
        fs::write(&file, &content).unwrap();
        let mut history = open_at(&dir.root, start() + MINUTE);
        history.record(&fixture(), &usage(start(), 20.0));
        assert!(!history.history_available);
        assert!(fs::read_to_string(&file).unwrap() == content);
    }
}

// Symbolic links need privileges on Windows.
#[cfg(unix)]
#[test]
fn symlink_files_and_roots_fail_closed_write_never_follows_a_substituted_symlink() {
    let dir = directory("relay-usage-statistics-");
    let root = &dir.root;
    let foreign = root.join("foreign.json");
    let foreign_content = json!({ "version": 1, "samples": [] }).to_string();
    fs::write(&foreign, &foreign_content).unwrap();
    // The ledger, and the one from before 0.11, are never read through a link.
    for name in ["usage-history.jsonl", "usage-history.json"] {
        let link = root.join(name);
        symlink(&foreign, &link);
        let mut linked = open_at(root, start() + MINUTE);
        linked.record(&fixture(), &usage(start(), 10.0));
        assert!(!linked.history_available);
        assert_eq!(fs::read_to_string(&foreign).unwrap(), foreign_content);
        fs::remove_file(&link).unwrap();
    }
    let file = root.join("usage-history.jsonl");
    let mut substituted = open_at(root, start() + MINUTE);
    symlink(&foreign, &file);
    substituted.record(&fixture(), &usage(start(), 10.0));
    assert!(!substituted.history_available);
    assert_eq!(fs::read_to_string(&foreign).unwrap(), foreign_content);
    let linked_root = root.join("linked-root");
    symlink(root, &linked_root);
    assert!(!open_at(&linked_root, start()).history_available);
}

#[test]
fn identity_replacement_does_not_inherit_the_earlier_login_s_statistics() {
    let dir = directory("relay-usage-statistics-");
    let mut history = open_at(&dir.root, start() + 10.0 * MINUTE);
    history.record(&fixture(), &usage(start(), 10.0));
    history.record(&fixture(), &usage(start() + 5.0 * MINUTE, 20.0));
    let different = with_auth(&fixture(), json!({ "accountUuid": "new-account" }));
    history.record(&different, &usage(start() + 10.0 * MINUTE, 90.0));
    let rollups = history.rollups().unwrap();
    assert_eq!(
        observed_five_hour_points(&rollups, &usage_identity(&different).unwrap()),
        0.0
    );
    assert_eq!(
        observed_five_hour_points(&rollups, &usage_identity(&fixture()).unwrap()),
        10.0
    );
}
