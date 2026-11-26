//! Port of `electron/core/sessions.ts`: the Claude Code transcripts in a profile, their preview,
//! and the copy of one transcript into another profile.

use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write};
use std::ops::Deref;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::desktop_files::js_truthy;
use crate::fs_util::{FileId, create_new_private, create_private_dir, iso_timestamp, mtime_ms};
use crate::shared::types::js::{JsMap, trim};
use crate::shared::types::{Session, TranscriptMessage, TranscriptRole};
use crate::usage::js_slice;

pub static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("valid pattern")
});
const MAX_TRANSCRIPT: u64 = 128 * 1024 * 1024;
/// In UTF-16 units, as `line.length` counts.
const MAX_LINE: usize = 2 * 1024 * 1024;
const CACHE_LIMIT: usize = 10_000;

/// A session and where its transcript lives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedSession {
    #[serde(flatten)]
    pub session: Session,
    pub file: PathBuf,
    pub root: PathBuf,
    pub project_folder: String,
}

impl Deref for IndexedSession {
    type Target = Session;
    fn deref(&self) -> &Session {
        &self.session
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("The session path is outside the profile folder.")]
    OutsideProfile,
    #[error("Symbolic links are not supported in sessions.")]
    SymbolicLink,
    #[error("The session exceeds the preview limit.")]
    PreviewLimit,
    #[error("This session exceeds the transfer limit.")]
    TransferLimit,
    #[error("The session is still being written. Close the running session first.")]
    StillWriting,
    #[error(
        "The session has a missing or damaged record. Close the source terminal and try again."
    )]
    DamagedRecord,
    #[error("The session record format is not supported.")]
    UnsupportedRecord,
    #[error("The file holds a different session ID. The transfer stopped.")]
    DifferentSessionId,
    #[error("An empty session cannot be transferred.")]
    EmptySession,
    #[error("The target session folder is invalid.")]
    InvalidTarget,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// What `scan_sessions` found.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScanResult {
    pub sessions: Vec<IndexedSession>,
    pub warnings: Vec<String>,
}

struct Cached {
    signature: String,
    session: IndexedSession,
}

/// Parsed metadata by transcript file, oldest first.
static METADATA_CACHE: LazyLock<Mutex<IndexMap<PathBuf, Cached>>> =
    LazyLock::new(|| Mutex::new(IndexMap::new()));

/// Calls `each` with every JSON object (or array) line of `file`. Lines over `MAX_LINE` and
/// unparsable lines are skipped: a CLI may be writing the last record.
fn rows(file: &Path, mut each: impl FnMut(&Value)) -> io::Result<()> {
    // Past 3 bytes per UTF-16 unit a line is surely too long: stop keeping it.
    const MAX_LINE_BYTES: usize = 3 * MAX_LINE;
    let emit = |line: &[u8], each: &mut dyn FnMut(&Value)| {
        if line.len() > MAX_LINE_BYTES {
            return;
        }
        let text = String::from_utf8_lossy(line);
        if line.len() > MAX_LINE && text.encode_utf16().count() > MAX_LINE {
            return;
        }
        if let Ok(value @ (Value::Object(_) | Value::Array(_))) =
            serde_json::from_str::<Value>(&text)
        {
            each(&value);
        }
    };
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(file)?);
    let mut line = Vec::new();
    let mut skipping = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            break;
        }
        match memchr::memchr(b'\n', buffer) {
            Some(end) => {
                if !skipping {
                    line.extend_from_slice(&buffer[..end]);
                    emit(&line, &mut each);
                }
                line.clear();
                skipping = false;
                reader.consume(end + 1);
            }
            None => {
                let read = buffer.len();
                if !skipping {
                    line.extend_from_slice(buffer);
                    if line.len() > MAX_LINE_BYTES {
                        line.clear();
                        skipping = true;
                    }
                }
                reader.consume(read);
            }
        }
    }
    if !line.is_empty() && !skipping {
        emit(&line, &mut each);
    }
    Ok(())
}

fn message_text(row: &Value) -> String {
    match row.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `path.isAbsolute` on this host.
fn is_absolute(text: &str) -> bool {
    if cfg!(windows) {
        let bytes = text.as_bytes();
        matches!(bytes.first(), Some(b'/' | b'\\'))
            || (bytes.len() > 2
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'/' | b'\\'))
    } else {
        text.starts_with('/')
    }
}

/// `path.basename`: the last part, trailing separators ignored.
fn basename(text: &str) -> &str {
    let separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let trimmed = text.trim_end_matches(separator);
    trimmed.rsplit(separator).next().unwrap_or("")
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `text.replace(/\s+/g, " ")`.
fn collapse_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

fn same_component(a: &Component, b: &Component) -> bool {
    if cfg!(windows) {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Node's `path.relative(from, to)`: `to` absolute when they share no root.
fn relative(from: &Path, to: &Path) -> PathBuf {
    let from = crate::fs_util::resolve(from);
    let to = crate::fs_util::resolve(to);
    let f: Vec<Component> = from.components().collect();
    let t: Vec<Component> = to.components().collect();
    let common = f
        .iter()
        .zip(&t)
        .take_while(|(a, b)| same_component(a, b))
        .count();
    if common == 0 {
        return to;
    }
    let mut out = PathBuf::new();
    for _ in common..f.len() {
        out.push("..");
    }
    for part in &t[common..] {
        out.push(part.as_os_str());
    }
    out
}

/// Fails unless `file` resolves inside `root` and no part of it below `root` is a link.
pub fn assert_contained(root: &Path, file: &Path) -> Result<(), SessionError> {
    let real_root = crate::fs_util::real_path(root)?;
    let real_file = crate::fs_util::real_path(file)?;
    let inside = relative(&real_root, &real_file);
    if inside.as_os_str().is_empty()
        || inside.is_absolute()
        || inside.has_root()
        || matches!(inside.components().next(), Some(Component::ParentDir))
    {
        return Err(SessionError::OutsideProfile);
    }
    // Reject symlinks, including ancestors, even when they resolve inside the root.
    let mut cursor = root.to_path_buf();
    for part in relative(root, file).components() {
        cursor.push(part.as_os_str());
        if fs::symlink_metadata(&cursor)?.file_type().is_symlink() {
            return Err(SessionError::SymbolicLink);
        }
    }
    Ok(())
}

/// The sessions in a profile's `projects` folder, newest metadata cached by file stamp.
pub fn scan_sessions(
    root: &Path,
    account_id: &str,
    pinned: &[String],
    lineage: &JsMap<String>,
) -> ScanResult {
    let mut sessions = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let projects = root.join("projects");
    let dirs = assert_contained(root, &projects).and_then(|()| Ok(fs::read_dir(&projects)?));
    let dirs = match dirs {
        Ok(dirs) => dirs,
        Err(SessionError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {
            return ScanResult { sessions, warnings };
        }
        Err(_) => {
            warnings.push("A profile's session folder could not be read or holds a link.".into());
            return ScanResult { sessions, warnings };
        }
    };
    for dir in dirs.flatten() {
        if !dir.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Some(folder) = dir.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let project = projects.join(&folder);
        let Ok(files) = fs::read_dir(&project) else {
            warnings.push("A project folder could not be read.".into());
            continue;
        };
        for entry in files.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(id) = name.strip_suffix(".jsonl") else {
                continue;
            };
            if !entry.file_type().is_ok_and(|t| t.is_file()) || !UUID.is_match(id) {
                continue;
            }
            let file = project.join(&name);
            match index_file(root, account_id, pinned, lineage, &folder, id, &file) {
                Ok(Indexed::Session(session)) => sessions.push(*session),
                Ok(Indexed::Skipped) => {}
                Ok(Indexed::TooLarge) => {
                    warnings.push("A session over 128 MB was not scanned.".into());
                }
                Err(_) => warnings
                    .push("A session file could not be read; the source file was kept.".into()),
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    warnings.retain(|w| seen.insert(w.clone()));
    ScanResult { sessions, warnings }
}

enum Indexed {
    Session(Box<IndexedSession>),
    Skipped,
    TooLarge,
}

fn index_file(
    root: &Path,
    account_id: &str,
    pinned: &[String],
    lineage: &JsMap<String>,
    folder: &str,
    id: &str,
    file: &Path,
) -> Result<Indexed, SessionError> {
    assert_contained(root, file)?;
    let stat = fs::metadata(file)?;
    if stat.len() > MAX_TRANSCRIPT {
        return Ok(Indexed::TooLarge);
    }
    let key = format!("{account_id}:{id}");
    let mtime = mtime_ms(&stat)?;
    let signature = format!("{}:{}:{mtime}", FileId::of_path(file)?.ino, stat.len());
    let is_pinned = pinned.contains(&key);
    let forked_from = lineage.get(&key).cloned();
    {
        let cache = METADATA_CACHE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = cache.get(file).filter(|c| c.signature == signature) {
            let mut session = cached.session.clone();
            session.session.pinned = is_pinned;
            session.session.forked_from = forked_from;
            return Ok(Indexed::Session(Box::new(session)));
        }
    }
    let mut cwd = String::new();
    let mut title = String::new();
    let mut first_prompt = String::new();
    let mut summary = String::new();
    let mut messages = 0u64;
    rows(file, |row| {
        if let Some(text) = row.get("cwd").and_then(Value::as_str)
            && is_absolute(text)
        {
            cwd = text.to_owned();
        }
        if let Some(text) = row.get("customTitle").and_then(Value::as_str) {
            title = text.to_owned();
        }
        if let Some(text) = row.get("summary").and_then(Value::as_str) {
            summary = text.to_owned();
        }
        let kind = row.get("type").and_then(Value::as_str);
        if matches!(kind, Some("user" | "assistant"))
            && !truthy(row, "isMeta")
            && !truthy(row, "isSidechain")
        {
            let text = message_text(row);
            if !text.is_empty() {
                messages += 1;
            }
            if kind == Some("user")
                && first_prompt.is_empty()
                && !text.is_empty()
                && !text.starts_with('<')
            {
                first_prompt = text;
            }
        }
    })?;
    if cwd.is_empty() {
        return Ok(Indexed::Skipped);
    }
    let chosen = [&title, &summary, &first_prompt]
        .into_iter()
        .find(|t| !t.is_empty())
        .map_or("Untitled session", |t| t.as_str());
    let project_name = match basename(&cwd) {
        "" => cwd.clone(),
        name => name.to_owned(),
    };
    let session = IndexedSession {
        session: Session {
            key,
            id: id.to_owned(),
            account_id: account_id.to_owned(),
            project_dir: cwd.clone(),
            project_name,
            title: js_slice(&collapse_space(chosen), 180),
            updated_at: iso_timestamp(mtime as i64),
            messages: messages as f64,
            bytes: stat.len() as f64,
            pinned: is_pinned,
            forked_from,
        },
        file: file.to_path_buf(),
        root: root.to_path_buf(),
        project_folder: folder.to_owned(),
    };
    let mut cache = METADATA_CACHE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if cache.len() >= CACHE_LIMIT {
        cache.shift_remove_index(0);
    }
    cache.insert(
        file.to_path_buf(),
        Cached {
            signature,
            session: session.clone(),
        },
    );
    Ok(Indexed::Session(Box::new(session)))
}

fn truthy(row: &Value, key: &str) -> bool {
    row.get(key).is_some_and(js_truthy)
}

/// The last 60 messages of a session, each cut to 12 000 characters.
pub fn read_transcript(session: &IndexedSession) -> Result<Vec<TranscriptMessage>, SessionError> {
    assert_contained(&session.root, &session.file)?;
    if fs::metadata(&session.file)?.len() > MAX_TRANSCRIPT {
        return Err(SessionError::PreviewLimit);
    }
    let mut messages = std::collections::VecDeque::new();
    rows(&session.file, |row| {
        let role = match row.get("type").and_then(Value::as_str) {
            Some("user") => TranscriptRole::User,
            Some("assistant") => TranscriptRole::Assistant,
            _ => return,
        };
        if truthy(row, "isMeta") || truthy(row, "isSidechain") {
            return;
        }
        let text = message_text(row);
        if !text.is_empty() {
            messages.push_back(TranscriptMessage {
                role,
                text: js_slice(&text, 12_000),
            });
            if messages.len() > 60 {
                messages.pop_front();
            }
        }
    })?;
    Ok(messages.into())
}

/// A parsed value as `JSON.stringify` writes it back: whole floats without `.0`, and
/// array-index keys first, ascending, as a plain object lists them.
fn js_json(value: &Value) -> Value {
    match value {
        Value::Number(number) if !number.is_i64() && !number.is_u64() => match number.as_f64() {
            Some(v) if v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 => {
                Value::from(v as i64)
            }
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(js_json).collect()),
        Value::Object(map) => {
            let index = |key: &str| -> Option<u32> {
                let digits = !key.is_empty()
                    && !(key.len() > 1 && key.starts_with('0'))
                    && key.bytes().all(|b| b.is_ascii_digit());
                digits
                    .then(|| key.parse::<u32>().ok())
                    .flatten()
                    .filter(|n| *n != u32::MAX)
            };
            let mut indexed: Vec<(u32, &String, &Value)> = map
                .iter()
                .filter_map(|(key, value)| index(key).map(|i| (i, key, value)))
                .collect();
            indexed.sort_by_key(|(i, _, _)| *i);
            let mut out = Map::new();
            for (_, key, value) in indexed {
                out.insert(key.clone(), js_json(value));
            }
            for (key, value) in map.iter().filter(|(key, _)| index(key).is_none()) {
                out.insert(key.clone(), js_json(value));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Copies one transcript into `target_root` under a fresh session id and returns that id.
///
/// Only the selected transcript is transferred. Credentials, hooks, settings and MCP state never
/// are. Source is always preserved. Existing target history is never overwritten.
pub fn copy_transcript(
    session: &IndexedSession,
    target_root: &Path,
) -> Result<String, SessionError> {
    assert_contained(&session.root, &session.file)?;
    let before = fs::metadata(&session.file)?;
    if before.len() > MAX_TRANSCRIPT {
        return Err(SessionError::TransferLimit);
    }
    let bytes = fs::read(&session.file)?;
    let after = fs::metadata(&session.file)?;
    if before.len() != after.len() || mtime_ms(&before)? != mtime_ms(&after)? {
        return Err(SessionError::StillWriting);
    }
    // Every handoff gets a fresh ID. This permits A → B → A without overwriting an older branch.
    let new_id = uuid::Uuid::new_v4().to_string();
    let mut cloned: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&bytes).split('\n') {
        if trim(line).is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return Err(SessionError::DamagedRecord);
        };
        let Value::Object(mut record) = record else {
            return Err(SessionError::UnsupportedRecord);
        };
        match record.get("sessionId") {
            None => {}
            Some(Value::String(id)) if *id == session.id => {
                record.insert("sessionId".into(), Value::String(new_id.clone()));
            }
            Some(_) => return Err(SessionError::DifferentSessionId),
        }
        cloned.push(
            serde_json::to_string(&js_json(&Value::Object(record))).map_err(io::Error::other)?,
        );
    }
    if cloned.is_empty() {
        return Err(SessionError::EmptySession);
    }
    let target_dir = target_root.join("projects").join(&session.project_folder);
    // Validate each ancestor before creating or writing beneath it.
    let mut cursor = target_root.to_path_buf();
    for part in ["projects", session.project_folder.as_str()] {
        cursor.push(part);
        match fs::symlink_metadata(&cursor) {
            Ok(stat) => {
                if !stat.is_dir() || stat.file_type().is_symlink() {
                    return Err(SessionError::InvalidTarget);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => create_private_dir(&cursor)?,
            Err(e) => return Err(e.into()),
        }
    }
    assert_contained(target_root, &target_dir)?;
    let target = target_dir.join(format!("{new_id}.jsonl"));
    let mut temp = target.clone().into_os_string();
    temp.push(format!(".{}.tmp", std::process::id()));
    let temp = PathBuf::from(temp);
    let result = (|| -> io::Result<()> {
        let mut handle = create_new_private(&temp)?;
        handle.write_all(format!("{}\n", cloned.join("\n")).as_bytes())?;
        handle.sync_all()?;
        drop(handle);
        // link is an atomic no-clobber publish on NTFS and POSIX.
        fs::hard_link(&temp, &target)
    })();
    let _ = fs::remove_file(&temp);
    result?;
    Ok(new_id)
}
