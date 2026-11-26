//! Port of `tests/continuation.test.ts`.

#[path = "common/continuation.rs"]
mod helpers;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use helpers::{
    account, capabilities, guarded_native, now, profile_identity, set_capability, usage, uuid,
};
use relay_core::continuation::{
    CONTINUATION_TEXT, ContinuationCapabilities, ContinuationCheckpoint,
    ContinuationCheckpointInput, ContinuationDelivery, ContinuationEngine, ContinuationError,
    ContinuationHost, ContinuationHostKind, ContinuationJournal, ContinuationJournalRecord,
    ContinuationKind, ContinuationQuiescence, ContinuationReceipt, ContinuationReopenInput,
    ContinuationRequest, ContinuationResultStatus, ContinuationSendInput, ContinuationSession,
    ContinuationState, ContinuationSwitchInput, DeliveryStatus, ExecutionPolicy,
    QuiescenceCoverage, SessionStatus, is_terminal_continuation_record,
};
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{
    AccountKind, AccountPlan, AccountPlanning, DesktopHistoryTransfer, UsageIssue, UsageWindow,
    default_settings,
};
use serde_json::{Map, Value, json};

#[derive(Default)]
struct MemoryJournal {
    records: Mutex<Map<String, Value>>,
    writes: Mutex<Vec<String>>,
    fail_stage: Mutex<Option<String>>,
    lock: Mutex<()>,
}

impl MemoryJournal {
    fn records(&self) -> MutexGuard<'_, Map<String, Value>> {
        self.records.lock().unwrap()
    }
    fn writes(&self) -> Vec<String> {
        self.writes.lock().unwrap().clone()
    }
    fn fail_at(&self, stage: &str) {
        *self.fail_stage.lock().unwrap() = Some(stage.into());
    }
}

impl ContinuationJournal for MemoryJournal {
    fn with_lock<T>(
        &self,
        _request_id: &str,
        action: impl FnOnce() -> Result<T, ContinuationError>,
    ) -> Result<T, ContinuationError> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        action()
    }
    fn read(&self, request_id: &str) -> Result<Option<Value>, ContinuationError> {
        Ok(self.records().get(request_id).cloned())
    }
    fn list_pending(&self) -> Result<Vec<Value>, ContinuationError> {
        Ok(self
            .records()
            .values()
            .filter(|record| !is_terminal_continuation_record(record, Some(now())))
            .cloned()
            .collect())
    }
    fn write(&self, record: &ContinuationJournalRecord) -> Result<(), ContinuationError> {
        let mut fail = self.fail_stage.lock().unwrap();
        if fail.as_deref() == Some(record.stage.as_str()) {
            *fail = None;
            return Err("fixture-journal-fsync-failed".into());
        }
        self.records()
            .insert(record.id.clone(), serde_json::to_value(record).unwrap());
        self.writes
            .lock()
            .unwrap()
            .push(record.stage.as_str().into());
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct Message {
    text: String,
    account_id: String,
}

struct HostState {
    capabilities: ContinuationCapabilities,
    state: ContinuationState,
    actions: Vec<String>,
    deliveries: HashMap<String, ContinuationDelivery>,
    messages: Vec<Message>,
    faults: HashSet<String>,
    checkpoints: HashMap<String, ContinuationCheckpoint>,
}

impl HostState {
    fn guard(&self, revision: f64) -> Result<(), ContinuationError> {
        if revision != self.state.context_revision {
            return Err("atomic-context-guard-rejected".into());
        }
        if self.state.session.status != SessionStatus::Stopped {
            return Err("fixture-session-busy".into());
        }
        Ok(())
    }
    fn fault(&self, name: &str) -> bool {
        self.faults.contains(name)
    }
}

struct FixtureHost(Mutex<HostState>);

impl FixtureHost {
    fn lock(&self) -> MutexGuard<'_, HostState> {
        self.0.lock().unwrap()
    }
    fn actions(&self) -> Vec<String> {
        self.lock().actions.clone()
    }
    fn messages(&self) -> Vec<Message> {
        self.lock().messages.clone()
    }
    fn sends(&self) -> usize {
        self.lock().actions.iter().filter(|a| *a == "send").count()
    }
}

impl ContinuationHost for FixtureHost {
    fn capabilities(&self) -> ContinuationCapabilities {
        self.lock().capabilities.clone()
    }
    fn read_state(&self) -> Result<ContinuationState, ContinuationError> {
        let mut host = self.lock();
        let state = host.state.clone();
        if host.fault("user-race") && host.actions.iter().any(|a| a == "reopen") {
            host.state.context_revision += 1.0;
        }
        Ok(state)
    }
    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, ContinuationError> {
        let mut host = self.lock();
        host.guard(input.expected_context_revision)?;
        host.actions.push("checkpoint".into());
        let mut checkpoint = ContinuationCheckpoint {
            id: format!("checkpoint-{}", input.request_id),
            session: host.state.session.clone(),
        };
        if host.fault("bad-checkpoint") {
            checkpoint.session.id = uuid();
        }
        host.checkpoints
            .insert(checkpoint.id.clone(), checkpoint.clone());
        host.state.context_revision += 1.0;
        Ok(checkpoint)
    }
    fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), ContinuationError> {
        let mut host = self.lock();
        host.guard(input.expected_context_revision)?;
        host.actions.push("switch".into());
        host.state.identity = input.target.clone();
        host.state.context_revision += 1.0;
        if host.fault("wrong-account") {
            host.state.identity.account_uuid = uuid();
        }
        if host.fault("busy-after-switch") {
            host.state.quiescence.subagents = 1.0;
        }
        if host.fault("crash-after-switch") {
            return Err("fixture-crash-after-switch".into());
        }
        Ok(())
    }
    fn reopen_session(&self, input: &ContinuationReopenInput) -> Result<(), ContinuationError> {
        let mut host = self.lock();
        host.guard(input.expected_context_revision)?;
        host.actions.push("reopen".into());
        host.state.session = host.checkpoints[&input.checkpoint.id].session.clone();
        host.state.context_revision += 1.0;
        if host.fault("wrong-session") {
            host.state.session.id = uuid();
        }
        if host.fault("wrong-project") {
            host.state.session.project_key = "fixture-other-project".into();
        }
        if host.fault("changed-transcript") {
            host.state.session.transcript_revision = "user-added-turn".into();
        }
        if host.fault("changed-permissions") {
            host.state.session.permission_mode = "bypassPermissions".into();
        }
        Ok(())
    }
    fn send_continuation(
        &self,
        input: &ContinuationSendInput,
    ) -> Result<ContinuationDelivery, ContinuationError> {
        let mut host = self.lock();
        host.guard(input.expected_context_revision)?;
        if let Some(existing) = host.deliveries.get(&input.request_id) {
            return Ok(existing.clone());
        }
        host.actions.push("send".into());
        if host.fault("refused") {
            return Ok(ContinuationDelivery {
                status: DeliveryStatus::Rejected,
                receipt: None,
            });
        }
        let account_id = host.state.identity.profile_id.clone();
        host.messages.push(Message {
            text: input.text.clone(),
            account_id,
        });
        let before_revision = host.state.session.transcript_revision.clone();
        let after_revision = format!("{before_revision}:continued");
        let turn_id = uuid();
        host.state.session.transcript_revision = after_revision.clone();
        host.state.session.last_request_id = Some(input.request_id.clone());
        host.state.session.last_turn_id = Some(turn_id.clone());
        host.state.session.status = SessionStatus::Running;
        host.state.context_revision += 1.0;
        let mut delivery = ContinuationDelivery {
            status: DeliveryStatus::Started,
            receipt: Some(ContinuationReceipt {
                request_id: input.request_id.clone(),
                identity: host.state.identity.clone(),
                session_id: host.state.session.id.clone(),
                project_key: host.state.session.project_key.clone(),
                permission_mode: host.state.session.permission_mode.clone(),
                before_revision,
                after_revision,
                turn_id,
            }),
        };
        host.deliveries
            .insert(input.request_id.clone(), delivery.clone());
        if host.fault("crash-after-send") {
            return Err("fixture-crash-after-send".into());
        }
        if host.fault("accepted-only") {
            delivery.status = DeliveryStatus::Accepted;
            return Ok(delivery);
        }
        if host.fault("receipt-wrong-account") {
            delivery.receipt.as_mut().unwrap().identity.account_uuid = uuid();
        }
        // Later turn IDs are expected while the resumed work continues; a different
        // conversation in the target is not the confirmed continuation.
        if host.fault("receipt-not-observed") {
            host.state.session.id = uuid();
        }
        Ok(delivery)
    }
    fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, ContinuationError> {
        let mut host = self.lock();
        host.actions.push("lookup".into());
        let status = |status| ContinuationDelivery {
            status,
            receipt: None,
        };
        if host.fault("ambiguous-lookup") {
            return Ok(status(DeliveryStatus::Unknown));
        }
        if host.fault("absent-lookup") {
            return Ok(status(DeliveryStatus::Absent));
        }
        Ok(host
            .deliveries
            .get(request_id)
            .cloned()
            .unwrap_or_else(|| status(DeliveryStatus::Absent)))
    }
}

type Engine = ContinuationEngine<Arc<FixtureHost>, Arc<MemoryJournal>>;

struct Fixture {
    request: ContinuationRequest,
    host: Arc<FixtureHost>,
    journal: Arc<MemoryJournal>,
    engine: Engine,
}

impl Fixture {
    /// A new engine on the same host and journal (an application restart).
    fn restarted(&self) -> Engine {
        ContinuationEngine::with_clock(Arc::clone(&self.host), Arc::clone(&self.journal), now)
    }
    fn execute(
        &self,
        request: &ContinuationRequest,
    ) -> relay_core::continuation::ContinuationResult {
        self.engine.execute(request).unwrap()
    }
    fn reason(&self, request: &ContinuationRequest) -> String {
        self.execute(request).reason
    }
    fn status(&self, request: &ContinuationRequest) -> ContinuationResultStatus {
        self.execute(request).status
    }
    fn host(&self) -> MutexGuard<'_, HostState> {
        self.host.lock()
    }
    fn record(&self) -> Value {
        self.journal.records()[&self.request.id].clone()
    }
}

fn usage_map(entries: [(&str, f64); 2]) -> JsMap<relay_core::shared::types::AccountUsage> {
    entries
        .into_iter()
        .map(|(id, used)| (id.to_owned(), usage(id, used, 25.0)))
        .collect()
}

fn fixture() -> Fixture {
    let source = account("Fixture A", "fixture-only");
    let target = account("Fixture B", "fixture-only");
    let request = ContinuationRequest {
        id: uuid(),
        usage: usage_map([(&source.id, 100.0), (&target.id, 20.0)]),
        source,
        target,
        authorized: true,
        settings: default_settings(),
        session_id: uuid(),
        project_key: "fixture-project".into(),
        transcript_revision: "revision-0".into(),
        permission_mode: "default".into(),
        expected_context_revision: 7.0,
        execution_policy: None,
    };
    let host = Arc::new(FixtureHost(Mutex::new(HostState {
        capabilities: capabilities(ContinuationHostKind::Simulated, "fixture-v1"),
        state: ContinuationState {
            context_revision: 7.0,
            observed_at: now(),
            identity: profile_identity(&request.source),
            session: ContinuationSession {
                id: request.session_id.clone(),
                project_key: request.project_key.clone(),
                transcript_revision: request.transcript_revision.clone(),
                permission_mode: request.permission_mode.clone(),
                status: SessionStatus::Stopped,
                last_request_id: None,
                last_turn_id: None,
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
        actions: Vec::new(),
        deliveries: HashMap::new(),
        messages: Vec::new(),
        faults: HashSet::new(),
        checkpoints: HashMap::new(),
    })));
    let journal = Arc::new(MemoryJournal::default());
    let engine = ContinuationEngine::with_clock(Arc::clone(&host), Arc::clone(&journal), now);
    Fixture {
        request,
        host,
        journal,
        engine,
    }
}

fn quiescence_counter<'a>(q: &'a mut ContinuationQuiescence, key: &str) -> &'a mut f64 {
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

#[test]
fn guarded_native_transport_requires_explicit_at_most_once_consent_and_verified_worker_coverage() {
    let mut f = fixture();
    guarded_native(&mut f.host().capabilities);
    f.host().state.quiescence.coverage = QuiescenceCoverage::GuardedLocal;
    assert_eq!(f.reason(&f.request), "adapter-contract-unverified");
    assert!(f.host.actions().is_empty());
    f.request.execution_policy = Some(ExecutionPolicy::GuardedNativeAtMostOnce);
    f.host().state.quiescence.coverage = QuiescenceCoverage::Unknown;
    assert_eq!(f.reason(&f.request), "coverage-unverified");
    assert!(f.host.actions().is_empty());
    f.host().state.quiescence.coverage = QuiescenceCoverage::GuardedLocal;
    let result = f.execute(&f.request);
    assert_eq!(result.status, ContinuationResultStatus::Continued);
    let record = result.record.unwrap();
    assert!(is_terminal_continuation_record(
        &serde_json::to_value(&record).unwrap(),
        Some(now())
    ));
    assert_eq!(f.host.messages().len(), 1);
    let bound: Value = serde_json::from_str(&record.bound_request).unwrap();
    assert_eq!(bound["executionPolicy"], "guarded-native-at-most-once");
    let changed = ContinuationRequest {
        execution_policy: None,
        ..f.request.clone()
    };
    {
        let caps = &mut f.host().capabilities;
        caps.kind = ContinuationHostKind::VerifiedContract;
        caps.idempotent_delivery = true;
        caps.atomic_context_guard = true;
    }
    assert_eq!(f.reason(&changed), "journal-binding-mismatch");
    assert_eq!(f.host.messages().len(), 1);
}

#[test]
fn native_opt_in_cannot_weaken_a_transport_advertising_a_verified_atomic_contract() {
    let mut f = fixture();
    {
        let caps = &mut f.host().capabilities;
        caps.kind = ContinuationHostKind::VerifiedContract;
        caps.atomic_context_guard = false;
    }
    f.request.execution_policy = Some(ExecutionPolicy::GuardedNativeAtMostOnce);
    assert_eq!(f.reason(&f.request), "adapter-contract-unverified");
    assert!(f.host.actions().is_empty());
}

#[test]
fn quota_ended_a_b_a_resumes_the_same_uuid_project_history_and_starts_one_target_account_turn_each_way()
 {
    let f = fixture();
    let first = f.execute(&f.request);
    assert_eq!(first.status, ContinuationResultStatus::Continued);
    assert_eq!(
        first.continuation_kind,
        ContinuationKind::StoppedSessionNewTurn
    );
    assert_eq!(f.host.actions(), ["checkpoint", "switch", "reopen", "send"]);
    let messages = f.host.messages();
    assert_eq!(messages[0].account_id, f.request.target.id);
    assert_eq!(messages[0].text, CONTINUATION_TEXT);
    let writes = f.journal.writes();
    let at = |stage: &str| writes.iter().position(|w| w == stage).unwrap();
    assert!(at("send-intent") < at("delivery-confirmed"));
    f.host().state.session.status = SessionStatus::Stopped;
    let first_receipt = first.receipt.unwrap();
    let back = ContinuationRequest {
        id: uuid(),
        source: f.request.target.clone(),
        target: f.request.source.clone(),
        usage: usage_map([(&f.request.target.id, 100.0), (&f.request.source.id, 20.0)]),
        transcript_revision: first_receipt.after_revision.clone(),
        expected_context_revision: f.host().state.context_revision,
        ..f.request.clone()
    };
    let second = f.execute(&back);
    assert_eq!(second.status, ContinuationResultStatus::Continued);
    let second_receipt = second.receipt.unwrap();
    assert_eq!(second_receipt.session_id, first_receipt.session_id);
    assert_eq!(second_receipt.project_key, first_receipt.project_key);
    assert_eq!(second_receipt.before_revision, first_receipt.after_revision);
    let messages = f.host.messages();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].account_id, f.request.source.id);
}

#[test]
fn every_busy_child_wait_queue_schedule_unknown_signal_blocks_before_any_host_mutation() {
    for key in [
        "busyWorkers",
        "subagents",
        "pendingTasks",
        "waiting",
        "queuedPrompts",
        "scheduledWakeups",
        "unknownWork",
    ] {
        for value in [1.0, f64::NAN, -1.0] {
            let f = fixture();
            *quiescence_counter(&mut f.host().state.quiescence, key) = value;
            assert_eq!(
                f.status(&f.request),
                ContinuationResultStatus::Blocked,
                "{key}"
            );
            assert!(f.host.actions().is_empty());
        }
    }
}

#[test]
fn a_source_worker_must_be_stopped_with_fresh_complete_observed_coverage_and_the_captured_context_revision()
 {
    let changes: [fn(&mut ContinuationState); 6] = [
        |s| s.session.status = SessionStatus::Running,
        |s| s.session.status = SessionStatus::Waiting,
        |s| s.quiescence.coverage = QuiescenceCoverage::Unknown,
        |s| s.observed_at = now() - 15_001.0,
        |s| s.observed_at = now() + 1.0,
        |s| s.context_revision += 1.0,
    ];
    for change in changes {
        let f = fixture();
        change(&mut f.host().state);
        assert_eq!(f.status(&f.request), ContinuationResultStatus::Blocked);
        assert!(f.host.actions().is_empty());
    }
}

#[test]
fn authorization_and_every_executable_capability_are_mandatory() {
    for key in [
        "exactSession",
        "conditionalActions",
        "idempotentDelivery",
        "deliveryLookup",
        "checkpoint",
        "accountSwitch",
        "sessionReopen",
        "targetedSend",
        "deliveryReceipt",
        "atomicContextGuard",
    ] {
        let f = fixture();
        set_capability(&mut f.host().capabilities, key, false);
        assert_eq!(f.reason(&f.request), "adapter-contract-unverified");
        assert!(f.host.actions().is_empty());
    }
    let mut f = fixture();
    f.request.authorized = false;
    assert_eq!(f.reason(&f.request), "not-authorized");
}

#[test]
fn account_enrollment_duplicate_identities_source_identity_and_exact_source_history_are_verified() {
    let changes: [fn(&mut Fixture); 7] = [
        |f| f.request.source.auth.as_mut().unwrap().logged_in = false,
        |f| f.request.target.auth.as_mut().unwrap().org_id = Some(uuid()),
        |f| {
            f.request.target.desktop = f.request.source.desktop.clone();
            f.request.target.auth = f.request.source.auth.clone();
        },
        |f| f.host().state.identity.account_uuid = uuid(),
        |f| f.host().state.session.id = uuid(),
        |f| f.host().state.session.transcript_revision = "other-revision".into(),
        |f| f.host().state.session.permission_mode = "other-mode".into(),
    ];
    for change in changes {
        let mut f = fixture();
        change(&mut f);
        assert_eq!(f.status(&f.request), ContinuationResultStatus::Blocked);
        assert!(f.host.actions().is_empty());
    }
}

#[test]
fn cross_company_history_needs_both_selected_endpoints_and_off_never_grants_same_group_access() {
    let mut f = fixture();
    f.request.target.kind = AccountKind::Work;
    f.request.target.group = "fixture-work".into();
    f.request.settings.desktop_history_transfer = DesktopHistoryTransfer::SameGroup;
    assert_eq!(f.reason(&f.request), "history-boundary");
    f.request.settings.desktop_history_transfer = DesktopHistoryTransfer::Selected;
    f.request.settings.desktop_history_accounts = vec![f.request.target.id.clone()];
    assert_eq!(f.reason(&f.request), "history-boundary");
    let source_id = f.request.source.id.clone();
    f.request.settings.desktop_history_accounts.push(source_id);
    assert_eq!(f.status(&f.request), ContinuationResultStatus::Continued);
    let mut off = fixture();
    off.request.settings.desktop_history_transfer = DesktopHistoryTransfer::Off;
    assert_eq!(off.reason(&off.request), "history-boundary");
}

#[test]
fn source_and_target_require_known_fresh_quota_source_recovered_quota_and_target_90_block() {
    fn target(f: &mut Fixture) -> &mut relay_core::shared::types::AccountUsage {
        let id = f.request.target.id.clone();
        f.request.usage.get_mut(&id).unwrap()
    }
    fn source(f: &mut Fixture) -> &mut relay_core::shared::types::AccountUsage {
        let id = f.request.source.id.clone();
        f.request.usage.get_mut(&id).unwrap()
    }
    let changes: [fn(&mut Fixture); 9] = [
        |f| target(f).five_hour = None,
        |f| target(f).stale = true,
        |f| target(f).issue = Some(UsageIssue::RateLimited),
        |f| target(f).checked_at = Some(relay_core::shared::types::js::iso(now() + 1.0)),
        |f| source(f).checked_at = Some(relay_core::shared::types::js::iso(now() - 300_001.0)),
        |f| source(f).five_hour.as_mut().unwrap().used_percent = 99.0,
        |f| target(f).seven_day.as_mut().unwrap().used_percent = 90.0,
        |f| {
            target(f).five_hour.as_mut().unwrap().resets_at =
                Some(relay_core::shared::types::js::iso(now()))
        },
        |f| f.request.target.cooldown_until = Some(relay_core::shared::types::js::iso(now() + 1.0)),
    ];
    for change in changes {
        let mut f = fixture();
        change(&mut f);
        assert_eq!(f.status(&f.request), ContinuationResultStatus::Blocked);
        assert!(f.host.actions().is_empty());
    }
}

#[test]
fn checkpoint_mismatch_switch_identity_mismatch_and_newly_busy_child_tasks_stop_before_reopening_or_sending()
 {
    for (fault, actions) in [
        ("bad-checkpoint", &["checkpoint"][..]),
        ("wrong-account", &["checkpoint", "switch"][..]),
        ("busy-after-switch", &["checkpoint", "switch"][..]),
    ] {
        let f = fixture();
        f.host().faults.insert(fault.into());
        assert_eq!(
            f.status(&f.request),
            ContinuationResultStatus::ReconciliationRequired
        );
        assert_eq!(f.host.actions(), actions);
        assert!(f.host.messages().is_empty());
    }
}

#[test]
fn reopened_uuid_project_transcript_and_permission_mode_must_all_match_before_the_continuation_send()
 {
    for fault in [
        "wrong-session",
        "wrong-project",
        "changed-transcript",
        "changed-permissions",
    ] {
        let f = fixture();
        f.host().faults.insert(fault.into());
        assert_eq!(f.reason(&f.request), "session-mismatch");
        assert!(f.host.messages().is_empty());
    }
}

#[test]
fn atomic_context_guard_rejects_a_user_turn_racing_the_final_send() {
    let f = fixture();
    f.host().faults.insert("user-race".into());
    assert_eq!(f.reason(&f.request), "atomic-context-guard-rejected");
    assert!(f.host.messages().is_empty());
}

#[test]
fn accepted_only_delivery_is_distinct_from_observed_new_turn_start() {
    let f = fixture();
    f.host().faults.insert("accepted-only".into());
    assert_eq!(f.reason(&f.request), "delivery-accepted");
    assert_eq!(f.record()["stage"], "delivery-accepted");
    assert_eq!(f.host.messages().len(), 1);
    assert_eq!(
        f.restarted().execute(&f.request).unwrap().status,
        ContinuationResultStatus::Continued
    );
    assert_eq!(f.host.messages().len(), 1);
}

#[test]
fn receipt_identity_and_the_observed_new_turn_independently_gate_confirmation() {
    for (fault, reason) in [
        ("receipt-wrong-account", "receipt-mismatch"),
        ("receipt-not-observed", "new-turn-not-observed"),
    ] {
        let f = fixture();
        f.host().faults.insert(fault.into());
        assert_eq!(f.reason(&f.request), reason);
        assert_ne!(f.record()["stage"], "delivery-confirmed");
    }
}

#[test]
fn crash_after_submission_reconciles_persisted_receipt_without_resending_after_engine_restart() {
    let f = fixture();
    f.host().faults.insert("crash-after-send".into());
    assert_eq!(
        f.status(&f.request),
        ContinuationResultStatus::ReconciliationRequired
    );
    assert_eq!(f.host.messages().len(), 1);
    let restarted = f.restarted();
    assert_eq!(
        restarted.execute(&f.request).unwrap().status,
        ContinuationResultStatus::Continued
    );
    assert_eq!(f.host.messages().len(), 1);
    assert_eq!(f.host.sends(), 1);
}

#[test]
fn absent_or_ambiguous_receipt_after_a_recorded_send_intent_never_causes_a_retry() {
    for fault in ["absent-lookup", "ambiguous-lookup"] {
        let f = fixture();
        f.host().faults.insert("crash-after-send".into());
        f.execute(&f.request);
        f.host().faults.insert(fault.into());
        let result = f.restarted().execute(&f.request).unwrap();
        assert_eq!(
            result.status,
            ContinuationResultStatus::ReconciliationRequired
        );
        assert_eq!(f.host.messages().len(), 1);
        assert_eq!(f.host.sends(), 1);
    }
}

#[test]
fn crash_before_submission_leaves_an_absent_receipt_for_explicit_recovery_not_automatic_execution()
{
    let f = fixture();
    f.host().faults.insert("user-race".into());
    f.execute(&f.request);
    f.host().faults.clear();
    let result = f.restarted().execute(&f.request).unwrap();
    assert_eq!(result.reason, "delivery-absent");
    assert!(f.host.messages().is_empty());
}

#[test]
fn durable_journal_writes_precede_side_effects_and_a_failed_send_intent_write_prevents_sending() {
    let prepared = fixture();
    prepared.journal.fail_at("prepared");
    let error = prepared.engine.execute(&prepared.request).unwrap_err();
    assert!(error.message().contains("fsync-failed"));
    assert!(prepared.host.actions().is_empty());
    let sending = fixture();
    sending.journal.fail_at("send-intent");
    assert_eq!(
        sending.status(&sending.request),
        ContinuationResultStatus::ReconciliationRequired
    );
    assert!(sending.host.messages().is_empty());
}

#[test]
fn crash_after_switching_resumes_a_durable_unsent_checkpoint_without_replaying_the_account_switch()
{
    let f = fixture();
    f.host().faults.insert("crash-after-switch".into());
    f.execute(&f.request);
    assert_eq!(
        f.restarted().execute(&f.request).unwrap().status,
        ContinuationResultStatus::Continued
    );
    assert_eq!(
        f.host.actions().iter().filter(|a| *a == "switch").count(),
        1
    );
    assert_eq!(f.host.messages().len(), 1);
    assert_eq!(f.host().state.session.id, f.request.session_id);
}

#[test]
fn a_completed_request_is_durable_idempotent_and_bound_to_account_session_permission_history() {
    let f = fixture();
    f.execute(&f.request);
    let actions = f.host.actions();
    assert_eq!(f.reason(&f.request), "durable-delivery-confirmed");
    assert_eq!(f.host.actions(), actions);
    let updates: [fn(&mut ContinuationRequest); 4] = [
        |r| r.target = account("Other", "fixture-only"),
        |r| r.session_id = uuid(),
        |r| r.transcript_revision = "changed".into(),
        |r| r.permission_mode = "bypassPermissions".into(),
    ];
    for update in updates {
        let mut request = f.request.clone();
        update(&mut request);
        assert_eq!(f.reason(&request), "journal-binding-mismatch");
        assert_eq!(f.host.actions(), actions);
    }
}

#[test]
fn the_host_wide_journal_lock_prevents_concurrent_duplicate_execution() {
    let f = fixture();
    let restarted = f.restarted();
    let results = std::thread::scope(|scope| {
        let first = scope.spawn(|| f.engine.execute(&f.request).unwrap());
        let second = scope.spawn(|| restarted.execute(&f.request).unwrap());
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert!(
        results
            .iter()
            .all(|result| result.status == ContinuationResultStatus::Continued)
    );
    assert_eq!(f.host.messages().len(), 1);
}

#[test]
fn a_team_source_with_unknown_weekly_quota_can_hand_off_a_known_exhausted_5h_window() {
    let mut f = fixture();
    f.request.source.kind = AccountKind::Work;
    f.request.source.planning = Some(AccountPlanning {
        plan: AccountPlan::Team,
        capacity_weight: 1.0,
    });
    let source_id = f.request.source.id.clone();
    f.request.usage.get_mut(&source_id).unwrap().seven_day = None;
    assert_eq!(f.status(&f.request), ContinuationResultStatus::Continued);
    let mut unknown = fixture();
    let source_id = unknown.request.source.id.clone();
    let source = unknown.request.usage.get_mut(&source_id).unwrap();
    source.five_hour = None;
    source.seven_day = None;
    assert_eq!(unknown.reason(&unknown.request), "quota-not-fresh");
}

#[test]
fn a_fresh_target_with_zero_used_and_no_start_reset_timestamp_is_eligible_nonzero_missing_reset_is_blocked()
 {
    let mut f = fixture();
    let target_id = f.request.target.id.clone();
    f.request.usage.get_mut(&target_id).unwrap().five_hour = Some(UsageWindow::new(0.0, None));
    assert_eq!(f.status(&f.request), ContinuationResultStatus::Continued);
    let mut nonzero = fixture();
    let target_id = nonzero.request.target.id.clone();
    nonzero.request.usage.get_mut(&target_id).unwrap().five_hour =
        Some(UsageWindow::new(1.0, None));
    assert_eq!(nonzero.reason(&nonzero.request), "quota-not-fresh");
}

#[test]
fn a_new_request_id_cannot_bypass_an_unresolved_send_even_for_a_different_session() {
    let f = fixture();
    f.host().faults.insert("crash-after-send".into());
    f.execute(&f.request);
    f.host().state.session.status = SessionStatus::Stopped;
    f.host().faults.clear();
    for session_id in [f.request.session_id.clone(), uuid()] {
        let (transcript_revision, expected_context_revision) = {
            let host = f.host();
            (
                host.state.session.transcript_revision.clone(),
                host.state.context_revision,
            )
        };
        let result = f.execute(&ContinuationRequest {
            id: uuid(),
            source: f.request.target.clone(),
            target: f.request.source.clone(),
            usage: usage_map([(&f.request.target.id, 100.0), (&f.request.source.id, 0.0)]),
            session_id,
            transcript_revision,
            expected_context_revision,
            ..f.request.clone()
        });
        assert_eq!(result.reason, "unresolved-host-intent");
        assert_eq!(f.host.messages().len(), 1);
    }
}

#[test]
fn corrupt_persisted_terminal_records_neither_claim_success_nor_exempt_the_host_wide_barrier() {
    let corruptions: [fn(&mut Value); 7] = [
        |r| r["receipt"]["identity"]["accountUuid"] = json!(uuid()),
        |r| r["receipt"]["sessionId"] = json!(uuid()),
        |r| r["sendRecorded"] = json!(false),
        |r| {
            r["stage"] = json!("blocked");
            r["sendRecorded"] = json!(true);
        },
        // `NaN` has no JSON form: the journal holds `null` where the TS holds `NaN`.
        |r| r["updatedAt"] = Value::Null,
        |r| r["updatedAt"] = json!(now() + 1.0),
        |r| {
            r["stage"] = json!("session-verified");
            r["sendRecorded"] = json!(false);
        },
    ];
    for corrupt in corruptions {
        let f = fixture();
        f.execute(&f.request);
        let mut record = f.record();
        corrupt(&mut record);
        f.journal
            .records()
            .insert(f.request.id.clone(), record.clone());
        assert!(!is_terminal_continuation_record(&record, Some(now())));
        assert_eq!(f.reason(&f.request), "journal-record-invalid");
        let actions = f.host.actions();
        assert_eq!(
            f.reason(&ContinuationRequest {
                id: uuid(),
                ..f.request.clone()
            }),
            "unresolved-host-intent"
        );
        assert_eq!(f.host.actions(), actions);
    }
}

#[test]
fn existing_unsent_recovery_also_blocks_while_another_host_intent_is_unresolved() {
    let f = fixture();
    f.host().faults.insert("crash-after-switch".into());
    f.execute(&f.request);
    let mut other = f.record();
    let other_id = uuid();
    other["id"] = json!(other_id);
    other["stage"] = json!("send-intent");
    other["sendRecorded"] = json!(true);
    f.journal.records().insert(other_id, other);
    let actions = f.host.actions();
    assert_eq!(f.reason(&f.request), "unresolved-host-intent");
    assert_eq!(f.host.actions(), actions);
}

#[test]
fn unsent_recovery_never_overwrites_a_user_updated_copy_of_the_same_conversation() {
    let f = fixture();
    f.host().faults.insert("crash-after-switch".into());
    f.execute(&f.request);
    f.host().state.session.transcript_revision = "user-turn-after-crash".into();
    f.host().faults.clear();
    let actions = f.host.actions();
    assert_eq!(f.reason(&f.request), "session-mismatch");
    assert_eq!(f.host.actions(), actions);
    assert!(f.host.messages().is_empty());
}

#[test]
fn journal_records_serialize_in_the_key_order_the_ts_engine_writes() {
    let f = fixture();
    f.execute(&f.request);
    let record = f.record();
    let keys: Vec<&str> = record
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "version",
            "id",
            "fingerprint",
            "boundRequest",
            "stage",
            "updatedAt",
            "sendRecorded",
            "checkpoint",
            "receipt"
        ]
    );
    let bound: Value = serde_json::from_str(record["boundRequest"].as_str().unwrap()).unwrap();
    let keys: Vec<&str> = bound
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "id",
            "source",
            "target",
            "sessionId",
            "projectKey",
            "transcriptRevision",
            "permissionMode",
            "expectedContextRevision",
            "continuationText"
        ]
    );
    assert!(
        record["boundRequest"]
            .as_str()
            .unwrap()
            .contains("\"expectedContextRevision\":7,")
    );
}
