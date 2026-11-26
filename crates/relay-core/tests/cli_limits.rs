//! Port of the Usage side of `tests/cli-limits.test.ts`: the account's CLI credential read from
//! the Keychain under its `credential_service`, the usage limits read with it, and a renewal
//! refused while another process holds the profile lock. The `relay` commands themselves
//! (`connect`, the text and JSON rows, the hints) are the CLI slice's. macOS only, as the TS
//! cases skip other systems.
#![cfg(target_os = "macos")]

#[path = "common/usage_cli.rs"]
mod helpers;
mod lock_child;
#[path = "common/vault.rs"]
mod vault;

use std::sync::Arc;

use helpers::{Connected, TOKEN, now_ms};
use lock_child::hold_profile;
use relay_core::profile_lock::profile_lock_holders;
use relay_core::shared::types::{UsageIssue, UsageStatus};
use relay_core::usage::{UsageEndpoint, UsageRequest};
use serde_json::{Value, json};

/// `connected(t, opts)`: the account's sign-in in the fake Keychain and a server answering for it.
fn connected(expires_at: Option<f64>, five: f64, seven: Option<f64>) -> (Connected, UsageRequest) {
    let c = Connected::new();
    c.save_credential(
        TOKEN,
        expires_at.unwrap_or_else(|| now_ms() + 3_600_000.0),
        &["user:inference", "user:profile"],
        true,
    );
    let resets =
        relay_core::shared::types::js::iso(now_ms() + ((2 * 60 + 10) * 60_000 + 30_000) as f64);
    let profile = c.server_profile();
    let request: UsageRequest = Arc::new(move |endpoint, token: &str| {
        assert_eq!(token, TOKEN);
        Ok(match endpoint {
            UsageEndpoint::Profile => profile.clone(),
            UsageEndpoint::Usage => {
                let mut usage =
                    json!({ "five_hour": { "utilization": five, "resets_at": resets } });
                if let Some(seven) = seven {
                    usage["seven_day"] = json!({ "utilization": seven, "resets_at": resets });
                }
                usage
            }
        })
    });
    (c, request)
}

#[test]
fn usage_json_shows_how_much_of_each_window_is_used_as_claude_s_usage_page_does() {
    let (c, request) = connected(None, 94.0, Some(40.0));
    let manager = c.manager(request);
    let row = manager.refresh(&c.account.id, false).unwrap();
    assert_eq!(row.account_id, c.account.id);
    assert_eq!(row.status, UsageStatus::Ready);
    assert_eq!(row.five_hour.as_ref().map(|w| w.used_percent), Some(94.0));
    assert_eq!(row.seven_day.as_ref().map(|w| w.used_percent), Some(40.0));
    // The rows' text ("94% used · resets in 2 h 10 min", Turkish) is the CLI's.
    let shown: Value = serde_json::to_value(manager.snapshot()).unwrap();
    assert!(!shown.to_string().contains(TOKEN));
    assert!(!c.issues.lock().unwrap().concat().contains(TOKEN));
}

#[test]
fn a_seat_that_reports_no_weekly_limit_says_so() {
    let (c, request) = connected(None, 94.0, None);
    let row = c.manager(request).refresh(&c.account.id, false).unwrap();
    assert_eq!(row.status, UsageStatus::Ready);
    // The CLI shows the missing week as "not-reported".
    assert_eq!(row.seven_day, None);
}

#[test]
fn an_expiring_credential_is_not_renewed_while_another_process_holds_the_profile_lock() {
    let (c, request) = connected(Some(now_ms() + 60_000.0), 94.0, Some(40.0));
    let _child = hold_profile(&c.locks, &c.account.id, "exclusive");
    let row = c.manager(request).refresh(&c.account.id, false).unwrap();
    // "another process is renewing it": an unavailable read while the profile lock is held.
    assert_eq!(row.issue, Some(UsageIssue::Unavailable));
    assert!(
        !profile_lock_holders(&c.locks, &c.account.id, None)
            .unwrap()
            .is_empty()
    );
    let log = c.claude_log();
    let calls: String = log
        .lines()
        .filter(|l| !l.starts_with("--version"))
        .collect();
    assert!(
        !["auth", "--print", "refresh"]
            .iter()
            .any(|w| calls.contains(w)),
        "{log}"
    );
    let shown = serde_json::to_value(row).unwrap().to_string();
    // Refused by the busy lock itself, which says no more; an I/O failure would carry a detail.
    assert_eq!(*c.issues.lock().unwrap(), ["unavailable "]);
    assert!(!shown.contains(TOKEN));
}
