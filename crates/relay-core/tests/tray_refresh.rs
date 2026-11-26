//! Port of tests/tray-refresh.test.ts. The TS snapshot step is sync or async; here it is one
//! blocking call, so "a failing snapshot" covers both of its throwing forms with one failing step.

use relay_core::tray_refresh::{TrayRefreshSteps, refresh_tray};

#[derive(Clone, Copy, PartialEq)]
enum Step {
    Works,
    Fails,
}

use Step::{Fails, Works};

struct Steps {
    current: bool,
    snapshot: Result<&'static str, ()>,
    mascot: Step,
    show: Step,
    unavailable: Step,
    calls: Vec<String>,
}

fn steps() -> Steps {
    Steps {
        current: true,
        snapshot: Ok("healthy"),
        mascot: Works,
        show: Works,
        unavailable: Works,
        calls: Vec::new(),
    }
}

impl Steps {
    fn call(&mut self, step: Step, call: String) -> Result<(), ()> {
        match step {
            Works => {
                self.calls.push(call);
                Ok(())
            }
            Fails => Err(()),
        }
    }
}

impl TrayRefreshSteps for Steps {
    type Snapshot = &'static str;
    type Error = ();
    fn current(&mut self) -> bool {
        self.current
    }
    fn snapshot(&mut self) -> Result<Self::Snapshot, ()> {
        self.snapshot
    }
    fn mascot_next(&mut self, snapshot: &&'static str) -> Result<(), ()> {
        self.call(self.mascot, format!("mascot:{snapshot}"))
    }
    fn mascot_unavailable(&mut self) -> Result<(), ()> {
        self.call(self.mascot, "mascot:unavailable".into())
    }
    fn show(&mut self, snapshot: &&'static str) -> Result<(), ()> {
        self.call(self.show, format!("show:{snapshot}"))
    }
    fn unavailable(&mut self) -> Result<(), ()> {
        self.call(self.unavailable, "menu:unavailable".into())
    }
}

#[test]
fn a_healthy_snapshot_feeds_the_panda_and_the_menu() {
    let mut s = steps();
    refresh_tray(&mut s);
    assert_eq!(s.calls, ["mascot:healthy", "show:healthy"]);
}

#[test]
fn a_throwing_panda_never_takes_down_a_healthy_menu_or_rejects() {
    let mut s = Steps {
        mascot: Fails,
        ..steps()
    };
    refresh_tray(&mut s);
    assert_eq!(s.calls, ["show:healthy"]);
}

#[test]
fn a_failing_menu_build_falls_back_without_telling_the_panda_the_snapshot_failed() {
    let mut s = Steps {
        show: Fails,
        ..steps()
    };
    refresh_tray(&mut s);
    assert_eq!(s.calls, ["mascot:healthy", "menu:unavailable"]);
}

#[test]
fn a_failing_snapshot_rests_the_panda_and_shows_the_fallback_menu() {
    let mut s = Steps {
        snapshot: Err(()),
        ..steps()
    };
    refresh_tray(&mut s);
    assert_eq!(s.calls, ["mascot:unavailable", "menu:unavailable"]);
}

#[test]
fn nothing_rejects_even_when_every_step_throws() {
    for snapshot in [Err(()), Ok("healthy")] {
        let mut s = Steps {
            snapshot,
            mascot: Fails,
            show: Fails,
            unavailable: Fails,
            ..steps()
        };
        refresh_tray(&mut s);
        assert!(s.calls.is_empty());
    }
}

#[test]
fn a_superseded_or_destroyed_tray_ignores_the_result() {
    for snapshot in [Ok("late"), Err(())] {
        let mut s = Steps {
            snapshot,
            current: false,
            ..steps()
        };
        refresh_tray(&mut s);
        assert!(s.calls.is_empty());
    }
}
