//! Port of the `shared/quota-windows` parts of tests/limit-headline.test.ts. The row, overview,
//! ring and panel helpers are UI (`src/`) and their assertions and cases are skipped.

#[path = "common/shared_misc.rs"]
mod helpers;

use helpers::from_json;
use relay_core::shared::quota_windows::{
    LimitHeadline, fullest_by_period, limit_headline, model_only_usage,
};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{AccountUsage, ModelWindowPeriod, UsageWindow};
use serde_json::json;

fn now() -> f64 {
    date_parse("2026-11-19T15:00:00Z")
}
fn at(minutes: f64) -> String {
    iso(now() + minutes * 60_000.0)
}

/// An Antigravity reading as the reader stores it: the five hours are the roomiest model.
fn antigravity() -> AccountUsage {
    from_json(json!({
        "accountId": "g1",
        "status": "ready",
        "stale": false,
        "checkedAt": at(-1.0),
        "fiveHour": { "usedPercent": 18, "resetsAt": at(299.0) },
        "modelWindows": [
            { "key": "antigravity_gemini_4_carbon_high", "label": "Gemini 4 Carbon (High)", "usedPercent": 100, "resetsAt": at(25.0) },
            { "key": "antigravity_claude_opus_5_5", "label": "Claude Opus 5.5", "usedPercent": 62, "resetsAt": at(190.0) },
            { "key": "antigravity_gemini_4_argon", "label": "Gemini 4 Argon", "usedPercent": 18, "resetsAt": at(299.0) },
        ],
    }))
}
fn claude() -> AccountUsage {
    from_json(json!({
        "accountId": "c1",
        "status": "ready",
        "stale": false,
        "checkedAt": at(-1.0),
        "fiveHour": { "usedPercent": 31, "resetsAt": at(130.0) },
        "sevenDay": { "usedPercent": 58, "resetsAt": at(3.0 * 1440.0) },
        "modelWindows": [
            { "key": "seven_day_fable", "label": "Fable", "model": "fable", "usedPercent": 100, "resetsAt": at(1440.0) },
        ],
    }))
}

#[test]
fn an_antigravity_accounts_figure_is_its_fullest_model_never_the_roomiest_one_the_gateway_keeps() {
    assert!(model_only_usage(Some(&antigravity())));
    assert!(!model_only_usage(Some(&claude())));
    assert_eq!(
        limit_headline(Some(&antigravity()), now()),
        Some(LimitHeadline {
            key: "antigravity_gemini_4_carbon_high".into(),
            label: Some("Gemini 4 Carbon (High)".into()),
            used_percent: 100.0,
            resets_at: Some(at(25.0)),
            model: true,
            source: None,
            read_at: None,
        })
    );
    // Once that model's reset has passed it counts as empty, and the next fullest one shows.
    assert_eq!(
        limit_headline(Some(&antigravity()), now() + 30.0 * 60_000.0)
            .and_then(|h| h.label)
            .as_deref(),
        Some("Claude Opus 5.5")
    );
}

#[test]
fn a_claude_accounts_figure_is_the_fuller_of_its_five_hours_and_its_week_a_models_own_limit_aside()
{
    let key = |u: &AccountUsage| limit_headline(Some(u), now()).map(|h| h.key);
    assert_eq!(key(&claude()).as_deref(), Some("seven_day"));
    let even = AccountUsage {
        seven_day: Some(UsageWindow::new(31.0, Some(&at(3.0 * 1440.0)))),
        ..claude()
    };
    assert_eq!(key(&even).as_deref(), Some("five_hour"));
    let reset = AccountUsage {
        seven_day: Some(UsageWindow::new(99.0, Some(&at(-5.0)))),
        ..claude()
    };
    assert_eq!(key(&reset).as_deref(), Some("five_hour"));
    assert_eq!(limit_headline(None, now()), None);
}

#[test]
fn antigravity_pools_the_tables_columns_take_the_fullest_five_hours_and_the_fullest_week_named() {
    let usage: AccountUsage = from_json(json!({
        "accountId": "g",
        "status": "ready",
        "stale": false,
        "checkedAt": at(-1.0),
        "sevenDay": { "usedPercent": 40, "resetsAt": at(3.0 * 24.0 * 60.0) },
        "modelWindows": [
            { "key": "antigravity_gemini_5h", "label": "Gemini", "period": "five_hour", "usedPercent": 20, "resetsAt": at(100.0) },
            { "key": "antigravity_gemini_weekly", "label": "Gemini", "period": "seven_day", "usedPercent": 98, "resetsAt": at(4.0 * 24.0 * 60.0) },
            { "key": "antigravity_3p_5h", "label": "Claude & GPT", "period": "five_hour", "usedPercent": 100, "resetsAt": at(-5.0) },
            { "key": "antigravity_3p_weekly", "label": "Claude & GPT", "period": "seven_day", "usedPercent": 40, "resetsAt": at(3.0 * 24.0 * 60.0) },
        ],
    }));
    let cols = fullest_by_period(Some(&usage), now());
    // Claude & GPT's five hours have reset: empty again, so Gemini's are the fuller.
    let five = cols[&ModelWindowPeriod::FiveHour].clone();
    assert_eq!(
        (five.label.as_deref(), five.used_percent),
        (Some("Gemini"), 20.0)
    );
    let week = cols[&ModelWindowPeriod::SevenDay].clone();
    assert_eq!(
        (week.label.as_deref(), week.used_percent),
        (Some("Gemini"), 98.0)
    );
    // Windows of unknown length (an older reading) give no column.
    let older: AccountUsage = from_json(json!({
        "accountId": "",
        "status": "ready",
        "stale": false,
        "modelWindows": [{ "key": "antigravity_gemini", "label": "Gemini", "usedPercent": 50 }],
    }));
    assert!(fullest_by_period(Some(&older), now()).is_empty());
}
