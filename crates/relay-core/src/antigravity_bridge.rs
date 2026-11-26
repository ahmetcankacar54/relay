//! Port of `electron/core/antigravity-bridge.ts`: one isolated CLIProxyAPI process and OAuth
//! store per Relay Antigravity account, driven through its local management API.

use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::usage::http_client;

pub const CLI_PROXY_VERSION: &str = "8.0.61";

fn release_url(name: &str) -> String {
    format!(
        "https://github.com/router-for-me/CLIProxyAPI/releases/download/v{CLI_PROXY_VERSION}/{name}"
    )
}

/// The pinned archive of each `<platform>-<arch>` (Node's names) and its SHA-256.
const ASSETS: [(&str, &str, &str); 6] = [
    (
        "darwin-arm64",
        "CLIProxyAPI_8.0.61_darwin_aarch64.tar.gz",
        "ed73b4e3e9a71c524c54ecb64da3235a48de5f233aabccc58c43259ac6b1392f",
    ),
    (
        "darwin-x64",
        "CLIProxyAPI_8.0.61_darwin_amd64.tar.gz",
        "6d60879a83f2a18dc5af37ee93a571c7f524fac9a664cb0b6080ccf11126c6e6",
    ),
    (
        "linux-arm64",
        "CLIProxyAPI_8.0.61_linux_aarch64.tar.gz",
        "ca1ba77c8140c875c66d5cb470cd6aba421f6ef71fede54e8e34703a46be5731",
    ),
    (
        "linux-x64",
        "CLIProxyAPI_8.0.61_linux_amd64.tar.gz",
        "9d0af252b7eca7b9f670f15cd0d369b20a3bb14523b474a00b1ea334a2220078",
    ),
    (
        "win32-arm64",
        "CLIProxyAPI_8.0.61_windows_aarch64.zip",
        "877878538504ff58469081392ec17143d9ad1d9f20042ff5a902a05f5733261c",
    ),
    (
        "win32-x64",
        "CLIProxyAPI_8.0.61_windows_amd64.zip",
        "e6dbe1337d17b993c6fa6d75d71f2e98db6ea3653af73a4217956f0c53e025b5",
    ),
];

/// Why a bridge step failed, as the TS throws it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AntigravityBridgeError(pub String);

fn fail(message: impl Into<String>) -> AntigravityBridgeError {
    AntigravityBridgeError(message.into())
}

/// Node's `process.platform`.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// 32 random bytes, base64url.
fn secret() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system has randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The names CLIProxyAPI gives Antigravity credentials: antigravity-<email>.json.
static CREDENTIAL_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^antigravity-[^/\\]+\.json$").expect("valid regex"));
static SERVICE_STATUS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Antigravity OAuth service returned [0-9]{3}$").expect("valid regex")
});

/// Asks an older sidecar's management route only when the current one answered with an error.
/// A timeout or a refused connection is the same on both routes: asking again would only double
/// the wait of a usage read that is already late.
fn older_route<T>(
    error: AntigravityBridgeError,
    ask: impl FnOnce() -> Result<T, AntigravityBridgeError>,
) -> Result<T, AntigravityBridgeError> {
    if SERVICE_STATUS.is_match(&error.0) {
        ask()
    } else {
        Err(error)
    }
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "cli-proxy-api.exe"
    } else {
        "cli-proxy-api"
    }
}

/// Installs a pinned CLIProxyAPI binary. The archive digest is checked before extraction.
pub fn install_cli_proxy_binary(tools_dir: &Path) -> Result<PathBuf, AntigravityBridgeError> {
    let key = format!("{}-{}", node_platform(), crate::mac_update::node_arch());
    let Some((_, name, sha256)) = ASSETS.iter().find(|(k, _, _)| *k == key) else {
        return Err(fail(format!(
            "CLIProxyAPI is unavailable on {}/{}",
            node_platform(),
            crate::mac_update::node_arch()
        )));
    };
    let install_dir = tools_dir.join(format!(
        "cli-proxy-api-{CLI_PROXY_VERSION}-{}-{}",
        node_platform(),
        crate::mac_update::node_arch()
    ));
    let binary = install_dir.join(binary_name());
    if binary.exists() {
        return Ok(binary);
    }
    let io = |e: std::io::Error| fail(e.to_string());
    crate::fs_util::create_private_dir_all(tools_dir).map_err(io)?;
    let temp = tools_dir.join(format!(".cli-proxy-download-{}", uuid::Uuid::new_v4()));
    crate::fs_util::create_private_dir(&temp).map_err(io)?;
    let result = (|| {
        let mut response = (crate::app_update::default_request())(
            &release_url(name),
            &[],
            Duration::from_secs(120),
        )
        .map_err(fail)?;
        if !response.ok() {
            return Err(fail(format!(
                "CLIProxyAPI download failed ({})",
                response.status
            )));
        }
        let mut bytes = Vec::new();
        (&mut response.body)
            .take(100 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(io)?;
        if bytes.len() > 100 * 1024 * 1024 {
            return Err(fail("CLIProxyAPI archive is too large"));
        }
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest != *sha256 {
            return Err(fail("CLIProxyAPI archive checksum mismatch"));
        }
        let archive = temp.join(name);
        crate::mac_update::write_mode(&archive, &bytes, 0o600).map_err(io)?;
        let status = Command::new("tar")
            .arg(if cfg!(windows) { "-xf" } else { "-xzf" })
            .arg(&archive)
            .arg("-C")
            .arg(&temp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(io)?;
        if !status.success() {
            return Err(fail("Command failed: tar"));
        }
        let extracted = temp.join(binary_name());
        fs::metadata(&extracted).map_err(io)?;
        crate::fs_util::create_private_dir_all(&install_dir).map_err(io)?;
        fs::copy(&extracted, &binary).map_err(io)?;
        #[cfg(unix)]
        crate::fs_util::set_mode(&binary, 0o700).map_err(io)?;
        Ok(binary.clone())
    })();
    let _ = fs::remove_dir_all(&temp);
    result
}

/// Where a sign-in stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AntigravityOAuthState {
    Wait,
    Ok { email: String },
    Error { error: String },
}

/// The callback address the browser was sent back to, checked before it goes anywhere: a
/// loopback /oauth-callback carrying this sign-in's state and a code. Anything else is refused.
pub fn antigravity_callback_url(
    address: &str,
    state: &str,
) -> Result<String, AntigravityBridgeError> {
    let url = url::Url::parse(crate::shared::types::js::trim(address))
        .map_err(|_| fail("Not a sign-in address"))?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        || url.path() != "/oauth-callback"
    {
        return Err(fail("Not the Antigravity sign-in address"));
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    if param("state").as_deref() != Some(state) {
        return Err(fail("This address belongs to another sign-in"));
    }
    if param("code").is_none_or(|c| c.is_empty()) {
        return Err(fail("The address has no sign-in code"));
    }
    Ok(url.to_string())
}

/// Finds or installs the CLIProxyAPI binary in the tools folder.
pub type BinaryProvider =
    Arc<dyn Fn(&Path) -> Result<PathBuf, AntigravityBridgeError> + Send + Sync>;

/// One POST to Google, sent through the sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleRequest {
    pub url: String,
    pub body: String,
    pub user_agent: Option<String>,
}

/// Google's answer, as the sidecar passed it on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleAnswer {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
}

/// The sidecar's local address and client key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeEndpoint {
    pub url: String,
    pub key: String,
}

#[derive(Default)]
struct Process {
    child: Option<Child>,
    port: Option<u16>,
}

/// One isolated CLIProxyAPI process and OAuth store per Relay Antigravity account.
pub struct AntigravityBridge {
    pub profile_dir: PathBuf,
    tools_dir: PathBuf,
    binary_provider: BinaryProvider,
    management_key: String,
    client_key: String,
    pub auth_dir: PathBuf,
    process: Mutex<Process>,
    /// One start at a time; a caller during a start waits for it.
    starting: Mutex<()>,
}

static CODE_ASSIST_HOST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:daily-)?cloudcode-pa\.googleapis\.com$").expect("valid regex")
});
static AGENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^antigravity/[A-Za-z0-9_./ -]{1,60}$").expect("valid regex"));
static STATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_-]{8,128}$").expect("valid regex"));
static PROJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9:._-]{1,128}$").expect("valid regex"));

impl AntigravityBridge {
    pub fn new(
        profile_dir: impl Into<PathBuf>,
        tools_dir: impl Into<PathBuf>,
        binary_provider: Option<BinaryProvider>,
    ) -> Self {
        let profile_dir = profile_dir.into();
        AntigravityBridge {
            auth_dir: profile_dir.join("antigravity-oauth"),
            profile_dir,
            tools_dir: tools_dir.into(),
            binary_provider: binary_provider
                .unwrap_or_else(|| Arc::new(|dir: &Path| install_cli_proxy_binary(dir))),
            management_key: secret(),
            client_key: secret(),
            process: Mutex::new(Process::default()),
            starting: Mutex::new(()),
        }
    }

    fn process(&self) -> std::sync::MutexGuard<'_, Process> {
        self.process.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The running sidecar's address and client key.
    pub fn endpoint(&self) -> Option<BridgeEndpoint> {
        let mut process = self.process();
        let port = process.port?;
        let running = matches!(process.child.as_mut()?.try_wait(), Ok(None));
        running.then(|| BridgeEndpoint {
            url: format!("http://127.0.0.1:{port}"),
            key: self.client_key.clone(),
        })
    }

    pub fn start(&self) -> Result<(), AntigravityBridgeError> {
        if self.endpoint().is_some() {
            return Ok(());
        }
        let _one = self.starting.lock().unwrap_or_else(|e| e.into_inner());
        if self.endpoint().is_some() {
            return Ok(());
        }
        self.start_now()
    }

    fn start_now(&self) -> Result<(), AntigravityBridgeError> {
        let io = |e: std::io::Error| fail(e.to_string());
        let binary = (self.binary_provider)(&self.tools_dir)?;
        crate::fs_util::create_private_dir_all(&self.auth_dir).map_err(io)?;
        let port = free_port().map_err(io)?;
        let config_path = self.profile_dir.join("antigravity-proxy.yaml");
        let quote = |text: &str| serde_json::to_string(text).expect("strings serialize");
        // JSON quoted strings are valid YAML scalars and cannot escape into new fields.
        let config = [
            "config-version: 8".to_owned(),
            "server:".to_owned(),
            "  host: \"127.0.0.1\"".to_owned(),
            format!("  port: {port}"),
            "management:".to_owned(),
            "  allow-remote: false".to_owned(),
            format!("  secret-key: {}", quote(&self.management_key)),
            "  disable-control-panel: true".to_owned(),
            "access:".to_owned(),
            "  api-keys:".to_owned(),
            format!("    - {}", quote(&self.client_key)),
            "oauth:".to_owned(),
            format!("  auth-dir: {}", quote(&self.auth_dir.to_string_lossy())),
            String::new(),
        ]
        .join("\n");
        crate::mac_update::write_mode(&config_path, config.as_bytes(), 0o600).map_err(io)?;
        let mut command = Command::new(&binary);
        command
            .args(["-config"])
            .arg(&config_path)
            .arg("-local-model")
            .current_dir(&self.profile_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        let started = Instant::now();
        let mut child = command.spawn().ok();
        // Consume logs so a full pipe cannot stall the sidecar; never surface token material.
        if let Some(child) = child.as_mut() {
            for mut pipe in [
                child
                    .stdout
                    .take()
                    .map(|p| Box::new(p) as Box<dyn Read + Send>),
                child
                    .stderr
                    .take()
                    .map(|p| Box::new(p) as Box<dyn Read + Send>),
            ]
            .into_iter()
            .flatten()
            {
                std::thread::spawn(move || {
                    let _ = std::io::copy(&mut pipe, &mut std::io::sink());
                });
            }
        }
        {
            let mut process = self.process();
            process.child = child;
            process.port = Some(port);
        }
        while started.elapsed() < Duration::from_secs(15) {
            let exited = match self.process().child.as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(None)),
                None => true,
            };
            if exited {
                break;
            }
            let answer = http_client()
                .get(format!("http://127.0.0.1:{port}/v1/models"))
                .header("Authorization", format!("Bearer {}", self.client_key))
                .timeout(Duration::from_millis(700))
                .send();
            if answer.is_ok_and(|r| r.status().is_success()) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        self.stop();
        Err(fail("CLIProxyAPI could not start on the local port"))
    }

    fn management(
        &self,
        route: &str,
        body: Option<&Value>,
    ) -> Result<Value, AntigravityBridgeError> {
        self.management_at("/v8/management", route, body)
    }

    fn management_at(
        &self,
        prefix: &str,
        route: &str,
        body: Option<&Value>,
    ) -> Result<Value, AntigravityBridgeError> {
        self.start()?;
        let endpoint = self
            .endpoint()
            .ok_or_else(|| fail("CLIProxyAPI could not start on the local port"))?;
        let url = format!("{}{prefix}{route}", endpoint.url);
        let request = match body {
            None => http_client().get(url),
            Some(body) => http_client()
                .post(url)
                .header("content-type", "application/json")
                .body(body.to_string()),
        };
        let response = request
            .header("Authorization", format!("Bearer {}", self.management_key))
            .timeout(Duration::from_secs(20))
            .send()
            .map_err(|e| fail(e.to_string()))?;
        if !response.status().is_success() {
            return Err(fail(format!(
                "Antigravity OAuth service returned {}",
                response.status().as_u16()
            )));
        }
        let text = response.text().map_err(|e| fail(e.to_string()))?;
        serde_json::from_str(&text).map_err(|e| fail(e.to_string()))
    }

    /// Google sends the browser back to localhost:51121, the port Antigravity's client is
    /// registered with. Relay answers there itself when it can (`forwarder: false`) and passes
    /// the address on with `submit_callback`; otherwise CLIProxyAPI is asked to listen there
    /// (is_webui), which ends on its own "Authentication successful!" page. The state and the
    /// address.
    pub fn begin_oauth(&self, forwarder: bool) -> Result<(String, String), AntigravityBridgeError> {
        let route = format!(
            "/oauth/auth-url?provider=antigravity{}",
            if forwarder { "&is_webui=true" } else { "" }
        );
        let result = self.management(&route, None)?;
        let text = |key: &str| {
            result
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let (Some("ok"), Some(state), Some(address)) = (
            result.get("status").and_then(Value::as_str),
            text("state"),
            text("url"),
        ) else {
            return Err(fail("Antigravity OAuth could not start"));
        };
        let url = url::Url::parse(&address).map_err(|e| fail(e.to_string()))?;
        if url.scheme() != "https" || url.host_str() != Some("accounts.google.com") {
            return Err(fail("Unexpected Antigravity sign-in address"));
        }
        Ok((state, address))
    }

    /// Finishes a sign-in from the address the browser was sent back to, when it could not
    /// reach the callback port by itself (pasted by the user). Only that sign-in's own address
    /// is sent on.
    pub fn submit_callback(
        &self,
        state: &str,
        address: &str,
    ) -> Result<(), AntigravityBridgeError> {
        let url = antigravity_callback_url(address, state)?;
        let result = self.management(
            "/oauth/callback",
            Some(&json!({ "provider": "antigravity", "redirect_url": url })),
        )?;
        if result.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(fail(
                result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Antigravity sign-in could not be finished"),
            ));
        }
        Ok(())
    }

    pub fn poll_oauth(&self, state: &str) -> Result<AntigravityOAuthState, AntigravityBridgeError> {
        if !STATE.is_match(state) {
            return Err(fail("Invalid OAuth state"));
        }
        let result = self.management(&format!("/oauth/status?state={state}"), None)?;
        match result.get("status").and_then(Value::as_str) {
            Some("wait") => return Ok(AntigravityOAuthState::Wait),
            Some("ok") => {}
            _ => {
                return Ok(AntigravityOAuthState::Error {
                    error: result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Antigravity sign-in failed")
                        .to_owned(),
                });
            }
        }
        let error = |text: &str| AntigravityOAuthState::Error {
            error: text.to_owned(),
        };
        // CLIProxyAPI names the saved file only for some flows: its built-in Google sign-in
        // finishes the session without an auth_id, after it saved antigravity-<email>.json.
        if let Some(auth_id) = result.get("auth_id").filter(|v| !v.is_null()) {
            let auth_id = auth_id.as_str().unwrap_or("");
            let file = Path::new(auth_id)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if file != auth_id || !CREDENTIAL_FILE.is_match(&file) {
                return Ok(error("Invalid Antigravity credential file"));
            }
            return Ok(match self.credential_email(&file) {
                Some(email) => AntigravityOAuthState::Ok { email },
                None => error("Incomplete Antigravity OAuth credential"),
            });
        }
        Ok(match self.saved_oauth_email() {
            Some(email) => AntigravityOAuthState::Ok { email },
            None => error("Google sign-in finished but no Antigravity credential was saved"),
        })
    }

    pub fn has_credential(&self) -> bool {
        self.saved_oauth_email().is_some()
    }

    fn credential_names(&self) -> Option<Vec<String>> {
        Some(
            fs::read_dir(&self.auth_dir)
                .ok()?
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect(),
        )
    }

    /// The e-mail of a usable saved credential in the auth folder, if one is there.
    pub fn saved_oauth_email(&self) -> Option<String> {
        self.credential_names()?
            .into_iter()
            .filter(|name| CREDENTIAL_FILE.is_match(name))
            .find_map(|name| self.credential_email(&name))
    }

    /// A credential file CLIProxyAPI saved: a regular file of the antigravity type with an
    /// e-mail and a refresh token. The Google Cloud project is optional.
    fn credential_email(&self, file: &str) -> Option<String> {
        let path = self.auth_dir.join(file);
        let stat = fs::symlink_metadata(&path).ok()?;
        if !stat.is_file() || stat.len() > 65_536 {
            return None;
        }
        let data: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
        let email = data.get("email")?.as_str()?;
        let refresh = data.get("refresh_token")?.as_str()?;
        (data.get("type").and_then(Value::as_str) == Some("antigravity")
            && email.contains('@')
            && !refresh.is_empty())
        .then(|| email.to_owned())
    }

    /// The Google Cloud project the saved credential names, if it names one (not a secret).
    pub fn project_id(&self) -> Option<String> {
        for name in self.credential_names()? {
            if !CREDENTIAL_FILE.is_match(&name) || self.credential_email(&name).is_none() {
                continue;
            }
            let data: Option<Value> = fs::read(self.auth_dir.join(&name))
                .ok()
                .and_then(|d| serde_json::from_slice(&d).ok());
            if let Some(project) = data
                .as_ref()
                .and_then(|d| d.get("project_id"))
                .and_then(Value::as_str)
                .filter(|p| PROJECT.is_match(p))
            {
                return Some(project.to_owned());
            }
        }
        None
    }

    /// One POST to Google with the saved sign-in, sent by CLIProxyAPI's management `api-call`
    /// so the token is put in (and renewed) by the sidecar. Only Code Assist's own hosts are
    /// asked.
    pub fn google_call(
        &self,
        request: &GoogleRequest,
    ) -> Result<GoogleAnswer, AntigravityBridgeError> {
        let url = url::Url::parse(&request.url).map_err(|e| fail(e.to_string()))?;
        if url.scheme() != "https" || !url.host_str().is_some_and(|h| CODE_ASSIST_HOST.is_match(h))
        {
            return Err(fail("Not a Code Assist address"));
        }
        let listed = self.management("/auth-files", None).or_else(|e| {
            older_route(e, || {
                self.management_at("/v0/management", "/auth-files", None)
            })
        })?;
        let file = listed
            .get("files")
            .and_then(Value::as_array)
            .and_then(|files| {
                files.iter().find(|f| {
                    let antigravity = f.get("provider").and_then(Value::as_str)
                        == Some("antigravity")
                        || f.get("type").and_then(Value::as_str) == Some("antigravity");
                    antigravity
                        && f.get("disabled") != Some(&Value::Bool(true))
                        && f.get("auth_index").is_some_and(Value::is_string)
                })
            })
            .ok_or_else(|| fail("No Antigravity credential in the sidecar"))?;
        // An Antigravity client string, the caller's when it names one (the quota summary wants
        // 2.x).
        let agent = request
            .user_agent
            .as_deref()
            .filter(|a| AGENT.is_match(a))
            .unwrap_or("antigravity/1.11.5 darwin/arm64");
        let body = json!({
            "auth_index": file.get("auth_index"),
            "method": "POST",
            "url": request.url,
            "header": {
                "Authorization": "Bearer $TOKEN$",
                "Content-Type": "application/json",
                "User-Agent": agent,
            },
            "data": request.body,
        });
        let answer = self.management("/api-call", Some(&body)).or_else(|e| {
            older_route(e, || {
                self.management_at("/v0/management", "/api-call", Some(&body))
            })
        })?;
        let status = answer
            .get("status_code")
            .and_then(Value::as_f64)
            .map_or(502, |s| s as u16);
        let header = answer.get("header");
        let retry = header
            .and_then(|h| h.get("Retry-After").filter(|v| !v.is_null()))
            .or_else(|| header.and_then(|h| h.get("retry-after")));
        let retry_after = match retry {
            Some(Value::String(text)) => Some(text.clone()),
            Some(Value::Array(list)) => list.first().and_then(Value::as_str).map(str::to_owned),
            _ => None,
        };
        let body = match answer.get("body") {
            Some(Value::String(text)) => text.clone(),
            Some(value @ (Value::Object(_) | Value::Array(_))) => value.to_string(),
            _ => String::new(),
        };
        Ok(GoogleAnswer {
            status,
            retry_after,
            body,
        })
    }

    pub fn stop(&self) {
        let mut process = self.process();
        if let Some(mut child) = process.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        process.port = None;
    }
}

impl Drop for AntigravityBridge {
    fn drop(&mut self) {
        self.stop();
    }
}
