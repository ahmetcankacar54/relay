//! Port of tests/model-prices.test.ts.

#[path = "common/shared_b.rs"]
mod helpers;

use helpers::near;
use relay_core::shared::model_prices::{
    ResponseUsage, TokenCounts, estimate_cost, price_key, response_cost,
};

const M: f64 = 1_000_000.0;

fn usage(input: f64, output: f64, cache_write: f64, cache_read: f64) -> ResponseUsage {
    ResponseUsage {
        input,
        output,
        cache_write,
        cache_read,
        ..Default::default()
    }
}

#[test]
fn model_ids_are_matched_with_a_trailing_date_or_bracket_suffix_dropped() {
    assert_eq!(
        price_key("claude-opus-5-5").as_deref(),
        Some("claude-opus-5-5")
    );
    assert_eq!(
        price_key("claude-haiku-4-5-20251001").as_deref(),
        Some("claude-haiku-4-5")
    );
    assert_eq!(
        price_key("claude-opus-5-5[1m]").as_deref(),
        Some("claude-opus-5-5")
    );
    assert_eq!(
        price_key("claude-3-5-haiku-20241022").as_deref(),
        Some("claude-3-5-haiku")
    );
    assert_eq!(price_key("gpt-5"), None);
    assert_eq!(price_key("toString"), None);
    assert_eq!(response_cost("unknown", &usage(M, 0.0, 0.0, 0.0)), None);
}

#[test]
fn each_kind_of_token_at_its_own_rate() {
    near(
        response_cost("claude-opus-5-5", &usage(M, 0.0, 0.0, 0.0)),
        4.0,
    );
    near(
        response_cost("claude-opus-5-5", &usage(0.0, M, 0.0, 0.0)),
        20.0,
    );
    near(
        response_cost("claude-opus-5-5", &usage(0.0, 0.0, 0.0, M)),
        0.2,
    );
    near(
        response_cost("claude-sonnet-5-5", &usage(0.0, 0.0, 0.0, M)),
        0.1,
    );
    near(
        response_cost("claude-fable-5-1", &usage(0.0, 0.0, 0.0, M)),
        0.25,
    );
    near(
        response_cost("claude-fable-5-2", &usage(0.0, 0.0, 0.0, M)),
        0.2,
    );
    near(
        response_cost("claude-fable-5-2", &usage(0.0, M, 0.0, 0.0)),
        40.0,
    );
    near(
        response_cost("claude-fable-5", &usage(0.0, 0.0, 0.0, M)),
        1.0,
    );
}

#[test]
fn cache_writes_are_5_minute_unless_the_row_says_1_hour() {
    near(
        response_cost("claude-opus-5-5", &usage(0.0, 0.0, M, 0.0)),
        5.0,
    );
    let split = |total: f64, one_hour: f64| ResponseUsage {
        cache_write_1h: Some(one_hour),
        ..usage(0.0, 0.0, total, 0.0)
    };
    near(response_cost("claude-opus-5-5", &split(M, M)), 8.0);
    near(response_cost("claude-opus-5-5", &split(2.0 * M, M)), 13.0);
    // A split larger than the total never prices more than the total.
    near(response_cost("claude-opus-5-5", &split(M, 5.0 * M)), 8.0);
}

#[test]
fn fast_mode_doubles_opus_5_5_and_scales_its_cache_rates() {
    let fast = |u: ResponseUsage| ResponseUsage {
        speed: Some("fast".into()),
        ..u
    };
    let all = ResponseUsage {
        cache_write_1h: Some(M),
        ..usage(M, M, M, M)
    };
    near(
        response_cost("claude-opus-5-5", &fast(all)),
        8.0 + 40.0 + 16.0 + 0.4,
    );
    near(
        response_cost("claude-opus-4-8", &fast(usage(0.0, M, 0.0, 0.0))),
        50.0,
    );
    // A model with no fast mode keeps its rates.
    near(
        response_cost("claude-sonnet-5-5", &fast(usage(0.0, M, 0.0, 0.0))),
        10.0,
    );
}

#[test]
fn us_inference_costs_1_1x_on_4_6_and_later_models_only() {
    let geo = |g: &str| ResponseUsage {
        geo: Some(g.into()),
        ..usage(M, 0.0, 0.0, 0.0)
    };
    near(response_cost("claude-opus-5-5", &geo("us")), 4.4);
    near(response_cost("claude-opus-5-5", &geo("global")), 4.0);
    near(response_cost("claude-haiku-4-5", &geo("us")), 1.0);
}

#[test]
fn haiku_5_5_prices_a_prompt_over_100_000_tokens_at_the_higher_tier() {
    near(
        response_cost("claude-haiku-5-5", &usage(50_000.0, M, 0.0, 50_000.0)),
        (50_000.0 * 0.1 + 50_000.0 * 0.01) / M + 0.5,
    );
    near(
        response_cost("claude-haiku-5-5", &usage(50_000.0, M, 0.0, 50_001.0)),
        (50_000.0 * 0.5 + 50_001.0 * 0.05) / M + 2.5,
    );
}

#[test]
fn an_estimate_prices_every_cache_write_as_1_hour() {
    near(
        estimate_cost(
            "claude-opus-5-5",
            &TokenCounts {
                input: M,
                output: M,
                cache_write: M,
                cache_read: M,
            },
        ),
        4.0 + 20.0 + 8.0 + 0.2,
    );
    near(
        estimate_cost(
            "claude-haiku-5-5",
            &TokenCounts {
                input: M,
                ..Default::default()
            },
        ),
        0.1,
    );
    assert_eq!(estimate_cost("mystery", &TokenCounts::default()), None);
}
