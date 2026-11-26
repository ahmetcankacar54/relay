//! Port of `electron/core/draft-vault.ts`: the drafts captured at switches, sealed in the vault.

use std::collections::HashSet;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::desktop_files::{DesktopFileError, read_bytes, write_bytes};
use crate::drafts::CapturedDraft;
use crate::fs_util::{iso_timestamp, parse_iso_ms};
use crate::shared::types::literal_enum;

/// Seals vault text (`DesktopHost.seal`): the vault's v2 format in the app. The error is the
/// sealer's message (no system encryption, say).
pub type Seal = Arc<dyn Fn(&str) -> Result<Vec<u8>, String> + Send + Sync>;
/// Opens what `Seal` sealed; the error is the unsealer's message.
pub type Unseal = Arc<dyn Fn(&[u8]) -> Result<String, String> + Send + Sync>;
/// The wall clock in epoch ms (`Date.now`).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// `Date.now` through relay-core's one clock.
pub fn system_clock() -> Clock {
    Arc::new(crate::clock::now_ms)
}

/// A sealed vault file (drafts, extension sign-ins, claude.ai logins) could not be used.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    /// A refusal of this code, with its message ("Invalid account uuid.", ...).
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Files(#[from] DesktopFileError),
    /// The sealer's message.
    #[error("{0}")]
    Seal(String),
    /// The unsealer's message.
    #[error("{0}")]
    Unseal(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

literal_enum!(
    /// `pending` waits to be re-typed; `needs-copy` could not be and waits for the user.
    DraftState { Pending = "pending", NeedsCopy = "needs-copy" }
);

/// What the panel may know of a rescued draft: never its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub to: String,
    pub title: String,
    pub new_session: bool,
    pub attachments: bool,
    pub state: DraftState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub captured_at: String,
}

/// One captured draft, kept until it is re-typed or dismissed. Holds the text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecord {
    pub id: String,
    /// The account the draft is re-typed for.
    pub to: String,
    /// The alias of the session; absent for the new-session draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_alias: Option<String>,
    /// Set (always `true`) on the new-session draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_session: Option<bool>,
    pub title: String,
    pub text: String,
    pub attachments: bool,
    pub captured_at: String,
    pub state: DraftState,
    /// Why a `needs-copy` record could not be re-typed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The slots a capture read for an account: its carried conversations, by alias, and the
/// new-session screen. A pending record in one of them that the capture did not fill is stale:
/// the account no longer has that draft, so it must not be re-typed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSlots {
    pub aliases: Vec<String>,
    pub new_session: bool,
}

literal_enum!(
    /// Where a read of the vault went wrong: its file, its seal, or its JSON.
    DraftReadStage { Read = "read", Unseal = "unseal", Parse = "parse" }
);

/// A change to a record: `reason: Some(None)` removes the reason, `None` keeps it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DraftPatch {
    pub state: Option<DraftState>,
    pub reason: Option<Option<String>>,
}

type Hook<T> = Option<Box<dyn Fn(T) + Send + Sync>>;
type ReadErrorHook = Option<Box<dyn Fn(DraftReadStage, &str) + Send + Sync>>;

/// Diagnosis hooks. Each is told only what it may log: a stage, a fixed label and indexes, never
/// a record's text or a message that could echo it. None may disturb the vault: a hook that
/// panics is caught.
#[derive(Default)]
pub struct DraftVaultHooks {
    /// The file could not be read, unsealed or parsed, or does not hold a list. Told once per
    /// change: the same failure on the next read is not told again, and a read that works starts
    /// it over.
    pub on_read_error: ReadErrorHook,
    /// The entry at `index` of the list is not a record the vault wrote. Told once per change.
    pub on_record_rejected: Hook<usize>,
    /// `list()` answered with `count` records, when that differs from its last answer.
    pub on_list: Hook<usize>,
}

/// Node's errno name for an I/O error, when it has one.
fn errno_name(error: &io::Error) -> Option<String> {
    #[cfg(unix)]
    if let Some(code) = error.raw_os_error() {
        let name = match code {
            libc::ENOENT => "ENOENT",
            libc::EACCES => "EACCES",
            libc::EPERM => "EPERM",
            libc::EIO => "EIO",
            libc::EISDIR => "EISDIR",
            libc::ENOTDIR => "ENOTDIR",
            libc::ELOOP => "ELOOP",
            libc::EMFILE => "EMFILE",
            libc::ENFILE => "ENFILE",
            libc::EBUSY => "EBUSY",
            libc::EAGAIN => "EAGAIN",
            libc::EINVAL => "EINVAL",
            libc::ENOSPC => "ENOSPC",
            libc::EROFS => "EROFS",
            libc::ENAMETOOLONG => "ENAMETOOLONG",
            libc::ENXIO => "ENXIO",
            _ => return None,
        };
        return Some(name.to_owned());
    }
    match error.kind() {
        io::ErrorKind::NotFound => Some("ENOENT".to_owned()),
        io::ErrorKind::PermissionDenied => Some("EPERM".to_owned()),
        _ => None,
    }
}

/// A fixed label for a failed read, never the error's own message: an errno code, or a fixed
/// word for a refusal of this code.
fn read_label(error: &DesktopFileError) -> String {
    match error {
        DesktopFileError::Io(e) => errno_name(e).unwrap_or_else(|| "read-failed".to_owned()),
        DesktopFileError::SymbolicLink | DesktopFileError::InvalidPath => "unsafe-path".to_owned(),
        DesktopFileError::UnsupportedFile => "unsupported-file".to_owned(),
        _ => "read-failed".to_owned(),
    }
}

/// A fixed label for a failed unseal: a message from unsealing may carry a piece of the data.
fn unseal_label(message: &str) -> &'static str {
    if message.to_lowercase().contains("encryption is unavailable") {
        "encryption-unavailable"
    } else {
        "unseal-failed"
    }
}

/// Inside the vault. Sealed, so the text is never on disk as it is.
const FILE: &str = "drafts/pending.bin";
const MAX_RECORDS: usize = 20;
const MAX_AGE_MS: i64 = 7 * 24 * 60 * 60_000;

/// One slot per account and conversation, and one per account for the new-session draft.
fn slot(to: &str, target_alias: Option<&str>) -> String {
    serde_json::to_string(&(to.to_lowercase(), target_alias)).expect("strings serialize")
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|s| !s.is_empty())
}

/// A clean copy of `value` when it is a record the vault wrote, else None.
fn parse_record(value: &Value) -> Option<DraftRecord> {
    let raw = value.as_object()?;
    let id = non_empty_string(raw.get("id"))?;
    let to = non_empty_string(raw.get("to"))?;
    let captured_at = raw.get("capturedAt")?.as_str()?;
    parse_iso_ms(captured_at)?;
    let state = match raw.get("state")?.as_str()? {
        "pending" => DraftState::Pending,
        "needs-copy" => DraftState::NeedsCopy,
        _ => return None,
    };
    let reason = match raw.get("reason") {
        None => None,
        Some(Value::String(reason)) => Some(reason.clone()),
        Some(_) => return None,
    };
    let title = raw.get("title")?.as_str()?;
    let text = raw.get("text")?.as_str()?;
    let attachments = raw.get("attachments")?.as_bool()?;
    // A conversation's draft has an alias; the new-session draft has none.
    let (target_alias, new_session) = match (raw.get("newSession"), raw.get("targetAlias")) {
        (Some(Value::Bool(true)), None) => (None, Some(true)),
        (None, Some(Value::String(alias))) if !alias.is_empty() => (Some(alias.clone()), None),
        _ => return None,
    };
    Some(DraftRecord {
        id: id.to_owned(),
        to: to.to_owned(),
        target_alias,
        new_session,
        title: title.to_owned(),
        text: text.to_owned(),
        attachments,
        captured_at: captured_at.to_owned(),
        state,
        reason,
    })
}

/// What the diagnosis hooks were last told, so an unchanged state is told once.
#[derive(Default)]
struct Told {
    read: Option<String>,
    rejected: Option<String>,
    count: Option<usize>,
}

struct Loaded {
    records: Vec<DraftRecord>,
    expired: bool,
}

/// Runs a diagnosis hook; one that panics changes nothing about the vault.
fn tell(f: impl FnOnce()) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

/// The drafts captured at switches, sealed with `seal` in `<vault>/drafts/pending.bin`.
///
/// It keeps at most 20 records, newest first, and only the newest per account and conversation.
/// Records older than seven days are dropped when read. A file that cannot be unsealed or parsed
/// reads as empty. A file that cannot be read at all fails every change, so a change never
/// overwrites records it could not see. Changes run one at a time, so none is lost to another.
pub struct DraftVault {
    vault: PathBuf,
    seal: Seal,
    unseal: Unseal,
    now: Clock,
    hooks: DraftVaultHooks,
    /// Held for each operation: the serial queue of the TS, and what the hooks were told.
    told: Mutex<Told>,
}

impl DraftVault {
    pub fn new(
        vault: impl Into<PathBuf>,
        seal: Seal,
        unseal: Unseal,
        now: Option<Clock>,
        hooks: DraftVaultHooks,
    ) -> DraftVault {
        DraftVault {
            vault: vault.into(),
            seal,
            unseal,
            now: now.unwrap_or_else(system_clock),
            hooks,
            told: Mutex::new(Told::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Told> {
        self.told.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read_failed(&self, told: &mut Told, stage: DraftReadStage, message: &str) {
        let signature = format!("{}:{message}", stage.as_str());
        if told.read.as_deref() == Some(signature.as_str()) {
            return;
        }
        told.read = Some(signature);
        if let Some(hook) = &self.hooks.on_read_error {
            tell(|| hook(stage, message));
        }
    }

    fn counted(&self, told: &mut Told, count: usize) {
        if told.count == Some(count) {
            return;
        }
        told.count = Some(count);
        if let Some(hook) = &self.hooks.on_list {
            tell(|| hook(count));
        }
    }

    fn rejected(&self, told: &mut Told, indexes: &[usize]) {
        let signature = indexes
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(",");
        if told.rejected.as_deref().unwrap_or_default() == signature {
            return;
        }
        told.rejected = Some(signature);
        if let Some(hook) = &self.hooks.on_record_rejected {
            for &index in indexes {
                tell(|| hook(index));
            }
        }
    }

    /// Every record, newest first, with its text. Never fails: when the file cannot be read it
    /// answers with none, and leaves the file as it is.
    pub fn list(&self) -> Vec<DraftRecord> {
        let mut told = self.lock();
        let Ok(loaded) = self.load(&mut told) else {
            self.counted(&mut told, 0);
            return Vec::new();
        };
        // The text of an expired record does not stay on disk either.
        if loaded.expired {
            let _ = self.save(&loaded.records);
        }
        self.counted(&mut told, loaded.records.len());
        loaded.records
    }

    /// Keeps `drafts` for account `to`, each replacing an older one in its slot, whatever its
    /// state. With `slots`, the slots the capture read, a pending record of `to` in one of them
    /// that `drafts` does not fill is dropped too: the newest capture wins, even an empty one.
    pub fn add(
        &self,
        to: &str,
        drafts: &[CapturedDraft],
        slots: Option<&DraftSlots>,
    ) -> Result<(), VaultError> {
        let mut told = self.lock();
        let captured_at = iso_timestamp((self.now)());
        let mut filled: HashSet<String> = HashSet::new();
        let mut fresh: Vec<DraftRecord> = Vec::new();
        for draft in drafts {
            let new_session = draft.new_session == Some(true);
            let alias = draft.target_alias.as_deref().filter(|a| !a.is_empty());
            // Neither a conversation's nor the new-session draft: there is nowhere to re-type it.
            if !new_session && alias.is_none() {
                continue;
            }
            let key = slot(to, if new_session { None } else { alias });
            if !filled.insert(key) {
                continue;
            }
            fresh.push(DraftRecord {
                id: uuid::Uuid::new_v4().to_string(),
                to: to.to_owned(),
                target_alias: if new_session {
                    None
                } else {
                    alias.map(str::to_owned)
                },
                new_session: new_session.then_some(true),
                title: draft.title.clone(),
                text: draft.text.clone(),
                attachments: draft.attachments,
                captured_at: captured_at.clone(),
                state: DraftState::Pending,
                reason: None,
            });
        }
        let mut read: HashSet<String> = HashSet::new();
        if let Some(slots) = slots {
            read.extend(slots.aliases.iter().map(|alias| slot(to, Some(alias))));
            if slots.new_session {
                read.insert(slot(to, None));
            }
        }
        if fresh.is_empty() && read.is_empty() {
            return Ok(());
        }
        let Loaded { records, .. } = self.load(&mut told)?;
        let total = records.len();
        let kept: Vec<DraftRecord> = records
            .into_iter()
            .filter(|record| {
                let key = slot(&record.to, record.target_alias.as_deref());
                // A record waiting to be copied by hand is never re-typed, so it is not stale.
                !filled.contains(&key)
                    && !(record.state == DraftState::Pending && read.contains(&key))
            })
            .collect();
        if fresh.is_empty() && kept.len() == total {
            return Ok(());
        }
        let mut next = fresh;
        next.extend(kept);
        next.truncate(MAX_RECORDS);
        self.save(&next)
    }

    /// Changes a record's state or reason.
    pub fn update(&self, id: &str, patch: DraftPatch) -> Result<(), VaultError> {
        let mut told = self.lock();
        let Loaded { mut records, .. } = self.load(&mut told)?;
        let Some(record) = records.iter_mut().find(|record| record.id == id) else {
            return Ok(());
        };
        if let Some(state) = patch.state {
            record.state = state;
        }
        if let Some(reason) = patch.reason {
            record.reason = reason;
        }
        self.save(&records)
    }

    pub fn remove(&self, id: &str) -> Result<(), VaultError> {
        let mut told = self.lock();
        let Loaded { records, .. } = self.load(&mut told)?;
        let total = records.len();
        let left: Vec<DraftRecord> = records.into_iter().filter(|r| r.id != id).collect();
        if left.len() != total {
            self.save(&left)?;
        }
        Ok(())
    }

    /// The valid, unexpired records on disk, newest first; `expired` when any were dropped. A
    /// missing file, or one that cannot be unsealed or parsed, holds none. Fails when the file
    /// cannot be read at all: what it holds is then unknown, and must not be written over.
    fn load(&self, told: &mut Told) -> Result<Loaded, VaultError> {
        let empty = || Loaded {
            records: Vec::new(),
            expired: false,
        };
        // Fails on any failure but a missing file, a link included.
        let data = match read_bytes(&self.vault, FILE) {
            Ok(data) => data,
            Err(error) => {
                self.read_failed(told, DraftReadStage::Read, &read_label(&error));
                return Err(error.into());
            }
        };
        let Some(data) = data else {
            told.read = None;
            return Ok(empty());
        };
        let text = match (self.unseal)(&data) {
            Ok(text) => text,
            Err(message) => {
                self.read_failed(told, DraftReadStage::Unseal, unseal_label(&message));
                return Ok(empty());
            }
        };
        let raw = match serde_json::from_str::<Value>(&text) {
            Ok(raw) => raw,
            Err(_) => {
                self.read_failed(told, DraftReadStage::Parse, "invalid-json");
                return Ok(empty());
            }
        };
        let Value::Array(raw) = raw else {
            self.read_failed(told, DraftReadStage::Parse, "not-an-array");
            return Ok(empty());
        };
        told.read = None;
        let now = (self.now)();
        let mut expired = false;
        let mut records: Vec<DraftRecord> = Vec::new();
        let mut rejected: Vec<usize> = Vec::new();
        for (index, value) in raw.iter().enumerate() {
            match parse_record(value) {
                None => rejected.push(index),
                Some(record) => {
                    let at = parse_iso_ms(&record.captured_at).expect("checked in parse_record");
                    if now - at > MAX_AGE_MS {
                        expired = true;
                    } else {
                        records.push(record);
                    }
                }
            }
        }
        self.rejected(told, &rejected);
        records.sort_by_key(|r| std::cmp::Reverse(parse_iso_ms(&r.captured_at).unwrap_or(0)));
        records.truncate(MAX_RECORDS);
        Ok(Loaded { records, expired })
    }

    fn save(&self, records: &[DraftRecord]) -> Result<(), VaultError> {
        if records.is_empty() {
            return Ok(write_bytes(&self.vault, FILE, None)?);
        }
        let text = serde_json::to_string(records).expect("records serialize");
        let sealed = (self.seal)(&text).map_err(VaultError::Seal)?;
        write_bytes(&self.vault, FILE, Some(&sealed))?;
        Ok(())
    }
}

pub fn summarize(record: &DraftRecord) -> DraftSummary {
    DraftSummary {
        id: record.id.clone(),
        to: record.to.clone(),
        title: record.title.clone(),
        new_session: record.new_session == Some(true),
        attachments: record.attachments,
        state: record.state,
        reason: record.reason.clone(),
        captured_at: record.captured_at.clone(),
    }
}
