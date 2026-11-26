//! Port of `electron/core/backup.ts`: the account backup (`.relaybackup`).
//!
//! A 36-byte header, then the AES-256-GCM ciphertext of one JSON payload and its 16-byte tag. The
//! header is `RLYB`, the format, scrypt's log2(N), r and p, a 16-byte salt and a 12-byte nonce; it
//! is authenticated with the payload, so a changed parameter fails like a changed byte of the
//! payload. The key is scrypt(passphrase, salt): the file opens on any computer that has the
//! passphrase, and on none without it.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::desktop_files::{read_bytes, write_bytes};
use crate::fs_util::{create_new_private, iso_timestamp};
use crate::profile_auth::signed_out;
use crate::shared::backup::{
    BACKUP_EXTENSION, BackupImportMode, BackupImportResult, BackupSummary, BackupSummaryAccount,
    MIN_BACKUP_PASSPHRASE,
};
use crate::shared::feature_risk::{FeatureRiskId, needs_risk_ack};
use crate::shared::proxy_types::{ProxyConfig, RoutingStrategy};
use crate::shared::types::js::JsMap;
use crate::shared::types::{Account, AccountProvider, RelaySettings};
use crate::store::schema::{
    IssueCode, NumberRule, Schema, SchemaError, StringRule, array, boolean, datetime, enumeration,
    literal, number, object, record, string, unknown, uuid,
};
use crate::store::{
    Store, StoreError, account_schema, at_path, file_stamp, parse_as, private_dir, settings_schema,
};
use crate::terminal_identity::{TerminalKeychain, security_keychain};
use crate::usage_credentials::credential_service;
use crate::vault_crypto::Sealer;

pub const BACKUP_MAGIC: &[u8; 4] = b"RLYB";
/// Raised when the payload or the header changes meaning; an older Relay refuses a newer file.
pub const BACKUP_FORMAT: u8 = 1;
const HEADER: usize = 36;
const SALT: usize = 16;
const NONCE: usize = 12;
const TAG: usize = 16;
/// Larger than any real backup (50 accounts' sign-ins and Claude Code configs).
pub const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
/// One profile file larger than this stays out; a config grown that large is not a sign-in.
const MAX_PROFILE_FILE: usize = 8 * 1024 * 1024;
/// The most memory a file may make scrypt use: a crafted header cannot exhaust the computer.
const MAX_SCRYPT_MEMORY: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScryptParams {
    #[serde(rename = "logN")]
    pub log_n: u8,
    pub r: u8,
    pub p: u8,
}

/// 128 MiB and about half a second on a current Mac: slow to guess, quick to open once.
pub const DEFAULT_SCRYPT: ScryptParams = ScryptParams {
    log_n: 17,
    r: 8,
    p: 1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupErrorReason {
    NotABackup,
    NewerFormat,
    WrongPassphrase,
    Damaged,
    TooLarge,
    ShortPassphrase,
}

/// Why a backup could not be written or opened; the app words each reason in its language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{}", backup_message(.reason))]
pub struct BackupError {
    pub reason: BackupErrorReason,
}

fn backup_message(reason: &BackupErrorReason) -> String {
    match reason {
        BackupErrorReason::NotABackup => "This file is not a Relay backup.".into(),
        BackupErrorReason::NewerFormat => {
            "This backup was made by a newer Relay. Update Relay, then import it.".into()
        }
        BackupErrorReason::WrongPassphrase => {
            "The passphrase is wrong, or the file was changed after it was saved.".into()
        }
        BackupErrorReason::Damaged => "This backup is damaged.".into(),
        BackupErrorReason::TooLarge => "This file is too large to be a Relay backup.".into(),
        BackupErrorReason::ShortPassphrase => {
            format!("The passphrase must be at least {MIN_BACKUP_PASSPHRASE} characters.")
        }
    }
}

fn refused(reason: BackupErrorReason) -> BackupError {
    BackupError { reason }
}

/// Anything a backup step can fail with.
#[derive(Debug, thiserror::Error)]
pub enum BackupFailure {
    #[error(transparent)]
    Backup(#[from] BackupError),
    #[error(transparent)]
    Invalid(#[from] SchemaError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// The gateway's portable settings: never its address (this computer's network) or bound clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupGateway {
    pub port: i64,
    pub routing_strategy: RoutingStrategy,
    pub affinity_ttl_seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_account_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_overflow: Option<bool>,
    /// The clients' key: a secret, so only in a backup that holds sign-ins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSessions {
    /// Claude app sign-ins, by Claude account uuid, as the vault held them before sealing.
    pub desktop: JsMap<String>,
    /// Antigravity app sign-ins, by Relay account id.
    pub antigravity_app: JsMap<String>,
    /// Claude Code's credential JSON, by Relay account id: Keychain item or `.credentials.json`.
    pub claude_code: JsMap<String>,
    /// Profile files (`PROFILE_FILE`), base64, by Relay account id.
    pub files: JsMap<JsMap<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPayload {
    /// Always "relay-backup".
    pub kind: String,
    pub created_at: String,
    pub relay_version: String,
    pub platform: String,
    /// Settings without the gateway, the accepted risk notes and the login item.
    pub settings: Map<String, Value>,
    pub accounts: Vec<Account>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<BackupGateway>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<BackupSessions>,
}

/// An opened backup: its payload, and the key it was opened with, to seal the pre-import copy.
#[derive(Debug, Clone)]
pub struct OpenedBackup {
    pub payload: BackupPayload,
    pub key: [u8; 32],
    pub params: ScryptParams,
    pub salt: Vec<u8>,
}

/// Claude Code's credential for one isolated profile, wherever this computer keeps it.
pub trait ClaudeCodeSignIns {
    fn read(&self, profile: &Path) -> Result<Option<String>, String>;
    fn write(&self, profile: &Path, text: &str) -> Result<(), String>;
}

/// Where secrets are read from and put back on this computer.
pub struct BackupHost<'a> {
    /// Relay's data folder: `desktop-vault/` and `profiles/` are inside it.
    pub data: &'a Path,
    /// This computer's vault key: unseals on export, seals again on import.
    pub sealer: &'a Sealer,
    pub claude_code: &'a dyn ClaudeCodeSignIns,
}

/// What is backed up from this computer now.
pub struct BackupSource<'a> {
    pub settings: &'a RelaySettings,
    pub accounts: &'a [Account],
    /// The gateway as main reads it: the registry's settings with proxy-pool.json's.
    pub gateway: &'a ProxyConfig,
}

pub struct BackupContext<'a> {
    pub host: BackupHost<'a>,
    pub relay_version: String,
    pub platform: String,
    pub now: &'a dyn Fn() -> i64,
}

// ---------------------------------------------------------------------------------------------
// Schemas

/// The profile files that carry a sign-in or the account it names: Claude Code's account config,
/// the Codex sign-in, and CLIProxyAPI's Antigravity OAuth files.
fn profile_file(relative: &str) -> bool {
    static PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"^(?:\.claude\.json|\.config\.json|provider-credential\.json|antigravity-oauth/[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}\.json)$",
        )
        .expect("valid pattern")
    });
    PATTERN.is_match(relative)
}
const PROFILE_FILES: [&str; 3] = [".claude.json", ".config.json", "provider-credential.json"];
const OAUTH_DIR: &str = "antigravity-oauth";

fn text_up_to(max: usize) -> Schema {
    string(StringRule {
        max: Some(max),
        ..Default::default()
    })
}

fn int(min: f64, max: f64) -> Schema {
    number(NumberRule {
        int: true,
        min: Some(min),
        max: Some(max),
    })
}

fn ids() -> Schema {
    array(
        string(StringRule {
            min: Some(1),
            max: Some(128),
            ..Default::default()
        }),
        Some(200),
    )
    .optional()
}

/// `gatewaySchema`.
pub fn gateway_schema() -> Schema {
    object(vec![
        ("port", int(1.0, 65_535.0)),
        (
            "routingStrategy",
            enumeration(["soonest-reset", "balanced", "strict-priority"]),
        ),
        ("affinityTtlSeconds", int(10.0, 3_600.0)),
        ("accountOrder", ids()),
        ("excludedAccountIds", ids()),
        ("subagentOverflow", boolean().optional()),
        (
            "apiKey",
            string(StringRule {
                min: Some(1),
                max: Some(200),
                ..Default::default()
            })
            .optional(),
        ),
    ])
}

fn sessions_schema() -> Schema {
    object(vec![
        ("desktop", record(uuid(), text_up_to(MAX_PROFILE_FILE))),
        (
            "antigravityApp",
            record(uuid(), text_up_to(MAX_PROFILE_FILE)),
        ),
        ("claudeCode", record(uuid(), text_up_to(MAX_PROFILE_FILE))),
        (
            "files",
            record(
                uuid(),
                record(
                    string(StringRule {
                        pattern: Some(profile_file),
                        ..Default::default()
                    }),
                    text_up_to(MAX_PROFILE_FILE * 2),
                ),
            ),
        ),
    ])
}

/// `payloadSchema`.
pub fn payload_schema() -> Schema {
    object(vec![
        ("kind", literal(json!("relay-backup"))),
        ("createdAt", datetime()),
        ("relayVersion", text_up_to(40)),
        ("platform", text_up_to(20)),
        ("settings", record(string(StringRule::default()), unknown())),
        ("accounts", array(account_schema(), Some(50))),
        ("gateway", gateway_schema().optional()),
        ("sessions", sessions_schema().optional()),
    ])
}

static PAYLOAD_SCHEMA: LazyLock<Schema> = LazyLock::new(payload_schema);

// ---------------------------------------------------------------------------------------------
// Sealing

fn check_params(params: ScryptParams) -> Result<(), BackupError> {
    let ScryptParams { log_n, r, p } = params;
    let ok = (10..=20).contains(&log_n)
        && (1..=32).contains(&r)
        && (1..=16).contains(&p)
        && 128 * (1u64 << log_n) * u64::from(r) <= MAX_SCRYPT_MEMORY;
    if ok {
        Ok(())
    } else {
        Err(refused(BackupErrorReason::Damaged))
    }
}

fn derive_key(
    passphrase: &str,
    salt: &[u8],
    params: ScryptParams,
) -> Result<[u8; 32], BackupError> {
    check_params(params)?;
    let normalized: String = passphrase.nfc().collect();
    let scrypt_params = scrypt::Params::new(params.log_n, u32::from(params.r), u32::from(params.p))
        .map_err(|_| refused(BackupErrorReason::Damaged))?;
    let mut key = [0u8; 32];
    scrypt::scrypt(normalized.as_bytes(), salt, &scrypt_params, &mut key)
        .map_err(|_| refused(BackupErrorReason::Damaged))?;
    Ok(key)
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random source failed");
    bytes
}

/// Seals the payload under `key`; the salt and parameters go in the header for opening.
pub fn seal_with_key(
    payload: &BackupPayload,
    key: &[u8; 32],
    params: ScryptParams,
    salt: &[u8],
) -> Vec<u8> {
    let nonce: [u8; NONCE] = random();
    let mut header = Vec::with_capacity(HEADER);
    header.extend_from_slice(BACKUP_MAGIC);
    header.extend_from_slice(&[BACKUP_FORMAT, params.log_n, params.r, params.p]);
    header.extend_from_slice(salt);
    header.extend_from_slice(&nonce);
    let cipher = Aes256Gcm::new_from_slice(key).expect("a 32-byte key");
    let plain = serde_json::to_string(payload).expect("a payload serializes");
    let body = cipher
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: plain.as_bytes(),
                aad: &header,
            },
        )
        .expect("AES-GCM sealing cannot fail below its 64 GiB limit");
    let mut out = header;
    out.extend_from_slice(&body);
    out
}

/// A new backup file: a fresh salt, the key from the passphrase, the payload sealed under it.
pub fn seal_backup(
    payload: &BackupPayload,
    passphrase: &str,
    params: ScryptParams,
) -> Result<Vec<u8>, BackupError> {
    if passphrase.chars().count() < MIN_BACKUP_PASSPHRASE {
        return Err(refused(BackupErrorReason::ShortPassphrase));
    }
    let salt: [u8; SALT] = random();
    Ok(seal_with_key(
        payload,
        &derive_key(passphrase, &salt, params)?,
        params,
        &salt,
    ))
}

/// What the header says, checked without the passphrase: a file picked for import is refused
/// here, before the user types anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupHeader {
    pub params: ScryptParams,
    pub salt: Vec<u8>,
    pub nonce: Vec<u8>,
}

pub fn read_backup_header(file: &[u8]) -> Result<BackupHeader, BackupError> {
    if file.len() > MAX_BACKUP_BYTES {
        return Err(refused(BackupErrorReason::TooLarge));
    }
    if file.len() < 4 || &file[..4] != BACKUP_MAGIC {
        return Err(refused(BackupErrorReason::NotABackup));
    }
    if file.len() < HEADER + TAG {
        return Err(refused(BackupErrorReason::Damaged));
    }
    if file[4] > BACKUP_FORMAT {
        return Err(refused(BackupErrorReason::NewerFormat));
    }
    if file[4] != BACKUP_FORMAT {
        return Err(refused(BackupErrorReason::Damaged));
    }
    let params = ScryptParams {
        log_n: file[5],
        r: file[6],
        p: file[7],
    };
    check_params(params)?;
    Ok(BackupHeader {
        params,
        salt: file[8..8 + SALT].to_vec(),
        nonce: file[8 + SALT..HEADER].to_vec(),
    })
}

/// Opens a backup. A wrong passphrase and a changed file fail the same way (the GCM tag), and
/// nothing of the payload is used before the tag checked.
pub fn open_backup(file: &[u8], passphrase: &str) -> Result<OpenedBackup, BackupError> {
    let BackupHeader {
        params,
        salt,
        nonce,
    } = read_backup_header(file)?;
    let key = derive_key(passphrase, &salt, params)?;
    let cipher = Aes256Gcm::new_from_slice(&key).expect("a 32-byte key");
    let nonce =
        Nonce::try_from(nonce.as_slice()).map_err(|_| refused(BackupErrorReason::Damaged))?;
    let plain = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &file[HEADER..],
                aad: &file[..HEADER],
            },
        )
        .map_err(|_| refused(BackupErrorReason::WrongPassphrase))?;
    let raw: Value = serde_json::from_str(&String::from_utf8_lossy(&plain))
        .map_err(|_| refused(BackupErrorReason::Damaged))?;
    let payload = parse_as::<BackupPayload>(&PAYLOAD_SCHEMA, &raw)
        .map_err(|_| refused(BackupErrorReason::Damaged))?;
    Ok(OpenedBackup {
        payload,
        key,
        params,
        salt,
    })
}

// ---------------------------------------------------------------------------------------------
// Collecting

fn profile_of(host: &BackupHost<'_>, account_id: &str) -> PathBuf {
    host.data.join("profiles").join(account_id)
}

fn vault_of(host: &BackupHost<'_>) -> PathBuf {
    host.data.join("desktop-vault")
}

/// Every setting but the gateway (it travels apart), the accepted risk notes (each computer asks
/// once) and the login item (the system's, set on each computer).
fn portable_settings(settings: &RelaySettings) -> Map<String, Value> {
    let mut rest = match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for key in ["proxy", "riskAcknowledged", "launchAtLogin"] {
        rest.shift_remove(key);
    }
    rest
}

fn portable_gateway(config: &ProxyConfig, with_key: bool) -> Result<BackupGateway, SchemaError> {
    let gateway = BackupGateway {
        port: config.port,
        routing_strategy: config.routing_strategy,
        affinity_ttl_seconds: config.affinity_ttl_seconds,
        account_order: config.account_order.clone(),
        excluded_account_ids: config.excluded_account_ids.clone(),
        subagent_overflow: config.subagent_overflow.filter(|on| *on),
        api_key: config
            .api_key
            .clone()
            .filter(|_| with_key)
            .filter(|key| !key.is_empty()),
    };
    let value = serde_json::to_value(&gateway).unwrap_or(Value::Null);
    parse_as(&gateway_schema(), &value)
}

/// A sealed vault file's text; None when there is none or this key cannot open it.
fn unsealed(host: &BackupHost<'_>, relative: &str) -> Option<String> {
    let data = read_bytes(&vault_of(host), relative).ok()??;
    host.sealer.unseal(&data).ok()
}

/// The profile's portable files, base64 by relative path; a missing, linked or oversized one is
/// left out.
fn profile_files(profile: &Path) -> JsMap<String> {
    let mut out = JsMap::new();
    let mut oauth: Vec<String> = fs::read_dir(profile.join(OAUTH_DIR))
        .map(|entries| {
            entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .map(|name| format!("{OAUTH_DIR}/{name}"))
                .collect()
        })
        .unwrap_or_default();
    oauth.sort();
    for relative in PROFILE_FILES.iter().map(|s| s.to_string()).chain(oauth) {
        if !profile_file(&relative) {
            continue;
        }
        if let Ok(Some(data)) = read_bytes(profile, &relative)
            && data.len() <= MAX_PROFILE_FILE
        {
            out.insert(relative, STANDARD.encode(data));
        }
    }
    out
}

fn has_sign_in(sessions: Option<&BackupSessions>, account: &Account) -> bool {
    let Some(sessions) = sessions else {
        return false;
    };
    account.desktop.as_ref().is_some_and(|d| {
        sessions
            .desktop
            .get(&d.account_uuid)
            .is_some_and(|s| !s.is_empty())
    }) || sessions
        .antigravity_app
        .get(&account.id)
        .is_some_and(|s| !s.is_empty())
        || sessions
            .claude_code
            .get(&account.id)
            .is_some_and(|s| !s.is_empty())
        || sessions.files.get(&account.id).is_some_and(|files| {
            files.keys().any(|name| {
                name == "provider-credential.json" || name.starts_with(&format!("{OAUTH_DIR}/"))
            })
        })
}

/// What a backup of this computer holds. With `include_sign_ins`, every saved sign-in Relay can
/// read is unsealed into it (a damaged or locked one is left out, never failing the backup).
pub fn collect_backup(
    source: &BackupSource<'_>,
    include_sign_ins: bool,
    context: &BackupContext<'_>,
) -> Result<BackupPayload, BackupFailure> {
    let schema = account_schema();
    let accounts: Vec<Account> = source
        .accounts
        .iter()
        .map(|account| {
            parse_as::<Account>(
                &schema,
                &serde_json::to_value(account).unwrap_or(Value::Null),
            )
        })
        .collect::<Result<_, _>>()?;
    let mut sessions = None;
    if include_sign_ins {
        let host = &context.host;
        let mut found = BackupSessions::default();
        for account in &accounts {
            if let Some(desktop) = &account.desktop
                && let Some(login) =
                    unsealed(host, &format!("accounts/{}.bin", desktop.account_uuid))
                && !login.is_empty()
            {
                found.desktop.insert(desktop.account_uuid.clone(), login);
            }
            if let Some(antigravity) = unsealed(
                host,
                &format!("antigravity-app/{}.bin", account.id.to_lowercase()),
            ) && !antigravity.is_empty()
            {
                found
                    .antigravity_app
                    .insert(account.id.clone(), antigravity);
            }
            let profile = profile_of(host, &account.id);
            if let Ok(Some(credential)) = host.claude_code.read(&profile)
                && !credential.is_empty()
            {
                found.claude_code.insert(account.id.clone(), credential);
            }
            let files = profile_files(&profile);
            if !files.is_empty() {
                found.files.insert(account.id.clone(), files);
            }
        }
        sessions = Some(found);
    }
    let payload = BackupPayload {
        kind: "relay-backup".into(),
        created_at: iso_timestamp((context.now)()),
        relay_version: context.relay_version.clone(),
        platform: context.platform.clone(),
        settings: portable_settings(source.settings),
        accounts,
        gateway: Some(portable_gateway(source.gateway, include_sign_ins)?),
        sessions,
    };
    let value = serde_json::to_value(&payload).map_err(io::Error::other)?;
    Ok(parse_as(&PAYLOAD_SCHEMA, &value)?)
}

/// The account here that `account` is: the same Relay id, or the same Claude app account.
fn present_as<'a>(account: &Account, current: &'a [Account]) -> Option<&'a Account> {
    current.iter().find(|here| {
        here.id == account.id
            || account.desktop.as_ref().is_some_and(|theirs| {
                here.desktop.as_ref().is_some_and(|ours| {
                    ours.account_uuid.to_lowercase() == theirs.account_uuid.to_lowercase()
                })
            })
    })
}

/// What the opened backup holds, against the accounts here now.
pub fn summarize_backup(payload: &BackupPayload, current: &[Account]) -> BackupSummary {
    BackupSummary {
        created_at: payload.created_at.clone(),
        relay_version: payload.relay_version.clone(),
        platform: payload.platform.clone(),
        sign_ins: payload.sessions.is_some(),
        current_accounts: current.len() as f64,
        accounts: payload
            .accounts
            .iter()
            .map(|account| BackupSummaryAccount {
                name: account.name.clone(),
                provider: account.provider.unwrap_or(AccountProvider::Claude),
                sign_in: has_sign_in(payload.sessions.as_ref(), account),
                present: present_as(account, current).is_some(),
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------------------------
// Importing

/// Puts the accounts' sign-ins back, sealed with this computer's key. A merge (`overwrite` false)
/// never replaces a Claude app sign-in kept here: it may be newer. Each failure is counted and
/// the rest go on.
fn restore_sign_ins(
    sessions: &BackupSessions,
    accounts: &[Account],
    host: &BackupHost<'_>,
    overwrite: bool,
) -> (usize, usize) {
    let (mut restored, mut failed) = (0, 0);
    let vault = vault_of(host);
    for account in accounts {
        let mut steps: Vec<Box<dyn FnOnce() -> Result<(), String> + '_>> = Vec::new();
        if let Some(uuid) = account.desktop.as_ref().map(|d| d.account_uuid.clone())
            && let Some(login) = sessions.desktop.get(&uuid).filter(|l| !l.is_empty())
        {
            let vault = &vault;
            steps.push(Box::new(move || {
                let relative = format!("accounts/{uuid}.bin");
                if !overwrite
                    && read_bytes(vault, &relative)
                        .map_err(|e| e.to_string())?
                        .is_some()
                {
                    return Ok(());
                }
                write_bytes(vault, &relative, Some(&host.sealer.seal(login)))
                    .map_err(|e| e.to_string())
            }));
        }
        if let Some(antigravity) = sessions
            .antigravity_app
            .get(&account.id)
            .filter(|a| !a.is_empty())
        {
            let vault = &vault;
            let relative = format!("antigravity-app/{}.bin", account.id.to_lowercase());
            steps.push(Box::new(move || {
                write_bytes(vault, &relative, Some(&host.sealer.seal(antigravity)))
                    .map_err(|e| e.to_string())
            }));
        }
        let profile = profile_of(host, &account.id);
        if let Some(credential) = sessions
            .claude_code
            .get(&account.id)
            .filter(|c| !c.is_empty())
        {
            let profile = profile.clone();
            steps.push(Box::new(move || {
                host.claude_code.write(&profile, credential)
            }));
        }
        if let Some(files) = sessions.files.get(&account.id) {
            for (relative, data) in files {
                let profile = profile.clone();
                steps.push(Box::new(move || {
                    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
                    let relative: PathBuf = relative.split('/').collect();
                    write_bytes(&profile, &relative.to_string_lossy(), Some(&bytes))
                        .map_err(|e| e.to_string())
                }));
            }
        }
        if steps.is_empty() {
            continue;
        }
        let mut ok = true;
        for step in steps {
            if step().is_err() {
                ok = false;
            }
        }
        if ok { restored += 1 } else { failed += 1 }
    }
    (restored, failed)
}

/// Parses settings a backup carries over this computer's, so a field an older Relay never wrote
/// keeps its value here; a field a newer Relay wrote and this one does not know is dropped. The
/// gateway, the accepted risk notes and the login item stay this computer's, and early start
/// comes over off until its risk was accepted here.
pub fn imported_settings(
    saved: &Map<String, Value>,
    current: &RelaySettings,
) -> Result<RelaySettings, BackupError> {
    let mut value = match serde_json::to_value(current) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (key, item) in saved {
        value.insert(key.clone(), item.clone());
    }
    let own = |key: &str, item: Option<Value>, value: &mut Map<String, Value>| match item {
        Some(item) => {
            value.insert(key.into(), item);
        }
        None => {
            value.shift_remove(key);
        }
    };
    own(
        "proxy",
        current
            .proxy
            .as_ref()
            .and_then(|p| serde_json::to_value(p).ok()),
        &mut value,
    );
    own(
        "riskAcknowledged",
        serde_json::to_value(&current.risk_acknowledged).ok(),
        &mut value,
    );
    own(
        "launchAtLogin",
        current.launch_at_login.map(Value::Bool),
        &mut value,
    );
    let schema = settings_schema();
    let mut value = Value::Object(value);
    for _ in 0..20 {
        let issues = match parse_as::<RelaySettings>(&schema, &value) {
            Ok(mut settings) => {
                if settings.planning.auto_start
                    && needs_risk_ack(Some(&current.risk_acknowledged), FeatureRiskId::EarlyStart)
                {
                    settings.planning.auto_start = false;
                }
                return Ok(settings);
            }
            Err(error) => error.issues,
        };
        let mut dropped = false;
        for issue in issues {
            let IssueCode::UnrecognizedKeys(keys) = issue.code else {
                continue;
            };
            let Some(Value::Object(map)) = at_path(&mut value, &issue.path) else {
                continue;
            };
            for key in keys {
                map.shift_remove(&key);
            }
            dropped = true;
        }
        if !dropped {
            break;
        }
    }
    Err(refused(BackupErrorReason::Damaged))
}

/// What an import did and, for a replace, the gateway settings main applies through its own calls.
#[derive(Debug, Clone, PartialEq)]
pub struct BackupImport {
    pub result: BackupImportResult,
    pub gateway: Option<BackupGateway>,
}

/// Brings an opened backup in. A merge adds the accounts not here yet (by id or Claude app
/// account, up to 50) with their sign-ins and keeps everything else. A replace first saves what
/// is here as a backup sealed with the same passphrase (`relay-backups/` in Relay's folder,
/// sign-ins included), then takes the file's accounts and settings; the files of accounts it
/// drops stay on disk, so importing that copy brings them back whole.
pub fn import_backup(
    opened: &OpenedBackup,
    mode: BackupImportMode,
    store: &Store,
    current_gateway: &ProxyConfig,
    context: &BackupContext<'_>,
) -> Result<BackupImport, BackupFailure> {
    let payload = &opened.payload;
    let host = &context.host;
    let state = store.state();
    let mut before = None;
    if mode == BackupImportMode::Replace {
        let copy = collect_backup(
            &BackupSource {
                settings: &state.settings,
                accounts: &state.accounts,
                gateway: current_gateway,
            },
            true,
            context,
        )?;
        let dir = host.data.join("relay-backups");
        private_dir(&dir)?;
        let name = format!(
            "before-import-{}.{BACKUP_EXTENSION}",
            file_stamp((context.now)())
        );
        let mut out = create_new_private(&dir.join(&name))?;
        out.write_all(&seal_with_key(
            &copy,
            &opened.key,
            opened.params,
            &opened.salt,
        ))?;
        before = Some(name);
    }
    let current = &state.accounts;
    let mut incoming: Vec<Account> = payload.accounts.clone();
    let mut skipped = 0;
    if mode == BackupImportMode::Merge {
        let room = 50usize.saturating_sub(current.len());
        let fresh: Vec<Account> = incoming
            .into_iter()
            .filter(|a| present_as(a, current).is_none())
            .collect();
        skipped = payload.accounts.len() - fresh.len().min(room);
        incoming = fresh.into_iter().take(room).collect();
    }
    let (restored, failed) = match &payload.sessions {
        Some(sessions) => {
            restore_sign_ins(sessions, &incoming, host, mode == BackupImportMode::Replace)
        }
        None => (0, 0),
    };
    let checked_at = iso_timestamp((context.now)());
    let mut accounts = Vec::with_capacity(incoming.len());
    for account in incoming {
        let profile = profile_of(host, &account.id);
        let had_profile = fs::metadata(&profile).is_ok_and(|m| m.is_dir());
        private_dir(&profile)?;
        // An account that came without a sign-in, and has none here, is signed out until it signs in.
        let signed_in = account.auth.as_ref().is_some_and(|a| a.logged_in);
        if signed_in && !had_profile && !has_sign_in(payload.sessions.as_ref(), &account) {
            let auth = signed_out(account.auth.as_ref(), &checked_at);
            accounts.push(Account {
                auth: Some(auth),
                ..account
            });
        } else {
            accounts.push(account);
        }
    }
    let added = accounts.len();
    store.try_update(|state| -> Result<(), BackupFailure> {
        if mode == BackupImportMode::Replace {
            state.settings = imported_settings(&payload.settings, &state.settings)?;
            state.accounts = accounts;
        } else {
            state.accounts.extend(accounts);
        }
        Ok(())
    })?;
    Ok(BackupImport {
        result: BackupImportResult {
            mode,
            added: added as f64,
            skipped: skipped as f64,
            sign_ins: restored as f64,
            sign_ins_failed: failed as f64,
            before,
        },
        gateway: if mode == BackupImportMode::Replace {
            payload.gateway.clone()
        } else {
            None
        },
    })
}

/// Claude Code's credential for a Relay profile on this computer: on macOS the Keychain item named
/// after the profile's path (through `/usr/bin/security`, so no dialog), else, and when macOS has
/// none, the profile's `.credentials.json`. Written back the same way.
pub struct ClaudeCodeKeychain {
    pub mac: bool,
}

/// `claudeCodeSignIns(platform)`; `platform` is Node's `process.platform`.
pub fn claude_code_sign_ins(platform: &str) -> ClaudeCodeKeychain {
    ClaudeCodeKeychain {
        mac: platform == "darwin",
    }
}

const CREDENTIAL_FILE: &str = ".credentials.json";

impl ClaudeCodeSignIns for ClaudeCodeKeychain {
    fn read(&self, profile: &Path) -> Result<Option<String>, String> {
        if self.mac {
            let item = security_keychain(None, None, Some(&credential_service(profile)))
                .read()
                .map_err(|e| e.to_string())?;
            if let Some(item) = item.filter(|i| !i.is_empty()) {
                return Ok(Some(item));
            }
        }
        let data = read_bytes(profile, CREDENTIAL_FILE).map_err(|e| e.to_string())?;
        Ok(data
            .map(|d| String::from_utf8_lossy(&d).into_owned())
            .filter(|t| !t.is_empty()))
    }

    fn write(&self, profile: &Path, text: &str) -> Result<(), String> {
        if self.mac {
            let keychain = security_keychain(None, None, Some(&credential_service(profile)));
            keychain.write(text).map_err(|e| e.to_string())?;
            if keychain.read().map_err(|e| e.to_string())?.as_deref() != Some(text) {
                return Err("The Keychain did not keep the Claude Code sign-in.".into());
            }
            return Ok(());
        }
        write_bytes(profile, CREDENTIAL_FILE, Some(text.as_bytes())).map_err(|e| e.to_string())
    }
}
