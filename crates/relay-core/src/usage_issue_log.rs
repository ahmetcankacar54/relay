//! Port of `electron/core/usage-issue-log.ts`: the private diagnosis log of usage issues.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::continuation_journal::{MAX_BYTES, read_private_json, write_private_json};
use crate::draft_diagnostics::{short_id, with_short_ids};
use crate::fs_util::iso_timestamp;
use crate::shared::types::UsageIssue;
use crate::shared::types::js::trim;
use crate::usage::js_slice;

/// The log keeps this many of the newest entries.
pub const USAGE_ISSUE_LOG_LIMIT: usize = 200;

/// One entry of the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageIssueEntry {
    pub account_id: String,
    pub issue: UsageIssue,
    /// ISO time the issue appeared, once per change of issue while Relay runs.
    pub at: String,
    /// Where and why: a step, an HTTP status, an error type. Never a credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// What `append_usage_issue` is given: the account, the issue and its detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageIssueInput {
    pub account_id: String,
    pub issue: UsageIssue,
    pub detail: Option<String>,
}

static BREAKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n\t]+").expect("valid"));
static TOKEN_LIKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_\-.~+/=]{32,}").expect("valid"));

/// A detail fit for the log: one line, at most 160 characters, anything token-like masked.
pub fn log_detail(detail: Option<&str>) -> Option<String> {
    let detail = detail.filter(|d| !d.is_empty())?;
    let line = BREAKS.replace_all(detail, " ");
    let line = TOKEN_LIKE.replace_all(&line, "<redacted>");
    let line = js_slice(&line, 160);
    let line = trim(&line);
    (!line.is_empty()).then(|| line.to_string())
}

/// The well-formed entries of the log; none when it is missing, unreadable or corrupt, so a
/// new log starts rather than the issue being lost.
fn entries_in(file: &Path) -> Vec<Map<String, Value>> {
    let Ok(Value::Object(value)) = read_private_json(file, MAX_BYTES) else {
        return Vec::new();
    };
    let version_one = value.get("version").and_then(Value::as_f64) == Some(1.0);
    let Some(Value::Array(entries)) = value.get("entries").filter(|_| version_one) else {
        return Vec::new();
    };
    let text = |entry: &Map<String, Value>, key: &str| entry.get(key).is_some_and(Value::is_string);
    entries
        .iter()
        .filter_map(Value::as_object)
        .filter(|entry| {
            text(entry, "accountId")
                && text(entry, "issue")
                && text(entry, "at")
                && entry.get("detail").is_none_or(Value::is_string)
        })
        .cloned()
        .collect()
}

/// Append one usage issue to the private diagnosis log, keeping the newest
/// [`USAGE_ISSUE_LOG_LIMIT`]. Only the account's short id (`short_id`), the issue, the time and
/// the issue's `log_detail` are written, never a credential. A failed write is swallowed: the
/// log is a diagnostic aid and must never disturb usage polling. Returns whether it saved.
pub fn append_usage_issue(file: &Path, entry: &UsageIssueInput, now: i64) -> bool {
    let mut entries = entries_in(file);
    let mut added = Map::new();
    added.insert(
        "accountId".into(),
        Value::String(short_id(Some(&entry.account_id)).unwrap_or_default()),
    );
    added.insert("issue".into(), Value::String(entry.issue.as_str().into()));
    added.insert("at".into(), Value::String(iso_timestamp(now)));
    if let Some(detail) = log_detail(entry.detail.as_deref()) {
        added.insert("detail".into(), Value::String(detail));
    }
    entries.push(added);
    let skip = entries.len().saturating_sub(USAGE_ISSUE_LOG_LIMIT);
    let entries: Vec<Value> = entries[skip..]
        .iter()
        .map(|entry| Value::Object(with_short_ids(entry)))
        .collect();
    write_private_json(
        file,
        &json!({ "version": 1, "entries": entries }),
        MAX_BYTES,
    )
    .is_ok()
}
