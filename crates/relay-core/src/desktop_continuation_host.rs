//! Port of `electron/core/desktop-continuation-host.ts`: the guarded macOS Accessibility
//! transport (the `desktop-automation` Swift helper) and the continuation host built on it.
//!
//! The helper is one child process per command: no arguments, the request as JSON on stdin,
//! the reply as JSON on stdout. Blocking where the TS awaits.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::continuation::{
    ContinuationCapabilities, ContinuationCheckpoint, ContinuationCheckpointInput,
    ContinuationDelivery, ContinuationError, ContinuationHost, ContinuationHostKind,
    ContinuationIdentity, ContinuationReopenInput, ContinuationSendInput, ContinuationSession,
    ContinuationState, ContinuationSwitchInput, DeliveryStatus, QuiescenceCoverage, SessionStatus,
};
use crate::desktop_continuation::{DesktopContinuationError, DesktopQuotaStop};
use crate::fs_util::safe_integer;
use crate::shared::types::literal_enum;

literal_enum!(DesktopAutomationIssue {
    AccessibilityPermissionRequired = "accessibility-permission-required",
    ClaudeNotRunning = "claude-not-running",
    DesktopUiUnsupported = "desktop-ui-unsupported",
    ExactSessionNotObserved = "exact-session-not-observed",
    ComposerNotEmpty = "composer-not-empty",
    PermissionModeMismatch = "permission-mode-mismatch",
    ContextChanged = "context-changed",
    DesktopWorkActive = "desktop-work-active",
    DeliveryAmbiguous = "delivery-ambiguous",
    DesktopObservationIncomplete = "desktop-observation-incomplete",
    // `write-draft`, or `open-session` asked to check, refused before acting: Claude is not in
    // front, or the user had input in the last 3 s.
    UserActive = "user-active",
});

impl DesktopAutomationIssue {
    /// The issue a helper reply names, when it is one of the known ones.
    pub fn parse(text: &str) -> Option<Self> {
        use DesktopAutomationIssue::*;
        [
            AccessibilityPermissionRequired,
            ClaudeNotRunning,
            DesktopUiUnsupported,
            ExactSessionNotObserved,
            ComposerNotEmpty,
            PermissionModeMismatch,
            ContextChanged,
            DesktopWorkActive,
            DeliveryAmbiguous,
            DesktopObservationIncomplete,
            UserActive,
        ]
        .into_iter()
        .find(|issue| issue.as_str() == text)
    }
}

literal_enum!(
    /// Where a send stopped, or how the helper itself failed, for the log only: the send's
    /// `write`, `verify`, `press` or `after` step, or `helper-timeout`, `helper-exit` and
    /// `helper-output` when the helper gave no answer to read.
    DesktopAutomationStep {
        Write = "write",
        Verify = "verify",
        Press = "press",
        After = "after",
        HelperTimeout = "helper-timeout",
        HelperExit = "helper-exit",
        HelperOutput = "helper-output",
    }
);

impl DesktopAutomationStep {
    /// A send step a helper reply names; the helper's own failures are never taken from it.
    fn parse_send_step(text: &str) -> Option<Self> {
        use DesktopAutomationStep::*;
        [Write, Verify, Press, After]
            .into_iter()
            .find(|step| step.as_str() == text)
    }
}

/// `DesktopAutomationError`: its message is the issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{}", issue.as_str())]
pub struct DesktopAutomationError {
    pub issue: DesktopAutomationIssue,
    /// True when the failure happened before anything in Claude was changed.
    pub unchanged: bool,
    pub step: Option<DesktopAutomationStep>,
}

impl DesktopAutomationError {
    pub fn new(issue: DesktopAutomationIssue) -> Self {
        DesktopAutomationError {
            issue,
            unchanged: false,
            step: None,
        }
    }
    /// A failure before anything in Claude was changed.
    pub fn unchanged(issue: DesktopAutomationIssue) -> Self {
        DesktopAutomationError {
            issue,
            unchanged: true,
            step: None,
        }
    }
    pub fn with_step(
        issue: DesktopAutomationIssue,
        unchanged: bool,
        step: Option<DesktopAutomationStep>,
    ) -> Self {
        DesktopAutomationError {
            issue,
            unchanged,
            step,
        }
    }
}

/// What an automation, an evidence reader or a host throws: a [`DesktopAutomationError`], or any
/// other error (`Other`, its TS `Error.message`). Callers branch on `instanceof
/// DesktopAutomationError`, so the two stay apart.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DesktopHostError {
    #[error(transparent)]
    Automation(#[from] DesktopAutomationError),
    #[error("{0}")]
    Other(String),
}

impl DesktopHostError {
    pub fn other(message: impl Into<String>) -> Self {
        DesktopHostError::Other(message.into())
    }
    /// `error instanceof DesktopAutomationError ? error : undefined`.
    pub fn automation(&self) -> Option<&DesktopAutomationError> {
        match self {
            DesktopHostError::Automation(error) => Some(error),
            DesktopHostError::Other(_) => None,
        }
    }
    /// The issue of a [`DesktopAutomationError`].
    pub fn issue(&self) -> Option<DesktopAutomationIssue> {
        self.automation().map(|error| error.issue)
    }
    /// `DesktopAutomationError.unchanged`; false for any other error.
    pub fn is_unchanged(&self) -> bool {
        self.automation().is_some_and(|error| error.unchanged)
    }
    /// The TS `Error.message`.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<DesktopAutomationIssue> for DesktopHostError {
    fn from(issue: DesktopAutomationIssue) -> Self {
        DesktopAutomationError::new(issue).into()
    }
}

impl From<DesktopHostError> for ContinuationError {
    fn from(error: DesktopHostError) -> Self {
        ContinuationError(error.to_string())
    }
}

impl From<DesktopHostError> for DesktopContinuationError {
    fn from(error: DesktopHostError) -> Self {
        DesktopContinuationError {
            message: error.to_string(),
            unchanged: error.is_unchanged(),
        }
    }
}

literal_enum!(SendWritten { Paste = "paste" });
literal_enum!(SendSubmitted { Return = "return" });

/// What the screen showed right after Send, for the log: never text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSendAfter {
    pub status: String,
    pub composer_present: bool,
    pub composer_empty: bool,
    /// The composer still holds exactly the text that was typed: Send did not take it.
    pub composer_holds_text: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer_chars: Option<i64>,
    pub marker_visible: bool,
    pub send_present: bool,
    /// How long the screen took to show the composer again after the send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waited_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSendResult {
    pub accepted_visible: bool,
    /// How the text went in: always a paste now. Older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written: Option<SendWritten>,
    /// How it was sent: with Return in the focused composer. Older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted: Option<SendSubmitted>,
    /// Older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<DesktopSendAfter>,
}

literal_enum!(SnapshotCoverage { ActiveConversationOnly = "active-conversation-only" });

/// AX proves only the selected conversation, never all workers or their children.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutomationSnapshot {
    pub observed_at: i64,
    pub pid: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_session_id: Option<String>,
    /// Code's new-session screen is on screen: it has no `local_session_id`. Inside the
    /// fingerprint; older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    pub status: SessionStatus,
    pub quota_stopped: bool,
    /// False when no composer was found, which also reads as not empty. Older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer_present: Option<bool>,
    pub composer_empty: bool,
    /// How an empty composer read as empty, for the diagnosis log; outside the fingerprint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer_empty_as: Option<String>,
    /// How many visible characters a composer that is not empty holds: never its text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer_chars: Option<i64>,
    /// The shape of the claude.ai page on screen with its ids dropped, for the log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
    /// With conversations side by side: how many panes, for the log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_found: Option<bool>,
    pub send_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_auto_resume: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_active_tasks: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_waiting_tasks: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_scheduled_tasks: Option<i64>,
    pub context_fingerprint: String,
    pub coverage: SnapshotCoverage,
    /// Claude is the app in front. Outside the fingerprint; older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontmost: Option<bool>,
    /// Milliseconds since the user's last input of any kind. Older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_ms: Option<i64>,
    /// Milliseconds since the user last pressed a key, a modifier included. Older helpers omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_idle_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutomationGuard {
    pub pid: i64,
    pub local_session_id: String,
    pub account_label: String,
    pub permission_mode: String,
    pub context_fingerprint: String,
}

/// Code's new-session screen, for `write_draft` only: the helper refuses it for any other
/// command. That screen may show no single permission selector, so the mode is kept only
/// when one was read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNewSessionGuard {
    pub pid: i64,
    /// Always true.
    pub new_session: bool,
    pub account_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    pub context_fingerprint: String,
}

/// The screens a draft can be typed into: a conversation, or Code's new-session screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DesktopDraftGuard {
    Session(DesktopAutomationGuard),
    NewSession(DesktopNewSessionGuard),
}

impl From<DesktopAutomationGuard> for DesktopDraftGuard {
    fn from(guard: DesktopAutomationGuard) -> Self {
        DesktopDraftGuard::Session(guard)
    }
}

impl From<DesktopNewSessionGuard> for DesktopDraftGuard {
    fn from(guard: DesktopNewSessionGuard) -> Self {
        DesktopDraftGuard::NewSession(guard)
    }
}

/// `openSession`/`openNewSession` options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionOptions {
    /// Check, right before opening, that Claude is in front and the user has had no input for
    /// 3 s; otherwise open nothing (`user-active`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_idle: Option<bool>,
}

/// `writeDraft` options.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDraftOptions {
    /// 500 to 3000: a key pressed in that time instead of any input refuses the write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys_idle_ms: Option<f64>,
}

/// The guarded Claude app UI transport.
pub trait DesktopAutomation: Send + Sync {
    /// Whether `request_accessibility` exists.
    fn supports_request_accessibility(&self) -> bool {
        false
    }
    /// Explicit user action only. Ordinary inspection never triggers an OS prompt.
    fn request_accessibility(&self) -> Result<bool, DesktopHostError> {
        Ok(false)
    }
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError>;
    /// Opens an exact saved conversation. Success still requires inspection. With
    /// `require_idle`, the helper first checks, right before it opens, that Claude is in front
    /// and the user has had no input for 3 s, and otherwise opens nothing: `user-active`.
    fn open_session(
        &self,
        local_session_id: &str,
        options: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError>;
    /// Shows Code's new-session screen through Desktop's own `claude://code/new`, which starts
    /// no session. Success still requires inspection. `require_idle` as for `open_session`.
    fn open_new_session(&self, options: Option<OpenSessionOptions>)
    -> Result<(), DesktopHostError>;
    /// Chooses the prior explicit permission mode; it never approves a tool dialog.
    fn set_permission(
        &self,
        guard: &DesktopAutomationGuard,
        mode: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError>;
    /// Whether `cancel_quota_resume` exists.
    fn supports_cancel_quota_resume(&self) -> bool {
        false
    }
    fn cancel_quota_resume(
        &self,
        _guard: &DesktopAutomationGuard,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Err(DesktopAutomationIssue::DesktopUiUnsupported.into())
    }
    /// At-most-one UI send attempt. A visible marker is not a durable receipt.
    fn send(
        &self,
        guard: &DesktopAutomationGuard,
        request_id: &str,
        text: &str,
    ) -> Result<DesktopSendResult, DesktopHostError>;
    fn has_request_marker(&self, request_id: &str) -> Result<bool, DesktopHostError>;
    /// Types `text` into the empty composer of the open conversation, or of Code's new-session
    /// screen, and never presses Send. One guarded attempt: a non-empty composer is
    /// `composer-not-empty`, a moved context is `context-changed`, an unverifiable result is
    /// `delivery-ambiguous`. Claude not in front, or input from the user in the last 3 s, is
    /// `user-active`, before anything is typed; with `keys_idle_ms` (500 to 3000), a key
    /// pressed in that time instead of any input. Returns the snapshot taken after the write.
    fn write_draft(
        &self,
        guard: &DesktopDraftGuard,
        text: &str,
        options: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError>;
    /// Whether `answer_quit_guard` exists.
    fn supports_answer_quit_guard(&self) -> bool {
        false
    }
    /// Answers Claude's own question before it quits, "Background commands are still
    /// running", with "Quit anyway". Only that question. Whether it pressed.
    fn answer_quit_guard(&self) -> Result<bool, DesktopHostError> {
        Ok(false)
    }
}

macro_rules! forward_automation {
    ($($ty:ty),+) => {$(
        impl<T: DesktopAutomation + ?Sized> DesktopAutomation for $ty {
            fn supports_request_accessibility(&self) -> bool {
                (**self).supports_request_accessibility()
            }
            fn request_accessibility(&self) -> Result<bool, DesktopHostError> {
                (**self).request_accessibility()
            }
            fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
                (**self).inspect()
            }
            fn open_session(
                &self,
                local_session_id: &str,
                options: Option<OpenSessionOptions>,
            ) -> Result<(), DesktopHostError> {
                (**self).open_session(local_session_id, options)
            }
            fn open_new_session(&self, options: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
                (**self).open_new_session(options)
            }
            fn set_permission(
                &self,
                guard: &DesktopAutomationGuard,
                mode: &str,
            ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
                (**self).set_permission(guard, mode)
            }
            fn supports_cancel_quota_resume(&self) -> bool {
                (**self).supports_cancel_quota_resume()
            }
            fn cancel_quota_resume(
                &self,
                guard: &DesktopAutomationGuard,
            ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
                (**self).cancel_quota_resume(guard)
            }
            fn send(
                &self,
                guard: &DesktopAutomationGuard,
                request_id: &str,
                text: &str,
            ) -> Result<DesktopSendResult, DesktopHostError> {
                (**self).send(guard, request_id, text)
            }
            fn has_request_marker(&self, request_id: &str) -> Result<bool, DesktopHostError> {
                (**self).has_request_marker(request_id)
            }
            fn write_draft(
                &self,
                guard: &DesktopDraftGuard,
                text: &str,
                options: Option<WriteDraftOptions>,
            ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
                (**self).write_draft(guard, text, options)
            }
            fn supports_answer_quit_guard(&self) -> bool {
                (**self).supports_answer_quit_guard()
            }
            fn answer_quit_guard(&self) -> Result<bool, DesktopHostError> {
                (**self).answer_quit_guard()
            }
        }
    )+};
}
forward_automation!(&T, Box<T>, Arc<T>);

/// `DesktopContinuationObservation`: a [`ContinuationState`] bound to its Desktop alias.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContinuationObservation {
    #[serde(flatten)]
    pub state: ContinuationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_quota_wakeup: Option<bool>,
    /// Read-only evidence must bind this Desktop alias to `state.session.id`.
    pub local_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_stop: Option<DesktopQuotaStop>,
}

/// Identity, transcript, complete worker coverage and durable acknowledgement are independent
/// of AX. Do not infer them from an empty composer or a quota banner.
pub trait DesktopContinuationEvidence: Send + Sync {
    fn read(
        &self,
        snapshot: &DesktopAutomationSnapshot,
    ) -> Result<DesktopContinuationObservation, DesktopHostError>;
    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, DesktopHostError>;
    fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), DesktopHostError>;
    fn local_session_id(
        &self,
        checkpoint: &ContinuationCheckpoint,
    ) -> Result<String, DesktopHostError>;
    fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, DesktopHostError>;
}

macro_rules! forward_evidence {
    ($($ty:ty),+) => {$(
        impl<T: DesktopContinuationEvidence + ?Sized> DesktopContinuationEvidence for $ty {
            fn read(
                &self,
                snapshot: &DesktopAutomationSnapshot,
            ) -> Result<DesktopContinuationObservation, DesktopHostError> {
                (**self).read(snapshot)
            }
            fn checkpoint(
                &self,
                input: &ContinuationCheckpointInput,
            ) -> Result<ContinuationCheckpoint, DesktopHostError> {
                (**self).checkpoint(input)
            }
            fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), DesktopHostError> {
                (**self).switch_account(input)
            }
            fn local_session_id(
                &self,
                checkpoint: &ContinuationCheckpoint,
            ) -> Result<String, DesktopHostError> {
                (**self).local_session_id(checkpoint)
            }
            fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, DesktopHostError> {
                (**self).lookup_delivery(request_id)
            }
        }
    )+};
}
forward_evidence!(&T, Box<T>, Arc<T>);

static LOCAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("valid pattern")
});
static REQUEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:-]{1,128}$").expect("valid pattern"));
static EMPTY_AS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z-]{1,16}$").expect("valid pattern"));
static SCREEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9/:*_-]{1,80}$").expect("valid pattern"));
static FINGERPRINT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-f]{64}$").expect("valid pattern"));

/// Whether `id` is an exact Desktop conversation id, the only kind `open_session` opens.
pub fn is_local_session_id(id: &str) -> bool {
    LOCAL.is_match(id)
}

/// Longest unsent draft Relay re-types; longer ones are left for Copy.
const MAX_DRAFT_LENGTH: usize = 16_384;
const MODES: [&str; 4] = ["Manual", "Auto", "Plan", "Accept edits"];

/// `text.length` in UTF-16 code units, as JS counts.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `value === undefined || ok(value)` for an object member: present but `null` is not absent.
fn absent_or(object: &Map<String, Value>, key: &str, ok: impl FnOnce(&Value) -> bool) -> bool {
    object.get(key).is_none_or(ok)
}

fn non_negative(value: &Value) -> bool {
    safe_integer(value).is_some_and(|n| n >= 0)
}

fn opt_i64(object: &Map<String, Value>, key: &str) -> Option<i64> {
    object.get(key).and_then(safe_integer)
}

fn opt_bool(object: &Map<String, Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(Value::as_bool)
}

fn opt_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn valid_send_after(value: Option<&Value>) -> Option<DesktopSendAfter> {
    let v = value?.as_object()?;
    let status = v.get("status")?.as_str()?;
    let flag = |key: &str| v.get(key).and_then(Value::as_bool);
    if js_length(status) > 32
        || !absent_or(v, "composerChars", |n| safe_integer(n).is_some())
        || !absent_or(v, "waitedMs", |n| safe_integer(n).is_some())
    {
        return None;
    }
    Some(DesktopSendAfter {
        status: status.to_owned(),
        composer_present: flag("composerPresent")?,
        composer_empty: flag("composerEmpty")?,
        composer_holds_text: flag("composerHoldsText")?,
        composer_chars: opt_i64(v, "composerChars"),
        marker_visible: flag("markerVisible")?,
        send_present: flag("sendPresent")?,
        waited_ms: opt_i64(v, "waitedMs"),
    })
}

/// `validSnapshot`: the snapshot a helper reply carries, or `None` when any member is malformed.
fn valid_snapshot(value: Option<&Value>) -> Option<DesktopAutomationSnapshot> {
    let v = value?.as_object()?;
    let observed_at = v
        .get("observedAt")
        .and_then(safe_integer)
        .filter(|n| *n > 0)?;
    let pid = v.get("pid").and_then(safe_integer).filter(|n| *n > 0)?;
    let is_bool = |value: &Value| value.is_boolean();
    let status = match v.get("status").and_then(Value::as_str)? {
        "stopped" => SessionStatus::Stopped,
        "running" => SessionStatus::Running,
        "waiting" => SessionStatus::Waiting,
        "unknown" => SessionStatus::Unknown,
        _ => return None,
    };
    let fingerprint = v.get("contextFingerprint").and_then(Value::as_str)?;
    let ok = absent_or(v, "localSessionId", |id| id.as_str().is_some_and(is_local_session_id))
        && absent_or(v, "newSession", is_bool)
        // The new-session screen has no conversation id.
        && !(v.get("newSession") == Some(&Value::Bool(true)) && v.contains_key("localSessionId"))
        && absent_or(v, "accountLabel", |label| {
            label.as_str().is_some_and(|label| js_length(label) <= 512)
        })
        && absent_or(v, "permissionMode", |mode| {
            mode.as_str().is_some_and(|mode| MODES.contains(&mode))
        })
        && v.get("quotaStopped").is_some_and(is_bool)
        && absent_or(v, "composerPresent", is_bool)
        && v.get("composerEmpty").is_some_and(is_bool)
        && absent_or(v, "composerEmptyAs", |text| {
            text.as_str().is_some_and(|text| EMPTY_AS.is_match(text))
        })
        && absent_or(v, "composerChars", non_negative)
        && absent_or(v, "screen", |text| {
            text.as_str().is_some_and(|text| SCREEN.is_match(text))
        })
        && absent_or(v, "panes", non_negative)
        && absent_or(v, "paneFound", is_bool)
        && v.get("sendEnabled").is_some_and(is_bool)
        && absent_or(v, "quotaAutoResume", is_bool)
        && ["visibleActiveTasks", "visibleWaitingTasks", "visibleScheduledTasks"]
            .iter()
            .all(|key| absent_or(v, key, non_negative))
        && FINGERPRINT.is_match(fingerprint)
        && v.get("coverage").and_then(Value::as_str) == Some("active-conversation-only")
        && absent_or(v, "frontmost", is_bool)
        && absent_or(v, "idleMs", non_negative)
        && absent_or(v, "keyIdleMs", non_negative);
    if !ok {
        return None;
    }
    Some(DesktopAutomationSnapshot {
        observed_at,
        pid,
        local_session_id: opt_string(v, "localSessionId"),
        new_session: opt_bool(v, "newSession"),
        account_label: opt_string(v, "accountLabel"),
        permission_mode: opt_string(v, "permissionMode"),
        status,
        quota_stopped: opt_bool(v, "quotaStopped")?,
        composer_present: opt_bool(v, "composerPresent"),
        composer_empty: opt_bool(v, "composerEmpty")?,
        composer_empty_as: opt_string(v, "composerEmptyAs"),
        composer_chars: opt_i64(v, "composerChars"),
        screen: opt_string(v, "screen"),
        panes: opt_i64(v, "panes"),
        pane_found: opt_bool(v, "paneFound"),
        send_enabled: opt_bool(v, "sendEnabled")?,
        quota_auto_resume: opt_bool(v, "quotaAutoResume"),
        visible_active_tasks: opt_i64(v, "visibleActiveTasks"),
        visible_waiting_tasks: opt_i64(v, "visibleWaitingTasks"),
        visible_scheduled_tasks: opt_i64(v, "visibleScheduledTasks"),
        context_fingerprint: fingerprint.to_owned(),
        coverage: SnapshotCoverage::ActiveConversationOnly,
        frontmost: opt_bool(v, "frontmost"),
        idle_ms: opt_i64(v, "idleMs"),
        key_idle_ms: opt_i64(v, "keyIdleMs"),
    })
}

/// `automationGuard`: the guard for the conversation a snapshot shows.
pub fn automation_guard(
    snapshot: &DesktopAutomationSnapshot,
) -> Result<DesktopAutomationGuard, DesktopAutomationError> {
    let Some(local_session_id) = snapshot
        .local_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return Err(DesktopAutomationError::new(
            DesktopAutomationIssue::ExactSessionNotObserved,
        ));
    };
    let (Some(account_label), Some(permission_mode)) = (
        snapshot.account_label.as_deref().filter(|l| !l.is_empty()),
        snapshot
            .permission_mode
            .as_deref()
            .filter(|m| !m.is_empty()),
    ) else {
        return Err(DesktopAutomationError::new(
            DesktopAutomationIssue::DesktopUiUnsupported,
        ));
    };
    Ok(DesktopAutomationGuard {
        pid: snapshot.pid,
        local_session_id: local_session_id.to_owned(),
        account_label: account_label.to_owned(),
        permission_mode: permission_mode.to_owned(),
        context_fingerprint: snapshot.context_fingerprint.clone(),
    })
}

/// A guard for Code's new-session screen, from a snapshot that shows it.
pub fn new_session_guard(
    snapshot: &DesktopAutomationSnapshot,
) -> Result<DesktopNewSessionGuard, DesktopAutomationError> {
    if snapshot.new_session != Some(true) || snapshot.local_session_id.is_some() {
        return Err(DesktopAutomationError::new(
            DesktopAutomationIssue::ExactSessionNotObserved,
        ));
    }
    let Some(account_label) = snapshot.account_label.as_deref().filter(|l| !l.is_empty()) else {
        return Err(DesktopAutomationError::new(
            DesktopAutomationIssue::DesktopUiUnsupported,
        ));
    };
    Ok(DesktopNewSessionGuard {
        pid: snapshot.pid,
        new_session: true,
        account_label: account_label.to_owned(),
        permission_mode: snapshot.permission_mode.clone(),
        context_fingerprint: snapshot.context_fingerprint.clone(),
    })
}

/// Which Claude the helper looks at (`DesktopTarget`'s answer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopTargetPid {
    /// TS `undefined`: only the main Claude can run; the helper takes the one app running.
    Any,
    /// TS `null`: separate windows run but the main Claude does not.
    MainNotRunning,
    /// The main Claude's pid while separate windows run beside it.
    Pid(i64),
}

/// Asked before every command but `request-accessibility`.
pub type DesktopTarget = Box<dyn Fn() -> Result<DesktopTargetPid, DesktopHostError> + Send + Sync>;
/// Runs one helper request: the request object in, the parsed reply out.
pub type DesktopNativeExecutor =
    Box<dyn Fn(Value) -> Result<Value, DesktopHostError> + Send + Sync>;

/// Commands that open a `claude://` link: macOS hands it to any Claude, a window included.
const LINK_COMMANDS: [&str; 2] = ["open-session", "open-new-session"];
const HELPER_TIMEOUT: Duration = Duration::from_millis(45_000);
const HELPER_MAX_BUFFER: usize = 65_536;

/// `execFile(helper, [], {timeout: 45_000, maxBuffer: 65_536, windowsHide: true})` with the
/// request on stdin. A timeout is `helper-timeout`; a failed start, a non-zero exit, a signal or
/// output past the buffer is `helper-exit`; stdout that is not JSON is `helper-output`.
fn run_helper(helper: &std::path::Path, request: &Value) -> Result<Value, DesktopHostError> {
    let fail = |step| {
        DesktopHostError::from(DesktopAutomationError::with_step(
            DesktopAutomationIssue::DesktopUiUnsupported,
            false,
            Some(step),
        ))
    };
    let mut command = Command::new(helper);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|_| fail(DesktopAutomationStep::HelperExit))?;
    if let Some(mut stdin) = child.stdin.take() {
        // Off the waiting thread so a helper that never reads still meets the timeout; one
        // that exits without reading is answered by its exit status.
        let body = request.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(body.as_bytes());
        });
    }
    let overflow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let overflow = Arc::clone(&overflow);
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let Some(mut pipe) = pipe else { return out };
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => return out,
                    Ok(n) => {
                        if out.len() + n > HELPER_MAX_BUFFER {
                            overflow.store(true, std::sync::atomic::Ordering::SeqCst);
                            return out;
                        }
                        out.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + HELPER_TIMEOUT;
    let status = loop {
        if overflow.load(std::sync::atomic::Ordering::SeqCst) {
            terminate(&mut child);
            let _ = child.wait();
            return Err(fail(DesktopAutomationStep::HelperExit));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                terminate(&mut child);
                let _ = child.wait();
                return Err(fail(DesktopAutomationStep::HelperTimeout));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return Err(fail(DesktopAutomationStep::HelperExit)),
        }
    };
    let out = stdout.join().unwrap_or_default();
    let _ = stderr.join();
    if !status.success() || overflow.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(fail(DesktopAutomationStep::HelperExit));
    }
    serde_json::from_slice(&out).map_err(|_| fail(DesktopAutomationStep::HelperOutput))
}

/// Node's default `killSignal`, SIGTERM; a plain kill elsewhere.
fn terminate(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        // SAFETY: signals only the child this function spawned, which has not been reaped.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

/// `nativeDesktopAutomation`: the helper never starts Claude, reads credentials or invokes a CLI.
pub struct NativeDesktopAutomation {
    helper: PathBuf,
    executor: Option<DesktopNativeExecutor>,
    target: Option<DesktopTarget>,
}

/// The production transport over the `desktop-automation` helper at `helper`. `executor`
/// replaces the child process (tests); `target` names the Claude to drive.
pub fn native_desktop_automation(
    helper: impl Into<PathBuf>,
    executor: Option<DesktopNativeExecutor>,
    target: Option<DesktopTarget>,
) -> NativeDesktopAutomation {
    NativeDesktopAutomation {
        helper: helper.into(),
        executor,
        target,
    }
}

impl NativeDesktopAutomation {
    fn call(
        &self,
        mut request: Map<String, Value>,
    ) -> Result<Map<String, Value>, DesktopHostError> {
        let command = request
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let pid = match (&self.target, command.as_str()) {
            (_, "request-accessibility") | (None, _) => DesktopTargetPid::Any,
            (Some(target), _) => target()?,
        };
        match pid {
            DesktopTargetPid::MainNotRunning => {
                return Err(DesktopAutomationError::unchanged(
                    DesktopAutomationIssue::ClaudeNotRunning,
                )
                .into());
            }
            DesktopTargetPid::Pid(_) if LINK_COMMANDS.contains(&command.as_str()) => {
                return Err(DesktopAutomationError::unchanged(
                    DesktopAutomationIssue::DesktopUiUnsupported,
                )
                .into());
            }
            DesktopTargetPid::Pid(pid) => {
                request.insert("pid".into(), json!(pid));
            }
            DesktopTargetPid::Any => {}
        }
        let request = Value::Object(request);
        let raw = match &self.executor {
            Some(executor) => executor(request)?,
            None => run_helper(&self.helper, &request)?,
        };
        let Value::Object(reply) = raw else {
            return Err(DesktopAutomationIssue::DesktopUiUnsupported.into());
        };
        if reply.get("ok") != Some(&Value::Bool(true)) {
            let issue = reply
                .get("issue")
                .and_then(Value::as_str)
                .and_then(DesktopAutomationIssue::parse)
                .unwrap_or(DesktopAutomationIssue::DesktopUiUnsupported);
            let step = reply
                .get("step")
                .and_then(Value::as_str)
                .and_then(DesktopAutomationStep::parse_send_step);
            return Err(DesktopAutomationError::with_step(issue, false, step).into());
        }
        Ok(reply)
    }

    fn snapshot(reply: &Map<String, Value>) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        valid_snapshot(reply.get("snapshot"))
            .ok_or_else(|| DesktopAutomationIssue::DesktopUiUnsupported.into())
    }
}

fn request(command: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("command".into(), Value::String(command.into()));
    map
}

fn guard_value(guard: &impl Serialize) -> Value {
    serde_json::to_value(guard).unwrap_or(Value::Null)
}

impl DesktopAutomation for NativeDesktopAutomation {
    fn supports_request_accessibility(&self) -> bool {
        true
    }
    fn request_accessibility(&self) -> Result<bool, DesktopHostError> {
        Ok(self
            .call(request("request-accessibility"))?
            .get("accessibilityGranted")
            == Some(&Value::Bool(true)))
    }
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Self::snapshot(&self.call(request("inspect"))?)
    }
    fn open_session(
        &self,
        local_session_id: &str,
        options: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError> {
        if !is_local_session_id(local_session_id) {
            return Err(DesktopAutomationIssue::ExactSessionNotObserved.into());
        }
        let mut r = request("open-session");
        r.insert(
            "localSessionId".into(),
            Value::String(local_session_id.into()),
        );
        if options.and_then(|o| o.require_idle) == Some(true) {
            r.insert("requireIdle".into(), Value::Bool(true));
        }
        self.call(r).map(drop)
    }
    fn open_new_session(
        &self,
        options: Option<OpenSessionOptions>,
    ) -> Result<(), DesktopHostError> {
        let mut r = request("open-new-session");
        if options.and_then(|o| o.require_idle) == Some(true) {
            r.insert("requireIdle".into(), Value::Bool(true));
        }
        self.call(r).map(drop)
    }
    fn set_permission(
        &self,
        guard: &DesktopAutomationGuard,
        mode: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        if !MODES.contains(&mode) {
            return Err(DesktopAutomationIssue::PermissionModeMismatch.into());
        }
        let mut r = request("set-permission");
        r.insert("guard".into(), guard_value(guard));
        r.insert("mode".into(), Value::String(mode.into()));
        Self::snapshot(&self.call(r)?)
    }
    fn supports_cancel_quota_resume(&self) -> bool {
        true
    }
    fn cancel_quota_resume(
        &self,
        guard: &DesktopAutomationGuard,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        let mut r = request("cancel-quota-resume");
        r.insert("guard".into(), guard_value(guard));
        Self::snapshot(&self.call(r)?)
    }
    fn supports_answer_quit_guard(&self) -> bool {
        true
    }
    fn answer_quit_guard(&self) -> Result<bool, DesktopHostError> {
        let mut r = request("quit-guard");
        r.insert("answer".into(), Value::String("quit-anyway".into()));
        Ok(self.call(r)?.get("pressed") == Some(&Value::Bool(true)))
    }
    fn send(
        &self,
        guard: &DesktopAutomationGuard,
        request_id: &str,
        text: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        if !REQUEST.is_match(request_id)
            || text.is_empty()
            || js_length(text) > 8192
            || text.contains('\0')
        {
            return Err(DesktopAutomationIssue::DesktopUiUnsupported.into());
        }
        let mut r = request("send");
        r.insert("guard".into(), guard_value(guard));
        r.insert("requestId".into(), Value::String(request_id.into()));
        r.insert("text".into(), Value::String(text.into()));
        let reply = self.call(r)?;
        Ok(DesktopSendResult {
            accepted_visible: reply.get("acceptedVisible") == Some(&Value::Bool(true)),
            written: (reply.get("written").and_then(Value::as_str) == Some("paste"))
                .then_some(SendWritten::Paste),
            submitted: (reply.get("submitted").and_then(Value::as_str) == Some("return"))
                .then_some(SendSubmitted::Return),
            after: valid_send_after(reply.get("after")),
        })
    }
    fn write_draft(
        &self,
        guard: &DesktopDraftGuard,
        text: &str,
        options: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        if text.is_empty() || js_length(text) > MAX_DRAFT_LENGTH || text.contains('\0') {
            return Err(DesktopAutomationIssue::DesktopUiUnsupported.into());
        }
        let keys = options.and_then(|o| o.keys_idle_ms);
        if let Some(keys) = keys
            && !(keys.fract() == 0.0 && (500.0..=3_000.0).contains(&keys))
        {
            return Err(DesktopAutomationIssue::DesktopUiUnsupported.into());
        }
        let mut r = request("write-draft");
        r.insert("guard".into(), guard_value(guard));
        r.insert("text".into(), Value::String(text.into()));
        if let Some(keys) = keys {
            r.insert("keysIdleMs".into(), json!(keys as i64));
        }
        Self::snapshot(&self.call(r)?)
    }
    fn has_request_marker(&self, request_id: &str) -> Result<bool, DesktopHostError> {
        if !REQUEST.is_match(request_id) {
            return Err(DesktopAutomationIssue::DesktopUiUnsupported.into());
        }
        let mut r = request("lookup");
        r.insert("requestId".into(), Value::String(request_id.into()));
        Ok(self.call(r)?.get("markerPresent") == Some(&Value::Bool(true)))
    }
}

/// Waits between read-only delivery lookups (`deliveryWait`).
pub type DeliveryWait = Box<dyn Fn(u64) + Send + Sync>;

/// Production AX transport, with its actual limitations exposed. In particular, it must not
/// satisfy `ContinuationEngine`'s atomic or exactly-once contract.
pub struct DesktopContinuationHost<A, E> {
    automation: A,
    evidence: E,
    delivery_wait: DeliveryWait,
}

/// What `observed` proves: the selected conversation, stopped, as the evidence reads it.
struct Observed {
    snapshot: DesktopAutomationSnapshot,
    state: DesktopContinuationObservation,
}

impl<A: DesktopAutomation, E: DesktopContinuationEvidence> DesktopContinuationHost<A, E> {
    pub fn new(automation: A, evidence: E) -> Self {
        Self::with_delivery_wait(
            automation,
            evidence,
            Box::new(|ms| std::thread::sleep(Duration::from_millis(ms))),
        )
    }
    pub fn with_delivery_wait(automation: A, evidence: E, delivery_wait: DeliveryWait) -> Self {
        DesktopContinuationHost {
            automation,
            evidence,
            delivery_wait,
        }
    }
    pub fn automation(&self) -> &A {
        &self.automation
    }
    pub fn evidence(&self) -> &E {
        &self.evidence
    }

    /// `capabilities`.
    pub fn host_capabilities() -> ContinuationCapabilities {
        ContinuationCapabilities {
            kind: ContinuationHostKind::GuardedNative,
            contract_id: "macos-accessibility-guarded-new-turn-v1".into(),
            exact_session: true,
            conditional_actions: true,
            idempotent_delivery: false,
            delivery_lookup: true,
            checkpoint: true,
            account_switch: true,
            session_reopen: true,
            targeted_send: true,
            delivery_receipt: true,
            atomic_context_guard: false,
        }
    }

    fn observed(&self, expected_revision: Option<f64>) -> Result<Observed, DesktopHostError> {
        use DesktopAutomationIssue::*;
        let snapshot = self.automation.inspect()?;
        let state = self.evidence.read(&snapshot)?;
        if !is_local_session_id(&state.local_session_id)
            || snapshot.local_session_id.as_deref() != Some(state.local_session_id.as_str())
        {
            return Err(ExactSessionNotObserved.into());
        }
        if expected_revision.is_some_and(|r| state.state.context_revision != r) {
            return Err(ContextChanged.into());
        }
        if snapshot.permission_mode.as_deref() != Some(state.state.session.permission_mode.as_str())
        {
            return Err(PermissionModeMismatch.into());
        }
        if snapshot.status != SessionStatus::Stopped
            || state.state.session.status != SessionStatus::Stopped
        {
            return Err(DesktopWorkActive.into());
        }
        Ok(Observed { snapshot, state })
    }

    /// `readState`, with the Desktop alias kept.
    pub fn read_observation(&self) -> Result<DesktopContinuationObservation, DesktopHostError> {
        let snapshot = self.automation.inspect()?;
        self.evidence.read(&snapshot)
    }

    /// Call only after explicit opt-in and fresh target/history quota preflight.
    pub fn cancel_quota_resume(
        &self,
        expected_context_revision: f64,
    ) -> Result<DesktopContinuationObservation, DesktopHostError> {
        use DesktopAutomationIssue::*;
        let Observed { snapshot, state } =
            self.observed(Some(expected_context_revision))
                .map_err(|error| {
                    DesktopAutomationError::unchanged(
                        error.issue().unwrap_or(DesktopObservationIncomplete),
                    )
                })?;
        let q = &state.state.quiescence;
        if state.quota_stop.is_none()
            || snapshot.quota_auto_resume != Some(true)
            || !self.automation.supports_cancel_quota_resume()
            || q.coverage != QuiescenceCoverage::GuardedLocal
            || q.scheduled_wakeups != 1.0
            || [
                q.busy_workers,
                q.subagents,
                q.pending_tasks,
                q.waiting,
                q.queued_prompts,
                q.unknown_work,
            ]
            .iter()
            .any(|value| *value != 0.0)
        {
            return Err(DesktopAutomationError::unchanged(DesktopWorkActive).into());
        }
        let changed = self
            .automation
            .cancel_quota_resume(&automation_guard(&snapshot)?)?;
        let fresh = self.evidence.read(&changed)?;
        if changed.quota_auto_resume != Some(false)
            || fresh.state.session.id != state.state.session.id
            || fresh.state.session.transcript_revision != state.state.session.transcript_revision
            || fresh.state.session.permission_mode != state.state.session.permission_mode
            || fresh.state.identity.profile_id != state.state.identity.profile_id
        {
            return Err(ContextChanged.into());
        }
        Ok(fresh)
    }

    pub fn checkpoint_desktop(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, DesktopHostError> {
        let Observed { state, .. } = self.observed(Some(input.expected_context_revision))?;
        require_quiescence(&state.state)?;
        require_session(&state.state.session, &input.session)?;
        self.evidence.checkpoint(input)
    }

    pub fn switch_account_desktop(
        &self,
        input: &ContinuationSwitchInput,
    ) -> Result<(), DesktopHostError> {
        let Observed { state, .. } = self.observed(Some(input.expected_context_revision))?;
        require_quiescence(&state.state)?;
        self.evidence.switch_account(input)
    }

    pub fn reopen_session_desktop(
        &self,
        input: &ContinuationReopenInput,
    ) -> Result<(), DesktopHostError> {
        use DesktopAutomationIssue::*;
        let before = self.evidence.read(&self.automation.inspect()?)?;
        if before.state.context_revision != input.expected_context_revision {
            return Err(ContextChanged.into());
        }
        require_identity(&before.state.identity, &input.target)?;
        require_quiescence(&before.state)?;
        let local_session_id = self.evidence.local_session_id(&input.checkpoint)?;
        self.automation.open_session(&local_session_id, None)?;
        // A requested navigation is not a successful reopen. Observe the loaded ID.
        let mut snapshot = self.automation.inspect()?;
        let mut state = self.evidence.read(&snapshot)?;
        require_identity(&state.state.identity, &input.target)?;
        require_quiescence(&state.state)?;
        if snapshot.local_session_id.as_deref() != Some(local_session_id.as_str())
            || state.local_session_id != local_session_id
        {
            return Err(ExactSessionNotObserved.into());
        }
        let checkpoint = &input.checkpoint.session;
        if state.state.session.id != checkpoint.id
            || state.state.session.project_key != checkpoint.project_key
            || state.state.session.transcript_revision != checkpoint.transcript_revision
        {
            return Err(ExactSessionNotObserved.into());
        }
        if snapshot.status != SessionStatus::Stopped
            || state.state.session.status != SessionStatus::Stopped
        {
            return Err(DesktopWorkActive.into());
        }
        if snapshot.permission_mode.as_deref() != Some(checkpoint.permission_mode.as_str()) {
            snapshot = self
                .automation
                .set_permission(&automation_guard(&snapshot)?, &checkpoint.permission_mode)?;
            state = self.evidence.read(&snapshot)?;
        }
        require_session(&state.state.session, checkpoint)?;
        if snapshot.permission_mode.as_deref() != Some(checkpoint.permission_mode.as_str()) {
            return Err(PermissionModeMismatch.into());
        }
        Ok(())
    }

    pub fn send_continuation_desktop(
        &self,
        input: &ContinuationSendInput,
    ) -> Result<ContinuationDelivery, DesktopHostError> {
        let previous = self.evidence.lookup_delivery(&input.request_id)?;
        if previous.status != DeliveryStatus::Absent {
            return Ok(previous);
        }
        let Observed { snapshot, state } = self.observed(Some(input.expected_context_revision))?;
        require_identity(&state.state.identity, &input.target)?;
        require_session(&state.state.session, &input.session)?;
        require_quiescence(&state.state)?;
        if !snapshot.composer_empty {
            return Err(DesktopAutomationIssue::ComposerNotEmpty.into());
        }
        self.automation.send(
            &automation_guard(&snapshot)?,
            &input.request_id,
            &input.text,
        )?;
        // Never fabricate a receipt from a button click or visible text. A durable receiver
        // transcript must establish the new user turn under this identity.
        let mut delivery = self.evidence.lookup_delivery(&input.request_id)?;
        // Read-only polling allows the receiver's first assistant row to arrive; with high
        // effort the first thinking block can take minutes. There is never another send
        // attempt, even after an ambiguous outcome.
        let mut attempt = 0;
        while attempt < 110
            && matches!(
                delivery.status,
                DeliveryStatus::Absent | DeliveryStatus::Accepted
            )
        {
            (self.delivery_wait)(if attempt < 10 { 500 } else { 2_000 });
            delivery = self.evidence.lookup_delivery(&input.request_id)?;
            attempt += 1;
        }
        Ok(if delivery.status == DeliveryStatus::Absent {
            ContinuationDelivery {
                status: DeliveryStatus::Unknown,
                receipt: None,
            }
        } else {
            delivery
        })
    }
}

fn require_quiescence(state: &ContinuationState) -> Result<(), DesktopHostError> {
    let q = &state.quiescence;
    if q.coverage != QuiescenceCoverage::GuardedLocal {
        return Err(DesktopAutomationIssue::DesktopObservationIncomplete.into());
    }
    let safe = |n: f64| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0;
    if q.counters().iter().any(|(_, n)| !safe(*n) || *n != 0.0) {
        return Err(DesktopAutomationIssue::DesktopWorkActive.into());
    }
    Ok(())
}

fn require_identity(
    a: &ContinuationIdentity,
    b: &ContinuationIdentity,
) -> Result<(), DesktopHostError> {
    if a.profile_id != b.profile_id
        || a.account_uuid.to_lowercase() != b.account_uuid.to_lowercase()
        || a.org_id.to_lowercase() != b.org_id.to_lowercase()
    {
        return Err(DesktopAutomationIssue::ContextChanged.into());
    }
    Ok(())
}

fn require_session(
    a: &ContinuationSession,
    b: &ContinuationSession,
) -> Result<(), DesktopHostError> {
    if a.id.to_lowercase() != b.id.to_lowercase()
        || a.project_key != b.project_key
        || a.transcript_revision != b.transcript_revision
    {
        return Err(DesktopAutomationIssue::ExactSessionNotObserved.into());
    }
    if a.permission_mode != b.permission_mode {
        return Err(DesktopAutomationIssue::PermissionModeMismatch.into());
    }
    Ok(())
}

impl<A: DesktopAutomation, E: DesktopContinuationEvidence> ContinuationHost
    for DesktopContinuationHost<A, E>
{
    fn capabilities(&self) -> ContinuationCapabilities {
        Self::host_capabilities()
    }
    fn read_state(&self) -> Result<ContinuationState, ContinuationError> {
        Ok(self.read_observation()?.state)
    }
    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, ContinuationError> {
        Ok(self.checkpoint_desktop(input)?)
    }
    fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), ContinuationError> {
        Ok(self.switch_account_desktop(input)?)
    }
    fn reopen_session(&self, input: &ContinuationReopenInput) -> Result<(), ContinuationError> {
        Ok(self.reopen_session_desktop(input)?)
    }
    fn send_continuation(
        &self,
        input: &ContinuationSendInput,
    ) -> Result<ContinuationDelivery, ContinuationError> {
        Ok(self.send_continuation_desktop(input)?)
    }
    fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, ContinuationError> {
        Ok(self.evidence.lookup_delivery(request_id)?)
    }
}
