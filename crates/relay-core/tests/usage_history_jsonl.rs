//! Port of tests/usage-history-jsonl.test.ts (`electron/core/usage-history`).

#[path = "common/p4services_usage_history.rs"]
mod helpers;

use helpers::*;
use relay_core::fs_util::FileId;
use relay_core::shared::types::{Account, AccountUsage};
use relay_core::shared::usage_statistics::{USAGE_HISTORY_DAYS, UsageSample, usage_sample};
use relay_core::usage_history::USAGE_COMPACTION_MS;
use serde_json::{Value, json};
use std::fs;

fn start() -> f64 {
    ms("2026-10-13T08:00:00.000Z")
}
fn fixture() -> Account {
    account("account-slot-a", "terra", start())
}
fn usage(when: f64, used_percent: f64) -> AccountUsage {
    usage_of(
        "account-slot-a",
        when,
        json!({ "usedPercent": used_percent, "resetsAt": at(when + 60.0 * MINUTE) }),
        Value::Null,
    )
}
fn sample(when: f64, used_percent: f64) -> UsageSample {
    usage_sample(&fixture(), &usage(when, used_percent)).unwrap()
}
fn value(sample: &UsageSample) -> Value {
    serde_json::to_value(sample).unwrap()
}
fn line(sample: &UsageSample) -> String {
    serde_json::to_string(sample).unwrap()
}

#[test]
fn each_sample_is_appended_as_one_line_of_usage_history_jsonl() {
    let dir = directory("relay-usage-jsonl-");
    let clock = Clock::new(start() + MINUTE);
    let mut history = clock.open(&dir.root);
    assert_eq!(history.file(), dir.root.join("usage-history.jsonl"));
    history.record(&fixture(), &usage(start(), 10.0));
    assert_eq!(
        json_lines(history.file()),
        vec![value(&sample(start(), 10.0))]
    );
    let first = fs::read_to_string(history.file()).unwrap();
    let inode = FileId::of_path(history.file()).unwrap();
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(start() + 5.0 * MINUTE, 20.0));
    let after = fs::read_to_string(history.file()).unwrap();
    // Appended in place: the first line is untouched and the file is the same.
    assert!(after.starts_with(&first));
    assert_eq!(FileId::of_path(history.file()).unwrap(), inode);
    assert_eq!(lines(history.file()).len(), 2);
    #[cfg(unix)]
    assert_eq!(mode(history.file()), 0o600);
}

#[test]
fn a_reload_returns_the_same_samples_in_time_order() {
    let dir = directory("relay-usage-jsonl-");
    let now = start() + 60.0 * MINUTE;
    let mut history = open_at(&dir.root, now);
    let mut other = with_auth(&fixture(), json!({ "accountUuid": "verified-account-b" }));
    other.id = "account-slot-b".into();
    history.record(&fixture(), &usage(start(), 10.0));
    history.record(
        &other,
        &patched(
            &usage(start() + 2.0 * MINUTE, 30.0),
            json!({ "accountId": other.id }),
        ),
    );
    history.record(&fixture(), &usage(start() + 5.0 * MINUTE, 20.0));
    let before = history.recent_samples(0.0);
    assert_eq!(before.len(), 3);
    assert_eq!(open_at(&dir.root, now).recent_samples(0.0), before);
}

#[test]
fn compaction_keeps_the_14_day_window_at_startup_and_then_at_most_once_a_day() {
    let dir = directory("relay-usage-jsonl-");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    history.record(&fixture(), &usage(clock.get(), 10.0));
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 20.0));
    // Less than a day: still appended.
    clock.add(USAGE_COMPACTION_MS - 10.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 30.0));
    assert_eq!(lines(history.file()).len(), 3);
    // Past the retention and a day after the last compaction: rewritten.
    clock.set(start() + (USAGE_HISTORY_DAYS + 1.0) * DAY);
    let now = clock.get();
    history.record(&fixture(), &usage(now, 40.0));
    assert_eq!(json_lines(history.file()), vec![value(&sample(now, 40.0))]);
    // A restart compacts too.
    let mut appended = fs::read_to_string(history.file()).unwrap();
    appended.push_str(&(line(&sample(start(), 50.0)) + "\n"));
    fs::write(history.file(), appended).unwrap();
    let reopened = clock.open(&dir.root);
    assert!(reopened.history_available);
    assert_eq!(json_lines(reopened.file()), vec![value(&sample(now, 40.0))]);
}

#[test]
fn the_ledger_from_before_is_migrated_once_and_kept_beside_it_never_losing_a_sample() {
    let dir = directory("relay-usage-jsonl-");
    let now = start() + 60.0 * MINUTE;
    let legacy = dir.root.join("usage-history.json");
    let samples: Vec<UsageSample> = [0.0, 5.0, 10.0]
        .iter()
        .map(|m| sample(start() + m * MINUTE, 10.0 + m))
        .collect();
    let content = serde_json::to_string(&json!({ "version": 1, "samples": samples })).unwrap();
    fs::write(&legacy, &content).unwrap();
    let mut history = open_at(&dir.root, now);
    assert!(history.history_available);
    assert_eq!(history.recent_samples(0.0), samples);
    assert_eq!(
        json_lines(history.file()),
        samples.iter().map(value).collect::<Vec<_>>()
    );
    assert!(!legacy.exists());
    assert_eq!(
        fs::read_to_string(dir.root.join("usage-history.json.migrated")).unwrap(),
        content
    );
    // A migration that stopped before the rename merges both, once each.
    fs::write(&legacy, &content).unwrap();
    history.record(&fixture(), &usage(start() + 15.0 * MINUTE, 40.0));
    let merged = open_at(&dir.root, now);
    let mut expected = samples.clone();
    expected.push(sample(start() + 15.0 * MINUTE, 40.0));
    assert_eq!(merged.recent_samples(0.0), expected);
    assert_eq!(lines(merged.file()).len(), 4);
}

#[test]
fn a_line_cut_short_by_a_crash_or_one_that_is_not_a_sample_is_skipped() {
    let dir = directory("relay-usage-jsonl-");
    let now = start() + 60.0 * MINUTE;
    let file = dir.root.join("usage-history.jsonl");
    let kept = vec![sample(start(), 10.0), sample(start() + 5.0 * MINUTE, 20.0)];
    let mut extra = value(&sample(start() + 2.0 * MINUTE, 15.0));
    extra["token"] = json!("no");
    let cut: String = line(&sample(start() + 7.0 * MINUTE, 30.0))
        .chars()
        .take(40)
        .collect();
    fs::write(
        &file,
        [
            line(&kept[0]),
            "not json".into(),
            extra.to_string(),
            line(&kept[1]),
            cut,
        ]
        .join("\n"),
    )
    .unwrap();
    let mut history = open_at(&dir.root, now);
    assert!(history.history_available);
    assert_eq!(history.recent_samples(0.0), kept);
    // The next sample starts on a line of its own.
    history.record(&fixture(), &usage(start() + 10.0 * MINUTE, 40.0));
    let mut expected = kept.clone();
    expected.push(sample(start() + 10.0 * MINUTE, 40.0));
    assert_eq!(open_at(&dir.root, now).recent_samples(0.0), expected);
}

#[test]
fn a_ledger_with_lines_but_no_sample_or_too_large_is_unavailable_and_never_overwritten() {
    let dir = directory("relay-usage-jsonl-");
    let file = dir.root.join("usage-history.jsonl");
    let mut hostile = value(&sample(start(), 10.0));
    hostile["accessToken"] = json!("not-allowed");
    for content in [
        "broken\nlines\n".to_string(),
        hostile.to_string() + "\n",
        "x".repeat(32 * 1024 * 1024 + 1),
    ] {
        fs::write(&file, &content).unwrap();
        let mut history = open_at(&dir.root, start() + MINUTE);
        history.record(&fixture(), &usage(start(), 20.0));
        assert!(!history.history_available);
        assert!(fs::read_to_string(&file).unwrap() == content);
    }
}
