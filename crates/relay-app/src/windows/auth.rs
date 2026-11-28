//! The usage sign-in in Relay's own window, one per account, each with its own persistent
//! claude.ai session (port of electron/auth-window.ts): whichever account the system browser is
//! signed in to cannot approve the wrong one, and a renewal finds the account still signed in.
//! macOS keys the session by a WebKit data store id, Windows and Linux by a data directory.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use relay_core::desktop_usage::SAFARI_USER_AGENT;
use relay_core::host::{Navigation, SIGN_IN_WINDOW_SIZE, SignInWindow, sign_in_popup_navigation};
use sha2::{Digest, Sha256};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL_PREFIX: &str = "auth-";

/// A webview label for the account (labels allow letters, digits, `-`, `/`, `:` and `_`).
pub fn label(account_id: &str) -> String {
    let safe: String = account_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{LABEL_PREFIX}{safe}")
}

/// macOS: the WebKit data store of the account's session, the first 16 bytes of
/// SHA-256("relay-auth-" + accountId).
pub fn data_store_identifier(account_id: &str) -> [u8; 16] {
    let digest = Sha256::digest(format!("relay-auth-{account_id}").as_bytes());
    let mut id = [0; 16];
    id.copy_from_slice(&digest[..16]);
    id
}

/// Windows and Linux: the session's folder, `<data>/webview/auth/<accountId>`.
pub fn data_directory(account_id: &str) -> Option<PathBuf> {
    let data = crate::state::STATE.paths.get()?.data_dir();
    Some(
        data.join("webview")
            .join("auth")
            .join(label(account_id).trim_start_matches(LABEL_PREFIX)),
    )
}

/// The account's session for a window builder.
fn with_session<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    account_id: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    #[cfg(target_os = "macos")]
    {
        builder.data_store_identifier(data_store_identifier(account_id))
    }
    #[cfg(not(target_os = "macos"))]
    {
        match data_directory(account_id) {
            Some(dir) => builder.data_directory(dir),
            None => builder,
        }
    }
}

fn open_external(app: &AppHandle, url: String) {
    let _ = app.run_on_main_thread(move || {
        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    });
}

/// Shows the account's sign-in window at `window.url`, or brings its open one to the front.
pub fn show_sign_in(app: &AppHandle, window: SignInWindow) {
    let label = label(&window.account_id);
    if let Some(open) = app.get_webview_window(&label) {
        let _ = open.show();
        let _ = open.set_focus();
        return;
    }
    let Ok(url) = window.url.parse() else {
        return;
    };
    let navigations = window.clone();
    let links = app.clone();
    let popups = window.clone();
    let popup_app = app.clone();
    let closes = window.clone();
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(&window.title)
        .inner_size(SIGN_IN_WINDOW_SIZE.0 as f64, SIGN_IN_WINDOW_SIZE.1 as f64)
        .user_agent(SAFARI_USER_AGENT)
        // Navigations and redirects: allowed sites load, other https addresses open in the
        // system browser, anything else is blocked.
        .on_navigation(
            move |target| match navigations.navigation(target.as_str()) {
                Navigation::Allow => true,
                Navigation::OpenExternal => {
                    open_external(&links, target.to_string());
                    false
                }
                Navigation::Block => false,
            },
        )
        // Pop-up sign-ins (a provider's) stay inside this account's session.
        .on_new_window(
            move |target, features| match popups.popup(target.as_str()) {
                Navigation::Allow => popup(&popup_app, &popups.account_id, target, features)
                    .map_or(NewWindowResponse::Deny, |window| {
                        NewWindowResponse::Create { window }
                    }),
                Navigation::OpenExternal => {
                    open_external(&popup_app, target.to_string());
                    NewWindowResponse::Deny
                }
                Navigation::Block => NewWindowResponse::Deny,
            },
        )
        // The approval reached the CLI: the page it shows says so; then the window closes.
        .on_page_load(move |shown, payload| {
            if payload.event() == PageLoadEvent::Started
                && let Some(delay) = closes.closes_after(payload.url().as_str())
            {
                let shown = shown.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    let _ = shown.close();
                });
            }
        });
    if let Err(error) = with_session(builder, &window.account_id).build() {
        eprintln!("Relay could not open the sign-in window. {error}");
    }
}

/// A provider's pop-up: the same session, https: pages only, no windows of its own.
fn popup(
    app: &AppHandle,
    account_id: &str,
    target: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> Option<tauri::WebviewWindow> {
    static POPUPS: AtomicU64 = AtomicU64::new(0);
    let label = format!(
        "{}-popup-{}",
        label(account_id),
        POPUPS.fetch_add(1, Ordering::SeqCst)
    );
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(target))
        .window_features(features)
        .user_agent(SAFARI_USER_AGENT)
        .on_navigation(|target| sign_in_popup_navigation(target.as_str()) == Navigation::Allow)
        .on_new_window(|_, _| NewWindowResponse::Deny);
    with_session(builder, account_id).build().ok()
}

pub fn close_sign_in(app: &AppHandle, account_id: &str) {
    if let Some(window) = app.get_webview_window(&label(account_id)) {
        let _ = window.close();
    }
}

/// Forgets an account's sign-in window session: its claude.ai login and cookies.
pub fn forget_session(app: &AppHandle, account_id: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label(account_id)) {
        return window.clear_all_browsing_data().map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let id = data_store_identifier(account_id);
        let removal = async move { app.remove_data_store(id).await };
        if crate::windows::is_main_thread() {
            // Its answer needs the main thread: let it finish later.
            tauri::async_runtime::spawn(removal);
            return Ok(());
        }
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        tauri::async_runtime::spawn(async move {
            let _ = send.send(removal.await);
        });
        // A store that was never made (no sign-in yet) is not an error.
        match receive.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(Ok(())) | Err(_) => Ok(()),
            Ok(Err(error)) if error.to_string().contains("not found") => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        match data_directory(account_id) {
            Some(dir) => match std::fs::remove_dir_all(&dir) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            },
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_account_has_its_own_data_store() {
        let a = data_store_identifier("acct-1");
        let digest = Sha256::digest(b"relay-auth-acct-1");
        assert_eq!(a.as_slice(), &digest[..16]);
        assert_ne!(a, data_store_identifier("acct-2"));
    }

    #[test]
    fn labels_keep_to_the_characters_tauri_allows() {
        assert_eq!(label("4f5e-2b1a"), "auth-4f5e-2b1a");
        assert_eq!(label("a.b c"), "auth-a_b_c");
    }
}
