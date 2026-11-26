//! Port of `electron/core/transcript-scan.ts`: incremental reads of Claude Code transcripts for
//! quota-stop polling.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::desktop_continuation_host::{DesktopAutomationIssue, DesktopHostError};
use crate::desktop_files::js_truthy;
use crate::fs_util::{FileId, mtime_ms, resolve};
use crate::shared::types::literal_enum;

/// One transcript row: a JSON object, keys in file order.
pub type Row = Map<String, Value>;

literal_enum!(
    /// What a main-chain user row is, as the start of the assistant turn after it.
    TurnTrigger {
        Prompt = "prompt",
        TaskNotification = "task-notification",
        Tool = "tool",
    }
);

/// What quota-stop polling needs from a transcript, without keeping its rows.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptSummary {
    /// Size of the complete transcript.
    pub bytes: u64,
    pub sha256: String,
    /// Every working directory a row was written from, resolved.
    pub cwds: BTreeSet<PathBuf>,
    /// The latest main-chain user or assistant row.
    pub last: Option<Row>,
    /// When `last` is a task notification, the latest other main-chain row before it.
    pub before_notifications: Option<Row>,
    /// What started the turn of the latest main-chain assistant row: the user row right before
    /// it was a person's prompt, a background task's notification, or a tool's result.
    pub trigger: Option<TurnTrigger>,
}

fn row_str<'a>(row: &'a Row, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `row[key]` is truthy, as JavaScript reads it.
pub(crate) fn truthy(row: &Row, key: &str) -> bool {
    row.get(key).is_some_and(js_truthy)
}

/// `row.message?.content`.
pub(crate) fn message_content(row: &Row) -> Option<&Value> {
    row.get("message")
        .and_then(|message| message.get("content"))
}

/// The kind of a main-chain user row: a task notification, a tool result, or a prompt.
pub fn turn_trigger(row: &Row) -> TurnTrigger {
    if is_task_notification(row) {
        return TurnTrigger::TaskNotification;
    }
    let tool = message_content(row)
        .and_then(Value::as_array)
        .is_some_and(|content| {
            content
                .iter()
                .any(|c| c.get("type").and_then(Value::as_str) == Some("tool_result"))
        });
    if tool {
        TurnTrigger::Tool
    } else {
        TurnTrigger::Prompt
    }
}

/// A prompt Claude Code wrote itself when a background task finished, not one a person sent.
/// Older transcripts lack `origin`; their text still says so.
pub fn is_task_notification(row: &Row) -> bool {
    if row_str(row, "type") != Some("user") {
        return false;
    }
    if let Some(origin) = row.get("origin") {
        return origin.get("kind").and_then(Value::as_str) == Some("task-notification");
    }
    message_content(row)
        .and_then(Value::as_str)
        .is_some_and(|content| content.starts_with("<task-notification>"))
}

struct Scan {
    id: FileId,
    size: Option<u64>,
    mtime_ms: Option<f64>,
    /// Bytes consumed so far, always just after a newline.
    offset: u64,
    /// The bytes just before `offset`, to notice a rewritten file.
    edge: Vec<u8>,
    /// SHA-256 of bytes [0, offset).
    hash: Sha256,
    cwds: BTreeSet<PathBuf>,
    last: Option<Row>,
    before_notifications: Option<Row>,
    /// The kind of the latest main-chain user row, and of the one before the latest assistant
    /// row.
    last_user: Option<TurnTrigger>,
    trigger: Option<TurnTrigger>,
    /// A malformed or oversized line was consumed; its file is never usable.
    invalid: bool,
}

impl Scan {
    fn new(id: FileId) -> Scan {
        Scan {
            id,
            size: None,
            mtime_ms: None,
            offset: 0,
            edge: Vec::new(),
            hash: Sha256::new(),
            cwds: BTreeSet::new(),
            last: None,
            before_notifications: None,
            last_user: None,
            trigger: None,
            invalid: false,
        }
    }
}

const EDGE_BYTES: usize = 64;

pub(crate) fn incomplete() -> DesktopHostError {
    DesktopAutomationIssue::DesktopObservationIncomplete.into()
}

pub(crate) fn io_error(error: io::Error) -> DesktopHostError {
    DesktopHostError::other(error.to_string())
}

pub(crate) fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The length of `text` in UTF-16 code units, JavaScript's `string.length`.
pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// [`TranscriptScanner::new`] options; unset ones take the TS defaults.
#[derive(Debug, Clone, Copy, Default)]
pub struct TranscriptScannerOptions {
    /// 64 MiB.
    pub max_bytes: Option<u64>,
    /// 2,097,152 UTF-16 code units.
    pub max_line_length: Option<usize>,
    /// 1 MiB.
    pub chunk_bytes: Option<usize>,
}

/// Reads Claude Code transcripts incrementally. Transcripts are append-only JSONL files up to
/// tens of megabytes that quota-stop polling looks at every few seconds; a full read and parse
/// of each one kept hundreds of megabytes in memory and the CPU busy. Each scan reads only what
/// was appended since the previous one and keeps a running hash instead of the rows. It accepts
/// and refuses exactly what `parse_desktop_transcript` does: a file must end with a newline, and
/// every non-empty line must be a JSON object within the length limit.
pub struct TranscriptScanner {
    /// Transcript bytes read from disk, for tests.
    pub bytes_read: u64,
    scans: HashMap<PathBuf, Scan>,
    max_bytes: u64,
    max_line_length: usize,
    chunk_bytes: usize,
}

impl Default for TranscriptScanner {
    fn default() -> Self {
        TranscriptScanner::new(TranscriptScannerOptions::default())
    }
}

impl TranscriptScanner {
    pub fn new(options: TranscriptScannerOptions) -> TranscriptScanner {
        TranscriptScanner {
            bytes_read: 0,
            scans: HashMap::new(),
            max_bytes: options.max_bytes.unwrap_or(64 * 1024 * 1024),
            max_line_length: options.max_line_length.unwrap_or(2_097_152),
            chunk_bytes: options.chunk_bytes.unwrap_or(1024 * 1024),
        }
    }

    pub fn scan(&mut self, file: &Path) -> Result<TranscriptSummary, DesktopHostError> {
        let mut handle = File::open(file).map_err(io_error)?;
        let stat = handle.metadata().map_err(io_error)?;
        if !stat.is_file() || stat.len() > self.max_bytes {
            return Err(incomplete());
        }
        let id = FileId::of_file(&handle).map_err(io_error)?;
        let size = stat.len();
        let mtime = mtime_ms(&stat).map_err(io_error)?;
        let unchanged = self.scans.get(file).is_some_and(|scan| {
            scan.id == id && scan.size == Some(size) && scan.mtime_ms == Some(mtime)
        });
        if !unchanged {
            let continued = match self.scans.get_mut(file) {
                Some(scan) => continues(&mut handle, scan, id, size, &mut self.bytes_read)
                    .map_err(io_error)?,
                None => false,
            };
            if !continued {
                self.scans.insert(file.to_path_buf(), Scan::new(id));
            }
            let scan = self.scans.get_mut(file).expect("scan inserted above");
            read_appended(
                &mut handle,
                scan,
                size,
                self.chunk_bytes,
                self.max_line_length,
                &mut self.bytes_read,
            )
            .map_err(io_error)?;
            scan.size = Some(size);
            scan.mtime_ms = Some(mtime);
        }
        let scan = &self.scans[file];
        if scan.invalid || scan.offset != size {
            return Err(incomplete());
        }
        Ok(TranscriptSummary {
            bytes: scan.offset,
            sha256: hex(&scan.hash.clone().finalize()),
            cwds: scan.cwds.clone(),
            last: scan.last.clone(),
            before_notifications: scan.before_notifications.clone(),
            trigger: scan.trigger,
        })
    }

    /// Forget every transcript not in `files`.
    pub fn retain(&mut self, files: &HashSet<PathBuf>) {
        self.scans.retain(|file, _| files.contains(file));
    }
}

/// Reads into `buffer` from `position` until it is full or the file ends.
pub(crate) fn read_at(handle: &mut File, buffer: &mut [u8], position: u64) -> io::Result<usize> {
    handle.seek(SeekFrom::Start(position))?;
    let mut filled = 0;
    while filled < buffer.len() {
        match handle.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// The same file, grown or not, with the consumed prefix still in place.
fn continues(
    handle: &mut File,
    scan: &Scan,
    id: FileId,
    size: u64,
    bytes_read: &mut u64,
) -> io::Result<bool> {
    if scan.id != id || size < scan.offset {
        return Ok(false);
    }
    let mut edge = vec![0u8; scan.edge.len()];
    let position = scan.offset - edge.len() as u64;
    let read = read_at(handle, &mut edge, position)?;
    *bytes_read += read as u64;
    Ok(read == edge.len() && edge == scan.edge)
}

fn read_appended(
    handle: &mut File,
    scan: &mut Scan,
    size: u64,
    chunk_bytes: usize,
    max_line_length: usize,
    bytes_read: &mut u64,
) -> io::Result<()> {
    let mut chunk = vec![0u8; chunk_bytes.max(1)];
    // A line split across chunks.
    let mut pending: Vec<u8> = Vec::new();
    let mut position = scan.offset;
    while position < size && !scan.invalid {
        let want = (chunk.len() as u64).min(size - position) as usize;
        let read = read_at(handle, &mut chunk[..want], position)?;
        if read == 0 {
            break;
        }
        *bytes_read += read as u64;
        position += read as u64;
        let view = &chunk[..read];
        let mut start = 0;
        while !scan.invalid {
            let Some(at) = memchr::memchr(b'\n', &view[start..]) else {
                break;
            };
            let end = start + at;
            if pending.is_empty() {
                consume(scan, &view[start..=end], max_line_length);
            } else {
                pending.extend_from_slice(&view[start..=end]);
                consume(scan, &pending, max_line_length);
                pending.clear();
            }
            start = end + 1;
        }
        if start < view.len() && !scan.invalid {
            pending.extend_from_slice(&view[start..]);
        }
    }
    Ok(())
}

/// One complete line, newline included.
fn consume(scan: &mut Scan, bytes: &[u8], max_line_length: usize) {
    scan.hash.update(bytes);
    scan.offset += bytes.len() as u64;
    if bytes.len() >= EDGE_BYTES {
        scan.edge = bytes[bytes.len() - EDGE_BYTES..].to_vec();
    } else {
        scan.edge.extend_from_slice(bytes);
        let excess = scan.edge.len().saturating_sub(EDGE_BYTES);
        scan.edge.drain(..excess);
    }
    let text = String::from_utf8_lossy(&bytes[..bytes.len() - 1]);
    if text.is_empty() {
        return;
    }
    // UTF-16 never needs more units than UTF-8 needs bytes.
    if text.len() > max_line_length && js_length(&text) > max_line_length {
        scan.invalid = true;
        return;
    }
    let Ok(Value::Object(value)) = serde_json::from_str::<Value>(&text) else {
        scan.invalid = true;
        return;
    };
    if let Some(cwd) = row_str(&value, "cwd") {
        scan.cwds.insert(resolve(Path::new(cwd)));
    }
    if !truthy(&value, "isSidechain")
        && !truthy(&value, "isMeta")
        && matches!(row_str(&value, "type"), Some("user" | "assistant"))
    {
        if !is_task_notification(&value) {
            scan.before_notifications = None;
        } else if let Some(last) = &scan.last
            && !is_task_notification(last)
        {
            scan.before_notifications = Some(last.clone());
        }
        if row_str(&value, "type") == Some("user") {
            scan.last_user = Some(turn_trigger(&value));
        } else {
            scan.trigger = scan.last_user;
        }
        scan.last = Some(value);
    }
}
