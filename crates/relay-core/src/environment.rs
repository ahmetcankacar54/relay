//! Port of `electron/core/environment.ts`: finding the official Claude Code CLI and the
//! environment it runs in. The real CLI is launched directly: never a login shell, never an
//! interpolated shell command.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::desktop_host_node::claude_candidates;
use crate::relay_paths::{Platform, app_data_root, home_dir};
use crate::shared::cli_version::meets_cli_minimum;

/// An environment as `process.env`: name to value.
pub type Env = HashMap<String, String>;

/// The environment a CLI runs in for `profile`: this one without inherited credentials,
/// routing or nested-session state that could select a different account.
pub fn profile_environment(profile: &str, source: &Env) -> Env {
    const PREFIXES: [&str; 4] = ["ANTHROPIC_", "CLAUDE_", "ELECTRON_", "RELAY_"];
    const NAMES: [&str; 3] = ["CLAUDECODE", "NODE_OPTIONS", "NODE_PATH"];
    let mut env: Env = source
        .iter()
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            let blocked =
                PREFIXES.iter().any(|p| upper.starts_with(p)) || NAMES.iter().any(|n| upper == *n);
            !blocked || key.as_str() == "CLAUDE_CODE_GIT_BASH_PATH"
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    env.insert("CLAUDE_CONFIG_DIR".into(), profile.into());
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env
}

/// This process's environment.
pub fn process_env() -> Env {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// Whether `p` can be run as the CLI: absolute, not a script wrapper, executable, a file.
pub fn usable_file(p: &str) -> bool {
    let lower = p.to_lowercase();
    if !Path::new(p).is_absolute() || [".cmd", ".bat", ".ps1"].iter().any(|s| lower.ends_with(s)) {
        return false;
    }
    if !crate::linux_safe_storage::executable(p) {
        return false;
    }
    fs::metadata(p).is_ok_and(|m| m.is_file())
}

/// "2.1.309" before "2.1.30" and "2.1.4"; names that are not versions sort last.
fn newest_version_first(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let parse = |v: &str| -> Option<Vec<f64>> {
        let ok = !v.is_empty()
            && v.split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()));
        ok.then(|| {
            v.split('.')
                .map(|p| p.parse().unwrap_or(f64::INFINITY))
                .collect()
        })
    };
    match (parse(a), parse(b)) {
        (Some(x), Some(y)) => {
            for i in 0..x.len().max(y.len()) {
                let (xi, yi) = (
                    x.get(i).copied().unwrap_or(0.0),
                    y.get(i).copied().unwrap_or(0.0),
                );
                if xi != yi {
                    return yi.partial_cmp(&xi).unwrap_or(Ordering::Equal);
                }
            }
            Ordering::Equal
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// The names in `dir`, sorted as libuv's scandir gives them; none when it cannot be read.
fn list(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// The Claude Code that Claude Desktop downloads for its Code tab:
/// `Claude/claude-code/<version>/<hash>/` in the app's data folder, holding
/// `claude.app/Contents/MacOS/claude` on macOS and `claude` on Linux, newest version first,
/// only where Desktop wrote `.verified` beside it.
pub fn desktop_bundled_claude(
    home: &Path,
    platform: Platform,
    usable: &dyn Fn(&str) -> bool,
    env: &dyn Fn(&str) -> Option<OsString>,
) -> Option<String> {
    if platform == Platform::Windows {
        return None;
    }
    let root = app_data_root(platform, home, env)
        .join("Claude")
        .join("claude-code");
    let mut versions = list(&root);
    versions.sort_by(|a, b| newest_version_first(a, b));
    for version in versions {
        for hash in list(&root.join(&version)) {
            let dir = root.join(&version).join(&hash);
            let executable = if platform == Platform::MacOs {
                dir.join("claude.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("claude")
            } else {
                dir.join("claude")
            };
            let executable = executable.to_string_lossy().into_owned();
            if dir.join(".verified").exists() && usable(&executable) {
                return Some(executable);
            }
        }
    }
    None
}

/// `desktop_bundled_claude` for this user and machine.
pub fn default_desktop_bundled_claude() -> Option<String> {
    desktop_bundled_claude(&home_dir(), Platform::current(), &usable_file, &|k| {
        std::env::var_os(k)
    })
}

/// The file a path leads to, or the path itself when it cannot be resolved.
fn real_file(p: &str) -> String {
    crate::fs_util::real_path(Path::new(p))
        .map_or_else(|_| p.to_owned(), |r| r.to_string_lossy().into_owned())
}

fn basename(platform: Platform, p: &str) -> String {
    let separators: &[char] = if platform == Platform::Windows {
        &['/', '\\']
    } else {
        &['/']
    };
    let trimmed = p.trim_end_matches(separators);
    let mut base = trimmed.rsplit(separators).next().unwrap_or("");
    if platform == Platform::Windows
        && base.len() >= 2
        && base.as_bytes()[1] == b':'
        && !trimmed.contains(separators)
    {
        base = &base[2..];
    }
    base.to_owned()
}

fn is_absolute(platform: Platform, p: &str) -> bool {
    if platform != Platform::Windows {
        return p.starts_with('/');
    }
    let b = p.as_bytes();
    matches!(b.first(), Some(b'/' | b'\\'))
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'/' | b'\\'))
}

/// Options of `is_claude_desktop_executable`.
#[derive(Default)]
pub struct DesktopExecutableOptions<'a> {
    pub platform: Option<Platform>,
    pub desktop: Option<Vec<String>>,
    pub realpath: Option<&'a dyn Fn(&str) -> String>,
}

/// Whether `file` is Claude Desktop rather than the Claude Code CLI: named as Desktop's
/// executable, inside a Claude.app or a claude-desktop install, or the same file as one of
/// Desktop's usual locations. Running Desktop for `auth status` would only open the app.
pub fn is_claude_desktop_executable(file: &str, options: &DesktopExecutableOptions) -> bool {
    let platform = options.platform.unwrap_or(Platform::current());
    let real = |p: &str| match options.realpath {
        Some(f) => f(p),
        None => real_file(p),
    };
    let resolved = real(file);
    let named = [file, resolved.as_str()].iter().any(|candidate| {
        ["claude-desktop", "Claude", "Claude.exe"].contains(&basename(platform, candidate).as_str())
            || candidate.ends_with(".app/Contents/MacOS/Claude")
                && candidate.len() > ".app/Contents/MacOS/Claude".len()
            || candidate.contains("/claude-desktop/")
    });
    if named {
        return true;
    }
    let desktop = options
        .desktop
        .clone()
        .unwrap_or_else(|| claude_candidates(platform, None, None, &|k| std::env::var(k).ok()));
    desktop
        .iter()
        .any(|d| is_absolute(platform, d) && real(d) == resolved)
}

/// Where a resolved CLI came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutableSource {
    Chosen,
    Path,
    ClaudeApp,
}

/// Where a resolved CLI came from: the user's choice, the usual places, or the Claude app's own.
pub fn executable_source(executable: &str, explicit: Option<&str>) -> ExecutableSource {
    // A choice that was set aside (Claude Desktop picked as the CLI) is not where it came from.
    if explicit.is_some_and(|e| !e.is_empty() && e == executable) {
        return ExecutableSource::Chosen;
    }
    let sep = std::path::MAIN_SEPARATOR;
    if executable.contains(&format!("{sep}Claude{sep}claude-code{sep}")) {
        ExecutableSource::ClaudeApp
    } else {
        ExecutableSource::Path
    }
}

/// The CLI to run: the user's choice, else the usual places, else the Claude app's own.
pub fn resolve_executable(chosen: Option<&str>) -> Option<String> {
    // Claude Desktop chosen as the CLI (an earlier Relay accepted it) is ignored.
    let explicit = chosen.filter(|c| {
        !c.is_empty() && !is_claude_desktop_executable(c, &DesktopExecutableOptions::default())
    });
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let home = home_dir();
    let candidates: Vec<String> = match explicit {
        Some(explicit) => vec![explicit.to_owned()],
        None => {
            let mut out = vec![home.join(".local").join("bin").join(name)];
            let path = std::env::var("PATH").unwrap_or_default();
            let delimiter = if cfg!(windows) { ';' } else { ':' };
            out.extend(
                path.split(delimiter)
                    .filter(|p| !p.is_empty())
                    .map(|p| crate::fs_util::resolve(&Path::new(p).join(name))),
            );
            if cfg!(windows) {
                out.push(home.join(".claude").join("local").join(name));
            } else {
                out.push(PathBuf::from("/opt/homebrew/bin/claude"));
                out.push(PathBuf::from("/usr/local/bin/claude"));
            }
            out.into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        }
    };
    candidates.into_iter().find(|c| usable_file(c)).or_else(|| {
        if explicit.is_some() {
            None
        } else {
            default_desktop_bundled_claude()
        }
    })
}

/// What a bounded run printed, and how it ended.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
}

/// A run that failed: not started, exited non-zero, killed, or more output than allowed. Its
/// output so far is kept, as Node's `execFile` error carries it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Command failed: {program}")]
pub struct CommandError {
    pub program: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Node's `execFile(executable, args, {env, cwd, timeout, maxBuffer})`, SIGTERM on timeout.
pub fn exec_file(
    executable: &str,
    args: &[&str],
    env: Option<&Env>,
    cwd: Option<&Path>,
    timeout: Duration,
    max_buffer: usize,
) -> Result<CommandOutput, CommandError> {
    let fail = |code, stdout: Vec<u8>, stderr: Vec<u8>| CommandError {
        program: executable.to_owned(),
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    };
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = env {
        command.env_clear().envs(env);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| fail(None, Vec::new(), Vec::new()))?;
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe
                    .by_ref()
                    .take(max_buffer as u64 + 1)
                    .read_to_end(&mut kept);
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            }
            kept
        })
    };
    let out = reader(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = reader(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    match status {
        Some(status)
            if status.success() && stdout.len() <= max_buffer && stderr.len() <= max_buffer =>
        {
            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            })
        }
        Some(status) => Err(fail(status.code(), stdout, stderr)),
        None => Err(fail(None, stdout, stderr)),
    }
}

/// Runs the CLI with a 15 s timeout and 1 MiB of output.
pub fn command(
    executable: &str,
    args: &[&str],
    env: &Env,
    cwd: &Path,
) -> Result<CommandOutput, CommandError> {
    exec_file(
        executable,
        args,
        Some(env),
        Some(cwd),
        Duration::from_secs(15),
        1024 * 1024,
    )
}

/// Node's `process.arch` for this build.
pub fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// Whether the CLI version can switch Claude Desktop here: macOS, or Windows on x64.
pub fn supports_desktop(version: &str, platform: Platform, arch: &str) -> bool {
    if platform != Platform::MacOs && !(platform == Platform::Windows && arch == "x64") {
        return false;
    }
    meets_cli_minimum(version)
}
