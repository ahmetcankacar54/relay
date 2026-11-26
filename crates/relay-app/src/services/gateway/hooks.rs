//! What the in-process gateway asks of the app (`hooks` of `startProxy` in
//! electron/main/gateway.ts): sign-ins read on demand and reused for 20 s, the pool and its
//! limits as Relay last read them, live limits back into the usage reader, the request log,
//! the overflow's keys and prices, and the planning time zone.

use std::pin::Pin;
use std::sync::Arc;

use relay_gateway::credential_cache::CredentialCache;
use relay_gateway::overflow_upstream::{OpenRouterPrices, OpenRouterPricesOptions};
use relay_gateway::proxy_server::{AntigravityRoute, GatewayHooks};
use relay_gateway::proxy_status::pool_accounts;
use relay_gateway::types::{
    Account, LiveLimits, OverflowCost, OverflowRates, Provider, ProxyLoopAlarm, ProxyRequestLog,
    UsageSnapshot,
};

use super::{
    GATEWAY_SIGN_INS, convert, gateway_accounts, gateway_config, gateway_credential, gateway_usage,
    overflow_keys, proxy_settings, renew_for_gateway, request_log,
};
use crate::state::{STATE, lock};

/// `async_trait`'s boxed future, spelled out (the app does not depend on the macro).
type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub(super) struct AppHooks {
    credentials: CredentialCache,
    /// OpenRouter's published prices for its overflow answers, read at most daily, kept on disk.
    prices: OpenRouterPrices,
}

impl AppHooks {
    pub(super) fn new() -> Self {
        AppHooks {
            credentials: CredentialCache::new(),
            prices: OpenRouterPrices::new(OpenRouterPricesOptions {
                file: Some(STATE.paths().data_dir().join("openrouter-prices.json")),
                ..Default::default()
            }),
        }
    }
}

/// The gateway's `LiveLimits` as the usage reader takes them (same fields, other crate).
fn core_live_limits(live: &LiveLimits) -> relay_core::usage::LiveLimits {
    relay_core::usage::LiveLimits {
        five_hour: live.five_hour.as_ref().and_then(convert),
        seven_day: live.seven_day.as_ref().and_then(convert),
        models: live.models.as_ref().map(|models| {
            models
                .iter()
                .map(|m| relay_core::usage::LiveModel {
                    model: m.model.clone(),
                    weekly: m.weekly,
                    used_percent: m.used_percent,
                    resets_at: m.resets_at.clone(),
                })
                .collect()
        }),
    }
}

impl GatewayHooks for AppHooks {
    fn credential<'life0, 'life1, 'async_trait>(
        &'life0 self,
        account: &'life1 Account,
    ) -> Boxed<'async_trait, Result<Option<String>, String>>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            if let Some(token) = self
                .credentials
                .get(&account.id, relay_core::clock::now_ms())
            {
                return Ok(Some(token));
            }
            let codex = account.provider() == Provider::Codex;
            let read = tokio::task::block_in_place(|| gateway_credential(&account.id, codex));
            Ok(read.and_then(|credential| {
                self.credentials
                    .accept(&account.id, credential, relay_core::clock::now_ms())
            }))
        })
    }

    fn antigravity<'life0, 'life1, 'async_trait>(
        &'life0 self,
        account: &'life1 Account,
    ) -> Boxed<'async_trait, Result<Option<AntigravityRoute>, String>>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let signed_in = account.auth.as_ref().is_some_and(|auth| auth.logged_in);
            if account.provider() != Provider::Antigravity || !signed_in {
                return Ok(None);
            }
            tokio::task::block_in_place(|| {
                let bridge = crate::services::antigravity::antigravity_bridge(&account.id)?;
                if !bridge.has_credential() {
                    return Ok(None);
                }
                bridge.start().map_err(|error| error.to_string())?;
                Ok(bridge.endpoint().map(|endpoint| AntigravityRoute {
                    url: endpoint.url,
                    key: endpoint.key,
                }))
            })
        })
    }

    /// The accounts as saved now and the limits as Relay last read them: quota-aware routing.
    /// Only the accounts left in the pool, in its order (strict priority reads the order).
    fn usage(&self) -> Arc<UsageSnapshot> {
        let accounts = gateway_accounts(&STATE.accounts());
        Arc::new(UsageSnapshot {
            accounts: pool_accounts(&accounts, &gateway_config(&proxy_settings())),
            usage_map: gateway_usage(),
        })
    }

    /// Every answer says how full the account's windows are: newer than the last read.
    fn on_live_limits(&self, account_id: &str, live: &LiveLimits) {
        if let Some(usage) = STATE.usage.get() {
            usage.observe(account_id, &core_live_limits(live));
        }
        // The status line names the account the gateway just used for the session.
        crate::services::statusline::schedule_statusline();
    }

    fn on_credential_rejected(&self, account_id: &str) {
        self.credentials.forget(account_id);
        // Refused although it read: the page shows it as renewing, not as working.
        lock(&GATEWAY_SIGN_INS).remove(account_id);
        renew_for_gateway(account_id);
    }

    /// An expired or unreadable token: the usage reader renews it when it can (never prompts).
    fn on_credential_missing(&self, account_id: &str) {
        renew_for_gateway(account_id);
    }

    fn on_loop_alarm(&self, alarm: &ProxyLoopAlarm) {
        if let Some(alarm) = convert(alarm) {
            crate::services::notifications::notify_loop_alarm(&alarm);
        }
    }

    fn request_log(&self, entry: &ProxyRequestLog) {
        lock(request_log()).record(entry);
    }

    fn request_bound(&self, request_id: &str, account_id: &str) {
        lock(request_log()).bind(request_id, account_id);
    }

    fn recent_requests(&self) -> Vec<ProxyRequestLog> {
        lock(request_log()).recent()
    }

    fn overflow_costs(&self) -> Option<Vec<OverflowCost>> {
        Some(lock(request_log()).overflow_costs())
    }

    fn overflow_key<'life0, 'life1, 'async_trait>(
        &'life0 self,
        upstream_id: &'life1 str,
    ) -> Boxed<'async_trait, Option<String>>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            tokio::task::block_in_place(|| overflow_keys()?.get(upstream_id).ok().flatten())
        })
    }

    fn overflow_price<'life0, 'life1, 'async_trait>(
        &'life0 self,
        model: &'life1 str,
    ) -> Boxed<'async_trait, Option<OverflowRates>>
    where
        'life0: 'async_trait,
        'life1: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move { self.prices.rate(model).await })
    }

    fn time_zone(&self) -> Option<String> {
        Some(STATE.settings().planning.time_zone)
    }
}
