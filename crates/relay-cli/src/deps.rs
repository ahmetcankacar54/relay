//! Port of `cli/src/deps.ts`: what the CLI reaches outside its own process; tests replace each
//! part.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use relay_core::browser_system::{BrowserSystem, mac_browser_system};
use relay_core::desktop::{DesktopHost, ExtensionPorts};
use relay_core::desktop_host_node::{NodeHostOptions, node_desktop_host};
use relay_core::environment::{exec_file, resolve_executable};
use relay_core::extension_storage::{ExtensionStorage, LevelExtensionStorage};
pub use relay_core::provider_usage::FetchFn;
use relay_core::provider_usage::default_fetch;
use relay_core::relay_paths::{Platform, home_dir};
use relay_core::terminal_identity::{TerminalPorts, mac_terminal_ports};
pub use relay_core::usage::UsageRequest;
use relay_core::usage::request_usage_json;
use relay_core::vault_crypto::Sealer;

use crate::io::Env;

/// Starts a detached worker: the executable, its arguments and its whole environment.
pub type SpawnDetached = Arc<dyn Fn(&Path, &[String], &Env) -> io::Result<()> + Send + Sync>;
/// Claude Desktop for the Claude.app bundles given.
pub type HostFactory = Arc<dyn Fn(&[PathBuf]) -> Arc<dyn DesktopHost> + Send + Sync>;
/// The Claude Code CLI, the chosen one first.
pub type ClaudeLookup = Arc<dyn Fn(Option<&str>) -> Option<String> + Send + Sync>;

/// `CliDeps`.
#[derive(Clone)]
pub struct CliDeps {
    /// Claude Desktop as the CLI drives it, for the Claude.app bundles `apps`. Its own
    /// seal/unseal are never used: the context seals with the vault key, or refuses.
    pub host: HostFactory,
    pub security_tool: PathBuf,
    pub request: UsageRequest,
    /// The Claude Code CLI, `explicit` first.
    pub claude: ClaudeLookup,
    /// `ps -axo pid=,ppid=,comm=`.
    pub process_list: Arc<dyn Fn() -> Result<String, String> + Send + Sync>,
    /// The installed Relay.app's version, or `None` when none is installed.
    pub relay_app_version: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Whether this runs in a logged-in macOS desktop session, not over SSH.
    pub gui_session: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The executable the detached worker runs (`std::env::current_exe()`).
    pub self_exe: PathBuf,
    pub spawn_detached: SpawnDetached,
    /// Claude Code's transcripts, for the history summary.
    pub transcript_root: PathBuf,
    /// `None` when a switch leaves the extension alone.
    pub extension: Option<ExtensionPorts>,
    /// The terminal's Claude Code sign-in; `None` when a switch leaves it alone.
    pub terminal: Option<TerminalPorts>,
    pub platform: Platform,
    /// The provider APIs' GET (`fetch`): Codex's usage endpoint.
    pub fetch: FetchFn,
}

/// Where Relay.app may be installed.
pub fn relay_apps() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/Relay.app"),
        home_dir().join("Applications").join("Relay.app"),
    ]
}

/// Node's `process.platform` for `platform`.
pub const fn platform_name(platform: Platform) -> &'static str {
    match platform {
        Platform::MacOs => "darwin",
        Platform::Windows => "win32",
        Platform::Linux => "linux",
    }
}

fn read_app_version(apps: &[PathBuf]) -> Option<String> {
    for app in apps {
        let plist = app.join("Contents").join("Info.plist");
        let Ok(output) = exec_file(
            "/usr/bin/plutil",
            &[
                "-extract",
                "CFBundleShortVersionString",
                "raw",
                &plist.to_string_lossy(),
            ],
            None,
            None,
            Duration::from_secs(5),
            1024 * 1024,
        ) else {
            continue;
        };
        let version = relay_core::store::schema::js_trim(&output.stdout).to_owned();
        if starts_with_version(&version) {
            return Some(version);
        }
    }
    None
}

/// `/^\d+\.\d+\.\d+/`.
fn starts_with_version(text: &str) -> bool {
    let mut parts = text.splitn(3, '.');
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (Some(a), Some(b), Some(c)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    digits(a) && digits(b) && c.bytes().next().is_some_and(|b| b.is_ascii_digit())
}

fn gui_session() -> bool {
    match exec_file(
        "/bin/launchctl",
        &["managername"],
        None,
        None,
        Duration::from_secs(3),
        1024 * 1024,
    ) {
        Ok(output) => relay_core::store::schema::js_trim(&output.stdout) == "Aqua",
        // Unknown: let Claude's own quit say so.
        Err(_) => true,
    }
}

fn process_list() -> Result<String, String> {
    exec_file(
        "/bin/ps",
        &["-axo", "pid=,ppid=,comm="],
        None,
        None,
        Duration::from_secs(5),
        8 * 1024 * 1024,
    )
    .map(|o| o.stdout)
    .map_err(|e| e.to_string())
}

/// Starts `exe args` in a session of its own, with nothing attached, and leaves it running.
pub fn spawn_detached(exe: &Path, args: &[String], env: &Env) -> io::Result<()> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own session: Claude's quit, or the terminal closing, cannot reach it.
        // SAFETY: setsid is async-signal-safe and touches no memory of this process.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP.
        command.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    command.spawn().map(drop)
}

/// A key only to build the host with: the context wraps the host's seal and unseal.
fn unused_sealer() -> Arc<Sealer> {
    Arc::new(Sealer::new(&[0u8; 32]).expect("32-byte key"))
}

pub fn default_deps() -> CliDeps {
    let platform = Platform::current();
    // A stand-in tool for tests and parity recordings; only an absolute path is honored.
    let security_tool = std::env::var_os("RELAY_SECURITY_TOOL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from("/usr/bin/security"));
    CliDeps {
        host: Arc::new(|apps: &[PathBuf]| {
            Arc::new(node_desktop_host(NodeHostOptions {
                sealer: unused_sealer(),
                apps: Some(apps.to_vec()),
                chosen: None,
                runner: None,
            })) as Arc<dyn DesktopHost>
        }),
        security_tool,
        request: Arc::new(request_usage_json),
        claude: Arc::new(resolve_executable),
        process_list: Arc::new(process_list),
        relay_app_version: Arc::new(|| read_app_version(&relay_apps())),
        gui_session: Arc::new(gui_session),
        self_exe: std::env::current_exe().unwrap_or_default(),
        spawn_detached: Arc::new(spawn_detached),
        transcript_root: home_dir().join(".claude"),
        extension: (platform == Platform::MacOs).then(|| ExtensionPorts {
            system: Arc::new(mac_browser_system(home_dir())) as Arc<dyn BrowserSystem>,
            storage: Arc::new(LevelExtensionStorage) as Arc<dyn ExtensionStorage>,
            cookies: None,
        }),
        terminal: mac_terminal_ports(None, platform),
        platform,
        fetch: default_fetch(),
    }
}
