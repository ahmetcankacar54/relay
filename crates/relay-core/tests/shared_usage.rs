//! Port of the `shared/usage` parts of tests/usage.test.ts. The quota parsing case keeps its
//! `remaining` assertions on the windows `parseUsage` returns (built directly here); the parse
//! errors, credentials, identity, Retry-After, network detail, store and UsageManager cases are
//! electron and belong to those ports.

#[path = "common/shared_misc.rs"]
mod helpers;

use helpers::usage_map;
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountProvider, AccountUsage, DesktopHistoryTransfer,
    RelaySettings, UsageStatus, UsageWindow, default_settings,
};
use relay_core::shared::usage::{remaining, suggested_account};

#[test]
fn quota_parsing_distinguishes_unavailable_windows_full_quota_and_partial_quota() {
    // `parseUsage(limits)`: five_hour 91.3 and seven_day 30 used.
    let five_hour = UsageWindow::new(91.3, Some("2026-10-13T16:00:00Z"));
    let seven_day = UsageWindow::new(30.0, Some("2026-10-16T16:00:00Z"));
    assert!((remaining(Some(&five_hour)).unwrap() - 8.7).abs() < 0.0001);
    assert_eq!(remaining(Some(&seven_day)), Some(70.0));
    // A window `parseUsage` reports as unavailable has nothing left to read.
    assert_eq!(remaining(None), None);
    assert_eq!(remaining(Some(&UsageWindow::new(100.0, None))), Some(0.0));
    assert_eq!(remaining(Some(&UsageWindow::new(0.0, None))), Some(100.0));
}

/// The fixture's `store.account(a.id)`: a personal Claude account created by the store, signed in.
fn store_account() -> Account {
    Account {
        group: "personal".into(),
        color: "terra".into(),
        created_at: "2026-10-13T11:00:00.000Z".into(),
        provider: Some(AccountProvider::Claude),
        auth: Some(AccountAuth {
            logged_in: true,
            email: Some("a@example.test".into()),
            checked_at: "2026-10-13".into(),
            ..Default::default()
        }),
        ..Account::new("2f0c3f6e-0000-4000-8000-000000000000", "A")
    }
}

#[test]
fn suggestions_require_fresh_five_hour_data_use_weekly_data_when_reported_and_stay_in_the_same_sharing_group()
 {
    let now = date_parse("2026-10-13T12:00:00Z");
    let active = Account {
        desktop: Some(AccountDesktop {
            account_uuid: "a".into(),
            org_id: "x".into(),
            saved_at: String::new(),
            ..Default::default()
        }),
        ..store_account()
    };
    let personal = Account {
        id: "b".into(),
        name: "B".into(),
        ..active.clone()
    };
    let work = Account {
        id: "c".into(),
        group: "work:secret".into(),
        ..personal.clone()
    };
    let u = AccountUsage {
        stale: false,
        checked_at: Some(iso(now)),
        five_hour: Some(UsageWindow::new(95.0, None)),
        seven_day: Some(UsageWindow::new(40.0, None)),
        ..AccountUsage::new(active.id.clone(), UsageStatus::Ready)
    };
    let grouped = RelaySettings {
        desktop_history_transfer: DesktopHistoryTransfer::SameGroup,
        ..default_settings()
    };
    let b = AccountUsage {
        account_id: "b".into(),
        five_hour: Some(UsageWindow::new(10.0, None)),
        ..u.clone()
    };
    let c = AccountUsage {
        account_id: "c".into(),
        five_hour: Some(UsageWindow::new(1.0, None)),
        ..u.clone()
    };
    let usage = usage_map([u.clone(), b.clone(), c.clone()]);
    let with_b = |b: AccountUsage| usage_map([u.clone(), b, c.clone()]);
    let three = [active.clone(), personal.clone(), work.clone()];
    let two = [active.clone(), personal.clone()];
    let id = |a: Option<&Account>| a.map(|a| a.id.clone());

    assert_eq!(
        id(suggested_account(
            Some(&active),
            &three,
            &usage,
            &grouped,
            now,
            None
        )),
        Some("b".into())
    );
    let stale = with_b(AccountUsage {
        stale: true,
        ..b.clone()
    });
    assert_eq!(
        id(suggested_account(
            Some(&active),
            &three,
            &stale,
            &grouped,
            now,
            None
        )),
        None
    );
    let no_five_hour = with_b(AccountUsage {
        five_hour: None,
        ..b.clone()
    });
    assert_eq!(
        id(suggested_account(
            Some(&active),
            &two,
            &no_five_hour,
            &grouped,
            now,
            None
        )),
        None
    );
    let no_weekly = with_b(AccountUsage {
        seven_day: None,
        ..b.clone()
    });
    assert_eq!(
        id(suggested_account(
            Some(&active),
            &two,
            &no_weekly,
            &grouped,
            now,
            None
        )),
        Some("b".into())
    );
    let off = RelaySettings {
        suggest_accounts: false,
        ..default_settings()
    };
    assert_eq!(
        id(suggested_account(
            Some(&active),
            &two,
            &usage,
            &off,
            now,
            None
        )),
        None
    );
}
