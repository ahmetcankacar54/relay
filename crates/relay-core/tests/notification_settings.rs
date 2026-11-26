//! Port of the `shared/notifications` case of `tests/notification-settings.test.ts`. The schema
//! case is in `store_settings.rs` (`notification_settings`); "every notification type sits in one
//! Notifications group in Settings → General" and "the limit warnings say they need the marks only
//! while the marks are off" render React components (`src/pages/settings`) and are not ported.

use relay_core::shared::notifications::{
    DEFAULT_NOTIFICATIONS, NotificationChoices, notification_settings,
};
use relay_core::shared::types::{LimitResetNotice, NotificationSettings, default_settings};

#[test]
fn a_registry_without_the_group_reads_every_notification_as_on_ready_again_for_the_account_in_use()
{
    assert_eq!(
        notification_settings(default_settings().notifications.as_ref()),
        DEFAULT_NOTIFICATIONS
    );
    assert_eq!(
        notification_settings(Some(&NotificationSettings {
            limit_weekly: Some(false),
            ..NotificationSettings::default()
        })),
        NotificationChoices {
            limit_weekly: false,
            ..DEFAULT_NOTIFICATIONS
        }
    );
    assert_eq!(DEFAULT_NOTIFICATIONS.limit_reset, LimitResetNotice::InUse);
}
