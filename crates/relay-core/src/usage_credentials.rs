//! Port of `electron/core/usage-credentials.ts`: the official CLI's sign-in for one isolated
//! profile, read from the login Keychain (macOS) or the profile's `.credentials.json`.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::fs_util::resolve;
use crate::relay_paths::Platform;
use crate::shared::types::UsageIssue;
use crate::vault_key::{DEFAULT_SECURITY_TOOL, ToolRun, run_tool};

/// A usage read that failed for a reason the account reports.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{}", .issue.as_str())]
pub struct UsageError {
    pub issue: UsageIssue,
    /// Epoch ms when a read may be tried again.
    pub retry_at: Option<f64>,
    /// Where and why, for the private diagnosis log: a step, an HTTP status, an error type
    /// ("usage 403 permission_error", "refresh: no network"). Never a credential.
    pub detail: Option<String>,
}

impl UsageError {
    pub fn new(issue: UsageIssue) -> UsageError {
        UsageError {
            issue,
            retry_at: None,
            detail: None,
        }
    }

    pub fn with_detail(issue: UsageIssue, detail: impl Into<String>) -> UsageError {
        UsageError {
            issue,
            retry_at: None,
            detail: Some(detail.into()),
        }
    }

    pub fn with_retry(issue: UsageIssue, retry_at: Option<f64>, detail: Option<String>) -> Self {
        UsageError {
            issue,
            retry_at,
            detail,
        }
    }
}

/// An official CLI sign-in. Main-process only: never exposed through snapshots or IPC.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageCredential {
    pub access_token: String,
    /// Epoch ms.
    pub expires_at: Option<f64>,
    pub scopes: Vec<String>,
    pub refresh_token: Option<String>,
    pub refresh_token_expires_at: Option<f64>,
    pub client_id: Option<String>,
}

/// The Keychain service the CLI uses for an isolated `CLAUDE_CONFIG_DIR`.
pub fn credential_service(profile: &Path) -> String {
    // Relay always uses an absolute, isolated CLAUDE_CONFIG_DIR. Never fall back to the default service.
    let resolved: String = resolve(profile).to_string_lossy().nfc().collect();
    let digest = Sha256::digest(resolved.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("Claude Code-credentials-{}", &hex[..8])
}

/// `security -w` prints non-printable secrets as hex; the CLI stores JSON text.
pub fn decode_secret(output: &str) -> String {
    let text = output.trim();
    if !text.is_empty() && text.len() % 2 == 0 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        let bytes: Vec<u8> = (0..text.len())
            .step_by(2)
            .filter_map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
            .collect();
        let decoded = String::from_utf8_lossy(&bytes).into_owned();
        if decoded.trim_start().starts_with('{') {
            return decoded;
        }
    }
    text.to_owned()
}

/// A control character or space anywhere (`/[\x00-\x20\x7f]/`).
pub(crate) fn has_control(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{20}' || c == '\u{7f}')
}

/// JS `string.length`: UTF-16 code units.
pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn client_id_ok(text: &str) -> bool {
    (1..=200).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// The CLI's `claudeAiOauth` from its credential JSON text.
pub fn parse_credential(raw: &str) -> Result<UsageCredential, UsageError> {
    let missing = || UsageError::new(UsageIssue::CredentialsMissing);
    let root: Value = serde_json::from_str(raw).map_err(|_| missing())?;
    let value = root.get("claudeAiOauth").ok_or_else(missing)?;
    let Some(access_token) = value.get("accessToken").and_then(Value::as_str) else {
        return Err(missing());
    };
    if access_token.is_empty() || js_len(access_token) > 16_384 || has_control(access_token) {
        return Err(missing());
    }
    let refresh_token = value
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && js_len(t) <= 16_384 && !has_control(t))
        .map(str::to_owned);
    Ok(UsageCredential {
        access_token: access_token.to_owned(),
        expires_at: value.get("expiresAt").and_then(Value::as_f64),
        scopes: value
            .get("scopes")
            .and_then(Value::as_array)
            .map(|s| {
                s.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        refresh_token,
        refresh_token_expires_at: value.get("refreshTokenExpiresAt").and_then(Value::as_f64),
        client_id: value
            .get("clientId")
            .and_then(Value::as_str)
            .filter(|c| client_id_ok(c))
            .map(str::to_owned),
    })
}

/// Exit status of `security find-generic-password` when no item matches.
const SECURITY_ITEM_NOT_FOUND: i32 = 44;
/// How long a read that found no Keychain item waits before it looks once more.
pub const MISSING_RETRY_MS: u64 = 1_500;

/// How a `security` run ended, as Node's `execFile` error code: `None` for success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolCode {
    Ok,
    Exit(i32),
    Failed(String),
}

impl std::fmt::Display for ToolCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolCode::Ok => Ok(()),
            ToolCode::Exit(code) => write!(f, "{code}"),
            ToolCode::Failed(code) => f.write_str(code),
        }
    }
}

/// Runs `tool args` like `execFile` with a SIGKILL timeout and an output cap.
pub(crate) fn exec_tool(
    tool: &Path,
    args: &[&str],
    timeout: Duration,
    max_buffer: usize,
) -> (ToolCode, String) {
    match run_tool(tool, args, None, timeout, max_buffer) {
        ToolRun::Exited {
            code: 0, stdout, ..
        } => (ToolCode::Ok, String::from_utf8_lossy(&stdout).into_owned()),
        ToolRun::Exited { code, stdout, .. } => (
            ToolCode::Exit(code),
            String::from_utf8_lossy(&stdout).into_owned(),
        ),
        // Node reports a spawn failure by its errno name.
        ToolRun::SpawnFailed(_) if !tool.exists() => {
            (ToolCode::Failed("ENOENT".into()), String::new())
        }
        ToolRun::SpawnFailed(_) => (ToolCode::Failed("EACCES".into()), String::new()),
        ToolRun::Failed => (ToolCode::Failed("failed".into()), String::new()),
    }
}

/// Reads the official CLI's credential for one isolated profile.
///
/// On macOS the CLI stores it in the login Keychain through `/usr/bin/security`, the item's
/// trusted application, so reading it through the same tool needs no consent dialog. A
/// background read is bounded: a consent prompt is killed and reports `keychain-locked`.
pub fn read_credential(
    profile: &Path,
    allow_prompt: bool,
    tool: Option<&Path>,
    platform: Platform,
    missing_retry_ms: u64,
) -> Result<UsageCredential, UsageError> {
    match fs::symlink_metadata(profile) {
        Ok(meta) if meta.is_symlink() => {
            return Err(UsageError::new(UsageIssue::CredentialsMissing));
        }
        Ok(_) => {}
        // The TS rejects with the fs error, which the readers report as an unanswered read.
        Err(_) => {
            return Err(UsageError::with_detail(
                UsageIssue::Unavailable,
                "no answer: Error",
            ));
        }
    }
    if platform == Platform::MacOs {
        let tool = tool.unwrap_or(Path::new(DEFAULT_SECURITY_TOOL));
        let service = credential_service(profile);
        let find = || {
            exec_tool(
                tool,
                &["find-generic-password", "-s", &service, "-w"],
                Duration::from_millis(if allow_prompt { 120_000 } else { 15_000 }),
                65_536,
            )
        };
        let mut found = find();
        // The CLI rewrites its item when it renews a sign-in; a read in that moment finds none.
        if found.0 == ToolCode::Exit(SECURITY_ITEM_NOT_FOUND) {
            std::thread::sleep(Duration::from_millis(missing_retry_ms));
            found = find();
        }
        // The CLI falls back to a private file when Keychain rejects its write.
        if found.0 == ToolCode::Exit(SECURITY_ITEM_NOT_FOUND) {
            return read_credential_file(profile);
        }
        if found.0 != ToolCode::Ok {
            return Err(UsageError::with_detail(
                UsageIssue::KeychainLocked,
                format!("keychain: security exit {}", found.0),
            ));
        }
        return parse_credential(&decode_secret(&found.1));
    }
    read_credential_file(profile)
}

fn read_credential_file(profile: &Path) -> Result<UsageCredential, UsageError> {
    let read = || -> Option<UsageCredential> {
        let file = profile.join(".credentials.json");
        let meta = fs::symlink_metadata(&file).ok()?;
        if !meta.is_file() || meta.len() > 65_536 {
            return None;
        }
        let bytes = fs::read(&file).ok()?;
        parse_credential(&String::from_utf8_lossy(&bytes)).ok()
    };
    read().ok_or_else(|| {
        UsageError::with_detail(
            UsageIssue::CredentialsMissing,
            "no Keychain item or credentials file",
        )
    })
}
