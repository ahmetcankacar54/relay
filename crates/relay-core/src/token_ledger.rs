//! Port of `electron/core/token-ledger.ts`: counts the tokens of Claude Code responses from
//! transcript JSONL files, by day, account and model, into `token-ledger.json` and the
//! `token-ledger-seen/<date>.bin` hash files beside it.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use indexmap::IndexMap;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::continuation_journal::{
    PrivateJsonError, private_journal_directory, read_private_json, write_private_json,
};
use crate::fs_util::{dirname, set_mode, sync_directory};
use crate::shared::model_prices::{self, ResponseUsage, estimate_cost, response_cost};
use crate::shared::planning::{local_date, local_slot};
use crate::shared::time_zones::valid_time_zone;
use crate::shared::types::js::{JsMap, compare_str, date_parse, ser_num, ser_opt_num};
use crate::token_attribution::{Attribution, AttributionRow};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    #[serde(serialize_with = "ser_num")]
    pub input: f64,
    #[serde(serialize_with = "ser_num")]
    pub output: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_write: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_read: f64,
    #[serde(serialize_with = "ser_num")]
    pub responses: f64,
    /// What these tokens would cost on the API, in USD.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub cost: Option<f64>,
    /// Tokens of responses whose model has no price; they add nothing to `cost`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub unpriced: Option<f64>,
    /// Some of `cost` was estimated (`true` or absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_estimated: Option<bool>,
}

/// One quarter hour of one day for one `who`: the four kinds and their cost.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotCounts {
    #[serde(serialize_with = "ser_num")]
    pub input: f64,
    #[serde(serialize_with = "ser_num")]
    pub output: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_write: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache_read: f64,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
}

/// `${date}|${who}|${model}`; who = `acct:<id>` | `est:<id>` | "terminal" | "unknown".
pub type BucketKey = String;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerProgress {
    #[serde(serialize_with = "ser_num")]
    pub scanned_bytes: f64,
    #[serde(serialize_with = "ser_num")]
    pub total_bytes: f64,
    /// A full pass has finished since the counts were last emptied.
    pub complete: bool,
    /// The last save failed (`true` or absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

/// date → who → model → counts.
pub type LedgerDays = JsMap<JsMap<JsMap<TokenCounts>>>;
/// date → who → quarter hour (0–95) → counts.
pub type LedgerSlots = JsMap<JsMap<JsMap<SlotCounts>>>;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSnapshot {
    pub days: LedgerDays,
    /// The last 8 days, by quarter hour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<LedgerSlots>,
    /// When slots began to be kept: earlier responses of those days have none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub slots_since: Option<f64>,
    pub progress: LedgerProgress,
}

/// Between finished passes the ledger is ticked this often.
pub const TOKEN_TICK_MS: u64 = 5 * 60_000;
/// While a pass is unfinished, ticks run back to back at this pace.
pub const TOKEN_FIRST_SCAN_TICK_MS: u64 = 2_000;

/// What one tick did: whether it finished the pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TickResult {
    pub complete: bool,
}

/// How the last tick ended: `{ complete }` or `"failed"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastTick {
    Ticked(TickResult),
    Failed,
}

impl From<TickResult> for LastTick {
    fn from(result: TickResult) -> Self {
        LastTick::Ticked(result)
    }
}

/// The wait before the next tick: the fast pace while the last tick left its pass unfinished,
/// the slow one after a finished pass or a tick that failed.
pub fn token_tick_delay(last: impl Into<LastTick>) -> u64 {
    match last.into() {
        LastTick::Ticked(TickResult { complete: false }) => TOKEN_FIRST_SCAN_TICK_MS,
        _ => TOKEN_TICK_MS,
    }
}

/// A transcript root; one under a Relay profile carries its account.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TokenRoot {
    pub dir: PathBuf,
    pub profile_account_id: Option<String>,
}

pub type AttributeFn = Box<dyn FnMut(&AttributionRow<'_>) -> Attribution + Send>;

pub struct TokenLedgerOptions {
    /// The ledger file, `<userData>/token-ledger.json`.
    pub file: PathBuf,
    /// Transcript roots; one under a Relay profile carries its account.
    pub roots: Vec<TokenRoot>,
    pub attribute: AttributeFn,
    /// The planning time zone that days are calendar dates in.
    pub zone: Box<dyn FnMut() -> String + Send>,
    /// Epoch ms; `Date.now` by default.
    pub now: Option<Box<dyn FnMut() -> f64 + Send>>,
    /// Wall time one tick may work for; it may finish the chunk it is in. 200 ms by default.
    pub budget_ms: Option<f64>,
    /// A transcript first seen untouched for longer is never read. 90 by default.
    pub max_age_days: Option<f64>,
    /// The largest ledger file written; for tests.
    pub max_bytes: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum TokenLedgerError {
    /// A seen file or its folder is not what the ledger wrote.
    #[error("token-ledger-seen-invalid")]
    SeenInvalid,
    /// `Intl` refuses the planning zone.
    #[error("Invalid time zone specified: {0}")]
    InvalidZone(String),
    #[error(transparent)]
    Json(#[from] PrivateJsonError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

const DAY_MS: f64 = 86_400_000.0;
const CHUNK_BYTES: usize = 1024 * 1024;
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
/// `<project>/<session>/subagents/<agent>.jsonl` is four levels below a root.
const MAX_DEPTH: usize = 4;
const KEEP_DAYS: f64 = 120.0;
/// Today and the 7 days before it keep quarter-hour slots.
const SLOT_DAYS: f64 = 8.0;
/// The 1 MiB default of the private JSON helpers is too small: the owner's transcripts are
/// thousands of files, each with a key and offsets here. Offsets and counts must stay in one
/// file to be written atomically together.
const LEDGER_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// A file's key is this many bytes of the SHA-256 of its path, in hex.
const FILE_KEY_BYTES: usize = 16;
/// A transcript untouched this long keeps no last response: none goes on streaming.
const IDLE_MS: f64 = 2.0 * DAY_MS;
/// Days of seen hashes kept in memory, least recently used dropped first.
const SEEN_DAYS_IN_MEMORY: usize = 16;
const HASH_BYTES: usize = 8;
/// While a scan spans ticks, the ledger is written at most this often.
const PERSIST_EVERY_MS: f64 = 10_000.0;
/// Claude Code's own stand-in replies, not responses from the API.
const SYNTHETIC_MODEL: &str = "<synthetic>";
const MAX_MODEL_LENGTH: usize = 100;
/// Real ids are about 30 characters.
const MAX_ID_LENGTH: usize = 200;
const LEDGER_VERSION: u8 = 3;

type Hash = [u8; HASH_BYTES];

/// `^\d{4}-\d{2}-\d{2}$`.
fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `^(\d|[1-8]\d|9[0-5])$`: a quarter hour, 0–95, as `String(n)` writes it.
fn is_slot(text: &str) -> bool {
    let b = text.as_bytes();
    match b {
        [d] => d.is_ascii_digit(),
        [t, d] => {
            (b'1'..=b'8').contains(t) && d.is_ascii_digit()
                || *t == b'9' && (b'0'..=b'5').contains(d)
        }
        _ => false,
    }
}

/// `^[0-9a-f]{32}$`.
fn is_file_key(text: &str) -> bool {
    text.len() == FILE_KEY_BYTES * 2 && text.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^(\d{4}-\d{2}-\d{2})\.bin$`.
fn seen_file_date(name: &str) -> Option<&str> {
    name.strip_suffix(".bin").filter(|date| is_date(date))
}

/// A positive finite number, else 0.
fn amount(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n,
        _ => 0.0,
    }
}

/// A finite number of at least 0.
fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

/// JavaScript's `string.length`: UTF-16 code units.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_id(value: &str) -> bool {
    !value.is_empty() && js_length(value) <= MAX_ID_LENGTH
}

fn is_not_found(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}

/// input, output, cacheWrite, cacheRead.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Usage([f64; 4]);

fn tokens_of(usage: &Usage) -> f64 {
    usage.0.iter().sum()
}

fn counts_usage(counts: &TokenCounts) -> Usage {
    Usage([
        counts.input,
        counts.output,
        counts.cache_write,
        counts.cache_read,
    ])
}

fn counts_fields(counts: &mut TokenCounts) -> [&mut f64; 4] {
    [
        &mut counts.input,
        &mut counts.output,
        &mut counts.cache_write,
        &mut counts.cache_read,
    ]
}

fn slot_fields(counts: &mut SlotCounts) -> [&mut f64; 4] {
    [
        &mut counts.input,
        &mut counts.output,
        &mut counts.cache_write,
        &mut counts.cache_read,
    ]
}

/// Give a bucket counted before costs were kept an estimated cost, once.
fn price_old_bucket(model: &str, counts: &mut TokenCounts) {
    let sums = model_prices::TokenCounts {
        input: counts.input,
        output: counts.output,
        cache_write: counts.cache_write,
        cache_read: counts.cache_read,
    };
    match estimate_cost(model, &sums) {
        None => counts.unpriced = Some(tokens_of(&counts_usage(counts))),
        Some(estimate) => counts.cost = Some(estimate),
    }
    counts.cost_estimated = Some(true);
}

fn usage_of(usage: &Map<String, Value>) -> Usage {
    Usage([
        amount(usage.get("input_tokens")),
        amount(usage.get("output_tokens")),
        amount(usage.get("cache_creation_input_tokens")),
        amount(usage.get("cache_read_input_tokens")),
    ])
}

/// A response's cost from its row; -1 when its model has no price.
fn cost_of(model: &str, usage: &Usage, raw: &Map<String, Value>) -> f64 {
    let [input, output, cache_write, cache_read] = usage.0;
    let split = raw.get("cache_creation").and_then(Value::as_object);
    let cost = response_cost(
        model,
        &ResponseUsage {
            input,
            output,
            cache_write,
            cache_read,
            cache_write_1h: split.map(|split| amount(split.get("ephemeral_1h_input_tokens"))),
            speed: raw.get("speed").and_then(Value::as_str).map(str::to_string),
            geo: raw
                .get("inference_geo")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
    );
    cost.unwrap_or(-1.0)
}

fn who_of(attribution: &Attribution) -> String {
    match attribution {
        Attribution::Account {
            account_id,
            estimated,
        } => format!("{}:{account_id}", if *estimated { "est" } else { "acct" }),
        Attribution::Terminal => "terminal".to_string(),
        Attribution::Unknown => "unknown".to_string(),
    }
}

fn empty_counts() -> TokenCounts {
    TokenCounts {
        cost: Some(0.0),
        unpriced: Some(0.0),
        ..TokenCounts::default()
    }
}

/// `days[date][who][model] ??= zeros`; JS key order, so a model named `__proto__` is just a key.
fn bucket<'a>(days: &'a mut LedgerDays, date: &str, who: &str, model: &str) -> &'a mut TokenCounts {
    days.entry_or_insert_with(date, JsMap::new)
        .entry_or_insert_with(who, JsMap::new)
        .entry_or_insert_with(model, empty_counts)
}

fn slot_bucket<'a>(
    slots: &'a mut LedgerSlots,
    date: &str,
    who: &str,
    slot: u32,
) -> &'a mut SlotCounts {
    slots
        .entry_or_insert_with(date, JsMap::new)
        .entry_or_insert_with(who, JsMap::new)
        .entry_or_insert_with(&slot.to_string(), SlotCounts::default)
}

fn sha256_hex(text: &str, bytes: usize) -> String {
    Sha256::digest(text.as_bytes())[..bytes]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The first 8 bytes of the SHA-256 of a response's `${message.id}:${requestId}`.
fn hash_of(key: &str) -> Hash {
    let digest = Sha256::digest(key.as_bytes());
    let mut hash = [0; HASH_BYTES];
    hash.copy_from_slice(&digest[..HASH_BYTES]);
    hash
}

/// The ledger's key for a transcript, so no folder name is ever saved.
fn file_key(file: &Path) -> String {
    sha256_hex(&file.to_string_lossy(), FILE_KEY_BYTES)
}

/// What Node's `fs.Stats` gives the ledger.
#[derive(Debug, Clone, Copy)]
struct Stat {
    is_file: bool,
    dev: f64,
    ino: f64,
    size: f64,
    /// `sec * 1e3 + nsec / 1e6`, as Node computes `mtimeMs`.
    mtime_ms: f64,
}

impl Stat {
    #[cfg(unix)]
    fn of(meta: &fs::Metadata, _: Option<&File>, _: Option<&Path>) -> io::Result<Stat> {
        use std::os::unix::fs::MetadataExt;
        Ok(Stat {
            is_file: meta.is_file(),
            dev: meta.dev() as f64,
            ino: meta.ino() as f64,
            size: meta.size() as f64,
            mtime_ms: meta.mtime() as f64 * 1e3 + meta.mtime_nsec() as f64 / 1e6,
        })
    }

    #[cfg(windows)]
    fn of(meta: &fs::Metadata, file: Option<&File>, path: Option<&Path>) -> io::Result<Stat> {
        use crate::fs_util::FileId;
        let id = match (meta.is_file(), file, path) {
            (false, ..) => FileId { dev: 0, ino: 0 },
            (true, Some(file), _) => FileId::of_file(file)?,
            (true, None, Some(path)) => FileId::of_path(path)?,
            (true, None, None) => FileId { dev: 0, ino: 0 },
        };
        let mtime_ms = match meta.modified()?.duration_since(std::time::UNIX_EPOCH) {
            Ok(after) => after.as_secs() as f64 * 1e3 + f64::from(after.subsec_nanos()) / 1e6,
            Err(before) => -(before.duration().as_secs_f64() * 1e3),
        };
        Ok(Stat {
            is_file: meta.is_file(),
            dev: id.dev as f64,
            ino: id.ino as f64,
            size: meta.len() as f64,
            mtime_ms,
        })
    }

    /// `fs.lstat`.
    fn lstat(path: &Path) -> io::Result<Stat> {
        Stat::of(&fs::symlink_metadata(path)?, None, Some(path))
    }

    /// `handle.stat()`.
    fn fstat(file: &File) -> io::Result<Stat> {
        Stat::of(&file.metadata()?, Some(file), None)
    }
}

/// `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`.
fn open_read(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

fn read_at(file: &File, buffer: &mut [u8], position: u64) -> io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buffer, position)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buffer, position)
    }
}

/// The response a transcript's last rows belong to, and what it has added so far.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LastResponse {
    date: String,
    who: String,
    model: String,
    #[serde(serialize_with = "ser_num")]
    input: f64,
    #[serde(serialize_with = "ser_num")]
    output: f64,
    #[serde(serialize_with = "ser_num")]
    cache_write: f64,
    #[serde(serialize_with = "ser_num")]
    cache_read: f64,
    /// The cost added so far; -1 when the model has no price.
    #[serde(serialize_with = "ser_num")]
    cost: f64,
    /// Its quarter hour, when the day keeps slots.
    #[serde(skip_serializing_if = "Option::is_none")]
    slot: Option<u32>,
}

impl LastResponse {
    fn usage(&self) -> Usage {
        Usage([self.input, self.output, self.cache_write, self.cache_read])
    }

    fn fields(&mut self) -> [&mut f64; 4] {
        [
            &mut self.input,
            &mut self.output,
            &mut self.cache_write,
            &mut self.cache_read,
        ]
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// What is kept of a transcript, under a hash of its path: where reading stopped, never its text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileState {
    #[serde(serialize_with = "ser_num")]
    dev: f64,
    #[serde(serialize_with = "ser_num")]
    ino: f64,
    /// Size when last looked at.
    #[serde(serialize_with = "ser_num")]
    size: f64,
    /// Bytes consumed, always just after a newline.
    #[serde(serialize_with = "ser_num")]
    offset: f64,
    #[serde(serialize_with = "ser_num")]
    mtime_ms: f64,
    /// `${message.id}:${requestId}` of the last response read.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_key: Option<String>,
    /// Where that response was counted; absent when it was skipped, as a copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    last: Option<LastResponse>,
    /// Shrunk or replaced by another inode: never read again, and its counted tokens stay.
    #[serde(skip_serializing_if = "is_false")]
    broken: bool,
}

/// Whether a file on disk is still the transcript a state was kept for: the same inode, never
/// shorter than what was read. The device number does not decide it, since macOS numbers a
/// volume anew when it is mounted again, as after a restart, while its files keep their inodes.
fn same_transcript(state: &FileState, stat: &Stat) -> bool {
    stat.ino == state.ino && stat.size >= state.offset
}

/// Keep the device number the volume has now; whether it changed.
fn adopt_device(state: &mut FileState, stat: &Stat) -> bool {
    if stat.dev == state.dev {
        return false;
    }
    state.dev = stat.dev;
    true
}

/// `token-ledger.json`. Version 2 keys files by a hash of their path; 3 was counted with
/// estimates that also take the nearest rise within 15 minutes. An earlier ledger is dropped
/// and rescanned, so its responses are attributed again.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved<'a> {
    version: u8,
    /// The time zone the days are in.
    #[serde(skip_serializing_if = "Option::is_none")]
    zone: Option<&'a str>,
    /// A full pass has finished since the counts were last emptied.
    #[serde(skip_serializing_if = "is_false")]
    complete: bool,
    files: &'a JsMap<FileState>,
    days: &'a LedgerDays,
    slots: &'a LedgerSlots,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    slots_since: Option<f64>,
    /// When buckets began to carry a cost; a ledger without it has its sums estimated once.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    priced_at: Option<f64>,
    /// The length of each day's seen file that goes with these offsets.
    seen: &'a JsMap<u64>,
}

/// A directory still to list.
#[derive(Debug, Clone)]
struct PassDir {
    dir: PathBuf,
    depth: usize,
    root: usize,
}

/// A transcript to read; the path is only ever in memory.
#[derive(Debug, Clone)]
struct PassFile {
    file: PathBuf,
    key: String,
    root: usize,
}

/// One walk of the roots and read of what they hold, possibly over many ticks.
#[derive(Debug, Default)]
struct Pass {
    /// Directories still to list, as a stack.
    dirs: Vec<PassDir>,
    /// Transcripts to read, in the order found.
    files: Vec<PassFile>,
    next: usize,
}

impl Pass {
    fn remaining(&self) -> bool {
        !self.dirs.is_empty() || self.next < self.files.len()
    }
}

/// A read the budget paused in the middle of a file.
#[derive(Debug)]
struct Cursor {
    file: PathBuf,
    position: u64,
    /// The unfinished line so far; dropped once it is over the line limit.
    pending: Vec<u8>,
    line_bytes: usize,
}

struct Tick {
    started: f64,
    deadline: f64,
    zone: String,
    /// The oldest date kept.
    cutoff: String,
    /// The oldest date whose slots are kept.
    slot_cutoff: String,
}

/// The responses each day already counted, across all transcripts: a resumed or forked session
/// copies earlier rows, timestamps included, into a new file. Each day is an append-only file of
/// 8-byte hashes of `${message.id}:${requestId}`, never any text, and only a few days are held
/// in memory.
struct SeenDays {
    dir: PathBuf,
    /// The length of each day's file on disk, as of the last flush.
    bytes: JsMap<u64>,
    /// Loaded days, least recently used first.
    loaded: IndexMap<String, HashSet<Hash>>,
    /// Hashes added since the last flush.
    pending: IndexMap<String, Vec<Hash>>,
    /// Days forgotten whose files go once a ledger without them is saved.
    dropped: IndexMap<String, ()>,
    /// How many days are loaded, readable while the ledger works.
    in_memory: Arc<AtomicUsize>,
}

impl SeenDays {
    fn new(dir: PathBuf) -> Self {
        SeenDays {
            dir,
            bytes: JsMap::new(),
            loaded: IndexMap::new(),
            pending: IndexMap::new(),
            dropped: IndexMap::new(),
            in_memory: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn note_loaded(&self) {
        self.in_memory.store(self.loaded.len(), Ordering::Relaxed);
    }

    fn has(&mut self, date: &str, hash: &Hash) -> Result<bool, TokenLedgerError> {
        Ok(self.day(date)?.contains(hash))
    }

    fn add(&mut self, date: &str, hash: Hash) -> Result<(), TokenLedgerError> {
        self.day(date)?.insert(hash);
        self.pending.entry(date.to_string()).or_default().push(hash);
        Ok(())
    }

    fn dates(&self) -> Vec<String> {
        let mut dates: IndexMap<&str, ()> = IndexMap::new();
        for date in self
            .bytes
            .keys()
            .chain(self.loaded.keys())
            .chain(self.pending.keys())
        {
            dates.insert(date, ());
        }
        dates.into_keys().map(str::to_string).collect()
    }

    /// Forget a day. Its file stays until a ledger that no longer counts on it is saved, so a
    /// saved ledger never names a seen file that is gone.
    fn drop_day(&mut self, date: &str) {
        self.loaded.shift_remove(date);
        self.pending.shift_remove(date);
        self.bytes.remove(date);
        self.dropped.insert(date.to_string(), ());
        self.note_loaded();
    }

    /// Delete the files of dropped days; one that cannot go is tried again later.
    fn remove_dropped(&mut self) {
        let dates: Vec<String> = self.dropped.keys().cloned().collect();
        for date in dates {
            match fs::remove_file(self.file(&date)) {
                Err(error) if !is_not_found(&error) => continue,
                _ => {}
            }
            self.dropped.shift_remove(&date);
        }
    }

    /// Forget everything in memory.
    fn forget(&mut self) {
        self.loaded.clear();
        self.pending.clear();
        self.bytes = JsMap::new();
        self.dropped.clear();
        self.note_loaded();
    }

    /// Delete every seen file; a symlink in the directory's place goes, not its target.
    fn remove_all(&self) -> io::Result<()> {
        let info = match fs::symlink_metadata(&self.dir) {
            Err(error) if is_not_found(&error) => return Ok(()),
            other => other?,
        };
        let result = if info.is_dir() && !info.is_symlink() {
            fs::remove_dir_all(&self.dir)
        } else {
            // A directory link on Windows goes with `remove_dir`.
            fs::remove_file(&self.dir).or_else(|error| {
                if cfg!(windows) && info.is_symlink() {
                    fs::remove_dir(&self.dir)
                } else {
                    Err(error)
                }
            })
        };
        match result {
            Err(error) if is_not_found(&error) => Ok(()),
            other => other,
        }
    }

    /// Append the new hashes durably, before any offset that read them is saved.
    fn flush(&mut self) -> Result<(), TokenLedgerError> {
        if self.pending.is_empty() {
            return Ok(());
        }
        private_journal_directory(&self.dir)?;
        let mut created = false;
        let dates: Vec<String> = self.pending.keys().cloned().collect();
        for date in dates {
            let mut options = OpenOptions::new();
            options.append(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let mut handle = options.open(self.file(&date))?;
            let stat = handle.metadata()?;
            if !stat.is_file() {
                return Err(TokenLedgerError::SeenInvalid);
            }
            let whole = stat.len() - stat.len() % HASH_BYTES as u64;
            // A torn append from a crash is cut off.
            if whole != stat.len() {
                handle.set_len(whole)?;
            }
            let hashes = &self.pending[&date];
            handle.write_all(&hashes.concat())?;
            handle.sync_all()?;
            created |= whole == 0;
            let length = whole + (hashes.len() * HASH_BYTES) as u64;
            self.bytes.insert(date.clone(), length);
            drop(handle);
            self.pending.shift_remove(&date);
        }
        if created {
            sync_directory(&self.dir)?;
        }
        Ok(())
    }

    /// Cut each day's file back to the length the saved ledger knew, and make it private again.
    /// Hashes past that length belong to rows whose counts were lost with an unsaved ledger;
    /// those rows are read again from the saved offsets, and count again, once. False when the
    /// files cannot be trusted, or when a day the ledger saved hashes for has no file: its
    /// copies would count again.
    fn restore(&mut self, saved: &Map<String, Value>) -> bool {
        let expected: Vec<&String> = saved
            .iter()
            .filter(|(date, length)| is_date(date) && amount(Some(length)) > 0.0)
            .map(|(date, _)| date)
            .collect();
        let listed = (|| -> io::Result<Option<Vec<String>>> {
            let info = fs::symlink_metadata(&self.dir)?;
            if !info.is_dir() || info.is_symlink() {
                return Ok(None);
            }
            let mut names = Vec::new();
            for entry in fs::read_dir(&self.dir)? {
                names.push(entry?.file_name().to_string_lossy().into_owned());
            }
            // libuv's scandir lists names sorted.
            names.sort();
            Ok(Some(names))
        })();
        let names = match listed {
            Ok(Some(names)) => names,
            Ok(None) => return false,
            Err(error) => return is_not_found(&error) && expected.is_empty(),
        };
        let mut found: IndexMap<String, ()> = IndexMap::new();
        for name in &names {
            if let Some(date) = seen_file_date(name) {
                found.insert(date.to_string(), ());
            }
        }
        if !expected
            .iter()
            .all(|date| found.contains_key(date.as_str()))
        {
            return false;
        }
        found
            .keys()
            .all(|date| self.restore_day(date, amount(saved.get(date.as_str()))))
    }

    fn restore_day(&mut self, date: &str, saved: f64) -> bool {
        let file = self.file(date);
        let result = (|| -> io::Result<bool> {
            let info = fs::symlink_metadata(&file)?;
            if !info.is_file() {
                return Ok(false);
            }
            let length = saved.min(info.len() as f64);
            let keep = length - length % HASH_BYTES as f64;
            if keep == 0.0 {
                fs::remove_file(&file)?;
                return Ok(true);
            }
            let keep = keep as u64;
            if info.len() > keep {
                OpenOptions::new().write(true).open(&file)?.set_len(keep)?;
            }
            set_mode(&file, 0o600)?;
            self.bytes.insert(date, keep);
            Ok(true)
        })();
        result.unwrap_or_else(|error| is_not_found(&error) && saved == 0.0)
    }

    fn file(&self, date: &str) -> PathBuf {
        self.dir.join(format!("{date}.bin"))
    }

    fn day(&mut self, date: &str) -> Result<&mut HashSet<Hash>, TokenLedgerError> {
        let set = match self.loaded.shift_remove(date) {
            Some(set) => set,
            None => {
                let set = self.read(date)?;
                if self.loaded.len() >= SEEN_DAYS_IN_MEMORY {
                    self.loaded.shift_remove_index(0);
                }
                set
            }
        };
        let (index, _) = self.loaded.insert_full(date.to_string(), set);
        self.note_loaded();
        Ok(&mut self.loaded[index])
    }

    /// Only a missing file is an empty day; any other failure fails the tick.
    fn read(&self, date: &str) -> Result<HashSet<Hash>, TokenLedgerError> {
        let mut set = HashSet::new();
        if let Some(data) = self.read_file(date)? {
            for chunk in data.chunks_exact(HASH_BYTES) {
                set.insert(chunk.try_into().expect("8-byte chunk"));
            }
        }
        if let Some(pending) = self.pending.get(date) {
            set.extend(pending.iter().copied());
        }
        Ok(set)
    }

    fn read_file(&self, date: &str) -> Result<Option<Vec<u8>>, TokenLedgerError> {
        match fs::symlink_metadata(&self.dir) {
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(info) if !info.is_dir() || info.is_symlink() => {
                return Err(TokenLedgerError::SeenInvalid);
            }
            Ok(_) => {}
        }
        let mut handle = match open_read(&self.file(date)) {
            Err(error) if is_not_found(&error) => return Ok(None),
            other => other?,
        };
        if !handle.metadata()?.is_file() {
            return Err(TokenLedgerError::SeenInvalid);
        }
        let mut data = Vec::new();
        handle.read_to_end(&mut data)?;
        Ok(Some(data))
    }
}

fn restore_last(value: Option<&Value>) -> Option<LastResponse> {
    let value = value?.as_object()?;
    let date = value.get("date")?.as_str().filter(|date| is_date(date))?;
    let who = value.get("who")?.as_str()?;
    let model = value.get("model")?.as_str()?;
    let input = amount(value.get("input"));
    let output = amount(value.get("output"));
    let cache_write = amount(value.get("cacheWrite"));
    let cache_read = amount(value.get("cacheRead"));
    // A response saved before costs were kept is taken as priced at its estimate.
    let cost = match value.get("cost").and_then(Value::as_f64) {
        Some(cost) if cost.is_finite() => cost.max(-1.0),
        _ => estimate_cost(
            model,
            &model_prices::TokenCounts {
                input,
                output,
                cache_write,
                cache_read,
            },
        )
        .unwrap_or(-1.0),
    };
    // `SLOT.test(String(value.slot))`: an integer 0–95.
    let slot = value
        .get("slot")
        .and_then(Value::as_f64)
        .filter(|slot| slot.fract() == 0.0 && (0.0..=95.0).contains(slot))
        .map(|slot| slot as u32);
    Some(LastResponse {
        date: date.to_string(),
        who: who.to_string(),
        model: model.to_string(),
        input,
        output,
        cache_write,
        cache_read,
        cost,
        slot,
    })
}

fn restore_file(value: &Value) -> Option<FileState> {
    let value = value.as_object()?;
    let number = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    let (dev, ino, size, offset, mtime_ms) = (
        number("dev")?,
        number("ino")?,
        number("size")?,
        number("offset")?,
        number("mtimeMs")?,
    );
    let last_key = value
        .get("lastKey")
        .and_then(Value::as_str)
        .map(str::to_string);
    let last = if last_key.is_some() {
        restore_last(value.get("last"))
    } else {
        None
    };
    Some(FileState {
        dev,
        ino,
        size,
        offset,
        mtime_ms,
        last_key,
        last,
        broken: value.get("broken") == Some(&Value::Bool(true)),
    })
}

/// A row's field as far as the ledger reads it: a string, or any other JSON value.
#[derive(Debug, PartialEq)]
enum Field {
    Str(String),
    Other,
}

impl Field {
    fn as_str(field: &Option<Field>) -> Option<&str> {
        match field {
            Some(Field::Str(text)) => Some(text),
            _ => None,
        }
    }
}

/// Visitor methods taking any non-string, non-object JSON value as `$value`.
macro_rules! accept_other {
    ($value:expr) => {
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok($value)
        }
    };
}

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldVisitor;
        impl<'de> Visitor<'de> for FieldVisitor {
            type Value = Field;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any JSON value")
            }
            accept_other!(Field::Other);
            fn visit_str<E: de::Error>(self, text: &str) -> Result<Field, E> {
                Ok(Field::Str(text.to_string()))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Field, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Field::Other)
            }
        }
        deserializer.deserialize_any(FieldVisitor)
    }
}

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "camelCase")]
enum RowKey {
    Type,
    Message,
    Timestamp,
    RequestId,
    Entrypoint,
    SessionId,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "camelCase")]
enum MessageKey {
    Id,
    Model,
    Usage,
    #[serde(other)]
    Other,
}

/// The parts of an assistant message the ledger reads; its content is skipped unparsed.
#[derive(Debug, Default)]
struct Message {
    id: Option<Field>,
    model: Option<Field>,
    usage: Option<Value>,
}

/// `row.message`: `None` when it is not an object.
struct MessageSlot(Option<Message>);

impl<'de> Deserialize<'de> for MessageSlot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MessageVisitor;
        impl<'de> Visitor<'de> for MessageVisitor {
            type Value = MessageSlot;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any JSON value")
            }
            accept_other!(MessageSlot(None));
            fn visit_str<E: de::Error>(self, _: &str) -> Result<MessageSlot, E> {
                Ok(MessageSlot(None))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<MessageSlot, A::Error> {
                let mut message = Message::default();
                while let Some(key) = map.next_key::<MessageKey>()? {
                    match key {
                        MessageKey::Id => message.id = Some(map.next_value()?),
                        MessageKey::Model => message.model = Some(map.next_value()?),
                        MessageKey::Usage => message.usage = Some(map.next_value()?),
                        MessageKey::Other => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(MessageSlot(Some(message)))
            }
        }
        deserializer.deserialize_any(MessageVisitor)
    }
}

/// The parts of a transcript row the ledger reads; a row that is not an object fails to parse.
#[derive(Default)]
struct Row {
    kind: Option<Field>,
    message: Option<Message>,
    timestamp: Option<Field>,
    request_id: Option<Field>,
    entrypoint: Option<Field>,
    session_id: Option<Field>,
}

impl<'de> Deserialize<'de> for Row {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RowVisitor;
        impl<'de> Visitor<'de> for RowVisitor {
            type Value = Row;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Row, A::Error> {
                let mut row = Row::default();
                while let Some(key) = map.next_key::<RowKey>()? {
                    match key {
                        RowKey::Type => row.kind = Some(map.next_value()?),
                        RowKey::Message => row.message = map.next_value::<MessageSlot>()?.0,
                        RowKey::Timestamp => row.timestamp = Some(map.next_value()?),
                        RowKey::RequestId => row.request_id = Some(map.next_value()?),
                        RowKey::Entrypoint => row.entrypoint = Some(map.next_value()?),
                        RowKey::SessionId => row.session_id = Some(map.next_value()?),
                        RowKey::Other => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(row)
            }
        }
        deserializer.deserialize_map(RowVisitor)
    }
}

/// What a line is counted into, apart from the transcript's own state.
struct Counter {
    attribute: AttributeFn,
    days: LedgerDays,
    slots: LedgerSlots,
    seen: SeenDays,
}

impl Counter {
    /// Count one complete line. A response streams as several contiguous rows with one id pair
    /// and a usage that only grows: the first row is counted, and each later one adds what grew,
    /// to the same bucket.
    fn line(
        &mut self,
        state: &mut FileState,
        bytes: &[u8],
        profile_account_id: Option<&str>,
        tick: &Tick,
    ) -> Result<(), TokenLedgerError> {
        if memchr::memmem::find(bytes, b"\"usage\"").is_none()
            || memchr::memmem::find(bytes, b"\"assistant\"").is_none()
        {
            return Ok(());
        }
        // `Buffer.toString("utf8")`: bad bytes become U+FFFD.
        let text = String::from_utf8_lossy(bytes);
        let Ok(row) = serde_json::from_str::<Row>(&text) else {
            return Ok(());
        };
        if Field::as_str(&row.kind) != Some("assistant") {
            return Ok(());
        }
        let Some(message) = &row.message else {
            return Ok(());
        };
        let Some(raw) = message.usage.as_ref().and_then(Value::as_object) else {
            return Ok(());
        };
        let model_field = Field::as_str(&message.model);
        if model_field == Some(SYNTHETIC_MODEL) {
            return Ok(());
        }
        let Some(id) = Field::as_str(&message.id) else {
            return Ok(());
        };
        let request_id = Field::as_str(&row.request_id).filter(|id| is_id(id));
        // Ids out of shape are counted without being deduplicated.
        let key = match request_id {
            Some(request_id) if is_id(id) => Some(format!("{id}:{request_id}")),
            _ => None,
        };
        let time = Field::as_str(&row.timestamp).map_or(f64::NAN, date_parse);
        if !time.is_finite() {
            return Ok(());
        }
        let usage = usage_of(raw);
        if key.is_some() && key == state.last_key {
            let Some(last) = state.last.as_mut() else {
                return Ok(());
            };
            if last.date < tick.cutoff {
                return Ok(());
            }
            let counts = bucket(&mut self.days, &last.date, &last.who, &last.model);
            let mut slot = match last.slot {
                Some(slot) if last.date >= tick.slot_cutoff => {
                    Some(slot_bucket(&mut self.slots, &last.date, &last.who, slot))
                }
                _ => None,
            };
            let before = tokens_of(&last.usage());
            for (i, (field, kept)) in counts_fields(counts)
                .into_iter()
                .zip(last.fields())
                .enumerate()
            {
                if usage.0[i] > *kept {
                    let grew = usage.0[i] - *kept;
                    *field += grew;
                    if let Some(slot) = slot.as_deref_mut() {
                        *slot_fields(slot)[i] += grew;
                    }
                    *kept = usage.0[i];
                }
            }
            if last.cost < 0.0 {
                counts.unpriced =
                    Some(counts.unpriced.unwrap_or(0.0) + tokens_of(&last.usage()) - before);
                return Ok(());
            }
            // The row's whole cost, less what its earlier rows added.
            let cost = cost_of(&last.model, &last.usage(), raw);
            if cost > last.cost {
                counts.cost = Some(counts.cost.unwrap_or(0.0) + cost - last.cost);
                if let Some(slot) = slot {
                    slot.cost += cost - last.cost;
                }
                last.cost = cost;
            }
            return Ok(());
        }
        let date = local_date(time, &tick.zone);
        let skip = |state: &mut FileState, key: Option<String>| {
            state.last_key = key;
            state.last = None;
        };
        if date < tick.cutoff {
            skip(state, key);
            return Ok(());
        }
        // A copy keeps its timestamp, so it is on the same day as the original.
        let hash = key.as_deref().map(hash_of);
        if let Some(hash) = &hash
            && self.seen.has(&date, hash)?
        {
            skip(state, key);
            return Ok(());
        }
        let who = who_of(&(self.attribute)(&AttributionRow {
            time,
            entrypoint: Field::as_str(&row.entrypoint),
            profile_account_id,
            session_id: Field::as_str(&row.session_id),
            request_id,
        }));
        let model = model_field
            .filter(|model| !model.is_empty() && js_length(model) <= MAX_MODEL_LENGTH)
            .unwrap_or("unknown");
        let counts = bucket(&mut self.days, &date, &who, model);
        for (field, value) in counts_fields(counts).into_iter().zip(usage.0) {
            *field += value;
        }
        counts.responses += 1.0;
        let cost = cost_of(model, &usage, raw);
        if cost < 0.0 {
            counts.unpriced = Some(counts.unpriced.unwrap_or(0.0) + tokens_of(&usage));
        } else {
            counts.cost = Some(counts.cost.unwrap_or(0.0) + cost);
        }
        let mut slot = None;
        if date >= tick.slot_cutoff {
            let quarter = local_slot(time, &tick.zone) as u32;
            slot = Some(quarter);
            let into = slot_bucket(&mut self.slots, &date, &who, quarter);
            for (field, value) in slot_fields(into).into_iter().zip(usage.0) {
                *field += value;
            }
            if cost > 0.0 {
                into.cost += cost;
            }
        }
        let (Some(key), Some(hash)) = (key, hash) else {
            state.last_key = None;
            state.last = None;
            return Ok(());
        };
        state.last_key = Some(key);
        let [input, output, cache_write, cache_read] = usage.0;
        state.last = Some(LastResponse {
            date: date.clone(),
            who,
            model: model.to_string(),
            input,
            output,
            cache_write,
            cache_read,
            cost,
            slot,
        });
        self.seen.add(&date, hash)
    }
}

/// Counts the tokens of Claude Code responses from transcript JSONL files, by day, account and
/// model. Transcripts are append-only and add up to gigabytes, so each file is read once: its
/// offset is persisted with the counts, and a later tick reads only what was appended. A tick
/// works within a time budget; a first scan spreads over many ticks and resumes after a
/// restart. Only counts, model names, dates, ids and hashed file keys are kept; never
/// transcript text or paths.
pub struct TokenLedger {
    file: PathBuf,
    roots: Vec<TokenRoot>,
    zone: Box<dyn FnMut() -> String + Send>,
    now: Box<dyn FnMut() -> f64 + Send>,
    budget_ms: f64,
    max_age_days: f64,
    max_bytes: u64,
    /// By `file_key` of the transcript's path.
    files: JsMap<FileState>,
    counter: Counter,
    slots_since: Option<f64>,
    priced_at: Option<f64>,
    /// The zone `days` are in; `None` until the first tick names one.
    bucket_zone: Option<String>,
    /// The seen files could not be trusted: empty everything before counting.
    must_start_over: bool,
    dirty: bool,
    last_persist: f64,
    /// A full pass has finished since the counts were last emptied, so they are whole up to it;
    /// saved with them. A later pass may span ticks meanwhile.
    pass_complete_since_start: bool,
    /// The last save failed.
    persist_failed: bool,
    pass: Option<Pass>,
    cursor: Option<Cursor>,
    chunk: Vec<u8>,
}

impl TokenLedger {
    pub fn new(options: TokenLedgerOptions) -> Self {
        let seen = SeenDays::new(dirname(&options.file).join("token-ledger-seen"));
        let mut ledger = TokenLedger {
            file: options.file,
            roots: options.roots,
            zone: options.zone,
            now: options
                .now
                .unwrap_or_else(|| Box::new(|| crate::clock::now_ms() as f64)),
            budget_ms: options.budget_ms.unwrap_or(200.0),
            max_age_days: options.max_age_days.unwrap_or(90.0),
            max_bytes: options.max_bytes.unwrap_or(LEDGER_MAX_BYTES),
            files: JsMap::new(),
            counter: Counter {
                attribute: options.attribute,
                days: JsMap::new(),
                slots: JsMap::new(),
                seen,
            },
            slots_since: None,
            priced_at: None,
            bucket_zone: None,
            must_start_over: false,
            dirty: false,
            last_persist: f64::NEG_INFINITY,
            pass_complete_since_start: false,
            persist_failed: false,
            pass: None,
            cursor: None,
            chunk: Vec::new(),
        };
        ledger.load();
        ledger
    }

    /// Add a transcript root; the roots are walked in the order added.
    pub fn add_root(&mut self, root: TokenRoot) {
        self.roots.push(root);
    }

    pub fn roots(&self) -> &[TokenRoot] {
        &self.roots
    }

    /// For tests: how many days of seen hashes are in memory.
    pub fn seen_days_in_memory(&self) -> usize {
        self.counter.seen.in_memory.load(Ordering::Relaxed)
    }

    /// For tests: `seen_days_in_memory`, readable while a tick runs (from `attribute`).
    pub fn seen_days_gauge(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.counter.seen.in_memory)
    }

    pub fn snapshot(&self) -> LedgerSnapshot {
        let mut scanned_bytes = 0.0;
        let mut total_bytes = 0.0;
        for state in self.files.values() {
            if state.broken {
                continue;
            }
            scanned_bytes += state.offset;
            total_bytes += state.size;
        }
        LedgerSnapshot {
            days: self.counter.days.clone(),
            slots: Some(self.counter.slots.clone()),
            slots_since: self.slots_since,
            progress: LedgerProgress {
                scanned_bytes,
                total_bytes,
                complete: self.pass_complete_since_start,
                error: self.persist_failed.then_some(true),
            },
        }
    }

    /// One budgeted step of a pass; resumable. `complete` says whether this tick finished the
    /// pass. (The TS shares overlapping calls; `&mut self` rules them out here.)
    pub fn tick(&mut self) -> Result<TickResult, TokenLedgerError> {
        let started = (self.now)();
        let zone = (self.zone)();
        // An invalid zone fails here, before anything is read.
        if !valid_time_zone(&zone) {
            return Err(TokenLedgerError::InvalidZone(zone));
        }
        let tick = Tick {
            started,
            deadline: started + self.budget_ms,
            cutoff: local_date(started - KEEP_DAYS * DAY_MS, &zone),
            slot_cutoff: local_date(started - (SLOT_DAYS - 1.0) * DAY_MS, &zone),
            zone,
        };
        if self.must_start_over || self.bucket_zone.as_ref().is_some_and(|z| *z != tick.zone) {
            self.start_over(&tick.zone)?;
        } else if self.bucket_zone.is_none() {
            self.bucket_zone = Some(tick.zone.clone());
            self.dirty = true;
        }
        if self.slots_since.is_none() {
            self.slots_since = Some(started);
            self.dirty = true;
        }
        let mut pass = self.pass.take().unwrap_or_else(|| Pass {
            dirs: self
                .roots
                .iter()
                .enumerate()
                .rev()
                .map(|(root, at)| PassDir {
                    dir: at.dir.clone(),
                    depth: 0,
                    root,
                })
                .collect(),
            ..Pass::default()
        });
        let stepped = self.steps(&mut pass, &tick);
        let complete = !pass.remaining();
        self.pass = Some(pass);
        stepped?;
        if complete {
            self.pass = None;
            if !self.pass_complete_since_start {
                self.pass_complete_since_start = true;
                self.dirty = true;
            }
        }
        self.prune(&tick);
        // The hashes reach the disk before any offset that read them.
        self.counter.seen.flush()?;
        if self.dirty && (complete || (self.now)() - self.last_persist >= PERSIST_EVERY_MS) {
            // Counting goes on in memory; the progress says the ledger is unsaved, and the save
            // is tried again later.
            let _ = self.persist();
        }
        Ok(TickResult { complete })
    }

    /// At least one step per tick, so a tiny budget still makes progress.
    fn steps(&mut self, pass: &mut Pass, tick: &Tick) -> Result<(), TokenLedgerError> {
        while pass.remaining() {
            if let Some(at) = pass.dirs.pop() {
                self.visit(pass, at, tick);
            } else if self.read(&pass.files[pass.next], tick)? {
                pass.next += 1;
            }
            if (self.now)() >= tick.deadline {
                break;
            }
        }
        Ok(())
    }

    /// Empty the counts, offsets and seen files together. The empty ledger is saved before the
    /// seen files go: loading it after a crash in between deletes them anyway. Until this
    /// succeeds, every tick tries it again.
    fn start_over(&mut self, zone: &str) -> Result<(), TokenLedgerError> {
        self.must_start_over = true;
        self.pass_complete_since_start = false;
        self.files = JsMap::new();
        self.counter.days = JsMap::new();
        // The rescan reads every kept day again, so their slots come back whole.
        self.counter.slots = JsMap::new();
        self.slots_since = Some(0.0);
        self.pass = None;
        self.cursor = None;
        self.bucket_zone = Some(zone.to_string());
        self.counter.seen.forget();
        self.persist()?;
        self.counter.seen.remove_all()?;
        self.must_start_over = false;
        Ok(())
    }

    /// List one directory: transcripts to read, and directories to list.
    fn visit(&mut self, pass: &mut Pass, at: PassDir, tick: &Tick) {
        let listed = (|| -> io::Result<Vec<(String, PathBuf, fs::FileType)>> {
            let mut entries = Vec::new();
            for entry in fs::read_dir(&at.dir)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                let name = entry.file_name().to_string_lossy().into_owned();
                entries.push((name, entry.path(), kind));
            }
            Ok(entries)
        })();
        let Ok(mut entries) = listed else {
            return;
        };
        entries.sort_by(|a, b| compare_str(&a.0, &b.0).total_cmp(&0.0));
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        // Symlinks are neither files nor directories here, so they are skipped.
        for (name, full, kind) in entries {
            if kind.is_dir() {
                if at.depth + 1 < MAX_DEPTH && name != "tool-results" {
                    dirs.push(PassDir {
                        dir: full,
                        depth: at.depth + 1,
                        root: at.root,
                    });
                }
            } else if kind.is_file() && name.ends_with(".jsonl") {
                files.push(full);
            }
        }
        pass.dirs.extend(dirs.into_iter().rev());
        for file in files {
            let Ok(stat) = Stat::lstat(&file) else {
                continue;
            };
            let key = file_key(&file);
            if self.observe(&key, &stat, tick.started) {
                pass.files.push(PassFile {
                    file,
                    key,
                    root: at.root,
                });
            }
        }
    }

    /// Track a transcript found on disk; whether it has anything to read.
    fn observe(&mut self, key: &str, stat: &Stat, now: f64) -> bool {
        if !stat.is_file {
            return false;
        }
        let Some(state) = self.files.get_mut(key) else {
            if stat.mtime_ms < now - self.max_age_days * DAY_MS {
                return false;
            }
            self.files.insert(
                key,
                FileState {
                    dev: stat.dev,
                    ino: stat.ino,
                    size: stat.size,
                    offset: 0.0,
                    mtime_ms: stat.mtime_ms,
                    last_key: None,
                    last: None,
                    broken: false,
                },
            );
            self.dirty = true;
            return true;
        };
        if state.mtime_ms != stat.mtime_ms {
            state.mtime_ms = stat.mtime_ms;
            self.dirty = true;
        }
        if state.broken {
            // A ledger before 0.17.2 broke every file whose device number a remount changed;
            // such a file is the same transcript, read on from its offset.
            if stat.dev == state.dev || !same_transcript(state, stat) {
                return false;
            }
            state.broken = false;
            self.dirty = true;
        }
        if !same_transcript(state, stat) {
            state.broken = true;
            self.dirty = true;
            return false;
        }
        if adopt_device(state, stat) {
            self.dirty = true;
        }
        if stat.size != state.size {
            state.size = stat.size;
            self.dirty = true;
        }
        true
    }

    /// Read a transcript from its offset; false when the budget paused it. A transcript that
    /// cannot be opened, inspected or read is left for the next pass, so one bad file never
    /// stalls the scan.
    fn read(&mut self, entry: &PassFile, tick: &Tick) -> Result<bool, TokenLedgerError> {
        let cursor = self
            .cursor
            .take()
            .filter(|cursor| cursor.file == entry.file);
        let Some(state) = self.files.get_mut(&entry.key) else {
            return Ok(true);
        };
        if state.broken || (cursor.is_none() && state.offset >= state.size) {
            return Ok(true);
        }
        let Ok(handle) = open_read(&entry.file) else {
            return Ok(true);
        };
        let Ok(stat) = Stat::fstat(&handle) else {
            return Ok(true);
        };
        if !stat.is_file {
            return Ok(true);
        }
        if !same_transcript(state, &stat) {
            state.broken = true;
            self.dirty = true;
            return Ok(true);
        }
        if adopt_device(state, &stat) {
            self.dirty = true;
        }
        if stat.size != state.size {
            state.size = stat.size;
            self.dirty = true;
        }
        let resume = cursor.filter(|cursor| {
            cursor.position as f64 <= stat.size
                && cursor.position as f64 - cursor.line_bytes as f64 == state.offset
        });
        let (mut position, mut pending, mut line_bytes) = match resume {
            Some(cursor) => (cursor.position, cursor.pending, cursor.line_bytes),
            None => (state.offset as u64, Vec::new(), 0),
        };
        let profile_account_id = self
            .roots
            .get(entry.root)
            .and_then(|root| root.profile_account_id.clone());
        if self.chunk.is_empty() {
            self.chunk = vec![0; CHUNK_BYTES];
        }
        let size = stat.size as u64;
        while position < size {
            let want = CHUNK_BYTES.min((size - position) as usize);
            let Ok(bytes_read) = read_at(&handle, &mut self.chunk[..want], position) else {
                return Ok(true);
            };
            if bytes_read == 0 {
                break;
            }
            position += bytes_read as u64;
            let view = &self.chunk[..bytes_read];
            let mut start = 0;
            while let Some(found) = memchr::memchr(b'\n', &view[start..]) {
                let end = start + found;
                let length = line_bytes + end - start;
                // Oversized lines are skipped without parsing.
                if length <= MAX_LINE_BYTES {
                    let tail = &view[start..end];
                    let line = if pending.is_empty() {
                        tail
                    } else {
                        pending.extend_from_slice(tail);
                        &pending[..]
                    };
                    self.counter
                        .line(state, line, profile_account_id.as_deref(), tick)?;
                }
                state.offset += (length + 1) as f64;
                self.dirty = true;
                pending.clear();
                line_bytes = 0;
                start = end + 1;
            }
            // A line with no newline yet stays unconsumed: offset stops before it.
            if start < view.len() {
                line_bytes += view.len() - start;
                if line_bytes <= MAX_LINE_BYTES {
                    pending.extend_from_slice(&view[start..]);
                } else {
                    pending.clear();
                }
            }
            if position < size && (self.now)() >= tick.deadline {
                self.cursor = Some(Cursor {
                    file: entry.file.clone(),
                    position,
                    pending,
                    line_bytes,
                });
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Drop days older than 120 days with their seen hashes, and the state of files last
    /// written well before that. Such a file is skipped as too old if seen again, and if it was
    /// written to since, its old rows fall on dropped days, so nothing re-counts. A file read to
    /// its end and idle for 2 days keeps no last response; a copy of it found later is a seen
    /// hash anyway.
    fn prune(&mut self, tick: &Tick) {
        let mut dirty = false;
        self.counter.days.retain(|date, _| {
            let keep = *date >= tick.cutoff;
            dirty |= !keep;
            keep
        });
        self.counter.slots.retain(|date, _| {
            let keep = *date >= tick.slot_cutoff;
            dirty |= !keep;
            keep
        });
        for date in self.counter.seen.dates() {
            if date < tick.cutoff {
                self.counter.seen.drop_day(&date);
                dirty = true;
            }
        }
        let forget_before = tick.started - (self.max_age_days.max(KEEP_DAYS) + 2.0) * DAY_MS;
        let idle_before = tick.started - IDLE_MS;
        self.files.retain(|_, state| {
            if state.mtime_ms < forget_before {
                dirty = true;
                return false;
            }
            if state.last_key.is_some()
                && state.mtime_ms < idle_before
                && state.offset >= state.size
            {
                state.last_key = None;
                state.last = None;
                dirty = true;
            }
            true
        });
        self.dirty |= dirty;
    }

    /// Save the counts with the offsets; fails, and says so in the progress, when it cannot.
    fn persist(&mut self) -> Result<(), TokenLedgerError> {
        let saved = Saved {
            version: LEDGER_VERSION,
            zone: self.bucket_zone.as_deref(),
            complete: self.pass_complete_since_start,
            files: &self.files,
            days: &self.counter.days,
            slots: &self.counter.slots,
            slots_since: self.slots_since,
            priced_at: self.priced_at,
            seen: &self.counter.seen.bytes,
        };
        self.last_persist = (self.now)();
        if let Err(error) = write_private_json(&self.file, &saved, self.max_bytes) {
            self.persist_failed = true;
            return Err(error.into());
        }
        self.persist_failed = false;
        self.dirty = false;
        self.counter.seen.remove_dropped();
        Ok(())
    }

    /// A ledger that cannot be read starts empty, and so do the seen hashes, or the rescan would
    /// find every response already seen; so does one of another version, such as version 1
    /// keyed by paths. Seen files that cannot be trusted empty the ledger too, on the first
    /// tick.
    fn load(&mut self) {
        let value = match read_private_json(&self.file, self.max_bytes) {
            Ok(Value::Object(saved))
                if saved.get("version").and_then(Value::as_f64)
                    == Some(f64::from(LEDGER_VERSION)) =>
            {
                saved
            }
            // No ledger yet, or an unreadable one.
            _ => Map::new(),
        };
        if let Some(zone) = value.get("zone").and_then(Value::as_str) {
            self.bucket_zone = Some(zone.to_string());
        }
        // Costs start now; buckets restored below without one are estimated.
        let priced = finite(value.get("pricedAt"));
        self.priced_at = Some(priced.unwrap_or_else(|| (self.now)()));
        if priced.is_none() {
            self.dirty = true;
        }
        let empty = Map::new();
        let seen = value
            .get("seen")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        if !self.counter.seen.restore(seen) {
            self.must_start_over = true;
            self.counter.seen.forget();
            return;
        }
        self.pass_complete_since_start = value.get("complete") == Some(&Value::Bool(true));
        if let Some(files) = value.get("files").and_then(Value::as_object) {
            for (key, raw) in files {
                if is_file_key(key)
                    && let Some(state) = restore_file(raw)
                {
                    self.files.insert(key.as_str(), state);
                }
            }
        }
        if let Some(days) = value.get("days").and_then(Value::as_object) {
            for (date, by_who) in days {
                let Some(by_who) = by_who.as_object().filter(|_| is_date(date)) else {
                    continue;
                };
                for (who, by_model) in by_who {
                    let Some(by_model) = by_model.as_object() else {
                        continue;
                    };
                    for (model, raw) in by_model {
                        let Some(raw) = raw.as_object() else {
                            continue;
                        };
                        let counts = bucket(&mut self.counter.days, date, who, model);
                        for (field, name) in counts_fields(counts).into_iter().zip([
                            "input",
                            "output",
                            "cacheWrite",
                            "cacheRead",
                        ]) {
                            *field += amount(raw.get(name));
                        }
                        counts.responses += amount(raw.get("responses"));
                        counts.cost = Some(counts.cost.unwrap_or(0.0) + amount(raw.get("cost")));
                        counts.unpriced =
                            Some(counts.unpriced.unwrap_or(0.0) + amount(raw.get("unpriced")));
                        if raw.get("costEstimated") == Some(&Value::Bool(true)) {
                            counts.cost_estimated = Some(true);
                        }
                        if priced.is_none() {
                            price_old_bucket(model, counts);
                        }
                    }
                }
            }
        }
        if priced.is_some()
            && let Some(slots) = value.get("slots").and_then(Value::as_object)
        {
            for (date, by_who) in slots {
                let Some(by_who) = by_who.as_object().filter(|_| is_date(date)) else {
                    continue;
                };
                for (who, by_slot) in by_who {
                    let Some(by_slot) = by_slot.as_object() else {
                        continue;
                    };
                    for (slot, raw) in by_slot {
                        let Some(raw) = raw.as_object().filter(|_| is_slot(slot)) else {
                            continue;
                        };
                        let quarter = slot.parse().expect("a slot is 0-95");
                        let counts = slot_bucket(&mut self.counter.slots, date, who, quarter);
                        for (field, name) in slot_fields(counts).into_iter().zip([
                            "input",
                            "output",
                            "cacheWrite",
                            "cacheRead",
                        ]) {
                            *field += amount(raw.get(name));
                        }
                        counts.cost += amount(raw.get("cost"));
                    }
                }
            }
        }
        let since = finite(value.get("slotsSince"));
        if let (Some(_), Some(since)) = (priced, since) {
            self.slots_since = Some(since);
        } else if value.get("version").and_then(Value::as_f64) != Some(f64::from(LEDGER_VERSION)) {
            // No ledger yet: the first scan reads every kept day, so their slots come whole.
            self.slots_since = Some(0.0);
        }
    }
}
