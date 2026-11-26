//! Port of `electron/core/draft-diagnostics.ts`: the private draft-restore diagnosis log
//! (`draft-events.json`, version 1).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::continuation_journal::{MAX_BYTES, read_private_json, write_private_json};
use crate::shared::types::js::iso;

/// The log keeps this many of the newest entries.
pub const DRAFT_EVENT_LIMIT: usize = 300;
/// A string in an entry, and its event name, are cut to this many characters.
pub const DRAFT_EVENT_STRING_LIMIT: usize = 200;
/// An entry keeps at most this many fields besides its time and event.
const MAX_FIELDS: usize = 20;

/// One entry: `at` (ISO time), `event`, and plain fields.
pub type DraftEventEntry = Map<String, Value>;

/// What the draft restore tells a diagnosis log: an event name and its plain fields.
pub type DraftLog = dyn Fn(&str, Option<&Map<String, Value>>) + Send + Sync;

/// Tells `log`, when there is one. A log that panics changes nothing about a restore.
pub fn log_draft(log: Option<&DraftLog>, event: &str, fields: Option<&Map<String, Value>>) {
    if let Some(log) = log {
        // The log is an aid, never a part of a restore.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| log(event, fields)));
    }
}

/// `value.slice(0, limit)`: the first `limit` UTF-16 code units (a pair is never split).
fn cut_units(value: &str, limit: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in value.char_indices() {
        units += ch.len_utf16();
        if units > limit {
            break;
        }
        end = index + ch.len_utf8();
    }
    value[..end].to_owned()
}

fn cut(value: &str) -> String {
    cut_units(value, DRAFT_EVENT_STRING_LIMIT)
}

/// The first 8 characters of an id, which tell two apart; `None` when there is none.
pub fn short_id(id: Option<&str>) -> Option<String> {
    id.filter(|id| !id.is_empty()).map(|id| cut_units(id, 8))
}

static FULL_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("valid pattern")
});

/// A log entry with every field that is a full account or org id cut to its `short_id`. Callers
/// cut the ids they log; this also cuts ones an older Relay wrote, as the log is rewritten.
pub fn with_short_ids(entry: &Map<String, Value>) -> Map<String, Value> {
    entry
        .iter()
        .map(|(key, value)| {
            let value = match value {
                Value::String(text) if FULL_ID.is_match(text) => {
                    short_id(Some(text)).map_or(Value::Null, Value::String)
                }
                other => other.clone(),
            };
            (key.clone(), value)
        })
        .collect()
}

/// A JSON number as `JSON.stringify` writes it: a whole float without its `.0`.
fn js_number(number: &serde_json::Number) -> Option<Value> {
    if number.is_i64() || number.is_u64() {
        return Some(Value::Number(number.clone()));
    }
    let value = number.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        return Some(Value::from(value as i64));
    }
    Some(Value::from(value))
}

/// The fields worth keeping: only strings, numbers, booleans and null, strings cut. A field
/// named `text` is dropped whatever it holds, `at` and `event` are the entry's own, and objects
/// and lists are dropped whole rather than looked into, so nothing nested travels along.
fn scalar_fields(fields: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut kept = Map::new();
    let Some(fields) = fields else { return kept };
    for (key, value) in fields {
        if key == "at" || key == "event" || key.to_lowercase() == "text" {
            continue;
        }
        if kept.len() >= MAX_FIELDS {
            break;
        }
        let value = match value {
            Value::String(text) => Value::String(cut(text)),
            Value::Bool(_) | Value::Null => value.clone(),
            Value::Number(number) => match js_number(number) {
                Some(value) => value,
                None => continue,
            },
            _ => continue,
        };
        kept.insert(key.clone(), value);
    }
    kept
}

static PARSE_ERROR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)JSON|Unexpected (?:token|end|non-whitespace)|at position \d+")
        .expect("valid pattern")
});

/// An error or reason for the log. A message that quotes data, as a JSON parse error quotes
/// the text it could not parse, is replaced by a fixed word; any other is kept as it is.
pub fn safe_message(message: &str) -> String {
    if PARSE_ERROR.is_match(message) {
        "parse-error".to_owned()
    } else {
        message.to_owned()
    }
}

fn entries_in(file: &Path) -> Vec<DraftEventEntry> {
    // Missing, unreadable or corrupt: start a new log rather than lose the event.
    let Ok(Value::Object(value)) = read_private_json(file, MAX_BYTES) else {
        return Vec::new();
    };
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Vec::new();
    }
    let Some(Value::Array(entries)) = value.get("entries") else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| match entry {
            Value::Object(entry)
                if entry.get("at").is_some_and(Value::is_string)
                    && entry.get("event").is_some_and(Value::is_string) =>
            {
                Some(entry.clone())
            }
            _ => None,
        })
        .collect()
}

/// Append one event of the draft restore to the private diagnosis log, keeping the newest
/// [`DRAFT_EVENT_LIMIT`]. `entry["event"]` names it; its other fields are kept only when they
/// are strings (cut to 200 characters), numbers, booleans or null, and never one named `text`.
/// Callers pass ids, states, reasons, counts and times, never a draft's text. A failed write is
/// swallowed: the log is a diagnostic aid and must never disturb a restore. Returns whether it
/// saved.
pub fn append_draft_event(file: &Path, entry: &Map<String, Value>, now: f64) -> bool {
    let Some(event) = entry
        .get("event")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
    else {
        return false;
    };
    let at = iso(now);
    if at.is_empty() {
        // `toISOString` throws on an invalid time.
        return false;
    }
    let mut next = Map::new();
    next.insert("at".into(), Value::String(at));
    next.insert("event".into(), Value::String(cut(event)));
    next.extend(scalar_fields(Some(entry)));
    let mut entries = entries_in(file);
    entries.push(next);
    let skip = entries.len().saturating_sub(DRAFT_EVENT_LIMIT);
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

/// Events that say the same thing on every 10 s run that does nothing, as while Claude is
/// closed. The log keeps 300 entries, so such a run is said once, until something else happens.
const REPEATED: [&str; 6] = [
    "restore-start",
    "record-start",
    "skip",
    "restore-end",
    "stalls",
    "retry-accessibility",
];

/// A filter that says whether an event is worth logging: every event is, but one of REPEATED
/// that is the same as the last of its kind with nothing else logged since. Keep one per log.
pub fn draft_event_filter() -> impl FnMut(&str, Option<&Map<String, Value>>) -> bool + Send {
    let repeated: HashSet<&str> = REPEATED.into_iter().collect();
    let mut last: HashMap<String, String> = HashMap::new();
    let mut quiet = false;
    move |event, fields| {
        if !repeated.contains(event) {
            last.clear();
            quiet = false;
            return true;
        }
        let signature = Value::Object(scalar_fields(fields)).to_string();
        let same = quiet && last.get(event) == Some(&signature);
        last.insert(event.to_owned(), signature);
        quiet = true;
        !same
    }
}
