//! Port of `tests/draft-ipc.test.ts`: backend cases of the scheduler, the panel's draft actions
//! and the notification.
//!
//! Skipped (source text of `electron/main/**`, `electron/preload.ts` or `shared/types.ts`):
//! "granting accessibility, or coming back to Relay with it granted, retries the drafts left
//! for Copy", "main gives the scheduler the re-typing setting, off unless turned on, and a
//! change of it runs a pass", "the accessibility request asks only while a feature that needs
//! it is on", "the quit notice addresses the user as sen", "every switch schedules a restore
//! through one hook, on the Desktop lock", "main runs every Desktop operation on one lock, and a
//! restore record refuses none of the user's actions", "no IPC handler returns draft text",
//! "the sidebar recipe is copied in main: the renderer sends an offer id and gets nothing back".
//! Ported without their `mainSource()` tail: "the snapshot carries draft summaries without
//! text", "the restore notification counts drafts and never names them".

#[path = "common/desktop.rs"]
mod desktop;
#[path = "common/fleet_drafts.rs"]
mod helpers;

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use helpers::*;
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationGuard, DesktopAutomationIssue, DesktopAutomationSnapshot,
    DesktopDraftGuard, DesktopHostError, DesktopSendResult, OpenSessionOptions, WriteDraftOptions,
};
use relay_core::draft_diagnostics::DraftLog;
use relay_core::draft_main::{
    DraftActions, DraftActionsDeps, DraftScheduler, DraftSchedulerDeps, DraftSource, RestoreFn,
    StallRun, StallTally, draft_actions, draft_notice, draft_retype_enabled, draft_summaries,
    tally_stalls,
};
use relay_core::draft_restorer::{DraftCounts, RestoreResult, RestoreStatus, RestorerDeps};
use relay_core::draft_vault::{DraftRecord, DraftState, DraftSummary, DraftVault, DraftVaultHooks};
use relay_core::drafts::CapturedDraft;
use relay_i18n::Locale;
use serde_json::{Value, json};

const ALIAS: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEXT: &str = "an unsent draft, word for word";
const NEW_TEXT: &str = "a new start, also unsent";
const DRAFT_ID: &str = "11111111-1111-4111-8111-111111111111";

/// A real DesktopManager whose sealed vault holds a conversation draft and a new-session one.
struct VaultFixture {
    fixture: desktop::Fixture,
    records: Vec<DraftRecord>,
}

fn vault_fixture() -> VaultFixture {
    let fixture = desktop::Fixture::new();
    let vault = DraftVault::new(
        fixture.vault(),
        Arc::new(|s: &str| Ok(desktop::test_seal(s))),
        Arc::new(|b: &[u8]| Ok(desktop::test_unseal(b))),
        None,
        DraftVaultHooks::default(),
    );
    vault
        .add(
            ACCOUNT,
            &[
                CapturedDraft {
                    target_alias: Some(ALIAS.into()),
                    new_session: None,
                    title: "Fix login".into(),
                    text: TEXT.into(),
                    attachments: false,
                },
                CapturedDraft {
                    target_alias: None,
                    new_session: Some(true),
                    title: String::new(),
                    text: NEW_TEXT.into(),
                    attachments: true,
                },
            ],
            None,
        )
        .unwrap();
    let records = fixture.manager.pending_draft_records();
    assert_eq!(records.len(), 2);
    VaultFixture { fixture, records }
}

impl VaultFixture {
    fn source(&self) -> Arc<dyn DraftSource> {
        Arc::clone(&self.fixture.manager) as Arc<dyn DraftSource>
    }
    fn mark(&self, id: &str, state: DraftState, reason: Option<&str>) {
        self.fixture
            .manager
            .mark_draft(id, state, reason.map(str::to_owned))
            .unwrap();
    }
}

fn actions(
    drafts: Arc<dyn DraftSource>,
    write: impl Fn(&str) -> Result<(), String> + Send + Sync + 'static,
    changed: impl Fn() + Send + Sync + 'static,
    log: Option<Arc<DraftLog>>,
) -> DraftActions {
    draft_actions(DraftActionsDeps {
        drafts,
        write_clipboard: Box::new(write),
        changed: Box::new(changed),
        log,
    })
}

type Clipboard = Arc<Mutex<Vec<String>>>;
fn clipboard() -> (
    Clipboard,
    impl Fn(&str) -> Result<(), String> + Send + Sync + 'static,
) {
    let kept: Clipboard = Arc::default();
    let sink = Arc::clone(&kept);
    (kept, move |text: &str| {
        sink.lock().unwrap().push(text.into());
        Ok(())
    })
}
fn counter() -> (Arc<AtomicUsize>, impl Fn() + Send + Sync + 'static) {
    let count = Arc::new(AtomicUsize::new(0));
    let sink = Arc::clone(&count);
    (count, move || {
        sink.fetch_add(1, Ordering::SeqCst);
    })
}
fn count(c: &AtomicUsize) -> usize {
    c.load(Ordering::SeqCst)
}

#[test]
fn the_snapshot_carries_draft_summaries_without_text() {
    let f = vault_fixture();
    let drafts = draft_summaries(&*f.fixture.manager);
    assert_eq!(
        drafts
            .iter()
            .map(|d| (d.id.clone(), d.title.clone(), d.state))
            .collect::<Vec<_>>(),
        f.records
            .iter()
            .map(|r| (r.id.clone(), r.title.clone(), DraftState::Pending))
            .collect::<Vec<_>>()
    );
    let serialized =
        serde_json::to_string(&json!({ "accounts": [], "warnings": [], "drafts": drafts }))
            .unwrap();
    assert!(!serialized.contains(TEXT));
    assert!(!serialized.contains(NEW_TEXT));
    assert!(
        serde_json::to_value(&drafts)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d.get("text").is_none())
    );
    // A vault that cannot be read shows no drafts rather than failing the snapshot.
    struct Failing;
    impl DraftSource for Failing {
        fn pending_drafts(&self) -> Result<Vec<DraftSummary>, String> {
            Err("EIO".into())
        }
        fn draft_text(&self, _: &str) -> Result<Option<String>, String> {
            Err("EIO".into())
        }
        fn dismiss_draft(&self, _: &str) -> Result<(), String> {
            Err("EIO".into())
        }
    }
    assert!(draft_summaries(&Failing).is_empty());
}

#[test]
fn copy_draft_writes_the_clipboard_in_main_and_removes_the_record() {
    let f = vault_fixture();
    let (kept, write) = clipboard();
    let (changed, on_changed) = counter();
    let actions = actions(f.source(), write, on_changed, None);
    let (conversation, new_session) = (f.records[0].clone(), f.records[1].clone());
    f.mark(&conversation.id, DraftState::NeedsCopy, Some("moved"));
    f.mark(&new_session.id, DraftState::NeedsCopy, Some("manual"));

    // Nothing comes back for the renderer: the text stays in main.
    assert_eq!(actions.copy(&json!(conversation.id)), Ok(()));
    assert_eq!(*kept.lock().unwrap(), vec![TEXT.to_owned()]);
    assert_eq!(
        f.fixture
            .manager
            .pending_drafts()
            .iter()
            .map(|d| d.id.clone())
            .collect::<Vec<_>>(),
        vec![new_session.id.clone()]
    );
    assert_eq!(count(&changed), 1);

    // A record that is gone copies nothing, and says so.
    let gone = actions.copy(&json!(conversation.id)).unwrap_err();
    assert!(gone.to_string().contains("no longer"));
    let gone = actions.dismiss(&json!(conversation.id)).unwrap_err();
    assert!(gone.to_string().contains("no longer"));
    assert_eq!(*kept.lock().unwrap(), vec![TEXT.to_owned()]);
    assert_eq!(count(&changed), 3);

    assert_eq!(actions.dismiss(&json!(new_session.id)), Ok(()));
    assert!(f.fixture.manager.pending_drafts().is_empty());
    assert_eq!(*kept.lock().unwrap(), vec![TEXT.to_owned()]);
    assert_eq!(count(&changed), 4);
}

#[test]
fn a_draft_still_waiting_is_copied_and_kept_and_cannot_be_dismissed() {
    let f = vault_fixture();
    let (kept, write) = clipboard();
    let actions = actions(f.source(), write, || {}, None);
    for record in &f.records {
        assert_eq!(actions.copy(&json!(record.id)), Ok(()));
        let error = actions.dismiss(&json!(record.id)).unwrap_err();
        assert!(error.to_string().contains("still waiting"));
    }
    assert_eq!(kept.lock().unwrap().len(), f.records.len());
    assert!(kept.lock().unwrap().iter().all(|text| !text.is_empty()));
    assert_eq!(
        f.fixture
            .manager
            .pending_drafts()
            .iter()
            .map(|d| (d.id.clone(), d.state))
            .collect::<Vec<_>>(),
        f.records
            .iter()
            .map(|r| (r.id.clone(), DraftState::Pending))
            .collect::<Vec<_>>()
    );
}

/// Fake drafts with one record left for copy, recording each step.
struct FakeDrafts {
    steps: Arc<Mutex<Vec<String>>>,
    dismiss_fails: bool,
}

impl DraftSource for FakeDrafts {
    fn pending_drafts(&self) -> Result<Vec<DraftSummary>, String> {
        self.steps.lock().unwrap().push("list".into());
        Ok(vec![left_for(DRAFT_ID, "moved")])
    }
    fn draft_text(&self, id: &str) -> Result<Option<String>, String> {
        self.steps.lock().unwrap().push(format!("read {id}"));
        Ok(Some(TEXT.into()))
    }
    fn dismiss_draft(&self, id: &str) -> Result<(), String> {
        if self.dismiss_fails {
            return Err("EIO".into());
        }
        self.steps.lock().unwrap().push(format!("dismiss {id}"));
        Ok(())
    }
}

fn fake_drafts(steps: &Arc<Mutex<Vec<String>>>, dismiss_fails: bool) -> Arc<dyn DraftSource> {
    Arc::new(FakeDrafts {
        steps: Arc::clone(steps),
        dismiss_fails,
    })
}

#[test]
fn copy_writes_the_clipboard_before_the_record_goes_and_keeps_it_when_the_clipboard_fails() {
    let steps: Arc<Mutex<Vec<String>>> = Arc::default();
    let fail = flag();
    let (a, b, c) = (Arc::clone(&steps), Arc::clone(&steps), Arc::clone(&fail));
    let actions = actions(
        fake_drafts(&steps, false),
        move |text| {
            if is_set(&c) {
                return Err("clipboard".into());
            }
            a.lock().unwrap().push(format!("write {text}"));
            Ok(())
        },
        move || b.lock().unwrap().push("changed".into()),
        None,
    );
    actions.copy(&json!(DRAFT_ID)).unwrap();
    assert_eq!(
        *steps.lock().unwrap(),
        vec![
            "list".to_owned(),
            format!("read {DRAFT_ID}"),
            format!("write {TEXT}"),
            format!("dismiss {DRAFT_ID}"),
            "changed".into(),
        ]
    );
    steps.lock().unwrap().clear();
    fail.store(true, Ordering::SeqCst);
    let error = actions.copy(&json!(DRAFT_ID)).unwrap_err();
    assert!(error.to_string().contains("clipboard"));
    assert_eq!(
        *steps.lock().unwrap(),
        vec![
            "list".to_owned(),
            format!("read {DRAFT_ID}"),
            "changed".into()
        ]
    );
}

#[test]
fn copy_and_dismiss_take_only_a_draft_id() {
    let steps: Arc<Mutex<Vec<String>>> = Arc::default();
    let (changed, on_changed) = counter();
    let actions = actions(
        fake_drafts(&steps, false),
        |_| panic!("nothing is copied"),
        on_changed,
        None,
    );
    for bad in [
        json!("../pending.bin"),
        json!(""),
        json!(42),
        Value::Null,
        json!({ "id": ALIAS }),
    ] {
        assert!(actions.copy(&bad).is_err());
        assert!(actions.dismiss(&bad).is_err());
    }
    assert!(steps.lock().unwrap().is_empty());
    assert_eq!(count(&changed), 0);
}

#[test]
fn a_vault_that_cannot_be_read_or_changed_is_a_normal_error_never_a_crash() {
    let f = vault_fixture();
    f.mark(&f.records[0].id, DraftState::NeedsCopy, Some("moved"));
    // The sealed file turns into something that cannot be read.
    let file = f.fixture.vault().join("drafts").join("pending.bin");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    let (kept, write) = clipboard();
    let (changed, on_changed) = counter();
    let actions = actions(f.source(), write, on_changed, None);
    assert!(actions.copy(&json!(f.records[0].id)).is_err());
    assert!(actions.dismiss(&json!(f.records[0].id)).is_err());
    assert!(kept.lock().unwrap().is_empty());
    assert_eq!(count(&changed), 2);
    assert!(draft_summaries(&*f.fixture.manager).is_empty());
    // The vault's own change failing is an ordinary failure too.
    let steps: Arc<Mutex<Vec<String>>> = Arc::default();
    let failing = actions_with_failing_dismiss(&steps);
    assert!(
        failing
            .copy(&json!(DRAFT_ID))
            .unwrap_err()
            .to_string()
            .contains("EIO")
    );
    assert!(
        failing
            .dismiss(&json!(DRAFT_ID))
            .unwrap_err()
            .to_string()
            .contains("EIO")
    );
}

fn actions_with_failing_dismiss(steps: &Arc<Mutex<Vec<String>>>) -> DraftActions {
    actions(fake_drafts(steps, true), |_| Ok(()), || {}, None)
}

fn run_tally(
    counts: &std::collections::HashMap<String, u32>,
    all: &[DraftSummary],
    result: &RestoreResult,
    account: Option<&str>,
) -> StallTally {
    tally_stalls(
        counts,
        StallRun {
            before: all,
            after: all,
            account,
            result,
        },
    )
}
fn counts_of(tally: &StallTally) -> Vec<(String, u32)> {
    let mut counts: Vec<(String, u32)> =
        tally.counts.iter().map(|(k, v)| (k.clone(), *v)).collect();
    counts.sort();
    counts
}
fn pairs(items: &[(&str, u32)]) -> Vec<(String, u32)> {
    items.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}
fn stopped_restored(reason: &str, restored: usize) -> RestoreResult {
    RestoreResult {
        restored,
        ..stopped(reason)
    }
}

#[test]
fn a_draft_is_counted_only_by_runs_that_tried_it_and_moved_nothing() {
    let mine = summary("mine");
    let theirs = DraftSummary {
        to: OTHER.into(),
        ..summary("theirs")
    };
    let copied = DraftSummary {
        state: DraftState::NeedsCopy,
        ..summary("copied")
    };
    let all = [mine, theirs, copied];
    // A stop counts the pending drafts of the account the run was for, and only them.
    let mut tally = run_tally(&Default::default(), &all, &stopped("moved"), Some(ACCOUNT));
    assert_eq!(counts_of(&tally), pairs(&[("mine", 1)]));
    assert!(tally.give_up.is_empty());
    let upper = ACCOUNT.to_uppercase();
    tally = run_tally(&tally.counts, &all, &stopped("not-ready"), Some(&upper));
    assert_eq!(counts_of(&tally), pairs(&[("mine", 2)]));
    // A run that tried nothing (Claude closed or just started: no reason) changes no count.
    tally = run_tally(
        &tally.counts,
        &all,
        &result(RestoreStatus::Waiting, 0, 1),
        Some(ACCOUNT),
    );
    assert_eq!(counts_of(&tally), pairs(&[("mine", 2)]));
    tally = run_tally(
        &tally.counts,
        &all,
        &result(RestoreStatus::Idle, 0, 0),
        Some(ACCOUNT),
    );
    assert_eq!(counts_of(&tally), pairs(&[("mine", 2)]));
    tally = run_tally(&tally.counts, &all, &stopped("moved"), None);
    assert_eq!(counts_of(&tally), pairs(&[("mine", 2)]));
    // The third stop in a row gives the draft up.
    tally = run_tally(&tally.counts, &all, &stopped("moved"), Some(ACCOUNT));
    assert_eq!(tally.give_up, vec!["mine".to_owned()]);
    assert!(counts_of(&tally).is_empty());
}

#[test]
fn a_run_that_moves_any_draft_starts_every_count_again() {
    let one = summary("one");
    let two = summary("two");
    let counts: std::collections::HashMap<String, u32> =
        [("one".to_owned(), 2), ("two".to_owned(), 2)].into();
    // `two` restored, so gone.
    let tally = tally_stalls(
        &counts,
        StallRun {
            before: &[one.clone(), two.clone()],
            after: std::slice::from_ref(&one),
            account: Some(ACCOUNT),
            result: &stopped_restored("moved", 1),
        },
    );
    assert!(tally.counts.is_empty());
    assert!(tally.give_up.is_empty());
    // `two` left for copy.
    let tally = tally_stalls(
        &counts,
        StallRun {
            before: &[one.clone(), two.clone()],
            after: &[
                one.clone(),
                DraftSummary {
                    state: DraftState::NeedsCopy,
                    ..two.clone()
                },
            ],
            account: Some(ACCOUNT),
            result: &stopped("moved"),
        },
    );
    assert!(tally.counts.is_empty());
    assert!(tally.give_up.is_empty());
    // A draft captured during the run is not counted, and one gone is forgotten.
    let tally = tally_stalls(
        &[("gone".to_owned(), 2)].into(),
        StallRun {
            before: std::slice::from_ref(&one),
            after: &[one.clone(), summary("fresh")],
            account: Some(ACCOUNT),
            result: &stopped("moved"),
        },
    );
    assert_eq!(counts_of(&tally), pairs(&[("one", 1)]));
}

#[test]
fn a_busy_lock_or_an_active_user_never_counts_every_other_stop_and_a_restore_that_throws_does() {
    let mine = [summary("mine")];
    let run = |reason: &str| {
        run_tally(
            &[("mine".to_owned(), 2)].into(),
            &mine,
            &stopped(reason),
            Some(ACCOUNT),
        )
    };
    // Another Desktop operation held the lock, or the user was working in Claude.
    for reason in ["busy", "active", "elsewhere"] {
        let tally = run(reason);
        assert!(tally.give_up.is_empty(), "{reason}");
        assert_eq!(counts_of(&tally), pairs(&[("mine", 2)]), "{reason}");
    }
    for reason in [
        "not-ready",
        "moved",
        "changed",
        "claude-not-running",
        "budget",
        "error",
    ] {
        let tally = run(reason);
        assert_eq!(tally.give_up, vec!["mine".to_owned()], "{reason}");
        assert!(tally.counts.is_empty(), "{reason}");
    }
}

// --- The scheduler over fake drafts, a fake 10 s or 60 s timer and a scripted restore -----

type Fail = &'static str;
type During = Box<dyn Fn(&mut State) + Send>;
type AfterMark = Arc<dyn Fn(&str) + Send + Sync>;

struct State {
    clock: i64,
    drafts: Vec<DraftSummary>,
    /// Reading the drafts panics, as a list that is not one makes the TS run throw.
    drafts_broken: bool,
    /// Desktop's current account, as config.json says.
    account: Option<String>,
    account_reads: usize,
    reads: usize,
    retype: bool,
    results: VecDeque<Result<RestoreResult, String>>,
    runs: usize,
    marks: Vec<(String, DraftState, Option<String>)>,
    notices: Vec<DraftCounts>,
    changed: usize,
    armed: usize,
    cancelled: usize,
    /// The armed timer's period: 10 s or 60 s, `None` while none is armed.
    every: Option<u64>,
    tick: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside the scripted restore, as the restorer changing the vault.
    during: Option<During>,
    /// Runs right after a mark changed a draft.
    after_mark: Option<AfterMark>,
    /// What fails: reading the drafts, marking one, the notification, telling the panel.
    fail: HashSet<Fail>,
    /// The drafts whose mark fails, one by one.
    fail_mark: HashSet<String>,
    log_panics: bool,
}

type Shared = Arc<Mutex<State>>;

struct Restorer {
    st: Shared,
    log: Arc<DraftLog>,
}

fn unused<T>() -> Result<T, DesktopHostError> {
    Err(DesktopHostError::other("unused"))
}

impl RestorerDeps for Restorer {
    fn automation(&self) -> &dyn DesktopAutomation {
        &Unused
    }
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError> {
        unused()
    }
    fn mark(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<&str>,
    ) -> Result<(), DesktopHostError> {
        let after = {
            let mut st = self.st.lock().unwrap();
            st.marks.push((id.into(), state, reason.map(str::to_owned)));
            if st.fail.contains("mark") || st.fail_mark.contains(id) {
                return Err(DesktopHostError::other("EIO"));
            }
            for d in st.drafts.iter_mut().filter(|d| d.id == id) {
                d.state = state;
                d.reason = reason.map(str::to_owned);
            }
            st.after_mark.clone()
        };
        if let Some(after) = after {
            after(id);
        }
        Ok(())
    }
    fn remove(&self, _: &str) -> Result<(), DesktopHostError> {
        unused()
    }
    fn current_account(&self) -> Result<Option<String>, DesktopHostError> {
        let mut st = self.st.lock().unwrap();
        st.account_reads += 1;
        Ok(st.account.clone())
    }
    fn running(&self) -> Result<bool, DesktopHostError> {
        unused()
    }
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError> {
        unused()
    }
    fn with_lock(&self, _: &mut dyn FnMut()) -> Result<bool, DesktopHostError> {
        unused()
    }
    fn yielding(&self) -> bool {
        false
    }
    fn notify(&self, summary: DraftCounts) -> Result<(), DesktopHostError> {
        let mut st = self.st.lock().unwrap();
        st.notices.push(summary);
        if st.fail.contains("notify") {
            return Err(DesktopHostError::other("notification"));
        }
        Ok(())
    }
    fn sleep(&self, _: u64) -> Result<(), DesktopHostError> {
        Ok(())
    }
    fn now(&self) -> i64 {
        self.st.lock().unwrap().clock
    }
    fn log(&self) -> Option<&DraftLog> {
        Some(&*self.log)
    }
}

#[derive(Default)]
struct Over {
    drafts: Option<Vec<DraftSummary>>,
    restore: Option<RestoreFn>,
    /// Whether drafts are re-typed; on unless a test turns it off.
    retype: Option<bool>,
}

struct H {
    scheduler: Arc<DraftScheduler>,
    st: Shared,
    logs: Logs,
}

impl H {
    fn st(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap()
    }
    fn push(&self, result: RestoreResult) {
        self.st().results.push_back(Ok(result));
    }
    fn fail_next(&self, message: &str) {
        self.st().results.push_back(Err(message.into()));
    }
    fn logs(&self) -> Vec<Value> {
        self.logs.lock().unwrap().clone()
    }
    /// The armed timer fires.
    fn fire_tick(&self) {
        let tick = self.st().tick.clone().expect("a timer is armed");
        tick();
    }
}

fn harness(over: Over) -> H {
    let st: Shared = Arc::new(Mutex::new(State {
        clock: 0,
        drafts: over.drafts.unwrap_or_else(|| vec![summary("one")]),
        drafts_broken: false,
        account: Some(ACCOUNT.into()),
        account_reads: 0,
        reads: 0,
        retype: over.retype.unwrap_or(true),
        results: VecDeque::new(),
        runs: 0,
        marks: Vec::new(),
        notices: Vec::new(),
        changed: 0,
        armed: 0,
        cancelled: 0,
        every: None,
        tick: None,
        during: None,
        after_mark: None,
        fail: HashSet::new(),
        fail_mark: HashSet::new(),
        log_panics: false,
    }));
    let (logs, keep) = log_sink();
    let mode = Arc::clone(&st);
    let log: Arc<DraftLog> = Arc::new(
        move |event: &str, fields: Option<&serde_json::Map<String, Value>>| {
            if mode.lock().unwrap().log_panics {
                panic!("the log failed");
            }
            keep(event, fields);
        },
    );
    let restorer = Arc::new(Restorer {
        st: Arc::clone(&st),
        log,
    });
    let (a, b, c, d, e) = (
        Arc::clone(&st),
        Arc::clone(&st),
        Arc::clone(&st),
        Arc::clone(&st),
        Arc::clone(&st),
    );
    let mut deps = DraftSchedulerDeps::new(
        restorer,
        Box::new(move || {
            let mut st = a.lock().unwrap();
            st.reads += 1;
            if st.drafts_broken {
                drop(st);
                panic!("not a list");
            }
            if st.fail.contains("read") {
                return Err("EIO".into());
            }
            Ok(st.drafts.clone())
        }),
        Box::new(move || {
            let mut st = b.lock().unwrap();
            st.changed += 1;
            if st.fail.contains("changed") {
                return Err("renderer".into());
            }
            Ok(())
        }),
        Box::new(move || c.lock().unwrap().retype),
    );
    deps.restore = Some(over.restore.unwrap_or_else(|| {
        Box::new(move |deps, _options| {
            d.lock().unwrap().runs += 1;
            let _ = deps.current_account();
            let next = {
                let mut st = d.lock().unwrap();
                if let Some(during) = st.during.take() {
                    during(&mut st);
                    st.during = Some(during);
                }
                st.results
                    .pop_front()
                    .unwrap_or_else(|| Ok(result(RestoreStatus::Idle, 0, 0)))
            };
            next.map_err(DesktopHostError::other)
        })
    }));
    deps.every = Some(Box::new(move |tick, ms| {
        let mut st = e.lock().unwrap();
        assert!(ms == 10_000 || ms == 60_000, "{ms}");
        // One timer at a time: a new one only after the last was cancelled.
        assert!(st.tick.is_none());
        st.armed += 1;
        st.every = Some(ms);
        st.tick = Some(Arc::from(tick));
        let e = Arc::clone(&e);
        Box::new(move || {
            let mut st = e.lock().unwrap();
            st.cancelled += 1;
            st.every = None;
            st.tick = None;
        })
    }));
    H {
        scheduler: DraftScheduler::new(deps),
        st,
        logs,
    }
}

fn base() -> H {
    harness(Over::default())
}
fn with_drafts(drafts: Vec<DraftSummary>) -> H {
    harness(Over {
        drafts: Some(drafts),
        ..Over::default()
    })
}
fn for_access(id: &str) -> DraftSummary {
    left_for(id, "accessibility")
}
fn mark(id: &str, state: DraftState, reason: Option<&str>) -> (String, DraftState, Option<String>) {
    (id.into(), state, reason.map(str::to_owned))
}
fn pending_again(id: &str) -> (String, DraftState, Option<String>) {
    mark(id, DraftState::Pending, None)
}
fn events(logs: &[Value], names: &[&str]) -> Vec<Value> {
    logs.iter()
        .filter(|e| names.iter().any(|n| e["event"] == *n))
        .cloned()
        .collect()
}

#[test]
fn each_run_logs_its_stall_tally_and_a_give_up_logs_the_draft_and_why() {
    let h = base();
    h.push(stopped("changed"));
    h.push(stopped("moved"));
    h.push(stopped("moved"));
    h.scheduler.after_switch();
    h.scheduler.tick();
    h.scheduler.tick();
    assert_eq!(
        events(&h.logs(), &["stalls", "give-up"]),
        vec![
            json!({ "event": "stalls", "giveUp": 0, "reason": "changed", "status": "waiting" }),
            json!({ "event": "stalls", "giveUp": 0, "reason": "moved", "status": "waiting" }),
            json!({ "event": "stalls", "giveUp": 1, "reason": "moved", "status": "waiting" }),
            json!({ "event": "give-up", "id": "one", "reason": "moved", "marked": true }),
        ]
    );
    // A draft that cannot be marked is logged as given up and not marked.
    let failing = base();
    failing.st().fail_mark.insert("one".into());
    for _ in 0..3 {
        failing.push(stopped("moved"));
    }
    failing.scheduler.after_switch();
    failing.scheduler.tick();
    failing.scheduler.tick();
    assert_eq!(
        failing.logs().into_iter().find(|e| e["event"] == "give-up"),
        Some(json!({ "event": "give-up", "id": "one", "reason": "moved", "marked": false }))
    );
}

#[test]
fn an_idle_run_and_one_that_threw_log_their_tally_with_a_fixed_reason() {
    let idle = base();
    idle.scheduler.after_switch();
    assert_eq!(
        idle.logs(),
        vec![json!({ "event": "stalls", "giveUp": 0, "reason": null, "status": "idle" })]
    );
    let threw = base();
    threw.fail_next("a message that must never be logged");
    threw.scheduler.after_switch();
    assert_eq!(
        threw.logs(),
        vec![json!({ "event": "stalls", "giveUp": 0, "reason": "error", "status": "waiting" })]
    );
}

#[test]
fn each_retry_after_accessibility_logs_how_many_drafts_it_moved() {
    let h = with_drafts(vec![for_access("a"), for_access("b")]);
    h.scheduler.retry_accessibility(false);
    h.scheduler.retry_accessibility(true);
    assert_eq!(
        events(&h.logs(), &["retry-accessibility"]),
        vec![
            json!({ "event": "retry-accessibility", "moved": 2, "once": false }),
            json!({ "event": "retry-accessibility", "moved": 0, "once": true }),
        ]
    );
    // A log that throws is fine.
    let bare = with_drafts(vec![for_access("a")]);
    bare.st().log_panics = true;
    assert_eq!(bare.scheduler.retry_accessibility(false), 1);
    bare.scheduler.after_switch();
}

#[test]
fn copy_and_dismiss_log_the_drafts_id_and_how_they_ended_never_its_text() {
    let (logs, log) = log_sink();
    let steps: Arc<Mutex<Vec<String>>> = Arc::default();
    let acts = actions(
        fake_drafts(&steps, false),
        |_| Ok(()),
        || {},
        Some(log.clone()),
    );
    acts.copy(&json!(DRAFT_ID)).unwrap();
    acts.dismiss(&json!(DRAFT_ID)).unwrap();
    let id = &DRAFT_ID[..8];
    assert_eq!(
        *logs.lock().unwrap(),
        vec![
            json!({ "event": "draft-copy", "id": id, "ok": true }),
            json!({ "event": "draft-dismiss", "id": id, "ok": true }),
        ]
    );
    // A refusal by this code says why; any other failure is a fixed word, never its message.
    struct Waiting;
    impl DraftSource for Waiting {
        fn pending_drafts(&self) -> Result<Vec<DraftSummary>, String> {
            Ok(vec![summary(DRAFT_ID)])
        }
        fn draft_text(&self, _: &str) -> Result<Option<String>, String> {
            Ok(Some(TEXT.into()))
        }
        fn dismiss_draft(&self, _: &str) -> Result<(), String> {
            Err(format!("EIO {TEXT}"))
        }
    }
    struct Broken;
    impl DraftSource for Broken {
        fn pending_drafts(&self) -> Result<Vec<DraftSummary>, String> {
            Ok(vec![DraftSummary {
                state: DraftState::NeedsCopy,
                ..summary(DRAFT_ID)
            }])
        }
        fn draft_text(&self, _: &str) -> Result<Option<String>, String> {
            Ok(Some(TEXT.into()))
        }
        fn dismiss_draft(&self, _: &str) -> Result<(), String> {
            Err(format!("EIO {TEXT}"))
        }
    }
    let refused = actions(Arc::new(Waiting), |_| Ok(()), || {}, Some(log.clone()));
    logs.lock().unwrap().clear();
    // A waiting draft is copied and kept: nothing is dismissed.
    assert_eq!(refused.copy(&json!(DRAFT_ID)), Ok(()));
    assert!(
        refused
            .dismiss(&json!(DRAFT_ID))
            .unwrap_err()
            .to_string()
            .contains("still waiting")
    );
    let sink = Arc::clone(&log);
    let throwing: Arc<DraftLog> = Arc::new(
        move |event: &str, fields: Option<&serde_json::Map<String, Value>>| {
            sink(event, fields);
            panic!("the log failed");
        },
    );
    let broken = actions(Arc::new(Broken), |_| Ok(()), || {}, Some(throwing));
    assert!(
        broken
            .copy(&json!(DRAFT_ID))
            .unwrap_err()
            .to_string()
            .contains("EIO")
    );
    let kept = logs.lock().unwrap().clone();
    assert_eq!(
        kept,
        vec![
            json!({ "event": "draft-copy", "id": id, "ok": true, "kept": true }),
            json!({ "event": "draft-dismiss", "id": id, "ok": false, "reason": "This draft is still waiting to be restored." }),
            json!({ "event": "draft-copy", "id": id, "ok": false, "reason": "failed" }),
        ]
    );
    assert!(!serde_json::to_string(&kept).unwrap().contains(TEXT));
}

/// A restore that waits at a gate of its own each call, opened in order by the test.
#[derive(Default)]
struct Gates(Mutex<VecDeque<Arc<Gate>>>);

impl Gates {
    fn hold(&self) {
        let gate = Gate::new();
        self.0.lock().unwrap().push_back(Arc::clone(&gate));
        gate.wait();
    }
    /// Opens the earliest gate, once a run waits there.
    fn open_next(&self) {
        wait_until("a run to wait", || !self.0.lock().unwrap().is_empty());
        let gate = self.0.lock().unwrap().pop_front().unwrap();
        gate.open();
    }
}

fn spawn(h: &Arc<H>, f: impl FnOnce(&H) + Send + 'static) -> std::thread::JoinHandle<()> {
    let h = Arc::clone(h);
    std::thread::spawn(move || f(&h))
}

#[test]
fn restores_never_overlap() {
    let active = Arc::new(AtomicUsize::new(0));
    let most = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let gates = Arc::new(Gates::default());
    let (a, m, c, g) = (
        Arc::clone(&active),
        Arc::clone(&most),
        Arc::clone(&calls),
        Arc::clone(&gates),
    );
    let h = Arc::new(harness(Over {
        restore: Some(Box::new(move |_, _| {
            c.fetch_add(1, Ordering::SeqCst);
            let now = a.fetch_add(1, Ordering::SeqCst) + 1;
            m.fetch_max(now, Ordering::SeqCst);
            g.hold();
            a.fetch_sub(1, Ordering::SeqCst);
            Ok(result(RestoreStatus::Waiting, 0, 1))
        })),
        ..Over::default()
    }));
    let first = spawn(&h, |h| h.scheduler.after_switch());
    wait_until("the first run", || count(&calls) == 1);
    // Ticks and a second switch while the run is in flight start nothing alongside it.
    let ticks = [
        spawn(&h, |h| h.scheduler.tick()),
        spawn(&h, |h| h.scheduler.tick()),
    ];
    let second = spawn(&h, |h| h.scheduler.after_switch());
    flush();
    assert_eq!(count(&calls), 1);
    gates.open_next();
    // The switch asked for a run of its own: it comes after, never alongside.
    wait_until("the second run", || count(&calls) == 2);
    gates.open_next();
    first.join().unwrap();
    second.join().unwrap();
    for tick in ticks {
        tick.join().unwrap();
    }
    assert_eq!(count(&calls), 2);
    assert_eq!(count(&most), 1);
    // Once idle, a tick runs again.
    let third = spawn(&h, |h| h.scheduler.tick());
    wait_until("the third run", || count(&calls) == 3);
    gates.open_next();
    third.join().unwrap();
}

#[test]
fn a_draft_stopped_three_runs_in_a_row_is_left_for_copy_with_the_last_reason() {
    let h = base();
    h.push(stopped("changed"));
    h.push(stopped("moved"));
    h.push(stopped("moved"));
    h.scheduler.after_switch();
    assert_eq!(h.st().armed, 1);
    h.fire_tick();
    h.scheduler.tick();
    assert_eq!(h.st().runs, 3);
    assert_eq!(
        h.st().marks,
        vec![mark("one", DraftState::NeedsCopy, Some("moved"))]
    );
    assert_eq!(
        h.st().notices,
        vec![DraftCounts {
            restored: 0,
            left: 1
        }]
    );
    assert_eq!(h.st().changed, 1);
    // Nothing pending is left: the 10 s retries stop, and nothing more runs.
    assert_eq!(h.st().cancelled, 1);
    h.scheduler.tick();
    assert_eq!(h.st().runs, 3);
}

#[test]
fn after_desktops_ui_never_answered_retries_wait_2_minutes_but_a_switch_does_not() {
    let h = base();
    h.push(stopped("not-ready"));
    h.push(stopped("not-ready"));
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 1);
    h.st().clock = 60_000;
    h.scheduler.tick();
    h.st().clock = 119_999;
    h.scheduler.tick();
    assert_eq!(h.st().runs, 1);
    h.st().clock = 120_000;
    h.scheduler.tick();
    assert_eq!(h.st().runs, 2);
    h.st().clock = 130_000;
    h.scheduler.tick();
    assert_eq!(h.st().runs, 2);
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 3);
    // A switch means a new Claude: the retries after it wait no more either.
    h.scheduler.tick();
    assert_eq!(h.st().runs, 4);
}

#[test]
fn a_run_the_user_was_active_in_sets_no_backoff_the_next_10_s_retry_runs() {
    let h = base();
    h.push(stopped("active"));
    h.push(stopped("active"));
    h.push(stopped("elsewhere"));
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 1);
    h.st().clock = 10_000;
    h.scheduler.tick();
    assert_eq!(h.st().runs, 2);
    h.st().clock = 20_000;
    h.scheduler.tick();
    assert_eq!(h.st().runs, 3);
    // Neither gives a draft up, and the retries stay on.
    assert!(h.st().marks.is_empty());
    assert_eq!(h.st().cancelled, 0);
}

#[test]
fn the_10_s_retries_run_only_while_a_draft_is_pending() {
    // Nothing pending at launch: no timer, no restore.
    let h = with_drafts(vec![left_for("copied", "manual")]);
    h.scheduler.start();
    assert_eq!(h.st().armed, 0);
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 0);
    assert_eq!(h.st().armed, 0);

    // A draft pending at launch: retries until the restore leaves none pending.
    let h = base();
    h.scheduler.start();
    assert_eq!(h.st().armed, 1);
    assert_eq!(h.st().runs, 0);
    h.scheduler.tick();
    assert_eq!(h.st().runs, 1);
    assert_eq!(h.st().cancelled, 0);
    h.push(result(RestoreStatus::Done, 1, 0));
    h.st().during = Some(Box::new(|st| st.drafts.clear()));
    h.scheduler.tick();
    assert_eq!(h.st().cancelled, 1);
    assert_eq!(h.st().changed, 1);

    // A switch that leaves a draft pending turns them on again; stop turns everything off.
    h.st().during = None;
    h.st().drafts = vec![summary("next")];
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 3);
    assert_eq!(h.st().armed, 2);
    h.scheduler.stop();
    assert_eq!(h.st().cancelled, 2);
    h.scheduler.after_switch();
    h.scheduler.tick();
    assert_eq!(h.st().runs, 3);
    assert_eq!(h.st().armed, 2);
}

#[test]
fn a_restore_that_throws_ends_its_run_and_three_in_a_row_leave_the_draft_for_copy() {
    let h = base();
    h.fail_next("unexpected");
    h.push(stopped("moved"));
    h.scheduler.after_switch();
    h.scheduler.tick();
    assert_eq!(h.st().runs, 2);
    assert!(h.st().marks.is_empty());
    // A failure that repeats is given up rather than retried every 10 s for a week.
    h.fail_next("unexpected");
    h.scheduler.tick();
    assert_eq!(
        h.st().marks,
        vec![mark("one", DraftState::NeedsCopy, Some("error"))]
    );
    assert_eq!(h.st().cancelled, 1);
}

#[test]
fn busy_runs_never_give_a_draft_up_however_many_there_are() {
    for reason in ["busy", "active", "elsewhere"] {
        let h = base();
        for _ in 0..5 {
            h.push(stopped(reason));
        }
        h.scheduler.after_switch();
        for _ in 0..4 {
            // Past any backoff, so every tick runs.
            h.st().clock += 60_000;
            h.scheduler.tick();
        }
        assert_eq!(h.st().runs, 5, "{reason}");
        assert!(h.st().marks.is_empty(), "{reason}");
        assert_eq!(h.st().cancelled, 0, "{reason}");
    }
}

#[test]
fn a_run_that_finds_nothing_pending_turns_the_retries_off_before_anything_else() {
    let h = base();
    h.scheduler.start();
    assert_eq!(h.st().armed, 1);
    // The last pending draft went another way, between two ticks.
    h.st().drafts = vec![DraftSummary {
        state: DraftState::NeedsCopy,
        ..summary("one")
    }];
    h.scheduler.tick();
    assert_eq!(h.st().cancelled, 1);
    assert_eq!(h.st().runs, 0);
    // A vault that cannot be read holds nothing to run for either.
    h.st().drafts = vec![summary("two")];
    h.scheduler.after_switch();
    assert_eq!(h.st().armed, 2);
    h.st().fail.insert("read");
    h.scheduler.tick();
    assert_eq!(h.st().runs, 1);
    assert_eq!(h.st().cancelled, 2);
}

#[test]
fn a_mark_that_fails_keeps_the_draft_pending_and_a_failing_notice_or_refresh_changes_nothing() {
    let h = base();
    h.st().fail.insert("mark");
    for _ in 0..3 {
        h.push(stopped("moved"));
    }
    h.scheduler.after_switch();
    h.scheduler.tick();
    h.scheduler.tick();
    assert_eq!(
        h.st().marks,
        vec![mark("one", DraftState::NeedsCopy, Some("moved"))]
    );
    // Nothing was left for copy: no notice, nothing changed, and the retries go on.
    assert!(h.st().notices.is_empty());
    assert_eq!(h.st().changed, 0);
    assert_eq!(h.st().cancelled, 0);

    {
        let mut st = h.st();
        st.fail.clear();
        st.fail.insert("notify");
        st.fail.insert("changed");
    }
    for _ in 0..3 {
        h.push(stopped("moved"));
    }
    for _ in 0..3 {
        h.scheduler.tick();
    }
    assert_eq!(
        h.st().marks.last(),
        Some(&mark("one", DraftState::NeedsCopy, Some("moved")))
    );
    assert_eq!(
        h.st().notices,
        vec![DraftCounts {
            restored: 0,
            left: 1
        }]
    );
    assert_eq!(h.st().changed, 1);
    // The draft is left for copy all the same, and the retries stop.
    assert_eq!(h.st().drafts[0].state, DraftState::NeedsCopy);
    assert_eq!(h.st().cancelled, 1);
}

#[test]
fn stop_during_a_run_drops_the_run_a_switch_asked_for_after_it() {
    let calls = Arc::new(AtomicUsize::new(0));
    let gates = Arc::new(Gates::default());
    let (c, g) = (Arc::clone(&calls), Arc::clone(&gates));
    let h = Arc::new(harness(Over {
        restore: Some(Box::new(move |_, _| {
            // Only the first run waits, so a run that should not happen shows instead of hanging.
            if c.fetch_add(1, Ordering::SeqCst) == 0 {
                g.hold();
            }
            Ok(result(RestoreStatus::Waiting, 0, 1))
        })),
        ..Over::default()
    }));
    let first = spawn(&h, |h| h.scheduler.after_switch());
    wait_until("the first run", || count(&calls) == 1);
    let second = spawn(&h, |h| h.scheduler.after_switch());
    flush();
    h.scheduler.stop();
    gates.open_next();
    first.join().unwrap();
    second.join().unwrap();
    assert_eq!(count(&calls), 1);
}

#[test]
fn a_run_that_fails_where_nothing_should_leaves_the_scheduler_able_to_run_again() {
    let h = base();
    // Not a list: reading it fails inside the run itself.
    h.st().drafts_broken = true;
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 0);
    h.st().drafts_broken = false;
    h.st().drafts = vec![summary("one")];
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 1);
}

#[test]
fn a_granted_accessibility_permission_sets_the_drafts_it_left_for_copy_back_to_pending() {
    let h = with_drafts(vec![
        for_access("a"),
        left_for("m", "manual"),
        for_access("b"),
    ]);
    assert_eq!(h.scheduler.retry_accessibility(false), 2);
    // Only the accessibility ones moved, the reason is gone with the state, and the panel is told.
    assert_eq!(h.st().marks, vec![pending_again("a"), pending_again("b")]);
    assert_eq!(
        h.st()
            .drafts
            .iter()
            .map(|d| (d.id.clone(), d.state, d.reason.clone()))
            .collect::<Vec<_>>(),
        vec![
            pending_again("a"),
            mark("m", DraftState::NeedsCopy, Some("manual")),
            pending_again("b"),
        ]
    );
    assert_eq!(h.st().changed, 1);
    // The 10 s retries are on, and the next one runs a restore.
    assert_eq!(h.st().armed, 1);
    assert_eq!(h.st().runs, 0);
    h.fire_tick();
    assert_eq!(h.st().runs, 1);
    // With none left for it, a second call moves nothing and says nothing.
    assert_eq!(h.scheduler.retry_accessibility(false), 0);
    assert_eq!(h.st().changed, 1);
}

#[test]
fn the_drafts_moved_back_start_with_no_stops_counted() {
    let h = base();
    for _ in 0..3 {
        h.push(stopped("moved"));
    }
    h.scheduler.after_switch();
    h.scheduler.tick();
    // Two stops are counted. The draft is then left for Copy some other way, and moved back.
    h.st().drafts = vec![for_access("one")];
    assert_eq!(h.scheduler.retry_accessibility(false), 1);
    // One more stop is the first again, not the third.
    h.scheduler.tick();
    assert_eq!(h.st().runs, 3);
    assert_eq!(h.st().marks, vec![pending_again("one")]);
    assert_eq!(h.st().drafts[0].state, DraftState::Pending);
}

#[test]
fn retrying_after_accessibility_never_throws_and_moves_nothing_it_cannot() {
    // A vault that cannot be read: no drafts, none moved.
    let h = with_drafts(vec![for_access("one")]);
    h.st().fail.insert("read");
    assert_eq!(h.scheduler.retry_accessibility(false), 0);
    assert!(h.st().marks.is_empty());
    assert_eq!(h.st().changed, 0);
    assert_eq!(h.st().armed, 0);

    // A change that fails leaves that draft for Copy, and the others go on.
    let h = with_drafts(vec![for_access("a"), for_access("b")]);
    h.st().fail.insert("mark");
    assert_eq!(h.scheduler.retry_accessibility(false), 0);
    assert_eq!(h.st().changed, 0);
    assert_eq!(h.st().armed, 0);
    assert_eq!(
        h.st().drafts.iter().map(|d| d.state).collect::<Vec<_>>(),
        vec![DraftState::NeedsCopy, DraftState::NeedsCopy]
    );

    // A panel that cannot be told changes nothing about the drafts.
    let h = with_drafts(vec![for_access("one")]);
    h.st().fail.insert("changed");
    assert_eq!(h.scheduler.retry_accessibility(false), 1);
    assert_eq!(h.st().armed, 1);

    // Once stopped, nothing is retried.
    let h = with_drafts(vec![for_access("one")]);
    h.scheduler.stop();
    assert_eq!(h.scheduler.retry_accessibility(false), 0);
    assert!(h.st().marks.is_empty());
}

#[test]
fn retrying_after_accessibility_leaves_the_retries_on_when_a_run_in_flight_turns_them_off() {
    let h = with_drafts(vec![summary("p"), for_access("q")]);
    for _ in 0..3 {
        h.push(stopped("moved"));
    }
    h.scheduler.after_switch();
    h.scheduler.tick();
    assert_eq!(h.st().armed, 1);
    // The third stop gives `p` up. While that is written, the permission is granted: `q` is set
    // pending, and the run, which read the drafts before, then finds nothing pending.
    let retry: Arc<Mutex<Option<std::thread::JoinHandle<usize>>>> = Arc::default();
    let (slot, scheduler, st) = (
        Arc::clone(&retry),
        Arc::downgrade(&h.scheduler),
        Arc::downgrade(&h.st),
    );
    h.st().after_mark = Some(Arc::new(move |id| {
        if id != "p" {
            return;
        }
        let scheduler = scheduler.upgrade().unwrap();
        *slot.lock().unwrap() = Some(std::thread::spawn(move || {
            scheduler.retry_accessibility(false)
        }));
        let st = st.upgrade().unwrap();
        wait_until("q to be set pending", || {
            st.lock().unwrap().marks.contains(&pending_again("q"))
        });
    }));
    h.scheduler.tick();
    let moved = retry.lock().unwrap().take().unwrap().join().unwrap();
    assert_eq!(moved, 1);
    assert_eq!(h.st().marks.last(), Some(&pending_again("q")));
    assert_eq!(
        h.st().drafts.iter().find(|d| d.id == "q").unwrap().state,
        DraftState::Pending
    );
    // The run turned the retries off, and the retry turned them on again after it.
    assert_eq!(h.st().cancelled, 1);
    assert_eq!(h.st().armed, 2);
    assert!(h.st().tick.is_some());
}

#[test]
fn a_retry_from_focus_moves_a_draft_back_once_a_run_the_explicit_grant_always_does() {
    let h = with_drafts(vec![for_access("a")]);
    assert_eq!(h.scheduler.retry_accessibility(true), 1);
    // A run left it for Copy for want of access again, and another draft with it.
    h.st().drafts = vec![for_access("a"), for_access("b")];
    assert_eq!(h.scheduler.retry_accessibility(true), 1);
    let ids = |h: &H| h.st().marks.iter().map(|m| m.0.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&h), ["a", "b"]);
    h.st().drafts = vec![for_access("a"), for_access("b")];
    assert_eq!(h.scheduler.retry_accessibility(true), 0);
    assert_eq!(h.st().marks.len(), 2);
    // The grant retries both, and what it moved counts as moved this run.
    assert_eq!(h.scheduler.retry_accessibility(false), 2);
    h.st().drafts = vec![for_access("c")];
    assert_eq!(h.scheduler.retry_accessibility(false), 1);
    h.st().drafts = vec![for_access("c")];
    assert_eq!(h.scheduler.retry_accessibility(true), 0);
    assert_eq!(ids(&h), ["a", "b", "a", "b", "c"]);
}

#[test]
fn two_retries_at_once_move_each_draft_once_and_the_second_finds_none() {
    for once in [false, true] {
        let h = Arc::new(with_drafts(vec![for_access("a"), for_access("b")]));
        let (a, b) = (Arc::clone(&h), Arc::clone(&h));
        let first = std::thread::spawn(move || a.scheduler.retry_accessibility(once));
        let second = std::thread::spawn(move || b.scheduler.retry_accessibility(once));
        // Whichever goes first moves both.
        let mut both = [first.join().unwrap(), second.join().unwrap()];
        both.sort();
        assert_eq!(both, [0, 2], "{once}");
        assert_eq!(
            h.st().marks,
            vec![pending_again("a"), pending_again("b")],
            "{once}"
        );
        assert_eq!(h.st().changed, 1);
        assert_eq!(h.st().armed, 1);
    }
}

#[test]
fn retrying_after_accessibility_never_moves_a_draft_that_may_be_typed_waits_for_its_composer_or_is_pending()
 {
    let h = with_drafts(vec![
        left_for("typed", "maybe-typed"),
        left_for("full", "composer-not-empty"),
        // Pending already, with a reason left from before.
        DraftSummary {
            reason: Some("accessibility".into()),
            ..summary("stale")
        },
    ]);
    assert_eq!(h.scheduler.retry_accessibility(false), 0);
    assert!(h.st().marks.is_empty());
    assert_eq!(h.st().changed, 0);
    assert_eq!(h.st().armed, 0);
}

#[test]
fn retrying_after_accessibility_keeps_the_stop_count_of_a_draft_it_did_not_move() {
    let h = with_drafts(vec![summary("p")]);
    for _ in 0..3 {
        h.push(stopped("moved"));
    }
    h.scheduler.after_switch();
    h.scheduler.tick();
    // `p` has two stops counted. `q` is moved back beside it.
    h.st().drafts = vec![summary("p"), for_access("q")];
    assert_eq!(h.scheduler.retry_accessibility(false), 1);
    // The next stop is `p`'s third: it is given up, and `q`, at its first, waits on.
    h.scheduler.tick();
    assert_eq!(
        h.st().marks,
        vec![
            pending_again("q"),
            mark("p", DraftState::NeedsCopy, Some("moved"))
        ]
    );
    assert_eq!(
        h.st().drafts.iter().find(|d| d.id == "q").unwrap().state,
        DraftState::Pending
    );
}

#[test]
fn one_draft_that_cannot_be_moved_back_leaves_the_others_moved_and_is_not_counted() {
    let h = with_drafts(vec![for_access("a"), for_access("b"), for_access("c")]);
    h.st().fail_mark.insert("b".into());
    assert_eq!(h.scheduler.retry_accessibility(false), 2);
    assert_eq!(
        h.st()
            .drafts
            .iter()
            .map(|d| (d.id.clone(), d.state))
            .collect::<Vec<_>>(),
        vec![
            ("a".to_owned(), DraftState::Pending),
            ("b".to_owned(), DraftState::NeedsCopy),
            ("c".to_owned(), DraftState::Pending),
        ]
    );
    assert_eq!(h.st().changed, 1);
    assert_eq!(h.st().armed, 1);
    // It was not moved, so a retry from focus still tries it.
    h.st().fail_mark.clear();
    assert_eq!(h.scheduler.retry_accessibility(true), 1);
    assert_eq!(h.st().marks.last(), Some(&pending_again("b")));
}

fn retype_off(drafts: Vec<DraftSummary>) -> H {
    harness(Over {
        retype: Some(false),
        drafts: Some(drafts),
        ..Over::default()
    })
}
fn theirs(id: &str) -> DraftSummary {
    DraftSummary {
        to: OTHER.into(),
        ..summary(id)
    }
}

#[test]
fn with_re_typing_off_every_pending_draft_is_left_for_copy_at_once_whatever_its_account() {
    let h = retype_off(vec![
        summary("mine"),
        theirs("theirs"),
        left_for("done", "lost"),
    ]);
    h.scheduler.after_switch();
    // No restore, and no need to know Desktop's account.
    assert_eq!(h.st().runs, 0);
    assert_eq!(h.st().account_reads, 0);
    assert_eq!(
        h.st().marks,
        vec![
            mark("mine", DraftState::NeedsCopy, Some("manual")),
            mark("theirs", DraftState::NeedsCopy, Some("manual")),
        ]
    );
    assert_eq!(
        h.st().notices,
        vec![DraftCounts {
            restored: 0,
            left: 2
        }]
    );
    assert_eq!(h.st().changed, 1);
    assert_eq!(h.st().armed, 0);
    assert!(
        h.logs()
            .iter()
            .any(|e| e["event"] == "retype-off" && e["left"] == 2)
    );
    // Nothing is pending any more: a tick or another switch finds nothing to do.
    h.scheduler.tick();
    h.scheduler.after_switch();
    assert_eq!(h.st().marks.len(), 2);
    assert_eq!(h.st().notices.len(), 1);
    assert_eq!(h.st().armed, 0);
}

#[test]
fn with_re_typing_off_drafts_waiting_from_before_go_to_copy_at_launch() {
    let h = retype_off(vec![theirs("old")]);
    h.scheduler.start();
    assert_eq!(
        h.st().marks,
        vec![mark("old", DraftState::NeedsCopy, Some("manual"))]
    );
    assert_eq!(
        h.st().notices,
        vec![DraftCounts {
            restored: 0,
            left: 1
        }]
    );
    assert_eq!(h.st().runs, 0);
    assert_eq!(h.st().armed, 0);
}

#[test]
fn with_re_typing_off_a_draft_whose_mark_fails_stays_pending_and_the_next_pass_tries_again() {
    let h = retype_off(vec![summary("a"), theirs("b")]);
    h.st().fail_mark.insert("b".into());
    h.scheduler.after_switch();
    assert_eq!(
        h.st().drafts.iter().map(|d| d.state).collect::<Vec<_>>(),
        vec![DraftState::NeedsCopy, DraftState::Pending]
    );
    assert_eq!(
        h.st().notices,
        vec![DraftCounts {
            restored: 0,
            left: 1
        }]
    );
    assert_eq!(h.st().every, Some(10_000));
    h.st().fail_mark.clear();
    h.scheduler.tick();
    assert_eq!(
        h.st().marks.last(),
        Some(&mark("b", DraftState::NeedsCopy, Some("manual")))
    );
    assert_eq!(
        h.st().notices.last(),
        Some(&DraftCounts {
            restored: 0,
            left: 1
        })
    );
    assert_eq!(h.st().every, None);
    assert_eq!(h.st().runs, 0);
}

/// An automation that notes each call and refuses it for want of accessibility.
struct Noting(Arc<Mutex<Vec<String>>>);

impl Noting {
    fn note<T>(&self, name: &str) -> Result<T, DesktopHostError> {
        self.0.lock().unwrap().push(format!("automation.{name}"));
        Err(DesktopAutomationIssue::AccessibilityPermissionRequired.into())
    }
}

impl DesktopAutomation for Noting {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        self.note("inspect")
    }
    fn open_session(&self, _: &str, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        self.note("openSession")
    }
    fn open_new_session(&self, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        self.note("openNewSession")
    }
    fn set_permission(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        self.note("setPermission")
    }
    fn send(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
        _: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        self.note("send")
    }
    fn has_request_marker(&self, _: &str) -> Result<bool, DesktopHostError> {
        self.note("hasRequestMarker")
    }
    fn write_draft(
        &self,
        _: &DesktopDraftGuard,
        _: &str,
        _: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        self.note("writeDraft")
    }
}

/// The real restorer's deps, noting each call.
struct Real {
    calls: Arc<Mutex<Vec<String>>>,
    automation: Noting,
    drafts: Arc<Mutex<Vec<DraftSummary>>>,
}

impl Real {
    fn called<T>(&self, name: &str, value: T) -> Result<T, DesktopHostError> {
        self.calls.lock().unwrap().push(name.into());
        Ok(value)
    }
}

impl RestorerDeps for Real {
    fn automation(&self) -> &dyn DesktopAutomation {
        &self.automation
    }
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError> {
        self.calls.lock().unwrap().push("pending".into());
        Ok(self
            .drafts
            .lock()
            .unwrap()
            .iter()
            .map(|d| DraftRecord {
                id: d.id.clone(),
                to: d.to.clone(),
                target_alias: Some(ALIAS.into()),
                new_session: None,
                title: d.title.clone(),
                text: TEXT.into(),
                attachments: d.attachments,
                captured_at: d.captured_at.clone(),
                state: d.state,
                reason: d.reason.clone(),
            })
            .collect())
    }
    fn mark(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<&str>,
    ) -> Result<(), DesktopHostError> {
        for d in self
            .drafts
            .lock()
            .unwrap()
            .iter_mut()
            .filter(|d| d.id == id)
        {
            d.state = state;
            d.reason = reason.map(str::to_owned);
        }
        Ok(())
    }
    fn remove(&self, _: &str) -> Result<(), DesktopHostError> {
        self.called("remove", ())
    }
    fn current_account(&self) -> Result<Option<String>, DesktopHostError> {
        self.called("currentAccount", Some(ACCOUNT.into()))
    }
    fn running(&self) -> Result<bool, DesktopHostError> {
        self.called("running", true)
    }
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError> {
        self.called("uptimeMs", Some(60_000))
    }
    fn with_lock(&self, f: &mut dyn FnMut()) -> Result<bool, DesktopHostError> {
        self.calls.lock().unwrap().push("withLock".into());
        f();
        Ok(true)
    }
    fn yielding(&self) -> bool {
        self.calls.lock().unwrap().push("yielding".into());
        false
    }
    fn notify(&self, _: DraftCounts) -> Result<(), DesktopHostError> {
        Ok(())
    }
    fn sleep(&self, _: u64) -> Result<(), DesktopHostError> {
        self.called("sleep", ())
    }
    fn now(&self) -> i64 {
        0
    }
}

#[test]
fn with_re_typing_off_nothing_reaches_desktop_no_restore_readiness_check_or_automation() {
    let calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let make = |retype: bool| {
        let drafts = Arc::new(Mutex::new(vec![
            summary("mine"),
            theirs("theirs"),
            for_access("denied"),
        ]));
        let restorer = Arc::new(Real {
            calls: Arc::clone(&calls),
            automation: Noting(Arc::clone(&calls)),
            drafts: Arc::clone(&drafts),
        });
        let read = Arc::clone(&drafts);
        let mut deps = DraftSchedulerDeps::new(
            restorer,
            Box::new(move || Ok(read.lock().unwrap().clone())),
            Box::new(|| Ok(())),
            Box::new(move || retype),
        );
        deps.every = Some(Box::new(|_, _| Box::new(|| {})));
        (DraftScheduler::new(deps), drafts)
    };

    let (off, drafts) = make(false);
    off.start();
    off.after_switch();
    off.tick();
    off.retype_changed();
    off.retry_accessibility(false);
    off.retry_accessibility(true);
    assert!(calls.lock().unwrap().is_empty());
    assert_eq!(
        drafts
            .lock()
            .unwrap()
            .iter()
            .map(|d| (d.id.clone(), d.state, d.reason.clone()))
            .collect::<Vec<_>>(),
        vec![
            mark("mine", DraftState::NeedsCopy, Some("manual")),
            mark("theirs", DraftState::NeedsCopy, Some("manual")),
            mark("denied", DraftState::NeedsCopy, Some("accessibility")),
        ]
    );

    // The same scheduler with re-typing on reaches all of them, so the check above can fail.
    let (on, _) = make(true);
    on.after_switch();
    let calls = calls.lock().unwrap();
    for name in [
        "currentAccount",
        "pending",
        "running",
        "uptimeMs",
        "automation.inspect",
    ] {
        assert!(calls.iter().any(|c| c == name), "{name}");
    }
}

#[test]
fn turning_re_typing_off_leaves_the_drafts_still_pending_for_copy_on_the_next_pass() {
    // Waiting only for another account: the 60 s check is armed.
    let h = with_drafts(vec![theirs("theirs")]);
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 1);
    assert_eq!(h.st().every, Some(60_000));
    h.st().retype = false;
    h.scheduler.retype_changed();
    assert_eq!(
        h.st().marks,
        vec![mark("theirs", DraftState::NeedsCopy, Some("manual"))]
    );
    assert_eq!(
        h.st().notices,
        vec![DraftCounts {
            restored: 0,
            left: 1
        }]
    );
    assert_eq!(h.st().every, None);
    assert_eq!(h.st().runs, 1);
}

#[test]
fn re_typing_turned_off_during_a_run_leaves_what_that_run_left_pending_for_copy_right_after_it() {
    let calls = Arc::new(AtomicUsize::new(0));
    let gates = Arc::new(Gates::default());
    let (c, g) = (Arc::clone(&calls), Arc::clone(&gates));
    let h = Arc::new(harness(Over {
        restore: Some(Box::new(move |_, _| {
            c.fetch_add(1, Ordering::SeqCst);
            g.hold();
            Ok(stopped("moved"))
        })),
        ..Over::default()
    }));
    let run = spawn(&h, |h| h.scheduler.after_switch());
    wait_until("the run", || count(&calls) == 1);
    h.st().retype = false;
    let change = spawn(&h, |h| h.scheduler.retype_changed());
    flush();
    gates.open_next();
    run.join().unwrap();
    change.join().unwrap();
    assert_eq!(count(&calls), 1);
    assert_eq!(
        h.st().marks,
        vec![mark("one", DraftState::NeedsCopy, Some("manual"))]
    );
    assert_eq!(h.st().every, None);
}

#[test]
fn with_re_typing_off_retrying_after_accessibility_moves_nothing_back() {
    let h = retype_off(vec![for_access("a"), for_access("b")]);
    assert_eq!(h.scheduler.retry_accessibility(false), 0);
    assert_eq!(h.scheduler.retry_accessibility(true), 0);
    assert!(h.st().marks.is_empty());
    assert_eq!(h.st().reads, 0);
    assert_eq!(h.st().changed, 0);
    assert_eq!(h.st().armed, 0);
}

#[test]
fn the_10_s_retries_arm_only_for_a_draft_for_desktops_account_others_get_a_60_s_look_at_the_account()
 {
    let h = with_drafts(vec![theirs("theirs")]);
    h.scheduler.after_switch();
    assert_eq!(h.st().runs, 1);
    assert_eq!(h.st().every, Some(60_000));
    // The 60 s check reads Desktop's account only: no drafts, no restore.
    let reads = h.st().reads;
    let account_reads = h.st().account_reads;
    h.fire_tick();
    assert_eq!(h.st().account_reads, account_reads + 1);
    assert_eq!(h.st().reads, reads);
    assert_eq!(h.st().runs, 1);
    assert_eq!(h.st().every, Some(60_000));
    // Desktop is on the draft's account now: a full pass, then 10 s retries.
    h.st().account = Some(OTHER.to_uppercase());
    h.fire_tick();
    assert_eq!(h.st().runs, 2);
    assert_eq!(h.st().every, Some(10_000));
    // With nothing pending, nothing is armed.
    h.st().drafts.clear();
    h.scheduler.tick();
    assert_eq!(h.st().every, None);
    assert_eq!(h.st().runs, 2);
}

#[test]
fn once_desktops_account_has_no_draft_pending_the_10_s_retries_give_way_to_the_60_s_check() {
    let h = with_drafts(vec![summary("mine"), theirs("theirs")]);
    h.scheduler.after_switch();
    assert_eq!(h.st().every, Some(10_000));
    h.push(result(RestoreStatus::Done, 1, 0));
    h.st().during = Some(Box::new(|st| st.drafts.retain(|d| d.id != "mine")));
    h.scheduler.tick();
    assert_eq!(h.st().every, Some(60_000));
    assert_eq!(h.st().cancelled, 1);
}

#[test]
fn at_launch_drafts_waiting_only_for_other_accounts_arm_the_60_s_check_not_the_10_s_retries() {
    let h = with_drafts(vec![theirs("theirs")]);
    h.scheduler.start();
    assert_eq!(h.st().every, Some(60_000));
    assert_eq!(h.st().runs, 0);
    // Desktop signed out: no draft is for its account either.
    let h = base();
    h.st().account = None;
    h.scheduler.start();
    assert_eq!(h.st().every, Some(60_000));
    assert_eq!(h.st().runs, 0);
    // Signed in to the draft's account: a full pass.
    h.st().account = Some(ACCOUNT.into());
    h.fire_tick();
    assert_eq!(h.st().runs, 1);
    assert_eq!(h.st().every, Some(10_000));
}

#[test]
fn re_typing_runs_only_on_macos_once_turned_on_linux_leaves_every_draft_for_copy() {
    assert!(draft_retype_enabled(Some(true), Some("darwin")));
    assert!(!draft_retype_enabled(None, Some("darwin")));
    assert!(!draft_retype_enabled(Some(false), Some("darwin")));
    for platform in ["linux", "win32"] {
        assert!(
            !draft_retype_enabled(Some(true), Some(platform)),
            "{platform}"
        );
    }
}

#[test]
fn setting_a_draft_back_to_pending_removes_its_reason_in_the_vault() {
    let f = vault_fixture();
    let (conversation, new_session) = (f.records[0].clone(), f.records[1].clone());
    f.mark(
        &conversation.id,
        DraftState::NeedsCopy,
        Some("accessibility"),
    );
    f.mark(&new_session.id, DraftState::NeedsCopy, Some("manual"));
    f.mark(&conversation.id, DraftState::Pending, None);
    let drafts = f.fixture.manager.pending_drafts();
    let back = drafts.iter().find(|d| d.id == conversation.id).unwrap();
    assert_eq!(back.state, DraftState::Pending);
    assert!(serde_json::to_value(back).unwrap().get("reason").is_none());
    assert_eq!(
        drafts
            .iter()
            .find(|d| d.id == new_session.id)
            .unwrap()
            .reason
            .as_deref(),
        Some("manual")
    );
    // Its text is as it was captured.
    assert_eq!(
        f.fixture.manager.draft_text(&conversation.id).as_deref(),
        Some(TEXT)
    );
}

#[test]
fn the_restore_notification_counts_drafts_and_never_names_them() {
    let notice = |restored, left, language, platform: Option<&str>| {
        draft_notice(DraftCounts { restored, left }, language, platform)
    };
    let darwin = Some("darwin");
    assert_eq!(
        notice(2, 0, Locale::Tr, darwin).as_deref(),
        Some("2 taslak yeniden yazıldı")
    );
    assert_eq!(
        notice(1, 0, Locale::En, darwin).as_deref(),
        Some("1 draft restored")
    );
    assert_eq!(
        notice(2, 0, Locale::En, darwin).as_deref(),
        Some("2 drafts restored")
    );
    assert_eq!(
        notice(0, 1, Locale::Tr, darwin).as_deref(),
        Some("1 taslak panelde bekliyor")
    );
    assert_eq!(
        notice(0, 1, Locale::En, darwin).as_deref(),
        Some("1 draft waiting in the panel")
    );
    assert_eq!(
        notice(0, 3, Locale::En, darwin).as_deref(),
        Some("3 drafts waiting in the panel")
    );
    assert_eq!(
        notice(2, 1, Locale::Tr, darwin).as_deref(),
        Some("2 taslak yeniden yazıldı · 1 taslak panelde bekliyor")
    );
    assert_eq!(
        notice(1, 2, Locale::En, darwin).as_deref(),
        Some("1 draft restored · 2 drafts waiting in the panel")
    );
    // Linux has no menu bar panel: the drafts wait for Copy in Settings.
    assert_eq!(
        notice(0, 2, Locale::En, Some("linux")).as_deref(),
        Some("2 drafts waiting to copy in Settings → Advanced → Experimental")
    );
    assert_eq!(
        notice(0, 1, Locale::Tr, Some("linux")).as_deref(),
        Some("1 taslak Ayarlar → Gelişmiş → Deneysel’de kopyalanmayı bekliyor")
    );
    assert_eq!(notice(0, 0, Locale::Tr, None), None);
}
