//! Port of `cli/src/inside-desktop.ts`: a Claude-quitting command run from inside Claude
//! Desktop is handed to a detached worker, since Claude's quit would end this process.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::continuation_journal::{MAX_BYTES, read_private_json, write_private_json};
use relay_core::desktop_host_node::claude_executable;
use relay_core::fs_util::{create_private_dir_all, iso_timestamp, parse_iso_ms};
use relay_core::redact::{MAX, redact};
use serde::{Deserialize, Serialize};

use crate::context::CliContext;
use crate::deps::CliDeps;
use crate::errors::CliResult;
use crate::guards::probe_writable;
use crate::io::{CliError, CliIo, exit};
use crate::util::js_number;

/// A Claude-quitting command handed to a detached worker, and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRecord {
    pub id: String,
    /// The command's arguments, without --yes and --lang.
    pub argv: Vec<String>,
    pub lang: String,
    pub created_at: String,
    /// `pending`, `running`, `done` or `failed`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown: Option<bool>,
}

/// Whether `pid` runs inside Claude Desktop: one of its ancestors in a `ps -axo pid=,ppid=,comm=`
/// listing is a process of the Claude.app bundle `executable` belongs to.
pub fn inside_claude_desktop(listing: &str, pid: i64, executable: &str) -> bool {
    let Some(at) = executable.find(".app/") else {
        return false;
    };
    let bundle = &executable[..at + 5];
    let mut processes: HashMap<i64, (i64, &str)> = HashMap::new();
    for line in listing.split('\n') {
        let fields = line.trim_start();
        let Some((pid_text, rest)) = fields.split_once(char::is_whitespace) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some((ppid_text, comm)) = rest.split_once(char::is_whitespace) else {
            continue;
        };
        let comm = comm.trim();
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if !digits(pid_text) || !digits(ppid_text) || comm.is_empty() {
            continue;
        }
        if let (Ok(p), Ok(pp)) = (pid_text.parse(), ppid_text.parse()) {
            processes.insert(p, (pp, comm));
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut current = processes.get(&pid).map(|p| p.0);
    while let Some(id) = current.filter(|id| *id != 0 && !seen.contains(id)) {
        seen.insert(id);
        let Some((ppid, comm)) = processes.get(&id) else {
            return false;
        };
        if comm.starts_with(bundle) {
            return true;
        }
        current = Some(*ppid);
    }
    false
}

/// `/^[0-9a-f-]{36}$/`.
fn record_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

const KEEP: usize = 20;

pub fn write_worker_record(dir: &Path, record: &WorkerRecord) -> CliResult<()> {
    create_private_dir_all(dir)?;
    write_private_json(&dir.join(format!("{}.json", record.id)), record, MAX_BYTES)?;
    let mut names: Vec<(String, f64)> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") && record_id(&name[..name.len() - 5]) {
            let meta = std::fs::metadata(dir.join(&name))?;
            names.push((name, relay_core::fs_util::mtime_ms(&meta)?));
        }
    }
    names.sort_by(|a, b| b.1.total_cmp(&a.1));
    for (name, _) in names.into_iter().skip(KEEP) {
        let _ = std::fs::remove_file(dir.join(name));
    }
    Ok(())
}

pub fn read_worker_record(dir: &Path, id: &str) -> Option<WorkerRecord> {
    if !record_id(id) {
        return None;
    }
    let value = read_private_json(&dir.join(format!("{id}.json")), MAX_BYTES).ok()?;
    serde_json::from_value(value).ok()
}

/// The newest record, or `None`.
pub fn last_worker_record(dir: &Path) -> Option<WorkerRecord> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut records: Vec<WorkerRecord> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json") && record_id(&name[..name.len() - 5]))
        .filter_map(|name| read_worker_record(dir, &name[..name.len() - 5]))
        .collect();
    let at = |r: &WorkerRecord| parse_iso_ms(&r.created_at).map_or(f64::NAN, |ms| ms as f64);
    records.sort_by(|a, b| {
        at(b)
            .partial_cmp(&at(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    records.into_iter().next()
}

/// Whether this CLI runs inside a Claude Desktop Code session (never true in the worker).
pub fn inside_desktop(ctx: &CliContext) -> bool {
    if ctx.io.var("RELAY_WORKER") == Some("1") {
        return false;
    }
    let Some(executable) = claude_executable(&ctx.paths.claude_apps) else {
        return false;
    };
    match (ctx.deps.process_list)() {
        Ok(listing) => inside_claude_desktop(
            &listing,
            i64::from(ctx.io.pid),
            &executable.to_string_lossy(),
        ),
        Err(_) => false,
    }
}

/// The line the prompt adds when this terminal lives inside Claude Desktop.
pub fn session_ends_line(ctx: &CliContext) -> String {
    ctx.t.t("insideDesktop.thisSessionWillEndToo")
}

/// The arguments a worker re-runs: the user's, without --yes and --lang.
fn worker_argv(argv: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        if arg == "--yes" || arg == "-y" {
            i += 1;
            continue;
        }
        if arg == "--lang" {
            i += 2;
            continue;
        }
        if !arg.starts_with("--lang=") {
            out.push(arg.clone());
        }
        i += 1;
    }
    out
}

/// Hands a confirmed Claude-quitting command to a detached worker, since Claude's quit would
/// kill this process: the worker is started in its own session and outlives this one, which
/// returns at once. A sandbox that forbids writing Relay's folder refuses it first.
pub fn detach(ctx: &CliContext, argv: &[String]) -> CliResult<i32> {
    let t = ctx.t;
    if !probe_writable(&ctx.paths.cli_operations) {
        return Err(CliError::new(
            t.t("insideDesktop.thisSessionRunsInASandbox"),
            exit::ENVIRONMENT,
        )
        .into());
    }
    let record = WorkerRecord {
        id: uuid::Uuid::new_v4().to_string(),
        argv: worker_argv(argv),
        lang: ctx.lang.as_str().to_owned(),
        created_at: iso_timestamp(ctx.io.now()),
        status: "pending".into(),
        error: None,
        finished_at: None,
        shown: None,
    };
    write_worker_record(&ctx.paths.cli_operations, &record)?;
    start_worker(&ctx.deps, &ctx.io, &record.id)?;
    ctx.io
        .out(&t.t("insideDesktop.theOperationContinuesInASeparate"));
    Ok(exit::OK)
}

pub fn start_worker(deps: &CliDeps, io: &CliIo, id: &str) -> CliResult<()> {
    let mut env = io.env.clone();
    env.insert("RELAY_WORKER".into(), "1".into());
    (deps.spawn_detached)(
        &deps.self_exe,
        &["__worker".to_owned(), id.to_owned()],
        &env,
    )?;
    Ok(())
}

/// Runs a worker's command with no terminal and records how it ended; the error is redacted.
pub fn run_worker(
    dir: &Path,
    id: &str,
    io: &CliIo,
    run: &dyn Fn(&[String], &CliIo) -> i32,
) -> CliResult<i32> {
    let Some(record) = read_worker_record(dir, id).filter(|r| r.status == "pending") else {
        return Ok(exit::USAGE);
    };
    write_worker_record(
        dir,
        &WorkerRecord {
            status: "running".into(),
            ..record.clone()
        },
    )?;
    let delay = js_number(io.var("RELAY_WORKER_DELAY_MS").unwrap_or("1000"));
    // Let the process that started this one exit first, so Claude's quit cannot reach it.
    if delay > 0.0 {
        std::thread::sleep(Duration::from_millis(delay.min(u64::MAX as f64) as u64));
    }
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = errors.clone();
    let silent = CliIo {
        stdout: Arc::new(|_| {}),
        stderr: Arc::new(move |line| {
            sink.lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(line.to_owned())
        }),
        is_tty: false,
        prompt: Arc::new(|_| None),
        ..io.clone()
    };
    let mut argv = record.argv.clone();
    argv.extend(["--yes".to_owned(), "--lang".to_owned(), record.lang.clone()]);
    let code = run(&argv, &silent);
    let last = errors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last()
        .cloned();
    let ok = code == exit::OK;
    write_worker_record(
        dir,
        &WorkerRecord {
            status: if ok { "done" } else { "failed" }.into(),
            error: (!ok).then(|| {
                redact(
                    &last
                        .map(|l| l.strip_prefix("relay: ").map(str::to_owned).unwrap_or(l))
                        .unwrap_or_else(|| format!("exit {code}")),
                    MAX,
                )
            }),
            finished_at: Some(iso_timestamp(io.now())),
            ..record
        },
    )?;
    Ok(code)
}
