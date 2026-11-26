//! Port of tests/tray-panel-toggle.test.ts. Skipped, source-text: "the panel window never
//! activates Relay" and "only a new document makes the panel wait for a paint, and every tray
//! click counts" (they read electron/tray-panel.ts, switch-window.ts and tray.ts). "a panel macOS
//! put on no Space gets a new window that opens for the same click" keeps its logic assertions;
//! its reads of electron/tray-panel.ts, main, package.json and build-native.mjs are dropped.

use relay_core::shared::tray_panel::{
    INITIAL_PANEL_LOAD, PANEL_OPEN_GUARD_MS, PANEL_PENDING_OPEN_MS, PANEL_REBUILD_GAP_MS,
    PANEL_REVIVE_GAP_MS, PANEL_STUCK_MS, POINTER_SLACK, PanelBlur, PanelBlurAction, PanelHealth,
    PanelLoadEvent, PanelLoadState, PanelOffSpaceAction, PanelPhase, PanelRevival, PendingOpen,
    Point, Rect, ToggleGuard, TrayClickAction, panel_blur_action, panel_load_state,
    panel_off_space_action, panel_revival, pending_open_due, pointer_on_tray, tray_click_action,
};
use relay_core::window_space::{WindowSpaceAddon, load_window_space};
use serde_json::Value;

#[test]
fn a_tray_click_right_after_a_blur_hide_does_not_reopen_the_panel() {
    let mut guard = ToggleGuard::new();
    assert!(guard.should_open(1000.0));
    guard.hidden(1000.0, true);
    assert!(!guard.should_open(1250.0));
    // A slow (long-press) click still lands inside the 400 ms window.
    assert!(!guard.should_open(1400.0));
    assert!(guard.should_open(1401.0));
}

#[test]
fn a_blur_from_a_click_elsewhere_never_swallows_the_next_tray_click() {
    let mut guard = ToggleGuard::new();
    guard.hidden(1000.0, false);
    assert!(guard.should_open(1050.0));
    guard.hidden(2000.0, true);
    guard.hidden(2100.0, false);
    assert!(guard.should_open(2150.0));
}

const TRAY: Rect = Rect {
    x: 1400.0,
    y: 0.0,
    width: 40.0,
    height: 24.0,
};

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

#[test]
fn the_pointer_counts_as_on_the_tray_icon_only_inside_its_bounds() {
    assert!(pointer_on_tray(
        Some(&TRAY),
        point(1420.0, 12.0),
        POINTER_SLACK
    ));
    assert!(pointer_on_tray(
        Some(&TRAY),
        point(1442.0, 26.0),
        POINTER_SLACK
    ));
    assert!(!pointer_on_tray(
        Some(&TRAY),
        point(900.0, 400.0),
        POINTER_SLACK
    ));
    assert!(!pointer_on_tray(None, point(900.0, 400.0), POINTER_SLACK));
}

#[test]
fn a_blur_right_after_opening_ignores_tray_pointer_so_the_panel_stays_open() {
    let on_tray = point(1420.0, 12.0);
    let elsewhere = point(500.0, 500.0);
    let blur = |opened_at: f64, now: f64, tray: Option<Rect>, cursor: Point| {
        panel_blur_action(PanelBlur {
            opened_at,
            now,
            tray,
            cursor,
        })
    };
    let tray = Some(TRAY);
    // Blur on tray immediately after opening (< 300 ms) is ignored
    assert_eq!(blur(1000.0, 1000.0, tray, on_tray), PanelBlurAction::Ignore);
    assert_eq!(blur(1000.0, 1250.0, tray, on_tray), PanelBlurAction::Ignore);
    assert_eq!(
        blur(1000.0, 1000.0 + PANEL_OPEN_GUARD_MS - 1.0, tray, on_tray),
        PanelBlurAction::Ignore
    );
    // Blur on tray after the panel has been open (>= 300 ms) hides and arms the guard
    assert_eq!(
        blur(1000.0, 1000.0 + PANEL_OPEN_GUARD_MS, tray, on_tray),
        PanelBlurAction::HideByTray
    );
    assert_eq!(
        blur(1000.0, 2000.0, tray, on_tray),
        PanelBlurAction::HideByTray
    );
    // Blur elsewhere always hides without arming the guard
    assert_eq!(blur(1000.0, 1050.0, tray, elsewhere), PanelBlurAction::Hide);
    assert_eq!(blur(1000.0, 2000.0, tray, elsewhere), PanelBlurAction::Hide);
    // When tray is unknown, it cannot count as on-tray
    assert_eq!(blur(1000.0, 1050.0, None, on_tray), PanelBlurAction::Hide);
}

#[test]
fn a_tray_click_falls_back_to_the_native_menu_until_the_panel_has_loaded() {
    assert_eq!(tray_click_action(true), TrayClickAction::Toggle);
    assert_eq!(tray_click_action(false), TrayClickAction::Menu);
}

use PanelLoadEvent::{Fail, Finish, Gone, Painted, Start};

fn run(events: &[PanelLoadEvent], from: PanelLoadState) -> PanelLoadState {
    events
        .iter()
        .fold(from, |state, event| panel_load_state(state, *event))
}

fn phase(events: &[PanelLoadEvent]) -> PanelPhase {
    run(events, INITIAL_PANEL_LOAD).phase
}

#[test]
fn the_panel_is_ready_only_after_its_renderer_reported_a_size() {
    assert_eq!(phase(&[]), PanelPhase::Loading);
    assert_eq!(phase(&[Start]), PanelPhase::Loading);
    assert_eq!(phase(&[Start, Finish]), PanelPhase::Loading);
    assert_eq!(phase(&[Start, Finish, Painted]), PanelPhase::Ready);
    // The first layout can arrive before did-finish-load.
    assert_eq!(phase(&[Start, Painted, Finish]), PanelPhase::Ready);
    assert_eq!(phase(&[Start, Painted, Painted]), PanelPhase::Ready);
}

#[test]
fn a_failed_main_frame_load_makes_the_panel_unusable_until_the_next_load() {
    assert_eq!(phase(&[Start, Fail, Finish]), PanelPhase::Failed);
    assert_eq!(phase(&[Start, Fail, Painted]), PanelPhase::Failed);
    assert_eq!(phase(&[Start, Painted, Fail]), PanelPhase::Failed);
    assert_eq!(phase(&[Start, Fail, Start, Painted]), PanelPhase::Ready);
}

#[test]
fn the_panel_reloads_after_one_renderer_crash_a_second_crash_is_final() {
    let first = run(&[Start, Painted, Gone], INITIAL_PANEL_LOAD);
    assert_eq!(
        first,
        PanelLoadState {
            phase: PanelPhase::Reloading,
            crashes: 1
        }
    );
    let recovered = run(&[Start, Painted], first);
    assert_eq!(
        recovered,
        PanelLoadState {
            phase: PanelPhase::Ready,
            crashes: 1
        }
    );
    let second = run(&[Gone], recovered);
    assert_eq!(
        second,
        PanelLoadState {
            phase: PanelPhase::Failed,
            crashes: 2
        }
    );
    // Nothing brings it back for the rest of the session.
    assert_eq!(
        run(&[Start, Finish, Painted], second).phase,
        PanelPhase::Failed
    );
}

#[test]
fn a_tray_click_brings_an_unusable_panel_back_for_the_next_click() {
    let base = PanelHealth {
        phase: PanelPhase::Loading,
        alive: true,
        page_loading: false,
        unready_for: 60_000.0,
        since_revival: f64::INFINITY,
    };
    let with = |phase| PanelHealth { phase, ..base };
    // Nothing to do for a panel that works, or one that is still loading its page.
    assert_eq!(panel_revival(with(PanelPhase::Ready)), None);
    assert_eq!(
        panel_revival(PanelHealth {
            page_loading: true,
            ..base
        }),
        None
    );
    assert_eq!(
        panel_revival(PanelHealth {
            unready_for: PANEL_STUCK_MS - 1.0,
            ..base
        }),
        None
    );
    // A page that never painted, failed to load or crashed out is loaded again.
    assert_eq!(
        panel_revival(PanelHealth {
            unready_for: PANEL_STUCK_MS,
            ..base
        }),
        Some(PanelRevival::Reload)
    );
    assert_eq!(
        panel_revival(with(PanelPhase::Reloading)),
        Some(PanelRevival::Reload)
    );
    assert_eq!(
        panel_revival(PanelHealth {
            unready_for: 0.0,
            ..with(PanelPhase::Failed)
        }),
        Some(PanelRevival::Reload)
    );
    // A window that is gone is made again.
    assert_eq!(
        panel_revival(PanelHealth {
            alive: false,
            ..with(PanelPhase::Ready)
        }),
        Some(PanelRevival::Recreate)
    );
    // Never on every click.
    assert_eq!(
        panel_revival(PanelHealth {
            since_revival: PANEL_REVIVE_GAP_MS - 1.0,
            ..with(PanelPhase::Failed)
        }),
        None
    );
    assert_eq!(
        panel_revival(PanelHealth {
            alive: false,
            since_revival: 0.0,
            ..with(PanelPhase::Failed)
        }),
        None
    );
}

#[test]
fn a_panel_macos_put_on_no_space_gets_a_new_window_that_opens_for_the_same_click() {
    // macOS can order the panel in on no Space: it counts as shown and nothing draws it.
    assert_eq!(
        panel_off_space_action(f64::INFINITY),
        PanelOffSpaceAction::Rebuild
    );
    assert_eq!(
        panel_off_space_action(PANEL_REBUILD_GAP_MS),
        PanelOffSpaceAction::Rebuild
    );
    // A new window off the Space again is only hidden, never rebuilt on every click.
    assert_eq!(
        panel_off_space_action(PANEL_REBUILD_GAP_MS - 1.0),
        PanelOffSpaceAction::Hide
    );
    assert!(!pending_open_due(None, 1000.0));
    assert!(pending_open_due(
        Some(PendingOpen { at: 1000.0 }),
        1000.0 + PANEL_PENDING_OPEN_MS
    ));
    // A panel that took too long to paint does not pop open out of nowhere.
    assert!(!pending_open_due(
        Some(PendingOpen { at: 1000.0 }),
        1001.0 + PANEL_PENDING_OPEN_MS
    ));
}

fn answering(answers: Vec<Value>) -> WindowSpaceAddon {
    let answers = std::sync::Mutex::new(answers.into_iter());
    WindowSpaceAddon {
        on_active_space: Some(Box::new(move |_| {
            answers.lock().unwrap().next().unwrap_or(Value::Null)
        })),
    }
}

#[test]
fn the_window_space_addon_answers_only_with_a_boolean_and_its_absence_turns_the_check_off() {
    let dir = std::path::Path::new("/addon");
    if !cfg!(target_os = "macos") {
        let check = load_window_space(dir, |_| Ok::<_, String>(answering(vec![Value::Bool(true)])));
        assert!(check.is_none());
        return;
    }
    let missing = load_window_space(std::path::Path::new("/nowhere"), |file| {
        Err(format!("Cannot find module '{}'", file.display()))
    });
    assert!(missing.is_none());
    assert!(load_window_space(dir, |_| Ok::<_, String>(WindowSpaceAddon::default())).is_none());
    let answers = vec![
        Value::Bool(false),
        Value::Bool(true),
        Value::Null,
        Value::from("yes"),
    ];
    let check = load_window_space(dir, |_| Ok::<_, String>(answering(answers))).expect("check");
    let handle = [0u8; 8];
    assert_eq!(check(&handle), Some(false));
    assert_eq!(check(&handle), Some(true));
    assert_eq!(check(&handle), None);
    assert_eq!(check(&handle), None);
}
