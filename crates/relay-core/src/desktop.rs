//! Port of `electron/core/desktop.ts`: Claude Desktop's accounts, switched by swapping its
//! sign-in files while it is closed, with a recoverable journal.

use std::path::{Path, PathBuf};

use crate::desktop_files::DesktopFileError;
use crate::desktop_instances::ClaudeWindowProcess;
use crate::desktop_launch::{ClaudeSignOut, LaunchWatch};
use crate::desktop_processes::ProcessError;
use crate::detached_exec::DetachedExecError;

/// Why a Desktop operation failed: the message the TS throws, and the error class it throws.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DesktopError {
    #[error("{0}")]
    Failed(String),
    /// `DesktopSwitchRefused`: called off by its guards before Claude was asked to quit.
    #[error("{0}")]
    SwitchRefused(String),
    /// `SignInNotSettled` (desktop-session.ts): the sign-in never reached the cookie file.
    #[error("{0}")]
    SignInNotSettled(String),
    /// `LockBusyError`: another Relay process holds the Desktop operation lock.
    #[error("{0}")]
    LockBusy(String),
}

impl DesktopError {
    pub fn new(message: impl Into<String>) -> DesktopError {
        DesktopError::Failed(message.into())
    }
    pub fn message(&self) -> &str {
        match self {
            DesktopError::Failed(m)
            | DesktopError::SwitchRefused(m)
            | DesktopError::SignInNotSettled(m)
            | DesktopError::LockBusy(m) => m,
        }
    }
}

impl From<String> for DesktopError {
    fn from(message: String) -> Self {
        DesktopError::Failed(message)
    }
}
impl From<&str> for DesktopError {
    fn from(message: &str) -> Self {
        DesktopError::Failed(message.to_string())
    }
}
impl From<DesktopFileError> for DesktopError {
    fn from(error: DesktopFileError) -> Self {
        DesktopError::Failed(error.to_string())
    }
}
impl From<std::io::Error> for DesktopError {
    fn from(error: std::io::Error) -> Self {
        DesktopError::Failed(error.to_string())
    }
}
impl From<serde_json::Error> for DesktopError {
    fn from(error: serde_json::Error) -> Self {
        DesktopError::Failed(error.to_string())
    }
}
impl From<ProcessError> for DesktopError {
    fn from(error: ProcessError) -> Self {
        DesktopError::Failed(error.0)
    }
}
impl From<DetachedExecError> for DesktopError {
    fn from(error: DetachedExecError) -> Self {
        DesktopError::Failed(error.message)
    }
}

pub type DesktopResult<T> = Result<T, DesktopError>;

/// How Relay starts Claude.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LaunchOptions {
    /// Start Claude without HTTP/3 (QUIC), so its requests go over HTTP/2.
    pub quic_off: bool,
}

/// While Claude, asked to quit, still runs: may answer its own question about work left
/// running; whether it did.
pub type AnswerGuard = dyn Fn() -> DesktopResult<bool> + Send + Sync;

/// The Claude the accessibility helper is to look at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutomationTarget {
    /// No window runs (TS `undefined`).
    Main,
    /// A window runs and this is the main Claude's pid.
    Pid(i64),
    /// A window runs but the main Claude is closed (TS `null`).
    None,
}

pub const WINDOWS_UNSUPPORTED: &str = "Separate Claude windows need macOS or Linux.";

/// Claude Desktop as Relay drives it. Optional TS members have defaults that act as if absent.
pub trait DesktopHost: Send + Sync {
    fn available(&self) -> bool;
    /// Whether Claude runs, from a full process listing.
    fn running(&self) -> DesktopResult<bool>;
    /// Whether Claude seems to run, for display: may answer from a pid seen alive in the last
    /// minute. Never used to decide a quit, launch or write.
    fn seems_running(&self) -> DesktopResult<bool> {
        self.running()
    }
    /// Asks Claude to quit and waits for it to close.
    fn quit(&self, answer_guard: Option<&AnswerGuard>) -> DesktopResult<()>;
    /// Starts Claude, without HTTP/3 when `options.quic_off`.
    fn launch(&self, options: Option<LaunchOptions>) -> DesktopResult<()>;
    fn seal(&self, data: &str) -> DesktopResult<Vec<u8>>;
    fn unseal(&self, data: &[u8]) -> DesktopResult<String>;
    /// Whether drafts can be captured: the host has a draft reader (TS `readDrafts`).
    fn reads_drafts(&self) -> bool {
        false
    }
    /// Reads the drafts in the job's private copy of Claude's Local Storage; the in-process
    /// reader by default. Only called when `reads_drafts`.
    fn read_drafts(
        &self,
        job: &crate::draft_transfer::DraftJob,
    ) -> crate::draft_transfer::DraftResult {
        crate::draft_transfer::read_drafts(job)
    }
    /// Why drafts cannot be captured on this machine, or None when they can.
    fn drafts_blocked(&self) -> DesktopResult<Option<String>> {
        Ok(None)
    }
    /// Where the draft step makes its scratch dirs; the temp folder when None.
    fn draft_scratch_dir(&self) -> Option<PathBuf> {
        None
    }
    /// How long Claude's main process has run, in ms; None when that cannot be told.
    fn claude_uptime_ms(&self) -> Option<i64> {
        None
    }
    /// Called right before a launch: watches Claude's own log. None when it cannot tell.
    fn watch_launch(&self) -> Option<Box<dyn LaunchWatch>> {
        None
    }
    /// Whether the Claude that runs signed itself out since it started; None when unknown.
    fn signed_out(&self) -> Option<bool> {
        None
    }
    /// The accounts Claude's log shows signing out lately; None when the host cannot tell
    /// (TS: no `signOuts`).
    fn sign_outs(&self) -> Option<Vec<ClaudeSignOut>> {
        None
    }
    /// Whether the host can run separate windows (TS: `launchWindow` and friends exist).
    fn has_windows(&self) -> bool {
        false
    }
    /// The Claudes that run on their own data folder, next to the main one.
    fn windows(&self) -> DesktopResult<Vec<ClaudeWindowProcess>> {
        Ok(Vec::new())
    }
    /// Starts a new Claude on the data folder `dir`.
    fn launch_window(&self, _dir: &Path, _options: Option<LaunchOptions>) -> DesktopResult<()> {
        Err(WINDOWS_UNSUPPORTED.into())
    }
    /// Asks the window whose main process is `pid` to quit.
    fn quit_window(&self, _pid: i64) -> DesktopResult<()> {
        Err(WINDOWS_UNSUPPORTED.into())
    }
    /// Brings the window whose main process is `pid` forward.
    fn activate_window(&self, _pid: i64) -> DesktopResult<()> {
        Err(WINDOWS_UNSUPPORTED.into())
    }
    fn automation_target(&self) -> DesktopResult<AutomationTarget> {
        Ok(AutomationTarget::Main)
    }
    /// How many windows the last full process listing saw; 0 before one.
    fn windows_seen(&self) -> usize {
        0
    }
}

// ---------------------------------------------------------------------------------------------
// DesktopManager

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::backup_prune::{SWITCH_BACKUP_LIMIT, prune_switch_backups};
use crate::config_sync::{ConfigSyncOptions, sync_profile_config};
use crate::desktop_files::{
    AUTH_KEYS, COOKIE_FILES, CarriedConversation, DESKTOP_PREFERENCES, HistoryPlanOptions,
    JsonObject, OutsideSource, Scope, Writes, directories, identity, is_uuid, json_bytes,
    plan_history_detailed, plan_permission_preferences, read_bytes, read_object, scope_path,
    write_bytes,
};
use crate::desktop_history::summarize_history;
use crate::desktop_launch::PageOutcome;
use crate::desktop_org::active_org_hint;
use crate::desktop_session::{
    CLAUDE_SIGNED_OUT, SIGN_IN_WITHOUT_SESSION, SessionPresence, SignInNotSettled, session_ends_ms,
    session_presence,
};
use crate::desktop_usage::CookieFiles;
use crate::draft_diagnostics::{safe_message, short_id};
use crate::draft_storage::remove_legacy_draft_backups;
use crate::draft_transfer::{
    CLAUDE_RUNNING, CaptureInput, CaptureOutcome, DraftJob, capture_drafts,
    sweep_stale_draft_scratch,
};
use crate::draft_vault::{
    DraftPatch, DraftReadStage, DraftRecord, DraftState, DraftSummary, DraftVault, DraftVaultHooks,
    summarize,
};
use crate::drafts::CapturedDraft;
use crate::fs_util::{iso_timestamp, mtime_ms};
use crate::shared::history_policy::{allowed_history_pair, history_sources};
use crate::shared::terminal_identity::{
    DEFAULT_TERMINAL_MODE, TerminalCurrent, TerminalCurrentState, TerminalIdentity, TerminalMode,
    TerminalOutcome, TerminalStatus, terminal_identities,
};
use crate::shared::types::js::JsMap;
use crate::shared::types::{
    Account, AccountDesktop, DesktopHistorySummary, DesktopHistoryTransfer, DesktopOperationKind,
    DesktopRestartEvent, DesktopState, OrgHint as StateOrgHint, SidebarGapSummary,
};
use crate::sidebar_layout::{
    AccountLayout, UnsupportedSidebar, plan_sidebar_gap, read_sidebar_storage, sidebar_recipe,
};
use crate::sidebar_vault::{SidebarGapRecord, SidebarGapVault};
use crate::store::{Store, StoreError};
use crate::terminal_identity::{
    SignInPorts, TerminalAdoption, TerminalPorts, TerminalRequest, TerminalSwitcher, TerminalVault,
    adopt_terminal_sign_in,
};

impl From<crate::draft_vault::VaultError> for DesktopError {
    fn from(error: crate::draft_vault::VaultError) -> Self {
        DesktopError::Failed(error.to_string())
    }
}
impl From<StoreError> for DesktopError {
    fn from(error: StoreError) -> Self {
        DesktopError::Failed(error.to_string())
    }
}
impl From<SignInNotSettled> for DesktopError {
    fn from(error: SignInNotSettled) -> Self {
        DesktopError::SignInNotSettled(error.to_string())
    }
}
impl From<crate::desktop_history::DesktopHistoryError> for DesktopError {
    fn from(error: crate::desktop_history::DesktopHistoryError) -> Self {
        DesktopError::Failed(error.to_string())
    }
}

/// A switch called off by its guards before Claude was asked to quit: Claude kept running and
/// no file was written.
pub fn desktop_switch_refused(message: impl Into<String>) -> DesktopError {
    DesktopError::SwitchRefused(message.into())
}

const SWITCH_CANCELLED: &str = "Automatic Desktop switch was cancelled before restart.";
/// Keys of the main Claude's config.json a window takes: how it looks, never who is signed in.
const WINDOW_CONFIG_KEYS: [&str; 2] = ["locale", "userThemeMode"];
pub const SIGN_IN_ENDED: &str =
    "This account’s saved Claude sign-in has ended. Sign in to it again in Relay.";
pub const WINDOW_HOLDS_ACCOUNT: &str =
    "This account is open in a separate Claude window. Close that window first.";
pub const WINDOW_PAUSES_AUTOMATIC: &str =
    "A separate Claude window is open, so Relay does not switch by itself.";
const UNREADABLE: &str = "Claude Desktop data could not be read. No files were changed.";
const FINISH_SIGN_IN: &str = "Finish or cancel the current Desktop sign-in first.";
const CONNECT_FIRST: &str = "Connect this account in Claude Desktop first.";
const OPENED_DURING_SWITCH: &str =
    "Claude opened during the Desktop switch. Restore its backup after closing Claude.";
const STILL_RUNNING: &str = "Claude is still running. No files were changed.";
/// How long observers (the tray, the windows) share one Desktop reading.
pub const DESKTOP_CACHE_MS: i64 = 2_500;
/// How long the claude.ai page of a Claude that Relay restarted may take to boot before Relay
/// restarts Claude once more.
pub const PAGE_BOOT_MS: i64 = 30_000;

/// The lock Relay's processes share so that only one of them runs a Desktop operation. `ensure`
/// takes it, or fails when another process holds it; the function it returns gives it back.
pub trait OperationLock: Send + Sync {
    fn ensure(&self, kind: DesktopOperationKind) -> DesktopResult<Box<dyn FnOnce() + Send>>;
}

/// How Relay starts Claude, asked right before each start. Either may fail.
pub trait LaunchChoice: Send + Sync {
    fn quic_off(&self) -> DesktopResult<bool>;
    fn learn_quic_off(&self) -> DesktopResult<()>;
}

/// The separate Claude windows Relay keeps for accounts, as a switch asks about them.
pub trait WindowsPort: Send + Sync {
    fn open_accounts(&self) -> DesktopResult<Vec<String>>;
    fn any_open(&self) -> DesktopResult<bool>;
    fn folder(&self, account_uuid: &str) -> Option<PathBuf>;
}

impl WindowsPort for crate::desktop_windows::DesktopWindows {
    fn open_accounts(&self) -> DesktopResult<Vec<String>> {
        crate::desktop_windows::DesktopWindows::open_accounts(self)
    }
    fn any_open(&self) -> DesktopResult<bool> {
        crate::desktop_windows::DesktopWindows::any_open(self)
    }
    fn folder(&self, account_uuid: &str) -> Option<PathBuf> {
        self.folder_of(account_uuid)
    }
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type CanProceed = Arc<dyn Fn() -> bool + Send + Sync>;
pub type BeforeQuit = Arc<dyn Fn() -> DesktopResult<()> + Send + Sync>;
pub type DraftEventHook = Arc<dyn Fn(&str, Option<&Map<String, Value>>) + Send + Sync>;
pub type AccountHook = Arc<dyn Fn(&Account) + Send + Sync>;
pub type RestartHook = Arc<dyn Fn(&DesktopRestartEvent) + Send + Sync>;
pub type StateHook = Arc<dyn Fn(&DesktopState) + Send + Sync>;
pub type SessionEnds = Arc<dyn Fn(&CookieFiles) -> Option<f64> + Send + Sync>;

#[derive(Clone, Default)]
pub struct DesktopSwitchOptions {
    /// Relay switches by itself (auto-switch, the fleet, continuation): never while a window runs.
    pub automatic: bool,
    pub closed_only: bool,
    pub expected_active_profile_id: Option<String>,
    pub can_proceed: Option<CanProceed>,
    /// Runs right before Claude is asked to quit; fail with `SwitchRefused` to call it off.
    pub before_quit: Option<BeforeQuit>,
    /// While Claude, asked to quit, still runs: may answer its question about work left running.
    pub answer_quit_guard: Option<Arc<AnswerGuard>>,
}

/// Hooks and tunables: the TS manager's public fields.
#[derive(Clone)]
pub struct DesktopHooks {
    /// Shared with Relay's other processes; taken around every Desktop operation when set.
    pub operation_lock: Option<Arc<dyn OperationLock>>,
    /// Told right before an operation first quits Claude, and when that operation ends.
    pub on_restart: Option<RestartHook>,
    /// Told when a switch ends and Desktop is free again, also when it fails.
    pub on_switched: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Told what the draft steps did, for a diagnosis log; never a draft's text.
    pub on_draft_event: Option<DraftEventHook>,
    pub launch_choice: Option<Arc<dyn LaunchChoice>>,
    pub windows: Option<Arc<dyn WindowsPort>>,
    /// Told each Desktop state read fresh from disk and the process list.
    pub on_state: Option<StateHook>,
    pub extension_verify_ms: u64,
    pub extension_recheck_ms: Vec<u64>,
    pub on_extension_broken: Option<AccountHook>,
    /// Whether a copy of Claude's cookie files holds a claude.ai session; tests replace it.
    pub session_of: Arc<dyn Fn(&CookieFiles) -> SessionPresence + Send + Sync>,
    /// When a saved sign-in's session cookies end; replaced in tests.
    pub session_ends: SessionEnds,
    /// How long Relay waits, before it quits Claude, for a sign-in to reach the cookie file.
    pub session_settle_ms: i64,
    pub session_poll_ms: u64,
    /// When, after a switch started Claude, Relay looks whether Claude signed the account out.
    pub sign_in_verify_ms: Vec<u64>,
    pub on_sign_in_rejected: Option<AccountHook>,
    /// Whether Anthropic cannot be reached now; a failed sign-in then proves nothing.
    pub extension_offline: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The browsers and the extension's storage; without it the extension step never runs.
    pub extension: Option<ExtensionPorts>,
    pub extension_scratch_dir: Option<PathBuf>,
    /// The terminal's Claude Code sign-in; without it the terminal step never runs.
    pub terminal: Option<TerminalPorts>,
    /// Whether Claude Code is connected to Relay's running gateway.
    pub gateway_bound: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl Default for DesktopHooks {
    fn default() -> Self {
        DesktopHooks {
            operation_lock: None,
            on_restart: None,
            on_switched: None,
            on_draft_event: None,
            launch_choice: None,
            windows: None,
            on_state: None,
            extension_verify_ms: 25_000,
            extension_recheck_ms: Vec::new(),
            on_extension_broken: None,
            session_of: Arc::new(session_presence),
            session_ends: Arc::new(session_ends_ms),
            session_settle_ms: 40_000,
            session_poll_ms: 2_000,
            sign_in_verify_ms: vec![8_000, 20_000],
            on_sign_in_rejected: None,
            extension_offline: Arc::new(default_offline),
            extension: None,
            extension_scratch_dir: None,
            terminal: None,
            gateway_bound: None,
        }
    }
}

/// What a Desktop reading finds on disk and in the process list.
#[derive(Debug, Clone, PartialEq)]
struct DesktopReading {
    available: bool,
    running: bool,
    windows: usize,
    current_account_uuid: Option<String>,
    organizations: Vec<String>,
    org_hint: Option<StateOrgHint>,
    recovery_required: bool,
}

struct SharedReading {
    at: i64,
    cell: OnceLock<DesktopResult<DesktopReading>>,
}

#[derive(Debug, Clone, PartialEq)]
struct Pending {
    profile_id: String,
    previous_uuid: Option<String>,
    started_at: Option<String>,
}

impl Pending {
    fn json(&self) -> Value {
        let mut map = Map::new();
        map.insert("profileId".into(), Value::String(self.profile_id.clone()));
        if let Some(previous) = &self.previous_uuid {
            map.insert("previousUuid".into(), Value::String(previous.clone()));
        }
        if let Some(at) = &self.started_at {
            map.insert("startedAt".into(), Value::String(at.clone()));
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone)]
struct Operation {
    kind: DesktopOperationKind,
    profile_id: Option<String>,
    restarted: bool,
}

#[derive(Default)]
struct ManagerState {
    busy: bool,
    started: u64,
    pending: Option<Pending>,
    last_error: Option<String>,
    error_revision: i64,
    dismissed_error_revision: i64,
    last_backup: Option<String>,
    pending_history_seen: Option<Vec<u8>>,
    carried: Vec<CarriedConversation>,
    written: usize,
    operation: Option<Operation>,
    shared: Option<Arc<SharedReading>>,
    ended_checked_at: Option<i64>,
    sign_in_verify_run: u64,
    last_terminal: Option<TerminalOutcome>,
    last_terminal_check: Option<TerminalCurrent>,
    ext: ExtensionState,
}

/// A saved Claude app sign-in, as the vault holds it.
struct SavedLogin {
    account_uuid: String,
    auth: JsonObject,
    cookies: Map<String, Value>,
}

impl SavedLogin {
    fn cookie(&self, name: &str) -> Option<Vec<u8>> {
        use base64::Engine;
        let text = self.cookies.get(name)?.as_str()?;
        Some(
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .unwrap_or_default(),
        )
    }
    fn cookie_files(&self) -> CookieFiles {
        COOKIE_FILES
            .iter()
            .map(|name| (name.to_string(), self.cookie(name)))
            .collect()
    }
}

fn b64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn unb64(text: &str) -> Vec<u8> {
    use base64::Engine;
    // Buffer.from(text, "base64") ignores what is not base64 rather than failing.
    let clean: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_'))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(clean.trim_end_matches('='))
        .unwrap_or_default()
}

/// The account's uuids for the extension step: Desktop's and its own, any that exist.
fn account_uuids(account: &Account) -> Vec<String> {
    [
        account.desktop.as_ref().map(|d| d.account_uuid.clone()),
        account.auth.as_ref().and_then(|a| a.account_uuid.clone()),
    ]
    .into_iter()
    .flatten()
    .filter(|v| !v.is_empty())
    .collect()
}

/// An account's terminal identities.
fn account_terminal_identities(account: &Account) -> Vec<TerminalIdentity> {
    terminal_identities(
        account
            .desktop
            .as_ref()
            .map(|d| (d.account_uuid.as_str(), d.org_id.as_str())),
        account
            .auth
            .as_ref()
            .map(|a| (a.account_uuid.as_deref(), a.org_id.as_deref())),
    )
}

fn scope_of(desktop: &AccountDesktop) -> Scope {
    Scope {
        account_uuid: desktop.account_uuid.clone(),
        org_id: desktop.org_id.clone(),
    }
}

fn fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Calls a listener; one that panics never changes how a Desktop operation ends.
fn tell(f: impl FnOnce()) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// What a capture says in the diagnosis log: the outcome, and per kept draft where it goes and
/// how long it is, as `alias8:length`, or `new:length` for the new-session screen. Never text.
fn capture_fields(
    from: &str,
    to: &str,
    outcome: &CaptureOutcome,
    captured: &[CapturedDraft],
) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("from".into(), json!(short_id(Some(from))));
    map.insert("to".into(), json!(short_id(Some(to))));
    let status = match outcome {
        CaptureOutcome::Captured { .. } => "captured",
        CaptureOutcome::Skipped { .. } => "skipped",
        CaptureOutcome::Failed { .. } => "failed",
    };
    map.insert("status".into(), json!(status));
    map.insert("count".into(), json!(captured.len()));
    match outcome {
        CaptureOutcome::Failed { error } => {
            map.insert("error".into(), json!(safe_message(error)));
        }
        CaptureOutcome::Skipped { reason } => {
            map.insert("reason".into(), json!(safe_message(reason)));
        }
        CaptureOutcome::Captured { .. } => {}
    }
    let drafts: Vec<String> = captured
        .iter()
        .map(|draft| {
            let slot = if draft.new_session == Some(true) {
                "new".to_string()
            } else {
                short_id(draft.target_alias.as_deref()).unwrap_or_else(|| "none".into())
            };
            format!("{slot}:{}", units(&draft.text))
        })
        .collect();
    map.insert("drafts".into(), json!(drafts.join(",")));
    map
}

static RESTORE_SESSION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)^claude-code-sessions/[a-f0-9-]{36}/[a-f0-9-]{36}/local_[a-f0-9-]{36}\.json$",
    )
    .unwrap()
});
static RESTORE_SPACES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)^local-agent-mode-sessions/[a-f0-9-]{36}/[a-f0-9-]{36}/spaces\.json$")
        .unwrap()
});

/// Claude Desktop's accounts: saving, signing in, switching, history merges and recovery.
pub struct DesktopManager {
    pub root: PathBuf,
    store: Arc<Store>,
    host: Arc<dyn DesktopHost>,
    transcript_root: PathBuf,
    now: Clock,
    vault: PathBuf,
    state: Mutex<ManagerState>,
    hooks: Mutex<DesktopHooks>,
    /// The drafts captured at switches, sealed, until they are re-typed or dismissed.
    drafts: DraftVault,
    /// What the account switched to lacks of its sources' sidebar organization.
    sidebar: SidebarGapVault,
    terminal_vault: Arc<TerminalVault>,
    terminal_switcher: Mutex<Option<Arc<TerminalSwitcher>>>,
    ext: ExtensionParts,
    sign_in_verified: Mutex<Option<JoinHandle<()>>>,
    this: Weak<DesktopManager>,
}

impl DesktopManager {
    /// `transcript_root` defaults to `~/.claude`, `now` to the wall clock.
    pub fn new(
        root: impl Into<PathBuf>,
        store: Arc<Store>,
        host: Arc<dyn DesktopHost>,
        transcript_root: Option<PathBuf>,
        now: Option<Clock>,
    ) -> Arc<DesktopManager> {
        let root = root.into();
        let now = now.unwrap_or_else(|| Arc::new(crate::clock::now_ms));
        let vault = store.root().join("desktop-vault");
        let transcript_root =
            transcript_root.unwrap_or_else(|| crate::relay_paths::home_dir().join(".claude"));
        Arc::new_cyclic(|this: &Weak<DesktopManager>| {
            let seal_host = Arc::clone(&host);
            let unseal_host = Arc::clone(&host);
            let draft_seal: crate::draft_vault::Seal =
                Arc::new(move |text: &str| seal_host.seal(text).map_err(|e| e.to_string()));
            let draft_unseal: crate::draft_vault::Unseal =
                Arc::new(move |data: &[u8]| unseal_host.unseal(data).map_err(|e| e.to_string()));
            let diag = |this: Weak<DesktopManager>| {
                move |event: &str, fields: Map<String, Value>| {
                    if let Some(manager) = this.upgrade() {
                        manager.diagnose(event, Some(fields));
                    }
                }
            };
            let on_read = diag(this.clone());
            let on_rejected = diag(this.clone());
            let on_list = diag(this.clone());
            let hooks = DraftVaultHooks {
                on_read_error: Some(Box::new(move |stage: DraftReadStage, message: &str| {
                    on_read(
                        "vault-read-failed",
                        fields(json!({ "stage": stage.as_str(), "message": message })),
                    )
                })),
                on_record_rejected: Some(Box::new(move |index: usize| {
                    on_rejected("vault-record-rejected", fields(json!({ "index": index })))
                })),
                on_list: Some(Box::new(move |count: usize| {
                    on_list("vault-list", fields(json!({ "count": count })))
                })),
            };
            let drafts = DraftVault::new(
                &vault,
                Arc::clone(&draft_seal),
                Arc::clone(&draft_unseal),
                None,
                hooks,
            );
            let sidebar = SidebarGapVault::with_clock(&vault, Arc::clone(&now));
            let terminal_vault = Arc::new(TerminalVault::with_clock(
                &vault,
                Arc::clone(&draft_seal),
                Arc::clone(&draft_unseal),
                Arc::clone(&now),
            ));
            let ext = ExtensionParts::new(&vault, draft_seal, draft_unseal, Arc::clone(&now));
            DesktopManager {
                root,
                store,
                host,
                transcript_root,
                now,
                vault,
                state: Mutex::new(ManagerState {
                    dismissed_error_revision: -1,
                    ..ManagerState::default()
                }),
                hooks: Mutex::new(DesktopHooks::default()),
                drafts,
                sidebar,
                terminal_vault,
                terminal_switcher: Mutex::new(None),
                ext,
                sign_in_verified: Mutex::new(None),
                this: this.clone(),
            }
        })
    }

    fn st(&self) -> MutexGuard<'_, ManagerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The hooks and tunables, cloned.
    pub fn hooks(&self) -> DesktopHooks {
        self.hooks.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Changes hooks and tunables.
    pub fn configure(&self, change: impl FnOnce(&mut DesktopHooks)) {
        change(&mut self.hooks.lock().unwrap_or_else(|e| e.into_inner()));
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    pub fn is_busy(&self) -> bool {
        self.st().busy
    }

    /// How many operations have marked Desktop busy; it only grows.
    pub fn operations(&self) -> u64 {
        self.st().started
    }

    /// The conversations the last switch or merge wrote into the account switched to.
    pub fn carried_count(&self) -> usize {
        self.st().written
    }

    /// The account a running switch goes to, for the menu bar title.
    pub fn switching_to(&self) -> Option<String> {
        self.st()
            .operation
            .as_ref()
            .filter(|op| op.kind == DesktopOperationKind::Switch)
            .and_then(|op| op.profile_id.clone())
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    /// One diagnosis event; a log that fails changes nothing about the drafts.
    fn diagnose(&self, event: &str, fields: Option<Map<String, Value>>) {
        if let Some(hook) = self.hooks().on_draft_event {
            tell(|| hook(event, fields.as_ref()));
        }
    }

    fn diag(&self, event: &str, value: Value) {
        self.diagnose(event, Some(fields(value)));
    }

    pub fn initialize(&self) -> DesktopResult<()> {
        crate::fs_util::create_private_dir_all(&self.vault)?;
        // The first design kept plaintext copies of Claude's Local Storage there.
        remove_legacy_draft_backups(&self.vault);
        // A draft step that stopped with Relay leaves a copy behind.
        sweep_stale_draft_scratch(
            &self
                .host
                .draft_scratch_dir()
                .unwrap_or_else(std::env::temp_dir),
        );
        // So does an extension step: its backup of the extension's folder.
        let scratch = self.extension_scratch();
        for suffix in ["", "-cookies", "-peek"] {
            let mut dir = scratch.clone().into_os_string();
            dir.push(suffix);
            crate::extension_storage::clear_scratch(Path::new(&dir));
        }
        self.refresh_pending();
        if read_object(&self.vault, "journal.json")?.is_some() {
            self.report_error("Desktop recovery is required before switching.");
        }
        Ok(())
    }

    /// Re-reads the pending sign-in: another Relay process sharing the vault may have begun or
    /// ended one. An unreadable file leaves what was known.
    fn refresh_pending(&self) {
        let Ok(pending) = read_object(&self.vault, "pending.json") else {
            return;
        };
        let parsed = pending.and_then(|p| {
            let profile_id = p.get("profileId")?.as_str().filter(|id| is_uuid(id))?;
            Some(Pending {
                profile_id: profile_id.to_string(),
                previous_uuid: p
                    .get("previousUuid")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                started_at: p
                    .get("startedAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        });
        self.st().pending = parsed;
    }

    fn pending(&self) -> Option<Pending> {
        self.st().pending.clone()
    }

    fn report_error(&self, message: &str) {
        let mut st = self.st();
        if st.last_error.as_deref() != Some(message) {
            st.error_revision += 1;
        }
        st.last_error = Some(message.to_string());
    }

    /// Shows a problem readying the vault at startup where Desktop errors show.
    pub fn report_vault_error(&self, message: &str) {
        self.report_error(message);
    }

    pub fn dismiss_error(&self, revision: i64) {
        let mut st = self.st();
        // A late dismissal must not hide an error from a newer operation.
        if revision == st.error_revision {
            st.dismissed_error_revision = revision;
        }
    }

    /// Desktop as it is now, read fresh with a full process check: for every decision.
    pub fn snapshot(&self) -> DesktopResult<DesktopState> {
        let reading = self.track(|| self.host.running())?;
        Ok(self.observed(self.state_of(&reading)))
    }

    /// Desktop for observers, which never decide a quit, launch or write: concurrent callers
    /// share one reading, reused for DESKTOP_CACHE_MS and dropped by every Desktop operation.
    pub fn cached_snapshot(&self) -> DesktopResult<DesktopState> {
        let shared = self.st().shared.clone();
        let reused = shared
            .as_ref()
            .filter(|entry| {
                let age = self.now() - entry.at;
                (0..DESKTOP_CACHE_MS).contains(&age)
            })
            .cloned();
        let reading = match &reused {
            // Shared with the reading under way; one that has not begun yet is made here.
            Some(entry) => entry
                .cell
                .get_or_init(|| self.read(|| self.host.seems_running()))
                .clone()?,
            None => self.track(|| self.host.seems_running())?,
        };
        let state = self.state_of(&reading);
        Ok(if reused.is_some() {
            state
        } else {
            self.observed(state)
        })
    }

    /// Tells `on_state` about a state just read; a hook that fails changes nothing.
    fn observed(&self, state: DesktopState) -> DesktopState {
        if let Some(hook) = self.hooks().on_state {
            tell(|| hook(&state));
        }
        state
    }

    /// Reads Desktop, sharing the reading with observers until it fails or a Desktop operation
    /// drops it.
    fn track(
        &self,
        running: impl FnOnce() -> DesktopResult<bool>,
    ) -> DesktopResult<DesktopReading> {
        let entry = Arc::new(SharedReading {
            at: self.now(),
            cell: OnceLock::new(),
        });
        self.st().shared = Some(Arc::clone(&entry));
        let result = entry.cell.get_or_init(|| self.read(running)).clone();
        if result.is_err() {
            let mut st = self.st();
            if st
                .shared
                .as_ref()
                .is_some_and(|shared| Arc::ptr_eq(shared, &entry))
            {
                st.shared = None;
            }
        }
        result
    }

    /// Readings begun before now are not shared after it.
    fn invalidate(&self) {
        self.st().shared = None;
    }

    fn read(&self, running: impl FnOnce() -> DesktopResult<bool>) -> DesktopResult<DesktopReading> {
        let mut current: Option<String> = None;
        let mut organizations = Vec::new();
        let mut org_hint = None;
        let since = self
            .pending()
            .and_then(|p| p.started_at)
            .map(|at| crate::shared::types::js::date_parse(&at))
            .filter(|ms| ms.is_finite());
        let outcome = (|| -> DesktopResult<()> {
            let config = read_object(&self.root, "config.json")?;
            current = identity(config.as_ref());
            if let Some(uuid) = &current {
                organizations = directories(&self.root, &format!("claude-code-sessions/{uuid}"))?;
                org_hint = active_org_hint(
                    &config.clone().map(Value::Object).unwrap_or(Value::Null),
                    uuid,
                    &organizations,
                    since,
                )
                .map(|hint| StateOrgHint {
                    org_id: hint.org_id,
                    certain: hint.certain,
                });
            }
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                let mut st = self.st();
                if st.last_error.as_deref() == Some(UNREADABLE) {
                    st.last_error = None;
                }
            }
            Err(_) => self.report_error(UNREADABLE),
        }
        let recovery = read_object(&self.vault, "journal.json")?.is_some();
        self.refresh_pending();
        Ok(DesktopReading {
            available: self.host.available(),
            running: running()?,
            // From the same listing: the windows it saw.
            windows: self.host.windows_seen(),
            current_account_uuid: current,
            organizations,
            org_hint,
            recovery_required: recovery,
        })
    }

    fn state_of(&self, reading: &DesktopReading) -> DesktopState {
        let current = reading.current_account_uuid.clone();
        let active = self.store.with_state(|s| {
            s.accounts
                .iter()
                .find(|a| {
                    a.desktop.as_ref().is_some_and(|d| {
                        Some(&d.account_uuid) == current.as_ref()
                            && reading.organizations.contains(&d.org_id)
                    })
                })
                .map(|a| a.id.clone())
        });
        let st = self.st();
        DesktopState {
            available: reading.available,
            running: reading.running,
            windows: (reading.windows > 0).then_some(reading.windows as f64),
            current_account_uuid: current,
            organizations: reading.organizations.clone(),
            org_hint: reading.org_hint.clone(),
            active_profile_id: active,
            pending_profile_id: st.pending.as_ref().map(|p| p.profile_id.clone()),
            busy: st.busy,
            error: if st.dismissed_error_revision == st.error_revision {
                None
            } else {
                st.last_error.clone()
            },
            error_revision: st.error_revision as f64,
            recovery_required: reading.recovery_required,
            last_backup: st.last_backup.clone(),
            ..DesktopState::default()
        }
    }

    fn journal(&self) -> DesktopResult<Option<JsonObject>> {
        Ok(read_object(&self.vault, "journal.json")?)
    }

    fn launch(&self, options: Option<LaunchOptions>) -> DesktopResult<()> {
        self.host.launch(options)
    }

    pub fn capture(&self, profile_id: &str, org_id: &str) -> DesktopResult<()> {
        let op = (DesktopOperationKind::Save, Some(profile_id.to_string()));
        self.exclusive(op, false, || {
            if self.pending().is_some_and(|p| p.profile_id != profile_id) {
                return Err(FINISH_SIGN_IN.into());
            }
            let account = self.store.account(profile_id)?;
            let state = self.snapshot()?;
            if !is_uuid(org_id) && state.current_account_uuid.is_some() {
                return Err("Invalid UUID".into());
            }
            let Some(current) = state
                .current_account_uuid
                .clone()
                .filter(|_| state.organizations.iter().any(|o| o == org_id))
            else {
                return Err("Open Claude Desktop, sign in and open the Code tab first.".into());
            };
            self.assert_profile_identity(&account, &current, org_id)?;
            let taken = self.store.with_state(|s| {
                s.accounts.iter().any(|a| {
                    a.id != profile_id
                        && a.desktop.as_ref().map(|d| &d.account_uuid) == Some(&current)
                })
            });
            if taken {
                return Err("This Desktop account is already saved in another profile.".into());
            }
            if let Some(desktop) = &account.desktop {
                if desktop.account_uuid != current {
                    return Err(
                        "This profile belongs to another Desktop account. Create a new profile."
                            .into(),
                    );
                }
                if desktop.org_id == org_id && self.pending().is_none() {
                    return Ok(());
                }
            }
            // Before Claude is quit: a quit before the session reaches the cookie file loses it.
            self.settle_session(true)?;
            self.quit_claude(None)?;
            let body = (|| -> DesktopResult<()> {
                let saved = self.save_current(&self.root, true)?;
                if saved.as_deref() != Some(current.as_str()) {
                    return Err("Desktop account changed during setup. Try again.".into());
                }
                let saved = saved.unwrap_or_default();
                let mut target = account.clone();
                target.desktop = Some(AccountDesktop {
                    account_uuid: saved.clone(),
                    org_id: org_id.to_string(),
                    saved_at: iso_timestamp(crate::clock::now_ms()),
                    ..AccountDesktop::default()
                });
                let plan = self.history_plan(&target)?;
                self.apply(plan, &ApplyOptions::default())?;
                let email = match &account.auth {
                    Some(auth)
                        if auth.account_uuid.as_deref() == Some(saved.as_str())
                            && auth.org_id.as_deref() == Some(org_id) =>
                    {
                        auth.email.clone()
                    }
                    _ => account.desktop.as_ref().and_then(|d| d.email.clone()),
                };
                let saved_at = iso_timestamp(crate::clock::now_ms());
                self.store.update(|s| {
                    if let Some(a) = s.accounts.iter_mut().find(|a| a.id == profile_id) {
                        a.desktop = Some(AccountDesktop {
                            account_uuid: saved.clone(),
                            org_id: org_id.to_string(),
                            saved_at,
                            email,
                            ..AccountDesktop::default()
                        });
                    }
                })?;
                if self.pending().is_some_and(|p| p.profile_id == profile_id) {
                    self.st().pending = None;
                    write_bytes(&self.vault, "pending.json", None)?;
                }
                Ok(())
            })();
            let after = (|| -> DesktopResult<()> {
                if self.journal()?.is_none() {
                    self.launch(None)?;
                }
                Ok(())
            })();
            after?;
            body
        })
    }

    /// Points a saved Claude app sign-in at another of the same account's Code workspaces, the
    /// one its usage sign-in belongs to. Only the binding changes; Claude is not restarted.
    /// Whether anything changed.
    pub fn rebind_org(&self, profile_id: &str, org_id: &str) -> DesktopResult<bool> {
        let free = |m: &Self| {
            let st = m.st();
            !st.busy && st.pending.is_none()
        };
        if !free(self) {
            return Ok(false);
        }
        if !is_uuid(org_id) {
            return Err("Invalid UUID".into());
        }
        let target = org_id.to_lowercase();
        let account = self.store.account(profile_id)?;
        let Some(desktop) = account.desktop.clone() else {
            return Ok(false);
        };
        if desktop.org_id.to_lowercase() == target {
            return Ok(false);
        }
        let auth = account.auth.as_ref();
        if auth
            .and_then(|a| a.account_uuid.as_ref())
            .map(|u| u.to_lowercase())
            != Some(desktop.account_uuid.to_lowercase())
            || auth
                .and_then(|a| a.org_id.as_ref())
                .map(|o| o.to_lowercase())
                != Some(target.clone())
        {
            return Ok(false);
        }
        if !is_uuid(&desktop.account_uuid) {
            return Err("Invalid UUID".into());
        }
        let workspaces = directories(
            &self.root,
            &format!("claude-code-sessions/{}", desktop.account_uuid),
        )?;
        let Some(workspace) = workspaces.into_iter().find(|o| o.to_lowercase() == target) else {
            return Ok(false);
        };
        if !free(self) {
            return Ok(false);
        }
        self.store.update(|s| {
            if let Some(stored) = s
                .accounts
                .iter_mut()
                .find(|a| a.id == profile_id)
                .and_then(|a| a.desktop.as_mut())
                && stored.account_uuid == desktop.account_uuid
            {
                stored.org_id = workspace;
            }
        })?;
        self.invalidate();
        Ok(true)
    }

    pub fn begin_login(&self, profile_id: &str) -> DesktopResult<()> {
        let op = (DesktopOperationKind::Link, Some(profile_id.to_string()));
        self.exclusive(op, false, || {
            let account = self.store.account(profile_id)?;
            if let Some(desktop) = &account.desktop {
                self.assert_profile_identity(&account, &desktop.account_uuid, &desktop.org_id)?;
            }
            if let Some(pending) = self.pending() {
                if pending.profile_id != profile_id {
                    return Err(FINISH_SIGN_IN.into());
                }
                return self.launch(None);
            }
            self.assert_current_saved()?;
            self.restart(
                || {
                    let current = self.save_current(&self.root, false)?;
                    // Never replace an unknown current account without a recoverable saved slot.
                    if let Some(current) = &current
                        && !self.desktop_saved(current)
                    {
                        return Err("Save the current Desktop account into a profile before adding another account.".into());
                    }
                    let mut config = read_object(&self.root, "config.json")?.unwrap_or_default();
                    for key in AUTH_KEYS {
                        config.shift_remove(key);
                    }
                    let mut changes = Writes::new();
                    changes.insert("config.json".into(), Some(json_bytes(&config)));
                    for file in COOKIE_FILES {
                        changes.insert(file.into(), None);
                    }
                    self.apply(changes, &ApplyOptions::default())?;
                    let pending = Pending {
                        profile_id: profile_id.to_string(),
                        previous_uuid: current,
                        started_at: Some(iso_timestamp(crate::clock::now_ms())),
                    };
                    self.st().pending = Some(pending.clone());
                    write_bytes(&self.vault, "pending.json", Some(&json_bytes(&pending.json())))?;
                    Ok(())
                },
                None,
                None,
                None,
            )
        })
    }

    fn desktop_saved(&self, account_uuid: &str) -> bool {
        self.store.with_state(|s| {
            s.accounts.iter().any(|a| {
                a.desktop
                    .as_ref()
                    .is_some_and(|d| d.account_uuid == account_uuid)
            })
        })
    }

    pub fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()> {
        let mut switched: Option<Account> = None;
        let op = (DesktopOperationKind::Switch, Some(profile_id.to_string()));
        let result = self.exclusive(op, false, || {
            if self.pending().is_some() {
                return Err(FINISH_SIGN_IN.into());
            }
            let target = self.store.account(profile_id)?;
            let Some(desktop) = target.desktop.clone() else {
                return Err(CONNECT_FIRST.into());
            };
            self.assert_profile_identity(&target, &desktop.account_uuid, &desktop.org_id)?;
            let windows = self.hooks().windows;
            if let Some(windows) = &windows
                && windows.open_accounts()?.contains(&desktop.account_uuid)
            {
                return Err(WINDOW_HOLDS_ACCOUNT.into());
            }
            // Its saved sign-in ended: an unattended switch would leave Claude signed out.
            if desktop.rejected_at.is_some() && (options.automatic || options.closed_only) {
                return Err(desktop_switch_refused(SIGN_IN_ENDED));
            }
            // Its own processes and log lines sit beside the main Claude's: only a person
            // switches.
            if options.automatic
                && let Some(windows) = &windows
                && windows.any_open()?
            {
                return Err(desktop_switch_refused(WINDOW_PAUSES_AUTOMATIC));
            }
            let assert_closed_switch = || -> DesktopResult<()> {
                if !options.closed_only {
                    return Ok(());
                }
                let expected = options.expected_active_profile_id.as_deref();
                if expected.is_none_or(|e| e == profile_id) {
                    return Err(
                        "The active Desktop account must be known before automatic preparation."
                            .into(),
                    );
                }
                let state = self.snapshot()?;
                if state.running {
                    return Err(STILL_RUNNING.into());
                }
                if state.active_profile_id.as_deref() != expected {
                    return Err("Desktop account changed before automatic preparation.".into());
                }
                if self.pending().is_some()
                    || state.recovery_required
                    || options.can_proceed.as_ref().is_some_and(|c| !c())
                {
                    return Err("Automatic preparation is no longer authorized.".into());
                }
                let latest = self.store.account(profile_id)?;
                if latest
                    .desktop
                    .as_ref()
                    .map(|d| (&d.account_uuid, &d.org_id))
                    != Some((&desktop.account_uuid, &desktop.org_id))
                {
                    return Err(
                        "The selected Desktop account changed before automatic preparation.".into(),
                    );
                }
                self.assert_profile_identity(&latest, &desktop.account_uuid, &desktop.org_id)
            };
            assert_closed_switch()?;
            self.assert_current_saved()?;
            let saved = self.read_login(&desktop.account_uuid)?;
            // The Claude app account the switch left, once the swap is written.
            let mut left: Option<String> = None;
            let mut change = || -> DesktopResult<()> {
                assert_closed_switch()?;
                let current = self.save_current(&self.root, false)?;
                if let Some(current) = &current
                    && !self.desktop_saved(current)
                {
                    return Err("Save the current Desktop account before switching.".into());
                }
                let mut config = read_object(&self.root, "config.json")?.unwrap_or_default();
                for key in AUTH_KEYS {
                    config.shift_remove(key);
                    if let Some(value) = saved.auth.get(key) {
                        config.insert(key.into(), value.clone());
                    }
                }
                let mut changes = self.history_plan(&target)?;
                let carried = self.st().carried.clone();
                let other = current.as_deref() != Some(saved.account_uuid.as_str());
                if other {
                    if let Some(current) = &current {
                        self.permission_preferences(&mut changes, current, &target);
                    }
                    changes.insert("config.json".into(), Some(json_bytes(&config)));
                    for file in COOKIE_FILES {
                        changes.insert(file.into(), saved.cookie(file));
                    }
                }
                assert_closed_switch()?;
                self.apply(
                    changes,
                    &ApplyOptions {
                        can_proceed: options.can_proceed.clone(),
                    },
                )?;
                if let Some(current) = current.as_ref().filter(|_| other) {
                    left = Some(current.clone());
                    // Still inside `change`, so a restart relaunches Claude only once the draft
                    // step is done.
                    self.carry_drafts(current, &saved.account_uuid, &target, &carried);
                }
                // Last, while Claude is still closed: a browser quit for it is open again before
                // Claude starts. A switch that keeps Claude closed never quits the browser.
                if other {
                    self.extension_step(&target, !options.closed_only, None);
                }
                Ok(())
            };
            if options.closed_only {
                change()?;
            } else {
                self.restart(
                    change,
                    options.can_proceed.clone(),
                    options.before_quit.clone(),
                    options.answer_quit_guard.clone(),
                )?;
            }
            switched = Some(target.clone());
            // After Claude is back, still inside the lock: profile files never need Claude closed.
            if let Some(left) = &left {
                self.config_sync_step(left, &target);
            }
            if !options.closed_only {
                self.verify_sign_in_later(target.clone());
            }
            Ok(())
        });
        if let Some(hook) = self.hooks().on_switched {
            tell(|| hook());
        }
        result?;
        // After the operation: it needs no app closed and waits on Claude Code's own lock.
        if let Some(target) = switched {
            self.terminal_step(&target);
        }
        Ok(())
    }

    pub fn cancel_login(&self) -> DesktopResult<()> {
        self.exclusive((DesktopOperationKind::CancelLink, None), false, || {
            let Some(pending) = self.pending() else {
                return Ok(());
            };
            let saved = match &pending.previous_uuid {
                Some(previous) => Some(self.read_login(previous)?),
                None => None,
            };
            self.restart(
                || {
                    self.save_current(&self.root, false)?;
                    if let Some(saved) = &saved {
                        let mut config =
                            read_object(&self.root, "config.json")?.unwrap_or_default();
                        for key in AUTH_KEYS {
                            config.shift_remove(key);
                            if let Some(value) = saved.auth.get(key) {
                                config.insert(key.into(), value.clone());
                            }
                        }
                        let mut changes = Writes::new();
                        changes.insert("config.json".into(), Some(json_bytes(&config)));
                        for file in COOKIE_FILES {
                            changes.insert(file.into(), saved.cookie(file));
                        }
                        self.apply(changes, &ApplyOptions::default())?;
                    }
                    self.st().pending = None;
                    write_bytes(&self.vault, "pending.json", None)?;
                    Ok(())
                },
                None,
                None,
                None,
            )
        })
    }

    fn quic_choice(&self) -> bool {
        // Unknown: open as Claude opens by itself.
        self.hooks()
            .launch_choice
            .is_some_and(|choice| choice.quic_off().unwrap_or(false))
    }

    /// Opens Claude: one already running only comes forward; a new one starts as Relay starts it.
    pub fn open(&self) -> DesktopResult<()> {
        let quic_off = self.quic_choice();
        let result = self.launch(quic_off.then_some(LaunchOptions { quic_off }));
        self.invalidate();
        result
    }

    /// Decrypts every saved Desktop sign-in once without changing anything.
    pub fn verify_saved_logins(&self) -> DesktopResult<()> {
        for account in self.store.state().accounts {
            if let Some(desktop) = &account.desktop {
                self.read_login(&desktop.account_uuid)?;
            }
        }
        Ok(())
    }

    pub fn history_summary(&self, profile_id: &str) -> DesktopResult<DesktopHistorySummary> {
        let account = self.store.account(profile_id)?;
        let Some(desktop) = &account.desktop else {
            return Err(CONNECT_FIRST.into());
        };
        let sources = self
            .store
            .with_state(|s| history_sources(&account, &s.accounts, &s.settings).len());
        Ok(summarize_history(
            &self.root,
            &scope_of(desktop),
            profile_id,
            sources as f64,
            Some(&self.transcript_root),
        )?)
    }

    pub fn sync_history(&self, profile_id: &str) -> DesktopResult<()> {
        let op = (DesktopOperationKind::Merge, Some(profile_id.to_string()));
        self.exclusive(op, false, || {
            if self.pending().is_some() {
                return Err(FINISH_SIGN_IN.into());
            }
            let account = self.store.account(profile_id)?;
            let Some(desktop) = account.desktop.clone() else {
                return Err(CONNECT_FIRST.into());
            };
            let state = self.snapshot()?;
            if state.active_profile_id.as_deref() != Some(profile_id) {
                return Err("Switch to this Desktop account before syncing its history.".into());
            }
            self.assert_profile_identity(&account, &desktop.account_uuid, &desktop.org_id)?;
            self.restart(
                || {
                    if identity(read_object(&self.root, "config.json")?.as_ref()).as_deref()
                        != Some(desktop.account_uuid.as_str())
                    {
                        return Err("Desktop account changed during setup. Try again.".into());
                    }
                    let plan = self.history_plan(&account)?;
                    self.apply(plan, &ApplyOptions::default())
                },
                None,
                None,
                None,
            )
        })
    }

    fn extension_scratch(&self) -> PathBuf {
        self.hooks()
            .extension_scratch_dir
            .unwrap_or_else(|| self.store.root().join("extension-scratch"))
    }

    fn terminal_stepper(&self) -> Option<Arc<TerminalSwitcher>> {
        let ports = self.hooks().terminal?;
        let mut switcher = self
            .terminal_switcher
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if switcher.is_none() {
            *switcher = Some(Arc::new(TerminalSwitcher::with_clock(
                ports,
                (*self.terminal_vault).clone(),
                Arc::clone(&self.now),
            )));
        }
        switcher.clone()
    }

    /// Keeps a sign-in made for the terminal in a scratch folder as `profile_id`'s terminal
    /// sign-in, then lets the terminal follow when that account is the one open now.
    pub fn adopt_terminal_sign_in(
        &self,
        profile_id: &str,
        ports: &SignInPorts,
    ) -> DesktopResult<TerminalAdoption> {
        let account = self.store.account(profile_id)?;
        let result = adopt_terminal_sign_in(
            ports,
            &account_terminal_identities(&account),
            &self.terminal_vault,
        )
        .map_err(|e| DesktopError::new(e.to_string()))?;
        self.diag("terminal-link", json!({ "result": result }));
        if result == TerminalAdoption::Saved {
            let _ = self.sync_terminal();
        }
        Ok(result)
    }

    fn terminal_mode(&self) -> TerminalMode {
        self.store
            .with_state(|s| s.settings.terminal_cli)
            .unwrap_or(DEFAULT_TERMINAL_MODE)
    }

    /// Carries the chosen Claude Code setup from the profile of the account the switch left into
    /// the one of `target`. Never fails; logs counts and short ids only.
    fn config_sync_step(&self, left_uuid: &str, target: &Account) {
        let Some(choice) = self.store.with_state(|s| s.settings.config_sync) else {
            return;
        };
        if !(choice.mcp_servers || choice.skills || choice.settings || choice.claude_md) {
            return;
        }
        let from = self.store.with_state(|s| {
            s.accounts
                .iter()
                .find(|a| {
                    a.id != target.id
                        && a.desktop
                            .as_ref()
                            .is_some_and(|d| d.account_uuid == left_uuid)
                })
                .cloned()
        });
        let Some(from) = from else {
            return;
        };
        // The switch is done; a profile left as it was is all that is lost.
        let (Ok(from_dir), Ok(to_dir)) =
            (self.store.profile(&from.id), self.store.profile(&target.id))
        else {
            return;
        };
        let backups = self.store.root().join("config-sync-backups");
        let now = Arc::clone(&self.now);
        let now_fn = move || now();
        let result = sync_profile_config(&ConfigSyncOptions {
            from: &from_dir,
            to: &to_dir,
            choice,
            backups: &backups,
            now: Some(&now_fn),
        });
        let mut map = fields(json!({
            "to": short_id(Some(target.desktop.as_ref().map_or(target.id.as_str(), |d| d.account_uuid.as_str()))),
            "mcpServers": result.mcp_servers,
            "entries": result.entries,
            "settings": result.settings,
            "claudeMd": result.claude_md,
            "backedUp": result.backup.is_some(),
        }));
        if !result.failed.is_empty() {
            map.insert("failed".into(), json!(result.failed));
        }
        self.diagnose("config-sync", Some(map));
    }

    /// Keeps the terminal's Claude Code sign-in with `target`. Never fails.
    fn terminal_step(&self, target: &Account) -> Option<TerminalOutcome> {
        let switcher = self.terminal_stepper()?;
        let known = self.store.with_state(|s| {
            s.accounts
                .iter()
                .flat_map(account_terminal_identities)
                .collect::<Vec<_>>()
        });
        let outcome = switcher.run(&TerminalRequest {
            mode: self.terminal_mode(),
            target: account_terminal_identities(target),
            known,
        });
        {
            let mut st = self.st();
            st.last_terminal = Some(outcome.clone());
            if let Some(current) = &outcome.current {
                st.last_terminal_check = Some(current.clone());
            }
        }
        let mut map = fields(json!({
            "to": short_id(Some(target.desktop.as_ref().map_or(target.id.as_str(), |d| d.account_uuid.as_str()))),
            "result": outcome.result,
        }));
        if let Some(reason) = &outcome.reason {
            map.insert("reason".into(), json!(reason));
        }
        map.insert("saved".into(), json!(outcome.saved));
        self.diagnose("terminal", Some(map));
        Some(outcome)
    }

    /// Runs the terminal step for the account Desktop is on, without changing Claude.
    pub fn sync_terminal(&self) -> DesktopResult<TerminalOutcome> {
        if self.terminal_stepper().is_none() {
            return Err("The terminal's Claude Code is not supported here.".into());
        }
        let state = self.snapshot()?;
        let active = state.active_profile_id.and_then(|id| {
            self.store
                .with_state(|s| s.accounts.iter().find(|a| a.id == id).cloned())
        });
        let Some(active) = active else {
            return Err("Switch Claude Desktop to a saved account first.".into());
        };
        self.terminal_step(&active)
            .ok_or_else(|| DesktopError::new("The terminal's Claude Code is not supported here."))
    }

    /// The setting, who the terminal is on, what is saved and the last result; None outside
    /// macOS and Linux.
    pub fn terminal_status(&self) -> Option<TerminalStatus> {
        self.terminal_stepper()?;
        let (current, last) = {
            let st = self.st();
            (st.last_terminal_check.clone(), st.last_terminal.clone())
        };
        let via_gateway = self.hooks().gateway_bound.is_some_and(|bound| bound());
        Some(TerminalStatus {
            mode: self.terminal_mode(),
            current,
            saved: self.terminal_vault.list(),
            last,
            via_gateway: via_gateway.then_some(true),
        })
    }

    /// Reads who the terminal's Claude Code is signed in to, and saves that sign-in when it is
    /// one of Relay's accounts. Writes nothing to Claude Code.
    pub fn check_terminal(&self) -> Option<TerminalStatus> {
        let switcher = self.terminal_stepper()?;
        let known = self.store.with_state(|s| {
            s.accounts
                .iter()
                .flat_map(account_terminal_identities)
                .collect::<Vec<_>>()
        });
        if let Some(current) = switcher.check(self.terminal_mode(), &known) {
            self.st().last_terminal_check = Some(current.clone());
            let mut map = fields(json!({ "state": current.state }));
            if current.state == TerminalCurrentState::SignedIn {
                map.insert("known".into(), json!(current.known == Some(true)));
                if let Some(account) = &current.account_uuid {
                    map.insert("account".into(), json!(short_id(Some(account))));
                }
            }
            self.diagnose("terminal-check", Some(map));
        }
        self.terminal_status()
    }

    /// Adds Claude's preferences file to `changes` when the account switched to has not chosen
    /// the permission modes that the one being left has. Follows the history policy; an
    /// unreadable file is left alone.
    fn permission_preferences(&self, changes: &mut Writes, from: &str, target: &Account) {
        let Some(desktop) = &target.desktop else {
            return;
        };
        let allowed = self.store.with_state(|s| {
            let source = s
                .accounts
                .iter()
                .find(|a| a.desktop.as_ref().is_some_and(|d| d.account_uuid == from));
            s.settings.desktop_history_transfer != DesktopHistoryTransfer::Off
                && source.is_some_and(|source| allowed_history_pair(source, target, &s.settings))
        });
        if !allowed {
            return;
        }
        let next = read_object(&self.root, DESKTOP_PREFERENCES)
            .ok()
            .and_then(|config| {
                plan_permission_preferences(config.as_ref(), from, &desktop.account_uuid).ok()
            })
            .flatten();
        if let Some(next) = next {
            changes.insert(DESKTOP_PREFERENCES.into(), Some(json_bytes(&next)));
        }
    }

    fn history_plan(&self, target: &Account) -> DesktopResult<Writes> {
        {
            let mut st = self.st();
            st.pending_history_seen = None;
            st.carried = Vec::new();
            st.written = 0;
        }
        let Some(desktop) = &target.desktop else {
            return Ok(Writes::new());
        };
        let windows = self.hooks().windows;
        // The account's own window holds its own conversations: no transfer between accounts.
        let window = windows
            .as_ref()
            .and_then(|w| w.folder(&desktop.account_uuid));
        let (off, sources) = self.store.with_state(|s| {
            let off = s.settings.desktop_history_transfer == DesktopHistoryTransfer::Off;
            let sources: Vec<Account> = if off {
                Vec::new()
            } else {
                history_sources(target, &s.accounts, &s.settings)
                    .into_iter()
                    .cloned()
                    .collect()
            };
            (off, sources)
        });
        if off && window.is_none() {
            return Ok(Writes::new());
        }
        let previous = read_object(&self.vault, "history-seen.json")?.unwrap_or_default();
        for (key, values) in &previous {
            let parts: Vec<&str> = key.split('/').collect();
            let valid = parts.len() == 2
                && parts.iter().all(|part| is_uuid(part))
                && values.as_array().is_some_and(|values| {
                    values.len() <= 10_000
                        && values.iter().all(|v| {
                            v.as_str()
                                .is_some_and(|s| !s.is_empty() && units(s) <= 2048)
                        })
                });
            if !valid {
                return Err("Invalid Desktop history tracking data.".into());
            }
        }
        let key = format!("{}/{}", desktop.account_uuid, desktop.org_id);
        let mut outside: Vec<OutsideSource> = window
            .map(|root| {
                vec![OutsideSource {
                    root,
                    scope: scope_of(desktop),
                }]
            })
            .unwrap_or_default();
        // And those the source accounts had in their windows: only from closed windows, and
        // only when Relay can tell which are.
        let source_windows: Vec<OutsideSource> = sources
            .iter()
            .filter_map(|source| {
                let scope = scope_of(source.desktop.as_ref()?);
                let root = windows.as_ref()?.folder(&scope.account_uuid)?;
                Some(OutsideSource { root, scope })
            })
            .collect();
        if !source_windows.is_empty()
            && let Some(Ok(open)) = windows.as_ref().map(|w| w.open_accounts())
        {
            let open: HashSet<String> = open.iter().map(|id| id.to_lowercase()).collect();
            for source in source_windows {
                if !open.contains(&source.scope.account_uuid.to_lowercase()) {
                    outside.push(source);
                }
            }
        }
        let previous_seen: Option<Vec<String>> = previous.get(&key).and_then(|v| {
            v.as_array().map(|values| {
                values
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
        });
        let plan = plan_history_detailed(
            &self.root,
            &scope_of(desktop),
            &sources
                .iter()
                .filter_map(|a| a.desktop.as_ref().map(scope_of))
                .collect::<Vec<_>>(),
            &HistoryPlanOptions {
                seen_space_ids: previous_seen.clone(),
                outside,
            },
        )?;
        let spaces_path = format!(
            "{}/spaces.json",
            scope_path("local-agent-mode-sessions", &scope_of(desktop))?
        );
        let spaces: Option<JsonObject> = match plan.writes.get(&spaces_path) {
            Some(Some(data)) => serde_json::from_slice(data)?,
            _ => read_object(&self.root, &spaces_path)?,
        };
        let mut seen: Vec<String> = previous_seen.unwrap_or_default();
        if let Some(list) = spaces
            .as_ref()
            .and_then(|s| s.get("spaces"))
            .and_then(Value::as_array)
        {
            seen.extend(
                list.iter()
                    .filter_map(|space| space.get("id")?.as_str().map(str::to_string)),
            );
        }
        let mut unique: Vec<String> = Vec::new();
        for id in seen {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        unique.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let mut next = previous.clone();
        next.insert(key, json!(unique));
        let target_dir = format!(
            "{}/",
            scope_path("claude-code-sessions", &scope_of(desktop))?
        );
        let written = plan
            .writes
            .iter()
            .filter(|(path, data)| path.starts_with(&target_dir) && data.is_some())
            .count();
        let mut st = self.st();
        if serde_json::to_string(&next)? != serde_json::to_string(&previous)? {
            st.pending_history_seen = Some(json_bytes(&next));
        }
        st.carried = plan.conversations;
        st.written = written;
        Ok(plan.writes)
    }

    /// Captures the unsent drafts of the account being left (`from`) in the conversations the
    /// switch carries, to be re-typed for the one switched to (`to`). Runs once the switch's files
    /// are written and while Claude is still closed. Drafts follow the history policy. Never
    /// fails, so a draft can never fail, roll back or hold up a switch.
    fn carry_drafts(
        &self,
        from: &str,
        to: &str,
        target: &Account,
        conversations: &[CarriedConversation],
    ) {
        let _ = self.sidebar.clear();
        let not_run = |reason: &str| {
            self.diag(
                "capture",
                json!({ "from": short_id(Some(from)), "to": short_id(Some(to)), "status": "not-run", "reason": reason }),
            )
        };
        let host = &self.host;
        if !host.reads_drafts() {
            return not_run("no-draft-reader");
        }
        let (off, allowed) = self.store.with_state(|s| {
            let off = s.settings.desktop_history_transfer == DesktopHistoryTransfer::Off;
            let source = s
                .accounts
                .iter()
                .find(|a| a.desktop.as_ref().is_some_and(|d| d.account_uuid == from));
            (
                off,
                source.is_some_and(|source| allowed_history_pair(source, target, &s.settings)),
            )
        });
        if off {
            return not_run("history-off");
        }
        if !allowed {
            return not_run("pair-not-allowed");
        }
        let blocked = (|| -> DesktopResult<Option<String>> {
            if let Some(reason) = host.drafts_blocked()?.filter(|r| !r.is_empty()) {
                return Ok(Some(reason));
            }
            // The copy is made while Claude is closed; one Claude is writing could be torn.
            if host.running()? {
                return Ok(Some(CLAUDE_RUNNING.into()));
            }
            Ok(None)
        })()
        .unwrap_or_else(|error| Some(error.message().to_string()));
        let captured = Mutex::new(Vec::<CapturedDraft>::new());
        // Read only for a step that will run.
        let titles = if blocked.is_some() {
            HashMap::new()
        } else {
            self.draft_titles(target, conversations)
        };
        let run = |job: &DraftJob| host.read_drafts(job);
        let store =
            |account: &str, drafts: &[CapturedDraft], slots: &crate::draft_vault::DraftSlots| {
                *captured.lock().unwrap_or_else(|e| e.into_inner()) = drafts.to_vec();
                self.drafts
                    .add(account, drafts, Some(slots))
                    .map_err(|e| e.to_string())
            };
        let sidebar = |raw: Option<&JsMap<String>>| {
            self.plan_sidebar(raw, from, target, conversations);
            Ok(())
        };
        let running = || host.running().map_err(|e| e.to_string());
        let last_json = self.vault.join("drafts").join("last.json");
        let tmp = host.draft_scratch_dir();
        let outcome = capture_drafts(CaptureInput {
            root: &self.root,
            from,
            to,
            conversations,
            titles: &titles,
            run: &run,
            store: &store,
            sidebar: Some(&sidebar),
            last_json: &last_json,
            now_ms: crate::clock::now_ms(),
            blocked,
            // Asked again once the copy is made: Claude can be opened meanwhile.
            running: Some(&running),
            tmp: tmp.as_deref(),
        });
        let captured = captured.into_inner().unwrap_or_else(|e| e.into_inner());
        self.diagnose(
            "capture",
            Some(capture_fields(from, to, &outcome, &captured)),
        );
    }

    /// Keeps what the account switched to lacks of its sources' Code sidebar organization, from
    /// the sidebar keys the draft read found (`raw`, None when it read none). Logs counts only.
    fn plan_sidebar(
        &self,
        raw: Option<&JsMap<String>>,
        from: &str,
        target: &Account,
        conversations: &[CarriedConversation],
    ) {
        let Some(desktop) = &target.desktop else {
            return;
        };
        let base =
            json!({ "from": short_id(Some(from)), "to": short_id(Some(&desktop.account_uuid)) });
        let with = |extra: Value| {
            let mut map = fields(base.clone());
            map.extend(fields(extra));
            map
        };
        let Some(raw) = raw else {
            return self.diagnose("sidebar", Some(with(json!({ "status": "not-read" }))));
        };
        let result =
            (|| -> Result<Option<crate::sidebar_layout::SidebarGap>, UnsupportedSidebar> {
                let storage = read_sidebar_storage(raw)?;
                let mut sources: Vec<Scope> = self.store.with_state(|s| {
                    history_sources(target, &s.accounts, &s.settings)
                        .into_iter()
                        .filter_map(|a| a.desktop.as_ref().map(scope_of))
                        .collect()
                });
                // The account being left first; the sort is stable.
                sources.sort_by_key(|scope| scope.account_uuid != from);
                let sources = sources
                    .iter()
                    .map(|scope| {
                        Ok(AccountLayout {
                            account_uuid: scope.account_uuid.clone(),
                            layout: storage.layout(scope)?,
                        })
                    })
                    .collect::<Result<Vec<_>, UnsupportedSidebar>>()?;
                let target_layout = AccountLayout {
                    account_uuid: desktop.account_uuid.clone(),
                    layout: storage.layout(&scope_of(desktop))?,
                };
                Ok(plan_sidebar_gap(
                    &sources,
                    &target_layout,
                    conversations,
                    &storage.starred,
                ))
            })();
        match result {
            Ok(None) => self.diagnose("sidebar", Some(with(json!({ "status": "none" })))),
            Ok(Some(gap)) => {
                let (sections, missing, sessions) =
                    (gap.sections.len(), gap.missing_sections, gap.sessions);
                match self.sidebar.put(&desktop.account_uuid, gap) {
                    Ok(_) => self.diagnose(
                        "sidebar",
                        Some(with(json!({
                            "status": "planned",
                            "sections": sections,
                            "missing": missing,
                            "sessions": sessions,
                        }))),
                    ),
                    Err(error) => self.diagnose(
                        "sidebar",
                        Some(with(json!({ "status": "failed", "reason": safe_message(&error.to_string()) }))),
                    ),
                }
            }
            Err(error) => self.diagnose(
                "sidebar",
                Some(with(
                    json!({ "status": "unsupported", "reason": safe_message(&error.to_string()) }),
                )),
            ),
        }
    }

    /// The account named for the sidebar offer: its Relay name, or a short id when it has none.
    fn account_name(&self, account_uuid: &str) -> String {
        self.store
            .with_state(|s| {
                s.accounts
                    .iter()
                    .find(|a| {
                        a.desktop.as_ref().is_some_and(|d| {
                            d.account_uuid.to_lowercase() == account_uuid.to_lowercase()
                        })
                    })
                    .map(|a| a.name.clone())
            })
            .unwrap_or_else(|| short_id(Some(account_uuid)).unwrap_or_default())
    }

    /// The sidebar offer, while Desktop is still on the account it was made for.
    fn current_sidebar_gap(&self) -> Option<SidebarGapRecord> {
        let record = self.sidebar.get()?;
        let current = identity(read_object(&self.root, "config.json").ok()?.as_ref());
        (current.map(|c| c.to_lowercase()) == Some(record.to.to_lowercase())).then_some(record)
    }

    /// What Desktop's current account lacks of its sources' sidebar sections, for the panel.
    pub fn sidebar_gap(&self) -> Option<SidebarGapSummary> {
        let record = self.current_sidebar_gap()?;
        Some(SidebarGapSummary {
            id: record.id.clone(),
            to: self.account_name(&record.to),
            from: record
                .gap
                .from
                .iter()
                .map(|u| self.account_name(u))
                .collect(),
            missing_sections: record.gap.missing_sections as f64,
            sessions: record.gap.sessions as f64,
        })
    }

    /// The recipe of sidebar gap `id`, while it is offered. Main process only.
    pub fn sidebar_recipe(&self, id: &str) -> Option<String> {
        let record = self.current_sidebar_gap().filter(|r| r.id == id)?;
        let from: Vec<String> = record
            .gap
            .from
            .iter()
            .map(|u| self.account_name(u))
            .collect();
        Some(sidebar_recipe(
            &record.gap,
            &self.account_name(&record.to),
            &from,
        ))
    }

    pub fn dismiss_sidebar_gap(&self, id: &str) -> DesktopResult<()> {
        Ok(self.sidebar.remove(id)?)
    }

    /// The title of each carried conversation on the target's card of it, as the merge left it.
    /// "" when the card has none or cannot be read.
    fn draft_titles(
        &self,
        target: &Account,
        conversations: &[CarriedConversation],
    ) -> HashMap<String, String> {
        let Some(dir) = target
            .desktop
            .as_ref()
            .and_then(|d| scope_path("claude-code-sessions", &scope_of(d)).ok())
        else {
            return HashMap::new();
        };
        conversations
            .iter()
            .map(|c| {
                let title =
                    read_object(&self.root, &format!("{dir}/local_{}.json", c.target_alias))
                        .ok()
                        .flatten()
                        .and_then(|card| card.get("title")?.as_str().map(str::to_string))
                        .unwrap_or_default();
                (c.target_alias.clone(), title)
            })
            .collect()
    }

    /// The captured drafts, newest first, for the panel: no text.
    pub fn pending_drafts(&self) -> Vec<DraftSummary> {
        self.drafts.list().iter().map(summarize).collect()
    }

    /// The captured drafts with their text. Main process only.
    pub fn pending_draft_records(&self) -> Vec<DraftRecord> {
        self.drafts.list()
    }

    /// The text of the captured draft `id`. Main process only.
    pub fn draft_text(&self, id: &str) -> Option<String> {
        self.drafts
            .list()
            .into_iter()
            .find(|r| r.id == id)
            .map(|r| r.text)
    }

    pub fn mark_draft(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<String>,
    ) -> DesktopResult<()> {
        Ok(self.drafts.update(
            id,
            DraftPatch {
                state: Some(state),
                reason: Some(reason),
            },
        )?)
    }

    pub fn dismiss_draft(&self, id: &str) -> DesktopResult<()> {
        Ok(self.drafts.remove(id)?)
    }

    /// How long Claude has run, in ms; None when the host cannot tell.
    pub fn claude_uptime_ms(&self) -> Option<i64> {
        self.host.claude_uptime_ms()
    }

    pub fn recover(&self) -> DesktopResult<()> {
        self.exclusive((DesktopOperationKind::Restore, None), true, || {
            let Some(journal) = self.journal()? else {
                return Ok(());
            };
            self.quit_claude(None)?;
            let backup = journal
                .get("backup")
                .and_then(Value::as_str)
                .filter(|id| is_uuid(id))
                .ok_or_else(|| DesktopError::new("Invalid UUID"))?
                .to_string();
            self.restore(&backup)?;
            write_bytes(&self.vault, "journal.json", None)?;
            self.st().last_error = None;
            self.relaunch()
        })
    }

    fn exclusive<T>(
        &self,
        (kind, profile_id): (DesktopOperationKind, Option<String>),
        recovery: bool,
        f: impl FnOnce() -> DesktopResult<T>,
    ) -> DesktopResult<T> {
        {
            let mut st = self.st();
            if st.busy {
                return Err("A Desktop operation is already in progress.".into());
            }
            // Taken before anything else: separate calls must not both pass the guard.
            st.busy = true;
            st.started += 1;
            st.last_error = None;
            st.operation = Some(Operation {
                kind,
                profile_id,
                restarted: false,
            });
            st.shared = None;
        }
        let mut release: Option<Box<dyn FnOnce() + Send>> = None;
        let result = (|| {
            if let Some(lock) = self.hooks().operation_lock {
                release = Some(lock.ensure(kind)?);
            }
            if !self.host.available() {
                return Err("Claude Desktop was not found on this platform.".into());
            }
            if !recovery && self.journal()?.is_some() {
                return Err("Restore the interrupted Desktop switch first.".into());
            }
            self.refresh_pending();
            f()
        })();
        if let Err(error) = &result
            && (!matches!(error, DesktopError::SwitchRefused(_))
                || error.message() == SWITCH_CANCELLED)
        {
            self.report_error(error.message());
        }
        if let Some(release) = release {
            release();
        }
        let operation = {
            let mut st = self.st();
            st.busy = false;
            st.shared = None;
            st.pending_history_seen = None;
            st.operation.take()
        };
        if let Some(operation) = operation.filter(|op| op.restarted) {
            self.report(false, &operation, result.is_ok());
        }
        result
    }

    /// Quits Claude for the running operation, reporting the restart first.
    fn quit_claude(&self, answer_guard: Option<Arc<AnswerGuard>>) -> DesktopResult<()> {
        let first = {
            let mut st = self.st();
            match st.operation.as_mut() {
                Some(op) if !op.restarted => {
                    op.restarted = true;
                    Some(op.clone())
                }
                _ => None,
            }
        };
        if let Some(op) = first {
            self.report(true, &op, false);
        }
        self.settle_session(false)?;
        self.host.quit(answer_guard.as_deref())
    }

    fn report(&self, start: bool, operation: &Operation, ok: bool) {
        let kind = operation.kind;
        let profile_id = operation.profile_id.clone();
        let event = if start {
            DesktopRestartEvent::Start { kind, profile_id }
        } else {
            DesktopRestartEvent::End {
                kind,
                profile_id,
                ok,
            }
        };
        if let Some(hook) = self.hooks().on_restart {
            tell(|| hook(&event));
        }
    }

    fn assert_profile_identity(
        &self,
        account: &Account,
        account_uuid: &str,
        org_id: &str,
    ) -> DesktopResult<()> {
        let auth = account.auth.as_ref();
        if let Some(uuid) = auth
            .and_then(|a| a.account_uuid.as_deref())
            .filter(|u| !u.is_empty())
            && uuid.to_lowercase() != account_uuid.to_lowercase()
        {
            return Err("This profile is connected to a different Claude account. Choose the matching Desktop account.".into());
        }
        if let Some(org) = auth
            .and_then(|a| a.org_id.as_deref())
            .filter(|o| !o.is_empty())
            && org.to_lowercase() != org_id.to_lowercase()
        {
            return Err("This profile is connected to a different Claude organization. Choose its matching Code workspace.".into());
        }
        Ok(())
    }

    fn assert_current_saved(&self) -> DesktopResult<()> {
        if let Some(current) = identity(read_object(&self.root, "config.json")?.as_ref())
            && !self.desktop_saved(&current)
        {
            return Err("Save the current Desktop account before switching.".into());
        }
        Ok(())
    }

    fn restart(
        &self,
        f: impl FnOnce() -> DesktopResult<()>,
        can_proceed: Option<CanProceed>,
        before_quit: Option<BeforeQuit>,
        answer_quit_guard: Option<Arc<AnswerGuard>>,
    ) -> DesktopResult<()> {
        // Check the live handoff guard immediately before asking Claude to quit.
        let refused = || desktop_switch_refused(SWITCH_CANCELLED);
        if can_proceed.as_ref().is_some_and(|c| !c()) {
            return Err(refused());
        }
        if let Some(before_quit) = &before_quit {
            before_quit()?;
        }
        if can_proceed.as_ref().is_some_and(|c| !c()) {
            return Err(refused());
        }
        self.quit_claude(answer_quit_guard)?;
        let result = f();
        if self.journal()?.is_none() {
            self.relaunch()?;
        }
        result
    }

    /// Starts Claude after Relay quit it, and holds the operation until its claude.ai page boots.
    /// A page that has not booted after PAGE_BOOT_MS while Claude still runs: Claude is quit and
    /// started once more, without HTTP/3. A start without HTTP/3 that Claude refuses is followed
    /// at once by a plain start. Only a failed launch fails.
    fn relaunch(&self) -> DesktopResult<()> {
        let quic_off = self.quic_choice();
        let first = self.launch_watched(1, quic_off)?;
        if first == Some(PageOutcome::Refused) && quic_off {
            self.diag(
                "claude-boot-refused",
                json!({ "attempt": 1, "quicOff": quic_off }),
            );
            self.launch_watched(2, false)?;
            return Ok(());
        }
        if first != Some(PageOutcome::Stalled) {
            return Ok(());
        }
        if self.host.quit(None).is_err() {
            self.diag("claude-boot-retry", json!({ "quit": false }));
            return Ok(());
        }
        self.diag("claude-boot-retry", json!({ "quit": true }));
        // The second start goes without HTTP/3; it is watched too, and never followed by a third.
        let second = self.launch_watched(2, true)?;
        if second == Some(PageOutcome::Loaded)
            && !quic_off
            && let Some(choice) = self.hooks().launch_choice
            && choice.learn_quic_off().is_ok()
        {
            self.diag("claude-quic-off", json!({ "learned": true }));
        }
        Ok(())
    }

    /// One launch, without HTTP/3 when `quic_off`; the watch then says how its page did. None
    /// when the watch cannot tell.
    fn launch_watched(&self, attempt: u32, quic_off: bool) -> DesktopResult<Option<PageOutcome>> {
        let watch = self.host.watch_launch();
        self.launch(quic_off.then_some(LaunchOptions { quic_off: true }))?;
        let Some(watch) = watch else {
            return Ok(None);
        };
        let begun = self.now();
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| watch.wait(PAGE_BOOT_MS)))
                .unwrap_or(PageOutcome::Unknown);
        self.diag(
            "claude-boot",
            json!({ "attempt": attempt, "outcome": outcome, "quicOff": quic_off, "waitedMs": self.now() - begun }),
        );
        Ok(Some(outcome))
    }

    /// Puts `account_uuid`'s saved sign-in into a separate window's data folder `dir`, in place
    /// of any other, so the window opens signed in. The window must not run yet.
    pub fn seed_window(&self, account_uuid: &str, dir: &Path) -> DesktopResult<()> {
        self.window_operation(|| {
            let saved = self.read_login(account_uuid)?;
            let main = read_object(&self.root, "config.json")?.unwrap_or_default();
            let mut config = read_object(dir, "config.json")?.unwrap_or_default();
            // The main Claude's language and theme, so the window looks like it.
            for key in WINDOW_CONFIG_KEYS {
                if let Some(value) = main.get(key) {
                    config.insert(key.into(), value.clone());
                }
            }
            for key in AUTH_KEYS {
                config.shift_remove(key);
                if let Some(value) = saved.auth.get(key) {
                    config.insert(key.into(), value.clone());
                }
            }
            write_bytes(dir, "config.json", Some(&json_bytes(&config)))?;
            for file in COOKIE_FILES {
                write_bytes(dir, file, saved.cookie(file).as_deref())?;
            }
            // The user's MCP servers and preferences are the main Claude's.
            if let Some(preferences) = read_bytes(&self.root, DESKTOP_PREFERENCES)? {
                write_bytes(dir, DESKTOP_PREFERENCES, Some(&preferences))?;
            }
            // The account's own Code conversations, as the main Claude has them. Only its own.
            let account = self.store.with_state(|s| {
                s.accounts
                    .iter()
                    .find(|a| {
                        a.desktop.as_ref().is_some_and(|d| {
                            d.account_uuid.to_lowercase() == account_uuid.to_lowercase()
                        })
                    })
                    .cloned()
            });
            if let Some(desktop) = account.and_then(|a| a.desktop) {
                let plan = plan_history_detailed(
                    dir,
                    &scope_of(&desktop),
                    &[],
                    &HistoryPlanOptions {
                        seen_space_ids: None,
                        outside: vec![OutsideSource {
                            root: self.root.clone(),
                            scope: scope_of(&desktop),
                        }],
                    },
                )?;
                for (relative, data) in &plan.writes {
                    write_bytes(dir, relative, data.as_deref())?;
                }
            }
            Ok(())
        })
    }

    /// Saves the sign-in a closed window left in `dir` back to the vault, while it is still
    /// `account_uuid`'s. Whether it saved.
    pub fn seal_window(&self, account_uuid: &str, dir: &Path) -> DesktopResult<bool> {
        self.window_operation(|| {
            if identity(read_object(dir, "config.json")?.as_ref()).as_deref() != Some(account_uuid)
            {
                return Ok(false);
            }
            Ok(self.save_current(dir, false)?.as_deref() == Some(account_uuid))
        })
    }

    /// A window's step, which never hides the error an earlier operation left to read.
    fn window_operation<T>(&self, f: impl FnOnce() -> DesktopResult<T>) -> DesktopResult<T> {
        let shown = self.st().last_error.clone();
        let result = self.exclusive((DesktopOperationKind::Window, None), false, f);
        let mut st = self.st();
        if st.last_error.is_none() {
            st.last_error = shown;
        }
        result
    }

    fn live_cookie_files(&self, root: &Path) -> CookieFiles {
        COOKIE_FILES
            .iter()
            .map(|name| (name.to_string(), read_bytes(root, name).ok().flatten()))
            .collect()
    }

    /// While Claude runs signed in to an account whose session is not in the cookie file yet,
    /// waits for it, up to `session_settle_ms`. With `required`, a session still missing fails
    /// before anything is quit or changed.
    fn settle_session(&self, required: bool) -> DesktopResult<()> {
        let hooks = self.hooks();
        let absent = || {
            identity(
                read_object(&self.root, "config.json")
                    .ok()
                    .flatten()
                    .as_ref(),
            )
            .is_some()
                && (hooks.session_of)(&self.live_cookie_files(&self.root))
                    == SessionPresence::Absent
        };
        if !self.host.running().unwrap_or(false) || !absent() {
            return Ok(());
        }
        if self.host.signed_out() == Some(true) {
            if required {
                return Err(CLAUDE_SIGNED_OUT.into());
            }
            return Ok(());
        }
        let until = self.now() + hooks.session_settle_ms;
        self.diag("sign-in-settle", json!({ "required": required }));
        while self.now() < until {
            std::thread::sleep(Duration::from_millis(hooks.session_poll_ms));
            if !absent() {
                return Ok(());
            }
        }
        self.diag("sign-in-unsettled", json!({ "required": required }));
        if required {
            return Err(SignInNotSettled.into());
        }
        Ok(())
    }

    /// Saves the sign-in Claude holds into the vault and answers its account. A sign-in without
    /// its session is never saved over one already kept; with `require_session` it fails instead.
    fn save_current(&self, root: &Path, require_session: bool) -> DesktopResult<Option<String>> {
        let config = read_object(root, "config.json")?;
        let Some(account_uuid) = identity(config.as_ref()) else {
            return Ok(None);
        };
        let config = config.unwrap_or_default();
        let mut auth = Map::new();
        for key in AUTH_KEYS {
            if let Some(value) = config.get(key) {
                auth.insert(key.into(), value.clone());
            }
        }
        let files = self.live_cookie_files(root);
        let session = (self.hooks().session_of)(&files);
        if session == SessionPresence::Absent {
            let kept = self.read_login(&account_uuid).is_ok();
            self.diag(
                "sign-in-without-session",
                json!({ "account": &account_uuid[..8], "kept": kept }),
            );
            if require_session {
                return Err(SIGN_IN_WITHOUT_SESSION.into());
            }
            if kept {
                return Ok(Some(account_uuid));
            }
        }
        let mut cookies = Map::new();
        for name in COOKIE_FILES {
            let value = files
                .get(name)
                .cloned()
                .flatten()
                .map_or(Value::Null, |data| Value::String(b64(&data)));
            cookies.insert(name.into(), value);
        }
        let login = json!({ "accountUuid": account_uuid, "auth": auth, "cookies": cookies });
        write_bytes(
            &self.vault,
            &format!("accounts/{account_uuid}.bin"),
            Some(&self.host.seal(&login.to_string())?),
        )?;
        // Claude drops the cookies of a session claude.ai refuses, so one still here was accepted.
        if session == SessionPresence::Present {
            self.clear_rejected(&account_uuid)?;
        }
        Ok(Some(account_uuid))
    }

    fn clear_rejected(&self, account_uuid: &str) -> DesktopResult<()> {
        let marked = self.store.with_state(|s| {
            s.accounts.iter().any(|a| {
                a.desktop
                    .as_ref()
                    .is_some_and(|d| d.account_uuid == account_uuid && d.rejected_at.is_some())
            })
        });
        if !marked {
            return Ok(());
        }
        Ok(self.store.update(|s| {
            for a in &mut s.accounts {
                if let Some(d) = a
                    .desktop
                    .as_mut()
                    .filter(|d| d.account_uuid == account_uuid)
                {
                    d.rejected_at = None;
                }
            }
        })?)
    }

    fn mark_rejected(&self, account_id: &str, account_uuid: &str, why: &str) -> Option<Account> {
        let at = iso_timestamp(self.now());
        let mut marked: Option<Account> = None;
        self.store
            .update(|s| {
                let Some(a) = s.accounts.iter_mut().find(|x| x.id == account_id) else {
                    return;
                };
                let Some(d) = a
                    .desktop
                    .as_mut()
                    .filter(|d| d.account_uuid == account_uuid)
                else {
                    return;
                };
                d.rejected_at = Some(at);
                marked = Some(a.clone());
            })
            .ok()?;
        let marked = marked?;
        self.diag(
            "sign-in-rejected",
            json!({ "account": &account_uuid[..account_uuid.len().min(8)], "why": why }),
        );
        self.invalidate();
        if let Some(hook) = self.hooks().on_sign_in_rejected {
            tell(|| hook(&marked));
        }
        Some(marked)
    }

    /// Each account Claude's log shows signing out after its copy was saved is marked, unless
    /// Claude is signed in to it again now. Never fails; quiet while an operation runs.
    pub fn note_sign_outs(&self) {
        {
            let st = self.st();
            if st.busy || st.pending.is_some() {
                return;
            }
        }
        let Some(outs) = self.host.sign_outs() else {
            return;
        };
        if outs.is_empty() {
            return;
        }
        let live = identity(
            read_object(&self.root, "config.json")
                .ok()
                .flatten()
                .as_ref(),
        );
        for out in outs {
            let account = self.store.with_state(|s| {
                s.accounts
                    .iter()
                    .find(|a| {
                        a.desktop
                            .as_ref()
                            .is_some_and(|d| d.account_uuid.to_lowercase() == out.account_uuid)
                    })
                    .cloned()
            });
            let Some(account) = account else { continue };
            let Some(desktop) = account.desktop.as_ref().filter(|d| d.rejected_at.is_none()) else {
                continue;
            };
            if live.as_ref().map(|l| l.to_lowercase()) == Some(out.account_uuid.clone()) {
                continue;
            }
            let file = self
                .vault
                .join("accounts")
                .join(format!("{}.bin", desktop.account_uuid));
            let saved = std::fs::metadata(&file)
                .ok()
                .and_then(|m| mtime_ms(&m).ok());
            match saved {
                Some(saved) if saved < out.at as f64 => {
                    self.mark_rejected(&account.id, &desktop.account_uuid, "signed-out-in-claude");
                }
                _ => continue,
            }
        }
    }

    /// Each account whose saved sign-in has ended (and that the Claude app is not on now) is
    /// marked like one Claude refused. At most every half hour; quiet while an operation runs.
    pub fn note_ended_sign_ins(&self) {
        let now = self.now();
        {
            let mut st = self.st();
            if st.busy || st.pending.is_some() {
                return;
            }
            if st.ended_checked_at.is_some_and(|at| now - at < 30 * 60_000) {
                return;
            }
            st.ended_checked_at = Some(now);
        }
        let live = identity(
            read_object(&self.root, "config.json")
                .ok()
                .flatten()
                .as_ref(),
        );
        let session_ends = self.hooks().session_ends;
        for account in self.store.state().accounts {
            let Some(desktop) = account.desktop.as_ref().filter(|d| d.rejected_at.is_none()) else {
                continue;
            };
            if live.as_ref().map(|l| l.to_lowercase()) == Some(desktop.account_uuid.to_lowercase())
            {
                continue;
            }
            let Ok(saved) = self.read_login(&desktop.account_uuid) else {
                continue;
            };
            let files: CookieFiles = saved
                .cookies
                .iter()
                .map(|(name, data)| (name.clone(), data.as_str().map(unb64)))
                .collect();
            if session_ends(&files).is_some_and(|ends| ends <= now as f64) {
                self.mark_rejected(&account.id, &desktop.account_uuid, "saved-session-ended");
            }
        }
    }

    fn verify_sign_in_later(&self, target: Account) {
        let Some(this) = self.this.upgrade() else {
            return;
        };
        let times = self.hooks().sign_in_verify_ms;
        let run = {
            let mut st = self.st();
            st.sign_in_verify_run += 1;
            st.sign_in_verify_run
        };
        let handle = std::thread::spawn(move || {
            let mut waited = 0;
            for at in times {
                std::thread::sleep(Duration::from_millis(at.saturating_sub(waited)));
                waited = at;
                // A newer switch's run replaced this one.
                if this.st().sign_in_verify_run != run {
                    return;
                }
                if this.verify_sign_in(&target) {
                    return;
                }
            }
        });
        *self
            .sign_in_verified
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    /// Waits for the last scheduled sign-in look to finish; for tests.
    pub fn wait_sign_in_verified(&self) {
        let handle = self
            .sign_in_verified
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    /// One look after a switch started Claude as `target`: when Claude signed itself out while it
    /// still names the account, claude.ai refused the saved session. Whether the look is final.
    fn verify_sign_in(&self, target: &Account) -> bool {
        {
            let st = self.st();
            // Another operation since: what Claude holds is no longer this switch's.
            if st.busy || st.pending.is_some() {
                return true;
            }
        }
        let Some(desktop) = &target.desktop else {
            return true;
        };
        match self.host.signed_out() {
            None => return true,
            Some(false) => return false,
            Some(true) => {}
        }
        let live = identity(
            read_object(&self.root, "config.json")
                .ok()
                .flatten()
                .as_ref(),
        );
        if live.is_some_and(|live| live != desktop.account_uuid) {
            return true;
        }
        self.mark_rejected(&target.id, &desktop.account_uuid, "refused-after-switch");
        true
    }

    /// The cookie files of `account_uuid`'s Claude app sign-in, for a usage read: Claude's own
    /// while it is signed in to that account, else the copy saved in the vault.
    pub fn login_cookie_files(&self, account_uuid: &str) -> DesktopResult<CookieFiles> {
        let read = |root: &Path| -> DesktopResult<CookieFiles> {
            COOKIE_FILES
                .iter()
                .map(|name| Ok((name.to_string(), read_bytes(root, name)?)))
                .collect()
        };
        let live = || {
            identity(
                read_object(&self.root, "config.json")
                    .ok()
                    .flatten()
                    .as_ref(),
            )
        };
        if !self.is_busy() && live().as_deref() == Some(account_uuid) {
            let files = read(&self.root)?;
            // Another account could have come in while the files were read.
            if !self.is_busy() && live().as_deref() == Some(account_uuid) {
                return Ok(files);
            }
        }
        Ok(self.read_login(account_uuid)?.cookie_files())
    }

    fn read_login(&self, account_uuid: &str) -> DesktopResult<SavedLogin> {
        if !is_uuid(account_uuid) {
            return Err("Invalid UUID".into());
        }
        let Some(data) = read_bytes(&self.vault, &format!("accounts/{account_uuid}.bin"))? else {
            return Err("Saved Desktop sign-in is missing. Connect this account again.".into());
        };
        let saved: Value = serde_json::from_str(&self.host.unseal(&data)?)?;
        let invalid = || DesktopError::new("Invalid saved Desktop sign-in.");
        let auth = saved.get("auth").and_then(Value::as_object).cloned();
        if identity(auth.as_ref()).as_deref() != Some(account_uuid)
            || saved.get("accountUuid").and_then(Value::as_str) != Some(account_uuid)
        {
            return Err(invalid());
        }
        let cookies = saved
            .get("cookies")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(invalid)?;
        Ok(SavedLogin {
            account_uuid: account_uuid.to_string(),
            auth: auth.unwrap_or_default(),
            cookies,
        })
    }

    fn apply(&self, changes: Writes, options: &ApplyOptions) -> DesktopResult<()> {
        let history_seen = self.st().pending_history_seen.take();
        if changes.is_empty() && history_seen.is_none() {
            return Ok(());
        }
        let guard = || -> DesktopResult<()> {
            if options.can_proceed.as_ref().is_some_and(|c| !c()) {
                return Err(
                    "Automatic Desktop switch was cancelled because its conditions changed.".into(),
                );
            }
            if self.host.running()? {
                return Err(STILL_RUNNING.into());
            }
            Ok(())
        };
        guard()?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut files = Map::new();
        let mut backup = Map::new();
        let mut seen = None;
        if history_seen.is_some() {
            seen = Some(
                read_bytes(&self.vault, "history-seen.json")?
                    .map_or(Value::Null, |data| Value::String(b64(&data))),
            );
        }
        for relative in changes.keys() {
            let value = read_bytes(&self.root, relative)?
                .map_or(Value::Null, |data| Value::String(b64(&data)));
            files.insert(relative.clone(), value);
        }
        backup.insert("files".into(), Value::Object(files));
        backup.insert(
            "createdAt".into(),
            Value::String(iso_timestamp(crate::clock::now_ms())),
        );
        if let Some(seen) = seen {
            backup.insert("historySeen".into(), seen);
        }
        write_bytes(
            &self.vault,
            &format!("backups/{id}.bin"),
            Some(&self.host.seal(&Value::Object(backup).to_string())?),
        )?;
        write_bytes(
            &self.vault,
            "journal.json",
            Some(&json_bytes(&json!({ "backup": id }))),
        )?;
        self.st().last_backup = Some(id.clone());
        // The journal names the new backup, so it is kept; older ones beyond the newest 20 go.
        prune_switch_backups(&self.vault, SWITCH_BACKUP_LIMIT);
        let written = (|| -> DesktopResult<()> {
            for (relative, data) in &changes {
                guard()?;
                write_bytes(&self.root, relative, data.as_deref())?;
            }
            if let Some(seen) = &history_seen {
                guard()?;
                write_bytes(&self.vault, "history-seen.json", Some(seen))?;
            }
            guard()?;
            write_bytes(&self.vault, "journal.json", None)?;
            Ok(())
        })();
        if let Err(error) = written {
            // Claude may have been opened by the user during a closed-app transaction. Keep the
            // recoverable journal; neither continue writing nor roll back live data.
            if self.host.running()? {
                return Err(OPENED_DURING_SWITCH.into());
            }
            // If restore fails, the journal blocks later writes and launches.
            self.restore(&id)?;
            write_bytes(&self.vault, "journal.json", None)?;
            return Err(error);
        }
        Ok(())
    }

    fn restore(&self, id: &str) -> DesktopResult<()> {
        if !is_uuid(id) {
            return Err("Invalid UUID".into());
        }
        let Some(data) = read_bytes(&self.vault, &format!("backups/{id}.bin"))? else {
            return Err("Desktop recovery backup is missing.".into());
        };
        let backup: Value = serde_json::from_str(&self.host.unseal(&data)?)?;
        let Some(files) = backup.get("files").and_then(Value::as_object) else {
            return Err("Invalid Desktop backup.".into());
        };
        let history_seen = backup.get("historySeen");
        if history_seen.is_some_and(|v| !v.is_null() && !v.is_string()) {
            return Err("Invalid recovery data.".into());
        }
        for (relative, value) in files {
            if !(relative == "config.json"
                || COOKIE_FILES.contains(&relative.as_str())
                || RESTORE_SESSION.is_match(relative)
                || RESTORE_SPACES.is_match(relative))
            {
                return Err("Invalid recovery path.".into());
            }
            if !value.is_null() && !value.is_string() {
                return Err("Invalid recovery data.".into());
            }
        }
        for (relative, value) in files {
            if self.host.running()? {
                return Err(OPENED_DURING_SWITCH.into());
            }
            write_bytes(&self.root, relative, value.as_str().map(unb64).as_deref())?;
        }
        if let Some(seen) = history_seen {
            write_bytes(
                &self.vault,
                "history-seen.json",
                seen.as_str().map(unb64).as_deref(),
            )?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct ApplyOptions {
    can_proceed: Option<CanProceed>,
}

// ---------------------------------------------------------------------------------------------
// The Claude browser extension's sign-in, kept with the account at a switch.

use crate::browser_system::{BrowserSystem, browser_running, data_dir, denied_browsers, read_json};
use crate::cookie_store::CookieStorage;
use crate::cookie_vault::CookieVault;
use crate::extension_storage::ExtensionStorage;
use crate::extension_switch::{CheckRequest, ExtensionRequest, ExtensionSwitcher};
use crate::extension_vault::ExtensionVault;
use crate::shared::browser_extension::{
    ExtensionCurrent, ExtensionMode, ExtensionOffer, ExtensionOutcome, ExtensionReason,
    ExtensionResult, ExtensionSetting, ExtensionStatus, browser, choose_instance,
    default_extension, pick_instance, startup_restores,
};

/// The browsers and the extension's storage the extension step works on.
#[derive(Clone)]
pub struct ExtensionPorts {
    pub system: Arc<dyn BrowserSystem>,
    pub storage: Arc<dyn ExtensionStorage>,
    pub cookies: Option<Arc<dyn CookieStorage>>,
}

fn default_offline() -> bool {
    crate::usage_refresh::anthropic_unreachable(&crate::usage_refresh::default_probe)
}

#[derive(Default)]
struct ExtensionState {
    last: Option<ExtensionOutcome>,
    last_check: Option<ExtensionCurrent>,
    /// The last extension check written to the diagnosis log, so a repeated one is not.
    check_logged: Option<String>,
    /// Counts verification runs: a newer step's run stops an older one's later looks.
    verify_run: u64,
}

struct ExtensionParts {
    vault: Arc<ExtensionVault>,
    cookie_vault: Arc<CookieVault>,
    switcher: Mutex<Option<Arc<ExtensionSwitcher>>>,
    /// One check at a time.
    checking: Mutex<()>,
    /// The first look of the last scheduled verification; for tests.
    verified: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl ExtensionParts {
    fn new(
        vault: &Path,
        seal: crate::draft_vault::Seal,
        unseal: crate::draft_vault::Unseal,
        now: Clock,
    ) -> ExtensionParts {
        ExtensionParts {
            vault: Arc::new(ExtensionVault::new(
                vault,
                Arc::clone(&seal),
                Arc::clone(&unseal),
                Some(Arc::clone(&now)),
            )),
            cookie_vault: Arc::new(CookieVault::new(vault, seal, unseal, Some(now))),
            switcher: Mutex::new(None),
            checking: Mutex::new(()),
            verified: Mutex::new(None),
        }
    }
}

/// A signed-in check's account, `known`, `other` and `expired`.
type SignedIn<'a> = (Option<&'a String>, bool, Option<bool>, Option<bool>);

fn signed_in(current: &ExtensionCurrent) -> Option<SignedIn<'_>> {
    match current {
        ExtensionCurrent::SignedIn {
            account_uuid,
            known,
            other,
            expired,
            ..
        } => Some((account_uuid.as_ref(), *known, *other, *expired)),
        _ => None,
    }
}

fn current_at(current: &ExtensionCurrent) -> &str {
    match current {
        ExtensionCurrent::SignedIn { at, .. }
        | ExtensionCurrent::SignedOut { at, .. }
        | ExtensionCurrent::Unreadable { at } => at,
    }
}

fn current_state(current: &ExtensionCurrent) -> &'static str {
    match current {
        ExtensionCurrent::SignedIn { .. } => "signed-in",
        ExtensionCurrent::SignedOut { .. } => "signed-out",
        ExtensionCurrent::Unreadable { .. } => "unreadable",
    }
}

fn date_ms(text: &str) -> f64 {
    crate::shared::types::js::date_parse(text)
}

impl DesktopManager {
    fn extension_setting(&self) -> ExtensionSetting {
        self.store
            .with_state(|s| s.settings.claude_extension.clone())
            .unwrap_or_else(default_extension)
    }

    fn switcher(&self) -> Option<Arc<ExtensionSwitcher>> {
        let hooks = self.hooks();
        let ports = hooks.extension?;
        let mut slot = self.ext.switcher.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(switcher) = slot.as_ref() {
            return Some(Arc::clone(switcher));
        }
        let scratch = self.extension_scratch();
        let mut cookie_scratch = scratch.clone().into_os_string();
        cookie_scratch.push("-cookies");
        let mut switch_ports = crate::extension_switch::ExtensionPorts::new(
            ports.system,
            ports.storage,
            Arc::clone(&self.ext.vault),
            &scratch,
        );
        switch_ports.cookies = ports.cookies;
        switch_ports.cookie_vault = Some(Arc::clone(&self.ext.cookie_vault));
        switch_ports.cookie_scratch = Some(PathBuf::from(cookie_scratch));
        switch_ports.now = Some(Arc::clone(&self.now));
        let this = self.this.clone();
        // Key names only, so a renamed sign-in key can be found from the log.
        switch_ports.on_unknown_layout = Some(Box::new(move |names: &[String]| {
            if let Some(m) = this.upgrade() {
                let names: Vec<String> = names
                    .iter()
                    .map(|n| crate::shared::browser_extension::js_slice_units(n, 40))
                    .collect();
                m.diag(
                    "extension-keys",
                    json!({ "count": names.len(), "names": names.join(" ") }),
                );
            }
        }));
        let this = self.this.clone();
        // Cookie names and database versions only, never values.
        switch_ports.on_cookie_layout = Some(Box::new(move |detail| {
            if let Some(m) = this.upgrade() {
                let map: Map<String, Value> = detail
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            json!(crate::shared::browser_extension::js_slice_units(v, 200)),
                        )
                    })
                    .collect();
                m.diagnose("extension-cookie-layout", Some(map));
            }
        }));
        let this = self.this.clone();
        switch_ports.on_foreign_login = Some(Box::new(move |account, other, why| {
            if let Some(m) = this.upgrade() {
                m.diag(
                    "extension-foreign-login",
                    json!({ "account": short_id(Some(account)), "other": short_id(Some(other)), "why": why.as_str() }),
                );
            }
        }));
        let this = self.this.clone();
        switch_ports.on_fresh_login = Some(Box::new(move |account, from| {
            if let Some(m) = this.upgrade() {
                m.diag(
                    "extension-fresh-login",
                    json!({ "account": short_id(Some(account)), "from": short_id(Some(from)) }),
                );
            }
        }));
        let switcher = Arc::new(ExtensionSwitcher::new(switch_ports));
        *slot = Some(Arc::clone(&switcher));
        Some(switcher)
    }

    /// Each account uuid's organization and each account's uuids (lower case), for telling
    /// claude.ai logins apart.
    fn extension_accounts(&self) -> (HashMap<String, String>, Vec<Vec<String>>) {
        self.store.with_state(|s| {
            let mut orgs = HashMap::new();
            let mut groups = Vec::new();
            for account in &s.accounts {
                let uuids: Vec<String> = account_uuids(account)
                    .iter()
                    .map(|u| u.to_lowercase())
                    .collect();
                let org = account
                    .desktop
                    .as_ref()
                    .map(|d| d.org_id.clone())
                    .or_else(|| account.auth.as_ref().and_then(|a| a.org_id.clone()))
                    .map(|o| o.to_lowercase());
                if let Some(org) = org.filter(|o| !o.is_empty()) {
                    for uuid in &uuids {
                        orgs.insert(uuid.clone(), org.clone());
                    }
                }
                groups.push(uuids);
            }
            (orgs, groups)
        })
    }

    fn known_uuids(&self) -> Vec<String> {
        self.store
            .with_state(|s| s.accounts.iter().flat_map(account_uuids).collect())
    }

    /// Runs `verify_extension` once `extension_verify_ms` has passed and again at each of
    /// `extension_recheck_ms`, until a look finds the failure or the extension elsewhere; a newer
    /// step replaces the run.
    fn verify_extension_later(&self, target: Account, after: String) {
        let Some(this) = self.this.upgrade() else {
            return;
        };
        let hooks = self.hooks();
        let run = {
            let mut st = self.st();
            st.ext.verify_run += 1;
            st.ext.verify_run
        };
        let mut rechecks: Vec<u64> = hooks
            .extension_recheck_ms
            .iter()
            .copied()
            .filter(|ms| *ms > hooks.extension_verify_ms)
            .collect();
        rechecks.sort_unstable();
        let mut times = vec![hooks.extension_verify_ms];
        times.extend(rechecks);
        let (first, verified) = std::sync::mpsc::channel();
        *self.ext.verified.lock().unwrap_or_else(|e| e.into_inner()) = Some(verified);
        std::thread::spawn(move || {
            let mut elapsed = 0;
            for (index, at) in times.into_iter().enumerate() {
                std::thread::sleep(Duration::from_millis(at.saturating_sub(elapsed)));
                elapsed = at;
                if this.st().ext.verify_run != run {
                    break;
                }
                let done = this.verify_extension(&target, &after);
                if index == 0 {
                    let _ = first.send(());
                }
                if done {
                    break;
                }
            }
            let _ = first.send(());
        });
    }

    /// Waits for the first look of the last scheduled extension verification; for tests.
    pub fn wait_extension_verified(&self) {
        let receiver = self
            .ext
            .verified
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(receiver) = receiver {
            let _ = receiver.recv();
        }
    }

    /// After a step put a sign-in in place: when a check made since finds the extension on
    /// `target` but recording a failed sign-in, that login is forgotten and `on_extension_broken`
    /// is told. Whether later looks are pointless. Never fails.
    fn verify_extension(&self, target: &Account, after: &str) -> bool {
        // A check is skipped while a Desktop operation runs: the look waits, up to five minutes.
        let pause = if self.hooks().extension_verify_ms > 0 {
            5_000
        } else {
            20
        };
        let mut tries = 0;
        while self.is_busy() && tries < 60 {
            std::thread::sleep(Duration::from_millis(pause));
            tries += 1;
        }
        let _ = self.check_extension(None);
        let Some(current) = self.st().ext.last_check.clone() else {
            return false;
        };
        // Skipped while a Desktop operation ran: an older reading proves nothing.
        if date_ms(current_at(&current)).is_nan()
            || date_ms(after).is_nan()
            || date_ms(current_at(&current)) <= date_ms(after)
        {
            return false;
        }
        let mine: Vec<String> = account_uuids(target)
            .iter()
            .map(|u| u.to_lowercase())
            .collect();
        let info = signed_in(&current);
        let account = info
            .and_then(|(uuid, ..)| uuid.cloned())
            .filter(|u| !u.is_empty());
        let here = account.as_ref().is_some_and(|u| mine.contains(u));
        let failed = here && info.is_some_and(|(.., expired)| expired == Some(true));
        let mut map = fields(json!({
            "to": short_id(Some(target.desktop.as_ref().map_or(target.id.as_str(), |d| d.account_uuid.as_str()))),
            "state": current_state(&current),
        }));
        if let Some(account) = &account {
            map.insert("account".into(), json!(short_id(Some(account))));
        }
        map.insert("signedIn".into(), json!(!failed));
        self.diagnose("extension-verify", Some(map));
        // Moved to another account since: what it does there is not this step's.
        if account.is_some() && !here {
            return true;
        }
        if !failed {
            return false;
        }
        self.extension_failed(target, account.as_deref().unwrap_or_default(), false)
    }

    /// The extension recorded a failed sign-in on `target` (`uuid`): the claude.ai login saved
    /// for it is forgotten and `on_extension_broken` is told, once while it waits when `quiet`.
    /// Not while Anthropic cannot be reached. Whether it was taken as broken.
    fn extension_failed(&self, target: &Account, uuid: &str, quiet: bool) -> bool {
        let mine: Vec<String> = account_uuids(target)
            .iter()
            .map(|x| x.to_lowercase())
            .collect();
        if quiet && mine.iter().any(|x| self.ext.cookie_vault.is_waiting(x)) {
            return true;
        }
        let offline = self.hooks().extension_offline;
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| offline())).unwrap_or(false) {
            self.diag(
                "extension-verify-offline",
                json!({ "account": short_id(Some(uuid)) }),
            );
            return false;
        }
        let saved = self.ext.cookie_vault.list();
        let held: Vec<String> = mine
            .iter()
            .filter(|x| saved.iter().any(|s| &s.account_uuid == *x))
            .cloned()
            .collect();
        // With nothing saved, the account still waits for a reconnect, so it is told once.
        let reject = if held.is_empty() {
            vec![uuid.to_lowercase()]
        } else {
            held
        };
        for x in reject {
            let _ = self.ext.cookie_vault.reject(&x);
        }
        self.diag(
            "extension-pair-broken",
            json!({ "account": short_id(Some(uuid)) }),
        );
        if let Some(hook) = self.hooks().on_extension_broken {
            tell(|| hook(target));
        }
        true
    }

    /// The background look: who the extension is signed in to, and whether its sign-in still
    /// works. Quiet while an operation runs and in mode "off". Never fails.
    pub fn extension_health(&self) {
        if self.extension_setting().mode == ExtensionMode::Off
            || self.is_busy()
            || self.switcher().is_none()
        {
            return;
        }
        let _ = self.check_extension(None);
        let Some(current) = self.st().ext.last_check.clone() else {
            return;
        };
        let Some((Some(uuid), _, _, Some(true))) = signed_in(&current) else {
            return;
        };
        let uuid = uuid.to_lowercase();
        let account = self.store.with_state(|s| {
            s.accounts
                .iter()
                .find(|a| account_uuids(a).iter().any(|x| x.to_lowercase() == uuid))
                .cloned()
        });
        if let Some(account) = account {
            self.extension_failed(&account, &uuid, true);
        }
    }

    /// What the last extension step did, or None when none ran since Relay started.
    pub fn extension_outcome(&self) -> Option<ExtensionOutcome> {
        self.st().ext.last.clone()
    }

    /// Keeps the Claude extension's sign-in with `target`. Never fails, so it can never fail or
    /// hold up a switch. Logs statuses and short ids only.
    fn extension_step(
        &self,
        target: &Account,
        may_quit: bool,
        mode: Option<ExtensionMode>,
    ) -> Option<ExtensionOutcome> {
        let switcher = self.switcher()?;
        let mut setting = self.extension_setting();
        if let Some(mode) = mode
            && setting.mode != ExtensionMode::Off
        {
            setting.mode = mode;
        }
        let (orgs, groups) = self.extension_accounts();
        let outcome = switcher.run(&ExtensionRequest {
            setting,
            may_quit,
            target: account_uuids(target),
            known: self.known_uuids(),
            orgs: Some(orgs),
            groups: Some(groups),
        });
        {
            let mut st = self.st();
            st.ext.last = Some(outcome.clone());
            // Mode "guide" looked at who the extension is on: that is the newest check too.
            if let Some(current) = &outcome.current {
                st.ext.last_check = Some(current.clone());
            } else if outcome.cleared == Some(true)
                && let Some(ExtensionCurrent::SignedIn {
                    account_uuid,
                    known,
                    other,
                    ..
                }) = st.ext.last_check.clone()
            {
                // The step removed the record of a failed sign-in: "expired" no longer holds.
                st.ext.last_check = Some(ExtensionCurrent::SignedIn {
                    account_uuid,
                    known,
                    other,
                    expired: None,
                    at: outcome.at.clone(),
                });
            }
        }
        let to = short_id(Some(
            target
                .desktop
                .as_ref()
                .map_or(target.id.as_str(), |d| d.account_uuid.as_str()),
        ));
        let mut map = fields(json!({ "to": to, "result": outcome.result }));
        if let Some(reason) = &outcome.reason {
            map.insert("reason".into(), json!(reason));
        }
        map.insert("restarted".into(), json!(outcome.restarted));
        if let Some(reopened) = outcome.reopened {
            map.insert("reopened".into(), json!(reopened));
        }
        map.insert("saved".into(), json!(outcome.saved));
        if outcome.cleared == Some(true) {
            map.insert("cleared".into(), json!(true));
        }
        self.diagnose("extension", Some(map));
        // A sign-in was put in place or a failure record removed: Relay looks whether that
        // worked, again over the next half hour.
        if outcome.result == ExtensionResult::Switched || outcome.cleared == Some(true) {
            self.verify_extension_later(target.clone(), outcome.at.clone());
        }
        // The account's saved login had ended: it waits for a reconnect, and the user is told.
        if outcome.reason == Some(ExtensionReason::LoginExpired) {
            self.diag("extension-login-expired", json!({ "to": to }));
            if let Some(hook) = self.hooks().on_extension_broken {
                tell(|| hook(target));
            }
        }
        Some(outcome)
    }

    /// Runs the extension step for the account Desktop is on, without changing Claude. The user
    /// asks for it, so it swaps as mode "restart" does; mode "off" still leaves it alone.
    pub fn sync_extension(&self) -> DesktopResult<ExtensionOutcome> {
        self.exclusive((DesktopOperationKind::Switch, None), false, || {
            if self.pending().is_some() {
                return Err(FINISH_SIGN_IN.into());
            }
            let state = self.snapshot()?;
            let active = match &state.active_profile_id {
                Some(id) => Some(self.store.account(id)?),
                None => None,
            };
            let Some(active) = active else {
                return Err("Switch Claude Desktop to a saved account first.".into());
            };
            self.extension_step(&active, true, Some(ExtensionMode::Restart))
                .ok_or_else(|| {
                    DesktopError::new("The Claude browser extension is not supported here.")
                })
        })
    }

    /// The browser (its name) a switch now would quit for the extension step.
    pub fn extension_quits_browser(&self) -> Option<String> {
        let switcher = self.switcher()?;
        let ports = self.hooks().extension?;
        let setting = self.extension_setting();
        if setting.mode != ExtensionMode::Restart {
            return None;
        }
        let instances = switcher.instances();
        let target = choose_instance(&instances, setting.browser.as_ref())?;
        if !ports.storage.available() || !browser_running(&*ports.system, target.app).ok()? {
            return None;
        }
        Some(browser(target.app).name.to_string())
    }

    /// The panel's offer to bring the extension to the account Desktop is on, from what Relay
    /// last saw. Never fails.
    pub fn extension_offer(&self) -> Option<ExtensionOffer> {
        let (check, last) = {
            let st = self.st();
            (st.ext.last_check.clone(), st.ext.last.clone())
        };
        let from_check = check.as_ref().is_some_and(|c| {
            last.as_ref()
                .is_none_or(|l| date_ms(current_at(c)) >= date_ms(&l.at))
        });
        // Mode "closed" left a running browser alone at the switch; any other step is no miss.
        let left_alone = last.as_ref().is_some_and(|l| {
            l.result == ExtensionResult::Skipped
                && l.reason == Some(ExtensionReason::BrowserRunning)
        });
        if from_check {
            if matches!(check, Some(ExtensionCurrent::Unreadable { .. })) {
                return None;
            }
        } else if !left_alone {
            return None;
        }
        // An extension never opened has nothing to swap.
        if from_check
            && matches!(
                check,
                Some(ExtensionCurrent::SignedOut {
                    unopened: Some(true),
                    ..
                })
            )
        {
            return None;
        }
        let switcher = self.switcher()?;
        self.hooks().extension?;
        let setting = self.extension_setting();
        if setting.mode == ExtensionMode::Off {
            return None;
        }
        let current =
            identity(read_object(&self.root, "config.json").ok()?.as_ref())?.to_lowercase();
        let by_uuid = |uuid: &str| {
            self.store.with_state(|s| {
                s.accounts
                    .iter()
                    .find(|a| account_uuids(a).iter().any(|x| x.to_lowercase() == uuid))
                    .cloned()
            })
        };
        let active = by_uuid(&current)?;
        let mine: Vec<String> = account_uuids(&active)
            .iter()
            .map(|u| u.to_lowercase())
            .collect();
        let mut on = None;
        let mut expired = false;
        let signed_out = from_check && matches!(check, Some(ExtensionCurrent::SignedOut { .. }));
        if from_check
            && let Some((Some(uuid), _, _, was_expired)) = check.as_ref().and_then(signed_in)
            && !uuid.is_empty()
        {
            let uuid = uuid.to_lowercase();
            // On Desktop's account: nothing to bring along, unless its sign-in expired there.
            if mine.contains(&uuid) {
                if was_expired != Some(true) {
                    return None;
                }
                expired = true;
            } else {
                on = by_uuid(&uuid).map(|a| a.name);
            }
        }
        let saved = |list: &[crate::shared::browser_extension::SavedSignIn]| {
            list.iter()
                .any(|x| mine.contains(&x.account_uuid.to_lowercase()))
        };
        let paired = saved(&self.ext.vault.list()) && saved(&self.ext.cookie_vault.list());
        // Expired with no login to put in place: only signing in again helps, in Settings.
        if !paired && !expired {
            return None;
        }
        let instances = switcher.instances();
        let instance = choose_instance(&instances, setting.browser.as_ref())?;
        Some(ExtensionOffer {
            account_id: active.id.clone(),
            to: active.name.clone(),
            on,
            signed_out: signed_out.then_some(true),
            expired: expired.then_some(true),
            reconnect: (expired && !paired).then_some(true),
            browser: browser(instance.app).name.to_string(),
        })
    }

    /// The setting, the extension found, what is saved, and the last result; for the UI.
    pub fn extension_status(&self) -> Option<ExtensionStatus> {
        let switcher = self.switcher()?;
        let ports = self.hooks().extension?;
        let setting = self.extension_setting();
        let instances = switcher.instances();
        let pick = pick_instance(&instances, setting.browser.as_ref());
        let target = pick.map(|(instance, _)| instance.clone());
        let broken = self.ext.cookie_vault.waiting();
        let denied = denied_browsers(&*ports.system);
        let restores_tabs = target.as_ref().map(|t| {
            let preferences = data_dir(&*ports.system, t.app)
                .join(&t.profile)
                .join("Preferences");
            startup_restores(&read_json(&*ports.system, &preferences).unwrap_or(Value::Null))
        });
        let (last, current) = {
            let st = self.st();
            (st.ext.last.clone(), st.ext.last_check.clone())
        };
        Some(ExtensionStatus {
            picked: pick.map(|(_, picked)| picked),
            setting,
            instances: instances.clone(),
            target,
            denied: (!denied.is_empty()).then_some(denied),
            restores_tabs,
            saved: self.ext.vault.list(),
            cookies_saved: Some(self.ext.cookie_vault.list()),
            last,
            current,
            broken,
        })
    }

    /// Opens claude.ai in the browser whose extension Relay manages, in front.
    pub fn open_claude_web(&self) -> DesktopResult<()> {
        let unsupported =
            || DesktopError::new("The Claude browser extension is not supported here.");
        let switcher = self.switcher().ok_or_else(unsupported)?;
        let ports = self.hooks().extension.ok_or_else(unsupported)?;
        let setting = self.extension_setting();
        let instances = switcher.instances();
        let instance = choose_instance(&instances, setting.browser.as_ref())
            .ok_or_else(|| DesktopError::new("No browser with the Claude extension was found."))?;
        ports
            .system
            .open_url(instance.app, "https://claude.ai/", &instance.profile)
            .map_err(DesktopError::Failed)
    }

    /// Reads who the extension is signed in to from a copy of its storage, without quitting a
    /// browser, and saves the sign-in when it is one of Relay's accounts. Skipped while a Desktop
    /// operation runs; one check at a time.
    pub fn check_extension(
        &self,
        claim_for: Option<&str>,
    ) -> DesktopResult<Option<ExtensionStatus>> {
        let Some(switcher) = self.switcher() else {
            return Ok(None);
        };
        let claim = match claim_for {
            Some(id) => {
                let claimed = self
                    .store
                    .with_state(|s| s.accounts.iter().find(|a| a.id == id).cloned())
                    .ok_or_else(|| DesktopError::new("Account not found."))?;
                let claim = claimed
                    .desktop
                    .as_ref()
                    .map(|d| d.account_uuid.clone())
                    .or_else(|| claimed.auth.as_ref().and_then(|a| a.account_uuid.clone()));
                Some(claim.ok_or_else(|| {
                    DesktopError::new("Save this account’s Claude app sign-in first.")
                })?)
            }
            None => None,
        };
        if !self.is_busy() {
            let current = {
                let _one = self.ext.checking.lock().unwrap_or_else(|e| e.into_inner());
                let (orgs, groups) = self.extension_accounts();
                switcher.check(&CheckRequest {
                    setting: self.extension_setting(),
                    known: self.known_uuids(),
                    orgs: Some(orgs),
                    groups: Some(groups),
                    claim,
                })
            };
            let setting = self.extension_setting();
            let instances = if setting.mode == ExtensionMode::Off {
                Vec::new()
            } else {
                switcher.instances()
            };
            let target = choose_instance(&instances, setting.browser.as_ref());
            if let Some(current) = current {
                self.st().ext.last_check = Some(current.clone());
                // Signed in to that account without a failure: it waits for no reconnect any more.
                if let Some((Some(uuid), _, _, expired)) = signed_in(&current)
                    && expired != Some(true)
                    && !uuid.is_empty()
                {
                    let _ = self.ext.cookie_vault.reconnected(uuid);
                }
                let mut map = fields(json!({ "state": current_state(&current) }));
                if let Some((uuid, known, other, expired)) = signed_in(&current) {
                    map.insert("known".into(), json!(known));
                    map.insert("other".into(), json!(other == Some(true)));
                    if let Some(uuid) = uuid.filter(|u| !u.is_empty()) {
                        map.insert("account".into(), json!(short_id(Some(uuid))));
                    }
                    if expired == Some(true) {
                        map.insert("expired".into(), json!(true));
                    }
                }
                map.insert("instances".into(), json!(instances.len()));
                if let Some(target) = target {
                    map.insert(
                        "target".into(),
                        json!(format!("{}:{}", target.app.as_str(), target.profile)),
                    );
                    map.insert("opened".into(), json!(target.opened));
                }
                // Settings checks every few seconds while a reconnect waits: only a change is
                // logged.
                let logged = Value::Object(map.clone()).to_string();
                let changed = {
                    let mut st = self.st();
                    let changed = st.ext.check_logged.as_deref() != Some(logged.as_str());
                    if changed {
                        st.ext.check_logged = Some(logged);
                    }
                    changed
                };
                if changed {
                    self.diagnose("extension-check", Some(map));
                }
            } else if setting.mode != ExtensionMode::Off && instances.is_empty() {
                self.diag(
                    "extension-check",
                    json!({ "state": "none", "instances": 0 }),
                );
            }
        }
        Ok(self.extension_status())
    }
}
