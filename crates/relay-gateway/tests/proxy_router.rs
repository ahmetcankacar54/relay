//! Port of tests/proxy-router.test.ts.

mod common;

use common::*;
use relay_gateway::proxy_router::{
    CooldownReason, PickContext, ProxyRouter, RouterError, RouterOptions,
};
use relay_gateway::proxy_session_cache::{ProxySessionCache, SessionCacheOptions};
use relay_gateway::{
    AFFINITY_REVISION, Account, AccountPlanning, AccountUsage, LEGACY_AFFINITY_TTL_SECONDS,
    Provider, ProxyConfig, RoutingStrategy, UsageMap, current_affinity_ttl,
};
use std::collections::HashSet;

fn select(
    router: &mut ProxyRouter,
    key: Option<&str>,
    accounts: &[Account],
    usage: &UsageMap,
    provider: Option<Provider>,
    exclude: &[&str],
) -> Result<relay_gateway::proxy_router::RouterSelection, RouterError> {
    let exclude: HashSet<String> = exclude.iter().map(|s| s.to_string()).collect();
    router.select_account(
        key,
        accounts,
        usage,
        provider,
        &exclude,
        None,
        &PickContext::default(),
    )
}

fn cache(ttl: f64, clock: &TestClock, max: Option<usize>) -> ProxySessionCache {
    ProxySessionCache::new(SessionCacheOptions {
        ttl_seconds: Some(ttl),
        max_entries: max,
        now: Some(clock.clock()),
    })
}

#[test]
fn proxy_session_cache_preserves_affinity_and_respects_ttl() {
    let clock = TestClock::new(1000);
    let mut cache = cache(10.0, &clock, None);
    cache.set("session-1", "acc-1");
    assert_eq!(cache.get("session-1").as_deref(), Some("acc-1"));
    // Advance time past TTL
    clock.advance(15_000);
    assert_eq!(cache.get("session-1"), None);
}

#[test]
fn proxy_router_preserves_kv_prompt_cache_via_session_affinity() {
    let mut router = ProxyRouter::default();
    let accounts = [named("acc-1", "Account 1"), named("acc-2", "Account 2")];
    let usage = UsageMap::new();
    let first = select(
        &mut router,
        Some("thread-xyz"),
        &accounts,
        &usage,
        None,
        &[],
    )
    .unwrap();
    // Subsequent call with same session key should return the exact same account
    let second = select(
        &mut router,
        Some("thread-xyz"),
        &accounts,
        &usage,
        None,
        &[],
    )
    .unwrap();
    assert_eq!(second.account.id, first.account.id);
    assert!(second.session_affinity_hit);
}

#[test]
fn proxy_router_prioritizes_account_resetting_soonest_token_burn_optimization() {
    let now = now_ms();
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now)));
    let soon = named("acc-soon", "Reset Tomorrow");
    let late = named("acc-late", "Reset In 5 Days");
    let mut usage = UsageMap::new();
    usage.insert(
        "acc-soon".into(),
        ready(
            "acc-soon",
            Some(window(20.0, Some(iso(now + 2 * 3_600_000)))),
            Some(window(30.0, Some(iso(now + 24 * 3_600_000)))),
        ),
    );
    usage.insert(
        "acc-late".into(),
        ready(
            "acc-late",
            Some(window(10.0, Some(iso(now + 4 * 3_600_000)))),
            Some(window(10.0, Some(iso(now + 5 * 24 * 3_600_000)))),
        ),
    );
    let picked = select(&mut router, None, &[late, soon], &usage, None, &[]).unwrap();
    // acc-soon's week ends in a day, acc-late's in five: burn the imminent quota first.
    assert_eq!(picked.account.id, "acc-soon");
}

#[test]
fn proxy_router_evicts_exhausted_account_from_session_affinity() {
    let mut router = ProxyRouter::default();
    router.session_cache_mut().set("sess-abc", "acc-1");
    let hour = iso(now_ms() + 3_600_000);
    let mut usage = UsageMap::new();
    // Spent until its reset an hour from now (a reset already past would make it empty again).
    usage.insert(
        "acc-1".into(),
        ready("acc-1", Some(window(100.0, Some(hour.clone()))), None),
    );
    usage.insert(
        "acc-2".into(),
        ready("acc-2", Some(window(10.0, Some(hour))), None),
    );
    let picked = select(
        &mut router,
        Some("sess-abc"),
        &[named("acc-1", "Account 1"), named("acc-2", "Account 2")],
        &usage,
        None,
        &[],
    )
    .unwrap();
    assert_eq!(picked.account.id, "acc-2");
    assert!(!picked.session_affinity_hit);
}

#[test]
fn proxy_session_cache_stays_bounded_and_drops_the_least_recently_used_session() {
    let clock = TestClock::new(1000);
    let mut cache = cache(600.0, &clock, Some(3));
    cache.set("a", "acc-1");
    cache.set("b", "acc-1");
    cache.set("c", "acc-1");
    // Touching "a" makes "b" the oldest.
    clock.advance(1);
    assert_eq!(cache.get("a").as_deref(), Some("acc-1"));
    cache.set("d", "acc-1");
    assert_eq!(cache.count(), 3);
    assert_eq!(cache.get("b"), None);
    assert_eq!(cache.get("a").as_deref(), Some("acc-1"));
    assert_eq!(cache.get("d").as_deref(), Some("acc-1"));
}

#[test]
fn proxy_session_cache_prunes_expired_sessions_without_being_read() {
    let clock = TestClock::new(1000);
    let mut cache = cache(10.0, &clock, None);
    for i in 0..50 {
        cache.set(&format!("s{i}"), "acc-1");
    }
    clock.advance(11_000);
    cache.set("fresh", "acc-2");
    assert_eq!(cache.count(), 1);
    assert_eq!(
        cache
            .list()
            .into_iter()
            .map(|s| s.session_key)
            .collect::<Vec<_>>(),
        ["fresh"]
    );
}

#[test]
fn proxy_router_keeps_a_rate_limited_account_out_until_its_cooldown_ends() {
    let clock = TestClock::new(1_000_000);
    let mut router = ProxyRouter::new(RouterOptions {
        now: Some(clock.clock()),
        ..Default::default()
    });
    let pool = [named("acc-1", "Account 1"), named("acc-2", "Account 2")];
    let usage = UsageMap::new();
    router.mark_unavailable("acc-1", 60_000, CooldownReason::Limit);
    assert_eq!(
        select(&mut router, None, &pool, &usage, None, &[])
            .unwrap()
            .account
            .id,
        "acc-2"
    );
    router.mark_unavailable("acc-2", 30_000, CooldownReason::Limit);
    assert!(matches!(
        select(&mut router, None, &pool, &usage, None, &[]),
        Err(RouterError::NoEligible {
            retry_after_seconds: Some(30),
            ..
        })
    ));
    clock.advance(31_000);
    assert_eq!(
        select(&mut router, None, &pool, &usage, None, &[])
            .unwrap()
            .account
            .id,
        "acc-2"
    );
    clock.advance(60_000);
    // Both back: the cooldown map holds nothing stale.
    assert!(select(&mut router, None, &pool, &usage, None, &[]).is_ok());
}

#[test]
fn proxy_router_strict_priority_follows_registry_order_and_skips_used_up_accounts() {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::StrictPriority, None);
    let pool = [named("acc-1", "Account 1"), named("acc-2", "Account 2")];
    let full = ready(
        "acc-1",
        Some(window(98.0, Some(iso(now_ms() + 3_600_000)))),
        None,
    );
    assert_eq!(
        select(&mut router, None, &pool, &UsageMap::new(), None, &[])
            .unwrap()
            .account
            .id,
        "acc-1"
    );
    let mut usage = UsageMap::new();
    usage.insert("acc-1".into(), full);
    assert_eq!(
        select(&mut router, None, &pool, &usage, None, &[])
            .unwrap()
            .account
            .id,
        "acc-2"
    );
}

#[test]
fn proxy_router_keeps_a_request_on_its_provider_and_says_when_that_provider_has_no_account() {
    let mut router = ProxyRouter::default();
    let both = [
        with_provider(named("claude-1", "Claude 1"), Provider::Claude),
        with_provider(named("codex-1", "Codex 1"), Provider::Codex),
    ];
    let usage = UsageMap::new();
    assert_eq!(
        select(
            &mut router,
            None,
            &both,
            &usage,
            Some(Provider::Claude),
            &[]
        )
        .unwrap()
        .account
        .id,
        "claude-1"
    );
    assert_eq!(
        select(&mut router, None, &both, &usage, Some(Provider::Codex), &[])
            .unwrap()
            .account
            .id,
        "codex-1"
    );
    // The only Claude account cooling down: the request waits, it never goes to Codex.
    router.mark_unavailable("claude-1", 60_000, CooldownReason::Limit);
    assert!(matches!(
        select(&mut router, None, &both, &usage, Some(Provider::Claude), &[]),
        Err(RouterError::NoEligible { retry_after_seconds: Some(s), .. }) if s > 0
    ));
    // Codex is not blocked by Claude's cooldown.
    assert_eq!(
        select(&mut router, None, &both, &usage, Some(Provider::Codex), &[])
            .unwrap()
            .account
            .id,
        "codex-1"
    );
    // No Antigravity account at all is a different answer from "cooling down".
    assert!(matches!(
        select(
            &mut router,
            None,
            &both,
            &usage,
            Some(Provider::Antigravity),
            &[]
        ),
        Err(RouterError::NoProvider { .. })
    ));
}

#[test]
fn proxy_router_skips_accounts_already_tried_for_the_request() {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::StrictPriority, None);
    let pool = [named("a", "A"), named("b", "B")];
    let usage = UsageMap::new();
    assert_eq!(
        select(&mut router, None, &pool, &usage, None, &[])
            .unwrap()
            .account
            .id,
        "a"
    );
    assert_eq!(
        select(&mut router, None, &pool, &usage, None, &["a"])
            .unwrap()
            .account
            .id,
        "b"
    );
    assert!(matches!(
        select(&mut router, None, &pool, &usage, None, &["a", "b"]),
        Err(RouterError::NoProvider { .. })
    ));
}

#[test]
fn soonest_reset_ranks_accounts_with_unknown_limits_after_accounts_with_known_room() {
    let now = now_ms();
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now)));
    let pool = [named("unknown", "Never read"), named("known", "Read")];
    let read = |used: f64| {
        ready(
            "known",
            None,
            Some(window(used, Some(iso(now + 86_400_000)))),
        )
    };
    let mut usage = UsageMap::new();
    usage.insert("known".into(), read(40.0));
    assert_eq!(
        select(&mut router, None, &pool, &usage, None, &[])
            .unwrap()
            .account
            .id,
        "known"
    );
    // With no room left on the known one, the unknown one is tried instead of the full one.
    usage.insert("known".into(), read(99.0));
    assert_eq!(
        select(&mut router, None, &pool, &usage, None, &[])
            .unwrap()
            .account
            .id,
        "unknown"
    );
}

#[test]
fn a_paused_session_keeps_its_account_for_the_hour_claude_codes_cache_lives() {
    // The cache is the account's: a session that moves writes its whole history again.
    assert_eq!(ProxyConfig::default().affinity_ttl_seconds, 3_600.0);
    let clock = TestClock::new(0);
    let mut cache = ProxySessionCache::with_clock(clock.clock());
    cache.set("s", "a");
    clock.advance(59 * 60_000);
    assert_eq!(cache.get("s").as_deref(), Some("a"));
    // Each request starts the hour again, as a cache hit does.
    clock.advance(59 * 60_000);
    assert_eq!(cache.get("s").as_deref(), Some("a"));
    clock.advance(61 * 60_000);
    assert_eq!(cache.get("s"), None);
}

#[test]
fn a_saved_lifetime_that_is_the_old_five_minute_default_moves_to_the_hour_once() {
    // Saved before the default changed: never a choice.
    assert_eq!(
        current_affinity_ttl(Some(LEGACY_AFFINITY_TTL_SECONDS), None),
        Some(3_600.0)
    );
    assert_eq!(
        current_affinity_ttl(Some(LEGACY_AFFINITY_TTL_SECONDS), Some(0)),
        Some(3_600.0)
    );
    // Any other saved value was chosen, and stays.
    assert_eq!(current_affinity_ttl(Some(900.0), None), Some(900.0));
    assert_eq!(current_affinity_ttl(Some(3_600.0), None), Some(3_600.0));
    // Five minutes chosen after the move stays five minutes.
    assert_eq!(
        current_affinity_ttl(Some(LEGACY_AFFINITY_TTL_SECONDS), Some(AFFINITY_REVISION)),
        Some(LEGACY_AFFINITY_TTL_SECONDS)
    );
    assert_eq!(current_affinity_ttl(None, None), None);
}

#[test]
fn soonest_reset_weighs_a_5_hour_windows_room_in_pro_units_by_the_accounts_plan() {
    let now = parse("2026-10-14T10:00:00Z");
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now)));
    let week = iso(now + 3 * 24 * 3_600_000);
    let usage = |id: &str, used: f64| -> AccountUsage {
        ready(
            id,
            Some(window(used, Some(iso(now + 2 * 3_600_000)))),
            Some(window(10.0, Some(week.clone()))),
        )
    };
    let plan = |id: &str, name: &str, plan: &str| {
        let mut account = named(id, name);
        account.planning = Some(AccountPlanning {
            plan: plan.into(),
            capacity_weight: Some(1.0),
        });
        account
    };
    let max20 = plan("max20", "Max 20×", "max20");
    let busy_pro = plan("busy-pro", "Busy Pro", "pro");
    let pro = plan("pro", "Pro", "pro");
    // Max 20× at 85 % still holds 300 Pro units, three fresh Pro windows.
    let mut map = UsageMap::new();
    map.insert("max20".into(), usage("max20", 85.0));
    map.insert("pro".into(), usage("pro", 0.0));
    assert_eq!(
        select(&mut router, None, &[pro.clone(), max20], &map, None, &[])
            .unwrap()
            .account
            .id,
        "max20"
    );
    // A Pro account at 85 % has 15 units left and ranks after a fresh one, as before.
    let mut map = UsageMap::new();
    map.insert("busy-pro".into(), usage("busy-pro", 85.0));
    map.insert("pro".into(), usage("pro", 0.0));
    assert_eq!(
        select(&mut router, None, &[busy_pro, pro], &map, None, &[])
            .unwrap()
            .account
            .id,
        "pro"
    );
}
