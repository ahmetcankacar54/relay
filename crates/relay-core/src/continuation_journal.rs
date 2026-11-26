//! Port of `electron/core/continuation-journal.ts`: the bounded private JSON file reader and
//! writer, the private journal folder, and the durable continuation journal
//! (`FileContinuationJournal`).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::continuation::{
    ContinuationError, ContinuationJournal, ContinuationJournalRecord,
    is_terminal_continuation_record,
};
use crate::fs_util::{
    FileId, create_new_private, create_private_dir_all, dirname, set_mode, sync_directory,
};

/// The default size cap of a private JSON file, 1 MiB.
pub const MAX_BYTES: u64 = 1_048_576;

#[derive(Debug, thiserror::Error)]
pub enum PrivateJsonError {
    /// Not a regular file, a symbolic link, over the cap, or replaced while it was opened.
    #[error("continuation-file-invalid")]
    Invalid,
    #[error("continuation-file-too-large")]
    TooLarge,
    #[error("continuation-directory-invalid")]
    DirectoryInvalid,
    /// The bytes are not UTF-8 (`TextDecoder`'s fatal mode).
    #[error("The encoded data was not valid for encoding utf-8")]
    Encoding,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl PrivateJsonError {
    /// The file is not there (Node's `ENOENT`).
    pub fn is_not_found(&self) -> bool {
        matches!(self, PrivateJsonError::Io(e) if e.kind() == io::ErrorKind::NotFound)
    }
}

/// Creates `directory` private (0700) and refuses one that is a symbolic link or not a folder.
/// JSON only: no credentials, native code or shell commands are persisted.
pub fn private_journal_directory(directory: &Path) -> Result<(), PrivateJsonError> {
    create_private_dir_all(directory)?;
    let info = fs::symlink_metadata(directory)?;
    if !info.is_dir() || info.is_symlink() {
        return Err(PrivateJsonError::DirectoryInvalid);
    }
    set_mode(directory, 0o700)?;
    Ok(())
}

fn open_no_follow(file: &Path) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(file)
}

/// Reads a JSON file of at most `max_bytes`, refusing a symbolic link, a non-file, a file that
/// changed between the look and the open, and bytes that are not UTF-8. A leading byte-order
/// mark is dropped, as `TextDecoder` does.
pub fn read_private_json(file: &Path, max_bytes: u64) -> Result<Value, PrivateJsonError> {
    let before = fs::symlink_metadata(file)?;
    if !before.is_file() || before.is_symlink() || before.len() > max_bytes {
        return Err(PrivateJsonError::Invalid);
    }
    let mut handle = open_no_follow(file)?;
    let info = handle.metadata()?;
    let named = fs::symlink_metadata(file)?;
    if !info.is_file()
        || named.is_symlink()
        || FileId::of_file(&handle)? != FileId::of_path(file)?
        || info.len() > max_bytes
    {
        return Err(PrivateJsonError::Invalid);
    }
    let mut data = Vec::new();
    (&mut handle).take(max_bytes + 1).read_to_end(&mut data)?;
    if data.len() as u64 > max_bytes {
        return Err(PrivateJsonError::TooLarge);
    }
    let text = std::str::from_utf8(&data).map_err(|_| PrivateJsonError::Encoding)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Ok(serde_json::from_str(text)?)
}

/// Replaces `file` with compact JSON of at most `max_bytes` through a private temporary file,
/// returning once the file and its folder entry are durable. Never writes through a symbolic
/// link.
pub fn write_private_json<T: Serialize + ?Sized>(
    file: &Path,
    value: &T,
    max_bytes: u64,
) -> Result<(), PrivateJsonError> {
    let data = serde_json::to_vec(value)?;
    if data.len() as u64 > max_bytes {
        return Err(PrivateJsonError::TooLarge);
    }
    // `existsSync` follows links: only a link that resolves is refused, as in the TS.
    if file.exists() && fs::symlink_metadata(file)?.is_symlink() {
        return Err(PrivateJsonError::Invalid);
    }
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary = PathBuf::from(temporary);
    let result = (|| -> Result<(), PrivateJsonError> {
        let mut handle = create_new_private(&temporary)?;
        io::Write::write_all(&mut handle, &data)?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&temporary, file)?;
        sync_directory(dirname(file))?;
        Ok(())
    })();
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    result
}

/// The JSON file name pattern of a request id.
fn valid_request_id(id: &str) -> bool {
    crate::continuation::is_key(id)
}

/// All journal instances in a process share one queue per folder, not a per-request lock.
fn process_lock(key: &Path) -> Arc<Mutex<()>> {
    static TAILS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut tails = TAILS.lock().unwrap_or_else(|e| e.into_inner());
    tails.entry(key.to_path_buf()).or_default().clone()
}

/// Whether `pid` is gone for sure, as Node's `process.kill(pid, 0)` failing with ESRCH says.
fn pid_gone(pid: i64) -> bool {
    #[cfg(unix)]
    {
        // A pid beyond pid_t makes Node's process.kill throw a type error, which is not ESRCH.
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return false;
        }
        io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let Ok(pid) = u32::try_from(pid) else {
            return false;
        };
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing(),
        );
        system.process(pid).is_none()
    }
}

fn io_error(error: io::Error) -> ContinuationError {
    ContinuationError(error.to_string())
}

/// The durable continuation journal: one private `<id>.journal.json` per request and a
/// host-wide `host.lock` owned by one process at a time.
pub struct FileContinuationJournal {
    directory: PathBuf,
    lock_file: PathBuf,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
}

impl FileContinuationJournal {
    /// A journal in `root` (created private) on the wall clock.
    pub fn new(root: &Path) -> Result<Self, PrivateJsonError> {
        Self::with_clock(root, || crate::clock::now_ms() as f64)
    }

    pub fn with_clock(
        root: &Path,
        now: impl Fn() -> f64 + Send + Sync + 'static,
    ) -> Result<Self, PrivateJsonError> {
        let directory = crate::fs_util::resolve(root);
        private_journal_directory(&directory)?;
        let lock_file = directory.join("host.lock");
        Ok(FileContinuationJournal {
            directory,
            lock_file,
            now: Box::new(now),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn file(&self, id: &str) -> Result<PathBuf, ContinuationError> {
        if !valid_request_id(id) {
            return Err("continuation-request-id-invalid".into());
        }
        Ok(self.directory.join(format!("{id}.journal.json")))
    }

    fn acquire(&self, token: &str) -> Result<File, ContinuationError> {
        for _ in 0..2 {
            match create_new_private(&self.lock_file) {
                Ok(mut handle) => {
                    let owner = serde_json::json!({ "pid": std::process::id(), "token": token });
                    io::Write::write_all(&mut handle, owner.to_string().as_bytes())
                        .and_then(|()| handle.sync_all())
                        .and_then(|()| sync_directory(&self.directory))
                        .map_err(io_error)?;
                    return Ok(handle);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(io_error(error)),
            }
            let stat = FileId::of_path(&self.lock_file).map_err(io_error)?;
            let owner = read_private_json(&self.lock_file, MAX_BYTES)
                .map_err(|_| ContinuationError::from("continuation-host-lock-unreadable"))?;
            let pid = owner
                .get("pid")
                .and_then(crate::fs_util::safe_integer)
                .filter(|pid| *pid > 0)
                .ok_or_else(|| ContinuationError::from("continuation-host-lock-unreadable"))?;
            if !pid_gone(pid) {
                return Err("continuation-host-locked".into());
            }
            let current = fs::symlink_metadata(&self.lock_file).map_err(io_error)?;
            if current.is_symlink() || FileId::of_path(&self.lock_file).map_err(io_error)? != stat {
                return Err("continuation-host-lock-changed".into());
            }
            fs::remove_file(&self.lock_file).map_err(io_error)?;
            sync_directory(&self.directory).map_err(io_error)?;
        }
        Err("continuation-host-locked".into())
    }

    /// Removes the lock file only while it is still the one this owner created.
    fn release(&self, owner: FileId) -> io::Result<()> {
        if !self.lock_file.exists() {
            return Ok(());
        }
        let named = fs::symlink_metadata(&self.lock_file)?;
        if !named.is_symlink() && FileId::of_path(&self.lock_file)? == owner {
            fs::remove_file(&self.lock_file)?;
            sync_directory(&self.directory)?;
        }
        Ok(())
    }
}

impl ContinuationJournal for FileContinuationJournal {
    fn with_lock<T>(
        &self,
        _request_id: &str,
        action: impl FnOnce() -> Result<T, ContinuationError>,
    ) -> Result<T, ContinuationError> {
        let queue = process_lock(&self.directory);
        let _queued = queue.lock().unwrap_or_else(|e| e.into_inner());
        let token = uuid::Uuid::new_v4().to_string();
        let handle = self.acquire(&token)?;
        let owner = FileId::of_file(&handle).map_err(io_error)?;
        let outcome = action();
        drop(handle);
        // Never remove a lock file someone replaced during an action.
        self.release(owner).map_err(io_error)?;
        outcome
    }

    fn read(&self, request_id: &str) -> Result<Option<Value>, ContinuationError> {
        let file = self.file(request_id)?;
        match read_private_json(&file, MAX_BYTES) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.is_not_found() => Ok(None),
            Err(_) => Err("continuation-journal-unreadable".into()),
        }
    }

    fn list_pending(&self) -> Result<Vec<Value>, ContinuationError> {
        let mut names: Vec<String> = fs::read_dir(&self.directory)
            .map_err(io_error)?
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<_>>()
            .map_err(io_error)?;
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let now = (self.now)();
        let mut pending = Vec::new();
        for name in names {
            if !name.ends_with(".journal.json") {
                continue;
            }
            match read_private_json(&self.directory.join(&name), MAX_BYTES) {
                Ok(value) => {
                    if !is_terminal_continuation_record(&value, Some(now)) {
                        pending.push(value);
                    }
                }
                // The engine treats this invalid sentinel as a host-wide barrier. A
                // damaged entry is never discarded merely because it cannot be parsed.
                Err(_) => pending.push(serde_json::json!({ "id": format!("unreadable:{name}") })),
            }
        }
        Ok(pending)
    }

    fn write(&self, record: &ContinuationJournalRecord) -> Result<(), ContinuationError> {
        write_private_json(&self.file(&record.id)?, record, MAX_BYTES)
            .map_err(|error| ContinuationError(error.to_string()))
    }
}
