//! Port of `tests/auth-window.test.ts`. The CLI stand-in is a `/bin/sh` script (the TS used a
//! Node script); Windows is skipped as in the TS.

#[path = "common/p4services.rs"]
mod helpers;

use relay_core::auth_page_policy::{
    local_callback, sign_in_navigation_allowed, sign_in_partition, url_host,
};

const HANDED: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s&redirect_uri=http%3A%2F%2Flocalhost%3A65076%2Fcallback";
const PRINTED: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

#[test]
fn the_sign_in_window_may_visit_anthropic_s_sites_sign_in_providers_and_the_cli_s_own_callback_only()
 {
    let callback = local_callback(HANDED);
    assert_eq!(
        callback.as_ref().map(url_host).as_deref(),
        Some("localhost:65076")
    );
    assert_eq!(local_callback(PRINTED), None);
    for ok in [
        "https://claude.ai/login",
        "https://claude.com/cai/oauth/authorize?x=1",
        "https://platform.claude.com/oauth/code/success",
        "https://www.anthropic.com/legal",
        "https://accounts.google.com/o/oauth2/auth",
        "http://localhost:65076/callback?code=abc",
    ] {
        assert!(sign_in_navigation_allowed(ok, callback.as_ref()), "{ok}");
    }
    for no in [
        "https://claude.ai.evil.test/",
        "https://evil.test/?claude.ai",
        "http://claude.ai/login",
        "http://localhost:65077/callback",
        "http://localhost:65076/other",
        "https://user:pw@claude.ai/",
        "file:///etc/passwd",
    ] {
        assert!(!sign_in_navigation_allowed(no, callback.as_ref()), "{no}");
    }
    assert!(!sign_in_navigation_allowed(
        "http://localhost:65076/callback",
        None
    ));
    assert_eq!(sign_in_partition("abc"), "persist:relay-auth-abc");
}

#[cfg(unix)]
mod unix {
    use super::helpers::{script, sleep_ms, until};
    use super::{HANDED, PRINTED};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use relay_core::auth::{AuthBrowser, AuthManager, Verdict};
    use relay_core::environment::process_env;
    use relay_core::shared::types::{AuthFlow, AuthFlowStatus};

    type Log<T> = Arc<Mutex<Vec<T>>>;

    struct Browser {
        root: std::path::PathBuf,
        hand_off: bool,
        shown: Log<(String, String)>,
        closed: Log<String>,
    }

    impl AuthBrowser for Browser {
        fn env(&self, attempt: &str) -> Vec<(String, String)> {
            vec![
                (
                    "RELAY_TEST_PAGE".into(),
                    self.root
                        .join(format!("{attempt}.url"))
                        .display()
                        .to_string(),
                ),
                (
                    "RELAY_TEST_HAND".into(),
                    if self.hand_off { "1" } else { "" }.into(),
                ),
            ]
        }
        fn take(&self, attempt: &str) -> Option<String> {
            let file = self.root.join(format!("{attempt}.url"));
            let url = std::fs::read_to_string(&file).ok()?;
            std::fs::remove_file(&file).ok()?;
            Some(url)
        }
        fn show(&self, account: &str, url: &str) {
            self.shown
                .lock()
                .unwrap()
                .push((account.into(), url.into()));
        }
        fn close(&self, account: &str) {
            self.closed.lock().unwrap().push(account.into());
        }
    }

    struct Fixture {
        auth: AuthManager,
        events: Log<AuthFlow>,
        shown: Log<(String, String)>,
        closed: Log<String>,
        opened: Log<String>,
        id: String,
        flow: AuthFlow,
        _root: tempfile::TempDir,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.auth.dispose();
        }
    }

    impl Fixture {
        fn last(&self) -> Option<AuthFlow> {
            self.events.lock().unwrap().last().cloned()
        }
    }

    fn fixture(body: &str, hand_off: bool, open_fails: bool, verify: Verdict) -> Fixture {
        let root = tempfile::Builder::new()
            .prefix("relay-auth-window-")
            .tempdir()
            .unwrap();
        let file = script(root.path(), "cli", body);
        let events: Log<AuthFlow> = Default::default();
        let shown: Log<(String, String)> = Default::default();
        let closed: Log<String> = Default::default();
        let opened: Log<String> = Default::default();
        let auth = AuthManager::new(
            Box::new(move |_| Ok(verify.clone())),
            Box::new({
                let events = events.clone();
                move |f| events.lock().unwrap().push(f)
            }),
            Box::new({
                let opened = opened.clone();
                move |u: &str| {
                    if open_fails {
                        return Err("no browser".into());
                    }
                    opened.lock().unwrap().push(u.into());
                    Ok(())
                }
            }),
            Some(Duration::from_secs(15)),
            None,
        );
        auth.set_browser(Some(Arc::new(Browser {
            root: root.path().to_owned(),
            hand_off,
            shown: shown.clone(),
            closed: closed.clone(),
        })));
        let id = uuid::Uuid::new_v4().to_string();
        let flow = auth
            .start(
                &id,
                file.to_str().unwrap(),
                root.path(),
                &process_env(),
                None,
            )
            .unwrap();
        Fixture {
            auth,
            events,
            shown,
            closed,
            opened,
            id,
            flow,
            _root: root,
        }
    }

    /// Prints the paste-code page, hands the localhost page to BROWSER, then waits for "approval".
    fn cli(exit_after: &str) -> String {
        format!(
            "echo 'Opening browser to sign in…'\necho \"If the browser didn't open, visit: {PRINTED}\"\nif [ -n \"$RELAY_TEST_HAND\" ]; then printf '%s' '{HANDED}' > \"$RELAY_TEST_PAGE\"; fi\nsleep {exit_after}\nexit 0"
        )
    }

    #[test]
    fn the_page_the_cli_hands_to_browser_opens_in_the_system_browser_relay_s_window_is_the_other_way_in()
     {
        let f = fixture(&cli("0.9"), true, false, Verdict::Yes);
        until(|| f.opened.lock().unwrap().len() == 1);
        // The localhost page, not the paste-a-code one the CLI printed, and no window of Relay's.
        assert_eq!(*f.opened.lock().unwrap(), [HANDED]);
        assert!(f.shown.lock().unwrap().is_empty());
        let waiting = f
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.status == AuthFlowStatus::Waiting)
            .cloned()
            .unwrap();
        assert!(
            waiting.browser_ready
                && waiting.window_available == Some(true)
                && waiting.in_window != Some(true)
        );
        // "Reopen browser" opens the same page again.
        f.auth.reopen(&f.id, &f.flow.id, false).unwrap();
        assert_eq!(*f.opened.lock().unwrap(), [HANDED, HANDED]);
        // "Open in Relay window": the flow now owns that window and closes it when the sign-in ends.
        f.auth.reopen(&f.id, &f.flow.id, true).unwrap();
        assert_eq!(
            *f.shown.lock().unwrap(),
            [(f.id.clone(), HANDED.to_owned())]
        );
        assert_eq!(f.last().unwrap().in_window, Some(true));
        until(|| f.last().unwrap().status == AuthFlowStatus::Connected);
        assert_eq!(*f.closed.lock().unwrap(), [f.id.as_str()]);
    }

    #[test]
    fn a_sign_in_approved_in_the_system_browser_never_opens_or_closes_relay_s_window() {
        let f = fixture(&cli("0.9"), true, false, Verdict::Yes);
        until(|| f.last().unwrap().status == AuthFlowStatus::Connected);
        assert_eq!(*f.opened.lock().unwrap(), [HANDED]);
        assert!(f.shown.lock().unwrap().is_empty());
        assert!(f.closed.lock().unwrap().is_empty());
    }

    #[test]
    fn a_system_browser_that_cannot_be_opened_leaves_relay_s_window() {
        let f = fixture(&cli("0.9"), true, true, Verdict::Yes);
        until(|| f.shown.lock().unwrap().len() == 1);
        assert_eq!(
            *f.shown.lock().unwrap(),
            [(f.id.clone(), HANDED.to_owned())]
        );
        assert!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.status == AuthFlowStatus::Waiting && e.in_window == Some(true))
        );
    }

    #[test]
    fn a_cli_that_hands_nothing_over_gets_its_printed_page_opened_after_a_few_seconds() {
        let f = fixture(&cli("7"), false, false, Verdict::Yes);
        sleep_ms(1_500);
        assert!(f.opened.lock().unwrap().is_empty());
        until(|| f.opened.lock().unwrap().len() == 1);
        assert_eq!(*f.opened.lock().unwrap(), [PRINTED]);
        assert!(f.shown.lock().unwrap().is_empty());
    }

    #[test]
    fn a_sign_in_that_does_not_fit_the_profile_fails_with_the_reason_verification_gives() {
        let reason = "Tarayıcıda başka bir Claude hesabıyla giriş yapıldı.";
        let f = fixture(&cli("0.9"), true, false, Verdict::Reason(reason.into()));
        until(|| f.last().unwrap().status == AuthFlowStatus::Failed);
        assert_eq!(f.last().unwrap().error.as_deref(), Some(reason));
    }
}
