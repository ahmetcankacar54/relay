//! The Rust port of `shared/notifications.ts`, delegating to `relay_core::shared::notifications`.

#![forbid(unsafe_code)]

use parity_args::opt_arg;
use relay_core::shared::notifications;
use relay_core::shared::types::NotificationSettings;

/// Port of `notificationSettings` (`shared/notifications.ts:18`): reads `settings.notifications`.
pub fn notification_settings(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    let saved: Option<NotificationSettings> = opt_arg(settings.get("notifications"))?;
    serde_json::to_value(notifications::notification_settings(saved.as_ref()))
        .map_err(|e| e.to_string())
}
