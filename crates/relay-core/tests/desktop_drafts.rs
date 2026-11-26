//! Port of `tests/desktop-drafts.test.ts`, the cases about drafts, their storage, the draft step
//! and the draft vault. Left out:
//! - the `planHistory`/`planHistoryDetailed` cases (`desktop_files`' merge planner, Desktop's);
//! - the helper process (`draftJobPath`, `parseDraftJob`, `awaitHelper`, `runHelper`, the exit
//!   half of `helperOutcome`, `electronMismatch`, the build/package/worker source-text cases):
//!   plan Phase 4 replaced the Electron helper with an in-process LevelDB reader, so they have no
//!   Rust counterpart. Their result checks (limits, "no result") are ported onto
//!   `checked_result`.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use relay_core::desktop_files::{CarriedConversation, CarriedMember};
#[cfg(unix)]
use relay_core::draft_storage::remove_legacy_draft_backups;
use relay_core::draft_storage::{
    LEVELDB, LOCAL_STORAGE, copy_local_storage, sweep_draft_leftovers,
};
#[cfg(unix)]
use relay_core::draft_transfer::assert_local_storage;
use relay_core::draft_transfer::{
    CLAUDE_RUNNING, CaptureInput, CaptureOutcome, DraftJob, DraftPage, DraftResult, EMPTY_STORAGE,
    capture_drafts, checked_result, drafts_blocked_reason, read_drafts, run_draft_job,
};
#[cfg(unix)]
use relay_core::draft_vault::VaultError;
use relay_core::draft_vault::{
    Clock, DraftPatch, DraftReadStage, DraftRecord, DraftSlots, DraftState, DraftVault,
    DraftVaultHooks, Seal, Unseal, summarize,
};
use relay_core::drafts::{
    CONVERSATION_DRAFT_PREFIX as P, CapturedDraft, NEW_SESSION_DRAFT, select_drafts,
};
use relay_core::shared::types::js::JsMap;
use serde_json::{Value, json};

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const C: &str = "33333333-3333-4333-8333-333333333333";

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn draft_with(owner: &str, text: Value, extra: Value) -> String {
    let mut d = json!({ "text": text, "files": [], "snippets": [] });
    for (k, v) in extra.as_object().unwrap() {
        d[k] = v.clone();
    }
    d["owner"] = json!(owner);
    d.to_string()
}

fn draft(owner: &str, text: &str) -> String {
    draft_with(owner, json!(text), json!({}))
}

fn carried(target_alias: &str, members: &[(&str, &str)]) -> CarriedConversation {
    CarriedConversation {
        target_alias: target_alias.into(),
        members: members
            .iter()
            .map(|(alias, account)| CarriedMember {
                alias: (*alias).into(),
                account_uuid: (*account).into(),
            })
            .collect(),
    }
}

fn kept(target_alias: &str, text: &str, title: &str) -> CapturedDraft {
    CapturedDraft {
        target_alias: Some(target_alias.into()),
        new_session: None,
        title: title.into(),
        text: text.into(),
        attachments: false,
    }
}

fn new_session(text: &str, attachments: bool) -> CapturedDraft {
    CapturedDraft {
        target_alias: None,
        new_session: Some(true),
        title: String::new(),
        text: text.into(),
        attachments,
    }
}

fn map(pairs: &[(&str, &str)]) -> JsMap<String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn key(alias: &str) -> String {
    format!("{P}{alias}")
}

fn select(drafts: &[(&str, String)], conversations: &[CarriedConversation]) -> Vec<CapturedDraft> {
    select_from(drafts, conversations, &[], A)
}

fn select_from(
    drafts: &[(&str, String)],
    conversations: &[CarriedConversation],
    titles: &[(&str, &str)],
    from: &str,
) -> Vec<CapturedDraft> {
    let drafts: JsMap<String> = drafts
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect();
    let titles: HashMap<String, String> = titles
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    select_drafts(&drafts, from, conversations, &titles)
}

#[test]
fn a_draft_at_the_target_alias_is_kept() {
    assert_eq!(
        select(
            &[(&key("x"), draft(A, "hello"))],
            &[carried("x", &[("x", A)])]
        ),
        [kept("x", "hello", "")]
    );
}

#[test]
fn a_draft_at_another_member_alias_is_kept_under_the_target_alias() {
    assert_eq!(
        select(&[(&key("x"), draft(A, "t"))], &[carried("y", &[("x", A)])]),
        [kept("y", "t", "")]
    );
}

#[test]
fn as_draft_is_kept_even_when_b_has_one_for_the_same_conversation() {
    assert_eq!(
        select(
            &[(&key("y"), draft(B, "old")), (&key("x"), draft(A, "new"))],
            &[carried("y", &[("x", A), ("y", B)])]
        ),
        [kept("y", "new", "")]
    );
}

#[test]
fn without_as_draft_nothing_is_kept() {
    assert!(
        select(
            &[(&key("y"), draft(B, "theirs"))],
            &[carried("y", &[("x", A), ("y", B)])]
        )
        .is_empty()
    );
}

#[test]
fn two_a_drafts_in_one_conversation_keep_the_one_at_the_target_alias() {
    assert_eq!(
        select(
            &[
                (&key("x"), draft(A, "from x")),
                (&key("y"), draft(A, "from y"))
            ],
            &[carried("y", &[("x", A), ("y", A)])]
        ),
        [kept("y", "from y", "")]
    );
}

#[test]
fn two_a_drafts_neither_at_the_target_alias_keep_the_lexically_first() {
    assert_eq!(
        select(
            &[
                (&key("b"), draft(A, "from b")),
                (&key("a"), draft(A, "from a"))
            ],
            &[carried("y", &[("b", A), ("a", A)])]
        ),
        [kept("y", "from a", "")]
    );
}

#[test]
fn a_repeated_member_does_not_duplicate_the_draft() {
    assert_eq!(
        select(
            &[(&key("x"), draft(A, "x")), (&key("y"), draft(A, "y"))],
            &[carried("y", &[("x", A), ("x", A), ("y", A), ("y", A)])]
        ),
        [kept("y", "y", "")]
    );
}

#[test]
fn another_accounts_drafts_and_conversations_outside_the_plan_are_ignored() {
    assert!(
        select(
            &[
                (&key("x"), draft(C, "theirs")),
                (&key("z"), draft(A, "elsewhere")),
                ("composer-draft:other", draft(A, "t"))
            ],
            &[carried("x", &[("x", A)])]
        )
        .is_empty()
    );
}

#[test]
fn an_upper_case_owner_is_still_as() {
    let from = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
    for (owner, given) in [
        (from.to_uppercase(), from.to_owned()),
        (from.to_owned(), from.to_uppercase()),
    ] {
        assert_eq!(
            select_from(
                &[
                    (&key("x"), draft(&owner, "c")),
                    (NEW_SESSION_DRAFT, draft(&owner, "n"))
                ],
                &[carried("y", &[("x", &given)])],
                &[],
                &given
            ),
            [kept("y", "c", ""), new_session("n", false)],
            "{owner}"
        );
    }
}

#[test]
fn the_new_session_draft_is_kept_only_from_a() {
    assert_eq!(
        select(&[(NEW_SESSION_DRAFT, draft(A, "hello"))], &[]),
        [new_session("hello", false)]
    );
    assert!(select(&[(NEW_SESSION_DRAFT, draft(C, "theirs"))], &[]).is_empty());
    // It comes after the conversation drafts, and neither is mistaken for the other.
    assert_eq!(
        select(
            &[
                (NEW_SESSION_DRAFT, draft(A, "new")),
                (&key("x"), draft(A, "conv"))
            ],
            &[carried("x", &[("x", A)])]
        ),
        [kept("x", "conv", ""), new_session("new", false)]
    );
}

#[test]
fn a_malformed_draft_is_skipped() {
    let bad = [
        "not json".to_owned(),
        json!({ "text": "t", "owner": 7 }).to_string(),
        json!({ "text": "t" }).to_string(),
        json!([{ "owner": A }]).to_string(),
        "null".to_owned(),
    ];
    for value in bad {
        assert!(
            select(&[(&key("x"), value.clone())], &[carried("y", &[("x", A)])]).is_empty(),
            "{value}"
        );
        assert!(
            select(&[(NEW_SESSION_DRAFT, value.clone())], &[]).is_empty(),
            "{value}"
        );
    }
}

#[test]
fn a_malformed_draft_does_not_stop_a_good_one_in_the_same_conversation() {
    assert_eq!(
        select(
            &[
                (&key("x"), "not json".into()),
                (&key("y"), draft(A, "good"))
            ],
            &[carried("y", &[("x", A), ("y", A)])]
        ),
        [kept("y", "good", "")]
    );
}

#[test]
fn a_malformed_draft_at_the_target_key_skips_the_conversation() {
    assert!(
        select(
            &[(&key("y"), "garbage".into()), (&key("x"), draft(A, "mine"))],
            &[carried("y", &[("x", A), ("y", B)])]
        )
        .is_empty()
    );
}

#[test]
fn a_malformed_target_draft_does_not_hold_back_another_conversation() {
    assert_eq!(
        select(
            &[
                (&key("y"), "garbage".into()),
                (&key("x"), draft(A, "stays")),
                (&key("q"), draft(A, "moves"))
            ],
            &[
                carried("y", &[("x", A), ("y", B)]),
                carried("q", &[("q", A)])
            ]
        ),
        [kept("q", "moves", "")]
    );
}

#[test]
fn as_draft_is_kept_over_a_third_accounts_draft_at_the_target_key() {
    // The target key is shared by every account that has that alias, so it holds one draft
    // whoever wrote it last.
    assert_eq!(
        select(
            &[
                (&key("y"), draft(C, "theirs")),
                (&key("x"), draft(A, "mine"))
            ],
            &[carried("y", &[("x", A), ("y", B)])]
        ),
        [kept("y", "mine", "")]
    );
}

#[test]
fn two_carried_conversations_do_not_interact() {
    assert_eq!(
        select(
            &[
                (&key("x"), draft(A, "first")),
                (&key("m"), draft(A, "second")),
                (&key("n"), draft(B, "theirs"))
            ],
            &[
                carried("y", &[("x", A)]),
                carried("n", &[("m", A), ("n", B)])
            ]
        ),
        [kept("y", "first", ""), kept("n", "second", "")]
    );
}

#[test]
fn a_draft_is_kept_for_one_conversation_only() {
    // Guards an input the real merge cannot produce: `x` is a member of both conversations.
    assert_eq!(
        select(
            &[(&key("x"), draft(A, "t"))],
            &[carried("y", &[("x", A)]), carried("z", &[("x", A)])]
        ),
        [kept("y", "t", "")]
    );
}

#[test]
fn the_target_alias_is_scanned_even_when_it_is_not_a_member() {
    assert_eq!(
        select(&[(&key("x"), draft(A, "t"))], &[carried("x", &[])]),
        [kept("x", "t", "")]
    );
}

#[test]
fn the_text_is_kept_exactly() {
    let text = "  first line\n\n\tsecond line \n";
    assert_eq!(
        select(&[(&key("x"), draft(A, text))], &[carried("x", &[("x", A)])]),
        [kept("x", text, "")]
    );
}

#[test]
fn the_title_comes_from_bs_record() {
    let drafts = [(key("x"), draft(A, "one")), (key("q"), draft(A, "two"))];
    let drafts: Vec<(&str, String)> = drafts
        .iter()
        .map(|(k, v)| (k.as_str(), v.clone()))
        .collect();
    let conversations = [carried("y", &[("x", A)]), carried("n", &[("q", A)])];
    assert_eq!(
        select_from(
            &drafts,
            &conversations,
            &[("y", "Fix login"), ("unrelated", "Other")],
            A
        ),
        [kept("y", "one", "Fix login"), kept("n", "two", "")]
    );
    // The new-session draft belongs to no conversation, so it has no title.
    assert_eq!(
        select_from(
            &[(NEW_SESSION_DRAFT, draft(A, "t"))],
            &[],
            &[("y", "Fix login")],
            A
        )[0]
        .title,
        ""
    );
    // A name that is only inherited is not a title.
    assert_eq!(
        select(
            &[(&key("constructor"), draft(A, "t"))],
            &[carried("constructor", &[])]
        )[0]
        .title,
        ""
    );
}

#[test]
fn attachments_are_flagged() {
    let flagged = |extra: Value| {
        select(
            &[(&key("x"), draft_with(A, json!("t"), extra))],
            &[carried("x", &[("x", A)])],
        )[0]
        .attachments
    };
    assert!(flagged(json!({ "files": [{ "name": "a.png" }] })));
    assert!(flagged(json!({ "snippets": [{ "id": 1 }] })));
    assert!(flagged(
        json!({ "files": [{ "name": "a.png" }], "snippets": [{ "id": 1 }] })
    ));
    assert!(!flagged(json!({})));
    // Absent, empty or not a list: nothing is attached.
    let absent = select(
        &[(&key("x"), json!({ "text": "t", "owner": A }).to_string())],
        &[carried("x", &[("x", A)])],
    );
    assert!(!absent[0].attachments);
    assert!(!flagged(json!({ "files": "a.png", "snippets": {} })));
    assert!(
        select(
            &[(
                NEW_SESSION_DRAFT,
                draft_with(A, json!("t"), json!({ "files": [1] }))
            )],
            &[]
        )[0]
        .attachments
    );
}

#[test]
fn an_empty_draft_is_not_captured() {
    let empty = [
        draft(A, ""),
        draft(A, "  \n\t "),
        // No text at all, or text that is not a string.
        json!({ "files": [], "snippets": [], "owner": A }).to_string(),
        draft_with(A, json!(5), json!({})),
        // Attachments alone are not worth keeping: only text is re-typed.
        draft_with(A, json!(""), json!({ "files": [{ "name": "a.png" }] })),
    ];
    for value in empty {
        assert!(
            select(&[(&key("x"), value.clone())], &[carried("x", &[("x", A)])]).is_empty(),
            "{value}"
        );
        assert!(
            select(&[(NEW_SESSION_DRAFT, value.clone())], &[]).is_empty(),
            "{value}"
        );
    }
    // An empty draft never takes the place of one with text, wherever it sits.
    assert_eq!(
        select(
            &[(&key("y"), draft(A, "")), (&key("x"), draft(A, "real"))],
            &[carried("y", &[("x", A), ("y", A)])]
        ),
        [kept("y", "real", "")]
    );
}

// --- Copying Local Storage, and sweeping what the first design left -----------------------

struct Fx {
    _temp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    vault: PathBuf,
    leveldb: PathBuf,
    files: Vec<(&'static str, Vec<u8>)>,
    tmp: PathBuf,
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).unwrap();
    bytes
}

/// A fake Claude root and vault, each with the pieces a real LevelDB directory has.
fn storage_fixture() -> Fx {
    let temp = tempfile::Builder::new()
        .prefix("relay-drafts-store-")
        .tempdir()
        .unwrap();
    let base = temp.path().to_path_buf();
    let root = base.join("Claude");
    let vault = base.join("desktop-vault");
    let leveldb = root.join(LEVELDB);
    fs::create_dir_all(leveldb.join("nested")).unwrap();
    fs::create_dir_all(&vault).unwrap();
    let files: Vec<(&'static str, Vec<u8>)> = vec![
        ("LOCK", vec![]),
        ("CURRENT", b"MANIFEST-000001\n".to_vec()),
        (
            "LOG",
            b"2026/10/16-12:00:00.000 Delete type=3 #1\n".to_vec(),
        ),
        ("MANIFEST-000001", vec![0, 255, 1, 254, 2, 253, 0, 0]),
        ("000003.log", random_bytes(4096)),
        // A few MB, so a short or truncated copy cannot pass by accident.
        ("000005.ldb", random_bytes(3 * 1024 * 1024)),
        ("nested/inner.bin", random_bytes(777)),
        ("nested/empty", vec![]),
    ];
    for (name, bytes) in &files {
        fs::write(leveldb.join(name), bytes).unwrap();
    }
    // Stands in for the temp dir, so the draft step never touches the real one.
    let tmp = base.join("tmp");
    fs::create_dir(&tmp).unwrap();
    Fx {
        _temp: temp,
        base,
        root,
        vault,
        leveldb,
        files,
        tmp,
    }
}

/// Every entry under `dir`, relative, with its bytes (files), its target (links) or None (dirs).
fn snapshot(dir: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    fn walk(dir: &Path, current: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
        for entry in fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();
            let full = entry.path();
            let rel = full
                .strip_prefix(dir)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                out.insert(rel, None);
                walk(dir, &full, out);
            } else if kind.is_symlink() {
                out.insert(
                    rel,
                    Some(format!("-> {}", fs::read_link(&full).unwrap().display()).into_bytes()),
                );
            } else {
                out.insert(rel, Some(fs::read(&full).unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// Where a test asks for a copy: a new dir in a scratch dir of its own, as the draft step does.
fn copy_target(fx: &Fx) -> PathBuf {
    let scratch = tempfile::Builder::new()
        .prefix("scratch-")
        .tempdir_in(&fx.base)
        .unwrap()
        .keep();
    scratch.join("copy")
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn gone(path: &Path) -> bool {
    fs::symlink_metadata(path).is_err()
}

#[cfg(unix)]
fn symlink(target: impl AsRef<Path>, link: impl AsRef<Path>) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[test]
fn a_copy_of_leveldb_is_byte_exact_and_private_and_claudes_stays_as_it_was() {
    let fx = storage_fixture();
    let before = snapshot(&fx.root.join(LOCAL_STORAGE));
    let storage = copy_target(&fx);
    assert!(copy_local_storage(&fx.root, &storage).unwrap());
    assert_eq!(names(&storage), ["leveldb"]);
    let copy = storage.join("leveldb");
    assert_eq!(snapshot(&copy), snapshot(&fx.leveldb));
    assert_eq!(fs::metadata(copy.join("LOCK")).unwrap().len(), 0);
    assert_eq!(fs::metadata(copy.join("nested/empty")).unwrap().len(), 0);
    for (name, bytes) in &fx.files {
        assert_eq!(&fs::read(copy.join(name)).unwrap(), bytes, "{name}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&storage).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    // Nothing was made or changed beside Claude's leveldb.
    assert_eq!(snapshot(&fx.root.join(LOCAL_STORAGE)), before);
    // A directory that already exists is never copied into.
    let error = copy_local_storage(&fx.root, &storage).unwrap_err();
    assert_eq!(error.io_kind(), Some(std::io::ErrorKind::AlreadyExists));
}

#[test]
#[cfg(unix)]
fn a_link_anywhere_in_leveldb_fails_the_copy() {
    // Chromium's leveldb holds none. Followed from the copy, a link could reach Claude's own
    // files, so not even one that stays inside is copied.
    let cases = [
        ("link", "LOCK", "Local Storage/leveldb/link"),
        ("nested/up", "../CURRENT", "Local Storage/leveldb/nested/up"),
        ("link", "ABSOLUTE", "Local Storage/leveldb/link"),
        ("link", "../outside", "Local Storage/leveldb/link"),
        (
            "nested/escape",
            "../../escape",
            "Local Storage/leveldb/nested/escape",
        ),
    ];
    for (name, target, shown) in cases {
        let fx = storage_fixture();
        let target_path = if target == "ABSOLUTE" {
            fx.leveldb.join("CURRENT")
        } else {
            PathBuf::from(target)
        };
        symlink(&target_path, fx.leveldb.join(name));
        let before = snapshot(&fx.root.join(LOCAL_STORAGE));
        let error = copy_local_storage(&fx.root, &copy_target(&fx)).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("{shown} is a symbolic link."),
            "{name} -> {target}"
        );
        assert_eq!(snapshot(&fx.root.join(LOCAL_STORAGE)), before, "{target}");
    }
}

#[test]
fn a_missing_leveldb_gives_no_copy() {
    let fx = storage_fixture();
    let storage = copy_target(&fx);
    fs::remove_dir_all(&fx.leveldb).unwrap();
    assert!(!copy_local_storage(&fx.root, &storage).unwrap());
    fs::remove_dir_all(fx.root.join(LOCAL_STORAGE)).unwrap();
    assert!(!copy_local_storage(&fx.root, &storage).unwrap());
    fs::remove_dir_all(&fx.root).unwrap();
    assert!(!copy_local_storage(&fx.root, &storage).unwrap());
    // Nothing was made where the copy would have gone.
    assert!(gone(&storage));
}

#[test]
#[cfg(unix)]
fn a_linked_or_misshapen_local_storage_or_leveldb_is_refused() {
    let linked = storage_fixture();
    let real = linked.base.join("real-leveldb");
    fs::rename(&linked.leveldb, &real).unwrap();
    symlink(&real, &linked.leveldb);
    let error = copy_local_storage(&linked.root, &copy_target(&linked)).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Local Storage/leveldb is a symbolic link."
    );

    let file = storage_fixture();
    fs::remove_dir_all(&file.leveldb).unwrap();
    fs::write(&file.leveldb, "not a directory").unwrap();
    let error = copy_local_storage(&file.root, &copy_target(&file)).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Local Storage/leveldb is not a directory."
    );

    let storage = storage_fixture();
    let elsewhere = storage.base.join("real-storage");
    fs::rename(storage.root.join(LOCAL_STORAGE), &elsewhere).unwrap();
    symlink(&elsewhere, storage.root.join(LOCAL_STORAGE));
    let target = copy_target(&storage);
    let error = copy_local_storage(&storage.root, &target).unwrap_err();
    assert_eq!(error.to_string(), "Local Storage is a symbolic link.");
    assert!(gone(&target));
}

/// A root user ignores file modes, and Windows has none, so the chmod-based tests prove nothing
/// there.
#[cfg(unix)]
fn root_user() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(unix)]
fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
#[cfg(unix)]
fn an_unreadable_leveldb_file_fails_the_copy() {
    if root_user() {
        return;
    }
    let fx = storage_fixture();
    let file = fx.leveldb.join("000003.log");
    chmod(&file, 0);
    let result = copy_local_storage(&fx.root, &copy_target(&fx));
    chmod(&file, 0o600);
    assert_eq!(
        result.unwrap_err().io_kind(),
        Some(std::io::ErrorKind::PermissionDenied)
    );
    assert_eq!(names(&fx.root.join(LOCAL_STORAGE)), ["leveldb"]);
}

#[test]
fn the_sweep_removes_only_unfinished_copies_and_only_while_leveldb_is_in_place() {
    let fx = storage_fixture();
    let storage = fx.root.join(LOCAL_STORAGE);
    let before = snapshot(&fx.leveldb);
    // Claude's own earlier leveldb, set aside by the first design: never deleted.
    let old = storage.join(format!("leveldb.relay-old-{}", uuid()));
    copy_dir(&fx.leveldb, &old);
    let plant = || {
        fs::create_dir(storage.join(format!("leveldb.relay-{}", uuid()))).unwrap();
        fs::create_dir_all(
            storage
                .join(format!(".relay-work-{}", uuid()))
                .join("leveldb"),
        )
        .unwrap();
    };
    plant();
    sweep_draft_leftovers(&fx.root);
    let mut expected = vec![
        "leveldb".to_owned(),
        old.file_name().unwrap().to_string_lossy().into_owned(),
    ];
    expected.sort();
    assert_eq!(names(&storage), expected);
    assert_eq!(snapshot(&old), before);
    assert_eq!(snapshot(&fx.leveldb), before);
    // With leveldb gone, what is beside it may be the only copy of Claude's data: all of it stays.
    fs::remove_dir_all(&fx.leveldb).unwrap();
    plant();
    let left = names(&storage);
    assert_eq!(left.len(), 3);
    sweep_draft_leftovers(&fx.root);
    assert_eq!(names(&storage), left);
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}

#[test]
#[cfg(unix)]
fn the_sweep_never_reaches_through_a_symlinked_local_storage() {
    let fx = storage_fixture();
    let storage = fx.root.join(LOCAL_STORAGE);
    let elsewhere = fx.base.join("elsewhere");
    fs::rename(&storage, &elsewhere).unwrap();
    fs::create_dir(elsewhere.join("leveldb.relay-1234")).unwrap();
    fs::create_dir(elsewhere.join(".relay-work-5678")).unwrap();
    symlink(&elsewhere, &storage);
    sweep_draft_leftovers(&fx.root);
    assert_eq!(
        names(&elsewhere),
        [".relay-work-5678", "leveldb", "leveldb.relay-1234"]
    );
}

#[test]
#[cfg(unix)]
fn the_first_designs_plaintext_backups_are_removed_and_nothing_else() {
    let fx = storage_fixture();
    let drafts = fx.vault.join("drafts");
    for stamp in ["2026-10-16T09-08-07-654Z", "2025-12-31T23-59-59-999Z"] {
        fs::create_dir_all(drafts.join(stamp).join("leveldb")).unwrap();
        fs::write(drafts.join(stamp).join("leveldb").join("000003.log"), "x").unwrap();
    }
    fs::write(drafts.join("last.json"), "{}").unwrap();
    fs::write(drafts.join("pending.bin"), "sealed").unwrap();
    fs::create_dir(drafts.join("not-a-stamp")).unwrap();
    // Named like a backup, but a file.
    fs::write(drafts.join("2026-10-01T00-00-00-000Z"), "file").unwrap();
    // Named like a backup, but a link: neither it nor what it leads to is removed.
    let outside = fx.base.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("precious"), "mine").unwrap();
    symlink(&outside, drafts.join("2026-11-01T12-00-00-000Z"));
    // Outside <vault>/drafts, however it is named.
    fs::create_dir_all(fx.vault.join("backups").join("2026-01-01T00-00-00-000Z")).unwrap();

    remove_legacy_draft_backups(&fx.vault);

    assert_eq!(
        names(&drafts),
        [
            "2026-10-01T00-00-00-000Z",
            "2026-11-01T12-00-00-000Z",
            "last.json",
            "not-a-stamp",
            "pending.bin"
        ]
    );
    assert_eq!(
        fs::read_to_string(drafts.join("pending.bin")).unwrap(),
        "sealed"
    );
    assert_eq!(
        fs::read_to_string(outside.join("precious")).unwrap(),
        "mine"
    );
    assert!(
        fs::symlink_metadata(drafts.join("2026-11-01T12-00-00-000Z"))
            .unwrap()
            .is_symlink()
    );
    assert_eq!(
        names(&fx.vault.join("backups")),
        ["2026-01-01T00-00-00-000Z"]
    );
}

#[test]
#[cfg(unix)]
fn the_backup_cleanup_never_follows_a_linked_drafts_dir() {
    let fx = storage_fixture();
    let outside = fx.base.join("outside");
    fs::create_dir_all(outside.join("2026-10-01T12-00-00-000Z")).unwrap();
    symlink(&outside, fx.vault.join("drafts"));
    remove_legacy_draft_backups(&fx.vault);
    assert_eq!(names(&outside), ["2026-10-01T12-00-00-000Z"]);
    // A vault without drafts is left as it is.
    fs::remove_file(fx.vault.join("drafts")).unwrap();
    remove_legacy_draft_backups(&fx.vault);
    assert!(names(&fx.vault).is_empty());
}

// --- Reading Local Storage -----------------------------------------------------------------

const ALIAS_X: &str = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ALIAS_Y: &str = "bbbbbbbb-0000-4000-8000-0000000000b2";

/// A page backed by a plain map, recording what the reader asks of it. `size` is how many keys
/// the whole origin holds: Claude keeps plenty besides drafts, so it defaults to a non-empty one.
struct FakePage {
    store: JsMap<String>,
    size: Option<usize>,
    fail_at: Option<&'static str>,
    fail_with: Option<String>,
    calls: Mutex<Vec<&'static str>>,
}

fn fake_page(store: JsMap<String>) -> FakePage {
    FakePage {
        store,
        size: None,
        fail_at: None,
        fail_with: None,
        calls: Mutex::default(),
    }
}

impl FakePage {
    fn trip(&self, at: &'static str) -> Result<(), String> {
        if self.fail_at == Some(at) {
            return Err(self
                .fail_with
                .clone()
                .unwrap_or_else(|| format!("{at} failed")));
        }
        Ok(())
    }
}

impl DraftPage for FakePage {
    fn size(&self) -> Result<usize, String> {
        self.calls.lock().unwrap().push("size");
        self.trip("size")?;
        Ok(self.size.unwrap_or(self.store.len() + 2))
    }
    fn read(&self) -> Result<JsMap<String>, String> {
        self.calls.lock().unwrap().push("read");
        self.trip("read")?;
        Ok(self.store.clone())
    }
}

fn ok(drafts: JsMap<String>) -> DraftResult {
    DraftResult::Ok {
        drafts,
        sidebar: None,
    }
}

fn failed(error: &str) -> DraftResult {
    DraftResult::Failed {
        error: error.into(),
    }
}

#[test]
fn run_draft_job_only_reads_it_answers_with_the_drafts_the_page_holds() {
    // Raw values pass through as they are, even ones nobody could parse.
    let initial: JsMap<String> = [
        (key(ALIAS_X), draft(A, "from A")),
        (key(ALIAS_Y), draft(B, "B's own")),
        (NEW_SESSION_DRAFT.to_owned(), "not json".to_owned()),
    ]
    .into_iter()
    .collect();
    let page = fake_page(initial.clone());
    assert_eq!(run_draft_job(&page), ok(initial.clone()));
    assert_eq!(page.store, initial);
    // Check the origin has data, then read once. There is nothing else to ask of the page.
    assert_eq!(*page.calls.lock().unwrap(), ["size", "read"]);
    // No drafts at all is not an error.
    assert_eq!(run_draft_job(&fake_page(JsMap::new())), ok(JsMap::new()));
}

#[test]
fn an_empty_origin_is_a_failure_not_a_success() {
    // The database could not be opened as Claude's: nothing to read, and nothing to trust.
    let page = FakePage {
        size: Some(0),
        ..fake_page(JsMap::new())
    };
    assert_eq!(
        run_draft_job(&page),
        failed("Claude's Local Storage opened empty")
    );
    assert_eq!(EMPTY_STORAGE, "Claude's Local Storage opened empty");
    // The reader stops there: it reads nothing.
    assert_eq!(*page.calls.lock().unwrap(), ["size"]);
}

#[test]
fn a_page_that_throws_is_reported_not_thrown() {
    for at in ["size", "read"] {
        let page = FakePage {
            fail_at: Some(at),
            ..fake_page(map(&[(&key(ALIAS_X), &draft(A, "t"))]))
        };
        assert_eq!(
            run_draft_job(&page),
            failed(&format!("{at} failed")),
            "{at}"
        );
    }
    // Any message is passed on as it is.
    let odd = FakePage {
        fail_at: Some("read"),
        fail_with: Some("plain string".into()),
        ..fake_page(JsMap::new())
    };
    assert_eq!(run_draft_job(&odd), failed("plain string"));
}

#[test]
#[cfg(unix)]
fn local_storage_is_opened_only_when_it_and_its_leveldb_are_real_directories() {
    let fx = storage_fixture();
    let storage = fx.root.join(LOCAL_STORAGE);
    assert!(assert_local_storage(&storage).is_ok());
    // Missing: nothing is ever created in its place.
    let not_real = |dir: &Path, what: &str| {
        let error = assert_local_storage(dir).unwrap_err();
        assert!(error.contains(what), "{error}");
    };
    not_real(
        &fx.base.join("nowhere"),
        "Local Storage is not a real directory",
    );
    let outside = fx.base.join("outside");
    fs::create_dir_all(outside.join("leveldb")).unwrap();
    let link = fx.base.join("link");
    symlink(&outside, &link);
    not_real(&link, "Local Storage is not a real");
    let plain = fx.base.join("plain-file");
    fs::write(&plain, "x").unwrap();
    not_real(&plain, "Local Storage is not a real");
    // A Local Storage without a leveldb, a linked leveldb, a leveldb that is a file.
    let bare = fx.base.join("bare");
    fs::create_dir(&bare).unwrap();
    not_real(&bare, "Local Storage/leveldb is not a real directory");
    symlink(&fx.leveldb, bare.join("leveldb"));
    not_real(&bare, "leveldb is not a real");
    let filed = fx.base.join("filed");
    fs::create_dir(&filed).unwrap();
    fs::write(filed.join("leveldb"), "x").unwrap();
    not_real(&filed, "leveldb is not a real");
    // Nothing was created or changed by the checks.
    assert_eq!(names(&bare), ["leveldb"]);
    assert_eq!(names(&outside), ["leveldb"]);
}

// --- The draft step of a switch --------------------------------------------------------------

const NOW: &str = "2026-10-16T10:00:00.000Z";
fn now_ms() -> i64 {
    chrono::DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .timestamp_millis()
}
// Text that must never reach last.json, or survive the step outside the vault.
const UNSENT: &str = "an unsent draft, word for word";
const NEW_SESSION_TEXT: &str = "the start of a new session";

/// What the reader finds in the copy: A's drafts of X and of a new session, and B's own draft.
fn helper_drafts() -> JsMap<String> {
    [
        (key(ALIAS_X), draft(A, UNSENT)),
        (key(ALIAS_Y), draft(B, "B's own draft")),
        (
            NEW_SESSION_DRAFT.to_owned(),
            draft_with(A, json!(NEW_SESSION_TEXT), json!({ "files": ["a.png"] })),
        ),
    ]
    .into_iter()
    .collect()
}

fn captured() -> Vec<CapturedDraft> {
    vec![
        kept(ALIAS_X, UNSENT, "Fix login"),
        new_session(NEW_SESSION_TEXT, true),
    ]
}

fn read_slots() -> DraftSlots {
    DraftSlots {
        aliases: vec![ALIAS_X.into(), ALIAS_Y.into()],
        new_session: true,
    }
}

fn last_outcome(vault: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(vault.join("drafts").join("last.json")).unwrap())
        .unwrap()
}

fn storage_names(fx: &Fx) -> Vec<String> {
    names(&fx.root.join(LOCAL_STORAGE))
}

fn inside(dir: &Path, target: &Path) -> bool {
    target != dir && target.starts_with(dir)
}

/// A stand-in for the reader. It leaves in the scratch dir what the old helper did (a link to
/// the copy, a file holding the drafts it read, text and all), then answers with `answer`.
struct FakeRun {
    jobs: Mutex<Vec<DraftJob>>,
    answer: Box<dyn Fn(&DraftJob) -> DraftResult + Send + Sync>,
}

fn fake_run(answer: impl Fn(&DraftJob) -> DraftResult + Send + Sync + 'static) -> FakeRun {
    FakeRun {
        jobs: Mutex::default(),
        answer: Box::new(answer),
    }
}

fn reads() -> FakeRun {
    fake_run(|_| ok(helper_drafts()))
}

impl FakeRun {
    fn run(&self, job: &DraftJob) -> DraftResult {
        self.jobs.lock().unwrap().push(job.clone());
        fs::create_dir_all(job.scratch.join("root")).unwrap();
        #[cfg(unix)]
        symlink(&job.storage, job.scratch.join("root").join("Local Storage"));
        fs::write(
            job.scratch.join("result.json"),
            serde_json::to_string(&json!({ "drafts": UNSENT })).unwrap(),
        )
        .unwrap();
        (self.answer)(job)
    }
    fn jobs(&self) -> Vec<DraftJob> {
        self.jobs.lock().unwrap().clone()
    }
}

type Stored = Arc<Mutex<Vec<(String, Vec<CapturedDraft>, DraftSlots)>>>;

#[derive(Default)]
struct Extra {
    blocked: Option<String>,
    running: Option<Box<dyn Fn() -> Result<bool, String>>>,
    store_fails: Option<String>,
}

/// Runs the step for an A→B switch that carries X (A's and B's) and Y (B's only). B calls X
/// "Fix login". Returns the outcome and what was handed to `store`.
fn capture(
    fx: &Fx,
    run: &FakeRun,
    extra: Extra,
) -> (
    CaptureOutcome,
    Vec<(String, Vec<CapturedDraft>, DraftSlots)>,
) {
    let stored: Stored = Arc::default();
    let sink = stored.clone();
    let store_fails = extra.store_fails.clone();
    let store =
        move |to: &str, drafts: &[CapturedDraft], slots: &DraftSlots| -> Result<(), String> {
            if let Some(error) = &store_fails {
                return Err(error.clone());
            }
            sink.lock()
                .unwrap()
                .push((to.to_owned(), drafts.to_vec(), slots.clone()));
            Ok(())
        };
    let conversations = [
        carried(ALIAS_X, &[(ALIAS_X, A), (ALIAS_X, B)]),
        carried(ALIAS_Y, &[(ALIAS_Y, B)]),
    ];
    let titles: HashMap<String, String> = [
        (ALIAS_X.to_owned(), "Fix login".to_owned()),
        (ALIAS_Y.to_owned(), "B's work".to_owned()),
    ]
    .into();
    let last_json = fx.vault.join("drafts").join("last.json");
    let run_fn = |job: &DraftJob| run.run(job);
    let outcome = capture_drafts(CaptureInput {
        root: &fx.root,
        from: A,
        to: B,
        conversations: &conversations,
        titles: &titles,
        run: &run_fn,
        store: &store,
        sidebar: None,
        last_json: &last_json,
        now_ms: now_ms(),
        blocked: extra.blocked,
        running: extra.running.as_deref(),
        tmp: Some(&fx.tmp),
    });
    let stored = stored.lock().unwrap().clone();
    (outcome, stored)
}

fn last(status: &str, field: &str, value: Value) -> Value {
    json!({ "at": NOW, "from": A, "to": B, "status": status, field: value })
}

#[test]
fn captures_as_drafts_and_never_changes_claudes_leveldb() {
    let fx = storage_fixture();
    let before = snapshot(&fx.root.join(LOCAL_STORAGE));
    let run = fake_run(|job| {
        // Whatever the reader does to its copy stays in the copy.
        let leveldb = job.storage.join("leveldb");
        fs::write(leveldb.join("000005.ldb"), "rewritten").unwrap();
        fs::write(leveldb.join("000009.log"), "new").unwrap();
        let _ = fs::remove_file(leveldb.join("LOCK"));
        ok(helper_drafts())
    });
    let (outcome, stored) = capture(&fx, &run, Extra::default());
    assert_eq!(outcome, CaptureOutcome::Captured { count: 2 });
    // With every slot the step read: the carried conversations and the new-session draft.
    assert_eq!(stored, [(B.to_owned(), captured(), read_slots())]);
    let jobs = run.jobs();
    assert_eq!(jobs.len(), 1);
    // Byte for byte as it was, and nothing was made beside it.
    assert_eq!(snapshot(&fx.root.join(LOCAL_STORAGE)), before);
    assert_eq!(storage_names(&fx), ["leveldb"]);
    // The scratch dir, with the copy and the text-bearing result file, is gone.
    assert!(gone(&jobs[0].scratch));
    assert!(names(&fx.tmp).is_empty());
}

#[test]
fn the_helper_sees_only_the_private_copy() {
    let fx = storage_fixture();
    let before = snapshot(&fx.leveldb);
    let problem: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = problem.clone();
    let (tmp, root, leveldb_names) = (fx.tmp.clone(), fx.root.clone(), fx.root.join(LOCAL_STORAGE));
    let run = fake_run(move |job| {
        let check = |ok: bool, what: &str| {
            if !ok {
                sink.lock().unwrap().push(what.to_owned());
            }
        };
        check(
            job.scratch.parent() == Some(tmp.as_path()),
            "scratch in tmp",
        );
        check(
            job.scratch
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("relay-drafts-"),
            "scratch prefix",
        );
        check(
            job.storage == job.scratch.join("copy"),
            "storage is the copy",
        );
        check(inside(&tmp, &job.storage), "copy inside tmp");
        check(!inside(&root, &job.storage), "copy outside Claude");
        // A copy of Claude's leveldb, and nothing was made in Claude's dir for it.
        check(
            snapshot(&job.storage.join("leveldb")) == before,
            "copy is exact",
        );
        check(
            names(&leveldb_names) == ["leveldb"],
            "nothing beside leveldb",
        );
        ok(helper_drafts())
    });
    let (outcome, _) = capture(&fx, &run, Extra::default());
    assert!(matches!(outcome, CaptureOutcome::Captured { .. }));
    assert!(
        problem.lock().unwrap().is_empty(),
        "{:?}",
        problem.lock().unwrap()
    );
    assert_eq!(run.jobs().len(), 1);
}

#[test]
fn a_failed_run_stores_nothing_and_leaves_no_scratch() {
    let cases: [(&str, DraftResult, &str); 4] = [
        (
            "ok false",
            failed("verification failed"),
            "verification failed",
        ),
        ("empty origin", failed(EMPTY_STORAGE), EMPTY_STORAGE),
        ("a throw", failed("helper crashed"), "helper crashed"),
        ("no answer", failed(""), "no result"),
    ];
    for (name, answer, error) in cases {
        let fx = storage_fixture();
        let before = snapshot(&fx.root.join(LOCAL_STORAGE));
        let run = fake_run(move |_| answer.clone());
        let (outcome, stored) = capture(&fx, &run, Extra::default());
        assert_eq!(
            outcome,
            CaptureOutcome::Failed {
                error: error.into()
            },
            "{name}"
        );
        assert!(stored.is_empty(), "{name}");
        let jobs = run.jobs();
        assert_eq!(jobs.len(), 1, "{name}");
        // The fake left the text it read in its result file: that is gone with the scratch dir.
        assert!(gone(&jobs[0].scratch));
        assert!(names(&fx.tmp).is_empty(), "{name}");
        assert_eq!(snapshot(&fx.root.join(LOCAL_STORAGE)), before, "{name}");
        assert_eq!(
            last_outcome(&fx.vault),
            last("failed", "error", json!(error)),
            "{name}"
        );
    }
}

#[test]
fn a_store_that_fails_is_a_failure_and_leaves_no_scratch() {
    let fx = storage_fixture();
    let run = reads();
    let extra = Extra {
        store_fails: Some("System encryption is unavailable.".into()),
        ..Extra::default()
    };
    let (outcome, _) = capture(&fx, &run, extra);
    assert_eq!(
        outcome,
        CaptureOutcome::Failed {
            error: "System encryption is unavailable.".into()
        }
    );
    assert!(gone(&run.jobs()[0].scratch));
    assert_eq!(
        last_outcome(&fx.vault),
        last(
            "failed",
            "error",
            json!("System encryption is unavailable.")
        )
    );
}

/// Sets a directory's modification time `minutes` ago.
fn age(path: &Path, minutes: u64) {
    let at = std::time::SystemTime::now() - std::time::Duration::from_secs(minutes * 60);
    relay_core::fs_util::set_times(path, at).unwrap();
}

#[test]
fn blocked_skips() {
    for reason in ["drafts move only on macOS", "Claude is running"] {
        let fx = storage_fixture();
        let storage = fx.root.join(LOCAL_STORAGE);
        // What the sweeps would remove, had the step gone on.
        fs::create_dir(storage.join("leveldb.relay-1234")).unwrap();
        fs::create_dir(storage.join(".relay-work-5678")).unwrap();
        let stale = tempfile::Builder::new()
            .prefix("relay-drafts-")
            .tempdir_in(&fx.tmp)
            .unwrap()
            .keep();
        age(&stale, 11);
        let before = snapshot(&storage);
        let run = reads();
        let (outcome, stored) = capture(
            &fx,
            &run,
            Extra {
                blocked: Some(reason.into()),
                ..Extra::default()
            },
        );
        assert_eq!(
            outcome,
            CaptureOutcome::Skipped {
                reason: reason.into()
            }
        );
        assert!(run.jobs().is_empty());
        assert!(stored.is_empty());
        // Nothing is swept, copied or made.
        assert_eq!(snapshot(&storage), before);
        assert_eq!(
            names(&fx.tmp),
            [stale.file_name().unwrap().to_string_lossy().into_owned()]
        );
        assert_eq!(
            last_outcome(&fx.vault),
            last("skipped", "reason", json!(reason))
        );
    }
}

#[test]
fn last_json_holds_no_text() {
    let fx = storage_fixture();
    let (outcome, _) = capture(&fx, &reads(), Extra::default());
    assert!(matches!(outcome, CaptureOutcome::Captured { .. }));
    let drafts = fx.vault.join("drafts");
    let raw = fs::read_to_string(drafts.join("last.json")).unwrap();
    for text in [UNSENT, NEW_SESSION_TEXT, "B's own draft"] {
        assert!(!raw.contains(text), "{raw}");
    }
    // Counts and reasons only.
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap(),
        last("captured", "count", json!(2))
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Private to Relay, like the directory made for it.
        assert_eq!(
            fs::metadata(&drafts).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(drafts.join("last.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
#[cfg(unix)]
fn stale_scratch_is_swept_relay_old_is_never_touched() {
    let fx = storage_fixture();
    let storage = fx.root.join(LOCAL_STORAGE);
    // What a crashed step left: a scratch dir whose link leads to a Claude dir.
    let claude = fx.base.join("fake-claude");
    fs::create_dir_all(claude.join("leveldb")).unwrap();
    fs::write(claude.join("leveldb").join("CURRENT"), "MANIFEST-1\n").unwrap();
    let stale = tempfile::Builder::new()
        .prefix("relay-drafts-")
        .tempdir_in(&fx.tmp)
        .unwrap()
        .keep();
    fs::create_dir(stale.join("root")).unwrap();
    symlink(&claude, stale.join("root").join("Local Storage"));
    // Younger than ten minutes: it may belong to a step still running.
    let fresh = tempfile::Builder::new()
        .prefix("relay-drafts-")
        .tempdir_in(&fx.tmp)
        .unwrap()
        .keep();
    // Not a scratch dir, however old.
    let other = fx.tmp.join("someone-else");
    fs::create_dir(&other).unwrap();
    age(&stale, 11);
    age(&other, 11);
    // What the first design left in Claude's Local Storage: a leveldb it set aside, which is
    // never deleted, and a working dir and an unfinished copy, which are.
    let old = storage.join("leveldb.relay-old-0123");
    copy_dir(&fx.leveldb, &old);
    let kept_old = snapshot(&old);
    fs::create_dir_all(
        storage
            .join(format!(".relay-work-{}", uuid()))
            .join("leveldb"),
    )
    .unwrap();
    fs::create_dir(storage.join(format!("leveldb.relay-{}", uuid()))).unwrap();

    assert!(matches!(
        capture(&fx, &reads(), Extra::default()).0,
        CaptureOutcome::Captured { .. }
    ));

    assert!(gone(&stale));
    assert!(fresh.is_dir());
    assert!(other.is_dir());
    assert_eq!(
        fs::read_to_string(claude.join("leveldb").join("CURRENT")).unwrap(),
        "MANIFEST-1\n"
    );
    assert_eq!(storage_names(&fx), ["leveldb", "leveldb.relay-old-0123"]);
    assert_eq!(snapshot(&old), kept_old);

    // Without leveldb, what is beside it may be all that is left of Claude's data: it all stays.
    fs::create_dir(storage.join(".relay-work-5678")).unwrap();
    fs::rename(&fx.leveldb, fx.base.join("elsewhere")).unwrap();
    assert_eq!(
        capture(&fx, &reads(), Extra::default()).0,
        CaptureOutcome::Skipped {
            reason: "no Local Storage".into()
        }
    );
    assert_eq!(
        storage_names(&fx),
        [".relay-work-5678", "leveldb.relay-old-0123"]
    );
    assert_eq!(snapshot(&old), kept_old);
}

#[test]
fn no_local_storage_skipped_run_not_called() {
    let fx = storage_fixture();
    fs::remove_dir_all(&fx.leveldb).unwrap();
    let run = reads();
    let (outcome, stored) = capture(&fx, &run, Extra::default());
    assert_eq!(
        outcome,
        CaptureOutcome::Skipped {
            reason: "no Local Storage".into()
        }
    );
    assert!(run.jobs().is_empty());
    assert!(stored.is_empty());
    assert!(names(&fx.tmp).is_empty());
    assert_eq!(
        last_outcome(&fx.vault),
        last("skipped", "reason", json!("no Local Storage"))
    );
}

#[test]
#[cfg(unix)]
fn a_leveldb_that_cannot_be_copied_fails_and_the_helper_never_runs() {
    let run = reads();
    let linked = storage_fixture();
    let real = linked.base.join("real-leveldb");
    fs::rename(&linked.leveldb, &real).unwrap();
    symlink(&real, &linked.leveldb);
    assert_eq!(
        capture(&linked, &run, Extra::default()).0,
        CaptureOutcome::Failed {
            error: "Local Storage/leveldb is a symbolic link.".into()
        }
    );
    assert!(names(&linked.tmp).is_empty());
    // A copy that breaks half way (the TS injected an fs.cp failure; here a file cannot be read).
    if !root_user() {
        let broken = storage_fixture();
        let file = broken.leveldb.join("nested").join("inner.bin");
        chmod(&file, 0);
        let (outcome, _) = capture(&broken, &run, Extra::default());
        chmod(&file, 0o600);
        assert!(
            matches!(&outcome, CaptureOutcome::Failed { error } if error.contains("ermission denied")),
            "{outcome:?}"
        );
        // The half copy went with the scratch dir.
        assert!(names(&broken.tmp).is_empty());
        assert_eq!(storage_names(&broken), ["leveldb"]);
        assert_eq!(last_outcome(&broken.vault)["status"], "failed");
    }
    assert!(run.jobs().is_empty());
}

#[test]
fn without_drafts_worth_keeping_no_draft_is_stored_but_the_slots_read_are() {
    let fx = storage_fixture();
    let run = fake_run(|_| {
        ok([
            (key(ALIAS_Y), draft(B, "B's own draft")),
            (key(ALIAS_X), draft(A, " ")),
        ]
        .into_iter()
        .collect())
    });
    let (outcome, stored) = capture(&fx, &run, Extra::default());
    assert_eq!(outcome, CaptureOutcome::Captured { count: 0 });
    // So the vault can drop an older draft A no longer has in them.
    assert_eq!(stored, [(B.to_owned(), vec![], read_slots())]);
    assert_eq!(last_outcome(&fx.vault)["count"], 0);
}

#[test]
fn claude_opening_after_the_copy_stops_the_step_before_the_run() {
    // Asked once, after the copy. A check that fails counts as running.
    let answers: [(&str, Result<bool, String>); 2] =
        [("running", Ok(true)), ("unknown", Err("ps failed".into()))];
    for (name, answer) in answers {
        let fx = storage_fixture();
        let before = snapshot(&fx.root.join(LOCAL_STORAGE));
        let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let sink = seen.clone();
        let tmp = fx.tmp.clone();
        let run = reads();
        let running = Box::new(move || {
            // What the step's scratch dir holds when it asks.
            for scratch in names(&tmp) {
                sink.lock().unwrap().push(names(&tmp.join(scratch)));
            }
            answer.clone()
        });
        let (outcome, stored) = capture(
            &fx,
            &run,
            Extra {
                running: Some(running),
                ..Extra::default()
            },
        );
        assert_eq!(
            outcome,
            CaptureOutcome::Skipped {
                reason: CLAUDE_RUNNING.into()
            },
            "{name}"
        );
        // Asked once, with the copy made.
        assert_eq!(*seen.lock().unwrap(), [vec!["copy".to_owned()]], "{name}");
        assert!(run.jobs().is_empty(), "{name}");
        assert!(stored.is_empty(), "{name}");
        // The copy is gone, and Claude's leveldb is as it was.
        assert!(names(&fx.tmp).is_empty(), "{name}");
        assert_eq!(snapshot(&fx.root.join(LOCAL_STORAGE)), before, "{name}");
        assert_eq!(
            last_outcome(&fx.vault),
            last("skipped", "reason", json!("Claude is running")),
            "{name}"
        );
    }
    // Still closed: the run goes ahead.
    let fx = storage_fixture();
    let run = reads();
    let (outcome, _) = capture(
        &fx,
        &run,
        Extra {
            running: Some(Box::new(|| Ok(false))),
            ..Extra::default()
        },
    );
    assert!(matches!(outcome, CaptureOutcome::Captured { .. }));
    assert_eq!(run.jobs().len(), 1);
}

#[test]
#[cfg(unix)]
fn a_link_inside_leveldb_fails_the_step_and_the_helper_never_runs() {
    let fx = storage_fixture();
    symlink("LOCK", fx.leveldb.join("link"));
    let run = reads();
    let (outcome, _) = capture(&fx, &run, Extra::default());
    assert_eq!(
        outcome,
        CaptureOutcome::Failed {
            error: "Local Storage/leveldb/link is a symbolic link.".into()
        }
    );
    assert!(run.jobs().is_empty());
    assert!(names(&fx.tmp).is_empty());
}

#[test]
fn a_long_error_is_cut_to_300_characters() {
    let fx = storage_fixture();
    let long = format!("{}Ω{}", "e".repeat(299), "tail".repeat(250));
    let cut: String = long.chars().take(300).collect();
    let answer = long.clone();
    let (outcome, _) = capture(&fx, &fake_run(move |_| failed(&answer)), Extra::default());
    assert_eq!(outcome, CaptureOutcome::Failed { error: cut.clone() });
    assert_eq!(last_outcome(&fx.vault)["error"], json!(cut));
    // A blocked reason, which may be any error Relay caught, is cut the same way.
    let blocked = storage_fixture();
    let (skipped, _) = capture(
        &blocked,
        &reads(),
        Extra {
            blocked: Some(long),
            ..Extra::default()
        },
    );
    assert_eq!(
        skipped,
        CaptureOutcome::Skipped {
            reason: cut.clone()
        }
    );
    assert_eq!(last_outcome(&blocked.vault)["reason"], json!(cut));
}

#[test]
#[cfg(unix)]
fn last_json_is_never_written_through_a_linked_drafts_dir() {
    let fx = storage_fixture();
    let target = fx.base.join("outside");
    fs::create_dir(&target).unwrap();
    symlink(&target, fx.vault.join("drafts"));
    assert!(matches!(
        capture(&fx, &reads(), Extra::default()).0,
        CaptureOutcome::Captured { .. }
    ));
    assert!(names(&target).is_empty());
}

// --- The in-process reader on a real LevelDB ------------------------------------------------

/// Chromium's DOMStorage key for `key` of claude.ai, Latin-1.
fn storage_key(key: &str) -> Vec<u8> {
    let mut out = b"_https://claude.ai\0\x01".to_vec();
    out.extend(key.chars().map(|c| c as u8));
    out
}

/// Chromium's DOMStorage value: UTF-16LE when it needs to be, Latin-1 otherwise.
fn storage_value(value: &str) -> Vec<u8> {
    if value.chars().all(|c| (c as u32) < 256) {
        std::iter::once(1u8)
            .chain(value.chars().map(|c| c as u8))
            .collect()
    } else {
        std::iter::once(0u8)
            .chain(value.encode_utf16().flat_map(u16::to_le_bytes))
            .collect()
    }
}

#[test]
fn the_in_process_reader_reads_claudes_drafts_and_sidebar_from_a_copy_of_its_local_storage() {
    let fx = storage_fixture();
    fs::remove_dir_all(&fx.leveldb).unwrap();
    {
        let options = rusty_leveldb::Options {
            create_if_missing: true,
            ..Default::default()
        };
        let mut db = rusty_leveldb::DB::open(&fx.leveldb, options).unwrap();
        let mut batch = rusty_leveldb::WriteBatch::default();
        batch.put(b"VERSION", b"1");
        batch.put(b"META:https://claude.ai", b"\x08\x01");
        for (k, v) in helper_drafts().iter() {
            batch.put(&storage_key(k), &storage_value(v));
        }
        batch.put(
            &storage_key("dframe-store"),
            &storage_value("{\"version\":1,\"note\":\"ğüş — ✓\"}"),
        );
        batch.put(&storage_key("theme"), &storage_value("dark"));
        // Another origin's draft key is not claude.ai's.
        batch.put(
            b"_https://example.com\0\x01composer-draft:epitaxy-draft",
            &storage_value(&draft(A, "x")),
        );
        db.write(batch, true).unwrap();
        db.close().unwrap();
    }
    let run = |job: &DraftJob| read_drafts(job);
    let stored: Stored = Arc::default();
    let sink = stored.clone();
    let store =
        move |to: &str, drafts: &[CapturedDraft], slots: &DraftSlots| -> Result<(), String> {
            sink.lock()
                .unwrap()
                .push((to.to_owned(), drafts.to_vec(), slots.clone()));
            Ok(())
        };
    let sidebar_seen: Arc<Mutex<Option<JsMap<String>>>> = Arc::default();
    let sidebar_sink = sidebar_seen.clone();
    let sidebar = move |raw: Option<&JsMap<String>>| -> Result<(), String> {
        *sidebar_sink.lock().unwrap() = raw.cloned();
        Ok(())
    };
    let conversations = [
        carried(ALIAS_X, &[(ALIAS_X, A), (ALIAS_X, B)]),
        carried(ALIAS_Y, &[(ALIAS_Y, B)]),
    ];
    let titles: HashMap<String, String> = [(ALIAS_X.to_owned(), "Fix login".to_owned())].into();
    let before = snapshot(&fx.root.join(LOCAL_STORAGE));
    let outcome = capture_drafts(CaptureInput {
        root: &fx.root,
        from: A,
        to: B,
        conversations: &conversations,
        titles: &titles,
        run: &run,
        store: &store,
        sidebar: Some(&sidebar),
        last_json: &fx.vault.join("drafts").join("last.json"),
        now_ms: now_ms(),
        blocked: None,
        running: None,
        tmp: Some(&fx.tmp),
    });
    assert_eq!(outcome, CaptureOutcome::Captured { count: 2 });
    assert_eq!(
        *stored.lock().unwrap(),
        [(B.to_owned(), captured(), read_slots())]
    );
    assert_eq!(
        *sidebar_seen.lock().unwrap(),
        Some(map(&[(
            "dframe-store",
            "{\"version\":1,\"note\":\"ğüş — ✓\"}"
        )]))
    );
    // Claude's leveldb is as it was: only the copy was opened.
    assert_eq!(snapshot(&fx.root.join(LOCAL_STORAGE)), before);
    assert!(names(&fx.tmp).is_empty());
}

#[test]
fn a_copy_that_is_not_a_leveldb_fails_the_read() {
    let fx = storage_fixture();
    let storage = copy_target(&fx);
    copy_local_storage(&fx.root, &storage).unwrap();
    let job = DraftJob {
        scratch: storage.parent().unwrap().to_path_buf(),
        storage,
    };
    assert!(matches!(read_drafts(&job), DraftResult::Failed { .. }));
}

// --- The sealed draft vault ------------------------------------------------------------------

/// A stand-in for the sealer: the text is base64 behind a marker, so it never shows as is.
fn seal() -> Seal {
    use base64::Engine;
    Arc::new(|text: &str| {
        Ok(format!(
            "SEALED:{}",
            base64::engine::general_purpose::STANDARD.encode(text)
        )
        .into_bytes())
    })
}

fn unseal_text(data: &[u8]) -> Result<String, String> {
    use base64::Engine;
    let text = String::from_utf8_lossy(data);
    let body = text.strip_prefix("SEALED:").ok_or("not sealed")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn unseal() -> Unseal {
    Arc::new(unseal_text)
}

fn sealed(text: &str) -> Vec<u8> {
    seal()(text).unwrap()
}

const DAY: i64 = 24 * 60 * 60_000;

struct Vf {
    _temp: tempfile::TempDir,
    vault: PathBuf,
    file: PathBuf,
    clock: Arc<Mutex<i64>>,
    drafts: DraftVault,
}

impl Vf {
    fn now(&self) -> Clock {
        let clock = self.clock.clone();
        Arc::new(move || *clock.lock().unwrap())
    }
    /// Another vault on the same files, as after a restart of Relay.
    fn reopen(&self) -> DraftVault {
        DraftVault::new(
            &self.vault,
            seal(),
            unseal(),
            Some(self.now()),
            DraftVaultHooks::default(),
        )
    }
    fn advance(&self, ms: i64) {
        *self.clock.lock().unwrap() += ms;
    }
}

fn vault_fixture() -> Vf {
    let temp = tempfile::Builder::new()
        .prefix("relay-draft-vault-")
        .tempdir()
        .unwrap();
    let vault = temp.path().to_path_buf();
    let clock = Arc::new(Mutex::new(now_ms()));
    let c = clock.clone();
    let now: Clock = Arc::new(move || *c.lock().unwrap());
    Vf {
        file: vault.join("drafts").join("pending.bin"),
        drafts: DraftVault::new(
            &vault,
            seal(),
            unseal(),
            Some(now),
            DraftVaultHooks::default(),
        ),
        vault,
        clock,
        _temp: temp,
    }
}

fn conversation_draft(target_alias: &str, text: &str) -> CapturedDraft {
    CapturedDraft {
        target_alias: Some(target_alias.into()),
        new_session: None,
        title: format!("Title of {target_alias}"),
        text: text.into(),
        attachments: false,
    }
}

fn is_v4(id: &str) -> bool {
    regex::Regex::new("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .unwrap()
        .is_match(id)
}

#[test]
fn the_vault_gives_back_what_it_was_given_sealed_in_between() {
    let v = vault_fixture();
    let ns = new_session(NEW_SESSION_TEXT, true);
    v.drafts
        .add(B, &[conversation_draft(ALIAS_X, UNSENT), ns.clone()], None)
        .unwrap();
    let records = v.reopen().list();
    assert_eq!(records.len(), 2);
    for record in &records {
        assert!(is_v4(&record.id));
        assert_eq!(record.to, B);
        assert_eq!(record.captured_at, NOW);
        assert_eq!(record.state, DraftState::Pending);
        assert_eq!(record.reason, None);
    }
    assert_ne!(records[0].id, records[1].id);
    let strip = |r: &DraftRecord| CapturedDraft {
        target_alias: r.target_alias.clone(),
        new_session: r.new_session,
        title: r.title.clone(),
        text: r.text.clone(),
        attachments: r.attachments,
    };
    assert_eq!(
        records.iter().map(strip).collect::<Vec<_>>(),
        [conversation_draft(ALIAS_X, UNSENT), ns]
    );
    // A summary for the panel: everything but the text and the alias.
    let summary = serde_json::to_value(summarize(&records[0])).unwrap();
    assert_eq!(
        summary,
        json!({
            "id": records[0].id, "to": B, "title": format!("Title of {ALIAS_X}"), "newSession": false,
            "attachments": false, "state": "pending", "capturedAt": NOW,
        })
    );
    assert!(summarize(&records[1]).new_session);
    let all: Vec<_> = records.iter().map(summarize).collect();
    assert!(!serde_json::to_string(&all).unwrap().contains(UNSENT));
    // The file is private to Relay.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&v.file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn the_vaults_file_does_not_hold_the_text() {
    let v = vault_fixture();
    v.drafts
        .add(B, &[conversation_draft(ALIAS_X, UNSENT)], None)
        .unwrap();
    let raw = String::from_utf8(fs::read(&v.file).unwrap()).unwrap();
    assert!(raw.starts_with("SEALED:"));
    assert!(!raw.contains(UNSENT));
    assert!(!raw.contains(&format!("Title of {ALIAS_X}")));
}

#[test]
fn the_vault_keeps_at_most_20_records_the_newest() {
    let v = vault_fixture();
    let aliases: Vec<String> = (0..25).map(|_| uuid()).collect();
    for alias in &aliases {
        v.drafts
            .add(B, &[conversation_draft(alias, UNSENT)], None)
            .unwrap();
        v.advance(1000);
    }
    let records = v.drafts.list();
    assert_eq!(records.len(), 20);
    // Newest first.
    let got: Vec<String> = records
        .iter()
        .map(|r| r.target_alias.clone().unwrap())
        .collect();
    let mut want: Vec<String> = aliases[5..].to_vec();
    want.reverse();
    assert_eq!(got, want);
    // A batch bigger than the cap keeps its first 20.
    let batch: Vec<CapturedDraft> = (0..21)
        .map(|_| conversation_draft(&uuid(), UNSENT))
        .collect();
    v.drafts.add(C, &batch, None).unwrap();
    let got: Vec<Option<String>> = v
        .drafts
        .list()
        .into_iter()
        .map(|r| r.target_alias)
        .collect();
    let want: Vec<Option<String>> = batch[..20].iter().map(|d| d.target_alias.clone()).collect();
    assert_eq!(got, want);
}

#[test]
fn the_newest_capture_wins_per_account_and_conversation() {
    let v = vault_fixture();
    v.drafts
        .add(
            B,
            &[
                conversation_draft(ALIAS_X, "older"),
                new_session("old start", false),
            ],
            None,
        )
        .unwrap();
    let older_x = v.drafts.list()[0].clone();
    v.drafts
        .update(
            &older_x.id,
            DraftPatch {
                state: Some(DraftState::NeedsCopy),
                reason: Some(Some("lost".into())),
            },
        )
        .unwrap();
    v.advance(1000);
    v.drafts
        .add(
            B,
            &[
                conversation_draft(ALIAS_X, "newer"),
                new_session("new start", false),
            ],
            None,
        )
        .unwrap();
    // The same conversation for another account, and another conversation, stay.
    v.drafts
        .add(C, &[conversation_draft(ALIAS_X, "C's")], None)
        .unwrap();
    v.drafts
        .add(B, &[conversation_draft(ALIAS_Y, "Y's")], None)
        .unwrap();
    let records = v.drafts.list();
    let mut view: Vec<(String, Option<String>, String, DraftState)> = records
        .iter()
        .map(|r| {
            (
                r.to.clone(),
                r.target_alias.clone(),
                r.text.clone(),
                r.state,
            )
        })
        .collect();
    view.sort_by(|a, b| (&a.0, &a.1, &a.2).cmp(&(&b.0, &b.1, &b.2)));
    let mut want = vec![
        (
            B.to_owned(),
            Some(ALIAS_X.to_owned()),
            "newer".to_owned(),
            DraftState::Pending,
        ),
        (
            B.to_owned(),
            Some(ALIAS_Y.to_owned()),
            "Y's".to_owned(),
            DraftState::Pending,
        ),
        (
            B.to_owned(),
            None,
            "new start".to_owned(),
            DraftState::Pending,
        ),
        (
            C.to_owned(),
            Some(ALIAS_X.to_owned()),
            "C's".to_owned(),
            DraftState::Pending,
        ),
    ];
    want.sort_by(|a, b| (&a.0, &a.1, &a.2).cmp(&(&b.0, &b.1, &b.2)));
    assert_eq!(view, want);
    assert!(!records.iter().any(|r| r.id == older_x.id));
}

#[test]
fn records_older_than_seven_days_are_dropped() {
    let v = vault_fixture();
    v.drafts
        .add(B, &[conversation_draft(ALIAS_X, UNSENT)], None)
        .unwrap();
    v.advance(DAY);
    v.drafts
        .add(B, &[conversation_draft(ALIAS_Y, UNSENT)], None)
        .unwrap();
    v.advance(6 * DAY);
    // X is exactly seven days old: kept.
    assert_eq!(v.drafts.list().len(), 2);
    v.advance(1);
    let left: Vec<Option<String>> = v
        .drafts
        .list()
        .into_iter()
        .map(|r| r.target_alias)
        .collect();
    assert_eq!(left, [Some(ALIAS_Y.to_owned())]);
    // Dropped from the file too, not only from the answer.
    let on_disk: Value =
        serde_json::from_str(&unseal_text(&fs::read(&v.file).unwrap()).unwrap()).unwrap();
    assert_eq!(on_disk.as_array().unwrap().len(), 1);
    v.advance(DAY);
    assert!(v.drafts.list().is_empty());
    assert!(gone(&v.file));
}

#[test]
fn a_records_state_changes_and_the_record_goes_by_id() {
    let v = vault_fixture();
    v.drafts
        .add(
            B,
            &[
                conversation_draft(ALIAS_X, UNSENT),
                conversation_draft(ALIAS_Y, UNSENT),
            ],
            None,
        )
        .unwrap();
    let list = v.drafts.list();
    let (x, y) = (list[0].clone(), list[1].clone());
    v.drafts
        .update(
            &x.id,
            DraftPatch {
                state: Some(DraftState::NeedsCopy),
                reason: Some(Some("accessibility".into())),
            },
        )
        .unwrap();
    let first = v.reopen().list()[0].clone();
    assert_eq!(first.state, DraftState::NeedsCopy);
    assert_eq!(first.reason.as_deref(), Some("accessibility"));
    // The text and the rest are as they were.
    assert_eq!(
        DraftRecord {
            state: x.state,
            reason: None,
            ..first
        },
        DraftRecord {
            reason: None,
            ..x.clone()
        }
    );
    // A patch without a reason keeps it; one that clears it removes it.
    v.drafts
        .update(
            &x.id,
            DraftPatch {
                state: Some(DraftState::Pending),
                reason: None,
            },
        )
        .unwrap();
    assert_eq!(v.drafts.list()[0].reason.as_deref(), Some("accessibility"));
    v.drafts
        .update(
            &x.id,
            DraftPatch {
                state: Some(DraftState::NeedsCopy),
                reason: Some(None),
            },
        )
        .unwrap();
    assert_eq!(v.drafts.list()[0].reason, None);
    // An unknown id changes nothing.
    let before = fs::read(&v.file).unwrap();
    v.drafts
        .update(
            &uuid(),
            DraftPatch {
                state: Some(DraftState::NeedsCopy),
                reason: None,
            },
        )
        .unwrap();
    v.drafts.remove(&uuid()).unwrap();
    assert_eq!(fs::read(&v.file).unwrap(), before);
    v.drafts.remove(&x.id).unwrap();
    assert_eq!(
        v.drafts
            .list()
            .into_iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        [y.id.as_str()]
    );
    // The last one takes the file with it.
    v.drafts.remove(&y.id).unwrap();
    assert!(v.drafts.list().is_empty());
    assert!(gone(&v.file));
}

fn valid_record() -> Value {
    json!({
        "id": uuid(), "to": B, "targetAlias": ALIAS_X, "title": "", "text": UNSENT,
        "attachments": false, "capturedAt": NOW, "state": "pending",
    })
}

fn with(record: &Value, change: Value) -> Value {
    let mut out = record.clone();
    for (k, v) in change.as_object().unwrap() {
        if v.is_null() {
            out.as_object_mut().unwrap().remove(k);
        } else {
            out[k] = v.clone();
        }
    }
    out
}

fn record_of(value: &Value) -> DraftRecord {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn a_corrupt_vault_file_reads_as_empty() {
    let v = vault_fixture();
    fs::create_dir_all(v.file.parent().unwrap()).unwrap();
    let valid = valid_record();
    let contents: Vec<Vec<u8>> = vec![
        b"not sealed at all".to_vec(),
        sealed("not json"),
        sealed("null"),
        sealed("{\"records\":[]}"),
        sealed(&json!([with(&valid, json!({ "state": "sent" }))]).to_string()),
        sealed(&json!([with(&valid, json!({ "text": 7 }))]).to_string()),
        sealed(&json!([with(&valid, json!({ "capturedAt": "yesterday" }))]).to_string()),
        sealed(&json!([with(&valid, json!({ "targetAlias": null }))]).to_string()),
        sealed(&json!([with(&valid, json!({ "newSession": true }))]).to_string()),
    ];
    for content in contents {
        fs::write(&v.file, &content).unwrap();
        assert!(
            v.drafts.list().is_empty(),
            "{}",
            String::from_utf8_lossy(&content)
        );
    }
    // Only the records that are wrong are left out.
    fs::write(
        &v.file,
        sealed(&json!([valid, with(&valid, json!({ "id": "" })), "junk", null]).to_string()),
    )
    .unwrap();
    assert_eq!(v.drafts.list(), [record_of(&valid)]);
    // A corrupt file does not stop the next capture.
    fs::write(&v.file, "garbage").unwrap();
    v.drafts
        .add(B, &[conversation_draft(ALIAS_Y, UNSENT)], None)
        .unwrap();
    let left: Vec<Option<String>> = v
        .drafts
        .list()
        .into_iter()
        .map(|r| r.target_alias)
        .collect();
    assert_eq!(left, [Some(ALIAS_Y.to_owned())]);
}

#[derive(Default)]
struct Calls {
    errors: Vec<(String, String)>,
    rejected: Vec<usize>,
    listed: Vec<usize>,
}

/// A vault on `v`'s files that tells its diagnosis hooks' calls to `calls`.
fn watched_vault(v: &Vf, unseal_with: Unseal) -> (DraftVault, Arc<Mutex<Calls>>) {
    let calls: Arc<Mutex<Calls>> = Arc::default();
    let (e, r, l) = (calls.clone(), calls.clone(), calls.clone());
    let hooks = DraftVaultHooks {
        on_read_error: Some(Box::new(move |stage: DraftReadStage, message: &str| {
            e.lock()
                .unwrap()
                .errors
                .push((stage.as_str().into(), message.into()))
        })),
        on_record_rejected: Some(Box::new(move |index| {
            r.lock().unwrap().rejected.push(index)
        })),
        on_list: Some(Box::new(move |count| l.lock().unwrap().listed.push(count))),
    };
    // The fixtures' clock: records captured at NOW must not age out as the real date moves on.
    let drafts = DraftVault::new(&v.vault, seal(), unseal_with, Some(Arc::new(now_ms)), hooks);
    (drafts, calls)
}

fn pair(stage: &str, message: &str) -> (String, String) {
    (stage.into(), message.into())
}

#[test]
fn on_read_error_says_whether_the_file_could_not_be_unsealed_or_parsed_with_a_label_that_holds_no_text()
 {
    let v = vault_fixture();
    fs::create_dir_all(v.file.parent().unwrap()).unwrap();
    let (drafts, calls) = watched_vault(&v, unseal());
    // Unsealing fails.
    fs::write(&v.file, "not sealed at all").unwrap();
    assert!(drafts.list().is_empty());
    assert_eq!(
        calls.lock().unwrap().errors,
        [pair("unseal", "unseal-failed")]
    );
    // The same failure on the next read is not told again.
    drafts.list();
    assert_eq!(calls.lock().unwrap().errors.len(), 1);
    // Bad JSON. The parser's own message quotes the data, so a fixed label is told instead.
    fs::write(&v.file, sealed(&format!("not json, {UNSENT}"))).unwrap();
    drafts.list();
    assert_eq!(
        calls.lock().unwrap().errors.last(),
        Some(&pair("parse", "invalid-json"))
    );
    // Valid JSON that is not a list.
    fs::write(&v.file, sealed(&json!({ "text": UNSENT }).to_string())).unwrap();
    drafts.list();
    assert_eq!(
        calls.lock().unwrap().errors.last(),
        Some(&pair("parse", "not-an-array"))
    );
    fs::write(&v.file, sealed("null")).unwrap();
    drafts.list();
    assert_eq!(calls.lock().unwrap().errors.len(), 3);
    // A read that works starts it over: the same failure after it is told again.
    fs::write(&v.file, sealed(&json!([valid_record()]).to_string())).unwrap();
    assert_eq!(drafts.list().len(), 1);
    fs::write(&v.file, sealed("not json")).unwrap();
    drafts.list();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.errors.len(), 4);
    assert!(!format!("{:?}", calls.errors).contains(UNSENT));
}

#[test]
fn on_read_error_never_carries_the_message_of_an_unseal_that_throws_or_of_a_read_that_fails() {
    let v = vault_fixture();
    v.drafts
        .add(B, &[conversation_draft(ALIAS_X, UNSENT)], None)
        .unwrap();
    // An unseal whose message quotes what it was given.
    let (quoting, calls) = watched_vault(
        &v,
        Arc::new(|data: &[u8]| {
            Err(format!(
                "cannot unseal {} {UNSENT}",
                String::from_utf8_lossy(data)
            ))
        }),
    );
    quoting.list();
    assert_eq!(
        calls.lock().unwrap().errors,
        [pair("unseal", "unseal-failed")]
    );
    // Without system encryption the label says so.
    let (locked, calls) = watched_vault(
        &v,
        Arc::new(|_: &[u8]| Err("System encryption is unavailable.".into())),
    );
    locked.list();
    assert_eq!(
        calls.lock().unwrap().errors,
        [pair("unseal", "encryption-unavailable")]
    );
    // A file that cannot be read at all: the errno, never the message with its path. (The TS
    // injected EIO into fs.readFile; a mode-0 file fails with EACCES here.)
    #[cfg(unix)]
    if !root_user() {
        let (unreadable, calls) = watched_vault(&v, unseal());
        chmod(&v.file, 0);
        assert!(unreadable.list().is_empty());
        let removed = unreadable.remove("x");
        chmod(&v.file, 0o600);
        assert!(matches!(removed, Err(VaultError::Files(_))));
        assert_eq!(calls.lock().unwrap().errors, [pair("read", "EACCES")]);
    }
}

#[test]
fn on_record_rejected_is_told_the_index_of_each_entry_that_is_not_a_record_once_per_change() {
    let v = vault_fixture();
    fs::create_dir_all(v.file.parent().unwrap()).unwrap();
    let (drafts, calls) = watched_vault(&v, unseal());
    let valid = valid_record();
    fs::write(
        &v.file,
        sealed(
            &json!([
                valid,
                with(&valid, json!({ "id": "" })),
                "junk",
                with(&valid, json!({ "state": "sent" })),
                null
            ])
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(drafts.list(), [record_of(&valid)]);
    assert_eq!(calls.lock().unwrap().rejected, [1, 2, 3, 4]);
    // The next read of the same file says nothing more.
    drafts.list();
    assert_eq!(calls.lock().unwrap().rejected, [1, 2, 3, 4]);
    assert!(calls.lock().unwrap().errors.is_empty());
    // A file with every entry valid, and then a malformed one again, is told again.
    fs::write(&v.file, sealed(&json!([valid]).to_string())).unwrap();
    drafts.list();
    fs::write(&v.file, sealed(&json!([valid, 7]).to_string())).unwrap();
    drafts.list();
    assert_eq!(calls.lock().unwrap().rejected, [1, 2, 3, 4, 1]);
}

#[test]
fn on_list_is_told_the_count_only_when_it_differs_from_the_last_one_told() {
    let v = vault_fixture();
    let (drafts, calls) = watched_vault(&v, unseal());
    drafts.list();
    drafts.list();
    assert_eq!(calls.lock().unwrap().listed, [0]);
    drafts
        .add(B, &[conversation_draft(ALIAS_X, UNSENT)], None)
        .unwrap();
    drafts.list();
    drafts.list();
    assert_eq!(calls.lock().unwrap().listed, [0, 1]);
    drafts
        .add(B, &[conversation_draft(ALIAS_Y, UNSENT)], None)
        .unwrap();
    drafts.list();
    assert_eq!(calls.lock().unwrap().listed, [0, 1, 2]);
    let record = drafts.list()[0].clone();
    drafts.remove(&record.id).unwrap();
    drafts.list();
    assert_eq!(calls.lock().unwrap().listed, [0, 1, 2, 1]);
}

#[test]
fn a_hook_that_throws_never_disturbs_the_vault() {
    let v = vault_fixture();
    let hooks = DraftVaultHooks {
        on_read_error: Some(Box::new(|_, _| panic!("diagnosis failed"))),
        on_record_rejected: Some(Box::new(|_| panic!("diagnosis failed"))),
        on_list: Some(Box::new(|_| panic!("diagnosis failed"))),
    };
    let drafts = DraftVault::new(&v.vault, seal(), unseal(), None, hooks);
    drafts
        .add(B, &[conversation_draft(ALIAS_X, UNSENT)], None)
        .unwrap();
    assert_eq!(drafts.list().len(), 1);
    fs::write(&v.file, "garbage").unwrap();
    assert!(drafts.list().is_empty());
}

#[test]
#[cfg(unix)]
fn a_vault_file_that_cannot_be_read_is_never_overwritten() {
    if root_user() {
        return;
    }
    let v = vault_fixture();
    v.drafts
        .add(B, &[conversation_draft(ALIAS_X, UNSENT)], None)
        .unwrap();
    let before = fs::read(&v.file).unwrap();
    let record = v.drafts.list()[0].clone();
    // The read fails for a reason that says nothing about what the file holds.
    chmod(&v.file, 0);
    let add = v
        .drafts
        .add(B, &[conversation_draft(ALIAS_Y, UNSENT)], None);
    let update = v.drafts.update(
        &record.id,
        DraftPatch {
            state: Some(DraftState::NeedsCopy),
            reason: None,
        },
    );
    let remove = v.drafts.remove(&record.id);
    // A read for the panel or the restorer shows nothing and changes nothing.
    let listed = v.drafts.list();
    chmod(&v.file, 0o600);
    for result in [add, update, remove] {
        assert!(matches!(result, Err(VaultError::Files(_))));
    }
    assert!(listed.is_empty());
    assert_eq!(fs::read(&v.file).unwrap(), before);
    assert_eq!(v.drafts.list(), [record]);
}

#[test]
fn a_capture_that_read_a_slot_and_found_nothing_drops_the_stale_draft_there() {
    let v = vault_fixture();
    let ns = new_session(NEW_SESSION_TEXT, false);
    let alias = uuid();
    v.drafts
        .add(
            B,
            &[
                conversation_draft(ALIAS_X, UNSENT),
                conversation_draft(ALIAS_Y, UNSENT),
                conversation_draft(&alias, UNSENT),
                ns.clone(),
            ],
            None,
        )
        .unwrap();
    // The same slots for another account, which a capture for B never touches.
    v.drafts
        .add(C, &[conversation_draft(ALIAS_X, UNSENT), ns], None)
        .unwrap();
    // Y waits to be copied by hand: it is never re-typed, so it is not stale.
    let y = v
        .drafts
        .list()
        .into_iter()
        .find(|r| r.to == B && r.target_alias.as_deref() == Some(ALIAS_Y))
        .unwrap();
    v.drafts
        .update(
            &y.id,
            DraftPatch {
                state: Some(DraftState::NeedsCopy),
                reason: Some(Some("lost".into())),
            },
        )
        .unwrap();
    v.advance(1000);
    let slots = |records: Vec<DraftRecord>| {
        let mut out: Vec<String> = records
            .iter()
            .map(|r| {
                format!(
                    "{}/{}",
                    if r.to == B { "B" } else { "C" },
                    r.target_alias.as_deref().unwrap_or("new")
                )
            })
            .collect();
        out.sort();
        out
    };
    let sorted = |list: Vec<String>| {
        let mut list = list;
        list.sort();
        list
    };
    // A conversation the capture read and A had no draft in.
    v.drafts
        .add(
            B,
            &[],
            Some(&DraftSlots {
                aliases: vec![ALIAS_X.into(), ALIAS_Y.into()],
                new_session: false,
            }),
        )
        .unwrap();
    assert_eq!(
        slots(v.drafts.list()),
        sorted(vec![
            format!("B/{ALIAS_Y}"),
            format!("B/{alias}"),
            "B/new".into(),
            format!("C/{ALIAS_X}"),
            "C/new".into()
        ])
    );
    // The new-session screen, read and found empty.
    v.drafts
        .add(
            B,
            &[conversation_draft(&alias, "newer")],
            Some(&DraftSlots {
                aliases: vec![alias.clone()],
                new_session: true,
            }),
        )
        .unwrap();
    let records = v.drafts.list();
    assert_eq!(
        slots(records.clone()),
        sorted(vec![
            format!("B/{ALIAS_Y}"),
            format!("B/{alias}"),
            format!("C/{ALIAS_X}"),
            "C/new".into()
        ])
    );
    assert_eq!(
        records
            .iter()
            .find(|r| r.to == B && r.target_alias.as_deref() == Some(alias.as_str()))
            .unwrap()
            .text,
        "newer"
    );
    // A capture that read nothing (no slots given) drops nothing.
    let file = fs::read(&v.file).unwrap();
    v.drafts.add(B, &[], None).unwrap();
    assert_eq!(fs::read(&v.file).unwrap(), file);
}

#[test]
fn vault_changes_made_at_the_same_time_all_land() {
    let v = vault_fixture();
    std::thread::scope(|scope| {
        for (to, alias) in [(B, ALIAS_X), (B, ALIAS_Y), (C, ALIAS_X)] {
            let drafts = &v.drafts;
            scope.spawn(move || {
                drafts
                    .add(to, &[conversation_draft(alias, UNSENT)], None)
                    .unwrap()
            });
        }
    });
    assert_eq!(v.drafts.list().len(), 3);
}

// --- What a read may answer -------------------------------------------------------------------

#[test]
fn a_written_failure_is_passed_on() {
    assert_eq!(
        checked_result(failed("verification failed")),
        failed("verification failed")
    );
}

#[test]
fn a_missing_or_invalid_result_is_no_result() {
    // A failure without a reason, and drafts that are not all `composer-draft:` keys. (Shapes the
    // JSON result file could have that a typed result cannot are left out.)
    assert_eq!(checked_result(failed("")), failed("no result"));
    for drafts in [
        map(&[("other:a", "x")]),
        map(&[("", "x")]),
        map(&[("__proto__", "x")]),
        map(&[("composer-draft:a", "x"), ("other:b", "y")]),
    ] {
        assert_eq!(
            checked_result(ok(drafts.clone())),
            failed("no result"),
            "{drafts:?}"
        );
    }
}

#[test]
fn no_drafts_is_a_valid_answer() {
    assert_eq!(checked_result(ok(JsMap::new())), ok(JsMap::new()));
}

#[test]
fn an_answer_is_limited_to_500_drafts_and_4_mib() {
    let answer = |drafts: JsMap<String>| checked_result(ok(drafts));
    let keys = |count: usize| -> JsMap<String> {
        (0..count)
            .map(|i| (format!("composer-draft:{i}"), "t".to_owned()))
            .collect()
    };
    assert!(matches!(answer(keys(500)), DraftResult::Ok { .. }));
    assert_eq!(answer(keys(501)), failed("no result"));
    // Keys count as well as values: the limit is on the total length.
    let k = "composer-draft:a";
    let limit = 4 * 1024 * 1024;
    let fits = map(&[(k, &"x".repeat(limit - k.len()))]);
    assert_eq!(answer(fits.clone()), ok(fits));
    assert_eq!(
        answer(map(&[(k, &"x".repeat(limit - k.len() + 1))])),
        failed("no result")
    );
    // Several drafts add up.
    let half = "x".repeat(limit / 2 - 16);
    assert!(matches!(
        answer(map(&[
            ("composer-draft:a", &half),
            ("composer-draft:b", &half)
        ])),
        DraftResult::Ok { .. }
    ));
    assert_eq!(
        answer(map(&[
            ("composer-draft:a", &half),
            ("composer-draft:b", &format!("{half}x"))
        ])),
        failed("no result")
    );
}

// --- Whether drafts can move on this machine ------------------------------------------------

#[test]
fn drafts_move_on_macos_and_linux() {
    assert_eq!(
        drafts_blocked_reason("win32"),
        Some("drafts move only on macOS and Linux")
    );
    for platform in ["darwin", "linux"] {
        assert_eq!(drafts_blocked_reason(platform), None, "{platform}");
    }
}
