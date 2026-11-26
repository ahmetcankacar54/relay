//! Port of tests/mascot-player.test.ts.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use relay_core::mascot_player::{AWAY_HOLD_MS, MascotPlayer, MascotPlayerHost};
use relay_core::shared::mascot::MascotPose;
use relay_core::shared::mascot_frames::MascotFrame;

#[derive(Default)]
struct World {
    now: f64,
    motion: bool,
    failing: bool,
    id: u64,
    randoms: VecDeque<f64>,
    /// Handle → when it is due; handles grow, so the map keeps the order timers were set in.
    timers: BTreeMap<u64, f64>,
    shown: Vec<MascotFrame>,
}

struct Host(Rc<RefCell<World>>);

impl MascotPlayerHost for Host {
    type Error = &'static str;
    fn show(&mut self, frame: MascotFrame) -> Result<(), Self::Error> {
        let mut world = self.0.borrow_mut();
        if world.failing {
            return Err("tray destroyed");
        }
        world.shown.push(frame);
        Ok(())
    }
    fn motion_allowed(&mut self) -> bool {
        self.0.borrow().motion
    }
    fn now(&mut self) -> f64 {
        self.0.borrow().now
    }
    fn set_timeout(&mut self, ms: f64) -> u64 {
        let mut world = self.0.borrow_mut();
        world.id += 1;
        let (id, at) = (world.id, world.now + ms);
        world.timers.insert(id, at);
        id
    }
    fn clear_timeout(&mut self, handle: u64) {
        self.0.borrow_mut().timers.remove(&handle);
    }
    fn random(&mut self) -> f64 {
        self.0.borrow_mut().randoms.pop_front().unwrap_or(0.0)
    }
}

struct Harness {
    player: MascotPlayer<Host>,
    world: Rc<RefCell<World>>,
}

fn harness(random: &[f64]) -> Harness {
    let world = Rc::new(RefCell::new(World {
        motion: true,
        randoms: random.iter().copied().collect(),
        ..World::default()
    }));
    Harness {
        player: MascotPlayer::new(Host(world.clone())),
        world,
    }
}

use MascotFrame::{Alert, Away, Blink, Full, Hungry, Idle, Sleep};

impl Harness {
    fn shown(&self) -> Vec<MascotFrame> {
        self.world.borrow().shown.clone()
    }
    fn last(&self) -> Option<MascotFrame> {
        self.world.borrow().shown.last().copied()
    }
    fn timers(&self) -> usize {
        self.world.borrow().timers.len()
    }
    /// Fire due timers in order, as the event loop would.
    fn advance(&mut self, ms: f64) {
        let end = self.world.borrow().now + ms;
        loop {
            let due = {
                let world = self.world.borrow();
                world
                    .timers
                    .iter()
                    .filter(|(_, at)| **at <= end)
                    .min_by(|a, b| a.1.total_cmp(b.1))
                    .map(|(id, at)| (*id, *at))
            };
            let Some((id, at)) = due else { break };
            {
                let mut world = self.world.borrow_mut();
                world.timers.remove(&id);
                world.now = world.now.max(at);
            }
            self.player.fire(id);
        }
        self.world.borrow_mut().now = end;
    }
    /// Move the clock without firing timers, as while the Mac sleeps.
    fn sleep(&mut self, ms: f64) {
        self.world.borrow_mut().now += ms;
    }
    fn set_motion(&mut self, motion: bool) {
        self.world.borrow_mut().motion = motion;
    }
    fn set_failing(&mut self, failing: bool) {
        self.world.borrow_mut().failing = failing;
    }
}

#[test]
fn the_idle_panda_blinks_for_a_moment_every_three_to_six_minutes() {
    let mut h = harness(&[]);
    assert_eq!(h.shown(), [Idle]);
    h.advance(3.0 * 60_000.0 - 1.0);
    assert_eq!(h.shown(), [Idle]);
    h.advance(1.0);
    assert_eq!(h.shown(), [Idle, Blink]);
    h.advance(150.0);
    assert_eq!(h.shown(), [Idle, Blink, Idle]);
    h.advance(3.0 * 60_000.0);
    assert_eq!(h.shown(), [Idle, Blink, Idle, Blink]);
    let mut late = harness(&[1.0]);
    late.advance(6.0 * 60_000.0 - 1.0);
    assert_eq!(late.shown(), [Idle]);
    late.advance(1.0);
    assert_eq!(late.last(), Some(Blink));
}

#[test]
fn every_pose_shows_its_still_frame_and_only_idle_blinks() {
    let mut h = harness(&[]);
    for pose in [
        MascotPose::Hungry,
        MascotPose::Full,
        MascotPose::Sleeping,
        MascotPose::Alert,
        MascotPose::Away,
    ] {
        h.player.update(pose);
        assert_eq!(h.timers(), 0, "{}", pose.as_str());
    }
    // Away holds its happy face first.
    h.player.update(MascotPose::Warming);
    h.advance(AWAY_HOLD_MS);
    assert_eq!(h.timers(), 0);
    h.player.update(MascotPose::Idle);
    assert_eq!(h.shown(), [Idle, Hungry, Full, Sleep, Alert, Away, Idle]);
    assert_eq!(h.timers(), 1);
}

#[test]
fn the_happy_face_stays_two_seconds_after_a_desktop_operation_ends_then_shows_the_latest_pose() {
    let mut h = harness(&[]);
    h.player.update(MascotPose::Away);
    h.player.update(MascotPose::Idle);
    h.advance(1_000.0);
    h.player.update(MascotPose::Full);
    h.advance(AWAY_HOLD_MS - 1_000.0 - 1.0);
    assert_eq!(h.shown(), [Idle, Away]);
    h.advance(1.0);
    assert_eq!(h.shown(), [Idle, Away, Full]);
    assert_eq!(h.timers(), 0);
}

#[test]
fn an_alert_or_a_new_operation_ends_the_hold_at_once() {
    let mut h = harness(&[]);
    h.player.update(MascotPose::Away);
    h.player.update(MascotPose::Idle);
    h.player.update(MascotPose::Alert);
    assert_eq!(h.shown(), [Idle, Away, Alert]);
    assert_eq!(h.timers(), 0);
    h.player.update(MascotPose::Away);
    h.player.update(MascotPose::Hungry);
    h.player.update(MascotPose::Away);
    assert_eq!(h.timers(), 0);
    h.advance(AWAY_HOLD_MS);
    assert_eq!(h.shown(), [Idle, Away, Alert, Away]);
    h.player.destroy();
    h.player.update(MascotPose::Idle);
    assert_eq!(h.timers(), 0);
}

#[test]
fn without_motion_the_panda_does_not_blink() {
    let mut h = harness(&[]);
    h.set_motion(false);
    h.advance(20.0 * 60_000.0);
    assert_eq!(h.shown(), [Idle]);
    assert_eq!(h.timers(), 1);
    h.set_motion(true);
    h.advance(6.0 * 60_000.0);
    assert_eq!(h.last(), Some(Idle));
    assert!(h.shown().contains(&Blink));
}

#[test]
fn a_blink_that_comes_due_long_after_the_mac_slept_is_skipped() {
    let mut h = harness(&[]);
    h.sleep(10.0 * 60_000.0);
    h.advance(0.0);
    assert_eq!(h.shown(), [Idle]);
    assert_eq!(h.timers(), 1);
}

#[test]
fn a_pose_change_during_a_blink_rests_on_the_new_pose() {
    let mut h = harness(&[]);
    h.advance(3.0 * 60_000.0);
    assert_eq!(h.last(), Some(Blink));
    h.player.update(MascotPose::Hungry);
    h.advance(1000.0);
    assert_eq!(h.shown(), [Idle, Blink, Hungry]);
    assert_eq!(h.timers(), 0);
}

#[test]
fn a_refused_image_is_retried_on_the_next_update_even_for_the_same_pose() {
    let mut h = harness(&[]);
    h.set_failing(true);
    h.player.update(MascotPose::Hungry);
    assert_eq!(h.shown(), [Idle]);
    h.set_failing(false);
    h.player.update(MascotPose::Hungry);
    assert_eq!(h.shown(), [Idle, Hungry]);
}

#[test]
fn destroy_leaves_no_timers_and_ignores_later_updates() {
    let mut h = harness(&[]);
    h.player.destroy();
    assert_eq!(h.timers(), 0);
    h.player.update(MascotPose::Alert);
    assert_eq!(h.shown(), [Idle]);
}
