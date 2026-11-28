//! The short private logs main keeps for finding what broke, and the switches they follow
//! (port of electron/main/logs.ts).

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use relay_core::desktop_launch::{claude_log_here, page_booted};
use relay_core::draft_diagnostics::{append_draft_event, draft_event_filter};
use relay_core::draft_main::draft_retype_enabled;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::state::{STATE, lock};

/// `draftRetype`: whether rescued drafts are re-typed into Claude; elsewhere than macOS, never:
/// left for Copy.
pub fn draft_retype() -> bool {
    draft_retype_enabled(STATE.settings().draft_retype, None)
}

/// `accessibilityWanted`: a feature that needs Accessibility is on (re-typing drafts, or
/// continuing conversations at the limit). Only then does Relay ask for it.
pub fn accessibility_wanted() -> bool {
    draft_retype()
        || STATE.fleet.get().is_some_and(|fleet| fleet.enabled())
        || STATE
            .continuation
            .get()
            .is_some_and(|continuation| continuation.snapshot().enabled)
}

type EventFilter = Box<dyn FnMut(&str, Option<&Map<String, Value>>) -> bool + Send>;

/// Whether a draft event is worth logging: a run that does nothing says so once.
static DRAFT_EVENT_ALLOWED: LazyLock<Mutex<EventFilter>> =
    LazyLock::new(|| Mutex::new(Box::new(draft_event_filter())));

/// `{ ...fields, event }`.
fn entry(event: &str, fields: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut entry = fields.cloned().unwrap_or_default();
    entry.insert("event".into(), json!(event));
    entry
}

fn append(file: &str, event: &str, fields: Option<&Map<String, Value>>) {
    let Some(paths) = STATE.paths.get() else {
        return;
    };
    append_draft_event(
        &paths.data_dir().join(file),
        &entry(event, fields),
        relay_core::clock::now_ms() as f64,
    );
}

/// `logDraftEvent`: one line of the private draft diagnosis log (never a draft's text). Fields
/// are ids, states, reasons and counts. Never panics into a restore: a log must not disturb it.
pub fn log_draft_event(event: &str, fields: Option<&serde_json::Map<String, serde_json::Value>>) {
    let _ = std::panic::catch_unwind(|| {
        if !(lock(&DRAFT_EVENT_ALLOWED))(event, fields) {
            return;
        }
        append("draft-events.json", event, fields);
    });
}

/// `logFleetEvent`: one event of the fleet ("Kota dolunca devam") for `fleet-events.json`:
/// each change of its state with what it waited on, and how each conversation's continuation
/// ended. Never a conversation's text. Never panics.
pub fn log_fleet_event(event: &str, fields: Option<&Map<String, Value>>) {
    let _ = std::panic::catch_unwind(|| append("fleet-events.json", event, fields));
}

/// `claudePageBooted`: whether the running Claude's page has booted, from its own log; `None`
/// when it cannot tell.
pub fn claude_page_booted() -> Option<bool> {
    page_booted(&claude_log_here()?)
}

const OUTLINE_TIMEOUT: Duration = Duration::from_secs(60);
const OUTLINE_MAX_BUFFER: usize = 8 * 1024 * 1024;

/// `execFile(helper, [], { timeout: 60_000, maxBuffer: 8 MiB })` with `{ command }` on stdin:
/// the parsed reply, or `{ ok: false, error }`.
fn ask_helper(helper: &Path, command: &str) -> Value {
    let failed = |error: String| json!({ "ok": false, "error": error });
    let mut child = match Command::new(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return failed(error.to_string()),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let body = json!({ "command": command }).to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(body.as_bytes());
        });
    }
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe
                    .take(OUTLINE_MAX_BUFFER as u64 + 1)
                    .read_to_end(&mut out);
            }
            out
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + OUTLINE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return failed(error.to_string()),
        }
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    let command_failed = || {
        format!(
            "Command failed: {}\n{}",
            helper.display(),
            String::from_utf8_lossy(&err)
        )
    };
    match status {
        Some(status) if status.success() && out.len() <= OUTLINE_MAX_BUFFER => {
            serde_json::from_slice(&out).unwrap_or_else(|_| failed("unreadable".into()))
        }
        Some(_) if out.len() > OUTLINE_MAX_BUFFER => {
            failed("stdout maxBuffer length exceeded".into())
        }
        _ => failed(command_failed()),
    }
}

/// `writeUiOutline`: Claude's controls, as roles and labels, written once to `file` for a
/// developer whose Claude no longer matches what the helper looks for (Relay started with
/// RELAY_UI_OUTLINE=1). It waits up to two minutes for Claude to run; the helper's issue, if
/// any, is written instead.
pub fn write_ui_outline(
    helper: &Path,
    file: &Path,
    running: impl Fn() -> bool,
) -> std::io::Result<()> {
    let mut tries = 0;
    while tries < 24 && !running() {
        std::thread::sleep(Duration::from_secs(5));
        tries += 1;
    }
    let at = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let inspect = ask_helper(helper, "inspect");
    let outline = ask_helper(helper, "outline");
    let result = json!({ "at": at, "inspect": inspect, "outline": outline });
    // JSON.stringify(result, null, 1).
    let mut text = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut text, formatter);
    result
        .serialize(&mut serializer)
        .map_err(std::io::Error::other)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(file)?.write_all(&text)
}
