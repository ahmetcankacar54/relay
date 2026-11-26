//! Port of the `shared/quota-windows` parts of tests/model-limits-ui.test.ts. `modelLimitFull`
//! and `limitFull` (src/data/selectors) are rebuilt from the shared functions they wrap; the row
//! labels, window elapsed, status words, overview and UsageCard cases are UI and skipped.

#[path = "common/shared_misc.rs"]
mod helpers;

use helpers::from_json;
use relay_core::shared::quota_windows::{quota_windows, spent_model_windows};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{AccountUsage, ModelWindow};
use relay_core::shared::usage::fresh_usage;
use serde_json::json;

const HOUR: f64 = 3_600_000.0;
const MONDAY: &str = "2026-11-16T05:00:00.000Z";

// Saturday 2026-11-14 10:00 UTC; Fable's week opens on Monday at 05:00 UTC.
fn now() -> f64 {
    date_parse("2026-11-14T10:00:00Z")
}
fn fable(used_percent: f64, resets_at: &str) -> ModelWindow {
    from_json(json!({
        "key": "seven_day_fable", "label": "Fable", "model": "fable",
        "usedPercent": used_percent, "resetsAt": resets_at, "weeklyShare": 50,
    }))
}
fn use_(id: &str, five: f64, week: f64, models: Vec<ModelWindow>) -> AccountUsage {
    let mut usage: AccountUsage = from_json(json!({
        "accountId": id, "status": "ready", "stale": false, "checkedAt": iso(now() - 60_000.0),
        "fiveHour": { "usedPercent": five, "resetsAt": iso(now() + 3.0 * HOUR) },
        "sevenDay": { "usedPercent": week, "resetsAt": iso(now() + 3.5 * 86_400_000.0) },
    }));
    if !models.is_empty() {
        usage.model_windows = Some(models);
    }
    usage
}

/// `modelLimitFull` of src/data/selectors.ts.
fn model_limit_full(u: &AccountUsage, now: f64) -> Vec<String> {
    if !fresh_usage(Some(u), now) {
        return vec![];
    }
    spent_model_windows(Some(u), now)
        .into_iter()
        .map(|w| w.key.clone())
        .collect()
}

#[test]
fn a_spent_fable_week_is_surfaced_but_never_makes_the_account_full() {
    let usage = use_("a", 20.0, 40.0, vec![fable(100.0, MONDAY)]);
    assert_eq!(model_limit_full(&usage, now()), ["seven_day_fable"]);
    // `limitFull` is undefined: no main window is full, the other models still answer.
    let windows = quota_windows(Some(&usage)).unwrap();
    assert!(
        windows.iter().all(|w| w.used_percent < 100.0),
        "the other models still answer"
    );
    assert_eq!(windows.len(), 2);
    // Not fresh, or already reset: nothing to say.
    assert_eq!(
        model_limit_full(
            &AccountUsage {
                stale: true,
                ..usage.clone()
            },
            now()
        ),
        Vec::<String>::new()
    );
    assert_eq!(
        model_limit_full(
            &use_("a", 20.0, 40.0, vec![fable(100.0, &iso(now() - HOUR))]),
            now()
        ),
        Vec::<String>::new()
    );
    assert_eq!(
        model_limit_full(&use_("a", 20.0, 40.0, vec![fable(99.0, MONDAY)]), now()),
        Vec::<String>::new()
    );
}
