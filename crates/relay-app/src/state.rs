//! The app's late-bound singletons (port of electron/main/state.ts): made once at startup
//! (`crate::boot`), read everywhere through `STATE`. Each `OnceLock` is set by the boot step that
//! makes it; reading one before then is a startup bug, so the accessors panic with its name.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};

use relay_core::active_account_timeline::ActiveAccountTimeline;
use relay_core::antigravity_switch::AntigravitySwitcher;
use relay_core::auto_capture::AutoCapture;
use relay_core::auto_switch::AutoSwitchManager;
use relay_core::desktop::DesktopManager;
use relay_core::desktop_continuation::DesktopContinuationManager;
use relay_core::desktop_continuation_host::DesktopAutomation;
use relay_core::desktop_windows::DesktopWindows;
use relay_core::draft_main::DraftScheduler;
use relay_core::fleet_continuation::FleetContinuation;
use relay_core::global_shortcuts::GlobalShortcuts;
use relay_core::host::{AppPaths, Shell, Webviews};
use relay_core::menu_bar_title::MenuBarTitle;
use relay_core::process_lock::ProcessLock;
use relay_core::service::Service;
use relay_core::shared::tray::TraySnapshot;
use relay_core::shared::types::{Account, DesktopState, PlanningSettings, RelaySettings};
use relay_core::shared::usage_rollups::UsageRollups;
use relay_core::sign_in_renewal::SignInRenewal;
use relay_core::switch_diagnostics::SwitchDiagnostics;
use relay_core::tempo_tracker::{TempoSource, TempoTracker};
use relay_core::usage::UsageManager;
use relay_core::usage_history::UsageHistory;
use relay_core::usage_refresh::UsageCredentialRefresher;
use relay_core::vault_migration::VaultSealer;
use relay_core::window_keeper::WindowKeeper;
use relay_i18n::LanguagePref;
use tauri::AppHandle;

/// Locks a mutex, taking the value of one a panicking thread left behind.
pub fn lock<T: ?Sized>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// The running Tauri app; `None` in tests that drive the core without a shell.
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// The tempo tracker's inputs: the usage history and the saved accounts and planning.
pub struct AppTempoSource;

impl TempoSource for AppTempoSource {
    fn available(&self) -> bool {
        STATE
            .usage_history
            .get()
            .is_some_and(|history| lock(history).rollups_available)
    }
    fn rollups(&self) -> Result<Option<UsageRollups>, String> {
        match STATE.usage_history.get() {
            Some(history) => Ok(lock(history).rollups()),
            None => Ok(None),
        }
    }
    fn accounts(&self) -> Vec<Account> {
        STATE.accounts()
    }
    fn settings(&self) -> PlanningSettings {
        STATE.settings().planning
    }
}

pub type Tempo = TempoTracker<AppTempoSource>;

pub struct AppState {
    pub service: OnceLock<Arc<Service>>,
    pub desktop: OnceLock<Arc<DesktopManager>>,
    /// This computer's vault key, once ready: account backups unseal and seal sign-ins with it.
    pub vault_sealer: OnceLock<Arc<VaultSealer>>,
    /// Why Claude app sign-ins cannot be saved, when the vault key is missing.
    pub vault_error: OnceLock<Option<String>>,
    /// Saves a Claude app sign-in by itself once the user has signed in and opened Code.
    pub auto_capture: OnceLock<Arc<AutoCapture>>,
    pub switch_diagnostics: OnceLock<Mutex<SwitchDiagnostics>>,
    /// Accounts opened in a separate Claude window beside the main one; macOS and Linux.
    pub desktop_windows: OnceLock<Arc<DesktopWindows>>,
    pub usage: OnceLock<Arc<UsageManager>>,
    pub usage_credential_refresher: OnceLock<Arc<UsageCredentialRefresher>>,
    pub auto_switch: OnceLock<Arc<AutoSwitchManager>>,
    /// What the menu bar title shows, kept beside the registry.
    pub menu_bar_title: OnceLock<Mutex<MenuBarTitle>>,
    /// The menu bar's last snapshot, so Settings can show what it shows.
    pub last_tray_snapshot: Mutex<Option<TraySnapshot>>,
    /// The global shortcuts (Settings → General), registered once the tray exists.
    pub global_shortcuts: OnceLock<Mutex<GlobalShortcuts>>,
    pub usage_history: OnceLock<Mutex<UsageHistory>>,
    pub active_timeline: OnceLock<Mutex<ActiveAccountTimeline>>,
    pub tempo: OnceLock<Tempo>,
    /// The saved language choice (language.json); `crate::i18n::locale` is what it resolves to.
    pub language_pref: RwLock<LanguagePref>,
    pub keeper: OnceLock<Arc<WindowKeeper>>,
    pub observed_desktop: Mutex<Option<DesktopState>>,
    pub initialized: AtomicBool,
    pub continuation: OnceLock<Arc<DesktopContinuationManager>>,
    pub fleet: OnceLock<Arc<FleetContinuation>>,
    pub automation: OnceLock<Arc<dyn DesktopAutomation>>,
    pub draft_restore: OnceLock<Arc<DraftScheduler>>,
    /// The lock Relay's processes share (the app and the relay CLI): each holder of the
    /// in-process lock takes it too, so a terminal never quits Claude in the middle of the
    /// app's work.
    pub operation_lock: OnceLock<Arc<ProcessLock>>,
    /// Set at quit: the window keeper's quota starter stops.
    pub keeper_abort: AtomicBool,
    pub quitting: AtomicBool,
    /// When the system said it is shutting down or restarting: quitting is not vetoed shortly
    /// after.
    pub system_shutdown_at: Mutex<Option<i64>>,
    pub sign_in_renewal: OnceLock<Arc<SignInRenewal>>,
    /// Moves the Antigravity app and agy between saved accounts; macOS only.
    pub antigravity_switcher: OnceLock<AntigravitySwitcher>,
    /// Whether the menu-bar item exists (Shell's `crate::tray`): without it closing the
    /// window quits.
    pub has_tray: AtomicBool,
    /// The desktop around the app (dialogs, clipboard, notifications, tray refresh).
    pub shell: OnceLock<Arc<dyn Shell>>,
    pub webviews: OnceLock<Arc<dyn Webviews>>,
    pub paths: OnceLock<Arc<dyn AppPaths>>,
}

macro_rules! getter {
    ($($name:ident: $ty:ty),* $(,)?) => {
        $(
            #[track_caller]
            pub fn $name(&self) -> &$ty {
                self.$name
                    .get()
                    .unwrap_or_else(|| panic!(concat!("Relay has not made ", stringify!($name), " yet")))
            }
        )*
    };
}

impl AppState {
    pub const fn new() -> Self {
        AppState {
            service: OnceLock::new(),
            desktop: OnceLock::new(),
            vault_sealer: OnceLock::new(),
            vault_error: OnceLock::new(),
            auto_capture: OnceLock::new(),
            switch_diagnostics: OnceLock::new(),
            desktop_windows: OnceLock::new(),
            usage: OnceLock::new(),
            usage_credential_refresher: OnceLock::new(),
            auto_switch: OnceLock::new(),
            menu_bar_title: OnceLock::new(),
            last_tray_snapshot: Mutex::new(None),
            global_shortcuts: OnceLock::new(),
            usage_history: OnceLock::new(),
            active_timeline: OnceLock::new(),
            tempo: OnceLock::new(),
            language_pref: RwLock::new(LanguagePref::System),
            keeper: OnceLock::new(),
            observed_desktop: Mutex::new(None),
            initialized: AtomicBool::new(false),
            continuation: OnceLock::new(),
            fleet: OnceLock::new(),
            automation: OnceLock::new(),
            draft_restore: OnceLock::new(),
            operation_lock: OnceLock::new(),
            keeper_abort: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            system_shutdown_at: Mutex::new(None),
            sign_in_renewal: OnceLock::new(),
            antigravity_switcher: OnceLock::new(),
            has_tray: AtomicBool::new(false),
            shell: OnceLock::new(),
            webviews: OnceLock::new(),
            paths: OnceLock::new(),
        }
    }

    getter! {
        service: Arc<Service>,
        desktop: Arc<DesktopManager>,
        vault_sealer: Arc<VaultSealer>,
        usage: Arc<UsageManager>,
        usage_credential_refresher: Arc<UsageCredentialRefresher>,
        auto_switch: Arc<AutoSwitchManager>,
        usage_history: Mutex<UsageHistory>,
        active_timeline: Mutex<ActiveAccountTimeline>,
        tempo: Tempo,
        keeper: Arc<WindowKeeper>,
        continuation: Arc<DesktopContinuationManager>,
        fleet: Arc<FleetContinuation>,
        automation: Arc<dyn DesktopAutomation>,
        draft_restore: Arc<DraftScheduler>,
        shell: Arc<dyn Shell>,
        webviews: Arc<dyn Webviews>,
        paths: Arc<dyn AppPaths>,
    }

    /// `service.store.state.settings`.
    pub fn settings(&self) -> RelaySettings {
        self.service()
            .store
            .with_state(|state| state.settings.clone())
    }

    /// `service.store.state.accounts`.
    pub fn accounts(&self) -> Vec<Account> {
        self.service()
            .store
            .with_state(|state| state.accounts.clone())
    }

    pub fn initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn set_quitting(&self, quitting: bool) {
        self.quitting.store(quitting, Ordering::SeqCst);
    }

    pub fn has_tray(&self) -> bool {
        self.has_tray.load(Ordering::SeqCst)
    }

    pub fn observed_desktop(&self) -> Option<DesktopState> {
        lock(&self.observed_desktop).clone()
    }

    /// `set.observedDesktop`: returns what it set.
    pub fn set_observed_desktop(&self, state: DesktopState) -> DesktopState {
        *lock(&self.observed_desktop) = Some(state.clone());
        state
    }

    /// A sign-in flow is starting, waiting or verifying.
    pub fn auth_busy(&self) -> bool {
        use relay_core::shared::types::AuthFlowStatus as S;
        self.service.get().is_some_and(|service| {
            service
                .auth
                .list()
                .iter()
                .any(|flow| matches!(flow.status, S::Starting | S::Waiting | S::Verifying))
        })
    }

    /// The main window's release timer may not free it now (electron/main/windows.ts `busy`): a
    /// sign-in or a Desktop operation in progress keeps it.
    pub fn main_window_busy(&self) -> bool {
        !self.initialized()
            || self.desktop.get().is_some_and(|desktop| desktop.is_busy())
            || crate::services::desktop_lock::DESKTOP_LOCK.busy()
            || self
                .observed_desktop()
                .is_some_and(|state| state.pending_profile_id.is_some())
            || self.auth_busy()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

pub static STATE: AppState = AppState::new();
