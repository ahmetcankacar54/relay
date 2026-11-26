//! Port of tests/auto-switch.test.ts.
//!
//! Skipped: "main passes the fleet and continuation conditions to continuationOwns, and only the
//! sign-in check to pendingAuth" reads `electron/main` source text (`mainSource()`).

#[path = "common/desktop.rs"]
mod desktop_fake;
#[path = "common/fleet_switch.rs"]
mod helpers;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use desktop_fake::{FakeHost, Sealing, test_seal};
use helpers::{FnDesktop, closed_on, random_uuid, signed_in_account, usage_map};
use relay_core::auto_switch::{
    AutoSwitchDependencies, AutoSwitchDesktop, AutoSwitchManager, Decision, auto_switch_decision,
    auto_switch_supported,
};
use relay_core::desktop::{
    CanProceed, DesktopError, DesktopHost, DesktopManager, DesktopResult, DesktopSwitchOptions,
};
use relay_core::desktop_files::{json_bytes, read_object, write_bytes};
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountPlan, AccountPlanning, AccountUsage, AutoSwitchMode, AutoSwitchReason,
    AutoSwitchStatus, DesktopHistoryTransfer, DesktopState, RelaySettings, UsageStatus,
    UsageWindow, default_settings,
};
use relay_core::store::{Store, StoreOptions};
use serde_json::{Value, json};

fn now() -> f64 {
    date_parse("2026-10-13T12:00:00Z")
}
fn reset() -> String {
    iso(now() + 3_600_000.0)
}
fn account(name: &str, group: &str) -> Account {
    signed_in_account(name, group, &iso(now()))
}
fn quota(account: &Account, five_hour: f64, seven_day: f64) -> AccountUsage {
    AccountUsage {
        stale: false,
        checked_at: Some(iso(now())),
        five_hour: Some(UsageWindow::new(five_hour, Some(&reset()))),
        seven_day: Some(UsageWindow::new(seven_day, Some(&reset()))),
        ..AccountUsage::new(account.id.clone(), UsageStatus::Ready)
    }
}

struct Scenario {
    a: Account,
    b: Account,
    settings: RelaySettings,
    desktop: DesktopState,
    usage: JsMap<AccountUsage>,
}

impl Scenario {
    fn new() -> Scenario {
        let (a, b) = (account("A", "personal"), account("B", "personal"));
        let settings = RelaySettings {
            auto_switch_mode: AutoSwitchMode::AfterExit,
            auto_switch_accounts: vec![a.id.clone(), b.id.clone()],
            ..default_settings()
        };
        let desktop = closed_on(&a);
        let usage = usage_map([quota(&a, 100.0, 20.0), quota(&b, 10.0, 20.0)]);
        Scenario {
            a,
            b,
            settings,
            desktop,
            usage,
        }
    }
    fn accounts(&self) -> Vec<Account> {
        vec![self.a.clone(), self.b.clone()]
    }
    fn decide_with(&self, pending_auth: bool, platform_supported: bool) -> Decision {
        auto_switch_decision(
            &self.settings,
            &self.accounts(),
            &self.desktop,
            &self.usage,
            now(),
            pending_auth,
            Some(platform_supported),
            None,
            false,
        )
    }
    fn decide(&self) -> Decision {
        self.decide_with(false, true)
    }
    fn reason(&self) -> AutoSwitchReason {
        self.decide().state.reason
    }
    fn usage_of(&mut self, id: &str) -> &mut AccountUsage {
        self.usage.get_mut(id).unwrap()
    }
    fn usage_a(&mut self) -> &mut AccountUsage {
        let id = self.a.id.clone();
        self.usage_of(&id)
    }
    fn usage_b(&mut self) -> &mut AccountUsage {
        let id = self.b.id.clone();
        self.usage_of(&id)
    }
}

#[test]
fn automatic_preparation_is_disabled_by_default_and_rejects_unsupported_platforms() {
    assert_eq!(default_settings().auto_switch_mode, AutoSwitchMode::Off);
    let mut f = Scenario::new();
    f.settings.auto_switch_mode = AutoSwitchMode::Off;
    assert_eq!(f.reason(), AutoSwitchReason::Disabled);
    f.settings.auto_switch_mode = AutoSwitchMode::AfterExit;
    assert_eq!(
        f.decide_with(false, false).state.reason,
        AutoSwitchReason::UnsupportedPlatform
    );
}

#[test]
fn preparing_on_quit_runs_on_macos_and_linux_not_windows() {
    assert!(auto_switch_supported(Some("darwin")));
    assert!(auto_switch_supported(Some("linux")));
    assert!(!auto_switch_supported(Some("win32")));
    let mut f = Scenario::new();
    f.settings.auto_switch_mode = AutoSwitchMode::AfterExit;
    let on = |platform: &str| {
        auto_switch_decision(
            &f.settings,
            &f.accounts(),
            &f.desktop,
            &f.usage,
            now(),
            false,
            Some(auto_switch_supported(Some(platform))),
            None,
            false,
        )
        .state
    };
    // Linux decides exactly as macOS: the same target, waiting for Claude to quit.
    assert_eq!(on("linux"), on("darwin"));
    assert_eq!(on("linux").reason, AutoSwitchReason::QuotaExhausted);
    assert_eq!(on("win32").reason, AutoSwitchReason::UnsupportedPlatform);
}

#[test]
fn a_real_exhausted_window_selects_a_verified_target_and_waits_while_claude_runs() {
    let mut f = Scenario::new();
    assert_eq!(f.reason(), AutoSwitchReason::QuotaExhausted);
    assert_eq!(f.decide().state.target_id, Some(f.b.id.clone()));
    f.desktop.running = true;
    assert_eq!(f.reason(), AutoSwitchReason::ClaudeRunning);
    assert_eq!(f.decide().state.status, AutoSwitchStatus::Waiting);
    f.usage_a().five_hour.as_mut().unwrap().used_percent = 99.99;
    assert_eq!(f.reason(), AutoSwitchReason::QuotaAvailable);
    f.usage_a().seven_day.as_mut().unwrap().used_percent = 100.0;
    assert_eq!(f.reason(), AutoSwitchReason::ClaudeRunning);
}

#[test]
fn source_quota_must_be_fresh_with_a_valid_future_reset_missing_weekly_data_alone_does_not_hide_5h_exhaustion()
 {
    let mut f = Scenario::new();
    f.usage_a().seven_day = None;
    assert_eq!(f.reason(), AutoSwitchReason::QuotaExhausted);
    for checked_at in [
        iso(now() - 5.0 * 60_000.0 - 1.0),
        iso(now() + 1.0),
        "invalid".to_string(),
    ] {
        f.usage_a().checked_at = Some(checked_at);
        assert_eq!(f.reason(), AutoSwitchReason::UsageNotFresh);
    }
    f.usage_a().checked_at = Some(iso(now()));
    for resets_at in [None, Some("invalid".to_string()), Some(iso(now()))] {
        f.usage_a().five_hour.as_mut().unwrap().resets_at = resets_at;
        assert_eq!(f.reason(), AutoSwitchReason::UsageNotFresh);
    }
}

#[test]
fn target_requires_known_matching_identities_both_windows_below_90_percent_and_no_cooldown() {
    let reject = |change: &dyn Fn(&mut Scenario)| {
        let mut f = Scenario::new();
        change(&mut f);
        assert_eq!(f.reason(), AutoSwitchReason::NoReadyTarget);
    };
    reject(&|f| f.b.auth.as_mut().unwrap().logged_in = false);
    reject(&|f| f.b.auth.as_mut().unwrap().account_uuid = None);
    reject(&|f| f.b.auth.as_mut().unwrap().org_id = Some(random_uuid()));
    reject(&|f| f.usage_b().five_hour = None);
    reject(&|f| f.usage_b().five_hour.as_mut().unwrap().used_percent = 90.0);
    reject(&|f| f.usage_b().seven_day.as_mut().unwrap().used_percent = 100.0);
    reject(&|f| f.usage_b().five_hour.as_mut().unwrap().used_percent = f64::NAN);
    reject(&|f| f.usage_b().checked_at = Some(iso(now() - 300_001.0)));
    reject(&|f| f.usage_b().five_hour.as_mut().unwrap().resets_at = Some("invalid".into()));
    reject(&|f| f.b.cooldown_until = Some(iso(now() + 1.0)));
    reject(&|f| {
        f.b.desktop = f.a.desktop.clone();
        f.b.auth = f.a.auth.clone();
    });
}

#[test]
fn automatic_account_selection_cannot_cross_an_ungranted_history_boundary() {
    let mut f = Scenario::new();
    f.settings.auto_switch_accounts = vec![f.a.id.clone()];
    assert_eq!(f.reason(), AutoSwitchReason::NoReadyTarget);
    f.settings.auto_switch_accounts = vec![f.b.id.clone()];
    assert_eq!(f.reason(), AutoSwitchReason::NotSelected);
    f.settings.auto_switch_accounts = vec![f.a.id.clone(), f.b.id.clone()];
    f.b.group = "work:private".into();
    f.settings.desktop_history_transfer = DesktopHistoryTransfer::SameGroup;
    assert_eq!(f.reason(), AutoSwitchReason::NoReadyTarget);
    f.settings.desktop_history_transfer = DesktopHistoryTransfer::All;
    assert_eq!(f.reason(), AutoSwitchReason::QuotaExhausted);
    f.settings.desktop_history_transfer = DesktopHistoryTransfer::Off;
    assert_eq!(f.reason(), AutoSwitchReason::NoReadyTarget);
    f.settings.desktop_history_transfer = DesktopHistoryTransfer::Selected;
    f.settings.desktop_history_accounts = vec![f.b.id.clone()];
    assert_eq!(f.reason(), AutoSwitchReason::NoReadyTarget);
    f.settings.desktop_history_accounts = vec![f.a.id.clone(), f.b.id.clone()];
    assert_eq!(f.reason(), AutoSwitchReason::QuotaExhausted);
}

#[test]
fn sign_in_recovery_unknown_active_identity_and_overlapping_desktop_operations_block_preparation() {
    let mut f = Scenario::new();
    assert_eq!(
        f.decide_with(true, true).state.reason,
        AutoSwitchReason::BrowserSignIn
    );
    f.desktop.pending_profile_id = Some(f.b.id.clone());
    assert_eq!(f.reason(), AutoSwitchReason::DesktopSignIn);
    f.desktop.pending_profile_id = None;
    f.desktop.recovery_required = true;
    assert_eq!(f.reason(), AutoSwitchReason::DesktopRecovery);
    f.desktop.recovery_required = false;
    f.desktop.busy = true;
    assert_eq!(f.reason(), AutoSwitchReason::DesktopBusy);
    f.desktop.busy = false;
    f.desktop.current_account_uuid = Some(random_uuid());
    assert_eq!(f.reason(), AutoSwitchReason::UnknownActive);
}

type Hook = Arc<dyn Fn() + Send + Sync>;
type SwitchHook = Arc<dyn Fn(&DesktopSwitchOptions) -> DesktopResult<()> + Send + Sync>;

/// What the fake Desktop, the usage reader and the clock of a manager fixture share.
struct Shared {
    a: Account,
    b: Account,
    desktop: Mutex<DesktopState>,
    usage: Mutex<JsMap<AccountUsage>>,
    now: Mutex<f64>,
    snapshots: AtomicUsize,
    calls: AtomicUsize,
    snapshot_hook: Mutex<Option<Hook>>,
    switch_hook: Mutex<Option<SwitchHook>>,
}

struct ManagerFixture {
    _temp: tempfile::TempDir,
    a: Account,
    store: Arc<Store>,
    shared: Arc<Shared>,
    manager: Arc<AutoSwitchManager>,
}

fn can_proceed(options: &DesktopSwitchOptions) -> bool {
    options.can_proceed.as_ref().is_some_and(|c| c())
}

fn manager_fixture() -> ManagerFixture {
    let temp = tempfile::Builder::new()
        .prefix("relay-auto-switch-")
        .tempdir()
        .unwrap();
    let f = Scenario::new();
    let store = Arc::new(Store::open(temp.path(), StoreOptions::default()).unwrap());
    store
        .update(|state| {
            state.accounts = f.accounts();
            state.settings = f.settings.clone();
        })
        .unwrap();
    let shared = Arc::new(Shared {
        a: f.a.clone(),
        b: f.b.clone(),
        desktop: Mutex::new(f.desktop.clone()),
        usage: Mutex::new(f.usage.clone()),
        now: Mutex::new(now()),
        snapshots: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
        snapshot_hook: Mutex::new(None),
        switch_hook: Mutex::new(None),
    });
    let (on_snapshot, on_switch) = (Arc::clone(&shared), Arc::clone(&shared));
    let desktop = FnDesktop::new(
        move || {
            on_snapshot.snapshots.fetch_add(1, Ordering::SeqCst);
            let hook = on_snapshot.snapshot_hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            Ok(on_snapshot.desktop.lock().unwrap().clone())
        },
        move |id, options| {
            let s = &on_switch;
            s.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(id, s.b.id);
            assert!(options.closed_only);
            assert_eq!(
                options.expected_active_profile_id.as_deref(),
                Some(&*s.a.id)
            );
            assert!(can_proceed(&options));
            let hook = s.switch_hook.lock().unwrap().clone();
            match hook {
                Some(hook) => hook(&options),
                None => {
                    *s.desktop.lock().unwrap() = closed_on(&s.b);
                    Ok(())
                }
            }
        },
    );
    let (usage_of, clock) = (Arc::clone(&shared), Arc::clone(&shared));
    let manager = AutoSwitchManager::new(
        Arc::clone(&store),
        desktop,
        Arc::new(move || usage_of.usage.lock().unwrap().clone()),
        AutoSwitchDependencies {
            now: Some(Arc::new(move || *clock.now.lock().unwrap())),
            platform_supported: Some(true),
            ..Default::default()
        },
    );
    ManagerFixture {
        _temp: temp,
        a: f.a,
        store,
        shared,
        manager,
    }
}

impl ManagerFixture {
    fn snapshots(&self) -> usize {
        self.shared.snapshots.load(Ordering::SeqCst)
    }
    fn calls(&self) -> usize {
        self.shared.calls.load(Ordering::SeqCst)
    }
    fn desktop(&self) -> MutexGuard<'_, DesktopState> {
        self.shared.desktop.lock().unwrap()
    }
    fn usage(&self) -> MutexGuard<'_, JsMap<AccountUsage>> {
        self.shared.usage.lock().unwrap()
    }
    fn set_snapshot_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.shared.snapshot_hook.lock().unwrap() = Some(Arc::new(hook));
    }
    fn set_switch_hook(
        &self,
        hook: impl Fn(&DesktopSwitchOptions) -> DesktopResult<()> + Send + Sync + 'static,
    ) {
        *self.shared.switch_hook.lock().unwrap() = Some(Arc::new(hook));
    }
    fn advance(&self, ms: f64) {
        *self.shared.now.lock().unwrap() += ms;
    }
    fn refresh(&self) {
        let at = iso(*self.shared.now.lock().unwrap());
        for usage in self.usage().values_mut() {
            usage.checked_at = Some(at.clone());
        }
    }
    fn settle(&self) {
        self.manager.tick();
        self.advance(10_001.0);
    }
    fn reason(&self) -> AutoSwitchReason {
        self.manager.snapshot().reason
    }
    fn set_mode(&self, mode: AutoSwitchMode) {
        self.store
            .update(|state| state.settings.auto_switch_mode = mode)
            .unwrap();
    }
}

#[test]
fn disabled_mode_does_not_inspect_desktop_or_invoke_switches() {
    let f = manager_fixture();
    f.set_mode(AutoSwitchMode::Off);
    f.manager.tick();
    assert_eq!(f.snapshots(), 0);
    assert_eq!(f.calls(), 0);
    assert_eq!(f.reason(), AutoSwitchReason::Disabled);
}

#[test]
fn re_enabling_automatic_preparation_starts_a_new_exit_grace_period() {
    let f = manager_fixture();
    f.settle();
    f.set_mode(AutoSwitchMode::Off);
    f.manager.tick();
    f.set_mode(AutoSwitchMode::AfterExit);
    f.manager.tick();
    assert_eq!(f.calls(), 0);
    assert_eq!(f.reason(), AutoSwitchReason::ExitSettling);
    f.advance(9_999.0);
    f.manager.tick();
    assert_eq!(f.calls(), 0);
    f.advance(2.0);
    f.manager.tick();
    assert_eq!(f.calls(), 1);
}

#[test]
fn the_same_exhaustion_keeps_its_episode_when_the_reset_time_moves_by_seconds() {
    let mut f = Scenario::new();
    let keys = |f: &Scenario| {
        let mut keys: Vec<String> = f
            .decide()
            .exhausted
            .unwrap()
            .into_iter()
            .map(|episode| episode.key)
            .collect();
        keys.sort();
        keys
    };
    let before = keys(&f);
    assert_eq!(before.len(), 1);
    let shift = |f: &mut Scenario, ms: f64| {
        let usage = f.usage_a();
        for window in [usage.five_hour.as_mut(), usage.seven_day.as_mut()] {
            let window = window.unwrap();
            window.resets_at = Some(iso(date_parse(window.resets_at.as_deref().unwrap()) + ms));
        }
    };
    shift(&mut f, 3_000.0);
    assert_eq!(keys(&f), before);
    // A reset an hour later is another episode.
    shift(&mut f, 3_600_000.0);
    assert_ne!(keys(&f), before);
}

#[test]
fn manager_prepares_after_exit_without_repeating_the_same_exhaustion_episode() {
    let f = manager_fixture();
    f.desktop().running = true;
    f.manager.tick();
    assert_eq!(f.calls(), 0);
    assert_eq!(f.manager.snapshot().status, AutoSwitchStatus::Waiting);
    f.desktop().running = false;
    f.manager.tick();
    assert_eq!(f.calls(), 0);
    assert_eq!(f.reason(), AutoSwitchReason::ExitSettling);
    f.advance(10_001.0);
    f.manager.tick();
    assert_eq!(f.calls(), 1);
    assert_eq!(f.manager.snapshot().status, AutoSwitchStatus::Switched);
    f.manager.tick();
    assert_eq!(f.manager.snapshot().status, AutoSwitchStatus::Switched);
    *f.desktop() = closed_on(&f.a);
    f.manager.tick();
    assert_eq!(f.calls(), 1);
    assert_eq!(f.reason(), AutoSwitchReason::AlreadySwitched);
}

#[test]
fn completed_exhaustion_windows_stay_blocked_after_relay_restarts() {
    let f = manager_fixture();
    f.settle();
    f.manager.tick();
    assert_eq!(f.store.with_state(|s| s.auto_switch_completed.len()), 1);
    let restarted_store = Arc::new(Store::open(f.store.root(), StoreOptions::default()).unwrap());
    let desktop = DesktopState {
        running: f.desktop().running,
        ..closed_on(&f.a)
    };
    let shared = Arc::clone(&f.shared);
    let manager = AutoSwitchManager::new(
        restarted_store,
        FnDesktop::new(
            move || Ok(desktop.clone()),
            |_, _| panic!("completed episode must not dispatch"),
        ),
        Arc::new(move || shared.usage.lock().unwrap().clone()),
        AutoSwitchDependencies {
            now: Some(Arc::new(|| now() + 10_001.0)),
            platform_supported: Some(true),
            ..Default::default()
        },
    );
    manager.tick();
    assert_eq!(manager.snapshot().reason, AutoSwitchReason::AlreadySwitched);
}

/// Makes every later registry write fail: the file says a newer build wrote it.
fn refuse_registry_writes(store: &Store) {
    let mut raw: Value = serde_json::from_slice(&std::fs::read(&store.file).unwrap()).unwrap();
    raw["schema"] = json!(999);
    std::fs::write(&store.file, serde_json::to_vec_pretty(&raw).unwrap()).unwrap();
    assert!(store.update(|_| {}).is_err());
}

#[test]
fn a_registry_save_failure_does_not_falsely_report_or_retry_a_completed_desktop_switch() {
    let f = manager_fixture();
    f.settle();
    refuse_registry_writes(&f.store);
    f.manager.tick();
    assert_eq!(f.manager.snapshot().status, AutoSwitchStatus::Switched);
    assert_eq!(f.reason(), AutoSwitchReason::LedgerUnavailable);
    assert_eq!(f.calls(), 1);
    f.manager.tick();
    assert_eq!(f.calls(), 1);
}

#[test]
fn settings_active_identity_and_quota_changes_during_snapshot_prevent_dispatch() {
    let mutations: [fn(&Arc<Store>, &Shared); 4] = [
        |store, _| {
            store
                .update(|state| state.settings.auto_switch_mode = AutoSwitchMode::Off)
                .unwrap()
        },
        |_, s| s.desktop.lock().unwrap().running = true,
        |_, s| s.desktop.lock().unwrap().active_profile_id = Some(s.b.id.clone()),
        |_, s| {
            s.usage
                .lock()
                .unwrap()
                .get_mut(&s.b.id)
                .unwrap()
                .seven_day
                .as_mut()
                .unwrap()
                .used_percent = 95.0
        },
    ];
    for mutate in mutations {
        let f = manager_fixture();
        f.settle();
        let (store, shared) = (Arc::clone(&f.store), Arc::clone(&f.shared));
        f.set_snapshot_hook(move || {
            if shared.snapshots.load(Ordering::SeqCst) == 3 {
                mutate(&store, &shared);
            }
        });
        f.manager.tick();
        assert_eq!(f.calls(), 0);
    }
}

#[test]
fn policy_changes_after_acquiring_desktop_lock_revoke_per_write_authorization() {
    for disable_mode in [false, true] {
        let f = manager_fixture();
        f.settle();
        let (store, a) = (Arc::clone(&f.store), f.a.id.clone());
        f.set_switch_hook(move |options| {
            store
                .update(|state| {
                    if disable_mode {
                        state.settings.auto_switch_mode = AutoSwitchMode::Off;
                    } else {
                        state.settings.auto_switch_accounts = vec![a.clone()];
                    }
                })
                .unwrap();
            assert!(!can_proceed(options));
            Err(DesktopError::new("fixture authorization revoked"))
        });
        f.manager.tick();
        assert_eq!(f.calls(), 1);
        assert_eq!(
            f.manager.snapshot().status,
            if disable_mode {
                AutoSwitchStatus::Off
            } else {
                AutoSwitchStatus::Blocked
            }
        );
    }
}

#[test]
fn stopping_the_manager_revokes_a_pending_switch_before_writes() {
    let f = manager_fixture();
    f.settle();
    let manager = Arc::downgrade(&f.manager);
    f.set_switch_hook(move |options| {
        manager.upgrade().unwrap().stop();
        assert!(!can_proceed(options));
        Err(DesktopError::new("fixture manager stopped"))
    });
    f.manager.tick();
    assert_eq!(f.calls(), 1);
    f.manager.tick();
    assert_eq!(f.calls(), 1);
}

#[test]
fn overlapping_ticks_cannot_dispatch_overlapping_switches() {
    let f = manager_fixture();
    f.settle();
    let gate = Arc::new(AtomicBool::new(false));
    let held = Arc::clone(&gate);
    f.set_switch_hook(move |_| {
        while !held.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    });
    let manager = Arc::clone(&f.manager);
    let running = std::thread::spawn(move || manager.tick());
    let until = Instant::now() + Duration::from_secs(10);
    while f.calls() == 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(f.calls(), 1);
    f.manager.tick();
    assert_eq!(f.calls(), 1);
    gate.store(true, Ordering::SeqCst);
    running.join().unwrap();
}

#[test]
fn private_format_errors_back_off_and_stop_after_three_attempts_in_an_episode() {
    let f = manager_fixture();
    f.settle();
    f.set_switch_hook(|_| Err(DesktopError::new("fixture invalid saved format")));
    f.manager.tick();
    assert_eq!(f.calls(), 1);
    f.manager.tick();
    assert_eq!(f.calls(), 1);
    assert_eq!(f.reason(), AutoSwitchReason::RetryBackoff);
    for attempts in 2..=3 {
        f.advance(10.0 * 60_000.0);
        f.refresh();
        f.manager.tick();
        assert_eq!(f.calls(), attempts);
    }
    f.advance(10.0 * 60_000.0);
    f.refresh();
    f.manager.tick();
    assert_eq!(f.calls(), 3);
    assert_eq!(f.reason(), AutoSwitchReason::SwitchFailed);
    assert_eq!(f.manager.snapshot().retry_at, None);
}

struct ClosedDesktopFixture {
    _temp: tempfile::TempDir,
    a: Account,
    b: Account,
    root: PathBuf,
    store: Arc<Store>,
    host: Arc<FakeHost>,
    manager: Arc<DesktopManager>,
}

fn closed_desktop_fixture() -> ClosedDesktopFixture {
    let temp = tempfile::Builder::new()
        .prefix("relay-closed-desktop-")
        .tempdir()
        .unwrap();
    let base = relay_core::fs_util::real_path(temp.path()).unwrap();
    let root = base.join("Claude");
    let store = Arc::new(Store::open(base.join("Relay"), StoreOptions::default()).unwrap());
    std::fs::create_dir(&root).unwrap();
    let (a, b) = (account("A", "personal"), account("B", "personal"));
    store
        .update(|state| state.accounts = vec![a.clone(), b.clone()])
        .unwrap();
    for account in [&a, &b] {
        let desktop = account.desktop.as_ref().unwrap();
        std::fs::create_dir_all(
            root.join("claude-code-sessions")
                .join(&desktop.account_uuid)
                .join(&desktop.org_id),
        )
        .unwrap();
    }
    let a_uuid = &a.desktop.as_ref().unwrap().account_uuid;
    write_bytes(
        &root,
        "config.json",
        Some(&json_bytes(&json!({
            "lastKnownAccountUuid": a_uuid,
            "oauth:tokenCacheV2": "fixture-A",
            "preference": "keep",
        }))),
    )
    .unwrap();
    write_bytes(&root, "Cookies", Some(b"fixture-cookie-A")).unwrap();
    let host = Arc::new(FakeHost::new(Sealing::Test));
    {
        let mut st = host.st();
        st.fail_quit = Some("must not quit".into());
        // Swept at startup: never the real temp folder.
        st.scratch = Some(base.join("tmp"));
    }
    let manager = DesktopManager::new(
        &root,
        Arc::clone(&store),
        Arc::clone(&host) as Arc<dyn DesktopHost>,
        Some(base.join(".claude")),
        None,
    );
    manager.initialize().unwrap();
    let b_uuid = &b.desktop.as_ref().unwrap().account_uuid;
    use base64::Engine;
    write_bytes(
        &store.root().join("desktop-vault"),
        &format!("accounts/{b_uuid}.bin"),
        Some(&test_seal(
            &json!({
                "accountUuid": b_uuid,
                "auth": {
                    "lastKnownAccountUuid": b_uuid,
                    "oauth:tokenCacheV2": "fixture-B",
                },
                "cookies": {
                    "Cookies": base64::engine::general_purpose::STANDARD.encode("fixture-cookie-B"),
                },
            })
            .to_string(),
        )),
    )
    .unwrap();
    ClosedDesktopFixture {
        _temp: temp,
        a,
        b,
        root,
        store,
        host,
        manager,
    }
}

impl ClosedDesktopFixture {
    fn set_running(&self, value: bool) {
        self.host.st().running = value;
    }
    fn starts(&self) -> u32 {
        self.host.st().starts
    }
    fn quits(&self) -> u32 {
        self.host.st().quits
    }
    fn config_uuid(&self) -> Value {
        read_object(&self.root, "config.json").unwrap().unwrap()["lastKnownAccountUuid"].clone()
    }
    fn cookies(&self) -> String {
        std::fs::read_to_string(self.root.join("Cookies")).unwrap()
    }
    fn uuid_of(account: &Account) -> Value {
        json!(account.desktop.as_ref().unwrap().account_uuid)
    }
    fn closed_only(&self, expected: &str, can_proceed: CanProceed) -> DesktopSwitchOptions {
        DesktopSwitchOptions {
            closed_only: true,
            expected_active_profile_id: Some(expected.into()),
            can_proceed: Some(can_proceed),
            ..Default::default()
        }
    }
}

#[test]
fn closed_only_desktop_preparation_switches_fixture_files_without_quitting_or_launching() {
    let f = closed_desktop_fixture();
    f.manager
        .switch_to(&f.b.id, f.closed_only(&f.a.id, Arc::new(|| true)))
        .unwrap();
    assert_eq!(f.config_uuid(), ClosedDesktopFixture::uuid_of(&f.b));
    assert_eq!(f.cookies(), "fixture-cookie-B");
    assert_eq!(f.starts(), 0);
    assert_eq!(f.quits(), 0);
}

#[test]
fn closed_only_desktop_rejects_running_app_wrong_active_profile_and_revoked_authorization() {
    for mode in ["running", "wrong-profile", "revoked"] {
        let f = closed_desktop_fixture();
        if mode == "running" {
            f.set_running(true);
        }
        let expected = if mode == "wrong-profile" {
            random_uuid()
        } else {
            f.a.id.clone()
        };
        assert!(
            f.manager
                .switch_to(
                    &f.b.id,
                    f.closed_only(&expected, Arc::new(move || mode != "revoked"))
                )
                .is_err(),
            "{mode}"
        );
        assert_eq!(f.config_uuid(), ClosedDesktopFixture::uuid_of(&f.a));
        assert_eq!(f.cookies(), "fixture-cookie-A");
        assert_eq!(f.starts(), 0);
        assert_eq!(f.quits(), 0);
    }
}

#[test]
fn an_app_starting_before_apply_prevents_automatic_auth_and_history_writes() {
    let f = closed_desktop_fixture();
    let checks = Arc::new(AtomicUsize::new(0));
    let host = Arc::clone(&f.host);
    assert!(
        f.manager
            .switch_to(
                &f.b.id,
                f.closed_only(
                    &f.a.id,
                    Arc::new(move || {
                        if checks.fetch_add(1, Ordering::SeqCst) + 1 == 3 {
                            host.st().running = true;
                        }
                        true
                    })
                )
            )
            .is_err()
    );
    assert_eq!(f.config_uuid(), ClosedDesktopFixture::uuid_of(&f.a));
    assert_eq!(f.cookies(), "fixture-cookie-A");
    assert_eq!(f.starts(), 0);
    assert_eq!(f.quits(), 0);
}

fn scope(kind: &str, account: &Account, file: &str) -> String {
    let desktop = account.desktop.as_ref().unwrap();
    format!("{kind}/{}/{}/{file}", desktop.account_uuid, desktop.org_id)
}

#[test]
fn history_grant_changes_after_planning_revoke_every_source_in_the_automatic_transaction() {
    for change in [
        "remove-source",
        "disable-history",
        "rebind-source",
        "change-source-group",
    ] {
        let f = closed_desktop_fixture();
        let c = account("C", "work:third-source");
        let (a, b, c_id) = (f.a.id.clone(), f.b.id.clone(), c.id.clone());
        f.store
            .update(|state| {
                state.accounts.push(c.clone());
                state.settings = RelaySettings {
                    auto_switch_mode: AutoSwitchMode::AfterExit,
                    auto_switch_accounts: vec![a.clone(), b.clone()],
                    desktop_history_transfer: DesktopHistoryTransfer::Selected,
                    desktop_history_accounts: vec![a.clone(), b.clone(), c_id.clone()],
                    ..default_settings()
                };
            })
            .unwrap();
        let session_id = random_uuid();
        let session_file = format!("local_{session_id}.json");
        let source_path = scope("claude-code-sessions", &c, &session_file);
        let target_path = scope("claude-code-sessions", &f.b, &session_file);
        write_bytes(
            &f.root,
            &source_path,
            Some(&json_bytes(&json!({
                "sessionId": format!("local_{session_id}"),
                "cliSessionId": session_id,
                "cwd": f.root.to_string_lossy(),
                "title": "Third-account private fixture",
                "lastActivityAt": now(),
            }))),
        )
        .unwrap();
        let usage = usage_map([quota(&f.a, 100.0, 20.0), quota(&f.b, 10.0, 20.0)]);
        let clock = Arc::new(Mutex::new(now()));
        let revoked = Arc::new(AtomicBool::new(false));
        {
            let (revoked, store, target_path) = (
                Arc::clone(&revoked),
                Arc::clone(&f.store),
                target_path.clone(),
            );
            let (a, b, c_id) = (a.clone(), b.clone(), c_id.clone());
            FakeHost::set(
                &f.host.seal_hook,
                Arc::new(move |value: &str| {
                    let data: Value = serde_json::from_str(value).unwrap_or_default();
                    let files = data.get("files").filter(|files| !files.is_null());
                    if let Some(files) = files
                        && !revoked.load(Ordering::SeqCst)
                    {
                        // The encrypted backup is prepared after historyPlan has included C.
                        assert!(files.get(&target_path).is_some());
                        revoked.store(true, Ordering::SeqCst);
                        store
                            .update(|state| match change {
                                "remove-source" => {
                                    state.settings.desktop_history_accounts =
                                        vec![a.clone(), b.clone()]
                                }
                                "disable-history" => {
                                    state.settings.desktop_history_transfer =
                                        DesktopHistoryTransfer::Off
                                }
                                "rebind-source" => {
                                    let c = state.accounts.iter_mut().find(|x| x.id == c_id);
                                    c.unwrap().desktop.as_mut().unwrap().org_id = random_uuid();
                                }
                                _ => {
                                    let c = state.accounts.iter_mut().find(|x| x.id == c_id);
                                    c.unwrap().group = "work:changed".into();
                                }
                            })
                            .unwrap();
                    }
                    Ok(())
                }),
            );
        }
        let tick_clock = Arc::clone(&clock);
        let manager = AutoSwitchManager::new(
            Arc::clone(&f.store),
            Arc::clone(&f.manager) as Arc<dyn AutoSwitchDesktop>,
            Arc::new(move || usage.clone()),
            AutoSwitchDependencies {
                now: Some(Arc::new(move || *tick_clock.lock().unwrap())),
                platform_supported: Some(true),
                ..Default::default()
            },
        );
        manager.tick();
        *clock.lock().unwrap() += 10_001.0;
        manager.tick();
        assert!(revoked.load(Ordering::SeqCst), "{change}");
        assert_eq!(manager.snapshot().status, AutoSwitchStatus::Blocked);
        assert_eq!(f.config_uuid(), ClosedDesktopFixture::uuid_of(&f.a));
        assert_eq!(read_object(&f.root, &target_path).unwrap(), None);
        assert_eq!(
            read_object(&f.root, &source_path).unwrap().unwrap()["title"],
            "Third-account private fixture"
        );
        assert!(!f.manager.snapshot().unwrap().recovery_required);
        assert_eq!(f.starts(), 0);
        assert_eq!(f.quits(), 0);
    }
}

#[test]
fn the_target_is_the_soonest_reset_that_holds_half_an_hour_at_the_tempo() {
    let mut f = Scenario::new();
    let mut c = account("C", "personal");
    f.b.planning = Some(AccountPlanning {
        plan: AccountPlan::Max5,
        capacity_weight: 5.0,
    });
    c.planning = Some(AccountPlanning {
        plan: AccountPlan::Pro,
        capacity_weight: 1.0,
    });
    f.settings.auto_switch_accounts.push(c.id.clone());
    // B: 80% of a Max 5× window (400 Pro units) until its reset in an hour.
    // C: 50 Pro units until its reset in 30 minutes; the old lowest-use rule
    // picked B.
    f.usage.insert(f.b.id.clone(), quota(&f.b, 20.0, 20.0));
    f.usage.insert(
        c.id.clone(),
        AccountUsage {
            five_hour: Some(UsageWindow::new(50.0, Some(&iso(now() + 30.0 * 60_000.0)))),
            ..quota(&c, 50.0, 20.0)
        },
    );
    let accounts = vec![f.a.clone(), f.b.clone(), c.clone()];
    let decide = |rate: Option<f64>| {
        auto_switch_decision(
            &f.settings,
            &accounts,
            &f.desktop,
            &f.usage,
            now(),
            false,
            Some(true),
            rate,
            false,
        )
        .state
        .target_id
    };
    assert_eq!(decide(None), Some(c.id.clone()));
    // 50 Pro units cover half an hour at 60/h, not at 200/h.
    assert_eq!(decide(Some(60.0)), Some(c.id.clone()));
    assert_eq!(decide(Some(200.0)), Some(f.b.id.clone()));
    // The manager reads the rate from its dependency on every decision.
    let temp = tempfile::Builder::new()
        .prefix("relay-auto-switch-")
        .tempdir()
        .unwrap();
    let store = Arc::new(Store::open(temp.path(), StoreOptions::default()).unwrap());
    store
        .update(|state| {
            state.accounts = accounts.clone();
            state.settings = f.settings.clone();
        })
        .unwrap();
    f.desktop.running = true;
    let rate = Arc::new(Mutex::new(None::<f64>));
    let (desktop, usage, tempo) = (f.desktop.clone(), f.usage.clone(), Arc::clone(&rate));
    let manager = AutoSwitchManager::new(
        store,
        FnDesktop::new(
            move || Ok(desktop.clone()),
            |_, _| panic!("Claude is still running"),
        ),
        Arc::new(move || usage.clone()),
        AutoSwitchDependencies {
            now: Some(Arc::new(now)),
            platform_supported: Some(true),
            tempo_rate: Some(Arc::new(move || *tempo.lock().unwrap())),
            ..Default::default()
        },
    );
    manager.tick();
    assert_eq!(manager.snapshot().reason, AutoSwitchReason::ClaudeRunning);
    assert_eq!(manager.snapshot().target_id, Some(c.id.clone()));
    *rate.lock().unwrap() = Some(200.0);
    manager.tick();
    assert_eq!(manager.snapshot().target_id, Some(f.b.id.clone()));
}

#[test]
fn a_continuation_that_owns_the_stopped_conversations_holds_preparation_with_its_own_reason_and_a_browser_sign_in_alone_still_says_browser_sign_in()
 {
    let mut f = Scenario::new();
    let decide = |f: &Scenario, pending_auth: bool, continuation_owns: bool| {
        auto_switch_decision(
            &f.settings,
            &f.accounts(),
            &f.desktop,
            &f.usage,
            now(),
            pending_auth,
            Some(true),
            None,
            continuation_owns,
        )
        .state
    };
    assert_eq!(
        decide(&f, false, false).reason,
        AutoSwitchReason::QuotaExhausted
    );
    let held = decide(&f, false, true);
    assert_eq!(held.status, AutoSwitchStatus::Blocked);
    assert_eq!(held.reason, AutoSwitchReason::ContinuationActive);
    let sign_in = decide(&f, true, false);
    assert_eq!(sign_in.status, AutoSwitchStatus::Blocked);
    assert_eq!(sign_in.reason, AutoSwitchReason::BrowserSignIn);
    // Continuation is checked right before the browser sign-in.
    assert_eq!(
        decide(&f, true, true).reason,
        AutoSwitchReason::ContinuationActive
    );
    // Desktop's own sign-in is checked before both.
    f.desktop.pending_profile_id = Some(f.b.id.clone());
    assert_eq!(
        decide(&f, true, true).reason,
        AutoSwitchReason::DesktopSignIn
    );
}

#[test]
fn the_manager_reads_continuation_owns_and_pending_auth_separately_on_every_decision_and_never_switches_while_either_holds()
 {
    let f = manager_fixture();
    let owns = Arc::new(AtomicBool::new(true));
    let auth = Arc::new(AtomicBool::new(false));
    let switches = Arc::new(AtomicUsize::new(0));
    let (shared, counted) = (Arc::clone(&f.shared), Arc::clone(&switches));
    let (usage_of, owns_now, auth_now) =
        (Arc::clone(&f.shared), Arc::clone(&owns), Arc::clone(&auth));
    let manager = AutoSwitchManager::new(
        Arc::clone(&f.store),
        FnDesktop::new(
            move || Ok(shared.desktop.lock().unwrap().clone()),
            move |_, _| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        ),
        Arc::new(move || usage_of.usage.lock().unwrap().clone()),
        AutoSwitchDependencies {
            now: Some(Arc::new(|| now() + 60_000.0)),
            platform_supported: Some(true),
            continuation_owns: Some(Arc::new(move || owns_now.load(Ordering::SeqCst))),
            pending_auth: Some(Arc::new(move || auth_now.load(Ordering::SeqCst))),
            ..Default::default()
        },
    );
    manager.tick();
    assert_eq!(
        manager.snapshot().reason,
        AutoSwitchReason::ContinuationActive
    );
    owns.store(false, Ordering::SeqCst);
    auth.store(true, Ordering::SeqCst);
    manager.tick();
    assert_eq!(manager.snapshot().reason, AutoSwitchReason::BrowserSignIn);
    auth.store(false, Ordering::SeqCst);
    manager.tick();
    assert_eq!(manager.snapshot().reason, AutoSwitchReason::ExitSettling);
    assert_eq!(switches.load(Ordering::SeqCst), 0);
}

#[test]
fn automatic_preparation_waits_while_a_separate_claude_window_runs() {
    let mut f = Scenario::new();
    f.desktop.windows = Some(1.0);
    assert_eq!(
        (f.decide().state.status, f.decide().state.reason),
        (AutoSwitchStatus::Blocked, AutoSwitchReason::SeparateWindow)
    );
    f.desktop.windows = None;
    assert_ne!(f.reason(), AutoSwitchReason::SeparateWindow);
}
