//! Port of tests/proxy-gateway-settings.test.ts: the key, configure-patch and quota cases. The
//! registry cases are relay-core's (store_settings.rs `proxy_gateway_settings`).

mod common;

use common::*;
use relay_gateway::proxy_status::{
    PROXY_KEY_PREFIX, ProxyConfigurePatch, generate_proxy_key, parse_proxy_configure_patch,
    quota_percent, reset_in_minutes,
};
use relay_gateway::{AccountUsage, RoutingStrategy};
use serde_json::json;
use std::collections::HashSet;

fn now() -> i64 {
    parse("2026-11-09T12:00:00Z")
}

fn usage(
    id: &str,
    five: Option<(f64, Option<String>)>,
    seven: Option<(f64, Option<String>)>,
) -> AccountUsage {
    ready(
        id,
        five.map(|(used, at)| window(used, at)),
        seven.map(|(used, at)| window(used, at)),
    )
}

#[test]
fn a_client_key_is_relay_sec_and_256_random_bits_never_repeated() {
    let keys: HashSet<String> = (0..50).map(|_| generate_proxy_key()).collect();
    assert_eq!(keys.len(), 50);
    for key in keys {
        assert!(key.starts_with(PROXY_KEY_PREFIX));
        let rest = &key[PROXY_KEY_PREFIX.len()..];
        assert_eq!(rest.len(), 43, "{key}");
        assert!(
            rest.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "{key}"
        );
    }
}

#[test]
fn configuring_takes_a_valid_port_a_host_and_the_routing_choice_and_nothing_else() {
    assert_eq!(
        parse_proxy_configure_patch(
            &json!({ "port": 9000, "host": " 100.64.0.1 ", "routingStrategy": "balanced" })
        )
        .unwrap(),
        ProxyConfigurePatch {
            port: Some(9000),
            host: Some("100.64.0.1".into()),
            routing_strategy: Some(RoutingStrategy::Balanced),
            ..ProxyConfigurePatch::default()
        }
    );
    for host in [
        "127.0.0.1",
        "localhost",
        "::1",
        "100.101.12.34",
        "100.127.255.255",
    ] {
        assert_eq!(
            parse_proxy_configure_patch(&json!({ "host": host }))
                .unwrap()
                .host
                .as_deref(),
            Some(host)
        );
    }
    for bad in [
        json!({ "allowCrossProviderFallback": true }),
        json!({ "port": 0 }),
        json!({ "port": 1.5 }),
        json!({ "port": "80" }),
        json!({ "host": "" }),
        json!({ "host": "x/y" }),
        json!({ "apiKey": "mine" }),
        json!({ "enabled": true }),
    ] {
        assert!(parse_proxy_configure_patch(&bad).is_err(), "{bad}");
    }
}

#[test]
fn the_gateway_listens_only_on_this_computer_or_its_tailscale_address() {
    for host in [
        "0.0.0.0",
        "::",
        "192.168.1.5",
        "100.128.0.1",
        "100.63.255.255",
        "example.com",
        "127.0.0.2",
    ] {
        let error = parse_proxy_configure_patch(&json!({ "host": host })).unwrap_err();
        assert!(
            error.contains("Use 127.0.0.1, localhost or a Tailscale address."),
            "{host}: {error}"
        );
    }
}

#[test]
fn quota_is_the_fuller_window_and_the_reset_is_the_soonest_one_that_is_still_ahead() {
    let now = now();
    let soon = iso(now + 90 * 60_000 + 1);
    let later = iso(now + 3 * 86_400_000);
    let past = iso(now - 1000);
    let u = usage(
        "a",
        Some((42.4, Some(soon))),
        Some((71.6, Some(later.clone()))),
    );
    assert_eq!(quota_percent(Some(&u)), Some(72));
    assert_eq!(reset_in_minutes(Some(&u), now), Some(91));
    assert_eq!(
        reset_in_minutes(
            Some(&usage(
                "a",
                Some((10.0, Some(past.clone()))),
                Some((10.0, Some(later)))
            )),
            now
        ),
        Some(3 * 1440)
    );
    assert_eq!(
        reset_in_minutes(Some(&usage("a", Some((10.0, Some(past))), None)), now),
        None
    );
    assert_eq!(quota_percent(None), None);
    assert_eq!(
        reset_in_minutes(Some(&usage("a", Some((10.0, None)), None)), now),
        None
    );
    assert_eq!(
        quota_percent(Some(&usage("a", Some((130.0, None)), None))),
        Some(100)
    );
}
