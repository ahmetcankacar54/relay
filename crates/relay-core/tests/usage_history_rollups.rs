//! Port of tests/usage-history-rollups.test.ts (`electron/core/usage-history`). The case "raw
//! retention is 14 days and at most 50,000 samples" tests `shared/usage-statistics` only and is
//! ported in `shared_usage_history_rollups.rs`.

#[path = "common/p4services_usage_history.rs"]
mod helpers;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use helpers::*;
use relay_core::shared::types::{Account, AccountUsage};
use relay_core::shared::usage_rollups::{HourRollup, UsageRollups, fold_samples, hour_key};
use relay_core::shared::usage_statistics::{UsageSample, usage_identity, usage_sample};
use relay_core::usage_history::FileOp;
use serde_json::{Value, json};

fn start() -> f64 {
    ms("2026-10-13T08:00:00.000Z")
}
fn fixture() -> Account {
    account("account-slot-a", "terra", start())
}
fn identity() -> String {
    usage_identity(&fixture()).unwrap()
}
fn usage(when: f64, used_percent: f64) -> AccountUsage {
    let five = 5.0 * 60.0 * MINUTE;
    usage_of(
        "account-slot-a",
        when,
        json!({
            "usedPercent": used_percent,
            "resetsAt": at(when - ((when - start()) % five) + five),
        }),
        json!({ "usedPercent": 15, "resetsAt": at(when + 3.0 * DAY) }),
    )
}
fn sample(when: f64, used_percent: f64) -> UsageSample {
    usage_sample(&fixture(), &usage(when, used_percent)).unwrap()
}
fn rollups_file(root: &Path) -> PathBuf {
    root.join("usage-rollups.json")
}
/// The rollups file, read back as rollups.
fn persisted(root: &Path) -> UsageRollups {
    serde_json::from_value(read_json(&rollups_file(root))).unwrap()
}
/// The samples of the raw ledger, one JSON object a line.
fn raw_samples(root: &Path) -> Vec<UsageSample> {
    json_lines(&root.join("usage-history.jsonl"))
        .into_iter()
        .map(|line| serde_json::from_value(line).unwrap())
        .collect()
}
fn hour(rollups: &UsageRollups, time: f64) -> HourRollup {
    rollups
        .hours
        .get(&identity())
        .unwrap()
        .get(&hour_key(time))
        .unwrap()
        .clone()
}
fn hour_of(points: f64, windows: f64, covered_minutes: f64) -> HourRollup {
    HourRollup {
        points,
        windows,
        covered_minutes,
    }
}
/// Four samples five minutes apart from `start`, 10% then +3% each.
fn four_samples() -> Vec<UsageSample> {
    [0.0, 5.0, 10.0, 15.0]
        .iter()
        .enumerate()
        .map(|(index, m)| sample(start() + m * MINUTE, 10.0 + index as f64 * 3.0))
        .collect()
}
fn write_legacy(root: &Path, samples: &[UsageSample]) {
    fs::write(
        root.join("usage-history.json"),
        json!({ "version": 1, "samples": samples }).to_string(),
    )
    .unwrap();
}

#[test]
fn recording_folds_samples_into_a_persisted_rollups_file() {
    let dir = directory("relay-usage-rollups-");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    history.record(&fixture(), &usage(start(), 10.0));
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 17.5));
    assert!(history.rollups_available);
    assert!(rollups_file(&dir.root).exists());
    assert_eq!(
        hour(&history.rollups().unwrap(), start()),
        hour_of(7.5, 1.0, 5.0)
    );
    let persisted = persisted(&dir.root);
    assert_eq!(Some(&persisted), history.rollups().as_ref());
    #[cfg(unix)]
    assert_eq!(mode(&rollups_file(&dir.root)), 0o600);
    // A fresh instance reads the persisted rollups.
    assert_eq!(clock.open(&dir.root).rollups(), Some(persisted));
}

#[test]
fn an_existing_raw_ledger_without_rollups_is_backfilled_on_open() {
    let dir = directory("relay-usage-rollups-");
    let now = start() + 60.0 * MINUTE;
    let samples = four_samples();
    write_legacy(&dir.root, &samples);
    let history = open_at(&dir.root, now);
    assert!(history.rollups_available);
    assert_eq!(history.rollups(), Some(fold_samples(&samples, now)));
    assert_eq!(hour(&history.rollups().unwrap(), start()).points, 9.0);
    assert_eq!(persisted(&dir.root), fold_samples(&samples, now));
}

#[test]
fn raw_samples_older_than_14_days_are_pruned_while_rollup_hours_remain() {
    let dir = directory("relay-usage-rollups-");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    history.record(&fixture(), &usage(clock.get(), 10.0));
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 20.0));
    clock.set(start() + 20.0 * DAY);
    let now = clock.get();
    history.record(&fixture(), &usage(now, 30.0));
    let raw = raw_samples(&dir.root);
    assert_eq!(raw.len(), 1);
    assert_eq!(raw[0].checked_at, at(now));
    let rollups = history.rollups().unwrap();
    assert_eq!(hour(&rollups, start()).points, 10.0);
    assert!(
        rollups
            .hours
            .get(&identity())
            .unwrap()
            .get(&hour_key(now))
            .is_some()
    );
    assert_eq!(
        hour(&clock.open(&dir.root).rollups().unwrap(), start()).points,
        10.0
    );
}

#[test]
fn a_corrupt_rollups_file_is_unavailable_and_never_overwritten() {
    let dir = directory("relay-usage-rollups-");
    let content = "{ broken rollups";
    fs::write(rollups_file(&dir.root), content).unwrap();
    let now = start() + 10.0 * MINUTE;
    let mut history = open_at(&dir.root, now);
    assert!(!history.rollups_available);
    assert_eq!(history.rollups(), None);
    history.record(&fixture(), &usage(start(), 10.0));
    history.record(&fixture(), &usage(start() + 5.0 * MINUTE, 20.0));
    assert_eq!(raw_samples(&dir.root).len(), 2);
    assert!(history.history_available);
    assert_eq!(
        fs::read_to_string(rollups_file(&dir.root)).unwrap(),
        content
    );
    // Valid JSON with an invalid shape is also rejected.
    let wrong_shape = json!({ "version": 2, "hours": {} }).to_string();
    fs::write(rollups_file(&dir.root), &wrong_shape).unwrap();
    let mut reopened = open_at(&dir.root, now);
    reopened.record(&fixture(), &usage(start() + 10.0 * MINUTE, 30.0));
    assert!(!reopened.rollups_available);
    assert_eq!(
        fs::read_to_string(rollups_file(&dir.root)).unwrap(),
        wrong_shape
    );
}

// Symbolic links need privileges on Windows.
#[cfg(unix)]
#[test]
fn a_symlinked_rollups_file_is_unavailable_and_not_followed() {
    let dir = directory("relay-usage-rollups-");
    let foreign = dir.root.join("foreign.json");
    let foreign_content =
        json!({ "version": 2, "hours": {}, "windows": {}, "hits": [], "last": {} }).to_string();
    fs::write(&foreign, &foreign_content).unwrap();
    symlink(&foreign, &rollups_file(&dir.root));
    let mut history = open_at(&dir.root, start() + 10.0 * MINUTE);
    assert!(!history.rollups_available);
    assert_eq!(history.rollups(), None);
    history.record(&fixture(), &usage(start(), 10.0));
    assert_eq!(fs::read_to_string(&foreign).unwrap(), foreign_content);
    assert!(
        fs::symlink_metadata(rollups_file(&dir.root))
            .unwrap()
            .file_type()
            .is_symlink()
    );

    // A symlink substituted after opening is refused at write time.
    fs::remove_file(rollups_file(&dir.root)).unwrap();
    let mut substituted = open_at(&dir.root, start() + 10.0 * MINUTE);
    assert!(substituted.rollups_available);
    fs::remove_file(rollups_file(&dir.root)).unwrap();
    symlink(&foreign, &rollups_file(&dir.root));
    substituted.record(&fixture(), &usage(start() + 5.0 * MINUTE, 20.0));
    assert!(!substituted.rollups_available);
    assert_eq!(fs::read_to_string(&foreign).unwrap(), foreign_content);
    assert!(substituted.history_available);
}

#[test]
fn a_stale_rollups_file_is_caught_up_with_newer_raw_samples_on_load() {
    let dir = directory("relay-usage-rollups-");
    let now = start() + 60.0 * MINUTE;
    let samples = four_samples();
    write_legacy(&dir.root, &samples);
    fs::write(
        rollups_file(&dir.root),
        serde_json::to_string(&fold_samples(&samples[..2], now)).unwrap(),
    )
    .unwrap();
    let history = open_at(&dir.root, now);
    assert!(history.rollups_available);
    assert_eq!(history.rollups(), Some(fold_samples(&samples, now)));
    assert_eq!(persisted(&dir.root), fold_samples(&samples, now));
}

#[test]
fn a_version_1_rollups_file_is_rebuilt_from_the_raw_ledger() {
    let dir = directory("relay-usage-rollups-");
    let now = start() + 60.0 * MINUTE;
    let samples = four_samples();
    write_legacy(&dir.root, &samples);
    // Version 1 credited coverage only inside windows and to the later hour.
    let mut v1 = serde_json::to_value(fold_samples(&samples[..2], now)).unwrap();
    v1["version"] = json!(1);
    v1["hours"] = json!({
        (identity()): { (hour_key(start() - DAY)): { "points": 99, "windows": 1, "coveredMinutes": 5 } },
    });
    fs::write(rollups_file(&dir.root), v1.to_string()).unwrap();
    let history = open_at(&dir.root, now);
    assert!(history.rollups_available);
    assert_eq!(history.rollups(), Some(fold_samples(&samples, now)));
    assert_eq!(history.rollups().unwrap().version, 2);
    assert_eq!(persisted(&dir.root), fold_samples(&samples, now));
}

#[test]
fn a_version_1_rollups_file_without_a_readable_raw_ledger_stays_unavailable() {
    let dir = directory("relay-usage-rollups-");
    fs::write(dir.root.join("usage-history.json"), "broken").unwrap();
    let content =
        json!({ "version": 1, "hours": {}, "windows": {}, "hits": [], "last": {} }).to_string();
    fs::write(rollups_file(&dir.root), &content).unwrap();
    let history = open_at(&dir.root, start());
    assert!(!history.rollups_available);
    assert_eq!(
        fs::read_to_string(rollups_file(&dir.root)).unwrap(),
        content
    );
}

#[test]
fn a_transient_rollups_write_failure_is_retried_on_the_next_record() {
    let dir = directory("relay-usage-rollups-");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    let target = rollups_file(&dir.root);
    // Only the first rename fails.
    let fail_next = Arc::new(AtomicBool::new(true));
    history.set_file_fault(Box::new(move |op, path| {
        if op == FileOp::Rename && path == target && fail_next.swap(false, Ordering::SeqCst) {
            return Err(std::io::Error::other("disk full"));
        }
        Ok(())
    }));
    history.record(&fixture(), &usage(clock.get(), 10.0));
    assert!(history.rollups_available);
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 17.0));
    assert!(history.rollups_available);
    let persisted = persisted(&dir.root);
    assert_eq!(
        persisted.last.get(&identity()).unwrap().checked_at,
        at(clock.get())
    );
    assert_eq!(hour(&persisted, start()), hour_of(7.0, 1.0, 5.0));
    assert_eq!(Some(persisted), history.rollups());
}

#[test]
fn an_unreadable_raw_ledger_still_folds_new_samples_into_the_rollups() {
    let dir = directory("relay-usage-rollups-");
    let raw_file = dir.root.join("usage-history.json");
    let clock = Clock::new(start());
    clock
        .open(&dir.root)
        .record(&fixture(), &usage(clock.get(), 10.0));
    let corrupt = "{ broken history";
    fs::write(&raw_file, corrupt).unwrap();
    clock.add(5.0 * MINUTE);
    let mut history = clock.open(&dir.root);
    assert!(!history.history_available);
    assert!(history.rollups_available);
    history.record(&fixture(), &usage(clock.get(), 17.5));
    assert!(history.rollups_available);
    assert_eq!(
        hour(&history.rollups().unwrap(), start()),
        hour_of(7.5, 1.0, 5.0)
    );
    assert_eq!(Some(persisted(&dir.root)), history.rollups());
    // A repeated sample is still ignored, and the raw ledger is never replaced.
    history.record(&fixture(), &usage(clock.get(), 40.0));
    assert_eq!(hour(&history.rollups().unwrap(), start()).points, 7.5);
    assert_eq!(fs::read_to_string(&raw_file).unwrap(), corrupt);
    assert_eq!(history.last_known_resets(&fixture()), None);
}

#[test]
fn a_failed_raw_write_keeps_folding_samples_into_the_rollups() {
    let dir = directory("relay-usage-rollups-");
    let raw_file = dir.root.join("usage-history.jsonl");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    fail_writes(&mut history, &raw_file);
    history.record(&fixture(), &usage(clock.get(), 10.0));
    assert!(!history.history_available);
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 17.0));
    assert!(history.rollups_available);
    assert_eq!(hour(&history.rollups().unwrap(), start()).points, 7.0);
    assert_eq!(
        read_json(&rollups_file(&dir.root))["last"][identity()]["checkedAt"],
        Value::String(at(clock.get()))
    );
    assert!(!raw_file.exists());
}

#[test]
fn rollups_stamped_ahead_of_the_clock_accept_new_samples_after_a_restart() {
    let dir = directory("relay-usage-rollups-");
    let raw_file = dir.root.join("usage-history.json");
    let clock = Clock::new(start() + 60.0 * MINUTE);
    clock
        .open(&dir.root)
        .record(&fixture(), &usage(clock.get(), 50.0));
    // The clock moves back an hour; the raw ledger is unreadable too.
    fs::write(&raw_file, "broken").unwrap();
    clock.set(start() + 5.0 * MINUTE);
    let mut history = clock.open(&dir.root);
    // Only the last check moves back to the clock; the folded hour stays.
    let rollups = history.rollups().unwrap();
    assert_eq!(
        rollups.last.get(&identity()).unwrap().checked_at,
        at(clock.get())
    );
    assert!(
        rollups
            .hours
            .get(&identity())
            .unwrap()
            .get(&hour_key(start() + 60.0 * MINUTE))
            .is_some()
    );
    assert_eq!(Some(persisted(&dir.root)), history.rollups());
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 10.0));
    assert_eq!(
        history
            .rollups()
            .unwrap()
            .last
            .get(&identity())
            .unwrap()
            .checked_at,
        at(clock.get())
    );
}

#[test]
fn a_restart_with_the_clock_behind_the_last_sample_does_not_replay_the_raw_ledger() {
    let dir = directory("relay-usage-rollups-");
    let clock = Clock::new(start());
    let mut before = clock.open(&dir.root);
    // 08:00 → 08:55 every 5 minutes, full from 08:50.
    for i in 0..12 {
        clock.set(start() + f64::from(i) * 5.0 * MINUTE);
        before.record(
            &fixture(),
            &usage(clock.get(), (10.0 + 9.0 * f64::from(i)).min(100.0)),
        );
    }
    let folded = before.rollups().unwrap();
    assert_eq!(hour(&folded, start()), hour_of(90.0, 1.0, 55.0));
    assert_eq!(folded.hits.len(), 1);
    // The clock moves back to 08:53; the raw ledger drops the 08:55 sample.
    clock.set(start() + 53.0 * MINUTE);
    let mut restarted = clock.open(&dir.root);
    let reopened = restarted.rollups().unwrap();
    assert_eq!(reopened.hours, folded.hours);
    assert_eq!(reopened.windows, folded.windows);
    assert_eq!(reopened.hits, folded.hits);
    let mut last = folded.last.get(&identity()).unwrap().clone();
    last.checked_at = at(clock.get());
    assert_eq!(reopened.last.get(&identity()), Some(&last));
    assert_eq!(persisted(&dir.root), reopened);
    // A sample after the restarted clock is accepted. 08:53 → 09:00 overlaps the 08:55 check,
    // but the hour stays at 60 minutes and the window's high-water mark is not counted again.
    clock.set(start() + 60.0 * MINUTE);
    restarted.record(&fixture(), &usage(clock.get(), 100.0));
    let after = restarted.rollups().unwrap();
    assert_eq!(
        after.last.get(&identity()).unwrap().checked_at,
        at(clock.get())
    );
    assert_eq!(hour(&after, start()), hour_of(90.0, 1.0, 60.0));
    assert_eq!(hour(&after, clock.get()), hour_of(0.0, 0.0, 0.0));
    assert_eq!(after.windows, folded.windows);
    assert_eq!(after.hits, folded.hits);
}

#[test]
fn recent_samples_returns_clones_of_the_samples_at_or_after_a_time() {
    let dir = directory("relay-usage-rollups-");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    for i in 0..5 {
        clock.set(start() + f64::from(i) * 5.0 * MINUTE);
        history.record(&fixture(), &usage(clock.get(), 10.0 + f64::from(i)));
    }
    let since = start() + 10.0 * MINUTE;
    let mut recent = history.recent_samples(since);
    assert_eq!(
        recent
            .iter()
            .map(|s| s.checked_at.clone())
            .collect::<Vec<_>>(),
        [10.0, 15.0, 20.0]
            .iter()
            .map(|m| at(start() + m * MINUTE))
            .collect::<Vec<_>>()
    );
    assert_eq!(recent[0].identity, identity());
    assert_eq!(history.recent_samples(start() - DAY).len(), 5);
    assert_eq!(history.recent_samples(clock.get() + MINUTE), Vec::new());
    // The result is a copy: changing it never reaches the ledger.
    recent[0].five_hour.as_mut().unwrap().used_percent = 99.0;
    recent.pop();
    assert_eq!(
        history.recent_samples(since)[0]
            .five_hour
            .as_ref()
            .unwrap()
            .used_percent,
        12.0
    );
    assert_eq!(history.recent_samples(since).len(), 3);
}

#[test]
fn recent_samples_is_empty_while_the_raw_ledger_is_unavailable() {
    let dir = directory("relay-usage-rollups-");
    let clock = Clock::new(start());
    let mut history = clock.open(&dir.root);
    history.record(&fixture(), &usage(clock.get(), 10.0));
    assert_eq!(history.recent_samples(start()).len(), 1);
    // A failed raw write leaves the ledger unavailable although the earlier samples are still
    // in memory.
    let file = history.file().to_path_buf();
    fail_writes(&mut history, &file);
    clock.add(5.0 * MINUTE);
    history.record(&fixture(), &usage(clock.get(), 17.0));
    assert!(!history.history_available);
    assert_eq!(history.recent_samples(start()), Vec::new());
    // A ledger that cannot be read at startup is unavailable the same way.
    let broken = directory("relay-usage-rollups-");
    fs::write(broken.root.join("usage-history.json"), "{ broken").unwrap();
    let reopened = clock.open(&broken.root);
    assert!(!reopened.history_available);
    assert_eq!(reopened.recent_samples(start()), Vec::new());
}
