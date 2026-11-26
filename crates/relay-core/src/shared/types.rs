//! Port of `shared/types.ts`: the data types the main process persists and sends over IPC.
//! The `RelayAPI`/`RelaySwitchAPI` method tables stay in TS; every type they carry is here, with
//! their inline argument and result shapes as named structs.

pub mod js;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use self::js::{JsMap, ser_num, ser_opt_num};

pub use super::backup::{
    BackupExportResult, BackupFileChoice, BackupImportMode, BackupImportResult, BackupSummary,
};
pub use super::browser_extension::{
    ExtensionCurrent, ExtensionInstance, ExtensionMode, ExtensionOffer, ExtensionOutcome,
    ExtensionSetting, ExtensionStatus, ExtensionTarget,
};
pub use super::feature_risk::{FeatureRiskId, RiskAcknowledgements};
pub use super::lost_found::{LostFoundCollection, LostFoundWeek, LostItem};
pub use super::meters::{MeterProvider, MeterReading};
pub use super::overflow::{
    OverflowConfigureInput, OverflowStatus, OverflowTestResult, OverflowUpstreamInput,
};
pub use super::proxy_types::{
    ProxyClassShare, ProxyClientId, ProxyConfig, ProxyLoopAlarm, ProxyPick, ProxyPickReason,
    ProxyRequestLog, ProxySessionView, RoutingStrategy,
};
pub use super::routes::{Destination, PageId, PageIntent};
pub use super::tempo::Tempo;
pub use super::terminal_identity::{TerminalMode, TerminalOutcome, TerminalStatus};
pub use super::token_usage_view::TokenUsageView;
pub use super::usage_statistics_view::UsageStatisticsView;
pub use crate::desktop_continuation::DesktopContinuationSnapshot;
pub use crate::draft_vault::DraftSummary;
pub use relay_i18n::{LanguagePref, Locale};

/// Declares a string-literal union as a serde enum with `as_str`.
macro_rules! literal_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant,)+
        }
        impl $name {
            /// The literal as TS writes it.
            pub const fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text,)+ }
            }
        }
    };
}
pub(crate) use literal_enum;

literal_enum!(AccountKind { Personal = "personal", Work = "work" });
literal_enum!(AccountPlan { Unknown = "unknown", Pro = "pro", Max5 = "max5", Max20 = "max20", Team = "team" });
literal_enum!(AccountProvider { Claude = "claude", Codex = "codex", Antigravity = "antigravity", Gemini = "gemini" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPlanning {
    pub plan: AccountPlan,
    #[serde(serialize_with = "ser_num")]
    pub capacity_weight: f64,
}

/// The saved Claude app sign-in of an account.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDesktop {
    pub account_uuid: String,
    pub org_id: String,
    pub saved_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Set when the saved Claude app sign-in ended; no unattended switch goes to it until renewed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected_at: Option<String>,
}

/// The account's Claude Code sign-in, as last checked.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuth {
    pub logged_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
    /// The plan read from the sign-in (never `unknown`); it fills `planning.plan`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<AccountPlan>,
    pub checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub kind: AccountKind,
    pub group: String,
    pub color: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<AccountProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<AccountPlanning>,
    /// The used percent at which automatic switching leaves this account; missing means the global line.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub switch_at_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<AccountDesktop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AccountAuth>,
}

impl Account {
    /// A bare account: what tests and new records start from.
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Account {
            id: id.into(),
            name: name.into(),
            kind: AccountKind::Personal,
            group: "Personal".into(),
            color: String::new(),
            created_at: String::new(),
            provider: None,
            cooldown_until: None,
            planning: None,
            switch_at_percent: None,
            desktop: None,
            auth: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub key: String,
    pub id: String,
    pub account_id: String,
    pub project_dir: String,
    pub project_name: String,
    pub title: String,
    pub updated_at: String,
    #[serde(serialize_with = "ser_num")]
    pub messages: f64,
    #[serde(serialize_with = "ser_num")]
    pub bytes: f64,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<String>,
}

literal_enum!(RunKind { Session = "session", Desktop = "desktop" });
literal_enum!(RunStatus { Running = "running", Exited = "exited" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub account_id: String,
    pub title: String,
    pub cwd: String,
    pub kind: RunKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    pub status: RunStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub exit_code: Option<f64>,
}

literal_enum!(DiagnosticsSource { Chosen = "chosen", Path = "path", ClaudeApp = "claude-app" });

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    /// Chosen in Settings, found in the usual places, or the one the Claude app downloaded for Code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DiagnosticsSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub desktop_supported: bool,
    /// Limits can be read through the Claude app's own sign-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_usage: Option<bool>,
    pub platform: String,
    pub data_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

literal_enum!(AuthFlowStatus {
    Starting = "starting",
    Waiting = "waiting",
    Verifying = "verifying",
    Connected = "connected",
    Failed = "failed",
    Cancelled = "cancelled",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthFlow {
    pub id: String,
    pub account_id: String,
    pub status: AuthFlowStatus,
    pub browser_ready: bool,
    pub code_requested: bool,
    /// The sign-in page was opened in Relay's own window for the account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_window: Option<bool>,
    /// Relay can show the page in its own window, beside the system browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_available: Option<bool>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Relay renews this sign-in by itself in a hidden window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
}

/// The Code sidebar sections the account switched to lacks, as counts and account names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarGapSummary {
    pub id: String,
    pub to: String,
    pub from: Vec<String>,
    #[serde(serialize_with = "ser_num")]
    pub missing_sections: f64,
    #[serde(serialize_with = "ser_num")]
    pub sessions: f64,
}

/// Whether each global shortcut is registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStates {
    pub open_panel: ShortcutState,
    pub switch_to_suggested: ShortcutState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: RelaySettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_switch: Option<AutoSwitchState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<DesktopContinuationSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fleet: Option<FleetContinuationState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<KeeperSnapshot>,
    /// The drafts rescued at switches: summaries only, never their text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drafts: Option<Vec<DraftSummary>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar: Option<SidebarGapSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<ExtensionOffer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<SeparateWindows>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcuts: Option<ShortcutStates>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub antigravity: Option<AntigravityAppState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meters: Option<Vec<MeterReading>>,
    pub usage: JsMap<AccountUsage>,
    pub auth_flows: Vec<AuthFlow>,
    /// Sign-ins being made for the terminal, one per account at most.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_flows: Option<Vec<AuthFlow>>,
    pub accounts: Vec<Account>,
    pub sessions: Vec<Session>,
    pub runs: Vec<Run>,
    pub diagnostics: Diagnostics,
    pub import_enabled: bool,
    pub warnings: Vec<String>,
}

literal_enum!(AntigravityBusy { Switching = "switching", SigningIn = "signing-in" });

/// The Antigravity app, as Relay sees it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAppState {
    pub installed: bool,
    pub can_open: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_sign_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_switch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy: Option<AntigravityBusy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AntigravityAppResult>,
}

literal_enum!(AntigravityResultKind {
    Switched = "switched",
    Saved = "saved",
    SavedOther = "saved-other",
    Other = "other",
    Cancelled = "cancelled",
    Failed = "failed",
});
literal_enum!(AntigravityResultReason {
    NotSaved = "not-saved",
    StillRunning = "still-running",
    Keychain = "keychain",
    VerifyFailed = "verify-failed",
    Busy = "busy",
    Timeout = "timeout",
    Save = "save",
    Launch = "launch",
    Cancelled = "cancelled",
    Unexpected = "unexpected",
});

/// How the last Antigravity switch or sign-in ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAppResult {
    pub kind: AntigravityResultKind,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<AntigravityResultReason>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub agy_running: Option<f64>,
    #[serde(serialize_with = "ser_num")]
    pub at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindow {
    pub account_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub opened_at: Option<f64>,
}

/// Separate Claude windows (macOS only).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateWindows {
    pub supported: bool,
    pub enabled: bool,
    pub open: Vec<OpenWindow>,
    #[serde(serialize_with = "ser_num")]
    pub others: f64,
}

literal_enum!(UpdateStatus {
    Idle = "idle",
    Checking = "checking",
    UpToDate = "up-to-date",
    Available = "available",
    Downloading = "downloading",
    Ready = "ready",
    Installing = "installing",
    Manual = "manual",
    Error = "error",
});
literal_enum!(UpdateManualReason {
    NoAsset = "no-asset",
    Location = "location",
    NotWritable = "not-writable",
    NotAppimage = "not-appimage",
});

/// Relay's own update, as the main process sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: UpdateStatus,
    pub current: String,
    pub auto_check: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes_url: Option<String>,
    /// Download progress, 0–1, while downloading.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_reason: Option<UpdateManualReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccount {
    pub name: String,
    pub kind: AccountKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<AccountProvider>,
}

/// What removing an account did.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRemoved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_out: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_consent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_consent: Option<bool>,
}

/// A terminal's output or exit, pushed on `relay:terminal` (with its `sequence` when known).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub exit_code: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub sequence: Option<f64>,
}

literal_enum!(TranscriptRole { User = "user", Assistant = "assistant" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptMessage {
    pub role: TranscriptRole,
    pub text: String,
}

literal_enum!(FleetStatus {
    Off = "off",
    Watching = "watching",
    Waiting = "waiting",
    Switching = "switching",
    Continuing = "continuing",
    Attention = "attention",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetLast {
    pub at: String,
    pub source_id: String,
    pub target_id: String,
    #[serde(serialize_with = "ser_num")]
    pub conversations: f64,
    #[serde(serialize_with = "ser_num")]
    pub started: f64,
    #[serde(serialize_with = "ser_num")]
    pub uncertain: f64,
    #[serde(serialize_with = "ser_num")]
    pub skipped: f64,
}

/// "Switch and continue" for every local Code conversation, kept on until turned off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetContinuationState {
    pub enabled: bool,
    pub status: FleetStatus,
    /// Machine-readable reason, localized by the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub stopped: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<FleetLast>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgHint {
    pub org_id: String,
    pub certain: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub available: bool,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_account_uuid: Option<String>,
    pub organizations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_hint: Option<OrgHint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_profile_id: Option<String>,
    pub busy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub recovery_required: bool,
    #[serde(serialize_with = "ser_num")]
    pub error_revision: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_backup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_capture: Option<AutoCaptureState>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub windows: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_status: Option<ProxyStatus>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    #[serde(serialize_with = "ser_num")]
    pub input: f64,
    #[serde(serialize_with = "ser_num")]
    pub output: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_read: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_write: f64,
}

literal_enum!(GatewayWaitReason { Limit = "limit", Auth = "auth", Transient = "transient" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatewayWaiting {
    pub reason: GatewayWaitReason,
    #[serde(serialize_with = "ser_num")]
    pub minutes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PercentCost {
    #[serde(serialize_with = "ser_num")]
    pub dollars: f64,
    #[serde(serialize_with = "ser_num")]
    pub windows: f64,
}

literal_enum!(ExtraUsageStatusKind { Billed = "billed", Required = "required" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsageStatus {
    pub kind: ExtraUsageStatusKind,
    #[serde(serialize_with = "ser_num")]
    pub minutes_ago: f64,
}

literal_enum!(GatewaySignIn { Missing = "missing", Expired = "expired" });

/// One account as the Proxy Gateway sees it, for the routing monitor.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAccountStatus {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<AccountProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub active: bool,
    pub signed_in: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub quota_percent: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub reset_in_minutes: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub five_hour_percent: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub five_hour_reset_minutes: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub weekly_percent: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub weekly_reset_minutes: Option<f64>,
    pub in_pool: bool,
    #[serde(serialize_with = "ser_num")]
    pub requests: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenTotals>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<GatewayWaiting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub full_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent_cost: Option<PercentCost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_usage: Option<ExtraUsageStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_sign_in: Option<GatewaySignIn>,
}

/// A client tool Relay can point at the gateway, and whether it is now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyClientStatus {
    pub id: ProxyClientId,
    pub installed: bool,
    pub bound: bool,
    pub stale: bool,
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStats {
    #[serde(serialize_with = "ser_num")]
    pub total_requests: f64,
    #[serde(serialize_with = "ser_num")]
    pub active_requests: f64,
    #[serde(serialize_with = "ser_num")]
    pub prompt_cache_hits: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_hit_rate: f64,
}

/// Where a new session of a model with its own limit goes, when that differs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextPickByModel {
    pub model: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// The account a new session of a provider would get now, and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextPick {
    pub account_id: String,
    pub reason: ProxyPickReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearly_full: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_model: Option<Vec<NextPickByModel>>,
}

/// What the Proxy Gateway page shows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    #[serde(serialize_with = "ser_num")]
    pub port: f64,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_strategy: Option<RoutingStrategy>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub affinity_ttl_seconds: Option<f64>,
    pub stats: ProxyStats,
    pub accounts: Vec<ProxyAccountStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent: Option<Vec<ProxyRequestLog>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailscale_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clients: Option<Vec<ProxyClientStatus>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_overflow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<ProxySessionView>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alarms: Option<Vec<ProxyLoopAlarm>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_share: Option<Vec<ProxyClassShare>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<OverflowStatus>,
    /// `Partial<Record<AccountProvider, …>>`, in the order main fills it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_pick: Option<IndexMap<AccountProvider, NextPick>>,
}

/// Local session discovered on disk for 1-click onboarding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProviderSession {
    pub provider: AccountProvider,
    pub detected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub already_linked_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub already_linked_account_name: Option<String>,
}

literal_enum!(CascadeLayerStatus { Done = "done", Ready = "ready", Skipped = "skipped", Pending = "pending" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneClickConnectInput {
    pub provider: AccountProvider,
    pub name: String,
    pub kind: AccountKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Codex only: an OpenAI API key typed by the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// `Pick<OneClickConnectInput, "name" | "kind" | "group">`, the Antigravity sign-in's start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AntigravityOAuthInput {
    pub name: String,
    pub kind: AccountKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CascadeLayers {
    pub desktop: CascadeLayerStatus,
    pub usage: CascadeLayerStatus,
    pub terminal: CascadeLayerStatus,
    pub extension_and_proxy: CascadeLayerStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneClickCascadeResult {
    pub account: Account,
    pub layers: CascadeLayers,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_sign_in: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityOAuthStart {
    pub account_id: String,
    pub state: String,
}

/// `AntigravityOAuthStart & { url }`: the localhost address the browser ended on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityCallback {
    pub account_id: String,
    pub state: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AntigravityOAuthPoll {
    Wait,
    Ok { result: Box<OneClickCascadeResult> },
    Error { error: String },
}

literal_enum!(AutoCaptureStatus {
    Waiting = "waiting",
    ChooseOrg = "choose-org",
    Saving = "saving",
    Saved = "saved",
    Failed = "failed",
});

/// The automatic save of a Claude app sign-in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCaptureState {
    pub account_id: String,
    pub status: AutoCaptureStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orgs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_org: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub already_saved: Option<String>,
    /// "timeout", "other-pending", or the save's own error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

literal_enum!(DesktopOperationKind {
    Switch = "switch",
    Save = "save",
    Link = "link",
    CancelLink = "cancel-link",
    Merge = "merge",
    Restore = "restore",
    Window = "window",
});

/// An operation about to quit Claude (`start`, once), then its end (`end`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub enum DesktopRestartEvent {
    #[serde(rename_all = "camelCase")]
    Start {
        kind: DesktopOperationKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    End {
        kind: DesktopOperationKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
        ok: bool,
    },
}

/// How Relay starts Claude.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLaunchChoice {
    pub quic_off: bool,
}

/// `Partial<ClaudeLaunchChoice>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLaunchPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quic_off: Option<bool>,
}

literal_enum!(MenuBarItem {
    FiveHour = "five-hour",
    Week = "week",
    Reset = "reset",
    Tokens = "tokens",
    Cost = "cost",
    Account = "account",
});

/// What the menu bar title shows, in order.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MenuBarTitleChoice {
    pub items: Vec<MenuBarItem>,
}

/// Each menu bar item's value on its own (`Record<MenuBarItem, string>`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MenuBarValues {
    #[serde(rename = "five-hour")]
    pub five_hour: String,
    pub week: String,
    pub reset: String,
    pub tokens: String,
    pub cost: String,
    pub account: String,
}

/// The menu bar as it is now.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MenuBarNow {
    pub title: String,
    pub values: MenuBarValues,
}

literal_enum!(Appearance { System = "system", Light = "light", Dark = "dark" });
literal_enum!(DesktopHistoryTransfer { All = "all", SameGroup = "same-group", Selected = "selected", Off = "off" });
literal_enum!(AutoSwitchMode { Off = "off", AfterExit = "after-exit" });

fn default_appearance() -> Appearance {
    Appearance::System
}
fn default_auto_switch_mode() -> AutoSwitchMode {
    AutoSwitchMode::Off
}

/// The settings in state.json, in `settingsSchema`'s order (strict: unknown keys are refused).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelaySettings {
    /// Window theme; "system" follows macOS.
    #[serde(default = "default_appearance")]
    pub appearance: Appearance,
    /// The local Proxy Gateway; changed through the proxy calls, never through updateSettings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
    pub planning: PlanningSettings,
    /// 0, 5, 15 or 30.
    pub usage_refresh_minutes: u32,
    /// 80, 90 or 95.
    pub usage_warning_percent: u32,
    pub usage_warnings: bool,
    pub suggest_accounts: bool,
    pub desktop_history_transfer: DesktopHistoryTransfer,
    #[serde(default)]
    pub desktop_history_accounts: Vec<String>,
    #[serde(default = "default_auto_switch_mode")]
    pub auto_switch_mode: AutoSwitchMode,
    #[serde(default)]
    pub auto_switch_accounts: Vec<String>,
    /// 2: registries from before "all" existed had "same-group" moved to "all" once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_policy_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu_bar_animation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switch_window: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pranks: Option<PrankLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_retype: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_extension: Option<ExtensionSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_cli: Option<TerminalMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_at_login: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_channel: Option<UpdateChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcuts: Option<ShortcutSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_sync: Option<ConfigSyncSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_switch_strategy: Option<AutoSwitchStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_notify: Option<RemoteNotifySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meters: Option<Vec<MeterProvider>>,
    /// The risk text version the user accepted, by risky feature.
    #[serde(default)]
    pub risk_acknowledged: RiskAcknowledgements,
}

/// One choice per item a switch keeps the same across the accounts' Claude Code profiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigSyncSettings {
    pub mcp_servers: bool,
    pub skills: bool,
    pub settings: bool,
    pub claude_md: bool,
}

pub const DEFAULT_CONFIG_SYNC: ConfigSyncSettings = ConfigSyncSettings {
    mcp_servers: false,
    skills: false,
    settings: false,
    claude_md: false,
};

literal_enum!(PrankLevel { Sometimes = "sometimes", Rarely = "rarely", Off = "off" });
literal_enum!(
    /// "beta" also takes GitHub pre-releases.
    UpdateChannel { Stable = "stable", Beta = "beta" }
);
literal_enum!(
    /// What a global shortcut does.
    ShortcutAction { OpenPanel = "openPanel", SwitchToSuggested = "switchToSuggested" }
);

/// `Partial<Record<ShortcutAction, string>>`: a missing key means its default, `""` means off.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShortcutSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_panel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switch_to_suggested: Option<String>,
}

impl ShortcutSettings {
    pub fn get(&self, action: ShortcutAction) -> Option<&String> {
        match action {
            ShortcutAction::OpenPanel => self.open_panel.as_ref(),
            ShortcutAction::SwitchToSuggested => self.switch_to_suggested.as_ref(),
        }
    }
}

literal_enum!(
    /// A shortcut as registered: off, working, or held by another app.
    ShortcutState { Off = "off", On = "on", Taken = "taken" }
);
literal_enum!(
    /// How the next account is chosen among those that hold half an hour at the tempo.
    AutoSwitchStrategy { Best = "best", WeeklyFirst = "weekly-first", ConsumeFirst = "consume-first" }
);
literal_enum!(RemoteNotifyKind { Ntfy = "ntfy", Webhook = "webhook" });

/// Which events are posted: limit warnings, "ready again", automatic switches, ending sign-ins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteNotifyEvents {
    pub limit: bool,
    pub reset: bool,
    pub auto_switch: bool,
    pub sign_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteNotifySettings {
    /// https, or http to this computer; missing means off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub kind: RemoteNotifyKind,
    pub events: RemoteNotifyEvents,
}

/// The argument of `testRemoteNotify`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteNotifyTest {
    pub url: String,
    pub kind: RemoteNotifyKind,
}

literal_enum!(RemoteNotifyFailure { Off = "off", InvalidUrl = "invalid-url", Failed = "failed" });

/// A post's outcome; `error` is redacted and never names the URL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RemoteNotifyResult {
    Ok {
        /// Always `true`.
        ok: bool,
        #[serde(serialize_with = "ser_num")]
        status: f64,
    },
    Failed {
        /// Always `false`.
        ok: bool,
        reason: RemoteNotifyFailure,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            serialize_with = "ser_opt_num"
        )]
        status: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

literal_enum!(
    /// Whom the "ready again" notice is for.
    LimitResetNotice { Off = "off", InUse = "in-use", All = "all" }
);

/// One switch per notification type; each missing key means on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_five_hour: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_weekly: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_reset: Option<LimitResetNotice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switches: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_ins: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub early_start: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningAccount {
    pub id: String,
    /// Manual first warm-up clock (HH:mm), applied on every planned day.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_start: Option<String>,
}

literal_enum!(
    /// How fast the plan expects usage to be consumed; "auto" learns it.
    TempoChoice { Auto = "auto", Light = "light", Medium = "medium", Heavy = "heavy" }
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningSettings {
    pub auto_start: bool,
    pub time_zone: String,
    /// Monday–Friday, by the interval's start date.
    pub weekday: PlanningHours,
    /// Saturday and Sunday, by the interval's start date.
    pub weekend: PlanningHours,
    /// Planned accounts in priority order.
    pub accounts: Vec<PlanningAccount>,
    /// Missing means "auto".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tempo: Option<TempoChoice>,
    /// Re-plan the rest of the day at today's pace; missing means on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive: Option<bool>,
}

/// `Partial<PlanningSettings>`, the `updatePlanning` patch.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_start: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekday: Option<PlanningHours>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekend: Option<PlanningHours>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts: Option<Vec<PlanningAccount>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tempo: Option<TempoChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive: Option<bool>,
}

/// `DEFAULT_PLANNING`.
pub fn default_planning_settings() -> PlanningSettings {
    PlanningSettings {
        auto_start: false,
        time_zone: "Europe/Istanbul".into(),
        weekday: PlanningHours {
            enabled: true,
            start: "09:00".into(),
            end: "18:00".into(),
        },
        weekend: PlanningHours {
            enabled: false,
            start: "11:00".into(),
            end: "17:00".into(),
        },
        accounts: Vec::new(),
        tempo: Some(TempoChoice::Auto),
        adaptive: None,
    }
}

literal_enum!(WindowAttemptStatus {
    Started = "started",
    Verified = "verified",
    SentUnverified = "sent-unverified",
    Failed = "failed",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowAttempt {
    pub id: String,
    pub account_id: String,
    pub identity_key: String,
    pub at: String,
    pub status: WindowAttemptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
}

literal_enum!(KeeperAccountState {
    Off = "off",
    Outside = "outside",
    Active = "active",
    Due = "due",
    Waiting = "waiting",
    Blocked = "blocked",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperAccountStatus {
    pub account_id: String,
    pub state: KeeperAccountState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_start_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledStart {
    pub account_id: String,
    pub start_at: String,
}

/// Today's re-plan at today's pace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperAdaptation {
    /// Today's pace multiplier for the tempo (1–3).
    #[serde(serialize_with = "ser_num")]
    pub factor: f64,
    /// Pro units an hour over the last hour, when observed long enough.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub observed_rate: Option<f64>,
    /// Next window starts that differ from the plan, earliest first.
    pub schedule: Vec<ScheduledStart>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperNext {
    pub account_id: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperSnapshot {
    pub enabled: bool,
    pub running: bool,
    pub accounts: Vec<KeeperAccountStatus>,
    /// Most recent first, at most 20.
    pub attempts: Vec<WindowAttempt>,
    #[serde(serialize_with = "ser_num")]
    pub planned_today: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<KeeperNext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tempo: Option<Tempo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptation: Option<KeeperAdaptation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHistorySummary {
    pub profile_id: String,
    #[serde(serialize_with = "ser_num")]
    pub indexed: f64,
    #[serde(serialize_with = "ser_num")]
    pub archived: f64,
    #[serde(serialize_with = "ser_num")]
    pub projects: f64,
    #[serde(serialize_with = "ser_num")]
    pub transcripts_found: f64,
    #[serde(serialize_with = "ser_num")]
    pub missing_transcripts: f64,
    #[serde(serialize_with = "ser_num")]
    pub unknown_transcripts: f64,
    #[serde(serialize_with = "ser_num")]
    pub duplicates: f64,
    #[serde(serialize_with = "ser_num")]
    pub source_profiles: f64,
    pub checked_at: String,
}

/// `DEFAULT_SETTINGS`, in its key order.
pub fn default_settings() -> RelaySettings {
    RelaySettings {
        appearance: Appearance::System,
        proxy: Some(super::proxy_types::default_proxy_config()),
        planning: default_planning_settings(),
        usage_refresh_minutes: 5,
        usage_warning_percent: 90,
        usage_warnings: true,
        suggest_accounts: true,
        desktop_history_transfer: DesktopHistoryTransfer::SameGroup,
        desktop_history_accounts: Vec::new(),
        auto_switch_mode: AutoSwitchMode::Off,
        auto_switch_accounts: Vec::new(),
        history_policy_version: Some(2),
        menu_bar_animation: None,
        switch_window: None,
        pranks: None,
        draft_retype: None,
        claude_extension: None,
        terminal_cli: None,
        notifications: None,
        launch_at_login: Some(false),
        update_channel: Some(UpdateChannel::Stable),
        shortcuts: None,
        config_sync: Some(DEFAULT_CONFIG_SYNC),
        auto_switch_strategy: Some(AutoSwitchStrategy::Best),
        remote_notify: None,
        meters: None,
        risk_acknowledged: RiskAcknowledgements::default(),
    }
}

impl Default for RelaySettings {
    fn default() -> Self {
        default_settings()
    }
}

/// `Partial<Omit<RelaySettings, "proxy" | "riskAcknowledged">>`, the `updateSettings` patch.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<PlanningSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_refresh_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_warning_percent: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_warnings: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggest_accounts: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_history_transfer: Option<DesktopHistoryTransfer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_history_accounts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_switch_mode: Option<AutoSwitchMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_switch_accounts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_policy_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu_bar_animation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switch_window: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pranks: Option<PrankLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_retype: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_extension: Option<ExtensionSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_cli: Option<TerminalMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_at_login: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_channel: Option<UpdateChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcuts: Option<ShortcutSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_sync: Option<ConfigSyncSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_switch_strategy: Option<AutoSwitchStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_notify: Option<RemoteNotifySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meters: Option<Vec<MeterProvider>>,
}

literal_enum!(AutoSwitchReason {
    LedgerUnavailable = "ledger-unavailable",
    ExitSettling = "exit-settling",
    UnsupportedPlatform = "unsupported-platform",
    Disabled = "disabled",
    NotSelected = "not-selected",
    DesktopUnavailable = "desktop-unavailable",
    DesktopBusy = "desktop-busy",
    SeparateWindow = "separate-window",
    DesktopRecovery = "desktop-recovery",
    DesktopSignIn = "desktop-sign-in",
    BrowserSignIn = "browser-sign-in",
    ContinuationActive = "continuation-active",
    UnknownActive = "unknown-active",
    SourceNotReady = "source-not-ready",
    UsageNotFresh = "usage-not-fresh",
    QuotaAvailable = "quota-available",
    NoReadyTarget = "no-ready-target",
    ClaudeRunning = "claude-running",
    AlreadySwitched = "already-switched",
    RetryBackoff = "retry-backoff",
    SwitchFailed = "switch-failed",
    QuotaExhausted = "quota-exhausted",
    Prepared = "prepared",
});
literal_enum!(AutoSwitchStatus {
    Off = "off",
    Watching = "watching",
    Waiting = "waiting",
    Blocked = "blocked",
    Switching = "switching",
    Switched = "switched",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitchState {
    pub status: AutoSwitchStatus,
    pub reason: AutoSwitchReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
}

literal_enum!(
    /// Where a limit figure came from.
    LimitSource { Official = "official", AppSession = "app-session", Gateway = "gateway", Estimate = "estimate" }
);

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    #[serde(serialize_with = "ser_num")]
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<LimitSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

impl UsageWindow {
    /// A window `used_percent` full resetting at `resets_at`, untagged.
    pub fn new(used_percent: f64, resets_at: Option<&str>) -> Self {
        UsageWindow {
            used_percent,
            resets_at: resets_at.map(str::to_string),
            source: None,
            read_at: None,
        }
    }
}

literal_enum!(UsageIssue {
    ConnectCli = "connect-cli",
    CredentialsMissing = "credentials-missing",
    KeychainLocked = "keychain-locked",
    RenewalRequired = "renewal-required",
    Expired = "expired",
    Scope = "scope",
    IdentityMismatch = "identity-mismatch",
    RateLimited = "rate-limited",
    Unavailable = "unavailable",
    Unsupported = "unsupported",
});
literal_enum!(ModelWindowPeriod { FiveHour = "five_hour", SevenDay = "seven_day" });

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelWindow {
    /// API key, e.g. "seven_day_opus".
    pub key: String,
    pub label: String,
    #[serde(serialize_with = "ser_num")]
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    /// The model family the limit applies to ("fable", "opus"), lowercase.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The most of the weekly limit this model may take, in percent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub weekly_share: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<ModelWindowPeriod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<LimitSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

literal_enum!(UsageStatus { Idle = "idle", Loading = "loading", Ready = "ready", Error = "error" });
literal_enum!(UsageSource { Cli = "cli", Desktop = "desktop" });

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownReset {
    pub resets_at: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastKnownResets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<KnownReset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<KnownReset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_renewal_required: Option<bool>,
    pub status: UsageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_limit_reached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_windows: Option<Vec<ModelWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_at: Option<String>,
    pub stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<UsageSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_sign_in_ends_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_sign_in_ended: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<UsageIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
    /// Identity-bound history for display only, never fresh quota evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_known_resets: Option<LastKnownResets>,
}

impl AccountUsage {
    /// `{ accountId, status, stale: false }` with nothing else.
    pub fn new(account_id: impl Into<String>, status: UsageStatus) -> Self {
        AccountUsage {
            account_id: account_id.into(),
            connection_renewal_required: None,
            status,
            five_hour: None,
            seven_day: None,
            other_limit_reached: None,
            model_windows: None,
            checked_at: None,
            live_at: None,
            stale: false,
            source: None,
            cli_sign_in_ends_at: None,
            cli_sign_in_ended: None,
            issue: None,
            retry_at: None,
            last_known_resets: None,
        }
    }
}

// The inline argument and result shapes of the RelayAPI methods.

/// `getLanguage()`: the saved choice and the language it resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageState {
    #[serde(serialize_with = "ser_pref", deserialize_with = "de_pref")]
    pub pref: LanguagePref,
    #[serde(serialize_with = "ser_locale", deserialize_with = "de_locale")]
    pub locale: Locale,
}

fn ser_locale<S: serde::Serializer>(locale: &Locale, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(locale.as_str())
}

fn de_locale<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Locale, D::Error> {
    let text = String::deserialize(deserializer)?;
    Locale::parse(&text).ok_or_else(|| serde::de::Error::custom(format!("unknown locale: {text}")))
}

fn ser_pref<S: serde::Serializer>(pref: &LanguagePref, serializer: S) -> Result<S::Ok, S::Error> {
    match pref {
        LanguagePref::System => serializer.serialize_str("system"),
        LanguagePref::Locale(locale) => ser_locale(locale, serializer),
    }
}

fn de_pref<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<LanguagePref, D::Error> {
    let text = String::deserialize(deserializer)?;
    if text == "system" {
        return Ok(LanguagePref::System);
    }
    Locale::parse(&text)
        .map(LanguagePref::Locale)
        .ok_or_else(|| serde::de::Error::custom(format!("unknown language: {text}")))
}

/// `exportBackup(input)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportInput {
    pub passphrase: String,
    pub include_sign_ins: bool,
}

literal_enum!(WindowOpened { Opened = "opened", Shown = "shown" });

/// `proxyConfigure(input)`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigureInput {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub port: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_strategy: Option<RoutingStrategy>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub affinity_ttl_seconds: Option<f64>,
    /// Account ids in pool order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_order: Option<Vec<String>>,
    /// Accounts the gateway must not route to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_account_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_overflow: Option<bool>,
}

/// `claudeAppAccess()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeAppAccess {
    pub supported: bool,
    pub allowed: bool,
}

/// `claudeStatusline()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeStatuslineState {
    pub installed: bool,
    pub other: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
}

literal_enum!(RenewSignInOutcome {
    Connected = "connected",
    Waiting = "waiting",
    Busy = "busy",
    Unavailable = "unavailable",
    Failed = "failed",
});

/// `renewSignInNow()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenewSignInResult {
    pub result: RenewSignInOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `usageStatistics(input)` and `tokenUsage(input)`: a range of 7, 30 or 90 days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeInput {
    pub range: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// `terminalBuffer()`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TerminalBuffer {
    pub data: String,
    #[serde(serialize_with = "ser_num")]
    pub sequence: f64,
    pub status: RunStatus,
}

literal_enum!(ReopenWhere { Window = "window", Browser = "browser" });
