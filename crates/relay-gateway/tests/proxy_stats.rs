//! The two ProxyStats cases of tests/proxy-gateway-settings.test.ts (removed from the TS suite in
//! Release B with the TS gateway).

use relay_gateway::TokenTally;
use relay_gateway::proxy_stats::ProxyStats;

fn tally(input: Option<f64>, cache_read: Option<f64>, cache_write: Option<f64>) -> TokenTally {
    TokenTally {
        input,
        cache_read,
        cache_write,
        ..Default::default()
    }
}

#[test]
fn the_gateways_counters_requests_in_flight_answers_that_read_the_cache_the_latest_account() {
    let mut stats = ProxyStats::new();
    stats.request_started();
    stats.request_started();
    stats.request_ended();
    stats.record_request("a");
    stats.record_request("b");
    stats.record_tokens("a", &tally(Some(100.0), Some(300.0), None));
    stats.record_tokens("b", &tally(Some(50.0), Some(0.0), None));
    stats.record_tokens("b", &tally(None, Some(10.0), None));
    let metrics = stats.metrics(0);
    assert_eq!(metrics.active_requests, 1);
    assert_eq!(metrics.prompt_cache_hits, 2);
    assert_eq!(metrics.last_account_id.as_deref(), Some("b"));
    stats.request_ended();
    stats.request_ended();
    assert_eq!(stats.metrics(0).active_requests, 0, "never below zero");
    stats.reset();
    assert_eq!(stats.metrics(0).prompt_cache_hits, 0);
    assert_eq!(stats.metrics(0).last_account_id, None);
}

#[test]
fn the_cache_hit_rate_counts_what_was_written_to_the_cache_as_a_miss() {
    let mut stats = ProxyStats::new();
    stats.record_tokens("a", &tally(Some(100.0), Some(800.0), Some(100.0)));
    assert_eq!(stats.metrics(0).cache_hit_ratio, 0.8);
    // A cold start (a session moved to another account, or back after the cache expired)
    // writes its whole history again: that has to pull the rate down.
    stats.record_tokens("b", &tally(Some(10.0), None, Some(990.0)));
    assert_eq!(stats.metrics(0).cache_hit_ratio, 0.4);
}
