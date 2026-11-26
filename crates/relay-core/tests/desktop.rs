//! Port of tests/desktop.test.ts.
//!
//! Skipped: "50 profiles and 64-character company groups persist…" (Store's), "a host that cannot
//! read Claude's Electron version captures nothing" (the Electron version gate is gone with the
//! in-process draft reader, plan Phase 4). Where the TS replaces `fs.rm`/`fs.rename` to inject a
//! failure, the Rust tests inject it through the switch's own guards (`can_proceed`, the host's
//! process check) at the same write.

#[path = "common/desktop.rs"]
mod helpers;

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use helpers::{FakeHost, Fixture, Sealing, scope_dir, session, test_seal, uuid};
use relay_core::desktop::{
    DESKTOP_CACHE_MS, DesktopError, DesktopHost, DesktopManager, DesktopResult,
    DesktopSwitchOptions, LaunchChoice, LaunchOptions, OperationLock, PAGE_BOOT_MS,
};
use relay_core::desktop_files::{
    DesktopFileError, HistoryPlanOptions, duplicate_sessions, json_bytes, plan_history,
    plan_permission_preferences, read_bytes, read_object, safe_file, write_bytes,
};
use relay_core::desktop_launch::{LaunchWatch, PageOutcome};
use relay_core::draft_transfer::DraftResult;
use relay_core::drafts::{CONVERSATION_DRAFT_PREFIX, NEW_SESSION_DRAFT};
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{
    Account, AccountAuth, DesktopHistoryTransfer, DesktopOperationKind, DesktopRestartEvent,
};
use relay_core::store::{Store, StoreOptions};
use serde_json::{Map, Value, json};

type Events = Arc<Mutex<Vec<(String, Option<Map<String, Value>>)>>>;

fn err_contains<T: std::fmt::Debug>(result: DesktopResult<T>, needle: &str) -> DesktopError {
    let error = result.expect_err("an error");
    assert!(
        error.message().contains(needle),
        "{:?} does not contain {needle:?}",
        error.message()
    );
    error
}

fn obj(root: &Path, relative: &str) -> Option<Map<String, Value>> {
    read_object(root, relative).unwrap()
}

fn text(root: &Path, relative: &str) -> String {
    fs::read_to_string(root.join(relative)).unwrap()
}

fn desktop(a: &Account) -> &relay_core::shared::types::AccountDesktop {
    a.desktop.as_ref().unwrap()
}

fn refuse() -> DesktopSwitchOptions {
    DesktopSwitchOptions {
        can_proceed: Some(Arc::new(|| false)),
        ..DesktopSwitchOptions::default()
    }
}

fn closed(expected: &str) -> DesktopSwitchOptions {
    DesktopSwitchOptions {
        closed_only: true,
        expected_active_profile_id: Some(expected.to_string()),
        ..DesktopSwitchOptions::default()
    }
}

fn record_events(f: &Fixture) -> Events {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    f.manager.configure(|h| {
        h.on_draft_event = Some(Arc::new(
            move |event: &str, fields: Option<&Map<String, Value>>| {
                sink.lock()
                    .unwrap()
                    .push((event.to_string(), fields.cloned()));
            },
        ))
    });
    events
}

fn record_restarts(f: &Fixture) -> Arc<Mutex<Vec<DesktopRestartEvent>>> {
    let restarts = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&restarts);
    f.manager.configure(|h| {
        h.on_restart = Some(Arc::new(move |e| sink.lock().unwrap().push(e.clone())))
    });
    restarts
}

fn restart(
    start: bool,
    kind: DesktopOperationKind,
    profile: Option<&str>,
    ok: bool,
) -> DesktopRestartEvent {
    let profile_id = profile.map(str::to_string);
    if start {
        DesktopRestartEvent::Start { kind, profile_id }
    } else {
        DesktopRestartEvent::End {
            kind,
            profile_id,
            ok,
        }
    }
}

#[test]
fn claudes_uptime_comes_from_the_host_and_is_unknown_without_one() {
    let f = Fixture::new();
    assert_eq!(f.manager.claude_uptime_ms(), None);
    f.host.st().uptime = Some(21_000);
    assert_eq!(f.manager.claude_uptime_ms(), Some(21_000));
    f.host.st().uptime = None;
    assert_eq!(f.manager.claude_uptime_ms(), None);
}

#[test]
fn every_switch_tells_on_switched_once_it_ends_after_desktop_is_free_even_when_it_fails() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None); // B is open in Claude
    let busy_when_told = Arc::new(Mutex::new(Vec::new()));
    let (sink, manager) = (Arc::clone(&busy_when_told), Arc::downgrade(&f.manager));
    f.manager.configure(|h| {
        h.on_switched = Some(Arc::new(move || {
            sink.lock()
                .unwrap()
                .push(manager.upgrade().unwrap().is_busy())
        }))
    });
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(*busy_when_told.lock().unwrap(), vec![false]);
    f.set_running(false);
    f.manager.switch_to(&b.id, closed(&a.id)).unwrap();
    assert_eq!(*busy_when_told.lock().unwrap(), vec![false, false]);
    f.set_running(true);
    err_contains(
        f.manager.switch_to(&a.id, refuse()),
        "cancelled before restart",
    );
    assert_eq!(*busy_when_told.lock().unwrap(), vec![false, false, false]);
    // A listener that panics never changes how a switch ends.
    f.manager
        .configure(|h| h.on_switched = Some(Arc::new(|| panic!("listener"))));
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    err_contains(
        f.manager.switch_to(&b.id, refuse()),
        "cancelled before restart",
    );
}

#[test]
fn a_changed_continuation_guard_blocks_restart_before_claude_is_asked_to_quit() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.set_running(true);
    let quits = f.quits();
    let error = err_contains(
        f.manager.switch_to(&b.id, refuse()),
        "cancelled before restart",
    );
    assert!(matches!(error, DesktopError::SwitchRefused(_)));
    // A `before_quit` refusal reaches the caller as it was raised.
    let error = f
        .manager
        .switch_to(
            &b.id,
            DesktopSwitchOptions {
                can_proceed: Some(Arc::new(|| true)),
                before_quit: Some(Arc::new(|| {
                    Err(DesktopError::SwitchRefused("work-started".into()))
                })),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(error, DesktopError::SwitchRefused("work-started".into()));
    assert_eq!(f.quits(), quits);
    let state = f.manager.snapshot().unwrap();
    assert_eq!(state.active_profile_id.as_deref(), Some(a.id.as_str()));
    assert!(state.running);
    // A guard that refuses only after the quit is an ordinary failure, not a refusal.
    let checks = Arc::new(AtomicU32::new(0));
    let counter = Arc::clone(&checks);
    let error = err_contains(
        f.manager.switch_to(
            &b.id,
            DesktopSwitchOptions {
                can_proceed: Some(Arc::new(move || counter.fetch_add(1, Ordering::SeqCst) < 2)),
                ..Default::default()
            },
        ),
        "conditions changed",
    );
    assert!(!matches!(error, DesktopError::SwitchRefused(_)));
    assert_eq!(f.quits(), quits + 1);
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
}

#[test]
fn a_switch_hands_its_answer_for_claudes_quit_question_to_the_quit_and_only_a_switch_given_one() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.set_running(true);
    f.manager
        .switch_to(
            &b.id,
            DesktopSwitchOptions {
                answer_quit_guard: Some(Arc::new(|| Ok(true))),
                ..Default::default()
            },
        )
        .unwrap();
    f.set_running(true);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    let answers = f.host.st().quit_answers.clone();
    assert_eq!(answers[answers.len() - 2..], [Some(true), None]);
}

#[test]
fn only_desktops_own_refusal_shows_as_its_error_a_before_quit_refusal_is_the_callers_to_tell() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.set_running(true);
    let quits = f.quits();
    assert!(matches!(
        f.manager.switch_to(&b.id, refuse()),
        Err(DesktopError::SwitchRefused(_))
    ));
    assert_eq!(
        f.manager.snapshot().unwrap().error.as_deref(),
        Some("Automatic Desktop switch was cancelled before restart.")
    );
    let refused = |error: DesktopError| DesktopSwitchOptions {
        can_proceed: Some(Arc::new(|| true)),
        before_quit: Some(Arc::new(move || Err(error.clone()))),
        ..Default::default()
    };
    assert!(matches!(
        f.manager.switch_to(
            &b.id,
            refused(DesktopError::SwitchRefused("work-started".into()))
        ),
        Err(DesktopError::SwitchRefused(_))
    ));
    assert_eq!(f.manager.snapshot().unwrap().error, None);
    let error = f
        .manager
        .switch_to(
            &b.id,
            refused(DesktopError::new("The process list could not be read.")),
        )
        .unwrap_err();
    assert!(!matches!(error, DesktopError::SwitchRefused(_)));
    assert_eq!(
        f.manager.snapshot().unwrap().error.as_deref(),
        Some("The process list could not be read.")
    );
    assert_eq!(f.quits(), quits);
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
}

#[test]
fn real_desktop_file_switch_a_b_a_preserves_config_cookies_history_and_refreshes_saved_credentials()
{
    let f = Fixture::new();
    let a = f.account("A", None);
    let (id, relative) = session(&f.root, &a, None, json!({}));
    let b = f.account("B", None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        obj(&f.root, "config.json").unwrap()["lastKnownAccountUuid"],
        json!(desktop(&a).account_uuid)
    );
    assert_eq!(text(&f.root, "Cookies"), "cookie-A");
    let mut config = obj(&f.root, "config.json").unwrap();
    config.insert("oauth:tokenCacheV2".into(), json!("refreshed-A"));
    write_bytes(&f.root, "config.json", Some(&json_bytes(&config))).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(text(&f.root, "Cookies"), "cookie-B");
    let transferred = obj(
        &f.root,
        &format!("{}/local_{id}.json", scope_dir("claude-code-sessions", &b)),
    )
    .unwrap();
    assert_eq!(transferred["permissionMode"], json!("default"));
    assert_eq!(transferred["remoteMcpServersConfig"], json!([]));
    assert_eq!(
        obj(&f.root, &relative).unwrap()["permissionMode"],
        json!("bypassPermissions")
    );
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    let config = obj(&f.root, "config.json").unwrap();
    assert_eq!(config["oauth:tokenCacheV2"], json!("refreshed-A"));
    assert_eq!(config["preference"], json!("preserved"));
    assert!(f.manager.snapshot().unwrap().last_backup.is_some());
}

#[test]
fn desktop_sign_in_is_idempotent_cancelling_restores_previous_account_even_after_a_new_sign_in() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.create("B", None);
    f.manager.begin_login(&b.id).unwrap();
    f.manager.begin_login(&b.id).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().pending_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    err_contains(
        f.manager.capture(&a.id, &desktop(&a).org_id),
        "Finish or cancel",
    );
    assert_eq!(
        obj(&f.root, "config.json")
            .unwrap()
            .get("lastKnownAccountUuid"),
        None
    );
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "Finish or cancel",
    );
    write_bytes(
        &f.root,
        "config.json",
        Some(&json_bytes(
            &json!({ "oauth:tokenCacheV2": "new-encrypted", "lastKnownAccountUuid": uuid() }),
        )),
    )
    .unwrap();
    f.manager.cancel_login().unwrap();
    let state = f.manager.snapshot().unwrap();
    assert_eq!(state.active_profile_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(state.pending_profile_id, None);
}

fn set_transfer(f: &Fixture, mode: DesktopHistoryTransfer, accounts: Option<Vec<String>>) {
    f.store
        .update(|s| {
            s.settings.desktop_history_transfer = mode;
            if let Some(accounts) = accounts {
                s.settings.desktop_history_accounts = accounts;
            }
        })
        .unwrap();
}

#[test]
fn work_histories_cross_only_the_selected_sharing_group_tombstones_prevent_resurrection() {
    let f = Fixture::new();
    set_transfer(&f, DesktopHistoryTransfer::SameGroup, None);
    let a = f.account("A", Some("team"));
    let b = f.account("B", Some("team"));
    let c = f.account("C", Some("other"));
    let (id, _) = session(&f.root, &a, None, json!({}));
    f.manager.switch_to(&c.id, Default::default()).unwrap();
    assert_eq!(
        obj(
            &f.root,
            &format!("{}/local_{id}.json", scope_dir("claude-code-sessions", &c))
        ),
        None
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    let dest = scope_dir("claude-code-sessions", &b);
    assert!(obj(&f.root, &format!("{dest}/local_{id}.json")).is_some());
    fs::remove_file(f.root.join(format!("{dest}/local_{id}.json"))).unwrap();
    write_bytes(&f.root, &format!("{dest}/deleted_{id}"), Some(b"")).unwrap();
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(obj(&f.root, &format!("{dest}/local_{id}.json")), None);
}

#[test]
fn unknown_account_and_live_process_guards_leave_desktop_sign_in_untouched() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let cfg = json!({ "oauth:tokenCacheV2": "unknown", "lastKnownAccountUuid": uuid() });
    write_bytes(&f.root, "config.json", Some(&json_bytes(&cfg))).unwrap();
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "Save the current",
    );
    assert_eq!(Value::Object(obj(&f.root, "config.json").unwrap()), cfg);
    let mut known = cfg.clone();
    known["lastKnownAccountUuid"] = json!(desktop(&a).account_uuid);
    write_bytes(&f.root, "config.json", Some(&json_bytes(&known))).unwrap();
    let before = obj(&f.root, "config.json");
    f.set_fail_quit();
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "still running",
    );
    assert_eq!(obj(&f.root, "config.json"), before);
}

#[test]
fn failed_multi_file_switch_rolls_back_and_crash_journal_offers_recovery() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let before = fs::read(f.root.join("config.json")).unwrap();
    // A one-time failure after config.json is replaced, while the cookie files are written: the
    // guards before the quit, before the backup and before config.json pass; the next fails.
    let checks = Arc::new(AtomicU32::new(0));
    let counter = Arc::clone(&checks);
    err_contains(
        f.manager.switch_to(
            &a.id,
            DesktopSwitchOptions {
                can_proceed: Some(Arc::new(move || counter.fetch_add(1, Ordering::SeqCst) < 4)),
                ..Default::default()
            },
        ),
        "conditions changed",
    );
    assert_eq!(fs::read(f.root.join("config.json")).unwrap(), before);
    assert!(!f.manager.snapshot().unwrap().recovery_required);
    assert_eq!(text(&f.root, "Cookies"), "cookie-B");
    let backup = uuid();
    let sealed = test_seal(
        &json!({
            "files": { "config.json": base64_of(&before) },
            "createdAt": "2026-11-26T00:00:00.000Z",
        })
        .to_string(),
    );
    write_bytes(&f.vault(), &format!("backups/{backup}.bin"), Some(&sealed)).unwrap();
    write_bytes(
        &f.vault(),
        "journal.json",
        Some(&json_bytes(&json!({ "backup": backup }))),
    )
    .unwrap();
    write_bytes(
        &f.root,
        "config.json",
        Some(&json_bytes(&json!({ "broken": true }))),
    )
    .unwrap();
    assert!(f.manager.snapshot().unwrap().recovery_required);
    err_contains(f.manager.switch_to(&b.id, Default::default()), "Restore");
    let restarts = record_restarts(&f);
    f.manager.recover().unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(
        *restarts.lock().unwrap(),
        vec![
            restart(true, DesktopOperationKind::Restore, None, false),
            restart(false, DesktopOperationKind::Restore, None, true),
        ]
    );
}

fn base64_of(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn scope(a: &Account) -> relay_core::desktop_files::Scope {
    relay_core::desktop_files::Scope {
        account_uuid: desktop(a).account_uuid.clone(),
        org_id: desktop(a).org_id.clone(),
    }
}

fn plan(root: &Path, target: &Account, sources: &[&Account]) -> relay_core::desktop_files::Writes {
    plan_history(
        root,
        &scope(target),
        &sources.iter().map(|a| scope(a)).collect::<Vec<_>>(),
        &HistoryPlanOptions::default(),
    )
    .unwrap()
}

fn planned(plan: &relay_core::desktop_files::Writes, path: &str) -> Value {
    serde_json::from_slice(plan.get(path).unwrap().as_ref().unwrap()).unwrap()
}

#[test]
fn project_merge_preserves_target_organization_bindings_and_rejects_symlink_paths() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let src = format!("{}/spaces.json", scope_dir("local-agent-mode-sessions", &a));
    write_bytes(
        &f.root,
        &src,
        Some(&json_bytes(&json!({
            "spaces": [{
                "id": "one", "name": "Work", "folders": [f.root.to_string_lossy()],
                "projects": ["private-remote"], "migration": { "org": "private" },
            }],
        }))),
    )
    .unwrap();
    let writes = plan(&f.root, &b, &[&a]);
    let copied: Value =
        serde_json::from_slice(writes.values().next().unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(copied["spaces"][0].get("projects"), None);
    assert_eq!(copied["spaces"][0].get("migration"), None);
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.base(), f.root.join("escape")).unwrap();
    // A junction, as the TS makes on Windows: no symbolic-link privilege needed.
    #[cfg(windows)]
    assert!(
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(f.root.join("escape"))
            .arg(f.base())
            .status()
            .unwrap()
            .success()
    );
    assert!(matches!(
        safe_file(&f.root, "escape/file"),
        Err(DesktopFileError::SymbolicLink)
    ));
    assert!(matches!(
        safe_file(&f.root, "../outside"),
        Err(DesktopFileError::InvalidPath)
    ));
}

#[test]
fn reconnecting_an_existing_desktop_profile_keeps_its_identity_and_refuses_a_different_account() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.manager.begin_login(&a.id).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().pending_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    write_bytes(
        &f.root,
        "config.json",
        Some(&json_bytes(&json!({ "oauth:tokenCacheV2": "refreshed", "lastKnownAccountUuid": desktop(&a).account_uuid }))),
    )
    .unwrap();
    f.manager.capture(&a.id, &desktop(&a).org_id).unwrap();
    assert_eq!(f.manager.snapshot().unwrap().pending_profile_id, None);
    f.manager.begin_login(&a.id).unwrap();
    let other = uuid();
    write_bytes(
        &f.root,
        "config.json",
        Some(&json_bytes(
            &json!({ "oauth:tokenCacheV2": "other", "lastKnownAccountUuid": other }),
        )),
    )
    .unwrap();
    fs::create_dir_all(
        f.root
            .join("claude-code-sessions")
            .join(&other)
            .join(&desktop(&a).org_id),
    )
    .unwrap();
    err_contains(
        f.manager.capture(&a.id, &desktop(&a).org_id),
        "another Desktop account",
    );
    f.manager.cancel_login().unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
}

#[test]
fn an_unreadable_history_record_is_skipped_and_left_untouched_instead_of_blocking_every_switch() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let id = uuid();
    let broken = format!("{}/local_{id}.json", scope_dir("claude-code-sessions", &a));
    write_bytes(&f.root, &broken, Some(b"{incomplete")).unwrap();
    let (good, _) = session(&f.root, &a, None, json!({}));
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(text(&f.root, &broken), "{incomplete");
    let dest = scope_dir("claude-code-sessions", &b);
    assert_eq!(obj(&f.root, &format!("{dest}/local_{id}.json")), None);
    assert!(obj(&f.root, &format!("{dest}/local_{good}.json")).is_some());
}

#[test]
fn dismissed_desktop_errors_stay_dismissed_across_polls_a_new_attempt_remains_visible() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.set_fail_quit();
    err_contains(f.manager.begin_login(&a.id), "still running");
    let first = f.manager.snapshot().unwrap();
    assert_eq!(first.error.as_deref(), Some("still running"));
    f.manager.dismiss_error(first.error_revision as i64);
    for _ in 0..3 {
        assert_eq!(f.manager.snapshot().unwrap().error, None);
    }
    err_contains(f.manager.begin_login(&a.id), "still running");
    let second = f.manager.snapshot().unwrap();
    assert_eq!(second.error.as_deref(), Some("still running"));
    assert!(second.error_revision > first.error_revision);
    f.manager.dismiss_error(first.error_revision as i64);
    assert_eq!(
        f.manager.snapshot().unwrap().error.as_deref(),
        Some("still running")
    );
    f.manager.dismiss_error(second.error_revision as i64);
    assert_eq!(f.manager.snapshot().unwrap().error, None);
}

#[test]
fn repeated_capture_of_an_already_connected_profile_does_not_restart_claude_or_rewrite_its_vault() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let file = f
        .vault()
        .join("accounts")
        .join(format!("{}.bin", desktop(&a).account_uuid));
    let before = fs::read(&file).unwrap();
    let starts = f.starts();
    f.set_fail_quit();
    f.manager.capture(&a.id, &desktop(&a).org_id).unwrap();
    assert_eq!(f.starts(), starts);
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(f.manager.snapshot().unwrap().error, None);
}

fn auth(account_uuid: &str, org_id: &str, email: Option<&str>) -> AccountAuth {
    AccountAuth {
        logged_in: true,
        email: email.map(str::to_string),
        account_uuid: Some(account_uuid.to_string()),
        org_id: Some(org_id.to_string()),
        org_name: None,
        subscription: None,
        plan: None,
        checked_at: "2026-11-26T00:00:00.000Z".into(),
        error: None,
    }
}

fn set_auth(f: &Fixture, id: &str, value: AccountAuth) {
    f.store
        .update(|s| {
            s.accounts.iter_mut().find(|x| x.id == id).unwrap().auth = Some(value);
        })
        .unwrap();
}

#[test]
fn known_cli_account_and_organization_mismatches_block_capture_before_claude_quits() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.create("B", None);
    let before = fs::read(f.root.join("config.json")).unwrap();
    let (quits, starts) = (f.quits(), f.starts());
    set_auth(
        &f,
        &b.id,
        auth(&uuid(), &desktop(&a).org_id, Some("same@example.test")),
    );
    err_contains(
        f.manager.capture(&b.id, &desktop(&a).org_id),
        "different Claude account",
    );
    set_auth(
        &f,
        &b.id,
        auth(
            &desktop(&a).account_uuid,
            &uuid(),
            Some("same@example.test"),
        ),
    );
    err_contains(
        f.manager.capture(&b.id, &desktop(&a).org_id),
        "different Claude organization",
    );
    assert_eq!(f.quits(), quits);
    assert_eq!(f.starts(), starts);
    assert_eq!(fs::read(f.root.join("config.json")).unwrap(), before);
    assert_eq!(f.store.account(&b.id).unwrap().desktop, None);
}

#[test]
fn wrong_cli_reconnect_identity_cannot_replace_or_switch_a_saved_desktop_association() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let before = fs::read(f.root.join("config.json")).unwrap();
    let quits = f.quits();
    set_auth(
        &f,
        &a.id,
        auth(&uuid(), &desktop(&a).org_id, Some("different@example.test")),
    );
    err_contains(f.manager.begin_login(&a.id), "different Claude account");
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "different Claude account",
    );
    assert_eq!(f.quits(), quits);
    assert_eq!(f.store.account(&a.id).unwrap().desktop, a.desktop);
    assert_eq!(fs::read(f.root.join("config.json")).unwrap(), before);
    assert_eq!(f.manager.snapshot().unwrap().pending_profile_id, None);
}

#[test]
fn matching_verified_cli_identity_supplies_a_readable_email_to_a_saved_desktop_profile() {
    let f = Fixture::new();
    let a = f.account("A", None);
    set_auth(
        &f,
        &a.id,
        auth(
            &desktop(&a).account_uuid,
            &desktop(&a).org_id,
            Some("matched@example.test"),
        ),
    );
    f.manager.begin_login(&a.id).unwrap();
    write_bytes(
        &f.root,
        "config.json",
        Some(&json_bytes(&json!({ "oauth:tokenCacheV2": "refreshed-fixture", "lastKnownAccountUuid": desktop(&a).account_uuid }))),
    )
    .unwrap();
    f.manager.capture(&a.id, &desktop(&a).org_id).unwrap();
    assert_eq!(
        f.store
            .account(&a.id)
            .unwrap()
            .desktop
            .unwrap()
            .email
            .as_deref(),
        Some("matched@example.test")
    );
    let reopened = Store::open(f.store.root(), StoreOptions::default()).unwrap();
    assert_eq!(
        reopened
            .account(&a.id)
            .unwrap()
            .desktop
            .unwrap()
            .email
            .as_deref(),
        Some("matched@example.test")
    );
}

/// Makes the host's availability check wait until the returned release is called.
fn hold_available(f: &Fixture) -> impl FnOnce() {
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let wait = Mutex::new(Some(wait));
    FakeHost::set(
        &f.host.available,
        Arc::new(move || {
            if let Some(wait) = wait.lock().unwrap().take() {
                let _ = wait.recv();
            }
            true
        }),
    );
    move || {
        let _ = release.send(());
    }
}

fn wait_busy(manager: &DesktopManager) {
    while !manager.is_busy() {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

#[test]
fn desktop_operations_acquire_their_lock_before_availability_checks_yield() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.create("B", None);
    let release = hold_available(&f);
    let manager = Arc::clone(&f.manager);
    let id = b.id.clone();
    let first = std::thread::spawn(move || manager.begin_login(&id));
    wait_busy(&f.manager);
    err_contains(
        f.manager.capture(&a.id, &desktop(&a).org_id),
        "operation is already in progress",
    );
    release();
    first.join().unwrap().unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().pending_profile_id.as_deref(),
        Some(b.id.as_str())
    );
}

#[test]
fn every_desktop_operation_that_marks_desktop_busy_is_counted_failed_ones_too() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let start = f.manager.operations();
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(f.manager.operations(), start + 1);
    assert!(f.manager.switch_to(&b.id, refuse()).is_err());
    assert_eq!(f.manager.operations(), start + 2);
    let release = hold_available(&f);
    let manager = Arc::clone(&f.manager);
    let id = b.id.clone();
    let first = std::thread::spawn(move || manager.switch_to(&id, Default::default()));
    wait_busy(&f.manager);
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "operation is already in progress",
    );
    release();
    first.join().unwrap().unwrap();
    assert_eq!(f.manager.operations(), start + 3);
}

#[test]
fn an_unknown_current_desktop_account_is_rejected_before_any_restart() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.create("B", None);
    write_bytes(
        &f.root,
        "config.json",
        Some(&json_bytes(
            &json!({ "oauth:tokenCacheV2": "unknown-fixture", "lastKnownAccountUuid": uuid() }),
        )),
    )
    .unwrap();
    let quits = f.quits();
    err_contains(
        f.manager.begin_login(&b.id),
        "Save the current Desktop account",
    );
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "Save the current Desktop account",
    );
    assert_eq!(f.quits(), quits);
}

#[test]
fn desktop_does_not_report_a_profile_active_when_its_saved_code_organization_is_missing() {
    let f = Fixture::new();
    let a = f.account("A", None);
    fs::remove_dir_all(f.root.join(scope_dir("claude-code-sessions", &a))).unwrap();
    let snapshot = f.manager.snapshot().unwrap();
    assert_eq!(
        snapshot.current_account_uuid.as_deref(),
        Some(desktop(&a).account_uuid.as_str())
    );
    assert_eq!(snapshot.active_profile_id, None);
}

#[test]
fn dismissal_does_not_clear_recovery_requirements_or_repeatedly_report_the_same_unreadable_data() {
    let f = Fixture::new();
    write_bytes(&f.root, "config.json", Some(b"invalid JSON")).unwrap();
    let first = f.manager.snapshot().unwrap();
    assert!(first.error.is_some());
    f.manager.dismiss_error(first.error_revision as i64);
    assert_eq!(f.manager.snapshot().unwrap().error, None);
    write_bytes(&f.root, "config.json", Some(&json_bytes(&json!({})))).unwrap();
    f.manager.snapshot().unwrap();
    write_bytes(&f.root, "config.json", Some(b"invalid JSON")).unwrap();
    assert!(f.manager.snapshot().unwrap().error.is_some());
    write_bytes(
        &f.vault(),
        "journal.json",
        Some(&json_bytes(&json!({ "backup": uuid() }))),
    )
    .unwrap();
    let recovery = f.manager.snapshot().unwrap();
    f.manager.dismiss_error(recovery.error_revision as i64);
    assert!(f.manager.snapshot().unwrap().recovery_required);
}

#[test]
fn history_transfer_off_leaves_each_accounts_session_index_intact_on_capture_and_switch() {
    let f = Fixture::new();
    set_transfer(&f, DesktopHistoryTransfer::Off, None);
    let a = f.account("A", None);
    let (sa, sa_rel) = session(&f.root, &a, None, json!({}));
    let b = f.account("B", None);
    let (_, sb_rel) = session(&f.root, &b, None, json!({}));
    let a_before = fs::read(f.root.join(&sa_rel)).unwrap();
    let b_before = fs::read(f.root.join(&sb_rel)).unwrap();
    let b_copy = format!("{}/local_{sa}.json", scope_dir("claude-code-sessions", &b));
    assert_eq!(obj(&f.root, &b_copy), None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(obj(&f.root, &b_copy), None);
    assert_eq!(fs::read(f.root.join(&sa_rel)).unwrap(), a_before);
    assert_eq!(fs::read(f.root.join(&sb_rel)).unwrap(), b_before);
    set_transfer(&f, DesktopHistoryTransfer::SameGroup, None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert!(obj(&f.root, &b_copy).is_some());
    set_transfer(&f, DesktopHistoryTransfer::Off, None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert!(
        obj(&f.root, &b_copy).is_some(),
        "disabling transfer must not delete previously merged history"
    );
}

fn slug(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[test]
fn explicitly_selected_accounts_share_code_history_across_organizations_while_unselected_histories_and_transcripts_stay_untouched()
 {
    let f = Fixture::new();
    set_transfer(&f, DesktopHistoryTransfer::Off, None);
    let personal = f.account("Personal", None);
    let work = f.account("Work", Some("company-one"));
    let other_work = f.account("Other work", Some("company-two"));
    let excluded = f.account("Excluded", Some("company-three"));
    let cwd = f.base().join("shared_project");
    let prior = uuid();
    let cwd_text = cwd.to_string_lossy().to_string();
    let (p, p_rel) = session(
        &f.root,
        &personal,
        None,
        json!({ "cwd": cwd_text, "originCwd": cwd_text, "priorCliSessionIds": [prior], "archived": true }),
    );
    let (w, _) = session(&f.root, &work, None, json!({ "cwd": cwd_text }));
    let (o, _) = session(&f.root, &other_work, None, json!({ "cwd": cwd_text }));
    let (x, _) = session(&f.root, &excluded, None, json!({ "cwd": cwd_text }));
    let source_before = fs::read(f.root.join(&p_rel)).unwrap();
    let transcript = format!("projects/{}/{p}.jsonl", slug(&cwd));
    let agent = format!("projects/{}/{p}/subagents/agent-fixture.jsonl", slug(&cwd));
    let transcript_bytes = b"{\"type\":\"user\",\"message\":\"fixture conversation\"}\n";
    let agent_bytes = b"{\"type\":\"assistant\",\"message\":\"fixture subagent\"}\n";
    write_bytes(&f.transcript_root, &transcript, Some(transcript_bytes)).unwrap();
    write_bytes(&f.transcript_root, &agent, Some(agent_bytes)).unwrap();
    set_transfer(
        &f,
        DesktopHistoryTransfer::Selected,
        Some(vec![
            personal.id.clone(),
            work.id.clone(),
            other_work.id.clone(),
        ]),
    );
    f.manager.switch_to(&work.id, Default::default()).unwrap();
    let work_dir = scope_dir("claude-code-sessions", &work);
    let copy = obj(&f.root, &format!("{work_dir}/local_{p}.json")).unwrap();
    assert_eq!(copy["cliSessionId"], json!(p));
    assert_eq!(copy["priorCliSessionIds"], json!([prior]));
    assert_eq!(copy["archived"], json!(true));
    assert!(obj(&f.root, &format!("{work_dir}/local_{o}.json")).is_some());
    assert_eq!(obj(&f.root, &format!("{work_dir}/local_{x}.json")), None);
    f.manager
        .switch_to(&personal.id, Default::default())
        .unwrap();
    let personal_dir = scope_dir("claude-code-sessions", &personal);
    assert!(obj(&f.root, &format!("{personal_dir}/local_{w}.json")).is_some());
    assert!(obj(&f.root, &format!("{personal_dir}/local_{o}.json")).is_some());
    assert_eq!(
        obj(&f.root, &format!("{personal_dir}/local_{x}.json")),
        None
    );
    assert_eq!(fs::read(f.root.join(&p_rel)).unwrap(), source_before);
    assert_eq!(
        fs::read(f.transcript_root.join(&transcript)).unwrap(),
        transcript_bytes
    );
    assert_eq!(
        fs::read(f.transcript_root.join(&agent)).unwrap(),
        agent_bytes
    );
    f.manager
        .switch_to(&excluded.id, Default::default())
        .unwrap();
    let excluded_dir = scope_dir("claude-code-sessions", &excluded);
    assert_eq!(
        obj(&f.root, &format!("{excluded_dir}/local_{p}.json")),
        None
    );
}

#[test]
fn newer_shared_project_records_refresh_local_folders_and_names_while_preserving_destination_server_bindings()
 {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let relative =
        |x: &Account| format!("{}/spaces.json", scope_dir("local-agent-mode-sessions", x));
    let new_dir = f.base().join("new").to_string_lossy().to_string();
    let old_dir = f.base().join("old").to_string_lossy().to_string();
    write_bytes(
        &f.root,
        &relative(&a),
        Some(&json_bytes(&json!({ "spaces": [{
            "id": "shared-space", "name": "New name", "folders": [new_dir], "updatedAt": 200,
            "projects": ["source-server-project"], "migration": { "organization": "source" },
        }] }))),
    )
    .unwrap();
    write_bytes(
        &f.root,
        &relative(&b),
        Some(&json_bytes(&json!({ "retained": "target", "spaces": [{
            "id": "shared-space", "name": "Old name", "folders": [old_dir], "updatedAt": 100,
            "projects": ["target-server-project"], "migration": { "organization": "target" },
        }] }))),
    )
    .unwrap();
    let before = fs::read(f.root.join(relative(&b))).unwrap();
    let writes = plan(&f.root, &b, &[&a]);
    let updated = planned(&writes, &relative(&b));
    assert_eq!(updated["spaces"].as_array().unwrap().len(), 1);
    assert_eq!(updated["spaces"][0]["name"], json!("New name"));
    assert_eq!(updated["spaces"][0]["folders"], json!([new_dir]));
    assert_eq!(
        updated["spaces"][0]["projects"],
        json!(["target-server-project"])
    );
    assert_eq!(
        updated["spaces"][0]["migration"],
        json!({ "organization": "target" })
    );
    assert_eq!(updated["retained"], json!("target"));
    assert_eq!(
        fs::read(f.root.join(relative(&b))).unwrap(),
        before,
        "planning must not write Desktop files"
    );
}

#[test]
fn a_project_deleted_in_its_destination_is_not_resurrected_on_a_later_account_switch() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    set_transfer(
        &f,
        DesktopHistoryTransfer::Selected,
        Some(vec![a.id.clone(), b.id.clone()]),
    );
    let relative =
        |x: &Account| format!("{}/spaces.json", scope_dir("local-agent-mode-sessions", x));
    write_bytes(
        &f.root,
        &relative(&a),
        Some(&json_bytes(&json!({ "spaces": [{ "id": "shared", "name": "Project", "folders": [f.root.to_string_lossy()], "updatedAt": 100 }] }))),
    )
    .unwrap();
    f.manager.sync_history(&b.id).unwrap();
    assert_eq!(
        obj(&f.root, &relative(&b)).unwrap()["spaces"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    write_bytes(
        &f.root,
        &relative(&b),
        Some(&json_bytes(&json!({ "spaces": [] }))),
    )
    .unwrap();
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(obj(&f.root, &relative(&b)).unwrap()["spaces"], json!([]));
    assert_eq!(
        obj(&f.root, &relative(&a)).unwrap()["spaces"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "destination deletion must not remove the source project"
    );
    let seen = obj(&f.vault(), "history-seen.json").unwrap();
    assert_eq!(
        seen[&format!("{}/{}", desktop(&b).account_uuid, desktop(&b).org_id)],
        json!(["shared"])
    );
}

#[test]
fn newest_conversation_lineage_keeps_destination_archive_and_permission_choices_and_removes_copied_stale_errors()
 {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let (id, latest, prior) = (uuid(), uuid(), uuid());
    session(
        &f.root,
        &a,
        Some(&id),
        json!({
            "cliSessionId": latest, "priorCliSessionIds": [prior], "lastActivityAt": 200,
            "archived": false, "pinned": false, "error": "stale quota", "errorAt": 100,
            "priorErrorMark": "old", "chromePermissionMode": "allow_all",
            "promptAppendSnapshot": "source instructions",
        }),
    );
    session(
        &f.root,
        &b,
        Some(&id),
        json!({
            "lastActivityAt": 100, "archived": true, "pinned": true, "lastFocusedAt": 90,
            "permissionMode": "acceptEdits", "chromePermissionMode": "always_ask",
        }),
    );
    let (new_record, _) = session(&f.root, &a, None, json!({}));
    let writes = plan(&f.root, &b, &[&a]);
    let dest = scope_dir("claude-code-sessions", &b);
    let updated = planned(&writes, &format!("{dest}/local_{id}.json"));
    assert_eq!(updated["cliSessionId"], json!(latest));
    assert_eq!(updated["priorCliSessionIds"], json!([prior]));
    assert_eq!(updated["archived"], json!(true));
    assert_eq!(updated["pinned"], json!(true));
    assert_eq!(updated["lastFocusedAt"], json!(90));
    assert_eq!(updated["permissionMode"], json!("acceptEdits"));
    assert_eq!(updated["chromePermissionMode"], json!("always_ask"));
    for key in ["error", "errorAt", "priorErrorMark", "promptAppendSnapshot"] {
        assert_eq!(updated.get(key), None, "{key}");
    }
    let copied = planned(&writes, &format!("{dest}/local_{new_record}.json"));
    assert_eq!(copied["chromePermissionMode"], json!("always_ask"));
}

#[test]
fn history_summary_checks_shared_transcript_presence_without_treating_an_index_or_unknown_path_encoding_as_resumability()
 {
    let f = Fixture::new();
    let a = f.account("A", None);
    let cwd = f.base().join("actual_project");
    let origin = f.base().join("original_project");
    let cwd_text = cwd.to_string_lossy().to_string();
    let (found, _) = session(
        &f.root,
        &a,
        None,
        json!({ "cwd": cwd_text, "originCwd": origin.to_string_lossy(), "archived": true }),
    );
    session(&f.root, &a, None, json!({ "cwd": cwd_text }));
    session(
        &f.root,
        &a,
        None,
        json!({ "cwd": cwd_text, "cliSessionId": "unknown-version-id" }),
    );
    session(
        &f.root,
        &a,
        None,
        json!({ "cwd": f.base().join("şirket").to_string_lossy() }),
    );
    let (deleted, _) = session(&f.root, &a, None, json!({ "cwd": cwd_text }));
    let dir = scope_dir("claude-code-sessions", &a);
    write_bytes(
        &f.root,
        &format!("{dir}/deleted_{}", deleted.to_uppercase()),
        Some(b""),
    )
    .unwrap();
    let transcript = format!("projects/{}/{found}.jsonl", slug(&cwd));
    let bytes = b"{\"type\":\"user\",\"message\":\"fixture\"}\n";
    write_bytes(&f.transcript_root, &transcript, Some(bytes)).unwrap();
    let spaces = format!("{}/spaces.json", scope_dir("local-agent-mode-sessions", &a));
    write_bytes(
        &f.root,
        &spaces,
        Some(&json_bytes(
            &json!({ "spaces": [{ "id": "project", "name": "Fixture" }] }),
        )),
    )
    .unwrap();
    let desktop_before = fs::read(f.root.join("config.json")).unwrap();
    let (starts, quits) = (f.starts(), f.quits());
    let summary = f.manager.history_summary(&a.id).unwrap();
    assert_eq!(summary.indexed, 4.0);
    assert_eq!(summary.archived, 1.0);
    assert_eq!(summary.projects, 1.0);
    assert_eq!(
        summary.transcripts_found, 1.0,
        "the current cwd must be probed when originCwd differs"
    );
    assert_eq!(summary.missing_transcripts, 1.0);
    assert_eq!(summary.unknown_transcripts, 2.0);
    assert_eq!(f.starts(), starts);
    assert_eq!(f.quits(), quits);
    assert_eq!(
        fs::read(f.root.join("config.json")).unwrap(),
        desktop_before
    );
    assert_eq!(
        fs::read(f.transcript_root.join(&transcript)).unwrap(),
        bytes
    );
}

#[cfg(unix)]
#[test]
fn transcript_symlinks_are_unknown_and_history_sync_refuses_an_inactive_account_before_restart() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let cwd = f.base().join("project");
    let (s, _) = session(&f.root, &b, None, json!({ "cwd": cwd.to_string_lossy() }));
    let folder = f.transcript_root.join("projects").join(slug(&cwd));
    fs::create_dir_all(&folder).unwrap();
    let outside = f.base().join("outside.jsonl");
    fs::write(&outside, "fixture").unwrap();
    std::os::unix::fs::symlink(&outside, folder.join(format!("{s}.jsonl"))).unwrap();
    let summary = f.manager.history_summary(&b.id).unwrap();
    assert_eq!(summary.unknown_transcripts, 1.0);
    assert_eq!(summary.missing_transcripts, 0.0);
    let (starts, quits) = (f.starts(), f.quits());
    err_contains(
        f.manager.sync_history(&a.id),
        "Switch to this Desktop account",
    );
    assert_eq!(f.starts(), starts);
    assert_eq!(f.quits(), quits);
}

#[test]
fn claude_opening_after_the_first_switch_write_retains_recovery_without_rolling_back_live_files() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.set_running(false);
    let (starts, quits) = (f.starts(), f.quits());
    // Claude opens once config.json names A: the next process check sees it.
    let opened = Arc::new(AtomicBool::new(false));
    let (flag, root, target) = (
        Arc::clone(&opened),
        f.root.clone(),
        desktop(&a).account_uuid.clone(),
    );
    FakeHost::set(
        &f.host.on_running,
        Arc::new(move |host: &FakeHost| {
            let names = read_object(&root, "config.json")
                .ok()
                .flatten()
                .and_then(|c| c.get("lastKnownAccountUuid").cloned())
                == Some(json!(target));
            if names && !flag.swap(true, Ordering::SeqCst) {
                host.st().running = true;
            }
        }),
    );
    err_contains(
        f.manager.switch_to(
            &a.id,
            DesktopSwitchOptions {
                can_proceed: Some(Arc::new(|| true)),
                ..closed(&b.id)
            },
        ),
        "Claude opened during",
    );
    *f.host.on_running.lock().unwrap() = None;
    assert!(opened.load(Ordering::SeqCst));
    assert_eq!(f.starts(), starts);
    assert_eq!(f.quits(), quits);
    assert_eq!(
        obj(&f.root, "config.json").unwrap()["lastKnownAccountUuid"],
        json!(desktop(&a).account_uuid),
        "the transaction must not undo a completed write while Claude is live"
    );
    assert!(f.manager.snapshot().unwrap().recovery_required);
    err_contains(
        f.manager.switch_to(&b.id, Default::default()),
        "Restore the interrupted",
    );
    f.set_running(false);
    f.manager.recover().unwrap();
    let state = f.manager.snapshot().unwrap();
    assert!(!state.recovery_required);
    assert_eq!(state.active_profile_id.as_deref(), Some(b.id.as_str()));
}

#[test]
fn a_cancelled_closed_app_switch_rolls_back_both_merged_history_and_deletion_tracking() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let source = format!("{}/spaces.json", scope_dir("local-agent-mode-sessions", &a));
    let target = format!("{}/spaces.json", scope_dir("local-agent-mode-sessions", &b));
    write_bytes(
        &f.root,
        &source,
        Some(&json_bytes(
            &json!({ "spaces": [{ "id": "copy", "name": "Fixture", "updatedAt": 100 }] }),
        )),
    )
    .unwrap();
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.set_running(false);
    let tracking = f.vault().join("history-seen.json");
    let tracking_before = fs::read(&tracking).unwrap();
    // Unauthorized once the tracking file was written.
    let (file, before) = (tracking.clone(), tracking_before.clone());
    err_contains(
        f.manager.switch_to(
            &b.id,
            DesktopSwitchOptions {
                can_proceed: Some(Arc::new(move || fs::read(&file).unwrap() == before)),
                ..closed(&a.id)
            },
        ),
        "conditions changed",
    );
    assert_eq!(obj(&f.root, &target), None);
    assert_eq!(fs::read(&tracking).unwrap(), tracking_before);
    let state = f.manager.snapshot().unwrap();
    assert!(!state.recovery_required);
    assert_eq!(state.active_profile_id.as_deref(), Some(a.id.as_str()));
}

#[test]
fn the_same_conversation_under_different_aliases_produces_one_card_per_account() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let (cli, older) = (uuid(), uuid());
    session(
        &f.root,
        &a,
        Some(&older),
        json!({ "cliSessionId": cli, "lastActivityAt": 100, "permissionMode": "auto" }),
    );
    session(
        &f.root,
        &a,
        Some(&cli),
        json!({ "lastActivityAt": 300, "permissionMode": "auto" }),
    );
    session(
        &f.root,
        &b,
        Some(&cli),
        json!({ "lastActivityAt": 200, "permissionMode": "default", "lastFocusedAt": 77 }),
    );
    session(
        &f.root,
        &b,
        Some(&older),
        json!({ "cliSessionId": cli, "lastActivityAt": 100 }),
    );
    let mut names = vec![format!("local_{cli}.json"), format!("local_{older}.json")];
    names.sort();
    assert_eq!(
        duplicate_sessions(&f.root, &scope(&b)).unwrap(),
        vec![names]
    );
    let writes = plan(&f.root, &b, &[&a]);
    let dest = scope_dir("claude-code-sessions", &b);
    assert_eq!(
        writes.get(&format!("{dest}/local_{older}.json")),
        Some(&None)
    );
    let kept = planned(&writes, &format!("{dest}/local_{cli}.json"));
    assert_eq!(kept["lastActivityAt"], json!(300));
    assert_eq!(kept["lastFocusedAt"], json!(77));
    assert_eq!(kept["permissionMode"], json!("auto"));
    assert_eq!(writes.len(), 2);
}

#[test]
fn a_conversation_claude_dropped_to_manual_goes_back_to_auto_on_the_next_account_one_the_user_set_to_manual_stays()
 {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let (dropped, chosen) = (uuid(), uuid());
    session(
        &f.root,
        &a,
        Some(&dropped),
        json!({ "permissionMode": "default", "autoChosenInApp": true }),
    );
    session(
        &f.root,
        &a,
        Some(&chosen),
        json!({ "permissionMode": "default", "autoChosenInApp": false }),
    );
    let writes = plan(&f.root, &b, &[&a]);
    let dest = scope_dir("claude-code-sessions", &b);
    let mode =
        |id: &str| planned(&writes, &format!("{dest}/local_{id}.json"))["permissionMode"].clone();
    assert_eq!(mode(&dropped), json!("auto"));
    assert_eq!(mode(&chosen), json!("default"));
}

#[test]
fn permission_modes_for_new_conversations_fill_what_the_next_account_has_not_chosen() {
    let (from, to) = (uuid(), uuid());
    let config = json!({
        "deploymentMode": "1p",
        "preferences": {
            "other": true,
            "epitaxyPrefs": {
                format!("cc-landing-draft-permission-mode.{from}"): "auto",
                format!("epitaxy-folder-permission-mode-v2.{from}"): {
                    "/work/a": "auto", "/work/b": "bypassPermissions", "/work/c": "plan",
                },
                format!("epitaxy-folder-permission-mode-v2.{to}"): { "/work/c": "default" },
            },
        },
    });
    let config = config.as_object().unwrap();
    let next = plan_permission_preferences(Some(config), &from, &to)
        .unwrap()
        .unwrap();
    let prefs = &next["preferences"]["epitaxyPrefs"];
    assert_eq!(
        prefs[format!("cc-landing-draft-permission-mode.{to}")],
        json!("auto")
    );
    assert_eq!(
        prefs[format!("epitaxy-folder-permission-mode-v2.{to}")],
        json!({ "/work/c": "default", "/work/a": "auto" })
    );
    assert_eq!(next["deploymentMode"], json!("1p"));
    assert_eq!(next["preferences"]["other"], json!(true));
    assert_eq!(
        config["preferences"]["epitaxyPrefs"].get(format!("cc-landing-draft-permission-mode.{to}")),
        None
    );
    assert_eq!(
        plan_permission_preferences(Some(&next), &from, &to).unwrap(),
        None
    );
    let bypass = json!({ "preferences": { "epitaxyPrefs": { format!("cc-landing-draft-permission-mode.{from}"): "bypassPermissions" } } });
    assert_eq!(
        plan_permission_preferences(bypass.as_object(), &from, &to).unwrap(),
        None
    );
    assert_eq!(
        plan_permission_preferences(Some(&Map::new()), &from, &to).unwrap(),
        None
    );
}

#[test]
fn a_switch_carries_the_left_accounts_new_conversation_mode_into_claudes_preferences() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    write_bytes(
        &f.root,
        "claude_desktop_config.json",
        Some(&json_bytes(&json!({ "preferences": { "epitaxyPrefs": {
            format!("cc-landing-draft-permission-mode.{}", desktop(&a).account_uuid): "auto",
        } } }))),
    )
    .unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    let prefs =
        obj(&f.root, "claude_desktop_config.json").unwrap()["preferences"]["epitaxyPrefs"].clone();
    assert_eq!(
        prefs[format!(
            "cc-landing-draft-permission-mode.{}",
            desktop(&b).account_uuid
        )],
        json!("auto")
    );
}

#[test]
fn a_stale_alias_superseded_by_a_resumed_lineage_collapses_into_the_live_conversation() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let (stale, live, first, rotated) = (uuid(), uuid(), uuid(), uuid());
    session(
        &f.root,
        &a,
        Some(&stale),
        json!({ "cliSessionId": first, "lastActivityAt": 10 }),
    );
    session(
        &f.root,
        &a,
        Some(&live),
        json!({ "cliSessionId": rotated, "priorCliSessionIds": [first], "lastActivityAt": 50 }),
    );
    let writes = plan(&f.root, &b, &[&a]);
    let dest = scope_dir("claude-code-sessions", &b);
    assert_eq!(
        writes.keys().cloned().collect::<Vec<_>>(),
        vec![format!("{dest}/local_{live}.json")]
    );
    let (other, _) = session(&f.root, &a, Some(&uuid()), json!({ "lastActivityAt": 5 }));
    let again = plan(&f.root, &b, &[&a]);
    assert!(matches!(
        again.get(&format!("{dest}/local_{other}.json")),
        Some(Some(_))
    ));
    assert_eq!(again.len(), 2);
}

#[test]
fn bypass_mode_never_travels_and_a_conversation_deleted_under_any_alias_stays_deleted() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let (bypass, _) = session(
        &f.root,
        &a,
        None,
        json!({ "permissionMode": "bypassPermissions" }),
    );
    let (cli, alias) = (uuid(), uuid());
    session(
        &f.root,
        &a,
        Some(&alias),
        json!({ "cliSessionId": cli, "lastActivityAt": 90 }),
    );
    let dest = scope_dir("claude-code-sessions", &b);
    write_bytes(&f.root, &format!("{dest}/deleted_{cli}"), Some(b"")).unwrap();
    session(&f.root, &b, Some(&cli), json!({ "lastActivityAt": 10 }));
    let writes = plan(&f.root, &b, &[&a]);
    assert!(!writes.contains_key(&format!("{dest}/local_{alias}.json")));
    assert!(!writes.contains_key(&format!("{dest}/local_{cli}.json")));
    assert_eq!(
        planned(&writes, &format!("{dest}/local_{bypass}.json"))["permissionMode"],
        json!("default")
    );
}

#[test]
fn verifying_saved_sign_ins_decrypts_each_one_without_touching_claude() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let (quits, starts) = (f.quits(), f.starts());
    let config = fs::read(f.root.join("config.json")).unwrap();
    f.manager.verify_saved_logins().unwrap();
    assert_eq!(f.quits(), quits);
    assert_eq!(f.starts(), starts);
    assert_eq!(fs::read(f.root.join("config.json")).unwrap(), config);
    fs::remove_file(
        f.vault()
            .join("accounts")
            .join(format!("{}.bin", desktop(&b).account_uuid)),
    )
    .unwrap();
    err_contains(
        f.manager.verify_saved_logins(),
        "Connect this account again",
    );
    assert!(a.desktop.is_some());
}

#[test]
fn a_desktop_switch_reports_the_claude_restart_it_causes() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    let events = record_restarts(&f);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            restart(true, DesktopOperationKind::Switch, Some(&a.id), false),
            restart(false, DesktopOperationKind::Switch, Some(&a.id), true),
        ]
    );
}

#[test]
fn desktop_operations_that_never_quit_claude_report_nothing() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let events = record_restarts(&f);
    f.manager.capture(&b.id, &desktop(&b).org_id).unwrap();
    err_contains(
        f.manager.switch_to(&a.id, refuse()),
        "cancelled before restart",
    );
    f.manager.cancel_login().unwrap();
    f.set_running(false);
    f.manager.switch_to(&a.id, closed(&b.id)).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    f.manager.open().unwrap();
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn a_desktop_operation_that_fails_after_asking_claude_to_quit_reports_a_failed_end() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    let events = record_restarts(&f);
    f.set_fail_quit();
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "still running",
    );
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            restart(true, DesktopOperationKind::Switch, Some(&a.id), false),
            restart(false, DesktopOperationKind::Switch, Some(&a.id), false),
        ]
    );
}

#[test]
fn each_restarting_desktop_operation_reports_its_own_kind() {
    let f = Fixture::new();
    let events = record_restarts(&f);
    let a = f.account("A", None);
    let c = f.create("C", None);
    f.manager.begin_login(&c.id).unwrap();
    f.manager.cancel_login().unwrap();
    f.manager.sync_history(&a.id).unwrap();
    use DesktopOperationKind::*;
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            restart(true, Save, Some(&a.id), false),
            restart(false, Save, Some(&a.id), true),
            restart(true, Link, Some(&c.id), false),
            restart(false, Link, Some(&c.id), true),
            restart(true, CancelLink, None, false),
            restart(false, CancelLink, None, true),
            restart(true, Merge, Some(&a.id), false),
            restart(false, Merge, Some(&a.id), true),
        ]
    );
}

#[test]
fn a_failing_restart_listener_never_breaks_the_desktop_operation() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    f.manager
        .configure(|h| h.on_restart = Some(Arc::new(|_| panic!("listener"))));
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
}

// ---------------------------------------------------------------------------------------------
// Drafts

type Read = Arc<dyn Fn(&relay_core::draft_transfer::DraftJob) -> DraftResult + Send + Sync>;

struct DraftHelper {
    leveldb: std::path::PathBuf,
    tmp: std::path::PathBuf,
    vault: std::path::PathBuf,
}

impl DraftHelper {
    fn last(&self) -> Option<Map<String, Value>> {
        obj(&self.vault, "drafts/last.json")
    }
    fn drafts(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.vault.join("drafts"))
            .map(|entries| {
                entries
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
    fn tmp_entries(&self) -> Vec<String> {
        fs::read_dir(&self.tmp)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }
}

fn ok_drafts(drafts: &[(String, String)]) -> DraftResult {
    let mut map = JsMap::new();
    for (key, value) in drafts {
        map.insert(key.clone(), value.clone());
    }
    DraftResult::Ok {
        drafts: map,
        sidebar: None,
    }
}

/// Gives the fixture's Claude a Local Storage and its host a draft reader that records each job,
/// answering with `read`. What the host does is recorded from here on.
fn with_draft_helper(f: &Fixture, read: Option<Read>) -> DraftHelper {
    let leveldb = f.root.join("Local Storage").join("leveldb");
    fs::create_dir_all(&leveldb).unwrap();
    fs::write(leveldb.join("CURRENT"), "MANIFEST-000001\n").unwrap();
    if let Some(read) = read {
        FakeHost::set(&f.host.read_drafts, read);
    }
    let tmp = f.base().join("tmp");
    fs::create_dir_all(&tmp).unwrap();
    {
        let mut st = f.host.st();
        st.reads_drafts = true;
        st.order.clear();
        st.scratch = Some(tmp.clone());
    }
    DraftHelper {
        leveldb,
        tmp,
        vault: f.vault(),
    }
}

/// The draft reader's and the launches' events, as the TS helper records them.
fn draft_events(f: &Fixture) -> Vec<String> {
    f.host
        .st()
        .order
        .iter()
        .filter(|e| e.starts_with("readDrafts") || e.starts_with("launch"))
        .map(|e| {
            if e.starts_with("launch") {
                "launch".to_string()
            } else {
                e.clone()
            }
        })
        .collect()
}

fn draft_of(owner: &str, text: &str, files: &[&str]) -> String {
    json!({ "text": text, "files": files, "snippets": [], "owner": owner }).to_string()
}

const UNSENT: &str = "an unsent draft, word for word";

struct Shared {
    f: Fixture,
    a: Account,
    b: Account,
    shared: String,
    d: DraftHelper,
}

/// A switch from A, open in Claude, to B, sharing one conversation. B's card of it is the newest
/// and is called "Fix login"; A has an unsent draft there and one on the new-session screen.
fn shared_conversation() -> Shared {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None); // A is open in Claude
    let shared = uuid();
    session(
        &f.root,
        &a,
        Some(&shared),
        json!({ "lastActivityAt": 100, "title": "A's title" }),
    );
    session(
        &f.root,
        &b,
        Some(&shared),
        json!({ "lastActivityAt": 300, "title": "Fix login" }),
    );
    let drafts = vec![
        (
            format!("{CONVERSATION_DRAFT_PREFIX}{shared}"),
            draft_of(&desktop(&a).account_uuid, UNSENT, &[]),
        ),
        (
            NEW_SESSION_DRAFT.to_string(),
            draft_of(&desktop(&a).account_uuid, "a new start", &["f"]),
        ),
        // B's own draft somewhere else is not A's to carry.
        (
            format!("{CONVERSATION_DRAFT_PREFIX}{}", uuid()),
            draft_of(&desktop(&b).account_uuid, "B's", &[]),
        ),
    ];
    let d = with_draft_helper(&f, Some(Arc::new(move |_| ok_drafts(&drafts))));
    Shared { f, a, b, shared, d }
}

fn jobs(f: &Fixture) -> usize {
    f.host.st().jobs.len()
}

#[test]
fn an_a_b_switch_captures_as_draft_of_a_shared_conversation_for_b() {
    let Shared { f, a, b, shared, d } = shared_conversation();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    let records = f.manager.pending_draft_records();
    assert_eq!(records.len(), 2);
    let conversation = &records[0];
    assert_eq!(conversation.id.len(), 36);
    assert!(relay_core::shared::types::js::date_parse(&conversation.captured_at).is_finite());
    assert_eq!(conversation.to, desktop(&b).account_uuid);
    assert_eq!(conversation.target_alias.as_deref(), Some(shared.as_str()));
    assert_eq!(conversation.new_session, None);
    assert_eq!(conversation.title, "Fix login");
    assert_eq!(conversation.text, UNSENT);
    assert!(!conversation.attachments);
    assert_eq!(
        conversation.state,
        relay_core::draft_vault::DraftState::Pending
    );
    assert_eq!(conversation.reason, None);
    assert_eq!(
        obj(
            &f.root,
            &format!(
                "{}/local_{shared}.json",
                scope_dir("claude-code-sessions", &b)
            )
        )
        .unwrap()["title"],
        json!("Fix login")
    );
    let new_session = &records[1];
    assert_eq!(new_session.new_session, Some(true));
    assert_eq!(new_session.text, "a new start");
    assert!(new_session.attachments);
    assert_eq!(new_session.to, desktop(&b).account_uuid);
    let mut last = d.last().unwrap();
    let at = last.shift_remove("at").unwrap();
    assert!(relay_core::shared::types::js::date_parse(at.as_str().unwrap()).is_finite());
    assert_eq!(
        Value::Object(last),
        json!({ "from": desktop(&a).account_uuid, "to": desktop(&b).account_uuid, "status": "captured", "count": 2 })
    );
    assert_eq!(d.drafts(), vec!["last.json", "pending.bin"]);
    for file in ["last.json", "pending.bin"] {
        let raw = fs::read(d.vault.join("drafts").join(file)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains(UNSENT), "{file}");
    }
    assert!(d.tmp_entries().is_empty());
}

fn events_of(events: &Events, name: &str) -> Vec<Option<Map<String, Value>>> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|(event, _)| event == name)
        .map(|(_, fields)| fields.clone())
        .collect()
}

fn fields(value: Value) -> Option<Map<String, Value>> {
    value.as_object().cloned()
}

#[test]
fn a_capture_is_logged_with_its_slots_and_lengths_never_its_text() {
    let Shared {
        f, a, b, shared, ..
    } = shared_conversation();
    let events = record_events(&f);
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        events_of(&events, "capture"),
        vec![fields(json!({
            "from": desktop(&a).account_uuid[..8],
            "to": desktop(&b).account_uuid[..8],
            "status": "captured",
            "count": 2,
            "drafts": format!("{}:{},new:{}", &shared[..8], UNSENT.len(), "a new start".len()),
        }))]
    );
    let logged = format!("{:?}", events.lock().unwrap());
    let full =
        regex::Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
            .unwrap();
    assert!(!full.is_match(&logged));
    assert!(!logged.contains(UNSENT));
    assert!(!logged.contains("a new start"));
}

#[test]
fn a_capture_that_fails_or_is_skipped_is_logged_with_its_reason_and_a_log_that_throws_changes_nothing()
 {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None);
    with_draft_helper(
        &f,
        Some(Arc::new(|_| DraftResult::Failed {
            error: format!("Unexpected token 'x', \"{UNSENT}\" is not valid JSON"),
        })),
    );
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    f.manager.configure(|h| {
        h.on_draft_event = Some(Arc::new(
            move |event: &str, fields: Option<&Map<String, Value>>| {
                sink.lock()
                    .unwrap()
                    .push((event.to_string(), fields.cloned()));
                panic!("the log failed");
            },
        ))
    });
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(
        *events.lock().unwrap(),
        vec![(
            "capture".to_string(),
            fields(json!({
                "from": desktop(&a).account_uuid[..8],
                "to": desktop(&b).account_uuid[..8],
                "status": "failed",
                "count": 0,
                "error": "parse-error",
                "drafts": "",
            }))
        )]
    );
    assert!(!format!("{:?}", events.lock().unwrap()).contains(UNSENT));
    // A host that cannot read drafts skips the step, and says why.
    let g = Fixture::new();
    let second = g.account("B", None);
    g.account("A", None);
    with_draft_helper(&g, None);
    FakeHost::set(
        &g.host.drafts_blocked,
        Arc::new(|_: &FakeHost| Ok(Some("Drafts are not supported here".to_string()))),
    );
    let skipped = record_events(&g);
    g.manager.switch_to(&second.id, Default::default()).unwrap();
    let skipped = skipped.lock().unwrap();
    assert_eq!(skipped.len(), 1);
    let entry = skipped[0].1.as_ref().unwrap();
    assert_eq!(entry["status"], json!("skipped"));
    assert_eq!(entry["reason"], json!("Drafts are not supported here"));
}

#[test]
fn a_switch_whose_history_policy_forbids_drafts_logs_that_no_capture_was_tried() {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None);
    with_draft_helper(&f, None);
    set_transfer(&f, DesktopHistoryTransfer::Off, None);
    let events = record_events(&f);
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        vec![(
            "capture".to_string(),
            fields(json!({
                "from": desktop(&a).account_uuid[..8],
                "to": desktop(&b).account_uuid[..8],
                "status": "not-run",
                "reason": "history-off",
            }))
        )]
    );
}

#[test]
fn the_draft_methods_work_by_id_and_summaries_carry_no_text() {
    let Shared { f, b, d, .. } = shared_conversation();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    let records = f.manager.pending_draft_records();
    let (conversation, new_session) = (&records[0], &records[1]);
    let summaries = f.manager.pending_drafts();
    assert!(!serde_json::to_string(&summaries).unwrap().contains(UNSENT));
    assert_eq!(
        serde_json::to_value(&summaries[0]).unwrap(),
        json!({
            "id": conversation.id, "to": desktop(&b).account_uuid, "title": "Fix login",
            "newSession": false, "attachments": false, "state": "pending",
            "capturedAt": conversation.captured_at,
        })
    );
    assert_eq!(
        f.manager.draft_text(&conversation.id).as_deref(),
        Some(UNSENT)
    );
    assert_eq!(f.manager.draft_text(&uuid()), None);
    f.manager
        .mark_draft(
            &conversation.id,
            relay_core::draft_vault::DraftState::NeedsCopy,
            Some("accessibility".into()),
        )
        .unwrap();
    let marked = &f.manager.pending_drafts()[0];
    assert_eq!(marked.state, relay_core::draft_vault::DraftState::NeedsCopy);
    assert_eq!(marked.reason.as_deref(), Some("accessibility"));
    f.manager.dismiss_draft(&conversation.id).unwrap();
    assert_eq!(
        f.manager
            .pending_drafts()
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        vec![new_session.id.clone()]
    );
    f.manager.dismiss_draft(&new_session.id).unwrap();
    assert!(f.manager.pending_drafts().is_empty());
    assert_eq!(d.drafts(), vec!["last.json"]);
}

#[test]
fn a_later_capture_that_finds_no_draft_drops_the_stale_one() {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None);
    let shared = uuid();
    session(&f.root, &a, Some(&shared), json!({ "lastActivityAt": 100 }));
    session(
        &f.root,
        &b,
        Some(&shared),
        json!({ "lastActivityAt": 300, "title": "Fix login" }),
    );
    let drafts = Arc::new(Mutex::new(vec![
        (
            format!("{CONVERSATION_DRAFT_PREFIX}{shared}"),
            draft_of(&desktop(&a).account_uuid, UNSENT, &[]),
        ),
        (
            NEW_SESSION_DRAFT.to_string(),
            draft_of(&desktop(&a).account_uuid, "a new start", &[]),
        ),
    ]));
    let source = Arc::clone(&drafts);
    let d = with_draft_helper(
        &f,
        Some(Arc::new(move |_| ok_drafts(&source.lock().unwrap()))),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(f.manager.pending_draft_records().len(), 2);
    drafts.lock().unwrap().clear();
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert!(f.manager.pending_draft_records().is_empty());
    assert_eq!(d.drafts(), vec!["last.json"]);
    assert_eq!(d.last().unwrap()["count"], json!(0));
}

#[cfg(unix)]
#[test]
fn initialize_removes_stale_draft_scratch_dirs_and_keeps_fresh_ones() {
    let f = Fixture::new();
    let tmp = f.host.st().scratch.clone().unwrap();
    fs::create_dir_all(&tmp).unwrap();
    let stale = tempfile::Builder::new()
        .prefix("relay-drafts-")
        .tempdir_in(&tmp)
        .unwrap()
        .keep();
    fs::create_dir_all(stale.join("copy").join("leveldb")).unwrap();
    fs::write(stale.join("result.json"), UNSENT).unwrap();
    let fresh = tempfile::Builder::new()
        .prefix("relay-drafts-")
        .tempdir_in(&tmp)
        .unwrap()
        .keep();
    let other = tmp.join("someone-else");
    fs::create_dir(&other).unwrap();
    let eleven = std::time::SystemTime::now() - std::time::Duration::from_secs(11 * 60);
    relay_core::fs_util::set_times(&stale, eleven).unwrap();
    relay_core::fs_util::set_times(&other, eleven).unwrap();
    f.manager_with(Arc::clone(&f.host) as Arc<dyn DesktopHost>, None);
    assert!(fs::symlink_metadata(&stale).is_err());
    let mut names: Vec<String> = fs::read_dir(&tmp)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut expected = vec![
        fresh.file_name().unwrap().to_string_lossy().into_owned(),
        "someone-else".to_string(),
    ];
    expected.sort();
    assert_eq!(names, expected);
}

#[test]
fn an_a_b_switch_runs_the_draft_helper_once_on_a_private_copy() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(&f, None);
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    let jobs = f.host.st().jobs.clone();
    assert_eq!(jobs.len(), 1);
    let job = &jobs[0];
    assert_eq!(job.scratch.parent().unwrap(), d.tmp);
    assert_eq!(job.storage, job.scratch.join("copy"));
    assert!(!job.storage.starts_with(&f.root));
    let names: Vec<String> = fs::read_dir(f.root.join("Local Storage"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["leveldb"]);
    assert!(d.tmp_entries().is_empty());
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(d.last().unwrap()["status"], json!("captured"));
    assert_eq!(d.last().unwrap()["count"], json!(0));
    assert!(f.manager.pending_draft_records().is_empty());
}

#[test]
fn claude_relaunches_only_after_the_draft_helper_finished() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    with_draft_helper(
        &f,
        Some(Arc::new(|_| {
            std::thread::sleep(std::time::Duration::from_millis(50));
            ok_drafts(&[])
        })),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        draft_events(&f),
        vec!["readDrafts:start", "readDrafts:end", "launch"]
    );
}

#[test]
fn a_throwing_helper_still_switches() {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None);
    let d = with_draft_helper(
        &f,
        Some(Arc::new(|job| {
            fs::write(job.storage.join("leveldb").join("CURRENT"), "x").unwrap();
            DraftResult::Failed {
                error: "helper crashed".into(),
            }
        })),
    );
    let starts = f.starts();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    let state = f.manager.snapshot().unwrap();
    assert_eq!(state.active_profile_id.as_deref(), Some(b.id.as_str()));
    assert_eq!(state.error, None);
    assert!(!state.recovery_required);
    assert_eq!(f.starts(), starts + 1);
    assert_eq!(
        fs::read_to_string(d.leveldb.join("CURRENT")).unwrap(),
        "MANIFEST-000001\n"
    );
    let mut last = d.last().unwrap();
    last.shift_remove("at").unwrap();
    assert_eq!(
        Value::Object(last),
        json!({ "from": desktop(&a).account_uuid, "to": desktop(&b).account_uuid, "status": "failed", "error": "helper crashed" })
    );
    assert!(f.manager.pending_draft_records().is_empty());
    assert!(d.tmp_entries().is_empty());
}

#[test]
fn a_draft_step_that_cannot_seal_its_drafts_still_switches() {
    let Shared { f, b, d, .. } = shared_conversation();
    // Saved sign-ins still seal; only the drafts cannot.
    FakeHost::set(
        &f.host.seal_hook,
        Arc::new(|text: &str| {
            if text.contains(UNSENT) {
                Err(DesktopError::new("System encryption is unavailable."))
            } else {
                Ok(())
            }
        }),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    let state = f.manager.snapshot().unwrap();
    assert_eq!(state.active_profile_id.as_deref(), Some(b.id.as_str()));
    assert_eq!(state.error, None);
    assert_eq!(d.last().unwrap()["status"], json!("failed"));
    assert_eq!(
        d.last().unwrap()["error"],
        json!("System encryption is unavailable.")
    );
    assert!(f.manager.pending_draft_records().is_empty());
    assert_eq!(d.drafts(), vec!["last.json"]);
}

#[test]
fn no_drafts_are_captured_when_history_transfer_is_off() {
    let Shared { f, b, d, .. } = shared_conversation();
    set_transfer(&f, DesktopHistoryTransfer::Off, None);
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last(), None);
    assert!(d.drafts().is_empty());
    assert!(f.manager.pending_draft_records().is_empty());
}

#[test]
fn no_drafts_are_captured_when_the_pair_is_not_allowed() {
    let f = Fixture::new();
    set_transfer(&f, DesktopHistoryTransfer::SameGroup, None);
    let b = f.account("B", Some("other"));
    f.account("A", Some("team"));
    let d = with_draft_helper(&f, None);
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last(), None);
    assert!(f.manager.pending_draft_records().is_empty());
}

#[test]
fn no_drafts_are_captured_when_switching_to_the_same_account() {
    let Shared { f, a, .. } = shared_conversation();
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    assert_eq!(jobs(&f), 0);
    assert_eq!(draft_events(&f), vec!["launch"]);
    assert!(f.manager.pending_draft_records().is_empty());
}

#[test]
fn the_closed_only_switch_captures_drafts_too() {
    let Shared { f, a, b, d, .. } = shared_conversation();
    f.set_running(false);
    f.manager.switch_to(&b.id, closed(&a.id)).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 1);
    assert_eq!(d.last().unwrap()["from"], json!(desktop(&a).account_uuid));
    assert_eq!(d.last().unwrap()["to"], json!(desktop(&b).account_uuid));
    assert_eq!(f.manager.pending_draft_records().len(), 2);
    assert_eq!(draft_events(&f), vec!["readDrafts:start", "readDrafts:end"]);
}

#[test]
fn a_linux_host_captures_drafts_at_an_automatic_switch_as_macos_does() {
    let Shared { f, a, b, d, .. } = shared_conversation();
    f.set_running(false);
    // The app host's gate, asked as on Linux.
    FakeHost::set(
        &f.host.drafts_blocked,
        Arc::new(|_: &FakeHost| {
            Ok(relay_core::draft_transfer::drafts_blocked_reason("linux").map(str::to_string))
        }),
    );
    f.manager
        .switch_to(
            &b.id,
            DesktopSwitchOptions {
                automatic: true,
                ..closed(&a.id)
            },
        )
        .unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 1);
    assert_eq!(d.last().unwrap()["status"], json!("captured"));
    assert_eq!(f.manager.pending_draft_records().len(), 2);
}

#[test]
fn a_host_that_cannot_read_drafts_records_why_and_captures_nothing() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(&f, None);
    let reason = "Claude Desktop runs Electron 45.0.0, Relay 44.7.0";
    FakeHost::set(
        &f.host.drafts_blocked,
        Arc::new(move |_: &FakeHost| Ok(Some(reason.to_string()))),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last().unwrap()["status"], json!("skipped"));
    assert_eq!(d.last().unwrap()["reason"], json!(reason));
    assert_eq!(d.drafts(), vec!["last.json"]);
}

#[test]
fn drafts_are_not_captured_once_claude_is_running_again() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(&f, None);
    // Claude is opened right after the switch's files are written.
    FakeHost::set(
        &f.host.drafts_blocked,
        Arc::new(|host: &FakeHost| {
            host.st().running = true;
            Ok(None)
        }),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last().unwrap()["reason"], json!("Claude is running"));
    assert_eq!(d.drafts(), vec!["last.json"]);
    assert!(d.tmp_entries().is_empty());
}

#[test]
fn claude_opening_once_the_copy_is_under_way_stops_the_step_before_the_helper() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(&f, None);
    // Claude opens after the first process check of the draft step: only the one after the
    // copy sees it (the TS asks `claudeElectron` in between).
    let armed = Arc::new(AtomicBool::new(false));
    let checks = Arc::clone(&armed);
    FakeHost::set(
        &f.host.drafts_blocked,
        Arc::new(move |_: &FakeHost| {
            checks.store(true, Ordering::SeqCst);
            Ok(None)
        }),
    );
    let seen = Arc::new(AtomicU32::new(0));
    let (gate, count) = (Arc::clone(&armed), Arc::clone(&seen));
    FakeHost::set(
        &f.host.on_running,
        Arc::new(move |host: &FakeHost| {
            if gate.load(Ordering::SeqCst) && count.fetch_add(1, Ordering::SeqCst) == 1 {
                host.st().running = true;
            }
        }),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last().unwrap()["reason"], json!("Claude is running"));
    assert!(d.tmp_entries().is_empty());
}

#[test]
fn what_the_helper_wrote_to_its_copy_never_reaches_claudes_leveldb() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(
        &f,
        Some(Arc::new(|job| {
            fs::write(
                job.storage.join("leveldb").join("CURRENT"),
                "MANIFEST-000002\n",
            )
            .unwrap();
            ok_drafts(&[])
        })),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        draft_events(&f),
        vec!["readDrafts:start", "readDrafts:end", "launch"]
    );
    assert_eq!(
        fs::read_to_string(d.leveldb.join("CURRENT")).unwrap(),
        "MANIFEST-000001\n"
    );
    let names: Vec<String> = fs::read_dir(f.root.join("Local Storage"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["leveldb"]);
    assert_eq!(d.drafts(), vec!["last.json"]);
    assert_eq!(d.last().unwrap()["status"], json!("captured"));
}

#[test]
fn a_failure_deciding_whether_drafts_can_be_read_never_reaches_the_switch() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(&f, None);
    FakeHost::set(
        &f.host.drafts_blocked,
        Arc::new(|_: &FakeHost| Err(DesktopError::new("plutil failed"))),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    let state = f.manager.snapshot().unwrap();
    assert_eq!(state.active_profile_id.as_deref(), Some(b.id.as_str()));
    assert_eq!(state.error, None);
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last().unwrap()["reason"], json!("plutil failed"));
    assert_eq!(draft_events(&f), vec!["launch"]);
}

#[test]
fn no_drafts_are_captured_between_accounts_that_are_not_both_selected() {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None);
    set_transfer(
        &f,
        DesktopHistoryTransfer::Selected,
        Some(vec![a.id.clone()]),
    );
    let d = with_draft_helper(&f, None);
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(b.id.as_str())
    );
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last(), None);
}

#[test]
fn the_draft_helper_runs_on_the_switched_files_after_the_switch_is_complete() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (sink, root, vault) = (Arc::clone(&seen), f.root.clone(), f.vault());
    with_draft_helper(
        &f,
        Some(Arc::new(move |_| {
            sink.lock().unwrap().push((
                read_object(&root, "config.json").unwrap().unwrap()["lastKnownAccountUuid"].clone(),
                read_object(&vault, "journal.json").unwrap().is_some(),
            ));
            ok_drafts(&[])
        })),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(json!(desktop(&b).account_uuid), false)]
    );
}

#[test]
fn a_switch_whose_files_fail_to_apply_runs_no_draft_step() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(&f, None);
    // One write fails (the TS fails `fs.rm` of Cookies-journal; here the write guard refuses it).
    let checks = Arc::new(AtomicU32::new(0));
    let counter = Arc::clone(&checks);
    assert!(
        f.manager
            .switch_to(
                &b.id,
                DesktopSwitchOptions {
                    can_proceed: Some(Arc::new(move || counter.fetch_add(1, Ordering::SeqCst) < 4)),
                    ..Default::default()
                },
            )
            .is_err()
    );
    assert!(checks.load(Ordering::SeqCst) >= 5);
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last(), None);
    // Claude still comes back.
    assert_eq!(draft_events(&f), vec!["launch"]);
}

#[test]
fn saving_an_account_and_syncing_history_never_capture_drafts() {
    let f = Fixture::new();
    f.account("B", None);
    let d = with_draft_helper(&f, None);
    let a = f.account("A", None);
    session(&f.root, &a, None, json!({}));
    f.manager.sync_history(&a.id).unwrap();
    assert_eq!(jobs(&f), 0);
    assert_eq!(d.last(), None);
}

#[test]
fn claude_relaunches_only_after_a_slow_draft_helper_that_then_fails() {
    let f = Fixture::new();
    let b = f.account("B", None);
    f.account("A", None);
    let d = with_draft_helper(
        &f,
        Some(Arc::new(|job| {
            fs::write(job.storage.join("leveldb").join("CURRENT"), "x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(50));
            DraftResult::Failed {
                error: "verification failed".into(),
            }
        })),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        draft_events(&f),
        vec!["readDrafts:start", "readDrafts:end", "launch"]
    );
    assert_eq!(
        fs::read_to_string(d.leveldb.join("CURRENT")).unwrap(),
        "MANIFEST-000001\n"
    );
    assert_eq!(d.last().unwrap()["status"], json!("failed"));
    assert_eq!(d.last().unwrap()["error"], json!("verification failed"));
}

#[test]
fn initialize_removes_the_first_designs_plaintext_backups_and_keeps_the_rest() {
    let f = Fixture::new();
    let drafts = f.vault().join("drafts");
    for stamp in ["2026-10-16T09-08-07-654Z", "2026-10-15T23-00-00-000Z"] {
        fs::create_dir_all(drafts.join(stamp).join("leveldb")).unwrap();
        fs::write(
            drafts.join(stamp).join("leveldb").join("000003.log"),
            "a plaintext draft",
        )
        .unwrap();
    }
    fs::write(drafts.join("last.json"), "{}").unwrap();
    fs::write(drafts.join("pending.bin"), "sealed").unwrap();
    f.manager_with(Arc::clone(&f.host) as Arc<dyn DesktopHost>, None);
    let mut names: Vec<String> = fs::read_dir(&drafts)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["last.json", "pending.bin"]);
    assert_eq!(
        fs::read_to_string(drafts.join("pending.bin")).unwrap(),
        "sealed"
    );
}

// ---------------------------------------------------------------------------------------------
// The shared Desktop reading

/// A host on the fixture's Claude that counts its process checks, each able to wait.
struct Counted {
    running: AtomicU32,
    seems: AtomicU32,
    hold: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    base: Arc<FakeHost>,
    fail_seems: AtomicBool,
}

impl Counted {
    fn wait(&self) {
        let hold = self.hold.lock().unwrap().take();
        if let Some(hold) = hold {
            let _ = hold.recv();
        }
    }
    fn hold_reads(&self) -> impl FnOnce() {
        let (release, wait) = std::sync::mpsc::channel();
        *self.hold.lock().unwrap() = Some(wait);
        move || {
            let _ = release.send(());
        }
    }
}

impl DesktopHost for Counted {
    fn available(&self) -> bool {
        self.base.available()
    }
    fn running(&self) -> DesktopResult<bool> {
        self.running.fetch_add(1, Ordering::SeqCst);
        let running = self.base.running()?;
        self.wait();
        Ok(running)
    }
    fn seems_running(&self) -> DesktopResult<bool> {
        self.seems.fetch_add(1, Ordering::SeqCst);
        if self.fail_seems.load(Ordering::SeqCst) {
            return Err(DesktopError::new("The process list could not be read."));
        }
        let running = self.base.running()?;
        self.wait();
        Ok(running)
    }
    fn quit(&self, guard: Option<&relay_core::desktop::AnswerGuard>) -> DesktopResult<()> {
        self.base.quit(guard)
    }
    fn launch(&self, options: Option<LaunchOptions>) -> DesktopResult<()> {
        self.base.launch(options)
    }
    fn seal(&self, data: &str) -> DesktopResult<Vec<u8>> {
        self.base.seal(data)
    }
    fn unseal(&self, data: &[u8]) -> DesktopResult<String> {
        self.base.unseal(data)
    }
    fn draft_scratch_dir(&self) -> Option<std::path::PathBuf> {
        self.base.draft_scratch_dir()
    }
}

struct CountedManager {
    manager: Arc<DesktopManager>,
    clock: Arc<std::sync::atomic::AtomicI64>,
    host: Arc<Counted>,
}

fn counted(f: &Fixture) -> CountedManager {
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(1_000_000));
    let host = Arc::new(Counted {
        running: AtomicU32::new(0),
        seems: AtomicU32::new(0),
        hold: Mutex::new(None),
        base: Arc::clone(&f.host),
        fail_seems: AtomicBool::new(false),
    });
    let now = Arc::clone(&clock);
    let manager = f.manager_with(
        Arc::clone(&host) as Arc<dyn DesktopHost>,
        Some(Arc::new(move || now.load(Ordering::SeqCst))),
    );
    CountedManager {
        manager,
        clock,
        host,
    }
}

fn checks(c: &CountedManager) -> (u32, u32) {
    (
        c.host.running.load(Ordering::SeqCst),
        c.host.seems.load(Ordering::SeqCst),
    )
}

#[test]
fn concurrent_observers_share_one_desktop_read_reused_for_a_short_while() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let c = counted(&f);
    let release = c.host_release();
    let readers: Vec<_> = (0..3)
        .map(|_| {
            let manager = Arc::clone(&c.manager);
            std::thread::spawn(move || manager.cached_snapshot())
        })
        .collect();
    while checks(&c).1 == 0 {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    std::thread::sleep(std::time::Duration::from_millis(20));
    release();
    for reader in readers {
        assert_eq!(
            reader.join().unwrap().unwrap().active_profile_id.as_deref(),
            Some(a.id.as_str())
        );
    }
    assert_eq!(checks(&c), (0, 1));
    c.clock.fetch_add(DESKTOP_CACHE_MS - 1, Ordering::SeqCst);
    c.manager.cached_snapshot().unwrap();
    assert_eq!(checks(&c).1, 1);
    c.clock.fetch_add(1, Ordering::SeqCst);
    c.manager.cached_snapshot().unwrap();
    assert_eq!(checks(&c).1, 2);
}

impl CountedManager {
    fn host_release(&self) -> impl FnOnce() {
        self.host.hold_reads()
    }
}

#[test]
fn decisions_read_desktop_fresh_and_every_desktop_operation_drops_the_shared_reading() {
    let f = Fixture::new();
    f.account("A", None);
    let c = counted(&f);
    c.manager.snapshot().unwrap();
    c.manager.snapshot().unwrap();
    assert_eq!(checks(&c), (2, 0));
    f.set_running(false);
    assert!(c.manager.cached_snapshot().unwrap().running);
    c.manager.open().unwrap();
    assert!(c.manager.cached_snapshot().unwrap().running);
    assert_eq!(checks(&c).1, 1);
    f.set_running(false);
    c.manager.recover().unwrap();
    assert!(!c.manager.cached_snapshot().unwrap().running);
    assert_eq!(checks(&c).1, 2);
}

#[test]
fn a_read_that_began_before_a_desktop_operation_is_not_kept_for_later_observers() {
    let f = Fixture::new();
    f.account("A", None);
    let c = counted(&f);
    let release = c.host_release();
    let manager = Arc::clone(&c.manager);
    let early = std::thread::spawn(move || manager.cached_snapshot());
    while checks(&c).1 == 0 {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    f.set_running(false);
    c.manager.open().unwrap();
    release();
    early.join().unwrap().unwrap();
    assert!(c.manager.cached_snapshot().unwrap().running);
    assert_eq!(checks(&c).1, 2);
}

#[test]
fn a_failed_desktop_read_is_not_kept_the_next_observer_reads_again() {
    let f = Fixture::new();
    f.account("A", None);
    let c = counted(&f);
    c.host.fail_seems.store(true, Ordering::SeqCst);
    err_contains(c.manager.cached_snapshot(), "process list");
    c.host.fail_seems.store(false, Ordering::SeqCst);
    assert!(c.manager.cached_snapshot().unwrap().running);
    assert_eq!(checks(&c).1, 2);
}

struct RecordingLock(Arc<Mutex<Vec<String>>>);

impl OperationLock for RecordingLock {
    fn ensure(&self, kind: DesktopOperationKind) -> DesktopResult<Box<dyn FnOnce() + Send>> {
        self.0.lock().unwrap().push(format!("+{}", kind.as_str()));
        let calls = Arc::clone(&self.0);
        Ok(Box::new(move || {
            calls.lock().unwrap().push(format!("-{}", kind.as_str()))
        }))
    }
}

struct BusyLock;

impl OperationLock for BusyLock {
    fn ensure(&self, _kind: DesktopOperationKind) -> DesktopResult<Box<dyn FnOnce() + Send>> {
        Err(DesktopError::LockBusy(
            "Relay (a terminal) is busy with switch".into(),
        ))
    }
}

#[test]
fn every_desktop_operation_ensures_the_operation_lock_and_releases_it_even_when_it_fails() {
    let f = Fixture::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let lock = Arc::new(RecordingLock(Arc::clone(&calls)));
    f.manager.configure(|h| h.operation_lock = Some(lock));
    let a = f.account("A", None);
    let b = f.account("B", None);
    calls.lock().unwrap().clear();
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.set_fail_quit();
    assert!(f.manager.switch_to(&b.id, Default::default()).is_err());
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["+switch", "-switch", "+switch", "-switch"]
    );
}

#[test]
fn a_busy_operation_lock_refuses_before_claude_is_quit() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    let quits = f.quits();
    f.manager
        .configure(|h| h.operation_lock = Some(Arc::new(BusyLock)));
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "busy with switch",
    );
    assert_eq!(f.quits(), quits);
    assert!(!f.manager.is_busy());
}

#[test]
fn a_sign_in_begun_by_another_manager_on_the_same_vault_is_seen() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    let other_store = Arc::new(Store::open(f.store.root(), StoreOptions::default()).unwrap());
    let other = DesktopManager::new(
        &f.root,
        Arc::clone(&other_store),
        Arc::clone(&f.host) as Arc<dyn DesktopHost>,
        Some(f.transcript_root.clone()),
        None,
    );
    other.initialize().unwrap();
    let c = other_store
        .create(&relay_core::shared::types::CreateAccount {
            name: "C".into(),
            kind: relay_core::shared::types::AccountKind::Personal,
            group: None,
            provider: None,
        })
        .unwrap();
    other.begin_login(&c.id).unwrap();
    assert_eq!(
        f.manager.snapshot().unwrap().pending_profile_id.as_deref(),
        Some(c.id.as_str())
    );
    err_contains(
        f.manager.switch_to(&a.id, Default::default()),
        "Finish or cancel",
    );
    other.cancel_login().unwrap();
    assert_eq!(f.manager.snapshot().unwrap().pending_profile_id, None);
}

#[test]
fn carried_count_reports_the_conversations_the_switch_wrote_into_the_target() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    session(&f.root, &b, None, json!({}));
    session(&f.root, &b, None, json!({}));
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(f.manager.carried_count(), 2);
}

// ---------------------------------------------------------------------------------------------
// The sidebar offer

/// Local Storage keys and their raw values.
type Keys = Vec<(String, String)>;
/// An account and its sidebar groups: each a name and its sessions.
type ScopeGroups<'a> = (&'a Account, Vec<(&'a str, Vec<String>)>);

fn sidebar_keys(scopes: &[ScopeGroups<'_>], starred: &[String]) -> Keys {
    let mut groups = Map::new();
    let mut sections = Map::new();
    for (account, list) in scopes {
        let key = format!(
            "{}/{}",
            desktop(account).account_uuid,
            desktop(account).org_id
        );
        let ids: Vec<String> = list.iter().map(|_| format!("cg-{}", uuid())).collect();
        let mut assignments = Map::new();
        for (i, (_, members)) in list.iter().enumerate() {
            for m in members {
                assignments.insert(format!("code:local_{m}"), json!(ids[i]));
            }
        }
        groups.insert(
            key.clone(),
            json!({
                "groups": list.iter().enumerate().map(|(i, (name, _))| json!({ "id": ids[i], "name": name })).collect::<Vec<_>>(),
                "assignments": assignments,
                "order": {},
            }),
        );
        let mut list_sections =
            vec![json!({ "id": "pinned", "kind": "pinned", "v": 2, "name": "", "order": 0 })];
        for (i, (name, _)) in list.iter().enumerate() {
            list_sections.push(
                json!({ "id": ids[i], "kind": "manual", "v": 2, "name": name, "order": 1 + i }),
            );
        }
        list_sections.push(json!({ "id": "sessions", "kind": "sessions", "v": 2, "name": "", "order": 99, "groupBy": "folder" }));
        sections.insert(
            key,
            json!({ "sections": list_sections, "migratedFrom": 1, "prefsSeeded": true }),
        );
    }
    vec![
        (
            "dframe-store".to_string(),
            json!({ "state": { "customGroupsByScope": groups, "codeSidebarByScope": sections }, "version": 1, "shared": 1 }).to_string(),
        ),
        (
            "LSS-persisted.starred-local-code-sessions".to_string(),
            json!({ "value": starred.iter().map(|a| format!("local_{a}")).collect::<Vec<_>>(), "tabId": "", "timestamp": 1 }).to_string(),
        ),
    ]
}

struct SidebarSwitch {
    f: Fixture,
    a: Account,
    b: Account,
    x: String,
    y: String,
    events: Events,
    sidebar: Arc<Mutex<Option<Keys>>>,
}

impl SidebarSwitch {
    fn sidebar_events(&self) -> Vec<Map<String, Value>> {
        events_of(&self.events, "sidebar")
            .into_iter()
            .map(Option::unwrap)
            .collect()
    }
}

/// A switch from A, open in Claude, to B: A filed two sessions in "relay" and has an empty
/// "landing"; B has none of it. `x` is on both accounts, `y` only on A.
fn sidebar_switch(pin_y: bool) -> SidebarSwitch {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None);
    let (x, y) = (uuid(), uuid());
    session(&f.root, &a, Some(&x), json!({ "lastActivityAt": 200 }));
    session(&f.root, &b, Some(&x), json!({ "lastActivityAt": 100 }));
    session(&f.root, &a, Some(&y), json!({ "lastActivityAt": 300 }));
    let starred = if pin_y { vec![y.clone()] } else { Vec::new() };
    let sidebar = Arc::new(Mutex::new(Some(sidebar_keys(
        &[(
            &a,
            vec![("relay", vec![x.clone(), y.clone()]), ("landing", vec![])],
        )],
        &starred,
    ))));
    let source = Arc::clone(&sidebar);
    with_draft_helper(
        &f,
        Some(Arc::new(move |_| DraftResult::Ok {
            drafts: JsMap::new(),
            sidebar: source.lock().unwrap().as_ref().map(|keys| {
                let mut map = JsMap::new();
                for (k, v) in keys {
                    map.insert(k.clone(), v.clone());
                }
                map
            }),
        })),
    );
    let events = record_events(&f);
    SidebarSwitch {
        f,
        a,
        b,
        x,
        y,
        events,
        sidebar,
    }
}

#[test]
fn an_a_b_switch_offers_the_sidebar_sections_b_lacks_with_a_recipe_only_main_can_read() {
    let s = sidebar_switch(false);
    let f = &s.f;
    f.manager.switch_to(&s.b.id, Default::default()).unwrap();
    let gap = f.manager.sidebar_gap().unwrap();
    assert_eq!(gap.id.len(), 36);
    assert_eq!(gap.to, "B");
    assert_eq!(gap.from, vec!["A"]);
    assert_eq!(gap.missing_sections, 2.0);
    assert_eq!(gap.sessions, 2.0);
    let recipe = f.manager.sidebar_recipe(&gap.id).unwrap();
    assert!(recipe.contains("on this account (B). They come from A,"));
    assert!(recipe.contains(&format!("### relay\n\nlocal_{} local_{}\n", s.x, s.y)));
    assert!(recipe.contains("### landing"));
    assert_eq!(f.manager.sidebar_recipe(&uuid()), None);
    assert_eq!(
        s.sidebar_events(),
        vec![
            fields(json!({
                "from": desktop(&s.a).account_uuid[..8],
                "to": desktop(&s.b).account_uuid[..8],
                "status": "planned",
                "sections": 2,
                "missing": 2,
                "sessions": 2,
            }))
            .unwrap()
        ]
    );
    let vault_file = f.vault().join("sidebar").join("pending.json");
    assert!(fs::read_to_string(vault_file).unwrap().contains(&s.y));
    f.manager.dismiss_sidebar_gap(&gap.id).unwrap();
    assert_eq!(f.manager.sidebar_gap(), None);
}

#[test]
fn a_pinned_session_is_left_out_of_the_recipe_moving_it_would_unpin_it_on_every_account() {
    let s = sidebar_switch(true);
    s.f.manager.switch_to(&s.b.id, Default::default()).unwrap();
    let gap = s.f.manager.sidebar_gap().unwrap();
    assert_eq!(gap.sessions, 1.0);
    let recipe = s.f.manager.sidebar_recipe(&gap.id).unwrap();
    assert!(recipe.contains(&format!("local_{}", s.x)));
    assert!(!recipe.contains(&s.y));
}

#[test]
fn the_offer_shows_only_while_desktop_is_on_the_account_it_was_made_for() {
    let s = sidebar_switch(false);
    let f = &s.f;
    f.manager.switch_to(&s.b.id, Default::default()).unwrap();
    assert!(f.manager.sidebar_gap().is_some());
    let mut config = obj(&f.root, "config.json").unwrap();
    config.insert(
        "lastKnownAccountUuid".into(),
        json!(desktop(&s.a).account_uuid),
    );
    write_bytes(&f.root, "config.json", Some(&json_bytes(&config))).unwrap();
    assert_eq!(f.manager.sidebar_gap(), None);
}

#[test]
fn each_switch_replaces_the_offer_no_sidebar_read_or_a_format_relay_does_not_know_offers_nothing() {
    let s = sidebar_switch(false);
    let f = &s.f;
    f.manager.switch_to(&s.b.id, Default::default()).unwrap();
    assert!(f.manager.sidebar_gap().is_some());
    *s.sidebar.lock().unwrap() = None;
    f.manager.switch_to(&s.a.id, Default::default()).unwrap();
    f.manager.switch_to(&s.b.id, Default::default()).unwrap();
    assert_eq!(f.manager.sidebar_gap(), None);
    *s.sidebar.lock().unwrap() = Some(vec![(
        "dframe-store".into(),
        json!({ "state": {}, "version": 7 }).to_string(),
    )]);
    f.manager.switch_to(&s.a.id, Default::default()).unwrap();
    assert_eq!(f.manager.sidebar_gap(), None);
    let events = s.sidebar_events();
    assert_eq!(
        events
            .iter()
            .map(|e| e["status"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!("planned"),
            json!("not-read"),
            json!("not-read"),
            json!("unsupported")
        ]
    );
    assert_eq!(
        events[3]["reason"],
        json!("unsupported Desktop sidebar format: dframe-store version")
    );
}

#[test]
fn with_history_transfer_off_a_switch_offers_no_sidebar_and_drops_the_last_offer() {
    let s = sidebar_switch(false);
    let f = &s.f;
    f.manager.switch_to(&s.b.id, Default::default()).unwrap();
    assert!(f.manager.sidebar_gap().is_some());
    set_transfer(f, DesktopHistoryTransfer::Off, None);
    f.manager.switch_to(&s.a.id, Default::default()).unwrap();
    f.manager.switch_to(&s.b.id, Default::default()).unwrap();
    assert_eq!(f.manager.sidebar_gap(), None);
    assert_eq!(s.sidebar_events().len(), 1);
}

#[test]
fn a_sidebar_in_a_format_relay_does_not_know_costs_the_drafts_nothing() {
    let f = Fixture::new();
    let b = f.account("B", None);
    let a = f.account("A", None);
    let shared = uuid();
    session(&f.root, &a, Some(&shared), json!({ "lastActivityAt": 300 }));
    session(&f.root, &b, Some(&shared), json!({ "lastActivityAt": 100 }));
    let owner = desktop(&a).account_uuid.clone();
    let key = format!("{CONVERSATION_DRAFT_PREFIX}{shared}");
    let d = with_draft_helper(
        &f,
        Some(Arc::new(move |_| {
            let mut drafts = JsMap::new();
            drafts.insert(key.clone(), draft_of(&owner, UNSENT, &[]));
            let mut sidebar = JsMap::new();
            sidebar.insert("dframe-store", "{not json".to_string());
            DraftResult::Ok {
                drafts,
                sidebar: Some(sidebar),
            }
        })),
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(f.manager.pending_draft_records().len(), 1);
    assert_eq!(d.last().unwrap()["status"], json!("captured"));
    assert_eq!(f.manager.sidebar_gap(), None);
}

// ---------------------------------------------------------------------------------------------
// Watched launches

struct Choice {
    quic_off: AtomicBool,
    learned: AtomicU32,
}

impl LaunchChoice for Choice {
    fn quic_off(&self) -> DesktopResult<bool> {
        Ok(self.quic_off.load(Ordering::SeqCst))
    }
    fn learn_quic_off(&self) -> DesktopResult<()> {
        self.learned.fetch_add(1, Ordering::SeqCst);
        self.quic_off.store(true, Ordering::SeqCst);
        Ok(())
    }
}

struct FakeWatch {
    outcome: PageOutcome,
    host: std::sync::Weak<FakeHost>,
}

impl LaunchWatch for FakeWatch {
    fn wait(&self, timeout_ms: i64) -> PageOutcome {
        assert_eq!(timeout_ms, PAGE_BOOT_MS);
        if let Some(host) = self.host.upgrade() {
            host.st()
                .order
                .push(format!("wait:{}", self.outcome.as_str()));
        }
        self.outcome
    }
}

struct Watched {
    events: Events,
    choice: Arc<Choice>,
    watches: Arc<AtomicU32>,
}

impl Watched {
    fn boot(&self) -> Vec<(String, Map<String, Value>)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e.starts_with("claude-boot") || e == "claude-quic-off")
            .map(|(e, fields)| {
                let mut fields = fields.clone().unwrap_or_default();
                let waited = fields.shift_remove("waitedMs");
                if e == "claude-boot" {
                    assert!(waited.is_some_and(|w| w.is_number()));
                }
                (e.clone(), fields)
            })
            .collect()
    }
    fn learned(&self) -> u32 {
        self.choice.learned.load(Ordering::SeqCst)
    }
}

fn boot(event: &str, value: Value) -> (String, Map<String, Value>) {
    (event.to_string(), value.as_object().unwrap().clone())
}

/// A host whose launches are watched: each watch reports the next of `outcomes`, and none is
/// given once they run out. The host's record starts over here.
fn watch_launches(f: &Fixture, outcomes: Vec<PageOutcome>, quic_off: bool) -> Watched {
    let events = record_events(f);
    let choice = Arc::new(Choice {
        quic_off: AtomicBool::new(quic_off),
        learned: AtomicU32::new(0),
    });
    let launch_choice = Arc::clone(&choice);
    f.manager
        .configure(|h| h.launch_choice = Some(launch_choice));
    {
        let mut st = f.host.st();
        st.order.clear();
        st.launches.clear();
    }
    let watches = Arc::new(AtomicU32::new(0));
    let (count, weak) = (Arc::clone(&watches), Arc::downgrade(&f.host));
    FakeHost::set(
        &f.host.watch_launch,
        Arc::new(move |host: &FakeHost| {
            let index = count.fetch_add(1, Ordering::SeqCst) as usize;
            host.st().order.push("watch".into());
            outcomes.get(index).map(|&outcome| {
                Box::new(FakeWatch {
                    outcome,
                    host: weak.clone(),
                }) as Box<dyn LaunchWatch>
            })
        }),
    );
    Watched {
        events,
        choice,
        watches,
    }
}

fn order(f: &Fixture) -> Vec<String> {
    f.host.st().order.clone()
}

#[test]
fn a_switch_waits_for_claudes_page_to_boot_and_restarts_nothing_more_when_it_does() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    f.set_running(true);
    let w = watch_launches(&f, vec![PageOutcome::Loaded], false);
    let ended = Arc::new(AtomicU32::new(0));
    let count = Arc::clone(&ended);
    f.manager.configure(|h| {
        h.on_switched = Some(Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }))
    });
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(order(&f), vec!["quit", "watch", "launch", "wait:loaded"]);
    assert_eq!(
        f.host.st().launches,
        vec![None],
        "a plain start, as Claude starts by itself"
    );
    assert_eq!(
        w.boot(),
        vec![boot(
            "claude-boot",
            json!({ "attempt": 1, "outcome": "loaded", "quicOff": false })
        )]
    );
    assert_eq!(ended.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    assert_eq!(w.watches.load(Ordering::SeqCst), 1);
}

#[test]
fn a_stuck_page_is_started_once_more_without_http3_and_http3_stays_off_when_that_loads() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.set_running(true);
    let restarts = record_restarts(&f);
    let w = watch_launches(
        &f,
        vec![
            PageOutcome::Stalled,
            PageOutcome::Loaded,
            PageOutcome::Loaded,
        ],
        false,
    );
    let busy = Arc::new(Mutex::new(Vec::new()));
    let (sink, manager) = (Arc::clone(&busy), Arc::downgrade(&f.manager));
    f.manager.configure(|h| {
        h.on_switched = Some(Arc::new(move || {
            sink.lock()
                .unwrap()
                .push(manager.upgrade().unwrap().is_busy())
        }))
    });
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        order(&f),
        vec![
            "quit",
            "watch",
            "launch",
            "wait:stalled",
            "quit",
            "watch",
            "launch:quic-off",
            "wait:loaded"
        ]
    );
    assert_eq!(
        w.boot(),
        vec![
            boot(
                "claude-boot",
                json!({ "attempt": 1, "outcome": "stalled", "quicOff": false })
            ),
            boot("claude-boot-retry", json!({ "quit": true })),
            boot(
                "claude-boot",
                json!({ "attempt": 2, "outcome": "loaded", "quicOff": true })
            ),
            boot("claude-quic-off", json!({ "learned": true })),
        ]
    );
    assert_eq!(w.learned(), 1);
    let restarts = restarts.lock().unwrap().clone();
    assert_eq!(restarts.len(), 2);
    assert!(matches!(restarts[0], DesktopRestartEvent::Start { .. }));
    assert!(matches!(
        restarts[1],
        DesktopRestartEvent::End { ok: true, .. }
    ));
    assert_eq!(*busy.lock().unwrap(), vec![false]);
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        order(&f)[8..],
        ["quit", "watch", "launch:quic-off", "wait:loaded"]
    );
    assert_eq!(w.learned(), 1);
}

#[test]
fn a_second_start_that_sticks_too_is_left_alone_learns_nothing_and_is_never_followed_by_a_third() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    f.set_running(true);
    let w = watch_launches(&f, vec![PageOutcome::Stalled, PageOutcome::Stalled], false);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        order(&f),
        vec![
            "quit",
            "watch",
            "launch",
            "wait:stalled",
            "quit",
            "watch",
            "launch:quic-off",
            "wait:stalled"
        ]
    );
    assert_eq!(w.learned(), 0);
    assert_eq!(w.boot().last().unwrap().0, "claude-boot");
}

#[test]
fn with_http3_already_off_every_start_goes_without_it_and_nothing_more_is_learned() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    f.set_running(true);
    let w = watch_launches(&f, vec![PageOutcome::Stalled, PageOutcome::Loaded], true);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        order(&f),
        vec![
            "quit",
            "watch",
            "launch:quic-off",
            "wait:stalled",
            "quit",
            "watch",
            "launch:quic-off",
            "wait:loaded"
        ]
    );
    assert_eq!(w.learned(), 0);
}

#[test]
fn a_page_relay_cannot_tell_about_or_a_claude_quit_meanwhile_is_left_alone() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.set_running(true);
    watch_launches(&f, vec![PageOutcome::Unknown, PageOutcome::Closed], false);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        order(&f),
        vec![
            "quit",
            "watch",
            "launch",
            "wait:unknown",
            "quit",
            "watch",
            "launch",
            "wait:closed"
        ]
    );
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(order(&f)[8..], ["quit", "watch", "launch"]);
}

#[test]
fn a_stuck_claude_that_will_not_quit_leaves_the_switch_done_and_claude_as_it_is() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    f.set_running(true);
    let starts = f.starts();
    let w = watch_launches(&f, vec![PageOutcome::Stalled], false);
    // The first quit is the switch's own; the retry's is refused.
    let quits = f.quits();
    FakeHost::set(
        &f.host.quit_hook,
        Arc::new(move |n: u32| {
            if n == quits + 2 {
                Err(DesktopError::new("Claude Desktop did not close."))
            } else {
                Ok(())
            }
        }),
    );
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        w.boot(),
        vec![
            boot(
                "claude-boot",
                json!({ "attempt": 1, "outcome": "stalled", "quicOff": false })
            ),
            boot("claude-boot-retry", json!({ "quit": false })),
        ]
    );
    assert_eq!(f.starts(), starts + 1, "only the switch's own launch");
    let state = f.manager.snapshot().unwrap();
    assert_eq!(state.active_profile_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(state.error, None);
}

struct PanickyWatch;

impl LaunchWatch for PanickyWatch {
    fn wait(&self, _timeout_ms: i64) -> PageOutcome {
        panic!("read failed")
    }
}

#[test]
fn a_watch_that_throws_is_as_good_as_none() {
    let f = Fixture::new();
    let a = f.account("A", None);
    f.account("B", None);
    f.set_running(true);
    let starts = f.starts();
    // A log that cannot be read gives no watch (the host's `watch_launch` cannot fail).
    FakeHost::set(&f.host.watch_launch, Arc::new(|_: &FakeHost| None));
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(f.starts(), starts + 1);
    FakeHost::set(
        &f.host.watch_launch,
        Arc::new(|_: &FakeHost| Some(Box::new(PanickyWatch) as Box<dyn LaunchWatch>)),
    );
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(f.starts(), starts + 2);
}

#[test]
fn a_start_without_http3_that_claude_refuses_is_followed_at_once_by_a_plain_one() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.set_running(true);
    let w = watch_launches(&f, vec![PageOutcome::Refused, PageOutcome::Loaded], true);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    let launches: Vec<String> = order(&f)
        .into_iter()
        .filter(|o| o.starts_with("launch"))
        .collect();
    assert_eq!(launches, vec!["launch:quic-off", "launch"]);
    assert_eq!(
        events_of(&w.events, "claude-boot-refused"),
        vec![fields(json!({ "attempt": 1, "quicOff": true }))]
    );
    watch_launches(&f, vec![PageOutcome::Refused], false);
    let starts = f.starts();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(f.starts(), starts + 1);
    let launches: Vec<String> = order(&f)
        .into_iter()
        .filter(|o| o.starts_with("launch"))
        .collect();
    assert_eq!(launches, vec!["launch"]);
}

#[test]
fn opening_the_claude_app_keeps_http3_off_when_relay_keeps_it_off() {
    let f = Fixture::new();
    watch_launches(&f, vec![], true);
    f.manager.open().unwrap();
    assert_eq!(
        f.host.st().launches,
        vec![Some(LaunchOptions { quic_off: true })]
    );
    watch_launches(&f, vec![], false);
    f.manager.open().unwrap();
    assert_eq!(f.host.st().launches, vec![None]);
}

#[test]
fn recovery_waits_for_claudes_page_and_restarts_a_stuck_one_too() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let before = fs::read(f.root.join("config.json")).unwrap();
    let backup = uuid();
    let sealed = test_seal(
        &json!({ "files": { "config.json": base64_of(&before) }, "createdAt": "2026-11-26T00:00:00.000Z" })
            .to_string(),
    );
    write_bytes(&f.vault(), &format!("backups/{backup}.bin"), Some(&sealed)).unwrap();
    write_bytes(
        &f.vault(),
        "journal.json",
        Some(&json_bytes(&json!({ "backup": backup }))),
    )
    .unwrap();
    f.set_running(true);
    watch_launches(&f, vec![PageOutcome::Stalled], false);
    f.manager.recover().unwrap();
    assert_eq!(
        order(&f),
        vec![
            "quit",
            "watch",
            "launch",
            "wait:stalled",
            "quit",
            "watch",
            "launch:quic-off"
        ]
    );
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
}

#[test]
fn a_profile_saved_in_the_wrong_workspace_moves_to_the_one_its_usage_sign_in_names_without_restarting_claude()
 {
    let f = Fixture::new();
    let a = f.account("A", None);
    let wrong = desktop(&a).org_id.clone();
    let right = uuid();
    let sign_in = |org: &str, account: &str| {
        let mut value = auth(account, org, None);
        value.checked_at = String::new();
        set_auth(&f, &a.id, value);
    };
    let quits = f.quits();
    sign_in(&right, &desktop(&a).account_uuid);
    assert!(!f.manager.rebind_org(&a.id, &right).unwrap());
    assert_eq!(
        f.store.account(&a.id).unwrap().desktop.unwrap().org_id,
        wrong
    );
    fs::create_dir_all(
        f.root
            .join("claude-code-sessions")
            .join(&desktop(&a).account_uuid)
            .join(&right),
    )
    .unwrap();
    assert!(f.manager.rebind_org(&a.id, &right.to_uppercase()).unwrap());
    let saved = f.store.account(&a.id).unwrap().desktop.unwrap();
    assert_eq!(saved.org_id, right);
    assert_eq!(saved.account_uuid, desktop(&a).account_uuid);
    assert_eq!(f.quits(), quits);
    assert_eq!(
        f.manager.snapshot().unwrap().active_profile_id.as_deref(),
        Some(a.id.as_str())
    );
    assert!(!f.manager.rebind_org(&a.id, &right).unwrap());
    assert!(!f.manager.rebind_org(&a.id, &wrong).unwrap());
    sign_in(&wrong, &uuid());
    assert!(!f.manager.rebind_org(&a.id, &wrong).unwrap());
    assert_eq!(
        f.store.account(&a.id).unwrap().desktop.unwrap().org_id,
        right
    );
}

#[test]
fn conversations_claude_runs_over_ssh_travel_like_local_ones_by_their_remote_folder() {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    let ssh = json!({ "sshHost": "user@remote.example", "sshPort": 22, "sshIdentityFile": "/home/user/.ssh/id" });
    let (remote, _) = session(
        &f.root,
        &a,
        None,
        json!({ "cwd": "D:\\projects\\app", "originCwd": "D:\\projects\\app", "sshConfig": ssh }),
    );
    session(
        &f.root,
        &b,
        None,
        json!({ "cliSessionId": remote, "cwd": "D:\\projects\\app", "sshConfig": ssh, "lastActivityAt": 1 }),
    );
    session(&f.root, &a, None, json!({ "cwd": "relative\\folder" }));
    let writes = plan(&f.root, &b, &[&a]);
    let target = scope_dir("claude-code-sessions", &b);
    let written: Vec<(&String, &Vec<u8>)> = writes
        .iter()
        .filter_map(|(file, bytes)| Some((file, bytes.as_ref()?)))
        .filter(|(file, _)| file.starts_with(&target))
        .collect();
    assert_eq!(written.len(), 1);
    assert_eq!(*written[0].0, format!("{target}/local_{remote}.json"));
    let carried: Value = serde_json::from_slice(written[0].1).unwrap();
    assert_eq!(carried["cwd"], json!("D:\\projects\\app"));
    assert_eq!(carried["sshConfig"], ssh);
    assert_eq!(writes.values().filter(|bytes| bytes.is_none()).count(), 1);
}

#[test]
fn the_fake_host_seals_as_the_ts_one_does() {
    // `Buffer.from("TEST-ENCRYPTED:" + base64(text))`, opened back by the fixture.
    assert_eq!(helpers::test_unseal(&test_seal("ş")), "ş");
    let real = Fixture::with(Sealing::Real(Arc::new(
        relay_core::vault_crypto::Sealer::new(&[5u8; 32]).unwrap(),
    )));
    let a = real.account("A", None);
    let sealed = read_bytes(
        &real.vault(),
        &format!("accounts/{}.bin", desktop(&a).account_uuid),
    )
    .unwrap()
    .unwrap();
    assert!(relay_core::vault_crypto::is_sealed_v2(&sealed));
}
