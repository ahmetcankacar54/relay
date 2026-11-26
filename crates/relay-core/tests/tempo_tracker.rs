//! Port of `tests/tempo-tracker.test.ts`.

#[path = "common/planning.rs"]
mod helpers;

use std::sync::{Arc, Mutex};

use helpers::{ZONE, hours, planning_account, wall};
use relay_core::shared::tempo::{
    TempoDays, TempoSource as TempoKind, fallback_tempo, preset_tempo, tempo_at,
};
use relay_core::shared::types::{
    Account, PlanningSettings, TempoChoice, default_planning_settings,
};
use relay_core::shared::usage_rollups::{UsageRollups, empty_rollups};
use relay_core::tempo_tracker::{TempoSource, TempoTracker};

struct State {
    now: f64,
    available: bool,
    calls: u32,
    broken: bool,
    accounts: Vec<Account>,
    settings: PlanningSettings,
}

#[derive(Clone)]
struct Source(Arc<Mutex<State>>);

impl Source {
    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.0.lock().expect("state"))
    }
}

impl TempoSource for Source {
    fn available(&self) -> bool {
        self.with(|s| s.available)
    }
    fn rollups(&self) -> Result<Option<UsageRollups>, String> {
        self.with(|s| {
            if s.broken {
                return Err("rollups unreadable".into());
            }
            s.calls += 1;
            Ok(Some(empty_rollups()))
        })
    }
    fn accounts(&self) -> Vec<Account> {
        self.with(|s| s.accounts.clone())
    }
    fn settings(&self) -> PlanningSettings {
        self.with(|s| s.settings.clone())
    }
    fn now(&self) -> f64 {
        self.with(|s| s.now)
    }
}

fn setup() -> (Source, TempoTracker<Source>) {
    let source = Source(Arc::new(Mutex::new(State {
        now: wall("2026-10-14", "10:00", ZONE),
        available: true,
        calls: 0,
        broken: false,
        accounts: vec![planning_account("a", "pro")],
        settings: PlanningSettings {
            time_zone: ZONE.into(),
            weekday: hours(true, "09:00", "18:00"),
            weekend: hours(false, "11:00", "17:00"),
            ..default_planning_settings()
        },
    })));
    let tracker = TempoTracker::new(source.clone());
    (source, tracker)
}
fn calls(source: &Source) -> u32 {
    source.with(|s| s.calls)
}
fn preset(choice: TempoChoice) -> relay_core::shared::tempo::Tempo {
    preset_tempo(choice, TempoKind::Preset, TempoDays::default())
}

#[test]
fn the_rollups_are_read_once_for_repeated_calls_on_the_same_day() {
    let (state, tracker) = setup();
    let first = tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 1);
    state.with(|s| s.now = wall("2026-10-14", "23:30", ZONE));
    assert_eq!(tracker.current().expect("a tempo"), first);
    assert_eq!(tracker.current().expect("a tempo"), first);
    assert_eq!(calls(&state), 1);
}

#[test]
fn the_tempo_is_learned_again_when_the_local_date_changes() {
    let (state, tracker) = setup();
    tracker.current().expect("a tempo");
    state.with(|s| s.now = wall("2026-10-15", "00:05", ZONE));
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 2);
}

#[test]
fn the_tempo_is_learned_again_when_the_tempo_choice_zone_or_hours_change() {
    let (state, tracker) = setup();
    tracker.current().expect("a tempo");
    state.with(|s| s.settings.tempo = Some(TempoChoice::Heavy));
    assert_eq!(
        tracker.current().expect("a tempo").source,
        TempoKind::Preset
    );
    assert_eq!(tracker.current().expect("a tempo").rate.weekday, 120.0);
    state.with(|s| s.settings.tempo = Some(TempoChoice::Auto));
    assert_eq!(
        tracker.current().expect("a tempo").source,
        TempoKind::Default
    );
    let before = calls(&state);
    state.with(|s| s.settings.time_zone = "UTC".into());
    tracker.current().expect("a tempo");
    state.with(|s| s.settings.weekday = hours(true, "08:00", "18:00"));
    tracker.current().expect("a tempo");
    state.with(|s| s.settings.weekend = hours(true, "11:00", "17:00"));
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), before + 3);
}

#[test]
fn the_tempo_is_learned_again_when_an_account_s_plan_sign_in_or_identity_changes() {
    let (state, tracker) = setup();
    tracker.current().expect("a tempo");
    state.with(|s| {
        let planning = s.accounts[0].planning.as_mut().expect("planned");
        planning.plan = relay_core::shared::types::AccountPlan::Max5;
        planning.capacity_weight = 5.0;
    });
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 2);
    state.with(|s| s.accounts[0].auth.as_mut().expect("auth").logged_in = false);
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 3);
    state.with(|s| s.accounts[0].auth.as_mut().expect("auth").org_id = Some("org-other".into()));
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 4);
    // Unrelated edits (a rename, the planned list) keep the learned tempo.
    state.with(|s| {
        s.accounts[0].name = "Renamed".into();
        s.settings.accounts = helpers::planned(&["a"]);
        s.settings.auto_start = true;
    });
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 4);
}

#[test]
fn the_tempo_is_learned_again_when_the_rollups_become_available_or_unavailable() {
    let (state, tracker) = setup();
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 1);
    state.with(|s| s.available = false);
    tracker.current().expect("a tempo");
    // Unavailable rollups are never read.
    assert_eq!(calls(&state), 1);
    assert_eq!(
        tracker.current().expect("a tempo").source,
        TempoKind::Default
    );
    state.with(|s| s.available = true);
    tracker.current().expect("a tempo");
    assert_eq!(calls(&state), 2);
}

#[test]
fn rate_at_reads_the_current_tempo_at_a_time_defaulting_to_now() {
    let (state, tracker) = setup();
    state.with(|s| s.settings.tempo = Some(TempoChoice::Light));
    let noon = wall("2026-10-14", "12:00", ZONE);
    assert_eq!(
        tracker.rate_at(Some(noon)),
        Ok(tempo_at(
            &tracker.current().expect("a tempo"),
            &state.settings(),
            noon
        ))
    );
    assert_eq!(tracker.rate_at(Some(noon)), Ok(20.0));
    assert_eq!(tracker.rate_at(None), Ok(20.0));
}

#[test]
fn when_learning_fails_the_keeper_still_gets_the_settings_fallback_tempo() {
    let (state, tracker) = setup();
    let failing_state = Source(Arc::new(Mutex::new(State {
        broken: true,
        ..state.with(|s| State {
            now: s.now,
            available: true,
            calls: 0,
            broken: false,
            accounts: s.accounts.clone(),
            settings: s.settings.clone(),
        })
    })));
    let failing = TempoTracker::new(failing_state.clone());
    assert!(failing.current().is_err());
    assert_eq!(
        failing.current_or_fallback(),
        fallback_tempo(&failing_state.settings())
    );
    failing_state.with(|s| s.settings.tempo = Some(TempoChoice::Light));
    assert_eq!(failing.current_or_fallback(), preset(TempoChoice::Light));
    // Once the rollups read again, the tempo is learned as usual.
    failing_state.with(|s| {
        s.settings.tempo = Some(TempoChoice::Auto);
        s.broken = false;
    });
    assert_eq!(
        failing.current_or_fallback(),
        tracker.current().expect("a tempo")
    );
    // One read each: the tracker's and the recovered one's.
    assert_eq!(calls(&state) + calls(&failing_state), 2);
}
