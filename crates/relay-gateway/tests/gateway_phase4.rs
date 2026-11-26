//! Port of tests/gateway-phase4.test.ts (the gateway's cases; the page's rendering is the UI's).

mod common;

use common::*;
use relay_gateway::proxy_request_log::clean_entry;
use relay_gateway::proxy_router::{CooldownReason, PickContext, ProxyRouter};
use relay_gateway::proxy_status::{
    GatewaySignIn, NextPick, NextPicks, StatusInput, build_proxy_status,
};
use relay_gateway::{
    Account, AccountAuth, AccountUsage, Provider, ProxyConfig, ProxyPick, ProxyPickReason,
    RoutingStrategy, ServerOptions, Upstreams, UsageMap,
};
use serde_json::json;
use std::collections::HashSet;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;

fn now() -> i64 {
    utc(2026, 10, 13, 12, 0)
}

fn usage_of(id: &str, five: f64, reset_hours: i64, now: i64) -> AccountUsage {
    ready(
        id,
        Some(window(five, Some(iso(now + reset_hours * HOUR)))),
        None,
    )
}

fn pick(
    router: &mut ProxyRouter,
    key: &str,
    accounts: &[Account],
    usage: &UsageMap,
) -> relay_gateway::proxy_router::RouterSelection {
    router
        .select_account(
            Some(key),
            accounts,
            usage,
            Some(Provider::Claude),
            &HashSet::new(),
            None,
            &PickContext::default(),
        )
        .unwrap()
}

#[test]
fn the_router_says_why_it_chose_an_account_the_sessions_own_the_strategys_pick_or_the_only_one() {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let accounts = [account("a"), account("b"), account("c")];
    let mut usage = UsageMap::new();
    usage.insert("a".into(), usage_of("a", 93.0, 1, now()));
    usage.insert("b".into(), usage_of("b", 20.0, 2, now()));
    usage.insert("c".into(), usage_of("c", 10.0, 4, now()));

    let first = pick(&mut router, "s-1", &accounts, &usage);
    assert_eq!(
        first.account.id, "b",
        "A resets first but is near its limit"
    );
    assert_eq!(first.reason, ProxyPickReason::SoonestReset);
    assert_eq!(first.nearly_full, Some(vec!["a".to_string()]));

    let again = pick(&mut router, "s-1", &accounts, &usage);
    assert_eq!(again.reason, ProxyPickReason::Bound);
    assert_eq!(again.nearly_full, None);

    let lone = pick(&mut router, "s-2", &[account("c")], &usage);
    assert_eq!(lone.reason, ProxyPickReason::Only);

    let mut strict =
        ProxyRouter::with_strategy(RoutingStrategy::StrictPriority, Some(fixed(now())));
    assert_eq!(
        pick(&mut strict, "s-3", &accounts, &usage).reason,
        ProxyPickReason::Priority
    );
    let mut balanced = ProxyRouter::with_strategy(RoutingStrategy::Balanced, Some(fixed(now())));
    assert_eq!(
        pick(&mut balanced, "s-4", &accounts, &usage).reason,
        ProxyPickReason::Balanced
    );
}

#[test]
fn a_session_whose_account_waits_on_its_sign_in_is_served_elsewhere_and_says_which_account_it_waits_for()
 {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let accounts = [account("a"), account("b")];
    let mut usage = UsageMap::new();
    usage.insert("a".into(), usage_of("a", 20.0, 1, now()));
    usage.insert("b".into(), usage_of("b", 20.0, 3, now()));
    assert_eq!(pick(&mut router, "s-1", &accounts, &usage).account.id, "a");
    router.mark_unavailable("a", 5 * MINUTE, CooldownReason::Auth);
    let served = pick(&mut router, "s-1", &accounts, &usage);
    assert_eq!(served.account.id, "b");
    assert_eq!(served.bound_waiting.as_deref(), Some("a"));
}

#[test]
fn the_preview_names_a_new_sessions_account_without_binding_anything() {
    let mut router = ProxyRouter::with_strategy(RoutingStrategy::SoonestReset, Some(fixed(now())));
    let mut usage = UsageMap::new();
    usage.insert("a".into(), usage_of("a", 95.0, 1, now()));
    usage.insert("b".into(), usage_of("b", 20.0, 2, now()));
    let preview = router
        .preview(
            &[account("a"), account("b")],
            &usage,
            Provider::Claude,
            None,
        )
        .unwrap();
    assert_eq!(preview.account.id, "b");
    assert_eq!(preview.nearly_full, Some(vec!["a".to_string()]));
    assert_eq!(router.session_cache_mut().count(), 0);
    assert!(
        router
            .preview(&[account("a")], &usage, Provider::Codex, None)
            .is_none(),
        "no account of that provider"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_held_on_one_account_names_it_on_the_account_that_served_it_and_the_log_keeps_the_reason()
 {
    let mut usage = UsageMap::new();
    usage.insert("a".into(), usage_of("a", 20.0, 1, now()));
    usage.insert("b".into(), usage_of("b", 20.0, 3, now()));
    let upstream = FakeUpstream::sync(|seen| {
        if seen.token() == "tok-a" {
            json_reply(
                529,
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
                &[],
            )
        } else {
            json_reply(
                200,
                r#"{"usage":{"input_tokens":2,"output_tokens":3}}"#,
                &[],
            )
        }
    })
    .await;
    let config = ProxyConfig {
        routing_strategy: RoutingStrategy::SoonestReset,
        ..config()
    };
    let gateway = Gateway::start_with(
        config,
        Hooks::new(vec![account("a"), account("b")]).usage(usage),
        Upstreams {
            anthropic_url: Some(upstream.url.clone()),
            ..Default::default()
        },
        ServerOptions {
            now: Some(fixed(now())),
            ..Default::default()
        },
    )
    .await;
    let mut expected = NextPicks::new();
    expected.insert(
        "claude".into(),
        NextPick {
            account_id: "a".into(),
            reason: ProxyPickReason::SoonestReset,
            nearly_full: None,
            by_model: None,
        },
    );
    assert_eq!(gateway.server.next_picks(), expected);
    gateway
        .post(
            "/v1/messages",
            &[("x-claude-code-session-id", "s-1")],
            r#"{"model":"claude-opus-5-5"}"#,
        )
        .await;
    gateway.idle().await;
    let recent = gateway.recent();
    let (served, held) = (&recent[0], &recent[1]);
    assert_eq!(held.account_id.as_deref(), Some("a"));
    assert_eq!(
        held.pick,
        Some(ProxyPick::new(ProxyPickReason::SoonestReset))
    );
    assert_eq!(served.account_id.as_deref(), Some("b"));
    let served_pick = served.pick.as_ref().unwrap();
    assert_eq!(served_pick.after.as_deref(), Some("a"));
    assert_eq!(
        served_pick.bound_waiting.as_deref(),
        Some("a"),
        "an overload keeps the session bound to A"
    );
    gateway.stop().await;
    upstream.close().await;
}

#[test]
fn a_pick_read_back_from_disk_keeps_known_reasons_and_account_ids_only() {
    let entry = clean_entry(&json!({
        "at": 1,
        "status": 200,
        "pick": { "reason": "soonest-reset", "nearlyFull": ["a", 7, "x".repeat(65)], "after": "b", "overflow": true, "extra": "no" },
    }))
    .unwrap();
    let mut expected = ProxyPick::new(ProxyPickReason::SoonestReset);
    expected.nearly_full = Some(vec!["a".into()]);
    expected.after = Some("b".into());
    expected.overflow = Some(true);
    assert_eq!(entry.pick, Some(expected));
    assert_eq!(
        clean_entry(&json!({ "at": 1, "status": 200, "pick": { "reason": "dice" } }))
            .unwrap()
            .pick,
        None
    );
}

#[test]
fn the_status_carries_the_next_pick_and_a_sign_in_the_gateway_cannot_use_only_for_pool_accounts() {
    let config = ProxyConfig {
        excluded_account_ids: Some(vec!["c".into()]),
        ..ProxyConfig::default()
    };
    let accounts: Vec<Account> = ["a", "b", "c"]
        .iter()
        .map(|id| {
            let mut account = account(id);
            account.auth = Some(AccountAuth {
                logged_in: true,
                ..Default::default()
            });
            account
        })
        .collect();
    let usage = UsageMap::new();
    let mut next = NextPicks::new();
    next.insert(
        "claude".into(),
        NextPick {
            account_id: "a".into(),
            reason: ProxyPickReason::Balanced,
            nearly_full: None,
            by_model: None,
        },
    );
    let sign_in = |id: &str| match id {
        "a" => None,
        "b" => Some(GatewaySignIn::Missing),
        _ => Some(GatewaySignIn::Expired),
    };
    let input = |running| StatusInput {
        next_pick: Some(next.clone()),
        gateway_sign_in: Some(&sign_in),
        ..StatusInput::new(running, &config, &accounts, &usage, now())
    };
    let status = build_proxy_status(input(true));
    assert_eq!(status.next_pick, Some(next.clone()));
    assert_eq!(
        status
            .accounts
            .iter()
            .map(|a| a.gateway_sign_in)
            .collect::<Vec<_>>(),
        [None, Some(GatewaySignIn::Missing), None],
        "C is out of the pool: the gateway never reads it"
    );
    let stopped = build_proxy_status(input(false));
    assert_eq!(stopped.next_pick, None);
    assert_eq!(stopped.accounts[1].gateway_sign_in, None);
}
