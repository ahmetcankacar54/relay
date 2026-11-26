//! Port of `electron/core/global-shortcuts.ts`.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::shared::account_state::desktop_cli_mismatch;
use crate::shared::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, rank_continuation_targets,
};
use crate::shared::quota_windows::{quota_windows, spent_model_windows};
use crate::shared::shortcuts::{SHORTCUT_ACTIONS, normalize_accelerator, shortcut_for};
use crate::shared::types::js::JsMap;
use crate::shared::types::{
    Account, AccountProvider, AccountUsage, RelaySettings, ShortcutAction, ShortcutSettings,
    ShortcutState, ShortcutStates,
};
use crate::shared::usage::{fresh_usage, suggested_account};

/// What a registered key runs when pressed; the shell calls it on its own thread.
pub type ShortcutCallback = Box<dyn Fn() + Send + Sync>;

/// The part of the shell's global shortcut registry Relay uses (Electron's `globalShortcut`,
/// Tauri's global-shortcut plugin); tests pass a fake.
pub trait ShortcutHost: Send + Sync {
    /// `Ok(false)` when another app holds the keys; `Err` when this platform cannot register
    /// them at all.
    fn register(&self, accelerator: &str, callback: ShortcutCallback) -> Result<bool, String>;
    fn unregister(&self, accelerator: &str) -> Result<(), String>;
}

/// `ShortcutStatus`: each action's state.
pub type ShortcutStatus = ShortcutStates;

/// What each action does; an `Err` is logged, never passed to the shell.
pub struct ShortcutHandlers {
    pub open_panel: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
    pub switch_to_suggested: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
}

impl ShortcutHandlers {
    fn run(&self, action: ShortcutAction) -> Result<(), String> {
        match action {
            ShortcutAction::OpenPanel => (self.open_panel)(),
            ShortcutAction::SwitchToSuggested => (self.switch_to_suggested)(),
        }
    }
}

/// An event and its fields, as main's log takes them.
pub type ShortcutLog = Arc<dyn Fn(&str, &Map<String, Value>) + Send + Sync>;

fn off() -> ShortcutStatus {
    ShortcutStates {
        open_panel: ShortcutState::Off,
        switch_to_suggested: ShortcutState::Off,
    }
}

fn set_state(states: &mut ShortcutStatus, action: ShortcutAction, state: ShortcutState) {
    match action {
        ShortcutAction::OpenPanel => states.open_panel = state,
        ShortcutAction::SwitchToSuggested => states.switch_to_suggested = state,
    }
}

fn log_fields(action: ShortcutAction, error: &str) -> Map<String, Value> {
    match json!({ "action": action.as_str(), "error": error }) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Relay's global shortcuts: registered from the settings at start and after every change, so
/// a key another app holds is reported ("taken") next to its field instead of failing. Applying
/// again retries a taken key, which may have been freed since. While Settings records a new key
/// they are paused, so pressing the key already registered is recorded instead of acting.
pub struct GlobalShortcuts {
    host: Arc<dyn ShortcutHost>,
    handlers: Arc<ShortcutHandlers>,
    log: Option<ShortcutLog>,
    /// In registration order, as the TS Map.
    registered: Vec<(ShortcutAction, String)>,
    states: ShortcutStatus,
    choice: Option<ShortcutSettings>,
    paused: bool,
}

impl GlobalShortcuts {
    pub fn new(
        host: Arc<dyn ShortcutHost>,
        handlers: ShortcutHandlers,
        log: Option<ShortcutLog>,
    ) -> Self {
        Self {
            host,
            handlers: Arc::new(handlers),
            log,
            registered: Vec::new(),
            states: off(),
            choice: None,
            paused: false,
        }
    }

    fn registered_key(&self, action: ShortcutAction) -> Option<&str> {
        self.registered
            .iter()
            .find(|(a, _)| *a == action)
            .map(|(_, key)| key.as_str())
    }

    /// Registers the chosen keys and drops the ones no longer chosen; answers each state.
    /// While paused the choice is only kept, and registered on resume.
    pub fn apply(&mut self, choice: Option<&ShortcutSettings>) -> ShortcutStatus {
        self.choice = choice.cloned();
        if self.paused {
            return self.status();
        }
        let wanted: Vec<(ShortcutAction, String)> = SHORTCUT_ACTIONS
            .iter()
            .filter_map(|&action| {
                normalize_accelerator(&shortcut_for(choice, action)).map(|key| (action, key))
            })
            .collect();
        let wanted_key = |action: ShortcutAction| {
            wanted
                .iter()
                .find(|(a, _)| *a == action)
                .map(|(_, key)| key.clone())
        };
        // Every key that changes is let go first, so two actions can trade keys in one change.
        let mut kept = Vec::new();
        for (action, accelerator) in std::mem::take(&mut self.registered) {
            if wanted_key(action).as_deref() == Some(accelerator.as_str()) {
                kept.push((action, accelerator));
            } else {
                self.release(&accelerator);
            }
        }
        self.registered = kept;
        let mut used: HashSet<String> = self.registered.iter().map(|(_, k)| k.clone()).collect();
        let mut states = off();
        for action in SHORTCUT_ACTIONS {
            let state = match wanted_key(action) {
                None => ShortcutState::Off,
                Some(accelerator) if self.registered_key(action) == Some(&accelerator) => {
                    ShortcutState::On
                }
                Some(accelerator) if used.contains(&accelerator) => ShortcutState::Taken,
                Some(accelerator) => {
                    if self.take(action, &accelerator) {
                        used.insert(accelerator.clone());
                        self.registered.push((action, accelerator));
                        ShortcutState::On
                    } else {
                        ShortcutState::Taken
                    }
                }
            };
            set_state(&mut states, action, state);
        }
        self.states = states;
        self.status()
    }

    pub fn status(&self) -> ShortcutStatus {
        self.states
    }

    /// Lets every key go until resume; the states stay as they were, for Settings.
    pub fn pause(&mut self) {
        if self.paused {
            return;
        }
        self.paused = true;
        for (_, accelerator) in std::mem::take(&mut self.registered) {
            self.release(&accelerator);
        }
    }

    /// Registers the latest choice again after pause.
    pub fn resume(&mut self) -> ShortcutStatus {
        if !self.paused {
            return self.status();
        }
        self.paused = false;
        let choice = self.choice.clone();
        self.apply(choice.as_ref())
    }

    /// Lets every key go: Relay is quitting.
    pub fn dispose(&mut self) {
        self.paused = false;
        for (_, accelerator) in std::mem::take(&mut self.registered) {
            self.release(&accelerator);
        }
        self.states = off();
    }

    fn take(&self, action: ShortcutAction, accelerator: &str) -> bool {
        let handlers = Arc::clone(&self.handlers);
        let log = self.log.clone();
        let callback: ShortcutCallback = Box::new(move || {
            if let Err(error) = handlers.run(action)
                && let Some(log) = &log
            {
                log("shortcut-failed", &log_fields(action, &error));
            }
        });
        match self.host.register(accelerator, callback) {
            Ok(taken) => taken,
            Err(error) => {
                // The shell refuses keys this platform cannot register; it reads as unavailable.
                if let Some(log) = &self.log {
                    log("shortcut-register-failed", &log_fields(action, &error));
                }
                false
            }
        }
    }

    fn release(&self, accelerator: &str) {
        // A key that is already gone needs nothing.
        let _ = self.host.unregister(accelerator);
    }
}

/// What `shortcut_switch_target` decides from.
#[derive(Clone, Copy, Debug)]
pub struct ShortcutSwitchInput<'a> {
    pub active_id: Option<&'a str>,
    pub accounts: &'a [Account],
    pub usage: &'a JsMap<AccountUsage>,
    pub settings: &'a RelaySettings,
    pub now: f64,
    pub rate: Option<f64>,
    pub in_windows: &'a HashSet<String>,
}

fn is_claude(account: &Account) -> bool {
    account.provider.unwrap_or(AccountProvider::Claude) == AccountProvider::Claude
}

/// The account `overviewAccounts` (src/data/selectors) marks recommended among `others`: the
/// first Claude account in ranked order that is saved for the Claude app, not open in its own
/// window, with a fresh reading and no full window; one with a spent model limit only when no
/// other is clear.
fn recommended<'a>(
    others: &[&'a Account],
    usage: &'a JsMap<AccountUsage>,
    now: f64,
    rate: Option<f64>,
    in_windows: &HashSet<String>,
    settings: &RelaySettings,
) -> Option<&'a Account> {
    let candidates: Vec<ContinuationTargetCandidate<'a>> = others
        .iter()
        .map(|&account| ContinuationTargetCandidate {
            account,
            usage: usage.get(&account.id),
        })
        .collect();
    let ranked = rank_continuation_targets(
        &candidates,
        Some(RankingContext {
            now,
            rate,
            strategy: settings.auto_switch_strategy,
        }),
    );
    // The overview lists Claude accounts saved for the Claude app first; only those can be
    // "ready" or "window-open", so they alone are pickable.
    let pickable: Vec<_> = ranked
        .iter()
        .filter(|r| {
            is_claude(r.account)
                && r.account.desktop.is_some()
                && !in_windows.contains(&r.account.id)
                && fresh_usage(r.usage, now)
                && !quota_windows(r.usage)
                    .unwrap_or_default()
                    .iter()
                    .any(|w| w.used_percent >= 100.0)
        })
        .collect();
    pickable
        .iter()
        .find(|r| spent_model_windows(r.usage, now).is_empty())
        .or(pickable.first())
        .map(|r| r.account)
}

/// The account "switch to the suggested account" offers: the panel's badge. That is the account
/// suggested once the active one passes the warning threshold (`suggested_account`), else the
/// top of the panel's ranking that can be switched to now; never one open in its own Claude
/// window, nor one whose Claude app and usage sign-ins disagree (the widget's Geç rule).
pub fn shortcut_switch_target<'a>(input: &ShortcutSwitchInput<'a>) -> Option<&'a Account> {
    let accounts = input.accounts;
    let active = input
        .active_id
        .and_then(|id| accounts.iter().find(|a| a.id == id));
    let active_id = active.map(|a| a.id.as_str());
    let switchable = |a: &Account| {
        Some(a.id.as_str()) != active_id
            && is_claude(a)
            && !input.in_windows.contains(&a.id)
            && a.desktop
                .as_ref()
                .is_some_and(|d| !d.account_uuid.is_empty() && !d.org_id.is_empty())
            && !desktop_cli_mismatch(a)
    };
    let candidates: Vec<&Account> = accounts
        .iter()
        .filter(|a| Some(a.id.as_str()) == active_id || switchable(a))
        .collect();
    let owned: Vec<Account> = candidates.iter().map(|a| (*a).clone()).collect();
    if let Some(suggestion) = suggested_account(
        active,
        &owned,
        input.usage,
        input.settings,
        input.now,
        input.rate,
    ) {
        return candidates.into_iter().find(|a| a.id == suggestion.id);
    }
    let others: Vec<&Account> = candidates
        .into_iter()
        .filter(|a| Some(a.id.as_str()) != active_id)
        .collect();
    recommended(
        &others,
        input.usage,
        input.now,
        input.rate,
        input.in_windows,
        input.settings,
    )
    .filter(|a| switchable(a))
}
