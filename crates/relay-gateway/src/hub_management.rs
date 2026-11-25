//! The CLIProxyAPI management calls usage dashboards make of a "hub" (`hub-management.ts`):
//! list the accounts, read an account's usage through its own sign-in, clear a cooldown.
//! `api-call` sends only the provider's own usage and reset-credit requests, with only the
//! headers those need, so an account's token can never be sent anywhere else.

use crate::types::{Account, Provider};
use async_trait::async_trait;
use serde_json::{Map, Value, json};
use std::time::Duration;

pub const HUB_PREFIX: &str = "/v0/management/";

/// What each provider's token may be sent to, by method.
const CLAUDE_ALLOWED: [(&str, &str); 1] = [("GET", "https://api.anthropic.com/api/oauth/usage")];
const CODEX_ALLOWED: [(&str, &str); 3] = [
    ("GET", "https://chatgpt.com/backend-api/wham/usage"),
    (
        "GET",
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ),
    (
        "POST",
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    ),
];

/// Headers passed on, by lower-case name; anything else is dropped.
const PASSED_HEADERS: [&str; 7] = [
    "authorization",
    "content-type",
    "openai-beta",
    "originator",
    "chatgpt-account-id",
    "anthropic-beta",
    "user-agent",
];

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_DATA_BYTES: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

/// One request a dashboard asked the hub to send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubRequest {
    pub url: String,
    pub method: String,
    /// In the order the dashboard gave them, `Authorization` last when Relay added it.
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubResponse {
    pub status: u16,
    pub text: String,
}

/// Sends a hub request (tests replace it). Redirects are errors, as `redirect: "error"`.
#[async_trait]
pub trait HubFetch: Send + Sync {
    async fn fetch(&self, request: HubRequest) -> Result<HubResponse, String>;
}

/// The real sender: no redirects, a 15 s deadline.
pub struct DefaultHubFetch {
    client: reqwest::Client,
}

impl Default for DefaultHubFetch {
    fn default() -> Self {
        DefaultHubFetch {
            client: reqwest::Client::builder()
                .tls_backend_preconfigured(crate::upstream_common::tls_config())
                .no_proxy()
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    attempt.error("redirect")
                }))
                .timeout(TIMEOUT)
                .build()
                .expect("the hub client builds"),
        }
    }
}

#[async_trait]
impl HubFetch for DefaultHubFetch {
    async fn fetch(&self, request: HubRequest) -> Result<HubResponse, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder.send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|e| e.to_string())?;
        Ok(HubResponse { status, text })
    }
}

/// What a management call needs from the gateway.
#[async_trait]
pub trait HubDeps: Send + Sync {
    /// The accounts the gateway may route to.
    fn accounts(&self) -> Vec<Account>;
    /// The account's token, as the gateway would send it.
    async fn credential(&self, account: &Account) -> Option<String>;
    /// Clears the gateway's own cooldown for the account.
    fn clear_cooldown(&self, account_id: &str);
    fn fetch(&self) -> &dyn HubFetch;
}

#[derive(Clone, Debug, PartialEq)]
pub struct HubAnswer {
    pub status: u16,
    pub body: Value,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HubProvider {
    Claude,
    Codex,
}

fn hub_provider(account: &Account) -> Option<HubProvider> {
    let logged_in = account.auth.as_ref().is_some_and(|a| a.logged_in);
    match account.provider() {
        Provider::Claude => logged_in.then_some(HubProvider::Claude),
        // Only a ChatGPT sign-in has the usage endpoints; an OpenAI API key has none.
        Provider::Codex => (logged_in
            && account
                .auth
                .as_ref()
                .and_then(|a| a.account_uuid.as_deref())
                .is_some_and(|u| !u.is_empty()))
        .then_some(HubProvider::Codex),
        _ => None,
    }
}

/// `auth-files`: the pool's Claude and Codex accounts in CLIProxyAPI's shape.
pub fn auth_files(accounts: &[Account]) -> Value {
    let files: Vec<Value> = accounts
        .iter()
        .filter_map(|account| {
            let provider = hub_provider(account)?;
            let mut file = Map::new();
            file.insert("id".into(), json!(account.id));
            file.insert("auth_index".into(), json!(account.id));
            file.insert(
                "provider".into(),
                json!(match provider {
                    HubProvider::Claude => "claude",
                    HubProvider::Codex => "codex",
                }),
            );
            file.insert("label".into(), json!(account.name));
            let auth = account.auth.as_ref();
            if let Some(email) = auth.and_then(|a| a.email.as_deref()).filter(|e| !e.is_empty()) {
                file.insert("email".into(), json!(email));
            }
            file.insert("disabled".into(), json!(false));
            if provider == HubProvider::Codex {
                let mut token = Map::new();
                token.insert(
                    "chatgpt_account_id".into(),
                    json!(auth.and_then(|a| a.account_uuid.clone())),
                );
                if let Some(plan) = auth
                    .and_then(|a| a.subscription.as_deref())
                    .filter(|s| !s.is_empty())
                {
                    token.insert("plan_type".into(), json!(plan.to_lowercase()));
                }
                file.insert("id_token".into(), Value::Object(token));
            }
            Some(Value::Object(file))
        })
        .collect();
    json!({ "files": files })
}

fn error(status: u16, message: &str) -> HubAnswer {
    HubAnswer {
        status,
        body: json!({ "error": message }),
    }
}

/// `api-call`: one allowed request with the account's own token, answered as
/// `{status_code, body}`.
pub async fn api_call(input: Option<&Value>, deps: &dyn HubDeps) -> HubAnswer {
    let Some(input) = input.filter(|v| v.is_object() || v.is_array()) else {
        return error(400, "invalid body");
    };
    let (Some(auth_index), Some(url)) = (
        input.get("auth_index").and_then(Value::as_str),
        input.get("url").and_then(Value::as_str),
    ) else {
        return error(400, "missing auth_index or url");
    };
    let verb = match input.get("method") {
        None => "GET",
        Some(Value::String(m)) if m == "GET" || m == "POST" => m.as_str(),
        Some(_) => return error(400, "unsupported method"),
    };
    let accounts = deps.accounts();
    let account = accounts.iter().find(|a| a.id == auth_index);
    let Some((account, provider)) = account.and_then(|a| Some((a, hub_provider(a)?))) else {
        return error(404, "unknown account");
    };
    let allowed: &[(&str, &str)] = match provider {
        HubProvider::Claude => &CLAUDE_ALLOWED,
        HubProvider::Codex => &CODEX_ALLOWED,
    };
    if !allowed.iter().any(|(m, u)| *m == verb && *u == url) {
        return error(
            403,
            "Relay only sends an account's token to its provider's usage requests",
        );
    }
    let data = match input.get("data") {
        None => None,
        Some(Value::String(d)) if crate::js::units(d) <= MAX_DATA_BYTES => Some(d.clone()),
        Some(_) => return error(400, "invalid data"),
    };
    let token = deps.credential(account).await;
    // A ChatGPT usage request needs the sign-in's token; an API key would only be refused.
    let Some(token) = token.filter(|t| {
        !t.is_empty() && !(provider == HubProvider::Codex && t.starts_with("sk-"))
    }) else {
        return HubAnswer {
            status: 200,
            body: json!({ "status_code": 401, "body": "" }),
        };
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(Value::Object(given)) = input.get("header") {
        for (name, value) in given {
            if let Value::String(value) = value {
                if PASSED_HEADERS.contains(&name.to_lowercase().as_str()) {
                    headers.push((name.clone(), value.replace("$TOKEN$", &token)));
                }
            }
        }
    }
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
    {
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    let request = HubRequest {
        url: url.to_string(),
        method: verb.to_string(),
        headers,
        body: if verb == "POST" { data } else { None },
    };
    match deps.fetch().fetch(request).await {
        Ok(response) => HubAnswer {
            status: 200,
            body: json!({
                "status_code": response.status,
                "body": if crate::js::units(&response.text) > MAX_RESPONSE_BYTES { String::new() } else { response.text },
            }),
        },
        Err(_) => HubAnswer {
            status: 200,
            body: json!({ "status_code": 502, "body": "" }),
        },
    }
}

/// `reset-quota`: the account may be picked again at once.
pub fn reset_quota(input: Option<&Value>, deps: &dyn HubDeps) -> HubAnswer {
    let index = input.and_then(|v| v.get("auth_index")).and_then(Value::as_str);
    let Some(index) = index.filter(|id| deps.accounts().iter().any(|a| a.id == *id)) else {
        return error(404, "unknown account");
    };
    deps.clear_cooldown(index);
    HubAnswer {
        status: 200,
        body: json!({ "status": "ok" }),
    }
}

/// Routes one management call; `None` when the path is not one Relay answers.
pub async fn hub_management(
    method: &str,
    path: &str,
    body: Option<&Value>,
    deps: &dyn HubDeps,
) -> Option<HubAnswer> {
    let call = path.strip_prefix(HUB_PREFIX).unwrap_or(path);
    match (method, call) {
        ("GET", "auth-files") => Some(HubAnswer {
            status: 200,
            body: auth_files(&deps.accounts()),
        }),
        ("POST", "api-call") => Some(api_call(body, deps).await),
        ("POST", "reset-quota") => Some(reset_quota(body, deps)),
        _ => None,
    }
}
