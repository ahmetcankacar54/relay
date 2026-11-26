//! Port of `electron/core/mascot-player.ts`: shows the menu bar panda's pose; the idle panda
//! blinks every few minutes, and the happy face of a Desktop operation stays a moment after it
//! ends.
//!
//! Timers belong to the host: `set_timeout` starts one and returns its handle, and the host calls
//! `MascotPlayer::fire` with that handle when it is due (the TS callback).

use crate::shared::mascot::MascotPose;
use crate::shared::mascot_frames::{BLINK_FRAME, MascotFrame, pose_frame};
use crate::shared::switch_scene::math_random;
use crate::tray_mascot::MascotSink;

/// The idle panda blinks this often, at a random moment in between.
pub const BLINK_MIN_MS: f64 = 3.0 * 60_000.0;
pub const BLINK_MAX_MS: f64 = 6.0 * 60_000.0;
/// How long the eyes stay closed.
pub const BLINK_MS: f64 = 150.0;
/// A blink this late (the Mac slept) is skipped instead of played.
pub const LATE_FRAME_MS: f64 = 2_000.0;
/// The happy face stays this long after a Desktop operation ends, unless an alert takes over.
pub const AWAY_HOLD_MS: f64 = 2_000.0;

/// What the player runs on: the tray image, the motion setting, the clock and one timer.
pub trait MascotPlayerHost {
    type Error;
    /// An error is the tray refusing the image; the next update tries again.
    fn show(&mut self, frame: MascotFrame) -> Result<(), Self::Error>;
    /// Read right before each blink: the setting and macOS Reduce motion.
    fn motion_allowed(&mut self) -> bool;
    fn now(&mut self) -> f64 {
        crate::clock::now_ms() as f64
    }
    /// Starts a timer of `ms`; when it is due the host calls `MascotPlayer::fire(handle)`.
    fn set_timeout(&mut self, ms: f64) -> u64;
    fn clear_timeout(&mut self, handle: u64);
    /// `Math.random()`.
    fn random(&mut self) -> f64 {
        math_random()
    }
}

/// What the running timer does when it fires.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Due {
    /// The happy face's hold ends.
    Hold,
    /// The idle panda blinks; `due` is when it should.
    Blink { due: f64 },
    /// The eyes open again.
    Unblink,
}

pub struct MascotPlayer<H: MascotPlayerHost> {
    host: H,
    pose: MascotPose,
    /// The pose waiting for the happy face's hold to end.
    after: Option<MascotPose>,
    shown: Option<MascotFrame>,
    /// The tray refused the last image; the next update tries again.
    failed: bool,
    timer: Option<(u64, Due)>,
    destroyed: bool,
}

impl<H: MascotPlayerHost> MascotPlayer<H> {
    pub fn new(host: H) -> Self {
        let mut player = MascotPlayer {
            host,
            pose: MascotPose::Idle,
            after: None,
            shown: None,
            failed: false,
            timer: None,
            destroyed: false,
        };
        player.rest();
        player
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    pub fn update(&mut self, pose: MascotPose) {
        if self.destroyed {
            return;
        }
        if self.pose == MascotPose::Away && pose != MascotPose::Away && pose != MascotPose::Alert {
            return self.hold(pose);
        }
        // Back to away, or an alert: the hold, if any, ends here.
        if self.after.is_some() {
            self.after = None;
            self.clear();
        }
        if pose == self.pose && !self.failed {
            return;
        }
        self.pose = pose;
        self.rest();
    }

    /// The timer `handle` is due; a handle that is no longer the running timer does nothing.
    pub fn fire(&mut self, handle: u64) {
        let Some((_, due)) = self.timer.filter(|(running, _)| *running == handle) else {
            return;
        };
        self.timer = None;
        match due {
            Due::Hold => {
                if self.destroyed {
                    return;
                }
                let Some(after) = self.after.take() else {
                    return;
                };
                self.pose = after;
                self.rest();
            }
            Due::Blink { due } => self.blink(due),
            Due::Unblink => {
                if self.show(pose_frame(self.pose)) {
                    self.schedule_blink();
                }
            }
        }
    }

    /// Keeps the happy face for AWAY_HOLD_MS after the operation ended, then shows the latest pose.
    fn hold(&mut self, next: MascotPose) {
        self.after = Some(next);
        if self.failed {
            self.show(pose_frame(MascotPose::Away));
        }
        if self.timer.is_some() {
            return;
        }
        let handle = self.host.set_timeout(AWAY_HOLD_MS);
        self.timer = Some((handle, Due::Hold));
    }

    pub fn destroy(&mut self) {
        self.destroyed = true;
        self.clear();
    }

    /// The pose's frame, and a blink timer when idle.
    fn rest(&mut self) {
        self.clear();
        if self.show(pose_frame(self.pose)) {
            self.schedule_blink();
        }
    }

    fn schedule_blink(&mut self) {
        if self.pose != MascotPose::Idle || self.destroyed {
            return;
        }
        let delay = BLINK_MIN_MS + self.host.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
        let due = self.host.now() + delay;
        let handle = self.host.set_timeout(delay);
        self.timer = Some((handle, Due::Blink { due }));
    }

    fn blink(&mut self, due: f64) {
        if self.destroyed {
            return;
        }
        if self.host.now() - due > LATE_FRAME_MS || !self.host.motion_allowed() {
            return self.schedule_blink();
        }
        if !self.show(BLINK_FRAME) {
            return;
        }
        let handle = self.host.set_timeout(BLINK_MS);
        self.timer = Some((handle, Due::Unblink));
    }

    fn clear(&mut self) {
        if let Some((handle, _)) = self.timer.take() {
            self.host.clear_timeout(handle);
        }
    }

    /// False when the tray refused the image.
    fn show(&mut self, frame: MascotFrame) -> bool {
        if Some(frame) == self.shown && !self.failed {
            return true;
        }
        match self.host.show(frame) {
            Ok(()) => {
                self.shown = Some(frame);
                self.failed = false;
                true
            }
            Err(_) => {
                self.failed = true;
                false
            }
        }
    }
}

impl<H: MascotPlayerHost> MascotSink for MascotPlayer<H> {
    fn update(&mut self, pose: MascotPose) {
        MascotPlayer::update(self, pose);
    }

    fn destroy(&mut self) {
        MascotPlayer::destroy(self);
    }
}
