//! Port of `electron/core/claude-statusline.ts`.
//!
//! Relay in Claude Code's status line: `statusLine` in `~/.claude/settings.json` runs
//! `relay statusline`. Every other key stays as it was. A status line another tool put there is
//! kept in Relay's data folder and comes back when Relay's is taken out. The CLI's
//! `relay statusline install|uninstall` and Relay.app's Settings switch share this code.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::continuation_journal::{
    MAX_BYTES, PrivateJsonError, read_private_json, write_private_json,
};
use crate::fs_util::{create_private_dir_all, dirname};
use crate::relay_paths::Platform;
use crate::shared::types::literal_enum;

/// The status line Relay replaced, in Relay's data folder.
pub const STATUSLINE_PREVIOUS_FILE: &str = "claude-statusline-previous.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatuslineSetup {
    /// Claude Code runs `relay statusline`.
    pub installed: bool,
    /// Another status line is set: installing replaces it, and uninstalling brings it back.
    pub other: bool,
}

literal_enum!(InstallOutcome { Installed = "installed", Replaced = "replaced", Already = "already" });
literal_enum!(UninstallOutcome {
    Removed = "removed",
    Restored = "restored",
    NotInstalled = "not-installed",
});

/// settings.json is not a JSON object: nothing is changed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{} is not valid JSON.", .file.display())]
pub struct ClaudeSettingsUnreadable {
    pub file: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum ClaudeStatuslineError {
    #[error(transparent)]
    SettingsUnreadable(#[from] ClaudeSettingsUnreadable),
    #[error(transparent)]
    PrivateJson(#[from] PrivateJsonError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

type Json = Map<String, Value>;

fn settings_file(claude_dir: &Path) -> PathBuf {
    claude_dir.join("settings.json")
}

/// A parsed JSON value as `JSON.stringify` would write it back: whole floats without `.0` and
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
        Value::Object(map) => Value::Object(js_object(map)),
        _ => value.clone(),
    }
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

fn js_object(map: &Json) -> Json {
    let mut indexed: Vec<(u32, &String, &Value)> = map
        .iter()
        .filter_map(|(key, value)| array_index(key).map(|i| (i, key, value)))
        .collect();
    indexed.sort_by_key(|(i, _, _)| *i);
    let mut out = Map::new();
    for (_, key, value) in indexed {
        out.insert(key.clone(), js_json(value));
    }
    for (key, value) in map {
        if array_index(key).is_none() {
            out.insert(key.clone(), js_json(value));
        }
    }
    out
}

/// `String.prototype.trim`, which also drops a byte-order mark.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn read_settings(claude_dir: &Path) -> Result<Json, ClaudeStatuslineError> {
    let file = settings_file(claude_dir);
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error.into()),
    };
    // `readFileSync(file, "utf8")` replaces bad bytes and drops a byte-order mark.
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if js_trim(text).is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(ClaudeSettingsUnreadable { file }.into()),
    }
}

/// Writes through a temporary file, so Claude Code never reads half a settings file. Owner-only,
/// as the gateway's binding writes it: the file may hold tokens in `env`.
fn write_settings(claude_dir: &Path, settings: &Json) -> io::Result<()> {
    let file = settings_file(claude_dir);
    fs::create_dir_all(claude_dir)?;
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(
        ".relay-{}-{}.tmp",
        std::process::id(),
        crate::clock::now_ms()
    ));
    let temporary = PathBuf::from(temporary);
    let mut text = serde_json::to_string_pretty(&Value::Object(js_object(settings)))
        .expect("JSON values always serialize");
    text.push('\n');
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(&temporary)?;
    handle.write_all(text.as_bytes())?;
    drop(handle);
    fs::rename(&temporary, &file)?;
    #[cfg(unix)]
    crate::fs_util::set_mode(&file, 0o600)?;
    Ok(())
}

static PLAIN_PART: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_@%+=:,./-]+$").expect("valid pattern"));
static SHELL_SPECIAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(["\\$`])"#).expect("valid pattern"));
static RELAY_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(^|[\s/\\"])relay(\.js)?"?\s+statusline(\s+--color)?\s*$"#)
        .expect("valid pattern")
});

/// The shell command that runs `relay statusline` through `executable` (the relay command, or
/// node and the CLI's launcher), every part absolute: Claude Code runs it in a non-login shell,
/// whose PATH may lack an npm or nvm folder. A part with anything but plain path characters is
/// double-quoted. On Windows the separators become forward slashes, since Claude Code runs the
/// command in Git Bash, which would eat backslashes.
pub fn statusline_command<S: AsRef<str>>(executable: &[S], platform: Platform) -> String {
    let mut parts: Vec<String> = executable
        .iter()
        .map(|part| {
            let part = part.as_ref();
            let text = if platform == Platform::Windows {
                part.replace('\\', "/")
            } else {
                part.to_owned()
            };
            if PLAIN_PART.is_match(&text) {
                text
            } else {
                format!("\"{}\"", SHELL_SPECIAL.replace_all(&text, "\\$1"))
            }
        })
        .collect();
    parts.push("statusline".to_owned());
    parts.join(" ")
}

/// Whether a `statusLine` value runs Relay's (`relay statusline`, by any path, with or without
/// `--color`).
pub fn is_relay_statusline(value: Option<&Value>) -> bool {
    let Some(Value::Object(value)) = value else {
        return false;
    };
    value.get("type").and_then(Value::as_str) == Some("command")
        && value
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| RELAY_COMMAND.is_match(js_trim(command)))
}

/// Whether Claude Code shows Relay's status line, and whether another one is set.
pub fn statusline_setup(claude_dir: &Path) -> Result<StatuslineSetup, ClaudeStatuslineError> {
    let settings = read_settings(claude_dir)?;
    let current = settings.get("statusLine");
    let installed = is_relay_statusline(current);
    Ok(StatuslineSetup {
        installed,
        other: !installed && current.is_some(),
    })
}

/// `fs.rmSync(file, { force: true })`.
fn remove_forced(file: &Path) -> io::Result<()> {
    match fs::remove_file(file) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Points Claude Code's status line at `command` (see [`statusline_command`]). Another one is
/// saved in `previous_file` first; with none, an older saved one is dropped, so uninstalling
/// cannot bring back a status line the user removed since. Relay's own with another path is
/// replaced in place.
pub fn install_statusline(
    claude_dir: &Path,
    previous_file: &Path,
    command: &str,
) -> Result<InstallOutcome, ClaudeStatuslineError> {
    let mut settings = read_settings(claude_dir)?;
    let current = settings.get("statusLine").cloned();
    let relay = is_relay_statusline(current.as_ref());
    if relay {
        if current
            .as_ref()
            .and_then(|c| c.get("command"))
            .and_then(Value::as_str)
            == Some(command)
        {
            return Ok(InstallOutcome::Already);
        }
    } else if let Some(current) = &current {
        create_private_dir_all(dirname(previous_file))?;
        write_private_json(
            previous_file,
            &json!({ "statusLine": js_json(current) }),
            MAX_BYTES,
        )?;
    } else {
        remove_forced(previous_file)?;
    }
    // `{ ...settings, statusLine: next }`: an existing key keeps its place.
    settings.insert(
        "statusLine".into(),
        json!({ "type": "command", "command": command }),
    );
    write_settings(claude_dir, &settings)?;
    Ok(if current.is_none() || relay {
        InstallOutcome::Installed
    } else {
        InstallOutcome::Replaced
    })
}

/// The status line Relay replaced, or `None`.
fn saved_statusline(previous_file: &Path) -> Option<Value> {
    match read_private_json(previous_file, MAX_BYTES) {
        Ok(Value::Object(saved)) => saved.get("statusLine").cloned(),
        _ => None,
    }
}

/// Takes Relay out of Claude Code's status line, putting back the one it replaced.
pub fn uninstall_statusline(
    claude_dir: &Path,
    previous_file: &Path,
) -> Result<UninstallOutcome, ClaudeStatuslineError> {
    let mut settings = read_settings(claude_dir)?;
    if !is_relay_statusline(settings.get("statusLine")) {
        return Ok(UninstallOutcome::NotInstalled);
    }
    let previous = saved_statusline(previous_file);
    // `{ ...rest, statusLine: previous }`: the restored key goes last.
    settings.shift_remove("statusLine");
    if let Some(previous) = &previous {
        settings.insert("statusLine".into(), previous.clone());
    }
    write_settings(claude_dir, &settings)?;
    remove_forced(previous_file)?;
    Ok(if previous.is_none() {
        UninstallOutcome::Removed
    } else {
        UninstallOutcome::Restored
    })
}
