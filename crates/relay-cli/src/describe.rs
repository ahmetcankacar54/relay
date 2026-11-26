//! Port of `cli/src/describe.ts`.

use relay_core::process_lock::{LockBy, LockInfo};
use relay_core::shared::types::{Account, AccountKind, DesktopHistoryTransfer};
use relay_i18n::Args;

use crate::deps::relay_apps;
use crate::i18n::T;

/// What a lock's holder is doing, in words: "Relay.app is switching accounts" and so on.
pub fn lock_holder_text(holder: &LockInfo, t: T) -> String {
    let who = match holder.by {
        LockBy::App => "Relay.app".to_owned(),
        LockBy::Cli => t.t("describe.anotherRelayCommand"),
        LockBy::Unknown => t.t("describe.anotherRelayProcess"),
    };
    let id = match holder.kind.as_str() {
        "switch" => "describe.isSwitchingAccounts",
        "save" => "describe.isSavingAnAccount",
        "link" => "describe.isStartingASignIn",
        "cancel-link" => "describe.isCancellingASignIn",
        "merge" => "describe.isBringingCodeHistoryOver",
        "restore" => "describe.isRestoringAnInterruptedSwitchS",
        "reset" => "describe.isResettingTheVault",
        "desktop-task" => "describe.isDoingATaskInThe",
        "draft-retype" => "describe.isReTypingADraft",
        _ => "describe.isRunningAClaudeAppOperation",
    };
    t.f(id, Args::new().set("who", who))
}

pub fn history_mode_text(mode: DesktopHistoryTransfer, t: T) -> String {
    t.t(match mode {
        DesktopHistoryTransfer::All => "describe.sharedAcrossAllAccounts",
        DesktopHistoryTransfer::SameGroup => "describe.sharedWithinEachGroup",
        DesktopHistoryTransfer::Selected => "describe.sharedBetweenTheSelectedAccounts",
        DesktopHistoryTransfer::Off => "describe.notShared",
    })
}

/// The group's name as the user typed it, or `None` for a work account in its own group.
pub fn group_name(account: &Account) -> Option<&str> {
    if account.kind != AccountKind::Work {
        return None;
    }
    let name = account.group.strip_prefix("work:")?;
    (name != account.id).then_some(name)
}

pub fn kind_text(account: &Account, t: T) -> String {
    if account.kind == AccountKind::Personal {
        return t.t("describe.personal");
    }
    match group_name(account) {
        Some(group) => format!("{} · {group}", t.t("describe.work")),
        None => t.t("describe.work"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitsState {
    Connected,
    NotConnected,
    Error,
}

impl LimitsState {
    pub const fn as_str(self) -> &'static str {
        match self {
            LimitsState::Connected => "connected",
            LimitsState::NotConnected => "not-connected",
            LimitsState::Error => "error",
        }
    }
}

pub fn limits_state(account: &Account) -> LimitsState {
    match &account.auth {
        Some(auth) if auth.error.as_deref().is_some_and(|e| !e.is_empty()) => LimitsState::Error,
        Some(auth) if auth.logged_in => LimitsState::Connected,
        _ => LimitsState::NotConnected,
    }
}

pub fn limits_text(state: LimitsState, t: T) -> String {
    t.t(match state {
        LimitsState::Connected => "describe.signedIn",
        LimitsState::Error => "describe.connectionNeedsRenewing",
        LimitsState::NotConnected => "describe.none",
    })
}

/// Whether a process inside a Relay.app bundle is in a `ps -axo pid=,ppid=,comm=` listing.
pub fn relay_app_running(listing: &str) -> bool {
    let apps = relay_apps();
    listing.split('\n').any(|line| {
        apps.iter()
            .any(|app| line.contains(&format!("{}/Contents/MacOS/", app.display())))
            || ends_with_relay_binary(line)
    })
}

/// `/\/Relay\.app\/Contents\/MacOS\/Relay\s*$/`.
fn ends_with_relay_binary(line: &str) -> bool {
    let trimmed = line.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    trimmed.ends_with("/Relay.app/Contents/MacOS/Relay")
}
