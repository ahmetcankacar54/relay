//! Port of `tests/draft-diagnostics.test.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use relay_core::draft_diagnostics::{
    DRAFT_EVENT_LIMIT, DRAFT_EVENT_STRING_LIMIT, append_draft_event, draft_event_filter, short_id,
};
use relay_core::shared::types::js::{date_parse, iso};
use serde_json::{Map, Value, json};

fn start() -> f64 {
    date_parse("2026-10-17T09:00:00Z")
}
const SECOND: f64 = 1000.0;

fn directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-draft-events-")
        .tempdir()
        .unwrap()
}

fn read_log(file: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

fn obj(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn log_file(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("draft-events.json")
}

#[test]
fn the_log_keeps_a_version_and_the_entries_it_was_given_each_with_its_time_and_event() {
    let dir = directory();
    let file = log_file(&dir);
    assert!(append_draft_event(
        &file,
        &obj(json!({ "event": "capture", "count": 2, "status": "captured" })),
        start(),
    ));
    append_draft_event(
        &file,
        &obj(json!({ "event": "shown", "matched": true })),
        start() + SECOND,
    );
    assert_eq!(
        read_log(&file),
        json!({
            "version": 1,
            "entries": [
                { "at": iso(start()), "event": "capture", "count": 2, "status": "captured" },
                { "at": iso(start() + SECOND), "event": "shown", "matched": true },
            ],
        })
    );
}

#[test]
fn a_logged_entry_holds_no_full_account_or_org_id_and_older_entries_lose_theirs_on_the_next_write()
{
    let dir = directory();
    let file = log_file(&dir);
    let from = "aaaaaaaa-1111-4111-8111-111111111111";
    let to = "bbbbbbbb-2222-4222-8222-222222222222";
    // An entry written before ids were cut.
    fs::write(
        &file,
        json!({ "version": 1, "entries": [{ "at": iso(start()), "event": "capture", "from": from, "to": to }] })
            .to_string(),
    )
    .unwrap();
    append_draft_event(
        &file,
        &obj(json!({ "event": "restore-start", "account": to, "records": 1 })),
        start() + SECOND,
    );
    let raw = fs::read_to_string(&file).unwrap();
    let uuid =
        regex::Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
            .unwrap();
    assert!(!uuid.is_match(&raw));
    assert_eq!(
        read_log(&file)["entries"],
        json!([
            { "at": iso(start()), "event": "capture", "from": "aaaaaaaa", "to": "bbbbbbbb" },
            { "at": iso(start() + SECOND), "event": "restore-start", "account": "bbbbbbbb", "records": 1 },
        ])
    );
}

#[test]
fn the_log_is_private_to_the_owner_as_the_other_relay_journals_are() {
    let dir = directory();
    let file = log_file(&dir);
    append_draft_event(&file, &obj(json!({ "event": "capture" })), start());
    append_draft_event(&file, &obj(json!({ "event": "capture" })), start() + SECOND);
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
fn the_log_keeps_only_the_newest_300_entries() {
    assert_eq!(DRAFT_EVENT_LIMIT, 300);
    let dir = directory();
    let file = log_file(&dir);
    for i in 0..DRAFT_EVENT_LIMIT + 25 {
        append_draft_event(
            &file,
            &obj(json!({ "event": "tick", "n": i })),
            start() + i as f64 * SECOND,
        );
    }
    let log = read_log(&file);
    let entries = log["entries"].as_array().unwrap();
    assert_eq!(entries.len(), DRAFT_EVENT_LIMIT);
    assert_eq!(entries[0]["n"], 25);
    assert_eq!(entries.last().unwrap()["n"], DRAFT_EVENT_LIMIT + 24);
}

#[test]
fn only_strings_numbers_booleans_and_null_are_kept() {
    // Functions, bigints, symbols, `undefined`, NaN and infinities have no JSON value to pass;
    // a whole float is written as JavaScript writes it.
    let dir = directory();
    let file = log_file(&dir);
    append_draft_event(
        &file,
        &obj(json!({
            "event": "mixed",
            "s": "text",
            "n": 3.0,
            "b": false,
            "nothing": null,
            "object": { "nested": "value" },
            "list": ["a", "b"],
        })),
        start(),
    );
    let raw = fs::read_to_string(&file).unwrap();
    assert!(raw.contains("\"n\":3,"));
    assert_eq!(
        read_log(&file)["entries"][0],
        json!({ "at": iso(start()), "event": "mixed", "s": "text", "n": 3, "b": false, "nothing": null })
    );
}

#[test]
fn a_field_named_text_is_never_written_whatever_its_case_or_value() {
    let dir = directory();
    let file = log_file(&dir);
    let secret = "the words of an unsent draft";
    append_draft_event(
        &file,
        &obj(
            json!({ "event": "write", "text": secret, "Text": secret, "TEXT": secret, "id": "abc" }),
        ),
        start(),
    );
    let raw = fs::read_to_string(&file).unwrap();
    assert!(!raw.contains(secret));
    let mut keys: Vec<String> = read_log(&file)["entries"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(keys, ["at", "event", "id"]);
}

#[test]
fn a_field_cannot_replace_the_time_or_the_event() {
    let dir = directory();
    let file = log_file(&dir);
    append_draft_event(
        &file,
        &obj(json!({ "event": "real", "at": "yesterday" })),
        start(),
    );
    let entry = read_log(&file)["entries"][0].clone();
    assert_eq!(entry["event"], "real");
    assert_eq!(entry["at"], iso(start()));
    // An entry without an event is no entry.
    assert!(!append_draft_event(
        &file,
        &obj(json!({ "id": "x" })),
        start()
    ));
    assert_eq!(read_log(&file)["entries"].as_array().unwrap().len(), 1);
}

#[test]
fn strings_and_the_event_itself_are_cut_to_200_characters() {
    assert_eq!(DRAFT_EVENT_STRING_LIMIT, 200);
    let dir = directory();
    let file = log_file(&dir);
    append_draft_event(
        &file,
        &obj(json!({ "event": "e".repeat(500), "error": "x".repeat(500), "short": "ok" })),
        start(),
    );
    let entry = read_log(&file)["entries"][0].clone();
    assert_eq!(entry["event"].as_str().unwrap().len(), 200);
    assert_eq!(entry["error"].as_str().unwrap().len(), 200);
    assert_eq!(entry["short"], "ok");
}

#[test]
fn an_entry_has_a_bounded_number_of_fields() {
    let dir = directory();
    let file = log_file(&dir);
    let mut many = Map::new();
    many.insert("event".into(), json!("many"));
    for i in 0..100 {
        many.insert(format!("k{i}"), json!(i));
    }
    append_draft_event(&file, &many, start());
    // The time and the event, and at most 20 fields.
    assert!(read_log(&file)["entries"][0].as_object().unwrap().len() <= 22);
}

#[test]
fn a_missing_corrupt_or_wrongly_shaped_file_starts_over_and_a_write_failure_is_swallowed() {
    let dir = directory();
    let root = dir.path();
    let missing = root.join("missing").join("draft-events.json");
    // The directory does not exist: the write fails and nothing is thrown.
    assert!(!append_draft_event(
        &missing,
        &obj(json!({ "event": "capture" })),
        start()
    ));
    assert!(!missing.exists());
    for content in [
        "{not json".to_owned(),
        String::new(),
        "[]".to_owned(),
        json!({ "version": 2, "entries": [] }).to_string(),
        json!({ "version": 1, "entries": "nope" }).to_string(),
    ] {
        let file = root.join("draft-events.json");
        fs::write(&file, content).unwrap();
        assert!(append_draft_event(
            &file,
            &obj(json!({ "event": "fresh" })),
            start()
        ));
        assert_eq!(
            read_log(&file)["entries"],
            json!([{ "at": iso(start()), "event": "fresh" }])
        );
    }
    // Entries that are not well formed are dropped, the rest are kept.
    let file = root.join("partial.json");
    fs::write(
        &file,
        json!({
            "version": 1,
            "entries": [
                { "at": "2026-10-16T00:00:00.000Z", "event": "keep" },
                { "at": 7, "event": "bad" },
                { "event": "no time" },
                null,
                "text",
            ],
        })
        .to_string(),
    )
    .unwrap();
    append_draft_event(&file, &obj(json!({ "event": "new" })), start());
    let events: Vec<Value> = read_log(&file)["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["event"].clone())
        .collect();
    assert_eq!(events, [json!("keep"), json!("new")]);
}

#[cfg(unix)]
#[test]
fn a_file_that_is_a_link_is_never_followed() {
    let dir = directory();
    let target = dir.path().join("elsewhere.json");
    fs::write(&target, "outside").unwrap();
    let file = log_file(&dir);
    std::os::unix::fs::symlink(&target, &file).unwrap();
    assert!(!append_draft_event(
        &file,
        &obj(json!({ "event": "capture" })),
        start()
    ));
    assert_eq!(fs::read_to_string(&target).unwrap(), "outside");
}

#[test]
fn an_id_is_cut_to_its_first_8_characters() {
    assert_eq!(
        short_id(Some("12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).as_deref(),
        Some("12345678")
    );
    assert_eq!(short_id(Some("abc")).as_deref(), Some("abc"));
    assert_eq!(short_id(None), None);
    assert_eq!(short_id(Some("")), None);
}

#[test]
fn the_repeat_filter_drops_what_a_run_that_did_nothing_says_again_and_nothing_else() {
    let mut allow = draft_event_filter();
    let mut allow = |event: &str, fields: Value| allow(event, Some(&obj(fields)));
    let wait = json!({ "account": "a", "records": 1, "ready": false });
    let wait_ready = json!({ "account": "a", "records": 1, "ready": true });
    let end = json!({ "status": "waiting", "restored": 0, "left": 1, "reason": null });
    let end_not_ready =
        json!({ "status": "waiting", "restored": 0, "left": 1, "reason": "not-ready" });
    // The first time, everything is kept.
    assert!(allow("restore-start", wait.clone()));
    assert!(allow("restore-end", end.clone()));
    assert!(allow("stalls", json!({ "giveUp": 0, "reason": null })));
    // The same run again, with nothing in between, is not.
    assert!(!allow("restore-start", wait.clone()));
    assert!(!allow("restore-end", end.clone()));
    assert!(!allow("stalls", json!({ "giveUp": 0, "reason": null })));
    // A change is kept.
    assert!(allow("restore-start", wait_ready.clone()));
    assert!(allow("restore-end", end_not_ready.clone()));
    assert!(!allow("restore-start", wait_ready.clone()));
    // A draft skipped the same way on each 10 s run is said once too.
    let skip = json!({ "id": "x", "visits": false, "returnKnown": true, "screen": "/new" });
    assert!(allow("record-start", json!({ "id": "x" })));
    assert!(allow("skip", skip.clone()));
    assert!(!allow("restore-start", wait_ready.clone()));
    assert!(!allow("record-start", json!({ "id": "x" })));
    assert!(!allow("skip", skip.clone()));
    // Any other event is always kept, and makes the next run's start count again.
    assert!(allow("watch-start", json!({ "places": 1 })));
    assert!(allow("watch-start", json!({ "places": 1 })));
    assert!(allow("restore-start", wait_ready.clone()));
    assert!(allow("restore-end", end_not_ready.clone()));
    // An accessibility retry that moved nothing is said once, too.
    assert!(allow("retry-accessibility", json!({ "moved": 0 })));
    assert!(!allow("retry-accessibility", json!({ "moved": 0 })));
    assert!(allow("retry-accessibility", json!({ "moved": 2 })));
}
