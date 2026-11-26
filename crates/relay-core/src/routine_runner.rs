//! Port of `electron/core/routine-runner.ts`: the scheduled usage-window starter, a one-turn
//! `claude --print` in an isolated temporary folder with every tool, MCP server and
//! customization off.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};

use crate::clock::now_ms;
use crate::environment::{CommandError, CommandOutput, Env, process_env, profile_environment};
use crate::profile_identity::read_profile_identity;
use crate::relay_paths::{Platform, home_dir};
use crate::shared::planning::planning_identity;
use crate::shared::types::Account;
use crate::store::Store;
use crate::usage_credentials::{UsageCredential, UsageError};

pub const QUOTA_STARTER_PROMPT: &str = "Reply with exactly OK. This is a scheduled usage-window check. Do not use tools, read files, or continue any previous task.";

pub fn quota_starter_args() -> Vec<String> {
    let settings = json!({
        "disableAllHooks": true,
        "enabledPlugins": {},
        "disableClaudeAiConnectors": true,
        "syncClaudeAiPlugins": false,
        "syncClaudeAiSkills": false,
        "autoMemoryEnabled": false,
    })
    .to_string();
    [
        "--print",
        QUOTA_STARTER_PROMPT,
        "--safe-mode",
        "--tools",
        "",
        "--disallowedTools",
        "*",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--setting-sources",
        "",
        "--settings",
        &settings,
        "--disable-slash-commands",
        "--no-chrome",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--max-turns",
        "1",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--output-format",
        "json",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

static TRACING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(OTEL_|BETA_TRACING_|ENABLE_BETA_TRACING|DEBUG$)").expect("valid pattern")
});

pub fn routine_environment(profile: &str, token: &str, source: &Env) -> Env {
    let mut env = profile_environment(profile, source);
    // The silently acquired credential takes precedence over keychain access.
    // No token is included in command arguments, logs, or persisted state.
    for (key, value) in [
        ("CLAUDE_CODE_OAUTH_TOKEN", token),
        ("ENABLE_CLAUDEAI_MCP_SERVERS", "false"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ("CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "1"),
        ("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"),
        ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
        ("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1"),
        ("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1"),
        ("DISABLE_AUTOUPDATER", "1"),
    ] {
        env.insert(key.into(), value.into());
    }
    // An inherited exporter could expose OAuth credentials or the routine text.
    env.retain(|key, _| !TRACING.is_match(key));
    env
}

/// Files whose presence means an administrator or server policy Relay will not run under.
pub fn routine_policy_paths(profile: &Path, platform: Platform, home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![profile.join("remote-settings.json")];
    let directory = match platform {
        Platform::MacOs => "/Library/Application Support/ClaudeCode",
        Platform::Linux => "/etc/claude-code",
        Platform::Windows => "C:\\Program Files\\ClaudeCode",
    };
    paths.extend(
        [
            "managed-settings.json",
            "managed-settings.d",
            "managed-mcp.json",
        ]
        .iter()
        .map(|name| Path::new(directory).join(name)),
    );
    if platform == Platform::MacOs {
        // Presence alone is enough to refuse; no policy contents or commands are
        // executed. The prefs domain is documented as com.anthropic.claudecode.
        let user = home.file_name().map(PathBuf::from).unwrap_or_default();
        paths.extend([
            PathBuf::from("/Library/Managed Preferences/com.anthropic.claudecode.plist"),
            Path::new("/Library/Managed Preferences")
                .join(user)
                .join("com.anthropic.claudecode.plist"),
            PathBuf::from("/Library/Preferences/com.anthropic.claudecode.plist"),
            home.join("Library/Preferences/com.anthropic.claudecode.plist"),
        ]);
    }
    paths
}

/// Any account whose usage identity matches its Desktop binding may start a window, including
/// company seats. Local administrator policy is still refused in `run_quota_starter`;
/// server-delivered policy cannot be detected locally.
pub fn window_start_eligible(account: &Account) -> bool {
    planning_identity(account).is_some()
}

/// Whether Claude Code's cached server settings at `file` are an empty object.
fn no_remote_settings(file: &Path) -> bool {
    let Ok(stat) = std::fs::symlink_metadata(file) else {
        return false;
    };
    if !stat.is_file() || stat.len() > 65_536 {
        return false;
    }
    let Ok(bytes) = std::fs::read(file) else {
        return false;
    };
    matches!(
        serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)),
        Ok(Value::Object(map)) if map.is_empty()
    )
}

/// One `execFile` call: no shell, a timeout, an output cap, and the abort signal.
#[derive(Debug, Clone)]
pub struct ExecRequest<'a> {
    pub file: &'a str,
    pub args: &'a [String],
    pub cwd: Option<&'a Path>,
    pub env: Option<&'a Env>,
    pub timeout: Duration,
    pub max_buffer: usize,
    pub signal: Option<&'a AtomicBool>,
}

pub type Execute<'a> = dyn Fn(&ExecRequest) -> Result<CommandOutput, CommandError> + 'a;

/// Node's `execFile` with an abort signal: the child is killed (SIGTERM on Unix) when the signal
/// is set or the timeout passes.
pub fn exec_file(request: &ExecRequest) -> Result<CommandOutput, CommandError> {
    let fail = |code, stdout: Vec<u8>, stderr: Vec<u8>| CommandError {
        program: request.file.to_owned(),
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    };
    let aborted = || request.signal.is_some_and(|s| s.load(Ordering::SeqCst));
    if aborted() {
        return Err(fail(None, Vec::new(), Vec::new()));
    }
    let mut command = Command::new(request.file);
    command
        .args(request.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = request.env {
        command.env_clear().envs(env);
    }
    if let Some(cwd) = request.cwd {
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
    let max_buffer = request.max_buffer;
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
    let deadline = Instant::now() + request.timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline && !aborted() => {
                std::thread::sleep(Duration::from_millis(5))
            }
            _ => {
                terminate(&mut child);
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

/// Ends only the child Relay started (its own handle), never another process ID.
fn terminate(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: the pid is our own unreaped child, so it cannot name another process.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let _ = child.wait();
}

/// `fs.mkdtemp(path.join(os.tmpdir(), "relay-quota-starter-"))`: a new private folder.
fn make_temp_dir() -> std::io::Result<PathBuf> {
    loop {
        let suffix: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_owned();
        let dir = std::env::temp_dir().join(format!("relay-quota-starter-{suffix}"));
        match crate::fs_util::create_private_dir(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            other => return other.map(|()| dir),
        }
    }
}

/// Options of `run_quota_starter`; every field defaults to the real thing, except `guard`,
/// which must be given (a missing guard refuses as a revoked setting).
#[derive(Default)]
pub struct QuotaStarterOptions<'a> {
    pub execute: Option<&'a Execute<'a>>,
    pub policy_paths: Option<Vec<PathBuf>>,
    /// Epoch ms.
    pub now: Option<&'a dyn Fn() -> i64>,
    pub guard: Option<&'a dyn Fn() -> bool>,
    pub signal: Option<&'a AtomicBool>,
}

/// Why the starter refused or failed. Never carries a child's output or a credential.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RoutineError {
    #[error("routine-settings-changed")]
    SettingsChanged,
    #[error("routine-policy-unverified")]
    PolicyUnverified,
    #[error("routine-platform-unsupported")]
    PlatformUnsupported,
    #[error("identity-mismatch")]
    IdentityMismatch,
    #[error("routine-cli-unavailable")]
    CliUnavailable,
    #[error("routine-policy-check-failed")]
    PolicyCheckFailed,
    #[error("routine-cli-unsupported")]
    CliUnsupported,
    #[error("routine-credentials-unavailable")]
    CredentialsUnavailable,
    #[error("routine-request-failed")]
    RequestFailed,
    /// The store could not name the account's profile.
    #[error("Account not found.")]
    AccountNotFound,
    /// The profile folder could not be read (the TS rejects with the fs error).
    #[error("{0}")]
    Profile(String),
}

fn platform_unsupported() -> bool {
    // Windows registry and WSL host policy aren't safely checked by this beta.
    // No attempt to circumvent or disable any administrator policy is made.
    !cfg!(any(target_os = "macos", target_os = "linux"))
        || std::env::var_os("WSL_DISTRO_NAME").is_some_and(|v| !v.is_empty())
        || std::env::var_os("WSL_INTEROP").is_some_and(|v| !v.is_empty())
}

/// Starts the account's usage window with one isolated `claude --print` turn.
pub fn run_quota_starter(
    store: &Store,
    account: &Account,
    credentials: &dyn Fn(&Path, bool) -> Result<UsageCredential, UsageError>,
    options: &QuotaStarterOptions,
) -> Result<(), RoutineError> {
    let aborted = || options.signal.is_some_and(|s| s.load(Ordering::SeqCst));
    let guarded = || !aborted() && options.guard.is_some_and(|guard| guard());
    if !guarded() {
        return Err(RoutineError::SettingsChanged);
    }
    if !window_start_eligible(account) {
        return Err(RoutineError::PolicyUnverified);
    }
    if platform_unsupported() {
        return Err(RoutineError::PlatformUnsupported);
    }
    let profile = store
        .profile(&account.id)
        .map_err(|_| RoutineError::AccountNotFound)?;
    let profile_stat =
        std::fs::symlink_metadata(&profile).map_err(|e| RoutineError::Profile(e.to_string()))?;
    if !profile_stat.is_dir() || profile_stat.file_type().is_symlink() {
        return Err(RoutineError::IdentityMismatch);
    }
    let auth = account.auth.as_ref();
    match read_profile_identity(&profile) {
        Some(identity)
            if Some(&identity.account_uuid) == auth.and_then(|a| a.account_uuid.as_ref())
                && Some(&identity.org_id) == auth.and_then(|a| a.org_id.as_ref()) => {}
        _ => return Err(RoutineError::IdentityMismatch),
    }
    let remote_settings = profile.join("remote-settings.json");
    let policy_paths = options
        .policy_paths
        .clone()
        .unwrap_or_else(|| routine_policy_paths(&profile, Platform::current(), &home_dir()));
    for file in &policy_paths {
        match std::fs::symlink_metadata(file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(RoutineError::PolicyUnverified),
            Ok(_) => {}
        }
        // Claude Code caches its organization's server settings here on every run, as {} for an
        // organization that has none: that is no policy.
        if *file == remote_settings && no_remote_settings(file) {
            continue;
        }
        return Err(RoutineError::PolicyUnverified);
    }
    let executable = store
        .with_state(|s| crate::environment::resolve_executable(s.executable.as_deref()))
        .ok_or(RoutineError::CliUnavailable)?;
    let invoke = |request: &ExecRequest| match options.execute {
        Some(execute) => execute(request),
        None => exec_file(request),
    };
    if cfg!(target_os = "macos") {
        let args = ["read".to_owned(), "com.anthropic.claudecode".to_owned()];
        let answer = invoke(&ExecRequest {
            file: "/usr/bin/defaults",
            args: &args,
            cwd: None,
            env: None,
            timeout: Duration::from_millis(10_000),
            max_buffer: 262_144,
            signal: options.signal,
        });
        match answer {
            Ok(_) => return Err(RoutineError::PolicyUnverified),
            // `defaults` says the domain is missing with exit 1. Any other end (a timeout on a
            // busy Mac, a signal) neither shows a policy nor rules one out: the keeper tries
            // again later.
            Err(failure) if failure.code != Some(1) => {
                return Err(RoutineError::PolicyCheckFailed);
            }
            Err(failure) if !failure.stderr.to_lowercase().contains("does not exist") => {
                return Err(RoutineError::PolicyUnverified);
            }
            Err(_) => {}
        }
    }
    let cwd = make_temp_dir().map_err(|_| RoutineError::RequestFailed)?;
    let result = (|| -> Result<(), RoutineError> {
        let profile_text = profile.to_string_lossy();
        let source = process_env();
        // Help is a local capability check, never a model request. Unknown flags
        // fail before sending a prompt and never trigger a less isolated fallback.
        let help_args = ["--help".to_owned()];
        let help_env = profile_environment(&profile_text, &source);
        let help = invoke(&ExecRequest {
            file: &executable,
            args: &help_args,
            cwd: Some(&cwd),
            env: Some(&help_env),
            timeout: Duration::from_millis(15_000),
            max_buffer: 262_144,
            signal: options.signal,
        })
        .map_err(|_| RoutineError::RequestFailed)?
        .stdout;
        if ![
            "--safe-mode",
            "--tools",
            "--strict-mcp-config",
            "--setting-sources",
            "--no-session-persistence",
            "--permission-prompts",
        ]
        .iter()
        .all(|flag| help.contains(flag))
        {
            return Err(RoutineError::CliUnsupported);
        }
        if !guarded() {
            return Err(RoutineError::SettingsChanged);
        }
        let credential = credentials(&profile, false).map_err(|_| RoutineError::RequestFailed)?;
        let now = options.now.map_or_else(now_ms, |now| now()) as f64;
        if !credential.scopes.iter().any(|s| s == "user:inference")
            || credential
                .expires_at
                .is_none_or(|at| at == 0.0 || at <= now)
        {
            return Err(RoutineError::CredentialsUnavailable);
        }
        if !guarded() {
            return Err(RoutineError::SettingsChanged);
        }
        let args = quota_starter_args();
        let env = routine_environment(&profile_text, &credential.access_token, &source);
        let stdout = invoke(&ExecRequest {
            file: &executable,
            args: &args,
            cwd: Some(&cwd),
            env: Some(&env),
            timeout: Duration::from_millis(90_000),
            max_buffer: 262_144,
            signal: options.signal,
        })
        .map_err(|_| RoutineError::RequestFailed)?
        .stdout;
        let result: Value =
            serde_json::from_str(&stdout).map_err(|_| RoutineError::RequestFailed)?;
        let ok = result.is_object()
            && !result
                .get("is_error")
                .is_some_and(crate::desktop_files::js_truthy)
            && result.get("subtype").and_then(Value::as_str) == Some("success")
            && result
                .get("result")
                .and_then(Value::as_str)
                .is_some_and(|r| crate::shared::types::js::trim(r) == "OK");
        if !ok {
            return Err(RoutineError::RequestFailed);
        }
        Ok(())
    })();
    // Never propagate execFile errors: they can include command/env/outputs.
    let _ = std::fs::remove_dir_all(&cwd);
    result
}
