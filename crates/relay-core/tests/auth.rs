//! Port of `tests/auth.test.ts`. The CLI stand-ins are `/bin/sh` scripts (the TS used Node
//! scripts); Windows is skipped as in the TS.

#[path = "common/p4services.rs"]
mod helpers;

use relay_core::auth::authorization_url;

const URL: &str = "https://claude.ai/oauth/authorize?client_id=fixture&state=private-state&redirect_uri=http%3A%2F%2Flocalhost%3A9999";

#[test]
fn oauth_links_accept_only_exact_official_https_authorization_origins() {
    assert_eq!(authorization_url(URL).as_deref(), Some(URL));
    let current = URL.replace("claude.ai/oauth", "claude.com/cai/oauth");
    assert_eq!(authorization_url(&current), Some(current.clone()));
    for invalid in [
        URL.replace("claude.ai", "claude.ai.evil.test"),
        URL.replacen("https", "http", 1),
        URL.replace("claude.ai", "user:secret@claude.ai"),
        URL.replace("claude.ai", "claude.ai:444"),
        URL.replace("/oauth/authorize", "/arbitrary"),
        "https://claude.ai/oauth/authorize?client_id=x".into(),
    ] {
        assert_eq!(authorization_url(&invalid), None, "{invalid}");
    }
}

#[cfg(unix)]
mod unix {
    use super::URL;
    use super::helpers::{script, sleep_ms, until};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use relay_core::auth::{AuthError, AuthManager, BackgroundSignIn, Verdict};
    use relay_core::environment::process_env;
    use relay_core::shared::types::{AuthFlow, AuthFlowStatus};

    pub struct Fixture {
        pub root: tempfile::TempDir,
        pub auth: AuthManager,
        pub events: Arc<Mutex<Vec<AuthFlow>>>,
        pub opened: Arc<Mutex<Vec<String>>>,
        pub file: std::path::PathBuf,
    }

    impl Fixture {
        pub fn start(&self, id: Option<&str>) -> AuthFlow {
            let id = id.map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
            self.auth
                .start(
                    &id,
                    self.file.to_str().unwrap(),
                    self.root.path(),
                    &process_env(),
                    None,
                )
                .unwrap()
        }
        pub fn first(&self) -> AuthFlow {
            self.auth.list()[0].clone()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.auth.dispose();
        }
    }

    pub fn fixture(
        body: &str,
        verify: impl Fn(&str) -> Result<Verdict, String> + Send + Sync + 'static,
        timeout: Duration,
    ) -> Fixture {
        let root = tempfile::Builder::new()
            .prefix("relay-auth-")
            .tempdir()
            .unwrap();
        let file = script(root.path(), "cli", body);
        let events = Arc::new(Mutex::new(Vec::new()));
        let opened = Arc::new(Mutex::new(Vec::new()));
        let auth = AuthManager::new(
            Box::new(verify),
            Box::new({
                let events = events.clone();
                move |flow| events.lock().unwrap().push(flow)
            }),
            Box::new({
                let opened = opened.clone();
                move |url: &str| {
                    opened.lock().unwrap().push(url.to_owned());
                    Ok(())
                }
            }),
            Some(timeout),
            None,
        );
        Fixture {
            root,
            auth,
            events,
            opened,
            file,
        }
    }

    fn yes(_: &str) -> Result<Verdict, String> {
        Ok(Verdict::Yes)
    }

    const LONG: Duration = Duration::from_secs(15);

    #[test]
    fn hidden_sign_in_is_idempotent_handles_split_urls_reopens_verifies_without_renderer_and_exposes_no_secrets()
     {
        let verified = Arc::new(Mutex::new(0));
        let (head, tail) = URL.split_at(45);
        let f = fixture(
            &format!(
                "printf '%s' '{head}'\nsleep 0.04\nprintf '%s\\nPaste code here if prompted:\\n' '{tail}'\nread line\necho 'Login successful'\nexit 0"
            ),
            {
                let verified = verified.clone();
                move |_| {
                    *verified.lock().unwrap() += 1;
                    Ok(Verdict::Yes)
                }
            },
            LONG,
        );
        let flow = f.start(None);
        assert_eq!(f.start(Some(&flow.account_id)).id, flow.id);
        until(|| f.first().browser_ready);
        assert!(f.first().code_requested);
        f.auth.reopen(&flow.account_id, &flow.id, false).unwrap();
        assert_eq!(*f.opened.lock().unwrap(), [URL]);
        assert!(
            f.auth
                .submit_code(&flow.account_id, &flow.id, "code\ncommand")
                .is_err()
        );
        f.auth
            .submit_code(&flow.account_id, &flow.id, "private-code")
            .unwrap();
        until(|| f.first().status == AuthFlowStatus::Connected);
        assert_eq!(*verified.lock().unwrap(), 1);
        let events = serde_json::to_string(&*f.events.lock().unwrap()).unwrap();
        assert!(!events.contains("private-state"));
        assert!(!events.contains("private-code"));
        assert!(f.auth.reopen(&flow.account_id, &flow.id, false).is_err());
    }

    #[test]
    fn failed_login_cannot_be_reported_as_connected_by_a_previously_valid_account() {
        let reads = Arc::new(Mutex::new(0));
        let f = fixture(
            "exit 1",
            {
                let reads = reads.clone();
                move |_| {
                    *reads.lock().unwrap() += 1;
                    Ok(Verdict::Yes)
                }
            },
            LONG,
        );
        f.start(None);
        until(|| f.first().status == AuthFlowStatus::Failed);
        assert_eq!(*reads.lock().unwrap(), 0);
    }

    #[test]
    fn cancel_disposes_child_retry_rejects_stale_callbacks_and_attempts_stay_independent() {
        let f = fixture(&format!("echo '{URL}'\nexec sleep 1000"), yes, LONG);
        let a = f.start(None);
        let b = f.start(None);
        until(|| f.auth.list().iter().all(|f| f.browser_ready));
        f.auth.cancel(&a.account_id, &a.id).unwrap();
        assert_eq!(
            f.auth.list().iter().find(|x| x.id == b.id).unwrap().status,
            AuthFlowStatus::Waiting
        );
        let retry = f.start(Some(&a.account_id));
        assert_ne!(a.id, retry.id);
        let error = f.auth.reopen(&a.account_id, &a.id, false).unwrap_err();
        assert!(error.to_string().contains("no longer valid"));
        assert_eq!(f.auth.list().len(), 2);
    }

    #[test]
    fn timeout_and_missing_executable_produce_terminal_failure_states() {
        let f = fixture("exec sleep 1000", yes, Duration::from_millis(100));
        f.start(None);
        until(|| f.first().status == AuthFlowStatus::Failed);
        assert!(!f.auth.active(&f.first().account_id));
        let id = uuid::Uuid::new_v4().to_string();
        let missing = f.root.path().join("missing");
        f.auth
            .start(
                &id,
                missing.to_str().unwrap(),
                f.root.path(),
                &Default::default(),
                None,
            )
            .unwrap();
        until(|| {
            f.auth
                .list()
                .iter()
                .find(|f| f.account_id == id)
                .is_some_and(|f| f.status == AuthFlowStatus::Failed)
        });
    }

    #[test]
    fn cancelling_during_verification_cannot_resurrect_a_completed_attempt() {
        let (finish, finished) = mpsc::channel::<bool>();
        let finished = Mutex::new(finished);
        let f = fixture(
            "exit 0",
            move |_| {
                let verdict = finished.lock().unwrap().recv().unwrap_or(false);
                Ok(if verdict { Verdict::Yes } else { Verdict::No })
            },
            LONG,
        );
        let flow = f.start(None);
        until(|| f.first().status == AuthFlowStatus::Verifying);
        f.auth.cancel(&flow.account_id, &flow.id).unwrap();
        finish.send(true).unwrap();
        sleep_ms(30);
        assert_eq!(f.first().status, AuthFlowStatus::Cancelled);
    }

    #[test]
    fn a_background_sign_in_hands_its_page_to_the_hidden_window_never_the_browser_and_settles_with_its_end()
     {
        let f = fixture(
            &format!("echo '{URL}'\nread line\necho 'Login successful'\nexit 0"),
            yes,
            LONG,
        );
        let presented = Arc::new(Mutex::new(Vec::<String>::new()));
        let id = uuid::Uuid::new_v4().to_string();
        let flow = f
            .auth
            .start(
                &id,
                f.file.to_str().unwrap(),
                f.root.path(),
                &process_env(),
                Some(BackgroundSignIn {
                    present: Arc::new({
                        let presented = presented.clone();
                        move |page| presented.lock().unwrap().push(page.to_owned())
                    }),
                }),
            )
            .unwrap();
        assert_eq!(flow.background, Some(true));
        let settled = f.auth.settled(&id, &flow.id).expect("settled");
        until(|| presented.lock().unwrap().len() == 1);
        assert_eq!(*presented.lock().unwrap(), [URL]);
        assert!(f.opened.lock().unwrap().is_empty());
        f.auth.cancel(&id, &flow.id).unwrap();
        assert_eq!(settled.wait().status, AuthFlowStatus::Cancelled);
        assert!(f.auth.settled(&id, "another").is_none());
    }

    #[test]
    fn a_background_renewal_never_takes_over_the_user_s_sign_in_nor_the_user_s_request_a_hidden_renewal()
     {
        let f = fixture(&format!("echo '{URL}'\nexec sleep 20"), yes, LONG);
        let id = uuid::Uuid::new_v4().to_string();
        let cli = f.file.to_str().unwrap();
        let env = process_env();
        let quiet = || {
            Some(BackgroundSignIn {
                present: Arc::new(|_: &str| {}),
            })
        };
        let user = f.auth.start(&id, cli, f.root.path(), &env, None).unwrap();
        assert!(matches!(
            f.auth.start(&id, cli, f.root.path(), &env, quiet()),
            Err(AuthError::Busy(_))
        ));
        // The same kind asked again still gets the running attempt.
        assert_eq!(
            f.auth
                .start(&id, cli, f.root.path(), &env, None)
                .unwrap()
                .id,
            user.id
        );
        f.auth.cancel(&id, &user.id).unwrap();
        let hidden = f
            .auth
            .start(&id, cli, f.root.path(), &env, quiet())
            .unwrap();
        assert!(matches!(
            f.auth.start(&id, cli, f.root.path(), &env, None),
            Err(AuthError::Busy(_))
        ));
        f.auth.cancel(&id, &hidden.id).unwrap();
    }
}
