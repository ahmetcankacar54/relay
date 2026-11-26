//! The `shared/proxy-url` and `shared/proxy-types` assertions of tests/proxy-clients.test.ts
//! ("Tailscale's 100.64.0.0/10 range…", its interface scan belongs to the gateway port),
//! tests/proxy-router.test.ts ("a saved lifetime that is the old five-minute default…"),
//! tests/proxy-tab.test.ts and tests/proxy-page.test.ts (the helpers src/lib/proxy-ui re-exports).

use relay_core::shared::proxy_types::{
    AFFINITY_REVISION, LEGACY_AFFINITY_TTL_SECONDS, ProxyConfig, RoutingStrategy,
    current_affinity_ttl, default_proxy_config,
};
use relay_core::shared::proxy_url::{
    client_host, gateway_host_allowed, gateway_url, is_loopback_host, is_tailscale_ipv4,
};

#[test]
fn tailscale_s_100_64_0_0_10_range_is_recognised_on_a_network_interface() {
    assert!(is_tailscale_ipv4("100.101.12.34"));
    assert!(!is_tailscale_ipv4("100.63.0.1"));
    assert!(!is_tailscale_ipv4("192.168.1.2"));
    // `Number()` per part, as the TS reads them.
    assert!(is_tailscale_ipv4("100.127.255.255"));
    assert!(!is_tailscale_ipv4("100.128.0.1"));
    assert!(!is_tailscale_ipv4("100.64.0"));
    assert!(!is_tailscale_ipv4("100.64.0.256"));
    assert!(!is_tailscale_ipv4("100.64.0.1.5"));
    assert!(is_tailscale_ipv4("100.0x40.0.1"));
    assert!(!is_tailscale_ipv4("100.64.x.1"));
    assert!(gateway_host_allowed("100.88.1.2"));
    assert!(!gateway_host_allowed("0.0.0.0"));
}

#[test]
fn a_saved_lifetime_that_is_the_old_five_minute_default_moves_to_the_hour_once() {
    // Saved before the default changed: never a choice.
    assert_eq!(
        current_affinity_ttl(Some(LEGACY_AFFINITY_TTL_SECONDS), None),
        Some(3_600)
    );
    assert_eq!(
        current_affinity_ttl(Some(LEGACY_AFFINITY_TTL_SECONDS), Some(0)),
        Some(3_600)
    );
    // Any other saved value was chosen, and stays.
    assert_eq!(current_affinity_ttl(Some(900), None), Some(900));
    assert_eq!(current_affinity_ttl(Some(3_600), None), Some(3_600));
    // Five minutes chosen after the move stays five minutes.
    assert_eq!(
        current_affinity_ttl(Some(LEGACY_AFFINITY_TTL_SECONDS), Some(AFFINITY_REVISION)),
        Some(LEGACY_AFFINITY_TTL_SECONDS)
    );
    assert_eq!(current_affinity_ttl::<i64>(None, None), None);
}

#[test]
fn a_wildcard_bind_address_is_dialled_through_loopback() {
    assert_eq!(client_host("0.0.0.0"), "127.0.0.1");
    assert_eq!(client_host("::"), "[::1]");
    assert_eq!(client_host("fd7a::1"), "[fd7a::1]");
    assert!(is_loopback_host("127.0.0.1"));
    assert!(is_loopback_host("localhost"));
    assert!(!is_loopback_host("100.64.0.2"));
    assert_eq!(gateway_url("0.0.0.0", 9000), "http://127.0.0.1:9000");
}

#[test]
fn the_saved_gateway_settings_keep_the_registry_s_shape() {
    // Not in the TS files: `settings.proxy` as JSON.stringify writes DEFAULT_PROXY_CONFIG, in
    // proxyConfigSchema's key order, and a stored one without the defaulted keys reads them.
    assert_eq!(
        serde_json::to_string(&default_proxy_config()).unwrap(),
        r#"{"enabled":false,"port":8317,"host":"127.0.0.1","affinityTtlSeconds":3600,"routingStrategy":"soonest-reset"}"#
    );
    let stored: ProxyConfig =
        serde_json::from_str(r#"{"enabled":true,"port":9000,"host":"localhost","apiKey":"k"}"#)
            .unwrap();
    assert_eq!(stored.affinity_ttl_seconds, 3_600);
    assert_eq!(stored.routing_strategy, RoutingStrategy::SoonestReset);
    assert_eq!(stored.api_key.as_deref(), Some("k"));
}
