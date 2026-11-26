//! Port of `shared/mascot-frames.ts`: the menu bar panda's frames and the frame each pose shows.

use serde::{Deserialize, Serialize};

use super::mascot::MascotPose;
use super::types::literal_enum;

/// Menu bar frame canvas in points; rendered at 1x, 2x and 3x, then trimmed on the right.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MascotFrameSize {
    pub width: u32,
    pub height: u32,
}

pub const MASCOT_FRAME_SIZE: MascotFrameSize = MascotFrameSize {
    width: 24,
    height: 20,
};

literal_enum!(
    /// One menu bar frame: the red panda head with one expression. "away", a Desktop operation such
    /// as a switch, is the happy face; "full", a used-up five-hour window, the wide eyes with a clock.
    MascotFrame {
        Idle = "idle",
        Blink = "blink",
        Hungry = "hungry",
        Sleep = "sleep",
        Alert = "alert",
        Away = "away",
        Full = "full",
    }
);

/// Every menu bar frame, in the TS order.
pub const MASCOT_FRAMES: [MascotFrame; 7] = [
    MascotFrame::Idle,
    MascotFrame::Blink,
    MascotFrame::Hungry,
    MascotFrame::Sleep,
    MascotFrame::Alert,
    MascotFrame::Away,
    MascotFrame::Full,
];

/// The frame each pose shows, in the TS record's key order. Warming shows the normal head.
pub const POSE_FRAME: [(MascotPose, MascotFrame); 7] = [
    (MascotPose::Idle, MascotFrame::Idle),
    (MascotPose::Warming, MascotFrame::Idle),
    (MascotPose::Hungry, MascotFrame::Hungry),
    (MascotPose::Full, MascotFrame::Full),
    (MascotPose::Sleeping, MascotFrame::Sleep),
    (MascotPose::Alert, MascotFrame::Alert),
    (MascotPose::Away, MascotFrame::Away),
];

/// `POSE_FRAME[pose]`.
pub const fn pose_frame(pose: MascotPose) -> MascotFrame {
    match pose {
        MascotPose::Idle | MascotPose::Warming => MascotFrame::Idle,
        MascotPose::Hungry => MascotFrame::Hungry,
        MascotPose::Full => MascotFrame::Full,
        MascotPose::Sleeping => MascotFrame::Sleep,
        MascotPose::Alert => MascotFrame::Alert,
        MascotPose::Away => MascotFrame::Away,
    }
}

/// Shown for a moment when the idle panda blinks.
pub const BLINK_FRAME: MascotFrame = MascotFrame::Blink;
