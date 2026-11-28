//! Port of electron/main/gateway.ts and gateway-requests.ts: the Proxy Gateway's settings,
//! sign-ins, start and stop (Settings → Proxy). The gateway runs in-process
//! (`relay_gateway::ProxyServer` on this module's own tokio runtime) instead of the Electron
//! build's `relay __gateway` sidecar.

pub mod clients;
mod hooks;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use relay_core::clock::now_ms;
use relay_core::overflow_keys::OverflowKeys;
use relay_core::provider_credentials::{CodexReadOptions, read_codex_credential};
use relay_core::relay_paths::Platform;
use relay_core::shared::overflow::OverflowSettings;
use relay_core::shared::proxy_types::{
    AFFINITY_REVISION, ClientBindings, DEFAULT_AFFINITY_TTL_SECONDS, DEFAULT_PROXY_HOST,
    ProxyConfig, ProxySessionState, current_affinity_ttl, default_proxy_config,
};
use relay_core::shared::proxy_url::{gateway_host_allowed, gateway_url};
use relay_core::shared::types::{Account, UsageIssue};
use relay_core::usage_credentials::{MISSING_RETRY_MS, read_credential};
use relay_gateway::credential_cache::ReadCredential;
use relay_gateway::overflow::spent_today;
use relay_gateway::proxy_request_log::{GatewayRequestLog, RequestLogOptions};
use relay_gateway::proxy_server::{ProxyServer, StartError, Upstreams};
use relay_gateway::proxy_stats::REQUEST_LOG_SIZE;
use relay_gateway::proxy_status::{
    GatewaySignIn, StatusInput, build_proxy_status, generate_proxy_key, overflow_status,
    parse_proxy_extras, pool_accounts,
};
use relay_gateway::types::{
    Account as GatewayAccount, OverflowStatus, ProxyConfig as GatewayConfig, ProxyRunStatus,
    UsageMap,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use clients::{
    ClientTarget, PROXY_CLIENTS, SavedValues, bind_client, client_statuses, home,
    tailscale_address, unbind_client,
};

use crate::state::{STATE, lock};

/// The gateway's runtime: its listener, connections and upstream requests.
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("relay-gateway")
        .build()
        .expect("the gateway's runtime starts")
});

/// `proxyServer`: the running gateway.
static PROXY_SERVER: Mutex<Option<Arc<ProxyServer>>> = Mutex::new(None);
/// Why the gateway is not running although it is turned on, shown on its page.
static PROXY_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// `proxyQueue`: one start, stop or change at a time.
static PROXY_QUEUE: Mutex<()> = Mutex::new(());
static PROXY_EXTRAS: Mutex<Option<ProxyExtras>> = Mutex::new(None);

/// How a sign-in stood when the gateway last read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignInState {
    Ok,
    Missing,
    Expired,
}

/// Whether the gateway could use each account's sign-in when it last read it, and when.
static GATEWAY_SIGN_INS: LazyLock<Mutex<HashMap<String, (SignInState, i64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Accounts whose sign-in is being read for the gateway page now.
static SIGN_IN_CHECKS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
/// How long a sign-in the gateway has not read stays as it was last seen on its page.
const SIGN_IN_CHECK_MS: i64 = 10 * 60_000;
/// How long a quitting Relay waits for the gateway to let go of its port.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// The overflow upstreams' sealed API keys; none until the vault is open.
static OVERFLOW_KEYS: OnceLock<OverflowKeys> = OnceLock::new();
/// `gatewayRequests()`: the gateway's requests across restarts, loaded on first use.
static REQUEST_LOG: LazyLock<Mutex<GatewayRequestLog>> = LazyLock::new(|| {
    let mut log = GatewayRequestLog::new(
        STATE.paths().data_dir().join("gateway-requests.jsonl"),
        RequestLogOptions {
            feed_size: Some(REQUEST_LOG_SIZE),
            ..Default::default()
        },
    );
    log.load();
    Mutex::new(log)
});

/// The same JSON in another crate's shape (the gateway keeps its own types).
fn convert<A: Serialize, B: DeserializeOwned>(value: &A) -> Option<B> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn gateway_config(config: &ProxyConfig) -> GatewayConfig {
    convert(config).unwrap_or_default()
}

fn gateway_accounts(accounts: &[Account]) -> Vec<GatewayAccount> {
    accounts.iter().filter_map(convert).collect()
}

/// `usage?.snapshot() ?? {}` in the gateway's shape.
fn gateway_usage() -> UsageMap {
    let Some(usage) = STATE.usage.get() else {
        return UsageMap::new();
    };
    usage
        .snapshot()
        .iter()
        .filter_map(|(id, usage)| Some((id.clone(), convert(usage)?)))
        .collect()
}

/// Writes a new file readable by its owner only.
fn write_private(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    io::Write::write_all(&mut options.open(file)?, bytes)
}

fn current() -> Option<Arc<ProxyServer>> {
    lock(&PROXY_SERVER).clone()
}

/// `!!proxyServer`.
pub fn is_running() -> bool {
    lock(&PROXY_SERVER).is_some()
}

/// `serializeProxy`: runs `task` after every start, stop or change before it.
pub fn serialize_proxy<T>(task: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _turn = lock(&PROXY_QUEUE);
    task()
}

/// Runs one of the gateway crate's futures (an overflow test) to its end on the gateway's
/// runtime; never from inside it.
pub fn block_on<F: Future>(future: F) -> F::Output {
    RUNTIME.block_on(future)
}

fn request_log() -> &'static Mutex<GatewayRequestLog> {
    &REQUEST_LOG
}

/// `gatewayRequests().accountFor(requestId)`: the account that served a provider request id.
pub fn gateway_account(request_id: &str) -> Option<String> {
    lock(request_log())
        .account_for(request_id)
        .map(str::to_string)
}

/// The pool order, the accounts left out, the bound clients and the overflow live in their
/// own file beside the registry: the registry's proxy settings are strict, so 0.18.2 (and
/// older) can still read it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyExtras {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    excluded_account_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subagent_overflow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    affinity_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_bindings: Option<ClientBindings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    overflow: Option<OverflowSettings>,
}

fn proxy_extras_file() -> PathBuf {
    STATE.service().store.root().join("proxy-pool.json")
}

fn proxy_extras() -> ProxyExtras {
    let mut cache = lock(&PROXY_EXTRAS);
    if let Some(extras) = cache.as_ref() {
        return extras.clone();
    }
    // Missing or unreadable: an empty pool setup, every account in, no client bound.
    let extras: ProxyExtras = fs::read_to_string(proxy_extras_file())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| parse_proxy_extras(&value).ok())
        .and_then(|extras| convert(&extras))
        .unwrap_or_default();
    *cache = Some(extras.clone());
    extras
}

fn write_proxy_extras(extras: &ProxyExtras) -> Result<(), String> {
    let file = proxy_extras_file();
    let temp = PathBuf::from(format!("{}.tmp", file.display()));
    let text = serde_json::to_string_pretty(extras).map_err(|e| e.to_string())?;
    write_private(&temp, format!("{text}\n").as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&temp, &file).map_err(|e| e.to_string())?;
    *lock(&PROXY_EXTRAS) = Some(extras.clone());
    Ok(())
}

/// `proxySettings()`: the saved settings over the defaults, with proxy-pool.json's parts.
pub fn proxy_settings() -> ProxyConfig {
    let saved = STATE
        .service()
        .store
        .with_state(|state| state.settings.proxy.clone());
    let mut config = saved.unwrap_or_else(default_proxy_config);
    let extras = proxy_extras();
    if extras.account_order.is_some() {
        config.account_order = extras.account_order;
    }
    if extras.excluded_account_ids.is_some() {
        config.excluded_account_ids = extras.excluded_account_ids;
    }
    if extras.subagent_overflow.is_some() {
        config.subagent_overflow = extras.subagent_overflow;
    }
    if extras.affinity_revision.is_some() {
        config.affinity_revision = extras.affinity_revision;
    }
    if extras.client_bindings.is_some() {
        config.client_bindings = extras.client_bindings;
    }
    if extras.overflow.is_some() {
        config.overflow = extras.overflow;
    }
    // A host older Relays accepted (the whole local network) falls back to this computer only.
    if !gateway_host_allowed(&config.host) {
        config.host = DEFAULT_PROXY_HOST.to_string();
    }
    config
}

/// `saveProxySettings`: the registry's part to state.json, the rest to proxy-pool.json.
pub fn save_proxy_settings(config: ProxyConfig) -> Result<(), String> {
    let mut base = config;
    let extras = ProxyExtras {
        account_order: base.account_order.take(),
        excluded_account_ids: base.excluded_account_ids.take(),
        // `false` is left out, as the TS spreads it only when truthy.
        subagent_overflow: base.subagent_overflow.take().filter(|on| *on),
        affinity_revision: base.affinity_revision.take(),
        client_bindings: base.client_bindings.take(),
        overflow: base.overflow.take(),
    };
    let changed =
        serde_json::to_string(&extras).ok() != serde_json::to_string(&proxy_extras()).ok();
    if changed {
        write_proxy_extras(&extras)?;
    }
    STATE
        .service()
        .store
        .update(|state| state.settings.proxy = Some(base))
        .map_err(|error| error.to_string())
}

/// Moves a saved affinity lifetime that is the old five-minute default to the hour Claude
/// Code's cache lives, once: the revision beside the registry says it was done, so a lifetime
/// chosen afterwards stays. Before the gateway starts.
pub fn settle_proxy_affinity() -> Result<(), String> {
    let extras = proxy_extras();
    if extras.affinity_revision.unwrap_or(0) >= AFFINITY_REVISION {
        return Ok(());
    }
    let saved = STATE
        .service()
        .store
        .with_state(|state| state.settings.proxy.clone());
    // Never used: nothing is saved, and the gateway takes the default when it is first turned on.
    let Some(saved) = saved else {
        return write_proxy_extras(&ProxyExtras {
            affinity_revision: Some(AFFINITY_REVISION),
            ..extras
        });
    };
    save_proxy_settings(ProxyConfig {
        affinity_revision: Some(AFFINITY_REVISION),
        affinity_ttl_seconds: current_affinity_ttl(
            Some(saved.affinity_ttl_seconds),
            extras.affinity_revision,
        )
        .unwrap_or(DEFAULT_AFFINITY_TTL_SECONDS),
        ..proxy_settings()
    })
}

/// Where bound clients dial the gateway: the saved address and key (none before the first start).
pub fn client_target(config: &ProxyConfig) -> Option<ClientTarget> {
    let key = config.api_key.as_deref().filter(|key| !key.is_empty())?;
    Some(ClientTarget {
        url: gateway_url(&config.host, config.port),
        key: key.to_string(),
    })
}

/// The overflow as the page shows it: today's spend in the planning day, and each key masked.
fn overflow_status_of(config: &ProxyConfig) -> Option<OverflowStatus> {
    let overflow = convert(config.overflow.as_ref()?)?;
    let costs = lock(request_log()).overflow_costs();
    let spent = spent_today(&costs, now_ms(), &STATE.settings().planning.time_zone);
    let hints: HashMap<String, String> = overflow_keys()
        .map(|keys| keys.hints().into_iter().collect())
        .unwrap_or_default();
    Some(overflow_status(&overflow, spent, &hints))
}

/// `proxyStatus()`: what the Proxy Gateway page shows (`ProxyStatus`).
pub fn proxy_status() -> Value {
    let config = proxy_settings();
    let server = current();
    let state = server.as_ref().map(|server| server.state());
    let running = state
        .as_ref()
        .is_some_and(|state| state.status == ProxyRunStatus::Running);
    if running {
        check_gateway_sign_ins();
    }
    let mut shown = gateway_config(&config);
    if let (true, Some(state)) = (running, &state) {
        shown.port = state.port;
        shown.host = state.host.clone();
    }
    let accounts = gateway_accounts(&STATE.accounts());
    let usage = gateway_usage();
    let metrics = server.as_ref().map(|server| server.metrics());
    let recent = server
        .as_ref()
        .map(|server| server.stats().recent())
        .unwrap_or_default();
    let class_share = lock(request_log()).today_by_class();
    let calibrations = convert(&crate::services::tokens_widget::limit_calibrations());
    let next_pick = server
        .as_ref()
        .filter(|_| running)
        .map(|server| server.next_picks());
    // Read before the insights are held: the gateway takes the router's lock first.
    let cooldowns: HashMap<String, _> = match &server {
        Some(server) => {
            let mut router = server.router();
            accounts
                .iter()
                .filter_map(|a| Some((a.id.clone(), router.cooldown_of(&a.id)?)))
                .collect()
        }
        None => HashMap::new(),
    };
    let cooldown_of = |id: &str| cooldowns.get(id).copied();
    let sign_ins = lock(&GATEWAY_SIGN_INS).clone();
    let sign_in = |id: &str| match sign_ins.get(id) {
        Some((SignInState::Missing, _)) => Some(GatewaySignIn::Missing),
        Some((SignInState::Expired, _)) => Some(GatewaySignIn::Expired),
        _ => None,
    };
    let clients = client_statuses(
        client_target(&config).as_ref(),
        config.client_bindings.as_ref(),
        &home(),
    );
    let overflow = overflow_status_of(&config);
    let error = lock(&PROXY_ERROR).clone();
    let insights = server.as_ref().map(|server| server.insights());
    let mut input = StatusInput::new(running, &shown, &accounts, &usage, now_ms());
    input.metrics = metrics.as_ref();
    input.error = error;
    input.recent = Some(recent);
    input.insights = insights.as_deref();
    input.class_share = Some(class_share);
    input.calibrations = calibrations.as_ref();
    input.next_pick = next_pick;
    input.gateway_sign_in = Some(&sign_in);
    input.tailscale_address = tailscale_address();
    input.clients = Some(clients);
    input.cooldown_of = Some(&cooldown_of);
    input.overflow = overflow;
    let status = build_proxy_status(input);
    drop(insights);
    serde_json::to_value(status).unwrap_or(Value::Null)
}

/// The sign-in the gateway sends for an account, when it can be used; notes how it stood, so
/// the gateway page can tell a saved sign-in from one the gateway can actually read. Never
/// prompts.
fn gateway_credential(account_id: &str, codex: bool) -> Option<ReadCredential> {
    let note = |state: SignInState| {
        lock(&GATEWAY_SIGN_INS).insert(account_id.to_string(), (state, now_ms()));
    };
    let profile = STATE.service().store.profile(account_id).ok()?;
    let credential = if codex {
        read_codex_credential(&profile, &CodexReadOptions::default())
            .map(|c| (c.access_token, c.expires_at))
    } else {
        match read_credential(
            &profile,
            false,
            STATE.paths().security_tool().as_deref(),
            Platform::current(),
            MISSING_RETRY_MS,
        ) {
            Ok(c) => Some((c.access_token, c.expires_at)),
            Err(error) => {
                // A locked Keychain says nothing about the sign-in itself.
                if error.issue == UsageIssue::CredentialsMissing {
                    note(SignInState::Missing);
                }
                return None;
            }
        }
    };
    let Some((access_token, expires_at)) = credential else {
        note(SignInState::Missing);
        return None;
    };
    // An expired token would only earn a 401; leave the account to the others.
    if expires_at.is_some_and(|at| at <= now_ms() as f64) {
        note(SignInState::Expired);
        return None;
    }
    note(SignInState::Ok);
    Some(ReadCredential {
        access_token,
        expires_at: expires_at.map(|at| at as i64),
    })
}

/// Reads again, in the background, the pool's sign-ins the gateway has not read for a while,
/// so its page shows an account it could not use before a request finds out.
fn check_gateway_sign_ins() {
    if !is_running() {
        return;
    }
    let now = now_ms();
    let accounts = gateway_accounts(&STATE.accounts());
    for account in pool_accounts(&accounts, &gateway_config(&proxy_settings())) {
        let provider = account.provider().as_str();
        let signed_in = account.auth.as_ref().is_some_and(|auth| auth.logged_in);
        if (provider != "claude" && provider != "codex") || !signed_in {
            continue;
        }
        let recent = lock(&GATEWAY_SIGN_INS)
            .get(&account.id)
            .is_some_and(|(_, at)| now - at < SIGN_IN_CHECK_MS);
        if recent || !lock(&SIGN_IN_CHECKS).insert(account.id.clone()) {
            continue;
        }
        let codex = provider == "codex";
        std::thread::spawn(move || {
            let credential = gateway_credential(&account.id, codex);
            let expired = matches!(
                lock(&GATEWAY_SIGN_INS).get(&account.id),
                Some((SignInState::Expired, _))
            );
            if credential.is_none() && expired {
                renew_for_gateway(&account.id);
            }
            lock(&SIGN_IN_CHECKS).remove(&account.id);
        });
    }
}

/// Rewrites the clients Relay bound: after the address or key changed, after a start (quitting
/// put their files back), and when Relay writes more than it used to. A file already right is
/// left alone. The values saved for unbinding grow with what was added.
fn rebind_clients(config: &ProxyConfig) -> Result<(), String> {
    let Some(target) = client_target(config) else {
        return Ok(());
    };
    let mut bindings = config.client_bindings.clone().unwrap_or_default();
    let home = home();
    let mut changed = false;
    for id in PROXY_CLIENTS {
        let Some(previous) = bindings.get(&id) else {
            continue;
        };
        let Ok(saved) = bind_client(id, &target, Some(previous), &home) else {
            continue;
        };
        if serde_json::to_string(&saved).ok() != serde_json::to_string(previous).ok() {
            bindings.insert(id, saved);
            changed = true;
        }
    }
    if changed {
        save_proxy_settings(ProxyConfig {
            client_bindings: Some(bindings),
            ..proxy_settings()
        })?;
    }
    Ok(())
}

/// While Relay quits: bound clients get their own settings back, since the gateway goes with it.
pub fn release_clients() {
    // Quitting before the registry opened: nothing was bound by this run.
    if STATE.service.get().is_none() {
        return;
    }
    let bindings = proxy_settings().client_bindings.unwrap_or_default();
    let home = home();
    for id in PROXY_CLIENTS {
        if let Some(saved) = bindings.get(&id) {
            clients::release_client_sync(id, Some(saved), &home);
        }
    }
}

/// data-reset.ts `unbindClients`: every bound client gets its own settings back for good, and
/// the gateway is left off with no client bound.
pub fn unbind_all_clients() -> Result<(), String> {
    serialize_proxy(|| {
        let bindings = proxy_settings().client_bindings.unwrap_or_default();
        let home = home();
        for id in PROXY_CLIENTS {
            if let Some(saved) = bindings.get(&id) {
                unbind_client(id, Some(saved), &home)?;
            }
        }
        save_proxy_settings(ProxyConfig {
            enabled: false,
            client_bindings: Some(ClientBindings::new()),
            ..proxy_settings()
        })
    })
}

/// Asks the usage reader to renew a Claude sign-in the gateway could not use; it backs off on
/// its own.
fn renew_for_gateway(account_id: &str) {
    let claude = STATE
        .accounts()
        .iter()
        .find(|a| a.id == account_id)
        .is_some_and(|a| a.provider.is_none_or(|p| p.as_str() == "claude"));
    if !claude {
        return;
    }
    let Some(usage) = STATE.usage.get().cloned() else {
        return;
    };
    let id = account_id.to_string();
    std::thread::spawn(move || {
        let _ = usage.refresh(&id, false);
    });
}

/// `overflowKeys()`: the overflow upstreams' sealed API keys; none until the vault is open.
pub fn overflow_keys() -> Option<OverflowKeys> {
    if let Some(keys) = OVERFLOW_KEYS.get() {
        return Some(keys.clone());
    }
    let sealer = STATE.vault_sealer.get()?.clone();
    let keys = OVERFLOW_KEYS.get_or_init(|| {
        let unsealer = sealer.clone();
        OverflowKeys::new(
            STATE.paths().data_dir().join("desktop-vault"),
            Arc::new(move |text: &str| sealer.seal(text).map_err(|e| e.to_string())),
            Arc::new(move |data: &[u8]| unsealer.unseal(data).map_err(|e| e.to_string())),
        )
    });
    Some(keys.clone())
}

/// `serializeProxy(startProxy)`: starts the gateway, one start/stop at a time; blocks until it
/// listens or failed.
pub fn start_proxy() -> Result<(), String> {
    serialize_proxy(start_proxy_now)
}

/// `startProxy` (inside a `serialize_proxy` turn): starts the gateway on the saved port and
/// host; a first start also creates the client key.
pub fn start_proxy_now() -> Result<(), String> {
    if is_running() {
        return Ok(());
    }
    let mut config = proxy_settings();
    if config.api_key.as_deref().is_none_or(str::is_empty) {
        config.api_key = Some(generate_proxy_key());
        save_proxy_settings(config.clone())?;
    }
    let server = Arc::new(ProxyServer::new(
        gateway_config(&config),
        Arc::new(hooks::AppHooks::new()),
        Upstreams::default(),
    ));
    if let Err(error) = RUNTIME.block_on(server.start()) {
        let message = match error {
            StartError::AddrInUse(_) => crate::i18n::say_with(
                "electronMain.isAlreadyInUseChooseAnother",
                &relay_i18n::Args::new()
                    .set("configHost", config.host.as_str())
                    .set("configPort", config.port),
            ),
            StartError::Other(message) => message,
        };
        *lock(&PROXY_ERROR) = Some(message.clone());
        return Err(message);
    }
    *lock(&PROXY_SERVER) = Some(server);
    *lock(&PROXY_ERROR) = None;
    crate::services::statusline::schedule_statusline();
    // Quitting put the bound clients' own settings back: they point at the gateway again.
    let _ = rebind_clients(&proxy_settings());
    Ok(())
}

/// `stopProxy` (inside a `serialize_proxy` turn).
pub fn stop_proxy() -> Result<(), String> {
    let server = lock(&PROXY_SERVER).take();
    if let Some(server) = server {
        RUNTIME.block_on(server.stop());
    }
    crate::services::statusline::schedule_statusline();
    Ok(())
}

/// `applyProxyConfig` (inside a `serialize_proxy` turn): saves `next`. A running gateway takes
/// a new routing strategy, session time or client key at once, keeping its open streams and
/// sessions; only a new host or port restarts it, and the old settings return if it cannot
/// start there.
pub fn apply_proxy_config(next: ProxyConfig) -> Result<(), String> {
    let previous = proxy_settings();
    save_proxy_settings(next.clone())?;
    if next.host != previous.host || next.port != previous.port || next.api_key != previous.api_key
    {
        rebind_clients(&next)?;
    }
    let Some(server) = current() else {
        return Ok(());
    };
    if next.host == previous.host && next.port == previous.port {
        let overflow = next.overflow.as_ref().and_then(convert);
        server.update_config(|config| {
            config.routing_strategy = convert(&next.routing_strategy).unwrap_or_default();
            config.affinity_ttl_seconds = next.affinity_ttl_seconds as f64;
            config.api_key = next.api_key.clone();
            config.subagent_overflow = Some(next.subagent_overflow == Some(true));
            config.overflow = overflow;
        });
        return Ok(());
    }
    stop_proxy()?;
    if let Err(error) = start_proxy_now() {
        save_proxy_settings(previous.clone())?;
        rebind_clients(&previous)?;
        let _ = start_proxy_now();
        return Err(error);
    }
    Ok(())
}

/// The gateway was turned off: its last start error no longer applies.
pub fn clear_proxy_error() {
    *lock(&PROXY_ERROR) = None;
}

/// proxy-pool.json changed underneath (an account removed): read it again next time.
pub fn reset_proxy_extras_cache() {
    *lock(&PROXY_EXTRAS) = None;
}

/// `proxyServer?.sessionCache.evictAccount(accountId)`: a removed account's sessions go.
pub fn evict_account(account_id: &str) {
    if let Some(server) = current() {
        server.session_cache().evict_account(account_id);
    }
}

/// `proxyServer?.sessionCache.list()`: which session is on which account, for the status line.
pub fn sessions() -> Option<Vec<ProxySessionState>> {
    let server = current()?;
    let list = server.session_cache().list();
    Some(list.iter().filter_map(convert).collect())
}

/// At quit: stops the gateway and points its clients back (`proxyServer?.stop()` and
/// `releaseClients()`).
pub fn shutdown() {
    if let Some(server) = lock(&PROXY_SERVER).take() {
        RUNTIME.block_on(async {
            let _ = tokio::time::timeout(STOP_GRACE, server.stop()).await;
        });
    }
    release_clients();
}
