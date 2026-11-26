//! Port of `tests/desktop-lock.test.ts`. The TS awaits interleave on one thread; here each
//! caller runs on its own thread and the test waits for the lock's counters where the TS
//! flushes its microtasks.

use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use relay_core::desktop_lock::{
    DESKTOP_HANDOFF, DesktopFileLock, DesktopLock, DesktopLockError, DesktopLockKind,
};
use relay_core::process_lock::{LockBusyError, LockBy, LockInfo, ProcessLockError};

/// A latch and the function that opens it (`gate()`).
#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    wake: Condvar,
}

impl Gate {
    fn new() -> Arc<Gate> {
        Arc::new(Gate::default())
    }
    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.wake.notify_all();
    }
    fn closed(&self) {
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.wake.wait(open).unwrap();
        }
    }
}

/// Waits for `ready`, failing after the TS cases' 5 s timeout.
fn until(ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out");
        thread::sleep(Duration::from_millis(1));
    }
}

fn plain() -> Arc<DesktopLock> {
    Arc::new(DesktopLock::default())
}

type Log = Arc<Mutex<Vec<String>>>;

fn log() -> Log {
    Arc::new(Mutex::new(Vec::new()))
}

fn push(log: &Log, entry: &str) {
    log.lock().unwrap().push(entry.to_owned());
}

fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

#[test]
fn desktop_operations_run_one_at_a_time_in_the_order_they_ask_and_each_is_told_inside_the_lock() {
    let told = log();
    let listener = Arc::clone(&told);
    let lock = Arc::new_cyclic(|me: &Weak<DesktopLock>| {
        let me = me.clone();
        DesktopLock::new(
            Box::new(move || {
                let active = me.upgrade().is_some_and(|lock| lock.active());
                push(&listener, if active { "begin" } else { "end" });
            }),
            None,
        )
    });
    let order = log();
    let first = Gate::new();
    let one = {
        let (lock, order, first) = (Arc::clone(&lock), Arc::clone(&order), Arc::clone(&first));
        thread::spawn(move || {
            lock.run(|| {
                push(&order, "one");
                first.closed();
                Ok::<_, DesktopLockError>(())
            })
        })
    };
    until(|| entries(&order) == ["one"]);
    let two = {
        let (lock, order) = (Arc::clone(&lock), Arc::clone(&order));
        thread::spawn(move || {
            lock.run(|| {
                push(&order, "two");
                Ok::<_, DesktopLockError>(())
            })
        })
    };
    until(|| lock.callers() == 2);
    // The waiter is not told while it waits.
    assert_eq!(entries(&order), ["one"]);
    assert_eq!(entries(&told), ["begin"]);
    assert_eq!(lock.callers(), 2);
    assert!(lock.busy());
    first.open();
    one.join().unwrap().unwrap();
    two.join().unwrap().unwrap();
    assert_eq!(entries(&order), ["one", "two"]);
    assert_eq!(entries(&told), ["begin", "end", "begin", "end"]);
    assert_eq!(lock.callers(), 0);
    assert!(!lock.active());
    assert!(!lock.busy());
    assert_eq!(lock.operations(), 2);
    // A listener that throws changes nothing.
    let quiet = DesktopLock::new(Box::new(|| panic!("listener")), None);
    assert_eq!(quiet.run(|| Ok::<_, DesktopLockError>(3)).unwrap(), 3);
}

#[test]
fn a_manual_action_during_another_operation_is_refused_as_before() {
    let lock = plain();
    let held = Gate::new();
    let running = {
        let (lock, held) = (Arc::clone(&lock), Arc::clone(&held));
        thread::spawn(move || {
            lock.run(|| {
                held.closed();
                Ok::<_, DesktopLockError>(())
            })
        })
    };
    until(|| lock.active());
    let ran = Mutex::new(false);
    let error = lock
        .manual(
            || {
                *ran.lock().unwrap() = true;
                Ok::<_, DesktopLockError>(())
            },
            None,
        )
        .unwrap_err();
    assert_eq!(error.to_string(), DESKTOP_HANDOFF);
    assert_eq!(
        DESKTOP_HANDOFF,
        "Finish the Desktop handoff before starting another Desktop operation."
    );
    held.open();
    running.join().unwrap().unwrap();
    assert!(!*ran.lock().unwrap());
    assert_eq!(lock.manual(|| Ok::<_, Thrown>(5), None).unwrap(), 5);
    // The caller's own reason refuses it too, after the lock's.
    let refuse = || {
        Some(Thrown::Error(
            "Wait for the account connection refresh to finish.".into(),
        ))
    };
    let error = lock
        .manual(
            || {
                *ran.lock().unwrap() = true;
                Ok::<_, Thrown>(())
            },
            Some(&refuse),
        )
        .unwrap_err();
    assert!(matches!(error, Thrown::Error(m) if m.contains("account connection refresh")));
    assert!(!*ran.lock().unwrap());
    assert_eq!(lock.callers(), 0);
}

#[test]
fn a_manual_action_during_a_restore_record_waits_for_it_then_runs_and_the_restore_s_next_record_sees_busy()
 {
    let lock = plain();
    let record = Gate::new();
    let order = log();
    let restoring = {
        let (lock, record, order) = (Arc::clone(&lock), Arc::clone(&record), Arc::clone(&order));
        thread::spawn(move || {
            lock.restore(
                || {
                    push(&order, "record");
                    record.closed();
                    push(&order, "record done");
                    Ok::<_, DesktopLockError>(())
                },
                || true,
            )
        })
    };
    until(|| entries(&order) == ["record"]);
    assert!(lock.active());
    assert!(lock.restoring());
    // A restore alone is not what the user sees as busy.
    assert!(!lock.busy());
    assert_eq!(lock.operations(), 0);

    let manual = {
        let (lock, order) = (Arc::clone(&lock), Arc::clone(&order));
        thread::spawn(move || {
            let inner = Arc::clone(&lock);
            lock.manual(
                move || {
                    push(&order, "switch");
                    assert!(!inner.restoring());
                    Ok::<_, DesktopLockError>("switched")
                },
                None,
            )
        })
    };
    until(|| lock.busy());
    assert_eq!(entries(&order), ["record"]);
    assert!(lock.busy());
    // Another action while the switch waits is refused, as during any operation.
    let error = lock
        .manual(|| Ok::<_, DesktopLockError>(()), None)
        .unwrap_err();
    assert!(error.to_string().contains("Finish the Desktop handoff"));
    // The restore's next record finds the lock taken, at once.
    let started = Instant::now();
    let next = lock
        .restore(
            || -> Result<(), DesktopLockError> { panic!("not run") },
            || true,
        )
        .unwrap();
    assert_eq!(next, None);
    assert!(started.elapsed() < Duration::from_millis(50));
    record.open();
    assert_eq!(manual.join().unwrap().unwrap(), "switched");
    restoring.join().unwrap().unwrap();
    assert_eq!(entries(&order), ["record", "record done", "switch"]);
    assert_eq!(lock.operations(), 1);
    assert_eq!(lock.callers(), 0);
}

/// What a TS `withLock` callback may throw: the restorer's stop object, an `Error`, or the
/// lock's own refusal.
#[derive(Debug, Clone, PartialEq)]
enum Thrown {
    Stop { leaves: String, reason: String },
    Error(String),
    Lock(String),
}

impl From<DesktopLockError> for Thrown {
    fn from(error: DesktopLockError) -> Self {
        Thrown::Lock(error.to_string())
    }
}

#[test]
fn the_restorer_s_lock_is_refused_at_once_while_desktop_is_busy_and_lets_anything_thrown_through_unchanged()
 {
    let lock = plain();
    let manager_busy = Mutex::new(false);
    let with_lock = |f: &mut dyn FnMut() -> Result<String, Thrown>| {
        lock.restore(f, || !*manager_busy.lock().unwrap())
    };
    assert_eq!(
        with_lock(&mut || Ok("7".into())).unwrap().as_deref(),
        Some("7")
    );

    // Another Desktop operation holds the lock: None at once, without running or waiting.
    let held = Gate::new();
    let holding = {
        let (lock, held) = (Arc::clone(&lock), Arc::clone(&held));
        thread::spawn(move || {
            lock.run(|| {
                held.closed();
                Ok::<_, DesktopLockError>(())
            })
        })
    };
    until(|| lock.active());
    let mut ran = false;
    let started = Instant::now();
    let answer = with_lock(&mut || {
        ran = true;
        Ok(String::new())
    })
    .unwrap();
    assert_eq!(answer, None);
    assert!(started.elapsed() < Duration::from_millis(50));
    assert!(!ran);
    held.open();
    holding.join().unwrap().unwrap();

    // DesktopManager runs an operation of its own.
    *manager_busy.lock().unwrap() = true;
    let answer = with_lock(&mut || {
        ran = true;
        Ok(String::new())
    })
    .unwrap();
    assert_eq!(answer, None);
    assert!(!ran);
    *manager_busy.lock().unwrap() = false;

    // What is thrown comes out as it went in, Error or not, and the lock is free after it.
    let stop = Thrown::Stop {
        leaves: "pending".into(),
        reason: "changed".into(),
    };
    assert_eq!(with_lock(&mut || Err(stop.clone())).unwrap_err(), stop);
    assert_eq!(lock.callers(), 0);
    assert!(!lock.active());
    let error = Thrown::Error("helper".into());
    assert_eq!(with_lock(&mut || Err(error.clone())).unwrap_err(), error);
    assert_eq!(lock.callers(), 0);
    assert_eq!(
        with_lock(&mut || Ok("again".into())).unwrap().as_deref(),
        Some("again")
    );
    // Restores are not counted as operations the menu bar must treat as racing its reads.
    assert_eq!(lock.operations(), 1);
}

fn holder() -> LockInfo {
    LockInfo {
        pid: 1,
        token: "t".into(),
        by: LockBy::Cli,
        kind: "switch".into(),
        started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

/// A file lock whose `acquire` and `release` are the test's own.
struct FileLock<A: Fn(DesktopLockKind) -> Result<(), ProcessLockError> + Send + Sync> {
    acquire: A,
    release: Box<dyn Fn() + Send + Sync>,
}

impl<A: Fn(DesktopLockKind) -> Result<(), ProcessLockError> + Send + Sync> DesktopFileLock
    for FileLock<A>
{
    fn acquire(&self, kind: DesktopLockKind) -> Result<(), ProcessLockError> {
        (self.acquire)(kind)
    }
    fn release(&self) {
        (self.release)()
    }
}

#[test]
fn an_operation_whose_file_lock_is_busy_rejects_and_frees_the_queue() {
    let busy = Arc::new(Mutex::new(true));
    let taken = log();
    let (is_busy, took, gave) = (Arc::clone(&busy), Arc::clone(&taken), Arc::clone(&taken));
    let lock = DesktopLock::new(
        Box::new(|| {}),
        Some(Box::new(FileLock {
            acquire: move |kind: DesktopLockKind| {
                if *is_busy.lock().unwrap() {
                    return Err(LockBusyError { holder: holder() }.into());
                }
                push(&took, &format!("+{}", kind.as_str()));
                Ok(())
            },
            release: Box::new(move || push(&gave, "-")),
        })),
    );
    let mut ran = false;
    let error = lock
        .run(|| {
            ran = true;
            Ok::<_, DesktopLockError>(())
        })
        .unwrap_err();
    assert!(matches!(
        error,
        DesktopLockError::File(ProcessLockError::Busy(_))
    ));
    assert!(!ran);
    assert!(!lock.busy());
    assert!(!lock.active());
    *busy.lock().unwrap() = false;
    assert_eq!(lock.run(|| Ok::<_, DesktopLockError>(7)).unwrap(), 7);
    assert_eq!(entries(&taken), ["+desktop-task", "-"]);
}

#[test]
fn a_draft_restore_gives_up_when_another_process_holds_the_file_lock() {
    let lock = DesktopLock::new(
        Box::new(|| {}),
        Some(Box::new(FileLock {
            acquire: |kind: DesktopLockKind| {
                if kind == DesktopLockKind::DraftRetype {
                    return Err(LockBusyError { holder: holder() }.into());
                }
                Ok(())
            },
            release: Box::new(|| {}),
        })),
    );
    let mut ran = false;
    assert_eq!(
        lock.restore(
            || {
                ran = true;
                Ok::<_, DesktopLockError>(1)
            },
            || true,
        )
        .unwrap(),
        None
    );
    assert!(!ran);
    assert_eq!(lock.callers(), 0);
}

#[test]
fn the_app_names_its_holders_for_the_other_process_a_desktop_task_or_a_draft_being_re_typed() {
    let kinds = log();
    let seen = Arc::clone(&kinds);
    let lock = DesktopLock::new(
        Box::new(|| {}),
        Some(Box::new(FileLock {
            acquire: move |kind: DesktopLockKind| {
                push(&seen, kind.as_str());
                Ok(())
            },
            release: Box::new(|| {}),
        })),
    );
    lock.run(|| Ok::<_, DesktopLockError>(())).unwrap();
    lock.restore(|| Ok::<_, DesktopLockError>(1), || true)
        .unwrap();
    assert_eq!(entries(&kinds), ["desktop-task", "draft-retype"]);
}

// The cases that run `restore_drafts` through the lock.

use relay_core::continuation::SessionStatus;
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationGuard, DesktopAutomationSnapshot, DesktopDraftGuard,
    DesktopHostError, DesktopSendResult, OpenSessionOptions, SnapshotCoverage, WriteDraftOptions,
};
use relay_core::draft_restorer::{
    DraftCounts, RestoreOptions, RestoreResult, RestoreStatus, RestorerDeps, restore_drafts,
};
use relay_core::draft_vault::{DraftRecord, DraftState};

const ACCOUNT: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const HOME: &str = "local_ffffffff-ffff-4fff-8fff-ffffffffffff";

fn alias(n: u32) -> String {
    format!("{n:08}-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}

fn record(n: u32) -> DraftRecord {
    DraftRecord {
        id: format!("draft-{n}"),
        to: ACCOUNT.into(),
        target_alias: Some(alias(n)),
        new_session: None,
        title: format!("Conversation {n}"),
        text: format!("draft {n}"),
        attachments: false,
        captured_at: "1970-01-01T00:00:00.000Z".into(),
        state: DraftState::Pending,
        reason: None,
    }
}

fn screen(place: &str, text: Option<&str>, fingerprint: String) -> DesktopAutomationSnapshot {
    DesktopAutomationSnapshot {
        observed_at: 1,
        pid: 7,
        local_session_id: Some(place.into()),
        new_session: None,
        account_label: Some("Test User".into()),
        permission_mode: Some("Auto".into()),
        status: SessionStatus::Stopped,
        quota_stopped: false,
        composer_present: Some(true),
        composer_empty: text.is_none_or(str::is_empty),
        composer_empty_as: None,
        composer_chars: None,
        screen: None,
        panes: None,
        pane_found: None,
        send_enabled: text.is_some_and(|t| !t.is_empty()),
        quota_auto_resume: None,
        visible_active_tasks: None,
        visible_waiting_tasks: None,
        visible_scheduled_tasks: None,
        context_fingerprint: fingerprint,
        coverage: SnapshotCoverage::ActiveConversationOnly,
        frontmost: Some(true),
        idle_ms: Some(60_000),
        key_idle_ms: None,
    }
}

type Inspect = Box<dyn Fn() -> DesktopAutomationSnapshot + Send + Sync>;
type Open = Box<dyn Fn(&str) + Send + Sync>;
type Write = Box<dyn Fn(&str) -> DesktopAutomationSnapshot + Send + Sync>;

/// The TS `Pick<DesktopAutomation, …>` fake; every other method fails the test.
struct Screen {
    inspect: Inspect,
    open: Open,
    write: Option<Write>,
}

impl DesktopAutomation for Screen {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Ok((self.inspect)())
    }
    fn open_session(
        &self,
        id: &str,
        _: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError> {
        (self.open)(id);
        Ok(())
    }
    fn open_new_session(&self, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        panic!("no new-session draft")
    }
    fn set_permission(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        panic!("not used")
    }
    fn send(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
        _: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        panic!("not used")
    }
    fn has_request_marker(&self, _: &str) -> Result<bool, DesktopHostError> {
        panic!("not used")
    }
    fn write_draft(
        &self,
        _: &DesktopDraftGuard,
        text: &str,
        _: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Ok((self.write.as_ref().expect("nothing is typed"))(text))
    }
}

/// The TS `restoreDrafts({...})` dependencies, over a shared [`DesktopLock`].
struct Restore {
    lock: Arc<DesktopLock>,
    automation: Screen,
    pending: Vec<DraftRecord>,
    mark: Box<dyn Fn(&str) + Send + Sync>,
    remove: Box<dyn Fn(&str) + Send + Sync>,
    current_account: Box<dyn Fn() -> String + Send + Sync>,
    notify: Box<dyn Fn() + Send + Sync>,
    sleep: Box<dyn Fn(u64) + Send + Sync>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl RestorerDeps for Restore {
    fn automation(&self) -> &dyn DesktopAutomation {
        &self.automation
    }
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError> {
        Ok(self.pending.clone())
    }
    fn mark(&self, id: &str, _: DraftState, _: Option<&str>) -> Result<(), DesktopHostError> {
        (self.mark)(id);
        Ok(())
    }
    fn remove(&self, id: &str) -> Result<(), DesktopHostError> {
        (self.remove)(id);
        Ok(())
    }
    fn current_account(&self) -> Result<Option<String>, DesktopHostError> {
        Ok(Some((self.current_account)()))
    }
    fn running(&self) -> Result<bool, DesktopHostError> {
        Ok(true)
    }
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError> {
        Ok(Some(60_000))
    }
    fn with_lock(&self, f: &mut dyn FnMut()) -> Result<bool, DesktopHostError> {
        self.lock
            .restore(
                || {
                    f();
                    Ok::<(), DesktopHostError>(())
                },
                || true,
            )
            .map(|ran| ran.is_some())
    }
    fn yielding(&self) -> bool {
        self.lock.callers() > 1
    }
    fn notify(&self, _: DraftCounts) -> Result<(), DesktopHostError> {
        (self.notify)();
        Ok(())
    }
    fn sleep(&self, ms: u64) -> Result<(), DesktopHostError> {
        (self.sleep)(ms);
        Ok(())
    }
    fn now(&self) -> i64 {
        (self.now)()
    }
}

fn waiting(restored: usize, left: usize, reason: &str) -> RestoreResult {
    RestoreResult {
        status: RestoreStatus::Waiting,
        restored,
        left,
        reason: Some(reason.into()),
    }
}

type Manual = Arc<Mutex<Option<thread::JoinHandle<Result<&'static str, DesktopLockError>>>>>;

#[test]
fn a_switch_asked_for_during_a_restored_draft_stops_the_restore_after_that_draft_the_rest_pending()
{
    let lock = plain();
    let views: Arc<Mutex<std::collections::HashMap<String, String>>> = Arc::default();
    let shown = Arc::new(Mutex::new(HOME.to_owned()));
    let calls = log();
    let view = {
        let (views, shown) = (Arc::clone(&views), Arc::clone(&shown));
        move || {
            let shown = shown.lock().unwrap().clone();
            let text = views.lock().unwrap().get(&shown).cloned();
            let fingerprint = format!("fp:{shown}:{}", text.clone().unwrap_or_default());
            screen(&shown, text.as_deref(), fingerprint)
        }
    };
    let view = Arc::new(view);
    let manual: Manual = Arc::default();
    let waited_for = Arc::new(Mutex::new(false));
    // A switch takes a while: it still holds the lock when the restore asks for its next record.
    let switching = Gate::new();
    let removed = log();
    let deps = Restore {
        lock: Arc::clone(&lock),
        automation: Screen {
            inspect: Box::new({
                let view = Arc::clone(&view);
                move || view()
            }),
            open: Box::new({
                let (calls, shown) = (Arc::clone(&calls), Arc::clone(&shown));
                move |id| {
                    push(&calls, &format!("open:{id}"));
                    *shown.lock().unwrap() = id.to_owned();
                }
            }),
            write: Some(Box::new({
                let (calls, shown, views, view) = (
                    Arc::clone(&calls),
                    Arc::clone(&shown),
                    Arc::clone(&views),
                    Arc::clone(&view),
                );
                move |text| {
                    let place = shown.lock().unwrap().clone();
                    push(&calls, &format!("write:{place}"));
                    views.lock().unwrap().insert(place, text.to_owned());
                    view()
                }
            })),
        },
        pending: vec![record(1), record(2)],
        mark: Box::new(|_| panic!("nothing is left for copy")),
        remove: Box::new({
            let removed = Arc::clone(&removed);
            move |id| push(&removed, id)
        }),
        current_account: Box::new(|| ACCOUNT.into()),
        notify: Box::new(|| {}),
        sleep: Box::new({
            let (lock, calls, manual, waited_for, switching) = (
                Arc::clone(&lock),
                Arc::clone(&calls),
                Arc::clone(&manual),
                Arc::clone(&waited_for),
                Arc::clone(&switching),
            );
            move |ms| {
                // The 5 s re-check of the first draft, inside its lock: the user asks for a switch.
                let mut manual = manual.lock().unwrap();
                if ms == 5_000 && manual.is_none() {
                    let (held, said, switching) = (
                        Arc::clone(&lock),
                        Arc::clone(&calls),
                        Arc::clone(&switching),
                    );
                    *manual = Some(thread::spawn(move || {
                        held.manual(
                            || {
                                push(&said, "switch");
                                switching.closed();
                                Ok("switched")
                            },
                            None,
                        )
                    }));
                    until(|| lock.callers() == 2);
                    *waited_for.lock().unwrap() = !entries(&calls).contains(&"switch".to_owned());
                }
            }
        }),
        now: Box::new(|| 0),
    };
    let result = restore_drafts(&deps, RestoreOptions::default()).unwrap();
    assert!(*waited_for.lock().unwrap());
    // It ran once the first draft was done with.
    until(|| entries(&calls).contains(&"switch".to_owned()));
    let all = entries(&calls);
    let at = |entry: &str| all.iter().position(|c| c == entry).unwrap();
    assert!(at("switch") > at(&format!("write:local_{}", alias(1))));
    switching.open();
    let handle = manual.lock().unwrap().take().unwrap();
    assert_eq!(handle.join().unwrap().unwrap(), "switched");
    assert_eq!(result, waiting(1, 1, "busy"));
    assert_eq!(entries(&removed), ["draft-1"]);
    // The second draft was never opened or typed.
    assert!(!all.contains(&format!("open:local_{}", alias(2))));
    let writes: Vec<String> = all
        .into_iter()
        .filter(|c| c.starts_with("write:"))
        .collect();
    assert_eq!(writes, [format!("write:local_{}", alias(1))]);
    assert_eq!(lock.callers(), 0);
}

#[test]
fn a_switch_asked_for_while_the_restore_waits_for_its_target_is_let_through_before_anything_is_typed()
 {
    let lock = plain();
    let calls = log();
    let marks = log();
    let clock = Arc::new(Mutex::new(0i64));
    let manual: Manual = Arc::default();
    let deps = Restore {
        lock: Arc::clone(&lock),
        automation: Screen {
            // Desktop is slow to follow the link: the screen stays where the user was.
            inspect: Box::new(|| screen(HOME, None, "fp".into())),
            open: Box::new({
                let calls = Arc::clone(&calls);
                move |id| push(&calls, &format!("open:{id}"))
            }),
            write: None,
        },
        pending: vec![record(1), record(2)],
        mark: Box::new({
            let marks = Arc::clone(&marks);
            move |id| push(&marks, id)
        }),
        remove: Box::new(|_| panic!("nothing is removed")),
        current_account: Box::new(|| ACCOUNT.into()),
        notify: Box::new(|| {}),
        sleep: Box::new({
            let (lock, calls, manual, clock) = (
                Arc::clone(&lock),
                Arc::clone(&calls),
                Arc::clone(&manual),
                Arc::clone(&clock),
            );
            move |ms| {
                *clock.lock().unwrap() += ms as i64;
                // The user asks for a switch while Relay waits for the first draft's conversation.
                let mut manual = manual.lock().unwrap();
                if ms == 500 && manual.is_none() {
                    let (held, said) = (Arc::clone(&lock), Arc::clone(&calls));
                    *manual = Some(thread::spawn(move || {
                        held.manual(
                            || {
                                push(&said, "switch");
                                Ok("switched")
                            },
                            None,
                        )
                    }));
                    until(|| lock.callers() == 2);
                }
            }
        }),
        now: Box::new({
            let clock = Arc::clone(&clock);
            move || *clock.lock().unwrap()
        }),
    };
    let result = restore_drafts(&deps, RestoreOptions::default()).unwrap();
    assert_eq!(result, waiting(0, 2, "busy"));
    let handle = manual.lock().unwrap().take().unwrap();
    assert_eq!(handle.join().unwrap().unwrap(), "switched");
    // One link, then the switch: no link sent again, nothing typed, nothing left for copy.
    assert_eq!(
        entries(&calls),
        [format!("open:local_{}", alias(1)), "switch".into()]
    );
    assert!(entries(&marks).is_empty());
    assert_eq!(lock.callers(), 0);
}

#[test]
fn the_restorer_s_own_stop_passes_through_the_lock() {
    // Under the lock the account has changed: the restorer's stop passes through with_lock.
    let lock = plain();
    let account_reads = Arc::new(Mutex::new(0));
    let deps = Restore {
        lock: Arc::clone(&lock),
        automation: Screen {
            inspect: Box::new(|| screen(HOME, None, "fp".into())),
            open: Box::new(|_| panic!("nothing is opened")),
            write: None,
        },
        pending: vec![record(1)],
        mark: Box::new(|_| panic!("nothing is left for copy")),
        remove: Box::new(|_| panic!("nothing is removed")),
        current_account: Box::new(move || {
            let mut reads = account_reads.lock().unwrap();
            *reads += 1;
            if *reads == 1 { ACCOUNT } else { OTHER }.into()
        }),
        notify: Box::new(|| panic!("nothing to tell")),
        sleep: Box::new(|_| {}),
        now: Box::new(|| 0),
    };
    let result = restore_drafts(&deps, RestoreOptions::default()).unwrap();
    assert_eq!(result, waiting(0, 1, "changed"));
    assert_eq!(lock.callers(), 0);
}
