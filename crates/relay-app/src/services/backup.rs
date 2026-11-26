//! Settings → Advanced → Back up and Import: the sealed account backups (port of
//! electron/main/backup.ts).

use std::path::Path;
use std::sync::Mutex;

use relay_core::backup::{
    BackupContext, BackupError, BackupErrorReason, BackupFailure, BackupHost, BackupSource,
    DEFAULT_SCRYPT, MAX_BACKUP_BYTES, OpenedBackup, claude_code_sign_ins, collect_backup,
    import_backup, open_backup, read_backup_header, seal_backup, summarize_backup,
};
use relay_core::host::{FileDialog, FileFilter};
use relay_core::shared::backup::{
    BACKUP_EXTENSION, BackupExportResult, BackupFileChoice, BackupImportMode, BackupImportResult,
    BackupSummary, MIN_BACKUP_PASSPHRASE,
};
use relay_core::shared::proxy_types::ProxyConfig;
use relay_core::vault_crypto::Sealer;
use relay_core::vault_migration::VaultSealer;

use crate::i18n::{say, say_with};
use crate::services::desktop_lock::manual_desktop_lock;
use crate::services::diagnostics::node_platform;
use crate::services::errors::record_main_error;
use crate::services::gateway::{apply_proxy_config, proxy_settings, serialize_proxy};
use crate::state::{STATE, lock};

/// The backup picked for import, kept in memory between the dialog's steps: the file, then once
/// the passphrase opened it, the payload and its key. The passphrase itself is never kept.
pub struct PendingBackup {
    pub file: Vec<u8>,
    pub opened: Option<OpenedBackup>,
}

pub static PENDING_BACKUP: Mutex<Option<PendingBackup>> = Mutex::new(None);

/// Whether the opened backup holds an account `matches` picks (`pendingBackup?.opened?...some`).
pub fn pending_accounts_any(matches: impl Fn(&relay_core::shared::types::Account) -> bool) -> bool {
    lock(&PENDING_BACKUP)
        .as_ref()
        .and_then(|pending| pending.opened.as_ref())
        .is_some_and(|opened| opened.payload.accounts.iter().any(matches))
}

/// This computer's vault key; backups are refused until it is ready.
fn sealer() -> Result<&'static Sealer, String> {
    match STATE.vault_sealer.get().map(|sealer| &**sealer) {
        Some(VaultSealer::Ready(sealer)) => Ok(sealer),
        _ => Err(say("dataBackup.errorVaultNotReady")),
    }
}

/// Where backups read and put back secrets on this computer.
fn with_context<T>(f: impl FnOnce(&BackupContext) -> Result<T, String>) -> Result<T, String> {
    let sealer = sealer()?;
    let service = STATE.service();
    let claude_code = claude_code_sign_ins(node_platform());
    let now = relay_core::clock::now_ms;
    f(&BackupContext {
        host: BackupHost {
            data: service.store.root(),
            sealer,
            claude_code: &claude_code,
        },
        relay_version: STATE.paths().app_version(),
        platform: node_platform().to_owned(),
        now: &now,
    })
}

/// A backup's refusal in the app's language.
fn refusal(error: &BackupError) -> String {
    match error.reason {
        BackupErrorReason::NotABackup => say("dataBackup.errorNotABackup"),
        BackupErrorReason::NewerFormat => say("dataBackup.errorNewerFormat"),
        BackupErrorReason::WrongPassphrase => say("dataBackup.errorWrongPassphrase"),
        BackupErrorReason::Damaged => say("dataBackup.errorDamaged"),
        BackupErrorReason::TooLarge => say("dataBackup.errorTooLarge"),
        BackupErrorReason::ShortPassphrase => say_with(
            "dataBackup.errorShortPassphrase",
            &relay_i18n::Args::new().set("count", MIN_BACKUP_PASSPHRASE as f64),
        ),
    }
}

/// Any backup step's failure: a refusal worded in the app's language, any other error as it came.
fn failure(error: BackupFailure) -> String {
    match error {
        BackupFailure::Backup(error) => refusal(&error),
        other => other.to_string(),
    }
}

fn refused(reason: BackupErrorReason) -> String {
    refusal(&BackupError { reason })
}

fn relay_filter() -> Vec<FileFilter> {
    vec![FileFilter {
        name: "Relay".into(),
        extensions: vec![BACKUP_EXTENSION.into()],
    }]
}

/// Writes a new private file (`fsp.writeFile(file, data, { mode: 0o600 })`).
pub fn write_private(file: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(file)?.write_all(data)
}

/// Settings → Advanced → Back up: the accounts, settings and, when chosen, the saved sign-ins,
/// sealed with the passphrase into a file the user places, then shown. None when the dialog was
/// cancelled. The passphrase only derives the key; it is never stored.
pub fn export_backup(
    passphrase: &str,
    include_sign_ins: bool,
) -> Result<Option<BackupExportResult>, String> {
    with_context(|context| {
        if passphrase.chars().count() < MIN_BACKUP_PASSPHRASE {
            return Err(refused(BackupErrorReason::ShortPassphrase));
        }
        let day = relay_core::fs_util::iso_timestamp(relay_core::clock::now_ms());
        let Some(file_path) = STATE.shell().save_dialog(&FileDialog {
            default_path: Some(
                STATE
                    .paths()
                    .documents_dir()
                    .join(format!("relay-{}.{BACKUP_EXTENSION}", &day[..10])),
            ),
            filters: relay_filter(),
            ..FileDialog::default()
        }) else {
            return Ok(None);
        };
        let (settings, accounts) = STATE
            .service()
            .store
            .with_state(|state| (state.settings.clone(), state.accounts.clone()));
        let gateway = proxy_settings();
        let payload = collect_backup(
            &BackupSource {
                settings: &settings,
                accounts: &accounts,
                gateway: &gateway,
            },
            include_sign_ins,
            context,
        )
        .map_err(failure)?;
        let file = seal_backup(&payload, passphrase, DEFAULT_SCRYPT).map_err(|e| refusal(&e))?;
        write_private(&file_path, &file).map_err(|e| e.to_string())?;
        STATE.shell().show_item_in_folder(&file_path);
        let sign_ins = summarize_backup(&payload, &[])
            .accounts
            .iter()
            .filter(|account| account.sign_in)
            .count();
        Ok(Some(BackupExportResult {
            accounts: payload.accounts.len() as f64,
            sign_ins: sign_ins as f64,
        }))
    })
}

/// Import, first step: the file, checked before any passphrase is asked. None when cancelled.
pub fn choose_backup() -> Result<Option<BackupFileChoice>, String> {
    let Some(picked) = STATE.shell().open_dialog(&FileDialog {
        filters: relay_filter(),
        ..FileDialog::default()
    }) else {
        return Ok(None);
    };
    let stat = std::fs::metadata(&picked).map_err(|e| e.to_string())?;
    if !stat.is_file() {
        return Err(refused(BackupErrorReason::NotABackup));
    }
    if stat.len() > MAX_BACKUP_BYTES as u64 {
        return Err(refused(BackupErrorReason::TooLarge));
    }
    let file = std::fs::read(&picked).map_err(|e| e.to_string())?;
    read_backup_header(&file).map_err(|e| refusal(&e))?;
    *lock(&PENDING_BACKUP) = Some(PendingBackup { file, opened: None });
    Ok(Some(BackupFileChoice {
        name: picked
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }))
}

/// Import, second step: opens the picked file with the passphrase and answers what it holds.
pub fn read_backup(passphrase: &str) -> Result<BackupSummary, String> {
    let file = lock(&PENDING_BACKUP)
        .as_ref()
        .map(|pending| pending.file.clone())
        .ok_or_else(|| say("dataBackup.errorNoFile"))?;
    // Opening derives the key (scrypt): the pending file stays unlocked meanwhile.
    let opened = open_backup(&file, passphrase).map_err(|e| refusal(&e))?;
    let summary = summarize_backup(&opened.payload, &STATE.accounts());
    if let Some(pending) = lock(&PENDING_BACKUP).as_mut() {
        pending.opened = Some(opened);
    }
    Ok(summary)
}

/// `{ ...proxySettings(), ...gateway }`: the backup's portable gateway settings over these.
fn merged_gateway(gateway: relay_core::backup::BackupGateway) -> ProxyConfig {
    let mut config = proxy_settings();
    config.port = gateway.port;
    config.routing_strategy = gateway.routing_strategy;
    config.affinity_ttl_seconds = gateway.affinity_ttl_seconds;
    if gateway.account_order.is_some() {
        config.account_order = gateway.account_order;
    }
    if gateway.excluded_account_ids.is_some() {
        config.excluded_account_ids = gateway.excluded_account_ids;
    }
    if gateway.subagent_overflow.is_some() {
        config.subagent_overflow = gateway.subagent_overflow;
    }
    if gateway.api_key.is_some() {
        config.api_key = gateway.api_key;
    }
    config
}

/// Import, last step, under the Desktop lock: brings the opened backup in (relay_core::backup),
/// then applies a replace's gateway settings through the gateway's own path and lets go of the
/// accounts a replace took out of the list.
pub fn apply_backup(mode: BackupImportMode) -> Result<BackupImportResult, String> {
    let opened = lock(&PENDING_BACKUP)
        .as_mut()
        .and_then(|pending| pending.opened.take())
        .ok_or_else(|| say("dataBackup.errorNoFile"))?;
    let service = STATE.service();
    let before: Vec<String> = STATE.accounts().into_iter().map(|a| a.id).collect();
    let imported = with_context(|context| {
        manual_desktop_lock(|| {
            service.transaction(|| {
                import_backup(&opened, mode, &service.store, &proxy_settings(), context)
                    .map_err(failure)
            })
        })
    });
    let imported = match imported {
        Ok(imported) => imported,
        Err(error) => {
            // Not taken for good: the user may try again with the opened file.
            if let Some(pending) = lock(&PENDING_BACKUP).as_mut() {
                pending.opened = Some(opened);
            }
            return Err(error);
        }
    };
    *lock(&PENDING_BACKUP) = None;
    let kept: Vec<String> = STATE.accounts().into_iter().map(|a| a.id).collect();
    for id in before.iter().filter(|id| !kept.contains(id)) {
        crate::services::antigravity::stop_bridge(id);
        STATE.usage().forget(id);
    }
    if let Some(gateway) = imported.gateway {
        let config = merged_gateway(gateway);
        if let Err(error) = serialize_proxy(|| apply_proxy_config(config)) {
            record_main_error("backup-gateway", &error);
        }
    }
    std::thread::spawn(crate::services::tokens_widget::add_token_roots);
    let keeper = STATE.keeper().clone();
    keeper.resume();
    std::thread::spawn(move || {
        let _ = keeper.tick();
    });
    crate::services::tray_setup::update_tray();
    crate::events::changed();
    Ok(imported.result)
}

/// The import dialog was closed: the picked backup is dropped.
pub fn forget_pending_backup() {
    *lock(&PENDING_BACKUP) = None;
}
