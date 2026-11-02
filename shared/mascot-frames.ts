import type { MascotPose } from "./mascot";

/** Menu bar frame canvas in points; rendered at 1x, 2x and 3x, then trimmed on the right (scripts/mascot-assets.ts). */
export const MASCOT_FRAME_SIZE = { width: 24, height: 20 } as const;

/**
 * Every menu bar frame: the red panda head with one expression (scripts/mascot-tray-from-rig.ts builds them from
 * the rig's head). "away", a Desktop operation such as a switch, is the happy face; "full", a used-up five-hour
 * window, the wide eyes with a small clock beside them.
 */
export const MASCOT_FRAMES = ["idle", "blink", "hungry", "sleep", "alert", "away", "full"] as const;
export type MascotFrame = (typeof MASCOT_FRAMES)[number];

/** The frame each pose shows. Warming shows the normal head. */
export const POSE_FRAME: Record<MascotPose, MascotFrame> = {
  idle: "idle",
  warming: "idle",
  hungry: "hungry",
  full: "full",
  sleeping: "sleep",
  alert: "alert",
  away: "away",
};

/** Shown for a moment when the idle panda blinks. */
export const BLINK_FRAME: MascotFrame = "blink";
