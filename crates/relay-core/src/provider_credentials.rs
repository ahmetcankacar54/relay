//! Port of `electron/core/provider-credentials.ts`: a Codex account's sign-in, kept in its Relay
//! profile (mode 0600). A ChatGPT sign-in's refresh token is never copied: two holders of one
//! rotating refresh token log each other out.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::clock::now_ms;
use crate::relay_paths::home_dir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexCredentialKind {
    ApiKey,
    Chatgpt,
}

/// A Codex account's sign-in: an OpenAI API key, or a ChatGPT access token copied from the CLI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredential {
    pub kind: CodexCredentialKind,
    pub access_token: String,
    /// ms; only a ChatGPT token has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<f64>,
    /// The ChatGPT account the token belongs to (`chatgpt_account_id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

const FILE: &str = "provider-credential.json";

/// The payload of a three-part JWT, when it is a JSON object (arrays count, as in JS).
pub fn decode_jwt_payload(token: Option<&str>) -> Option<Value> {
    let token = token.filter(|t| !t.is_empty())?;
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    // Node's base64url decoder ignores padding and stops at the first character it cannot read.
    let clean: String = parts[1]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '='))
        .filter(|c| *c != '=')
        .collect();
    let usable = match clean.len() % 4 {
        1 => &clean[..clean.len() - 1],
        _ => &clean[..],
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(usable)
        .ok()?;
    let parsed: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    matches!(parsed, Value::Object(_) | Value::Array(_)).then_some(parsed)
}

/// The ms expiry an access token states about itself (`exp`), if it is a JWT.
pub fn token_expiry(token: &str) -> Option<f64> {
    decode_jwt_payload(Some(token))?
        .get("exp")?
        .as_f64()
        .map(|exp| exp * 1000.0)
}

/// The ChatGPT account and plan an OpenAI token's claims name.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatgptClaims {
    pub account_id: Option<String>,
    pub plan: Option<String>,
    pub email: Option<String>,
}

pub fn chatgpt_claims(token: Option<&str>) -> ChatgptClaims {
    let payload = decode_jwt_payload(token);
    let text = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let auth = payload
        .as_ref()
        .and_then(|p| p.get("https://api.openai.com/auth"));
    let profile = payload
        .as_ref()
        .and_then(|p| p.get("https://api.openai.com/profile"));
    ChatgptClaims {
        account_id: text(auth.and_then(|a| a.get("chatgpt_account_id"))),
        plan: text(auth.and_then(|a| a.get("chatgpt_plan_type"))),
        email: text(payload.as_ref().and_then(|p| p.get("email")))
            .or_else(|| text(profile.and_then(|p| p.get("email")))),
    }
}

/// A JSON object file of at most 1 MiB; None for anything else.
fn read_json(file: &Path) -> Option<Map<String, Value>> {
    let meta = fs::symlink_metadata(file).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    match serde_json::from_str(&String::from_utf8_lossy(&fs::read(file).ok()?)).ok()? {
        Value::Object(obj) => Some(obj),
        _ => None,
    }
}

/// Saves the credential as `{provider: "codex", ...}` through a 0600 temporary file.
pub fn write_codex_credential(
    profile_dir: &Path,
    credential: &CodexCredential,
) -> std::io::Result<()> {
    crate::fs_util::create_private_dir_all(profile_dir)?;
    let target = profile_dir.join(FILE);
    let tmp = PathBuf::from(format!(
        "{}.{}.tmp",
        target.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let mut value = Map::new();
    value.insert("provider".into(), "codex".into());
    if let Value::Object(fields) = serde_json::to_value(credential)? {
        value.extend(fields);
    }
    let result = (|| {
        let mut handle = crate::fs_util::create_new_private(&tmp)?;
        handle.write_all(&crate::desktop_files::json_bytes(&value))?;
        drop(handle);
        fs::rename(&tmp, &target)
    })();
    let _ = fs::remove_file(&tmp);
    result
}

/// Where the Codex CLI keeps its sign-in.
pub fn codex_auth_files(home: Option<&Path>) -> Vec<PathBuf> {
    let home = home.map_or_else(home_dir, Path::to_path_buf);
    vec![
        home.join(".codex").join("auth.json"),
        home.join(".config").join("codex").join("auth.json"),
    ]
}

/// The Codex CLI's current ChatGPT access token and the account it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCliSession {
    pub access_token: String,
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// The Codex CLI's current ChatGPT sign-in, if it is signed in.
pub fn read_codex_cli_session(files: &[PathBuf]) -> Option<CodexCliSession> {
    for file in files {
        let Some(auth) = read_json(file) else {
            continue;
        };
        let tokens = auth.get("tokens").filter(|t| t.is_object() || t.is_array());
        let Some(access_token) = tokens
            .and_then(|t| t.get("access_token"))
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        let from_access = chatgpt_claims(Some(access_token));
        let from_id = chatgpt_claims(
            tokens
                .and_then(|t| t.get("id_token"))
                .and_then(Value::as_str),
        );
        let account_id = tokens
            .and_then(|t| t.get("account_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or(from_access.account_id.clone())
            .or(from_id.account_id.clone());
        return Some(CodexCliSession {
            access_token: access_token.to_owned(),
            account_id,
            email: from_id.email.or(from_access.email),
            plan: from_id.plan.or(from_access.plan),
        });
    }
    None
}

/// An OpenAI API key the Codex CLI or the environment holds.
pub fn read_open_ai_api_key(
    files: &[PathBuf],
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    for file in files {
        if let Some(key) = read_json(file)
            .as_ref()
            .and_then(|a| a.get("OPENAI_API_KEY"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|k| !k.is_empty())
        {
            return Some(key.to_owned());
        }
    }
    env("OPENAI_API_KEY")
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty())
}

/// Options of `read_codex_credential`: the clock and the Codex CLI's files.
#[derive(Debug, Clone, Default)]
pub struct CodexReadOptions {
    pub now: Option<f64>,
    pub cli_files: Option<Vec<PathBuf>>,
}

/// A Codex account's usable sign-in. For a ChatGPT sign-in, the Codex CLI's own token is used
/// while it is signed in to the same ChatGPT account; otherwise the copy saved when the account
/// was connected, until it expires. 0.18 builds saved the token in `.credentials.json` under
/// `claudeAiOauth`; that is still read.
pub fn read_codex_credential(
    profile_dir: &Path,
    options: &CodexReadOptions,
) -> Option<CodexCredential> {
    let now = options.now.unwrap_or_else(|| now_ms() as f64);
    let file = read_json(&profile_dir.join(FILE));
    let saved = match file.as_ref().filter(|f| {
        f.get("accessToken")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.is_empty())
    }) {
        Some(file) => CodexCredential {
            kind: if file.get("kind").and_then(Value::as_str) == Some("api-key") {
                CodexCredentialKind::ApiKey
            } else {
                CodexCredentialKind::Chatgpt
            },
            access_token: file["accessToken"].as_str().unwrap_or_default().to_owned(),
            expires_at: file.get("expiresAt").and_then(Value::as_f64),
            account_id: file
                .get("accountId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        None => {
            let legacy = read_json(&profile_dir.join(".credentials.json"));
            let token = legacy
                .as_ref()
                .and_then(|l| l.get("claudeAiOauth"))
                .and_then(|o| o.get("accessToken"))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())?;
            let api_key = token.starts_with("sk-");
            CodexCredential {
                kind: if api_key {
                    CodexCredentialKind::ApiKey
                } else {
                    CodexCredentialKind::Chatgpt
                },
                access_token: token.to_owned(),
                expires_at: if api_key { None } else { token_expiry(token) }.filter(|e| *e != 0.0),
                account_id: if api_key {
                    None
                } else {
                    chatgpt_claims(Some(token)).account_id
                },
            }
        }
    };
    if saved.kind == CodexCredentialKind::ApiKey {
        return Some(saved);
    }
    if let Some(account_id) = &saved.account_id {
        let files = options
            .cli_files
            .clone()
            .unwrap_or_else(|| codex_auth_files(None));
        if let Some(live) = read_codex_cli_session(&files)
            && live.account_id.as_ref() == Some(account_id)
        {
            let expires_at = token_expiry(&live.access_token);
            if expires_at.is_none_or(|e| e > now) {
                return Some(CodexCredential {
                    access_token: live.access_token,
                    expires_at: expires_at.filter(|e| *e != 0.0).or(saved.expires_at),
                    ..saved
                });
            }
        }
    }
    if saved.expires_at.is_some_and(|e| e <= now) {
        None
    } else {
        Some(saved)
    }
}
