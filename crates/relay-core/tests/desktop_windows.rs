//! Port of tests/desktop-windows.test.ts. The `localizeError` checks (the renderer's message
//! catalog) are left to the UI's tests.

#[path = "common/desktop.rs"]
mod helpers;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use helpers::{FakeHost, Fixture, uuid};
use relay_core::desktop::{
    DesktopError, DesktopHost, DesktopSwitchOptions, WINDOW_HOLDS_ACCOUNT, WindowsPort,
};
use relay_core::desktop_files::{json_bytes, read_bytes, read_object, write_bytes};
use relay_core::desktop_windows::{
    DesktopWindows, DesktopWindowsDeps, LogFields, SessionOwner, WINDOW_DID_NOT_CLOSE,
    WINDOW_IS_MAIN, WINDOWS_OFF, WindowOpened,
};
use relay_core::shared::types::{Account, DesktopHistoryTransfer};
use serde_json::{Map, Value, json};

struct World {
    f: Fixture,
    windows: Arc<DesktopWindows>,
    events: Arc<Mutex<Vec<(String, LogFields)>>>,
}

fn fixture() -> World {
    let f = Fixture::new();
    f.host.windows_supported.store(true, Ordering::SeqCst);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let (root, seed, seal) = (
        f.root.clone(),
        Arc::downgrade(&f.manager),
        Arc::downgrade(&f.manager),
    );
    let windows = Arc::new(DesktopWindows::new(DesktopWindowsDeps {
        folder: f.base().join("Relay").join("claude-windows"),
        host: Arc::clone(&f.host) as Arc<dyn DesktopHost>,
        current: Box::new(move || {
            Ok(read_object(&root, "config.json")?
                .and_then(|c| c.get("lastKnownAccountUuid")?.as_str().map(str::to_string)))
        }),
        seed: Box::new(move |account, dir| seed.upgrade().unwrap().seed_window(account, dir)),
        seal: Box::new(move |account, dir| seal.upgrade().unwrap().seal_window(account, dir)),
        quic_off: None,
        now: Box::new(relay_core::clock::now_ms),
        sleep: Some(Box::new(|_| {})),
        log: Some(Box::new(move |event: &str, fields: &LogFields| {
            sink.lock()
                .unwrap()
                .push((event.to_string(), fields.clone()))
        })),
    }));
    let port = Arc::clone(&windows) as Arc<dyn WindowsPort>;
    f.manager.configure(|h| h.windows = Some(port));
    World { f, windows, events }
}

fn uuid_of(a: &Account) -> &str {
    &a.desktop.as_ref().unwrap().account_uuid
}

impl World {
    fn account(&self, name: &str) -> Account {
        self.f.account(name, None)
    }
    fn vault_login(&self, account_uuid: &str) -> Value {
        let data = read_bytes(&self.f.vault(), &format!("accounts/{account_uuid}.bin"))
            .unwrap()
            .unwrap();
        serde_json::from_str(&helpers::test_unseal(&data)).unwrap()
    }
    fn dir(&self, a: &Account) -> PathBuf {
        self.windows.data_dir(uuid_of(a)).unwrap()
    }
    fn main_token(&self) -> Value {
        read_object(&self.f.root, "config.json").unwrap().unwrap()["oauth:tokenCacheV2"].clone()
    }
}

fn obj(root: &std::path::Path, relative: &str) -> Option<Map<String, Value>> {
    read_object(root, relative).unwrap()
}

#[test]
fn a_window_opens_signed_in_with_the_vaults_sign_in_and_gives_a_renewed_one_back_once_closed() {
    let w = fixture();
    let a = w.account("A");
    w.account("B"); // The main Claude is on B.
    w.windows.set_enabled(true).unwrap();
    assert_eq!(w.windows.open(uuid_of(&a)).unwrap(), WindowOpened::Opened);
    let dir = w.dir(&a);
    assert_eq!(w.f.host.st().launched, vec![(dir.clone(), false)]);
    let config = obj(&dir, "config.json").unwrap();
    assert_eq!(config["lastKnownAccountUuid"], json!(uuid_of(&a)));
    assert_eq!(config["oauth:tokenCacheV2"], json!("encrypted:A"));
    assert_eq!(read_bytes(&dir, "Cookies").unwrap().unwrap(), b"cookie-A");
    assert_eq!(
        w.windows.open_accounts().unwrap(),
        vec![uuid_of(&a).to_string()]
    );
    assert_eq!(w.main_token(), json!("encrypted:B"));
    let mut renewed = config.clone();
    renewed.insert("oauth:tokenCacheV2".into(), json!("encrypted:A-renewed"));
    write_bytes(&dir, "config.json", Some(&json_bytes(&renewed))).unwrap();
    w.windows.close(uuid_of(&a)).unwrap();
    assert_eq!(w.f.host.st().quit_pids.len(), 1);
    assert_eq!(
        w.vault_login(uuid_of(&a))["auth"]["oauth:tokenCacheV2"],
        json!("encrypted:A-renewed")
    );
    assert!(w.windows.open_accounts().unwrap().is_empty());
    assert_eq!(
        w.events
            .lock()
            .unwrap()
            .iter()
            .map(|(e, _)| e.clone())
            .collect::<Vec<_>>(),
        vec!["window-opened", "window-closed"]
    );
}

#[test]
fn a_window_closed_by_hand_gives_its_sign_in_back_on_the_next_look_one_signed_out_changes_nothing()
{
    let w = fixture();
    let a = w.account("A");
    let c = w.account("C");
    w.account("B");
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    w.windows.open(uuid_of(&c)).unwrap();
    write_bytes(
        &w.dir(&a),
        "config.json",
        Some(&json_bytes(
            &json!({ "lastKnownAccountUuid": uuid_of(&a), "oauth:tokenCacheV2": "encrypted:A-2" }),
        )),
    )
    .unwrap();
    write_bytes(&w.dir(&c), "config.json", Some(&json_bytes(&json!({})))).unwrap();
    w.f.host.st().windows.clear();
    assert_eq!(
        w.windows.reconcile().unwrap(),
        vec![uuid_of(&a).to_string()]
    );
    assert_eq!(
        w.vault_login(uuid_of(&a))["auth"]["oauth:tokenCacheV2"],
        json!("encrypted:A-2")
    );
    assert_eq!(
        w.vault_login(uuid_of(&c))["auth"]["oauth:tokenCacheV2"],
        json!("encrypted:C")
    );
    assert!(w.windows.reconcile().unwrap().is_empty());
}

#[test]
fn a_sign_in_that_cannot_be_saved_back_now_is_tried_again_later() {
    let w = fixture();
    let a = w.account("A");
    w.account("B");
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    w.f.host.st().windows.clear();
    // Another Desktop operation holds Desktop while the window's sign-in would be saved.
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let wait = Mutex::new(Some(wait));
    FakeHost::set(
        &w.f.host.unseal_gate,
        Arc::new(move || {
            if let Some(wait) = wait.lock().unwrap().take() {
                let _ = wait.recv();
            }
        }),
    );
    let manager = Arc::clone(&w.f.manager);
    let (account, other) = (uuid_of(&a).to_string(), w.f.base().join("other"));
    let busy = std::thread::spawn(move || manager.seed_window(&account, &other));
    while !w.f.manager.is_busy() {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(w.windows.reconcile().unwrap().is_empty());
    let _ = release.send(());
    busy.join().unwrap().unwrap();
    assert_eq!(
        w.windows.reconcile().unwrap(),
        vec![uuid_of(&a).to_string()]
    );
}

#[test]
fn opening_is_refused_while_off_for_the_main_claudes_own_account_and_brings_an_open_one_forward() {
    let w = fixture();
    let a = w.account("A");
    let b = w.account("B");
    assert_eq!(
        w.windows.open(uuid_of(&a)).unwrap_err(),
        DesktopError::new(WINDOWS_OFF)
    );
    w.windows.set_enabled(true).unwrap();
    assert_eq!(
        w.windows.open(uuid_of(&b)).unwrap_err(),
        DesktopError::new(WINDOW_IS_MAIN)
    );
    assert_eq!(w.windows.open(uuid_of(&a)).unwrap(), WindowOpened::Opened);
    assert_eq!(w.windows.open(uuid_of(&a)).unwrap(), WindowOpened::Shown);
    let st = w.f.host.st();
    assert_eq!(st.launched.len(), 1);
    assert_eq!(st.shown, vec![st.windows[0].pid]);
    drop(st);
    // The choice is kept beside the registry.
    let again = DesktopWindows::new(DesktopWindowsDeps {
        folder: w.f.base().join("Relay").join("claude-windows"),
        host: Arc::clone(&w.f.host) as Arc<dyn DesktopHost>,
        current: Box::new(|| Ok(None)),
        seed: Box::new(|_, _| Ok(())),
        seal: Box::new(|_, _| Ok(false)),
        quic_off: None,
        now: Box::new(relay_core::clock::now_ms),
        sleep: None,
        log: None,
    });
    assert!(again.enabled());
}

#[test]
fn a_window_that_does_not_close_says_so_and_keeps_its_sign_in() {
    let w = fixture();
    let a = w.account("A");
    w.account("B");
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    w.f.host.st().stubborn = true;
    assert_eq!(
        w.windows.close(uuid_of(&a)).unwrap_err(),
        DesktopError::new(WINDOW_DID_NOT_CLOSE)
    );
    assert_eq!(
        w.windows.open_accounts().unwrap(),
        vec![uuid_of(&a).to_string()]
    );
}

#[test]
fn the_main_claude_cannot_switch_to_an_account_its_window_holds_and_never_switches_by_itself_while_one_runs()
 {
    let w = fixture();
    let a = w.account("A");
    let c = w.account("C");
    w.account("B");
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    assert_eq!(
        w.f.manager
            .switch_to(&a.id, Default::default())
            .unwrap_err(),
        DesktopError::new(WINDOW_HOLDS_ACCOUNT)
    );
    assert!(matches!(
        w.f.manager.switch_to(
            &c.id,
            DesktopSwitchOptions {
                automatic: true,
                ..Default::default()
            }
        ),
        Err(DesktopError::SwitchRefused(_))
    ));
    assert_eq!(w.main_token(), json!("encrypted:B"));
    w.f.manager.switch_to(&c.id, Default::default()).unwrap();
    assert_eq!(w.main_token(), json!("encrypted:C"));
    assert_eq!(w.f.manager.snapshot().unwrap().windows, Some(1.0));
}

fn window_record(w: &World, a: &Account, title: &str) -> (String, String) {
    let id = uuid();
    let relative = format!(
        "claude-code-sessions/{}/{}/local_{id}.json",
        uuid_of(a),
        a.desktop.as_ref().unwrap().org_id
    );
    write_bytes(
        &w.dir(a),
        &relative,
        Some(&json_bytes(&json!({
            "sessionId": format!("local_{id}"), "cliSessionId": id,
            "cwd": w.f.base().to_string_lossy(), "title": title, "lastActivityAt": 42,
        }))),
    )
    .unwrap();
    (id, relative)
}

#[test]
fn switching_to_an_account_takes_over_the_conversations_its_closed_window_had() {
    let w = fixture();
    let a = w.account("A");
    w.account("B");
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    let (id, record) = window_record(&w, &a, "From the window");
    let owners: Vec<(String, SessionOwner)> = w.windows.session_owners().into_iter().collect();
    assert_eq!(
        owners,
        vec![(
            id.clone(),
            SessionOwner {
                account_uuid: uuid_of(&a).to_string(),
                until: f64::INFINITY
            }
        )]
    );
    w.windows.close(uuid_of(&a)).unwrap();
    let owners: Vec<(String, SessionOwner)> = w.windows.session_owners().into_iter().collect();
    assert_eq!(
        owners,
        vec![(
            id,
            SessionOwner {
                account_uuid: uuid_of(&a).to_string(),
                until: 42.0 + 10.0 * 60_000.0
            }
        )]
    );
    w.f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(
        obj(&w.f.root, &record).unwrap()["title"],
        json!("From the window")
    );
}

#[test]
fn with_history_transfer_off_the_main_claude_still_takes_over_its_own_accounts_window_conversations()
 {
    let w = fixture();
    let a = w.account("A");
    w.account("B");
    w.f.store
        .update(|s| s.settings.desktop_history_transfer = DesktopHistoryTransfer::Off)
        .unwrap();
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    let (_, record) = window_record(&w, &a, "Own");
    w.windows.close(uuid_of(&a)).unwrap();
    w.f.manager.switch_to(&a.id, Default::default()).unwrap();
    assert_eq!(obj(&w.f.root, &record).unwrap()["title"], json!("Own"));
}

#[test]
fn a_closed_windows_conversations_follow_when_the_main_claude_switches_between_other_accounts() {
    let w = fixture();
    let a = w.account("A");
    let b = w.account("B");
    w.account("C"); // The main Claude is on C.
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    let (id, _) = window_record(&w, &a, "In A's window");
    let carried = format!(
        "claude-code-sessions/{}/{}/local_{id}.json",
        uuid_of(&b),
        b.desktop.as_ref().unwrap().org_id
    );
    w.f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(obj(&w.f.root, &carried), None);
    w.windows.close(uuid_of(&a)).unwrap();
    w.f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        obj(&w.f.root, &carried).unwrap()["title"],
        json!("In A's window")
    );
}

#[test]
fn with_history_transfer_off_another_accounts_window_conversations_stay_there() {
    let w = fixture();
    let a = w.account("A");
    let b = w.account("B");
    w.account("C");
    w.f.store
        .update(|s| s.settings.desktop_history_transfer = DesktopHistoryTransfer::Off)
        .unwrap();
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    let (id, _) = window_record(&w, &a, "A only");
    w.windows.close(uuid_of(&a)).unwrap();
    w.f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        obj(
            &w.f.root,
            &format!(
                "claude-code-sessions/{}/{}/local_{id}.json",
                uuid_of(&b),
                b.desktop.as_ref().unwrap().org_id
            )
        ),
        None
    );
}

#[test]
fn a_look_while_a_window_is_still_starting_does_not_take_it_for_closed() {
    let w = fixture();
    let a = w.account("A");
    w.account("B");
    w.windows.set_enabled(true).unwrap();
    // The listing shows the new app only after a reconcile ran in between.
    let between = Arc::new(Mutex::new(None));
    let (sink, windows) = (Arc::clone(&between), Arc::downgrade(&w.windows));
    FakeHost::set(
        &w.f.host.before_launch_window,
        Arc::new(move || {
            *sink.lock().unwrap() = Some(windows.upgrade().unwrap().reconcile().unwrap());
        }),
    );
    w.windows.open(uuid_of(&a)).unwrap();
    assert_eq!(*between.lock().unwrap(), Some(Vec::<String>::new()));
    write_bytes(
        &w.dir(&a),
        "config.json",
        Some(&json_bytes(&json!({ "lastKnownAccountUuid": uuid_of(&a), "oauth:tokenCacheV2": "encrypted:A-later" }))),
    )
    .unwrap();
    w.windows.close(uuid_of(&a)).unwrap();
    assert_eq!(
        w.vault_login(uuid_of(&a))["auth"]["oauth:tokenCacheV2"],
        json!("encrypted:A-later")
    );
}

#[test]
fn a_window_sealing_back_leaves_an_earlier_desktop_error_to_read() {
    let w = fixture();
    let a = w.account("A");
    w.account("B");
    w.f.manager.report_vault_error("Earlier problem.");
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    w.windows.close(uuid_of(&a)).unwrap();
    assert_eq!(
        w.f.manager.snapshot().unwrap().error.as_deref(),
        Some("Earlier problem.")
    );
}

#[test]
fn a_window_opens_with_its_own_accounts_conversations_the_main_claudes_preferences_and_its_look() {
    let w = fixture();
    let a = w.account("A");
    let b = w.account("B"); // The main Claude is on B.
    let record = |account: &Account, title: &str| {
        let id = uuid();
        let d = account.desktop.as_ref().unwrap();
        (
            format!(
                "claude-code-sessions/{}/{}/local_{id}.json",
                d.account_uuid, d.org_id
            ),
            json_bytes(&json!({
                "sessionId": format!("local_{id}"), "cliSessionId": id,
                "cwd": w.f.base().to_string_lossy(), "title": title, "lastActivityAt": 42,
            })),
        )
    };
    let own = record(&a, "A's own");
    let other = record(&b, "B's");
    write_bytes(&w.f.root, &own.0, Some(&own.1)).unwrap();
    write_bytes(&w.f.root, &other.0, Some(&other.1)).unwrap();
    write_bytes(
        &w.f.root,
        "claude_desktop_config.json",
        Some(&json_bytes(
            &json!({ "mcpServers": { "tool": { "command": "x" } } }),
        )),
    )
    .unwrap();
    let mut main = obj(&w.f.root, "config.json").unwrap();
    main.insert("locale".into(), json!("tr-TR"));
    main.insert("userThemeMode".into(), json!("dark"));
    main.insert("updaterLastSeenVersion".into(), json!("1"));
    write_bytes(&w.f.root, "config.json", Some(&json_bytes(&main))).unwrap();
    w.windows.set_enabled(true).unwrap();
    w.windows.open(uuid_of(&a)).unwrap();
    let dir = w.dir(&a);
    assert_eq!(obj(&dir, &own.0).unwrap()["title"], json!("A's own"));
    assert_eq!(obj(&dir, &other.0), None);
    assert_eq!(
        obj(&dir, "claude_desktop_config.json").unwrap()["mcpServers"],
        json!({ "tool": { "command": "x" } })
    );
    let config = obj(&dir, "config.json").unwrap();
    assert_eq!(config["locale"], json!("tr-TR"));
    assert_eq!(config["userThemeMode"], json!("dark"));
    assert_eq!(config.get("updaterLastSeenVersion"), None);
    assert_eq!(config["lastKnownAccountUuid"], json!(uuid_of(&a)));
}
