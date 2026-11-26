//! The `shared/overflow` assertions of tests/gateway-overflow.test.ts. The server, headers, request
//! log, vault and page cases belong to the relay-gateway port; here the request log's
//! `overflowCosts()` is given as the list it returns.

use relay_core::shared::model_prices::{ResponseUsage, response_cost};
use relay_core::shared::overflow::{
    ApiUpstreamPreset as P, OVERFLOW_PRESET_IDS, OverflowRates, OverflowTokens, UpstreamPrices,
    deepseek_peak, key_hint, local_day_bounds, overflow_cost, overflow_model, overflow_preset,
    spent_today,
};
use relay_core::shared::types::js::date_parse;

#[test]
fn each_preset_maps_the_model_by_family() {
    // From "each preset sends its key as it should…"; its header assertions are the gateway's.
    let map = |preset| overflow_preset(preset).model_map;
    assert_eq!(
        overflow_model(&map(P::Openrouter), "claude-opus-5-5"),
        "anthropic/claude-opus-5.5"
    );
    assert_eq!(overflow_model(&map(P::Kimi), "claude-haiku-5-5"), "kimi-k3");
    assert_eq!(overflow_model(&map(P::Glm), "claude-sonnet-5-5"), "glm-5.4");
    assert_eq!(
        overflow_model(&map(P::Anthropic), "claude-opus-5-5[1m]"),
        "claude-opus-5-5"
    );
    // No preset targets Kimi K2.
    for preset in OVERFLOW_PRESET_IDS {
        let p = overflow_preset(preset);
        let text = format!(
            "{}{}{}",
            p.label,
            p.base_url,
            serde_json::to_string(&p.model_map).unwrap()
        );
        assert!(!text.contains("k2"), "{preset:?}");
    }
}

#[test]
fn costs_anthropic_list_prices_preset_tables_with_deepseek_s_peak_user_prices_else_unknown() {
    let tokens = OverflowTokens {
        input: Some(1_000_000.0),
        output: Some(1_000_000.0),
        ..Default::default()
    };
    let off_peak = date_parse("2026-11-21T12:00:00Z");
    let peak = date_parse("2026-11-23T02:00:00Z");
    assert!(!deepseek_peak(off_peak));
    assert!(deepseek_peak(peak));
    assert_eq!(
        overflow_cost(
            P::Anthropic,
            None,
            "claude-sonnet-5-5",
            &tokens,
            off_peak,
            None
        ),
        response_cost(
            "claude-sonnet-5-5",
            &ResponseUsage {
                input: 1_000_000.0,
                output: 1_000_000.0,
                ..Default::default()
            }
        )
    );
    assert_eq!(
        overflow_cost(
            P::Deepseek,
            None,
            "deepseek-v4-pro",
            &tokens,
            off_peak,
            None
        ),
        Some(0.66 + 1.98)
    );
    assert_eq!(
        overflow_cost(P::Deepseek, None, "deepseek-v4-pro", &tokens, peak, None),
        Some((0.66 + 1.98) * 2.0)
    );
    assert_eq!(
        overflow_cost(P::Glm, None, "glm-5.3-flash", &tokens, off_peak, None),
        Some(0.15 + 0.5)
    );
    assert_eq!(
        overflow_cost(P::Kimi, None, "kimi-k3", &tokens, off_peak, None),
        None,
        "Kimi has no table"
    );
    let prices = UpstreamPrices {
        input: 1.0,
        output: 4.0,
    };
    assert_eq!(
        overflow_cost(P::Kimi, Some(&prices), "kimi-k3", &tokens, off_peak, None),
        Some(5.0)
    );
    let fetched = OverflowRates {
        input: 5.0,
        output: 25.0,
        cache_read: Some(0.5),
        cache_write: None,
    };
    let read = OverflowTokens {
        input: Some(1_000_000.0),
        cache_read: Some(1_000_000.0),
        ..Default::default()
    };
    assert_eq!(
        overflow_cost(
            P::Openrouter,
            None,
            "anthropic/claude-opus-5.5",
            &read,
            off_peak,
            Some(&fetched)
        ),
        Some(5.5)
    );
}

#[test]
fn the_cap_s_spend_survives_a_restart_through_the_request_log_by_planning_day() {
    let now = date_parse("2026-11-23T10:00:00Z");
    // `overflowCosts()`: the priced answers overflow gave (the account's answer is not one).
    let costs = [(now - 3_600_000.0, 0.75), (now - 30.0 * 3_600_000.0, 2.0)];
    assert_eq!(spent_today(&costs, now, "UTC"), 0.75);
    // In Tokyo (UTC+9) 10:00 UTC is 19:00 and yesterday 04:00 UTC was 13:00 the day before.
    assert_eq!(spent_today(&costs, now, "Asia/Tokyo"), 0.75);
    // In Honolulu (UTC-10) it is 00:00 now: an hour ago was yesterday.
    assert_eq!(spent_today(&costs, now, "Pacific/Honolulu"), 0.0);
    let (start, end) = local_day_bounds(now, "Europe/Istanbul");
    assert_eq!(start, date_parse("2026-11-22T21:00:00Z"));
    assert_eq!(end, date_parse("2026-11-23T21:00:00Z"));
}

#[test]
fn keys_are_sealed_in_the_vault_and_the_page_only_gets_a_masked_hint() {
    // The hint half of the case; the sealing is the gateway port's.
    assert_eq!(key_hint("sk-test-overflow-key-0000-alto"), "sk-…alto");
    assert_eq!(key_hint("short"), "…");
    assert_eq!(key_hint("  abcdefghijkl  "), "…ijkl");
}
