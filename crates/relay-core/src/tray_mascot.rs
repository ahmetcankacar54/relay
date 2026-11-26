//! Port of `electron/core/tray-mascot.ts`: feeds the menu bar panda the pose for each tray
//! snapshot, reads Desktop state for a snapshot, and says whether the panda may move.

use crate::shared::mascot::{MascotInput, MascotPose, mascot_pose};

/// What shows the poses (`MascotPlayer`).
pub trait MascotSink {
    fn update(&mut self, pose: MascotPose);
    fn destroy(&mut self);
}

/// Feeds the menu bar panda the pose for each tray snapshot.
pub struct TrayMascot<P: MascotSink> {
    player: P,
    now: Box<dyn Fn() -> f64 + Send>,
}

impl<P: MascotSink> TrayMascot<P> {
    /// On the wall clock (`Date.now`).
    pub fn new(player: P) -> Self {
        Self::with_clock(player, Box::new(|| crate::clock::now_ms() as f64))
    }

    pub fn with_clock(player: P, now: Box<dyn Fn() -> f64 + Send>) -> Self {
        TrayMascot { player, now }
    }

    pub fn player(&self) -> &P {
        &self.player
    }

    pub fn next(&mut self, input: MascotInput<'_>) {
        let pose = mascot_pose(input, (self.now)());
        self.player.update(pose);
    }

    /// The snapshot could not be read: rest on idle.
    pub fn unavailable(&mut self) {
        self.player.update(MascotPose::Idle);
    }

    pub fn destroy(&mut self) {
        self.player.destroy();
    }
}

/// A Desktop state read for a tray snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopForTray<T> {
    pub state: T,
    pub busy: bool,
}

/// Reads Desktop state for a tray snapshot. A read that overlapped an operation counts as busy:
/// its state may predate the switch. A failed read is the read's error.
pub fn read_desktop_for_tray<T, E>(
    read: impl FnOnce() -> Result<T, E>,
    busy: impl Fn() -> bool,
    operations: impl Fn() -> u64,
) -> Result<DesktopForTray<T>, E> {
    let before = operations();
    let busy_before = busy();
    let state = read()?;
    Ok(DesktopForTray {
        state,
        busy: busy_before || busy() || operations() != before,
    })
}

/// What `motion_allowed` reads of the system (Electron's `getAnimationSettings()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AnimationSettings {
    pub prefers_reduced_motion: bool,
}

/// The setting (`menuBarAnimation`) must not be off and macOS Reduce motion must be off; a system
/// read that fails allows motion.
pub fn motion_allowed<E>(
    menu_bar_animation: Option<bool>,
    animation: impl FnOnce() -> Result<AnimationSettings, E>,
) -> bool {
    if menu_bar_animation == Some(false) {
        return false;
    }
    animation().map_or(true, |a| !a.prefers_reduced_motion)
}
