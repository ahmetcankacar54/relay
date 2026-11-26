//! Helpers of the auto-switch, auto-capture and switch-strategy (prepare on quit) ports.
// Each test binary uses part of these.
#![allow(dead_code, clippy::type_complexity)]

use std::sync::Arc;

use relay_core::auto_switch::AutoSwitchDesktop;
use relay_core::desktop::{DesktopResult, DesktopSwitchOptions};
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountKind, AccountUsage, DesktopState,
};

pub fn random_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// An account whose Claude app sign-in and Claude Code sign-in are the same, both saved at `at`.
pub fn signed_in_account(name: &str, group: &str, at: &str) -> Account {
    let (account_uuid, org_id) = (random_uuid(), random_uuid());
    Account {
        kind: if group == "personal" {
            AccountKind::Personal
        } else {
            AccountKind::Work
        },
        group: group.into(),
        color: "olive".into(),
        created_at: at.into(),
        desktop: Some(AccountDesktop {
            account_uuid: account_uuid.clone(),
            org_id: org_id.clone(),
            saved_at: at.into(),
            ..Default::default()
        }),
        auth: Some(AccountAuth {
            logged_in: true,
            account_uuid: Some(account_uuid),
            org_id: Some(org_id),
            checked_at: at.into(),
            ..Default::default()
        }),
        ..Account::new(random_uuid(), name)
    }
}

/// `{ [usage.accountId]: usage, ... }`.
pub fn usage_map(items: impl IntoIterator<Item = AccountUsage>) -> JsMap<AccountUsage> {
    let mut map = JsMap::new();
    for usage in items {
        map.insert(usage.account_id.clone(), usage);
    }
    map
}

/// Desktop closed and signed in to `source`, as the TS fixtures write it.
pub fn closed_on(source: &Account) -> DesktopState {
    let desktop = source.desktop.as_ref().unwrap();
    DesktopState {
        available: true,
        running: false,
        current_account_uuid: Some(desktop.account_uuid.clone()),
        active_profile_id: Some(source.id.clone()),
        organizations: vec![desktop.org_id.clone()],
        busy: false,
        recovery_required: false,
        error_revision: 0.0,
        ..DesktopState::default()
    }
}

/// A TS `{ snapshot, switchTo }` object literal.
pub struct FnDesktop {
    pub snapshot: Box<dyn Fn() -> DesktopResult<DesktopState> + Send + Sync>,
    pub switch_to: Box<dyn Fn(&str, DesktopSwitchOptions) -> DesktopResult<()> + Send + Sync>,
}

impl FnDesktop {
    pub fn new(
        snapshot: impl Fn() -> DesktopResult<DesktopState> + Send + Sync + 'static,
        switch_to: impl Fn(&str, DesktopSwitchOptions) -> DesktopResult<()> + Send + Sync + 'static,
    ) -> Arc<FnDesktop> {
        Arc::new(FnDesktop {
            snapshot: Box::new(snapshot),
            switch_to: Box::new(switch_to),
        })
    }
}

impl AutoSwitchDesktop for FnDesktop {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        (self.snapshot)()
    }
    fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()> {
        (self.switch_to)(profile_id, options)
    }
}
