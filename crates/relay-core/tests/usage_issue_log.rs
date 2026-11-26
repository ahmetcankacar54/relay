//! The `appendUsageIssue` cases of tests/usage-issue-log.test.ts
//! (`electron/core/usage-issue-log`). The `UsageManager` `onIssue` cases are in
//! `usage_issue_log_usage.rs`; "main logs usage issues to usage-issues.json…" reads main-process
//! source text and is not ported.

use std::fs;
use std::path::Path;

use regex::Regex;
use relay_core::shared::types::UsageIssue;
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::usage_issue_log::{USAGE_ISSUE_LOG_LIMIT, UsageIssueInput, append_usage_issue};
use serde_json::{Value, json};

const MINUTE: i64 = 60_000;
const SECRET: &str = "fixture-usage-issue-secret";

fn start() -> i64 {
    date_parse("2026-10-17T09:00:00Z") as i64
}
fn at(ms: i64) -> String {
    iso(ms as f64)
}
fn directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-usage-issues-")
        .tempdir()
        .unwrap()
}
fn read_log(file: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}
fn input(account_id: &str, issue: UsageIssue, detail: Option<&str>) -> UsageIssueInput {
    UsageIssueInput {
        account_id: account_id.into(),
        issue,
        detail: detail.map(str::to_string),
    }
}

#[test]
fn the_log_keeps_a_version_and_the_entries_it_was_given_with_the_time_of_each() {
    let dir = directory();
    let file = dir.path().join("usage-issues.json");
    append_usage_issue(&file, &input("a", UsageIssue::Expired, None), start());
    append_usage_issue(
        &file,
        &input("b", UsageIssue::Scope, None),
        start() + MINUTE,
    );
    assert_eq!(
        read_log(&file),
        json!({
            "version": 1,
            "entries": [
                { "accountId": "a", "issue": "expired", "at": at(start()) },
                { "accountId": "b", "issue": "scope", "at": at(start() + MINUTE) },
            ],
        })
    );
    // Private to the owner, like the other Relay journals.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn the_log_keeps_only_the_newest_200_entries() {
    assert_eq!(USAGE_ISSUE_LOG_LIMIT, 200);
    let dir = directory();
    let file = dir.path().join("usage-issues.json");
    for i in 0..USAGE_ISSUE_LOG_LIMIT + 25 {
        append_usage_issue(
            &file,
            &input(&format!("a{i}"), UsageIssue::Unavailable, None),
            start() + i as i64 * MINUTE,
        );
    }
    let log = read_log(&file);
    let entries = log["entries"].as_array().unwrap();
    assert_eq!(entries.len(), USAGE_ISSUE_LOG_LIMIT);
    assert_eq!(entries[0]["accountId"], "a25");
    assert_eq!(
        entries.last().unwrap()["accountId"],
        format!("a{}", USAGE_ISSUE_LOG_LIMIT + 24)
    );
}

#[test]
fn a_logged_issue_holds_the_account_s_short_id_never_its_full_id_and_older_entries_lose_theirs() {
    let dir = directory();
    let file = dir.path().join("usage-issues.json");
    let full = "cccccccc-3333-4333-8333-333333333333";
    fs::write(
        &file,
        json!({ "version": 1, "entries": [{ "accountId": full, "issue": "expired", "at": at(start()) }] })
            .to_string(),
    )
    .unwrap();
    append_usage_issue(
        &file,
        &input(full, UsageIssue::Scope, None),
        start() + MINUTE,
    );
    let raw = fs::read_to_string(&file).unwrap();
    let uuid =
        Regex::new("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap();
    assert!(!uuid.is_match(&raw));
    let pairs: Vec<(Value, Value)> = read_log(&file)["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["accountId"].clone(), e["issue"].clone()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            (json!("cccccccc"), json!("expired")),
            (json!("cccccccc"), json!("scope")),
        ]
    );
}

#[test]
fn a_missing_corrupt_or_wrongly_shaped_log_starts_over_and_a_write_failure_is_swallowed() {
    let dir = directory();
    let root = dir.path();
    let missing = root.join("missing").join("usage-issues.json");
    // The directory does not exist: the write fails and nothing is thrown.
    assert!(!append_usage_issue(
        &missing,
        &input("a", UsageIssue::Expired, None),
        start()
    ));
    assert!(!missing.exists());
    for content in [
        "{not json".to_string(),
        String::new(),
        "[]".into(),
        json!({ "version": 2, "entries": [] }).to_string(),
        json!({ "version": 1, "entries": "nope" }).to_string(),
    ] {
        let file = root.join("usage-issues.json");
        fs::write(&file, content).unwrap();
        append_usage_issue(&file, &input("a", UsageIssue::Expired, None), start());
        assert_eq!(
            read_log(&file)["entries"],
            json!([{ "accountId": "a", "issue": "expired", "at": at(start()) }])
        );
    }
    // Entries that are not well formed are dropped, the rest are kept.
    let file = root.join("partial.json");
    fs::write(
        &file,
        json!({
            "version": 1,
            "entries": [
                { "accountId": "keep", "issue": "scope", "at": "2026-10-16T00:00:00.000Z" },
                { "accountId": 7, "issue": "scope", "at": "x" },
                null,
            ],
        })
        .to_string(),
    )
    .unwrap();
    append_usage_issue(&file, &input("a", UsageIssue::Expired, None), start());
    let ids: Vec<Value> = read_log(&file)["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["accountId"].clone())
        .collect();
    assert_eq!(ids, vec![json!("keep"), json!("a")]);
}

/// The TS passes an object with token fields cast to the input type; the Rust input type has
/// no place for them, so the case checks what is written.
#[test]
fn the_log_holds_only_the_account_the_issue_and_the_time_never_a_credential() {
    let dir = directory();
    let file = dir.path().join("usage-issues.json");
    append_usage_issue(&file, &input("a", UsageIssue::Expired, None), start());
    assert!(!fs::read_to_string(&file).unwrap().contains(SECRET));
    let log = read_log(&file);
    let mut keys: Vec<&String> = log["entries"][0].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["accountId", "at", "issue"]);
}

#[test]
fn an_issue_s_detail_says_where_and_why_on_one_short_line_with_anything_token_like_masked() {
    let dir = directory();
    let file = dir.path().join("usage-issues.json");
    append_usage_issue(
        &file,
        &input("a", UsageIssue::Scope, Some("usage 403 permission_error")),
        start(),
    );
    let hostile = format!(
        "refresh failed\nBearer sk-ant-oat01-{} {}",
        "x".repeat(60),
        "y".repeat(200)
    );
    append_usage_issue(
        &file,
        &input("a", UsageIssue::Expired, Some(&hostile)),
        start() + MINUTE,
    );
    append_usage_issue(
        &file,
        &input("a", UsageIssue::Unavailable, None),
        start() + 2 * MINUTE,
    );
    let log = read_log(&file);
    let entries = log["entries"].as_array().unwrap();
    assert_eq!(entries[0]["detail"], "usage 403 permission_error");
    let detail = entries[1]["detail"].as_str().unwrap();
    assert!(!detail.contains('\n'));
    assert!(!Regex::new("x{20}|y{20}").unwrap().is_match(detail));
    assert!(detail.encode_utf16().count() <= 160);
    assert!(entries[2].get("detail").is_none());
}
