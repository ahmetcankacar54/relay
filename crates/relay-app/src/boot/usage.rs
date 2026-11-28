//! The first Desktop reading, the usage history and tempo, and the limit reads with their
//! sign-in renewal (port of electron/main/boot/usage.ts).

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::active_account_timeline::{ActiveAccountTimeline, ActiveObservation};
use relay_core::auto_capture::{AutoCapture, AutoCaptureDeps};
use relay_core::desktop::{DesktopError, DesktopResult};
use relay_core::linux_safe_storage::{linux_keyring_reachable, process_env};
use relay_core::profile_lock::{ProfileLockKind, acquire_profile_lock};
use relay_core::provider_credentials::{CodexReadOptions, read_codex_credential};
use relay_core::provider_usage::{
    AntigravityRequest, FetchedResponse, ProviderUsageResult, read_antigravity_tier,
    read_antigravity_usage, read_codex_usage,
};
use relay_core::relay_paths::Platform;
use relay_core::shared::cli_version::reads_usage;
use relay_core::shared::types::{Account, AccountProvider, DesktopState, RunStatus, UsageIssue};
use relay_core::tempo_tracker::TempoTracker;
use relay_core::usage::{UsageManager, UsageManagerDeps};
use relay_core::usage_credentials::{
    MISSING_RETRY_MS, UsageCredential, UsageError, read_credential,
};
use relay_core::usage_history::UsageHistory;
use relay_core::usage_issue_log::{UsageIssueInput, append_usage_issue};
use relay_core::usage_refresh::{
    ProfileRelease, UsageCredentialRefresher, UsageRefreshDeps, anthropic_unreachable,
    default_probe,
};

use crate::services::desktop_lock::{DESKTOP_LOCK, manual_desktop_lock, profile_locks};
use crate::state::{AppTempoSource, STATE, lock};

/// How often the automatic save looks at Claude; it reads Claude only while armed.
const AUTO_CAPTURE_TICK_MS: u64 = 2_000;
/// An Antigravity account's Google plan is read with its limits at most this often.
const ANTIGRAVITY_TIER_MS: i64 = 6 * 3_600_000;

/// The tempo now for the switch rule; `None` when it cannot be read (the rule then falls back to
/// its 10% threshold).
pub fn current_tempo_rate() -> Option<f64> {
    STATE.tempo.get()?.rate_at(None).ok()
}

/// Reads a profile's Claude Code sign-in.
pub fn read_usage_credential(
    profile: &Path,
    allow_prompt: bool,
) -> Result<UsageCredential, UsageError> {
    let tool = STATE.paths.get().and_then(|paths| paths.security_tool());
    read_credential(
        profile,
        allow_prompt,
        tool.as_deref(),
        Platform::current(),
        MISSING_RETRY_MS,
    )
}

/// What the active-account timeline reads of a Desktop state.
fn observation(state: &DesktopState) -> ActiveObservation {
    ActiveObservation {
        running: state.running,
        current_account_uuid: state.current_account_uuid.clone(),
        organizations: Some(state.organizations.clone()),
    }
}

/// The automatic save's view of the app.
struct CaptureDeps;

impl AutoCaptureDeps for CaptureDeps {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        STATE.desktop().snapshot()
    }
    fn accounts(&self) -> Vec<Account> {
        STATE.accounts()
    }
    fn capture(&self, account_id: &str, org_id: &str) -> DesktopResult<()> {
        // The capture's own error is kept: "not settled yet" must reach the automatic save as
        // such, not as a message.
        let mut failure: Option<DesktopError> = None;
        let result = manual_desktop_lock(|| {
            STATE
                .desktop()
                .capture(account_id, org_id)
                .map_err(|error| {
                    let message = error.to_string();
                    failure = Some(error);
                    message
                })
        });
        result.map_err(|message| failure.take().unwrap_or_else(|| DesktopError::new(message)))
    }
    fn changed(&self) {
        crate::events::changed();
    }
    fn now(&self) -> f64 {
        relay_core::clock::now_ms() as f64
    }
}

/// Whether `file` is there and executable (`access(X_OK)`).
fn executable_file(file: &str) -> bool {
    let Ok(meta) = std::fs::metadata(file) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// The CLI the refresher runs the exchange with: refused while it is missing, broken or too old
/// to read usage.
fn refresh_executable() -> Result<String, UsageError> {
    let diagnostics = STATE.service().panel_snapshot().diagnostics;
    match diagnostics.executable {
        Some(executable)
            if diagnostics.error.is_none()
                && reads_usage(diagnostics.version.as_deref().unwrap_or("")) =>
        {
            Ok(executable)
        }
        _ => Err(UsageError::new(UsageIssue::Unavailable)),
    }
}

/// Whether the refresher may touch `account`'s profile now: nothing else works on it, and the
/// saved sign-in is still the one it was asked to renew.
fn refresh_can_proceed(account: &Account, profile: &Path) -> bool {
    let service = STATE.service();
    let current = service
        .store
        .with_state(|s| s.accounts.iter().find(|a| a.id == account.id).cloned());
    let Some(auth) = current.and_then(|current| current.auth) else {
        return false;
    };
    !DESKTOP_LOCK.active()
        && !service.auth.active(&account.id)
        && !service
            .runner
            .list()
            .iter()
            .any(|run| run.account_id == account.id && run.status == RunStatus::Running)
        && auth.logged_in
        && auth.account_uuid == account.auth.as_ref().and_then(|a| a.account_uuid.clone())
        && auth.org_id == account.auth.as_ref().and_then(|a| a.org_id.clone())
        && service
            .store
            .profile(&account.id)
            .is_ok_and(|saved| saved == profile)
}

fn profile_of(account: &Account) -> std::path::PathBuf {
    STATE
        .service()
        .store
        .profile(&account.id)
        .unwrap_or_default()
}

/// A Codex or Antigravity account's limits, read through its own provider's sign-in.
fn provider_usage(account: &Account) -> Result<ProviderUsageResult, UsageError> {
    match account.provider {
        Some(AccountProvider::Codex) => {
            let credential =
                read_codex_credential(&profile_of(account), &CodexReadOptions::default());
            read_codex_usage(credential.as_ref(), None, None)
        }
        Some(AccountProvider::Antigravity) => antigravity_usage(account),
        _ => Err(UsageError::with_detail(
            UsageIssue::Unsupported,
            "provider quota endpoint unavailable",
        )),
    }
}

/// Antigravity through its CLIProxyAPI sidecar.
fn antigravity_usage(account: &Account) -> Result<ProviderUsageResult, UsageError> {
    let bridge = crate::services::antigravity::antigravity_bridge(&account.id)
        .map_err(|error| UsageError::with_detail(UsageIssue::Unavailable, error))?;
    if !bridge.has_credential() {
        return Err(UsageError::with_detail(
            UsageIssue::Expired,
            "antigravity: no saved Google sign-in",
        ));
    }
    let call = |request: &AntigravityRequest| -> Result<FetchedResponse, String> {
        bridge
            .google_call(&relay_core::antigravity_bridge::GoogleRequest {
                url: request.url.clone(),
                body: request.body.clone(),
                user_agent: request.user_agent.clone(),
            })
            .map(|answer| FetchedResponse {
                status: answer.status,
                retry_after: answer.retry_after,
                body: answer.body,
            })
            .map_err(|error| error.to_string())
    };
    let project = bridge.project_id();
    let mut result = read_antigravity_usage(&call, project.as_deref(), None)?;
    // The Google plan (AI Pro, Ultra, free) changes rarely: read with the limits at most every
    // six hours, and kept when a read fails.
    let now = relay_core::clock::now_ms();
    let tier_at = lock(&crate::services::antigravity::ANTIGRAVITY_TIER_READS)
        .get(&account.id)
        .copied()
        .unwrap_or(0);
    let subscription = account
        .auth
        .as_ref()
        .and_then(|a| a.subscription.as_deref());
    if now - tier_at > ANTIGRAVITY_TIER_MS
        || subscription.is_none_or(|s| s.is_empty() || s.to_lowercase().contains("oauth"))
    {
        lock(&crate::services::antigravity::ANTIGRAVITY_TIER_READS).insert(account.id.clone(), now);
        if let Some(plan) = read_antigravity_tier(&call, project.as_deref()) {
            result.plan = Some(plan);
        }
    }
    Ok(result)
}

pub fn boot_usage() -> Result<(), String> {
    let data_dir = STATE.paths().data_dir();
    let desktop = STATE.desktop().clone();
    // Which account was open when, from every fresh Desktop reading, set before the first one.
    let _ = STATE
        .active_timeline
        .set(Mutex::new(ActiveAccountTimeline::new(
            data_dir.join("active-account-timeline.json"),
        )));
    desktop.configure(|hooks| {
        hooks.on_state = Some(Arc::new(|state: &DesktopState| {
            lock(STATE.active_timeline()).observe(&observation(state));
        }));
    });
    desktop.initialize().map_err(|e| e.to_string())?;
    let _ = STATE
        .auto_capture
        .set(Arc::new(AutoCapture::new(CaptureDeps)));
    // Reads Claude only while armed.
    std::thread::Builder::new()
        .name("relay-auto-capture".into())
        .spawn(|| {
            while !STATE.quitting() {
                std::thread::sleep(Duration::from_millis(AUTO_CAPTURE_TICK_MS));
                if let Some(capture) = STATE.auto_capture.get() {
                    capture.tick();
                }
            }
        })
        .map_err(|e| e.to_string())?;
    if let Some(Some(error)) = STATE.vault_error.get() {
        desktop.report_vault_error(error);
    }
    let _ = STATE
        .usage_history
        .set(Mutex::new(UsageHistory::new(&data_dir)));
    let _ = STATE.tempo.set(TempoTracker::new(AppTempoSource));

    let read: relay_core::usage::CredentialRead = Arc::new(read_usage_credential);
    let mut refresh_deps = UsageRefreshDeps::new(Arc::new(refresh_executable), read.clone());
    // A renewal that fell on a dropped network waits two minutes, not a new sign-in.
    refresh_deps.unreachable = Some(Arc::new(|| anthropic_unreachable(&default_probe)));
    refresh_deps.profile_lock = Some(Arc::new(|account_id: &str| {
        acquire_profile_lock(&profile_locks(), account_id, ProfileLockKind::Exclusive).map(
            |guard| {
                let mut guard = Some(guard);
                Box::new(move || {
                    if let Some(mut guard) = guard.take() {
                        guard.release();
                    }
                }) as ProfileRelease
            },
        )
    }));
    refresh_deps.can_proceed = Some(Arc::new(refresh_can_proceed));
    let refresher = Arc::new(UsageCredentialRefresher::new(refresh_deps));
    let _ = STATE.usage_credential_refresher.set(refresher.clone());

    let mut deps = UsageManagerDeps::new(read);
    deps.on_sample = Arc::new(|account, value| {
        // The notice first: a failed history write must not hold it back.
        crate::services::notifications::observe_limits(account, value);
        lock(STATE.usage_history()).record(account, value);
        crate::services::statusline::schedule_statusline();
    });
    let refreshing = refresher.clone();
    deps.refresh_credential = Some(Arc::new(
        move |account, credential, force, allow_interaction| {
            STATE.service().transaction(|| {
                refreshing.refresh(
                    account,
                    &profile_of(account),
                    credential,
                    force,
                    allow_interaction,
                )
            })
        },
    ));
    deps.refresh_credential_pending = Some(Arc::new(move |account| {
        refresher.has_pending(&profile_of(account))
    }));
    // A short private log, so the cause of a sign-in warning can be found later.
    let issues = data_dir.join("usage-issues.json");
    deps.on_issue = Some(Arc::new(move |account, issue, detail| {
        append_usage_issue(
            &issues,
            &UsageIssueInput {
                account_id: account.id.clone(),
                issue,
                detail: detail.map(str::to_owned),
            },
            relay_core::clock::now_ms(),
        );
    }));
    // Without a Claude Code sign-in, the Claude app's own sign-in reads the limits (macOS, and
    // Linux where the desktop's keyring can be read).
    if cfg!(target_os = "macos")
        || (cfg!(target_os = "linux") && linux_keyring_reachable(&process_env(), &executable_file))
    {
        deps.desktop_usage = Some(crate::services::desktop_usage::desktop_usage_source(
            STATE.vault_sealer().clone(),
        ));
    }
    // Codex through its ChatGPT sign-in, Antigravity through its CLIProxyAPI sidecar.
    deps.provider_usage = Some(Arc::new(provider_usage));
    let _ = STATE.usage.set(Arc::new(UsageManager::new(
        STATE.service().store.clone(),
        deps,
    )));
    Ok(())
}
