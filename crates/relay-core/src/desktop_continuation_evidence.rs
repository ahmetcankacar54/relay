//! Port of `electron/core/desktop-continuation-evidence.ts`: what Relay reads, outside the Claude
//! app's UI, to continue a Desktop conversation safely: the process census, the conversation's
//! record and transcript, durable checkpoints and delivery receipts.
//!
//! Blocking where the TS awaits; the TS's async and sync variants (`processes` /
//! `processesSync`, `measure` / `measureSync`) keep both seams but run the same way.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::continuation::{
    ContinuationCheckpoint, ContinuationCheckpointInput, ContinuationDelivery,
    ContinuationIdentity, ContinuationQuiescence, ContinuationReceipt, ContinuationSession,
    ContinuationState, ContinuationSwitchInput, DeliveryStatus, QuiescenceCoverage, SessionStatus,
};
use crate::continuation_journal::{
    MAX_BYTES, private_journal_directory, read_private_json, write_private_json,
};
use crate::desktop::{DesktopError, DesktopManager, DesktopResult, DesktopSwitchOptions};
use crate::desktop_continuation::{DesktopQuotaStop, QuotaStopReason};
use crate::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationError, DesktopAutomationIssue, DesktopAutomationSnapshot,
    DesktopContinuationEvidence, DesktopContinuationObservation, DesktopHostError,
};
use crate::desktop_files::{
    DesktopFileError, Scope, read_bytes, read_object, safe_file, scope_path,
};
use crate::desktop_instances::user_data_dir;
use crate::environment::exec_file;
use crate::fs_util::{mtime_ms, resolve, safe_integer};
use crate::shared::types::js::{date_parse, number_value, ser_num, trim};
use crate::shared::types::{Account, AccountDesktop, DesktopState, literal_enum};
use crate::store::Store;
use crate::transcript_scan::{
    Row, TranscriptScanner, TranscriptSummary, TurnTrigger, hex, incomplete, io_error,
    is_task_notification, js_length, message_content, read_at, truthy,
};

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("valid pattern")
}

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
});
static REQUEST: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Za-z0-9._:-]{1,128}$"));
static MAIN_APP: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"/Claude\.app/Contents/MacOS/Claude$"));
static ENGINE_NAME: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)(?:^|/)claude(?:-code)?(?:\.exe)?$"));
static ENGINE_PACKAGE: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)/claude-code/"));
static ENGINE_VERSION: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)/(?:\.local/share/claude/versions|\.claude/local)/[^/]+$"));
static JS_RUNTIME: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)(?:^|/)(?:node|nodejs|bun)(?:\.exe)?$"));
static OPTION_SPLIT: LazyLock<Regex> = LazyLock::new(|| pattern(r"\s+--"));
// The TS ends with the lookahead `(?=\s|$)`; for a yes/no match consuming it is the same.
static ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"(?i)(?:^|\s)/(?:[^\s]*/)?claude(?:-code)?(?:\.(?:js|cjs|mjs))?(?:\s|$)")
});
static COMMAND_LINE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^\s*([0-9]+)\s+([0-9]+)\s+(.+)$"));
static ARGS_LINE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^\s*([0-9]+)\s+(.+)$"));
static SHELL: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?:^|/)(?:zsh|bash|sh)$"));
static SHELL_SNAPSHOT: LazyLock<Regex> = LazyLock::new(|| pattern(r"/shell-snapshots/snapshot-"));
static PORT: LazyLock<Regex> = LazyLock::new(|| pattern(r":([0-9]+)$"));
static CPU_LINE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^\s*([0-9]+)\s+(?:([0-9]+)-)?([0-9:.]+)\s*$"));
static INTERRUPTED: LazyLock<Regex> = LazyLock::new(|| pattern(r"^\[Request interrupted"));
static MARKER: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"\[Relay continuation: ([A-Za-z0-9._:-]{1,128})\]\s*$"));
static LOCAL_FILE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)^(local_[0-9a-f-]{36})\.json$"));
static LOCAL_ID: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)^local_[0-9a-f-]{36}$"));
static SHA_HEX: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[a-f0-9]{64}$"));

fn sha(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn issue(issue: DesktopAutomationIssue) -> DesktopHostError {
    DesktopAutomationError::new(issue).into()
}

fn file_error(error: DesktopFileError) -> DesktopHostError {
    DesktopHostError::other(error.to_string())
}

/// A `DesktopManager` failure as the evidence reports it: one of the evidence's own automation
/// issues, thrown from a guard and passed through the switch, keeps its kind.
fn desktop_error(error: DesktopError) -> DesktopHostError {
    match DesktopAutomationIssue::parse(error.message()) {
        Some(found) => issue(found),
        None => DesktopHostError::other(error.message()),
    }
}

fn row_str<'a>(row: &'a Row, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn is_uuid(value: Option<&str>) -> bool {
    UUID.is_match(value.unwrap_or(""))
}

/// Node's POSIX `path.basename`.
fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("").to_owned()
}

/// A JSON number as `JSON.stringify` writes it: integers without a fraction.
fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// `Number(value)` for a JSON value.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_value(s),
        Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
    }
}

fn scope(desktop: &AccountDesktop) -> Scope {
    Scope {
        account_uuid: desktop.account_uuid.clone(),
        org_id: desktop.org_id.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopProcess {
    pub pid: i64,
    pub ppid: i64,
    pub executable: String,
    pub args: String,
}

/// The main Claude's own process: Claude.app's executable, started without its own data
/// folder. A separate window (`--user-data-dir`) is another app that a switch neither quits nor
/// waits for.
pub fn is_main_claude_app(process: &DesktopProcess) -> bool {
    MAIN_APP.is_match(&process.executable) && user_data_dir(&process.args).is_none()
}

/// Native installs use a version filename; npm installs can run under Node.
pub fn is_desktop_claude_engine(process: &DesktopProcess) -> bool {
    let executable = process.executable.replace('\\', "/");
    if ENGINE_NAME.is_match(&executable)
        || ENGINE_PACKAGE.is_match(&executable)
        || ENGINE_VERSION.is_match(&executable)
    {
        return true;
    }
    // Restrict argument-based recognition to JS runtimes. A shell's task prompt or an
    // unrelated process mentioning a package path must not masquerade as the one permitted
    // source engine.
    if !JS_RUNTIME.is_match(&executable) {
        return false;
    }
    let args = process.args.replace('\\', "/");
    let entry_prefix = OPTION_SPLIT.split(&args).next().unwrap_or("");
    if entry_prefix.contains("/node_modules/@anthropic-ai/claude-code/") {
        return true;
    }
    ENTRY.is_match(entry_prefix)
}

/// Parse two OS snapshots rather than splitting executable paths on spaces.
pub fn combine_desktop_processes(
    commands: &str,
    arguments: &str,
) -> Result<String, DesktopHostError> {
    let mut args: HashMap<i64, &str> = HashMap::new();
    for line in arguments.split('\n') {
        if let Some(m) = ARGS_LINE.captures(line)
            && let Ok(pid) = m[1].parse::<i64>()
        {
            args.insert(pid, m.get(2).map_or("", |g| g.as_str()));
        }
    }
    let mut processes = Vec::new();
    for line in commands.split('\n').filter(|line| !trim(line).is_empty()) {
        let m = COMMAND_LINE.captures(line).ok_or_else(incomplete)?;
        let pid = m[1].parse::<i64>().map_err(|_| incomplete())?;
        processes.push(DesktopProcess {
            pid,
            ppid: m[2].parse::<i64>().map_err(|_| incomplete())?,
            executable: m[3].to_owned(),
            args: args.get(&pid).copied().unwrap_or("").to_owned(),
        });
    }
    serde_json::to_string(&processes).map_err(|e| DesktopHostError::other(e.to_string()))
}

/// A Bash command of a Claude Code session: the engine runs each in a shell of its own, the
/// leader of its own process group, that first sources the session's shell snapshot.
pub fn is_engine_shell(row: &DesktopProcess) -> bool {
    SHELL.is_match(&row.executable) && SHELL_SNAPSHOT.is_match(&row.args)
}

/// A command one of Claude's engines runs: its shell and every process under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineCommand {
    /// The command's shell, the leader of its process group.
    pub pid: i64,
    /// Every process of the command, the shell first.
    pub pids: Vec<i64>,
    /// The executable names under the shell, for the log: "node", "docker-buildx".
    pub names: Vec<String>,
}

/// The commands Claude's engines run in a census. Once every conversation has stopped, these
/// are the ones a session left running in the background: dev servers, builds, watchers.
/// Claude asks before it quits while one runs, and its quit stops them.
pub fn engine_commands(rows: &[DesktopProcess], app_pid: i64) -> Vec<EngineCommand> {
    let mut children: HashMap<i64, Vec<&DesktopProcess>> = HashMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row);
    }
    let mut under_app: HashSet<i64> = HashSet::from([app_pid]);
    let mut grew = true;
    while grew {
        grew = false;
        for row in rows {
            if !under_app.contains(&row.pid) && under_app.contains(&row.ppid) {
                under_app.insert(row.pid);
                grew = true;
            }
        }
    }
    let engines: HashSet<i64> = rows
        .iter()
        .filter(|row| {
            row.pid != app_pid && under_app.contains(&row.pid) && is_desktop_claude_engine(row)
        })
        .map(|row| row.pid)
        .collect();
    let mut commands = Vec::new();
    for shell in rows {
        if !engines.contains(&shell.ppid) || !is_engine_shell(shell) {
            continue;
        }
        let mut tree: Vec<&DesktopProcess> = vec![shell];
        let mut i = 0;
        while i < tree.len() {
            if let Some(kids) = children.get(&tree[i].pid) {
                tree.extend(kids.iter().copied());
            }
            i += 1;
        }
        let mut names: Vec<String> = Vec::new();
        for row in &tree[1..] {
            let name = basename(&row.executable);
            if !names.contains(&name) {
                names.push(name);
            }
        }
        commands.push(EngineCommand {
            pid: shell.pid,
            pids: tree.iter().map(|row| row.pid).collect(),
            names,
        });
    }
    commands
}

/// The TCP ports each of `pids` listens on, from `lsof -F pn` output, in the order they came.
/// A `p` line that is not a number (a `NaN` key in the TS) keeps its ports out.
pub fn parse_listening_ports(output: &str) -> IndexMap<i64, Vec<i64>> {
    let mut ports: IndexMap<i64, Vec<i64>> = IndexMap::new();
    let mut pid: Option<Option<i64>> = None;
    for line in output.split('\n') {
        if let Some(rest) = line.strip_prefix('p') {
            let n = number_value(rest);
            pid = Some((n.is_finite() && n.fract() == 0.0).then_some(n as i64));
        } else if line.starts_with('n')
            && let Some(current) = pid
        {
            let port = PORT
                .captures(line)
                .and_then(|m| m[1].parse::<u64>().ok())
                .filter(|port| *port > 0 && *port < (1 << 53));
            if let (Some(port), Some(current)) = (port, current) {
                let list = ports.entry(current).or_default();
                if !list.contains(&(port as i64)) {
                    list.push(port as i64);
                }
            }
        }
    }
    ports
}

/// The TCP ports these processes listen on; none when `lsof` cannot tell.
fn listening_ports(pids: &[i64]) -> IndexMap<i64, Vec<i64>> {
    let list = pids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    match exec_file(
        "/usr/sbin/lsof",
        &[
            "-nP",
            "-a",
            "-iTCP",
            "-sTCP:LISTEN",
            "-p",
            &list,
            "-F",
            "pn",
        ],
        None,
        None,
        Duration::from_millis(3000),
        1_048_576,
    ) {
        Ok(output) => parse_listening_ports(&output.stdout),
        // lsof exits 1 when nothing listens; its output still says what it found.
        Err(error) => parse_listening_ports(&error.stdout),
    }
}

/// A signal `stop_background` sends: 0 only asks whether the process is there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Signal {
    /// Signal 0.
    Probe,
    Term,
    Kill,
}

impl Signal {
    /// As Node names it: `0`, `SIGTERM`, `SIGKILL`.
    pub const fn name(self) -> &'static str {
        match self {
            Signal::Probe => "0",
            Signal::Term => "SIGTERM",
            Signal::Kill => "SIGKILL",
        }
    }
}

/// `process.kill`, as true when it reached a process (or group) and false when none was there.
pub fn send_signal(pid: i64, signal: Signal) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        let number = match signal {
            Signal::Probe => 0,
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        // SAFETY: kill(2) takes plain integers and touches no memory of ours.
        unsafe { libc::kill(pid, number) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
        false
    }
}

/// A background command as the fleet weighs it: whether it serves, and when it last worked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCommand {
    /// The command's shell, the leader of its process group.
    pub pid: i64,
    /// Every process of the command, the shell first.
    pub pids: Vec<i64>,
    /// The executable names under the shell, for the log.
    pub names: Vec<String>,
    /// TCP ports it listens on: a server, which never ends on its own.
    pub ports: Vec<i64>,
    /// When Relay first saw it.
    #[serde(serialize_with = "ser_num")]
    pub seen_at: f64,
    /// When Relay last saw it use CPU; None when never.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::shared::types::js::ser_opt_num"
    )]
    pub active_at: Option<f64>,
}

/// What `stop_background` did: the names it stopped, how many processes are left, and how many
/// commands it did not expect.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BackgroundStopResult {
    pub stopped: Vec<String>,
    pub left: usize,
    pub unexpected: usize,
}

fn ps(args: &[&str]) -> Result<String, DesktopHostError> {
    exec_file(
        "/bin/ps",
        args,
        None,
        None,
        Duration::from_millis(3000),
        2_097_152,
    )
    .map(|output| output.stdout)
    .map_err(|error| DesktopHostError::other(error.to_string()))
}

fn collect_processes() -> Result<String, DesktopHostError> {
    let commands = ps(&["-axo", "pid=,ppid=,comm="])?;
    let arguments = ps(&["-axo", "pid=,args="])?;
    combine_desktop_processes(&commands, &arguments)
}

/// A local Code conversation whose latest turn ended with a usage limit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaStop {
    pub local_session_id: String,
    pub cli_session_id: String,
    pub project_key: String,
    /// Claude's UI label for the conversation's mode, when it is one Relay restores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    pub turn_id: String,
    #[serde(serialize_with = "ser_num")]
    pub stopped_at: f64,
    pub transcript_relative: String,
    pub transcript_bytes: u64,
    pub transcript_sha256: String,
    /// What started the turn that hit the limit: a person's prompt, a tool's result in a
    /// working turn, or a background task's notification, as a command that ended (or was
    /// stopped) sends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<TurnTrigger>,
}

/// Index values to the labels Claude shows; bypass and others are left alone.
pub fn ui_permission_mode(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str)? {
        "default" => Some("Manual"),
        "auto" => Some("Auto"),
        "plan" => Some("Plan"),
        "acceptEdits" => Some("Accept edits"),
        _ => None,
    }
}

/// Inputs measured outside the process table.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QuiescenceInputs {
    /// Recently written Claude Code transcripts, other than the selected one, whose turn is
    /// unfinished.
    pub busy_transcripts: Option<f64>,
    /// Processes whose CPU time advanced since the previous observation. None: not measured
    /// yet.
    pub active_pids: Option<HashSet<i64>>,
    /// Filled with the name of each process counted as unknown work, for the diagnosis log.
    pub work: Option<Vec<String>>,
    /// Processes judged elsewhere, as the background commands the fleet waits for or stops.
    pub ignore: Option<HashSet<i64>>,
}

fn census_rows(raw: &str, app_pid: i64) -> Option<Vec<DesktopProcess>> {
    let Ok(Value::Array(input)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    if input.len() > 100_000 {
        return None;
    }
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(input.len());
    for r in &input {
        let pid = r.get("pid").and_then(safe_integer).filter(|pid| *pid > 0)?;
        let ppid = r
            .get("ppid")
            .and_then(safe_integer)
            .filter(|ppid| *ppid >= 0)?;
        let executable = r.get("executable").and_then(Value::as_str)?;
        let args = r.get("args").and_then(Value::as_str)?;
        if !seen.insert(pid) {
            return None;
        }
        rows.push(DesktopProcess {
            pid,
            ppid,
            executable: executable.to_owned(),
            args: args.to_owned(),
        });
    }
    rows.iter().any(|r| r.pid == app_pid).then_some(rows)
}

/// Decide whether restarting Claude would interrupt work.
///
/// Desktop keeps one Claude Code engine alive per open conversation, wrapped in a `disclaimer`
/// helper, even when the conversation is idle. Engine activity is therefore judged from
/// transcripts (an unfinished turn is busy), not from the mere presence of a process. Any other
/// process Claude started (a tool, a background job, an MCP server) blocks only while it is
/// using CPU. Processes outside Claude's tree, such as a terminal Claude Code CLI or the browser
/// extension's native host, are unaffected by a Desktop restart and are ignored.
pub fn desktop_process_quiescence(
    raw: &str,
    app_pid: i64,
    _session_id: &str,
    selected_stopped: bool,
    inputs: &mut QuiescenceInputs,
) -> ContinuationQuiescence {
    let mut result = ContinuationQuiescence {
        coverage: QuiescenceCoverage::Unknown,
        busy_workers: 0.0,
        subagents: 0.0,
        pending_tasks: 0.0,
        waiting: 0.0,
        queued_prompts: 0.0,
        scheduled_wakeups: 0.0,
        unknown_work: 0.0,
    };
    let Some(rows) = census_rows(raw, app_pid) else {
        result.unknown_work = 1.0;
        return result;
    };
    let app = rows
        .iter()
        .find(|r| r.pid == app_pid)
        .expect("checked above");
    if !MAIN_APP.is_match(&app.executable) {
        result.unknown_work = 1.0;
        return result;
    }
    let bundle = &app.executable[..app.executable.find(".app/").map_or(0, |at| at + 5)];
    let helpers = format!("{bundle}Contents/");
    let mut descendants: HashSet<i64> = HashSet::from([app_pid]);
    let mut prior = usize::MAX;
    while prior != descendants.len() {
        prior = descendants.len();
        for row in &rows {
            if descendants.contains(&row.ppid) {
                descendants.insert(row.pid);
            }
        }
    }
    // The selected conversation itself must have finished its turn.
    if !selected_stopped {
        result.busy_workers += 1.0;
    }
    result.busy_workers += inputs.busy_transcripts.unwrap_or(0.0);
    for row in &rows {
        if row.pid == app_pid || !descendants.contains(&row.pid) {
            continue;
        }
        // Claude's own helpers (Chromium processes, engine wrappers, crash reporter).
        if row.executable.starts_with(&helpers) {
            continue;
        }
        if is_desktop_claude_engine(row) {
            continue;
        }
        if inputs.ignore.as_ref().is_some_and(|i| i.contains(&row.pid)) {
            continue;
        }
        if inputs
            .active_pids
            .as_ref()
            .is_none_or(|active| active.contains(&row.pid))
        {
            result.unknown_work += 1.0;
            if let Some(work) = inputs.work.as_mut() {
                work.push(basename(&row.executable));
            }
        }
    }
    result.coverage = QuiescenceCoverage::GuardedLocal;
    result
}

/// How a persisted row ended in error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranscriptError {
    Quota,
    Other,
}

/// Use the same persisted error forms for stop detection and delivery receipts.
fn transcript_error(row: &Row) -> Option<TranscriptError> {
    let field = |value: Option<&Value>, key: &str| value.and_then(|v| v.get(key)).cloned();
    let reasons = [
        row.get("error").cloned(),
        field(row.get("error"), "type"),
        row.get("errorType").cloned(),
        field(row.get("apiError"), "type"),
        field(row.get("message"), "stop_reason"),
    ];
    let quota = reasons.iter().flatten().any(|reason| {
        matches!(
            reason.as_str(),
            Some("rate_limit" | "rate_limit_error" | "rate-limit" | "usage_limit")
        )
    });
    if quota {
        return Some(TranscriptError::Quota);
    }
    if row.get("isApiErrorMessage") == Some(&Value::Bool(true))
        || truthy(row, "error")
        || truthy(row, "errorType")
        || truthy(row, "apiError")
    {
        return Some(TranscriptError::Other);
    }
    None
}

fn main_turn_row(row: &Row) -> bool {
    !truthy(row, "isSidechain")
        && !truthy(row, "isMeta")
        && matches!(row_str(row, "type"), Some("user" | "assistant"))
}

/// The main chain's latest user or assistant row. Background tasks that finish after a
/// usage-limit stop leave task notifications behind it; out of quota, Claude Code never answers
/// them, so the stop stays the latest row. After any other row a notification starts a new turn
/// and is the latest row itself.
fn main_tail<'a>(rows: &[&'a Row]) -> Option<&'a Row> {
    let turns: Vec<&Row> = rows
        .iter()
        .copied()
        // Written to the transcript only, as a background task's notice that came after the
        // turn ended: Claude Code never answers it, so it is no turn.
        .filter(|r| main_turn_row(r) && r.get("queueTranscriptOnly") != Some(&Value::Bool(true)))
        .collect();
    let mut index = turns.len();
    while index > 0 && is_task_notification(turns[index - 1]) {
        index -= 1;
    }
    let settled = index.checked_sub(1).map(|i| turns[i]);
    if index < turns.len()
        && let Some(settled) = settled
        && row_str(settled, "type") == Some("assistant")
        && transcript_error(settled) == Some(TranscriptError::Quota)
    {
        return Some(settled);
    }
    turns.last().copied()
}

literal_enum!(
    /// Turn state of a transcript's main chain.
    TurnState { Idle = "idle", Busy = "busy" }
);

/// Turn state of a transcript's main chain: an unfinished turn means work is in progress.
pub fn transcript_turn_state(rows: &[Row]) -> TurnState {
    let refs: Vec<&Row> = rows.iter().collect();
    let Some(tail) = main_tail(&refs) else {
        return TurnState::Idle;
    };
    if row_str(tail, "type") == Some("user") {
        return if INTERRUPTED.is_match(trim(&transcript_message_text(tail))) {
            TurnState::Idle
        } else {
            TurnState::Busy
        };
    }
    if transcript_error(tail).is_some() {
        return TurnState::Idle;
    }
    let tool = message_content(tail)
        .and_then(Value::as_array)
        .is_some_and(|content| {
            content
                .iter()
                .any(|c| c.get("type").and_then(Value::as_str) == Some("tool_use"))
        });
    if tool {
        return TurnState::Busy;
    }
    let stop = tail
        .get("message")
        .and_then(|m| m.get("stop_reason"))
        .and_then(Value::as_str);
    if matches!(
        stop,
        Some("end_turn" | "stop_sequence" | "max_tokens" | "refusal")
    ) {
        TurnState::Idle
    } else {
        TurnState::Busy
    }
}

/// Parse `ps -o pid=,time=` cumulative CPU times ([dd-][hh:]mm:ss.ss) in seconds.
pub fn parse_cpu_times(output: &str) -> HashMap<i64, f64> {
    let mut times = HashMap::new();
    for line in output.split('\n') {
        let Some(m) = CPU_LINE.captures(line) else {
            continue;
        };
        let parts: Vec<f64> = m[3].split(':').map(number_value).collect();
        if parts.iter().any(|part| !part.is_finite()) {
            continue;
        }
        let seconds = parts.iter().fold(0.0, |total, part| total * 60.0 + part);
        let days = m.get(2).map_or(0.0, |d| number_value(d.as_str()));
        if let Ok(pid) = m[1].parse::<i64>() {
            times.insert(pid, seconds + days * 86_400.0);
        }
    }
    times
}

/// Transcripts written within this window are considered possibly live.
const LIVE_TRANSCRIPT_MS: f64 = 2.0 * 60.0 * 60_000.0;
/// CPU seconds a process may use between observations and still count as idle.
const IDLE_CPU_SECONDS: f64 = 0.3;
const TAIL_BYTES: u64 = 512 * 1024;
/// A conversation no project folder held is probed across every folder at most this often.
const FOLDER_PROBE_MS: f64 = 60_000.0;

fn transcript_tail(data: &[u8]) -> Vec<Row> {
    let start = data.len().saturating_sub(TAIL_BYTES as usize);
    let text = String::from_utf8_lossy(&data[start..]);
    text.split('\n')
        .skip(usize::from(start > 0))
        .filter(|line| !line.is_empty())
        // A line Claude is still appending fails here; the next observation reads it.
        .filter_map(|line| match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(row)) => Some(row),
            _ => None,
        })
        .collect()
}

/// The text of a row's message: a string, or its text blocks joined by newlines.
pub fn transcript_message_text(row: &Row) -> String {
    match message_content(row) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(content)) => content
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Every row of a complete transcript: refused when it is over 64 MiB, does not end with a
/// newline, or has a line over the length limit, not JSON or not an object.
pub fn parse_desktop_transcript(data: &[u8]) -> Result<Vec<Row>, DesktopHostError> {
    if data.len() > 64 * 1024 * 1024 || data.last().is_some_and(|b| *b != b'\n') {
        return Err(incomplete());
    }
    let text = String::from_utf8_lossy(data);
    let mut rows = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        if line.len() > 2_097_152 && js_length(line) > 2_097_152 {
            return Err(incomplete());
        }
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(row)) => rows.push(row),
            _ => return Err(incomplete()),
        }
    }
    Ok(rows)
}

/// Rows written after a quota stop that start or queue another turn: a prompt or an answer on
/// the main chain, or a queued prompt, but not a task notification Claude Code wrote itself, nor
/// any row of its own bookkeeping. An answer that is the limit again is no work: a stopped
/// command's notification starts a turn that ends there at once, and Relay stops commands just
/// before it quits Claude.
pub fn moved_on(appended: &[Row]) -> bool {
    appended.iter().any(|row| {
        if row.get("isSidechain") == Some(&Value::Bool(true)) {
            return false;
        }
        match row_str(row, "type") {
            Some("assistant") => transcript_error(row) != Some(TranscriptError::Quota),
            Some("user") => {
                row.get("isMeta") != Some(&Value::Bool(true)) && !is_task_notification(row)
            }
            Some("queue-operation") if row_str(row, "operation") == Some("enqueue") => !row
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.starts_with("<task-notification>")),
            Some("attachment") => {
                row.get("attachment")
                    .and_then(|a| a.get("type"))
                    .and_then(Value::as_str)
                    == Some("queued_command")
            }
            _ => false,
        }
    })
}

/// The latest main-chain turn when it ended with a usage limit: its id and when.
#[derive(Debug, Clone, PartialEq)]
pub struct QuotaEndedTurn {
    pub turn_id: String,
    /// `Date.parse` of its timestamp: NaN when missing or unreadable.
    pub timestamp: f64,
}

fn latest_quota_ended(rows: &[&Row]) -> Option<QuotaEndedTurn> {
    let tail = main_tail(rows)?;
    if row_str(tail, "type") != Some("assistant") || !is_uuid(row_str(tail, "uuid")) {
        return None;
    }
    if transcript_error(tail) != Some(TranscriptError::Quota) {
        return None;
    }
    Some(QuotaEndedTurn {
        turn_id: row_str(tail, "uuid").unwrap_or_default().to_owned(),
        timestamp: date_parse(row_str(tail, "timestamp").unwrap_or("")),
    })
}

pub fn latest_quota_ended_turn(rows: &[Row]) -> Option<QuotaEndedTurn> {
    let refs: Vec<&Row> = rows.iter().collect();
    latest_quota_ended(&refs)
}

/// A row Claude Code wrote itself, such as an API error or "No response requested.".
fn synthetic(row: &Row) -> bool {
    row.get("message")
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
        == Some("<synthetic>")
}

/// The user turn carrying a continuation marker, and the assistant row proving it started.
#[derive(Debug, Clone, PartialEq)]
pub struct ContinuationTurn {
    pub request_id: String,
    pub user: Row,
    pub assistant: Option<Row>,
}

pub fn continuation_turn(rows: &[Row], request_id: Option<&str>) -> Option<ContinuationTurn> {
    // A background task that finishes during the resumed turn is not a new prompt.
    let user = rows.iter().rev().find(|r| {
        row_str(r, "type") == Some("user")
            && !truthy(r, "isMeta")
            && !truthy(r, "isSidechain")
            && !is_task_notification(r)
            && !transcript_message_text(r).is_empty()
    })?;
    let user_id = row_str(user, "uuid").filter(|id| UUID.is_match(id))?;
    let text = transcript_message_text(user);
    let marker = MARKER.captures(&text)?;
    let marked = marker[1].to_owned();
    if let Some(wanted) = request_id.filter(|id| !id.is_empty())
        && marked != wanted
    {
        return None;
    }
    let mut by_id: HashMap<&str, &Row> = HashMap::new();
    for row in rows {
        if let Some(id) = row_str(row, "uuid").filter(|id| UUID.is_match(id)) {
            by_id.insert(id, row);
        }
    }
    let parent = |row: &Row| row_str(row, "parentUuid").and_then(|p| by_id.get(p).copied());
    let descends = |row: &Row| {
        let mut cursor = Some(row);
        let mut seen: HashSet<Option<&str>> = HashSet::new();
        while let Some(at) = cursor {
            let id = row_str(at, "uuid");
            if seen.contains(&id) {
                break;
            }
            if id == Some(user_id) {
                return true;
            }
            seen.insert(id);
            cursor = parent(at);
        }
        false
    };
    // Before the first prompt after a stop, Claude Code writes a synthetic "No response
    // requested." reply and parents the prompt on it: a row the marker itself answers, not
    // other work.
    let mut answered: HashSet<Option<&str>> = HashSet::new();
    let mut cursor = parent(user);
    while let Some(at) = cursor {
        if !answered.insert(row_str(at, "uuid")) {
            break;
        }
        cursor = parent(at);
    }
    // The resumed turn alternates assistant and tool-result rows while it works. Its latest
    // successful assistant row in the marker's chain proves it started. A persisted API error
    // alone (for example another quota stop) or another synthetic row only proves the input
    // was accepted, never that work resumed.
    let assistants: Vec<&Row> = rows
        .iter()
        .filter(|r| {
            row_str(r, "type") == Some("assistant")
                && !truthy(r, "isMeta")
                && !truthy(r, "isSidechain")
                && is_uuid(row_str(r, "uuid"))
                && !(synthetic(r) && answered.contains(&row_str(r, "uuid")))
        })
        .collect();
    let chained: Vec<&Row> = assistants.iter().copied().filter(|r| descends(r)).collect();
    if !assistants.is_empty() && chained.is_empty() {
        return None;
    }
    let started = chained
        .iter()
        .rev()
        .find(|r| transcript_error(r).is_none() && !synthetic(r))
        .map(|r| (*r).clone());
    Some(ContinuationTurn {
        request_id: marked,
        user: user.clone(),
        assistant: started,
    })
}

/// What the evidence needs of `DesktopManager`: its reading and its switch.
pub trait EvidenceDesktop: Send + Sync {
    fn snapshot(&self) -> DesktopResult<DesktopState>;
    fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()>;
}

impl EvidenceDesktop for DesktopManager {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        DesktopManager::snapshot(self)
    }
    fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()> {
        DesktopManager::switch_to(self, profile_id, options)
    }
}

/// A process listing (`processes`, `processesSync`) or `ps -axo pid=,time=` output (`cpuTimes`).
pub type EvidenceReading = Box<dyn Fn() -> Result<String, DesktopHostError> + Send + Sync>;
pub type EvidenceClock = Box<dyn Fn() -> f64 + Send + Sync>;
/// The TCP ports each of these processes listens on.
pub type PortLookup = Box<dyn Fn(&[i64]) -> IndexMap<i64, Vec<i64>> + Send + Sync>;
/// Sends a signal to a process, or to a process group with a negative pid; whether it reached
/// one.
pub type SignalSender = Box<dyn Fn(i64, Signal) -> bool + Send + Sync>;
pub type EvidenceSleep = Box<dyn Fn(u64) + Send + Sync>;

pub struct DesktopEvidenceOptions {
    pub store: Arc<Store>,
    pub desktop: Arc<dyn EvidenceDesktop>,
    pub automation: Arc<dyn DesktopAutomation>,
    pub claude_root: PathBuf,
    pub transcript_root: PathBuf,
    pub processes: Option<EvidenceReading>,
    pub processes_sync: Option<EvidenceReading>,
    /// `ps -axo pid=,time=` output; injectable for tests.
    pub cpu_times: Option<EvidenceReading>,
    pub now: Option<EvidenceClock>,
    /// The TCP ports each of these processes listens on; injectable for tests.
    pub listening_ports: Option<PortLookup>,
    /// Sends `signal` to a process, or to a process group with a negative pid; signal 0 only
    /// asks whether it is there. Whether it reached one. Injectable for tests.
    pub signal: Option<SignalSender>,
    pub sleep: Option<EvidenceSleep>,
}

impl DesktopEvidenceOptions {
    /// The required options; every seam at its default.
    pub fn new(
        store: Arc<Store>,
        desktop: Arc<dyn EvidenceDesktop>,
        automation: Arc<dyn DesktopAutomation>,
        claude_root: impl Into<PathBuf>,
        transcript_root: impl Into<PathBuf>,
    ) -> DesktopEvidenceOptions {
        DesktopEvidenceOptions {
            store,
            desktop,
            automation,
            claude_root: claude_root.into(),
            transcript_root: transcript_root.into(),
            processes: None,
            processes_sync: None,
            cpu_times: None,
            now: None,
            listening_ports: None,
            signal: None,
            sleep: None,
        }
    }
}

struct CpuSample {
    at: f64,
    times: HashMap<i64, f64>,
}

#[derive(Clone, Copy)]
struct CommandTimes {
    seen_at: f64,
    active_at: Option<f64>,
}

struct LastQuiet {
    busy: Vec<String>,
    work: Vec<String>,
    sampled: bool,
}

struct EvidenceState {
    revision: f64,
    signature: String,
    cpu: Option<CpuSample>,
    family: HashSet<i64>,
    scanner: TranscriptScanner,
    /// Each conversation's project folder, and when a probe of every folder found it in that
    /// one alone.
    project_folders: HashMap<String, (String, f64)>,
    /// When each conversation no single folder held was last probed.
    unplaced: HashMap<String, f64>,
    background: Vec<BackgroundCommand>,
    /// When each background command, by its shell, was first seen and last seen working.
    command_times: HashMap<i64, CommandTimes>,
    last_quiet: Option<LastQuiet>,
}

/// A transcript read whole.
struct Transcript {
    relative: String,
    data: Vec<u8>,
    rows: Vec<Row>,
}

/// A transcript scanned incrementally.
struct Scanned {
    folder: String,
    relative: String,
    summary: TranscriptSummary,
}

/// Claude's main pid in a census.
enum ClaudeApp {
    Running(i64),
    /// A closed Claude cannot be interrupted.
    Closed,
    /// The census is unreadable.
    Unverified,
}

/// A checkpoint record as read back: the file's object, kept whole so that a rewrite keeps its
/// keys in place, and the fields Relay uses.
#[derive(Clone)]
struct CheckpointRecord {
    raw: Map<String, Value>,
    checkpoint: ContinuationCheckpoint,
    target: Option<ContinuationIdentity>,
    local_session_id: String,
    transcript_relative: String,
    transcript_bytes: u64,
    transcript_sha256: String,
}

/// A session in the key order the TS builds it in.
fn session_value(session: &ContinuationSession) -> Value {
    let mut map = Map::new();
    map.insert("id".into(), json!(session.id));
    map.insert("projectKey".into(), json!(session.project_key));
    map.insert(
        "transcriptRevision".into(),
        json!(session.transcript_revision),
    );
    map.insert("permissionMode".into(), json!(session.permission_mode));
    map.insert("status".into(), json!(session.status));
    if let Some(turn) = &session.last_turn_id {
        map.insert("lastTurnId".into(), json!(turn));
    }
    if let Some(request) = &session.last_request_id {
        map.insert("lastRequestId".into(), json!(request));
    }
    Value::Object(map)
}

fn quiet_counters(q: &ContinuationQuiescence) -> bool {
    q.coverage == QuiescenceCoverage::GuardedLocal
        && q.counters().iter().all(|(_, value)| *value == 0.0)
}

fn marker_users<'a>(appended: &'a [Row], request_id: &str) -> Vec<&'a Row> {
    let marker = format!("[Relay continuation: {request_id}]");
    appended
        .iter()
        .filter(|r| {
            row_str(r, "type") == Some("user")
                && !truthy(r, "isMeta")
                && !truthy(r, "isSidechain")
                && !is_task_notification(r)
                && transcript_message_text(r).contains(&marker)
        })
        .collect()
}

struct Inner {
    options: DesktopEvidenceOptions,
    records_root: PathBuf,
    state: Mutex<EvidenceState>,
}

/// The Desktop evidence reader: identity, transcript, worker coverage and durable receipts,
/// independent of the UI.
#[derive(Clone)]
pub struct NativeDesktopContinuationEvidence {
    inner: Arc<Inner>,
}

impl NativeDesktopContinuationEvidence {
    pub fn new(
        options: DesktopEvidenceOptions,
    ) -> Result<NativeDesktopContinuationEvidence, DesktopHostError> {
        let records_root = options.store.root().join("continuation-checkpoints");
        private_journal_directory(&records_root)
            .map_err(|e| DesktopHostError::other(e.to_string()))?;
        Ok(NativeDesktopContinuationEvidence {
            inner: Arc::new(Inner {
                options,
                records_root,
                state: Mutex::new(EvidenceState {
                    revision: 0.0,
                    signature: String::new(),
                    cpu: None,
                    family: HashSet::new(),
                    scanner: TranscriptScanner::default(),
                    project_folders: HashMap::new(),
                    unplaced: HashMap::new(),
                    background: Vec::new(),
                    command_times: HashMap::new(),
                    last_quiet: None,
                }),
            }),
        })
    }

    /// Local Code conversations of `account` whose latest turn ended with a usage limit within
    /// `within_ms` (6 hours when None), most recent first. Read from Claude's index and
    /// transcripts only; nothing in Claude is touched.
    pub fn quota_stops(
        &self,
        account: &Account,
        within_ms: Option<f64>,
    ) -> Result<Vec<QuotaStop>, DesktopHostError> {
        self.inner.quota_stops(account, within_ms)
    }

    /// Why restarting Claude would interrupt work other than these stopped conversations, or
    /// None when nothing else is running.
    pub fn quiet_except(&self, stops: &[QuotaStop]) -> Result<Option<String>, DesktopHostError> {
        self.inner.quiet_except(stops)
    }

    /// The commands Claude Code sessions left running in the background, as the last
    /// `quiet_except` found them: their ports, and when each was first seen and last used CPU.
    pub fn background_commands(&self) -> Vec<BackgroundCommand> {
        self.inner.state().background.clone()
    }

    /// Stops the background commands whose shells are in `allowed`, right before Claude quits:
    /// each command's process group and every process in it is asked to end, and what is still
    /// there after 5 s is killed. Stops nothing when another command runs, one the fleet has not
    /// weighed.
    pub fn stop_background(
        &self,
        allowed: &HashSet<i64>,
    ) -> Result<BackgroundStopResult, DesktopHostError> {
        self.inner.stop_background(allowed)
    }

    /// What the last `quiet_except` found running, for the diagnosis log: the session ids (cut
    /// to 8 characters) of the transcripts whose turn was unfinished, the names of the
    /// processes counted as work, and whether a CPU sample to compare with was there. Never a
    /// path or text.
    pub fn quiet_detail(&self) -> Map<String, Value> {
        let list = |names: &[String]| {
            let mut unique: Vec<&str> = Vec::new();
            for name in names {
                if !unique.contains(&name.as_str()) {
                    unique.push(name);
                }
            }
            let joined = unique.into_iter().take(6).collect::<Vec<_>>().join(" ");
            joined.chars().take(120).collect::<String>()
        };
        let state = self.inner.state();
        let mut detail = Map::new();
        if let Some(last) = &state.last_quiet {
            detail.insert("busy".into(), json!(list(&last.busy)));
            detail.insert("work".into(), json!(list(&last.work)));
            detail.insert("sampled".into(), json!(last.sampled));
        }
        detail
    }

    /// The variant of `quiet_except` for the checks immediately before quit and writes.
    pub fn quiet_except_sync(
        &self,
        stops: &[QuotaStop],
    ) -> Result<Option<String>, DesktopHostError> {
        self.inner.quiet_except_sync(stops)
    }

    /// The stopped conversation has not moved on: its transcript still begins with the bytes
    /// seen at the stop, and nothing written after them is a new turn. Claude keeps writing
    /// rows of its own to a stopped conversation, the more so as it quits and starts again
    /// (`last-prompt`, `cost-state`, titles, modes, queue operations, and background task
    /// notifications Claude Code never answers out of quota); none of them is a turn. A prompt,
    /// an answer, or a prompt queued to be sent is. A transcript that cannot be read, or one
    /// being written mid-line, is not known to be unchanged.
    pub fn unchanged(&self, stop: &QuotaStop) -> bool {
        let Ok(data) = fs::read(
            self.inner
                .options
                .transcript_root
                .join(&stop.transcript_relative),
        ) else {
            return false;
        };
        let bytes = stop.transcript_bytes as usize;
        if (data.len() as u64) < stop.transcript_bytes
            || sha(&data[..bytes]) != stop.transcript_sha256
        {
            return false;
        }
        data.len() == bytes
            || parse_desktop_transcript(&data[bytes..]).is_ok_and(|rows| !moved_on(&rows))
    }

    /// Delivery of one continuation marker appended after the observed stop: `absent`,
    /// `accepted`, `started` or `unknown`.
    pub fn delivery_after(
        &self,
        stop: &QuotaStop,
        request_id: &str,
    ) -> Result<DeliveryStatus, DesktopHostError> {
        let data = read_bytes(
            &self.inner.options.transcript_root,
            &stop.transcript_relative,
        )
        .map_err(file_error)?;
        let Some(data) = data.filter(|data| {
            data.len() as u64 >= stop.transcript_bytes
                && sha(&data[..stop.transcript_bytes as usize]) == stop.transcript_sha256
        }) else {
            return Ok(DeliveryStatus::Unknown);
        };
        let Ok(appended) = parse_desktop_transcript(&data[stop.transcript_bytes as usize..]) else {
            return Ok(DeliveryStatus::Unknown);
        };
        let users = marker_users(&appended, request_id);
        if users.is_empty() {
            return Ok(DeliveryStatus::Absent);
        }
        if users.len() != 1 {
            return Ok(DeliveryStatus::Unknown);
        }
        let Some(turn) = continuation_turn(&appended, Some(request_id))
            .filter(|turn| turn.user.get("uuid") == users[0].get("uuid"))
        else {
            return Ok(DeliveryStatus::Unknown);
        };
        Ok(if turn.assistant.is_some() {
            DeliveryStatus::Started
        } else {
            DeliveryStatus::Accepted
        })
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, EvidenceState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now(&self) -> f64 {
        match &self.options.now {
            Some(now) => now(),
            None => crate::clock::now_ms() as f64,
        }
    }

    fn processes(&self) -> Result<String, DesktopHostError> {
        match &self.options.processes {
            Some(processes) => processes(),
            None => collect_processes(),
        }
    }

    fn processes_sync(&self) -> Result<String, DesktopHostError> {
        match &self.options.processes_sync {
            Some(processes) => processes(),
            None => collect_processes(),
        }
    }

    /// Count other recently written transcripts whose turn is unfinished. Each one's session
    /// id, cut to 8 characters, goes into `names` for the diagnosis log.
    fn busy_transcripts(&self, excluded: &HashSet<String>, names: &mut Vec<String>) -> f64 {
        let root = self.options.transcript_root.join("projects");
        let cutoff = self.now() - LIVE_TRANSCRIPT_MS;
        let mut busy = 0.0;
        let Ok(folders) = fs::read_dir(&root) else {
            return 0.0;
        };
        for folder in folders.flatten() {
            if !folder.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let folder_name = folder.file_name().to_string_lossy().into_owned();
            let Ok(files) = fs::read_dir(root.join(&folder_name)) else {
                continue;
            };
            for entry in files.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let relative = format!("projects/{folder_name}/{name}");
                if excluded.contains(&relative) {
                    continue;
                }
                let file = root.join(&folder_name).join(&name);
                let read = || -> Result<Option<TurnState>, std::io::Error> {
                    let stat = fs::symlink_metadata(&file)?;
                    if !stat.is_file() || mtime_ms(&stat)? < cutoff {
                        return Ok(None);
                    }
                    let length = stat.len().min(TAIL_BYTES);
                    let mut buffer = vec![0u8; length as usize];
                    let mut handle = File::open(&file)?;
                    read_at(&mut handle, &mut buffer, stat.len() - length)?;
                    let data = if stat.len() > length {
                        let mut data = Vec::with_capacity(buffer.len() + 1);
                        data.push(b'\n');
                        data.extend_from_slice(&buffer);
                        data
                    } else {
                        buffer
                    };
                    Ok(Some(transcript_turn_state(&transcript_tail(&data))))
                };
                match read() {
                    Ok(None | Some(TurnState::Idle)) => {}
                    Ok(Some(TurnState::Busy)) | Err(_) => {
                        busy += 1.0;
                        names.push(name.chars().take(8).collect());
                    }
                }
            }
        }
        busy
    }

    /// Processes whose CPU time advanced since the previous sample (None on the first).
    fn active_pids(&self) -> Result<Option<HashSet<i64>>, DesktopHostError> {
        // Taken before the reading: a slow `ps` must not overwrite a newer sample.
        let at = self.now();
        let output = match &self.options.cpu_times {
            Some(cpu_times) => cpu_times()?,
            None => ps(&["-axo", "pid=,time="])?,
        };
        Ok(self.sample_cpu(&output, at))
    }

    /// `at` is when the reading started; one older than the stored sample is dropped (not
    /// measured).
    fn sample_cpu(&self, output: &str, at: f64) -> Option<HashSet<i64>> {
        let mut state = self.state();
        if state.cpu.as_ref().is_some_and(|previous| at < previous.at) {
            return None;
        }
        let times = parse_cpu_times(output);
        let previous = state.cpu.replace(CpuSample { at, times });
        let previous = previous.filter(|previous| at - previous.at <= 120_000.0)?;
        let current = &state.cpu.as_ref().expect("just stored").times;
        Some(
            current
                .iter()
                .filter(|(pid, seconds)| {
                    previous
                        .times
                        .get(pid)
                        .is_none_or(|before| *seconds - before > IDLE_CPU_SECONDS)
                })
                .map(|(pid, _)| *pid)
                .collect(),
        )
    }

    fn measure(
        &self,
        excluded: &HashSet<String>,
        names: Option<&mut Vec<String>>,
    ) -> Result<QuiescenceInputs, DesktopHostError> {
        let mut scratch = Vec::new();
        let busy = self.busy_transcripts(excluded, names.unwrap_or(&mut scratch));
        Ok(QuiescenceInputs {
            busy_transcripts: Some(busy),
            active_pids: self.active_pids()?,
            ..QuiescenceInputs::default()
        })
    }

    /// Remember Claude's process tree so engines orphaned by a quit are noticed.
    fn remember(&self, raw: &str, app_pid: i64) {
        // An unreadable census keeps the previous family; it already blocks.
        if let Ok(rows) = serde_json::from_str::<Vec<DesktopProcess>>(raw) {
            self.remember_rows(&rows, app_pid);
        }
    }

    fn remember_rows(&self, rows: &[DesktopProcess], app_pid: i64) {
        let mut family = HashSet::from([app_pid]);
        let mut size = usize::MAX;
        while size != family.len() {
            size = family.len();
            for row in rows {
                if family.contains(&row.ppid) {
                    family.insert(row.pid);
                }
            }
        }
        self.state().family = family;
    }

    fn transcript(&self, cli_id: &str, cwd: &str) -> Result<Transcript, DesktopHostError> {
        let root = &self.options.transcript_root;
        let folders = fs::read_dir(root.join("projects")).map_err(io_error)?;
        let wanted = resolve(Path::new(cwd));
        let mut found = Vec::new();
        for folder in folders {
            let folder = folder.map_err(io_error)?;
            if !folder.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let relative = format!(
                "projects/{}/{cli_id}.jsonl",
                folder.file_name().to_string_lossy()
            );
            let Some(data) = read_bytes(root, &relative).map_err(file_error)? else {
                continue;
            };
            let rows = parse_desktop_transcript(&data)?;
            // Rows record the shell's working directory, which moves as tools `cd`. The
            // session belongs to the project if any row was written from it.
            let ours = rows
                .iter()
                .filter_map(|row| row_str(row, "cwd"))
                .any(|path| resolve(Path::new(path)) == wanted);
            if !ours {
                return Err(issue(DesktopAutomationIssue::ExactSessionNotObserved));
            }
            found.push(Transcript {
                relative,
                data,
                rows,
            });
        }
        if found.len() != 1 {
            return Err(issue(DesktopAutomationIssue::ExactSessionNotObserved));
        }
        Ok(found.remove(0))
    }

    /// `transcript` for quota-stop polling: the same file and project checks, but read
    /// incrementally instead of loading and parsing every row on each poll. Each file looked at
    /// is added to `scanned`.
    fn scanned_transcript(
        &self,
        state: &mut EvidenceState,
        cli_id: &str,
        cwd: &str,
        folders: &mut dyn FnMut() -> Result<Vec<String>, DesktopHostError>,
        scanned: &mut HashSet<PathBuf>,
    ) -> Result<Scanned, DesktopHostError> {
        let now = self.now();
        // The folder a probe found it in alone is looked at first, and alone, until that probe
        // is FOLDER_PROBE_MS old: then every folder is probed again, so a later duplicate is
        // noticed.
        if let Some((folder, at)) = state.project_folders.get(cli_id).cloned() {
            if now - at >= FOLDER_PROBE_MS || now < at {
                state.project_folders.remove(cli_id);
            } else {
                let mut found = self.scanned_in(state, &[folder], cli_id, cwd, scanned)?;
                if found.len() == 1 {
                    return Ok(found.remove(0));
                }
                state.project_folders.remove(cli_id);
            }
        }
        state
            .unplaced
            .retain(|_, at| !(now - *at >= FOLDER_PROBE_MS || now < *at));
        if state.unplaced.contains_key(cli_id) {
            return Err(issue(DesktopAutomationIssue::ExactSessionNotObserved));
        }
        // A transcript still being written fails here and is probed again next time.
        let listed = folders()?;
        let mut found = self.scanned_in(state, &listed, cli_id, cwd, scanned)?;
        if found.len() != 1 {
            state.unplaced.insert(cli_id.to_owned(), now);
            return Err(issue(DesktopAutomationIssue::ExactSessionNotObserved));
        }
        let found = found.remove(0);
        state
            .project_folders
            .insert(cli_id.to_owned(), (found.folder.clone(), now));
        Ok(found)
    }

    /// The transcripts of `cli_id` in `folders`, each scanned and added to `scanned`.
    fn scanned_in(
        &self,
        state: &mut EvidenceState,
        folders: &[String],
        cli_id: &str,
        cwd: &str,
        scanned: &mut HashSet<PathBuf>,
    ) -> Result<Vec<Scanned>, DesktopHostError> {
        let root = &self.options.transcript_root;
        let wanted = resolve(Path::new(cwd));
        let mut found = Vec::new();
        for folder in folders {
            let relative = format!("projects/{folder}/{cli_id}.jsonl");
            let file = resolve(&root.join(&relative));
            match fs::symlink_metadata(&file) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(io_error(e)),
            }
            // No symbolic link anywhere on the path, as read_bytes requires.
            safe_file(root, &relative).map_err(file_error)?;
            scanned.insert(file.clone());
            let summary = state.scanner.scan(&file)?;
            if !summary.cwds.contains(&wanted) {
                return Err(issue(DesktopAutomationIssue::ExactSessionNotObserved));
            }
            found.push(Scanned {
                folder: folder.clone(),
                relative,
                summary,
            });
        }
        Ok(found)
    }

    fn quota_stops(
        &self,
        account: &Account,
        within_ms: Option<f64>,
    ) -> Result<Vec<QuotaStop>, DesktopHostError> {
        let within_ms = within_ms.unwrap_or(6.0 * 60.0 * 60_000.0);
        let Some(desktop) = &account.desktop else {
            return Ok(Vec::new());
        };
        let relative = scope_path("claude-code-sessions", &scope(desktop)).map_err(file_error)?;
        let sessions = self.options.claude_root.join(&relative);
        let Ok(entries) = fs::read_dir(&sessions) else {
            return Ok(Vec::new());
        };
        let names: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let cutoff = self.now() - within_ms;
        let mut stops: Vec<QuotaStop> = Vec::new();
        let projects = self.options.transcript_root.join("projects");
        let mut listing: Option<Result<Vec<String>, DesktopHostError>> = None;
        let mut folders = || -> Result<Vec<String>, DesktopHostError> {
            listing
                .get_or_insert_with(|| {
                    let entries = fs::read_dir(&projects).map_err(io_error)?;
                    let mut names = Vec::new();
                    for entry in entries {
                        let entry = entry.map_err(io_error)?;
                        if entry.file_type().is_ok_and(|t| t.is_dir()) {
                            names.push(entry.file_name().to_string_lossy().into_owned());
                        }
                    }
                    Ok(names)
                })
                .clone()
        };
        let mut scanned: HashSet<PathBuf> = HashSet::new();
        let mut state = self.state();
        for name in names {
            let Some(local) = LOCAL_FILE.captures(&name) else {
                continue;
            };
            // Polled every few seconds: skip records untouched since the window.
            match fs::metadata(sessions.join(&name)).and_then(|stat| mtime_ms(&stat)) {
                Ok(mtime) if mtime >= cutoff => {}
                _ => continue,
            }
            let Ok(Some(metadata)) =
                read_object(&self.options.claude_root, &format!("{relative}/{name}"))
            else {
                continue;
            };
            let cli = row_str(&metadata, "cliSessionId");
            let cwd = row_str(&metadata, "cwd");
            let (Some(cli), Some(cwd)) = (cli.filter(|id| UUID.is_match(id)), cwd) else {
                continue;
            };
            if truthy(&metadata, "archived")
                || truthy(&metadata, "isArchived")
                || !Path::new(cwd).is_absolute()
                // NaN, a missing or unreadable time, is never in the window.
                || js_number(metadata.get("lastActivityAt"))
                    .partial_cmp(&cutoff)
                    .is_none_or(|order| order.is_lt())
            {
                continue;
            }
            let Ok(transcript) =
                self.scanned_transcript(&mut state, cli, cwd, &mut folders, &mut scanned)
            else {
                continue;
            };
            let summary = &transcript.summary;
            let tail: Vec<&Row> = [summary.before_notifications.as_ref(), summary.last.as_ref()]
                .into_iter()
                .flatten()
                .collect();
            let now = self.now();
            let Some(ended) = latest_quota_ended(&tail).filter(|ended| {
                ended.timestamp.is_finite() && ended.timestamp >= cutoff && ended.timestamp <= now
            }) else {
                continue;
            };
            stops.push(QuotaStop {
                local_session_id: local[1].to_owned(),
                cli_session_id: cli.to_lowercase(),
                project_key: resolve(Path::new(cwd)).to_string_lossy().into_owned(),
                permission_mode: ui_permission_mode(metadata.get("permissionMode"))
                    .map(str::to_owned),
                turn_id: ended.turn_id,
                stopped_at: ended.timestamp,
                transcript_relative: transcript.relative,
                transcript_bytes: summary.bytes,
                transcript_sha256: summary.sha256.clone(),
                trigger: summary.trigger,
            });
        }
        state.scanner.retain(&scanned);
        stops.sort_by(|a, b| b.stopped_at.total_cmp(&a.stopped_at));
        Ok(stops)
    }

    fn quiet_except(&self, stops: &[QuotaStop]) -> Result<Option<String>, DesktopHostError> {
        let raw = self.processes()?;
        let app = match self.claude_app(&raw) {
            ClaudeApp::Running(pid) => pid,
            other => {
                self.state().background = Vec::new();
                return Ok(app_reason(other));
            }
        };
        let mut busy = Vec::new();
        let excluded: HashSet<String> = stops
            .iter()
            .map(|stop| stop.transcript_relative.clone())
            .collect();
        let measured = self.measure(&excluded, Some(&mut busy))?;
        // Background commands are the fleet's to wait for or stop, not unknown work.
        let commands = commands_in(&raw, app);
        let mut inputs = QuiescenceInputs {
            work: Some(Vec::new()),
            ignore: Some(commands.iter().flat_map(|c| c.pids.clone()).collect()),
            ..measured.clone()
        };
        let reason = quiet_reason(&raw, app, &mut inputs);
        let background = self.weigh(&commands, measured.active_pids.as_ref());
        let mut state = self.state();
        state.background = background;
        state.last_quiet = Some(LastQuiet {
            busy,
            work: inputs.work.unwrap_or_default(),
            sampled: measured.active_pids.is_some(),
        });
        Ok(reason)
    }

    /// Each command with its ports and times; a first look without a CPU sample counts as
    /// working.
    fn weigh(
        &self,
        commands: &[EngineCommand],
        active: Option<&HashSet<i64>>,
    ) -> Vec<BackgroundCommand> {
        let now = self.now();
        let times: HashMap<i64, CommandTimes> = {
            let mut state = self.state();
            let mut times = HashMap::new();
            for command in commands {
                let before = state.command_times.get(&command.pid).copied();
                let working =
                    active.is_none_or(|active| command.pids.iter().any(|pid| active.contains(pid)));
                times.insert(
                    command.pid,
                    CommandTimes {
                        seen_at: before.map_or(now, |b| b.seen_at),
                        active_at: if working {
                            Some(now)
                        } else {
                            before.and_then(|b| b.active_at)
                        },
                    },
                );
            }
            state.command_times = times.clone();
            times
        };
        let ports = if commands.is_empty() {
            IndexMap::new()
        } else {
            let pids: Vec<i64> = commands.iter().flat_map(|c| c.pids.clone()).collect();
            match &self.options.listening_ports {
                Some(lookup) => lookup(&pids),
                None => listening_ports(&pids),
            }
        };
        commands
            .iter()
            .map(|command| {
                let mut listened: Vec<i64> = Vec::new();
                for pid in &command.pids {
                    for port in ports.get(pid).into_iter().flatten() {
                        if !listened.contains(port) {
                            listened.push(*port);
                        }
                    }
                }
                let at = times[&command.pid];
                BackgroundCommand {
                    pid: command.pid,
                    pids: command.pids.clone(),
                    names: command.names.clone(),
                    ports: listened,
                    seen_at: at.seen_at,
                    active_at: at.active_at,
                }
            })
            .collect()
    }

    fn stop_background(
        &self,
        allowed: &HashSet<i64>,
    ) -> Result<BackgroundStopResult, DesktopHostError> {
        let raw = self.processes()?;
        let ClaudeApp::Running(app) = self.claude_app(&raw) else {
            return Ok(BackgroundStopResult::default());
        };
        let commands = commands_in(&raw, app);
        let unexpected = commands
            .iter()
            .filter(|command| !allowed.contains(&command.pid))
            .count();
        if unexpected > 0 || commands.is_empty() {
            return Ok(BackgroundStopResult {
                stopped: Vec::new(),
                left: 0,
                unexpected,
            });
        }
        let signal = |pid: i64, signal: Signal| match &self.options.signal {
            Some(send) => send(pid, signal),
            None => send_signal(pid, signal),
        };
        let pids: Vec<i64> = commands.iter().flat_map(|c| c.pids.clone()).collect();
        let send = |name: Signal| {
            for command in &commands {
                signal(-command.pid, name);
            }
            for pid in &pids {
                signal(*pid, name);
            }
        };
        let alive = || {
            pids.iter()
                .filter(|pid| signal(**pid, Signal::Probe))
                .count()
        };
        let wait = |ms: u64| match &self.options.sleep {
            Some(sleep) => sleep(ms),
            None => std::thread::sleep(Duration::from_millis(ms)),
        };
        send(Signal::Term);
        for _ in 0..20 {
            if alive() == 0 {
                break;
            }
            wait(250);
        }
        if alive() > 0 {
            send(Signal::Kill);
            for _ in 0..8 {
                if alive() == 0 {
                    break;
                }
                wait(250);
            }
        }
        let mut stopped: Vec<String> = Vec::new();
        for name in commands.iter().flat_map(|c| c.names.iter()) {
            if !stopped.contains(name) {
                stopped.push(name.clone());
            }
        }
        Ok(BackgroundStopResult {
            stopped,
            left: alive(),
            unexpected: 0,
        })
    }

    fn quiet_except_sync(&self, stops: &[QuotaStop]) -> Result<Option<String>, DesktopHostError> {
        let raw = self.processes_sync()?;
        let app = match self.claude_app(&raw) {
            ClaudeApp::Running(pid) => pid,
            other => return Ok(app_reason(other)),
        };
        let excluded: HashSet<String> = stops
            .iter()
            .map(|stop| stop.transcript_relative.clone())
            .collect();
        let mut inputs = QuiescenceInputs {
            ignore: Some(
                commands_in(&raw, app)
                    .iter()
                    .flat_map(|c| c.pids.clone())
                    .collect(),
            ),
            ..self.measure(&excluded, None)?
        };
        Ok(quiet_reason(&raw, app, &mut inputs))
    }

    /// Claude's main pid in a census, its tree remembered.
    fn claude_app(&self, raw: &str) -> ClaudeApp {
        let Ok(rows) = serde_json::from_str::<Vec<DesktopProcess>>(raw) else {
            return ClaudeApp::Unverified;
        };
        match rows.iter().find(|row| is_main_claude_app(row)) {
            None => ClaudeApp::Closed,
            Some(app) => {
                self.remember_rows(&rows, app.pid);
                ClaudeApp::Running(app.pid)
            }
        }
    }

    fn read(
        &self,
        snapshot: &DesktopAutomationSnapshot,
    ) -> Result<DesktopContinuationObservation, DesktopHostError> {
        let not_observed = || issue(DesktopAutomationIssue::ExactSessionNotObserved);
        let desktop = self.options.desktop.snapshot().map_err(desktop_error)?;
        let local = snapshot
            .local_session_id
            .clone()
            .filter(|id| !id.is_empty());
        let current = desktop
            .current_account_uuid
            .clone()
            .filter(|id| !id.is_empty());
        let (Some(local), Some(current)) = (local, current) else {
            return Err(not_observed());
        };
        if desktop.recovery_required
            || desktop
                .pending_profile_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
        {
            return Err(not_observed());
        }
        let accounts = self.options.store.with_state(|s| s.accounts.clone());
        let mut matches = Vec::new();
        for account in &accounts {
            let Some(desktop) = account
                .desktop
                .as_ref()
                .filter(|d| d.account_uuid.to_lowercase() == current.to_lowercase())
            else {
                continue;
            };
            let relative = format!(
                "{}/{local}.json",
                scope_path("claude-code-sessions", &scope(desktop)).map_err(file_error)?
            );
            if let Some(metadata) =
                read_object(&self.options.claude_root, &relative).map_err(file_error)?
            {
                matches.push((account, desktop, metadata));
            }
        }
        if matches.len() != 1 {
            return Err(not_observed());
        }
        let (account, account_desktop, metadata) = matches.remove(0);
        let scopes = &desktop.organizations;
        let label = |text: &str| trim(text).nfc().collect::<String>().to_lowercase();
        let organization_label = account
            .auth
            .as_ref()
            .and_then(|auth| auth.org_name.as_deref())
            .map(label)
            .filter(|l| !l.is_empty());
        let ui_label = snapshot
            .account_label
            .as_deref()
            .map(label)
            .filter(|l| !l.is_empty());
        let org = account_desktop.org_id.to_lowercase();
        let unique_scope = scopes.len() == 1 && scopes[0].to_lowercase() == org;
        let labeled_scope = match (&organization_label, &ui_label) {
            (Some(organization), Some(ui)) => {
                ui.ends_with(organization.as_str()) && scopes.contains(&account_desktop.org_id)
            }
            _ => false,
        };
        // An account often has empty folders for other organizations it belongs to, and its UI
        // label is usually a name, not the organization. The open conversation's own record
        // identifies the organization when it exists only under the registered one.
        let mut session_scope =
            !unique_scope && !labeled_scope && scopes.iter().any(|s| s.to_lowercase() == org);
        if session_scope {
            for other in scopes {
                if other.to_lowercase() == org {
                    continue;
                }
                let elsewhere = Scope {
                    account_uuid: account_desktop.account_uuid.clone(),
                    org_id: other.clone(),
                };
                let relative = format!(
                    "{}/{local}.json",
                    scope_path("claude-code-sessions", &elsewhere).map_err(file_error)?
                );
                if read_bytes(&self.options.claude_root, &relative)
                    .map_err(file_error)?
                    .is_some()
                {
                    session_scope = false;
                }
            }
        }
        if !unique_scope && !labeled_scope && !session_scope {
            return Err(issue(DesktopAutomationIssue::DesktopObservationIncomplete));
        }
        let cli = row_str(&metadata, "cliSessionId").filter(|id| UUID.is_match(id));
        let cwd = row_str(&metadata, "cwd").filter(|cwd| Path::new(cwd).is_absolute());
        let permission_mode = snapshot
            .permission_mode
            .clone()
            .filter(|mode| !mode.is_empty());
        let (Some(cli), Some(cwd), Some(permission_mode)) = (cli, cwd, permission_mode) else {
            return Err(not_observed());
        };
        if truthy(&metadata, "archived") || truthy(&metadata, "isArchived") {
            return Err(not_observed());
        }
        let transcript = self.transcript(cli, cwd)?;
        let tail = transcript.rows.iter().rev().find(|r| {
            matches!(row_str(r, "type"), Some("user" | "assistant"))
                && !truthy(r, "isMeta")
                && !truthy(r, "isSidechain")
        });
        let ended = latest_quota_ended_turn(&transcript.rows);
        let continuation = continuation_turn(&transcript.rows, None);
        let now = self.now();
        let stopped = snapshot.status == SessionStatus::Stopped;
        let fresh_end = snapshot.quota_stopped
            && stopped
            && ended
                .as_ref()
                .is_some_and(|e| e.timestamp.is_finite() && e.timestamp <= now);
        let selected_ended = stopped
            && (ended.is_some()
                || tail.is_some_and(|tail| {
                    row_str(tail, "type") == Some("assistant")
                        && matches!(
                            tail.get("message")
                                .and_then(|m| m.get("stop_reason"))
                                .and_then(Value::as_str),
                            Some("end_turn" | "max_tokens" | "stop_sequence")
                        )
                }));
        let processes = self.processes()?;
        self.remember(&processes, snapshot.pid);
        let mut inputs = self.measure(&HashSet::from([transcript.relative.clone()]), None)?;
        let mut quiescence =
            desktop_process_quiescence(&processes, snapshot.pid, cli, selected_ended, &mut inputs);
        if truthy(&metadata, "remoteSessionId")
            || truthy(&metadata, "sshHost")
            || matches!(row_str(&metadata, "sessionType"), Some("remote" | "ssh"))
        {
            quiescence.coverage = QuiescenceCoverage::Unknown;
            quiescence.unknown_work += 1.0;
        }
        if !snapshot.composer_empty {
            quiescence.queued_prompts += 1.0;
        }
        if snapshot.status == SessionStatus::Waiting {
            quiescence.waiting += 1.0;
        }
        // Work in other conversations is measured from transcripts and processes. Labels such
        // as "Running" or "Scheduled" also appear in ordinary rows, so only the selected
        // conversation's own quota-resume timer counts here.
        let auto_resume = snapshot.quota_auto_resume == Some(true);
        if auto_resume {
            quiescence.scheduled_wakeups += 1.0;
        }
        let session = ContinuationSession {
            id: cli.to_lowercase(),
            project_key: resolve(Path::new(cwd)).to_string_lossy().into_owned(),
            transcript_revision: sha(&transcript.data),
            permission_mode,
            status: snapshot.status,
            last_request_id: continuation.map(|c| c.request_id),
            last_turn_id: tail
                .and_then(|t| row_str(t, "uuid"))
                .filter(|id| UUID.is_match(id))
                .map(str::to_owned),
        };
        let identity = ContinuationIdentity {
            profile_id: account.id.clone(),
            account_uuid: account_desktop.account_uuid.to_lowercase(),
            org_id: account_desktop.org_id.to_lowercase(),
        };
        let signature = sha(json!({
            "identity": identity,
            "session": session_value(&session),
            "localSessionId": local,
            "ui": snapshot.context_fingerprint,
            "quiescence": quiescence,
        })
        .to_string()
        .as_bytes());
        let revision = {
            let mut state = self.state();
            if signature != state.signature {
                state.signature = signature;
                state.revision += 1.0;
            }
            state.revision
        };
        let own_quota_wakeup = fresh_end && auto_resume && quiescence.scheduled_wakeups == 1.0;
        let quota_stop = match (&ended, fresh_end) {
            (Some(ended), true) => Some(DesktopQuotaStop {
                reason: QuotaStopReason::RateLimit,
                session_id: session.id.clone(),
                turn_id: ended.turn_id.clone(),
                observed_at: now,
            }),
            _ => None,
        };
        Ok(DesktopContinuationObservation {
            state: ContinuationState {
                context_revision: revision,
                observed_at: now,
                identity,
                session,
                quiescence,
            },
            own_quota_wakeup: Some(own_quota_wakeup),
            local_session_id: local,
            quota_stop,
        })
    }

    fn inspect_and_read(&self) -> Result<DesktopContinuationObservation, DesktopHostError> {
        let snapshot = self.options.automation.inspect()?;
        self.read(&snapshot)
    }

    fn file(&self, request_id: &str) -> Result<PathBuf, DesktopHostError> {
        if !REQUEST.is_match(request_id) {
            return Err(issue(DesktopAutomationIssue::DesktopUiUnsupported));
        }
        Ok(self.records_root.join(format!("{request_id}.json")))
    }

    fn write_record(
        &self,
        request_id: &str,
        raw: &Map<String, Value>,
    ) -> Result<(), DesktopHostError> {
        write_private_json(&self.file(request_id)?, raw, MAX_BYTES)
            .map_err(|e| DesktopHostError::other(e.to_string()))
    }

    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, DesktopHostError> {
        let current = self.inspect_and_read()?;
        if current.state.context_revision != input.expected_context_revision
            || current.state.session.id != input.session.id
            || current.state.session.transcript_revision != input.session.transcript_revision
        {
            return Err(issue(DesktopAutomationIssue::ContextChanged));
        }
        let account = self
            .options
            .store
            .account(&current.state.identity.profile_id)
            .map_err(|e| DesktopHostError::other(e.to_string()))?;
        let desktop = account
            .desktop
            .as_ref()
            .ok_or_else(|| DesktopHostError::other("Cannot read properties of undefined"))?;
        let relative = format!(
            "{}/{}.json",
            scope_path("claude-code-sessions", &scope(desktop)).map_err(file_error)?,
            current.local_session_id
        );
        let metadata = read_object(&self.options.claude_root, &relative).map_err(file_error)?;
        let cwd = metadata
            .as_ref()
            .and_then(|m| row_str(m, "cwd"))
            .ok_or_else(|| {
                DesktopHostError::other("Cannot read properties of null (reading 'cwd')")
            })?;
        let transcript = self.transcript(&input.session.id, cwd)?;
        let checkpoint = ContinuationCheckpoint {
            id: input.request_id.clone(),
            session: input.session.clone(),
        };
        let mut raw = Map::new();
        raw.insert("version".into(), json!(1));
        raw.insert("requestId".into(), json!(input.request_id));
        raw.insert(
            "checkpoint".into(),
            json!({ "id": checkpoint.id, "session": session_value(&checkpoint.session) }),
        );
        raw.insert("source".into(), json!(current.state.identity));
        raw.insert("localSessionId".into(), json!(current.local_session_id));
        raw.insert("transcriptRelative".into(), json!(transcript.relative));
        raw.insert("transcriptBytes".into(), json!(transcript.data.len()));
        raw.insert("transcriptSha256".into(), json!(sha(&transcript.data)));
        raw.insert("createdAt".into(), number(self.now()));
        self.write_record(&input.request_id, &raw)?;
        Ok(checkpoint)
    }

    fn record(&self, request_id: &str) -> Result<CheckpointRecord, DesktopHostError> {
        let value = read_private_json(&self.file(request_id)?, MAX_BYTES)
            .map_err(|e| DesktopHostError::other(e.to_string()))?;
        let invalid = || issue(DesktopAutomationIssue::DesktopObservationIncomplete);
        let Value::Object(raw) = value else {
            return Err(invalid());
        };
        let valid = raw.get("version").and_then(Value::as_f64) == Some(1.0)
            && row_str(&raw, "requestId") == Some(request_id)
            && truthy(&raw, "checkpoint")
            && LOCAL_ID.is_match(row_str(&raw, "localSessionId").unwrap_or(""))
            && raw.get("transcriptBytes").and_then(safe_integer).is_some()
            && SHA_HEX.is_match(row_str(&raw, "transcriptSha256").unwrap_or(""));
        if !valid {
            return Err(invalid());
        }
        // Fields the TS reads without checking are required here: a record without them
        // cannot be used either way.
        let checkpoint: ContinuationCheckpoint =
            serde_json::from_value(raw["checkpoint"].clone()).map_err(|_| invalid())?;
        let target = match raw.get("target") {
            None | Some(Value::Null) => None,
            Some(value) => Some(serde_json::from_value(value.clone()).map_err(|_| invalid())?),
        };
        let transcript_relative = row_str(&raw, "transcriptRelative")
            .ok_or_else(invalid)?
            .to_owned();
        let transcript_bytes = u64::try_from(
            raw.get("transcriptBytes")
                .and_then(safe_integer)
                .unwrap_or(-1),
        )
        .map_err(|_| invalid())?;
        Ok(CheckpointRecord {
            checkpoint,
            target,
            local_session_id: row_str(&raw, "localSessionId").unwrap_or("").to_owned(),
            transcript_relative,
            transcript_bytes,
            transcript_sha256: row_str(&raw, "transcriptSha256").unwrap_or("").to_owned(),
            raw,
        })
    }

    fn local_session_id(
        &self,
        checkpoint: &ContinuationCheckpoint,
    ) -> Result<String, DesktopHostError> {
        let record = self.record(&checkpoint.id)?;
        if record.checkpoint.session.id != checkpoint.session.id
            || record.checkpoint.session.transcript_revision
                != checkpoint.session.transcript_revision
        {
            return Err(issue(DesktopAutomationIssue::ContextChanged));
        }
        Ok(record.local_session_id)
    }

    /// `canProceed`: rechecked by `DesktopManager` immediately before graceful quit and before
    /// each write. No frozen last-known-safe process list authorizes restart.
    fn can_proceed(
        &self,
        current: &DesktopContinuationObservation,
        record: &CheckpointRecord,
        snapshot_pid: i64,
    ) -> bool {
        let check = || -> Result<bool, DesktopHostError> {
            let raw = self.processes_sync()?;
            let parsed: Vec<DesktopProcess> =
                serde_json::from_str(&raw).map_err(|e| DesktopHostError::other(e.to_string()))?;
            if !parsed.iter().any(|p| p.pid == snapshot_pid) {
                // After graceful quit, an engine of the old Claude that is still alive could
                // still write; a newly started Claude also blocks the write.
                let family = self.state().family.clone();
                return Ok(!parsed.iter().any(|p| {
                    (family.contains(&p.pid) && is_desktop_claude_engine(p))
                        || is_main_claude_app(p)
                }));
            }
            self.remember(&raw, snapshot_pid);
            let mut inputs =
                self.measure(&HashSet::from([record.transcript_relative.clone()]), None)?;
            let q = desktop_process_quiescence(
                &raw,
                snapshot_pid,
                &current.state.session.id,
                true,
                &mut inputs,
            );
            let config: Value = serde_json::from_slice(
                &fs::read(self.options.claude_root.join("config.json")).map_err(io_error)?,
            )
            .map_err(|e| DesktopHostError::other(e.to_string()))?;
            let transcript = fs::read(
                self.options
                    .transcript_root
                    .join(&record.transcript_relative),
            )
            .map_err(io_error)?;
            let unchanged = sha(&transcript) == current.state.session.transcript_revision;
            let account = config
                .get("lastKnownAccountUuid")
                .and_then(Value::as_str)
                .map(str::to_lowercase);
            Ok(unchanged
                && account.as_deref() == Some(current.state.identity.account_uuid.as_str())
                && quiet_counters(&q))
        };
        check().unwrap_or(false)
    }

    /// `beforeQuit`: the conversation, read again, is still the one stopped at the limit and
    /// nothing else works.
    fn before_quit(
        &self,
        current: &DesktopContinuationObservation,
        expected_context_revision: f64,
    ) -> Result<(), DesktopHostError> {
        let fresh = self.inspect_and_read()?;
        let (now, was) = (&fresh.state, &current.state);
        if now.context_revision != expected_context_revision
            || now.identity.profile_id != was.identity.profile_id
            || now.session.id != was.session.id
            || now.session.transcript_revision != was.session.transcript_revision
            || now.session.permission_mode != was.session.permission_mode
            || now.session.status != SessionStatus::Stopped
            || fresh.quota_stop.is_none()
            || !quiet_counters(&now.quiescence)
        {
            return Err(issue(DesktopAutomationIssue::DesktopWorkActive));
        }
        Ok(())
    }

    fn switch_account(
        self: &Arc<Self>,
        input: &ContinuationSwitchInput,
    ) -> Result<(), DesktopHostError> {
        let current = self.inspect_and_read()?;
        if current.state.context_revision != input.expected_context_revision
            || !quiet_counters(&current.state.quiescence)
            || current.quota_stop.is_none()
        {
            return Err(issue(DesktopAutomationIssue::DesktopWorkActive));
        }
        let target = self
            .options
            .store
            .account(&input.target.profile_id)
            .map_err(|e| DesktopHostError::other(e.to_string()))?;
        let matches = target.desktop.as_ref().is_some_and(|d| {
            d.account_uuid.to_lowercase() == input.target.account_uuid.to_lowercase()
                && d.org_id.to_lowercase() == input.target.org_id.to_lowercase()
        });
        if !matches {
            return Err(issue(DesktopAutomationIssue::ContextChanged));
        }
        let mut record = self.record(&input.request_id)?;
        record.raw.insert("target".into(), json!(input.target));
        record.target = Some(input.target.clone());
        self.write_record(&input.request_id, &record.raw)?;
        let current_snapshot = self.options.automation.inspect()?;
        let can_proceed = {
            let inner = Arc::clone(self);
            let (current, record) = (current.clone(), record.clone());
            let pid = current_snapshot.pid;
            Arc::new(move || inner.can_proceed(&current, &record, pid))
        };
        let before_quit = {
            let inner = Arc::clone(self);
            let current = current.clone();
            let expected = input.expected_context_revision;
            Arc::new(move || {
                inner
                    .before_quit(&current, expected)
                    .map_err(|e| DesktopError::new(e.message()))
            })
        };
        self.options
            .desktop
            .switch_to(
                &input.target.profile_id,
                DesktopSwitchOptions {
                    automatic: true,
                    can_proceed: Some(can_proceed),
                    before_quit: Some(before_quit),
                    ..DesktopSwitchOptions::default()
                },
            )
            .map_err(desktop_error)?;
        // Graceful launch is asynchronous and can land on a homepage. Establish the exact target
        // alias before the engine's post-switch identity/session read.
        let mut last_issue: Option<DesktopHostError> = None;
        // Claude may need a while after a cold launch, and a link delivered before its Code
        // view is ready can be dropped: resend it every five seconds.
        let mut opened_at: Option<Instant> = None;
        for _ in 0..120 {
            let mut attempt = || -> Result<bool, DesktopHostError> {
                let desktop = self.options.desktop.snapshot().map_err(desktop_error)?;
                if desktop.current_account_uuid.map(|id| id.to_lowercase())
                    != Some(input.target.account_uuid.to_lowercase())
                {
                    return Err(issue(DesktopAutomationIssue::ContextChanged));
                }
                let view = self.options.automation.inspect()?;
                if view.local_session_id.as_deref() != Some(record.local_session_id.as_str()) {
                    if opened_at.is_none_or(|at| at.elapsed() >= Duration::from_millis(5_000)) {
                        opened_at = Some(Instant::now());
                        self.options
                            .automation
                            .open_session(&record.local_session_id, None)?;
                    }
                    return Ok(false);
                }
                let target_state = self.read(&view)?;
                let (got, want) = (&target_state.state, &record.checkpoint.session);
                if got.identity.profile_id != input.target.profile_id
                    || got.session.id != want.id
                    || got.session.project_key != want.project_key
                    || got.session.transcript_revision != want.transcript_revision
                {
                    return Err(issue(DesktopAutomationIssue::ExactSessionNotObserved));
                }
                Ok(true)
            };
            match attempt() {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => last_issue = Some(error),
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err(last_issue.unwrap_or_else(|| issue(DesktopAutomationIssue::ExactSessionNotObserved)))
    }

    fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, DesktopHostError> {
        let unknown = ContinuationDelivery {
            status: DeliveryStatus::Unknown,
            receipt: None,
        };
        let status = |status| ContinuationDelivery {
            status,
            receipt: None,
        };
        let Ok(record) = self.record(request_id) else {
            return Ok(unknown);
        };
        let data = read_bytes(&self.options.transcript_root, &record.transcript_relative)
            .map_err(file_error)?;
        let bytes = record.transcript_bytes as usize;
        let Some(data) = data
            .filter(|data| data.len() >= bytes && sha(&data[..bytes]) == record.transcript_sha256)
        else {
            return Ok(unknown);
        };
        let appended = parse_desktop_transcript(&data[bytes..])?;
        let users = marker_users(&appended, request_id);
        if users.is_empty() {
            return Ok(status(DeliveryStatus::Absent));
        }
        let Some(target) = record.target.as_ref() else {
            return Ok(unknown);
        };
        if users.len() != 1 || !is_uuid(row_str(users[0], "uuid")) {
            return Ok(unknown);
        }
        let state = self.inspect_and_read()?;
        let (got, want) = (&state.state, &record.checkpoint.session);
        if got.identity.profile_id != target.profile_id
            || got.identity.account_uuid != target.account_uuid
            || got.identity.org_id != target.org_id
            || got.session.id != want.id
            || got.session.project_key != want.project_key
            || got.session.permission_mode != want.permission_mode
            || state.local_session_id != record.local_session_id
        {
            return Ok(unknown);
        }
        let Some(turn) = continuation_turn(&appended, Some(request_id))
            .filter(|turn| turn.user.get("uuid") == users[0].get("uuid"))
        else {
            return Ok(unknown);
        };
        let Some(assistant) = turn.assistant else {
            return Ok(status(DeliveryStatus::Accepted));
        };
        Ok(ContinuationDelivery {
            status: DeliveryStatus::Started,
            receipt: Some(ContinuationReceipt {
                request_id: request_id.to_owned(),
                identity: target.clone(),
                session_id: got.session.id.clone(),
                project_key: got.session.project_key.clone(),
                permission_mode: got.session.permission_mode.clone(),
                before_revision: want.transcript_revision.clone(),
                after_revision: sha(&data),
                turn_id: row_str(&assistant, "uuid").unwrap_or("").to_owned(),
            }),
        })
    }
}

fn app_reason(app: ClaudeApp) -> Option<String> {
    match app {
        ClaudeApp::Unverified => Some("quiescence-unverified".into()),
        ClaudeApp::Closed | ClaudeApp::Running(_) => None,
    }
}

fn commands_in(raw: &str, app: i64) -> Vec<EngineCommand> {
    serde_json::from_str::<Vec<DesktopProcess>>(raw)
        .map(|rows| engine_commands(&rows, app))
        .unwrap_or_default()
}

fn quiet_reason(raw: &str, app_pid: i64, inputs: &mut QuiescenceInputs) -> Option<String> {
    let q = desktop_process_quiescence(raw, app_pid, "", true, inputs);
    if q.coverage != QuiescenceCoverage::GuardedLocal {
        return Some("quiescence-unverified".into());
    }
    q.counters()
        .iter()
        .find(|(_, value)| *value != 0.0)
        .map(|(key, _)| format!("not-quiescent:{key}"))
}

impl DesktopContinuationEvidence for NativeDesktopContinuationEvidence {
    fn read(
        &self,
        snapshot: &DesktopAutomationSnapshot,
    ) -> Result<DesktopContinuationObservation, DesktopHostError> {
        self.inner.read(snapshot)
    }
    fn checkpoint(
        &self,
        input: &ContinuationCheckpointInput,
    ) -> Result<ContinuationCheckpoint, DesktopHostError> {
        self.inner.checkpoint(input)
    }
    fn switch_account(&self, input: &ContinuationSwitchInput) -> Result<(), DesktopHostError> {
        self.inner.switch_account(input)
    }
    fn local_session_id(
        &self,
        checkpoint: &ContinuationCheckpoint,
    ) -> Result<String, DesktopHostError> {
        self.inner.local_session_id(checkpoint)
    }
    fn lookup_delivery(&self, request_id: &str) -> Result<ContinuationDelivery, DesktopHostError> {
        self.inner.lookup_delivery(request_id)
    }
}
