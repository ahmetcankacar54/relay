//! Port of the `shared/remote-notify` case of tests/remote-notify.test.ts. The settings-schema
//! assertions in it belong to the store port; the sender and notifier cases to
//! electron/core/remote-notify's port.

use relay_core::shared::remote_notify::{remote_notify_settings, remote_notify_url};
use relay_core::shared::types::{RemoteNotifyEvents, RemoteNotifyKind, RemoteNotifySettings};

#[test]
fn only_https_or_http_to_this_computer_without_a_user_name_or_password_is_a_target() {
    for ok in [
        "https://ntfy.sh/relay-alto",
        "https://example.com/hooks/relay?x=1",
        "http://localhost:8080/relay",
        "http://127.0.0.1/relay",
        "http://[::1]:2586/relay",
        "  https://ntfy.sh/relay  ",
    ] {
        assert!(remote_notify_url(Some(ok)).is_some(), "{ok}");
    }
    let long = format!("https://example.com/{}", "a".repeat(2_000));
    for bad in [
        "",
        "ntfy.sh/relay",
        "http://example.com/relay",
        "http://192.168.1.10/relay",
        "ftp://example.com/relay",
        "javascript:alert(1)",
        "https://user:secret@example.com/hook",
        long.as_str(),
    ] {
        assert_eq!(remote_notify_url(Some(bad)), None, "{bad}");
    }
    assert_eq!(remote_notify_url(None), None);
    assert_eq!(
        remote_notify_settings(None),
        RemoteNotifySettings {
            url: None,
            kind: RemoteNotifyKind::Ntfy,
            events: RemoteNotifyEvents {
                limit: true,
                reset: true,
                auto_switch: true,
                sign_in: true
            },
        }
    );
}
