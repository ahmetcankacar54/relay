import type { MascotPose } from "./mascot";

/** Menu bar frame canvas in points; rendered at 1x, 2x and 3x, then trimmed on the right (scripts/mascot-assets.ts). */
export const MASCOT_FRAME_SIZE = { width: 24, height: 20 } as const;

/** Every menu bar frame: one red panda head and a door. Codex delivers one file per name. */
export const MASCOT_FRAMES = ["idle", "blink", "hungry", "sleep", "alert", "away"] as const;
export type MascotFrame = (typeof MASCOT_FRAMES)[number];

/** The frame each pose shows. Warming shows the normal head. */
export const POSE_FRAME: Record<MascotPose, MascotFrame> = {
  idle: "idle",
  warming: "idle",
  hungry: "hungry",
  sleeping: "sleep",
  alert: "alert",
  away: "away",
};

/** Shown for a moment when the idle panda blinks. */
export const BLINK_FRAME: MascotFrame = "blink";
