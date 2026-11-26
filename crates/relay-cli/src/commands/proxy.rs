use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use relay_core::provider_credentials::{CodexReadOptions, read_codex_credential};
use relay_core::relay_paths::Platform;
use relay_core::shared::feature_risk::{GatewayRiskConfig, PoolAccount, gateway_risks};
use relay_core::shared::proxy_url::{LOOPBACK_HOSTS, client_host, gateway_host_allowed};
use relay_core::shared::types::AccountProvider;
use relay_core::store::Store;
use relay_core::usage_credentials::{MISSING_RETRY_MS, read_credential};
use relay_gateway::credential_cache::{CredentialCache, ReadCredential};
use relay_gateway::proxy_server::{GatewayHooks, ProxyServer, StartError, Upstreams};
use relay_gateway::proxy_status::generate_proxy_key;
use relay_gateway::types::{
    Account as GatewayAccount, AccountUsage as GatewayUsage, ProxyConfig, UsageSnapshot,
};
use relay_i18n::Args;
use serde_json::{Map, Value};

use crate::CommandRun;
use crate::context::{CliContext, Needs, open_context};
use crate::errors::{CliResult, Failure};
use crate::i18n::T;
use crate::io::{CliError, CliIo, exit};
use crate::json::number_text;
use crate::output::{Style, color_enabled, paint, print_json};
use crate::risk::require_risk_consent;
use crate::usage_reader::usage_manager;
use crate::util::js_number;

/// How often limits are re-read, so routing follows the real 5-hour and weekly windows.
const USAGE_REFRESH_MS: u64 = 2 * 60_000;
const STATUS_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_PORT: u16 = 8317;
const DEFAULT_HOST: &str = "127.0.0.1";

fn parse_port(raw: Option<&str>, t: T) -> Result<u16, CliError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_PORT);
    };
    let digits = !raw.is_empty() && raw.len() <= 5 && raw.bytes().all(|b| b.is_ascii_digit());
    match raw.parse::<u32>() {
        Ok(port) if digits && (1..=65_535).contains(&port) => Ok(port as u16),
        _ => Err(CliError::new(
            t.t("proxy.portMustBeANumberFrom"),
            exit::USAGE,
        )),
    }
}

/// `--host`: this computer only, or its Tailscale address, as in Relay's Proxy page.
fn parse_host(raw: Option<&str>, t: T) -> Result<String, CliError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_HOST.into());
    };
    let host = relay_core::store::schema::js_trim(raw);
    if !gateway_host_allowed(host) {
        return Err(CliError::new(t.t("proxy.use127001Localhost"), exit::USAGE));
    }
    Ok(host.to_owned())
}

/// The lines that point Claude Code and OpenAI-style clients at the gateway.
fn env_lines(url: &str, key: Option<&str>) -> Vec<String> {
    let shown = key.unwrap_or("<relay-key>");
    vec![
        format!("export ANTHROPIC_BASE_URL=\"{url}\""),
        format!("export ANTHROPIC_AUTH_TOKEN=\"{shown}\""),
        // Behind a gateway Claude Code caches for 5 minutes unless told the subscription's hour.
        "export CLAUDE_CODE_PROMPT_CACHE_TTL=\"1h\"".to_owned(),
        format!("export OPENAI_BASE_URL=\"{url}/v1\""),
        format!("export OPENAI_API_KEY=\"{shown}\""),
    ]
}

/// Reads the gateway's /status; fails when nothing answers or the answer is not JSON.
fn fetch_status(host: &str, port: u16, key: Option<&str>) -> Result<Value, String> {
    // Plain HTTP on this computer; reqwest still wants a TLS setup to build.
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    let client = reqwest::blocking::Client::builder()
        .tls_backend_preconfigured(tls)
        .no_proxy()
        .timeout(Duration::from_millis(STATUS_TIMEOUT_MS))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(format!("http://{}:{port}/status", client_host(host)));
    if let Some(key) = key {
        request = request.header("x-relay-key", key);
    }
    let response = request.send().map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    use std::io::Read;
    response
        .take(1_000_001)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() > 1_000_000 {
        return Err("response too large".into());
    }
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

/// `${value}` in a template literal.
fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => number_text(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    template(Some(v))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `x.toFixed(1)`: ties round up, as JS rounds the exact value.
fn to_fixed1(x: f64) -> String {
    if !x.is_finite() {
        return number_text(x);
    }
    let exact = format!("{:.40}", x.abs());
    let frac = exact.split_once('.').map_or("", |(_, f)| f);
    let tie = frac.len() > 1 && frac.as_bytes()[1] == b'5' && frac[2..].bytes().all(|b| b == b'0');
    let rounded = if tie {
        format!("{:.1}", x.abs() + 0.01)
    } else {
        format!("{:.1}", x.abs())
    };
    if x < 0.0 && rounded.bytes().any(|b| (b'1'..=b'9').contains(&b)) {
        format!("-{rounded}")
    } else {
        rounded
    }
}

/// `Number(value ?? 0)`.
fn number_of(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::String(s)) => js_number(s),
        Some(_) => f64::NAN,
    }
}

/// `RELAY_PROXY_UPSTREAMS`: local stand-ins for the provider APIs, for tests and parity recordings.
pub fn parse_upstreams(raw: Option<&str>) -> Result<Option<Upstreams>, CliError> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    // Worded so redact() keeps it: "is not valid JSON" reads as a parser error and is replaced.
    let Ok(Value::Object(value)) = serde_json::from_str::<Value>(raw) else {
        return Err(CliError::new(
            "RELAY_PROXY_UPSTREAMS does not hold a JSON object.",
            exit::USAGE,
        ));
    };
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(Some(Upstreams {
        anthropic_url: text("anthropicUrl"),
        codex_url: text("codexUrl"),
        openai_url: text("openaiUrl"),
        codex_websocket_url: text("codexWebSocketUrl"),
    }))
}

/// The gateway's view of an account or a reading, through their shared JSON shape.
fn convert<A: serde::Serialize, B: serde::de::DeserializeOwned>(value: &A) -> Option<B> {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
}

/// What `relay proxy start` gives its gateway: sign-ins read on demand and reused for 20 s, the
/// registry's accounts, and the limits read in the background.
struct CliHooks {
    store: Arc<Store>,
    security_tool: PathBuf,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    credentials: CredentialCache,
    usage: Arc<Mutex<HashMap<String, GatewayUsage>>>,
}

impl CliHooks {
    fn read(&self, account: &GatewayAccount) -> Option<ReadCredential> {
        let profile = self.store.profile(&account.id).ok()?;
        if account.provider().as_str() == "codex" {
            let now = (self.now)() as f64;
            let cred = read_codex_credential(
                &profile,
                &CodexReadOptions {
                    now: Some(now),
                    cli_files: None,
                },
            )?;
            return Some(ReadCredential {
                access_token: cred.access_token,
                expires_at: cred.expires_at.map(|e| e as i64),
            });
        }
        let cred = read_credential(
            &profile,
            false,
            Some(&self.security_tool),
            Platform::current(),
            MISSING_RETRY_MS,
        )
        .ok()?;
        Some(ReadCredential {
            access_token: cred.access_token,
            expires_at: cred.expires_at.map(|e| e as i64),
        })
    }
}

#[async_trait]
impl GatewayHooks for CliHooks {
    async fn credential(&self, account: &GatewayAccount) -> Result<Option<String>, String> {
        let now = (self.now)();
        if let Some(token) = self.credentials.get(&account.id, now) {
            return Ok(Some(token));
        }
        let Some(read) = tokio::task::block_in_place(|| self.read(account)) else {
            return Ok(None);
        };
        Ok(self.credentials.accept(&account.id, read, (self.now)()))
    }

    fn usage(&self) -> Arc<UsageSnapshot> {
        let accounts = self
            .store
            .with_state(|s| s.accounts.iter().filter_map(convert).collect());
        let usage_map = self.usage.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Arc::new(UsageSnapshot {
            accounts,
            usage_map,
        })
    }

    fn on_credential_rejected(&self, account_id: &str) {
        self.credentials.forget(account_id);
    }
}

pub fn proxy_command(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let parsed = run.parsed;
    let subcommand = parsed.positionals.first().map_or("status", String::as_str);
    if parsed.positionals.len() > 1 {
        return Err(
            CliError::new(t.t("proxy.relayProxyTakesOneSubcommandStart"), exit::USAGE).into(),
        );
    }
    if !["start", "status", "env"].contains(&subcommand) {
        return Err(CliError::new(
            t.f(
                "proxy.unknownProxySubcommandExpectedStart",
                Args::new().set("subcommand", subcommand),
            ),
            exit::USAGE,
        )
        .into());
    }
    let port = parse_port(parsed.flags.str("port"), t)?;
    let host = parse_host(parsed.flags.str("host"), t)?;
    let color = color_enabled(io, &parsed.flags);
    let url = format!("http://{}:{port}", client_host(&host));

    // The client key Relay.app made for its gateway; `relay proxy start` uses it too.
    let ctx = open_context(io, run.deps, &parsed.flags, Needs::READ)?;
    let saved_key = ctx
        .store
        .with_state(|s| s.settings.proxy.as_ref().and_then(|p| p.api_key.clone()));

    if subcommand == "env" {
        // Plain lines: the output is meant for `eval "$(relay proxy env)"`.
        for line in env_lines(&url, saved_key.as_deref()) {
            io.out(&line);
        }
        if saved_key.is_none() {
            io.err(&t.t("proxy.noClientKeyYetOpenThe"));
        }
        return Ok(exit::OK);
    }

    if subcommand == "status" {
        let json = parsed.flags.truthy("json");
        match fetch_status(&host, port, saved_key.as_deref()) {
            Ok(data) => {
                if json {
                    let mut out = Map::new();
                    out.insert("running".into(), Value::Bool(true));
                    if let Value::Object(fields) = &data {
                        for (k, v) in fields {
                            out.insert(k.clone(), v.clone());
                        }
                    }
                    print_json(io, &Value::Object(out));
                } else {
                    let state = data.get("state");
                    let metrics = data.get("metrics");
                    io.out(&paint(
                        color,
                        Style::Green,
                        &format!("Relay Proxy Gateway is running on {host}:{port}"),
                    ));
                    io.out(&format!(
                        "Status: {}",
                        template(state.and_then(|s| s.get("status")))
                    ));
                    io.out(&format!(
                        "Active Sessions: {}",
                        template(state.and_then(|s| s.get("activeSessionsCount")))
                    ));
                    io.out(&format!(
                        "Total Requests: {}",
                        template(metrics.and_then(|m| m.get("totalRequests")))
                    ));
                    let ratio = number_of(metrics.and_then(|m| m.get("cacheHitRatio")));
                    io.out(&format!("Cache Hit Ratio: {}%", to_fixed1(ratio * 100.0)));
                }
            }
            Err(_) => {
                if json {
                    print_json(
                        io,
                        &serde_json::json!({ "running": false, "port": port, "host": host }),
                    );
                } else {
                    io.out(&paint(
                        color,
                        Style::Dim,
                        &format!("Relay Proxy Gateway is NOT running on {host}:{port}"),
                    ));
                    io.out("Run 'relay proxy start' to start the local gateway.");
                }
            }
        }
        return Ok(exit::OK);
    }
    start(&ctx, io, t, host, port, url, saved_key, color)
}

#[allow(clippy::too_many_arguments)]
fn start(
    ctx: &CliContext,
    io: &CliIo,
    t: T,
    host: String,
    port: u16,
    url: String,
    saved_key: Option<String>,
    color: bool,
) -> CliResult<i32> {
    let registry = ctx.store.state();
    // The same risks the app asks about before its gateway starts; this gateway has no
    // Antigravity helper, so only Claude, Codex and the tailnet apply.
    let pool: Vec<PoolAccount> = registry
        .accounts
        .iter()
        .filter(|a| a.provider != Some(AccountProvider::Antigravity))
        .map(|a| PoolAccount::new(a.id.clone(), a.provider.map(|p| p.as_str())))
        .collect();
    let risks = gateway_risks(
        &GatewayRiskConfig {
            host: &host,
            ..Default::default()
        },
        &pool,
    );
    require_risk_consent(
        io,
        t,
        Some(&registry.settings.risk_acknowledged),
        &risks,
        ctx.flags.is_true("yes"),
    )?;

    // Always with a client key, so no other local process can spend the accounts.
    let key = saved_key.clone().unwrap_or_else(generate_proxy_key);
    let upstreams = if cfg!(any(debug_assertions, feature = "parity")) {
        parse_upstreams(io.var("RELAY_PROXY_UPSTREAMS"))?.unwrap_or_default()
    } else {
        Upstreams::default()
    };
    let usage = Arc::new(Mutex::new(HashMap::new()));
    let now = io.now.clone();
    let hooks = Arc::new(CliHooks {
        store: ctx.store.clone(),
        security_tool: ctx.deps.security_tool.clone(),
        now: Arc::new(move || now()),
        credentials: CredentialCache::new(),
        usage: usage.clone(),
    });
    let config = ProxyConfig {
        host: host.clone(),
        port,
        enabled: true,
        api_key: Some(key.clone()),
        ..ProxyConfig::default()
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| Failure::Other(e.to_string()))?;
    let proxy = ProxyServer::new(config, hooks, upstreams);

    io.out(&paint(
        color,
        Style::Cyan,
        &format!("Starting Relay Proxy Gateway on {host}:{port}..."),
    ));
    let state = match runtime.block_on(proxy.start()) {
        Ok(state) => state,
        Err(StartError::AddrInUse(_)) => {
            return Err(CliError::new(
                t.f(
                    "proxy.isAlreadyInUseTryAnother",
                    Args::new().set("host", host.as_str()).set("port", port),
                ),
                exit::BUSY,
            )
            .into());
        }
        Err(StartError::Other(message)) => {
            return Err(CliError::new(
                t.f(
                    "proxy.theGatewayCouldNotStart",
                    Args::new().set("message", message),
                ),
                exit::FAILED,
            )
            .into());
        }
    };
    io.out(&paint(
        color,
        Style::Green,
        &format!("✓ Gateway listening on {}", state.endpoint_url),
    ));
    if !LOOPBACK_HOSTS.contains(&host.as_str()) {
        io.err(&paint(
            color,
            Style::Yellow,
            &t.f(
                "proxy.warningIsNotALoopbackAddress",
                Args::new().set("host", host.as_str()),
            ),
        ));
    }
    if saved_key.is_none() {
        io.out(&t.t("proxy.aClientKeyWasMadeFor"));
    }
    io.out(&paint(color, Style::Yellow, &t.t("proxy.setInYourClient")));
    for line in env_lines(&url, Some(&key)) {
        io.out(&format!("  {line}"));
    }

    // Keep the limits (and the account list) current in the background.
    let manager = usage_manager(ctx, None);
    let store = ctx.store.clone();
    let _ = std::thread::Builder::new()
        .name("relay-usage".into())
        .spawn(move || {
            loop {
                // Keep routing on the list already loaded when it cannot be read.
                let _ = store.reload();
                for account in store.state().accounts {
                    if !account.auth.as_ref().is_some_and(|a| a.logged_in) {
                        continue;
                    }
                    // Routing falls back to what it last knew, or to no data for this account.
                    if let Ok(reading) = manager.refresh(&account.id, false)
                        && let Some(reading) = convert::<_, GatewayUsage>(&reading)
                    {
                        usage
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(account.id.clone(), reading);
                    }
                }
                std::thread::sleep(Duration::from_millis(USAGE_REFRESH_MS));
            }
        });

    let (signals, mut received) = tokio::sync::mpsc::unbounded_channel::<()>();
    io.signal(Some(Arc::new(move |_| {
        let _ = signals.send(());
    })));
    let stdout = io.stdout.clone();
    runtime.block_on(async {
        received.recv().await;
        stdout(&paint(
            color,
            Style::Yellow,
            "\nStopping Relay Proxy Gateway...",
        ));
        // A second Ctrl+C leaves at once.
        tokio::select! {
            () = proxy.stop() => {}
            _ = received.recv() => {}
        }
    });
    io.signal(None);
    runtime.block_on(proxy.stop());
    Ok(exit::OK)
}
