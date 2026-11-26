//! Port of `electron/core/account-removal.ts`: forgetting an account, for `relay remove` and the
//! app alike.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

use serde_json::{Map, Value};

use crate::desktop_files::{DesktopFileError, write_bytes};
use crate::profile_lock::{ProfileLockError, ProfileLockKind, acquire_profile_lock};
use crate::shared::overflow::OverflowSettings;
use crate::shared::types::AccountRemoved;
use crate::store::{Store, StoreError};

/// Why an account cannot be removed now: it is open in the Claude app, or its sign-in there is
/// pending.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovalBlock {
    Active,
    Pending,
}

/// The Desktop facts the refusals read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DesktopFacts {
    pub active_profile_id: Option<String>,
    pub pending_profile_id: Option<String>,
}

/// A removal refused by `removal_block`; the CLI and the app each say it in their own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{}", match .reason {
    RemovalBlock::Active => "Switch the Claude app to another account before removing this one.",
    RemovalBlock::Pending => "Finish or cancel this account’s Claude app sign-in before removing it.",
})]
pub struct AccountRemovalRefused {
    pub reason: RemovalBlock,
}

/// What stops removing `account_id` while Desktop is as `state` says; None when nothing does.
pub fn removal_block(account_id: &str, state: &DesktopFacts) -> Option<RemovalBlock> {
    if state.active_profile_id.as_deref() == Some(account_id) {
        return Some(RemovalBlock::Active);
    }
    if state.pending_profile_id.as_deref() == Some(account_id) {
        return Some(RemovalBlock::Pending);
    }
    None
}

#[derive(Debug, thiserror::Error)]
pub enum AccountRemovalError {
    #[error(transparent)]
    Refused(#[from] AccountRemovalRefused),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    ProfileLock(#[from] ProfileLockError),
    #[error(transparent)]
    File(#[from] DesktopFileError),
    #[error(transparent)]
    Io(#[from] io::Error),
    /// Reading Desktop failed.
    #[error("{0}")]
    Desktop(String),
}

/// Signs the usage sign-in out in a profile, answering whether it did.
pub type SignOut<'f> = dyn Fn(&Path) -> Result<bool, String> + 'f;

pub struct AccountRemoval<'a> {
    pub store: &'a Store,
    /// The sealed sign-ins (`desktop-vault`).
    pub vault: &'a Path,
    /// The per-account profile locks, shared with Relay's other processes.
    pub locks: &'a Path,
    /// Desktop read fresh: the refusals are checked again right before anything is deleted.
    pub desktop: &'a dyn Fn() -> Result<DesktopFacts, String>,
    /// Signs the usage sign-in out in the profile (`claude auth logout`), answering whether it
    /// did. None when no Claude Code CLI was found.
    pub sign_out: Option<&'a SignOut<'a>>,
}

fn string_list(value: Option<&Value>) -> Option<Option<Vec<String>>> {
    let Some(value) = value else {
        return Some(None);
    };
    let items = value.as_array()?;
    if items.len() > 200 {
        return None;
    }
    items
        .iter()
        .map(|v| v.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
        .map(Some)
}

/// `proxyExtrasSchema.parse`: the extras in its key order, unknown keys dropped and an overflow
/// setup this build cannot read left out; None when the file does not parse.
fn parse_extras(value: &Value) -> Option<Map<String, Value>> {
    let map = value.as_object()?;
    let mut out = Map::new();
    for key in ["accountOrder", "excludedAccountIds"] {
        if let Some(list) = string_list(map.get(key))? {
            out.insert(key.into(), Value::from(list));
        }
    }
    if let Some(revision) = map.get("affinityRevision") {
        let n = revision.as_f64()?;
        if n.fract() != 0.0 || !(0.0..=1_000.0).contains(&n) {
            return None;
        }
        out.insert("affinityRevision".into(), revision.clone());
    }
    if let Some(flag) = map.get("subagentOverflow") {
        out.insert("subagentOverflow".into(), Value::Bool(flag.as_bool()?));
    }
    if let Some(overflow) = map.get("overflow")
        && let Ok(settings) = serde_json::from_value::<OverflowSettings>(overflow.clone())
    {
        out.insert("overflow".into(), serde_json::to_value(settings).ok()?);
    }
    if let Some(bindings) = map.get("clientBindings") {
        let bindings = bindings.as_object()?;
        let mut kept = Map::new();
        for client in ["claude-code", "codex", "omp"] {
            let Some(saved) = bindings.get(client) else {
                continue;
            };
            let saved = saved.as_object()?;
            if saved.values().any(|v| !(v.is_string() || v.is_null())) {
                return None;
            }
            kept.insert(client.into(), Value::Object(saved.clone()));
        }
        out.insert("clientBindings".into(), Value::Object(kept));
    }
    Some(out)
}

/// Takes an account out of the gateway's pool order and its left-out list in `proxy-pool.json`,
/// beside the registry. A missing or unreadable file has nothing to take out. The client
/// bindings there hold the clients' own settings, never an account.
fn forget_in_pool(root: &Path, account_id: &str) -> io::Result<()> {
    let file = root.join("proxy-pool.json");
    let Some(mut extras) = fs::read(&file)
        .ok()
        .and_then(|data| serde_json::from_str::<Value>(&String::from_utf8_lossy(&data)).ok())
        .and_then(|value| parse_extras(&value))
    else {
        return Ok(());
    };
    let names = |key: &str, extras: &Map<String, Value>| {
        extras
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|l| l.iter().any(|id| id == account_id))
    };
    if !names("accountOrder", &extras) && !names("excludedAccountIds", &extras) {
        return Ok(());
    }
    for key in ["accountOrder", "excludedAccountIds"] {
        if let Some(Value::Array(list)) = extras.get_mut(key) {
            list.retain(|id| id != account_id);
        }
    }
    let temp = root.join("proxy-pool.json.tmp");
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&extras).unwrap_or_default()
    );
    write_private(&temp, text.as_bytes())?;
    fs::rename(&temp, &file)
}

/// `fs.writeFileSync(file, data, { mode: 0o600 })`: an existing file keeps its mode.
fn write_private(file: &Path, data: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    io::Write::write_all(&mut options.open(file)?, data)
}

/// Forgets an account. Refused (`AccountRemovalRefused`) for the account open in the Claude app
/// and one whose Claude app sign-in is pending, and while anything holds its profile lock. Under
/// that lock it signs the usage sign-in out, deletes the profile folder, the sealed Claude app
/// sign-in, the Claude extension's sign-in, the plain terminal's saved sign-ins and the browser's
/// claude.ai login kept for it (under either uuid the account has), and drops it from the
/// registry, the lists that name it and the gateway's pool. The Claude app's own data, the usage
/// history and the token ledger are left alone.
pub fn remove_account(
    account_id: &str,
    options: &AccountRemoval<'_>,
) -> Result<AccountRemoved, AccountRemovalError> {
    let store = options.store;
    let account = store.account(account_id)?;
    let facts = (options.desktop)().map_err(AccountRemovalError::Desktop)?;
    if let Some(reason) = removal_block(&account.id, &facts) {
        return Err(AccountRemovalRefused { reason }.into());
    }
    let mut guard = acquire_profile_lock(options.locks, &account.id, ProfileLockKind::Exclusive)?;
    let result = remove_locked(&account, options);
    guard.release();
    let _ = fs::remove_dir_all(options.locks.join(&account.id));
    result
}

fn remove_locked(
    account: &crate::shared::types::Account,
    options: &AccountRemoval<'_>,
) -> Result<AccountRemoved, AccountRemovalError> {
    let store = options.store;
    let mut result = AccountRemoved::default();
    let profile = store.profile(&account.id)?;
    // Also when the stored check says "not logged in": a stale check must not leave the
    // profile's Keychain item behind once its folder is gone.
    if account.auth.as_ref().is_some_and(|a| a.logged_in) {
        result.signed_out = Some(false);
    }
    if account.auth.is_some()
        && let Some(sign_out) = options.sign_out
    {
        // A failure is said as not signed out: its Keychain item may remain.
        if let Ok(done) = sign_out(&profile) {
            result.signed_out = Some(done);
        }
    }
    match fs::remove_dir_all(&profile) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    let desktop_uuid = account.desktop.as_ref().map(|d| d.account_uuid.clone());
    let auth_uuid = account.auth.as_ref().and_then(|a| a.account_uuid.clone());
    if let Some(uuid) = &desktop_uuid {
        write_bytes(
            options.vault,
            &format!("accounts/{}.bin", uuid.to_lowercase()),
            None,
        )?;
    }
    // The Claude extension's saved sign-in and the browser's login go with the account.
    let mut seen = HashSet::new();
    for uuid in [&desktop_uuid, &auth_uuid].into_iter().flatten() {
        if !seen.insert(uuid.clone()) {
            continue;
        }
        for dir in ["extension", "extension-cookies"] {
            write_bytes(
                options.vault,
                &format!("{dir}/{}.bin", uuid.to_lowercase()),
                None,
            )?;
        }
    }
    // The plain terminal's saved sign-ins, one file per organization: `terminal/<uuid>.<org>.bin`.
    let uuids: Vec<String> = [&desktop_uuid, &auth_uuid]
        .into_iter()
        .flatten()
        .map(|u| u.to_lowercase())
        .collect();
    let saved: Vec<String> = match fs::read_dir(options.vault.join("terminal")) {
        Ok(entries) => entries
            .map(|e| Ok(e?.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<_>>()?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    for name in saved {
        if uuids
            .iter()
            .any(|uuid| name.starts_with(&format!("{uuid}.")))
        {
            write_bytes(options.vault, &format!("terminal/{name}"), None)?;
        }
    }
    let id = account.id.clone();
    store.update(|s| {
        s.accounts.retain(|a| a.id != id);
        s.settings.desktop_history_accounts.retain(|a| *a != id);
        s.settings.auto_switch_accounts.retain(|a| *a != id);
        s.settings.planning.accounts.retain(|a| a.id != id);
    })?;
    forget_in_pool(&store.root, &account.id)?;
    Ok(result)
}
