//! Port of `electron/core/browser-system.ts`: finding the Chromium browsers that have the Claude
//! extension, telling whether one runs, and quitting and opening it again.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use crate::desktop_processes::{kill_term, pid_alive};
use crate::detached_exec::{ExecOptions, run_detached};
use crate::fs_util::{mtime_ms, resolve};
use crate::shared::browser_extension::{
    BrowserApp, CLAUDE_EXTENSION_ID, ExtensionInstance, browser, browser_apps, is_profile_folder,
    local_state_profiles,
};

/// What Relay reads and runs to find and restart a browser: its `Local State`, `Preferences`, the
/// target of its `SingletonLock` link, the process list, and `osascript` and `open` (on Linux
/// /proc, a signal and the browser's own launcher).
pub trait BrowserSystem: Send + Sync {
    /// ~/Library/Application Support; on Linux $XDG_CONFIG_HOME (~/.config).
    fn support(&self) -> &Path;
    /// The browsers' layout: macOS when None; Linux (`Some("linux")`) has its own folders and
    /// fewer browsers.
    fn platform(&self) -> Option<&str> {
        None
    }
    /// This machine's name, which a Linux `SingletonLock` link starts with ("host-pid").
    fn hostname(&self) -> Option<&str> {
        None
    }
    fn read_text(&self, file: &Path) -> Option<String>;
    fn exists(&self, file: &Path) -> bool;
    /// macOS refuses to let Relay read the file (privacy protection), as opposed to it missing.
    fn denied(&self, _file: &Path) -> bool {
        false
    }
    /// The newest modification time (ms) of a folder's files; None when it cannot be read.
    fn modified_at(&self, dir: &Path) -> Option<f64>;
    fn read_link(&self, file: &Path) -> Option<String>;
    fn alive(&self, pid: i64) -> bool;
    /// Every process's executable path, one per line: from `ps` on macOS, /proc on Linux.
    fn processes(&self) -> Result<String, String>;
    /// Asks the browser to quit as a user would; returns once asked, not once it has quit.
    fn quit(&self, app: BrowserApp) -> Result<(), String>;
    /// Opens the browser in the background, restoring the windows it had.
    fn launch(&self, app: BrowserApp) -> Result<(), String>;
    /// Opens `url` in the browser, in front, in the profile folder `profile`.
    fn open_url(&self, app: BrowserApp, url: &str, profile: &str) -> Result<(), String>;
    fn sleep(&self, ms: u64);
}

/// Local State is a few hundred kilobytes; anything far larger is not one.
const MAX_JSON: u64 = 16 * 1024 * 1024;

fn read_text(file: &Path) -> Option<String> {
    if fs::metadata(file).ok()?.len() > MAX_JSON {
        return None;
    }
    // readFileSync(file, "utf8"): invalid bytes become U+FFFD.
    fs::read(file)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn modified_at(dir: &Path) -> Option<f64> {
    let mut newest = mtime_ms(&fs::metadata(dir).ok()?).ok()?;
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let mtime = mtime_ms(&fs::symlink_metadata(entry.path()).ok()?).ok()?;
        newest = newest.max(mtime);
    }
    Some(newest)
}

fn read_link(file: &Path) -> Option<String> {
    fs::read_link(file)
        .ok()
        .map(|target| target.to_string_lossy().into_owned())
}

fn exists(file: &Path) -> bool {
    file.exists()
}

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn exec_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// The macOS browser adapter.
pub struct MacBrowserSystem {
    home: PathBuf,
    support: PathBuf,
}

/// The macOS adapter for `home` (the user's home folder).
pub fn mac_browser_system(home: impl Into<PathBuf>) -> MacBrowserSystem {
    let home = home.into();
    MacBrowserSystem {
        support: home.join("Library").join("Application Support"),
        home,
    }
}

impl BrowserSystem for MacBrowserSystem {
    fn support(&self) -> &Path {
        &self.support
    }
    fn read_text(&self, file: &Path) -> Option<String> {
        read_text(file)
    }
    fn exists(&self, file: &Path) -> bool {
        exists(file)
    }
    fn denied(&self, file: &Path) -> bool {
        match fs::File::open(file) {
            Ok(_) => false,
            Err(error) => error.kind() == std::io::ErrorKind::PermissionDenied,
        }
    }
    fn modified_at(&self, dir: &Path) -> Option<f64> {
        modified_at(dir)
    }
    fn read_link(&self, file: &Path) -> Option<String> {
        read_link(file)
    }
    fn alive(&self, pid: i64) -> bool {
        pid_alive(pid)
    }
    fn processes(&self) -> Result<String, String> {
        let options = ExecOptions {
            max_buffer: Some(8 * 1024 * 1024),
            ..ExecOptions::timeout_ms(5000)
        };
        run_detached("/bin/ps", &["-axo".into(), "comm=".into()], &options)
            .map(|out| out.stdout)
            .map_err(exec_error)
    }
    fn quit(&self, app: BrowserApp) -> Result<(), String> {
        // Guarded: `tell … to quit` on an app that is not running would launch it first.
        let id = browser(app).bundle_id;
        let script = format!(
            "if application id \"{id}\" is running then tell application id \"{id}\" to quit"
        );
        run_detached(
            "/usr/bin/osascript",
            &["-e".into(), script],
            &ExecOptions::timeout_ms(20_000),
        )
        .map(|_| ())
        .map_err(exec_error)
    }
    fn launch(&self, app: BrowserApp) -> Result<(), String> {
        // -g keeps focus where it is. The flag restores the last session whatever the browser's
        // own startup setting says, so a quit for the swap never loses the user's tabs.
        let args = [
            "-g",
            "-b",
            browser(app).bundle_id,
            "--args",
            "--restore-last-session",
        ];
        run_detached(
            "/usr/bin/open",
            &args.map(str::to_owned),
            &ExecOptions::timeout_ms(15_000),
        )
        .map(|_| ())
        .map_err(exec_error)
    }
    fn open_url(&self, app: BrowserApp, url: &str, profile: &str) -> Result<(), String> {
        let args = vec![format!("--profile-directory={profile}"), url.to_owned()];
        // `open` hands arguments only to a browser it starts. A running one is reached through its
        // own executable: Chromium passes a second start's command line to the running browser,
        // which opens the page in that profile. Only HOME and PATH travel, never Relay's
        // environment. Only a browser installed in an Applications folder is run.
        let main = format!(".app/Contents/MacOS/{}", browser(app).executable);
        let user_apps = format!("{}/", self.home.join("Applications").to_string_lossy());
        let installed = ["/Applications/", user_apps.as_str()];
        let listed = self.processes()?;
        let running = listed.split('\n').map(str::trim).find(|line| {
            installed.iter().any(|dir| line.starts_with(dir))
                && resolve(Path::new(line)) == Path::new(line)
                && !line.contains("/./")
                && line.ends_with(&main)
        });
        match running {
            Some(running) => {
                let env = BTreeMap::from([
                    ("HOME".to_owned(), self.home.to_string_lossy().into_owned()),
                    ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ]);
                let options = ExecOptions {
                    env: Some(env),
                    ..ExecOptions::timeout_ms(15_000)
                };
                run_detached(running, &args, &options)
            }
            None => {
                let mut all = vec![
                    "-b".to_owned(),
                    browser(app).bundle_id.to_owned(),
                    "--args".to_owned(),
                ];
                all.extend(args);
                run_detached("/usr/bin/open", &all, &ExecOptions::timeout_ms(15_000))
            }
        }
        .map(|_| ())
        .map_err(exec_error)
    }
    fn sleep(&self, ms: u64) {
        sleep(ms);
    }
}

// --- Linux ------------------------------------------------------------------------------------

/// One process of this user, from /proc: its executable and its command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxProcess {
    pub pid: i64,
    pub exe: String,
    pub args: Vec<String>,
}

/// The processes /proc lets this user see whole: other users' `exe` links cannot be read.
fn linux_processes() -> Vec<LinuxProcess> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            // A binary replaced by an update reads "<path> (deleted)" until the browser restarts.
            let exe = fs::read_link(format!("/proc/{name}/exe")).ok()?;
            let exe = exe.to_string_lossy();
            let exe = exe.strip_suffix(" (deleted)").unwrap_or(&exe).to_owned();
            let cmdline = fs::read(format!("/proc/{name}/cmdline")).ok()?;
            let args = String::from_utf8_lossy(&cmdline)
                .split('\0')
                .filter(|a| !a.is_empty())
                .map(str::to_owned)
                .collect();
            Some(LinuxProcess {
                pid: name.parse().ok()?,
                exe,
                args,
            })
        })
        .collect()
}

/// A `SingletonLock` link's owner, "host-pid".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockOwner {
    pub host: String,
    pub pid: i64,
}

/// A `SingletonLock` link's target, "host-pid"; None for anything else.
pub fn lock_owner(target: Option<&str>) -> Option<LockOwner> {
    static OWNER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new("^(.*)-([0-9]+)$").expect("static"));
    let captures = OWNER.captures(target?)?;
    let pid: f64 = captures[2].parse().ok()?;
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    (pid > 0.0 && pid <= MAX_SAFE).then(|| LockOwner {
        host: captures[1].to_owned(),
        pid: pid as i64,
    })
}

fn basename(file: &str) -> &str {
    file.rsplit('/').next().unwrap_or(file)
}

/// The browser's main processes, the ones to ask to quit: the one its `SingletonLock` names when
/// that is this machine's and still a browser process, else every process of its executables that
/// is not a helper (`--type=…`: renderers, zygotes, GPU). A recycled pid is never signalled: its
/// executable must be named like the browser's.
pub fn linux_main_pids(
    app: BrowserApp,
    lock_target: Option<&str>,
    hostname: &str,
    processes: &[LinuxProcess],
) -> Vec<i64> {
    let executables: &[&str] = browser(app).linux.map(|l| l.executables).unwrap_or(&[]);
    let names: Vec<&str> = executables.iter().map(|exe| basename(exe)).collect();
    let main = |p: &LinuxProcess| !p.args.iter().any(|arg| arg.starts_with("--type="));
    if let Some(lock) = lock_owner(lock_target)
        && lock.host == hostname
        && let Some(owner) = processes.iter().find(|p| p.pid == lock.pid)
        && names.contains(&basename(&owner.exe))
        && main(owner)
    {
        return vec![owner.pid];
    }
    processes
        .iter()
        .filter(|p| executables.contains(&p.exe.as_str()) && main(p))
        .map(|p| p.pid)
        .collect()
}

/// The first of `commands` that is an executable file in one of `dirs`.
pub fn find_command(
    commands: &[&str],
    dirs: &[String],
    executable: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    for command in commands {
        for dir in dirs {
            let dir = Path::new(dir);
            if !dir.is_absolute() {
                continue;
            }
            let file = resolve(&dir.join(command));
            if executable(&file) {
                return Some(file);
            }
        }
    }
    None
}

/// The part of Relay's environment a browser it starts gets: the graphical session (X11 or
/// Wayland, D-Bus, XDG folders, locale), never Relay's own variables or an AppImage's library
/// path, which would break the browser.
pub fn session_environment(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    static KEEP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new("^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|DESKTOP_SESSION|SSH_AUTH_SOCK|KDE_FULL_SESSION|KDE_SESSION_VERSION|GNOME_DESKTOP_SESSION_ID|GTK_THEME|QT_QPA_PLATFORMTHEME|XDG_[A-Z_]+|LC_[A-Z_]+)$").expect("static")
    });
    env.iter()
        .filter(|(key, _)| KEEP.is_match(key))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// This machine's name (`os.hostname()`).
fn this_hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is writable for its whole length.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
        if ok {
            let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
            return String::from_utf8_lossy(&buffer[..end]).into_owned();
        }
        String::new()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

/// Linux: browsers under $XDG_CONFIG_HOME, found running through their `SingletonLock` or /proc,
/// quit with SIGTERM to the main process, started through their launcher on PATH.
///
/// SIGTERM is what the desktop sends at logout: Chromium saves the session and closes, but there
/// is no quit that a "leave this page" prompt can hold up as on macOS. So the default mode
/// ("guide") and "closed" never quit it.
pub struct LinuxBrowserSystem {
    home: PathBuf,
    env: BTreeMap<String, String>,
    support: PathBuf,
    hostname: String,
}

/// The Linux adapter for `home` and the environment `env` (Relay's own in the app).
pub fn linux_browser_system(
    home: impl Into<PathBuf>,
    env: BTreeMap<String, String>,
) -> LinuxBrowserSystem {
    let home = home.into();
    let support = match env.get("XDG_CONFIG_HOME") {
        Some(xdg) if !xdg.is_empty() && Path::new(xdg).is_absolute() => PathBuf::from(xdg),
        _ => home.join(".config"),
    };
    LinuxBrowserSystem {
        home,
        env,
        support,
        hostname: this_hostname(),
    }
}

impl LinuxBrowserSystem {
    fn command(&self, app: BrowserApp) -> Option<PathBuf> {
        let mut dirs: Vec<String> = self
            .env
            .get("PATH")
            .map(String::as_str)
            .unwrap_or_default()
            .split(':')
            .map(str::to_owned)
            .collect();
        dirs.extend(["/usr/local/bin", "/usr/bin", "/bin"].map(str::to_owned));
        let commands: &[&str] = browser(app).linux.map(|l| l.commands).unwrap_or(&[]);
        find_command(commands, &dirs, &|file| is_executable_file(file))
    }

    /// The browser outlives Relay: its own process group, no pipes, not waited for by the caller.
    /// A second start of a running browser hands its command line to the running one and exits.
    fn start(&self, app: BrowserApp, args: &[String]) -> Result<(), String> {
        let file = self
            .command(app)
            .ok_or_else(|| format!("{} was not found on PATH.", browser(app).name))?;
        let mut env = self.env.clone();
        env.insert("HOME".into(), self.home.to_string_lossy().into_owned());
        let mut command = std::process::Command::new(&file);
        command
            .args(args)
            .env_clear()
            .envs(session_environment(&env))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        // Reaped in the background, as Node's event loop does, so no zombie is left.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

fn is_executable_file(file: &Path) -> bool {
    let Ok(meta) = fs::metadata(file) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

impl BrowserSystem for LinuxBrowserSystem {
    fn support(&self) -> &Path {
        &self.support
    }
    fn platform(&self) -> Option<&str> {
        Some("linux")
    }
    fn hostname(&self) -> Option<&str> {
        Some(&self.hostname)
    }
    fn read_text(&self, file: &Path) -> Option<String> {
        read_text(file)
    }
    fn exists(&self, file: &Path) -> bool {
        exists(file)
    }
    fn modified_at(&self, dir: &Path) -> Option<f64> {
        modified_at(dir)
    }
    fn read_link(&self, file: &Path) -> Option<String> {
        read_link(file)
    }
    fn alive(&self, pid: i64) -> bool {
        pid_alive(pid)
    }
    fn processes(&self) -> Result<String, String> {
        Ok(linux_processes()
            .into_iter()
            .map(|p| p.exe)
            .collect::<Vec<_>>()
            .join("\n"))
    }
    fn quit(&self, app: BrowserApp) -> Result<(), String> {
        let lock = read_link(&data_dir(self, app).join("SingletonLock"));
        for pid in linux_main_pids(app, lock.as_deref(), &self.hostname, &linux_processes()) {
            // Gone already: the wait decides.
            let _ = kill_term(pid);
        }
        Ok(())
    }
    fn launch(&self, app: BrowserApp) -> Result<(), String> {
        // The flag restores the last session whatever the browser's own startup setting says.
        self.start(app, &["--restore-last-session".to_owned()])
    }
    fn open_url(&self, app: BrowserApp, url: &str, profile: &str) -> Result<(), String> {
        self.start(
            app,
            &[format!("--profile-directory={profile}"), url.to_owned()],
        )
    }
    fn sleep(&self, ms: u64) {
        sleep(ms);
    }
}

/// The browser adapter of this platform; None where Relay has none (Windows).
pub fn platform_browser_system(platform: &str) -> Option<Arc<dyn BrowserSystem>> {
    let home = || {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
    };
    match platform {
        "darwin" => Some(Arc::new(mac_browser_system(home()))),
        "linux" => Some(Arc::new(linux_browser_system(
            home(),
            std::env::vars().collect(),
        ))),
        _ => None,
    }
}

/// The browser's user data folder.
pub fn data_dir(system: &(impl BrowserSystem + ?Sized), app: BrowserApp) -> PathBuf {
    let info = browser(app);
    let dir = match (system.platform(), info.linux) {
        (Some("linux"), Some(linux)) => linux.data_dir,
        _ => info.data_dir,
    };
    system.support().join(dir)
}

/// `Local State` or a profile's `Preferences` as JSON; None when missing or invalid.
pub fn read_json(system: &(impl BrowserSystem + ?Sized), file: &Path) -> Option<Value> {
    serde_json::from_str(&system.read_text(file)?).ok()
}

/// The folder holding the extension's `chrome.storage.local` in a profile.
pub fn extension_storage_dir(
    system: &(impl BrowserSystem + ?Sized),
    app: BrowserApp,
    profile: &str,
) -> Result<PathBuf, String> {
    if !is_profile_folder(profile) {
        return Err("Invalid browser profile.".into());
    }
    Ok(data_dir(system, app)
        .join(profile)
        .join("Local Extension Settings")
        .join(CLAUDE_EXTENSION_ID))
}

/// The folder the extension is installed in, in a profile; it has no storage until first opened.
pub fn extension_install_dir(
    system: &(impl BrowserSystem + ?Sized),
    app: BrowserApp,
    profile: &str,
) -> Result<PathBuf, String> {
    if !is_profile_folder(profile) {
        return Err("Invalid browser profile.".into());
    }
    Ok(data_dir(system, app)
        .join(profile)
        .join("Extensions")
        .join(CLAUDE_EXTENSION_ID))
}

/// Every browser profile that has the extension, in the browsers' own order: those with its
/// storage, and those where it is installed but was never opened (`opened` false).
pub fn extension_instances(system: &(impl BrowserSystem + ?Sized)) -> Vec<ExtensionInstance> {
    let mut out = Vec::new();
    for app in browser_apps(system.platform()) {
        let state =
            read_json(system, &data_dir(system, app).join("Local State")).unwrap_or(Value::Null);
        for p in local_state_profiles(&state) {
            let (Ok(storage), Ok(install)) = (
                extension_storage_dir(system, app, &p.profile),
                extension_install_dir(system, app, &p.profile),
            ) else {
                continue;
            };
            let opened = system.exists(&storage);
            if !opened && !system.exists(&install) {
                continue;
            }
            let used_at = if opened {
                system.modified_at(&storage)
            } else {
                None
            };
            out.push(ExtensionInstance {
                app,
                profile: p.profile,
                name: p.name,
                opened,
                used_at,
            });
        }
    }
    out
}

/// Browsers whose data folder is there but macOS does not let Relay read: their extension cannot
/// be found until Relay has Full Disk Access.
pub fn denied_browsers(system: &(impl BrowserSystem + ?Sized)) -> Vec<BrowserApp> {
    browser_apps(system.platform())
        .into_iter()
        .filter(|&app| {
            let dir = data_dir(system, app);
            system.exists(&dir) && system.denied(&dir.join("Local State"))
        })
        .collect()
}

/// Whether the browser runs: the process its `SingletonLock` link names ("host-pid") is alive, or
/// its main executable is in the process list. On Linux a link made on another machine (a shared
/// home) counts as running: the browser there holds the profile.
pub fn browser_running(
    system: &(impl BrowserSystem + ?Sized),
    app: BrowserApp,
) -> Result<bool, String> {
    let lock = lock_owner(
        system
            .read_link(&data_dir(system, app).join("SingletonLock"))
            .as_deref(),
    );
    if let Some(lock) = &lock {
        if system.hostname().is_some_and(|host| lock.host != host) {
            return Ok(true);
        }
        if system.alive(lock.pid) {
            return Ok(true);
        }
    }
    let listed = system.processes()?;
    let mut lines = listed.split('\n').map(str::trim);
    if system.platform() == Some("linux") {
        let executables: &[&str] = browser(app).linux.map(|l| l.executables).unwrap_or(&[]);
        return Ok(lines.any(|line| executables.contains(&line)));
    }
    let main = format!(".app/Contents/MacOS/{}", browser(app).executable);
    Ok(lines.any(|line| line.ends_with(&main)))
}

/// Asks the browser to quit and waits for it, never forcing it: a "downloads in progress" or
/// "leave this page" prompt keeps it open and the caller leaves it alone. False when it is still
/// running after `wait_ms` (30 s in the app).
pub fn quit_browser(
    system: &(impl BrowserSystem + ?Sized),
    app: BrowserApp,
    wait_ms: u64,
) -> Result<bool, String> {
    // Not asked, or asked and the answer was lost: the wait below decides.
    let _ = system.quit(app);
    let mut waited = 0;
    while waited <= wait_ms {
        if !browser_running(system, app)? {
            return Ok(true);
        }
        system.sleep(250);
        waited += 250;
    }
    Ok(false)
}

/// `quit_browser`'s default wait.
pub const QUIT_WAIT_MS: u64 = 30_000;
