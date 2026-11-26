//! Port of `electron/core/desktop-launch.ts`: whether the claude.ai page of a Claude that Relay
//! started has booted, read from Claude's own main log.
//!
//! Claude writes "Starting app {" as it starts, and "Loaded https://claude.ai (web commit …)" once
//! the page's code runs and reports its build to the app. Until then the window shows only the
//! grey loading skeleton. Relay only reads the log: nothing is written, and a log it cannot read
//! changes nothing.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use chrono::{Local, NaiveDate, TimeZone};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::desktop_processes::ProcessError;
use crate::relay_paths::{Platform, app_data_root};
use crate::shared::types::literal_enum;

/// Claude's line as it starts.
const STARTED: &str = "] Starting app {";
/// The page's report of its build, once its code runs.
static LOADED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\] Loaded https://\S+ \(web commit ").unwrap());
/// How much of the log before a launch must show a page report, so Relay knows its format.
const KNOWN_BYTES: u64 = 4 * 1024 * 1024;
/// The most of the log read after a launch: its end, where the launch is.
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
/// How long a launch may take to log its start before the watch stops waiting for it.
pub const START_MS: i64 = 10_000;
const POLL_MS: u64 = 1_000;
/// Every this many polls the watch checks that Claude still runs.
const RUNNING_EVERY: u32 = 5;
/// How much of the log's end `page_booted` reads: a start logs far less before its page loads.
const TAIL_BYTES: u64 = 2 * 1024 * 1024;

literal_enum!(
    /// How far the last launch in a piece of the log got.
    LaunchProgress { None = "none", Started = "started", Loaded = "loaded" }
);

literal_enum!(
    /// What a watch found: `loaded`, the page booted; `stalled`, Claude started and still runs
    /// but its page never booted in time; `closed`, Claude was quit after it started; `refused`,
    /// Claude exited before it logged its start; `unknown`, no start was logged or Claude's state
    /// could not be read. Only `stalled`, and `refused` for a start that passed switches, are
    /// reasons to start Claude again.
    PageOutcome {
        Loaded = "loaded",
        Stalled = "stalled",
        Closed = "closed",
        Refused = "refused",
        Unknown = "unknown",
    }
);

/// The last start in `text`, and whether its page reported its build after it.
pub fn launch_progress(text: &str) -> LaunchProgress {
    let Some(start) = text.rfind(STARTED) else {
        return LaunchProgress::None;
    };
    if LOADED.is_match(&text[start..]) {
        LaunchProgress::Loaded
    } else {
        LaunchProgress::Started
    }
}

/// Claude's main log and the file it moves a full one to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeLogFiles {
    pub current: PathBuf,
    pub rotated: PathBuf,
}

/// Where Claude Desktop logs: ~/Library/Logs/Claude on macOS, `logs` in its data folder on Linux
/// (~/.config/Claude, or under $XDG_CONFIG_HOME). None where the log is not known (Windows).
pub fn claude_log(
    home: &Path,
    platform: Platform,
    env: &dyn Fn(&str) -> Option<OsString>,
) -> Option<ClaudeLogFiles> {
    let dir = match platform {
        Platform::MacOs => home.join("Library").join("Logs").join("Claude"),
        Platform::Linux => app_data_root(platform, home, env)
            .join("Claude")
            .join("logs"),
        Platform::Windows => return None,
    };
    Some(ClaudeLogFiles {
        current: dir.join("main.log"),
        rotated: dir.join("main1.log"),
    })
}

/// Claude's log on this machine.
pub fn claude_log_here() -> Option<ClaudeLogFiles> {
    claude_log(
        &crate::relay_paths::home_dir(),
        Platform::current(),
        &|key| std::env::var_os(key),
    )
}

fn size_of(file: &Path) -> Option<u64> {
    std::fs::metadata(file).ok().map(|meta| meta.len())
}

/// Bytes `start` to `end` of `file` as text, at most the last MAX_READ_BYTES of them.
fn read_range(file: &Path, start: u64, end: u64) -> io::Result<String> {
    let from = start.max(end.saturating_sub(MAX_READ_BYTES));
    if end <= from {
        return Ok(String::new());
    }
    let mut handle = File::open(file)?;
    handle.seek(SeekFrom::Start(from))?;
    let mut buffer = Vec::with_capacity((end - from) as usize);
    handle.take(end - from).read_to_end(&mut buffer)?;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Where the log ends now, before a launch; None when it cannot be read, or when its recent
/// part holds no page report (Claude logs differently now, so its silence would mean nothing).
/// A log that was just rotated is read on into the file it went to.
pub fn mark_log(files: &ClaudeLogFiles) -> Option<u64> {
    let end = size_of(&files.current)?;
    let mut recent = read_range(&files.current, end.saturating_sub(KNOWN_BYTES), end).ok()?;
    if !LOADED.is_match(&recent)
        && end < KNOWN_BYTES
        && let Some(rotated) = size_of(&files.rotated)
    {
        recent = read_range(
            &files.rotated,
            rotated.saturating_sub(KNOWN_BYTES - end),
            rotated,
        )
        .ok()?;
    }
    LOADED.is_match(&recent).then_some(end)
}

/// What the log holds after `offset`, where `mark_log` left it. When Claude has rotated it since,
/// the rest of the old log comes first, then the new one.
pub fn log_since(files: &ClaudeLogFiles, offset: u64) -> io::Result<String> {
    let end = size_of(&files.current).unwrap_or(0);
    if end >= offset {
        return read_range(&files.current, offset, end);
    }
    let rest = match size_of(&files.rotated) {
        Some(rotated) if rotated >= offset => read_range(&files.rotated, offset, rotated)?,
        _ => String::new(),
    };
    Ok(rest + &read_range(&files.current, 0, end)?)
}

/// What `wait_for_page` reads.
pub trait PageWaitDeps {
    /// The log since the watch began; a failed read counts as nothing new.
    fn read(&self) -> io::Result<String>;
    fn running(&self) -> Result<bool, ProcessError>;
    fn sleep(&self, ms: u64);
    fn now(&self) -> i64;
}

/// Reads the log every second until the launch's page reports its build, for at most
/// `timeout_ms`. Stops early when no start is logged within START_MS, and when Claude is quit:
/// it checks every 5 s, and once more before it calls the page stalled.
pub fn wait_for_page(deps: &dyn PageWaitDeps, timeout_ms: i64) -> PageOutcome {
    let begun = deps.now();
    let mut polls: u32 = 1;
    loop {
        let progress = launch_progress(&deps.read().unwrap_or_default());
        if progress == LaunchProgress::Loaded {
            return PageOutcome::Loaded;
        }
        let waited = deps.now() - begun;
        if progress == LaunchProgress::None && waited >= START_MS {
            return PageOutcome::Unknown;
        }
        let due = waited >= timeout_ms;
        if due || polls % RUNNING_EVERY == 0 {
            let running = match deps.running() {
                Ok(running) => running,
                // Unknown: never a reason to start Claude again.
                Err(_) if due => return PageOutcome::Unknown,
                Err(_) => true,
            };
            if !running {
                return if progress == LaunchProgress::None {
                    PageOutcome::Refused
                } else {
                    PageOutcome::Closed
                };
            }
            if due {
                return PageOutcome::Stalled;
            }
        }
        deps.sleep(POLL_MS);
        polls += 1;
    }
}

/// Whether the page of the Claude that runs now has booted, from the end of its log: true once
/// "Loaded https://claude.ai" follows its last "Starting app {", false before; None when the log
/// cannot tell.
pub fn page_booted(files: &ClaudeLogFiles) -> Option<bool> {
    let end = size_of(&files.current)?;
    let text = read_range(&files.current, end.saturating_sub(TAIL_BYTES), end).ok()?;
    match launch_progress(&text) {
        LaunchProgress::None => None,
        progress => Some(progress == LaunchProgress::Loaded),
    }
}

/// Claude's line when its claude.ai page goes to /logout.
const LOGGED_OUT: &str = "] [account] Navigated to /logout";
/// Claude's line when a sign-in completes in the Claude that runs.
const LOGGED_IN: &str = "] [account] Login-state transition (loggedOut: true";

/// Whether the last start in `text` ended signed out: its page went to /logout and no sign-in
/// followed. None when `text` holds no start.
pub fn signed_out_since_start(text: &str) -> Option<bool> {
    let start = text.rfind(STARTED)?;
    let run = &text[start..];
    let Some(out) = run.rfind(LOGGED_OUT) else {
        return Some(false);
    };
    Some(run.rfind(LOGGED_IN).is_none_or(|login| out > login))
}

/// Claude's line when an account signs out: `uuid: <account> → <none>`, with the local time.
static SIGN_OUT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[info\] \[account\] Login-state transition \(loggedOut: false → true, uuid: ([0-9a-f-]{36}) → ",
    )
    .unwrap()
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSignOut {
    pub account_uuid: String,
    /// When Claude logged it, ms.
    pub at: i64,
}

/// `new Date(y, m - 1, d, h, mi, s).getTime()` in local time; out-of-range parts roll over as
/// in JS, and a time in a skipped hour moves forward.
fn local_ms(parts: [i64; 6]) -> Option<i64> {
    let [year, month, day, hour, minute, second] = parts;
    let months = year * 12 + (month - 1);
    let first = NaiveDate::from_ymd_opt(
        i32::try_from(months.div_euclid(12)).ok()?,
        u32::try_from(months.rem_euclid(12) + 1).ok()?,
        1,
    )?;
    let naive = first.and_hms_opt(0, 0, 0)?
        + chrono::Duration::days(day - 1)
        + chrono::Duration::hours(hour)
        + chrono::Duration::minutes(minute)
        + chrono::Duration::seconds(second);
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(time) => Some(time.timestamp_millis()),
        chrono::LocalResult::Ambiguous(earlier, _) => Some(earlier.timestamp_millis()),
        chrono::LocalResult::None => Local
            .from_local_datetime(&(naive + chrono::Duration::hours(1)))
            .earliest()
            .map(|time| time.timestamp_millis()),
    }
}

/// Each account's last sign-out in `text`, in the order first seen.
pub fn sign_outs_in(text: &str) -> Vec<ClaudeSignOut> {
    let mut last: Vec<ClaudeSignOut> = Vec::new();
    for m in SIGN_OUT.captures_iter(text) {
        let part = |i: usize| m[i].parse::<i64>().unwrap_or(0);
        let Some(at) = local_ms([part(1), part(2), part(3), part(4), part(5), part(6)]) else {
            continue;
        };
        let account_uuid = m[7].to_lowercase();
        match last
            .iter_mut()
            .find(|seen| seen.account_uuid == account_uuid)
        {
            Some(seen) => seen.at = at,
            None => last.push(ClaudeSignOut { account_uuid, at }),
        }
    }
    last
}

/// The sign-outs in the end of Claude's log; none when it cannot be read.
pub fn claude_sign_outs(files: &ClaudeLogFiles) -> Vec<ClaudeSignOut> {
    let Some(end) = size_of(&files.current) else {
        return Vec::new();
    };
    read_range(&files.current, end.saturating_sub(TAIL_BYTES), end)
        .map(|text| sign_outs_in(&text))
        .unwrap_or_default()
}

/// Whether the Claude that runs now signed itself out since it started, from the end of its log;
/// None when the log cannot tell.
pub fn claude_signed_out(files: &ClaudeLogFiles) -> Option<bool> {
    let end = size_of(&files.current)?;
    signed_out_since_start(&read_range(&files.current, end.saturating_sub(TAIL_BYTES), end).ok()?)
}

/// A launch being watched: `wait` tells how the page of the Claude started since did.
pub trait LaunchWatch: Send + Sync {
    fn wait(&self, timeout_ms: i64) -> PageOutcome;
}

/// Claude's full process check, as a watch uses it.
pub type RunningCheck = Arc<dyn Fn() -> Result<bool, ProcessError> + Send + Sync>;

struct LogWatch {
    files: ClaudeLogFiles,
    offset: u64,
    running: RunningCheck,
}

impl PageWaitDeps for LogWatch {
    fn read(&self) -> io::Result<String> {
        log_since(&self.files, self.offset)
    }
    fn running(&self) -> Result<bool, ProcessError> {
        (self.running)()
    }
    fn sleep(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    fn now(&self) -> i64 {
        crate::clock::now_ms()
    }
}

impl LaunchWatch for LogWatch {
    fn wait(&self, timeout_ms: i64) -> PageOutcome {
        wait_for_page(self, timeout_ms)
    }
}

/// Starts watching Claude's log before a launch; None when the log cannot tell.
pub fn watch_claude_launch(
    files: &ClaudeLogFiles,
    running: RunningCheck,
) -> Option<Box<dyn LaunchWatch>> {
    let offset = mark_log(files)?;
    Some(Box::new(LogWatch {
        files: files.clone(),
        offset,
        running,
    }))
}
