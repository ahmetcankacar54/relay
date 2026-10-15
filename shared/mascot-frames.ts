import type { MascotCue, MascotPose } from "./mascot";

/** Menu bar frame size in points; rendered at 1x, 2x and 3x. */
export const MASCOT_FRAME_SIZE = { width: 24, height: 20 } as const;

/** Costumes the panda returns in after a switch; each has four frames. */
export const DISGUISES = ["fedora", "shades", "detective"] as const;
export type Disguise = (typeof DISGUISES)[number];

/** Every menu bar frame. Codex delivers one file per name (see docs/mascot/codex-brief.md). */
export const MASCOT_FRAMES = [
  "idle", "blink-0", "blink-1", "ear-0", "ear-1", "wash-0", "wash-1", "wash-2", "tail-0", "tail-1",
  "exit-0", "exit-1", "exit-2", "exit-3", "away-0", "away-1",
  "enter-fedora-0", "enter-fedora-1", "toss-fedora-0", "toss-fedora-1",
  "enter-shades-0", "enter-shades-1", "toss-shades-0", "toss-shades-1",
  "enter-detective-0", "enter-detective-1", "toss-detective-0", "toss-detective-1",
  "bow-0", "bow-1",
  "warm-0", "warm-1", "warm-2", "warm-3", "stretch-0", "stretch-1", "stretch-2",
  "hungry", "rumble-0", "rumble-1", "rumble-2", "rumble-3",
  "munch-0", "munch-1", "munch-2", "munch-3",
  "sleep", "curl-0", "curl-1", "curl-2", "snore-0", "snore-1", "snore-2",
  "alert", "rise-0", "rise-1",
] as const;
export type MascotFrame = (typeof MASCOT_FRAMES)[number];

/** A sequence; a repeated frame holds it for another tick. */
export interface MascotSequence {
  frames: readonly MascotFrame[];
  fps: number;
}

/** The still frame of each pose; also shown when motion is not allowed. */
export const POSE_FRAME: Record<MascotPose, MascotFrame> = {
  idle: "idle",
  away: "away-0",
  warming: "warm-0",
  hungry: "hungry",
  sleeping: "sleep",
  alert: "alert",
};

/** Poses that loop while they last (cut to the still frame after 60 s). */
export const POSE_LOOP: Partial<Record<MascotPose, MascotSequence>> = {
  away: { frames: ["away-0", "away-1"], fps: 2 },
  warming: { frames: ["warm-0", "warm-1", "warm-2", "warm-3"], fps: 8 },
};

/** One-off sequences; `return` depends on the disguise (see returnSequence). */
export const CUE_SEQUENCE: Record<Exclude<MascotCue, "return">, MascotSequence> = {
  rise: { frames: ["rise-0", "rise-1"], fps: 8 },
  leave: { frames: ["exit-0", "exit-1", "exit-2", "exit-3"], fps: 8 },
  stretch: { frames: ["stretch-0", "stretch-1", "stretch-2"], fps: 8 },
  munch: {
    frames: ["munch-0", "munch-1", "munch-2", "munch-3", "munch-0", "munch-1", "munch-2", "munch-3"],
    fps: 8,
  },
  curl: { frames: ["curl-0", "curl-1", "curl-2"], fps: 8 },
  rumble: { frames: ["rumble-0", "rumble-1", "rumble-2", "rumble-3"], fps: 8 },
};

/** Back through the door in a disguise: look around, fling it off, bow. */
export function returnSequence(disguise: Disguise): MascotSequence {
  const enter0 = `enter-${disguise}-0` as const;
  const enter1 = `enter-${disguise}-1` as const;
  return {
    frames: [enter0, enter1, enter1, enter1, `toss-${disguise}-0`, `toss-${disguise}-1`, "bow-0", "bow-1", "bow-1"],
    fps: 4,
  };
}

/** Short fidgets played every few minutes, in turn. Alert has none: it stays still. */
export const POSE_FIDGETS: Partial<Record<MascotPose, readonly MascotSequence[]>> = {
  idle: [
    { frames: ["blink-0", "blink-1", "blink-0"], fps: 8 },
    { frames: ["ear-0", "ear-1"], fps: 8 },
    { frames: ["wash-0", "wash-1", "wash-2", "wash-1", "wash-2", "wash-0"], fps: 8 },
    { frames: ["tail-0", "tail-1", "tail-0"], fps: 8 },
  ],
  hungry: [CUE_SEQUENCE.rumble],
  sleeping: [{ frames: ["snore-0", "snore-1", "snore-2"], fps: 4 }],
};
