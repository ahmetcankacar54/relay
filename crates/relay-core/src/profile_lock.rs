//! Port of `electron/core/profile-lock.ts`: per-account profile locks, one file per holder at
//! `<locks>/<accountId>/<pid>-<uuid>.json`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::now_ms;
use crate::fs_util::{create_private_dir_all, iso_timestamp, safe_integer, set_mode};
use crate::process_lock::{LockDeps, holder_alive};

/// Shared: Claude Code runs under the profile (the CLI's `run`, the app's terminals).
/// Exclusive: its credential is being changed (login, refresh, removal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileLockKind {
    Shared,
    Exclusive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLockHolder {
    pub pid: i64,
    pub kind: ProfileLockKind,
    pub started_at: String,
}

/// The account's profile is held in a way that excludes the requested kind.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{}", if .holders.iter().any(|h| h.kind == ProfileLockKind::Exclusive) {
    "Another process is signing this account in or renewing its connection."
} else {
    "Claude Code is running with this account."
})]
pub struct ProfileLockBusyError {
    pub account_id: String,
    pub holders: Vec<ProfileLockHolder>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileLockError {
    #[error(transparent)]
    Busy(#[from] ProfileLockBusyError),
    #[error("Invalid account id.")]
    InvalidAccountId,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Any 8-4-4-4-12 hex id, either case.
fn uuid_shaped(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `/^\d+-[0-9a-f-]{36}\.json$/i`.
fn holder_file_name(name: &str) -> bool {
    let Some(stem) = name
        .len()
        .checked_sub(5)
        .and_then(|cut| name.is_char_boundary(cut).then(|| &name[..cut]))
        .filter(|_| name[name.len() - 5..].eq_ignore_ascii_case(".json"))
    else {
        return false;
    };
    let Some((pid, id)) = stem.split_once('-') else {
        return false;
    };
    !pid.is_empty()
        && pid.bytes().all(|b| b.is_ascii_digit())
        && id.len() == 36
        && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn account_dir(locks_dir: &Path, account_id: &str) -> Result<PathBuf, ProfileLockError> {
    if !uuid_shaped(account_id) {
        return Err(ProfileLockError::InvalidAccountId);
    }
    Ok(locks_dir.join(account_id.to_ascii_lowercase()))
}

struct Entry {
    name: String,
    holder: ProfileLockHolder,
}

/// Live holders, each with its file name; dead holders' files are removed on the way.
fn live_entries(dir: &Path) -> io::Result<Vec<Entry>> {
    let names = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let deps = LockDeps::default();
    let mut live = Vec::new();
    for entry in names {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !holder_file_name(&name) {
            continue;
        }
        let file = dir.join(&name);
        // Being written this instant, or not ours to judge.
        let Ok(value) = read_private_json(&file, 4096) else {
            continue;
        };
        let Some(holder) = (|| {
            let v = value.as_object()?;
            Some(ProfileLockHolder {
                pid: safe_integer(v.get("pid")?)?,
                kind: match v.get("kind")?.as_str()? {
                    "shared" => ProfileLockKind::Shared,
                    "exclusive" => ProfileLockKind::Exclusive,
                    _ => return None,
                },
                started_at: v.get("startedAt")?.as_str()?.to_owned(),
            })
        })() else {
            continue;
        };
        if !holder_alive(holder.pid, &holder.started_at, &deps) {
            // Swept by someone else is fine.
            let _ = fs::remove_file(&file);
            continue;
        }
        live.push(Entry { name, holder });
    }
    Ok(live)
}

/// The live holders of an account's profile lock, without `except_pid`'s.
pub fn profile_lock_holders(
    locks_dir: &Path,
    account_id: &str,
    except_pid: Option<i64>,
) -> Result<Vec<ProfileLockHolder>, ProfileLockError> {
    Ok(live_entries(&account_dir(locks_dir, account_id)?)?
        .into_iter()
        .map(|e| e.holder)
        .filter(|h| Some(h.pid) != except_pid)
        .collect())
}

/// Whether any account's profile is locked exclusively, other than by `except_pid`.
pub fn any_exclusive_profile_lock(
    locks_dir: &Path,
    except_pid: Option<i64>,
) -> Result<bool, ProfileLockError> {
    let entries = match fs::read_dir(locks_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    let mut accounts = Vec::new();
    for entry in entries {
        if let Some(name) = entry?.file_name().to_str().filter(|n| uuid_shaped(n)) {
            accounts.push(name.to_owned());
        }
    }
    for account in accounts {
        if profile_lock_holders(locks_dir, &account, except_pid)?
            .iter()
            .any(|h| h.kind == ProfileLockKind::Exclusive)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A held profile lock. Its file goes on `release` or drop, whichever comes first.
#[derive(Debug)]
pub struct ProfileLockGuard {
    file: Option<PathBuf>,
}

impl ProfileLockGuard {
    /// Gives the lock back; again does nothing.
    pub fn release(&mut self) {
        if let Some(file) = self.file.take() {
            // Already gone is fine.
            let _ = fs::remove_file(file);
        }
    }
}

impl Drop for ProfileLockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// Takes an account's profile lock. The process writes its own file, then looks at the others:
/// exclusive needs no other live holder, shared needs no live exclusive one. On a conflict its
/// own file goes again and `ProfileLockBusyError` names them.
pub fn acquire_profile_lock(
    locks_dir: &Path,
    account_id: &str,
    kind: ProfileLockKind,
) -> Result<ProfileLockGuard, ProfileLockError> {
    let dir = account_dir(locks_dir, account_id)?;
    create_private_dir_all(&dir)?;
    set_mode(&dir, 0o700)?;
    let pid = std::process::id();
    let name = format!("{pid}-{}.json", uuid::Uuid::new_v4());
    let file = dir.join(&name);
    let holder = ProfileLockHolder {
        pid: i64::from(pid),
        kind,
        started_at: iso_timestamp(now_ms()),
    };
    let data = serde_json::to_vec(&holder).map_err(io::Error::other)?;
    let mut handle = crate::fs_util::create_new_private(&file)?;
    io::Write::write_all(&mut handle, &data)?;
    drop(handle);
    let mut guard = ProfileLockGuard { file: Some(file) };
    let others: Vec<ProfileLockHolder> = live_entries(&dir)?
        .into_iter()
        .filter(|e| e.name != name)
        .map(|e| e.holder)
        .collect();
    let conflict = match kind {
        ProfileLockKind::Exclusive => !others.is_empty(),
        ProfileLockKind::Shared => others.iter().any(|h| h.kind == ProfileLockKind::Exclusive),
    };
    if conflict {
        guard.release();
        return Err(ProfileLockBusyError {
            account_id: account_id.to_owned(),
            holders: others,
        }
        .into());
    }
    Ok(guard)
}
