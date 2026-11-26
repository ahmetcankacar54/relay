//! Port of `shared/notifications.ts`.

use serde::{Deserialize, Serialize};

use super::types::{LimitResetNotice, NotificationSettings};

/// `Required<NotificationSettings>`: every notification type with its choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationChoices {
    pub limit_five_hour: bool,
    pub limit_weekly: bool,
    pub limit_reset: LimitResetNotice,
    pub switches: bool,
    pub sign_ins: bool,
    pub early_start: bool,
    pub updates: bool,
}

/// Every notification type on, and "ready again" for the account in use: what Relay showed before
/// the Notifications group existed, plus the reset notice, which tells at most once per window reset.
pub const DEFAULT_NOTIFICATIONS: NotificationChoices = NotificationChoices {
    limit_five_hour: true,
    limit_weekly: true,
    limit_reset: LimitResetNotice::InUse,
    switches: true,
    sign_ins: true,
    early_start: true,
    updates: true,
};

/// The saved choices over the defaults: a registry from before the group, or a missing key, reads
/// as the default.
pub fn notification_settings(notifications: Option<&NotificationSettings>) -> NotificationChoices {
    let d = DEFAULT_NOTIFICATIONS;
    let Some(n) = notifications else { return d };
    NotificationChoices {
        limit_five_hour: n.limit_five_hour.unwrap_or(d.limit_five_hour),
        limit_weekly: n.limit_weekly.unwrap_or(d.limit_weekly),
        limit_reset: n.limit_reset.unwrap_or(d.limit_reset),
        switches: n.switches.unwrap_or(d.switches),
        sign_ins: n.sign_ins.unwrap_or(d.sign_ins),
        early_start: n.early_start.unwrap_or(d.early_start),
        updates: n.updates.unwrap_or(d.updates),
    }
}
