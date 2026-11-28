//! The first step: the registry, the language, the vault key and the Antigravity switcher
//! (port of electron/main/boot/vault.ts).

use std::sync::Arc;

use relay_core::auth::WebviewAuthBrowser;
use relay_core::language_file::load_language_pref;
use relay_core::legacy_unseal::SystemLegacySeal;
use relay_core::process_lock::{LockBy, ProcessLock};
use relay_core::profile_lock::acquire_profile_lock;
use relay_core::service::{Service, ServiceOptions};
use relay_core::shared::types::{AuthFlowStatus, RelaySettings};
use relay_core::vault_crypto::LegacyUnseal;
use relay_core::vault_migration::{PrepareVault, prepare_vault};
use relay_i18n::{LanguagePref, resolve_locale};

use crate::services::desktop_lock::profile_locks;
use crate::state::STATE;

/// The window theme from the Appearance setting (`nativeTheme.themeSource`).
pub fn apply_theme(settings: &RelaySettings) {
    use relay_core::shared::types::Appearance;
    let Some(app) = crate::state::app() else {
        return;
    };
    app.set_theme(match settings.appearance {
        Appearance::Light => Some(tauri::Theme::Light),
        Appearance::Dark => Some(tauri::Theme::Dark),
        _ => None,
    });
}

/// Resolves the saved language choice against the system's and makes it the app's.
pub fn apply_language(pref: LanguagePref) {
    *STATE
        .language_pref
        .write()
        .unwrap_or_else(|e| e.into_inner()) = pref;
    crate::i18n::set_locale(resolve_locale(Some(pref), &crate::i18n::system_languages()));
}

pub fn boot_vault() -> Result<(), String> {
    let paths = STATE.paths().clone();
    let data = paths.data_dir();
    let mut options = ServiceOptions::new(&data);
    options.emit = Box::new(crate::events::terminal);
    options.emit_auth = Some(Arc::new(|flow| {
        if flow.status == AuthFlowStatus::Connected
            && let Some(usage) = STATE.usage.get()
        {
            usage.invalidate(&flow.account_id);
            usage.tick();
        }
        // A renewal Relay runs by itself stays off the screens.
        if flow.background != Some(true) {
            crate::events::auth(&flow);
        }
    }));
    options.open_browser = Some(Arc::new(|url: &str| STATE.shell().open_external(url)));
    options.profile_lock = Some(Arc::new(|account_id, kind| {
        acquire_profile_lock(&profile_locks(), account_id, kind)
    }));
    let service = Service::new(options).map_err(|e| e.to_string())?;
    let _ = STATE.service.set(service.clone());
    // The app speaks before any window opens (tray, menu, widget): the saved language, which
    // installs from before the setting get as Turkish (what they saw), new ones as the
    // system's.
    let has_accounts = service.store.with_state(|state| !state.accounts.is_empty());
    apply_language(load_language_pref(service.store.root(), has_accounts));
    // A browser login may finish after its dialog closed or Relay restarted.
    crate::services::antigravity::recover_saved_sign_ins();
    // The usage sign-in opens in Relay's own window per account; Windows keeps the browser.
    if !cfg!(windows) {
        match WebviewAuthBrowser::new(
            &data,
            &crate::i18n::say("authWindow.signInWithClaude"),
            STATE.webviews().clone(),
        ) {
            Ok(browser) => {
                // The terminal's sign-ins open the same way (boot/automation.ts).
                let browser: Arc<dyn relay_core::auth::AuthBrowser> = Arc::new(browser);
                service.auth.set_browser(Some(browser.clone()));
                service.terminal_auth.set_browser(Some(browser));
            }
            Err(error) => {
                crate::services::errors::record_main_error("auth-window", &error.to_string())
            }
        }
    }
    crate::services::desktop_support::watch_registry();
    apply_theme(&STATE.settings());
    let vault_dir = paths.data_dir().join("desktop-vault");
    let _ = STATE.operation_lock.set(Arc::new(ProcessLock::new(
        vault_dir.join("operation.lock"),
        LockBy::App,
    )));
    // Saved sign-ins move from safeStorage to the vault key the relay CLI can read too. The
    // vault key lives in the macOS Keychain, elsewhere in the system's keyring.
    let tool = paths.security_tool();
    let legacy = Arc::new(SystemLegacySeal::new(&data, tool.as_deref()));
    let unseal = legacy.clone();
    let legacy_unseal: LegacyUnseal = Arc::new(move |blob: &[u8]| unseal.unseal(blob));
    let available = || legacy.available();
    let prepared = prepare_vault(PrepareVault {
        vault: &vault_dir,
        legacy_unseal,
        legacy_available: Some(&available),
        tool: tool.as_deref(),
    });
    let sealer = Arc::new(prepared.sealer);
    let _ = STATE.vault_sealer.set(sealer.clone());
    let _ = STATE.vault_error.set(prepared.error);
    #[cfg(target_os = "macos")]
    boot_antigravity(&vault_dir, sealer, tool.as_deref());
    Ok(())
}

/// The Antigravity switcher on the vault; a sign-in Relay took off this Mac for a new
/// account's sign-in goes back if Relay quit mid-way.
#[cfg(target_os = "macos")]
fn boot_antigravity(
    vault_dir: &std::path::Path,
    sealer: Arc<relay_core::vault_migration::VaultSealer>,
    tool: Option<&std::path::Path>,
) {
    use relay_core::antigravity_app::antigravity_data_dir;
    use relay_core::antigravity_switch::{
        AntigravitySwitcher, AntigravityVault, mac_antigravity_ports,
    };
    use relay_core::relay_paths::{Platform, home_dir};
    let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let data_dir = antigravity_data_dir(Platform::MacOs, &home_dir().to_string_lossy(), &env);
    let seal_with = sealer.clone();
    let vault = AntigravityVault::new(
        vault_dir,
        Arc::new(move |text: &str| seal_with.seal(text).map_err(|e| e.to_string())),
        Arc::new(move |data: &[u8]| sealer.unseal(data).map_err(|e| e.to_string())),
        None,
    );
    let switcher = AntigravitySwitcher::new(
        mac_antigravity_ports(std::path::Path::new(&data_dir), tool),
        Arc::new(vault),
        Arc::new(|| STATE.accounts()),
        Some(Arc::new(crate::events::changed)),
        None,
    );
    if STATE.antigravity_switcher.set(switcher).is_ok()
        && let Some(switcher) = STATE.antigravity_switcher.get()
    {
        let switcher = switcher.clone();
        std::thread::spawn(move || switcher.recover());
    }
}
