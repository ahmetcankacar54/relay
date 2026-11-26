//! Test helpers for the continuation slice: synthetic enrolled accounts, fresh quota readings
//! and host capabilities, as the TS continuation tests build them.
#![allow(dead_code)]

use relay_core::continuation::{
    ContinuationCapabilities, ContinuationHostKind, ContinuationIdentity,
};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountKind, AccountUsage, UsageStatus, UsageWindow,
};

/// `Date.parse("2026-10-13T14:00:00Z")`.
pub fn now() -> f64 {
    date_parse("2026-10-13T14:00:00Z")
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// An enrolled personal account: matching saved Claude app and CLI sign-ins.
pub fn account(name: &str, group: &str) -> Account {
    let (account_uuid, org_id) = (uuid(), uuid());
    let at = iso(now());
    Account {
        kind: AccountKind::Personal,
        group: group.into(),
        color: "olive".into(),
        created_at: at.clone(),
        desktop: Some(AccountDesktop {
            account_uuid: account_uuid.clone(),
            org_id: org_id.clone(),
            saved_at: at.clone(),
            email: None,
            rejected_at: None,
        }),
        auth: Some(AccountAuth {
            logged_in: true,
            account_uuid: Some(account_uuid),
            org_id: Some(org_id),
            checked_at: at,
            ..AccountAuth::default()
        }),
        ..Account::new(uuid(), name)
    }
}

/// The saved Claude app identity of `account`, as typed (not lowercased).
pub fn profile_identity(account: &Account) -> ContinuationIdentity {
    let desktop = account.desktop.as_ref().expect("enrolled");
    ContinuationIdentity {
        profile_id: account.id.clone(),
        account_uuid: desktop.account_uuid.clone(),
        org_id: desktop.org_id.clone(),
    }
}

/// A fresh reading: `used` percent of five hours (resets in an hour) and `weekly` of the week
/// (resets in a day).
pub fn usage(account_id: &str, used: f64, weekly: f64) -> AccountUsage {
    let now = now();
    AccountUsage {
        checked_at: Some(iso(now)),
        five_hour: Some(UsageWindow::new(used, Some(&iso(now + 3_600_000.0)))),
        seven_day: Some(UsageWindow::new(weekly, Some(&iso(now + 86_400_000.0)))),
        ..AccountUsage::new(account_id, UsageStatus::Ready)
    }
}

/// Every capability on, for a `kind` host.
pub fn capabilities(kind: ContinuationHostKind, contract_id: &str) -> ContinuationCapabilities {
    ContinuationCapabilities {
        kind,
        contract_id: contract_id.into(),
        exact_session: true,
        conditional_actions: true,
        idempotent_delivery: true,
        delivery_lookup: true,
        checkpoint: true,
        account_switch: true,
        session_reopen: true,
        targeted_send: true,
        delivery_receipt: true,
        atomic_context_guard: true,
    }
}

/// Sets one capability by its TS name.
pub fn set_capability(caps: &mut ContinuationCapabilities, key: &str, value: bool) {
    let field = match key {
        "exactSession" => &mut caps.exact_session,
        "conditionalActions" => &mut caps.conditional_actions,
        "idempotentDelivery" => &mut caps.idempotent_delivery,
        "deliveryLookup" => &mut caps.delivery_lookup,
        "checkpoint" => &mut caps.checkpoint,
        "accountSwitch" => &mut caps.account_switch,
        "sessionReopen" => &mut caps.session_reopen,
        "targetedSend" => &mut caps.targeted_send,
        "deliveryReceipt" => &mut caps.delivery_receipt,
        "atomicContextGuard" => &mut caps.atomic_context_guard,
        other => panic!("unknown capability {other}"),
    };
    *field = value;
}

/// Makes `caps` the guarded native transport (no atomic guard, no idempotent delivery).
pub fn guarded_native(caps: &mut ContinuationCapabilities) {
    caps.kind = ContinuationHostKind::GuardedNative;
    caps.atomic_context_guard = false;
    caps.idempotent_delivery = false;
}
