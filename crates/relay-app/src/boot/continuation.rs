//! Continuing a conversation at the limit, and the automatic switch that waits for it (port of
//! electron/main/boot/continuation.ts).

use std::sync::Arc;

use relay_core::auto_switch::{AutoSwitchDependencies, AutoSwitchManager};
use relay_core::continuation::{
    ContinuationCapabilities, ContinuationEngine, ContinuationRequest, ContinuationResult,
};
use relay_core::continuation_journal::FileContinuationJournal;
use relay_core::desktop::{DesktopError, DesktopManager};
use relay_core::desktop_continuation::{
    DesktopContinuationContext, DesktopContinuationDependencies, DesktopContinuationError,
    DesktopContinuationManager, DesktopContinuationObservation, DesktopContinuationPersistence,
    DesktopContinuationSnapshot, DesktopLockAction, FileDesktopContinuationPersistence,
};
use relay_core::desktop_continuation_evidence::{
    DesktopEvidenceOptions, NativeDesktopContinuationEvidence,
};
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationIssue, DesktopContinuationHost, DesktopHostError,
};
use relay_core::desktop_lock::DesktopLockError;
use relay_core::process_lock::ProcessLockError;
use relay_core::shared::types::js::JsMap;

use super::usage::current_tempo_rate;
use crate::services::desktop_lock::{pending_auth, with_desktop_lock};
use crate::state::STATE;

type Host = DesktopContinuationHost<Arc<dyn DesktopAutomation>, NativeDesktopContinuationEvidence>;

/// An action's own error, or the Desktop lock's refusal.
enum Locked<E> {
    Lock(DesktopLockError),
    Inner(E),
}

impl<E> From<DesktopLockError> for Locked<E> {
    fn from(error: DesktopLockError) -> Self {
        Locked::Lock(error)
    }
}

/// `withDesktopLock(action)` for actions whose error type has no lock case: the lock's refusal
/// becomes that error through `refused`.
pub(crate) fn locked<T, E>(
    action: impl FnOnce() -> Result<T, E>,
    refused: impl FnOnce(DesktopLockError) -> E,
) -> Result<T, E> {
    match with_desktop_lock(|| action().map_err(Locked::Inner)) {
        Ok(value) => Ok(value),
        Err(Locked::Inner(error)) => Err(error),
        Err(Locked::Lock(error)) => Err(refused(error)),
    }
}

/// The lock's refusal as the Desktop error the TS threw (`LockBusyError` for another process).
pub(crate) fn desktop_lock_error(error: DesktopLockError) -> DesktopError {
    match error {
        DesktopLockError::File(ProcessLockError::Busy(busy)) => {
            DesktopError::LockBusy(busy.to_string())
        }
        other => DesktopError::new(other.to_string()),
    }
}

/// What Relay's state is for the continuation, the fleet and the switch rule.
pub(crate) fn continuation_context() -> DesktopContinuationContext {
    let (accounts, settings) = STATE
        .service()
        .store
        .with_state(|s| (s.accounts.clone(), s.settings.clone()));
    DesktopContinuationContext {
        accounts,
        settings,
        usage: STATE.usage().snapshot().into_iter().collect(),
        tempo_rate: current_tempo_rate(),
    }
}

/// The manager's dependencies: the engine over the guarded native host, and its saved state.
struct ContinuationDeps {
    engine: ContinuationEngine<Host, FileContinuationJournal>,
    persistence: FileDesktopContinuationPersistence,
}

fn observation(
    state: relay_core::desktop_continuation_host::DesktopContinuationObservation,
) -> DesktopContinuationObservation {
    DesktopContinuationObservation {
        state: state.state,
        quota_stop: state.quota_stop,
        blocked_reason: None,
        own_quota_wakeup: state.own_quota_wakeup,
    }
}

impl DesktopContinuationDependencies for ContinuationDeps {
    fn observe(&self) -> Result<DesktopContinuationObservation, DesktopContinuationError> {
        if !cfg!(target_os = "macos") {
            return Err(
                DesktopHostError::from(DesktopAutomationIssue::DesktopUiUnsupported).into(),
            );
        }
        Ok(observation(self.engine.host().read_observation()?))
    }
    fn capabilities(&self) -> ContinuationCapabilities {
        Host::host_capabilities()
    }
    fn execute(
        &self,
        request: &ContinuationRequest,
    ) -> Result<ContinuationResult, DesktopContinuationError> {
        Ok(self.engine.execute(request)?)
    }
    fn supports_abandon_unsent(&self) -> bool {
        true
    }
    fn abandon_unsent(&self, request_id: &str) -> Result<(), DesktopContinuationError> {
        self.engine.abandon_unsent(request_id)?;
        Ok(())
    }
    fn snapshot(&self) -> DesktopContinuationContext {
        continuation_context()
    }
    fn persistence(&self) -> &dyn DesktopContinuationPersistence {
        &self.persistence
    }
    fn with_desktop_lock(
        &self,
        action: &mut DesktopLockAction<'_>,
    ) -> Result<DesktopContinuationSnapshot, DesktopContinuationError> {
        with_desktop_lock(action)
    }
    fn pending_auth(&self) -> bool {
        pending_auth()
            || STATE
                .observed_desktop()
                .is_some_and(|state| state.pending_profile_id.is_some())
    }
    fn changed(&self) {
        crate::events::changed();
    }
    fn supports_prepare_quota_stop(&self) -> bool {
        true
    }
    fn prepare_quota_stop(
        &self,
        observation_now: &DesktopContinuationObservation,
        _request: &ContinuationRequest,
    ) -> Result<DesktopContinuationObservation, DesktopContinuationError> {
        let state = self
            .engine
            .host()
            .cancel_quota_resume(observation_now.state.context_revision)?;
        Ok(observation(state))
    }
}

pub fn boot_continuation() -> Result<Arc<NativeDesktopContinuationEvidence>, String> {
    let paths = STATE.paths();
    let data_dir = paths.data_dir();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let desktop: Arc<DesktopManager> = STATE.desktop().clone();
    let automation: Arc<dyn DesktopAutomation> = STATE.automation().clone();
    let evidence = NativeDesktopContinuationEvidence::new(DesktopEvidenceOptions::new(
        STATE.service().store.clone(),
        desktop.clone(),
        automation.clone(),
        paths.app_data_dir().join("Claude"),
        home.join(".claude"),
    ))
    .map_err(|e| e.message())?;
    let host = DesktopContinuationHost::new(automation, evidence.clone());
    let deps = ContinuationDeps {
        engine: ContinuationEngine::new(
            host,
            FileContinuationJournal::new(&data_dir.join("continuation-journal"))
                .map_err(|e| e.to_string())?,
        ),
        persistence: FileDesktopContinuationPersistence::new(&data_dir.join("continuation"))
            .map_err(|e| e.to_string())?,
    };
    let _ = STATE
        .continuation
        .set(Arc::new(DesktopContinuationManager::new(deps)));

    let usage = STATE.usage().clone();
    let _ = STATE.auto_switch.set(AutoSwitchManager::new(
        STATE.service().store.clone(),
        desktop,
        Arc::new(move || usage.snapshot().into_iter().collect::<JsMap<_>>()),
        AutoSwitchDependencies {
            with_desktop_lock: Some(Arc::new(|action| locked(action, desktop_lock_error))),
            tempo_rate: Some(Arc::new(current_tempo_rate)),
            // Continue at quota owns conversations stopped at quota while it or a continuation
            // is on; preparing waits for it, with its own reason.
            continuation_owns: Some(Arc::new(|| {
                let continuation = STATE.continuation().snapshot();
                STATE.fleet.get().is_some_and(|fleet| fleet.enabled())
                    || continuation.enabled
                    || continuation.status
                        == relay_core::desktop_continuation::ContinuationStatus::ReconciliationRequired
                    || continuation.reason == "continuation-state-unreadable"
            })),
            pending_auth: Some(Arc::new(pending_auth)),
            changed: Some(Arc::new(crate::events::changed)),
            switched: Some(Arc::new(
                crate::services::notifications::remote_auto_switched,
            )),
            ..AutoSwitchDependencies::default()
        },
    ));
    Ok(Arc::new(evidence))
}
