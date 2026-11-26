//! Port of the `shared/quota-windows` cases of tests/limit-origin.test.ts. The UsageManager
//! (electron) cases, the `usageWindowRows` (UI) assertions and the LimitLine tooltip cases (UI)
//! are skipped.

use relay_core::shared::quota_windows::{LimitOrigin, limit_columns, limit_headline, limit_origin};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{AccountUsage, LimitSource, UsageSource, UsageStatus, UsageWindow};
use serde_json::json;

fn now() -> f64 {
    date_parse("2026-11-20T12:00:00Z")
}

/// `{}` as a window: no reset, source or read time (the used percent is not read).
fn untagged() -> UsageWindow {
    UsageWindow::new(0.0, None)
}
fn usage_with(source: Option<UsageSource>, checked_at: &str) -> AccountUsage {
    AccountUsage {
        source,
        checked_at: Some(checked_at.into()),
        ..AccountUsage::new("", UsageStatus::Ready)
    }
}

#[test]
fn a_window_whose_reset_passed_since_its_reading_is_relays_estimate() {
    let read = UsageWindow {
        source: Some(LimitSource::Official),
        read_at: Some(iso(now() - 3_600_000.0)),
        ..UsageWindow::new(80.0, Some(&iso(now() - 60_000.0)))
    };
    assert_eq!(
        limit_origin(Some(&read), None, now()),
        Some(LimitOrigin {
            source: LimitSource::Estimate,
            read_at: read.read_at.clone()
        })
    );
    let open = UsageWindow {
        resets_at: Some(iso(now() + 60_000.0)),
        ..read.clone()
    };
    assert_eq!(
        limit_origin(Some(&open), None, now()),
        Some(LimitOrigin {
            source: LimitSource::Official,
            read_at: read.read_at.clone()
        })
    );
}

#[test]
fn an_untagged_window_takes_its_source_from_the_accounts_sign_in_and_its_age_from_the_read() {
    let checked_at = iso(now() - 5.0 * 60_000.0);
    assert_eq!(
        limit_origin(
            Some(&untagged()),
            Some(&usage_with(Some(UsageSource::Desktop), &checked_at)),
            now()
        ),
        Some(LimitOrigin {
            source: LimitSource::AppSession,
            read_at: Some(checked_at.clone())
        })
    );
    assert_eq!(
        limit_origin(
            Some(&untagged()),
            Some(&usage_with(Some(UsageSource::Cli), &checked_at)),
            now()
        ),
        Some(LimitOrigin {
            source: LimitSource::Official,
            read_at: Some(checked_at.clone())
        })
    );
    assert_eq!(
        limit_origin(
            Some(&untagged()),
            Some(&usage_with(None, &checked_at)),
            now()
        ),
        None
    );
    assert_eq!(
        limit_origin(
            None,
            Some(&usage_with(Some(UsageSource::Cli), &checked_at)),
            now()
        ),
        None
    );
}

#[test]
fn rows_columns_and_the_headline_keep_each_windows_source() {
    let read_at = iso(now() - 60_000.0);
    let usage: AccountUsage = serde_json::from_value(json!({
        "accountId": "a",
        "status": "ready",
        "stale": false,
        "fiveHour": { "usedPercent": 30, "source": "gateway", "readAt": read_at },
        "sevenDay": { "usedPercent": 50, "source": "official", "readAt": read_at },
    }))
    .unwrap();
    assert_eq!(
        limit_headline(Some(&usage), now()).and_then(|h| h.source),
        Some(LimitSource::Official)
    );
    assert_eq!(
        limit_columns(Some(&usage), now())
            .five
            .and_then(|c| c.source()),
        Some(LimitSource::Gateway)
    );
    let pools: AccountUsage = serde_json::from_value(json!({
        "accountId": "b",
        "status": "ready",
        "stale": false,
        "modelWindows": [{
            "key": "antigravity_gemini_5h",
            "label": "Gemini",
            "usedPercent": 30,
            "period": "five_hour",
            "source": "official",
            "readAt": read_at,
        }],
    }))
    .unwrap();
    assert_eq!(
        limit_columns(Some(&pools), now())
            .five
            .and_then(|c| c.source()),
        Some(LimitSource::Official)
    );
}
