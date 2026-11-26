//! Port of `electron/core/code-tab.ts`.

use serde::{Deserialize, Serialize};

/// Claude's new-session screen in Code: opening it once makes Claude create the account's Code
/// workspace.
pub const CODE_TAB_LINK: &str = "claude://code/new";

/// `openCodeTab`'s default `timeoutMs`.
pub const CODE_TAB_TIMEOUT_MS: i64 = 30_000;

/// How long a Claude whose log cannot tell gets before the link is sent anyway.
const UNTOLD_GRACE_MS: i64 = 4_000;
const POLL_MS: u64 = 500;

/// What `open_code_tab` drives. A failing step ends the run with its error, as a rejected
/// promise does in the TS.
pub trait CodeTabDeps {
    type Error;
    /// Starts Claude, or brings a running one forward.
    fn open(&mut self) -> Result<(), Self::Error>;
    /// Whether Claude's claude.ai page has booted; None when its log cannot tell.
    fn booted(&mut self) -> Result<Option<bool>, Self::Error>;
    fn running(&mut self) -> Result<bool, Self::Error>;
    fn open_link(&mut self, url: &str) -> Result<(), Self::Error>;
    fn sleep(&mut self, ms: u64);
    /// Epoch ms.
    fn now(&self) -> i64;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodeTabOutcome {
    Opened,
    Timeout,
}

/// Opens Claude on its Code tab: starts or brings Claude forward, waits for its claude.ai page to
/// boot (a `claude://` link makes Claude load the page again, so one sent while it boots restarts
/// that), then opens the new-session screen. `Timeout`: Claude is open but the link was not sent.
pub fn open_code_tab<D: CodeTabDeps>(
    deps: &mut D,
    timeout_ms: i64,
) -> Result<CodeTabOutcome, D::Error> {
    deps.open()?;
    let start = deps.now();
    let mut running_since: Option<i64> = None;
    while deps.now() - start < timeout_ms {
        let booted = deps.booted()?;
        if booted == Some(true) {
            break;
        }
        if booted.is_none() && deps.running()? {
            let since = *running_since.get_or_insert_with(|| deps.now());
            if deps.now() - since >= UNTOLD_GRACE_MS {
                break;
            }
        }
        deps.sleep(POLL_MS);
    }
    if deps.now() - start >= timeout_ms {
        return Ok(CodeTabOutcome::Timeout);
    }
    deps.open_link(CODE_TAB_LINK)?;
    Ok(CodeTabOutcome::Opened)
}
