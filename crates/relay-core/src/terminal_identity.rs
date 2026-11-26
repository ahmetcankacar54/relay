//! Port of `electron/core/terminal-identity.ts`: keeps the terminal's Claude Code sign-in (the
//! plain `claude`, without CLAUDE_CONFIG_DIR) with the account at a switch.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::cli_refresh_lock::{CliRefreshLockError, with_cli_refresh_lock};
use crate::clock::now_ms;
use crate::desktop_files::{DesktopFileError, JsonObject, read_bytes, safe_file, write_bytes};
use crate::fs_util::iso_timestamp;
use crate::relay_paths::{Platform, home_dir};
use crate::shared::terminal_identity::{
    TerminalCurrent, TerminalCurrentState, TerminalIdentity, TerminalMode, TerminalOutcome,
    TerminalReason, TerminalResult, TerminalSaved, same_identity,
};
use crate::usage::{UsageEndpoint, request_usage_json};
use crate::usage_credentials::{credential_service, decode_secret, js_len};
use crate::vault_key::{DEFAULT_SECURITY_TOOL, ToolRun, run_tool};

/// The Keychain service of Claude Code's sign-in when CLAUDE_CONFIG_DIR is not set.
pub const TERMINAL_SERVICE: &str = "Claude Code-credentials";
/// Exit status of `security find-generic-password` when no item matches.
const ITEM_NOT_FOUND: i32 = 44;

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
pub(crate) fn loose_uuid(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Why a terminal step stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{}", reason_text(*.0))]
pub struct TerminalError(pub TerminalReason);

/// The reason as the TS spells it (`write-failed`).
pub fn reason_text(reason: TerminalReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

impl TerminalError {
    pub fn reason(&self) -> TerminalReason {
        self.0
    }
}

/// The stored credential item: Claude Code's JSON text, which may hold other sign-ins (MCP
/// servers) too.
pub trait TerminalKeychain: Send + Sync {
    /// The item's text; None when there is none. Fails with "locked".
    fn read(&self) -> Result<Option<String>, TerminalError>;
    fn write(&self, text: &str) -> Result<(), TerminalError>;
    fn remove(&self) -> Result<(), TerminalError>;
}

/// Claude Code's global config file (`~/.claude.json`), whose `oauthAccount` names the sign-in.
pub trait TerminalConfig: Send + Sync {
    fn read(&self) -> Result<Option<JsonObject>, TerminalError>;
    /// Sets `oauthAccount` (removes it for None), keeping every other key.
    fn write_account(&self, account: Option<&JsonObject>) -> Result<(), TerminalError>;
}

/// Holds Claude Code's own refresh lock while the action runs; fails with "busy".
pub type TerminalLock = Arc<dyn Fn(&mut dyn FnMut()) -> Result<(), TerminalError> + Send + Sync>;
/// Who an access token belongs to, asked of Anthropic; None when that cannot be told.
pub type TerminalOwner = Arc<dyn Fn(&str) -> Option<TerminalIdentity> + Send + Sync>;

#[derive(Clone)]
pub struct TerminalPorts {
    pub keychain: Arc<dyn TerminalKeychain>,
    pub config: Arc<dyn TerminalConfig>,
    pub lock: TerminalLock,
    pub owner: Option<TerminalOwner>,
}

/// The ports of a scratch sign-in folder: no lock.
#[derive(Clone)]
pub struct SignInPorts {
    pub keychain: Arc<dyn TerminalKeychain>,
    pub config: Arc<dyn TerminalConfig>,
    pub owner: Option<TerminalOwner>,
}

impl From<&TerminalPorts> for SignInPorts {
    fn from(ports: &TerminalPorts) -> SignInPorts {
        SignInPorts {
            keychain: ports.keychain.clone(),
            config: ports.config.clone(),
            owner: ports.owner.clone(),
        }
    }
}

// --- macOS -----------------------------------------------------------------------------------

/// The longest command line interactive `security -i` takes whole: it reads one command per
/// line into a 4 KB buffer and silently cuts a longer one. Claude Code writes through stdin up
/// to this length and through the arguments above it; Relay does the same.
pub const SECURITY_STDIN_LIMIT: usize = 4032;

/// This process's user name (`os.userInfo().username`); None when it has none.
pub fn current_user_name() -> Option<String> {
    #[cfg(unix)]
    {
        // SAFETY: getpwuid_r writes into the buffers given; the name is copied out before return.
        unsafe {
            let mut pwd: libc::passwd = std::mem::zeroed();
            let mut buf = vec![0 as libc::c_char; 4096];
            let mut result: *mut libc::passwd = std::ptr::null_mut();
            let code = libc::getpwuid_r(
                libc::geteuid(),
                &mut pwd,
                buf.as_mut_ptr(),
                buf.len(),
                &mut result,
            );
            if code != 0 || result.is_null() || pwd.pw_name.is_null() {
                return None;
            }
            Some(
                std::ffi::CStr::from_ptr(pwd.pw_name)
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }
    #[cfg(not(unix))]
    {
        std::env::var("USERNAME").ok()
    }
}

/// The Keychain item, read and written through `security` exactly as Claude Code does (its
/// trusted application, so no dialog).
#[derive(Debug, Clone)]
pub struct SecurityKeychain {
    user: String,
    tool: PathBuf,
    service: String,
    unsupported: bool,
}

/// The Keychain item `service` of `user` through `tool`. Defaults: this user,
/// `/usr/bin/security`, `TERMINAL_SERVICE`.
pub fn security_keychain(
    user: Option<&str>,
    tool: Option<&Path>,
    service: Option<&str>,
) -> SecurityKeychain {
    let user = match user {
        Some(user) => user.to_owned(),
        None => current_user_name().unwrap_or_default(),
    };
    // Checked at use, so a name it cannot quote only stops the terminal step.
    let unsupported = user.is_empty() || user.contains(['"', '\\', '\n', '\r']);
    SecurityKeychain {
        user,
        tool: tool.map_or_else(|| PathBuf::from(DEFAULT_SECURITY_TOOL), Path::to_path_buf),
        service: service.unwrap_or(TERMINAL_SERVICE).to_owned(),
        unsupported,
    }
}

/// How a `security` run ended: None for success, Some(exit) otherwise (-1: not started or killed).
fn run_security(
    keychain: &SecurityKeychain,
    args: &[&str],
) -> Result<(Option<i32>, String), TerminalError> {
    if keychain.unsupported {
        return Err(TerminalError(TerminalReason::Unsupported));
    }
    Ok(
        match run_tool(
            &keychain.tool,
            args,
            None,
            Duration::from_secs(15),
            1024 * 1024,
        ) {
            ToolRun::Exited {
                code: 0, stdout, ..
            } => (None, String::from_utf8_lossy(&stdout).into_owned()),
            ToolRun::Exited { code, stdout, .. } => {
                (Some(code), String::from_utf8_lossy(&stdout).into_owned())
            }
            ToolRun::SpawnFailed(_) | ToolRun::Failed => (Some(-1), String::new()),
        },
    )
}

impl TerminalKeychain for SecurityKeychain {
    fn read(&self) -> Result<Option<String>, TerminalError> {
        let (code, stdout) = run_security(
            self,
            &[
                "find-generic-password",
                "-a",
                &self.user,
                "-s",
                &self.service,
                "-w",
            ],
        )?;
        match code {
            Some(ITEM_NOT_FOUND) => Ok(None),
            Some(_) => Err(TerminalError(TerminalReason::Locked)),
            None => Ok(Some(decode_secret(&stdout))),
        }
    }

    fn write(&self, text: &str) -> Result<(), TerminalError> {
        if self.unsupported {
            return Err(TerminalError(TerminalReason::Unsupported));
        }
        let hex: String = text.bytes().map(|b| format!("{b:02x}")).collect();
        let line = format!(
            "add-generic-password -U -a \"{}\" -s \"{}\" -X \"{hex}\"\n",
            self.user, self.service
        );
        if js_len(&line) > SECURITY_STDIN_LIMIT {
            // Too long for one interactive line: the arguments, briefly visible to this user's
            // processes.
            let (code, _) = run_security(
                self,
                &[
                    "add-generic-password",
                    "-U",
                    "-a",
                    &self.user,
                    "-s",
                    &self.service,
                    "-X",
                    &hex,
                ],
            )?;
            return match code {
                None => Ok(()),
                Some(_) => Err(TerminalError(TerminalReason::WriteFailed)),
            };
        }
        // Interactive `security` exits 0 whatever happens: the caller reads the item back.
        let input = format!("{line}quit\n");
        match run_tool(
            &self.tool,
            &["-i"],
            Some(input.as_bytes()),
            Duration::from_secs(15),
            0,
        ) {
            // The TS rejects with the spawn error.
            ToolRun::SpawnFailed(_) => Err(TerminalError(TerminalReason::WriteFailed)),
            _ => Ok(()),
        }
    }

    fn remove(&self) -> Result<(), TerminalError> {
        let (code, _) = run_security(
            self,
            &[
                "delete-generic-password",
                "-a",
                &self.user,
                "-s",
                &self.service,
            ],
        )?;
        match code {
            None | Some(ITEM_NOT_FOUND) => Ok(()),
            Some(_) => Err(TerminalError(TerminalReason::WriteFailed)),
        }
    }
}

/// Claude Code's global config: `<config dir>/.config.json` when that legacy file exists, as
/// Claude Code reads it, otherwise `~/.claude.json`.
pub fn claude_config_file(home: &Path, config_dir: Option<&Path>) -> PathBuf {
    let config_dir = config_dir.map_or_else(|| home.join(".claude"), Path::to_path_buf);
    let legacy = config_dir.join(".config.json");
    if legacy.exists() {
        legacy
    } else {
        home.join(".claude.json")
    }
}

/// A JSON config file read and written whole.
#[derive(Debug, Clone)]
pub struct JsonConfig {
    file: PathBuf,
}

pub fn json_config(file: impl Into<PathBuf>) -> JsonConfig {
    JsonConfig { file: file.into() }
}

#[cfg(unix)]
fn file_mode(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o777
}
#[cfg(not(unix))]
fn file_mode(_meta: &fs::Metadata) -> u32 {
    0o666
}

/// Creates `file` new (`wx`) with `mode` (minus the umask).
fn create_new_with_mode(file: &Path, mode: u32) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(file)
}

impl JsonConfig {
    fn parse(text: &str) -> Result<JsonObject, TerminalError> {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(obj)) => Ok(obj),
            _ => Err(TerminalError(TerminalReason::Unreadable)),
        }
    }

    fn read_text(&self) -> Result<Option<(String, u32)>, TerminalError> {
        let unreadable = TerminalError(TerminalReason::Unreadable);
        let meta = match fs::symlink_metadata(&self.file) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unreadable),
        };
        if !meta.is_file() || meta.len() > 16 * 1024 * 1024 {
            return Err(unreadable);
        }
        match fs::read(&self.file) {
            Ok(bytes) => Ok(Some((
                String::from_utf8_lossy(&bytes).into_owned(),
                file_mode(&meta),
            ))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(unreadable),
        }
    }
}

impl TerminalConfig for JsonConfig {
    fn read(&self) -> Result<Option<JsonObject>, TerminalError> {
        self.read_text()?
            .map(|(text, _)| Self::parse(&text))
            .transpose()
    }

    fn write_account(&self, account: Option<&JsonObject>) -> Result<(), TerminalError> {
        // Claude Code rewrites this file often; a write that raced one is made again on the new text.
        for _ in 0..3 {
            let found = self.read_text()?;
            let mut config = match &found {
                Some((text, _)) => Self::parse(text)?,
                None => Map::new(),
            };
            match account {
                None => {
                    config.shift_remove("oauthAccount");
                }
                Some(account) => {
                    config.insert("oauthAccount".into(), Value::Object(account.clone()));
                }
            }
            let mut tmp = self.file.as_os_str().to_owned();
            tmp.push(format!(".relay-{}", uuid::Uuid::new_v4()));
            let tmp = PathBuf::from(tmp);
            let result = (|| -> Result<bool, TerminalError> {
                let failed = |_| TerminalError(TerminalReason::WriteFailed);
                let mut handle = create_new_with_mode(&tmp, found.as_ref().map_or(0o600, |f| f.1))
                    .map_err(failed)?;
                handle
                    .write_all(&crate::desktop_files::json_bytes(&config))
                    .map_err(failed)?;
                drop(handle);
                let again = self.read_text()?;
                if again.map(|f| f.0) != found.as_ref().map(|f| f.0.clone()) {
                    return Ok(false);
                }
                fs::rename(&tmp, &self.file).map_err(failed)?;
                Ok(true)
            })();
            let _ = fs::remove_file(&tmp);
            if result? {
                return Ok(());
            }
        }
        Err(TerminalError(TerminalReason::Busy))
    }
}

/// The account and organization the OAuth profile endpoint names for `access_token`.
pub fn profile_owner(access_token: &str) -> Option<TerminalIdentity> {
    owner_of(&request_usage_json(UsageEndpoint::Profile, access_token).ok()?)
}

/// The identity a profile answer names, when both ids are uuids.
pub fn owner_of(value: &Value) -> Option<TerminalIdentity> {
    let pick = |outer: &str, a: &str, b: &str| {
        let o = value.get(outer)?;
        match o.get(a) {
            Some(Value::Null) | None => o.get(b),
            found => found,
        }
        .and_then(Value::as_str)
        .map(str::to_owned)
    };
    let account_uuid = pick("account", "uuid", "account_uuid")?;
    let org_id = pick("organization", "uuid", "organization_uuid")?;
    (loose_uuid(&account_uuid) && loose_uuid(&org_id)).then(|| TerminalIdentity {
        account_uuid: account_uuid.to_lowercase(),
        org_id: org_id.to_lowercase(),
    })
}

/// Claude Code's own refresh lock on `config_dir`, as the ports' `lock`.
pub fn cli_lock(config_dir: PathBuf) -> TerminalLock {
    Arc::new(move |action: &mut dyn FnMut()| {
        match with_cli_refresh_lock(&config_dir, 10_000, action) {
            Ok(()) => Ok(()),
            Err(CliRefreshLockError::Busy(_)) => Err(TerminalError(TerminalReason::Busy)),
            // Any other failure: the TS rethrows it, which the steps report as unreadable.
            Err(CliRefreshLockError::Io(_)) => Err(TerminalError(TerminalReason::Unreadable)),
        }
    })
}

fn default_owner() -> TerminalOwner {
    Arc::new(profile_owner)
}

/// The ports for the plain `claude` of this Mac user; None elsewhere.
pub fn mac_terminal_ports(home: Option<&Path>, platform: Platform) -> Option<TerminalPorts> {
    if platform != Platform::MacOs {
        return None;
    }
    let home = home.map_or_else(home_dir, Path::to_path_buf);
    let config_dir = home.join(".claude");
    Some(TerminalPorts {
        keychain: Arc::new(security_keychain(
            Some(&current_user_name().unwrap_or_default()),
            None,
            None,
        )),
        config: Arc::new(json_config(claude_config_file(&home, Some(&config_dir)))),
        lock: cli_lock(config_dir),
        owner: Some(default_owner()),
    })
}

// --- Linux -----------------------------------------------------------------------------------

/// A credentials file is a few kilobytes; anything far larger is not one.
const MAX_CREDENTIALS: u64 = 1024 * 1024;

/// Claude Code's sign-in where it has no Keychain: the private JSON file
/// `<config dir>/.credentials.json`, written whole through a 0600 temporary file and renamed.
#[derive(Debug, Clone)]
pub struct CredentialsFile {
    file: PathBuf,
}

pub fn credentials_file(file: impl Into<PathBuf>) -> CredentialsFile {
    CredentialsFile { file: file.into() }
}

impl TerminalKeychain for CredentialsFile {
    fn read(&self) -> Result<Option<String>, TerminalError> {
        let unreadable = TerminalError(TerminalReason::Unreadable);
        let meta = match fs::symlink_metadata(&self.file) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unreadable),
        };
        if !meta.is_file() || meta.len() > MAX_CREDENTIALS {
            return Err(unreadable);
        }
        match fs::read(&self.file) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(unreadable),
        }
    }

    fn write(&self, text: &str) -> Result<(), TerminalError> {
        let dir = crate::fs_util::dirname(&self.file).to_path_buf();
        let tmp = dir.join(format!(".credentials.json.relay-{}", uuid::Uuid::new_v4()));
        let result = (|| -> io::Result<bool> {
            match fs::symlink_metadata(&self.file) {
                Ok(meta) if !meta.is_file() => return Ok(false),
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            crate::fs_util::create_private_dir_all(&dir)?;
            let mut handle = crate::fs_util::create_new_private(&tmp)?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
            drop(handle);
            fs::rename(&tmp, &self.file)?;
            Ok(true)
        })();
        let _ = fs::remove_file(&tmp);
        match result {
            Ok(true) => Ok(()),
            _ => Err(TerminalError(TerminalReason::WriteFailed)),
        }
    }

    fn remove(&self) -> Result<(), TerminalError> {
        match fs::symlink_metadata(&self.file) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Ok(meta) if meta.is_file() => match fs::remove_file(&self.file) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => {
                    Err(TerminalError(TerminalReason::WriteFailed))
                }
                _ => Ok(()),
            },
            _ => Err(TerminalError(TerminalReason::WriteFailed)),
        }
    }
}

/// The ports for the plain `claude` of this Linux user: `~/.claude/.credentials.json`.
pub fn linux_terminal_ports(home: Option<&Path>, platform: Platform) -> Option<TerminalPorts> {
    if platform != Platform::Linux {
        return None;
    }
    let home = home.map_or_else(home_dir, Path::to_path_buf);
    let config_dir = home.join(".claude");
    Some(TerminalPorts {
        keychain: Arc::new(credentials_file(config_dir.join(".credentials.json"))),
        config: Arc::new(json_config(claude_config_file(&home, Some(&config_dir)))),
        lock: cli_lock(config_dir),
        owner: Some(default_owner()),
    })
}

/// A scratch folder's sign-in: the Keychain item named after it (macOS), else its private file.
struct ScratchKeychain {
    item: Option<SecurityKeychain>,
    file: PathBuf,
}

impl TerminalKeychain for ScratchKeychain {
    fn read(&self) -> Result<Option<String>, TerminalError> {
        if let Some(item) = &self.item
            && let Some(stored) = item.read()?
        {
            return Ok(Some(stored));
        }
        let Ok(meta) = fs::symlink_metadata(&self.file) else {
            return Ok(None);
        };
        if !meta.is_file() || meta.len() > 65_536 {
            return Ok(None);
        }
        Ok(fs::read(&self.file)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    fn write(&self, _text: &str) -> Result<(), TerminalError> {
        Err(TerminalError(TerminalReason::Unsupported))
    }

    fn remove(&self) -> Result<(), TerminalError> {
        if let Some(item) = &self.item {
            let _ = item.remove();
        }
        match fs::remove_file(&self.file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                Err(TerminalError(TerminalReason::WriteFailed))
            }
            _ => Ok(()),
        }
    }
}

/// Where a `claude auth login` run with `CLAUDE_CONFIG_DIR=dir` leaves its sign-in: the
/// Keychain item named after the folder (a private file in it when the Keychain refused the
/// write) and the folder's `.claude.json`.
pub fn scratch_sign_in_ports(dir: &Path, platform: Platform) -> SignInPorts {
    let item = (platform == Platform::MacOs).then(|| {
        security_keychain(
            Some(&current_user_name().unwrap_or_default()),
            None,
            Some(&credential_service(dir)),
        )
    });
    SignInPorts {
        keychain: Arc::new(ScratchKeychain {
            item,
            file: dir.join(".credentials.json"),
        }),
        config: Arc::new(json_config(dir.join(".claude.json"))),
        owner: Some(default_owner()),
    }
}

/// What became of a sign-in made for the terminal in a scratch folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalAdoption {
    Saved,
    SignedOut,
    OtherAccount,
}

/// Keeps the sign-in `ports` hold as the terminal sign-in of the account with `expected`
/// identities: it must name one of them, and its token must be that account's when Anthropic
/// can be asked. Saved as taken away (`parked`).
pub fn adopt_terminal_sign_in(
    ports: &SignInPorts,
    expected: &[TerminalIdentity],
    vault: &TerminalVault,
) -> Result<TerminalAdoption, TerminalVaultError> {
    let reading = read_terminal(ports.keychain.as_ref(), ports.config.as_ref())?;
    let (Some(oauth), Some(account)) = (&reading.oauth, &reading.account) else {
        return Ok(TerminalAdoption::SignedOut);
    };
    let Some(identity) = &reading.identity else {
        return Ok(TerminalAdoption::OtherAccount);
    };
    if !expected.iter().any(|x| same_identity(x, identity)) {
        return Ok(TerminalAdoption::OtherAccount);
    }
    let owner = ports
        .owner
        .as_ref()
        .and_then(|owner| owner(&js_text(oauth.get("accessToken"))));
    if owner.is_some_and(|owner| !same_identity(&owner, identity)) {
        return Ok(TerminalAdoption::OtherAccount);
    }
    vault.save(identity, oauth, account, true)?;
    Ok(TerminalAdoption::Saved)
}

// --- The vault -------------------------------------------------------------------------------

/// Inside the vault, one sealed file per account and organization: `terminal/<uuid>.<org>.bin`.
const DIR: &str = "terminal";

/// A saved terminal sign-in.
#[derive(Debug, Clone, PartialEq)]
pub struct Saved {
    pub account_uuid: String,
    pub org_id: String,
    pub saved_at: String,
    /// Taken away from the terminal at a switch, so it is the only copy and still good.
    pub parked: bool,
    /// Claude Code's `claudeAiOauth`.
    pub oauth: JsonObject,
    /// Claude Code's `oauthAccount`.
    pub account: JsonObject,
}

impl Saved {
    pub fn identity(&self) -> TerminalIdentity {
        TerminalIdentity {
            account_uuid: self.account_uuid.clone(),
            org_id: self.org_id.clone(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TerminalVaultError {
    #[error(transparent)]
    Terminal(#[from] TerminalError),
    #[error("Invalid identity.")]
    InvalidIdentity,
    #[error("Invalid saved terminal sign-in.")]
    InvalidSaved,
    /// The sealer's own failure (no key yet, damaged data).
    #[error("{0}")]
    Seal(String),
    #[error(transparent)]
    Files(#[from] DesktopFileError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn vault_file(id: &TerminalIdentity) -> Result<String, TerminalVaultError> {
    if !loose_uuid(&id.account_uuid) || !loose_uuid(&id.org_id) {
        return Err(TerminalVaultError::InvalidIdentity);
    }
    Ok(format!(
        "{DIR}/{}.{}.bin",
        id.account_uuid.to_lowercase(),
        id.org_id.to_lowercase()
    ))
}

pub type SealFn = Arc<dyn Fn(&str) -> Result<Vec<u8>, String> + Send + Sync>;
pub type UnsealFn = Arc<dyn Fn(&[u8]) -> Result<String, String> + Send + Sync>;
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The terminal's sign-ins, sealed like the rest of the vault, each under the identity it names.
#[derive(Clone)]
pub struct TerminalVault {
    vault: PathBuf,
    seal: SealFn,
    unseal: UnsealFn,
    now: NowFn,
}

impl TerminalVault {
    pub fn new(vault: impl Into<PathBuf>, seal: SealFn, unseal: UnsealFn) -> TerminalVault {
        Self::with_clock(vault, seal, unseal, Arc::new(now_ms))
    }

    pub fn with_clock(
        vault: impl Into<PathBuf>,
        seal: SealFn,
        unseal: UnsealFn,
        now: NowFn,
    ) -> TerminalVault {
        TerminalVault {
            vault: vault.into(),
            seal,
            unseal,
            now,
        }
    }

    pub fn save(
        &self,
        id: &TerminalIdentity,
        oauth: &JsonObject,
        account: &JsonObject,
        parked: bool,
    ) -> Result<(), TerminalVaultError> {
        let mut saved = Map::new();
        saved.insert("accountUuid".into(), id.account_uuid.to_lowercase().into());
        saved.insert("orgId".into(), id.org_id.to_lowercase().into());
        saved.insert("savedAt".into(), iso_timestamp((self.now)()).into());
        saved.insert("parked".into(), parked.into());
        saved.insert("oauth".into(), Value::Object(oauth.clone()));
        saved.insert("account".into(), Value::Object(account.clone()));
        let file = vault_file(id)?;
        let text = serde_json::to_string(&saved)?;
        let sealed = (self.seal)(&text).map_err(TerminalVaultError::Seal)?;
        write_bytes(&self.vault, &file, Some(&sealed))?;
        Ok(())
    }

    /// The sign-in saved for the first of `ids` that has one. Fails for a damaged file.
    pub fn load(&self, ids: &[TerminalIdentity]) -> Result<Option<Saved>, TerminalVaultError> {
        for id in ids {
            let Some(data) = read_bytes(&self.vault, &vault_file(id)?)? else {
                continue;
            };
            let text = (self.unseal)(&data).map_err(TerminalVaultError::Seal)?;
            let value: Value = serde_json::from_str(&text)?;
            let invalid = || TerminalVaultError::InvalidSaved;
            let obj = value.as_object().ok_or_else(invalid)?;
            let text_of = |key: &str| obj.get(key).and_then(Value::as_str).map(str::to_owned);
            let (Some(account_uuid), Some(org_id)) = (text_of("accountUuid"), text_of("orgId"))
            else {
                return Err(invalid());
            };
            let saved_id = TerminalIdentity {
                account_uuid: account_uuid.clone(),
                org_id: org_id.clone(),
            };
            let oauth = obj.get("oauth").and_then(Value::as_object);
            let account = obj.get("account").and_then(Value::as_object);
            if !same_identity(&saved_id, id) || !oauth.is_some_and(valid_oauth) {
                return Err(invalid());
            }
            let (Some(oauth), Some(account)) = (oauth, account) else {
                return Err(invalid());
            };
            return Ok(Some(Saved {
                account_uuid,
                org_id,
                saved_at: text_of("savedAt").unwrap_or_default(),
                parked: obj.get("parked") == Some(&Value::Bool(true)),
                oauth: oauth.clone(),
                account: account.clone(),
            }));
        }
        Ok(None)
    }

    pub fn remove(&self, id: &TerminalIdentity) -> Result<(), TerminalVaultError> {
        write_bytes(&self.vault, &vault_file(id)?, None)?;
        Ok(())
    }

    /// Which identities have a sign-in saved, when, and whether it was taken away at a switch.
    pub fn list(&self) -> Vec<TerminalSaved> {
        let Ok(dir) = safe_file(&self.vault, DIR) else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .collect();
        // libuv's scandir sorts the names.
        names.sort();
        let mut out = Vec::new();
        for name in names {
            let Some(stem) = name.strip_suffix(".bin") else {
                continue;
            };
            let Some((a, o)) = stem.split_once('.') else {
                continue;
            };
            let shape = |s: &str| {
                s.len() == 36
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
            };
            if !shape(a) || !shape(o) || !loose_uuid(a) || !loose_uuid(o) {
                continue;
            }
            let id = TerminalIdentity {
                account_uuid: a.to_owned(),
                org_id: o.to_owned(),
            };
            // Damaged or gone since the listing: not offered.
            if let Ok(Some(saved)) = self.load(std::slice::from_ref(&id)) {
                out.push(TerminalSaved {
                    account_uuid: id.account_uuid,
                    org_id: id.org_id,
                    saved_at: saved.saved_at,
                    parked: saved.parked,
                });
            }
        }
        out
    }
}

// --- The step --------------------------------------------------------------------------------

fn valid_oauth(oauth: &JsonObject) -> bool {
    let nonempty = |key: &str| {
        oauth
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    };
    nonempty("accessToken") && nonempty("refreshToken")
}

/// A JSON value as a template literal writes it (`${value}`).
fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => {
            crate::shared::types::js::number_string(n.as_f64().unwrap_or(f64::NAN))
        }
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                v => js_text(Some(v)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

/// Tells two credentials apart without keeping either in the clear.
fn fingerprint(oauth: Option<&JsonObject>) -> String {
    let Some(oauth) = oauth else {
        return String::new();
    };
    let text = format!(
        "{}\0{}",
        js_text(oauth.get("accessToken")),
        js_text(oauth.get("refreshToken"))
    );
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// An access token this close to its expiry is not asked about: it may lapse on the way.
const VERIFY_MARGIN_MS: f64 = 60_000.0;

struct Reading {
    /// The item's text as stored, for putting it back; None when there is none.
    raw: Option<String>,
    item: JsonObject,
    oauth: Option<JsonObject>,
    account: Option<JsonObject>,
    identity: Option<TerminalIdentity>,
}

fn read_terminal(
    keychain: &dyn TerminalKeychain,
    config: &dyn TerminalConfig,
) -> Result<Reading, TerminalError> {
    let raw = keychain.read()?;
    let item = match &raw {
        None => Map::new(),
        Some(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(obj)) => obj,
            _ => return Err(TerminalError(TerminalReason::Unreadable)),
        },
    };
    let oauth = item
        .get("claudeAiOauth")
        .and_then(Value::as_object)
        .filter(|o| valid_oauth(o))
        .cloned();
    let config = config.read()?;
    let account = config
        .as_ref()
        .and_then(|c| c.get("oauthAccount"))
        .and_then(Value::as_object)
        .cloned();
    let identity = oauth.as_ref().and(account.as_ref()).and_then(|account| {
        let u = account.get("accountUuid")?.as_str()?;
        let o = account.get("organizationUuid")?.as_str()?;
        (loose_uuid(u) && loose_uuid(o)).then(|| TerminalIdentity {
            account_uuid: u.to_lowercase(),
            org_id: o.to_lowercase(),
        })
    });
    Ok(Reading {
        raw,
        item,
        oauth,
        account,
        identity,
    })
}

fn signed_out(at: String) -> TerminalCurrent {
    TerminalCurrent {
        state: TerminalCurrentState::SignedOut,
        account_uuid: None,
        org_id: None,
        email: None,
        org_name: None,
        known: None,
        mismatch: None,
        at,
    }
}

fn describe_terminal(
    reading: &Reading,
    known: &[TerminalIdentity],
    at: String,
    mismatch: bool,
) -> TerminalCurrent {
    if reading.oauth.is_none() {
        return signed_out(at);
    }
    let text = |key: &str| {
        reading
            .account
            .as_ref()
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    TerminalCurrent {
        state: TerminalCurrentState::SignedIn,
        account_uuid: reading.identity.as_ref().map(|i| i.account_uuid.clone()),
        org_id: reading.identity.as_ref().map(|i| i.org_id.clone()),
        email: text("emailAddress"),
        org_name: text("organizationName"),
        known: Some(
            !mismatch
                && reading
                    .identity
                    .as_ref()
                    .is_some_and(|id| known.iter().any(|x| same_identity(x, id))),
        ),
        mismatch: mismatch.then_some(true),
        at,
    }
}

/// Who the terminal is signed in to, reading only: nothing is saved or written, nothing asked.
pub fn peek_terminal(
    ports: &TerminalPorts,
    known: &[TerminalIdentity],
    now: &dyn Fn() -> i64,
) -> TerminalCurrent {
    match read_terminal(ports.keychain.as_ref(), ports.config.as_ref()) {
        Ok(reading) => describe_terminal(&reading, known, iso_timestamp(now()), false),
        Err(_) => TerminalCurrent {
            state: TerminalCurrentState::Unreadable,
            ..signed_out(iso_timestamp(now()))
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalRequest {
    pub mode: TerminalMode,
    /// The account to put in place: its identities.
    pub target: Vec<TerminalIdentity>,
    /// Every Relay account's identities: the only terminal sign-ins ever saved or replaced.
    pub known: Vec<TerminalIdentity>,
}

/// What `keep` did with a reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kept {
    Saved,
    Same,
    NotKnown,
    Mismatch,
    Unverified,
}

enum Verified {
    Match,
    Mismatch,
    Unknown,
}

fn outcome(
    result: TerminalResult,
    reason: Option<TerminalReason>,
    saved: bool,
    current: Option<TerminalCurrent>,
) -> TerminalOutcome {
    TerminalOutcome {
        result,
        reason,
        saved,
        unconfirmed: None,
        current,
        at: String::new(),
    }
}

/// Keeps the terminal's Claude Code sign-in with the account: at a switch it saves the sign-in
/// the terminal holds, under the account and organization it names, and puts the target's saved
/// one in place. Never fails.
pub struct TerminalSwitcher {
    ports: TerminalPorts,
    vault: TerminalVault,
    now: NowFn,
}

impl TerminalSwitcher {
    pub fn new(ports: TerminalPorts, vault: TerminalVault) -> TerminalSwitcher {
        Self::with_clock(ports, vault, Arc::new(now_ms))
    }

    pub fn with_clock(ports: TerminalPorts, vault: TerminalVault, now: NowFn) -> TerminalSwitcher {
        TerminalSwitcher { ports, vault, now }
    }

    fn at(&self) -> String {
        iso_timestamp((self.now)())
    }

    /// Whether the token really is the account `~/.claude.json` names.
    fn verify(&self, reading: &Reading) -> Verified {
        let (Some(oauth), Some(identity), Some(owner)) =
            (&reading.oauth, &reading.identity, &self.ports.owner)
        else {
            return Verified::Unknown;
        };
        if let Some(expires) = oauth.get("expiresAt").and_then(Value::as_f64)
            && expires <= (self.now)() as f64 + VERIFY_MARGIN_MS
        {
            return Verified::Unknown;
        }
        match owner(&js_text(oauth.get("accessToken"))) {
            None => Verified::Unknown,
            Some(o) if same_identity(&o, identity) => Verified::Match,
            Some(_) => Verified::Mismatch,
        }
    }

    /// Saves the reading for its account when that is one of Relay's, it differs from the saved
    /// copy and its token is verified to be that account's. A switch (`parked`) also keeps a
    /// token that cannot be asked about, unless a copy taken away at an earlier switch is saved.
    fn keep(
        &self,
        reading: &Reading,
        known: &[TerminalIdentity],
        parked: bool,
    ) -> Result<Kept, TerminalVaultError> {
        let (Some(identity), Some(oauth), Some(account)) =
            (&reading.identity, &reading.oauth, &reading.account)
        else {
            return Ok(Kept::NotKnown);
        };
        if !known.iter().any(|x| same_identity(x, identity)) {
            return Ok(Kept::NotKnown);
        }
        let saved = self
            .vault
            .load(std::slice::from_ref(identity))
            .ok()
            .flatten();
        // Only a new credential is worth a new copy, unless a check's copy is now taken away.
        if let Some(saved) = &saved
            && fingerprint(Some(&saved.oauth)) == fingerprint(Some(oauth))
            && (saved.parked || !parked)
        {
            return Ok(Kept::Same);
        }
        match self.verify(reading) {
            Verified::Mismatch => return Ok(Kept::Mismatch),
            Verified::Unknown if !parked => return Ok(Kept::Unverified),
            // A copy taken away at an earlier switch is the only good one.
            Verified::Unknown if saved.as_ref().is_some_and(|s| s.parked) => {
                return Ok(Kept::Unverified);
            }
            _ => {}
        }
        self.vault.save(identity, oauth, account, parked)?;
        Ok(Kept::Saved)
    }

    /// Who the terminal is signed in to, saving that sign-in when it is one of Relay's accounts.
    /// Writes nothing to Claude Code.
    pub fn check(&self, mode: TerminalMode, known: &[TerminalIdentity]) -> Option<TerminalCurrent> {
        if mode == TerminalMode::Off {
            return None;
        }
        let mut result: Option<Result<TerminalCurrent, TerminalError>> = None;
        // Under Claude Code's lock, so a swap or a renewal half done is never read as one sign-in.
        let locked = (self.ports.lock)(&mut || {
            result = Some(
                read_terminal(self.ports.keychain.as_ref(), self.ports.config.as_ref()).map(
                    |reading| {
                        // Not saved when the vault is not ready; who it is was still read.
                        let kept = self.keep(&reading, known, false).unwrap_or(Kept::NotKnown);
                        describe_terminal(&reading, known, self.at(), kept == Kept::Mismatch)
                    },
                ),
            );
        });
        let unreadable = || TerminalCurrent {
            state: TerminalCurrentState::Unreadable,
            ..signed_out(self.at())
        };
        match locked {
            // Busy renewing: say who it is, and save it at the next check.
            Err(TerminalError(TerminalReason::Busy)) => {
                Some(peek_terminal(&self.ports, known, &*self.now))
            }
            Err(_) => Some(unreadable()),
            Ok(()) => Some(match result {
                Some(Ok(current)) => current,
                Some(Err(TerminalError(TerminalReason::Busy))) => {
                    peek_terminal(&self.ports, known, &*self.now)
                }
                _ => unreadable(),
            }),
        }
    }

    pub fn run(&self, request: &TerminalRequest) -> TerminalOutcome {
        let at = self.at();
        if request.mode == TerminalMode::Off {
            return TerminalOutcome {
                at,
                ..outcome(
                    TerminalResult::Skipped,
                    Some(TerminalReason::Off),
                    false,
                    None,
                )
            };
        }
        let mut result: Option<Result<TerminalOutcome, TerminalError>> = None;
        let locked = (self.ports.lock)(&mut || result = Some(self.swap(request)));
        let done = match (locked, result) {
            (Err(e), _) | (Ok(()), Some(Err(e))) => Err(e),
            (Ok(()), Some(Ok(core))) => Ok(core),
            (Ok(()), None) => Err(TerminalError(TerminalReason::Unreadable)),
        };
        match done {
            Ok(core) => TerminalOutcome { at, ..core },
            Err(TerminalError(reason)) => TerminalOutcome {
                at,
                ..outcome(
                    if reason == TerminalReason::Busy {
                        TerminalResult::Skipped
                    } else {
                        TerminalResult::Failed
                    },
                    Some(reason),
                    false,
                    None,
                )
            },
        }
    }

    fn swap(&self, request: &TerminalRequest) -> Result<TerminalOutcome, TerminalError> {
        let vault_error = |e: TerminalVaultError| match e {
            TerminalVaultError::Terminal(e) => e,
            _ => TerminalError(TerminalReason::Unreadable),
        };
        let reading = read_terminal(self.ports.keychain.as_ref(), self.ports.config.as_ref())?;
        let at = self.at();
        let current = describe_terminal(&reading, &request.known, at.clone(), false);
        // A sign-in Relay cannot name would be lost by the swap: it is saved nowhere.
        if reading.oauth.is_some() && current.known != Some(true) {
            return Ok(outcome(
                TerminalResult::Skipped,
                Some(TerminalReason::UnknownAccount),
                false,
                Some(current),
            ));
        }
        if let Some(identity) = &reading.identity
            && request.target.iter().any(|x| same_identity(x, identity))
        {
            let kept = self
                .keep(&reading, &request.known, false)
                .map_err(vault_error)?;
            return Ok(outcome(
                if kept == Kept::Saved {
                    TerminalResult::Saved
                } else {
                    TerminalResult::Unchanged
                },
                Some(if kept == Kept::Mismatch {
                    TerminalReason::Mismatch
                } else {
                    TerminalReason::AlreadyThere
                }),
                kept == Kept::Saved,
                Some(describe_terminal(
                    &reading,
                    &request.known,
                    at,
                    kept == Kept::Mismatch,
                )),
            ));
        }
        let kept = self
            .keep(&reading, &request.known, true)
            .map_err(vault_error)?;
        if kept == Kept::Mismatch {
            return Ok(outcome(
                TerminalResult::Skipped,
                Some(TerminalReason::Mismatch),
                false,
                Some(describe_terminal(&reading, &request.known, at, true)),
            ));
        }
        let saved = kept == Kept::Saved;
        let Some(wanted) = self.vault.load(&request.target).map_err(vault_error)? else {
            return Ok(outcome(
                if saved {
                    TerminalResult::Saved
                } else {
                    TerminalResult::Unchanged
                },
                Some(TerminalReason::NoSavedLogin),
                saved,
                Some(current),
            ));
        };
        // Only the Claude sign-in changes: MCP servers' sign-ins in the same item stay.
        let mut item = reading.item.clone();
        item.insert("claudeAiOauth".into(), Value::Object(wanted.oauth.clone()));
        let text = serde_json::to_string(&item).unwrap_or_default();
        let put = || -> Result<(), TerminalError> {
            self.ports.keychain.write(&text)?;
            let back = self.ports.keychain.read()?;
            let back_oauth = match &back {
                Some(back) => match serde_json::from_str::<Value>(back) {
                    Ok(value) => value.get("claudeAiOauth").cloned(),
                    Err(_) => return Err(TerminalError(TerminalReason::WriteFailed)),
                },
                None => None,
            };
            let back_print = match &back_oauth {
                None => String::new(),
                Some(Value::Object(o)) => fingerprint(Some(o)),
                // A non-object: its fields read undefined.
                Some(_) => fingerprint(Some(&Map::new())),
            };
            if back_print != fingerprint(Some(&wanted.oauth)) {
                return Err(TerminalError(TerminalReason::WriteFailed));
            }
            // Last, and replaced whole by a rename: when it fails the config is as it was.
            self.ports.config.write_account(Some(&wanted.account))
        };
        if put().is_err() {
            let restore = || -> Result<(), TerminalError> {
                match &reading.raw {
                    None => self.ports.keychain.remove()?,
                    Some(raw) => self.ports.keychain.write(raw)?,
                }
                if self.ports.keychain.read()? != reading.raw {
                    return Err(TerminalError(TerminalReason::RestoreFailed));
                }
                Ok(())
            };
            let reason = if restore().is_err() {
                TerminalReason::RestoreFailed
            } else {
                TerminalReason::WriteFailed
            };
            return Ok(outcome(
                TerminalResult::Failed,
                Some(reason),
                saved,
                Some(current),
            ));
        }
        // In use again: Claude Code will renew it, so the vault's copy no longer counts as the
        // only one.
        let _ = self
            .vault
            .save(&wanted.identity(), &wanted.oauth, &wanted.account, false);
        let text_of = |key: &str| {
            wanted
                .account
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        Ok(TerminalOutcome {
            // Saved by a check and never taken away at a switch: Claude Code may have renewed
            // this copy's refresh token away.
            unconfirmed: (!wanted.parked).then_some(true),
            ..outcome(
                TerminalResult::Switched,
                None,
                saved,
                Some(TerminalCurrent {
                    state: TerminalCurrentState::SignedIn,
                    account_uuid: Some(wanted.account_uuid.clone()),
                    org_id: Some(wanted.org_id.clone()),
                    email: text_of("emailAddress"),
                    org_name: text_of("organizationName"),
                    known: Some(true),
                    mismatch: None,
                    at: self.at(),
                }),
            )
        })
    }
}
