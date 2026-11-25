//! Port of `electron/core/vault-key.ts`: the vault key, a random 32 bytes kept as base64 in the
//! macOS Keychain (through `security`) or, on Windows and Linux, in the OS keyring.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::DecodePaddingMode;

pub const VAULT_KEY_SERVICE: &str = "Relay Vault Key";
pub const VAULT_KEY_ACCOUNT: &str = "relay-vault";
/// The tool every platform default reads the Keychain through on macOS.
pub const DEFAULT_SECURITY_TOOL: &str = "/usr/bin/security";
/// Exit status of `security find-generic-password` when no item matches.
const ITEM_NOT_FOUND: i32 = 44;
const TOOL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BUFFER: usize = 4096;

pub type VaultKey = [u8; 32];

/// Why the vault key could not be had: no item, a locked or refusing Keychain, or bad data.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultKeyError {
    #[error("The Keychain item \"Relay Vault Key\" was not found.")]
    Missing,
    #[error(
        "The Keychain item \"Relay Vault Key\" could not be read. Unlock the login keychain and try again."
    )]
    Locked,
    #[error("The Keychain item \"Relay Vault Key\" does not hold a vault key.")]
    Invalid,
    /// `security -i` could not be started to add a key (the TS rejects with the spawn error).
    #[error("{0}")]
    Spawn(String),
}

/// Where the key lives: `security` (macOS, or a stand-in on any Unix) or the OS keyring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultKeyStore {
    Security(PathBuf),
    #[cfg(not(target_os = "macos"))]
    Keyring,
}

impl VaultKeyStore {
    /// `tool` when given (`RELAY_SECURITY_TOOL`, tests), else this platform's store.
    pub fn platform(tool: Option<&Path>) -> Self {
        match tool {
            Some(tool) => Self::Security(tool.to_path_buf()),
            #[cfg(target_os = "macos")]
            None => Self::Security(PathBuf::from(DEFAULT_SECURITY_TOOL)),
            #[cfg(not(target_os = "macos"))]
            None => Self::Keyring,
        }
    }
}

/// Node's lenient base64 for a string that passed the shape check: padding optional.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// A stored value as a key: base64 of exactly 32 bytes, else `Invalid`.
fn parse_key(stored: &str) -> Result<VaultKey, VaultKeyError> {
    let text = stored.trim();
    let shaped = {
        let body = text.trim_end_matches('=');
        !body.is_empty()
            && text.len() - body.len() <= 2
            && body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    };
    if !shaped {
        return Err(VaultKeyError::Invalid);
    }
    LENIENT
        .decode(text)
        .ok()
        .and_then(|bytes| VaultKey::try_from(bytes.as_slice()).ok())
        .ok_or(VaultKeyError::Invalid)
}

fn random_key_text() -> String {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).expect("the OS random source failed");
    STANDARD.encode(key)
}

/// Reads the vault key through `security`, the item's trusted application, so neither Relay
/// nor the CLI is ever prompted after a rebuild or an update.
pub fn read_vault_key(tool: &Path) -> Result<VaultKey, VaultKeyError> {
    let run = run_tool(
        tool,
        &[
            "find-generic-password",
            "-s",
            VAULT_KEY_SERVICE,
            "-a",
            VAULT_KEY_ACCOUNT,
            "-w",
        ],
        None,
        TOOL_TIMEOUT,
        MAX_BUFFER,
    );
    match run {
        ToolRun::Exited {
            code: ITEM_NOT_FOUND,
            ..
        } => Err(VaultKeyError::Missing),
        _ => Err(VaultKeyError::Locked),
    }
}

/// Adds a new random key through `security -i`, so the key travels on stdin and never in a
/// process's arguments. Interactive `security` exits 0 whatever happens, and another process
/// may have added its own key first, so the key used is always the one read back.
pub fn create_vault_key(tool: &Path) -> Result<VaultKey, VaultKeyError> {
    let value = random_key_text();
    let script = format!(
        "add-generic-password -s \"{VAULT_KEY_SERVICE}\" -a {VAULT_KEY_ACCOUNT} -l \"{VAULT_KEY_SERVICE}\" -w {value}\nquit\n"
    );
    if let ToolRun::SpawnFailed(error) =
        run_tool(tool, &["-i"], Some(script.as_bytes()), TOOL_TIMEOUT, 0)
    {
        return Err(VaultKeyError::Spawn(error));
    }
    read_vault_key(tool)
}

/// Reads the key from `store`; a missing one is created only when `may_create` (the vault holds
/// no sealed file).
pub fn load_vault_key_from(
    store: &VaultKeyStore,
    may_create: bool,
) -> Result<VaultKey, VaultKeyError> {
    let read = match store {
        VaultKeyStore::Security(tool) => read_vault_key(tool),
        #[cfg(not(target_os = "macos"))]
        VaultKeyStore::Keyring => keyring_store::read(),
    };
    match read {
        Err(VaultKeyError::Missing) if may_create => match store {
            VaultKeyStore::Security(tool) => create_vault_key(tool),
            #[cfg(not(target_os = "macos"))]
            VaultKeyStore::Keyring => keyring_store::create(),
        },
        other => other,
    }
}

/// `loadVaultKey({tool, mayCreate})`.
#[derive(Debug, Clone, Default)]
pub struct LoadVaultKey<'a> {
    /// The `security` stand-in; `None` is this platform's store.
    pub tool: Option<&'a Path>,
    pub may_create: bool,
}

pub fn load_vault_key(options: &LoadVaultKey<'_>) -> Result<VaultKey, VaultKeyError> {
    load_vault_key_from(&VaultKeyStore::platform(options.tool), options.may_create)
}

/// Windows Credential Manager or the Linux Secret Service: the item has the same service and
/// account names as the Keychain's.
#[cfg(not(target_os = "macos"))]
mod keyring_store {
    use super::{VAULT_KEY_ACCOUNT, VAULT_KEY_SERVICE};

    fn entry() -> Result<keyring::Entry, VaultKeyError> {
        keyring::Entry::new(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT).map_err(|_| VaultKeyError::Locked)
    }

    pub(super) fn read() -> Result<VaultKey, VaultKeyError> {
        match entry()?.get_password() {
            Ok(text) => parse_key(&text),
            Err(keyring::Error::NoEntry) => Err(VaultKeyError::Missing),
            Err(keyring::Error::BadEncoding(_)) => Err(VaultKeyError::Invalid),
            Err(_) => Err(VaultKeyError::Locked),
        }
    }

    /// The keyring has no add-if-absent: like the Keychain path, the key used is the one read
    /// back, so a concurrent writer's key wins for both.
    pub(super) fn create() -> Result<VaultKey, VaultKeyError> {
        entry()?
            .set_password(&random_key_text())
            .map_err(|_| VaultKeyError::Locked)?;
        read()
    }
}

/// How a bounded tool run ended.
#[derive(Debug)]
pub enum ToolRun {
    Exited {
        code: i32,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    /// Not started (missing, not executable): the spawn error's text.
    SpawnFailed(String),
    /// Killed by a signal, killed on timeout, or more output than `max_buffer`.
    Failed,
}

/// Node's `execFile` with `timeout`, `killSignal: "SIGKILL"` and `maxBuffer`. A `max_buffer` of 0
/// discards both outputs (`stdio: "ignore"`).
pub(crate) fn run_tool(
    program: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
    max_buffer: usize,
) -> ToolRun {
    let capture = max_buffer > 0;
    let output = || {
        if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        }
    };
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(output())
        .stderr(output());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return ToolRun::SpawnFailed(error.to_string()),
    };
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            if let Some(mut pipe) = pipe {
                // Keep one byte past the cap to tell "too much" apart; drain the rest.
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
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // A tool that exits without reading closes the pipe; that is its answer, not ours.
        let _ = pipe.write_all(text);
    }
    let status = wait_bounded(&mut child, timeout);
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    let Some(status) = status else {
        return ToolRun::Failed;
    };
    if stdout.len() > max_buffer && capture || stderr.len() > max_buffer && capture {
        return ToolRun::Failed;
    }
    match status.code() {
        Some(code) => ToolRun::Exited {
            code,
            stdout,
            stderr,
        },
        None => ToolRun::Failed,
    }
}

/// The child's status, or `None` once it was killed for outliving `timeout`.
fn wait_bounded(child: &mut std::process::Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    let mut pause = Duration::from_millis(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
