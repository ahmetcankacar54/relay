//! Port of tests/switch-scene.test.ts.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use relay_core::shared::switch_scene::{
    CLOSING_MS, DISGUISES, Disguise, INITIAL_SCENE, LEAVING_MS, RETURNING_MS, SceneAccount,
    SceneAccounts, SceneContext, SwitchOutcome, SwitchSceneEvent, SwitchSceneState, SwitchStage,
    SwitchStory, SwitchStoryHost, SwitchWindowState, WAITING_LIMIT_MS, pick_disguise,
    scene_deadline, scene_line, scene_view, switch_scene, switch_window_visible,
};
use relay_core::shared::types::DesktopOperationKind;
use relay_i18n::Locale::{self, En, Tr};

fn start() -> SwitchSceneEvent {
    start_from(None)
}

fn start_from(from: Option<&str>) -> SwitchSceneEvent {
    SwitchSceneEvent::Start {
        kind: DesktopOperationKind::Switch,
        profile_id: Some("b".into()),
        from_id: from.map(str::to_string),
    }
}

fn merge_start(from: Option<&str>) -> SwitchSceneEvent {
    SwitchSceneEvent::Start {
        kind: DesktopOperationKind::Merge,
        profile_id: None,
        from_id: from.map(str::to_string),
    }
}

fn ended(ok: bool) -> SwitchSceneEvent {
    SwitchSceneEvent::End {
        kind: DesktopOperationKind::Switch,
        profile_id: Some("b".into()),
        ok,
        from_id: None,
    }
}

fn merged() -> SwitchSceneEvent {
    SwitchSceneEvent::End {
        kind: DesktopOperationKind::Merge,
        profile_id: None,
        ok: true,
        from_id: None,
    }
}

const TICK: SwitchSceneEvent = SwitchSceneEvent::Tick;

fn fedora(_: Option<Disguise>) -> Disguise {
    Disguise::Fedora
}

/// Each event at its time, from the initial state; every state along the way.
fn run(steps: &[(f64, SwitchSceneEvent)]) -> Vec<SwitchSceneState> {
    let mut state = INITIAL_SCENE;
    steps
        .iter()
        .map(|(at, event)| {
            state = switch_scene(&state, event, *at, &mut fedora).into_owned();
            state.clone()
        })
        .collect()
}

#[test]
fn a_switch_leaves_waits_returns_in_disguise_fades_and_hides() {
    let back = 5_000.0;
    let states = run(&[
        (0.0, start()),
        (LEAVING_MS, TICK),
        (back, ended(true)),
        (back + RETURNING_MS.switched, TICK),
        (back + RETURNING_MS.switched + CLOSING_MS, TICK),
    ]);
    let stages: Vec<SwitchStage> = states.iter().map(|s| s.stage).collect();
    assert_eq!(
        stages,
        [
            SwitchStage::Leaving,
            SwitchStage::Waiting,
            SwitchStage::Returning,
            SwitchStage::Closing,
            SwitchStage::Hidden
        ]
    );
    assert_eq!(states[0].story, 1);
    assert_eq!(states[2].outcome, Some(SwitchOutcome::Switched));
    assert_eq!(states[2].disguise, Some(Disguise::Fedora));
    assert_eq!(states[2].since, back);
}

#[test]
fn each_outcome_returns_for_its_own_time_in_disguise_only_after_a_switch() {
    let cases = [
        (ended(false), SwitchOutcome::Failed),
        (merged(), SwitchOutcome::Back),
        (ended(true), SwitchOutcome::Switched),
    ];
    for (event, outcome) in cases {
        let ms = RETURNING_MS.of(outcome);
        let states = run(&[
            (0.0, start()),
            (LEAVING_MS, TICK),
            (2_000.0, event),
            (2_000.0 + ms - 1.0, TICK),
        ]);
        let (returning, before) = (&states[2], &states[3]);
        assert_eq!(returning.outcome, Some(outcome));
        assert_eq!(before.stage, SwitchStage::Returning, "{}", outcome.as_str());
        assert_eq!(scene_deadline(before), Some(2_000.0 + ms));
        assert_eq!(
            returning.disguise,
            (outcome == SwitchOutcome::Switched).then_some(Disguise::Fedora)
        );
    }
}

#[test]
fn an_operation_that_ends_while_the_panda_still_walks_returns_once_the_walk_is_over() {
    let states = run(&[(0.0, start()), (400.0, ended(true)), (LEAVING_MS, TICK)]);
    let (held, returning) = (&states[1], &states[2]);
    assert_eq!(held.stage, SwitchStage::Leaving);
    assert_eq!(held.outcome, Some(SwitchOutcome::Switched));
    assert_eq!(returning.stage, SwitchStage::Returning);
    assert_eq!(returning.since, LEAVING_MS);
}

#[test]
fn an_end_that_arrives_before_the_leaving_timer_has_run_still_plays_its_return_from_now() {
    let states = run(&[(0.0, start()), (5_000.0, ended(true))]);
    let returning = &states[1];
    assert_eq!(returning.stage, SwitchStage::Returning);
    assert_eq!(returning.since, 5_000.0);
    assert_eq!(returning.outcome, Some(SwitchOutcome::Switched));
    assert_eq!(returning.disguise, Some(Disguise::Fedora));
    assert_eq!(
        scene_deadline(returning),
        Some(5_000.0 + RETURNING_MS.switched)
    );
}

#[test]
fn after_a_minute_of_waiting_the_window_hides_and_a_late_end_still_plays_the_return() {
    let states = run(&[
        (0.0, start()),
        (LEAVING_MS, TICK),
        (LEAVING_MS + WAITING_LIMIT_MS, TICK),
        (90_000.0, ended(true)),
    ]);
    assert_eq!(states[1].stage, SwitchStage::Waiting);
    assert_eq!(states[2].stage, SwitchStage::Stalled);
    assert_eq!(scene_deadline(&states[2]), None);
    assert_eq!(states[3].stage, SwitchStage::Returning);
    assert_eq!(states[3].since, 90_000.0);
}

#[test]
fn a_new_operation_during_the_return_starts_the_story_over() {
    let again = run(&[
        (0.0, start()),
        (LEAVING_MS, TICK),
        (2_000.0, ended(true)),
        (2_500.0, merge_start(None)),
    ])
    .remove(3);
    assert_eq!(again.stage, SwitchStage::Leaving);
    assert_eq!(again.story, 2);
    assert_eq!(again.kind, Some(DesktopOperationKind::Merge));
    assert_eq!(again.profile_id, None);
    assert_eq!(again.outcome, None);
    assert_eq!(again.disguise, None);
    assert_eq!(again.last_disguise, Some(Disguise::Fedora));
}

#[test]
fn a_timer_that_fires_late_after_sleep_skips_the_stages_it_slept_through() {
    let states = run(&[(0.0, start()), (500.0, ended(true)), (100_000.0, TICK)]);
    assert_eq!(states[2].stage, SwitchStage::Hidden);
}

#[test]
fn an_end_without_its_start_changes_nothing() {
    let next = switch_scene(&INITIAL_SCENE, &ended(true), 10.0, &mut fedora);
    assert!(matches!(next, Cow::Borrowed(state) if *state == INITIAL_SCENE));
}

#[test]
fn a_disguise_is_random_but_never_the_previous_one() {
    let all: Vec<Disguise> = DISGUISES.iter().map(|(d, _)| *d).collect();
    for previous in &all {
        for r in [0.0, 0.49, 0.5, 0.999] {
            assert_ne!(pick_disguise(Some(*previous), || r), *previous);
        }
    }
    let picked: HashSet<Disguise> = [0.0, 0.4, 0.8]
        .into_iter()
        .map(|r| pick_disguise(None, || r))
        .collect();
    assert_eq!(picked, all.into_iter().collect());
}

#[test]
fn each_switched_story_asks_the_picker_to_avoid_the_disguise_worn_in_the_story_before() {
    let mut seen: Vec<Option<Disguise>> = Vec::new();
    let worn = [Disguise::Sunglasses, Disguise::Deerstalker];
    let mut pick = |previous: Option<Disguise>| {
        seen.push(previous);
        worn[seen.len() - 1]
    };
    let mut state = INITIAL_SCENE;
    let steps = [
        (0.0, start()),
        (LEAVING_MS, TICK),
        (2_000.0, ended(true)),
        (10_000.0, TICK),
        (11_000.0, start()),
        (11_000.0 + LEAVING_MS, TICK),
        (13_000.0, ended(true)),
    ];
    for (at, event) in &steps {
        state = switch_scene(&state, event, *at, &mut pick).into_owned();
    }
    assert_eq!(seen, [None, Some(Disguise::Sunglasses)]);
    assert_eq!(state.disguise, Some(Disguise::Deerstalker));
}

fn vertex(id: &str) -> Option<String> {
    (id == "b").then(|| "Vertex".to_string())
}

#[test]
fn the_line_names_the_target_and_the_result_in_turkish_and_english() {
    let lines = |language: Locale, steps: &[(f64, SwitchSceneEvent)]| -> Vec<String> {
        run(steps)
            .iter()
            .map(|s| scene_line(s, language, &vertex))
            .collect()
    };
    assert_eq!(
        lines(
            Tr,
            &[(0.0, start()), (LEAVING_MS, TICK), (2_000.0, ended(true))]
        ),
        [
            "Vertex hesabına geçiliyor",
            "Vertex hesabına geçiliyor",
            "Vertex hesabındasın"
        ]
    );
    assert_eq!(
        lines(
            En,
            &[(0.0, start()), (500.0, ended(false)), (LEAVING_MS, TICK)]
        ),
        [
            "Relay switches to Vertex",
            "Relay switches to Vertex",
            "Did not finish · details in Relay"
        ]
    );
    assert_eq!(
        lines(
            Tr,
            &[
                (0.0, merge_start(None)),
                (LEAVING_MS, TICK),
                (2_000.0, merged())
            ]
        ),
        [
            "Claude uygulaması yeniden başlatılıyor…",
            "Claude uygulaması yeniden başlatılıyor…",
            "Claude uygulaması yeniden açıldı"
        ]
    );
    let third =
        |steps: &[(f64, SwitchSceneEvent)], language| scene_line(&run(steps)[2], language, &vertex);
    assert_eq!(
        third(
            &[(0.0, start()), (500.0, ended(false)), (LEAVING_MS, TICK)],
            Tr
        ),
        "İşlem tamamlanamadı · ayrıntılar Relay’de"
    );
    assert_eq!(
        third(
            &[(0.0, start()), (500.0, ended(true)), (LEAVING_MS, TICK)],
            En
        ),
        "You are on Vertex"
    );
    assert_eq!(
        third(
            &[
                (0.0, merge_start(None)),
                (500.0, merged()),
                (LEAVING_MS, TICK)
            ],
            En
        ),
        "The Claude app reopened"
    );
}

#[test]
fn an_account_deleted_during_the_story_falls_back_to_the_general_lines() {
    let states = run(&[(0.0, start()), (LEAVING_MS, TICK), (2_000.0, ended(true))]);
    let lines: Vec<String> = states
        .iter()
        .map(|s| scene_line(s, Tr, &|_| None))
        .collect();
    assert_eq!(
        lines,
        [
            "Claude uygulaması yeniden başlatılıyor…",
            "Claude uygulaması yeniden başlatılıyor…",
            "Claude uygulaması yeniden açıldı"
        ]
    );
}

#[test]
fn the_view_is_on_screen_only_for_drawn_stages_with_the_outcome_once_returning() {
    let name = |_: &str| Some("Vertex".to_string());
    let context = SceneContext {
        language: Tr,
        name: &name,
        percent: None,
        motion: false,
    };
    let states = run(&[(0.0, start()), (400.0, ended(true)), (LEAVING_MS, TICK)]);
    let views: Vec<_> = states
        .iter()
        .map(|s| scene_view(s, &context))
        .map(|v| (v.stage, v.visible, v.outcome, v.motion))
        .collect();
    assert_eq!(
        views,
        [
            (SwitchStage::Leaving, true, None, false),
            (SwitchStage::Leaving, true, None, false),
            (
                SwitchStage::Returning,
                true,
                Some(SwitchOutcome::Switched),
                false
            ),
        ]
    );
    assert!(!scene_view(&INITIAL_SCENE, &context).visible);
    let stalled = run(&[
        (0.0, start()),
        (LEAVING_MS, TICK),
        (LEAVING_MS + WAITING_LIMIT_MS, TICK),
    ])
    .remove(2);
    assert!(!scene_view(&stalled, &context).visible);
}

fn side(name: &str, percent: Option<f64>) -> SceneAccount {
    SceneAccount {
        name: name.into(),
        percent,
    }
}

#[test]
fn a_switch_s_view_carries_the_from_to_accounts_with_their_five_hour_percents() {
    let names: HashMap<&str, &str> = [("a", "Kişisel · Max"), ("b", "Vertex")].into();
    let percents: HashMap<&str, f64> = [("a", 94.0), ("b", 22.0)].into();
    let name = |id: &str| names.get(id).map(|n| n.to_string());
    let percent = |id: &str| percents.get(id).copied();
    let context = SceneContext {
        language: Tr,
        name: &name,
        percent: Some(&percent),
        motion: true,
    };
    let leaving = run(&[(0.0, start_from(Some("a")))]).remove(0);
    assert_eq!(leaving.from_id.as_deref(), Some("a"));
    assert_eq!(
        scene_view(&leaving, &context).accounts,
        Some(SceneAccounts {
            from: Some(side("Kişisel · Max", Some(94.0))),
            to: side("Vertex", Some(22.0)),
        })
    );
    // Without a known source, or switching to the account already open, only the target shows.
    let only_target = Some(SceneAccounts {
        from: None,
        to: side("Vertex", Some(22.0)),
    });
    let unknown = run(&[(0.0, start())]).remove(0);
    assert_eq!(scene_view(&unknown, &context).accounts, only_target);
    let same = run(&[(0.0, start_from(Some("b")))]).remove(0);
    assert_eq!(scene_view(&same, &context).accounts, only_target);
    // No percent known: the name alone. A restart that is not a switch, or a deleted target: no
    // row.
    let no_percent = |_: &str| None;
    let without = SceneContext {
        percent: Some(&no_percent),
        ..context
    };
    assert_eq!(
        scene_view(&leaving, &without).accounts,
        Some(SceneAccounts {
            from: Some(side("Kişisel · Max", None)),
            to: side("Vertex", None),
        })
    );
    let merge = run(&[(0.0, merge_start(Some("a")))]).remove(0);
    let context = SceneContext {
        percent: Some(&percent),
        ..without
    };
    assert_eq!(scene_view(&merge, &context).accounts, None);
    let only_a = |id: &str| (id == "a").then(|| names["a"].to_string());
    let deleted = SceneContext {
        name: &only_a,
        ..context
    };
    assert_eq!(scene_view(&leaving, &deleted).accounts, None);
}

#[test]
fn the_switch_window_shows_only_with_the_setting_on_its_page_ready_and_the_panel_closed() {
    let on = SwitchWindowState {
        loaded: true,
        enabled: true,
        panel_open: false,
    };
    assert!(switch_window_visible(Some(true), on));
    assert!(!switch_window_visible(
        Some(true),
        SwitchWindowState {
            enabled: false,
            ..on
        }
    ));
    assert!(!switch_window_visible(
        Some(true),
        SwitchWindowState {
            loaded: false,
            ..on
        }
    ));
    assert!(!switch_window_visible(
        Some(true),
        SwitchWindowState {
            panel_open: true,
            ..on
        }
    ));
    assert!(!switch_window_visible(Some(false), on));
    assert!(!switch_window_visible(None, on));
}

/// The test clock: timers in the order they were set, fired one at a time.
#[derive(Default)]
struct Clock {
    now: f64,
    id: u64,
    timers: Vec<(u64, f64)>,
    shown: Vec<(SwitchStage, f64)>,
    pick: Option<Disguise>,
    show_fails: bool,
}

struct Host(Rc<RefCell<Clock>>);

impl SwitchStoryHost for Host {
    type Error = &'static str;
    fn show(&mut self, state: &SwitchSceneState) -> Result<(), Self::Error> {
        let mut clock = self.0.borrow_mut();
        if clock.show_fails {
            return Err("window gone");
        }
        clock.shown.push((state.stage, state.since));
        Ok(())
    }
    fn now(&mut self) -> f64 {
        self.0.borrow().now
    }
    fn set_timeout(&mut self, ms: f64) -> u64 {
        let mut clock = self.0.borrow_mut();
        clock.id += 1;
        let (id, at) = (clock.id, clock.now + ms);
        clock.timers.push((id, at));
        id
    }
    fn clear_timeout(&mut self, handle: u64) {
        self.0.borrow_mut().timers.retain(|(id, _)| *id != handle);
    }
    fn pick(&mut self, previous: Option<Disguise>) -> Disguise {
        let pick = self.0.borrow().pick;
        pick.unwrap_or_else(|| pick_disguise(previous, || 0.0))
    }
}

fn story(pick: Option<Disguise>, show_fails: bool) -> (SwitchStory<Host>, Rc<RefCell<Clock>>) {
    let clock = Rc::new(RefCell::new(Clock {
        pick,
        show_fails,
        ..Clock::default()
    }));
    (SwitchStory::new(Host(clock.clone())), clock)
}

fn timers(clock: &Rc<RefCell<Clock>>) -> Vec<f64> {
    clock.borrow().timers.iter().map(|(_, at)| *at).collect()
}

/// Runs the first timer at its time.
fn fire(story: &mut SwitchStory<Host>, clock: &Rc<RefCell<Clock>>) {
    {
        let mut c = clock.borrow_mut();
        let (_, at) = c.timers.remove(0);
        c.now = at;
    }
    story.tick();
}

#[test]
fn the_story_times_its_stages_and_publishes_each_change() {
    let (mut story, clock) = story(Some(Disguise::Sunglasses), false);
    story.report(start());
    assert_eq!(timers(&clock), [LEAVING_MS]);
    fire(&mut story, &clock);
    clock.borrow_mut().now = 3_000.0;
    story.report(ended(true));
    assert_eq!(story.current().disguise, Some(Disguise::Sunglasses));
    assert_eq!(timers(&clock), [3_000.0 + RETURNING_MS.switched]);
    fire(&mut story, &clock);
    fire(&mut story, &clock);
    let stages: Vec<SwitchStage> = clock.borrow().shown.iter().map(|(s, _)| *s).collect();
    assert_eq!(
        stages,
        [
            SwitchStage::Leaving,
            SwitchStage::Waiting,
            SwitchStage::Returning,
            SwitchStage::Closing,
            SwitchStage::Hidden
        ]
    );
    assert!(clock.borrow().timers.is_empty());
}

#[test]
fn an_end_reported_before_the_leaving_timer_has_run_still_plays_the_return() {
    let (mut story, clock) = story(Some(Disguise::Sunglasses), false);
    story.report(start());
    clock.borrow_mut().now = 5_000.0; // the leaving timer is overdue but has not fired
    story.report(ended(true));
    assert_eq!(story.current().stage, SwitchStage::Returning);
    assert_eq!(story.current().since, 5_000.0);
    assert_eq!(timers(&clock), [5_000.0 + RETURNING_MS.switched]);
    fire(&mut story, &clock);
    fire(&mut story, &clock);
    assert_eq!(
        clock.borrow().shown,
        [
            (SwitchStage::Leaving, 0.0),
            (SwitchStage::Returning, 5_000.0),
            (SwitchStage::Closing, 5_000.0 + RETURNING_MS.switched),
            (
                SwitchStage::Hidden,
                5_000.0 + RETURNING_MS.switched + CLOSING_MS
            ),
        ]
    );
}

#[test]
fn a_failing_view_never_stops_the_story_and_destroy_clears_its_timer() {
    let (mut story, clock) = story(None, true);
    story.report(start());
    assert_eq!(story.current().stage, SwitchStage::Leaving);
    assert_eq!(clock.borrow().timers.len(), 1);
    story.destroy();
    assert!(clock.borrow().timers.is_empty());
}
