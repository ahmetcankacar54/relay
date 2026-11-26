//! Port of `tests/desktop-continuation-host.test.ts`.
//!
//! The "the Swift …" cases scan `electron/native/desktop-automation.swift`'s source text; the
//! helper stays Swift and is not part of this port, so they are left to the TS suite.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

use relay_core::continuation::{
    ContinuationCheckpoint, ContinuationCheckpointInput, ContinuationDelivery, ContinuationHost,
    ContinuationIdentity, ContinuationQuiescence, ContinuationReopenInput, ContinuationSendInput,
    ContinuationSession, ContinuationState, ContinuationSwitchInput, DeliveryStatus,
    QuiescenceCoverage, SessionStatus,
};
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationGuard, DesktopAutomationIssue, DesktopAutomationSnapshot,
    DesktopAutomationStep, DesktopContinuationEvidence, DesktopContinuationHost,
    DesktopContinuationObservation, DesktopDraftGuard, DesktopHostError, DesktopNativeExecutor,
    DesktopSendResult, DesktopTargetPid, NativeDesktopAutomation, OpenSessionOptions,
    WriteDraftOptions, is_local_session_id, native_desktop_automation, new_session_guard,
};

const ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

fn local_id() -> String {
    format!("local_{ID}")
}

fn source() -> ContinuationIdentity {
    ContinuationIdentity {
        profile_id: "source".into(),
        account_uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into(),
        org_id: "cccccccc-cccc-cccc-cccc-cccccccccccc".into(),
    }
}

fn target() -> ContinuationIdentity {
    ContinuationIdentity {
        profile_id: "target".into(),
        account_uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd".into(),
        ..source()
    }
}

/// `snapshot()` as the helper's JSON.
fn snapshot_json() -> Value {
    json!({
        "observedAt": 100,
        "pid": 456,
        "localSessionId": local_id(),
        "accountLabel": "Test User Company",
        "permissionMode": "Auto",
        "status": "stopped",
        "quotaStopped": true,
        "composerEmpty": true,
        "sendEnabled": true,
        "contextFingerprint": "a".repeat(64),
        "coverage": "active-conversation-only",
    })
}

/// `{ ...snapshot(), ...extra }`; a `null` in `extra` drops the key (TS `undefined`).
fn snapshot_with(extra: Value) -> Value {
    let mut base = snapshot_json();
    let object = base.as_object_mut().unwrap();
    for (key, value) in extra.as_object().unwrap() {
        if value.is_null() {
            object.remove(key);
        } else {
            object.insert(key.clone(), value.clone());
        }
    }
    base
}

fn snapshot() -> DesktopAutomationSnapshot {
    serde_json::from_value(snapshot_json()).unwrap()
}

fn state() -> DesktopContinuationObservation {
    DesktopContinuationObservation {
        state: ContinuationState {
            observed_at: 100.0,
            context_revision: 1.0,
            identity: source(),
            session: ContinuationSession {
                id: ID.into(),
                project_key: "project-key".into(),
                transcript_revision: "rev-1".into(),
                permission_mode: "Auto".into(),
                status: SessionStatus::Stopped,
                last_request_id: None,
                last_turn_id: None,
            },
            quiescence: ContinuationQuiescence {
                coverage: QuiescenceCoverage::GuardedLocal,
                busy_workers: 0.0,
                subagents: 0.0,
                pending_tasks: 0.0,
                waiting: 0.0,
                queued_prompts: 0.0,
                scheduled_wakeups: 0.0,
                unknown_work: 0.0,
            },
        },
        own_quota_wakeup: None,
        local_session_id: local_id(),
        quota_stop: None,
    }
}

/// The TS fixture's automation and evidence, sharing `ui`, `observed` and `calls`.
struct World {
    ui: Mutex<DesktopAutomationSnapshot>,
    observed: Mutex<DesktopContinuationObservation>,
    delivery: Mutex<ContinuationDelivery>,
    calls: Mutex<Vec<String>>,
}

impl World {
    fn call(&self, entry: String) {
        self.calls.lock().unwrap().push(entry);
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl DesktopAutomation for World {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Ok(self.ui.lock().unwrap().clone())
    }
    fn open_session(
        &self,
        alias: &str,
        options: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError> {
        // Continuation never asks the helper to check the user: it opens as before.
        self.call(match options {
            None => format!("open:{alias}"),
            Some(options) => format!("open:{alias}:{}", serde_json::to_string(&options).unwrap()),
        });
        Ok(())
    }
    fn open_new_session(&self, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        Err(DesktopHostError::other(
            "openNewSession must not be called here",
        ))
    }
    fn set_permission(
        &self,
        _guard: &DesktopAutomationGuard,
        mode: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        self.call(format!("mode:{mode}"));
        self.ui.lock().unwrap().permission_mode = Some(mode.into());
        self.observed.lock().unwrap().state.session.permission_mode = mode.into();
        Ok(self.ui.lock().unwrap().clone())
    }
    fn send(
        &self,
        _guard: &DesktopAutomationGuard,
        request_id: &str,
        _text: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        self.call(format!("send:{request_id}"));
        Ok(DesktopSendResult {
            accepted_visible: true,
            written: None,
            submitted: None,
            after: None,
        })
    }
    fn has_request_marker(&self, _: &str) -> Result<bool, DesktopHostError> {
        Ok(false)
    }
    fn write_draft(
        &self,
        _: &DesktopDraftGuard,
        _: &str,
        _: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Err(DesktopHostError::other(
            "writeDraft must not be called here",
        ))
    }
}

impl DesktopContinuationEvidence for World {
    fn read(
        &self,
        _: &DesktopAutomationSnapshot,
    ) -> Result<DesktopContinuationObservation, DesktopHostError> {
        Ok(self.observed.lock().unwrap().clone())
    }
    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, DesktopHostError> {
        self.call("checkpoint".into());
        Ok(ContinuationCheckpoint {
            id: "checkpoint".into(),
            session: input.session.clone(),
        })
    }
    fn switch_account(&self, _: &ContinuationSwitchInput) -> Result<(), DesktopHostError> {
        self.call("switch".into());
        Ok(())
    }
    fn local_session_id(&self, _: &ContinuationCheckpoint) -> Result<String, DesktopHostError> {
        Ok(local_id())
    }
    fn lookup_delivery(&self, _: &str) -> Result<ContinuationDelivery, DesktopHostError> {
        Ok(self.delivery.lock().unwrap().clone())
    }
}

type Host = DesktopContinuationHost<Arc<World>, Arc<World>>;

fn fixture() -> (Host, Arc<World>) {
    let world = Arc::new(World {
        ui: Mutex::new(snapshot()),
        observed: Mutex::new(state()),
        delivery: Mutex::new(ContinuationDelivery {
            status: DeliveryStatus::Absent,
            receipt: None,
        }),
        calls: Mutex::new(Vec::new()),
    });
    let host = DesktopContinuationHost::with_delivery_wait(
        Arc::clone(&world),
        Arc::clone(&world),
        Box::new(|_| {}),
    );
    (host, world)
}

fn issue_of(error: &DesktopHostError) -> Option<DesktopAutomationIssue> {
    error.issue()
}

fn switch_input() -> ContinuationSwitchInput {
    ContinuationSwitchInput {
        request_id: "request".into(),
        target: target(),
        expected_context_revision: 1.0,
    }
}

fn session(world: &World) -> ContinuationSession {
    world.observed.lock().unwrap().state.session.clone()
}

/// An executor that records each request and answers `reply`.
fn recording(reply: Value) -> (DesktopNativeExecutor, Arc<Mutex<Vec<Value>>>) {
    let commands = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&commands);
    (
        Box::new(move |input| {
            seen.lock().unwrap().push(input);
            Ok(reply.clone())
        }),
        commands,
    )
}

fn answering(reply: Value) -> NativeDesktopAutomation {
    native_desktop_automation("/unused", Some(Box::new(move |_| Ok(reply.clone()))), None)
}

fn reply_snapshot(extra: Value) -> NativeDesktopAutomation {
    answering(json!({ "ok": true, "snapshot": snapshot_with(extra) }))
}

fn guard_for_send() -> DesktopAutomationGuard {
    DesktopAutomationGuard {
        pid: 1,
        local_session_id: local_id(),
        account_label: "test".into(),
        permission_mode: "Auto".into(),
        context_fingerprint: "a".repeat(64),
    }
}

fn draft_guard() -> DesktopDraftGuard {
    DesktopDraftGuard::Session(DesktopAutomationGuard {
        pid: 456,
        local_session_id: local_id(),
        account_label: "Test User Company".into(),
        permission_mode: "Auto".into(),
        context_fingerprint: "a".repeat(64),
    })
}

fn draft_guard_json() -> Value {
    serde_json::to_value(draft_guard()).unwrap()
}

fn require_idle(value: Option<bool>) -> Option<OpenSessionOptions> {
    Some(OpenSessionOptions {
        require_idle: value,
    })
}

fn keys(ms: f64) -> Option<WriteDraftOptions> {
    Some(WriteDraftOptions {
        keys_idle_ms: Some(ms),
    })
}

#[test]
fn native_adapter_exposes_absence_of_atomic_and_receiver_idempotent_guarantees() {
    let (host, _) = fixture();
    assert!(!host.capabilities().atomic_context_guard);
    assert!(!host.capabilities().idempotent_delivery);
}

#[test]
fn quota_stopped_selected_conversation_does_not_prove_full_quiescence() {
    let (host, world) = fixture();
    world.observed.lock().unwrap().state.quiescence.coverage = QuiescenceCoverage::Unknown;
    let error = host.switch_account_desktop(&switch_input()).unwrap_err();
    assert_eq!(
        issue_of(&error),
        Some(DesktopAutomationIssue::DesktopObservationIncomplete)
    );
    assert!(world.calls().is_empty());
}

#[test]
fn native_host_requires_its_explicit_guarded_local_observation_contract() {
    for coverage in [
        QuiescenceCoverage::VerifiedAll,
        QuiescenceCoverage::IsolatedAll,
    ] {
        let (host, world) = fixture();
        world.observed.lock().unwrap().state.quiescence.coverage = coverage;
        let error = host.switch_account_desktop(&switch_input()).unwrap_err();
        assert_eq!(
            issue_of(&error),
            Some(DesktopAutomationIssue::DesktopObservationIncomplete)
        );
        assert!(world.calls().is_empty());
    }
}

#[test]
fn any_live_sibling_pending_task_queue_wakeup_or_unknown_blocks_mutation() {
    for key in 0..7 {
        let (host, world) = fixture();
        {
            let q = &mut world.observed.lock().unwrap().state.quiescence;
            *[
                &mut q.busy_workers,
                &mut q.subagents,
                &mut q.pending_tasks,
                &mut q.waiting,
                &mut q.queued_prompts,
                &mut q.scheduled_wakeups,
                &mut q.unknown_work,
            ][key] = 1.0;
        }
        let error = host.switch_account_desktop(&switch_input()).unwrap_err();
        assert_eq!(
            issue_of(&error),
            Some(DesktopAutomationIssue::DesktopWorkActive)
        );
        assert!(world.calls().is_empty());
    }
}

#[test]
fn changed_generation_or_active_ui_turn_blocks_checkpoint() {
    let (host, world) = fixture();
    world.ui.lock().unwrap().status = SessionStatus::Running;
    let input = |revision: f64| ContinuationCheckpointInput {
        request_id: "request".into(),
        session: session(&world),
        expected_context_revision: revision,
    };
    let error = host.checkpoint_desktop(&input(1.0)).unwrap_err();
    assert_eq!(
        issue_of(&error),
        Some(DesktopAutomationIssue::DesktopWorkActive)
    );
    world.ui.lock().unwrap().status = SessionStatus::Stopped;
    let error = host.checkpoint_desktop(&input(2.0)).unwrap_err();
    assert_eq!(
        issue_of(&error),
        Some(DesktopAutomationIssue::ContextChanged)
    );
    assert!(world.calls().is_empty());
}

#[test]
fn a_desktop_title_alias_mismatch_cannot_checkpoint_the_same_uuid() {
    let (host, world) = fixture();
    world.ui.lock().unwrap().local_session_id =
        Some("local_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee".into());
    let error = host
        .checkpoint_desktop(&ContinuationCheckpointInput {
            request_id: "request".into(),
            session: session(&world),
            expected_context_revision: 1.0,
        })
        .unwrap_err();
    assert_eq!(
        issue_of(&error),
        Some(DesktopAutomationIssue::ExactSessionNotObserved)
    );
    assert!(world.calls().is_empty());
}

fn reopen_input(world: &World) -> ContinuationReopenInput {
    ContinuationReopenInput {
        request_id: "request".into(),
        checkpoint: ContinuationCheckpoint {
            id: "checkpoint".into(),
            session: session(world),
        },
        target: target(),
        expected_context_revision: 1.0,
    }
}

#[test]
fn reopen_restores_and_verifies_the_captured_permission_mode() {
    let (host, world) = fixture();
    let input = reopen_input(&world);
    {
        let mut observed = world.observed.lock().unwrap();
        observed.state.identity = target();
        observed.state.session.permission_mode = "Manual".into();
    }
    world.ui.lock().unwrap().permission_mode = Some("Manual".into());
    host.reopen_session_desktop(&input).unwrap();
    assert_eq!(
        world.calls(),
        vec![format!("open:{}", local_id()), "mode:Auto".into()]
    );
}

#[test]
fn reopen_does_not_change_permissions_while_another_task_is_present() {
    let (host, world) = fixture();
    let input = reopen_input(&world);
    {
        let mut observed = world.observed.lock().unwrap();
        observed.state.identity = target();
        observed.state.session.permission_mode = "Manual".into();
        observed.state.quiescence.subagents = 1.0;
    }
    world.ui.lock().unwrap().permission_mode = Some("Manual".into());
    let error = host.reopen_session_desktop(&input).unwrap_err();
    assert_eq!(
        issue_of(&error),
        Some(DesktopAutomationIssue::DesktopWorkActive)
    );
    assert!(world.calls().is_empty());
}

fn send_input(world: &World) -> ContinuationSendInput {
    ContinuationSendInput {
        request_id: "request".into(),
        target: source(),
        session: session(world),
        expected_context_revision: 1.0,
        text: "Continue".into(),
    }
}

fn unknown() -> ContinuationDelivery {
    ContinuationDelivery {
        status: DeliveryStatus::Unknown,
        receipt: None,
    }
}

#[test]
fn a_visible_ui_acceptance_is_not_fabricated_into_a_durable_receipt() {
    let (host, world) = fixture();
    let result = host.send_continuation_desktop(&send_input(&world)).unwrap();
    assert_eq!(result, unknown());
    assert_eq!(world.calls(), vec!["send:request".to_owned()]);
}

#[test]
fn existing_ambiguous_delivery_is_never_sent_a_second_time() {
    let (host, world) = fixture();
    *world.delivery.lock().unwrap() = unknown();
    assert_eq!(
        host.send_continuation_desktop(&send_input(&world)).unwrap(),
        unknown()
    );
    assert!(world.calls().is_empty());
}

#[test]
fn new_user_text_or_permission_change_prevents_send() {
    let (host, world) = fixture();
    world.ui.lock().unwrap().composer_empty = false;
    let input = send_input(&world);
    let error = host.send_continuation_desktop(&input).unwrap_err();
    assert_eq!(
        issue_of(&error),
        Some(DesktopAutomationIssue::ComposerNotEmpty)
    );
    {
        let mut ui = world.ui.lock().unwrap();
        ui.composer_empty = true;
        ui.permission_mode = Some("Manual".into());
    }
    let error = host.send_continuation_desktop(&input).unwrap_err();
    assert_eq!(
        issue_of(&error),
        Some(DesktopAutomationIssue::PermissionModeMismatch)
    );
    assert!(world.calls().is_empty());
}

#[test]
fn native_reply_validation_hides_arbitrary_helper_output_and_requires_selected_scope_metadata() {
    let adapter = reply_snapshot(json!({ "coverage": "guarded-local" }));
    assert_eq!(
        adapter.inspect().unwrap_err().issue(),
        Some(DesktopAutomationIssue::DesktopUiUnsupported)
    );
    let error_adapter = answering(json!({ "ok": false, "issue": "credential secret" }));
    assert_eq!(
        error_adapter.inspect().unwrap_err().issue(),
        Some(DesktopAutomationIssue::DesktopUiUnsupported)
    );
}

#[test]
fn a_snapshot_s_composer_present_is_optional_and_a_boolean_when_given() {
    let reply = |extra| reply_snapshot(extra);
    assert_eq!(
        reply(json!({ "composerPresent": true }))
            .inspect()
            .unwrap()
            .composer_present,
        Some(true)
    );
    assert_eq!(
        reply(json!({ "composerPresent": false }))
            .inspect()
            .unwrap()
            .composer_present,
        Some(false)
    );
    // An older helper does not report it.
    assert_eq!(reply(json!({})).inspect().unwrap().composer_present, None);
    assert_eq!(
        reply(json!({ "composerPresent": "yes" }))
            .inspect()
            .unwrap_err()
            .issue(),
        Some(DesktopAutomationIssue::DesktopUiUnsupported)
    );
}

#[test]
fn a_snapshot_keeps_frontmost_and_idle_ms_which_are_optional_and_well_formed_when_given() {
    let reply = |extra| reply_snapshot(extra);
    let kept = reply(json!({ "frontmost": true, "idleMs": 4_250 }))
        .inspect()
        .unwrap();
    assert_eq!(kept.frontmost, Some(true));
    assert_eq!(kept.idle_ms, Some(4_250));
    let behind = reply(json!({ "frontmost": false, "idleMs": 0 }))
        .inspect()
        .unwrap();
    assert_eq!(behind.frontmost, Some(false));
    assert_eq!(behind.idle_ms, Some(0));
    // An older helper reports neither.
    let older = reply(json!({})).inspect().unwrap();
    assert_eq!(older.frontmost, None);
    assert_eq!(older.idle_ms, None);
    for bad in [
        json!({ "frontmost": "yes" }),
        json!({ "frontmost": 1 }),
        json!({ "idleMs": -1 }),
        json!({ "idleMs": 1.5 }),
        json!({ "idleMs": "60000" }),
        // JSON has no Infinity: the nearest is a number past every safe integer.
        json!({ "idleMs": 1e300 }),
    ] {
        assert_eq!(
            reply(bad.clone()).inspect().unwrap_err().issue(),
            Some(DesktopAutomationIssue::DesktopUiUnsupported),
            "{bad}"
        );
    }
    // writeDraft's snapshot is read the same way.
    let written = reply(json!({ "frontmost": true, "idleMs": 9_000 }))
        .write_draft(&draft_guard(), "draft", None)
        .unwrap();
    assert_eq!(written.frontmost, Some(true));
    assert_eq!(written.idle_ms, Some(9_000));
}

#[test]
fn a_snapshot_keeps_key_idle_ms_which_is_optional_and_a_whole_number_of_ms_when_given() {
    let reply = |extra| reply_snapshot(extra);
    assert_eq!(
        reply(json!({ "keyIdleMs": 1_250 }))
            .inspect()
            .unwrap()
            .key_idle_ms,
        Some(1_250)
    );
    assert_eq!(
        reply(json!({ "keyIdleMs": 0 }))
            .inspect()
            .unwrap()
            .key_idle_ms,
        Some(0)
    );
    assert_eq!(reply(json!({})).inspect().unwrap().key_idle_ms, None);
    for bad in [
        json!(-1),
        json!(1.5),
        json!("1000"),
        json!(1e300),
        json!(true),
    ] {
        assert_eq!(
            reply(json!({ "keyIdleMs": bad.clone() }))
                .inspect()
                .unwrap_err()
                .issue(),
            Some(DesktopAutomationIssue::DesktopUiUnsupported),
            "{bad}"
        );
    }
}

#[test]
fn only_an_exact_local_session_id_passes_is_local_session_id() {
    assert!(is_local_session_id(&local_id()));
    // The id is matched whatever the case of its hex digits.
    let upper = format!("local_{}", ID.to_uppercase());
    assert!(is_local_session_id(&upper));
    for bad in [
        ID.to_owned(),
        format!("local_{ID}x"),
        format!("local_../{ID}"),
        "local_".into(),
        String::new(),
    ] {
        assert!(!is_local_session_id(&bad), "{bad}");
    }
}

#[test]
fn native_transport_validates_exact_ids_and_never_uses_last_session_navigation() {
    let (executor, commands) = recording(json!({ "ok": true }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    assert_eq!(
        adapter.open_session("last", None).unwrap_err().issue(),
        Some(DesktopAutomationIssue::ExactSessionNotObserved)
    );
    adapter.open_session(&local_id(), None).unwrap();
    assert_eq!(
        *commands.lock().unwrap(),
        vec![json!({ "command": "open-session", "localSessionId": local_id() })]
    );
    assert_eq!(
        adapter
            .send(&guard_for_send(), "request", "a\0b")
            .unwrap_err()
            .issue(),
        Some(DesktopAutomationIssue::DesktopUiUnsupported)
    );
    assert_eq!(commands.lock().unwrap().len(), 1);
}

#[test]
fn send_passes_on_how_the_text_went_in_the_screen_after_send_and_the_step_a_failure_came_from() {
    let guard = guard_for_send();
    let after = json!({
        "status": "stopped",
        "composerPresent": true,
        "composerEmpty": false,
        "composerHoldsText": true,
        "composerChars": 47,
        "markerVisible": false,
        "sendPresent": true,
    });
    let mut with_wait = after.clone();
    with_wait["waitedMs"] = json!(600);
    let sent = answering(json!({
        "ok": true,
        "acceptedVisible": false,
        "written": "paste",
        "submitted": "return",
        "after": with_wait,
    }));
    assert_eq!(
        serde_json::to_value(sent.send(&guard, "request", "Try again").unwrap()).unwrap(),
        json!({
            "acceptedVisible": false,
            "written": "paste",
            "submitted": "return",
            "after": with_wait,
        })
    );
    // An older helper, or one with a malformed report, still sends: only the extras drop.
    let mut malformed = after.clone();
    malformed["status"] = json!(3);
    let older = answering(json!({
        "ok": true,
        "acceptedVisible": true,
        "written": "typed",
        "after": malformed,
    }));
    assert_eq!(
        serde_json::to_value(older.send(&guard, "request", "Try again").unwrap()).unwrap(),
        json!({ "acceptedVisible": true })
    );
    let failed = |step: Value| {
        answering(json!({ "ok": false, "issue": "desktop-ui-unsupported", "step": step }))
            .send(&guard, "request", "Try again")
            .unwrap_err()
    };
    let error = failed(json!("press"));
    let automation = error.automation().expect("a DesktopAutomationError");
    assert_eq!(
        automation.issue,
        DesktopAutomationIssue::DesktopUiUnsupported
    );
    assert_eq!(automation.step, Some(DesktopAutomationStep::Press));
    let error = failed(json!("secret text"));
    assert_eq!(
        error.automation().expect("a DesktopAutomationError").step,
        None
    );
}

#[cfg(unix)]
#[test]
fn a_helper_that_times_out_exits_or_prints_no_json_says_which() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let script = |name: &str, body: &str| {
        let file = directory.path().join(name);
        std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        file
    };
    let step = |helper| match native_desktop_automation(helper, None, None).inspect() {
        Err(error) => match error.automation() {
            Some(automation) => format!("{:?}", automation.step.map(|s| s.as_str())),
            None => "other".into(),
        },
        Ok(_) => "resolved".into(),
    };
    assert_eq!(step(script("exit.sh", "exit 3")), "Some(\"helper-exit\")");
    assert_eq!(
        step(script("text.sh", "echo not-json")),
        "Some(\"helper-output\")"
    );
}

#[test]
fn open_session_asks_the_helper_to_check_the_user_only_when_asked() {
    let (executor, commands) = recording(json!({ "ok": true }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    adapter.open_session(&local_id(), None).unwrap();
    adapter
        .open_session(&local_id(), require_idle(Some(true)))
        .unwrap();
    adapter
        .open_session(&local_id(), require_idle(Some(false)))
        .unwrap();
    adapter
        .open_session(&local_id(), require_idle(None))
        .unwrap();
    assert_eq!(
        *commands.lock().unwrap(),
        vec![
            json!({ "command": "open-session", "localSessionId": local_id() }),
            json!({ "command": "open-session", "localSessionId": local_id(), "requireIdle": true }),
            json!({ "command": "open-session", "localSessionId": local_id() }),
            json!({ "command": "open-session", "localSessionId": local_id() }),
        ]
    );
    // The helper's refusal comes through as itself.
    let refused = answering(json!({ "ok": false, "issue": "user-active" }));
    assert_eq!(
        refused
            .open_session(&local_id(), require_idle(Some(true)))
            .unwrap_err()
            .issue(),
        Some(DesktopAutomationIssue::UserActive)
    );
}

#[test]
fn write_draft_sends_the_write_draft_command_with_the_guard_and_text() {
    let written = snapshot_with(json!({ "composerEmpty": false }));
    let (executor, commands) = recording(json!({ "ok": true, "snapshot": written }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    let result = adapter
        .write_draft(&draft_guard(), "Merhaba\nDünya", None)
        .unwrap();
    assert_eq!(
        *commands.lock().unwrap(),
        vec![
            json!({ "command": "write-draft", "guard": draft_guard_json(), "text": "Merhaba\nDünya" })
        ]
    );
    assert_eq!(serde_json::to_value(result).unwrap(), written);
    // The 16 384 character limit is inclusive.
    adapter
        .write_draft(&draft_guard(), &"a".repeat(16_384), None)
        .unwrap();
    assert_eq!(commands.lock().unwrap().len(), 2);
}

#[test]
fn write_draft_passes_keys_idle_ms_only_when_given_and_refuses_one_out_of_500_to_3000_without_calling_the_helper()
 {
    let (executor, commands) = recording(json!({ "ok": true, "snapshot": snapshot_json() }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    adapter
        .write_draft(&draft_guard(), "draft", keys(1_000.0))
        .unwrap();
    adapter
        .write_draft(&draft_guard(), "draft", Some(WriteDraftOptions::default()))
        .unwrap();
    adapter
        .write_draft(&draft_guard(), "draft", keys(500.0))
        .unwrap();
    adapter
        .write_draft(&draft_guard(), "draft", keys(3_000.0))
        .unwrap();
    let request = |keys: Option<i64>| {
        let mut value =
            json!({ "command": "write-draft", "guard": draft_guard_json(), "text": "draft" });
        if let Some(keys) = keys {
            value["keysIdleMs"] = json!(keys);
        }
        value
    };
    assert_eq!(
        *commands.lock().unwrap(),
        vec![
            request(Some(1_000)),
            request(None),
            request(Some(500)),
            request(Some(3_000)),
        ]
    );
    for keys_idle_ms in [499.0, 3_001.0, 1.5, f64::NAN, -1.0] {
        assert_eq!(
            adapter
                .write_draft(&draft_guard(), "draft", keys(keys_idle_ms))
                .unwrap_err()
                .issue(),
            Some(DesktopAutomationIssue::DesktopUiUnsupported),
            "{keys_idle_ms}"
        );
    }
    assert_eq!(commands.lock().unwrap().len(), 4);
}

#[test]
fn write_draft_refuses_empty_nul_and_over_long_text_without_calling_the_helper() {
    let (executor, commands) = recording(json!({ "ok": true, "snapshot": snapshot_json() }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    for text in [String::new(), "a\0b".into(), "a".repeat(16_385)] {
        assert_eq!(
            adapter
                .write_draft(&draft_guard(), &text, None)
                .unwrap_err()
                .issue(),
            Some(DesktopAutomationIssue::DesktopUiUnsupported)
        );
    }
    assert!(commands.lock().unwrap().is_empty());
}

#[test]
fn write_draft_maps_composer_not_empty_and_context_changed() {
    for issue in [
        DesktopAutomationIssue::ComposerNotEmpty,
        DesktopAutomationIssue::ContextChanged,
        DesktopAutomationIssue::DeliveryAmbiguous,
        DesktopAutomationIssue::AccessibilityPermissionRequired,
        // The helper refused before typing: the user is active or Claude is not in front.
        DesktopAutomationIssue::UserActive,
    ] {
        let adapter = answering(json!({ "ok": false, "issue": issue.as_str() }));
        assert_eq!(
            adapter
                .write_draft(&draft_guard(), "draft", None)
                .unwrap_err()
                .issue(),
            Some(issue)
        );
    }
    let unknown = answering(json!({ "ok": false, "issue": "draft text echoed back" }));
    assert_eq!(
        unknown
            .write_draft(&draft_guard(), "draft", None)
            .unwrap_err()
            .issue(),
        Some(DesktopAutomationIssue::DesktopUiUnsupported)
    );
    // A reply without a valid snapshot cannot prove what is in the composer.
    let no_snapshot = answering(json!({ "ok": true }));
    assert_eq!(
        no_snapshot
            .write_draft(&draft_guard(), "draft", None)
            .unwrap_err()
            .issue(),
        Some(DesktopAutomationIssue::DesktopUiUnsupported)
    );
}

#[test]
fn a_snapshot_s_new_session_is_optional_a_boolean_and_never_comes_with_a_conversation_id() {
    let reply = |extra| reply_snapshot(extra);
    assert_eq!(
        reply(json!({ "localSessionId": null, "newSession": true }))
            .inspect()
            .unwrap()
            .new_session,
        Some(true)
    );
    assert_eq!(
        reply(json!({ "newSession": false }))
            .inspect()
            .unwrap()
            .new_session,
        Some(false)
    );
    // An older helper does not report it.
    assert_eq!(reply(json!({})).inspect().unwrap().new_session, None);
    for bad in [
        json!({ "newSession": "yes" }),
        json!({ "newSession": 1 }),
        // A conversation is not the new-session screen.
        json!({ "newSession": true }),
    ] {
        assert_eq!(
            reply(bad.clone()).inspect().unwrap_err().issue(),
            Some(DesktopAutomationIssue::DesktopUiUnsupported),
            "{bad}"
        );
    }
}

/// `newSessionView(over)`: the new-session screen; a `null` in `over` drops the key.
fn new_session_view(over: Value) -> DesktopAutomationSnapshot {
    let mut view = snapshot_with(json!({ "localSessionId": null, "newSession": true }));
    let object: &mut Map<String, Value> = view.as_object_mut().unwrap();
    for (key, value) in over.as_object().unwrap() {
        if value.is_null() {
            object.remove(key);
        } else {
            object.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(view).unwrap()
}

#[test]
fn new_session_guard_names_the_new_session_screen_with_its_mode_only_when_one_was_read() {
    assert_eq!(
        serde_json::to_value(new_session_guard(&new_session_view(json!({}))).unwrap()).unwrap(),
        json!({
            "pid": 456,
            "newSession": true,
            "accountLabel": "Test User Company",
            "permissionMode": "Auto",
            "contextFingerprint": "a".repeat(64),
        })
    );
    let modeless = new_session_guard(&new_session_view(json!({ "permissionMode": null }))).unwrap();
    assert!(
        !serde_json::to_value(modeless)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("permissionMode")
    );
    // A conversation, or a screen that is neither, is not the new-session screen.
    let mut no_id = snapshot();
    no_id.local_session_id = None;
    for view in [
        snapshot(),
        no_id,
        new_session_view(json!({ "newSession": false })),
        new_session_view(json!({ "localSessionId": local_id() })),
    ] {
        assert_eq!(
            new_session_guard(&view).unwrap_err().issue,
            DesktopAutomationIssue::ExactSessionNotObserved
        );
    }
    // Without its account the screen cannot be told apart from another account's.
    assert_eq!(
        new_session_guard(&new_session_view(json!({ "accountLabel": null })))
            .unwrap_err()
            .issue,
        DesktopAutomationIssue::DesktopUiUnsupported
    );
}

#[test]
fn open_new_session_sends_open_new_session_asking_the_helper_to_check_the_user_only_when_asked() {
    let (executor, commands) = recording(json!({ "ok": true }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    adapter.open_new_session(None).unwrap();
    adapter.open_new_session(require_idle(Some(true))).unwrap();
    adapter.open_new_session(require_idle(Some(false))).unwrap();
    assert_eq!(
        *commands.lock().unwrap(),
        vec![
            json!({ "command": "open-new-session" }),
            json!({ "command": "open-new-session", "requireIdle": true }),
            json!({ "command": "open-new-session" }),
        ]
    );
    let refused = answering(json!({ "ok": false, "issue": "user-active" }));
    assert_eq!(
        refused
            .open_new_session(require_idle(Some(true)))
            .unwrap_err()
            .issue(),
        Some(DesktopAutomationIssue::UserActive)
    );
}

#[test]
fn write_draft_passes_a_new_session_guard_to_the_helper_as_it_is() {
    let reply = serde_json::to_value(new_session_view(json!({ "composerEmpty": false }))).unwrap();
    let (executor, commands) = recording(json!({ "ok": true, "snapshot": reply }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    let guard = DesktopDraftGuard::NewSession(
        new_session_guard(&new_session_view(json!({ "permissionMode": null }))).unwrap(),
    );
    let result = adapter.write_draft(&guard, "draft", None).unwrap();
    assert_eq!(
        *commands.lock().unwrap(),
        vec![
            json!({ "command": "write-draft", "guard": serde_json::to_value(&guard).unwrap(), "text": "draft" })
        ]
    );
    assert_eq!(result.new_session, Some(true));
}

#[test]
fn write_draft_never_sends_the_request_has_no_request_id() {
    let (executor, commands) = recording(json!({ "ok": true, "snapshot": snapshot_json() }));
    let adapter = native_desktop_automation("/unused", Some(executor), None);
    adapter.write_draft(&draft_guard(), "draft", None).unwrap();
    let commands = commands.lock().unwrap();
    assert_eq!(commands.len(), 1);
    let mut keys: Vec<&String> = commands[0].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["command", "guard", "text"]);
    assert_eq!(commands[0]["command"], "write-draft");
    assert!(commands[0].get("requestId").is_none());
}

#[test]
fn while_separate_windows_run_the_helper_is_told_the_main_claude_s_pid_and_sends_no_claude_link() {
    let (executor, requests) = recording(json!({
        "ok": true,
        "snapshot": snapshot_json(),
        "pressed": false,
        "accessibilityGranted": true,
    }));
    let pick = Arc::new(Mutex::new(DesktopTargetPid::Pid(4242)));
    let current = Arc::clone(&pick);
    let adapter = native_desktop_automation(
        "/unused",
        Some(executor),
        Some(Box::new(move || Ok(*current.lock().unwrap()))),
    );
    let last_pid = || requests.lock().unwrap().last().unwrap().get("pid").cloned();
    adapter.inspect().unwrap();
    assert_eq!(last_pid(), Some(json!(4242)));
    adapter.answer_quit_guard().unwrap();
    assert_eq!(last_pid(), Some(json!(4242)));
    // A link would reach whichever Claude macOS picks.
    let before = requests.lock().unwrap().len();
    assert_eq!(
        adapter.open_new_session(None).unwrap_err().issue(),
        Some(DesktopAutomationIssue::DesktopUiUnsupported)
    );
    assert_eq!(requests.lock().unwrap().len(), before);
    // Asking for the permission names no Claude.
    adapter.request_accessibility().unwrap();
    assert_eq!(last_pid(), None);
    // Windows run but the main Claude does not: never the window.
    *pick.lock().unwrap() = DesktopTargetPid::MainNotRunning;
    assert_eq!(
        adapter.inspect().unwrap_err().issue(),
        Some(DesktopAutomationIssue::ClaudeNotRunning)
    );
    assert_eq!(requests.lock().unwrap().len(), before + 1);
    // No window: as before.
    *pick.lock().unwrap() = DesktopTargetPid::Any;
    adapter.inspect().unwrap();
    assert_eq!(last_pid(), None);
}
