//! Port of `electron/core/profile-identity.ts`: the non-secret identity Claude Code saved in an
//! isolated profile, and the account's sign-in from `claude auth status`.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::desktop_files::is_uuid;
use crate::shared::types::{AccountAuth, AccountPlan};

const MAX_METADATA: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIdentity {
    pub account_uuid: String,
    pub org_id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    /// The plan Claude Code saved with the sign-in; None when it names none Relay knows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<AccountPlan>,
}

/// The plan in the sign-in metadata Claude Code saves (`oauthAccount`): the user's own rate-limit
/// tier first (a Team seat can carry a Max tier), then the organization's tier and type.
pub fn claude_plan(identity: &Map<String, Value>) -> Option<AccountPlan> {
    let tiers = ["userRateLimitTier", "organizationRateLimitTier"]
        .iter()
        .filter_map(|key| identity.get(*key).and_then(Value::as_str));
    for tier in tiers {
        let lower = tier.to_lowercase();
        if lower.contains("max20x") || lower.contains("max_20x") {
            return Some(AccountPlan::Max20);
        }
        if lower.contains("max5x") || lower.contains("max_5x") {
            return Some(AccountPlan::Max5);
        }
    }
    match identity.get("organizationType").and_then(Value::as_str) {
        Some("claude_pro") => Some(AccountPlan::Pro),
        Some("claude_team" | "claude_enterprise") => Some(AccountPlan::Team),
        _ => None,
    }
}

/// `value.trim()` when it is a non-empty string of at most `limit` UTF-16 units.
fn text(value: Option<&Value>, limit: usize) -> Option<String> {
    let trimmed = crate::store::schema::js_trim(value?.as_str()?);
    (!trimmed.is_empty() && trimmed.encode_utf16().count() <= limit).then(|| trimmed.to_string())
}

fn valid_uuid(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .filter(|v| is_uuid(v))
        .map(str::to_lowercase)
}

/// Reads only non-secret identity fields from an isolated CLI profile, never credential files
/// and never the user's default Claude configuration. `.config.json` (legacy) wins over
/// `.claude.json` when it exists; a link, a folder, an oversized or malformed file gives None.
pub fn read_profile_identity(profile: &Path) -> Option<ProfileIdentity> {
    let directory = fs::symlink_metadata(profile).ok()?;
    if !directory.is_dir() {
        return None;
    }
    for name in [".config.json", ".claude.json"] {
        let target = profile.join(name);
        let stat = match fs::symlink_metadata(&target) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        };
        if !stat.is_file() {
            return None;
        }
        let file = open_no_follow(&target).ok()?;
        if !file.metadata().ok()?.is_file() || file.metadata().ok()?.len() > MAX_METADATA {
            return None;
        }
        let mut buffer = Vec::new();
        file.take(MAX_METADATA + 1).read_to_end(&mut buffer).ok()?;
        if buffer.len() as u64 > MAX_METADATA {
            return None;
        }
        let value: Value = serde_json::from_slice(&buffer).ok()?;
        let identity = value.get("oauthAccount").and_then(Value::as_object);
        let field = |key: &str| identity.and_then(|i| i.get(key));
        let account_uuid = valid_uuid(field("accountUuid"))?;
        let org_id = valid_uuid(field("organizationUuid"))?;
        let email = text(field("emailAddress"), 254)?;
        return Some(ProfileIdentity {
            account_uuid,
            org_id,
            email,
            org_name: text(field("organizationName"), 150),
            plan: identity.and_then(claude_plan),
        });
    }
    None
}

fn open_no_follow(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid CLI authentication status.")]
pub struct InvalidAuthStatus;

/// The account's sign-in from `claude auth status --json`, keeping what was known before when it
/// is signed out. The metadata's uuid, organization name and plan are trusted only when its email
/// and organization match the status: email alone cannot tell personal and company apart.
pub fn auth_status(
    value: &Value,
    previous: Option<&AccountAuth>,
    metadata: Option<&ProfileIdentity>,
    checked_at: &str,
) -> Result<AccountAuth, InvalidAuthStatus> {
    let status = value.as_object().ok_or(InvalidAuthStatus)?;
    let logged_in = status
        .get("loggedIn")
        .and_then(Value::as_bool)
        .ok_or(InvalidAuthStatus)?;
    if !logged_in || status.get("authMethod").and_then(Value::as_str) != Some("claude.ai") {
        let mut auth = previous.cloned().unwrap_or_default();
        auth.logged_in = false;
        auth.checked_at = checked_at.to_string();
        auth.error = logged_in
            .then(|| "This profile needs a sign-in with a Claude subscription.".to_string());
        return Ok(auth);
    }
    let email = text(status.get("email"), 254);
    let org_id = valid_uuid(status.get("orgId"));
    let corroborated = match (metadata, &email, &org_id) {
        (Some(m), Some(email), Some(org)) => {
            m.email.to_lowercase() == email.to_lowercase() && &m.org_id == org
        }
        _ => false,
    };
    let trusted = metadata.filter(|_| corroborated);
    Ok(AccountAuth {
        logged_in: true,
        email,
        account_uuid: valid_uuid(status.get("accountUuid"))
            .or_else(|| trusted.map(|m| m.account_uuid.clone())),
        org_id,
        org_name: text(status.get("orgName"), 150)
            .or_else(|| trusted.and_then(|m| m.org_name.clone())),
        subscription: text(status.get("subscriptionType"), 64),
        // The plan in the metadata belongs to this sign-in only when email and organization match.
        plan: trusted.and_then(|m| m.plan),
        checked_at: checked_at.to_string(),
        error: None,
    })
}
