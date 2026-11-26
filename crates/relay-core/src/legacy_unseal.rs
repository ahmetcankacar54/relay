//! Legacy (pre-v2) vault unsealing, for migration only: the bytes Electron's `safeStorage`
//! wrote, which are Chromium's OSCrypt layouts:
//! - macOS: `v10` ‖ AES-128-CBC (PKCS#7, IV 16 × 0x20), key PBKDF2-SHA1 of the Keychain item
//!   "Relay Safe Storage" password, salt `saltysalt`, 1003 iterations.
//! - Windows: `v10` ‖ 12-byte nonce ‖ AES-256-GCM (ciphertext ‖ tag), key from `Local State`
//!   `os_crypt.encrypted_key` (base64, `DPAPI` prefix, then DPAPI); older blobs are DPAPI whole.
//! - Linux: `v11` with the keyring secret (Secret Service `application` "Relay", or KWallet) or
//!   `v10` with "peanuts"; PBKDF2-SHA1 one iteration, AES-128-CBC, IV 16 × 0x20.
//!
//! Like OSCrypt, an empty blob opens as "" and one without a known prefix is old clear text.

use std::path::Path;
use std::time::Duration;

use aes::Aes128;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, KeyIvInit};
use sha1::Sha1;

use crate::vault_key::{ToolRun, run_tool};

/// macOS: the Keychain item Electron's safeStorage kept Relay's key in.
pub const MAC_SAFE_STORAGE_SERVICE: &str = "Relay Safe Storage";
/// Linux: the app name Electron handed Chromium's keyring code.
pub const LINUX_APP_NAME: &str = "Relay";
const SALT: &[u8] = b"saltysalt";
const MAC_ITERATIONS: u32 = 1003;
const IV: [u8; 16] = [0x20; 16];
const WIN_NONCE: usize = 12;
/// Reading another app's Keychain item or a closed wallet may ask the user: allow an answer.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const QUICK_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BUFFER: usize = 16_384;
/// Chromium's libsecret schema for the Safe Storage secret.
const SECRET_SCHEMA: &str = "chrome_libsecret_os_crypt_password_v2";
/// Where distributions and source installs put secret-tool, tried in this order; never PATH.
const SECRET_TOOLS: [&str; 2] = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"];
const BUSCTL: &str = "/usr/bin/busctl";

/// Electron's own messages: no key for the old seal, or a blob it does not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LegacyUnsealError {
    #[error("System encryption is unavailable.")]
    Unavailable,
    #[error("Error while decrypting the ciphertext provided to safeStorage.decryptString.")]
    Decrypt,
}

/// DPAPI `CryptUnprotectData` of a whole blob; `None` when it refuses.
pub type Dpapi = fn(&[u8]) -> Option<Vec<u8>>;

/// The key material of the old seal, already read from the system (or given by a test).
#[derive(Debug, Clone)]
pub enum LegacyKeySource {
    /// The "Relay Safe Storage" Keychain password.
    Mac { password: String },
    /// The unwrapped `os_crypt` key; `dpapi` opens blobs from before the `v10` layout.
    Windows {
        key: Option<[u8; 32]>,
        dpapi: Option<Dpapi>,
    },
    /// The keyring secret for `v11`; `None` when no keyring answered (`v10` needs none).
    Linux { v11_secret: Option<String> },
}

/// Chromium's CBC key: PBKDF2-SHA1 of the password, salt `saltysalt`, 16 bytes.
pub fn cbc_key(password: &str, iterations: u32) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<Sha1>(password.as_bytes(), SALT, iterations, &mut key);
    key
}

fn cbc_open(key: &[u8; 16], body: &[u8]) -> Option<Vec<u8>> {
    let mut buf = body.to_vec();
    let plain = cbc::Decryptor::<Aes128>::new(key.into(), &IV.into())
        .decrypt_padded::<Pkcs7>(&mut buf)
        .ok()?;
    Some(plain.to_vec())
}

fn text(bytes: &[u8]) -> String {
    // Electron hands the plain text to V8 as UTF-8: invalid sequences become U+FFFD.
    String::from_utf8_lossy(bytes).into_owned()
}

/// Opens one blob Electron's `safeStorage.encryptString` wrote.
pub fn legacy_unseal(blob: &[u8], source: &LegacyKeySource) -> Result<String, LegacyUnsealError> {
    if blob.is_empty() {
        return Ok(String::new());
    }
    match source {
        LegacyKeySource::Mac { password } => match blob.strip_prefix(b"v10") {
            Some(body) => cbc_open(&cbc_key(password, MAC_ITERATIONS), body)
                .map(|plain| text(&plain))
                .ok_or(LegacyUnsealError::Decrypt),
            None => Ok(text(blob)),
        },
        LegacyKeySource::Linux { v11_secret } => {
            let (body, password) = if let Some(body) = blob.strip_prefix(b"v11") {
                let secret = v11_secret
                    .as_deref()
                    .ok_or(LegacyUnsealError::Unavailable)?;
                (body, secret)
            } else if let Some(body) = blob.strip_prefix(b"v10") {
                (body, "peanuts")
            } else {
                return Ok(text(blob));
            };
            // Chromium retries with an empty password: a few profiles were sealed with one
            // (crbug.com/1195256).
            cbc_open(&cbc_key(password, 1), body)
                .or_else(|| cbc_open(&cbc_key("", 1), body))
                .map(|plain| text(&plain))
                .ok_or(LegacyUnsealError::Decrypt)
        }
        LegacyKeySource::Windows { key, dpapi } => match blob.strip_prefix(b"v10") {
            Some(body) => {
                let key = key.as_ref().ok_or(LegacyUnsealError::Unavailable)?;
                if body.len() < WIN_NONCE {
                    return Err(LegacyUnsealError::Decrypt);
                }
                let (nonce, sealed) = body.split_at(WIN_NONCE);
                let nonce = Nonce::try_from(nonce).map_err(|_| LegacyUnsealError::Decrypt)?;
                Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key))
                    .decrypt(&nonce, sealed)
                    .map(|plain| text(&plain))
                    .map_err(|_| LegacyUnsealError::Decrypt)
            }
            None => {
                let dpapi = dpapi.ok_or(LegacyUnsealError::Unavailable)?;
                dpapi(blob)
                    .map(|plain| text(&plain))
                    .ok_or(LegacyUnsealError::Decrypt)
            }
        },
    }
}

impl LegacyKeySource {
    /// macOS: reads "Relay Safe Storage" through `security` (default `/usr/bin/security`).
    /// Its trusted application was Electron's Relay, so macOS may ask the user once.
    pub fn mac_from_keychain(tool: &Path) -> Result<Self, LegacyUnsealError> {
        match run_tool(
            tool,
            &[
                "find-generic-password",
                "-s",
                MAC_SAFE_STORAGE_SERVICE,
                "-w",
            ],
            None,
            PROMPT_TIMEOUT,
            MAX_BUFFER,
        ) {
            ToolRun::Exited {
                code: 0, stdout, ..
            } => {
                let output = String::from_utf8_lossy(&stdout);
                // `security -w` ends the password with a newline; Chromium's never holds one.
                let password = output.strip_suffix('\n').unwrap_or(&output);
                if password.is_empty() {
                    return Err(LegacyUnsealError::Unavailable);
                }
                Ok(Self::Mac {
                    password: password.to_owned(),
                })
            }
            // Missing (exit 44), refused, or timed out: the old seal cannot be used this run.
            _ => Err(LegacyUnsealError::Unavailable),
        }
    }

    /// Windows: the key from `<userData>/Local State`, unwrapped with DPAPI.
    #[cfg(windows)]
    pub fn windows_from_local_state(local_state: &Path) -> Self {
        let key = std::fs::read(local_state)
            .ok()
            .and_then(|json| windows_key_from_local_state(&json, dpapi_unprotect));
        Self::Windows {
            key,
            dpapi: Some(dpapi_unprotect),
        }
    }

    /// Linux: the `v11` secret from the desktop's keyring, chosen as Chromium does.
    pub fn linux_from_keyring(env: &dyn Fn(&str) -> Option<String>) -> Self {
        Self::Linux {
            v11_secret: linux_v11_secret(env, &|file, args, timeout| {
                run_tool(file, args, None, timeout, MAX_BUFFER)
            }),
        }
    }
}

/// This OS's old seal, read from the system on first use and kept for the run: macOS's
/// "Relay Safe Storage" through `tool`, Windows' `<userData>/Local State`, Linux's keyring.
pub struct SystemLegacySeal {
    #[cfg_attr(not(windows), allow(dead_code))]
    user_data: std::path::PathBuf,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    tool: std::path::PathBuf,
    source: std::sync::OnceLock<Option<LegacyKeySource>>,
}

impl SystemLegacySeal {
    /// `tool` is the `security` stand-in (`RELAY_SECURITY_TOOL`); `None` is `/usr/bin/security`.
    pub fn new(user_data: &Path, tool: Option<&Path>) -> Self {
        Self {
            user_data: user_data.to_path_buf(),
            tool: tool.map_or_else(
                || crate::vault_key::DEFAULT_SECURITY_TOOL.into(),
                Path::to_path_buf,
            ),
            source: std::sync::OnceLock::new(),
        }
    }

    fn source(&self) -> Option<&LegacyKeySource> {
        self.source
            .get_or_init(|| {
                #[cfg(target_os = "macos")]
                return LegacyKeySource::mac_from_keychain(&self.tool).ok();
                #[cfg(windows)]
                return Some(LegacyKeySource::windows_from_local_state(
                    &self.user_data.join("Local State"),
                ));
                #[cfg(not(any(target_os = "macos", windows)))]
                return Some(LegacyKeySource::linux_from_keyring(&|name| {
                    std::env::var(name).ok()
                }));
            })
            .as_ref()
    }

    /// Whether the old seal's key could be had this run (`safeStorage.isEncryptionAvailable`).
    /// On Linux only a keyring secret counts: without one, `v11` files would be set aside as
    /// unreadable while the keyring is merely locked.
    pub fn available(&self) -> bool {
        match self.source() {
            None => false,
            Some(LegacyKeySource::Mac { .. }) => true,
            Some(LegacyKeySource::Windows { key, .. }) => key.is_some(),
            Some(LegacyKeySource::Linux { v11_secret }) => v11_secret.is_some(),
        }
    }

    pub fn unseal(&self, blob: &[u8]) -> Result<String, LegacyUnsealError> {
        legacy_unseal(blob, self.source().ok_or(LegacyUnsealError::Unavailable)?)
    }
}

/// `os_crypt.encrypted_key` from a `Local State` file: base64 of `DPAPI` ‖ the DPAPI blob of
/// the 32-byte key.
pub fn windows_key_from_local_state(
    local_state: &[u8],
    unprotect: impl Fn(&[u8]) -> Option<Vec<u8>>,
) -> Option<[u8; 32]> {
    let json: serde_json::Value = serde_json::from_slice(local_state).ok()?;
    let encoded = json.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let wrapped = STANDARD.decode(encoded).ok()?;
    let blob = wrapped.strip_prefix(b"DPAPI")?;
    <[u8; 32]>::try_from(unprotect(blob)?.as_slice()).ok()
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).ok()?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` points at `data` for the call; `output` is LocalAlloc'd by the call and
    // freed below after copying.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .ok()?;
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(Some(HLOCAL(output.pbData.cast())));
        Some(plain)
    }
}

/// A bounded run of a tool: `(file, args, timeout)`.
pub type Run<'a> = &'a dyn Fn(&Path, &[&str], Duration) -> ToolRun;

/// The keyring Chromium picks without `--password-store`, as `base::nix::GetDesktopEnvironment`
/// decides: KDE's own kwalletd by its session version, the Secret Service everywhere else.
/// `Some((service, object path))` for KWallet.
pub fn linux_kwallet(env: &dyn Fn(&str) -> Option<String>) -> Option<(String, String)> {
    let current = env("XDG_CURRENT_DESKTOP");
    let kde = match &current {
        Some(desktops) => desktops
            .split(':')
            .any(|d| d.trim().eq_ignore_ascii_case("KDE")),
        None => {
            let session = env("DESKTOP_SESSION")
                .unwrap_or_default()
                .to_ascii_lowercase();
            session.starts_with("kde") || session.starts_with("plasma")
        }
    };
    if !kde {
        return None;
    }
    let daemon = match env("KDE_SESSION_VERSION").as_deref() {
        Some("6") => "kwalletd6",
        Some("5") => "kwalletd5",
        _ => "kwalletd",
    };
    Some((format!("org.kde.{daemon}"), format!("/modules/{daemon}")))
}

/// Reads the `v11` secret through secret-tool (Secret Service) or busctl (KWallet); `None` when
/// no keyring answers or none holds it.
pub fn linux_v11_secret(env: &dyn Fn(&str) -> Option<String>, run: Run<'_>) -> Option<String> {
    match linux_kwallet(env) {
        Some((service, object)) => kwallet_secret(run, &service, &object),
        None => secret_service_secret(run),
    }
}

fn secret_service_secret(run: Run<'_>) -> Option<String> {
    for tool in SECRET_TOOLS {
        match run(
            Path::new(tool),
            &[
                "lookup",
                "xdg:schema",
                SECRET_SCHEMA,
                "application",
                LINUX_APP_NAME,
            ],
            PROMPT_TIMEOUT,
        ) {
            // Not installed there: the next place.
            ToolRun::SpawnFailed(_) => continue,
            ToolRun::Exited {
                code: 0, stdout, ..
            } => {
                // secret-tool ends the secret with a newline only on a terminal.
                let output = String::from_utf8_lossy(&stdout);
                let secret = output.strip_suffix('\n').unwrap_or(&output);
                return (!secret.is_empty()).then(|| secret.to_owned());
            }
            _ => return None,
        }
    }
    None
}

/// One KWallet D-Bus call through `busctl`, answered as JSON; its single value.
fn kwallet_call(
    run: Run<'_>,
    service: &str,
    object: &str,
    timeout: Duration,
    method: &str,
    signature_and_args: &[&str],
) -> Option<serde_json::Value> {
    let seconds = format!("--timeout={}", timeout.as_secs());
    let mut args = vec![
        "--user",
        "--json=short",
        seconds.as_str(),
        "call",
        service,
        object,
        "org.kde.KWallet",
        method,
    ];
    args.extend_from_slice(signature_and_args);
    match run(Path::new(BUSCTL), &args, timeout + Duration::from_secs(2)) {
        ToolRun::Exited {
            code: 0, stdout, ..
        } => {
            // busctl's JSON: {"type":"s","data":["kdewallet"]}.
            let answer: serde_json::Value = serde_json::from_slice(&stdout).ok()?;
            answer.get("data")?.get(0).cloned()
        }
        _ => None,
    }
}

fn kwallet_secret(run: Run<'_>, service: &str, object: &str) -> Option<String> {
    let call =
        |timeout, method, args: &[&str]| kwallet_call(run, service, object, timeout, method, args);
    let wallet = call(QUICK_TIMEOUT, "networkWallet", &[])?;
    let wallet = wallet.as_str().filter(|w| !w.is_empty())?;
    let handle = call(
        PROMPT_TIMEOUT,
        "open",
        &["sxs", wallet, "0", LINUX_APP_NAME],
    )?
    .as_i64()?;
    if handle < 0 {
        return None;
    }
    let handle = handle.to_string();
    let folder = format!("{LINUX_APP_NAME} Keys");
    let key = format!("{LINUX_APP_NAME} Safe Storage");
    let entry = [
        "isss",
        handle.as_str(),
        folder.as_str(),
        key.as_str(),
        LINUX_APP_NAME,
    ];
    let secret = (call(QUICK_TIMEOUT, "hasEntry", &entry) == Some(serde_json::Value::Bool(true)))
        .then(|| call(QUICK_TIMEOUT, "readPassword", &entry))
        .flatten()
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|secret| !secret.is_empty());
    // Only Relay's own handle; the wallet stays open for everyone else.
    let _ = call(
        QUICK_TIMEOUT,
        "close",
        &["ibs", handle.as_str(), "false", LINUX_APP_NAME],
    );
    secret
}
