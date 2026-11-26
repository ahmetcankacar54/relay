//! Port of `electron/core/desktop-org.ts`: which of an account's Code workspaces
//! (organizations) the Claude app is in now.
//!
//! One Claude account can belong to several organizations, and the app keeps a Code workspace
//! folder for each it has ever opened. The app's `config.json` says which one it uses, in two
//! places Relay only reads: a remembered answer pairing `accountUuid` with `orgUuid` (any
//! top-level object with both fields), and `dxt:allowlistLastUpdated:<org>`, which the app
//! refreshes for the organization it has open. Both are the app's bookkeeping, so the answer is a
//! hint with a confidence.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::types::js::date_parse;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgHint {
    pub org_id: String,
    /// The app names this organization for the account outright, or refreshed it after `since`.
    /// Otherwise it is only the most recently used of the candidates.
    pub certain: bool,
}

fn lower(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_lowercase)
}

const ALLOWLIST: &str = "dxt:allowlistLastUpdated:";

/// The workspace the app uses for `account_uuid` among `orgs`; `since` is when the sign-in being
/// saved began (ms), so a refresh after it belongs to this sign-in.
pub fn active_org_hint(
    config: &Value,
    account_uuid: &str,
    orgs: &[String],
    since: Option<f64>,
) -> Option<OrgHint> {
    let entries = config.as_object()?;
    if orgs.len() < 2 {
        return None;
    }
    let known: HashMap<String, &String> =
        orgs.iter().map(|org| (org.to_lowercase(), org)).collect();
    let account = account_uuid.to_lowercase();
    for value in entries.values() {
        let Some(pair) = value.as_object() else {
            continue;
        };
        if lower(pair.get("accountUuid")).as_deref() != Some(account.as_str()) {
            continue;
        }
        let org = lower(pair.get("orgUuid")).unwrap_or_default();
        if let Some(named) = known.get(&org) {
            return Some(OrgHint {
                org_id: (*named).clone(),
                certain: true,
            });
        }
    }
    let mut newest: Option<(&String, f64)> = None;
    for (key, value) in entries {
        let Some(rest) = key.strip_prefix(ALLOWLIST).filter(|rest| !rest.is_empty()) else {
            continue;
        };
        let Some(org) = known.get(&rest.to_lowercase()) else {
            continue;
        };
        let at = value.as_str().map_or(f64::NAN, date_parse);
        if !at.is_finite() {
            continue;
        }
        if newest.is_none_or(|(_, seen)| at > seen) {
            newest = Some((org, at));
        }
    }
    let (org, at) = newest?;
    Some(OrgHint {
        org_id: org.clone(),
        certain: since.is_some_and(|since| at >= since),
    })
}
