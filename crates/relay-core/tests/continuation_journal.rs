//! Port of `tests/continuation-journal.test.ts`: the private JSON cases, then the
//! `FileContinuationJournal` cases (reload, terminal records, host lock).

use std::fs;

use relay_core::continuation_journal::{
    MAX_BYTES, PrivateJsonError, private_journal_directory, read_private_json, write_private_json,
};
use serde_json::json;

fn temporary() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-continuation-journal-")
        .tempdir()
        .unwrap()
}

#[test]
fn bounded_parser_refuses_directories_oversized_files_and_invalid_utf_8() {
    let directory = temporary();
    assert!(matches!(
        read_private_json(directory.path(), MAX_BYTES),
        Err(PrivateJsonError::Invalid)
    ));
    let file = directory.path().join("input");
    fs::write(&file, vec![0u8; 1_048_577]).unwrap();
    assert!(matches!(
        read_private_json(&file, MAX_BYTES),
        Err(PrivateJsonError::Invalid)
    ));
    fs::write(&file, [0x7b, 0xff, 0x7d]).unwrap();
    assert!(read_private_json(&file, MAX_BYTES).is_err());
}

// From "symlinked journal entries are unreadable barriers and never write through their
// targets": the read and write halves that belong to the private JSON functions.
#[cfg(unix)]
#[test]
fn symlinked_entries_are_unreadable_and_never_written_through() {
    let directory = temporary();
    let target = directory.path().join("synthetic-target");
    fs::write(&target, "unchanged").unwrap();
    let link = directory.path().join("entry.journal.json");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(matches!(
        read_private_json(&link, MAX_BYTES),
        Err(PrivateJsonError::Invalid)
    ));
    let error = write_private_json(&link, &json!({"id": "x"}), MAX_BYTES).unwrap_err();
    assert!(error.to_string().contains("file-invalid"));
    assert_eq!(fs::read_to_string(&target).unwrap(), "unchanged");
}

#[test]
fn writes_reload_unchanged_as_compact_private_json_with_no_temporary_left() {
    let directory = temporary();
    let file = directory.path().join("record.journal.json");
    let value = json!({"version": 1, "id": "a", "stage": "prepared", "nested": {"z": 1, "a": [true, null]}});
    write_private_json(&file, &value, MAX_BYTES).unwrap();
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        r#"{"version":1,"id":"a","stage":"prepared","nested":{"z":1,"a":[true,null]}}"#
    );
    assert_eq!(read_private_json(&file, MAX_BYTES).unwrap(), value);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // Replacing keeps nothing of the old file and leaves no temporary behind.
    write_private_json(&file, &json!([1]), MAX_BYTES).unwrap();
    assert_eq!(read_private_json(&file, MAX_BYTES).unwrap(), json!([1]));
    let names: Vec<_> = fs::read_dir(directory.path()).unwrap().collect();
    assert_eq!(names.len(), 1);
}

#[test]
fn oversized_values_are_refused_before_anything_is_written() {
    let directory = temporary();
    let file = directory.path().join("big.json");
    let error = write_private_json(&file, &"x".repeat(100), 64).unwrap_err();
    assert!(matches!(error, PrivateJsonError::TooLarge));
    assert_eq!(error.to_string(), "continuation-file-too-large");
    assert!(!file.exists());
    // A file over a smaller read cap is refused before it is opened.
    fs::write(&file, "\"0123456789\"").unwrap();
    assert!(matches!(
        read_private_json(&file, 4),
        Err(PrivateJsonError::Invalid)
    ));
}

#[test]
fn a_missing_file_reads_as_not_found() {
    let directory = temporary();
    let error = read_private_json(&directory.path().join("none.json"), MAX_BYTES).unwrap_err();
    assert!(error.is_not_found());
}

#[test]
fn a_byte_order_mark_is_dropped_as_text_decoder_does() {
    let directory = temporary();
    let file = directory.path().join("bom.json");
    fs::write(&file, b"\xEF\xBB\xBF{\"a\":1}").unwrap();
    assert_eq!(
        read_private_json(&file, MAX_BYTES).unwrap(),
        json!({"a": 1})
    );
}

#[test]
fn the_journal_directory_is_made_private() {
    let directory = temporary();
    let journal = directory.path().join("a").join("journal");
    private_journal_directory(&journal).unwrap();
    assert!(journal.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&journal).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&journal, &link).unwrap();
        assert!(matches!(
            private_journal_directory(&link),
            Err(PrivateJsonError::DirectoryInvalid)
        ));
    }
}

// The `FileContinuationJournal` cases of `tests/continuation-journal.test.ts`.

#[path = "common/continuation.rs"]
mod helpers;

use std::sync::mpsc;
use std::time::Duration;

use helpers::{now, uuid};
use relay_core::continuation::{
    CONTINUATION_TEXT, ContinuationError, ContinuationJournal, ContinuationJournalRecord,
    ContinuationStage,
};
use relay_core::continuation_journal::FileContinuationJournal;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn record(continuation_text: &str) -> ContinuationJournalRecord {
    let id = uuid();
    let identity = || json!({ "profileId": uuid(), "accountUuid": uuid(), "orgId": uuid() });
    let bound_request = json!({
        "id": id,
        "source": identity(),
        "target": identity(),
        "sessionId": uuid(),
        "projectKey": "synthetic-project",
        "transcriptRevision": "revision-1",
        "permissionMode": "Auto",
        "expectedContextRevision": 1,
        "continuationText": continuation_text,
    })
    .to_string();
    ContinuationJournalRecord {
        version: 1,
        id,
        fingerprint: Sha256::digest(bound_request.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        bound_request,
        stage: ContinuationStage::Prepared,
        updated_at: now(),
        send_recorded: false,
        checkpoint: None,
        reason: None,
        receipt: None,
    }
}

fn journal(directory: &tempfile::TempDir) -> FileContinuationJournal {
    FileContinuationJournal::with_clock(directory.path(), now).unwrap()
}

fn ids(pending: &[Value]) -> Vec<&str> {
    pending.iter().map(|v| v["id"].as_str().unwrap()).collect()
}

#[test]
fn journal_writes_reload_unchanged_and_unfinished_intents_survive_new_instances() {
    let directory = temporary();
    let journal = journal(&directory);
    let intent = record(CONTINUATION_TEXT);
    journal
        .with_lock(&intent.id, || journal.write(&intent))
        .unwrap();
    let reloaded = FileContinuationJournal::with_clock(directory.path(), now).unwrap();
    let expected = serde_json::to_value(&intent).unwrap();
    assert_eq!(reloaded.read(&intent.id).unwrap(), Some(expected.clone()));
    assert_eq!(reloaded.list_pending().unwrap(), vec![expected]);
    assert!(!directory.path().join("host.lock").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(directory.path()), 0o700);
        assert_eq!(
            mode(&directory.path().join(format!("{}.journal.json", intent.id))),
            0o600
        );
    }
    assert_eq!(reloaded.read(&uuid()).unwrap(), None);
    let error = reloaded.read("../escape").unwrap_err();
    assert!(error.message().contains("request-id-invalid"));
}

#[test]
fn completed_valid_terminal_records_cease_blocking_damaged_terminal_claims_still_block() {
    let directory = temporary();
    let journal = journal(&directory);
    let mut terminal = ContinuationJournalRecord {
        stage: ContinuationStage::Blocked,
        ..record(CONTINUATION_TEXT)
    };
    journal.write(&terminal).unwrap();
    assert!(journal.list_pending().unwrap().is_empty());
    terminal.send_recorded = true;
    journal.write(&terminal).unwrap();
    assert_eq!(journal.list_pending().unwrap().len(), 1);
    fs::write(directory.path().join("damaged.journal.json"), "{").unwrap();
    let pending = journal.list_pending().unwrap();
    assert_eq!(pending.len(), 2);
    assert!(ids(&pending).contains(&"unreadable:damaged.journal.json"));
}

#[test]
fn terminal_records_bound_to_an_older_relay_s_continuation_text_stop_blocking_unknown_text_still_blocks()
 {
    let directory = temporary();
    let journal = journal(&directory);
    let legacy = ContinuationJournalRecord {
        stage: ContinuationStage::Blocked,
        ..record(concat!(
            "Continue this same conversation from the saved checkpoint. First inspect ",
            "the existing transcript and verify whether interrupted actions already took ",
            "effect. Do not replay the last prompt or duplicate completed work. Preserve ",
            "the existing permission mode, ask for any outstanding user decision, and do ",
            "not claim that stopped subagents or shell processes are still running."
        ))
    };
    journal.write(&legacy).unwrap();
    assert!(journal.list_pending().unwrap().is_empty());
    let unknown = ContinuationJournalRecord {
        stage: ContinuationStage::Blocked,
        ..record("Something else")
    };
    journal.write(&unknown).unwrap();
    assert_eq!(ids(&journal.list_pending().unwrap()), [unknown.id.as_str()]);
}

#[test]
fn all_instances_serialize_the_whole_host_across_different_request_ids() {
    let directory = temporary();
    let first = FileContinuationJournal::new(directory.path()).unwrap();
    let second = FileContinuationJournal::new(directory.path()).unwrap();
    let actions = std::sync::Mutex::new(Vec::<&str>::new());
    let (entered_tx, entered) = mpsc::channel();
    let (release, wait) = mpsc::channel::<()>();
    let (first, actions) = (&first, &actions);
    std::thread::scope(|scope| {
        let a = scope.spawn(move || {
            first.with_lock("first", || {
                actions.lock().unwrap().push("first-enter");
                entered_tx.send(()).unwrap();
                wait.recv().unwrap();
                actions.lock().unwrap().push("first-leave");
                Ok(())
            })
        });
        entered.recv().unwrap();
        let b = scope.spawn(|| {
            second.with_lock("second", || {
                actions.lock().unwrap().push("second-enter");
                Ok(())
            })
        });
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(*actions.lock().unwrap(), ["first-enter"]);
        release.send(()).unwrap();
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
    });
    assert_eq!(
        *actions.lock().unwrap(),
        ["first-enter", "first-leave", "second-enter"]
    );
}

#[test]
fn an_alive_cross_process_owner_blocks_actions_a_provably_exited_owner_permits_recovery() {
    let directory = temporary();
    let journal = FileContinuationJournal::new(directory.path()).unwrap();
    let lock = directory.path().join("host.lock");
    fs::write(
        &lock,
        json!({ "pid": std::process::id(), "token": "existing-owner" }).to_string(),
    )
    .unwrap();
    let mut invoked = false;
    let error = journal
        .with_lock("new", || {
            invoked = true;
            Ok(())
        })
        .unwrap_err();
    assert!(error.message().contains("host-locked"));
    assert!(!invoked);
    let mut child = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
    } else {
        std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
    }
    .unwrap();
    let exited_pid = child.id();
    child.wait().unwrap();
    fs::write(
        &lock,
        json!({ "pid": exited_pid, "token": "exited-owner" }).to_string(),
    )
    .unwrap();
    journal
        .with_lock("new", || {
            invoked = true;
            Ok(())
        })
        .unwrap();
    assert!(invoked);
    assert!(!lock.exists());
}

#[test]
fn exceptions_release_owned_host_lock_but_corrupted_lock_metadata_remains_a_barrier() {
    let directory = temporary();
    let journal = FileContinuationJournal::new(directory.path()).unwrap();
    let error = journal
        .with_lock("test", || -> Result<(), ContinuationError> {
            Err("synthetic-failure".into())
        })
        .unwrap_err();
    assert!(error.message().contains("synthetic-failure"));
    assert!(!directory.path().join("host.lock").exists());
    fs::write(directory.path().join("host.lock"), "{").unwrap();
    let error = journal.with_lock("new", || Ok(())).unwrap_err();
    assert!(error.message().contains("host-lock-unreadable"));
    assert!(directory.path().join("host.lock").exists());
}

#[cfg(unix)]
#[test]
fn symlinked_journal_entries_are_unreadable_barriers_and_never_write_through_their_targets() {
    let directory = temporary();
    let journal = FileContinuationJournal::new(directory.path()).unwrap();
    let intent = record(CONTINUATION_TEXT);
    let target = directory.path().join("synthetic-target");
    fs::write(&target, "unchanged").unwrap();
    std::os::unix::fs::symlink(
        &target,
        directory.path().join(format!("{}.journal.json", intent.id)),
    )
    .unwrap();
    let error = journal.read(&intent.id).unwrap_err();
    assert!(error.message().contains("journal-unreadable"));
    assert_eq!(journal.list_pending().unwrap().len(), 1);
    let error = journal.write(&intent).unwrap_err();
    assert!(error.message().contains("file-invalid"));
    assert_eq!(fs::read_to_string(&target).unwrap(), "unchanged");
}
