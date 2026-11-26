//! Port of the electron/core/global-shortcuts cases of tests/global-shortcuts.test.ts. The
//! `shared/shortcuts` cases are in shared_global_shortcuts.rs, the store schema case in
//! store_settings.rs; the main wiring (source text) and Settings UI cases are not ported.

#[path = "common/shared_misc.rs"]
mod helpers;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use helpers::{planning_account, planning_usage};
use relay_core::global_shortcuts::{
    GlobalShortcuts, ShortcutCallback, ShortcutHandlers, ShortcutHost, ShortcutLog,
    ShortcutSwitchInput, shortcut_switch_target,
};
use relay_core::shared::shortcuts::default_shortcut;
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountDesktop, AccountUsage, ShortcutAction, ShortcutSettings, ShortcutState,
    ShortcutStates, UsageWindow, default_settings,
};

fn open_default() -> &'static str {
    default_shortcut(ShortcutAction::OpenPanel)
}

/// The shell's global shortcut registry, with keys `held` by another app.
#[derive(Default)]
struct FakeHost {
    /// In registration order.
    registered: Mutex<Vec<(String, Arc<ShortcutCallback>)>>,
    held: Mutex<HashSet<String>>,
    calls: Mutex<Vec<String>>,
}

impl FakeHost {
    fn new(held: &[&str]) -> Arc<Self> {
        let host = Self::default();
        host.held
            .lock()
            .unwrap()
            .extend(held.iter().map(|k| k.to_string()));
        Arc::new(host)
    }

    fn keys(&self) -> Vec<String> {
        self.registered
            .lock()
            .unwrap()
            .iter()
            .map(|(k, _)| k.clone())
            .collect()
    }

    fn press(&self, accelerator: &str) {
        let callback = self
            .registered
            .lock()
            .unwrap()
            .iter()
            .find(|(k, _)| k == accelerator)
            .map(|(_, c)| Arc::clone(c))
            .expect("registered");
        callback();
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl ShortcutHost for FakeHost {
    fn register(&self, accelerator: &str, callback: ShortcutCallback) -> Result<bool, String> {
        self.calls.lock().unwrap().push(format!("+{accelerator}"));
        let mut registered = self.registered.lock().unwrap();
        if self.held.lock().unwrap().contains(accelerator)
            || registered.iter().any(|(k, _)| k == accelerator)
        {
            return Ok(false);
        }
        registered.push((accelerator.to_owned(), Arc::new(callback)));
        Ok(true)
    }

    fn unregister(&self, accelerator: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("-{accelerator}"));
        self.registered
            .lock()
            .unwrap()
            .retain(|(k, _)| k != accelerator);
        Ok(())
    }
}

/// A host on which every key fails to register, as Electron throws for one a platform lacks.
struct ThrowingHost;

impl ShortcutHost for ThrowingHost {
    fn register(&self, _: &str, _: ShortcutCallback) -> Result<bool, String> {
        Err("conversion failed".into())
    }
    fn unregister(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

type Ran = Arc<Mutex<Vec<&'static str>>>;

fn recording(ran: &Ran) -> ShortcutHandlers {
    let open = Arc::clone(ran);
    let switch = Arc::clone(ran);
    ShortcutHandlers {
        open_panel: Box::new(move || {
            open.lock().unwrap().push("open");
            Ok(())
        }),
        switch_to_suggested: Box::new(move || {
            switch.lock().unwrap().push("switch");
            Ok(())
        }),
    }
}

fn noop() -> ShortcutHandlers {
    ShortcutHandlers {
        open_panel: Box::new(|| Ok(())),
        switch_to_suggested: Box::new(|| Ok(())),
    }
}

fn logger(logged: &Arc<Mutex<Vec<String>>>) -> Option<ShortcutLog> {
    let logged = Arc::clone(logged);
    Some(Arc::new(move |event, _| {
        logged.lock().unwrap().push(event.to_owned())
    }))
}

fn states(open_panel: ShortcutState, switch_to_suggested: ShortcutState) -> ShortcutStates {
    ShortcutStates {
        open_panel,
        switch_to_suggested,
    }
}

fn choice(open_panel: Option<&str>, switch_to_suggested: Option<&str>) -> ShortcutSettings {
    ShortcutSettings {
        open_panel: open_panel.map(str::to_owned),
        switch_to_suggested: switch_to_suggested.map(str::to_owned),
    }
}

use ShortcutState::{Off, On, Taken};

#[test]
fn shortcuts_register_at_start_follow_every_change_and_let_go_at_quit() {
    let host = FakeHost::new(&[]);
    let ran: Ran = Arc::default();
    let mut shortcuts = GlobalShortcuts::new(host.clone(), recording(&ran), None);
    assert_eq!(shortcuts.apply(None), states(On, Off));
    assert_eq!(host.keys(), [open_default()]);
    host.press(open_default());
    assert_eq!(*ran.lock().unwrap(), ["open"]);
    // Applying the same choice again touches nothing.
    host.calls.lock().unwrap().clear();
    shortcuts.apply(Some(&choice(None, None)));
    assert!(host.calls().is_empty());
    // A new key replaces the old; switching turned on.
    shortcuts.apply(Some(&choice(Some("Control+Alt+K"), Some("Control+Alt+J"))));
    let mut keys = host.keys();
    keys.sort();
    assert_eq!(keys, ["Control+Alt+J", "Control+Alt+K"]);
    assert!(host.calls().contains(&format!("-{}", open_default())));
    host.press("Control+Alt+J");
    assert_eq!(*ran.lock().unwrap(), ["open", "switch"]);
    // Two actions trade keys in one change.
    assert_eq!(
        shortcuts.apply(Some(&choice(Some("Control+Alt+J"), Some("Control+Alt+K")))),
        states(On, On)
    );
    host.press("Control+Alt+J");
    assert_eq!(*ran.lock().unwrap(), ["open", "switch", "open"]);
    // Cleared: off and unregistered.
    assert_eq!(
        shortcuts.apply(Some(&choice(Some(""), Some("Control+Alt+K")))),
        states(Off, On)
    );
    assert_eq!(host.keys(), ["Control+Alt+K"]);
    shortcuts.dispose();
    assert!(host.keys().is_empty());
    assert_eq!(shortcuts.status(), states(Off, Off));
}

#[test]
fn a_key_another_app_holds_is_reported_not_thrown_and_retried_at_the_next_change() {
    let host = FakeHost::new(&[open_default()]);
    let logged: Arc<Mutex<Vec<String>>> = Arc::default();
    let mut shortcuts = GlobalShortcuts::new(host.clone(), noop(), logger(&logged));
    assert_eq!(shortcuts.apply(None), states(Taken, Off));
    assert!(host.keys().is_empty());
    // The same key for both actions: the second one is taken.
    assert_eq!(
        shortcuts.apply(Some(&choice(Some("Alt+F1"), Some("Alt+F1")))),
        states(On, Taken)
    );
    // The other app let go: the next apply takes it.
    host.held.lock().unwrap().clear();
    assert_eq!(shortcuts.apply(Some(&choice(None, None))), states(On, Off));
    // The shell refuses a key this platform cannot register: unavailable, logged.
    let mut throwing = GlobalShortcuts::new(Arc::new(ThrowingHost), noop(), logger(&logged));
    assert_eq!(
        throwing.apply(Some(&choice(None, None))),
        states(Taken, Off)
    );
    assert_eq!(*logged.lock().unwrap(), ["shortcut-register-failed"]);
    // An action that fails is logged, never passed to the shell.
    let failing = FakeHost::new(&[]);
    GlobalShortcuts::new(
        failing.clone(),
        ShortcutHandlers {
            open_panel: Box::new(|| Err("no window".into())),
            switch_to_suggested: Box::new(|| Ok(())),
        },
        logger(&logged),
    )
    .apply(Some(&choice(None, None)));
    failing.press(open_default());
    assert_eq!(
        *logged.lock().unwrap(),
        ["shortcut-register-failed", "shortcut-failed"]
    );
}

fn now() -> f64 {
    date_parse("2026-10-13T06:00:00Z")
}

/// A Claude account saved for the Claude app, with its limits read now.
fn linked(id: &str, five_hour: f64) -> (Account, AccountUsage) {
    let mut account = planning_account(id, "max5");
    let desktop: AccountDesktop = serde_json::from_value(serde_json::json!({
        "accountUuid": id, "orgId": format!("org-{id}"), "savedAt": iso(now()),
    }))
    .unwrap();
    account.desktop = Some(desktop);
    let mut usage = planning_usage(&account, now());
    usage.five_hour = Some(window(five_hour, None));
    (account, usage)
}

fn window(used_percent: f64, resets_at: Option<String>) -> UsageWindow {
    let mut value = serde_json::json!({ "usedPercent": used_percent });
    if let Some(resets_at) = resets_at {
        value["resetsAt"] = resets_at.into();
    }
    serde_json::from_value(value).unwrap()
}

fn usage_of(entries: &[&AccountUsage]) -> JsMap<AccountUsage> {
    let mut map = JsMap::new();
    for usage in entries {
        map.insert(usage.account_id.clone(), (*usage).clone());
    }
    map
}

fn target(
    accounts: &[Account],
    usage: &JsMap<AccountUsage>,
    in_windows: &HashSet<String>,
) -> Option<String> {
    let settings = default_settings();
    shortcut_switch_target(&ShortcutSwitchInput {
        active_id: Some("vertex"),
        accounts,
        usage,
        settings: &settings,
        now: now(),
        rate: None,
        in_windows,
    })
    .map(|a| a.id.clone())
}

#[test]
fn switch_to_suggested_offers_the_panel_s_suggested_account_never_the_active_or_a_separate_window_s()
 {
    let (vertex, vertex_usage) = linked("vertex", 95.0);
    let (alto, alto_usage) = linked("alto", 10.0);
    let (birch, birch_usage) = linked("birch", 60.0);
    let accounts = vec![vertex.clone(), alto.clone(), birch.clone()];
    let usage = usage_of(&[&vertex_usage, &alto_usage, &birch_usage]);
    let none = HashSet::new();
    // Vertex is past the warning: the suggestion is the roomiest other account.
    assert_eq!(target(&accounts, &usage, &none).as_deref(), Some("alto"));
    // Alto is open in its own Claude window: the next one.
    let alto_open: HashSet<String> = ["alto".to_owned()].into();
    assert_eq!(
        target(&accounts, &usage, &alto_open).as_deref(),
        Some("birch")
    );
    // Without a warning, the panel's badge: the top of its ranking.
    let mut calm = vertex_usage.clone();
    calm.five_hour = Some(window(5.0, None));
    assert_eq!(
        target(
            &accounts,
            &usage_of(&[&calm, &alto_usage, &birch_usage]),
            &none
        )
        .as_deref(),
        Some("alto")
    );
    // An account whose Claude app and usage sign-ins disagree, or not saved for the Claude app, is skipped.
    let mut mismatched = alto.clone();
    mismatched.auth.as_mut().unwrap().account_uuid = Some("someone-else".into());
    let mut unlinked = birch.clone();
    unlinked.desktop = None;
    assert_eq!(
        target(&[vertex.clone(), mismatched, unlinked], &usage, &none),
        None
    );
    // Nothing to offer when every other account is full.
    let full = |usage: &AccountUsage| {
        let mut usage = usage.clone();
        usage.five_hour = Some(window(100.0, Some(iso(now() + 3_600_000.0))));
        usage
    };
    assert_eq!(
        target(
            &accounts,
            &usage_of(&[&vertex_usage, &full(&alto_usage), &full(&birch_usage)]),
            &none
        ),
        None
    );
}

#[test]
fn while_settings_records_the_keys_are_let_go_a_change_meanwhile_is_registered_on_resume() {
    let host = FakeHost::new(&[]);
    let mut shortcuts = GlobalShortcuts::new(host.clone(), noop(), None);
    shortcuts.apply(Some(&choice(None, None)));
    shortcuts.pause();
    // The registered combination now reaches the recorder instead of Relay.
    assert!(host.keys().is_empty());
    // The states stay as they were, so Settings does not flash "taken" while recording.
    assert_eq!(shortcuts.status(), states(On, Off));
    shortcuts.pause();
    // The recorded key is saved while paused: kept, not registered yet.
    shortcuts.apply(Some(&choice(Some("Control+Alt+K"), None)));
    assert!(host.keys().is_empty());
    assert_eq!(shortcuts.resume(), states(On, Off));
    assert_eq!(host.keys(), ["Control+Alt+K"]);
    // Resuming twice, or without a pause, changes nothing.
    host.calls.lock().unwrap().clear();
    shortcuts.resume();
    assert!(host.calls().is_empty());
    // Quitting while paused registers nothing again.
    shortcuts.pause();
    shortcuts.dispose();
    shortcuts.resume();
    assert!(host.keys().is_empty());
}
