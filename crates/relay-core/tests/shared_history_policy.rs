//! The `shared/history-policy` cases of tests/history-policy.test.ts. The settings schema and Store
//! migration cases are Electron.

use relay_core::shared::history_policy::{allowed_history_pair, history_sources};
use relay_core::shared::types::js::iso;
use relay_core::shared::types::{
    Account, AccountDesktop, AccountKind, DesktopHistoryTransfer, RelaySettings, default_settings,
};
use uuid::Uuid;

fn account(group: &str) -> Account {
    let created_at = iso(1_792_000_000_000.0);
    Account {
        kind: AccountKind::Work,
        group: group.into(),
        color: "blue".into(),
        created_at: created_at.clone(),
        desktop: Some(AccountDesktop {
            account_uuid: Uuid::new_v4().to_string(),
            org_id: Uuid::new_v4().to_string(),
            saved_at: created_at,
            ..AccountDesktop::default()
        }),
        ..Account::new(Uuid::new_v4().to_string(), group)
    }
}
fn with_transfer(settings: &RelaySettings, transfer: DesktopHistoryTransfer) -> RelaySettings {
    RelaySettings {
        desktop_history_transfer: transfer,
        ..settings.clone()
    }
}

#[test]
fn history_stays_within_the_sharing_group_by_default_all_accounts_share_only_when_chosen() {
    // The TS parses DEFAULT_SETTINGS without the newer fields through the store schema; the
    // defaults it fills in are DEFAULT_SETTINGS' own, so the defaults stand in for the parse.
    let settings = default_settings();
    let (a, b, c) = (
        account("personal"),
        account("personal"),
        account("work:client"),
    );
    let all = [a.clone(), b.clone(), c.clone()];
    assert_eq!(
        default_settings().desktop_history_transfer,
        DesktopHistoryTransfer::SameGroup
    );
    assert_eq!(
        settings.desktop_history_transfer,
        DesktopHistoryTransfer::SameGroup
    );
    assert_eq!(history_sources(&a, &all, &settings), [&b]);
    assert_eq!(
        history_sources(
            &a,
            &all,
            &with_transfer(&settings, DesktopHistoryTransfer::All)
        ),
        [&b, &c]
    );
    assert!(
        history_sources(
            &a,
            &all,
            &with_transfer(&settings, DesktopHistoryTransfer::Off)
        )
        .is_empty()
    );
}

#[test]
fn selected_history_requires_both_endpoints_and_excludes_every_unselected_or_unbound_account() {
    let (a, b, c) = (
        account("personal"),
        account("work:first"),
        account("work:second"),
    );
    let mut unbound = account("personal");
    unbound.desktop = None;
    let settings = RelaySettings {
        desktop_history_transfer: DesktopHistoryTransfer::Selected,
        desktop_history_accounts: vec![a.id.clone(), b.id.clone(), unbound.id.clone()],
        ..default_settings()
    };
    let three = [a.clone(), b.clone(), c.clone()];
    let four = [a.clone(), b.clone(), c.clone(), unbound.clone()];
    assert_eq!(history_sources(&a, &four, &settings), [&b]);
    assert_eq!(history_sources(&b, &three, &settings), [&a]);
    assert!(history_sources(&c, &three, &settings).is_empty());
    assert!(allowed_history_pair(&a, &b, &settings));
    assert!(!allowed_history_pair(&a, &c, &settings));
}
