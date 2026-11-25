//! Port of `shared/usage-statistics.ts`: the usage samples Relay records and the quota identity
//! they are filed under.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::types::js::{date_parse, iso};
use super::types::{Account, AccountUsage, UsageStatus, UsageWindow};

pub const USAGE_HISTORY_DAYS: f64 = 14.0;
pub const MAX_USAGE_SAMPLES: usize = 50_000;
pub const MAX_USAGE_GAP_MS: f64 = 35.0 * 60_000.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSample {
    pub account_id: String,
    pub identity: String,
    pub checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<UsageWindow>,
}

/// `JSON.stringify([kind, id, org])`.
fn identity_key(kind: &str, id: &str, org: &str) -> String {
    serde_json::to_string(&[kind, id, org]).expect("strings serialize")
}

/// The identity samples are recorded under: the Claude Code sign-in's, else the Claude app's.
pub fn usage_identity(account: &Account) -> Option<String> {
    if account.auth.as_ref().is_some_and(|a| a.logged_in) {
        return history_identity(account);
    }
    desktop_identity(account)
}

fn desktop_identity(account: &Account) -> Option<String> {
    let desktop = account.desktop.as_ref()?;
    Some(identity_key("uuid", &desktop.account_uuid, &desktop.org_id))
}

/// The identity an account's recorded usage is filed under, also while it is signed out: a
/// sign-out keeps the last verified UUID and organization.
pub fn history_identity(account: &Account) -> Option<String> {
    let Some(auth) = &account.auth else { return desktop_identity(account) };
    let desktop = account.desktop.as_ref();
    let uuid = auth.account_uuid.clone().or_else(|| desktop.map(|d| d.account_uuid.clone()));
    let email = auth.email.as_ref().map(|e| super::time_zones::js_trim(e).to_lowercase());
    let org = auth.org_id.clone().or_else(|| desktop.map(|d| d.org_id.clone())).unwrap_or_default();
    let truthy = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
    // Email alone proves a user, not which organization's quota was observed.
    if org.is_empty() || (!truthy(&uuid) && !truthy(&email)) {
        return None;
    }
    let kind = if truthy(&uuid) { "uuid" } else { "email" };
    let id = uuid.or(email).unwrap_or_default();
    Some(identity_key(kind, &id, &org))
}

/// Identity → owning account: the first signed-in account sharing it, else the first.
pub fn identity_owners(accounts: &[Account]) -> IndexMap<String, &Account> {
    let mut owner: IndexMap<String, &Account> = IndexMap::new();
    for account in accounts {
        let Some(identity) = history_identity(account) else { continue };
        let logged_in = |a: &Account| a.auth.as_ref().is_some_and(|x| x.logged_in);
        match owner.get(&identity) {
            Some(current) if logged_in(current) || !logged_in(account) => {}
            _ => {
                owner.insert(identity, account);
            }
        }
    }
    owner
}

fn normalized_window(window: Option<&UsageWindow>) -> Option<UsageWindow> {
    let window = window?;
    if !window.used_percent.is_finite() || window.used_percent < 0.0 || window.used_percent > 100.0 {
        return None;
    }
    if let Some(reset) = &window.resets_at
        && !date_parse(reset).is_finite()
    {
        return None;
    }
    Some(UsageWindow {
        used_percent: window.used_percent,
        resets_at: window.resets_at.as_deref().filter(|r| !r.is_empty()).map(|r| iso(date_parse(r))),
        source: None,
        read_at: None,
    })
}

/// The sample a fresh, ready reading makes, when it has a usable window.
pub fn usage_sample(account: &Account, usage: &AccountUsage) -> Option<UsageSample> {
    let identity = usage_identity(account)?;
    let checked = usage.checked_at.as_deref().filter(|c| !c.is_empty())?;
    if usage.account_id != account.id
        || usage.status != UsageStatus::Ready
        || usage.stale
        || usage.issue.is_some()
        || !date_parse(checked).is_finite()
    {
        return None;
    }
    let five_hour = normalized_window(usage.five_hour.as_ref());
    let seven_day = normalized_window(usage.seven_day.as_ref());
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(UsageSample {
        account_id: account.id.clone(),
        identity,
        checked_at: iso(date_parse(checked)),
        five_hour,
        seven_day,
    })
}
