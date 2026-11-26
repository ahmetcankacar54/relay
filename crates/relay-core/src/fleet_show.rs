//! Port of `electron/core/fleet-show.ts`: waits for a continued conversation to show in Claude,
//! opening it by link while the user is idle.

use serde::{Deserialize, Serialize};

use crate::desktop_continuation_host::{DesktopAutomationSnapshot, DesktopHostError};
use crate::shared::types::literal_enum;

/// How long a continuation waits for its conversation to show after a switch.
pub const CONTINUE_SHOW_MS: f64 = 3.0 * 60_000.0;
/// No input for this long: the user is not at work in Claude, and Relay may act there.
pub const CONTINUE_IDLE_MS: i64 = 5_000;
/// The least time between two links to the same conversation: each makes Claude load its page again.
pub const CONTINUE_REOPEN_MS: f64 = 30_000.0;
/// The most links one continuation sends.
pub const CONTINUE_OPENS: u32 = 3;
/// How often the conversation's transcript is read again for a turn of the user's own.
const MOVED_CHECK_MS: f64 = 5_000.0;
const POLL_MS: u64 = 1_000;

pub trait ShowDeps {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError>;
    fn open(&self, local_session_id: &str) -> Result<(), DesktopHostError>;
    /// Whether Claude's page has booted; `Some(false)` holds the links back, `None` does not.
    fn booted(&self) -> Result<Option<bool>, DesktopHostError>;
    /// The stopped conversation has not moved on: no turn since the stop, the user's own included.
    fn unchanged(&self) -> bool;
    fn now(&self) -> f64;
    fn sleep(&self, ms: u64);
}

literal_enum!(ShowSkipped {
    MovedOn = "moved-on",
    NotShown = "not-shown",
    UserActive = "user-active",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ShowResult {
    Shown {
        shown: DesktopAutomationSnapshot,
    },
    Skipped {
        skipped: ShowSkipped,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last: Option<DesktopAutomationSnapshot>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        issue: Option<String>,
        opened: u32,
    },
}

/// Waits until `local_session_id` shows in Claude with its mode readable and the user idle,
/// opening it by link meanwhile. A conversation the user continued by hand is theirs: the wait
/// ends at once. Links go only while the user is idle, at most [`CONTINUE_OPENS`] and
/// [`CONTINUE_REOPEN_MS`] apart, since each one reloads Claude's page and takes the user to that
/// conversation.
pub fn wait_for_conversation(local_session_id: &str, deps: &dyn ShowDeps) -> ShowResult {
    let deadline = deps.now() + CONTINUE_SHOW_MS;
    let mut last: Option<DesktopAutomationSnapshot> = None;
    let mut issue: Option<String> = None;
    let mut opened_at = f64::NEG_INFINITY;
    let mut checked_at = f64::NEG_INFINITY;
    let mut opened = 0;
    let mut was_idle = false;
    while deps.now() < deadline {
        if deps.now() - checked_at >= MOVED_CHECK_MS {
            checked_at = deps.now();
            if !deps.unchanged() {
                return ShowResult::Skipped {
                    skipped: ShowSkipped::MovedOn,
                    last,
                    issue: None,
                    opened,
                };
            }
        }
        let step = (|| -> Result<Option<DesktopAutomationSnapshot>, DesktopHostError> {
            let view = deps.inspect()?;
            last = Some(view.clone());
            issue = None;
            let idle = view.idle_ms.unwrap_or(CONTINUE_IDLE_MS) >= CONTINUE_IDLE_MS;
            if idle {
                was_idle = true;
            }
            if view.local_session_id.as_deref() == Some(local_session_id)
                && view
                    .permission_mode
                    .as_deref()
                    .is_some_and(|m| !m.is_empty())
            {
                if idle {
                    return Ok(Some(view));
                }
            } else if idle
                && opened < CONTINUE_OPENS
                && deps.now() - opened_at >= CONTINUE_REOPEN_MS
                // A link makes Claude load its page again: none while it is still loading.
                && deps.booted()? != Some(false)
            {
                opened_at = deps.now();
                opened += 1;
                deps.open(local_session_id)?;
            }
            Ok(None)
        })();
        match step {
            Ok(Some(shown)) => return ShowResult::Shown { shown },
            Ok(None) => {}
            // Not ready yet.
            Err(error) => {
                issue = Some(
                    error
                        .issue()
                        .map_or_else(|| "failed".to_owned(), |issue| issue.as_str().to_owned()),
                );
            }
        }
        deps.sleep(POLL_MS);
    }
    ShowResult::Skipped {
        skipped: if was_idle {
            ShowSkipped::NotShown
        } else {
            ShowSkipped::UserActive
        },
        last,
        issue,
        opened,
    }
}
