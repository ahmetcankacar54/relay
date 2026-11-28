//! Settings → Advanced: diagnostics, account backups and removing Relay's data (port of
//! electron/main/ipc/diagnostics-backup.ts).

use relay_core::shared::backup::{BackupImportMode, MIN_BACKUP_PASSPHRASE};
use relay_core::shared::feature_risk::antigravity_account_risks;
use relay_core::shared::types::AccountProvider;
use relay_core::store::schema::{boolean, strict};

use super::{Call, IpcResult, Registry, done, reply, require_risk, string};
use crate::services::backup;
use crate::state::STATE;

pub fn register(registry: &mut Registry) {
    registry.handle("show-diagnostics", show_diagnostics);
    registry.handle("export-diagnostics", export_diagnostics);
    registry.handle("backup-export", backup_export);
    registry.handle("backup-choose", backup_choose);
    registry.handle("backup-open", backup_open);
    registry.handle("backup-import", backup_import);
    registry.handle("backup-cancel", backup_cancel);
    registry.handle("reset-data", reset_data);
}

/// Takes no argument: the renderer cannot name a path to reveal. Only these fixed files in the
/// data folder.
fn show_diagnostics(_call: &Call) -> IpcResult {
    let folder = STATE.paths().data_dir();
    for name in ["draft-events.json", "usage-issues.json"] {
        let file = folder.join(name);
        if std::fs::metadata(&file).is_ok_and(|stat| stat.is_file()) {
            STATE.shell().show_item_in_folder(&file);
            return done();
        }
    }
    // Neither exists yet: open the folder itself rather than highlight it in its parent.
    STATE.shell().open_path(&folder)?;
    done()
}

/// Takes no argument: main picks the files and the save dialog picks the place.
fn export_diagnostics(_call: &Call) -> IpcResult {
    let app = crate::state::app().ok_or("Relay has no window yet.")?;
    reply(crate::services::diagnostics::export_diagnostics(app)?)
}

/// Account backups: the page passes the passphrase and choices, never a path; dialogs pick
/// files.
fn backup_export(call: &Call) -> IpcResult {
    let input = call.value(
        0,
        &strict(vec![
            ("passphrase", string(MIN_BACKUP_PASSPHRASE, 1024)),
            ("includeSignIns", boolean()),
        ]),
    )?;
    let passphrase = input["passphrase"].as_str().unwrap_or_default();
    let include_sign_ins = input["includeSignIns"].as_bool().unwrap_or_default();
    reply(backup::export_backup(passphrase, include_sign_ins)?)
}

fn backup_choose(_call: &Call) -> IpcResult {
    reply(backup::choose_backup()?)
}

fn backup_open(call: &Call) -> IpcResult {
    reply(backup::read_backup(&call.string(0, 1, 1024)?)?)
}

fn backup_import(call: &Call) -> IpcResult {
    let mode: BackupImportMode = call.parse(
        0,
        &relay_core::store::schema::enumeration(["merge", "replace"]),
    )?;
    // Antigravity accounts the import adds are on the risk ladder: accepted first, as when
    // added by hand.
    let here: Vec<String> = STATE.accounts().into_iter().map(|a| a.id).collect();
    if backup::pending_accounts_any(|account| {
        account.provider == Some(AccountProvider::Antigravity)
            && (mode == BackupImportMode::Replace || !here.contains(&account.id))
    }) {
        require_risk(&antigravity_account_risks(
            crate::services::gateway::proxy_settings().enabled,
        ))?;
    }
    reply(backup::apply_backup(mode)?)
}

fn backup_cancel(_call: &Call) -> IpcResult {
    backup::forget_pending_backup();
    done()
}

fn reset_data(_call: &Call) -> IpcResult {
    crate::services::data_reset::reset_data()?;
    done()
}
