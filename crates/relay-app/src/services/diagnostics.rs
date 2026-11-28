//! The diagnostics zip (port of exportDiagnostics in electron/main/windows.ts).

use std::path::{Path, PathBuf};

use relay_core::diagnostics_bundle::{
    CRASH_DUMP_NAMES, DiagnosticsBundleInput, build_diagnostics_bundle, newest_crash_dumps,
    settings_summary,
};
use relay_core::fs_util::iso_timestamp;
use relay_core::host::{FileDialog, FileFilter};
use serde_json::json;
use tauri::AppHandle;
use tauri::Manager;

use crate::state::STATE;

/// Node's `process.platform`.
pub fn node_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

/// The logs a bug report needs: the main error log and the event logs in the data folder.
fn diagnostics_files() -> Vec<PathBuf> {
    let data = STATE.paths().data_dir();
    let mut files = vec![crate::host::logs_dir().join("main-errors.log")];
    files.extend(
        [
            "usage-issues.json",
            "draft-events.json",
            "fleet-events.json",
        ]
        .iter()
        .map(|name| data.join(name)),
    );
    files
}

/// Help → Export diagnostics, and Settings → Advanced: the redacted zip for a bug report,
/// saved where the user picks and shown in Finder or Explorer. False when cancelled.
pub fn export_diagnostics(app: &AppHandle) -> Result<bool, String> {
    let at = relay_core::clock::now_ms();
    let created_at = iso_timestamp(at);
    let downloads = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| relay_core::relay_paths::home_dir().join("Downloads"));
    let Some(file_path) = STATE.shell().save_dialog(&FileDialog {
        default_path: Some(downloads.join(format!("relay-diagnostics-{}.zip", &created_at[..10]))),
        filters: vec![FileFilter {
            name: "ZIP".into(),
            extensions: vec!["zip".into()],
        }],
        ..FileDialog::default()
    }) else {
        return Ok(false);
    };
    let (accounts, settings) = STATE
        .service()
        .store
        .with_state(|state| (state.accounts.clone(), state.settings.clone()));
    let names: Vec<String> = accounts
        .iter()
        .flat_map(|account| {
            [
                account.name.clone(),
                account
                    .auth
                    .as_ref()
                    .and_then(|auth| auth.org_name.clone())
                    .unwrap_or_default(),
            ]
        })
        .collect();
    // Electron's crash dumps stay where it kept them (`<userData>/Crashpad`); Tauri writes none.
    let crash_dumps =
        newest_crash_dumps(&STATE.paths().data_dir().join("Crashpad"), CRASH_DUMP_NAMES);
    let summary = json!({
        "createdAt": created_at,
        "relay": app.package_info().version.to_string(),
        "packaged": !crate::host::UNPACKAGED,
        "tauri": tauri::VERSION,
        "webview": tauri::webview_version().unwrap_or_default(),
        "os": {
            "platform": node_platform(),
            "arch": relay_core::mac_update::node_arch(),
            "version": sysinfo::System::os_version().unwrap_or_default(),
            "release": sysinfo::System::kernel_version().unwrap_or_default(),
        },
        "locale": {
            "app": crate::i18n::locale().as_str(),
            "system": sys_locale::get_locale().unwrap_or_default(),
        },
        "settings": settings_summary(&settings, &accounts),
        "crashDumps": crash_dumps,
    });
    let files = diagnostics_files();
    let files: Vec<&Path> = files.iter().map(PathBuf::as_path).collect();
    let home = relay_core::relay_paths::home_dir();
    let home = home.to_string_lossy();
    let zip = build_diagnostics_bundle(&DiagnosticsBundleInput {
        files: &files,
        summary: &summary,
        names: &names,
        home: Some(&home),
        at_ms: Some(at),
    });
    crate::services::backup::write_private(&file_path, &zip).map_err(|e| e.to_string())?;
    STATE.shell().show_item_in_folder(&file_path);
    Ok(true)
}
