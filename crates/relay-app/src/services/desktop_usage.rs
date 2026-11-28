//! Usage read through each account's Claude app sign-in (port of electron/main/desktop-usage.ts).
//! Whether the user allowed the Keychain (Linux: keyring) read of "Claude Safe Storage" is
//! remembered in a small file, never the password itself.
//!
//! The claude.ai GET (electron/desktop-usage-request.ts, Chromium's network stack there) is
//! relay-core's `claude_web_request`: exactly the given `Cookie` header, no redirect, 15 s,
//! 256 KiB.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use relay_core::desktop_files::{read_bytes, write_bytes};
use relay_core::desktop_usage::{
    DESKTOP_USAGE_MARKER, DesktopUsageDeps, DesktopUsageReader, SafeStorageOptions,
    SafeStoragePassword, SavedPassword, claude_web_request, safe_storage_password,
};
use relay_core::linux_safe_storage::{LinuxSafeStorageOptions, linux_safe_storage_password};
use relay_core::usage::DesktopUsageSource;
use relay_core::vault_migration::VaultSealer;
use serde_json::Value;

use crate::state::STATE;

/// The vault file that keeps the Claude Safe Storage password, sealed (macOS).
const SAFE_STORAGE_KEPT: &str = "claude-safe-storage.bin";

static READER: OnceLock<Arc<DesktopUsageReader>> = OnceLock::new();

/// `desktopUsageReader`: reads through each account's Claude app sign-in; also lends the
/// renewal its claude.ai session. `None` until `desktop_usage_source` made it.
pub fn desktop_usage_reader() -> Option<Arc<DesktopUsageReader>> {
    READER.get().cloned()
}

fn marker() -> PathBuf {
    STATE.paths().data_dir().join(DESKTOP_USAGE_MARKER)
}

fn vault_dir() -> PathBuf {
    STATE.paths().data_dir().join("desktop-vault")
}

/// `desktopUsageAllowed`: whether the user allowed Relay to read the Claude app's sign-in (the
/// marker, never the password).
pub fn desktop_usage_allowed() -> bool {
    std::fs::read(marker())
        .ok()
        .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
        .is_some_and(|value| value.get("allowed") == Some(&Value::Bool(true)))
}

fn remember(allowed: bool) {
    let marker = marker();
    if allowed {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(&marker) {
            use std::io::Write;
            let _ = file.write_all(br#"{"allowed":true}"#);
        }
    } else {
        let _ = std::fs::remove_file(&marker);
        let _ = write_bytes(&vault_dir(), SAFE_STORAGE_KEPT, None);
    }
}

/// `desktopUsageSource`: the reader on the vault, as the usage manager's desktop source.
pub fn desktop_usage_source(sealer: Arc<VaultSealer>) -> DesktopUsageSource {
    let allowed: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(desktop_usage_allowed);
    let remembered: Arc<dyn Fn(bool) + Send + Sync> = Arc::new(remember);
    let password: Arc<dyn SafeStoragePassword> = if cfg!(target_os = "linux") {
        Arc::new(linux_safe_storage_password(LinuxSafeStorageOptions {
            allowed,
            remember: remembered,
            env: None,
            run: None,
        }))
    } else {
        let (load_sealer, store_sealer) = (sealer.clone(), sealer);
        // macOS: kept sealed after one read, since "Always Allow" never sticks for `security`.
        Arc::new(safe_storage_password(SafeStorageOptions {
            allowed,
            remember: remembered,
            tool: STATE.paths().security_tool(),
            saved: Some(SavedPassword {
                load: Arc::new(move || {
                    let data = read_bytes(&vault_dir(), SAFE_STORAGE_KEPT).ok()??;
                    load_sealer
                        .unseal(&data)
                        .ok()
                        .filter(|password| !password.is_empty())
                }),
                // Written whole or not at all, so a crash never leaves a file that cannot be
                // unsealed.
                store: Arc::new(move |password: &str| {
                    let sealed = store_sealer.seal(password).map_err(|e| e.to_string())?;
                    write_bytes(&vault_dir(), SAFE_STORAGE_KEPT, Some(&sealed))
                        .map_err(|e| e.to_string())
                }),
                clear: Arc::new(|| {
                    let _ = write_bytes(&vault_dir(), SAFE_STORAGE_KEPT, None);
                }),
            }),
        }))
    };
    let reader = READER
        .get_or_init(|| {
            Arc::new(DesktopUsageReader::new(DesktopUsageDeps {
                cookie_files: Arc::new(|account_uuid: &str| {
                    STATE
                        .desktop()
                        .login_cookie_files(account_uuid)
                        .map_err(|e| e.to_string())
                }),
                password,
                request: Arc::new(claude_web_request),
                read_rows: None,
                now: None,
                platform: None,
            }))
        })
        .clone();
    DesktopUsageSource {
        usable: Arc::new(DesktopUsageReader::usable),
        read: Arc::new(move |account, allow_prompt| reader.read(account, allow_prompt)),
    }
}
