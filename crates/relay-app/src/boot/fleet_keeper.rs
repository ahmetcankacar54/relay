//! Continuing every conversation at the limit (the fleet), then the planner's window keeper
//! (port of electron/main/boot/fleet-keeper.ts).

use std::sync::Arc;

use relay_core::desktop_continuation::ContinuationStatus;
use relay_core::desktop_continuation_evidence::NativeDesktopContinuationEvidence;
use relay_core::desktop_continuation_host::DesktopAutomationIssue;
use relay_core::fleet_continuation::{FleetContinuation, FleetDeps};
use relay_core::routine_runner::{QuotaStarterOptions, run_quota_starter};
use relay_core::shared::adaptive_plan::PACE_WINDOW_MS;
use relay_core::shared::automation_mode::{automation_mode, automation_mode_writes};
use relay_core::shared::planning::planning_identity;
use relay_core::shared::routine_failure::routine_failure_notice;
use relay_core::shared::types::{Account, AccountUsage, DesktopState, FleetStatus, RunStatus};
use relay_core::shared::usage_statistics::UsageSample;
use relay_core::window_keeper::{AdaptedNotice, KeeperDeps, KeeperState, WindowKeeper};

use super::continuation::{continuation_context, locked};
use super::usage::read_usage_credential;
use crate::i18n::{locale, say};
use crate::services::desktop_lock::{DESKTOP_LOCK, pending_auth};
use crate::services::notifications::{NotifyKind, notifies, notify_adapted, notify_fleet, show};
use crate::state::{STATE, lock};

/// A fresh Desktop reading, kept as the one Relay observed last.
fn observe_desktop() -> Result<DesktopState, String> {
    let state = STATE.desktop().snapshot().map_err(|e| e.to_string())?;
    Ok(STATE.set_observed_desktop(state))
}

/// Another Relay operation owns Claude or a sign-in is in progress: the keeper waits.
fn keeper_blocked() -> bool {
    let Some(observed) = STATE.observed_desktop() else {
        return true;
    };
    DESKTOP_LOCK.active()
        || observed.busy
        || observed.recovery_required
        || observed.pending_profile_id.is_some()
        || pending_auth()
        || matches!(
            STATE.fleet().snapshot().status,
            FleetStatus::Switching | FleetStatus::Continuing
        )
        || STATE.continuation().snapshot().status == ContinuationStatus::Executing
}

/// The last hour of raw usage: today's pace; none without the ledger.
fn recent_usage_samples() -> Vec<UsageSample> {
    let since = relay_core::clock::now_ms() as f64 - PACE_WINDOW_MS;
    STATE
        .usage_history
        .get()
        .map(|history| lock(history).recent_samples(since))
        .unwrap_or_default()
}

struct AppKeeperDeps;

impl KeeperDeps for AppKeeperDeps {
    fn state(&self) -> KeeperState {
        let (settings, accounts) = STATE
            .service()
            .store
            .with_state(|s| (s.settings.planning.clone(), s.accounts.clone()));
        KeeperState {
            settings,
            accounts,
            usage: STATE.usage().snapshot().into_iter().collect(),
            tempo: STATE.tempo().current_or_fallback(),
            blocked: keeper_blocked(),
            busy_account_ids: STATE
                .service()
                .runner
                .list()
                .into_iter()
                .filter(|run| run.status == RunStatus::Running)
                .map(|run| run.account_id)
                .collect(),
            recent_samples: recent_usage_samples(),
            active_id: STATE
                .observed_desktop()
                .and_then(|state| state.active_profile_id),
        }
    }
    fn refresh(&self, account_id: &str) -> Result<(), String> {
        STATE
            .usage()
            .refresh(account_id, false)
            .map(drop)
            .map_err(|e| e.0)
    }
    fn refresh_after_start(&self, account_id: &str) -> Result<AccountUsage, String> {
        STATE
            .usage()
            .refresh_after_request(account_id)
            .map_err(|e| e.0)
    }
    fn start(&self, account: &Account) -> Result<(), String> {
        observe_desktop()?;
        let identity = planning_identity(account);
        let guard = || {
            if observe_desktop().is_err() {
                return false;
            }
            let store = &STATE.service().store;
            store.with_state(|s| s.settings.planning.auto_start)
                && !keeper_blocked()
                && store
                    .account(&account.id)
                    .is_ok_and(|current| planning_identity(&current) == identity)
        };
        run_quota_starter(
            &STATE.service().store,
            account,
            &read_usage_credential,
            &QuotaStarterOptions {
                guard: Some(&guard),
                signal: Some(&STATE.keeper_abort),
                ..QuotaStarterOptions::default()
            },
        )
        .map_err(|e| e.to_string())
    }
    fn notify(&self, account: &Account, reason: &str) {
        if !notifies(NotifyKind::EarlyStart) {
            return;
        }
        show(
            say("electronMain.earlyStartFailed"),
            routine_failure_notice(&account.name, reason, locale()),
            None,
        );
    }
    fn adapted(&self, notice: &AdaptedNotice) -> Result<(), String> {
        notify_adapted(notice);
        Ok(())
    }
    fn changed(&self) {
        crate::events::changed();
    }
}

pub fn boot_fleet_keeper(evidence: Arc<NativeDesktopContinuationEvidence>) -> Result<(), String> {
    let data_dir = STATE.paths().data_dir();
    let continue_conversation =
        crate::services::continue_conversation::make_continue_conversation(evidence.clone());
    let (stops, quiet, quiet_sync, unchanged, detail, commands, stop_background) = (
        evidence.clone(),
        evidence.clone(),
        evidence.clone(),
        evidence.clone(),
        evidence.clone(),
        evidence.clone(),
        evidence,
    );
    let fleet = FleetContinuation::new(FleetDeps {
        directory: data_dir.join("fleet-continuation"),
        now: None,
        snapshot: Arc::new(continuation_context),
        desktop: Arc::new(|| {
            let mut state = observe_desktop()?;
            state.busy = STATE.desktop().is_busy() || DESKTOP_LOCK.active();
            Ok(state)
        }),
        busy: Arc::new(|| {
            let continuation = STATE.continuation().snapshot();
            pending_auth()
                || continuation.enabled
                || continuation.status == ContinuationStatus::Executing
                || continuation.status == ContinuationStatus::ReconciliationRequired
        }),
        // A stop after the last reading: read again now, past the one-minute success cache.
        refresh_usage: Some(Arc::new(|id: &str| {
            STATE
                .usage()
                .refresh_after_request(id)
                .map(drop)
                .map_err(|e| e.0)
        })),
        stops: Arc::new(move |account: &Account| {
            stops.quota_stops(account, None).map_err(|e| e.message())
        }),
        quiet: Arc::new(move |list| quiet.quiet_except(list).map_err(|e| e.message())),
        quiet_sync: Arc::new(move |list| {
            quiet_sync
                .quiet_except_sync(list)
                .unwrap_or_else(|e| Some(e.message()))
        }),
        unchanged: Arc::new(move |stop| unchanged.unchanged(stop)),
        automation_ready: Arc::new(|| {
            if !cfg!(target_os = "macos") {
                return Ok(Some(
                    DesktopAutomationIssue::DesktopUiUnsupported.as_str().into(),
                ));
            }
            Ok(match STATE.automation().inspect() {
                Ok(_) => None,
                Err(error) => {
                    let issue = error
                        .issue()
                        .unwrap_or(DesktopAutomationIssue::DesktopUiUnsupported);
                    // Claude being closed is fine: the switch launches it.
                    (issue != DesktopAutomationIssue::ClaudeNotRunning)
                        .then(|| issue.as_str().to_owned())
                }
            })
        }),
        switch_to: Arc::new(|target_id, guards| STATE.desktop().switch_to(target_id, guards)),
        continue_one: Arc::new(continue_conversation),
        with_desktop_lock: Arc::new(|action| locked(action, |e| e.to_string())),
        changed: Arc::new(crate::events::changed),
        log: Some(Arc::new(|event, fields| {
            crate::services::logs::log_fleet_event(event, Some(fields));
        })),
        quiet_detail: Some(Arc::new(move || detail.quiet_detail())),
        finished: Some(Arc::new(notify_fleet)),
        // What the stopped sessions left running (dev servers, builds), stopped at the switch.
        background_commands: Some(Arc::new(move || commands.background_commands())),
        stop_background: Some(Arc::new(move |allowed| {
            stop_background
                .stop_background(allowed)
                .map_err(|e| e.message())
        })),
        answer_quit_guard: Some(Arc::new(|| {
            let automation = STATE.automation();
            Ok(automation.supports_answer_quit_guard()
                && automation.answer_quit_guard().unwrap_or(false))
        })),
    })?;
    let fleet = STATE.fleet.get_or_init(|| Arc::new(fleet));
    // Before the single choice both records could be saved on. The fleet wins, as the mode
    // reads; turning it off later must not leave prepare-on-quit on.
    let saved = STATE.settings().auto_switch_mode;
    let mode = automation_mode_writes(automation_mode(saved, Some(fleet.snapshot().enabled)))
        .auto_switch_mode;
    if mode != saved {
        // A refused write keeps the pair; the fleet still wins while it is on.
        let _ = STATE
            .service()
            .store
            .update(|s| s.settings.auto_switch_mode = mode);
    }
    observe_desktop()?;
    let keeper = WindowKeeper::new(&data_dir.join("window-keeper"), Arc::new(AppKeeperDeps))
        .map_err(|e| e.to_string())?;
    let _ = STATE.keeper.set(Arc::new(keeper));
    Ok(())
}
