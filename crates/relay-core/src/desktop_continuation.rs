//! Port of `electron/core/desktop-continuation.ts`. Holds only the data types `shared/types.ts`
//! imports for now; the continuation controller is ported later.

use serde::{Deserialize, Serialize};

use crate::shared::types::js::ser_opt_num;
use crate::shared::types::literal_enum;

literal_enum!(ContinuationStatus {
    Off = "off",
    Armed = "armed",
    Waiting = "waiting",
    Executing = "executing",
    Continued = "continued",
    Blocked = "blocked",
    ReconciliationRequired = "reconciliation-required",
});
literal_enum!(
    /// Automatic enrollment is frozen at arming.
    TargetSelection { Automatic = "automatic" }
);

/// What the panel shows of "switch and continue" for one conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContinuationSnapshot {
    pub status: ContinuationStatus,
    pub reason: String,
    pub can_arm: bool,
    pub enabled: bool,
    pub executable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_selection: Option<TargetSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "ser_opt_num")]
    pub allowed_target_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}
