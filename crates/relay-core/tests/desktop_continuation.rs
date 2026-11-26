//! Port of `tests/desktop-continuation.test.ts`.
//!
//! The TS fixtures are plain objects whose functions tests replace after a manager was built
//! (`f.deps.observe = …`) and spread into new dependency objects (`{ ...f.deps, … }`). Here
//! [`Deps`] holds each replaceable function in a slot shared by clones (the same object) and
//! copied by [`Deps::spread`] (a spread); `engine` stays one shared object, as in the TS.

#[path = "common/continuation.rs"]
mod helpers;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use helpers::{account, capabilities, guarded_native, now, uuid};
use relay_core::continuation::{
    ContinuationCapabilities, ContinuationCheckpoint, ContinuationCheckpointInput,
    ContinuationDelivery, ContinuationEngine, ContinuationError, ContinuationHost,
    ContinuationHostKind, ContinuationIdentity, ContinuationJournal, ContinuationKind,
    ContinuationQuiescence, ContinuationReceipt, ContinuationReopenInput, ContinuationRequest,
    ContinuationResult, ContinuationResultStatus, ContinuationSendInput, ContinuationSession,
    ContinuationState, ContinuationSwitchInput, DeliveryStatus, ExecutionPolicy,
    QuiescenceCoverage, SessionStatus,
};
use relay_core::continuation_journal::FileContinuationJournal;
use relay_core::desktop_continuation::{
    CONTINUATION_FAR_POLL_MS, CONTINUATION_POLL_MS, CompletedEpisode, ContinuationStatus,
    ContinuationTimer, DesktopContinuationArmInput, DesktopContinuationContext,
    DesktopContinuationDependencies, DesktopContinuationError, DesktopContinuationManager,
    DesktopContinuationObservation, DesktopContinuationPersistence,
    DesktopContinuationPersistentState, DesktopContinuationSnapshot, DesktopLockAction,
    DesktopQuotaStop, FileDesktopContinuationPersistence, OwnQuotaWakeup, QuotaStopReason,
    TargetSelection, continuation_poll_ms,
};
use relay_core::shared::types::js::{JsMap, iso};
use relay_core::shared::types::{
    Account, AccountPlan, AccountPlanning, AccountUsage, DesktopHistoryTransfer, KnownReset,
    LastKnownResets, RelaySettings, UsageStatus, UsageWindow, default_settings,
};

type DErr = DesktopContinuationError;
type Obs = DesktopContinuationObservation;
type State = DesktopContinuationPersistentState;
type Snapshot = DesktopContinuationSnapshot;
type SaveFilter = fn(&State) -> bool;
type Edit = (&'static str, fn(&Fixture));

type ObserveFn = Arc<dyn Fn() -> Result<Obs, DErr> + Send + Sync>;
type SnapshotFn = Arc<dyn Fn() -> DesktopContinuationContext + Send + Sync>;
type LockFn = Arc<dyn Fn(&mut DesktopLockAction<'_>) -> Result<Snapshot, DErr> + Send + Sync>;
type NowFn = Arc<dyn Fn() -> f64 + Send + Sync>;
type PrepareFn = Arc<dyn Fn(&Obs, &ContinuationRequest) -> Result<Obs, DErr> + Send + Sync>;
type ExecuteFn =
    Arc<dyn Fn(&ContinuationRequest) -> Result<ContinuationResult, DErr> + Send + Sync>;
type AbandonFn = Arc<dyn Fn(&str) -> Result<(), DErr> + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// `t.mock.timers` for `setInterval`: time moves only through [`FakeTimers::tick`].
#[derive(Default)]
struct FakeTimers {
    now: Mutex<f64>,
    intervals: Mutex<Vec<Arc<Interval>>>,
}

struct Interval {
    every: f64,
    next: Mutex<f64>,
    tick: Box<dyn Fn() + Send + Sync>,
    cancelled: AtomicBool,
}

struct FakeTimer(Arc<Interval>);

impl ContinuationTimer for FakeTimer {
    fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
    }
}

impl FakeTimers {
    fn register(
        &self,
        every_ms: u64,
        tick: Box<dyn Fn() + Send + Sync>,
    ) -> Box<dyn ContinuationTimer> {
        let every = every_ms as f64;
        let interval = Arc::new(Interval {
            every,
            next: Mutex::new(*lock(&self.now) + every),
            tick,
            cancelled: AtomicBool::new(false),
        });
        lock(&self.intervals).push(Arc::clone(&interval));
        Box::new(FakeTimer(interval))
    }

    /// Runs every interval callback due within the next `ms`, in time order.
    fn tick(&self, ms: f64) {
        let target = *lock(&self.now) + ms;
        loop {
            let due = lock(&self.intervals)
                .iter()
                .filter(|i| !i.cancelled.load(Ordering::SeqCst) && *lock(&i.next) <= target)
                .min_by(|a, b| lock(&a.next).total_cmp(&lock(&b.next)))
                .cloned();
            let Some(interval) = due else { break };
            let at = *lock(&interval.next);
            *lock(&self.now) = at;
            *lock(&interval.next) = at + interval.every;
            (interval.tick)();
        }
        *lock(&self.now) = target;
    }
}

/// The state one `setup()` closes over.
struct Shared {
    accounts: Mutex<Vec<Account>>,
    usage: Mutex<JsMap<AccountUsage>>,
    settings: Mutex<RelaySettings>,
    observation: Mutex<Obs>,
    persisted: Mutex<State>,
    capabilities: Mutex<ContinuationCapabilities>,
    requests: Mutex<Vec<ContinuationRequest>>,
    result: Mutex<ContinuationResult>,
    desktop_locked: AtomicBool,
    locks: AtomicUsize,
    observations: AtomicUsize,
    preparations: AtomicUsize,
    timers: FakeTimers,
}

/// The in-memory persistence of `setup()`; `fail_when` stands in for a replaced `save`.
struct MemoryPersistence {
    shared: Arc<Shared>,
    fail_when: Mutex<Option<SaveFilter>>,
}

impl DesktopContinuationPersistence for MemoryPersistence {
    fn load(&self) -> Result<State, DErr> {
        Ok(lock(&self.shared.persisted).clone())
    }
    fn save(&self, state: &State) -> Result<(), DErr> {
        if lock(&self.fail_when).is_some_and(|fail| fail(state)) {
            return Err("disk-full".into());
        }
        *lock(&self.shared.persisted) = state.clone();
        Ok(())
    }
}

/// `deps.engine`: one object every spread of the dependencies shares.
struct Engine {
    execute: Mutex<ExecuteFn>,
    abandon_unsent: Mutex<Option<AbandonFn>>,
}

impl Engine {
    /// `{ ...engine, abandonUnsent }`.
    fn with_abandon(&self, abandon: AbandonFn) -> Arc<Engine> {
        Arc::new(Engine {
            execute: Mutex::new(lock(&self.execute).clone()),
            abandon_unsent: Mutex::new(Some(abandon)),
        })
    }
}

type Slot<T> = Arc<Mutex<T>>;

fn slot<T>(value: T) -> Slot<T> {
    Arc::new(Mutex::new(value))
}

#[derive(Clone)]
struct Deps {
    shared: Arc<Shared>,
    observe: Slot<ObserveFn>,
    snapshot: Slot<SnapshotFn>,
    with_desktop_lock: Slot<LockFn>,
    now: Slot<NowFn>,
    prepare_quota_stop: Slot<Option<PrepareFn>>,
    engine: Arc<Engine>,
    persistence: Arc<dyn DesktopContinuationPersistence>,
}

impl Deps {
    /// `{ ...deps }`: the same functions in new slots.
    fn spread(&self) -> Deps {
        Deps {
            shared: Arc::clone(&self.shared),
            observe: slot(lock(&self.observe).clone()),
            snapshot: slot(lock(&self.snapshot).clone()),
            with_desktop_lock: slot(lock(&self.with_desktop_lock).clone()),
            now: slot(lock(&self.now).clone()),
            prepare_quota_stop: slot(lock(&self.prepare_quota_stop).clone()),
            engine: Arc::clone(&self.engine),
            persistence: Arc::clone(&self.persistence),
        }
    }
    fn set_observe(&self, f: impl Fn() -> Result<Obs, DErr> + Send + Sync + 'static) {
        *lock(&self.observe) = Arc::new(f);
    }
    fn set_snapshot(&self, f: impl Fn() -> DesktopContinuationContext + Send + Sync + 'static) {
        *lock(&self.snapshot) = Arc::new(f);
    }
    fn set_lock(
        &self,
        f: impl Fn(&mut DesktopLockAction<'_>) -> Result<Snapshot, DErr> + Send + Sync + 'static,
    ) {
        *lock(&self.with_desktop_lock) = Arc::new(f);
    }
    fn set_prepare(
        &self,
        f: impl Fn(&Obs, &ContinuationRequest) -> Result<Obs, DErr> + Send + Sync + 'static,
    ) {
        *lock(&self.prepare_quota_stop) = Some(Arc::new(f));
    }
    fn prepare(&self) -> PrepareFn {
        lock(&self.prepare_quota_stop)
            .clone()
            .expect("prepareQuotaStop")
    }
    fn set_execute(
        &self,
        f: impl Fn(&ContinuationRequest) -> Result<ContinuationResult, DErr> + Send + Sync + 'static,
    ) {
        *lock(&self.engine.execute) = Arc::new(f);
    }
    fn execute_fn(&self) -> ExecuteFn {
        lock(&self.engine.execute).clone()
    }
}

impl DesktopContinuationDependencies for Deps {
    fn observe(&self) -> Result<Obs, DErr> {
        let observe = lock(&self.observe).clone();
        observe()
    }
    fn capabilities(&self) -> ContinuationCapabilities {
        lock(&self.shared.capabilities).clone()
    }
    fn execute(&self, request: &ContinuationRequest) -> Result<ContinuationResult, DErr> {
        let execute = self.execute_fn();
        execute(request)
    }
    fn supports_abandon_unsent(&self) -> bool {
        lock(&self.engine.abandon_unsent).is_some()
    }
    fn abandon_unsent(&self, request_id: &str) -> Result<(), DErr> {
        let abandon = lock(&self.engine.abandon_unsent)
            .clone()
            .expect("abandonUnsent");
        abandon(request_id)
    }
    fn snapshot(&self) -> DesktopContinuationContext {
        let snapshot = lock(&self.snapshot).clone();
        snapshot()
    }
    fn persistence(&self) -> &dyn DesktopContinuationPersistence {
        &*self.persistence
    }
    fn with_desktop_lock(&self, action: &mut DesktopLockAction<'_>) -> Result<Snapshot, DErr> {
        let with_lock = lock(&self.with_desktop_lock).clone();
        with_lock(action)
    }
    fn now(&self) -> f64 {
        let now = lock(&self.now).clone();
        now()
    }
    fn supports_prepare_quota_stop(&self) -> bool {
        lock(&self.prepare_quota_stop).is_some()
    }
    fn prepare_quota_stop(
        &self,
        observation: &Obs,
        request: &ContinuationRequest,
    ) -> Result<Obs, DErr> {
        let prepare = self.prepare();
        prepare(observation, request)
    }
    fn set_interval(
        &self,
        every_ms: u64,
        tick: Box<dyn Fn() + Send + Sync>,
    ) -> Box<dyn ContinuationTimer> {
        self.shared.timers.register(every_ms, tick)
    }
}

struct Fixture {
    shared: Arc<Shared>,
    deps: Deps,
    manager: DesktopContinuationManager,
    source: String,
    target: String,
    alternate: String,
    memory: Arc<MemoryPersistence>,
}

fn result(status: ContinuationResultStatus, reason: &str) -> ContinuationResult {
    ContinuationResult {
        status,
        continuation_kind: ContinuationKind::StoppedSessionNewTurn,
        reason: reason.into(),
        record: None,
        receipt: None,
    }
}

impl Fixture {
    fn new_manager(&self) -> DesktopContinuationManager {
        DesktopContinuationManager::new(self.deps.clone())
    }
    fn requests(&self) -> Vec<ContinuationRequest> {
        lock(&self.shared.requests).clone()
    }
    fn persisted(&self) -> State {
        lock(&self.shared.persisted).clone()
    }
    fn observation(&self) -> MutexGuard<'_, Obs> {
        lock(&self.shared.observation)
    }
    fn usage(&self) -> MutexGuard<'_, JsMap<AccountUsage>> {
        lock(&self.shared.usage)
    }
    fn caps(&self) -> MutexGuard<'_, ContinuationCapabilities> {
        lock(&self.shared.capabilities)
    }
    fn set_result(&self, status: ContinuationResultStatus, reason: &str) {
        *lock(&self.shared.result) = result(status, reason);
    }
    fn counts(&self) -> (usize, usize) {
        (
            self.shared.observations.load(Ordering::SeqCst),
            self.shared.locks.load(Ordering::SeqCst),
        )
    }
    fn preparations(&self) -> usize {
        self.shared.preparations.load(Ordering::SeqCst)
    }
    fn edit_account(&self, id: &str, edit: impl FnOnce(&mut Account)) {
        let mut accounts = lock(&self.shared.accounts);
        edit(accounts.iter_mut().find(|a| a.id == id).unwrap());
    }
    fn account(&self, id: &str) -> Account {
        lock(&self.shared.accounts)
            .iter()
            .find(|a| a.id == id)
            .unwrap()
            .clone()
    }
    fn identity_of(&self, id: &str) -> ContinuationIdentity {
        helpers::profile_identity(&self.account(id))
    }
    fn edit_usage(&self, id: &str, edit: impl FnOnce(&mut AccountUsage)) {
        edit(self.usage().get_mut(id).unwrap());
    }
    fn scheduled_wakeups(&self) -> f64 {
        self.observation().state.quiescence.scheduled_wakeups
    }
}

fn explicit(target: &str) -> DesktopContinuationArmInput {
    DesktopContinuationArmInput {
        target_account_id: target.into(),
        execution_policy: None,
    }
}

fn guarded(target: &str) -> DesktopContinuationArmInput {
    DesktopContinuationArmInput {
        target_account_id: target.into(),
        execution_policy: Some(ExecutionPolicy::GuardedNativeAtMostOnce),
    }
}

fn automatic_arm() -> DesktopContinuationArmInput {
    guarded("automatic")
}

fn synthetic() -> Account {
    account("Synthetic", "synthetic")
}

fn setup() -> Fixture {
    let (source, target, session_id) = (synthetic(), synthetic(), uuid());
    let observation = Obs {
        state: ContinuationState {
            context_revision: 3.0,
            observed_at: now(),
            identity: helpers::profile_identity(&source),
            session: ContinuationSession {
                id: session_id.clone(),
                project_key: "synthetic-project".into(),
                transcript_revision: "checkpoint-3".into(),
                permission_mode: "Auto".into(),
                status: SessionStatus::Stopped,
                last_request_id: None,
                last_turn_id: Some("ended-turn-3".into()),
            },
            quiescence: ContinuationQuiescence {
                coverage: QuiescenceCoverage::IsolatedAll,
                busy_workers: 0.0,
                subagents: 0.0,
                pending_tasks: 0.0,
                waiting: 0.0,
                queued_prompts: 0.0,
                scheduled_wakeups: 0.0,
                unknown_work: 0.0,
            },
        },
        quota_stop: Some(DesktopQuotaStop {
            reason: QuotaStopReason::RateLimit,
            session_id,
            turn_id: "ended-turn-3".into(),
            observed_at: now(),
        }),
        blocked_reason: None,
        own_quota_wakeup: None,
    };
    let (source_id, target_id) = (source.id.clone(), target.id.clone());
    let shared = Arc::new(Shared {
        accounts: Mutex::new(vec![source, target]),
        usage: Mutex::new(JsMap::new()),
        settings: Mutex::new(default_settings()),
        observation: Mutex::new(observation),
        persisted: Mutex::new(State::default()),
        capabilities: Mutex::new(capabilities(
            ContinuationHostKind::Simulated,
            "synthetic-all",
        )),
        requests: Mutex::new(Vec::new()),
        result: Mutex::new(result(
            ContinuationResultStatus::Continued,
            "new-turn-verified",
        )),
        desktop_locked: AtomicBool::new(false),
        locks: AtomicUsize::new(0),
        observations: AtomicUsize::new(0),
        preparations: AtomicUsize::new(0),
        timers: FakeTimers::default(),
    });
    let memory = Arc::new(MemoryPersistence {
        shared: Arc::clone(&shared),
        fail_when: Mutex::new(None),
    });
    let s = Arc::clone(&shared);
    let observe: ObserveFn = Arc::new(move || {
        s.observations.fetch_add(1, Ordering::SeqCst);
        Ok(lock(&s.observation).clone())
    });
    let s = Arc::clone(&shared);
    let execute: ExecuteFn = Arc::new(move |request: &ContinuationRequest| {
        assert!(
            s.desktop_locked.load(Ordering::SeqCst),
            "execute must hold the shared Desktop lock"
        );
        lock(&s.requests).push(request.clone());
        Ok(lock(&s.result).clone())
    });
    let s = Arc::clone(&shared);
    let snapshot: SnapshotFn = Arc::new(move || DesktopContinuationContext {
        accounts: lock(&s.accounts).clone(),
        settings: lock(&s.settings).clone(),
        usage: lock(&s.usage).clone(),
        tempo_rate: None,
    });
    let s = Arc::clone(&shared);
    let with_lock: LockFn = Arc::new(move |action: &mut DesktopLockAction<'_>| {
        assert!(!s.desktop_locked.load(Ordering::SeqCst));
        s.locks.fetch_add(1, Ordering::SeqCst);
        s.desktop_locked.store(true, Ordering::SeqCst);
        let outcome = action();
        s.desktop_locked.store(false, Ordering::SeqCst);
        outcome
    });
    let deps = Deps {
        shared: Arc::clone(&shared),
        observe: slot(observe),
        snapshot: slot(snapshot),
        with_desktop_lock: slot(with_lock),
        now: slot(Arc::new(now) as NowFn),
        prepare_quota_stop: slot(None),
        engine: Arc::new(Engine {
            execute: Mutex::new(execute),
            abandon_unsent: Mutex::new(None),
        }),
        persistence: memory.clone(),
    };
    Fixture {
        manager: DesktopContinuationManager::new(deps.clone()),
        shared,
        deps,
        source: source_id,
        target: target_id,
        alternate: String::new(),
        memory,
    }
}

fn wakeup_setup() -> Fixture {
    let mut f = setup();
    guarded_native(&mut f.caps());
    {
        let mut observation = f.observation();
        observation.state.quiescence.coverage = QuiescenceCoverage::GuardedLocal;
        observation.state.quiescence.scheduled_wakeups = 1.0;
        observation.own_quota_wakeup = Some(true);
    }
    *f.usage() = [
        (f.source.clone(), helpers::usage(&f.source, 100.0, 20.0)),
        (f.target.clone(), helpers::usage(&f.target, 10.0, 20.0)),
    ]
    .into_iter()
    .collect();
    let deps = f.deps.spread();
    let shared = Arc::clone(&f.shared);
    deps.set_prepare(move |observation, request| {
        shared.preparations.fetch_add(1, Ordering::SeqCst);
        let persisted = lock(&shared.persisted).clone();
        let pending = persisted.pending.as_ref().expect("pending");
        assert_eq!(pending.id, request.id);
        assert_eq!(
            pending.own_quota_wakeup,
            Some(OwnQuotaWakeup::CancellationIntent)
        );
        assert_eq!(persisted.arm, None);
        assert_eq!(observation.own_quota_wakeup, Some(true));
        assert_eq!(
            request.execution_policy,
            Some(ExecutionPolicy::GuardedNativeAtMostOnce)
        );
        assert_eq!(request.expected_context_revision, 3.0);
        let mut current = lock(&shared.observation);
        current.state.quiescence.scheduled_wakeups = 0.0;
        current.state.context_revision += 1.0;
        current.own_quota_wakeup = Some(false);
        Ok(current.clone())
    });
    f.deps = deps;
    f.manager = f.new_manager();
    f
}

fn automatic_setup() -> Fixture {
    let mut f = wakeup_setup();
    let alternate = synthetic();
    f.alternate = alternate.id.clone();
    lock(&f.shared.accounts).push(alternate);
    let alternate_usage = AccountUsage {
        account_id: f.alternate.clone(),
        ..f.usage().get(&f.target).unwrap().clone()
    };
    f.usage().insert(f.alternate.clone(), alternate_usage);
    {
        let mut observation = f.observation();
        observation.state.quiescence.scheduled_wakeups = 0.0;
        observation.own_quota_wakeup = Some(false);
    }
    f.deps = f.deps.spread();
    f.manager = f.new_manager();
    f
}

fn temporary(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
}

#[test]
fn new_manager_defaults_off_read_only_inspection_never_invokes_the_engine() {
    let f = setup();
    assert_eq!(f.manager.snapshot().status, ContinuationStatus::Off);
    f.manager.tick();
    assert_eq!(f.counts(), (0, 0));
    let view = f.manager.inspect();
    assert!(view.can_arm);
    assert_eq!(view.permission_mode.as_deref(), Some("Auto"));
    assert_eq!(
        view.session_id,
        Some(f.observation().state.session.id.clone())
    );
    assert!(f.requests().is_empty());
    assert_eq!(f.persisted().arm, None);
}

#[test]
fn inspection_preserves_actionable_os_permission_errors_without_leaking_arbitrary_diagnostic_text()
{
    let f = setup();
    f.deps
        .set_observe(|| Err("accessibility-permission-required".into()));
    assert_eq!(
        f.manager.inspect().observation_reason.as_deref(),
        Some("accessibility-permission-required")
    );
    f.deps
        .set_observe(|| Err("private-profile-path-and-token".into()));
    let value = f.manager.inspect();
    assert_eq!(
        value.observation_reason.as_deref(),
        Some("desktop-observation-unavailable")
    );
    assert!(
        !serde_json::to_string(&value)
            .unwrap()
            .contains("private-profile-path-and-token")
    );
}

#[test]
fn explicit_selected_target_produces_one_persisted_same_session_handoff_with_unchanged_permissions()
{
    let f = setup();
    let armed = f.manager.arm(&explicit(&f.target)).unwrap();
    assert!(armed.enabled);
    assert_eq!(f.persisted().arm.unwrap().target.profile_id, f.target);
    let result = f.manager.tick();
    assert_eq!(result.status, ContinuationStatus::Continued);
    assert!(!result.enabled);
    let requests = f.requests();
    assert_eq!(Some(&requests[0].session_id), armed.session_id.as_ref());
    assert_eq!(requests[0].permission_mode, "Auto");
    assert_eq!(requests[0].target.id, f.target);
    assert_eq!(f.persisted().completed.len(), 1);
    f.manager.tick();
    assert_eq!(
        f.requests().len(),
        1,
        "successful one-shot does not oscillate accounts"
    );
}

#[test]
fn checking_a_new_unarmed_conversation_does_not_attach_a_previous_completion_badge_or_target() {
    let f = setup();
    f.manager.arm(&explicit(&f.target)).unwrap();
    f.manager.tick();
    let session_id = uuid();
    {
        let mut observation = f.observation();
        observation.state.identity = f.identity_of(&f.target);
        observation.state.session.id = session_id.clone();
    }
    let checked = f.manager.inspect();
    assert_eq!(checked.status, ContinuationStatus::Off);
    assert_eq!(checked.source_id.as_deref(), Some(f.target.as_str()));
    assert_eq!(checked.target_id, None);
    assert_eq!(checked.session_id, Some(session_id));
    assert!(checked.can_arm);
}

#[test]
fn watch_can_be_armed_while_the_selected_session_runs_but_its_tasks_are_never_interrupted() {
    let f = setup();
    {
        let mut observation = f.observation();
        observation.state.session.status = SessionStatus::Running;
        observation.state.quiescence.subagents = 1.0;
    }
    f.manager.arm(&explicit(&f.target)).unwrap();
    assert_eq!(f.manager.tick().reason, "session-not-stopped");
    assert!(f.requests().is_empty());
    f.observation().state.session.status = SessionStatus::Stopped;
    assert_eq!(f.manager.tick().reason, "not-quiescent:subagents");
    assert!(f.requests().is_empty());
}

fn counter<'a>(q: &'a mut ContinuationQuiescence, key: &str) -> &'a mut f64 {
    match key {
        "busyWorkers" => &mut q.busy_workers,
        "subagents" => &mut q.subagents,
        "pendingTasks" => &mut q.pending_tasks,
        "waiting" => &mut q.waiting,
        "queuedPrompts" => &mut q.queued_prompts,
        "scheduledWakeups" => &mut q.scheduled_wakeups,
        "unknownWork" => &mut q.unknown_work,
        other => panic!("unknown counter {other}"),
    }
}

fn nonzero_work_keeps_waiting(work: &str) {
    let f = setup();
    f.manager.arm(&explicit(&f.target)).unwrap();
    *counter(&mut f.observation().state.quiescence, work) = 1.0;
    assert_eq!(f.manager.tick().reason, format!("not-quiescent:{work}"));
    assert!(f.requests().is_empty());
}

#[test]
fn nonzero_busy_workers_keeps_the_application_waiting_without_switching() {
    nonzero_work_keeps_waiting("busyWorkers");
}

#[test]
fn nonzero_pending_tasks_keeps_the_application_waiting_without_switching() {
    nonzero_work_keeps_waiting("pendingTasks");
}

#[test]
fn nonzero_waiting_keeps_the_application_waiting_without_switching() {
    nonzero_work_keeps_waiting("waiting");
}

#[test]
fn nonzero_queued_prompts_keeps_the_application_waiting_without_switching() {
    nonzero_work_keeps_waiting("queuedPrompts");
}

#[test]
fn nonzero_scheduled_wakeups_keeps_the_application_waiting_without_switching() {
    nonzero_work_keeps_waiting("scheduledWakeups");
}

#[test]
fn nonzero_unknown_work_keeps_the_application_waiting_without_switching() {
    nonzero_work_keeps_waiting("unknownWork");
}

#[test]
fn quota_metric_without_a_fresh_matched_ended_turn_signal_does_not_trigger_continuation() {
    let f = setup();
    f.manager.arm(&explicit(&f.target)).unwrap();
    f.observation().quota_stop = None;
    assert_eq!(f.manager.tick().reason, "awaiting-quota-stop");
    {
        let mut observation = f.observation();
        observation.quota_stop = Some(DesktopQuotaStop {
            reason: QuotaStopReason::RateLimit,
            session_id: observation.state.session.id.clone(),
            turn_id: "other-turn".into(),
            observed_at: now(),
        });
    }
    assert_eq!(f.manager.tick().reason, "quota-stop-unverified");
    {
        let mut observation = f.observation();
        let stop = observation.quota_stop.as_mut().unwrap();
        stop.turn_id = "ended-turn-3".into();
        stop.observed_at = now() - 15_001.0;
    }
    assert_eq!(f.manager.tick().reason, "quota-stop-unverified");
    assert!(f.requests().is_empty());
}

#[test]
fn permission_session_source_and_enrolled_target_identity_changes_all_refuse_an_armed_handoff() {
    let edits: [Edit; 4] = [
        ("permission-mode-changed", |f| {
            f.observation().state.session.permission_mode = "Manual".into()
        }),
        ("selected-session-changed", |f| {
            f.observation().state.session.id = uuid()
        }),
        ("source-account-changed", |f| {
            let identity = f.identity_of(&f.target);
            f.observation().state.identity = identity;
        }),
        ("target-identity-changed", |f| {
            let other = uuid();
            f.edit_account(&f.target, |t| {
                t.desktop.as_mut().unwrap().org_id = other.clone();
                t.auth.as_mut().unwrap().org_id = Some(other);
            });
        }),
    ];
    for (reason, edit) in edits {
        let f = setup();
        f.manager.arm(&explicit(&f.target)).unwrap();
        edit(&f);
        assert_eq!(f.manager.tick().reason, reason);
        assert!(f.requests().is_empty());
    }
}

#[test]
fn unknown_task_coverage_and_stale_observation_never_count_as_quiescent() {
    let f = setup();
    f.manager.arm(&explicit(&f.target)).unwrap();
    f.observation().state.quiescence.coverage = QuiescenceCoverage::Unknown;
    assert_eq!(f.manager.tick().reason, "coverage-unverified");
    f.observation().state.observed_at = now() - 15_001.0;
    assert_eq!(f.manager.tick().reason, "observation-not-fresh");
    assert!(f.requests().is_empty());
}

#[test]
fn unavailable_shared_desktop_lock_blocks_monitoring_without_throwing_or_calling_the_engine() {
    let f = setup();
    f.manager.arm(&explicit(&f.target)).unwrap();
    f.deps.set_lock(|_| Err("synthetic-owner-busy".into()));
    let outcome = f.manager.tick();
    assert_eq!(outcome.status, ContinuationStatus::Blocked);
    assert_eq!(outcome.reason, "desktop-lock-unavailable");
    assert!(f.requests().is_empty());
    assert_eq!(f.persisted().pending, None);
}

#[test]
fn unsupported_adapter_may_save_monitoring_intent_clearly_reports_nonexecutable_and_never_executes()
{
    let f = setup();
    f.caps().atomic_context_guard = false;
    let inspection = f.manager.inspect();
    assert!(inspection.can_arm);
    assert!(!inspection.executable);
    assert_eq!(
        inspection.observation_reason.as_deref(),
        Some("adapter-contract-unverified")
    );
    let arm = f.manager.arm(&explicit(&f.target)).unwrap();
    assert_eq!(arm.status, ContinuationStatus::Blocked);
    assert!(arm.enabled);
    assert_eq!(f.manager.tick().reason, "adapter-contract-unverified");
    assert!(f.requests().is_empty());
    assert!(!f.manager.disarm().unwrap().enabled);
}

#[test]
fn guarded_native_path_requires_explicit_persisted_at_most_once_consent_before_execution() {
    let f = setup();
    guarded_native(&mut f.caps());
    assert!(f.manager.inspect().executable);
    let error = f.manager.arm(&explicit(&f.target)).unwrap_err();
    assert!(error.message.contains("guarded-native-policy-required"));
    assert_eq!(f.persisted().arm, None);
    f.manager.arm(&guarded(&f.target)).unwrap();
    f.observation().state.quiescence.coverage = QuiescenceCoverage::GuardedLocal;
    let result = f.manager.tick();
    assert_eq!(result.status, ContinuationStatus::Continued);
    let requests = f.requests();
    assert_eq!(
        requests[0].execution_policy,
        Some(ExecutionPolicy::GuardedNativeAtMostOnce)
    );
    assert_eq!(requests[0].permission_mode, "Auto");
}

#[test]
fn guarded_native_consent_does_not_override_incomplete_coverage_or_running_child_work() {
    let f = setup();
    guarded_native(&mut f.caps());
    f.manager.arm(&guarded(&f.target)).unwrap();
    assert_eq!(f.manager.tick().reason, "coverage-unverified");
    {
        let mut observation = f.observation();
        observation.state.quiescence.coverage = QuiescenceCoverage::GuardedLocal;
        observation.state.quiescence.subagents = 1.0;
    }
    assert_eq!(f.manager.tick().reason, "not-quiescent:subagents");
    assert!(f.requests().is_empty());
}

#[test]
fn persisted_strict_mode_arm_cannot_silently_opt_into_guarded_native_after_an_upgrade() {
    let f = setup();
    f.manager.arm(&explicit(&f.target)).unwrap();
    guarded_native(&mut f.caps());
    let upgraded = f.new_manager();
    assert_eq!(upgraded.tick().reason, "guarded-native-policy-required");
    assert!(f.requests().is_empty());
}

#[test]
fn automatic_enrollment_freezes_distinct_identities_without_requiring_fresh_quota_or_displaying_a_placeholder_target()
 {
    let f = automatic_setup();
    let duplicate = Account {
        id: uuid(),
        ..f.account(&f.target)
    };
    lock(&f.shared.accounts).push(duplicate);
    f.usage().remove(&f.target);
    f.usage().remove(&f.alternate);
    let armed = f.manager.arm(&automatic_arm()).unwrap();
    assert_eq!(armed.target_selection, Some(TargetSelection::Automatic));
    assert_eq!(armed.target_id, None);
    assert_eq!(armed.allowed_target_count, Some(2.0));
    let enrolled = f.persisted().arm.unwrap();
    assert_eq!(enrolled.target_selection, Some(TargetSelection::Automatic));
    let allowed = enrolled.allowed_targets.unwrap();
    assert_eq!(allowed.len(), 2);
    assert!(!allowed.iter().any(|a| a.profile_id == f.source));
    assert_eq!(f.manager.tick().reason, "automatic-target-unavailable");
    assert!(f.requests().is_empty());
}

#[test]
fn automatic_arm_needs_a_distinct_enrolled_identity_excluding_cli_only_and_duplicate_source_profiles()
 {
    let f = automatic_setup();
    {
        let mut accounts = lock(&f.shared.accounts);
        accounts.truncate(1);
        accounts.push(Account {
            desktop: None,
            ..synthetic()
        });
        let source = accounts[0].clone();
        accounts.push(Account {
            id: uuid(),
            ..source
        });
    }
    let error = f.manager.arm(&automatic_arm()).unwrap_err();
    assert!(
        error
            .message
            .contains("automatic-target-enrollment-unavailable")
    );
    assert_eq!(f.persisted().arm, None);
}

fn planning(plan: AccountPlan, capacity_weight: f64) -> Option<AccountPlanning> {
    Some(AccountPlanning {
        plan,
        capacity_weight,
    })
}

#[test]
fn automatic_selection_starts_only_at_the_exact_ended_quota_turn_and_uses_capacity_adjusted_bottleneck_remaining()
 {
    let f = automatic_setup();
    f.edit_account(&f.target, |a| a.planning = planning(AccountPlan::Pro, 1.0));
    f.edit_account(&f.alternate, |a| {
        a.planning = planning(AccountPlan::Max5, 5.0)
    });
    f.edit_usage(&f.target, |u| {
        u.five_hour.as_mut().unwrap().used_percent = 5.0;
        u.seven_day.as_mut().unwrap().used_percent = 5.0;
    });
    f.edit_usage(&f.alternate, |u| {
        u.five_hour.as_mut().unwrap().used_percent = 70.0;
        u.seven_day.as_mut().unwrap().used_percent = 40.0;
    });
    let stop = f.observation().quota_stop.take();
    f.manager.arm(&automatic_arm()).unwrap();
    assert_eq!(f.manager.tick().reason, "awaiting-quota-stop");
    assert!(f.requests().is_empty());
    f.observation().quota_stop = stop;
    let result = f.manager.tick();
    assert_eq!(result.status, ContinuationStatus::Continued);
    let requests = f.requests();
    assert_eq!(requests[0].target.id, f.alternate);
    assert_eq!(result.target_id.as_deref(), Some(f.alternate.as_str()));
    assert_eq!(result.target_selection, Some(TargetSelection::Automatic));
    assert_eq!(requests[0].session_id, f.observation().state.session.id);
    assert_eq!(requests[0].permission_mode, "Auto");
}

#[test]
fn automatic_selection_uses_the_weekly_bottleneck_even_when_another_account_has_more_five_hour_quota()
 {
    let f = automatic_setup();
    f.edit_usage(&f.target, |u| {
        u.five_hour.as_mut().unwrap().used_percent = 1.0;
        u.seven_day.as_mut().unwrap().used_percent = 85.0;
    });
    f.edit_usage(&f.alternate, |u| {
        u.five_hour.as_mut().unwrap().used_percent = 50.0;
        u.seven_day.as_mut().unwrap().used_percent = 50.0;
    });
    f.manager.arm(&automatic_arm()).unwrap();
    f.manager.tick();
    assert_eq!(f.requests()[0].target.id, f.alternate);
}

#[test]
fn automatic_choice_is_recomputed_from_fresh_quota_inside_the_shared_desktop_lock_immediately_before_handoff()
 {
    let f = automatic_setup();
    f.edit_account(&f.target, |a| {
        a.planning = planning(AccountPlan::Max20, 20.0)
    });
    f.manager.arm(&automatic_arm()).unwrap();
    let inner = lock(&f.deps.with_desktop_lock).clone();
    let (shared, target) = (Arc::clone(&f.shared), f.target.clone());
    f.deps.set_lock(move |action| {
        lock(&shared.usage)
            .get_mut(&target)
            .unwrap()
            .five_hour
            .as_mut()
            .unwrap()
            .used_percent = 100.0;
        inner(action)
    });
    f.manager.tick();
    assert_eq!(f.requests()[0].target.id, f.alternate);
}

#[test]
fn automatic_mode_rejects_unusable_live_quota_cooldown_and_changed_identities_before_cancelling_the_original_wakeup()
 {
    let scenarios: [fn(&Fixture); 13] = [
        |f| f.edit_usage(&f.target, |u| u.stale = true),
        |f| f.edit_usage(&f.target, |u| u.checked_at = Some(iso(now() - 300_001.0))),
        |f| f.edit_usage(&f.target, |u| u.checked_at = Some(iso(now() + 1.0))),
        |f| {
            let source = f.source.clone();
            f.edit_usage(&f.target, |u| u.account_id = source)
        },
        |f| f.edit_usage(&f.target, |u| u.five_hour = None),
        |f| {
            f.edit_usage(&f.target, |u| {
                u.five_hour = None;
                u.seven_day = None;
                u.last_known_resets = Some(LastKnownResets {
                    five_hour: Some(KnownReset {
                        resets_at: iso(now() + 3_600_000.0),
                        checked_at: iso(now()),
                    }),
                    seven_day: Some(KnownReset {
                        resets_at: iso(now() + 86_400_000.0),
                        checked_at: iso(now()),
                    }),
                });
            })
        },
        |f| {
            f.edit_usage(&f.target, |u| {
                u.seven_day.as_mut().unwrap().resets_at = Some(iso(now() - 1.0))
            })
        },
        |f| {
            f.edit_usage(&f.target, |u| {
                u.five_hour.as_mut().unwrap().used_percent = 90.0
            })
        },
        |f| {
            f.edit_usage(&f.target, |u| {
                u.seven_day.as_mut().unwrap().used_percent = 90.0
            })
        },
        |f| {
            f.edit_account(&f.target, |a| {
                a.cooldown_until = Some(iso(now() + 60_000.0))
            })
        },
        |f| f.edit_account(&f.target, |a| a.cooldown_until = Some("invalid".into())),
        |f| {
            f.edit_account(&f.target, |a| {
                a.auth.as_mut().unwrap().account_uuid = Some(uuid())
            })
        },
        |f| {
            f.edit_account(&f.target, |a| {
                let changed = uuid();
                a.auth.as_mut().unwrap().account_uuid = Some(changed.clone());
                a.desktop.as_mut().unwrap().account_uuid = changed;
            })
        },
    ];
    for change in scenarios {
        let f = automatic_setup();
        f.edit_usage(&f.alternate, |u| {
            u.five_hour.as_mut().unwrap().used_percent = 100.0
        });
        {
            let mut observation = f.observation();
            observation.own_quota_wakeup = Some(true);
            observation.state.quiescence.scheduled_wakeups = 1.0;
        }
        f.manager.arm(&automatic_arm()).unwrap();
        change(&f);
        let result = f.manager.tick();
        assert_eq!(result.status, ContinuationStatus::Waiting);
        assert_eq!(result.reason, "automatic-target-unavailable");
        assert_eq!(f.preparations(), 0);
        assert!(f.requests().is_empty());
        assert_eq!(f.persisted().pending, None);
        assert_eq!(f.scheduled_wakeups(), 1.0);
    }
}

#[test]
fn automatic_continuation_applies_current_history_scope_and_never_admits_accounts_added_after_enrollment()
 {
    let f = automatic_setup();
    f.manager.arm(&automatic_arm()).unwrap();
    {
        let mut settings = lock(&f.shared.settings);
        settings.desktop_history_transfer = DesktopHistoryTransfer::Selected;
        settings.desktop_history_accounts = vec![f.source.clone(), f.alternate.clone()];
    }
    f.edit_account(&f.target, |a| {
        a.planning = planning(AccountPlan::Max20, 20.0)
    });
    let added = Account {
        planning: planning(AccountPlan::Max20, 20.0),
        ..synthetic()
    };
    let added_usage = AccountUsage {
        account_id: added.id.clone(),
        ..f.usage().get(&f.target).unwrap().clone()
    };
    f.usage().insert(added.id.clone(), added_usage);
    lock(&f.shared.accounts).push(added);
    f.manager.tick();
    let requests = f.requests();
    assert_eq!(requests[0].target.id, f.alternate);
    assert_eq!(
        requests[0].settings.desktop_history_transfer,
        DesktopHistoryTransfer::Selected
    );
    assert!(
        requests[0]
            .settings
            .desktop_history_accounts
            .contains(&f.alternate)
    );
}

#[test]
fn automatic_target_absence_caused_by_history_restrictions_waits_without_any_restart_timer_mutation_or_pending_attempt()
 {
    let f = automatic_setup();
    {
        let mut observation = f.observation();
        observation.own_quota_wakeup = Some(true);
        observation.state.quiescence.scheduled_wakeups = 1.0;
    }
    f.manager.arm(&automatic_arm()).unwrap();
    lock(&f.shared.settings).desktop_history_transfer = DesktopHistoryTransfer::Off;
    assert_eq!(f.manager.tick().reason, "automatic-target-unavailable");
    assert_eq!(f.preparations(), 0);
    assert!(f.requests().is_empty());
    assert_eq!(f.persisted().pending, None);
    assert_eq!(f.scheduled_wakeups(), 1.0);
}

#[test]
fn automatic_quota_wakeup_takeover_binds_the_dynamically_selected_account_durably_before_ui_cancellation()
 {
    let f = automatic_setup();
    f.edit_account(&f.target, |a| a.planning = planning(AccountPlan::Pro, 1.0));
    f.edit_account(&f.alternate, |a| {
        a.planning = planning(AccountPlan::Max20, 20.0)
    });
    {
        let mut observation = f.observation();
        observation.own_quota_wakeup = Some(true);
        observation.state.quiescence.scheduled_wakeups = 1.0;
    }
    let prepare = f.deps.prepare();
    let (shared, alternate) = (Arc::clone(&f.shared), f.alternate.clone());
    f.deps.set_prepare(move |observation, request| {
        assert_eq!(request.target.id, alternate);
        assert_eq!(
            lock(&shared.persisted)
                .pending
                .as_ref()
                .map(|p| p.arm.target.profile_id.clone()),
            Some(alternate.clone())
        );
        prepare(observation, request)
    });
    f.manager.arm(&automatic_arm()).unwrap();
    f.manager.tick();
    assert_eq!(f.preparations(), 1);
    let requests = f.requests();
    assert_eq!(requests[0].target.id, f.alternate);
    assert_eq!(requests[0].expected_context_revision, 4.0);
}

#[test]
fn automatic_mode_retains_exact_source_session_and_permission_guards_while_waiting() {
    for changed in ["session", "permission", "source"] {
        let f = automatic_setup();
        f.manager.arm(&automatic_arm()).unwrap();
        match changed {
            "session" => f.observation().state.session.id = uuid(),
            "permission" => f.observation().state.session.permission_mode = "Manual".into(),
            _ => {
                let identity = f.identity_of(&f.target);
                f.observation().state.identity = identity;
            }
        }
        let result = f.manager.tick();
        assert_eq!(result.status, ContinuationStatus::Blocked);
        assert_eq!(
            result.reason,
            match changed {
                "session" => "selected-session-changed",
                "permission" => "permission-mode-changed",
                _ => "source-account-changed",
            }
        );
        assert!(f.requests().is_empty());
        assert_eq!(f.preparations(), 0);
    }
}

#[test]
fn automatic_mode_never_selects_or_starts_a_handoff_while_other_work_or_extra_wakeups_exist() {
    for work in [
        "subagents",
        "busyWorkers",
        "waiting",
        "unknownWork",
        "scheduledWakeups",
    ] {
        let f = automatic_setup();
        {
            let mut observation = f.observation();
            observation.own_quota_wakeup = Some(true);
            observation.state.quiescence.scheduled_wakeups = 1.0;
            *counter(&mut observation.state.quiescence, work) =
                if work == "scheduledWakeups" { 2.0 } else { 1.0 };
        }
        f.manager.arm(&automatic_arm()).unwrap();
        assert_eq!(f.manager.tick().status, ContinuationStatus::Waiting);
        assert_eq!(f.preparations(), 0);
        assert!(f.requests().is_empty());
        assert_eq!(f.persisted().pending, None);
    }
}

#[test]
fn uncertain_automatic_handoff_freezes_its_chosen_target_through_quota_changes_new_accounts_and_restart()
 {
    let f = automatic_setup();
    f.edit_account(&f.alternate, |a| {
        a.planning = planning(AccountPlan::Max20, 20.0)
    });
    f.set_result(
        ContinuationResultStatus::ReconciliationRequired,
        "delivery-unknown",
    );
    f.manager.arm(&automatic_arm()).unwrap();
    f.manager.tick();
    let pending = f.persisted().pending.unwrap();
    assert_eq!(pending.arm.target.profile_id, f.alternate);
    f.edit_usage(&f.alternate, |u| {
        u.five_hour.as_mut().unwrap().used_percent = 100.0
    });
    f.edit_account(&f.target, |a| {
        a.planning = planning(AccountPlan::Max20, 20.0)
    });
    let added = synthetic();
    let added_usage = AccountUsage {
        account_id: added.id.clone(),
        ..f.usage().get(&f.target).unwrap().clone()
    };
    f.usage().insert(added.id.clone(), added_usage);
    lock(&f.shared.accounts).push(added);
    let restarted = f.new_manager();
    restarted.tick();
    assert_eq!(f.requests().len(), 1);
    restarted.resume_pending().unwrap();
    let requests = f.requests();
    assert_eq!(requests[1].id, pending.id);
    assert_eq!(requests[1].target.id, f.alternate);
    assert_eq!(
        restarted.snapshot().target_id.as_deref(),
        Some(f.alternate.as_str())
    );
}

#[test]
fn automatic_enrollment_survives_durable_reload_and_older_explicit_target_arms_remain_compatible() {
    let f = automatic_setup();
    let root = temporary("relay-automatic-enrollment-");
    let deps = Deps {
        persistence: Arc::new(FileDesktopContinuationPersistence::new(root.path()).unwrap()),
        ..f.deps.spread()
    };
    let manager = DesktopContinuationManager::new(deps.clone());
    manager.arm(&automatic_arm()).unwrap();
    let restored = DesktopContinuationManager::new(Deps {
        persistence: Arc::new(FileDesktopContinuationPersistence::new(root.path()).unwrap()),
        ..deps.spread()
    });
    assert_eq!(
        restored.snapshot().target_selection,
        Some(TargetSelection::Automatic)
    );
    assert_eq!(restored.snapshot().target_id, None);
    assert_eq!(restored.snapshot().allowed_target_count, Some(2.0));
    restored.tick();
    assert_eq!(f.requests().len(), 1);
    let explicit = f.new_manager();
    explicit.arm(&guarded(&f.target)).unwrap();
    assert_eq!(explicit.snapshot().target_selection, None);
    assert_eq!(
        explicit.snapshot().target_id.as_deref(),
        Some(f.target.as_str())
    );
}

#[test]
fn guarded_handoff_may_cancel_only_the_selected_stopped_turn_s_own_quota_wakeup_after_complete_policy_validation()
 {
    let f = wakeup_setup();
    let execute = f.deps.execute_fn();
    let shared = Arc::clone(&f.shared);
    f.deps.set_execute(move |request| {
        let pending = lock(&shared.persisted).pending.clone().unwrap();
        assert_eq!(pending.id, request.id);
        assert_eq!(
            pending.own_quota_wakeup,
            Some(OwnQuotaWakeup::CancelledVerified)
        );
        assert_eq!(pending.expected_context_revision, 4.0);
        execute(request)
    });
    f.manager.arm(&guarded(&f.target)).unwrap();
    assert_eq!(f.manager.tick().status, ContinuationStatus::Continued);
    assert_eq!(f.preparations(), 1);
    let requests = f.requests();
    assert_eq!(
        requests[0].expected_context_revision, 4.0,
        "engine binds the fresh post-cancellation observation"
    );
    assert_eq!(requests[0].permission_mode, "Auto");
}

#[test]
fn unavailable_target_quota_or_nonexhausted_source_leaves_the_user_s_original_wakeup_intact() {
    for source_available in [false, true] {
        let f = wakeup_setup();
        if source_available {
            f.edit_usage(&f.source, |u| {
                u.five_hour.as_mut().unwrap().used_percent = 20.0
            });
        } else {
            f.edit_usage(&f.target, |u| {
                u.five_hour.as_mut().unwrap().used_percent = 98.0
            });
        }
        f.manager.arm(&guarded(&f.target)).unwrap();
        assert_eq!(
            f.manager.tick().reason,
            if source_available {
                "source-quota-available"
            } else {
                "target-quota-unavailable"
            }
        );
        assert_eq!(f.preparations(), 0);
        assert_eq!(f.scheduled_wakeups(), 1.0);
        assert!(f.requests().is_empty());
    }
}

#[test]
fn other_work_multiple_wakeups_or_unverified_wakeup_ownership_never_permits_cancellation() {
    let scenarios: [fn(&mut Obs); 3] = [
        |o| o.state.quiescence.unknown_work = 1.0,
        |o| o.state.quiescence.scheduled_wakeups = 2.0,
        |o| o.own_quota_wakeup = None,
    ];
    for change in scenarios {
        let f = wakeup_setup();
        change(&mut f.observation());
        f.manager.arm(&guarded(&f.target)).unwrap();
        assert_ne!(f.manager.tick().status, ContinuationStatus::Continued);
        assert_eq!(f.preparations(), 0);
        assert!(f.requests().is_empty());
    }
}

#[test]
fn fresh_reread_after_wake_cancellation_must_preserve_the_exact_permission_and_transcript_checkpoint()
 {
    for mode_changed in [false, true] {
        let f = wakeup_setup();
        let original = f.deps.prepare();
        f.deps.set_prepare(move |observation, request| {
            let mut after = original(observation, request)?;
            if mode_changed {
                after.state.session.permission_mode = "Manual".into();
            } else {
                after.state.session.transcript_revision = "user-added-a-turn".into();
            }
            Ok(after)
        });
        f.manager.arm(&guarded(&f.target)).unwrap();
        assert_eq!(
            f.manager.tick().observation_reason.as_deref(),
            Some(if mode_changed {
                "permission-mode-changed"
            } else {
                "quota-checkpoint-changed"
            })
        );
        assert_eq!(f.preparations(), 1);
        assert!(f.requests().is_empty());
        assert_eq!(
            f.manager.snapshot().status,
            ContinuationStatus::ReconciliationRequired
        );
        assert_eq!(f.manager.snapshot().reason, "own-quota-wakeup-uncertain");
        assert_eq!(
            f.persisted().pending.unwrap().own_quota_wakeup,
            Some(OwnQuotaWakeup::CancellationIntent)
        );
        assert_eq!(f.persisted().arm, None);
        f.manager.tick();
        f.manager.resume_pending().unwrap();
        assert_eq!(f.preparations(), 1);
        assert!(f.requests().is_empty());
    }
}

#[test]
fn wakeup_cancellation_failures_retain_durable_intent_and_never_retry_including_after_restart() {
    for cancellation_occurred in [false, true] {
        let f = wakeup_setup();
        let cancellations = Arc::new(AtomicUsize::new(0));
        let (count, shared) = (Arc::clone(&cancellations), Arc::clone(&f.shared));
        f.deps.set_prepare(move |_, request| {
            count.fetch_add(1, Ordering::SeqCst);
            let pending = lock(&shared.persisted).pending.clone().unwrap();
            assert_eq!(pending.id, request.id);
            assert_eq!(
                pending.own_quota_wakeup,
                Some(OwnQuotaWakeup::CancellationIntent)
            );
            if cancellation_occurred {
                let mut observation = lock(&shared.observation);
                observation.state.quiescence.scheduled_wakeups = 0.0;
                observation.own_quota_wakeup = Some(false);
            }
            Err("context-changed".into())
        });
        f.manager.arm(&guarded(&f.target)).unwrap();
        let failed = f.manager.tick();
        assert_eq!(failed.status, ContinuationStatus::ReconciliationRequired);
        assert_eq!(failed.reason, "own-quota-wakeup-uncertain");
        assert_eq!(
            failed.observation_reason.as_deref(),
            Some("context-changed")
        );
        assert!(f.requests().is_empty());
        let pending_id = f.persisted().pending.unwrap().id;
        let restarted = f.new_manager();
        assert_eq!(restarted.snapshot().reason, "own-quota-wakeup-uncertain");
        restarted.tick();
        restarted.resume_pending().unwrap();
        assert_eq!(cancellations.load(Ordering::SeqCst), 1);
        assert!(f.requests().is_empty());
        assert_eq!(f.persisted().pending.unwrap().id, pending_id);
        assert_eq!(
            f.scheduled_wakeups(),
            if cancellation_occurred { 0.0 } else { 1.0 }
        );
    }
}

#[test]
fn failed_pre_cancellation_persistence_leaves_the_original_desktop_wakeup_untouched() {
    let f = wakeup_setup();
    *lock(&f.memory.fail_when) = Some(|state: &State| {
        state.pending.as_ref().and_then(|p| p.own_quota_wakeup)
            == Some(OwnQuotaWakeup::CancellationIntent)
    });
    f.manager.arm(&guarded(&f.target)).unwrap();
    assert_eq!(f.manager.tick().status, ContinuationStatus::Blocked);
    assert_eq!(f.preparations(), 0);
    assert!(f.requests().is_empty());
    assert_eq!(f.persisted().pending, None);
    assert_eq!(f.scheduled_wakeups(), 1.0);
}

#[test]
fn failed_post_cancellation_persistence_preserves_uncertain_takeover_instead_of_invoking_the_engine()
 {
    let f = wakeup_setup();
    *lock(&f.memory.fail_when) = Some(|state: &State| {
        state.pending.as_ref().and_then(|p| p.own_quota_wakeup)
            == Some(OwnQuotaWakeup::CancelledVerified)
    });
    f.manager.arm(&guarded(&f.target)).unwrap();
    assert_eq!(f.manager.tick().reason, "own-quota-wakeup-uncertain");
    assert_eq!(f.preparations(), 1);
    assert!(f.requests().is_empty());
    assert_eq!(
        f.persisted().pending.unwrap().own_quota_wakeup,
        Some(OwnQuotaWakeup::CancellationIntent)
    );
    assert_eq!(f.scheduled_wakeups(), 0.0);
    let restarted = f.new_manager();
    restarted.tick();
    restarted.resume_pending().unwrap();
    assert_eq!(f.preparations(), 1);
    assert!(f.requests().is_empty());
}

#[test]
fn engine_rejection_after_verified_wakeup_cancellation_retains_reconciliation_and_exact_durable_binding()
 {
    let f = wakeup_setup();
    f.set_result(ContinuationResultStatus::Blocked, "unresolved-host-intent");
    f.manager.arm(&guarded(&f.target)).unwrap();
    let failed = f.manager.tick();
    assert_eq!(failed.status, ContinuationStatus::ReconciliationRequired);
    assert_eq!(failed.reason, "unresolved-host-intent");
    let pending = f.persisted().pending.unwrap();
    assert_eq!(
        pending.own_quota_wakeup,
        Some(OwnQuotaWakeup::CancelledVerified)
    );
    assert_eq!(pending.id, f.requests()[0].id);
    assert_eq!(pending.expected_context_revision, 4.0);
    let restarted = f.new_manager();
    restarted.tick();
    assert_eq!(f.requests().len(), 1);
    restarted.resume_pending().unwrap();
    let requests = f.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].id, pending.id);
    assert_eq!(f.preparations(), 1);
    assert_eq!(f.persisted().pending.unwrap().id, pending.id);
}

#[test]
fn durable_uncertain_wakeup_survives_file_reload_and_explicit_unsent_cancellation_never_restores_or_replays_ui()
 {
    let f = wakeup_setup();
    let root = temporary("relay-wakeup-takeover-");
    let persistence = Arc::new(FileDesktopContinuationPersistence::new(root.path()).unwrap());
    let native_cancellations = Arc::new(AtomicUsize::new(0));
    let abandoned_id = Arc::new(Mutex::new(None::<String>));
    let abandoned = Arc::clone(&abandoned_id);
    let deps = Deps {
        persistence: persistence.clone(),
        engine: f.deps.engine.with_abandon(Arc::new(move |id: &str| {
            *lock(&abandoned) = Some(id.to_owned());
            Ok(())
        })),
        ..f.deps.spread()
    };
    let (count, saved, shared) = (
        Arc::clone(&native_cancellations),
        Arc::clone(&persistence),
        Arc::clone(&f.shared),
    );
    deps.set_prepare(move |_, request| {
        count.fetch_add(1, Ordering::SeqCst);
        let state = saved.load().unwrap();
        let pending = state.pending.unwrap();
        assert_eq!(
            pending.own_quota_wakeup,
            Some(OwnQuotaWakeup::CancellationIntent)
        );
        assert_eq!(pending.id, request.id);
        lock(&shared.observation).state.quiescence.scheduled_wakeups = 0.0;
        Err("context-changed".into())
    });
    let manager = DesktopContinuationManager::new(deps.clone());
    manager.arm(&guarded(&f.target)).unwrap();
    manager.tick();
    let pending = persistence.load().unwrap().pending.unwrap();
    assert_eq!(
        pending.own_quota_wakeup,
        Some(OwnQuotaWakeup::CancellationIntent)
    );
    let restarted = DesktopContinuationManager::new(Deps {
        persistence: Arc::new(FileDesktopContinuationPersistence::new(root.path()).unwrap()),
        ..deps.spread()
    });
    restarted.tick();
    restarted.resume_pending().unwrap();
    assert_eq!(native_cancellations.load(Ordering::SeqCst), 1);
    assert!(f.requests().is_empty());
    let cancelled = restarted.abandon_pending().unwrap();
    assert_eq!(cancelled.status, ContinuationStatus::Off);
    assert_eq!(*lock(&abandoned_id), Some(pending.id));
    assert_eq!(persistence.load().unwrap().pending, None);
    assert_eq!(f.scheduled_wakeups(), 0.0);
    assert_eq!(native_cancellations.load(Ordering::SeqCst), 1);
    assert!(f.requests().is_empty());
}

#[test]
fn an_ambiguous_handoff_never_repeats_quota_wakeup_preparation_during_explicit_reconciliation() {
    let f = wakeup_setup();
    f.set_result(
        ContinuationResultStatus::ReconciliationRequired,
        "delivery-unknown",
    );
    f.manager.arm(&guarded(&f.target)).unwrap();
    f.manager.tick();
    assert_eq!(f.preparations(), 1);
    f.set_result(
        ContinuationResultStatus::Continued,
        "durable-delivery-confirmed",
    );
    f.manager.resume_pending().unwrap();
    assert_eq!(f.preparations(), 1);
    let requests = f.requests();
    assert_eq!(
        requests[1].expected_context_revision,
        requests[0].expected_context_revision
    );
}

#[test]
fn explicit_cancellation_clears_only_an_engine_confirmed_unsent_pending_intent_even_after_account_identity_changes()
 {
    let f = setup();
    f.set_result(
        ContinuationResultStatus::ReconciliationRequired,
        "target-identity-changed",
    );
    let cancelled_id = Arc::new(Mutex::new(None::<String>));
    let cancelled = Arc::clone(&cancelled_id);
    let manager = DesktopContinuationManager::new(Deps {
        engine: f.deps.engine.with_abandon(Arc::new(move |id: &str| {
            *lock(&cancelled) = Some(id.to_owned());
            Ok(())
        })),
        ..f.deps.spread()
    });
    manager.arm(&explicit(&f.target)).unwrap();
    manager.tick();
    let pending_id = f.persisted().pending.unwrap().id;
    f.edit_account(&f.target, |a| a.auth.as_mut().unwrap().logged_in = false);
    let outcome = manager.abandon_pending().unwrap();
    assert_eq!(*lock(&cancelled_id), Some(pending_id));
    assert_eq!(outcome.status, ContinuationStatus::Off);
    assert_eq!(outcome.reason, "user-cancelled-unsent");
    assert_eq!(f.persisted().pending, None);
    assert_eq!(f.persisted().arm, None);
    assert_eq!(f.requests().len(), 1);
}

#[test]
fn a_possible_send_cannot_be_cleared_by_the_manager_s_explicit_cancellation_action() {
    let f = setup();
    f.set_result(
        ContinuationResultStatus::ReconciliationRequired,
        "delivery-unknown",
    );
    let manager = DesktopContinuationManager::new(Deps {
        engine: f.deps.engine.with_abandon(Arc::new(|_: &str| {
            Err("cannot-cancel-possible-send".into())
        })),
        ..f.deps.spread()
    });
    manager.arm(&explicit(&f.target)).unwrap();
    manager.tick();
    let before = f.persisted();
    let error = manager.abandon_pending().unwrap_err();
    assert!(error.message.contains("cannot-cancel-possible-send"));
    assert_eq!(f.persisted(), before);
    assert_eq!(f.requests().len(), 1);
}

struct CorruptPersistence {
    writes: AtomicUsize,
}

impl DesktopContinuationPersistence for CorruptPersistence {
    fn load(&self) -> Result<State, DErr> {
        Err("synthetic-corrupt-state".into())
    }
    fn save(&self, _: &State) -> Result<(), DErr> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn unreadable_optional_automation_state_keeps_the_account_panel_usable_but_cannot_arm_reset_or_write()
 {
    let f = setup();
    let corrupt = Arc::new(CorruptPersistence {
        writes: AtomicUsize::new(0),
    });
    let manager = Arc::new(DesktopContinuationManager::new(Deps {
        persistence: corrupt.clone(),
        ..f.deps.spread()
    }));
    assert_eq!(manager.snapshot().reason, "continuation-state-unreadable");
    assert!(!manager.snapshot().executable);
    manager.inspect();
    manager.tick();
    manager.start();
    manager.stop();
    let unreadable = |error: DErr| assert!(error.message.contains("continuation-state-unreadable"));
    unreadable(manager.arm(&explicit(&f.target)).unwrap_err());
    unreadable(manager.disarm().unwrap_err());
    unreadable(manager.resume_pending().unwrap_err());
    unreadable(manager.abandon_pending().unwrap_err());
    assert_eq!(corrupt.writes.load(Ordering::SeqCst), 0);
    assert!(f.requests().is_empty());
    assert_eq!(f.counts().0, 0);
}

#[test]
fn ambiguous_delivery_disables_automation_survives_restart_and_never_resends_automatically() {
    let f = setup();
    f.set_result(
        ContinuationResultStatus::ReconciliationRequired,
        "delivery-unknown",
    );
    f.manager.arm(&explicit(&f.target)).unwrap();
    assert_eq!(
        f.manager.tick().status,
        ContinuationStatus::ReconciliationRequired
    );
    let pending = f.persisted().pending.unwrap();
    assert_eq!(f.persisted().arm, None);
    let restarted = f.new_manager();
    assert_eq!(
        restarted.snapshot().status,
        ContinuationStatus::ReconciliationRequired
    );
    restarted.tick();
    assert_eq!(f.requests().len(), 1);
    let error = restarted.arm(&explicit(&f.target)).unwrap_err();
    assert!(error.message.contains("unfinished-attempt"));
    f.set_result(
        ContinuationResultStatus::Continued,
        "durable-delivery-confirmed",
    );
    restarted.resume_pending().unwrap();
    let requests = f.requests();
    assert_eq!(requests[1].id, pending.id);
    assert_eq!(
        requests[1].expected_context_revision,
        pending.expected_context_revision
    );
    assert_eq!(f.persisted().pending, None);
}

#[test]
fn a_recovery_preflight_failure_retains_unfinished_binding_instead_of_clearing_an_unknown_send() {
    let f = setup();
    f.set_result(
        ContinuationResultStatus::ReconciliationRequired,
        "delivery-unknown",
    );
    f.manager.arm(&explicit(&f.target)).unwrap();
    f.manager.tick();
    let request_id = f.persisted().pending.unwrap().id;
    f.set_result(
        ContinuationResultStatus::Blocked,
        "adapter-contract-unverified",
    );
    let result = f.manager.resume_pending().unwrap();
    assert_eq!(result.status, ContinuationStatus::ReconciliationRequired);
    assert_eq!(f.persisted().pending.unwrap().id, request_id);
}

#[test]
fn pre_intent_rejection_retries_only_from_a_new_fresh_binding_and_deduplicates_consumed_quota_events()
 {
    let f = setup();
    f.set_result(ContinuationResultStatus::Blocked, "quota-not-fresh");
    f.manager.arm(&explicit(&f.target)).unwrap();
    f.manager.tick();
    assert_eq!(f.persisted().pending, None);
    f.observation().state.context_revision += 1.0;
    f.set_result(ContinuationResultStatus::Continued, "new-turn-verified");
    f.manager.tick();
    let requests = f.requests();
    assert_ne!(requests[0].id, requests[1].id);
    assert_eq!(requests[1].expected_context_revision, 4.0);
    f.manager.arm(&explicit(&f.target)).unwrap();
    assert_eq!(f.manager.tick().reason, "quota-episode-already-continued");
    assert_eq!(f.requests().len(), 2);
}

#[test]
fn durable_state_is_private_reloads_the_exact_intent_and_refuses_corrupt_or_symlinked_files() {
    let directory = temporary("relay-continuation-manager-");
    let persistence = FileDesktopContinuationPersistence::new(directory.path()).unwrap();
    assert_eq!(persistence.load().unwrap(), State::default());
    persistence
        .save(&State {
            completed: vec![CompletedEpisode {
                key: "a".repeat(64),
                at: now(),
            }],
            ..State::default()
        })
        .unwrap();
    assert_eq!(
        FileDesktopContinuationPersistence::new(directory.path())
            .unwrap()
            .load()
            .unwrap()
            .completed[0]
            .at,
        now()
    );
    // The file is what the TS writes: compact JSON, `version` then `completed`.
    assert_eq!(
        std::fs::read_to_string(&persistence.file).unwrap(),
        format!(
            r#"{{"version":1,"completed":[{{"key":"{}","at":{}}}]}}"#,
            "a".repeat(64),
            now()
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&persistence.file)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    std::fs::write(&persistence.file, "{").unwrap();
    let error = persistence.load().unwrap_err();
    assert!(error.message.contains("continuation-state-unreadable"));
    std::fs::remove_file(&persistence.file).unwrap();
    #[cfg(unix)]
    {
        std::fs::write(directory.path().join("elsewhere"), "{}").unwrap();
        std::os::unix::fs::symlink(directory.path().join("elsewhere"), &persistence.file).unwrap();
        let error = persistence.load().unwrap_err();
        assert!(error.message.contains("continuation-state-unreadable"));
        let error = persistence.save(&State::default()).unwrap_err();
        assert!(error.message.contains("continuation-file-invalid"));
    }
}

/// The host of the application-manager case: it acts on the setup's observed state.
struct StateHost {
    shared: Arc<Shared>,
    actions: Mutex<Vec<String>>,
}

impl StateHost {
    fn check(&self, revision: f64) -> MutexGuard<'_, Obs> {
        let observation = lock(&self.shared.observation);
        assert_eq!(revision, observation.state.context_revision);
        assert_eq!(observation.state.session.status, SessionStatus::Stopped);
        observation
    }
    fn act(&self, action: &str) {
        lock(&self.actions).push(action.into());
    }
}

impl ContinuationHost for StateHost {
    fn capabilities(&self) -> ContinuationCapabilities {
        lock(&self.shared.capabilities).clone()
    }
    fn read_state(&self) -> Result<ContinuationState, ContinuationError> {
        Ok(lock(&self.shared.observation).state.clone())
    }
    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, ContinuationError> {
        let mut observation = self.check(input.expected_context_revision);
        self.act("checkpoint");
        observation.state.context_revision += 1.0;
        Ok(ContinuationCheckpoint {
            id: "synthetic-checkpoint".into(),
            session: observation.state.session.clone(),
        })
    }
    fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), ContinuationError> {
        let mut observation = self.check(input.expected_context_revision);
        self.act("switch");
        observation.state.identity = input.target.clone();
        observation.state.context_revision += 1.0;
        Ok(())
    }
    fn reopen_session(&self, input: &ContinuationReopenInput) -> Result<(), ContinuationError> {
        let mut observation = self.check(input.expected_context_revision);
        self.act("reopen");
        observation.state.session = input.checkpoint.session.clone();
        observation.state.context_revision += 1.0;
        Ok(())
    }
    fn send_continuation(
        &self,
        input: &ContinuationSendInput,
    ) -> Result<ContinuationDelivery, ContinuationError> {
        let mut observation = self.check(input.expected_context_revision);
        self.act("send");
        let session = &mut observation.state.session;
        let before_revision = session.transcript_revision.clone();
        session.transcript_revision = "synthetic-next-turn".into();
        session.last_request_id = Some(input.request_id.clone());
        session.last_turn_id = Some("synthetic-turn-4".into());
        session.status = SessionStatus::Running;
        let receipt = ContinuationReceipt {
            request_id: input.request_id.clone(),
            identity: input.target.clone(),
            session_id: session.id.clone(),
            project_key: session.project_key.clone(),
            permission_mode: session.permission_mode.clone(),
            before_revision,
            after_revision: session.transcript_revision.clone(),
            turn_id: "synthetic-turn-4".into(),
        };
        observation.state.context_revision += 1.0;
        Ok(ContinuationDelivery {
            status: DeliveryStatus::Started,
            receipt: Some(receipt),
        })
    }
    fn lookup_delivery(&self, _: &str) -> Result<ContinuationDelivery, ContinuationError> {
        Ok(ContinuationDelivery {
            status: DeliveryStatus::Unknown,
            receipt: None,
        })
    }
}

#[test]
fn application_manager_runs_the_real_guarded_engine_and_durable_journal_through_one_same_session_handoff()
 {
    let f = setup();
    let directory = temporary("relay-manager-engine-");
    guarded_native(&mut f.caps());
    f.observation().state.quiescence.coverage = QuiescenceCoverage::GuardedLocal;
    let host = Arc::new(StateHost {
        shared: Arc::clone(&f.shared),
        actions: Mutex::new(Vec::new()),
    });
    let journal = Arc::new(
        FileContinuationJournal::with_clock(&directory.path().join("journal"), now).unwrap(),
    );
    let engine = Arc::new(ContinuationEngine::with_clock(
        Arc::clone(&host),
        Arc::clone(&journal),
        now,
    ));
    let (source, target) = (f.source.clone(), f.target.clone());
    let accounts = lock(&f.shared.accounts).clone();
    let deps = Deps {
        engine: Arc::new(Engine {
            execute: Mutex::new({
                let engine = Arc::clone(&engine);
                Arc::new(move |request: &ContinuationRequest| {
                    engine.execute(request).map_err(DErr::from)
                }) as ExecuteFn
            }),
            abandon_unsent: Mutex::new({
                let engine = Arc::clone(&engine);
                Some(Arc::new(move |id: &str| {
                    engine.abandon_unsent(id).map(|_| ()).map_err(DErr::from)
                }) as AbandonFn)
            }),
        }),
        persistence: Arc::new(
            FileDesktopContinuationPersistence::new(&directory.path().join("manager")).unwrap(),
        ),
        ..f.deps.spread()
    };
    deps.set_snapshot(move || DesktopContinuationContext {
        accounts: accounts.clone(),
        settings: default_settings(),
        usage: [
            (source.clone(), helpers::usage(&source, 100.0, 20.0)),
            (target.clone(), helpers::usage(&target, 10.0, 20.0)),
        ]
        .into_iter()
        .collect(),
        tempo_rate: None,
    });
    let manager = DesktopContinuationManager::new(deps);
    manager.arm(&guarded(&f.target)).unwrap();
    let outcome = manager.tick();
    assert_eq!(outcome.status, ContinuationStatus::Continued);
    assert!(!outcome.enabled);
    {
        let observation = f.observation();
        assert_eq!(observation.state.session.permission_mode, "Auto");
        assert_eq!(observation.state.identity.profile_id, f.target);
    }
    assert_eq!(
        *lock(&host.actions),
        ["checkpoint", "switch", "reopen", "send"]
    );
    assert!(journal.list_pending().unwrap().is_empty());
    let saved = FileDesktopContinuationPersistence::new(&directory.path().join("manager"))
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(saved.pending, None);
    assert_eq!(saved.arm, None);
    assert_eq!(saved.completed.len(), 1);
}

#[test]
fn a_wakeup_takeover_refused_before_any_click_withdraws_its_intent_and_keeps_watching() {
    let f = wakeup_setup();
    f.deps
        .set_prepare(|_, _| Err(DErr::unchanged("context-changed")));
    f.manager.arm(&guarded(&f.target)).unwrap();
    let armed = f.persisted().arm;
    let result = f.manager.tick();
    assert_ne!(result.status, ContinuationStatus::ReconciliationRequired);
    assert_eq!(f.persisted().pending, None);
    assert_eq!(f.persisted().arm, armed);
    assert!(f.requests().is_empty());
}

#[test]
fn automatic_selection_takes_the_soonest_reset_that_holds_half_an_hour_at_the_snapshot_s_tempo() {
    for (tempo_rate, expected) in [(None, "target"), (Some(200.0), "alternate")] {
        let f = automatic_setup();
        f.edit_account(&f.alternate, |a| {
            a.planning = planning(AccountPlan::Max5, 5.0)
        });
        // Target: 50 Pro units until its reset in 30 minutes; alternate: 400 in an hour.
        f.edit_usage(&f.target, |u| {
            u.five_hour = Some(UsageWindow::new(50.0, Some(&iso(now() + 30.0 * 60_000.0))))
        });
        f.edit_usage(&f.alternate, |u| {
            u.five_hour.as_mut().unwrap().used_percent = 20.0
        });
        let deps = f.deps.spread();
        let base = lock(&f.deps.snapshot).clone();
        deps.set_snapshot(move || DesktopContinuationContext {
            tempo_rate,
            ..base()
        });
        let manager = DesktopContinuationManager::new(deps);
        manager.arm(&automatic_arm()).unwrap();
        manager.tick();
        let expected = if expected == "target" {
            &f.target
        } else {
            &f.alternate
        };
        assert_eq!(&f.requests()[0].target.id, expected);
    }
}

/// A fresh reading of `used` percent on the five-hour window, and `weekly` on the week.
fn poll_reading(account_id: &str, now: f64, used: f64, weekly: Option<f64>) -> AccountUsage {
    AccountUsage {
        checked_at: Some(iso(now - 60_000.0)),
        five_hour: Some(UsageWindow::new(used, Some(&iso(now + 3_600_000.0)))),
        seven_day: weekly.map(|w| UsageWindow::new(w, Some(&iso(now + 86_400_000.0)))),
        ..AccountUsage::new(account_id, UsageStatus::Ready)
    }
}

#[test]
fn the_watch_polls_every_30_s_while_the_source_has_more_than_20_left_else_every_10_s() {
    let id = "source";
    let now = now();
    assert_eq!(CONTINUATION_POLL_MS, 10_000);
    assert_eq!(CONTINUATION_FAR_POLL_MS, 30_000);
    assert_eq!(
        continuation_poll_ms(Some(&poll_reading(id, now, 50.0, None)), now),
        30_000
    );
    assert_eq!(
        continuation_poll_ms(Some(&poll_reading(id, now, 79.0, Some(10.0))), now),
        30_000
    );
    // 20% left, or less, on any window is near the limit.
    assert_eq!(
        continuation_poll_ms(Some(&poll_reading(id, now, 80.0, None)), now),
        10_000
    );
    assert_eq!(
        continuation_poll_ms(Some(&poll_reading(id, now, 10.0, Some(85.0))), now),
        10_000
    );
    assert_eq!(
        continuation_poll_ms(
            Some(&AccountUsage {
                other_limit_reached: Some(true),
                ..poll_reading(id, now, 10.0, None)
            }),
            now
        ),
        10_000
    );
    // Without a fresh reading the watch cannot tell: it stays quick.
    assert_eq!(continuation_poll_ms(None, now), 10_000);
    assert_eq!(
        continuation_poll_ms(
            Some(&AccountUsage {
                stale: true,
                ..poll_reading(id, now, 10.0, None)
            }),
            now
        ),
        10_000
    );
    assert_eq!(
        continuation_poll_ms(
            Some(&poll_reading(id, now - 20.0 * 60_000.0, 10.0, None)),
            now
        ),
        10_000
    );
    assert_eq!(
        continuation_poll_ms(
            Some(&AccountUsage {
                status: UsageStatus::Error,
                ..poll_reading(id, now, 10.0, None)
            }),
            now
        ),
        10_000
    );
}

#[test]
fn an_armed_watch_far_from_the_limit_observes_every_30_s_and_every_10_s_once_it_nears_it() {
    let f = setup();
    let clock = Arc::new(Mutex::new(now()));
    let usage = Arc::new(Mutex::new(JsMap::<AccountUsage>::new()));
    let observed = Arc::new(AtomicUsize::new(0));
    let deps = f.deps.spread();
    {
        let clock = Arc::clone(&clock);
        *lock(&deps.now) = Arc::new(move || *lock(&clock));
    }
    {
        let (base, usage) = (lock(&f.deps.snapshot).clone(), Arc::clone(&usage));
        deps.set_snapshot(move || DesktopContinuationContext {
            usage: lock(&usage).clone(),
            ..base()
        });
    }
    {
        let (clock, observed, shared) = (
            Arc::clone(&clock),
            Arc::clone(&observed),
            Arc::clone(&f.shared),
        );
        deps.set_observe(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            let mut value = lock(&shared.observation).clone();
            value.state.observed_at = *lock(&clock);
            Ok(value)
        });
    }
    let manager = Arc::new(DesktopContinuationManager::new(deps));
    manager.arm(&explicit(&f.target)).unwrap();
    // A changed mode is settled by the read-only look: one observation a poll.
    f.observation().state.session.permission_mode = "Manual".into();
    let advance = |ms: f64| {
        *lock(&clock) += ms;
        f.shared.timers.tick(ms);
    };
    let reading = |used: f64| poll_reading(&f.source, *lock(&clock), used, None);
    lock(&usage).insert(f.source.clone(), reading(50.0));
    let start = observed.load(Ordering::SeqCst);
    let polls = || observed.load(Ordering::SeqCst) - start;
    manager.start();
    assert_eq!(polls(), 1);
    advance(10_000.0);
    advance(10_000.0);
    assert_eq!(polls(), 1);
    advance(10_000.0);
    assert_eq!(polls(), 2);
    lock(&usage).insert(f.source.clone(), reading(85.0));
    advance(10_000.0);
    assert_eq!(polls(), 3);
    advance(10_000.0);
    assert_eq!(polls(), 4);
    manager.stop();
}
