//! Port of `electron/core/relay-cli-path.ts`: where the relay CLI is installed, for the command
//! Relay writes into Claude Code's status line. A Mac app started from the Dock gets a bare
//! PATH, so the usual install folders are searched too: npm's global folder, Homebrew, Volta,
//! pnpm and every nvm version. Only then is the user's login shell asked, with a deadline. The
//! CLI the app bundles next to its executable is `bundled_relay_cli`.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::host::AppPaths;
use crate::relay_paths::Platform;
use crate::shared::cli_package::RELAY_CLI_PACKAGE;

/// The longest the login shell may take to answer; the Settings row waits for it.
pub const LOGIN_SHELL_LOOKUP_MS: u64 = 2_000;

/// Homebrew's and the system's bin folders, where a Homebrew Node puts npm's global commands.
pub const SYSTEM_BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// The process environment, as Node's `process.env`.
pub fn process_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// Whether `file` may be executed by this user (`fs.accessSync(file, X_OK)`).
#[cfg(unix)]
fn executable(file: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(file.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a NUL-terminated path.
    unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
}

/// The package's launcher, relative to its folder: `launcher.js` (0.2.0 on), `dist/relay.js`
/// before.
const LAUNCHERS: [&str; 2] = ["launcher.js", "dist/relay.js"];

fn launcher(file: &str) -> String {
    format!("{RELAY_CLI_PACKAGE}/{file}")
}

/// Whether `file` is this package's relay: its launcher, or npm's shim pointing at it.
pub fn is_relay_cli(file: &Path) -> bool {
    let check = || -> std::io::Result<bool> {
        if !file.is_absolute() || !fs::metadata(file)?.is_file() {
            return Ok(false);
        }
        #[cfg(unix)]
        if !executable(file) {
            return Ok(false);
        }
        let real = fs::canonicalize(file)?;
        let real = real
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if LAUNCHERS
            .iter()
            .any(|l| real.ends_with(&format!("/{}", launcher(l))))
        {
            return Ok(true);
        }
        // npm's Windows shims are scripts that name the package's launcher.
        let mut head = Vec::with_capacity(4096);
        fs::File::open(file)?.take(4096).read_to_end(&mut head)?;
        let text = String::from_utf8_lossy(&head).replace('\\', "/");
        Ok(LAUNCHERS.iter().any(|l| text.contains(&launcher(l))))
    };
    check().unwrap_or(false)
}

/// Node's name of a platform (`process.platform`).
fn node_platform(platform: Platform) -> &'static str {
    match platform {
        Platform::MacOs => "darwin",
        Platform::Windows => "win32",
        Platform::Linux => "linux",
    }
}

/// The prebuilt binary npm installed for the 0.2.0 launcher (`launcher.js` runs it), when it is
/// found beside the package: nested in its node_modules or hoisted next to it. Claude Code runs
/// the status line command often, so it gets the binary and no Node start. Otherwise `file`.
/// Never on Windows, where `file` is npm's shim, the command Git Bash (Claude Code's shell)
/// runs. `arch` is Node's name (`arm64`, `x64`).
pub fn relay_cli_binary(file: &Path, platform: Platform, arch: &str) -> PathBuf {
    if platform == Platform::Windows {
        return file.to_path_buf();
    }
    let Ok(real) = fs::canonicalize(file) else {
        return file.to_path_buf();
    };
    let text = real
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let Some(pkg) = real
        .parent()
        .filter(|_| text.ends_with(&format!("/{}", launcher(LAUNCHERS[0]))))
    else {
        return file.to_path_buf();
    };
    let scoped = format!("{RELAY_CLI_PACKAGE}-{}-{arch}", node_platform(platform));
    let nested = pkg.join("node_modules").join(&scoped);
    let hoisted = pkg.parent().and_then(Path::parent).map(|m| m.join(&scoped));
    for dir in [Some(nested), hoisted].into_iter().flatten() {
        let binary = dir.join("bin").join("relay");
        if fs::metadata(&binary).is_ok_and(|m| m.is_file()) {
            #[cfg(unix)]
            if !executable(&binary) {
                continue;
            }
            return binary;
        }
    }
    file.to_path_buf()
}

/// `path.win32.join` / `path.posix.join`: the parts joined, `.` and `..` folded, separators
/// made the platform's.
pub(crate) fn js_join(win: bool, parts: &[&str]) -> String {
    let sep = if win { '\\' } else { '/' };
    let is_sep = |c: char| c == '/' || (win && c == '\\');
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(&sep.to_string());
    if joined.is_empty() {
        return ".".into();
    }
    let bytes = joined.as_bytes();
    let (mut root, rest) =
        if win && bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let rooted = joined[2..].starts_with(is_sep);
            (
                format!("{}{}", &joined[..2], if rooted { "\\" } else { "" }),
                &joined[2..],
            )
        } else if joined.starts_with(is_sep) {
            (sep.to_string(), &joined[..])
        } else {
            (String::new(), &joined[..])
        };
    let absolute = root.ends_with(sep);
    let mut out: Vec<&str> = Vec::new();
    for part in rest.split(is_sep) {
        match part {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|p| *p != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            _ => out.push(part),
        }
    }
    root.push_str(&out.join(&sep.to_string()));
    if root.is_empty() { ".".into() } else { root }
}

/// `a.localeCompare(b, "en", { numeric: true })`, near enough for version folders: digit runs
/// by value, the rest case-insensitively.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    fn chunks(s: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((d, text)) if *d == digit => text.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (x, y) = (chunks(a), chunks(b));
    for ((xd, xs), (yd, ys)) in x.iter().zip(&y) {
        let order = if *xd && *yd {
            let (xs, ys) = (xs.trim_start_matches('0'), ys.trim_start_matches('0'));
            xs.len().cmp(&ys.len()).then_with(|| xs.cmp(ys))
        } else {
            xs.to_lowercase().cmp(&ys.to_lowercase())
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    x.len().cmp(&y.len())
}

/// Every nvm-installed Node's bin folder, newest version first.
fn nvm_bins(home: &str) -> Vec<String> {
    let root = js_join(false, &[home, ".nvm", "versions", "node"]);
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort_by(|a, b| natural_cmp(b, a));
    names
        .iter()
        .map(|version| js_join(false, &[&root, version, "bin"]))
        .collect()
}

/// The files `relay` may be, in order: PATH first, then the usual install folders.
pub fn relay_cli_candidates(
    env: &BTreeMap<String, String>,
    home: &str,
    platform: Platform,
    system_dirs: &[&str],
) -> Vec<String> {
    let win = platform == Platform::Windows;
    let delimiter = if win { ';' } else { ':' };
    let path = env.get("PATH").or_else(|| env.get("Path"));
    let mut dirs: Vec<String> = path
        .map(|p| {
            p.split(delimiter)
                .filter(|d| !d.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if win {
        let appdata = env
            .get("APPDATA")
            .cloned()
            .unwrap_or_else(|| js_join(true, &[home, "AppData", "Roaming"]));
        dirs.push(js_join(true, &[&appdata, "npm"]));
    } else {
        dirs.push(js_join(false, &[home, ".local", "bin"]));
        dirs.push(js_join(false, &[home, ".npm-global", "bin"]));
        dirs.push(js_join(false, &[home, ".volta", "bin"]));
        dirs.push(if platform == Platform::MacOs {
            js_join(false, &[home, "Library", "pnpm"])
        } else {
            js_join(false, &[home, ".local", "share", "pnpm"])
        });
        dirs.extend(system_dirs.iter().map(|d| (*d).to_owned()));
        dirs.extend(nvm_bins(home));
    }
    // npm's Windows folder has an extensionless sh shim too: the one Git Bash, Claude Code's
    // shell, runs.
    let mut seen = std::collections::HashSet::new();
    dirs.iter()
        .map(|dir| js_join(win, &[dir, "relay"]))
        .filter(|file| seen.insert(file.clone()))
        .collect()
}

/// `relay` as the user's login shell finds it, or None after `timeout_ms`; never on Windows.
pub fn login_shell_relay(env: &BTreeMap<String, String>, timeout_ms: u64) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let shell = env.get("SHELL").filter(|s| Path::new(s).is_absolute())?;
    // The interactive login shell reads the same files a terminal does (nvm lives in .zshrc); a
    // marker keeps whatever those files print apart from the answer.
    let mut child = Command::new(shell)
        .args(["-ilc", "printf '\\n__RELAY__%s\\n' \"$(command -v relay)\""])
        .env_clear()
        .envs(env)
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = (&mut stdout).take(256 * 1024).read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    // A grandchild the shell left may hold the pipe open: the answer is not waited for then.
    let out = wait_join(reader, Duration::from_millis(200))?;
    let text = String::from_utf8_lossy(&out);
    let start = text.find("__RELAY__")? + "__RELAY__".len();
    let file = text[start..].split('\n').next()?.trim();
    (!file.is_empty() && Path::new(file).is_absolute()).then(|| PathBuf::from(file))
}

fn wait_join<T>(handle: std::thread::JoinHandle<T>, limit: Duration) -> Option<T> {
    let until = Instant::now() + limit;
    while !handle.is_finished() {
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    handle.join().ok()
}

/// What `find_relay_cli` looks with; every field defaults to this computer's.
#[derive(Default)]
pub struct FindRelayCliOptions<'a> {
    pub env: Option<BTreeMap<String, String>>,
    pub home: Option<String>,
    pub platform: Option<Platform>,
    /// SYSTEM_BIN_DIRS unless given (tests give none).
    pub system_dirs: Option<Vec<String>>,
    pub login_shell: Option<&'a dyn Fn() -> Option<PathBuf>>,
}

/// The installed relay CLI, or None when it is not installed (or another program is called
/// `relay`). The login shell is asked only when no usual folder has it.
pub fn find_relay_cli(options: FindRelayCliOptions) -> Option<PathBuf> {
    let env = options.env.unwrap_or_else(process_env);
    let home = options.home.unwrap_or_else(|| {
        std::env::home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let system: Vec<&str> = match &options.system_dirs {
        Some(dirs) => dirs.iter().map(String::as_str).collect(),
        None => SYSTEM_BIN_DIRS.to_vec(),
    };
    let platform = options.platform.unwrap_or_else(Platform::current);
    let candidates = relay_cli_candidates(&env, &home, platform, &system);
    let arch = crate::mac_update::node_arch();
    if let Some(found) = candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|f| is_relay_cli(f))
    {
        return Some(relay_cli_binary(&found, platform, arch));
    }
    let shell = match options.login_shell {
        Some(ask) => ask(),
        None => login_shell_relay(&env, LOGIN_SHELL_LOOKUP_MS),
    };
    shell
        .filter(|s| is_relay_cli(s))
        .map(|s| relay_cli_binary(&s, platform, arch))
}

/// The relay CLI the app ships beside its own executable (`Relay.app/Contents/MacOS/relay`,
/// `relay.exe` next to `Relay.exe`); None in a development run or when it is missing.
pub fn bundled_relay_cli(paths: &dyn AppPaths) -> Option<PathBuf> {
    if !paths.is_packaged() {
        return None;
    }
    let name = if cfg!(windows) { "relay.exe" } else { "relay" };
    let file = paths.exe_path().parent()?.join(name);
    file.is_file().then_some(file)
}
