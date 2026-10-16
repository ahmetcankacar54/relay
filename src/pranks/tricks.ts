import { POSE_PARTS } from "../../shared/panda-poses";
import { MOTION_PARTS, type PandaSceneSpec } from "../mascot/scenes";

export type Trick = "swish" | "wave" | "happy" | "grumpy" | "hide" | "rawr";

/** How long one trick plays. */
export const TRICK_MS = 1_200;
/** The click count starts over after this long without a click. */
export const TRICK_RESET_MS = 30_000;

/** The click that earns the last trick; the click after it starts the count again. */
const LAST_CLICK = 10;

/** The count after a click at `now`: it grows with each click, and starts at 1 after a pause or the 10th click. */
export function nextClick(
  previous: { count: number; at: number } | undefined,
  now: number,
): { count: number; at: number } {
  if (!previous || now - previous.at >= TRICK_RESET_MS || previous.count >= LAST_CLICK) {
    return { count: 1, at: now };
  }
  return { count: previous.count + 1, at: now };
}

const RANDOM_TRICKS = ["swish", "wave", "happy"] as const satisfies readonly Trick[];

/** Clicks 1–3 draw swish, wave or happy; 4–6 are grumpy, 7–9 hide, and the 10th is rawr. */
export function trickFor(count: number, random: () => number): Trick {
  if (count >= LAST_CLICK) return "rawr";
  if (count >= 7) return "hide";
  if (count >= 4) return "grumpy";
  return RANDOM_TRICKS[Math.min(Math.floor(random() * RANDOM_TRICKS.length), RANDOM_TRICKS.length - 1)];
}

/** How a scene looks while a trick plays (pose, expression, motion, data-trick). Never changes `spec`. */
export function trickLook(spec: PandaSceneSpec, trick: Trick | undefined): PandaSceneSpec & { trick?: Trick } {
  if (trick === undefined) return spec;
  switch (trick) {
    case "happy":
      return { ...spec, expression: "happy", trick };
    case "grumpy":
      return { ...spec, expression: "worried", trick };
    case "wave":
      return { ...spec, motion: spec.motion.includes("wave") ? spec.motion : [...spec.motion, "wave"], trick };
    case "rawr":
      return {
        pose: "stand",
        expression: "wide",
        props: [],
        // Keep a motion only while the stand pose still has a part for it to move.
        motion: spec.motion.filter((motion) => MOTION_PARTS[motion].some((part) => POSE_PARTS.stand.includes(part))),
        trick,
      };
    case "swish":
    case "hide":
      return { ...spec, trick };
  }
}
