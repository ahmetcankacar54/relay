//! Port of tests/transcript-scan.test.ts.

#[path = "common/fleet_evidence.rs"]
mod helpers;

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use helpers::{append, line, lines, sha, spread};
use relay_core::desktop_continuation_evidence::parse_desktop_transcript;
use relay_core::fs_util::resolve;
use relay_core::transcript_scan::{Row, TranscriptScanner, TranscriptScannerOptions, TurnTrigger};
use serde_json::{Value, json};
use tempfile::TempDir;

fn scratch() -> (TempDir, PathBuf) {
    let root = tempfile::Builder::new()
        .prefix("relay-scan-test-")
        .tempdir()
        .unwrap();
    let file = root.path().join("session.jsonl");
    (root, file)
}

/// What a full read and parse of the same file concludes.
struct FullParse {
    bytes: u64,
    sha256: String,
    cwds: BTreeSet<PathBuf>,
    last: Option<Row>,
}

fn full_parse(file: &Path) -> FullParse {
    let data = fs::read(file).unwrap();
    let rows = parse_desktop_transcript(&data).unwrap();
    let main = |r: &Row| {
        !r.get("isSidechain").is_some_and(truthy)
            && !r.get("isMeta").is_some_and(truthy)
            && matches!(
                r.get("type").and_then(Value::as_str),
                Some("user" | "assistant")
            )
    };
    FullParse {
        bytes: data.len() as u64,
        sha256: sha(&data),
        cwds: rows
            .iter()
            .filter_map(|r| r.get("cwd").and_then(Value::as_str))
            .map(|cwd| resolve(Path::new(cwd)))
            .collect(),
        last: rows.iter().rev().find(|r| main(r)).cloned(),
    }
}

fn truthy(value: &Value) -> bool {
    relay_core::desktop_files::js_truthy(value)
}

fn assert_matches_full_parse(scanner: &mut TranscriptScanner, file: &Path) {
    let scanned = scanner.scan(file).unwrap();
    let expected = full_parse(file);
    assert_eq!(scanned.bytes, expected.bytes);
    assert_eq!(scanned.sha256, expected.sha256);
    assert_eq!(scanned.cwds, expected.cwds);
    assert_eq!(scanned.last, expected.last);
}

fn rows() -> Vec<Value> {
    vec![
        json!({
            "type": "user",
            "uuid": "u1",
            "cwd": "/work/app",
            "message": { "content": "Merhaba ğüşiöç" },
        }),
        json!({
            "type": "assistant",
            "uuid": "a1",
            "cwd": "/work/app/src",
            "message": {
                "content": [{ "type": "text", "text": "😀 ok" }],
                "stop_reason": "end_turn",
            },
        }),
        json!({
            "type": "assistant",
            "uuid": "s1",
            "isSidechain": true,
            "cwd": "/elsewhere",
            "message": { "content": "agent" },
        }),
        json!({ "type": "user", "uuid": "m1", "isMeta": true, "message": { "content": "meta" } }),
        json!({ "type": "summary", "summary": "not a turn" }),
    ]
}

fn incomplete(scanner: &mut TranscriptScanner, file: &Path) {
    let error = scanner.scan(file).expect_err("incomplete");
    assert!(
        error.to_string().contains("desktop-observation-incomplete"),
        "{error}"
    );
}

fn uuid_of(row: &Option<Row>) -> Option<&str> {
    row.as_ref()?.get("uuid")?.as_str()
}

#[test]
fn an_incremental_scan_matches_a_full_parse_after_every_append_across_chunk_and_character_boundaries()
 {
    let (_root, file) = scratch();
    let rows = rows();
    // Tiny chunks split rows and multi-byte characters between reads.
    let mut scanner = TranscriptScanner::new(TranscriptScannerOptions {
        chunk_bytes: Some(7),
        ..Default::default()
    });
    fs::write(&file, lines(&rows[..2])).unwrap();
    assert_matches_full_parse(&mut scanner, &file);
    for row in &rows[2..] {
        let before = scanner.bytes_read;
        let size = fs::metadata(&file).unwrap().len();
        append(&file, &line(row));
        assert_matches_full_parse(&mut scanner, &file);
        // Only the appended row (and a few bytes proving the prefix) is read.
        assert!(scanner.bytes_read - before <= fs::metadata(&file).unwrap().len() - size + 64);
    }
    append(&file, "\n\n");
    assert_matches_full_parse(&mut scanner, &file);
}

#[test]
fn an_unchanged_transcript_is_not_read_again() {
    let (_root, file) = scratch();
    let mut scanner = TranscriptScanner::default();
    fs::write(&file, lines(&rows())).unwrap();
    let first = scanner.scan(&file).unwrap();
    let read = scanner.bytes_read;
    assert_eq!(scanner.scan(&file).unwrap(), first);
    assert_eq!(scanner.bytes_read, read);
}

#[test]
fn a_partial_last_line_is_incomplete_until_its_newline_arrives() {
    let (_root, file) = scratch();
    let rows = rows();
    let mut scanner = TranscriptScanner::default();
    fs::write(&file, line(&rows[0]) + &rows[1].to_string()).unwrap();
    incomplete(&mut scanner, &file);
    append(&file, "\n");
    assert_matches_full_parse(&mut scanner, &file);
    assert_eq!(uuid_of(&scanner.scan(&file).unwrap().last), Some("a1"));
}

#[test]
fn a_malformed_non_object_or_oversized_line_keeps_the_transcript_unusable() {
    let rows = rows();
    let long = "x".repeat(80);
    for bad in ["{not json", "[1,2]", "42", "null", long.as_str()] {
        let (_root, file) = scratch();
        let options = TranscriptScannerOptions {
            max_line_length: Some(70),
            ..Default::default()
        };
        let mut scanner = TranscriptScanner::new(options);
        fs::write(&file, line(&rows[0]) + bad + "\n").unwrap();
        incomplete(&mut scanner, &file);
        append(&file, &line(&rows[1]));
        incomplete(&mut scanner, &file);
        incomplete(&mut TranscriptScanner::new(options), &file);
    }
}

#[test]
fn a_rewritten_or_replaced_transcript_is_scanned_again_from_the_start() {
    let (root, file) = scratch();
    let rows = rows();
    let mut scanner = TranscriptScanner::default();
    fs::write(&file, lines(&rows[..2])).unwrap();
    scanner.scan(&file).unwrap();
    // Same file, new content that is at least as long.
    fs::write(
        &file,
        line(&spread(&rows[0], json!({ "cwd": "/rewritten" })))
            + &line(&spread(
                &rows[1],
                json!({ "uuid": "a2", "cwd": "/rewritten" }),
            ))
            + &line(&rows[3]),
    )
    .unwrap();
    assert_matches_full_parse(&mut scanner, &file);
    assert_eq!(uuid_of(&scanner.scan(&file).unwrap().last), Some("a2"));
    // Shorter content.
    fs::write(&file, line(&rows[0])).unwrap();
    assert_matches_full_parse(&mut scanner, &file);
    // A different file renamed into place.
    let replacement = root.path().join("replacement.jsonl");
    fs::write(&replacement, lines(&rows)).unwrap();
    fs::rename(&replacement, &file).unwrap();
    assert_matches_full_parse(&mut scanner, &file);
}

#[test]
fn files_over_the_size_limit_empty_files_and_non_files_are_handled_like_a_full_read() {
    let (root, file) = scratch();
    fs::write(&file, lines(&rows())).unwrap();
    incomplete(
        &mut TranscriptScanner::new(TranscriptScannerOptions {
            max_bytes: Some(100),
            ..Default::default()
        }),
        &file,
    );
    fs::write(&file, "").unwrap();
    let empty = TranscriptScanner::default().scan(&file).unwrap();
    assert_eq!(empty.bytes, 0);
    assert_eq!(empty.sha256, sha(&[]));
    assert_eq!(empty.cwds.len(), 0);
    assert_eq!(empty.last, None);
    assert!(TranscriptScanner::default().scan(root.path()).is_err());
}

#[test]
fn retain_forgets_transcripts_that_are_no_longer_watched() {
    let (root, file) = scratch();
    let other = root.path().join("other.jsonl");
    fs::write(&file, lines(&rows())).unwrap();
    fs::write(&other, lines(&rows())).unwrap();
    let mut scanner = TranscriptScanner::default();
    scanner.scan(&file).unwrap();
    scanner.scan(&other).unwrap();
    scanner.retain(&HashSet::from([file.clone()]));
    let mut read = scanner.bytes_read;
    scanner.scan(&file).unwrap();
    assert_eq!(scanner.bytes_read, read);
    read = scanner.bytes_read;
    scanner.scan(&other).unwrap();
    assert_eq!(
        scanner.bytes_read - read,
        fs::metadata(&other).unwrap().len()
    );
}

#[test]
fn the_row_before_trailing_task_notifications_is_kept_until_another_row_follows_them() {
    let (_root, file) = scratch();
    let notice = |uuid: &str| {
        json!({
            "type": "user",
            "uuid": uuid,
            "origin": { "kind": "task-notification" },
            "message": { "content": "<task-notification>\n</task-notification>" },
        })
    };
    let stop = json!({
        "type": "assistant",
        "uuid": "q1",
        "error": "rate_limit",
        "message": { "content": "limited" },
    });
    let mut scanner = TranscriptScanner::default();
    fs::write(&file, line(&stop)).unwrap();
    assert_eq!(scanner.scan(&file).unwrap().before_notifications, None);
    append(&file, &line(&notice("n1")));
    append(&file, &line(&json!({ "type": "user", "isMeta": true })));
    append(&file, &line(&notice("n2")));
    let after = scanner.scan(&file).unwrap();
    assert_eq!(uuid_of(&after.last), Some("n2"));
    assert_eq!(uuid_of(&after.before_notifications), Some("q1"));
    // A fresh scan of the whole file concludes the same.
    let fresh = TranscriptScanner::default().scan(&file).unwrap();
    assert_eq!(uuid_of(&fresh.before_notifications), Some("q1"));
    append(
        &file,
        &line(&json!({ "type": "user", "uuid": "h1", "message": { "content": "go on" } })),
    );
    let prompted = scanner.scan(&file).unwrap();
    assert_eq!(uuid_of(&prompted.last), Some("h1"));
    assert_eq!(prompted.before_notifications, None);
}

#[test]
fn the_scan_says_what_started_the_latest_assistant_turn_past_notifications_after_it() {
    let (_root, file) = scratch();
    let mut scanner = TranscriptScanner::default();
    let notice = |uuid: &str| {
        json!({
            "type": "user",
            "uuid": uuid,
            "origin": { "kind": "task-notification" },
            "message": { "content": "<task-notification>\n<task-id>t</task-id>" },
        })
    };
    let limited = |uuid: &str| {
        json!({
            "type": "assistant",
            "uuid": uuid,
            "error": "rate_limit",
            "message": { "content": [{ "type": "text", "text": "You've hit your session limit" }] },
        })
    };
    fs::write(
        &file,
        line(&json!({ "type": "user", "uuid": "u1", "message": { "content": "go" } }))
            + &line(&limited("a1")),
    )
    .unwrap();
    assert_eq!(
        scanner.scan(&file).unwrap().trigger,
        Some(TurnTrigger::Prompt)
    );
    append(
        &file,
        &(line(&json!({
            "type": "user",
            "uuid": "u2",
            "message": { "content": [{ "type": "tool_result", "content": "ok" }] },
        })) + &line(&limited("a2"))),
    );
    assert_eq!(
        scanner.scan(&file).unwrap().trigger,
        Some(TurnTrigger::Tool)
    );
    // A notification's own turn hits the limit; later notifications leave the answer standing.
    append(
        &file,
        &(line(&notice("n1")) + &line(&limited("a3")) + &line(&notice("n2"))),
    );
    let scanned = scanner.scan(&file).unwrap();
    assert_eq!(scanned.trigger, Some(TurnTrigger::TaskNotification));
    assert_eq!(uuid_of(&scanned.before_notifications), Some("a3"));
}
