//! Port of `shared/account-state.ts`: the account facts every surface reads the same way.

use super::types::{Account, AccountUsage, AuthFlow, AuthFlowStatus, UsageIssue, UsageSource};

/// The usage issue every surface shows: the last read's, else a connection to renew.
pub fn displayed_issue(usage: Option<&AccountUsage>) -> Option<UsageIssue> {
    let usage = usage?;
    usage.issue.or(if usage.connection_renewal_required == Some(true) {
        Some(UsageIssue::RenewalRequired)
    } else {
        None
    })
}

fn logged_in(account: &Account) -> bool {
    account.auth.as_ref().is_some_and(|a| a.logged_in)
}

/// The account has no Claude Code sign-in and Relay reads its limits through its Claude app sign-in.
pub fn reads_through_app(account: &Account, usage: Option<&AccountUsage>) -> bool {
    !logged_in(account) && account.desktop.is_some() && usage.and_then(|u| u.source) == Some(UsageSource::Desktop)
}

pub fn cli_needs_reconnect(account: &Account, usage: Option<&AccountUsage>) -> bool {
    (!logged_in(account) && !reads_through_app(account, usage))
        || (logged_in(account) && usage.and_then(|u| u.cli_sign_in_ended) == Some(true))
        || matches!(
            usage.and_then(|u| u.issue),
            Some(UsageIssue::Expired | UsageIssue::CredentialsMissing | UsageIssue::Scope | UsageIssue::IdentityMismatch)
        )
}

pub fn duplicate_cli_account<'a>(account: &Account, accounts: &'a [Account]) -> Option<&'a Account> {
    let identity = account.auth.as_ref().filter(|a| a.logged_in)?;
    let uuid = identity.account_uuid.as_deref().filter(|s| !s.is_empty())?;
    let org = identity.org_id.as_deref().filter(|s| !s.is_empty())?;
    accounts.iter().find(|other| {
        other.id != account.id
            && other.auth.as_ref().is_some_and(|a| {
                a.logged_in && a.account_uuid.as_deref() == Some(uuid) && a.org_id.as_deref() == Some(org)
            })
    })
}

pub fn desktop_cli_mismatch(account: &Account) -> bool {
    let (Some(desktop), Some(auth)) = (&account.desktop, &account.auth) else { return false };
    auth.logged_in
        && (auth.account_uuid.as_deref().is_some_and(|u| !u.is_empty() && u != desktop.account_uuid)
            || auth.org_id.as_deref().is_some_and(|o| !o.is_empty() && o != desktop.org_id))
}

/// The mismatch is only the workspace: the same Claude app account in another organization.
pub fn desktop_cli_workspace_mismatch(account: &Account) -> bool {
    desktop_cli_mismatch(account)
        && match (&account.auth, &account.desktop) {
            (Some(auth), Some(desktop)) => auth
                .account_uuid
                .as_deref()
                .is_some_and(|u| !u.is_empty() && u.to_lowercase() == desktop.account_uuid.to_lowercase()),
            _ => false,
        }
}

pub fn pending_auth(flow: Option<&AuthFlow>) -> bool {
    flow.is_some_and(|f| matches!(f.status, AuthFlowStatus::Starting | AuthFlowStatus::Waiting | AuthFlowStatus::Verifying))
}
