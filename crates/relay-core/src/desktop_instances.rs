//! Port of `electron/core/desktop-instances.ts`: Claude Desktop's processes split by app, the
//! main Claude apart from the separate windows started on a data folder of their own.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::desktop_processes::{mac_bundle, pid_line};
use crate::fs_util::resolve;

/// One process in a `ps` census: its executable (`comm`) and its whole command line (`args`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRow {
    pub pid: i64,
    pub ppid: i64,
    pub executable: String,
    pub args: String,
}

/// A Claude started with its own data folder (`--user-data-dir`), next to the main one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeWindowProcess {
    /// Its data folder, resolved.
    pub dir: String,
    /// Its main process.
    pub pid: i64,
    /// Its main process and every helper under it.
    pub pids: Vec<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeInstances {
    /// The main Claude's processes: those of the app started without `--user-data-dir`.
    pub main: Vec<i64>,
    /// The main Claude's own process; None when there is none, or more than one.
    pub main_pid: Option<i64>,
    /// Every app process started without `--user-data-dir`: normally one, the main Claude.
    pub main_apps: Vec<i64>,
    pub windows: Vec<ClaudeWindowProcess>,
}

const SWITCH: &str = " --user-data-dir=";

/// The data folder in a command line's `--user-data-dir=` switch, up to the next switch; None
/// without one. Chromium gives every helper the switch too, with the default folder for the main
/// Claude's helpers, so only an app's own main process tells main from window.
pub fn user_data_dir(args: &str) -> Option<String> {
    let at = args.find(SWITCH)?;
    let rest = &args[at + SWITCH.len()..];
    let dir = rest.find(" --").map_or(rest, |end| &rest[..end]).trim();
    if dir.is_empty() {
        return None;
    }
    Some(resolve(Path::new(dir)).to_string_lossy().into_owned())
}

static COMMAND_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(\d+)\s+(.+)$").unwrap());
static LINUX_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(\d+)\s+(\S.*)$").unwrap());
static TYPE_SWITCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\s)--type=").unwrap());

/// `ps -axo pid=,ppid=,comm=` and `ps -axo pid=,args=` as rows; lines that are neither are
/// skipped. A process missing from the second listing has empty args.
pub fn process_rows(commands: &str, arguments: &str) -> Vec<ProcessRow> {
    let args: HashMap<i64, &str> = arguments.split('\n').filter_map(pid_line).collect();
    commands
        .split('\n')
        .filter_map(|line| {
            let m = COMMAND_ROW.captures(line)?;
            let pid: i64 = m[1].parse().ok()?;
            Some(ProcessRow {
                pid,
                ppid: m[2].parse().ok()?,
                executable: m[3].to_string(),
                args: args.get(&pid).copied().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Claude Desktop's processes on macOS, split by app (see split_instances): every process inside
/// the bundle, the app's main process being the bundle's executable. Chrome's native messaging
/// host can outlive Claude and is never counted.
pub fn mac_instances(rows: &[ProcessRow], executable: &str) -> ClaudeInstances {
    let Some(bundle) = mac_bundle(executable) else {
        return ClaudeInstances::default();
    };
    let browser_host = format!("{bundle}Contents/Helpers/chrome-native-host");
    let ours: Vec<&ProcessRow> = rows
        .iter()
        .filter(|row| {
            row.executable != browser_host
                && (row.executable == executable || row.executable.starts_with(bundle))
        })
        .collect();
    split_instances(rows, &ours, |row| row.executable == executable)
}

/// `ps -eo pid=,ppid=,args=` (Linux) as rows, the command line's first word as the executable;
/// lines that are not a process are skipped.
pub fn linux_process_rows(stdout: &str) -> Vec<ProcessRow> {
    stdout
        .split('\n')
        .filter_map(|line| {
            let m = LINUX_ROW.captures(line)?;
            let args = m[3].trim_end().to_string();
            Some(ProcessRow {
                pid: m[1].parse().ok()?,
                ppid: m[2].parse().ok()?,
                executable: js_words(&args).first().copied().unwrap_or("").to_string(),
                args,
            })
        })
        .collect()
}

/// `text.split(/\s+/)` for the leading words: a leading empty word is kept, as JS keeps it.
fn js_words(text: &str) -> Vec<&str> {
    text.split(char::is_whitespace)
        .enumerate()
        .filter(|(i, word)| !word.is_empty() || *i == 0)
        .map(|(_, word)| word)
        .collect()
}

/// `path.posix.basename`.
fn posix_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("")
}

/// Helpers in a Linux install that are never part of a Claude: Chrome owns the native messaging
/// host, and Chromium's crash handler leaves its parent and ends by itself once Claude has.
const LINUX_OUTSIDERS: [&str; 2] = ["chrome-native-host", "chrome_crashpad_handler"];

/// A path inside a claude-desktop install or a mounted Claude AppImage.
fn in_linux_install(arg: &str) -> bool {
    arg.contains("/claude-desktop/") || arg.contains("/.mount_Claude")
}

/// The command and its first argument, as `args.split(/\s+/)` gives them.
fn command_and_first(args: &str) -> (&str, &str) {
    let words = js_words(args);
    (
        words.first().copied().unwrap_or(""),
        words.get(1).copied().unwrap_or(""),
    )
}

/// Whether a Linux command line is Claude Desktop's. Linux builds start through a launcher, a
/// script or an AppImage, so a process counts when its command is the chosen executable, lies
/// inside a claude-desktop install or a mounted Claude AppImage, or shares the executable's name;
/// or when it runs the launcher script or the install's `.asar` as its first argument. Only the
/// command and its first argument are looked at. The Claude Code CLI is also called "claude", so
/// that bare name never matches by itself.
pub fn linux_claude_command(args: &str, executable: &str) -> bool {
    let name = posix_basename(executable);
    let (command, first) = command_and_first(args);
    command == executable
        || in_linux_install(command)
        || (!name.is_empty() && name != "claude" && posix_basename(command) == name)
        || first == executable
        || (in_linux_install(first) && first.ends_with(".asar"))
}

/// Claude Desktop's processes on Linux, split by app (see split_instances). An app's main
/// process runs Claude's executable (by path or name), the launcher script or the `.asar`, with
/// no Chromium `--type=` switch, and does not run under another Claude process. `self_pid`
/// (Relay) is never Claude.
pub fn linux_instances(rows: &[ProcessRow], executable: &str, self_pid: i64) -> ClaudeInstances {
    let name = posix_basename(executable);
    let ours: Vec<&ProcessRow> = rows
        .iter()
        .filter(|row| {
            row.pid != self_pid
                && !LINUX_OUTSIDERS.contains(&posix_basename(&row.executable))
                && linux_claude_command(&row.args, executable)
        })
        .collect();
    let claude: HashSet<i64> = ours.iter().map(|row| row.pid).collect();
    split_instances(rows, &ours, |row| {
        if claude.contains(&row.ppid) || TYPE_SWITCH.is_match(&row.args) {
            return false;
        }
        let (_, first) = command_and_first(&row.args);
        row.executable == executable
            || (name != "claude" && posix_basename(&row.executable) == name)
            || first == executable
            || (in_linux_install(first) && first.ends_with(".asar"))
    })
}

/// This process's id, the `self` `linux_instances` leaves out.
pub fn own_pid() -> i64 {
    i64::from(std::process::id())
}

/// `ours` (a Claude's processes among `rows`) split by app. Every process belongs to the app whose
/// main process (`is_app`) it runs under. The app started without `--user-data-dir` is the main
/// Claude; each one started with it is a window. A process under no app goes to the window whose
/// folder its own switch names, else to the main Claude.
fn split_instances(
    rows: &[ProcessRow],
    ours: &[&ProcessRow],
    is_app: impl Fn(&ProcessRow) -> bool,
) -> ClaudeInstances {
    let parent: HashMap<i64, i64> = rows.iter().map(|row| (row.pid, row.ppid)).collect();
    // Each app's main process and its data folder (None for the main Claude), in insertion order.
    let mut apps: Vec<(i64, Option<String>)> = Vec::new();
    for row in ours {
        if is_app(row) {
            let dir = user_data_dir(&row.args);
            match apps.iter_mut().find(|(pid, _)| *pid == row.pid) {
                Some(entry) => entry.1 = dir,
                None => apps.push((row.pid, dir)),
            }
        }
    }
    let app_dir = |pid: i64| apps.iter().find(|(p, _)| *p == pid).map(|(_, dir)| dir);
    let app_of = |pid: i64| -> Option<i64> {
        let mut at = pid;
        let mut hops = 0;
        while at > 1 && hops < 64 {
            if app_dir(at).is_some() {
                return Some(at);
            }
            at = parent.get(&at).copied().unwrap_or(0);
            hops += 1;
        }
        None
    };
    let mut window_apps: HashMap<&str, i64> = HashMap::new();
    for (pid, dir) in &apps {
        if let Some(dir) = dir {
            window_apps.insert(dir.as_str(), *pid);
        }
    }
    let mut main = Vec::new();
    let mut windows: Vec<ClaudeWindowProcess> = Vec::new();
    for row in ours {
        let app = app_of(row.pid).or_else(|| {
            user_data_dir(&row.args).and_then(|dir| window_apps.get(dir.as_str()).copied())
        });
        let dir = app.and_then(|app| app_dir(app).cloned().flatten());
        let (Some(app), Some(dir)) = (app, dir) else {
            main.push(row.pid);
            continue;
        };
        match windows.iter_mut().find(|window| window.pid == app) {
            Some(window) => window.pids.push(row.pid),
            None => windows.push(ClaudeWindowProcess {
                dir,
                pid: app,
                pids: vec![row.pid],
            }),
        }
    }
    let main_apps: Vec<i64> = apps
        .iter()
        .filter(|(_, dir)| dir.is_none())
        .map(|(pid, _)| *pid)
        .collect();
    ClaudeInstances {
        main,
        main_pid: (main_apps.len() == 1).then(|| main_apps[0]),
        main_apps,
        windows,
    }
}

/// A window's data folder as a path.
pub fn window_dir(window: &ClaudeWindowProcess) -> PathBuf {
    PathBuf::from(&window.dir)
}
