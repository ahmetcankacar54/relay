//! Port of `tests/continuation-readiness.test.ts`: `shared/continuation-readiness` against the
//! `electron/core/continuation` runtime policy. Skipped: "preparation distinguishes connected
//! enrollment from fresh target capacity without authorizing a watch" and "a frozen watch does not
//! show newly connected accounts as current authorized targets" (they render the React
//! `ContinuationSettings` component from `src/features`).

#[path = "common/continuation.rs"]
mod helpers;

use helpers::now;
use relay_core::continuation::{ContinuationRequest, continuation_policy_reason};
use relay_core::shared::continuation_readiness::{
    ContinuationTargetReadinessReason, continuation_target_readiness_reason,
};
use relay_core::shared::types::js::iso;
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountKind, AccountUsage, DesktopHistoryTransfer,
    KnownReset, LastKnownResets, RelaySettings, UsageIssue, UsageStatus, UsageWindow,
    default_settings,
};

fn fixture_account(id: &str, name: &str, account_uuid: &str, org_id: &str) -> Account {
    let at = iso(now());
    Account {
        kind: AccountKind::Personal,
        group: "fixture".into(),
        color: "olive".into(),
        created_at: at.clone(),
        desktop: Some(AccountDesktop {
            account_uuid: account_uuid.into(),
            org_id: org_id.into(),
            saved_at: at.clone(),
            email: None,
            rejected_at: None,
        }),
        auth: Some(AccountAuth {
            logged_in: true,
            account_uuid: Some(account_uuid.into()),
            org_id: Some(org_id.into()),
            checked_at: at,
            ..AccountAuth::default()
        }),
        ..Account::new(id, name)
    }
}

fn source() -> Account {
    fixture_account(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "Max",
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
}

fn target() -> Account {
    fixture_account(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "Team",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
    )
}

fn settings() -> RelaySettings {
    RelaySettings {
        desktop_history_transfer: DesktopHistoryTransfer::Selected,
        desktop_history_accounts: vec![source().id, target().id],
        ..default_settings()
    }
}

fn quota(account: &Account, used: f64) -> AccountUsage {
    let now = now();
    AccountUsage {
        checked_at: Some(iso(now)),
        five_hour: Some(UsageWindow::new(used, Some(&iso(now + 3_600_000.0)))),
        seven_day: Some(UsageWindow::new(40.0, Some(&iso(now + 86_400_000.0)))),
        ..AccountUsage::new(account.id.clone(), UsageStatus::Ready)
    }
}

fn request(account: &Account, usage: &AccountUsage, policy: &RelaySettings) -> ContinuationRequest {
    let source = source();
    ContinuationRequest {
        id: "readiness-test".into(),
        usage: [
            (source.id.clone(), quota(&source, 100.0)),
            (account.id.clone(), usage.clone()),
        ]
        .into_iter()
        .collect(),
        source,
        target: account.clone(),
        settings: policy.clone(),
        session_id: "55555555-5555-4555-8555-555555555555".into(),
        project_key: "fixture-project".into(),
        transcript_revision: "fixture-transcript".into(),
        permission_mode: "Auto".into(),
        expected_context_revision: 1.0,
        authorized: true,
        execution_policy: None,
    }
}

type Scenario = fn(&mut Account, &mut AccountUsage, &mut RelaySettings);

#[test]
fn target_preparation_agrees_with_the_runtime_policy_across_quota_freshness_reset_and_sharing_boundaries()
 {
    // Each scenario with the reason the TS runtime policy gives; the readiness function refuses
    // exactly where the runtime does.
    let scenarios: [(Scenario, Option<&str>); 30] = [
        (|_, _, _| {}, None),
        (|_, u, _| u.checked_at = Some(iso(now() - 300_000.0)), None),
        (
            |_, u, _| u.checked_at = Some(iso(now() - 300_001.0)),
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.checked_at = Some(iso(now() + 1.0)),
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.checked_at = Some("invalid".into()),
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.account_id = source().id,
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.status = UsageStatus::Loading,
            Some("quota-not-fresh"),
        ),
        (|_, u, _| u.stale = true, Some("quota-not-fresh")),
        (
            |_, u, _| u.issue = Some(UsageIssue::KeychainLocked),
            Some("quota-not-fresh"),
        ),
        (|_, u, _| u.five_hour = None, Some("quota-not-fresh")),
        (
            |_, u, _| u.five_hour.as_mut().unwrap().resets_at = Some(iso(now())),
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.seven_day.as_mut().unwrap().resets_at = Some("invalid".into()),
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.five_hour.as_mut().unwrap().used_percent = 89.999,
            None,
        ),
        (
            |_, u, _| u.five_hour.as_mut().unwrap().used_percent = 90.0,
            Some("target-quota-unavailable"),
        ),
        (
            |_, u, _| u.seven_day.as_mut().unwrap().used_percent = 90.0,
            Some("target-quota-unavailable"),
        ),
        (
            |_, u, _| u.five_hour.as_mut().unwrap().used_percent = f64::NAN,
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.seven_day.as_mut().unwrap().used_percent = -1.0,
            Some("quota-not-fresh"),
        ),
        (
            |_, u, _| u.five_hour = Some(UsageWindow::new(0.0, None)),
            None,
        ),
        (
            |_, u, _| u.five_hour = Some(UsageWindow::new(1.0, None)),
            Some("quota-not-fresh"),
        ),
        (
            |a, _, _| a.cooldown_until = Some(iso(now() + 1.0)),
            Some("target-cooldown"),
        ),
        (|a, _, _| a.cooldown_until = Some(iso(now())), None),
        (
            |a, _, _| a.cooldown_until = Some("invalid".into()),
            Some("target-cooldown"),
        ),
        (
            |_, _, p| p.desktop_history_transfer = DesktopHistoryTransfer::Off,
            Some("history-boundary"),
        ),
        (
            |_, _, p| p.desktop_history_accounts = vec![target().id],
            Some("history-boundary"),
        ),
        (
            |a, _, p| {
                p.desktop_history_transfer = DesktopHistoryTransfer::SameGroup;
                a.group = "other".into();
            },
            Some("history-boundary"),
        ),
        (
            |a, _, _| a.auth.as_mut().unwrap().org_id = source().auth.unwrap().org_id,
            Some("identity-not-enrolled"),
        ),
        (
            |a, _, _| a.auth.as_mut().unwrap().logged_in = false,
            Some("identity-not-enrolled"),
        ),
        (|a, _, _| a.desktop = None, Some("identity-not-enrolled")),
        (
            |a, _, _| {
                a.desktop.as_mut().unwrap().account_uuid = "not-a-uuid".into();
                a.auth.as_mut().unwrap().account_uuid = Some("not-a-uuid".into());
            },
            Some("identity-not-enrolled"),
        ),
        (|_, u, _| u.connection_renewal_required = Some(true), None),
    ];
    for (index, (mutate, expected)) in scenarios.into_iter().enumerate() {
        let mut account = target();
        let mut usage = quota(&account, 20.0);
        let mut policy = settings();
        mutate(&mut account, &mut usage, &mut policy);
        let preparation = continuation_target_readiness_reason(
            Some(&source()),
            &account,
            Some(&usage),
            &policy,
            now(),
        );
        let runtime = continuation_policy_reason(&request(&account, &usage, &policy), now(), true);
        assert_eq!(
            preparation.is_none(),
            runtime.is_none(),
            "scenario {index}: {preparation:?}/{runtime:?}"
        );
        assert_eq!(runtime, expected, "scenario {index}");
    }
}

#[test]
fn a_seat_without_a_reported_weekly_window_is_judged_by_its_five_hour_window_historical_resets_never_count()
 {
    let (source, target, settings) = (source(), target(), settings());
    let mut usage = quota(&target, 20.0);
    usage.seven_day = None;
    usage.last_known_resets = Some(LastKnownResets {
        five_hour: None,
        seven_day: Some(KnownReset {
            resets_at: iso(now() + 86_400_000.0),
            checked_at: iso(now()),
        }),
    });
    let reason = |usage: &AccountUsage| {
        continuation_target_readiness_reason(Some(&source), &target, Some(usage), &settings, now())
    };
    assert_eq!(reason(&usage), None);
    usage.five_hour.as_mut().unwrap().used_percent = 95.0;
    assert_eq!(
        reason(&usage),
        Some(ContinuationTargetReadinessReason::TargetQuotaUnavailable)
    );
    usage.five_hour = None;
    assert_eq!(
        reason(&usage),
        Some(ContinuationTargetReadinessReason::FiveHourUnavailable)
    );
}

#[test]
fn source_enrollment_and_duplicate_identities_cannot_imply_an_alternative_account() {
    let (source, target, settings) = (source(), target(), settings());
    assert_eq!(
        continuation_target_readiness_reason(
            None,
            &target,
            Some(&quota(&target, 20.0)),
            &settings,
            now()
        ),
        Some(ContinuationTargetReadinessReason::SourceNotEnrolled)
    );
    let duplicate = Account {
        desktop: source.desktop.clone(),
        auth: source.auth.clone(),
        ..target
    };
    assert_eq!(
        continuation_target_readiness_reason(
            Some(&source),
            &duplicate,
            Some(&quota(&duplicate, 20.0)),
            &settings,
            now()
        ),
        Some(ContinuationTargetReadinessReason::DuplicateIdentity)
    );
}
