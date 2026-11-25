//! Port of `shared/remote-notify.ts`.

use url::Url;

use super::model_prices::js_trim;
use super::types::{RemoteNotifyEvents, RemoteNotifyKind, RemoteNotifySettings};

/// `DEFAULT_REMOTE_NOTIFY`: every event on and ntfy picked, before a URL is saved.
pub const DEFAULT_REMOTE_NOTIFY_KIND: RemoteNotifyKind = RemoteNotifyKind::Ntfy;
pub const DEFAULT_REMOTE_NOTIFY_EVENTS: RemoteNotifyEvents = RemoteNotifyEvents { limit: true, reset: true, auto_switch: true, sign_in: true };

/// The saved choices over the defaults; a missing group reads as the default.
pub fn remote_notify_settings(saved: Option<&RemoteNotifySettings>) -> RemoteNotifySettings {
    match saved {
        Some(saved) => saved.clone(),
        None => RemoteNotifySettings { url: None, kind: DEFAULT_REMOTE_NOTIFY_KIND, events: DEFAULT_REMOTE_NOTIFY_EVENTS },
    }
}

/// Hosts plain http may reach: a self-hosted ntfy on this computer, never one across a network.
const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
pub const REMOTE_NOTIFY_URL_MAX: usize = 2_000;

/// The URL Relay may post events to, or `None`: https anywhere, http only to this computer. A
/// URL with a user name or password is refused.
pub fn remote_notify_url(raw: Option<&str>) -> Option<Url> {
    let text = js_trim(raw?);
    if text.is_empty() || text.encode_utf16().count() > REMOTE_NOTIFY_URL_MAX {
        return None;
    }
    let url = Url::parse(text).ok()?;
    let hostname = url.host_str().unwrap_or("");
    if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) || hostname.is_empty() {
        return None;
    }
    match url.scheme() {
        "https" => Some(url),
        "http" if LOCAL_HOSTS.contains(&hostname) => Some(url),
        _ => None,
    }
}
