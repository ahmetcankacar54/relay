//! Port of `electron/core/continuation.ts`: stopped-session orchestration with durable
//! at-most-one submission.
//!
//! The host and the journal are blocking traits (relay-core has no async runtime). Journal
//! entries cross the trait as JSON values where the TS reads untyped data (a damaged or foreign
//! file must stay a barrier, never vanish in a typed parse), and as typed records on write.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::fs_util::safe_integer;
use crate::shared::continuation_target_ranking::switch_at_percent;
use crate::shared::history_policy::allowed_history_pair;
use crate::shared::quota_windows::quota_windows;
use crate::shared::types::js::{JsMap, date_parse, ser_num};
use crate::shared::types::{
    Account, AccountUsage, DesktopHistoryTransfer, RelaySettings, UsageStatus, UsageWindow,
    literal_enum,
};

/// An error a host, a journal or the engine reports; its text is the TS `Error.message`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ContinuationError(pub String);

impl ContinuationError {
    pub fn new(message: impl Into<String>) -> Self {
        ContinuationError(message.into())
    }
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl From<&str> for ContinuationError {
    fn from(message: &str) -> Self {
        ContinuationError(message.to_owned())
    }
}

impl From<String> for ContinuationError {
    fn from(message: String) -> Self {
        ContinuationError(message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationIdentity {
    pub profile_id: String,
    pub account_uuid: String,
    pub org_id: String,
}

literal_enum!(SessionStatus {
    Stopped = "stopped",
    Running = "running",
    Waiting = "waiting",
    Unknown = "unknown",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationSession {
    pub id: String,
    pub project_key: String,
    pub transcript_revision: String,
    pub permission_mode: String,
    pub status: SessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
}

literal_enum!(QuiescenceCoverage {
    IsolatedAll = "isolated-all",
    VerifiedAll = "verified-all",
    GuardedLocal = "guarded-local",
    Unknown = "unknown",
});

/// What else runs in the host besides the selected conversation (`ContinuationState.quiescence`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationQuiescence {
    pub coverage: QuiescenceCoverage,
    #[serde(serialize_with = "ser_num")]
    pub busy_workers: f64,
    #[serde(serialize_with = "ser_num")]
    pub subagents: f64,
    #[serde(serialize_with = "ser_num")]
    pub pending_tasks: f64,
    #[serde(serialize_with = "ser_num")]
    pub waiting: f64,
    #[serde(serialize_with = "ser_num")]
    pub queued_prompts: f64,
    #[serde(serialize_with = "ser_num")]
    pub scheduled_wakeups: f64,
    #[serde(serialize_with = "ser_num")]
    pub unknown_work: f64,
}

impl ContinuationQuiescence {
    /// Every work counter with its TS name, in the order the engine checks them.
    pub fn counters(&self) -> [(&'static str, f64); 7] {
        [
            ("busyWorkers", self.busy_workers),
            ("subagents", self.subagents),
            ("pendingTasks", self.pending_tasks),
            ("waiting", self.waiting),
            ("queuedPrompts", self.queued_prompts),
            ("scheduledWakeups", self.scheduled_wakeups),
            ("unknownWork", self.unknown_work),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationState {
    #[serde(serialize_with = "ser_num")]
    pub context_revision: f64,
    #[serde(serialize_with = "ser_num")]
    pub observed_at: f64,
    pub identity: ContinuationIdentity,
    pub session: ContinuationSession,
    pub quiescence: ContinuationQuiescence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationCheckpoint {
    pub id: String,
    pub session: ContinuationSession,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationReceipt {
    pub request_id: String,
    pub identity: ContinuationIdentity,
    pub session_id: String,
    pub project_key: String,
    pub permission_mode: String,
    pub before_revision: String,
    pub after_revision: String,
    pub turn_id: String,
}

literal_enum!(DeliveryStatus {
    Absent = "absent",
    Unknown = "unknown",
    Accepted = "accepted",
    Started = "started",
    Rejected = "rejected",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationDelivery {
    pub status: DeliveryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<ContinuationReceipt>,
}

literal_enum!(ContinuationHostKind {
    Simulated = "simulated",
    VerifiedContract = "verified-contract",
    GuardedNative = "guarded-native",
});

/// `ContinuationHost["capabilities"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationCapabilities {
    pub kind: ContinuationHostKind,
    pub contract_id: String,
    pub exact_session: bool,
    pub conditional_actions: bool,
    pub idempotent_delivery: bool,
    pub delivery_lookup: bool,
    pub checkpoint: bool,
    pub account_switch: bool,
    pub session_reopen: bool,
    pub targeted_send: bool,
    pub delivery_receipt: bool,
    pub atomic_context_guard: bool,
}

/// The argument of [`ContinuationHost::checkpoint`].
#[derive(Debug, Clone, PartialEq)]
pub struct ContinuationCheckpointInput {
    pub request_id: String,
    pub session: ContinuationSession,
    pub expected_context_revision: f64,
}

/// The argument of [`ContinuationHost::switch_account`].
#[derive(Debug, Clone, PartialEq)]
pub struct ContinuationSwitchInput {
    pub request_id: String,
    pub target: ContinuationIdentity,
    pub expected_context_revision: f64,
}

/// The argument of [`ContinuationHost::reopen_session`].
#[derive(Debug, Clone, PartialEq)]
pub struct ContinuationReopenInput {
    pub request_id: String,
    pub checkpoint: ContinuationCheckpoint,
    pub target: ContinuationIdentity,
    pub expected_context_revision: f64,
}

/// The argument of [`ContinuationHost::send_continuation`].
#[derive(Debug, Clone, PartialEq)]
pub struct ContinuationSendInput {
    pub request_id: String,
    pub target: ContinuationIdentity,
    pub session: ContinuationSession,
    pub expected_context_revision: f64,
    pub text: String,
}

/// The transport that observes and drives the Claude host.
pub trait ContinuationHost {
    fn capabilities(&self) -> ContinuationCapabilities;
    fn read_state(&self) -> Result<ContinuationState, ContinuationError>;
    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, ContinuationError>;
    fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), ContinuationError>;
    fn reopen_session(&self, input: &ContinuationReopenInput) -> Result<(), ContinuationError>;
    fn send_continuation(
        &self,
        input: &ContinuationSendInput,
    ) -> Result<ContinuationDelivery, ContinuationError>;
    fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, ContinuationError>;
}

macro_rules! forward_host {
    ($($ty:ty),+) => {$(
        impl<T: ContinuationHost + ?Sized> ContinuationHost for $ty {
            fn capabilities(&self) -> ContinuationCapabilities {
                (**self).capabilities()
            }
            fn read_state(&self) -> Result<ContinuationState, ContinuationError> {
                (**self).read_state()
            }
            fn checkpoint(
                &self,
                input: &ContinuationCheckpointInput,
            ) -> Result<ContinuationCheckpoint, ContinuationError> {
                (**self).checkpoint(input)
            }
            fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), ContinuationError> {
                (**self).switch_account(input)
            }
            fn reopen_session(&self, input: &ContinuationReopenInput) -> Result<(), ContinuationError> {
                (**self).reopen_session(input)
            }
            fn send_continuation(
                &self,
                input: &ContinuationSendInput,
            ) -> Result<ContinuationDelivery, ContinuationError> {
                (**self).send_continuation(input)
            }
            fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, ContinuationError> {
                (**self).lookup_delivery(request_id)
            }
        }
    )+};
}
forward_host!(&T, Box<T>, Arc<T>);

literal_enum!(
    /// Explicit opt-in to an OS UI transport without an atomic receiver contract.
    ExecutionPolicy { GuardedNativeAtMostOnce = "guarded-native-at-most-once" }
);

#[derive(Debug, Clone, PartialEq)]
pub struct ContinuationRequest {
    pub id: String,
    pub source: Account,
    pub target: Account,
    pub settings: RelaySettings,
    pub usage: JsMap<AccountUsage>,
    pub session_id: String,
    pub project_key: String,
    pub transcript_revision: String,
    pub permission_mode: String,
    pub expected_context_revision: f64,
    pub authorized: bool,
    pub execution_policy: Option<ExecutionPolicy>,
}

literal_enum!(ContinuationStage {
    Prepared = "prepared",
    Checkpointed = "checkpointed",
    SwitchIntent = "switch-intent",
    AccountVerified = "account-verified",
    OpenIntent = "open-intent",
    SessionVerified = "session-verified",
    SendIntent = "send-intent",
    DeliveryAccepted = "delivery-accepted",
    DeliveryConfirmed = "delivery-confirmed",
    ReconciliationRequired = "reconciliation-required",
    Blocked = "blocked",
});

impl ContinuationStage {
    /// Stages that hold a checkpoint and may not yet have recorded a send.
    fn before_send(self) -> bool {
        use ContinuationStage::*;
        matches!(
            self,
            Checkpointed | SwitchIntent | AccountVerified | OpenIntent | SessionVerified
        )
    }
}

/// One durable host intent. Key order is the order the engine's writes produce: a record starts
/// with `sendRecorded`, `checkpoint` is added next, then `reason` or `receipt`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationJournalRecord {
    /// Always 1.
    pub version: u8,
    pub id: String,
    pub fingerprint: String,
    /// Canonical opaque request metadata, used to validate other host intents.
    pub bound_request: String,
    pub stage: ContinuationStage,
    #[serde(serialize_with = "ser_num")]
    pub updated_at: f64,
    pub send_recorded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<ContinuationCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<ContinuationReceipt>,
}

/// Writes must be durable before returning; the lock covers this entire host.
pub trait ContinuationJournal {
    fn with_lock<T>(
        &self,
        request_id: &str,
        action: impl FnOnce() -> Result<T, ContinuationError>,
    ) -> Result<T, ContinuationError>;
    /// The stored entry as JSON, `None` when there is none.
    fn read(&self, request_id: &str) -> Result<Option<Value>, ContinuationError>;
    /// All unfinished host intents, including unreadable entries; never drop one.
    fn list_pending(&self) -> Result<Vec<Value>, ContinuationError>;
    fn write(&self, record: &ContinuationJournalRecord) -> Result<(), ContinuationError>;
}

macro_rules! forward_journal {
    ($($ty:ty),+) => {$(
        impl<J: ContinuationJournal + ?Sized> ContinuationJournal for $ty {
            fn with_lock<T>(
                &self,
                request_id: &str,
                action: impl FnOnce() -> Result<T, ContinuationError>,
            ) -> Result<T, ContinuationError> {
                (**self).with_lock(request_id, action)
            }
            fn read(&self, request_id: &str) -> Result<Option<Value>, ContinuationError> {
                (**self).read(request_id)
            }
            fn list_pending(&self) -> Result<Vec<Value>, ContinuationError> {
                (**self).list_pending()
            }
            fn write(&self, record: &ContinuationJournalRecord) -> Result<(), ContinuationError> {
                (**self).write(record)
            }
        }
    )+};
}
forward_journal!(&J, Box<J>, Arc<J>);

literal_enum!(ContinuationResultStatus {
    Blocked = "blocked",
    Continued = "continued",
    ReconciliationRequired = "reconciliation-required",
});
literal_enum!(
    /// It never transfers a still-running worker or its child processes.
    ContinuationKind { StoppedSessionNewTurn = "stopped-session-new-turn" }
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationResult {
    pub status: ContinuationResultStatus,
    pub continuation_kind: ContinuationKind,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<ContinuationJournalRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<ContinuationReceipt>,
}

literal_enum!(AbandonStatus { Abandoned = "abandoned" });

/// What [`ContinuationEngine::abandon_unsent`] resolves with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbandonUnsentResult {
    pub status: AbandonStatus,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<ContinuationJournalRecord>,
}

// A continuation is a new turn after a stopped checkpoint, not a transfer of
// running shells/subagents. It says what the user would type after a limit
// stop; the marker the send appends is what proves delivery.
pub const CONTINUATION_TEXT: &str = "Try again";
// Journal entries written by an older Relay bound this text: they stay valid,
// so a finished one never turns into a host-wide barrier.
const LEGACY_CONTINUATION_TEXT: &str = concat!(
    "Continue this same conversation from the saved checkpoint. First inspect ",
    "the existing transcript and verify whether interrupted actions already took ",
    "effect. Do not replay the last prompt or duplicate completed work. Preserve ",
    "the existing permission mode, ask for any outstanding user decision, and do ",
    "not claim that stopped subagents or shell processes are still running."
);

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
pub(crate) fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `/^[A-Za-z0-9._:-]{1,128}$/`.
pub(crate) fn is_key(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
}

/// Non-empty text of at most 4096 UTF-16 units without NUL.
pub(crate) fn is_text(s: &str) -> bool {
    !s.is_empty() && !s.contains('\0') && s.encode_utf16().count() <= 4096
}

/// `Number.isSafeInteger(n) && n >= 0`.
pub(crate) fn is_clock(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&n)
}

pub(crate) fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn identity(account: &Account) -> ContinuationIdentity {
    let desktop = account.desktop.as_ref();
    ContinuationIdentity {
        profile_id: account.id.clone(),
        account_uuid: desktop.map_or_else(String::new, |d| d.account_uuid.to_lowercase()),
        org_id: desktop.map_or_else(String::new, |d| d.org_id.to_lowercase()),
    }
}

/// `b` is an `identity()` result (already lowercase).
fn same_identity(a: &ContinuationIdentity, b: &ContinuationIdentity) -> bool {
    a.profile_id == b.profile_id
        && a.account_uuid.to_lowercase() == b.account_uuid
        && a.org_id.to_lowercase() == b.org_id
}

fn enrolled(account: &Account) -> bool {
    let (Some(desktop), Some(auth)) = (&account.desktop, &account.auth) else {
        return false;
    };
    is_key(&account.id)
        && is_uuid(&desktop.account_uuid)
        && is_uuid(&desktop.org_id)
        && auth.logged_in
        && auth
            .account_uuid
            .as_ref()
            .is_some_and(|u| u.to_lowercase() == desktop.account_uuid.to_lowercase())
        && auth
            .org_id
            .as_ref()
            .is_some_and(|o| o.to_lowercase() == desktop.org_id.to_lowercase())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Binding<'a> {
    id: &'a str,
    source: ContinuationIdentity,
    target: ContinuationIdentity,
    session_id: String,
    project_key: &'a str,
    transcript_revision: &'a str,
    permission_mode: &'a str,
    #[serde(serialize_with = "ser_num")]
    expected_context_revision: f64,
    continuation_text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_policy: Option<ExecutionPolicy>,
}

fn serialized_binding(request: &ContinuationRequest) -> String {
    serde_json::to_string(&Binding {
        id: &request.id,
        source: identity(&request.source),
        target: identity(&request.target),
        session_id: request.session_id.to_lowercase(),
        project_key: &request.project_key,
        transcript_revision: &request.transcript_revision,
        permission_mode: &request.permission_mode,
        expected_context_revision: request.expected_context_revision,
        continuation_text: CONTINUATION_TEXT,
        execution_policy: request.execution_policy,
    })
    .expect("a binding serializes")
}

fn binding(request: &ContinuationRequest) -> String {
    sha256_hex(&serialized_binding(request))
}

fn fresh_quota(usage: Option<&AccountUsage>, account_id: &str, now: f64) -> bool {
    let Some(usage) = usage else { return false };
    let at = date_parse(usage.checked_at.as_deref().unwrap_or(""));
    usage.account_id == account_id
        && usage.status == UsageStatus::Ready
        && !usage.stale
        && usage.issue.is_none()
        && at.is_finite()
        && at <= now
        && now - at <= 300_000.0
}

fn valid_window(window: Option<&UsageWindow>, now: f64) -> bool {
    let Some(w) = window else { return false };
    w.used_percent.is_finite()
        && w.used_percent >= 0.0
        && w.used_percent <= 100.0
        && ((w.used_percent == 0.0 && w.resets_at.is_none())
            || w.resets_at.as_deref().is_some_and(|at| {
                let at = date_parse(at);
                at.is_finite() && at > now
            }))
}

/// Why the account, history and quota policy refuses `request` now, `None` when it allows it.
/// `check_quota` is false once Claude has switched: the quota decision was already made.
pub fn continuation_policy_reason(
    request: &ContinuationRequest,
    now: f64,
    check_quota: bool,
) -> Option<&'static str> {
    if !request.authorized {
        return Some("not-authorized");
    }
    if !enrolled(&request.source) || !enrolled(&request.target) {
        return Some("identity-not-enrolled");
    }
    let settings = &request.settings;
    if !settings
        .desktop_history_accounts
        .iter()
        .all(|id| is_key(id))
    {
        return Some("invalid-history-policy");
    }
    if settings.desktop_history_transfer == DesktopHistoryTransfer::Off
        || !allowed_history_pair(&request.source, &request.target, settings)
    {
        return Some("history-boundary");
    }
    if !check_quota {
        return None;
    }
    let source = request.usage.get(&request.source.id);
    let target = request.usage.get(&request.target.id);
    if !fresh_quota(target, &request.target.id, now)
        || !quota_windows(target).is_some_and(|ws| ws.iter().all(|w| valid_window(Some(w), now)))
    {
        return Some("quota-not-fresh");
    }
    let source_windows = [
        source.and_then(|s| s.five_hour.as_ref()),
        source.and_then(|s| s.seven_day.as_ref()),
    ];
    if !fresh_quota(source, &request.source.id, now)
        || !source_windows.iter().any(Option::is_some)
        || source_windows
            .iter()
            .any(|w| w.is_some() && !valid_window(*w, now))
    {
        return Some("quota-not-fresh");
    }
    let source = source.expect("fresh quota exists");
    // A model-specific weekly limit (e.g. Opus) also stops the conversation.
    if source.other_limit_reached != Some(true)
        && !source_windows
            .iter()
            .any(|w| valid_window(*w, now) && w.is_some_and(|w| w.used_percent == 100.0))
    {
        return Some("source-quota-available");
    }
    let line = switch_at_percent(&request.target, 90.0);
    if quota_windows(target)
        .unwrap_or_default()
        .iter()
        .any(|w| w.used_percent >= line)
    {
        return Some("target-quota-unavailable");
    }
    if let Some(cooldown) = request
        .target
        .cooldown_until
        .as_deref()
        .filter(|c| !c.is_empty())
    {
        let at = date_parse(cooldown);
        if !at.is_finite() || at > now {
            return Some("target-cooldown");
        }
    }
    None
}

fn same_session(a: &ContinuationSession, b: &ContinuationSession) -> bool {
    a.id.to_lowercase() == b.id.to_lowercase()
        && a.project_key == b.project_key
        && a.transcript_revision == b.transcript_revision
        && a.permission_mode == b.permission_mode
}

fn request_session(request: &ContinuationRequest) -> ContinuationSession {
    ContinuationSession {
        id: request.session_id.to_lowercase(),
        project_key: request.project_key.clone(),
        transcript_revision: request.transcript_revision.clone(),
        permission_mode: request.permission_mode.clone(),
        status: SessionStatus::Stopped,
        last_request_id: None,
        last_turn_id: None,
    }
}

fn receipt_matches(request: &ContinuationRequest, receipt: Option<&ContinuationReceipt>) -> bool {
    let Some(receipt) = receipt else { return false };
    receipt.request_id == request.id
        && same_identity(&receipt.identity, &identity(&request.target))
        && receipt.session_id.to_lowercase() == request.session_id.to_lowercase()
        && receipt.project_key == request.project_key
        && receipt.permission_mode == request.permission_mode
        && receipt.before_revision == request.transcript_revision
        && is_text(&receipt.after_revision)
        && receipt.after_revision != receipt.before_revision
        && is_key(&receipt.turn_id)
}

fn valid_record(
    request: &ContinuationRequest,
    record: &ContinuationJournalRecord,
    now: f64,
) -> bool {
    use ContinuationStage::*;
    let stage = record.stage;
    if !is_clock(record.updated_at)
        || record.updated_at > now
        || record.bound_request != serialized_binding(request)
    {
        return false;
    }
    if let Some(checkpoint) = &record.checkpoint
        && (!is_text(&checkpoint.id)
            || !same_session(&checkpoint.session, &request_session(request))
            || checkpoint.session.status != SessionStatus::Stopped)
    {
        return false;
    }
    if record.receipt.is_some() && !receipt_matches(request, record.receipt.as_ref()) {
        return false;
    }
    if record.receipt.is_some()
        && (!record.send_recorded || !matches!(stage, DeliveryConfirmed | ReconciliationRequired))
    {
        return false;
    }
    if stage == Prepared && record.checkpoint.is_some() {
        return false;
    }
    if (stage.before_send() || matches!(stage, SendIntent | DeliveryAccepted | DeliveryConfirmed))
        && record.checkpoint.is_none()
    {
        return false;
    }
    if record.send_recorded && record.checkpoint.is_none() {
        return false;
    }
    if matches!(stage, SendIntent | DeliveryAccepted | DeliveryConfirmed) && !record.send_recorded {
        return false;
    }
    if (stage == Prepared || stage.before_send()) && record.send_recorded {
        return false;
    }
    if stage == DeliveryConfirmed && record.receipt.is_none() {
        return false;
    }
    if stage == Blocked && (record.send_recorded || record.receipt.is_some()) {
        return false;
    }
    true
}

// JavaScript value semantics for the untyped checks.

/// `!!value`.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a === b` for JSON values read from separate parses (objects never compare equal).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

fn str_at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?.get(key)?.as_str()
}

fn key_v(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(is_key)
}

fn uuid_v(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(is_uuid)
}

fn text_v(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(is_text)
}

fn clock_v(value: Option<&Value>) -> bool {
    value.and_then(safe_integer).is_some_and(|n| n >= 0)
}

/// `sameIdentity(a, b)` where `b` is a known, lowercase identity.
fn same_identity_v(a: Option<&Value>, b: &Value) -> bool {
    let (Some(account_uuid), Some(org_id)) = (str_at(a, "accountUuid"), str_at(a, "orgId")) else {
        return false;
    };
    strict_eq(a.and_then(|a| a.get("profileId")), b.get("profileId"))
        && Some(account_uuid.to_lowercase().as_str()) == str_at(Some(b), "accountUuid")
        && Some(org_id.to_lowercase().as_str()) == str_at(Some(b), "orgId")
}

/// A damaged terminal journal entry remains a host-wide unresolved barrier.
pub fn is_terminal_continuation_record(value: &Value, now: Option<f64>) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let get = |key: &str| record.get(key);
    let (Some(bound), Some(fingerprint)) = (
        get("boundRequest").and_then(Value::as_str),
        get("fingerprint").and_then(Value::as_str),
    ) else {
        return false;
    };
    if !strict_eq(get("version"), Some(&Value::from(1)))
        || !key_v(get("id"))
        || !clock_v(get("updatedAt"))
        || now.is_some_and(|now| {
            !is_clock(now) || get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0) > now
        })
        || sha256_hex(bound) != fingerprint
    {
        return false;
    }
    let Ok(b) = serde_json::from_str::<Value>(bound) else {
        return false;
    };
    if !b.is_object() {
        return false;
    }
    let known_identity = |v: Option<&Value>| {
        v.is_some_and(truthy)
            && key_v(v.and_then(|v| v.get("profileId")))
            && uuid_v(v.and_then(|v| v.get("accountUuid")))
            && uuid_v(v.and_then(|v| v.get("orgId")))
    };
    let execution_policy = b.get("executionPolicy");
    if !strict_eq(b.get("id"), get("id"))
        || !known_identity(b.get("source"))
        || !known_identity(b.get("target"))
        || !uuid_v(b.get("sessionId"))
        || !text_v(b.get("projectKey"))
        || !text_v(b.get("transcriptRevision"))
        || !text_v(b.get("permissionMode"))
        || !clock_v(b.get("expectedContextRevision"))
        || !matches!(
            b.get("continuationText").and_then(Value::as_str),
            Some(CONTINUATION_TEXT | LEGACY_CONTINUATION_TEXT)
        )
        || (execution_policy.is_some()
            && execution_policy.and_then(Value::as_str)
                != Some(ExecutionPolicy::GuardedNativeAtMostOnce.as_str()))
    {
        return false;
    }
    let b_str = |key: &str| b.get(key).and_then(Value::as_str).unwrap_or_default();
    let checkpoint = get("checkpoint").filter(|c| truthy(c));
    if let Some(checkpoint) = checkpoint {
        let session = checkpoint.get("session");
        let same = str_at(session, "id")
            .is_some_and(|id| id.to_lowercase() == b_str("sessionId").to_lowercase())
            && str_at(session, "projectKey") == Some(b_str("projectKey"))
            && str_at(session, "transcriptRevision") == Some(b_str("transcriptRevision"))
            && str_at(session, "permissionMode") == Some(b_str("permissionMode"));
        if !text_v(checkpoint.get("id"))
            || str_at(session, "status") != Some(SessionStatus::Stopped.as_str())
            || !same
        {
            return false;
        }
    }
    let send_recorded = get("sendRecorded");
    if str_at(Some(value), "stage") == Some(ContinuationStage::Blocked.as_str()) {
        return send_recorded == Some(&Value::Bool(false)) && get("receipt").is_none();
    }
    let receipt = get("receipt").filter(|r| truthy(r));
    let Some(receipt) = receipt else { return false };
    let r = |key: &str| receipt.get(key);
    str_at(Some(value), "stage") == Some(ContinuationStage::DeliveryConfirmed.as_str())
        && send_recorded == Some(&Value::Bool(true))
        && checkpoint.is_some()
        && strict_eq(r("requestId"), b.get("id"))
        && b.get("target")
            .is_some_and(|target| same_identity_v(r("identity"), target))
        && r("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|id| id.to_lowercase() == b_str("sessionId").to_lowercase())
        && strict_eq(r("projectKey"), b.get("projectKey"))
        && strict_eq(r("permissionMode"), b.get("permissionMode"))
        && strict_eq(r("beforeRevision"), b.get("transcriptRevision"))
        && text_v(r("afterRevision"))
        && r("afterRevision").and_then(Value::as_str) != Some(b_str("transcriptRevision"))
        && key_v(r("turnId"))
}

fn result(
    status: ContinuationResultStatus,
    reason: impl Into<String>,
    record: Option<&ContinuationJournalRecord>,
    receipt: Option<&ContinuationReceipt>,
) -> ContinuationResult {
    ContinuationResult {
        status,
        continuation_kind: ContinuationKind::StoppedSessionNewTurn,
        reason: reason.into(),
        record: record.cloned(),
        receipt: receipt.cloned(),
    }
}

fn fail(reason: &str) -> ContinuationResult {
    result(ContinuationResultStatus::Blocked, reason, None, None)
}

/// The stopped-session handoff: checkpoint, switch, reopen, one send, each step journaled first.
pub struct ContinuationEngine<H, J> {
    host: H,
    journal: J,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
}

impl<H: ContinuationHost, J: ContinuationJournal> ContinuationEngine<H, J> {
    /// An engine on the wall clock.
    pub fn new(host: H, journal: J) -> Self {
        Self::with_clock(host, journal, || crate::clock::now_ms() as f64)
    }

    pub fn with_clock(host: H, journal: J, now: impl Fn() -> f64 + Send + Sync + 'static) -> Self {
        ContinuationEngine {
            host,
            journal,
            now: Box::new(now),
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn journal(&self) -> &J {
        &self.journal
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    /// Each adapter checks revision again; native UI checks are observational.
    fn state_reason(
        &self,
        state: &ContinuationState,
        expected_identity: &ContinuationIdentity,
        expected_session: Option<&ContinuationSession>,
    ) -> Option<String> {
        let now = self.now();
        if !is_clock(now)
            || !is_clock(state.observed_at)
            || state.observed_at > now
            || now - state.observed_at > 15_000.0
        {
            return Some("observation-not-fresh".into());
        }
        if !is_clock(state.context_revision) {
            return Some("invalid-context-revision".into());
        }
        if !same_identity(&state.identity, expected_identity) {
            return Some("identity-mismatch".into());
        }
        let q = &state.quiescence;
        let expected_coverage = match self.host.capabilities().kind {
            ContinuationHostKind::Simulated => QuiescenceCoverage::IsolatedAll,
            ContinuationHostKind::GuardedNative => QuiescenceCoverage::GuardedLocal,
            ContinuationHostKind::VerifiedContract => QuiescenceCoverage::VerifiedAll,
        };
        if q.coverage != expected_coverage {
            return Some("coverage-unverified".into());
        }
        for (name, value) in q.counters() {
            if !is_clock(value) || value != 0.0 {
                return Some(format!("not-quiescent:{name}"));
            }
        }
        if state.session.status != SessionStatus::Stopped {
            return Some("session-not-stopped".into());
        }
        if expected_session.is_some_and(|expected| !same_session(&state.session, expected)) {
            return Some("session-mismatch".into());
        }
        None
    }

    pub fn execute(
        &self,
        request: &ContinuationRequest,
    ) -> Result<ContinuationResult, ContinuationError> {
        if !request.authorized {
            return Ok(fail("not-authorized"));
        }
        let caps = self.host.capabilities();
        if !is_text(&caps.contract_id)
            || !caps.exact_session
            || !caps.conditional_actions
            || !caps.delivery_lookup
            || !caps.checkpoint
            || !caps.account_switch
            || !caps.session_reopen
            || !caps.targeted_send
            || !caps.delivery_receipt
            || if caps.kind == ContinuationHostKind::GuardedNative {
                request.execution_policy != Some(ExecutionPolicy::GuardedNativeAtMostOnce)
            } else {
                !caps.idempotent_delivery || !caps.atomic_context_guard
            }
        {
            return Ok(fail("adapter-contract-unverified"));
        }
        if !is_key(&request.id)
            || !is_uuid(&request.session_id)
            || !is_text(&request.project_key)
            || !is_text(&request.transcript_revision)
            || !is_text(&request.permission_mode)
            || !is_clock(request.expected_context_revision)
            || !is_clock(self.now())
        {
            return Ok(fail("invalid-request"));
        }
        if !enrolled(&request.source) || !enrolled(&request.target) {
            return Ok(fail("identity-not-enrolled"));
        }
        let source = identity(&request.source);
        let target = identity(&request.target);
        if source.profile_id == target.profile_id
            || (source.account_uuid == target.account_uuid && source.org_id == target.org_id)
        {
            return Ok(fail("duplicate-identity"));
        }
        self.journal.with_lock(&request.id, || {
            let fingerprint = binding(request);
            if let Some(value) = self.journal.read(&request.id)?.filter(truthy) {
                if !strict_eq(value.get("version"), Some(&Value::from(1)))
                    || value.get("id").and_then(Value::as_str) != Some(request.id.as_str())
                    || value.get("fingerprint").and_then(Value::as_str)
                        != Some(fingerprint.as_str())
                {
                    return Ok(fail("journal-binding-mismatch"));
                }
                let Ok(record) = serde_json::from_value::<ContinuationJournalRecord>(value) else {
                    return Ok(fail("journal-record-invalid"));
                };
                if !valid_record(request, &record, self.now()) {
                    return Ok(fail("journal-record-invalid"));
                }
                if record.stage == ContinuationStage::DeliveryConfirmed
                    && let Some(receipt) = &record.receipt
                {
                    return Ok(result(
                        ContinuationResultStatus::Continued,
                        "durable-delivery-confirmed",
                        Some(&record),
                        Some(receipt),
                    ));
                }
                if record.send_recorded {
                    return self.reconcile(request, record);
                }
                if record.checkpoint.is_some() && record.stage != ContinuationStage::Blocked {
                    if self.has_other_intent(&request.id)? {
                        return Ok(fail("unresolved-host-intent"));
                    }
                    return self.run(request, record, None);
                }
                let status = if record.stage == ContinuationStage::Blocked {
                    ContinuationResultStatus::Blocked
                } else {
                    ContinuationResultStatus::ReconciliationRequired
                };
                let reason = record
                    .reason
                    .clone()
                    .unwrap_or_else(|| "interrupted-before-send".into());
                return Ok(result(status, reason, Some(&record), None));
            }
            if self.has_other_intent(&request.id)? {
                return Ok(fail("unresolved-host-intent"));
            }
            let session = request_session(request);
            let before = self.host.read_state()?;
            let reason = continuation_policy_reason(request, self.now(), true)
                .map(str::to_owned)
                .or_else(|| self.state_reason(&before, &source, Some(&session)))
                .or_else(|| {
                    (before.context_revision != request.expected_context_revision)
                        .then(|| "context-revision-changed".to_owned())
                });
            if let Some(reason) = reason {
                return Ok(fail(&reason));
            }
            let record = ContinuationJournalRecord {
                version: 1,
                id: request.id.clone(),
                fingerprint,
                bound_request: serialized_binding(request),
                stage: ContinuationStage::Prepared,
                updated_at: self.now(),
                send_recorded: false,
                checkpoint: None,
                reason: None,
                receipt: None,
            };
            self.journal.write(&record)?;
            self.run(request, record, Some(before))
        })
    }

    /// User cancellation never probes Desktop or clears a possible send.
    pub fn abandon_unsent(
        &self,
        request_id: &str,
    ) -> Result<AbandonUnsentResult, ContinuationError> {
        if !is_key(request_id) || !is_clock(self.now()) {
            return Err("invalid-request".into());
        }
        self.journal.with_lock(request_id, || {
            let Some(record) = self.journal.read(request_id)?.filter(truthy) else {
                if self.has_other_intent(request_id)? {
                    return Err("unresolved-host-intent".into());
                }
                // execute writes prepared durably before any host operation. Absence
                // therefore proves that this request never entered the host pipeline.
                return Ok(AbandonUnsentResult {
                    status: AbandonStatus::Abandoned,
                    reason: "user-cancelled-unsent".into(),
                    record: None,
                });
            };
            if record.get("id").and_then(Value::as_str) != Some(request_id)
                || record.get("sendRecorded") != Some(&Value::Bool(false))
                || record.get("receipt").is_some()
            {
                return Err("cannot-cancel-possible-send".into());
            }
            use ContinuationStage::*;
            let stage = record
                .get("stage")
                .and_then(|s| serde_json::from_value::<ContinuationStage>(s.clone()).ok());
            let unsent = stage.filter(|s| {
                s.before_send() || matches!(s, Prepared | ReconciliationRequired | Blocked)
            });
            let updated_at = record.get("updatedAt");
            let checkpoint = record.get("checkpoint");
            if unsent.is_none()
                || !clock_v(updated_at)
                || updated_at.and_then(Value::as_f64).unwrap_or(0.0) > self.now()
                || (unsent == Some(Prepared) && checkpoint.is_some())
                || (unsent.is_some_and(ContinuationStage::before_send)
                    && !checkpoint.is_some_and(truthy))
            {
                return Err("journal-record-invalid".into());
            }
            let mut terminal = record;
            let fields = terminal.as_object_mut().expect("an object has an id");
            fields.insert("stage".into(), Blocked.as_str().into());
            fields.insert("reason".into(), "user-cancelled-unsent".into());
            // Validate original binding/hash/checkpoint before changing its timestamp.
            if !is_terminal_continuation_record(&terminal, Some(self.now())) {
                return Err("journal-record-invalid".into());
            }
            let Ok(mut terminal) = serde_json::from_value::<ContinuationJournalRecord>(terminal)
            else {
                return Err("journal-record-invalid".into());
            };
            terminal.updated_at = self.now();
            self.journal.write(&terminal)?;
            Ok(AbandonUnsentResult {
                status: AbandonStatus::Abandoned,
                reason: "user-cancelled-unsent".into(),
                record: Some(terminal),
            })
        })
    }

    fn has_other_intent(&self, request_id: &str) -> Result<bool, ContinuationError> {
        let pending = self.journal.list_pending()?;
        let now = self.now();
        Ok(pending.iter().any(|entry| {
            !truthy(entry)
                || (entry.get("id").and_then(Value::as_str) != Some(request_id)
                    && !is_terminal_continuation_record(entry, Some(now)))
        }))
    }

    fn persist(
        &self,
        record: &mut ContinuationJournalRecord,
        stage: ContinuationStage,
    ) -> Result<(), ContinuationError> {
        record.stage = stage;
        record.updated_at = self.now();
        self.journal.write(record)
    }

    /// Resume only an unambiguous, durable, unsent checkpoint under the same lock.
    fn run(
        &self,
        request: &ContinuationRequest,
        mut record: ContinuationJournalRecord,
        initial: Option<ContinuationState>,
    ) -> Result<ContinuationResult, ContinuationError> {
        match self.run_steps(request, &mut record, initial) {
            Ok(result) => Ok(result),
            Err(error) => {
                record.reason = Some(error.0);
                self.persist(&mut record, ContinuationStage::ReconciliationRequired)?;
                Ok(result(
                    ContinuationResultStatus::ReconciliationRequired,
                    record.reason.clone().unwrap_or_default(),
                    Some(&record),
                    None,
                ))
            }
        }
    }

    fn run_steps(
        &self,
        request: &ContinuationRequest,
        record: &mut ContinuationJournalRecord,
        initial: Option<ContinuationState>,
    ) -> Result<ContinuationResult, ContinuationError> {
        let source = identity(&request.source);
        let target = identity(&request.target);
        let session = request_session(request);
        let mut state = match initial {
            Some(state) => state,
            None => self.host.read_state()?,
        };
        if record.checkpoint.is_none() {
            self.assert_ready(request, &state, &source, Some(&session), true)?;
            let checkpoint = self.host.checkpoint(&ContinuationCheckpointInput {
                request_id: request.id.clone(),
                session: session.clone(),
                expected_context_revision: state.context_revision,
            })?;
            let matches = is_text(&checkpoint.id)
                && same_session(&checkpoint.session, &session)
                && checkpoint.session.status == SessionStatus::Stopped;
            record.checkpoint = Some(checkpoint);
            if !matches {
                return Err("checkpoint-mismatch".into());
            }
            self.persist(record, ContinuationStage::Checkpointed)?;
            state = self.host.read_state()?;
        }
        if same_identity(&state.identity, &source) {
            self.assert_ready(request, &state, &source, Some(&session), true)?;
            self.persist(record, ContinuationStage::SwitchIntent)?;
            self.host.switch_account(&ContinuationSwitchInput {
                request_id: request.id.clone(),
                target: target.clone(),
                expected_context_revision: state.context_revision,
            })?;
            state = self.host.read_state()?;
        }
        // A resumed journal never guesses the active identity, task coverage or
        // history. The exact checkpoint is reopened; a conditional adapter must
        // refuse to overwrite a conversation whose transcript changed meanwhile.
        self.assert_ready(request, &state, &target, None, false)?;
        if state.session.id.to_lowercase() == session.id
            && !same_session(&state.session, &session)
            && !(self.host.capabilities().kind == ContinuationHostKind::GuardedNative
                && state.session.project_key == session.project_key
                && state.session.transcript_revision == session.transcript_revision)
        {
            return Err("session-mismatch".into());
        }
        self.persist(record, ContinuationStage::AccountVerified)?;
        self.persist(record, ContinuationStage::OpenIntent)?;
        self.host.reopen_session(&ContinuationReopenInput {
            request_id: request.id.clone(),
            checkpoint: record.checkpoint.clone().expect("checkpointed above"),
            target: target.clone(),
            expected_context_revision: state.context_revision,
        })?;
        state = self.host.read_state()?;
        self.assert_ready(request, &state, &target, Some(&session), false)?;
        self.persist(record, ContinuationStage::SessionVerified)?;
        // Persist before submission. Any restart with this bit queries receipts;
        // an absent/ambiguous acknowledgement must NEVER cause a blind resend.
        record.send_recorded = true;
        self.persist(record, ContinuationStage::SendIntent)?;
        state = self.host.read_state()?;
        self.assert_ready(request, &state, &target, Some(&session), false)?;
        let delivery = self.host.send_continuation(&ContinuationSendInput {
            request_id: request.id.clone(),
            target,
            session,
            expected_context_revision: state.context_revision,
            text: CONTINUATION_TEXT.into(),
        })?;
        self.confirm(request, record, delivery)
    }

    fn assert_ready(
        &self,
        request: &ContinuationRequest,
        state: &ContinuationState,
        expected_identity: &ContinuationIdentity,
        session: Option<&ContinuationSession>,
        check_quota: bool,
    ) -> Result<(), ContinuationError> {
        let reason = continuation_policy_reason(request, self.now(), check_quota)
            .map(str::to_owned)
            .or_else(|| self.state_reason(state, expected_identity, session));
        match reason {
            Some(reason) => Err(reason.into()),
            None => Ok(()),
        }
    }

    fn reconcile(
        &self,
        request: &ContinuationRequest,
        mut record: ContinuationJournalRecord,
    ) -> Result<ContinuationResult, ContinuationError> {
        let confirmed = self
            .host
            .lookup_delivery(&request.id)
            .and_then(|delivery| self.confirm(request, &mut record, delivery));
        if let Ok(result) = confirmed {
            return Ok(result);
        }
        record.stage = ContinuationStage::ReconciliationRequired;
        record.reason = Some("delivery-lookup-unavailable".into());
        record.updated_at = self.now();
        self.journal.write(&record)?;
        Ok(result(
            ContinuationResultStatus::ReconciliationRequired,
            "delivery-lookup-unavailable",
            Some(&record),
            None,
        ))
    }

    fn confirm(
        &self,
        request: &ContinuationRequest,
        record: &mut ContinuationJournalRecord,
        delivery: ContinuationDelivery,
    ) -> Result<ContinuationResult, ContinuationError> {
        let mut reason = format!("delivery-{}", delivery.status.as_str());
        if delivery.status == DeliveryStatus::Started
            && let Some(receipt) = delivery.receipt
        {
            if !receipt_matches(request, Some(&receipt)) {
                reason = "receipt-mismatch".into();
            } else {
                let state = self.host.read_state()?;
                let now = self.now();
                if is_clock(state.observed_at)
                    && state.observed_at <= now
                    && now - state.observed_at <= 15_000.0
                    && same_identity(&state.identity, &identity(&request.target))
                    && state.session.id.to_lowercase() == request.session_id.to_lowercase()
                    && state.session.project_key == request.project_key
                    && state.session.permission_mode == request.permission_mode
                // The resumed turn keeps appending to the transcript, so its revision
                // and latest row move on; the receipt already bound them to the nonce.
                {
                    record.stage = ContinuationStage::DeliveryConfirmed;
                    record.receipt = Some(receipt);
                    record.reason = None;
                    record.updated_at = now;
                    self.journal.write(record)?;
                    return Ok(result(
                        ContinuationResultStatus::Continued,
                        "new-turn-verified",
                        Some(&*record),
                        record.receipt.as_ref(),
                    ));
                }
                reason = "new-turn-not-observed".into();
            }
        }
        record.stage = if delivery.status == DeliveryStatus::Accepted {
            ContinuationStage::DeliveryAccepted
        } else {
            ContinuationStage::ReconciliationRequired
        };
        record.reason = Some(reason.clone());
        record.updated_at = self.now();
        self.journal.write(record)?;
        Ok(result(
            ContinuationResultStatus::ReconciliationRequired,
            reason,
            Some(&*record),
            None,
        ))
    }
}
