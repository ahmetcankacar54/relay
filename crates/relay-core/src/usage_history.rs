//! Port of `electron/core/usage-history.ts`: the ledger of verified usage samples
//! (`usage-history.jsonl`, 14 days) and its 90-day hourly rollups (`usage-rollups.json`).
//!
//! The ledger contains only verified quota metadata, never messages or tokens. Each sample is
//! appended to usage-history.jsonl as one line, without an fsync; compaction rewrites the file
//! atomically with the 14-day window. A line a crash cut short, or one that is not a valid
//! sample, is skipped. A ledger whose lines hold no sample at all, or that cannot be read
//! safely, stays unavailable rather than silently overwriting it. usage-history.json, the
//! ledger before 0.11, is merged in once and kept as usage-history.json.migrated. Rollups keep
//! 90 days of hourly aggregates beside the 14-day raw ledger; an unreadable rollups file is
//! likewise never overwritten and never affects the raw ledger or live limits. An unavailable
//! raw ledger does not stop the rollups: new samples are still folded and persisted. A failed
//! rollups write keeps the folded state in memory and is retried on the next record; only an
//! unsafe target (symlink or non-file) makes the rollups unavailable.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{Value, json};

use crate::fs_util::{FileId, create_new_private};
use crate::shared::types::js::{date_parse, trim};
use crate::shared::types::{Account, AccountUsage, KnownReset, LastKnownResets};
use crate::shared::usage_rollups::{UsageRollups, catch_up, fold_sample, fold_samples};
use crate::shared::usage_statistics::{
    MAX_USAGE_SAMPLES, USAGE_HISTORY_DAYS, UsageSample, usage_identity, usage_sample,
};
use crate::store::private_dir;
use crate::store::schema::{
    NumberRule, Schema, StringRule, array, datetime, enumeration, literal, number, record, strict,
    string, union,
};

// 50,000 samples of ~340 bytes each, and a day of appends after them, must stay readable
// after they are written.
const MAX_HISTORY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ROLLUPS_BYTES: u64 = 16 * 1024 * 1024;
/// The ledger is rewritten with its retained window at startup and then at most this often.
pub const USAGE_COMPACTION_MS: f64 = 86_400_000.0;
const DAY_MS: f64 = 86_400_000.0;

/// A file operation [`UsageHistory::set_file_fault`] can fail, as the TS tests do by mocking
/// `fs.openSync` (any open of the path) and `fs.renameSync` (a rename onto the path).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOp {
    Open,
    Rename,
}

/// Called before each open and rename with the path concerned; an error fails the operation.
pub type FileFault = Box<dyn Fn(FileOp, &Path) -> io::Result<()> + Send + Sync>;

#[derive(Debug, thiserror::Error)]
enum UsageFileError {
    /// `UnsafeUsageFileError`: a write target that is a symlink or not a file.
    #[error("Invalid usage file.")]
    Unsafe,
    #[error("{0}")]
    Failed(String),
}

impl UsageFileError {
    fn failed(error: impl std::fmt::Display) -> Self {
        UsageFileError::Failed(error.to_string())
    }
}

impl From<io::Error> for UsageFileError {
    fn from(error: io::Error) -> Self {
        UsageFileError::failed(error)
    }
}

type Result<T, E = UsageFileError> = std::result::Result<T, E>;

fn ranged_string(min: usize, max: usize) -> Schema {
    string(StringRule {
        min: Some(min),
        max: Some(max),
        ..Default::default()
    })
}

fn percent() -> Schema {
    number(NumberRule {
        min: Some(0.0),
        max: Some(100.0),
        ..Default::default()
    })
}

fn non_negative(int: bool) -> Schema {
    number(NumberRule {
        int,
        min: Some(0.0),
        ..Default::default()
    })
}

fn identity_key() -> Schema {
    ranged_string(1, 1024)
}

fn sample_schema() -> Schema {
    let window = strict(vec![
        ("usedPercent", percent()),
        ("resetsAt", datetime().optional()),
    ]);
    strict(vec![
        ("accountId", ranged_string(1, 128)),
        ("identity", identity_key()),
        ("checkedAt", datetime()),
        ("fiveHour", window.clone().optional()),
        ("sevenDay", window.optional()),
    ])
    .refine(
        |sample| sample.get("fiveHour").is_some() || sample.get("sevenDay").is_some(),
        "Invalid input",
    )
}

static SAMPLE: LazyLock<Schema> = LazyLock::new(sample_schema);
static HISTORY: LazyLock<Schema> = LazyLock::new(|| {
    strict(vec![
        ("version", literal(json!(1))),
        ("samples", array(sample_schema(), Some(MAX_USAGE_SAMPLES))),
    ])
});
static ROLLUPS: LazyLock<Schema> = LazyLock::new(|| {
    let hour = strict(vec![
        ("points", non_negative(false)),
        ("windows", non_negative(true)),
        ("coveredMinutes", non_negative(false)),
    ]);
    let window_record = strict(vec![("resetAt", datetime()), ("maxPercent", percent())]);
    let hit = strict(vec![
        ("identity", identity_key()),
        ("kind", enumeration(["five-hour", "weekly"])),
        ("at", datetime()),
        ("until", datetime().optional()),
        ("resetAt", datetime().optional()),
    ]);
    strict(vec![
        ("version", union(vec![literal(json!(1)), literal(json!(2))])),
        ("hours", record(identity_key(), record(datetime(), hour))),
        (
            "windows",
            record(identity_key(), array(window_record, None)),
        ),
        ("hits", array(hit, None)),
        ("last", record(identity_key(), sample_schema())),
    ])
});

/// A sample from a value the sample schema accepted.
fn sample_from(value: &Value) -> Option<UsageSample> {
    let parsed = SAMPLE.parse(value).ok()?;
    serde_json::from_value(parsed).ok()
}

fn not_found(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}

pub struct UsageHistory {
    root: PathBuf,
    /// usage-history.jsonl: one sample per line, oldest first.
    file: PathBuf,
    /// usage-history.json, the ledger before 0.11.
    legacy_file: PathBuf,
    rollups_file: PathBuf,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    fault: Option<FileFault>,
    samples: Vec<UsageSample>,
    /// The ledger is readable and writable.
    pub history_available: bool,
    /// When the ledger was last rewritten with its retained window.
    compacted_at: f64,
    rollups_state: Option<UsageRollups>,
    /// In-memory rollups differ from usage-rollups.json.
    rollups_dirty: bool,
    pub rollups_available: bool,
}

impl UsageHistory {
    /// The history in `root`, on the wall clock.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::with_clock(root, || crate::clock::now_ms() as f64)
    }

    pub fn with_clock(
        root: impl Into<PathBuf>,
        now: impl Fn() -> f64 + Send + Sync + 'static,
    ) -> Self {
        let root = root.into();
        let mut history = UsageHistory {
            file: root.join("usage-history.jsonl"),
            legacy_file: root.join("usage-history.json"),
            rollups_file: root.join("usage-rollups.json"),
            root,
            compacted_at: now(),
            now: Box::new(now),
            fault: None,
            samples: Vec::new(),
            history_available: true,
            rollups_state: None,
            rollups_dirty: false,
            rollups_available: true,
        };
        match history.load() {
            Ok(samples) => history.samples = samples,
            Err(_) => history.history_available = false,
        }
        if history.load_rollups().is_err() {
            history.rollups_available = false;
            history.rollups_state = None;
        }
        if history.rollups_dirty {
            history.persist_rollups();
        }
        history
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    /// usage-history.jsonl.
    pub fn file(&self) -> &Path {
        &self.file
    }
    /// usage-history.json, the ledger before 0.11.
    pub fn legacy_file(&self) -> &Path {
        &self.legacy_file
    }
    pub fn rollups_file(&self) -> &Path {
        &self.rollups_file
    }

    /// Fails file operations from now on as `fault` decides; for tests of write failures.
    pub fn set_file_fault(&mut self, fault: FileFault) {
        self.fault = Some(fault);
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    fn check(&self, op: FileOp, path: &Path) -> io::Result<()> {
        self.fault.as_ref().map_or(Ok(()), |fault| fault(op, path))
    }

    fn load_rollups(&mut self) -> Result<()> {
        let value = self.read_private_json_file(&self.rollups_file, MAX_ROLLUPS_BYTES)?;
        let parsed = value
            .map(|value| ROLLUPS.parse(&value).map_err(UsageFileError::failed))
            .transpose()?;
        let version_two = parsed.as_ref().and_then(|p| p["version"].as_f64()) == Some(2.0);
        if let Some(mut parsed) = parsed.filter(|_| version_two) {
            parsed["version"] = json!(2);
            let loaded: UsageRollups =
                serde_json::from_value(parsed).map_err(UsageFileError::failed)?;
            // Catch up samples recorded after the last successful rollups write, and clamp
            // last samples stamped later than now (the clock moved back).
            let samples: &[UsageSample] = if self.history_available {
                &self.samples
            } else {
                &[]
            };
            let state = catch_up(&loaded, samples, self.now());
            self.rollups_dirty = state != loaded;
            self.rollups_state = Some(state);
        } else if !self.history_available {
            return Err(UsageFileError::failed(
                "No readable usage history to backfill from.",
            ));
        } else {
            // Missing, or version 1 (coverage counted differently): rebuild from the raw
            // ledger. Version 1 history beyond the raw 14 days is lost.
            self.rollups_state = Some(fold_samples(&self.samples, self.now()));
            self.rollups_dirty = true;
        }
        Ok(())
    }

    /// The retained samples of the ledger and of one from before 0.11, compacted into
    /// usage-history.jsonl. The old file is set aside only once its samples are written.
    fn load(&mut self) -> Result<Vec<UsageSample>> {
        let appended = self.read_ledger(&self.file)?;
        let legacy = self.read_private_json_file(&self.legacy_file, MAX_HISTORY_BYTES)?;
        if appended.is_none() && legacy.is_none() {
            return Ok(Vec::new());
        }
        let mut all = Vec::new();
        if let Some(legacy) = &legacy {
            let parsed = HISTORY.parse(legacy).map_err(UsageFileError::failed)?;
            all = serde_json::from_value(parsed["samples"].clone())
                .map_err(UsageFileError::failed)?;
        }
        all.extend(appended.unwrap_or_default());
        let samples = self.pruned(all);
        self.compact(&samples)?;
        if legacy.is_some() {
            let mut migrated = self.legacy_file.clone().into_os_string();
            migrated.push(".migrated");
            let migrated = PathBuf::from(migrated);
            // Merged again at the next start on failure: duplicates are dropped.
            if self.check(FileOp::Rename, &migrated).is_ok() {
                let _ = fs::rename(&self.legacy_file, &migrated);
            }
        }
        Ok(samples)
    }

    /// The valid samples of a JSONL ledger; None when it does not exist.
    fn read_ledger(&self, file: &Path) -> Result<Option<Vec<UsageSample>>> {
        let Some(text) = self.read_private_file(file, MAX_HISTORY_BYTES)? else {
            return Ok(None);
        };
        let mut lines: Vec<&str> = text.split('\n').collect();
        // After the last newline: nothing, or a line a crash cut short.
        lines.pop();
        let mut samples = Vec::new();
        let mut complete = 0;
        for line in lines {
            if trim(line).is_empty() {
                continue;
            }
            complete += 1;
            // Not JSON, or not a sample: skipped.
            if let Some(sample) = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| sample_from(&value))
            {
                samples.push(sample);
            }
        }
        // Lines, but not one sample among them: not a ledger to overwrite.
        if complete > 0 && samples.is_empty() {
            return Err(UsageFileError::failed("Invalid usage history."));
        }
        Ok(Some(samples))
    }

    /// Rewrites the ledger atomically with `samples`.
    fn compact(&mut self, samples: &[UsageSample]) -> Result<()> {
        let text: String = samples.iter().map(line_of).collect();
        self.write_private_file(&self.file, &text)?;
        self.compacted_at = self.now();
        Ok(())
    }

    /// Appends one sample as a line; compaction, not each append, makes the file durable.
    fn append(&self, sample: &UsageSample) -> Result<()> {
        private_dir(&self.root).map_err(UsageFileError::failed)?;
        match fs::symlink_metadata(&self.file) {
            Ok(target) if !target.is_file() || target.is_symlink() => {
                return Err(UsageFileError::Unsafe);
            }
            Err(error) if !not_found(&error) => return Err(error.into()),
            _ => {}
        }
        self.check(FileOp::Open, &self.file)?;
        let mut options = OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut handle = options.open(&self.file)?;
        if !handle.metadata()?.is_file() {
            return Err(UsageFileError::Unsafe);
        }
        handle.write_all(line_of(sample).as_bytes())?;
        Ok(())
    }

    /// Adds `sample` in time order and drops what the retention no longer keeps.
    fn insert(&mut self, sample: UsageSample) {
        let at = date_parse(&sample.checked_at);
        let mut index = self.samples.len();
        while index > 0 && date_parse(&self.samples[index - 1].checked_at) > at {
            index -= 1;
        }
        self.samples.insert(index, sample);
        let oldest = self.now() - USAGE_HISTORY_DAYS * DAY_MS;
        let mut drop = self.samples.len().saturating_sub(MAX_USAGE_SAMPLES);
        while drop < self.samples.len() && date_parse(&self.samples[drop].checked_at) < oldest {
            drop += 1;
        }
        if drop > 0 {
            self.samples.drain(..drop);
        }
    }

    fn persist_rollups(&mut self) {
        if !self.rollups_available {
            return;
        }
        let Some(state) = &self.rollups_state else {
            return;
        };
        let written = serde_json::to_string(state)
            .map_err(UsageFileError::failed)
            .and_then(|text| self.write_private_file(&self.rollups_file, &text));
        match written {
            Ok(()) => self.rollups_dirty = false,
            Err(UsageFileError::Unsafe) => {
                self.rollups_available = false;
                self.rollups_state = None;
            }
            Err(_) => self.rollups_dirty = true,
        }
    }

    /// Parsed JSON, or None when the file does not exist.
    fn read_private_json_file(&self, file: &Path, max_bytes: u64) -> Result<Option<Value>> {
        let Some(text) = self.read_private_file(file, max_bytes)? else {
            return Ok(None);
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(UsageFileError::failed)
    }

    /// The file's text, or None when it does not exist.
    fn read_private_file(&self, file: &Path, max_bytes: u64) -> Result<Option<String>> {
        private_dir(&self.root).map_err(UsageFileError::failed)?;
        let metadata = match fs::symlink_metadata(file) {
            Ok(metadata) => metadata,
            Err(error) if not_found(&error) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || metadata.is_symlink() || metadata.len() > max_bytes {
            return Err(UsageFileError::failed("Invalid usage file."));
        }
        let before = FileId::of_path(file)?;
        self.check(FileOp::Open, file)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut handle = options.open(file)?;
        let opened = handle.metadata()?;
        if !opened.is_file() || opened.len() > max_bytes || FileId::of_file(&handle)? != before {
            return Err(UsageFileError::failed("Usage file changed while reading."));
        }
        let mut data = Vec::new();
        handle.read_to_end(&mut data)?;
        // `readFileSync(fd, "utf8")` replaces malformed bytes rather than failing.
        Ok(Some(String::from_utf8_lossy(&data).into_owned()))
    }

    /// Atomic private write that refuses to replace a non-file or symlink.
    fn write_private_file(&self, file: &Path, text: &str) -> Result<()> {
        let mut temporary = file.as_os_str().to_owned();
        temporary.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let temporary = PathBuf::from(temporary);
        let result = (|| -> Result<()> {
            private_dir(&self.root).map_err(UsageFileError::failed)?;
            match fs::symlink_metadata(file) {
                Ok(target) if !target.is_file() || target.is_symlink() => {
                    return Err(UsageFileError::Unsafe);
                }
                Err(error) if !not_found(&error) => return Err(error.into()),
                _ => {}
            }
            self.check(FileOp::Open, &temporary)?;
            let mut handle = create_new_private(&temporary)?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
            drop(handle);
            self.check(FileOp::Rename, file)?;
            fs::rename(&temporary, file)?;
            Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        result
    }

    fn pruned(&self, samples: Vec<UsageSample>) -> Vec<UsageSample> {
        let now = self.now();
        let oldest = now - USAGE_HISTORY_DAYS * DAY_MS;
        let mut seen = HashSet::new();
        let mut kept: Vec<UsageSample> = samples
            .into_iter()
            .filter(|sample| {
                let checked_at = date_parse(&sample.checked_at);
                let key = (
                    sample.account_id.clone(),
                    sample.identity.clone(),
                    checked_at.to_bits(),
                );
                if checked_at < oldest || checked_at > now || seen.contains(&key) {
                    return false;
                }
                seen.insert(key);
                true
            })
            .collect();
        // Stable, as `Array.prototype.sort` is.
        kept.sort_by(|a, b| {
            date_parse(&a.checked_at)
                .partial_cmp(&date_parse(&b.checked_at))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let skip = kept.len().saturating_sub(MAX_USAGE_SAMPLES);
        kept.drain(..skip);
        kept
    }

    pub fn record(&mut self, account: &Account, usage: &AccountUsage) {
        let Some(sample) = usage_sample(account, usage) else {
            return;
        };
        if date_parse(&sample.checked_at) > self.now() {
            return;
        }
        if self.history_available {
            let previous = self
                .samples
                .iter()
                .rev()
                .find(|s| s.account_id == sample.account_id && s.identity == sample.identity);
            if previous.is_some_and(|p| date_parse(&p.checked_at) >= date_parse(&sample.checked_at))
            {
                return;
            }
            self.insert(sample.clone());
            let since_compaction = self.now() - self.compacted_at;
            // A day after the last compaction, or a clock that moved back before it.
            let written = if !(0.0..USAGE_COMPACTION_MS).contains(&since_compaction) {
                let samples = std::mem::take(&mut self.samples);
                let pruned = self.pruned(samples);
                let written = self.compact(&pruned);
                self.samples = pruned;
                written
            } else {
                self.append(&sample)
            };
            if written.is_err() {
                self.history_available = false;
            }
        }
        // The rollups reject duplicate and out-of-order samples on their own.
        if !self.rollups_available {
            return;
        }
        let Some(state) = &self.rollups_state else {
            return;
        };
        let folded = fold_sample(state, &sample, self.now());
        if folded == *state && !self.rollups_dirty {
            return;
        }
        self.rollups_state = Some(folded);
        self.persist_rollups();
    }

    /// Copies of the raw samples checked at or after `since`, oldest first.
    pub fn recent_samples(&self, since: f64) -> Vec<UsageSample> {
        if !self.history_available {
            return Vec::new();
        }
        // The samples are in time order: walk back from the newest.
        let mut first = self.samples.len();
        while first > 0 && date_parse(&self.samples[first - 1].checked_at) >= since {
            first -= 1;
        }
        self.samples[first..].to_vec()
    }

    /// 90-day hourly rollups; None when the rollups file is unavailable.
    pub fn rollups(&self) -> Option<UsageRollups> {
        if !self.rollups_available {
            return None;
        }
        self.rollups_state.clone()
    }

    /// Reset dates survive a cache invalidation, without reviving old quota.
    pub fn last_known_resets(&self, account: &Account) -> Option<LastKnownResets> {
        if !self.history_available {
            return None;
        }
        let identity = usage_identity(account)?;
        let now = self.now();
        let oldest = now - USAGE_HISTORY_DAYS * DAY_MS;
        let mut five_hour: Option<KnownReset> = None;
        let mut seven_day: Option<KnownReset> = None;
        // Runs on every snapshot: the samples are already deduplicated and in time order, so
        // scan back from the newest and stop at the retention.
        for sample in self.samples.iter().rev() {
            if sample.account_id != account.id || sample.identity != identity {
                continue;
            }
            let checked_at = date_parse(&sample.checked_at);
            if checked_at < oldest {
                break;
            }
            if checked_at > now {
                continue;
            }
            let reset = |window: &Option<crate::shared::types::UsageWindow>| {
                let resets_at = window.as_ref()?.resets_at.as_deref()?;
                (!resets_at.is_empty()).then(|| KnownReset {
                    resets_at: resets_at.to_string(),
                    checked_at: sample.checked_at.clone(),
                })
            };
            if five_hour.is_none() {
                five_hour = reset(&sample.five_hour);
            }
            if seven_day.is_none() {
                seven_day = reset(&sample.seven_day);
            }
            if five_hour.is_some() && seven_day.is_some() {
                break;
            }
        }
        if five_hour.is_none() && seven_day.is_none() {
            return None;
        }
        Some(LastKnownResets {
            five_hour,
            seven_day,
        })
    }
}

/// `JSON.stringify(sample) + "\n"`.
fn line_of(sample: &UsageSample) -> String {
    let mut line = serde_json::to_string(sample).expect("samples serialize");
    line.push('\n');
    line
}
