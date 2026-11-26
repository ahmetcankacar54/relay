//! Port of `tests/desktop-sign-in-session.test.ts`: its `desktop-session` cases. The
//! `desktop-launch` log case and the `DesktopManager` cases are the Desktop slice's.

#[path = "common/usage_desktop.rs"]
mod helpers;

use helpers::{files, temp};
use relay_core::desktop_session::{SessionPresence, session_ends_ms, session_presence};

/// A Chromium cookie database with the given claude.ai cookie names, as bytes.
fn cookie_db(names: &[&str]) -> Vec<u8> {
    let dir = temp("relay-cookie-db-");
    let file = dir.path().join("Cookies");
    let db = rusqlite::Connection::open(&file).unwrap();
    db.execute_batch(
        "create table meta(key text primary key, value text); insert into meta values('version','24');
         create table cookies(host_key text, name text, value text, encrypted_value blob)",
    )
    .unwrap();
    for name in names {
        db.execute(
            "insert into cookies values(?,?,?,?)",
            rusqlite::params![".claude.ai", name, "", b"v10-sealed".to_vec()],
        )
        .unwrap();
    }
    drop(db);
    std::fs::read(&file).unwrap()
}

#[test]
fn a_saved_session_ends_when_its_session_key_cookies_do_one_that_cannot_be_told_says_nothing() {
    {
        let dir = temp("relay-cookie-ends-");
        let file = dir.path().join("Cookies");
        let db = rusqlite::Connection::open(&file).unwrap();
        db.execute_batch(
            "create table meta(key text primary key, value text); insert into meta values('version','24');
             create table cookies(host_key text, name text, value text, encrypted_value blob, expires_utc integer, has_expires integer)",
        )
        .unwrap();
        let chromium = |ms: i64| (ms + 11_644_473_600_000) * 1000;
        for (name, ends) in [
            ("sessionKey", 1_800_000_000_000),
            ("sessionKeyV3", 1_800_000_500_000),
            ("routingHint", 1_900_000_000_000),
        ] {
            db.execute(
                "insert into cookies values(?,?,?,?,?,?)",
                rusqlite::params![
                    ".claude.ai",
                    name,
                    "",
                    b"v10-sealed".to_vec(),
                    chromium(ends),
                    1
                ],
            )
            .unwrap();
        }
        drop(db);
        assert_eq!(
            session_ends_ms(&files("Cookies", Some(std::fs::read(&file).unwrap()))),
            Some(1_800_000_500_000.0)
        );
    }
    // No expiry columns, no session, no database: nothing to tell.
    assert_eq!(
        session_ends_ms(&files("Cookies", Some(cookie_db(&["sessionKey"])))),
        None
    );
    assert_eq!(
        session_ends_ms(&files("Cookies", Some(cookie_db(&["routingHint"])))),
        None
    );
    assert_eq!(session_ends_ms(&files("Cookies", None)), None);
}

#[test]
fn a_cookie_database_holds_a_session_only_while_it_has_a_session_key_row() {
    assert_eq!(
        session_presence(&files(
            "Cookies",
            Some(cookie_db(&["sessionKey", "routingHint"]))
        )),
        SessionPresence::Present
    );
    assert_eq!(
        session_presence(&files(
            "Network/Cookies",
            Some(cookie_db(&["sessionKeyV3"]))
        )),
        SessionPresence::Present
    );
    // Signed out, or a sign-in Chromium has not written yet: the other cookies stay.
    assert_eq!(
        session_presence(&files(
            "Cookies",
            Some(cookie_db(&["cf_clearance", "lastActiveOrg"]))
        )),
        SessionPresence::Absent
    );
    // Bytes that are no database, and no database at all, say nothing.
    assert_eq!(
        session_presence(&files(
            "Cookies",
            Some(b"deleted sessionKey row residue".to_vec())
        )),
        SessionPresence::Unknown
    );
    assert_eq!(
        session_presence(&files("Cookies", None)),
        SessionPresence::Unknown
    );
}

// --- The Desktop slice's cases: Claude's log, and DesktopManager around a session ---------------

#[path = "common/desktop.rs"]
mod desktop_helpers;

mod manager {
    use std::sync::{Arc, Mutex};

    use super::desktop_helpers::Fixture;
    use relay_core::desktop::DesktopError;
    use relay_core::desktop_files::{read_bytes, write_bytes};
    use relay_core::desktop_launch::{ClaudeSignOut, sign_outs_in, signed_out_since_start};
    use relay_core::desktop_session::SessionPresence;
    use relay_core::shared::types::Account;

    const A: &str = "00000000-0000-4000-8000-0000000000a1";

    fn log() -> String {
        [
            "2026-11-10 13:30:00 [info] Starting app {".to_string(),
            "2026-11-10 13:34:08 [info] [account] Navigated to /logout, synthesizing logged-out".to_string(),
            format!("2026-11-10 13:34:08 [info] [account] Login-state transition (loggedOut: false → true, uuid: {A} → <none>), clearing oauth cache"),
        ]
        .join("\n")
    }

    #[test]
    fn claudes_log_tells_a_start_that_signed_itself_out_and_which_account_signed_out_when() {
        assert_eq!(signed_out_since_start("nothing"), None);
        assert_eq!(
            signed_out_since_start("x] Starting app {\n loaded"),
            Some(false)
        );
        assert_eq!(signed_out_since_start(&log()), Some(true));
        assert_eq!(
            signed_out_since_start(
                &(log()
                    + "\n2026-11-10 13:35:00 [info] [account] Login-state transition (loggedOut: true → false, uuid: <none> → x)")
            ),
            Some(false)
        );
        assert_eq!(
            signed_out_since_start(&(log() + "\n2026-11-10 14:00:00 [info] Starting app {")),
            Some(false)
        );
        let at = chrono::TimeZone::with_ymd_and_hms(&chrono::Local, 2026, 11, 10, 13, 34, 8)
            .earliest()
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            sign_outs_in(&log()),
            vec![ClaudeSignOut {
                account_uuid: A.into(),
                at
            }]
        );
    }

    struct World {
        f: Fixture,
        session: Arc<Mutex<SessionPresence>>,
    }

    fn fixture() -> World {
        let f = Fixture::new();
        f.host.st().signed_out = Some(false);
        f.host.st().sign_outs = Some(Vec::new());
        let session = Arc::new(Mutex::new(SessionPresence::Present));
        let presence = Arc::clone(&session);
        f.manager.configure(|h| {
            h.session_of = Arc::new(move |_| *presence.lock().unwrap());
            h.session_settle_ms = 60;
            h.session_poll_ms = 5;
            h.sign_in_verify_ms = vec![1, 2];
        });
        World { f, session }
    }

    impl World {
        fn set_session(&self, value: SessionPresence) {
            *self.session.lock().unwrap() = value;
        }
        fn account(&self, name: &str) -> Account {
            self.f.account(name, None)
        }
        fn vault(&self, account_uuid: &str) -> Option<Vec<u8>> {
            read_bytes(&self.f.vault(), &format!("accounts/{account_uuid}.bin")).unwrap()
        }
        fn rejected(&self, id: &str) -> Option<String> {
            self.f
                .store
                .account(id)
                .unwrap()
                .desktop
                .unwrap()
                .rejected_at
        }
    }

    #[test]
    fn a_sign_in_whose_session_is_not_in_the_cookie_file_yet_is_not_saved_and_claude_is_not_quit() {
        let w = fixture();
        let a = w.f.create("A", None);
        let (account_uuid, org_id) = w.f.sign_in("A");
        w.f.set_running(true);
        w.set_session(SessionPresence::Absent);
        assert!(matches!(
            w.f.manager.capture(&a.id, &org_id),
            Err(DesktopError::SignInNotSettled(_))
        ));
        assert_eq!(w.f.quits(), 0);
        assert_eq!(w.vault(&account_uuid), None);
        assert_eq!(w.f.store.account(&a.id).unwrap().desktop, None);
        // Chromium writes it while Relay waits: the same save then goes through.
        let session = Arc::clone(&w.session);
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(15));
            *session.lock().unwrap() = SessionPresence::Present;
        });
        w.f.manager.capture(&a.id, &org_id).unwrap();
        writer.join().unwrap();
        assert_eq!(w.f.quits(), 1);
        assert!(w.vault(&account_uuid).is_some());
        assert_eq!(
            w.f.store
                .account(&a.id)
                .unwrap()
                .desktop
                .unwrap()
                .account_uuid,
            account_uuid
        );
    }

    #[test]
    fn a_claude_that_signed_itself_out_is_not_waited_for_and_a_closed_ones_session_less_sign_in_is_refused()
     {
        let w = fixture();
        let a = w.f.create("A", None);
        let (account_uuid, org_id) = w.f.sign_in("A");
        w.set_session(SessionPresence::Absent);
        w.f.set_running(true);
        w.f.host.st().signed_out = Some(true);
        let error = w.f.manager.capture(&a.id, &org_id).unwrap_err();
        assert!(error.message().contains("signed out"));
        assert_eq!(w.f.quits(), 0);
        w.f.set_running(false);
        w.f.host.st().signed_out = Some(false);
        let error = w.f.manager.capture(&a.id, &org_id).unwrap_err();
        assert!(error.message().contains("holds no session"));
        assert_eq!(w.vault(&account_uuid), None);
    }

    #[test]
    fn a_switch_never_replaces_a_saved_sign_in_with_one_that_lost_its_session() {
        let w = fixture();
        let a = w.account("A");
        let b = w.account("B");
        let b_uuid = b.desktop.clone().unwrap().account_uuid;
        let saved_b = w.vault(&b_uuid);
        write_bytes(&w.f.root, "Cookies", Some(b"cookie-B-without-session")).unwrap();
        w.set_session(SessionPresence::Absent);
        w.f.manager.switch_to(&a.id, Default::default()).unwrap();
        w.f.manager.wait_sign_in_verified();
        assert_eq!(w.vault(&b_uuid), saved_b);
        assert_eq!(
            read_bytes(&w.f.root, "Cookies").unwrap().unwrap(),
            b"cookie-A".to_vec()
        );
    }

    #[test]
    fn an_account_claude_signs_out_right_after_a_switch_is_marked_skipped_by_unattended_switches_and_cleared_by_a_new_sign_in()
     {
        let w = fixture();
        let a = w.account("A");
        let b = w.account("B");
        let rejected = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&rejected);
        w.f.manager.configure(|h| {
            h.on_sign_in_rejected = Some(Arc::new(move |account: &Account| {
                sink.lock().unwrap().push(account.name.clone())
            }))
        });
        w.f.host.st().signed_out = Some(true);
        w.f.manager.switch_to(&a.id, Default::default()).unwrap();
        w.f.manager.wait_sign_in_verified();
        assert!(w.rejected(&a.id).is_some());
        assert_eq!(*rejected.lock().unwrap(), vec!["A"]);
        w.set_session(SessionPresence::Absent);
        w.f.manager.switch_to(&b.id, Default::default()).unwrap();
        w.f.host.st().signed_out = Some(false);
        w.f.manager.wait_sign_in_verified();
        w.set_session(SessionPresence::Present);
        assert_eq!(w.rejected(&b.id), None);
        assert!(w.rejected(&a.id).is_some());
        assert!(matches!(
            w.f.manager.switch_to(
                &a.id,
                relay_core::desktop::DesktopSwitchOptions {
                    automatic: true,
                    ..Default::default()
                }
            ),
            Err(DesktopError::SwitchRefused(_))
        ));
        // By hand it still opens; a sign-in saved again clears the mark.
        w.f.manager.begin_login(&a.id).unwrap();
        let desktop = a.desktop.clone().unwrap();
        relay_core::desktop_files::write_bytes(
            &w.f.root,
            "config.json",
            Some(&relay_core::desktop_files::json_bytes(&serde_json::json!({
                "oauth:tokenCacheV2": "encrypted:A",
                "lastKnownAccountUuid": desktop.account_uuid,
            }))),
        )
        .unwrap();
        write_bytes(&w.f.root, "Cookies", Some(b"cookie-A")).unwrap();
        w.f.manager.capture(&a.id, &desktop.org_id).unwrap();
        assert_eq!(w.rejected(&a.id), None);
    }

    fn now_ms() -> i64 {
        relay_core::clock::now_ms()
    }

    #[test]
    fn signing_out_inside_claude_ends_the_saved_sign_in_the_account_is_marked_unless_claude_is_in_it_again()
     {
        let w = fixture();
        let a = w.account("A");
        let b = w.account("B");
        w.f.host.st().sign_outs = Some(vec![
            ClaudeSignOut {
                account_uuid: a.desktop.clone().unwrap().account_uuid,
                at: now_ms() + 60_000,
            },
            ClaudeSignOut {
                account_uuid: b.desktop.clone().unwrap().account_uuid,
                at: now_ms() - 3_600_000,
            },
        ]);
        w.f.manager.note_sign_outs();
        assert!(w.rejected(&a.id).is_some());
        assert_eq!(w.rejected(&b.id), None);
    }

    #[test]
    fn a_saved_sign_in_left_unused_until_its_session_cookies_ended_is_marked_before_a_switch_puts_it_back()
     {
        let w = fixture();
        let a = w.account("A");
        let b = w.account("B"); // The Claude app is on B.
        let rejected = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&rejected);
        w.f.manager.configure(|h| {
            h.on_sign_in_rejected = Some(Arc::new(move |account: &Account| {
                sink.lock().unwrap().push(account.name.clone())
            }))
        });
        let ended = (now_ms() - 60_000) as f64;
        w.f.manager.configure(|h| {
            h.session_ends = Arc::new(move |files| {
                let cookie = files
                    .get("Cookies")
                    .cloned()
                    .flatten()
                    .map(|c| String::from_utf8_lossy(&c).into_owned())
                    .unwrap_or_default();
                (cookie.contains("cookie-A") || cookie.contains("cookie-B")).then_some(ended)
            })
        });
        w.f.manager.note_ended_sign_ins();
        assert!(w.rejected(&a.id).is_some(), "A's saved sign-in ended");
        assert_eq!(
            w.rejected(&b.id),
            None,
            "the app is on B: its live sign-in counts"
        );
        assert_eq!(*rejected.lock().unwrap(), vec!["A"]);
        // Looked at most every half hour.
        w.f.store
            .update(|s| {
                let a = s.accounts.iter_mut().find(|x| x.id == a.id).unwrap();
                a.desktop.as_mut().unwrap().rejected_at = None;
            })
            .unwrap();
        w.f.manager.note_ended_sign_ins();
        assert_eq!(*rejected.lock().unwrap(), vec!["A"]);
    }
}
