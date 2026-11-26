//! Port of `shared/terminal-identity.ts`: what Relay does with the terminal's Claude Code
//! sign-in (the plain `claude`, without CLAUDE_CONFIG_DIR) at a switch.

use relay_i18n::{Args, Locale, translate};
use serde::{Deserialize, Serialize};

/// "follow": puts the account's saved terminal sign-in in place, after saving the one it
/// leaves. "off": never reads or touches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalMode {
    #[default]
    Follow,
    Off,
}

pub const TERMINAL_MODES: [TerminalMode; 2] = [TerminalMode::Follow, TerminalMode::Off];
/// Missing in the registry means "follow".
pub const DEFAULT_TERMINAL_MODE: TerminalMode = TerminalMode::Follow;

/// Who a terminal sign-in belongs to: the person and the organization, both lowercase.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdentity {
    pub account_uuid: String,
    pub org_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalCurrentState {
    SignedIn,
    SignedOut,
    Unreadable,
}

/// Who the terminal's `claude` is signed in to, as Relay last read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCurrent {
    pub state: TerminalCurrentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// Shown for a sign-in Relay does not know, so the user can tell which one it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
    /// The sign-in belongs to one of Relay's accounts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known: Option<bool>,
    /// Anthropic says the token is another account's than `~/.claude.json` names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mismatch: Option<bool>,
    pub at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalReason {
    Off,
    Unsupported,
    /// Claude Code was renewing the sign-in; nothing was touched.
    Busy,
    /// The terminal is on an account Relay does not have; it is never overwritten.
    UnknownAccount,
    /// The target has no terminal sign-in saved yet.
    NoSavedLogin,
    /// The token is another account's than `~/.claude.json` names.
    Mismatch,
    AlreadyThere,
    Locked,
    Unreadable,
    WriteFailed,
    RestoreFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalResult {
    Switched,
    Unchanged,
    Saved,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutcome {
    pub result: TerminalResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<TerminalReason>,
    /// The sign-in the terminal held was saved for its account.
    pub saved: bool,
    /// The sign-in put in place was saved while in use, so Claude Code may have renewed it since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unconfirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<TerminalCurrent>,
    pub at: String,
}

/// A saved terminal sign-in: whose, when, and whether it was taken away at a switch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSaved {
    pub account_uuid: String,
    pub org_id: String,
    pub saved_at: String,
    pub parked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatus {
    pub mode: TerminalMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<TerminalCurrent>,
    pub saved: Vec<TerminalSaved>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<TerminalOutcome>,
    /// Claude Code is connected to Relay's gateway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via_gateway: Option<bool>,
}

/// An account's identities that a terminal sign-in can belong to: its Desktop one and its own.
/// Each pair is `(accountUuid, orgId)`; a pair with either part missing or empty is skipped.
pub fn terminal_identities(
    desktop: Option<(&str, &str)>,
    auth: Option<(Option<&str>, Option<&str>)>,
) -> Vec<TerminalIdentity> {
    let mut out: Vec<TerminalIdentity> = Vec::new();
    let mut add = |account_uuid: Option<&str>, org_id: Option<&str>| {
        let (Some(account_uuid), Some(org_id)) = (account_uuid, org_id) else {
            return;
        };
        if account_uuid.is_empty() || org_id.is_empty() {
            return;
        }
        let id = TerminalIdentity {
            account_uuid: account_uuid.to_lowercase(),
            org_id: org_id.to_lowercase(),
        };
        if !out.iter().any(|x| same_identity(x, &id)) {
            out.push(id);
        }
    };
    if let Some((u, o)) = desktop {
        add(Some(u), Some(o));
    }
    if let Some((u, o)) = auth {
        add(u, o);
    }
    out
}

pub fn same_identity(a: &TerminalIdentity, b: &TerminalIdentity) -> bool {
    a.account_uuid.to_lowercase() == b.account_uuid.to_lowercase()
        && a.org_id.to_lowercase() == b.org_id.to_lowercase()
}

/// One sentence for a step's outcome; `None` when there is nothing worth saying.
pub fn terminal_line(
    outcome: &TerminalOutcome,
    locale: Locale,
    name: Option<&str>,
) -> Option<String> {
    let t = |id: &str| translate(locale, id, &Args::new());
    let to = name.map_or_else(|| t("sharedTerminalIdentity.thisAccount"), str::to_string);
    let with_to = |id: &str| translate(locale, id, &Args::new().set("to", to.as_str()));
    if outcome.result == TerminalResult::Switched {
        let moved = with_to("sharedTerminalIdentity.claudeCodeInTheTerminalMoved");
        let old = if outcome.unconfirmed == Some(true) {
            t("sharedTerminalIdentity.thisSignInCanBeOld")
        } else {
            String::new()
        };
        return Some(
            [moved, old]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    use TerminalReason as R;
    Some(match outcome.reason {
        Some(R::AlreadyThere) => with_to("sharedTerminalIdentity.claudeCodeInTheTerminalIs"),
        Some(R::NoSavedLogin) => with_to("sharedTerminalIdentity.hasNoSavedTerminalSignIn"),
        Some(R::UnknownAccount) => t("sharedTerminalIdentity.claudeCodeInTheTerminalIs2"),
        Some(R::Mismatch) => t("sharedTerminalIdentity.theTerminalSignInIsFor"),
        Some(R::Unsupported) => t("sharedTerminalIdentity.relayCannotManageTheTerminalSign"),
        Some(R::Busy) => t("sharedTerminalIdentity.claudeCodeRenewedItsSignIn"),
        Some(R::Locked) => t("sharedTerminalIdentity.relayCannotReadTheKeychainUnlock"),
        Some(R::Unreadable) => t("sharedTerminalIdentity.relayCannotReadTheClaudeCode"),
        Some(R::WriteFailed) => t("sharedTerminalIdentity.relayCannotWriteTheTerminalSign"),
        Some(R::RestoreFailed) => t("sharedTerminalIdentity.relayCannotWriteTheTerminalSign2"),
        _ if outcome.result == TerminalResult::Failed => {
            t("sharedTerminalIdentity.relayCannotChangeTheTerminalSign")
        }
        _ => return None,
    })
}
