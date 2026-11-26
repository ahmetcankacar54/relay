//! Port of `electron/core/desktop-host-node.ts`: Claude Desktop as a plain process sees it — its
//! processes, quitting and launching it, and the vault's seal.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::Regex;

use crate::desktop::{
    AnswerGuard, AutomationTarget, DesktopError, DesktopHost, DesktopResult, LaunchOptions,
    WINDOWS_UNSUPPORTED,
};
use crate::desktop_instances::{
    ClaudeInstances, ClaudeWindowProcess, linux_instances, linux_process_rows, mac_instances,
    own_pid, process_rows,
};
use crate::desktop_launch::{
    ClaudeSignOut, LaunchWatch, claude_log_here, claude_sign_outs, claude_signed_out,
    watch_claude_launch,
};
use crate::desktop_processes::{
    ClaudeListing, ClaudeLiveness, LivenessDeps, ProcessError, assert_process_listing, kill_term,
    parse_etime, pid_alive, retry_once, sleep_ms,
};
use crate::detached_exec::{
    DetachedExecError, ExecOptions, ExecOutput, run_attached, run_detached,
};
use crate::relay_paths::{Platform, home_dir};
use crate::vault_crypto::Sealer;

/// Runs a command to completion: on macOS and Linux out of the terminal's process group (see
/// `run_detached`), as `execFile` on Windows. Tests replace it.
pub trait CommandRunner: Send + Sync {
    fn exec(
        &self,
        file: &str,
        args: &[String],
        options: &ExecOptions,
    ) -> Result<ExecOutput, DetachedExecError>;
}

/// The real runner.
pub struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn exec(
        &self,
        file: &str,
        args: &[String],
        options: &ExecOptions,
    ) -> Result<ExecOutput, DetachedExecError> {
        if cfg!(windows) {
            run_attached(file, args, options)
        } else {
            run_detached(file, args, options)
        }
    }
}

/// The environment `open` gets when it starts Claude on macOS: none, so Launch Services gives
/// Claude the user's standard one and nothing of Relay's own.
pub fn clean_launch_env() -> BTreeMap<String, String> {
    BTreeMap::new()
}

static RELAY_ONLY_ENV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|ELECTRON_|RELAY_|NODE_OPTIONS$|NODE_PATH$|CHROME_DESKTOP$|ORIGINAL_XDG_CURRENT_DESKTOP$|APPIMAGE$|APPDIR$|ARGV0$|OWD$)").unwrap()
});

/// The environment Claude gets when Relay starts it on Linux: the session's own without what is
/// Relay's or a Claude Code session's that started Relay. Electron moves the desktop's name aside
/// (ORIGINAL_XDG_CURRENT_DESKTOP); Claude gets the real one back.
pub fn linux_launch_env(source: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = source
        .iter()
        .filter(|(key, _)| !RELAY_ONLY_ENV.is_match(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if let Some(original) = source
        .get("ORIGINAL_XDG_CURRENT_DESKTOP")
        .filter(|value| !value.is_empty())
    {
        env.insert("XDG_CURRENT_DESKTOP".into(), original.clone());
    }
    env
}

/// Claude's command-line switches for a launch, Chromium's own: no HTTP/3. Never a debugging or
/// network-override switch such as --log-net-log: Claude refuses to start with one.
pub fn launch_args(options: Option<LaunchOptions>) -> Vec<String> {
    if options.is_some_and(|o| o.quic_off) {
        vec!["--disable-quic".into()]
    } else {
        Vec::new()
    }
}

/// What `app_script` asks the app to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    Terminate,
    Activate,
}

/// Asks the macOS app with `pid` to quit as its Quit menu item would, or brings it forward.
/// Prints "gone" when no app has that pid.
pub fn app_script(action: AppAction, pid: i64) -> DesktopResult<String> {
    const MAX_SAFE: i64 = (1 << 53) - 1;
    if pid <= 1 || pid > MAX_SAFE {
        return Err("Invalid process id.".into());
    }
    let call = match action {
        AppAction::Terminate => "app.terminate",
        AppAction::Activate => "app.activateWithOptions($.NSApplicationActivateAllWindows)",
    };
    Ok(format!(
        "ObjC.import(\"AppKit\"); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier({pid}); app.isNil() ? \"gone\" : String({call})"
    ))
}

/// `open`'s arguments for a Claude: a new app when `fresh`, with `args` as its switches.
pub fn open_args(bundle: &str, args: &[String], fresh: bool) -> Vec<String> {
    let mut out = Vec::new();
    if fresh {
        out.push("-n".to_string());
    }
    out.push("-a".into());
    out.push(bundle.into());
    if !args.is_empty() {
        out.push("--args".into());
        out.extend(args.iter().cloned());
    }
    out
}

/// The default Claude.app bundles, first found wins.
pub fn claude_apps() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/Claude.app"),
        home_dir().join("Applications").join("Claude.app"),
    ]
}

/// The executable of the first of `apps` (Claude.app bundles) that has one.
pub fn claude_executable(apps: &[PathBuf]) -> Option<PathBuf> {
    apps.iter()
        .filter(|app| app.is_absolute())
        .map(|app| app.join("Contents").join("MacOS").join("Claude"))
        .find(|p| p.exists())
}

/// `path.posix.join` of absolute or relative parts, folded.
fn posix_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    let absolute = joined.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|last| *last != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    let body = out.join("/");
    match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".into(),
        (false, false) => body,
    }
}

/// `path.win32.join` for plain parts: backslashes, repeated separators folded.
fn win32_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\\")
        .replace('/', "\\");
    let mut out = String::with_capacity(joined.len());
    for c in joined.chars() {
        if c == '\\' && out.ends_with('\\') && out.len() > 1 {
            continue;
        }
        out.push(c);
    }
    out
}

/// Where Claude Desktop is usually installed, in the order tried. On Linux: the official
/// package's launcher, the community packages' places and a Claude AppImage in ~/Applications.
pub fn claude_candidates(
    platform: Platform,
    apps: Option<&[PathBuf]>,
    home: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    let home = home.map_or_else(home_dir, Path::to_path_buf);
    let home = home.to_string_lossy().into_owned();
    match platform {
        Platform::MacOs => {
            let defaults;
            let apps = match apps {
                Some(apps) => apps,
                None => {
                    defaults = claude_apps();
                    &defaults
                }
            };
            apps.iter()
                .map(|app| posix_join(&[&app.to_string_lossy(), "Contents", "MacOS", "Claude"]))
                .collect()
        }
        Platform::Windows => {
            let local = env("LOCALAPPDATA").unwrap_or_default();
            vec![
                win32_join(&[&local, "AnthropicClaude/claude.exe"]),
                win32_join(&[&local, "Programs/Claude/Claude.exe"]),
            ]
        }
        Platform::Linux => {
            static APPIMAGE: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"(?i)claude.*\.appimage$").unwrap());
            let folder = posix_join(&[&home, "Applications"]);
            let app_images: Vec<String> = std::fs::read_dir(&folder)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .filter(|name| APPIMAGE.is_match(name))
                        .map(|name| posix_join(&[&home, "Applications", &name]))
                        .collect()
                })
                .unwrap_or_default();
            let mut out = vec![
                "/usr/bin/claude-desktop".to_string(),
                "/usr/local/bin/claude-desktop".into(),
                posix_join(&[&home, ".local", "bin", "claude-desktop"]),
                "/opt/Claude/claude-desktop".into(),
                "/opt/Claude/claude".into(),
                "/usr/lib/claude-desktop/claude-desktop".into(),
            ];
            out.extend(app_images);
            out
        }
    }
}

/// Node's `path.isAbsolute` on this host.
fn host_absolute(path: &str) -> bool {
    Path::new(path).is_absolute() || (cfg!(windows) && path.starts_with(['/', '\\']))
}

/// The executable to run: the one the user chose (a Claude.app is opened to its executable),
/// else the first default that exists.
pub fn resolve_claude_executable(
    chosen: Option<&str>,
    candidates: &[String],
    exists: &dyn Fn(&str) -> bool,
) -> Option<String> {
    if let Some(chosen) = chosen.filter(|c| !c.is_empty() && host_absolute(c)) {
        // An .app bundle exists only on macOS, so its executable is joined the macOS way.
        let file = if chosen.ends_with(".app") {
            posix_join(&[chosen, "Contents", "MacOS", "Claude"])
        } else {
            chosen.to_string()
        };
        if exists(&file) {
            return Some(file);
        }
    }
    candidates
        .iter()
        .find(|p| host_absolute(p) && exists(p))
        .cloned()
}

/// How `linux_electron_version` reads files.
pub trait VersionFiles {
    fn realpath(&self, path: &str) -> std::io::Result<String>;
    fn read(&self, path: &str) -> std::io::Result<String>;
}

/// The real file system.
pub struct RealFiles;

impl VersionFiles for RealFiles {
    fn realpath(&self, path: &str) -> std::io::Result<String> {
        crate::fs_util::real_path(Path::new(path)).map(|p| p.to_string_lossy().into_owned())
    }
    fn read(&self, path: &str) -> std::io::Result<String> {
        std::fs::read_to_string(path)
    }
}

fn posix_dirname(path: &str) -> String {
    match path.trim_end_matches('/').rfind('/') {
        Some(0) => "/".into(),
        Some(at) => path[..at].to_string(),
        None => ".".into(),
    }
}

/// The Electron version of a Linux Claude: the `version` file Electron ships beside its
/// executable, found through the launcher's link, else in the official package's folder.
pub fn linux_electron_version(executable: &str, files: &dyn VersionFiles) -> Option<String> {
    static VERSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\d+\.\d+\.\d+(-[\w.]+)?$").unwrap());
    let mut dirs: Vec<String> = Vec::new();
    let mut add = |dir: String| {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };
    // A launcher that is gone: the other places may still tell.
    if let Ok(real) = files.realpath(executable) {
        add(posix_dirname(&real));
    }
    add(posix_dirname(executable));
    add("/usr/lib/claude-desktop".into());
    dirs.iter().find_map(|dir| {
        let text = files.read(&posix_join(&[dir, "version"])).ok()?;
        let version = text.trim();
        VERSION.is_match(version).then(|| version.to_string())
    })
}

/// What a node host is built from.
pub struct NodeHostOptions {
    pub sealer: Arc<Sealer>,
    pub apps: Option<Vec<PathBuf>>,
    /// The location the user chose in Settings, read on every use.
    pub chosen: Option<Arc<dyn Fn() -> Option<String> + Send + Sync>>,
    /// Runs commands; the system's by default.
    pub runner: Option<Arc<dyn CommandRunner>>,
}

struct Inner {
    sealer: Arc<Sealer>,
    candidates: Vec<String>,
    chosen: Option<Arc<dyn Fn() -> Option<String> + Send + Sync>>,
    runner: Arc<dyn CommandRunner>,
    seen_windows: AtomicUsize,
}

const PS_BUFFER: usize = 8 * 1024 * 1024;

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

impl Inner {
    fn exe(&self) -> Option<String> {
        let chosen = self.chosen.as_ref().and_then(|chosen| chosen());
        resolve_claude_executable(chosen.as_deref(), &self.candidates, &|p| {
            Path::new(p).exists()
        })
    }

    fn exec(
        &self,
        file: &str,
        argv: Vec<String>,
        options: ExecOptions,
    ) -> Result<ExecOutput, DetachedExecError> {
        self.runner.exec(file, &argv, &options)
    }

    fn ps(&self, argv: &[&str]) -> Result<String, DesktopError> {
        Ok(self
            .exec(
                "/bin/ps",
                args(argv),
                ExecOptions {
                    timeout: Duration::from_millis(5000),
                    max_buffer: Some(PS_BUFFER),
                    env: None,
                },
            )?
            .stdout)
    }

    /// Every process's pid, parent, executable and command line. macOS only. A busy main
    /// process can cut ps short, so an empty listing is a failure; one retry rides it out.
    fn mac_listing(&self) -> DesktopResult<Vec<crate::desktop_instances::ProcessRow>> {
        retry_once(
            || {
                let commands = self.ps(&["-axo", "pid=,ppid=,comm="])?;
                let arguments = self.ps(&["-axo", "pid=,args="])?;
                assert_process_listing(&commands)?;
                assert_process_listing(&arguments)?;
                Ok(process_rows(&commands, &arguments))
            },
            250,
            &sleep_ms,
        )
    }

    /// Every process's pid, parent and command line. Linux only.
    fn linux_listing(&self) -> DesktopResult<Vec<crate::desktop_instances::ProcessRow>> {
        retry_once(
            || {
                let stdout = self.ps(&["-eo", "pid=,ppid=,args="])?;
                assert_process_listing(&stdout)?;
                Ok(linux_process_rows(&stdout))
            },
            250,
            &sleep_ms,
        )
    }

    /// The main Claude and its windows, from one full listing. macOS and Linux only.
    fn instances(&self) -> DesktopResult<ClaudeInstances> {
        let Some(executable) = self.exe() else {
            return Ok(ClaudeInstances::default());
        };
        Ok(if Platform::current() == Platform::Linux {
            linux_instances(&self.linux_listing()?, &executable, own_pid())
        } else {
            mac_instances(&self.mac_listing()?, &executable)
        })
    }

    fn app(&self, action: AppAction, pid: i64) -> DesktopResult<()> {
        let script = app_script(action, pid)?;
        self.exec(
            "/usr/bin/osascript",
            vec!["-l".into(), "JavaScript".into(), "-e".into(), script],
            ExecOptions::timeout_ms(10_000),
        )?;
        Ok(())
    }

    /// The main Claude's pids, and its main pid on macOS, from one full listing.
    fn list_claude(&self) -> Result<ClaudeListing, ProcessError> {
        let Some(executable) = self.exe() else {
            return Ok(ClaudeListing::default());
        };
        let failed = |e: DesktopError| ProcessError::new(e.message());
        match Platform::current() {
            Platform::Linux => {
                let claude = linux_instances(
                    &self.linux_listing().map_err(failed)?,
                    &executable,
                    own_pid(),
                );
                self.seen_windows
                    .store(claude.windows.len(), Ordering::SeqCst);
                Ok(ClaudeListing {
                    pids: claude.main,
                    main: claude.main_pid,
                })
            }
            Platform::MacOs => {
                let claude = mac_instances(&self.mac_listing().map_err(failed)?, &executable);
                self.seen_windows
                    .store(claude.windows.len(), Ordering::SeqCst);
                Ok(ClaudeListing {
                    pids: claude.main,
                    main: claude.main_pid,
                })
            }
            Platform::Windows => {
                let stdout = self
                    .exec(
                        "powershell.exe",
                        args(&[
                            "-NoProfile",
                            "-NonInteractive",
                            "-Command",
                            "Get-Process -Name Claude -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress",
                        ]),
                        ExecOptions::timeout_ms(5000),
                    )
                    .map_err(|e| ProcessError::new(e.message))?
                    .stdout;
                Ok(ClaudeListing {
                    pids: windows_claude_pids(&stdout, &executable)?,
                    main: None,
                })
            }
        }
    }

    /// Starts `executable` on its own, outside Relay's process group. On Linux it gets the
    /// session's environment and the home folder, as a start from the desktop does.
    fn spawn_detached(&self, executable: &str, argv: &[String]) -> DesktopResult<()> {
        let mut command = Command::new(executable);
        command
            .args(argv)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        }
        if Platform::current() == Platform::Linux {
            let source: BTreeMap<String, String> = std::env::vars().collect();
            command
                .env_clear()
                .envs(linux_launch_env(&source))
                .current_dir(home_dir());
        }
        let child = command.spawn().map_err(|e| {
            DesktopError::new(format!(
                "spawn {executable} {}",
                crate::detached_exec::errno_code(&e)
            ))
        })?;
        // Reaped in the background so it never lingers as a zombie of Relay's.
        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
        Ok(())
    }

    /// The Electron version inside Claude.app; None when it cannot be read. macOS only.
    fn read_claude_electron(&self) -> Option<String> {
        let executable = self.exe()?;
        let bundle = bundle_of(&executable);
        let plist = Path::new(&bundle).join(
            "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist",
        );
        let out = self
            .exec(
                "/usr/bin/plutil",
                vec![
                    "-extract".into(),
                    "CFBundleVersion".into(),
                    "raw".into(),
                    plist.to_string_lossy().into_owned(),
                ],
                ExecOptions::timeout_ms(5000),
            )
            .ok()?;
        Some(out.stdout.trim().to_string())
    }
}

/// The pids of PowerShell's `Get-Process | ConvertTo-Json` whose path is `executable`.
fn windows_claude_pids(stdout: &str, executable: &str) -> Result<Vec<i64>, ProcessError> {
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let result: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| ProcessError::new(e.to_string()))?;
    let list = match result {
        serde_json::Value::Array(list) => list,
        other => vec![other],
    };
    Ok(list
        .iter()
        .filter(|p| {
            p.get("Path")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|path| path.to_lowercase() == executable.to_lowercase())
        })
        .filter_map(|p| crate::fs_util::safe_integer(p.get("Id")?))
        .collect())
}

/// `…/Claude.app` of an executable inside it.
fn bundle_of(executable: &str) -> String {
    match executable.find(".app/") {
        Some(at) => executable[..at + 4].to_string(),
        None => executable[..executable.len().min(3)].to_string(),
    }
}

/// Claude Desktop as a plain process sees it. Draft capture needs no app of Relay's: the
/// in-process reader does it.
pub struct NodeDesktopHost {
    inner: Arc<Inner>,
    liveness: ClaudeLiveness,
}

/// `nodeDesktopHost`.
pub fn node_desktop_host(options: NodeHostOptions) -> NodeDesktopHost {
    let candidates =
        claude_candidates(Platform::current(), options.apps.as_deref(), None, &|key| {
            std::env::var(key).ok()
        });
    let inner = Arc::new(Inner {
        sealer: options.sealer,
        candidates,
        chosen: options.chosen,
        runner: options.runner.unwrap_or_else(|| Arc::new(SystemRunner)),
        seen_windows: AtomicUsize::new(0),
    });
    let lister = Arc::clone(&inner);
    // Every full listing goes through it, so the tray's check can skip most of them.
    let liveness = ClaudeLiveness::new(LivenessDeps {
        list: Box::new(move || lister.list_claude()),
        alive: Box::new(pid_alive),
        now: Box::new(crate::clock::now_ms),
    });
    NodeDesktopHost { inner, liveness }
}

const QUIT_FAILED: &str = "Claude Desktop did not close. Finish running work and quit Claude, then try again. No files changed.";

impl NodeDesktopHost {
    fn pids(&self) -> DesktopResult<Vec<i64>> {
        Ok(self.liveness.pids()?)
    }

    /// The Electron version inside Claude (macOS) or beside it (Linux).
    pub fn claude_electron(&self) -> Option<String> {
        match Platform::current() {
            Platform::MacOs => self.inner.read_claude_electron(),
            Platform::Linux => self
                .inner
                .exe()
                .and_then(|exe| linux_electron_version(&exe, &RealFiles)),
            Platform::Windows => None,
        }
    }

    fn quit_mac(&self, answer_guard: Option<&AnswerGuard>) -> DesktopResult<Option<()>> {
        let attempt = || -> DesktopResult<()> {
            // By bundle id, AppleScript could reach a window instead; then each main app by pid.
            let ClaudeInstances {
                windows, main_apps, ..
            } = self.inner.instances()?;
            if !windows.is_empty() {
                for pid in main_apps {
                    self.inner.app(AppAction::Terminate, pid)?;
                }
            } else {
                self.inner.exec(
                    "/usr/bin/osascript",
                    args(&[
                        "-e",
                        "tell application id \"com.anthropic.claudefordesktop\" to quit",
                    ]),
                    ExecOptions::timeout_ms(20_000),
                )?;
            }
            Ok(())
        };
        if let Err(error) = attempt() {
            // Claude answers "canceled" while it asks the user about work left running; the
            // looks below decide whether it closed.
            if self.pids()?.is_empty() {
                return Ok(Some(()));
            }
            if answer_guard.is_none() {
                return Err(error);
            }
        }
        Ok(None)
    }
}

impl DesktopHost for NodeDesktopHost {
    fn available(&self) -> bool {
        self.inner.exe().is_some()
    }

    fn running(&self) -> DesktopResult<bool> {
        Ok(self.liveness.running()?)
    }

    fn seems_running(&self) -> DesktopResult<bool> {
        Ok(self.liveness.seems_running()?)
    }

    fn quit(&self, answer_guard: Option<&AnswerGuard>) -> DesktopResult<()> {
        let active = self.pids()?;
        if active.is_empty() {
            return Ok(());
        }
        match Platform::current() {
            Platform::MacOs => {
                if self.quit_mac(answer_guard)?.is_some() {
                    return Ok(());
                }
            }
            Platform::Linux => {
                // Electron quits on SIGTERM as from its menu, its helpers with it: only the main
                // Claude's own process is asked, never a window's.
                let ClaudeInstances { main_apps, .. } = self.inner.instances()?;
                let targets = if main_apps.is_empty() {
                    &active
                } else {
                    &main_apps
                };
                for &pid in targets {
                    // Already gone: fine.
                    let _ = kill_term(pid);
                }
            }
            Platform::Windows => {
                let argv: Vec<String> = active
                    .iter()
                    .flat_map(|pid| ["/PID".to_string(), pid.to_string()])
                    .collect();
                if let Err(error) =
                    self.inner
                        .exec("taskkill.exe", argv, ExecOptions::timeout_ms(20_000))
                    && !self.pids()?.is_empty()
                {
                    return Err(error.into());
                }
            }
        }
        for i in 0..40 {
            if self.pids()?.is_empty() {
                return Ok(());
            }
            // Still open after 2 s, and again 3 s later: Claude may be asking before it quits.
            if let Some(guard) = answer_guard
                && (i == 8 || i == 20)
            {
                // Unanswered: the quit fails below as it would without an answer.
                let _ = guard();
            }
            sleep_ms(250);
        }
        Err(QUIT_FAILED.into())
    }

    fn launch(&self, options: Option<LaunchOptions>) -> DesktopResult<()> {
        let Some(executable) = self.inner.exe() else {
            return Err("Claude Desktop is not installed.".into());
        };
        let argv = launch_args(options);
        if Platform::current() == Platform::MacOs {
            // While a window runs, `open -a` could only bring that one forward: the main Claude
            // comes forward by pid when it runs, and otherwise starts as a new app.
            let ClaudeInstances {
                windows, main_pid, ..
            } = self.inner.instances()?;
            if let Some(pid) = main_pid.filter(|_| !windows.is_empty()) {
                return self.inner.app(AppAction::Activate, pid);
            }
            // `open` hands its own environment to the app it starts; with none, Claude gets what
            // a Dock launch gives it.
            self.inner.exec(
                "/usr/bin/open",
                open_args(&bundle_of(&executable), &argv, !windows.is_empty()),
                ExecOptions {
                    timeout: Duration::from_millis(10_000),
                    max_buffer: None,
                    env: Some(clean_launch_env()),
                },
            )?;
            Ok(())
        } else {
            self.inner.spawn_detached(&executable, &argv)
        }
    }

    fn seal(&self, data: &str) -> DesktopResult<Vec<u8>> {
        Ok(self.inner.sealer.seal(data))
    }

    fn unseal(&self, data: &[u8]) -> DesktopResult<String> {
        self.inner
            .sealer
            .unseal(data)
            .map_err(|e| DesktopError::new(e.to_string()))
    }

    fn reads_drafts(&self) -> bool {
        true
    }

    fn drafts_blocked(&self) -> DesktopResult<Option<String>> {
        Ok(match Platform::current() {
            Platform::MacOs | Platform::Linux => None,
            Platform::Windows => Some("Drafts move only on macOS and Linux.".into()),
        })
    }

    // Claude's log is only known on macOS and Linux.
    fn watch_launch(&self) -> Option<Box<dyn LaunchWatch>> {
        let log = claude_log_here()?;
        let inner = Arc::clone(&self.inner);
        let liveness = ClaudeLiveness::new(LivenessDeps {
            list: Box::new(move || inner.list_claude()),
            alive: Box::new(pid_alive),
            now: Box::new(crate::clock::now_ms),
        });
        watch_claude_launch(&log, Arc::new(move || liveness.running()))
    }

    fn signed_out(&self) -> Option<bool> {
        claude_signed_out(&claude_log_here()?)
    }

    fn sign_outs(&self) -> Option<Vec<ClaudeSignOut>> {
        Some(
            claude_log_here()
                .map(|log| claude_sign_outs(&log))
                .unwrap_or_default(),
        )
    }

    fn has_windows(&self) -> bool {
        true
    }

    fn windows(&self) -> DesktopResult<Vec<ClaudeWindowProcess>> {
        match Platform::current() {
            Platform::MacOs | Platform::Linux => Ok(self.inner.instances()?.windows),
            Platform::Windows => Ok(Vec::new()),
        }
    }

    fn launch_window(&self, dir: &Path, options: Option<LaunchOptions>) -> DesktopResult<()> {
        let executable = self.inner.exe();
        if Platform::current() == Platform::Windows {
            return Err(WINDOWS_UNSUPPORTED.into());
        }
        let Some(executable) = executable else {
            return Err("Claude Desktop is not installed.".into());
        };
        let mut argv = vec![format!("--user-data-dir={}", dir.to_string_lossy())];
        argv.extend(launch_args(options));
        if Platform::current() == Platform::Linux {
            self.inner.spawn_detached(&executable, &argv)
        } else {
            self.inner.exec(
                "/usr/bin/open",
                open_args(&bundle_of(&executable), &argv, true),
                ExecOptions {
                    timeout: Duration::from_millis(10_000),
                    max_buffer: None,
                    env: Some(clean_launch_env()),
                },
            )?;
            Ok(())
        }
    }

    fn quit_window(&self, pid: i64) -> DesktopResult<()> {
        if Platform::current() != Platform::Linux {
            return self.inner.app(AppAction::Terminate, pid);
        }
        // Only a window's own main process, seen in a fresh listing: never a reused pid.
        if !self
            .inner
            .instances()?
            .windows
            .iter()
            .any(|window| window.pid == pid)
        {
            return Ok(());
        }
        // Already gone: fine.
        let _ = kill_term(pid);
        Ok(())
    }

    fn activate_window(&self, pid: i64) -> DesktopResult<()> {
        if Platform::current() != Platform::Linux {
            return self.inner.app(AppAction::Activate, pid);
        }
        // Started again on its folder, Claude hands over to the one running there, which brings
        // its window forward.
        let executable = self.inner.exe();
        let window = self
            .inner
            .instances()?
            .windows
            .into_iter()
            .find(|w| w.pid == pid);
        if let (Some(executable), Some(window)) = (executable, window) {
            self.inner
                .spawn_detached(&executable, &[format!("--user-data-dir={}", window.dir)])?;
        }
        Ok(())
    }

    fn windows_seen(&self) -> usize {
        self.inner.seen_windows.load(Ordering::SeqCst)
    }

    fn automation_target(&self) -> DesktopResult<AutomationTarget> {
        if Platform::current() != Platform::MacOs {
            return Ok(AutomationTarget::Main);
        }
        let ClaudeInstances {
            windows, main_pid, ..
        } = self.inner.instances()?;
        Ok(match (windows.is_empty(), main_pid) {
            (true, _) => AutomationTarget::Main,
            (false, Some(pid)) => AutomationTarget::Pid(pid),
            (false, None) => AutomationTarget::None,
        })
    }

    fn claude_uptime_ms(&self) -> Option<i64> {
        let executable = self.inner.exe();
        if Platform::current() == Platform::Windows || executable.is_none() {
            return None;
        }
        // Gone between the two reads, or ps failed: the uptime is unknown.
        let main = self.inner.instances().ok()?.main_pid?;
        let stdout = self
            .inner
            .exec(
                "/bin/ps",
                vec!["-o".into(), "etime=".into(), "-p".into(), main.to_string()],
                ExecOptions::timeout_ms(5000),
            )
            .ok()?
            .stdout;
        parse_etime(&stdout)
    }
}
