//! The electron/core/sessions cases of tests/core.test.ts. The store cases are in
//! core_store.rs and the environment cases in core_environment.rs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use relay_core::sessions::SessionError;
use relay_core::sessions::{IndexedSession, copy_transcript, read_transcript, scan_sessions};
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{Account, AccountKind, CreateAccount};
use relay_core::store::{Store, StoreOptions};
use serde_json::{Value, json};

struct Fixture {
    _tmp: tempfile::TempDir,
    #[cfg(unix)]
    root: PathBuf,
    store: Store,
    a: Account,
    b: Account,
    source: IndexedSession,
    file: PathBuf,
    text: String,
    message_id: String,
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn personal(store: &Store, name: &str) -> Account {
    store
        .create(&CreateAccount {
            name: name.into(),
            kind: AccountKind::Personal,
            group: None,
            provider: None,
        })
        .unwrap()
}

fn scan(store: &Store, account: &Account, pinned: &[String]) -> Vec<IndexedSession> {
    scan_sessions(
        &store.profile(&account.id).unwrap(),
        &account.id,
        pinned,
        &JsMap::new(),
    )
    .sessions
}

fn append(file: &Path, text: &str) {
    fs::OpenOptions::new()
        .append(true)
        .open(file)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

fn fixture() -> Fixture {
    let tmp = tempfile::Builder::new()
        .prefix("relay-test-")
        .tempdir()
        .unwrap();
    let root = tmp.path().to_path_buf();
    let store = Store::open(&root, StoreOptions::default()).unwrap();
    let a = personal(&store, "Personal A");
    let b = personal(&store, "Personal B");
    let id = uuid();
    let dir = store
        .profile(&a.id)
        .unwrap()
        .join("projects")
        .join("-test-project");
    fs::create_dir_all(&dir).unwrap();
    let message_id = uuid();
    let cwd = root.to_string_lossy();
    let records = [
        json!({
            "type": "user",
            "uuid": message_id,
            "sessionId": id,
            "cwd": cwd,
            "message": { "role": "user", "content": "Continue this task" },
        }),
        json!({
            "type": "assistant",
            "uuid": uuid(),
            "parentUuid": message_id,
            "sessionId": id,
            "cwd": cwd,
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "Progress is saved." },
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "input": { "command": "should not be displayed as text" },
                    },
                ],
            },
        }),
        json!({ "type": "custom-title", "customTitle": "Reliable handoff", "sessionId": id }),
    ];
    let text = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let file = dir.join(format!("{id}.jsonl"));
    fs::write(&file, &text).unwrap();
    let source = scan(&store, &a, &[]).remove(0);
    Fixture {
        _tmp: tmp,
        #[cfg(unix)]
        root,
        store,
        a,
        b,
        source,
        file,
        text,
        message_id,
    }
}

#[test]
fn history_parser_extracts_actual_messages_custom_title_and_partial_tails_safely() {
    let f = fixture();
    assert_eq!(f.source.title, "Reliable handoff");
    assert_eq!(f.source.messages, 2.0);
    append(&f.file, r#"{"partial":"#);
    let found = scan(&f.store, &f.a, std::slice::from_ref(&f.source.key));
    assert_eq!(found.len(), 1);
    assert!(found[0].pinned);
    let preview = read_transcript(&found[0]).unwrap();
    assert_eq!(preview.len(), 2);
    assert_eq!(preview[1].text, "Progress is saved.");
    assert!(
        !serde_json::to_string(&preview)
            .unwrap()
            .contains("should not be displayed")
    );
}

#[test]
fn a_to_b_to_a_handoff_creates_independent_branches_and_preserves_both_histories() {
    let f = fixture();
    let copy_id = copy_transcript(&f.source, &f.store.profile(&f.b.id).unwrap()).unwrap();
    assert_ne!(copy_id, f.source.id);
    let target = scan(&f.store, &f.b, &[]).remove(0);
    assert_eq!(target.id, copy_id);
    assert_eq!(target.messages, 2.0);
    let rows: Vec<Value> = fs::read_to_string(&target.file)
        .unwrap()
        .trim()
        .split('\n')
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(rows.iter().all(|r| r["sessionId"] == json!(copy_id)));
    assert_eq!(rows[1]["parentUuid"], json!(f.message_id));
    append(
        &target.file,
        &(json!({
            "type": "user",
            "sessionId": copy_id,
            "cwd": f.source.project_dir,
            "message": { "content": "New work on B" },
        })
        .to_string()
            + "\n"),
    );
    let return_id = copy_transcript(&target, &f.store.profile(&f.a.id).unwrap()).unwrap();
    assert_ne!(return_id, copy_id);
    assert_ne!(return_id, f.source.id);
    let restored = scan(&f.store, &f.a, &[]);
    assert_eq!(restored.len(), 2);
    assert_eq!(
        restored
            .iter()
            .find(|s| s.id == return_id)
            .map(|s| s.messages),
        Some(3.0)
    );
    assert_eq!(fs::read_to_string(&f.file).unwrap(), f.text);
}

#[test]
fn history_transfer_never_copies_credentials_settings_or_other_sessions() {
    let f = fixture();
    let profile_a = f.store.profile(&f.a.id).unwrap();
    let profile_b = f.store.profile(&f.b.id).unwrap();
    fs::write(profile_a.join(".credentials.json"), "secret fixture").unwrap();
    fs::write(profile_a.join("settings.json"), r#"{"hooks":"never copy"}"#).unwrap();
    copy_transcript(&f.source, &profile_b).unwrap();
    assert!(!profile_b.join(".credentials.json").exists());
    assert!(!profile_b.join("settings.json").exists());
    assert_eq!(scan(&f.store, &f.b, &[]).len(), 1);
}

#[test]
fn incomplete_transcripts_refuse_transfer_without_creating_a_target() {
    let f = fixture();
    append(&f.file, r#"{"incomplete":"#);
    let error = copy_transcript(&f.source, &f.store.profile(&f.b.id).unwrap()).unwrap_err();
    assert!(error.to_string().contains("missing or damaged record"));
    assert_eq!(scan(&f.store, &f.b, &[]).len(), 0);
}

// Symlink creation requires Windows developer privileges.
#[cfg(unix)]
#[test]
fn source_and_target_symlinks_cannot_escape_profile_boundaries() {
    use std::os::unix::fs::symlink;
    let f = fixture();
    let profile_b = f.store.profile(&f.b.id).unwrap();
    symlink(&f.root, profile_b.join("projects")).unwrap();
    let error = copy_transcript(&f.source, &profile_b).unwrap_err();
    assert!(error.to_string().contains("invalid"));
    let outside = f.root.join("outside.jsonl");
    fs::copy(&f.file, &outside).unwrap();
    fs::remove_file(&f.file).unwrap();
    symlink(&outside, &f.file).unwrap();
    assert_eq!(scan(&f.store, &f.a, &[]).len(), 0);
    let error = copy_transcript(&f.source, &profile_b).unwrap_err();
    assert!(matches!(
        error,
        SessionError::OutsideProfile | SessionError::SymbolicLink
    ));
}

#[test]
fn foreign_session_identities_are_not_silently_cloned() {
    let f = fixture();
    append(
        &f.file,
        &(json!({ "sessionId": uuid(), "type": "user" }).to_string() + "\n"),
    );
    let error = copy_transcript(&f.source, &f.store.profile(&f.b.id).unwrap()).unwrap_err();
    assert!(error.to_string().contains("different session ID"));
}
