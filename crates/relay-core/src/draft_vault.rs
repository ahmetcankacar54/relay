//! Port of `electron/core/draft-vault.ts`. Holds only the data types `shared/types.ts` imports
//! for now; the vault itself is ported later.

use serde::{Deserialize, Serialize};

use crate::shared::types::literal_enum;

literal_enum!(
    /// `pending` waits to be re-typed; `needs-copy` could not be and waits for the user.
    DraftState { Pending = "pending", NeedsCopy = "needs-copy" }
);

/// What the panel may know of a rescued draft: never its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub to: String,
    pub title: String,
    pub new_session: bool,
    pub attachments: bool,
    pub state: DraftState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub captured_at: String,
}
