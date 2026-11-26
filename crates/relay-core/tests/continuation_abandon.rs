//! Port of `tests/continuation-abandon.test.ts`.

#[path = "common/continuation.rs"]
mod helpers;

use helpers::{now, uuid};
use relay_core::continuation::{
    AbandonStatus, CONTINUATION_TEXT, ContinuationCapabilities, ContinuationCheckpoint,
    ContinuationCheckpointInput, ContinuationDelivery, ContinuationEngine, ContinuationError,
    ContinuationHost, ContinuationJournal, ContinuationJournalRecord, ContinuationReopenInput,
    ContinuationSendInput, ContinuationSession, ContinuationStage, ContinuationState,
    ContinuationSwitchInput, SessionStatus, is_terminal_continuation_record,
};
use relay_core::continuation_journal::FileContinuationJournal;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Cancelling a proven unsent intent must not depend on current account access, transcript
/// availability, changed permissions, or a quota that has reset: every host call fails the test.
struct UnavailableHost;

impl ContinuationHost for UnavailableHost {
    fn capabilities(&self) -> ContinuationCapabilities {
        panic!("host capabilities read")
    }
    fn read_state(&self) -> Result<ContinuationState, ContinuationError> {
        panic!("host read")
    }
    fn checkpoint(
        &self,
        _: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, ContinuationError> {
        panic!("host checkpoint")
    }
    fn switch_account(&self, _: &ContinuationSwitchInput) -> Result<(), ContinuationError> {
        panic!("host switch")
    }
    fn reopen_session(&self, _: &ContinuationReopenInput) -> Result<(), ContinuationError> {
        panic!("host reopen")
    }
    fn send_continuation(
        &self,
        _: &ContinuationSendInput,
    ) -> Result<ContinuationDelivery, ContinuationError> {
        panic!("host send")
    }
    fn lookup_delivery(&self, _: &str) -> Result<ContinuationDelivery, ContinuationError> {
        panic!("host lookup")
    }
}

fn intent(stage: ContinuationStage) -> ContinuationJournalRecord {
    let (id, session_id) = (uuid(), uuid());
    let identity = || json!({ "profileId": uuid(), "accountUuid": uuid(), "orgId": uuid() });
    let bound_request = json!({
        "id": id,
        "source": identity(),
        "target": identity(),
        "sessionId": session_id,
        "projectKey": "synthetic-project",
        "transcriptRevision": "before",
        "permissionMode": "Auto",
        "expectedContextRevision": 7,
        "executionPolicy": "guarded-native-at-most-once",
        "continuationText": CONTINUATION_TEXT,
    })
    .to_string();
    let fingerprint: String = Sha256::digest(bound_request.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    ContinuationJournalRecord {
        version: 1,
        id: id.clone(),
        fingerprint,
        bound_request,
        stage,
        updated_at: now(),
        send_recorded: false,
        checkpoint: (stage != ContinuationStage::Prepared).then(|| ContinuationCheckpoint {
            id,
            session: ContinuationSession {
                id: session_id,
                project_key: "synthetic-project".into(),
                transcript_revision: "before".into(),
                permission_mode: "Auto".into(),
                status: SessionStatus::Stopped,
                last_request_id: None,
                last_turn_id: None,
            },
        }),
        reason: None,
        receipt: None,
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    journal: std::sync::Arc<FileContinuationJournal>,
    engine: ContinuationEngine<UnavailableHost, std::sync::Arc<FileContinuationJournal>>,
}

fn fixture() -> Fixture {
    let directory = tempfile::Builder::new()
        .prefix("relay-abandon-test-")
        .tempdir()
        .unwrap();
    let journal =
        std::sync::Arc::new(FileContinuationJournal::with_clock(directory.path(), now).unwrap());
    let engine =
        ContinuationEngine::with_clock(UnavailableHost, std::sync::Arc::clone(&journal), now);
    Fixture {
        _directory: directory,
        journal,
        engine,
    }
}

fn value(record: &ContinuationJournalRecord) -> Value {
    serde_json::to_value(record).unwrap()
}

#[test]
fn proven_unsent_handoffs_may_be_durably_abandoned_even_when_the_previous_account_or_transcript_is_inaccessible()
 {
    use ContinuationStage::*;
    for stage in [
        Prepared,
        Checkpointed,
        SwitchIntent,
        AccountVerified,
        OpenIntent,
        SessionVerified,
        ReconciliationRequired,
    ] {
        let f = fixture();
        let original = intent(stage);
        f.journal.write(&original).unwrap();
        let abandoned = f.engine.abandon_unsent(&original.id).unwrap();
        assert_eq!(abandoned.status, AbandonStatus::Abandoned);
        let terminal = f.journal.read(&original.id).unwrap().unwrap();
        assert_eq!(terminal["reason"], "user-cancelled-unsent");
        assert_eq!(terminal["sendRecorded"], false);
        assert_eq!(terminal["fingerprint"], original.fingerprint.as_str());
        assert!(is_terminal_continuation_record(&terminal, Some(now())));
        assert!(f.journal.list_pending().unwrap().is_empty());
    }
}

#[test]
fn send_intent_accepted_confirmed_or_ambiguous_possible_submissions_cannot_be_abandoned() {
    use ContinuationStage::*;
    for stage in [
        SendIntent,
        DeliveryAccepted,
        DeliveryConfirmed,
        ReconciliationRequired,
    ] {
        let f = fixture();
        let mut original = intent(stage);
        original.send_recorded = true;
        f.journal.write(&original).unwrap();
        let error = f.engine.abandon_unsent(&original.id).unwrap_err();
        assert!(error.message().contains("cannot-cancel-possible-send"));
        assert_eq!(
            f.journal.read(&original.id).unwrap(),
            Some(value(&original))
        );
    }
}

#[test]
fn corrupt_bindings_impossible_stages_and_malformed_checkpoints_remain_untouched_barriers() {
    let changes: [fn(&mut ContinuationJournalRecord); 5] = [
        |r| r.fingerprint = "bad".into(),
        |r| r.bound_request = "{}".into(),
        |r| r.stage = ContinuationStage::SendIntent,
        |r| r.updated_at = now() + 1.0,
        |r| r.checkpoint.as_mut().unwrap().session.permission_mode = "changed".into(),
    ];
    for change in changes {
        let f = fixture();
        let mut original = intent(ContinuationStage::Checkpointed);
        change(&mut original);
        f.journal.write(&original).unwrap();
        let error = f.engine.abandon_unsent(&original.id).unwrap_err();
        assert!(error.message().contains("journal-record-invalid"));
        assert_eq!(
            f.journal.read(&original.id).unwrap(),
            Some(value(&original))
        );
    }
}

#[test]
fn absent_pre_intent_record_is_cancellable_only_while_no_other_unresolved_host_intent_exists() {
    let f = fixture();
    let absent_id = uuid();
    assert_eq!(
        f.engine.abandon_unsent(&absent_id).unwrap().status,
        AbandonStatus::Abandoned
    );
    f.journal
        .write(&intent(ContinuationStage::Checkpointed))
        .unwrap();
    let error = f.engine.abandon_unsent(&absent_id).unwrap_err();
    assert!(error.message().contains("unresolved-host-intent"));
    let error = f.engine.abandon_unsent("../invalid").unwrap_err();
    assert!(error.message().contains("invalid-request"));
}
