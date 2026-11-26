//! Port of `electron/core/linux-safe-storage.ts`: Claude's cookie key on Linux.
//!
//! Electron gives Chromium's FreedesktopSecretKeyProvider the app's name, so the secret is
//! "Claude Safe Storage" in KWallet's "Claude Keys" folder, or the Secret Service item whose
//! `application` is "Claude". Cookies written with it start with `v11`; with no keyring they
//! start with `v10` and use Chromium's fixed "peanuts". Both keys are PBKDF2-SHA1 with one
//! iteration, unlike macOS's 1003.

use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::desktop_usage::SafeStoragePassword;
use crate::shared::types::UsageIssue;
use crate::usage_credentials::UsageError;
use crate::vault_key::{ToolRun, run_tool};

pub const LINUX_APP_NAME: &str = "Claude";
/// Chromium's libsecret schema for the Safe Storage secret.
const SECRET_SCHEMA: &str = "chrome_libsecret_os_crypt_password_v2";
/// The id Relay gives KWallet; its access dialog names it.
const KWALLET_APP_ID: &str = "Relay";

/// Chromium's Linux cookie key: PBKDF2-SHA1, one iteration, of the keyring secret.
pub fn linux_cookie_key(secret: &str) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(secret.as_bytes(), b"saltysalt", 1, &mut key);
    key
}

/// The `v10` key: no keyring, Chromium's fixed password.
pub static LINUX_V10_KEY: LazyLock<[u8; 16]> = LazyLock::new(|| linux_cookie_key("peanuts"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxKeyring {
    Kwallet {
        service: String,
        object_path: String,
    },
    SecretService,
}

/// An environment as `process.env`: name to value.
pub type Env = HashMap<String, String>;

/// This process's environment.
pub fn process_env() -> Env {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// The keyring Chromium picks without `--password-store`, as `base::nix::GetDesktopEnvironment`
/// decides: KDE's own kwalletd by its session version, the Secret Service everywhere else.
pub fn linux_keyring(env: &Env) -> LinuxKeyring {
    let current = env.get("XDG_CURRENT_DESKTOP");
    let desktops: Vec<String> = current
        .map_or("", String::as_str)
        .split(':')
        .map(|d| d.trim().to_uppercase())
        .collect();
    let session = env
        .get("DESKTOP_SESSION")
        .map_or(String::new(), |s| s.to_lowercase());
    let kde = desktops.iter().any(|d| d == "KDE")
        || (current.is_none_or(String::is_empty)
            && (session.starts_with("kde") || session.starts_with("plasma")));
    if !kde {
        return LinuxKeyring::SecretService;
    }
    let daemon = match env.get("KDE_SESSION_VERSION").map(String::as_str) {
        Some("6") => "kwalletd6",
        Some("5") => "kwalletd5",
        _ => "kwalletd",
    };
    LinuxKeyring::Kwallet {
        service: format!("org.kde.{daemon}"),
        object_path: format!("/modules/{daemon}"),
    }
}

const BUSCTL: &str = "/usr/bin/busctl";
/// Where distributions and source installs put secret-tool, tried in this order; never PATH.
const SECRET_TOOLS: [&str; 2] = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"];

/// Whether `file` is executable by this process (`access(X_OK)`).
pub(crate) fn executable(file: &str) -> bool {
    #[cfg(unix)]
    {
        let Ok(c) = std::ffi::CString::new(file) else {
            return false;
        };
        // SAFETY: a valid NUL-terminated path.
        unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        Path::new(file).exists()
    }
}

/// Whether the tool that reads this desktop's keyring is installed.
pub fn linux_keyring_reachable(env: &Env, exists: &dyn Fn(&str) -> bool) -> bool {
    match linux_keyring(env) {
        LinuxKeyring::Kwallet { .. } => exists(BUSCTL),
        LinuxKeyring::SecretService => SECRET_TOOLS.iter().any(|f| exists(f)),
    }
}

/// Exit status or spawn error code of a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunCode {
    Exit(i32),
    Error(String),
}

impl fmt::Display for RunCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunCode::Exit(code) => write!(f, "{code}"),
            RunCode::Error(code) => f.write_str(code),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunResult {
    /// None on success.
    pub code: Option<RunCode>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `file args` bounded by a timeout in ms.
pub type Run = Arc<dyn Fn(&str, &[String], u64) -> RunResult + Send + Sync>;

/// `execFile` with a SIGKILL timeout and a 16 KiB output cap.
pub fn default_run() -> Run {
    Arc::new(|file: &str, args: &[String], timeout_ms: u64| {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        match run_tool(
            Path::new(file),
            &args,
            None,
            Duration::from_millis(timeout_ms),
            16_384,
        ) {
            ToolRun::Exited {
                code,
                stdout,
                stderr,
            } => RunResult {
                code: (code != 0).then_some(RunCode::Exit(code)),
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            },
            ToolRun::SpawnFailed(_) => RunResult {
                code: Some(RunCode::Error(
                    if Path::new(file).exists() {
                        "EACCES"
                    } else {
                        "ENOENT"
                    }
                    .into(),
                )),
                ..RunResult::default()
            },
            ToolRun::Failed => RunResult {
                code: Some(RunCode::Error("failed".into())),
                ..RunResult::default()
            },
        }
    })
}

fn code_text(code: &Option<RunCode>) -> String {
    code.as_ref().map_or("undefined".into(), RunCode::to_string)
}

const WALLET_CLOSED: &str = "desktop: kwallet closed";

fn locked(detail: &str) -> UsageError {
    UsageError::with_detail(UsageIssue::KeychainLocked, format!("desktop: {detail}"))
}

fn missing() -> UsageError {
    UsageError::with_detail(
        UsageIssue::CredentialsMissing,
        "desktop: no Claude Safe Storage secret",
    )
}

/// Options of the Linux Safe Storage reader.
#[derive(Clone)]
pub struct LinuxSafeStorageOptions {
    /// Whether the user allowed a background read before.
    pub allowed: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Keeps whether reads are allowed.
    pub remember: Arc<dyn Fn(bool) + Send + Sync>,
    pub env: Option<Env>,
    pub run: Option<Run>,
}

/// Reads Claude's Safe Storage secret from the desktop's keyring; kept for the run once read.
pub struct LinuxSafeStoragePassword {
    options: LinuxSafeStorageOptions,
    cached: Mutex<Option<String>>,
}

/// Reads Claude's Safe Storage secret from the desktop's keyring. A background read is only
/// tried once the user has allowed it; a closed KWallet is never opened in the background
/// either, since that would show its unlock dialog. Every call is bounded.
pub fn linux_safe_storage_password(options: LinuxSafeStorageOptions) -> LinuxSafeStoragePassword {
    LinuxSafeStoragePassword {
        options,
        cached: Mutex::new(None),
    }
}

impl SafeStoragePassword for LinuxSafeStoragePassword {
    fn get(&self, allow_prompt: bool) -> Result<String, UsageError> {
        if let Some(cached) = self
            .cached
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Ok(cached);
        }
        if !allow_prompt && !(self.options.allowed)() {
            return Err(UsageError::with_detail(
                UsageIssue::KeychainLocked,
                "desktop: keyring not allowed yet",
            ));
        }
        let env = self.options.env.clone().unwrap_or_else(process_env);
        let run = self.options.run.clone().unwrap_or_else(default_run);
        let timeout = if allow_prompt { 120_000 } else { 15_000 };
        let read = match linux_keyring(&env) {
            LinuxKeyring::Kwallet {
                service,
                object_path,
            } => kwallet_secret(&run, &service, &object_path, allow_prompt, timeout),
            LinuxKeyring::SecretService => secret_service_secret(&run, timeout),
        };
        match read {
            Ok(secret) => {
                *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(secret.clone());
                (self.options.remember)(true);
                Ok(secret)
            }
            Err(error) => {
                // A wallet still closed after login says nothing about the user's consent: keep it.
                if error.issue == UsageIssue::KeychainLocked
                    && error.detail.as_deref() != Some(WALLET_CLOSED)
                {
                    (self.options.remember)(false);
                }
                Err(error)
            }
        }
    }
}

/// One KWallet D-Bus call through `busctl`, answered as JSON; its single value.
fn kwallet_call(
    run: &Run,
    service: &str,
    object_path: &str,
    timeout_ms: u64,
    method: &str,
    signature: &str,
    args: &[&str],
) -> Result<Option<Value>, UsageError> {
    let seconds = timeout_ms.div_ceil(1000);
    let mut argv: Vec<String> = vec![
        "--user".into(),
        "--json=short".into(),
        format!("--timeout={seconds}"),
        "call".into(),
        service.into(),
        object_path.into(),
        "org.kde.KWallet".into(),
        method.into(),
    ];
    if !signature.is_empty() {
        argv.push(signature.into());
        argv.extend(args.iter().map(|a| (*a).to_owned()));
    }
    let result = run(BUSCTL, &argv, timeout_ms + 2_000);
    if result.code.is_some() {
        return Err(locked(&format!(
            "kwallet {method} exit {}",
            code_text(&result.code)
        )));
    }
    let answer: Value = serde_json::from_str(&result.stdout)
        .map_err(|_| locked(&format!("kwallet {method} unreadable answer")))?;
    // busctl's JSON: {"type":"s","data":["kdewallet"]}.
    Ok(answer
        .get("data")
        .and_then(Value::as_array)
        .and_then(|d| d.first().cloned()))
}

fn kwallet_secret(
    run: &Run,
    service: &str,
    object_path: &str,
    allow_prompt: bool,
    timeout: u64,
) -> Result<String, UsageError> {
    let quick = 5_000;
    let call = |timeout: u64, method: &str, signature: &str, args: &[&str]| {
        kwallet_call(run, service, object_path, timeout, method, signature, args)
    };
    let wallet = call(quick, "networkWallet", "", &[])?;
    let Some(wallet) = wallet
        .as_ref()
        .and_then(Value::as_str)
        .filter(|w| !w.is_empty())
    else {
        return Err(locked("kwallet has no wallet"));
    };
    if !allow_prompt && call(quick, "isOpen", "s", &[wallet])? != Some(Value::Bool(true)) {
        return Err(UsageError::with_detail(
            UsageIssue::KeychainLocked,
            WALLET_CLOSED,
        ));
    }
    let handle = call(timeout, "open", "sxs", &[wallet, "0", KWALLET_APP_ID])?;
    let Some(handle) = handle
        .as_ref()
        .and_then(Value::as_f64)
        .filter(|h| *h >= 0.0)
    else {
        return Err(locked("kwallet open refused"));
    };
    let handle = crate::shared::types::js::number_string(handle);
    let folder = format!("{LINUX_APP_NAME} Keys");
    let key = format!("{LINUX_APP_NAME} Safe Storage");
    let result = (|| {
        let has = call(
            quick,
            "hasEntry",
            "isss",
            &[&handle, &folder, &key, KWALLET_APP_ID],
        )?;
        if has != Some(Value::Bool(true)) {
            return Err(missing());
        }
        let secret = call(
            quick,
            "readPassword",
            "isss",
            &[&handle, &folder, &key, KWALLET_APP_ID],
        )?;
        match secret.as_ref().and_then(Value::as_str) {
            Some(s) if !s.is_empty() => Ok(s.to_owned()),
            _ => Err(locked("kwallet empty secret")),
        }
    })();
    // Only Relay's own handle; the wallet stays open for everyone else.
    let _ = call(quick, "close", "ibs", &[&handle, "false", KWALLET_APP_ID]);
    result
}

fn secret_service_secret(run: &Run, timeout: u64) -> Result<String, UsageError> {
    for tool in SECRET_TOOLS {
        let args: Vec<String> = [
            "lookup",
            "xdg:schema",
            SECRET_SCHEMA,
            "application",
            LINUX_APP_NAME,
        ]
        .map(String::from)
        .to_vec();
        let result = run(tool, &args, timeout);
        // Not installed there: the next place.
        if result.code == Some(RunCode::Error("ENOENT".into())) {
            continue;
        }
        // No match: exit 1 and nothing said. Anything else is a locked or unreachable keyring.
        if result.code == Some(RunCode::Exit(1))
            && result.stdout.is_empty()
            && result.stderr.trim().is_empty()
        {
            return Err(missing());
        }
        // secret-tool ends the secret with a newline only on a terminal.
        let secret = result
            .stdout
            .strip_suffix('\n')
            .unwrap_or(&result.stdout)
            .to_owned();
        if result.code.is_some() || secret.is_empty() {
            return Err(locked(&format!(
                "secret-tool exit {}",
                code_text(&result.code)
            )));
        }
        return Ok(secret);
    }
    Err(locked("secret-tool not installed"))
}
