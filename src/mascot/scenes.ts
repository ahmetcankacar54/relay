import type { PandaExpression, PandaPose, PandaProp } from "../../shared/panda-poses";

/** The light CSS motions (src/styles/panda.css) and the parts each one moves. */
export const MOTION_PARTS = {
  blink: ["eyes"],
  tail: ["tail"],
  wave: ["arm-left"],
  look: ["head"],
  nod: ["head"],
  walk: ["leg-front", "leg-back"],
  chew: ["head", "held"],
  breathe: ["body"],
} as const satisfies Record<string, readonly string[]>;
export type PandaMotion = keyof typeof MOTION_PARTS;

export interface PandaSceneSpec {
  pose: PandaPose;
  expression: PandaExpression;
  props: readonly PandaProp[];
  motion: readonly PandaMotion[];
}

/** The in-app scenes; the switch window builds its own from walk, stand and door. */
export const PANDA_SCENES = {
  welcome: { pose: "sit", expression: "happy", props: ["bamboo"], motion: ["wave", "blink", "tail"] },
  lookout: { pose: "sit", expression: "open", props: [], motion: ["look", "blink", "tail"] },
  collecting: { pose: "sit", expression: "open", props: ["notebook"], motion: ["nod", "blink"] },
  trouble: { pose: "stand", expression: "wide", props: ["bang"], motion: [] },
  travel: { pose: "walk", expression: "open", props: ["bamboo"], motion: [] },
  "head-idle": { pose: "head", expression: "open", props: [], motion: ["blink"] },
  "head-hungry": { pose: "head", expression: "worried", props: [], motion: ["blink"] },
  "head-sleep": { pose: "head", expression: "closed", props: ["z"], motion: [] },
  "head-alert": { pose: "head", expression: "wide", props: ["bang"], motion: [] },
} as const satisfies Record<string, PandaSceneSpec>;
export type PandaScene = keyof typeof PANDA_SCENES;
