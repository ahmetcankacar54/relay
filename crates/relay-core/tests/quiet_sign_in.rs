//! Rust-only tests of `approve_quietly`, the loop that drives the hidden renewal window (the
//! port of `electron/quiet-sign-in.ts`, which had no TS tests), against a stand-in `Webviews`.

use std::sync::{Arc, Mutex};

use relay_core::host::{
    QuietNavigation, QuietNavigationKind, QuietOpened, QuietPage, QuietWindow, SignInWindow,
    Webviews,
};
use relay_core::quiet_approval::{QuietResult, READ_PAGE, approve_quietly};
use serde_json::{Value, json};

const PAGE: &str = "https://claude.ai/oauth/authorize?client_id=c&state=s&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback";

#[derive(Default)]
struct Shared {
    clicks: Vec<String>,
    navigations: Vec<QuietNavigation>,
    closed: bool,
    opened: Option<QuietWindow>,
}

struct Page {
    shared: Arc<Mutex<Shared>>,
    page: Value,
}

impl QuietPage for Page {
    fn eval(&self, script: &str) -> Option<Value> {
        if script == READ_PAGE {
            return Some(self.page.clone());
        }
        let mut shared = self.shared.lock().unwrap();
        shared.clicks.push(script.to_owned());
        // The approval sends the page to the CLI's callback.
        shared.navigations.push(QuietNavigation {
            kind: QuietNavigationKind::Committed,
            url: "http://localhost:54545/callback?code=x".into(),
        });
        Some(Value::Bool(true))
    }
    fn take_navigations(&mut self) -> Vec<QuietNavigation> {
        std::mem::take(&mut self.shared.lock().unwrap().navigations)
    }
    fn close(self: Box<Self>) {
        self.shared.lock().unwrap().closed = true;
    }
}

struct Views {
    shared: Arc<Mutex<Shared>>,
    page: Value,
    fail: bool,
}

impl Webviews for Views {
    fn show_sign_in(&self, _: SignInWindow) {}
    fn close_sign_in(&self, _: &str) {}
    fn forget_sign_in_session(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn open_quiet(&self, window: &QuietWindow) -> Result<QuietOpened, String> {
        if self.fail {
            return Err("no window".into());
        }
        let mut shared = self.shared.lock().unwrap();
        shared.opened = Some(window.clone());
        shared.navigations.push(QuietNavigation {
            kind: QuietNavigationKind::Committed,
            url: PAGE.into(),
        });
        Ok(QuietOpened {
            page: Box::new(Page {
                shared: self.shared.clone(),
                page: self.page.clone(),
            }),
            refused: vec!["sessionKey".into()],
        })
    }
}

fn views(page: Value, fail: bool) -> Views {
    Views {
        shared: Arc::default(),
        page,
        fail,
    }
}

#[test]
fn the_window_clicks_authorize_and_is_approved_when_the_page_reaches_the_cli_callback() {
    let views = views(
        json!({ "host": "claude.ai", "path": "/oauth/authorize", "loginForm": false,
                "buttons": [{ "text": "Cancel", "disabled": false }, { "text": "Authorize", "disabled": false }] }),
        false,
    );
    let outcome = approve_quietly(&views, PAGE, Vec::new(), 10_000);
    assert_eq!(outcome.result, QuietResult::Approved);
    assert_eq!(outcome.refused, ["sessionKey"]);
    assert_eq!(
        outcome.trail,
        ["claude.ai/oauth/authorize", "localhost/callback"]
    );
    assert_eq!(outcome.last.unwrap().buttons, ["Cancel", "Authorize"]);
    let shared = views.shared.lock().unwrap();
    assert_eq!(shared.clicks.len(), 1);
    assert!(shared.clicks[0].contains("[1]") && shared.clicks[0].contains("\"Authorize\""));
    let opened = shared.opened.as_ref().unwrap();
    assert!(opened.allows("https://claude.ai/login"));
    assert!(!opened.allows("https://evil.test/"));
}

#[test]
fn a_page_without_an_approve_button_ends_without_approval_when_time_runs_out() {
    let views = views(
        json!({ "host": "claude.ai", "path": "/oauth/authorize", "loginForm": false,
                "buttons": [{ "text": "Continue with Google", "disabled": false }] }),
        false,
    );
    let outcome = approve_quietly(&views, PAGE, Vec::new(), 1_500);
    assert_eq!(
        outcome.result,
        QuietResult::NoApproval {
            detail: "no approve button".into()
        }
    );
    assert!(views.shared.lock().unwrap().closed);
}

#[test]
fn a_page_without_a_local_callback_or_a_window_that_cannot_open_fails_at_once() {
    let views_ok = views(Value::Null, false);
    let outcome = approve_quietly(
        &views_ok,
        "https://claude.ai/oauth/authorize?x=1",
        Vec::new(),
        10_000,
    );
    assert_eq!(
        outcome.result,
        QuietResult::Failed {
            detail: "page has no local callback".into()
        }
    );
    let broken = views(Value::Null, true);
    let outcome = approve_quietly(&broken, PAGE, Vec::new(), 10_000);
    assert_eq!(
        outcome.result,
        QuietResult::Failed {
            detail: "no window".into()
        }
    );
}
