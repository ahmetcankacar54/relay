//! The hidden renewal window (the window side of electron/quiet-sign-in.ts): an in-memory
//! (incognito) session holding an account's claude.ai cookies for one renewal. The page logic is
//! `relay_core::quiet_approval::approve_quietly`, which drives this window through `QuietPage`.
//! Scripts run with `eval_with_callback`, whose result comes straight back to Rust: the page gets
//! no command to call.
//!
//! Differences from Electron: Tauri reports no same-document navigations and no server
//! redirects, so the trail holds committed pages only, and the page's own requests to Anthropic
//! (diagnostics only) are not listed; audio is not muted (the window is hidden and lives a minute).

use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::clock::now_ms;
use relay_core::desktop_usage::{SAFARI_USER_AGENT, SameSite};
use relay_core::host::{
    CookieSpec, QuietNavigation, QuietNavigationKind, QuietOpened, QuietPage, QuietWindow,
    SIGN_IN_WINDOW_SIZE,
};
use serde_json::Value;
use tauri::webview::cookie::{Cookie, SameSite as CookieSameSite, time::OffsetDateTime};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::state::lock;

/// How long a script may take to answer before its read counts as failed.
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

struct Page {
    window: WebviewWindow,
    navigations: Arc<Mutex<Vec<QuietNavigation>>>,
}

impl QuietPage for Page {
    fn eval(&self, script: &str) -> Option<Value> {
        let (send, receive) = sync_channel(1);
        // A thrown error answers null (Windows drops exceptions silently otherwise).
        let wrapped =
            format!("(() => {{ try {{ return ({script}); }} catch (e) {{ return null; }} }})()");
        self.window
            .eval_with_callback(wrapped, move |json| {
                let _ = send.try_send(json);
            })
            .ok()?;
        let json = receive.recv_timeout(EVAL_TIMEOUT).ok()?;
        serde_json::from_str::<Value>(&json)
            .ok()
            .filter(|value| !value.is_null())
    }

    fn take_navigations(&mut self) -> Vec<QuietNavigation> {
        std::mem::take(&mut *lock(&self.navigations))
    }

    fn close(self: Box<Self>) {
        // The incognito session goes with the window.
        let _ = self.window.destroy();
    }
}

/// A cookie as `Webview::set_cookie` takes it. WebKit needs a domain on every cookie; a host-only
/// one (`__Host-…`) gets its exact host, which WebKit keeps host-only (no leading dot).
fn cookie(spec: &CookieSpec) -> Cookie<'static> {
    let host = tauri::Url::parse(&spec.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let mut cookie = Cookie::build((spec.name.clone(), spec.value.clone()))
        .domain(spec.domain.clone().unwrap_or(host))
        .path(spec.path.clone())
        .secure(spec.secure)
        .http_only(spec.http_only);
    if let Some(same_site) = match spec.same_site {
        SameSite::Unspecified => None,
        SameSite::NoRestriction => Some(CookieSameSite::None),
        SameSite::Lax => Some(CookieSameSite::Lax),
        SameSite::Strict => Some(CookieSameSite::Strict),
    } {
        cookie = cookie.same_site(same_site);
    }
    if spec.expiration_date.is_finite()
        && let Ok(at) = OffsetDateTime::from_unix_timestamp(spec.expiration_date as i64)
    {
        cookie = cookie.expires(at);
    }
    cookie.build()
}

/// Opens a hidden quiet window: sets the account's cookies, then loads `window.url`, blocking
/// navigations `window.allows` refuses. Call it off the main thread: it waits for the window.
pub fn open(app: &AppHandle, quiet: &QuietWindow) -> Result<QuietOpened, String> {
    let url: tauri::Url = quiet.url.parse().map_err(|e| format!("{e}"))?;
    let label = format!("quiet-{}", uuid::Uuid::new_v4());
    let navigations = Arc::new(Mutex::new(Vec::new()));
    let allowed = quiet.clone();
    let visits = navigations.clone();
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External("about:blank".parse().expect("static")),
    )
    .title("Relay")
    .inner_size(SIGN_IN_WINDOW_SIZE.0 as f64, SIGN_IN_WINDOW_SIZE.1 as f64)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .incognito(true)
    // A plain browser's user agent: no Relay or engine tokens, as the limit reads send.
    .user_agent(SAFARI_USER_AGENT)
    .on_navigation(move |target| {
        target.as_str() == "about:blank" || allowed.allows(target.as_str())
    })
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(move |_, payload| {
        if payload.event() == PageLoadEvent::Started && payload.url().as_str() != "about:blank" {
            lock(&visits).push(QuietNavigation {
                kind: QuietNavigationKind::Committed,
                url: payload.url().to_string(),
            });
        }
    })
    .build()
    .map_err(|e| e.to_string())?;
    let mut refused = Vec::new();
    for spec in quiet.cookie_specs(now_ms() as f64 / 1_000.0) {
        if window.set_cookie(cookie(&spec)).is_err() {
            refused.push(spec.name);
        }
    }
    if let Err(error) = window.navigate(url) {
        let _ = window.destroy();
        return Err(error.to_string());
    }
    Ok(QuietOpened {
        page: Box::new(Page {
            window,
            navigations,
        }),
        refused,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(domain: Option<&str>) -> CookieSpec {
        CookieSpec {
            url: "https://claude.ai/".into(),
            domain: domain.map(str::to_owned),
            path: "/".into(),
            name: "sessionKey".into(),
            value: "v".into(),
            secure: true,
            http_only: true,
            same_site: SameSite::Lax,
            expiration_date: 2_000_000_000.0,
        }
    }

    #[test]
    fn a_domain_cookie_keeps_its_domain_and_a_host_only_one_gets_its_host() {
        assert_eq!(
            cookie(&spec(Some(".claude.ai"))).domain(),
            Some("claude.ai")
        );
        let host_only = cookie(&spec(None));
        assert_eq!(host_only.domain(), Some("claude.ai"));
        assert_eq!(host_only.same_site(), Some(CookieSameSite::Lax));
        assert_eq!(host_only.secure(), Some(true));
        assert_eq!(
            host_only.expires_datetime().map(|at| at.unix_timestamp()),
            Some(2_000_000_000)
        );
    }
}
