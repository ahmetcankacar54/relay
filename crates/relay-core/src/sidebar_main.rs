//! Port of `electron/core/sidebar-main.ts`: the panel's sidebar offer actions, run in the main
//! process so the recipe and its sessions never reach a renderer.

use serde_json::{Map, Value};

use crate::desktop::DesktopManager;
use crate::desktop_files::is_uuid;
use crate::draft_diagnostics::{DraftLog, log_draft, short_id};
use crate::shared::types::SidebarGapSummary;

/// The panel's view of the sidebar offer; none when it cannot be read.
pub fn sidebar_summary<E>(
    sidebar_gap: impl FnOnce() -> Result<Option<SidebarGapSummary>, E>,
) -> Option<SidebarGapSummary> {
    sidebar_gap().ok().flatten()
}

const GONE: &str = "This sidebar offer is no longer there.";

/// Why a sidebar action failed; the message is the TS `Error.message`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SidebarActionError {
    /// The id is not a uuid (zod's `z.uuid()` refusal).
    #[error("Invalid UUID")]
    InvalidId,
    /// The offer is gone, or made for another account than Desktop's current one.
    #[error("{}", GONE)]
    Gone,
    #[error("{0}")]
    Failed(String),
}

/// Where the offers live (`DesktopManager`).
pub trait SidebarGaps: Send + Sync {
    /// The recipe of offer `id`, while it is offered.
    fn sidebar_recipe(&self, id: &str) -> Result<Option<String>, String>;
    fn dismiss_sidebar_gap(&self, id: &str) -> Result<(), String>;
}

impl SidebarGaps for DesktopManager {
    fn sidebar_recipe(&self, id: &str) -> Result<Option<String>, String> {
        Ok(DesktopManager::sidebar_recipe(self, id))
    }
    fn dismiss_sidebar_gap(&self, id: &str) -> Result<(), String> {
        DesktopManager::dismiss_sidebar_gap(self, id).map_err(|error| error.to_string())
    }
}

pub struct SidebarActionsDeps {
    pub gaps: Box<dyn SidebarGaps>,
    pub write_clipboard: Box<dyn Fn(&str) + Send + Sync>,
    pub changed: Box<dyn Fn() + Send + Sync>,
    /// A diagnosis log: the offer's id cut to 8 characters and how the action ended.
    pub log: Option<Box<DraftLog>>,
}

/// The panel's Copy recipe and Dismiss, by offer id. Copy writes the recipe to the clipboard
/// here, in main, and keeps the offer, so it can be copied again; Dismiss removes it. An offer
/// that is gone, or made for another account than Desktop's current one, fails. Neither ever
/// returns anything, so the sessions never travel to a renderer. Either way the renderers are
/// told to read again.
pub struct SidebarActions {
    deps: SidebarActionsDeps,
}

/// `sidebarActions(deps)`.
pub fn sidebar_actions(deps: SidebarActionsDeps) -> SidebarActions {
    SidebarActions { deps }
}

fn gap_id(raw: &Value) -> Result<&str, SidebarActionError> {
    raw.as_str()
        .filter(|id| is_uuid(id))
        .ok_or(SidebarActionError::InvalidId)
}

fn fields(id: &str, ok: bool, reason: Option<&str>) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(
        "id".into(),
        short_id(Some(id)).map_or(Value::Null, Value::String),
    );
    map.insert("ok".into(), Value::Bool(ok));
    if let Some(reason) = reason {
        map.insert("reason".into(), Value::String(reason.into()));
    }
    map
}

impl SidebarActions {
    pub fn copy(&self, raw: &Value) -> Result<(), SidebarActionError> {
        let id = gap_id(raw)?;
        let result = match self.deps.gaps.sidebar_recipe(id) {
            Ok(Some(recipe)) => {
                (self.deps.write_clipboard)(&recipe);
                Ok(())
            }
            Ok(None) => Err(SidebarActionError::Gone),
            Err(message) => Err(SidebarActionError::Failed(message)),
        };
        let log = self.deps.log.as_deref();
        match &result {
            Ok(()) => log_draft(log, "sidebar-copy", Some(&fields(id, true, None))),
            Err(error) => {
                let reason = if *error == SidebarActionError::Gone {
                    GONE
                } else {
                    "failed"
                };
                log_draft(log, "sidebar-copy", Some(&fields(id, false, Some(reason))));
            }
        }
        (self.deps.changed)();
        result
    }

    pub fn dismiss(&self, raw: &Value) -> Result<(), SidebarActionError> {
        let id = gap_id(raw)?;
        let result = self
            .deps
            .gaps
            .dismiss_sidebar_gap(id)
            .map_err(SidebarActionError::Failed);
        if result.is_ok() {
            log_draft(
                self.deps.log.as_deref(),
                "sidebar-dismiss",
                Some(&fields(id, true, None)),
            );
        }
        (self.deps.changed)();
        result
    }
}
