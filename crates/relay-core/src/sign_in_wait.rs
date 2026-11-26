//! Port of `electron/core/sign-in-wait.ts`: where a Claude app sign-in for an account stands.

use serde::Serialize;

use crate::shared::types::{Account, DesktopState};

/// Where a Claude app sign-in for `accountId` stands, from one Desktop reading:
/// - `Ready`: an account is signed in that can be saved into `accountId` (a new one, or the same
///   one again while its own sign-in is pending), and Code has a workspace for it. With several
///   workspaces, `preferred` is the one to save without asking and `suggested` the one to offer;
/// - `Waiting`: nobody new is signed in yet, or Code has not been opened;
/// - `SavedElsewhere`: the account signed in is already saved in another profile;
/// - `Done`: `accountId` already holds it and nothing is pending;
/// - `OtherPending`: a sign-in for another profile is pending.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SignInReading {
    #[serde(rename_all = "camelCase")]
    Ready {
        account_uuid: String,
        orgs: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        preferred: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        suggested: Option<String>,
    },
    Waiting,
    SavedElsewhere {
        account: Box<Account>,
    },
    Done,
    OtherPending,
}

impl SignInReading {
    /// The `kind` as the TS names it.
    pub fn kind(&self) -> &'static str {
        match self {
            SignInReading::Ready { .. } => "ready",
            SignInReading::Waiting => "waiting",
            SignInReading::SavedElsewhere { .. } => "saved-elsewhere",
            SignInReading::Done => "done",
            SignInReading::OtherPending => "other-pending",
        }
    }
}

/// `readSignIn`: shared by `relay add` and Relay.app's automatic save.
pub fn read_sign_in(state: &DesktopState, accounts: &[Account], account_id: &str) -> SignInReading {
    let pending = state.pending_profile_id.as_deref();
    if pending.is_some_and(|p| !p.is_empty() && p != account_id) {
        return SignInReading::OtherPending;
    }
    let pending = pending.filter(|p| !p.is_empty());
    let Some(uuid) = state
        .current_account_uuid
        .as_deref()
        .filter(|u| !u.is_empty())
    else {
        return SignInReading::Waiting;
    };
    let saved = accounts
        .iter()
        .find(|a| a.desktop.as_ref().is_some_and(|d| d.account_uuid == uuid));
    if let Some(saved) = saved
        && saved.id != account_id
    {
        return SignInReading::SavedElsewhere {
            account: Box::new(saved.clone()),
        };
    }
    // The profile's own account again: done, unless its renewed sign-in waits to be saved.
    if saved.is_some() && pending.is_none() {
        return SignInReading::Done;
    }
    if state.organizations.is_empty() {
        return SignInReading::Waiting;
    }
    let among = |org: Option<&str>| {
        let org = org.filter(|o| !o.is_empty())?;
        state
            .organizations
            .iter()
            .find(|o| o.to_lowercase() == org.to_lowercase())
            .cloned()
    };
    // The usage sign-in of this very account names its organization: that is the workspace.
    let own = accounts
        .iter()
        .find(|a| a.id == account_id)
        .and_then(|a| a.auth.as_ref());
    let signed_in = own
        .filter(|auth| {
            auth.logged_in
                && auth
                    .account_uuid
                    .as_ref()
                    .is_some_and(|u| u.to_lowercase() == uuid.to_lowercase())
        })
        .and_then(|auth| among(auth.org_id.as_deref()));
    let hinted = among(state.org_hint.as_ref().map(|h| h.org_id.as_str()));
    let certain = state.org_hint.as_ref().is_some_and(|h| h.certain);
    let preferred = signed_in.or_else(|| if certain { hinted.clone() } else { None });
    let suggested = preferred.clone().or(hinted);
    SignInReading::Ready {
        account_uuid: uuid.to_string(),
        orgs: state.organizations.clone(),
        preferred,
        suggested,
    }
}
