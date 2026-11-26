//! Port of `electron/core/draft-transfer.ts` and the reading half of `electron/draft-job.ts`.
//!
//! The draft step of a switch reads Claude's unsent drafts from a private copy of its Chromium
//! Local Storage. The Electron app did that in a helper process running Relay's own Chromium (and
//! so needed Claude's Electron major); here a LevelDB reader opens the copy in process, so the
//! helper, its job file and the Electron-version gate are gone.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::desktop_files::{CarriedConversation, json_bytes, write_bytes};
use crate::draft_storage::{copy_local_storage, remove_any, sweep_draft_leftovers};
use crate::draft_vault::DraftSlots;
use crate::drafts::{CapturedDraft, DRAFT_KEY_PREFIX, select_drafts};
use crate::fs_util::{iso_timestamp, mtime_ms, system_time_ms};
use crate::shared::types::js::JsMap;
use crate::sidebar_keys::{MAX_SIDEBAR_CHARS, SIDEBAR_KEYS};

/// The draft step's scratch dirs are `<tmp>/relay-drafts-*`, where `tmp` defaults to the temp dir.
const SCRATCH_PREFIX: &str = "relay-drafts-";
/// A scratch dir older than this was left by a Relay that stopped mid-step.
const STALE_SCRATCH_MS: f64 = 10.0 * 60_000.0;
/// Why a step stops when Claude is open: a copy of a leveldb Claude is writing could be torn.
pub const CLAUDE_RUNNING: &str = "Claude is running";
/// Most characters of an error or reason `last.json` keeps.
const MAX_REASON_CHARS: usize = 300;
/// Why a read fails when the copy held no data for claude.ai.
pub const EMPTY_STORAGE: &str = "Claude's Local Storage opened empty";
/// Most drafts a read may report. Claude holds a few dozen at most.
const MAX_DRAFTS: usize = 500;
/// Most characters (UTF-16 code units), keys and values together, a read may report.
const MAX_DRAFT_CHARS: usize = 4 * 1024 * 1024;

/// What the reader works on: Relay's private copy of Claude's Local Storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftJob {
    /// The directory holding the copy's `leveldb`: `<scratch>/copy`, outside Claude's directory.
    pub storage: PathBuf,
    /// The run's scratch dir, `<tmp>/relay-drafts-*`, removed after the run.
    pub scratch: PathBuf,
}

/// What a read answers: on success, every `composer-draft:` key of Local Storage with its raw
/// value, and the raw values of the `SIDEBAR_KEYS` it found (None when they could not be read).
#[derive(Debug, Clone, PartialEq)]
pub enum DraftResult {
    Ok {
        drafts: JsMap<String>,
        sidebar: Option<JsMap<String>>,
    },
    Failed {
        error: String,
    },
}

impl DraftResult {
    fn failed(error: impl Into<String>) -> DraftResult {
        DraftResult::Failed {
            error: error.into(),
        }
    }
}

/// The draft step's outcome, as `last.json` records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CaptureOutcome {
    Captured { count: usize },
    Skipped { reason: String },
    Failed { error: String },
}

/// Local Storage seen through a reader that can only look: it offers no way to write.
pub trait DraftPage {
    /// How many keys the origin holds, of any kind. 0 means there was no data to read.
    fn size(&self) -> Result<usize, String>;
    /// Every `composer-draft:` key with its value.
    fn read(&self) -> Result<JsMap<String>, String>;
    /// The `SIDEBAR_KEYS` the origin holds, with their values; None when the page cannot say.
    fn read_sidebar(&self) -> Option<Result<JsMap<String>, String>> {
        None
    }
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn chars_of(map: &JsMap<String>) -> usize {
    map.iter().map(|(k, v)| units(k) + units(v)).sum()
}

/// Reads every `composer-draft:` key through `page`, and the sidebar keys, and writes nothing.
/// Never fails: a failure is a `Failed` result. A sidebar that cannot be read is left out: it
/// never costs the drafts.
///
/// An origin with no keys at all is a failure: a database that did not open as Claude's must not
/// report success over nothing.
pub fn run_draft_job(page: &dyn DraftPage) -> DraftResult {
    let size = match page.size() {
        Ok(size) => size,
        Err(error) => return DraftResult::failed(error),
    };
    if size == 0 {
        return DraftResult::failed(EMPTY_STORAGE);
    }
    let drafts = match page.read() {
        Ok(drafts) => drafts,
        Err(error) => return DraftResult::failed(error),
    };
    // Too large, it would crowd out the drafts' own limit.
    let sidebar = page
        .read_sidebar()
        .and_then(Result::ok)
        .filter(|sidebar| chars_of(sidebar) <= MAX_SIDEBAR_CHARS);
    DraftResult::Ok { drafts, sidebar }
}

/// A read's drafts within the limits: at most 500, every key a `composer-draft:` key, keys and
/// values together at most 4 MiB of characters. Over them, the read counts as no result.
fn valid_drafts(drafts: &JsMap<String>) -> bool {
    if drafts.len() > MAX_DRAFTS {
        return false;
    }
    let mut chars = 0;
    for (key, text) in drafts {
        if !key.starts_with(DRAFT_KEY_PREFIX) {
            return false;
        }
        chars += units(key) + units(text);
        if chars > MAX_DRAFT_CHARS {
            return false;
        }
    }
    true
}

/// A read's sidebar within the limit: only `SIDEBAR_KEYS`, at most `MAX_SIDEBAR_CHARS`.
fn valid_sidebar(sidebar: &JsMap<String>) -> bool {
    sidebar
        .keys()
        .all(|key| SIDEBAR_KEYS.contains(&key.as_str()))
        && chars_of(sidebar) <= MAX_SIDEBAR_CHARS
}

/// The result `capture_drafts` acts on (the old `helperOutcome`): drafts past the limits are no
/// result; a sidebar that is off is only left out, the drafts stand on their own.
pub fn checked_result(result: DraftResult) -> DraftResult {
    match result {
        DraftResult::Failed { error } if error.is_empty() => DraftResult::failed("no result"),
        DraftResult::Failed { error } => DraftResult::Failed { error },
        DraftResult::Ok { drafts, sidebar } => {
            if !valid_drafts(&drafts) {
                return DraftResult::failed("no result");
            }
            DraftResult::Ok {
                drafts,
                sidebar: sidebar.filter(valid_sidebar),
            }
        }
    }
}

/// Fails unless `storage` is a real directory holding a real `leveldb` directory. A link or a
/// missing path is refused, so the reader is never pointed at anything but Relay's own copy.
pub fn assert_local_storage(storage: &Path) -> Result<(), String> {
    for (dir, name) in [
        (storage.to_path_buf(), "Local Storage"),
        (storage.join("leveldb"), "Local Storage/leveldb"),
    ] {
        // lstat, so a link is not followed.
        if !fs::symlink_metadata(&dir).is_ok_and(|st| st.is_dir()) {
            return Err(format!("{name} is not a real directory."));
        }
    }
    Ok(())
}

/// The origin Claude's Local Storage belongs to, as Chromium keys it.
const ORIGIN: &[u8] = b"https://claude.ai";

/// Chromium's DOMStorage string encoding: a format byte, then Latin-1 (1) or UTF-16LE (0).
fn decode_storage_string(bytes: &[u8]) -> Option<String> {
    let (&format, rest) = bytes.split_first()?;
    match format {
        1 => Some(rest.iter().map(|&b| char::from(b)).collect()),
        0 if rest.len() % 2 == 0 => {
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

/// claude.ai's Local Storage entries in a leveldb, read in key order: `_<origin>\0<key>` keys.
pub struct LevelDbPage {
    entries: Vec<(String, String)>,
}

impl LevelDbPage {
    /// Opens `<storage>/leveldb` and reads claude.ai's entries. The database is a private copy:
    /// nothing in Claude's directory is ever opened.
    pub fn open(storage: &Path) -> Result<LevelDbPage, String> {
        assert_local_storage(storage)?;
        let options = rusty_leveldb::Options {
            create_if_missing: false,
            ..Default::default()
        };
        let mut db = rusty_leveldb::DB::open(storage.join("leveldb"), options)
            .map_err(|e| format!("Claude's Local Storage could not be opened: {}", e.err))?;
        let mut prefix = vec![b'_'];
        prefix.extend_from_slice(ORIGIN);
        prefix.push(0);
        let mut entries = Vec::new();
        {
            use rusty_leveldb::LdbIterator;
            let mut iter = db
                .new_iter()
                .map_err(|e| format!("Claude's Local Storage could not be read: {}", e.err))?;
            iter.seek(&prefix);
            while iter.valid() {
                let Some((key, value)) = iter.current() else {
                    break;
                };
                let Some(name) = key.strip_prefix(prefix.as_slice()) else {
                    break;
                };
                if let (Some(name), Some(value)) =
                    (decode_storage_string(name), decode_storage_string(&value))
                {
                    entries.push((name, value));
                }
                if !iter.advance() {
                    break;
                }
            }
        }
        let _ = db.close();
        Ok(LevelDbPage { entries })
    }
}

impl DraftPage for LevelDbPage {
    fn size(&self) -> Result<usize, String> {
        Ok(self.entries.len())
    }
    fn read(&self) -> Result<JsMap<String>, String> {
        Ok(self
            .entries
            .iter()
            .filter(|(key, _)| key.starts_with(DRAFT_KEY_PREFIX))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect())
    }
    fn read_sidebar(&self) -> Option<Result<JsMap<String>, String>> {
        let mut found = JsMap::new();
        for key in SIDEBAR_KEYS {
            if let Some((_, value)) = self.entries.iter().find(|(k, _)| k == key) {
                found.insert(key, value.clone());
            }
        }
        Some(Ok(found))
    }
}

/// The default `run` of `capture_drafts`: reads the job's copy in process, within the limits.
pub fn read_drafts(job: &DraftJob) -> DraftResult {
    match LevelDbPage::open(&job.storage) {
        Ok(page) => checked_result(run_draft_job(&page)),
        Err(error) => DraftResult::failed(error),
    }
}

/// Hands the drafts kept, and the slots read, for an account to the vault.
pub type DraftStore<'a> = &'a dyn Fn(&str, &[CapturedDraft], &DraftSlots) -> Result<(), String>;
/// Gets the sidebar keys a read found (None when it found none).
pub type SidebarSink<'a> = &'a dyn Fn(Option<&JsMap<String>>) -> Result<(), String>;

/// What the draft step of a switch needs.
pub struct CaptureInput<'a> {
    pub root: &'a Path,
    pub from: &'a str,
    pub to: &'a str,
    pub conversations: &'a [CarriedConversation],
    pub titles: &'a HashMap<String, String>,
    /// Reads the job's copy; `read_drafts` in the app.
    pub run: &'a dyn Fn(&DraftJob) -> DraftResult,
    pub store: DraftStore<'a>,
    pub sidebar: Option<SidebarSink<'a>>,
    /// `<vault>/drafts/last.json`.
    pub last_json: &'a Path,
    pub now_ms: i64,
    /// Why drafts cannot be read now.
    pub blocked: Option<String>,
    /// Asked once the copy is made: a Claude that opened meanwhile, or a check that fails,
    /// skips the step.
    pub running: Option<&'a dyn Fn() -> Result<bool, String>>,
    /// Where the scratch dir is made; the temp dir when None.
    pub tmp: Option<&'a Path>,
}

/// `text.slice(0, n)` in UTF-16 code units.
fn cut(text: &str, n: usize) -> String {
    crate::shared::browser_extension::js_slice_units(text, n)
}

/// The draft step of a switch, while Claude is closed: reads the unsent drafts of account `from`
/// and hands those worth re-typing for account `to` to `store`, as `select_drafts` picks them
/// from the carried `conversations`, with B's `titles`.
///
/// Nothing in Claude's directory is written. Its leveldb is copied into a new scratch dir in
/// `tmp`, as `<scratch>/copy/leveldb`, and `run` reads only that copy. The scratch dir, which
/// holds the copy and so the drafts' text, is removed whatever happens. Before the copy, scratch
/// dirs left in `tmp` by an earlier step and what the first design left in Claude's Local
/// Storage are swept. With `blocked` the step is skipped before anything is swept or copied.
///
/// After a successful read, `store` gets the drafts kept, possibly none, and the slots read for
/// `to`: every carried conversation and the new-session screen. `sidebar`, when given, gets the
/// sidebar keys read (None when none were) before that; whatever it does, it never changes the
/// step's outcome.
///
/// A run that fails, and a copy or a store that fails, end the step as failed. The outcome is
/// written to `last_json` with reasons cut to 300 characters, never draft text. Never fails.
pub fn capture_drafts(input: CaptureInput<'_>) -> CaptureOutcome {
    let outcome = match capture(&input) {
        Ok(outcome) => outcome,
        Err(error) => CaptureOutcome::Failed { error },
    };
    // Whatever produced an error or a reason, only its start is kept.
    let outcome = match outcome {
        CaptureOutcome::Failed { error } => CaptureOutcome::Failed {
            error: cut(&error, MAX_REASON_CHARS),
        },
        CaptureOutcome::Skipped { reason } => CaptureOutcome::Skipped {
            reason: cut(&reason, MAX_REASON_CHARS),
        },
        captured => captured,
    };
    // Written as `drafts/last.json` under the vault, so a linked drafts dir is refused too.
    let drafts = crate::fs_util::dirname(input.last_json);
    let vault = crate::fs_util::dirname(drafts);
    let relative = format!(
        "{}/{}",
        drafts.file_name().unwrap_or_default().to_string_lossy(),
        input
            .last_json
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    );
    let mut record = serde_json::Map::new();
    record.insert("at".into(), iso_timestamp(input.now_ms).into());
    record.insert("from".into(), input.from.into());
    record.insert("to".into(), input.to.into());
    if let Ok(serde_json::Value::Object(fields)) = serde_json::to_value(&outcome) {
        record.extend(fields);
    }
    // The record is only there to explain what happened.
    let _ = write_bytes(vault, &relative, Some(&json_bytes(&record)));
    outcome
}

fn capture(input: &CaptureInput<'_>) -> Result<CaptureOutcome, String> {
    // Before the sweeps, so a skipped step deletes nothing.
    if let Some(blocked) = input.blocked.as_deref().filter(|b| !b.is_empty()) {
        return Ok(CaptureOutcome::Skipped {
            reason: blocked.to_owned(),
        });
    }
    let tmp = input
        .tmp
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    sweep_stale_draft_scratch(&tmp);
    sweep_draft_leftovers(input.root);

    let scratch = make_scratch(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        let storage = scratch.join("copy");
        if !copy_local_storage(input.root, &storage).map_err(|e| e.to_string())? {
            return Ok(CaptureOutcome::Skipped {
                reason: "no Local Storage".into(),
            });
        }
        if let Some(running) = input.running {
            // Unknown counts as running.
            if running().unwrap_or(true) {
                return Ok(CaptureOutcome::Skipped {
                    reason: CLAUDE_RUNNING.into(),
                });
            }
        }
        let job = DraftJob {
            storage,
            scratch: scratch.clone(),
        };
        let (drafts, sidebar) = match (input.run)(&job) {
            DraftResult::Ok { drafts, sidebar } => (drafts, sidebar),
            DraftResult::Failed { error } => {
                return Ok(CaptureOutcome::Failed {
                    error: if error.is_empty() {
                        "no result".into()
                    } else {
                        error
                    },
                });
            }
        };
        if let Some(sidebar_fn) = input.sidebar {
            // The sidebar is a side matter of the step: the drafts still go on.
            let _ = sidebar_fn(sidebar.as_ref());
        }
        let kept = select_drafts(&drafts, input.from, input.conversations, input.titles);
        // Even with none kept: an older draft in a slot read here is no longer the account's.
        (input.store)(
            input.to,
            &kept,
            &DraftSlots {
                aliases: input
                    .conversations
                    .iter()
                    .map(|c| c.target_alias.clone())
                    .collect(),
                new_session: true,
            },
        )?;
        Ok(CaptureOutcome::Captured { count: kept.len() })
    })();
    let _ = remove_any(&scratch);
    result
}

/// `fs.mkdtemp(<tmp>/relay-drafts-)`: a new private dir with a random suffix.
fn make_scratch(tmp: &Path) -> std::io::Result<PathBuf> {
    loop {
        let suffix: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_owned();
        let dir = tmp.join(format!("{SCRATCH_PREFIX}{suffix}"));
        match crate::fs_util::create_private_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

/// Removes the draft scratch dirs in `tmp` that are older than ten minutes: a Relay that crashed
/// or was killed mid-step leaves one behind, with its copy. Run before every step and when Relay
/// starts. Never fails.
pub fn sweep_stale_draft_scratch(tmp: &Path) {
    let Ok(entries) = fs::read_dir(tmp) else {
        return;
    };
    let now = system_time_ms(std::time::SystemTime::now());
    for entry in entries.flatten() {
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        if !is_dir
            || !entry
                .file_name()
                .to_string_lossy()
                .starts_with(SCRATCH_PREFIX)
        {
            continue;
        }
        let dir = entry.path();
        if let Ok(meta) = fs::symlink_metadata(&dir)
            && let Ok(mtime) = mtime_ms(&meta)
            && now - mtime > STALE_SCRATCH_MS
        {
            // A link inside is removed, never what it points to.
            let _ = remove_any(&dir);
        }
    }
}

/// Why drafts cannot be captured on this machine, or None when they can. Reading needs only
/// Claude closed, so Linux reads them too; only re-typing them into Claude is macOS's.
pub fn drafts_blocked_reason(platform: &str) -> Option<&'static str> {
    (platform != "darwin" && platform != "linux").then_some("drafts move only on macOS and Linux")
}
