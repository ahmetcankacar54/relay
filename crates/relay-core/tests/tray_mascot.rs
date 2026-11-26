//! Port of tests/tray-mascot.test.ts.

#[path = "common/tray.rs"]
mod helpers;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use helpers::{at, from_json, ms, spread};
use relay_core::shared::mascot::MascotPose;
use relay_core::shared::tray::TraySnapshot;
use relay_core::tray_mascot::{
    AnimationSettings, DesktopForTray, MascotSink, TrayMascot, motion_allowed,
    read_desktop_for_tray,
};
use serde_json::{Value, json};

fn now() -> f64 {
    ms("2026-10-15T10:00:00Z")
}

fn account(id: &str) -> Value {
    json!({ "id": id, "name": id, "kind": "personal", "group": "personal", "color": "olive", "createdAt": at(now()) })
}

fn usage(id: &str, five: f64) -> Value {
    json!({
        "accountId": id, "status": "ready", "stale": false, "checkedAt": at(now() - 60_000.0),
        "fiveHour": { "usedPercent": five, "resetsAt": at(now() + 3_600_000.0) },
    })
}

fn input(d: Value) -> TraySnapshot {
    let desktop = spread(
        json!({
            "available": true, "running": true, "organizations": [], "activeProfileId": "a", "busy": false,
            "recoveryRequired": false, "errorRevision": 0,
        }),
        d,
    );
    from_json(json!({
        "accounts": [account("a"), account("b")],
        "usage": { "a": usage("a", 20.0), "b": usage("b", 10.0) },
        "desktop": desktop,
    }))
}

#[derive(Default)]
struct Recorded {
    poses: Vec<MascotPose>,
    destroyed: bool,
}

struct Recorder(Rc<RefCell<Recorded>>);

impl MascotSink for Recorder {
    fn update(&mut self, pose: MascotPose) {
        self.0.borrow_mut().poses.push(pose);
    }
    fn destroy(&mut self) {
        self.0.borrow_mut().destroyed = true;
    }
}

fn recorder() -> (TrayMascot<Recorder>, Rc<RefCell<Recorded>>) {
    let recorded = Rc::new(RefCell::new(Recorded::default()));
    let mascot = TrayMascot::with_clock(Recorder(recorded.clone()), Box::new(now));
    (mascot, recorded)
}

#[test]
fn each_tray_snapshot_becomes_a_pose() {
    let (mut mascot, recorded) = recorder();
    mascot.next(input(json!({})).mascot_input());
    mascot.next(input(json!({ "busy": true })).mascot_input());
    mascot.next(input(json!({ "activeProfileId": "b" })).mascot_input());
    assert_eq!(
        recorded.borrow().poses,
        [MascotPose::Idle, MascotPose::Away, MascotPose::Idle]
    );
}

#[test]
fn an_unreadable_snapshot_rests_on_idle() {
    let (mut mascot, recorded) = recorder();
    mascot.next(input(json!({ "busy": true })).mascot_input());
    mascot.unavailable();
    assert_eq!(
        recorded.borrow().poses,
        [MascotPose::Away, MascotPose::Idle]
    );
}

#[test]
fn a_desktop_read_that_overlapped_an_operation_counts_as_busy() {
    let busy = Cell::new(false);
    let operations = Cell::new(4u64);
    let read = |during: &dyn Fn()| {
        read_desktop_for_tray(
            || {
                during();
                Ok::<_, ()>("state")
            },
            || busy.get(),
            || operations.get(),
        )
        .unwrap()
    };
    let state = |busy| DesktopForTray {
        state: "state",
        busy,
    };
    assert_eq!(read(&|| {}), state(false));
    // Began and ended during the read: the state may predate the switch.
    assert_eq!(read(&|| operations.set(operations.get() + 1)), state(true));
    // Busy when the read began, finished before it ended.
    busy.set(true);
    assert_eq!(read(&|| busy.set(false)), state(true));
    // Began during the read and still running.
    assert_eq!(
        read(&|| {
            operations.set(operations.get() + 1);
            busy.set(true);
        }),
        state(true)
    );
}

#[test]
fn destroy_stops_the_player() {
    let (mut mascot, recorded) = recorder();
    mascot.destroy();
    assert!(recorded.borrow().destroyed);
}

#[test]
fn motion_needs_the_setting_on_and_reduce_motion_off_and_survives_a_failing_system_read() {
    let reduce = |prefers_reduced_motion: bool| {
        move || {
            Ok::<_, String>(AnimationSettings {
                prefers_reduced_motion,
            })
        }
    };
    assert!(motion_allowed(None, reduce(false)));
    assert!(motion_allowed(Some(true), reduce(false)));
    assert!(!motion_allowed(Some(false), reduce(false)));
    assert!(!motion_allowed(None, reduce(true)));
    assert!(motion_allowed(None, || Err::<AnimationSettings, _>(
        "unsupported"
    )));
}
