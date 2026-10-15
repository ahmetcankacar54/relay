/** The puppet poses Relay draws in the app; Codex delivers one SVG per pose. */
export const PANDA_POSES = ["sit", "stand", "curl", "walk", "peek", "chew", "head", "door"] as const;
export type PandaPose = (typeof PANDA_POSES)[number];

/** Expression groups inside every `eyes` part; the component shows one. */
export const PANDA_EXPRESSIONS = ["open", "closed", "happy", "worried", "wide"] as const;
export type PandaExpression = (typeof PANDA_EXPRESSIONS)[number];

/** Every rig file is drawn on a 512×512 canvas at one shared scale. */
export const PANDA_CANVAS = 512;

/** Each pose's moving parts (`data-part`, each with a `data-pivot`). */
export const POSE_PARTS: Record<PandaPose, readonly string[]> = {
  sit: ["tail", "head", "ear-left", "ear-right", "arm-left", "arm-right", "eyes"],
  stand: ["tail", "head", "arm-left", "arm-right", "eyes"],
  curl: ["tail", "body"],
  walk: ["tail", "head", "leg-front", "leg-back", "eyes"],
  peek: ["head", "ear-left", "ear-right", "paw-left", "paw-right", "eyes"],
  chew: ["head", "arm-left", "arm-right", "held", "eyes"],
  head: ["head", "ear-left", "ear-right", "eyes"],
  door: ["frame", "leaf", "knob"],
};

/** Each pose's props (`data-prop`), hidden unless a scene shows them. */
export const POSE_PROPS = {
  sit: ["bamboo", "notebook", "bowl", "rumble"],
  stand: ["bang", "fedora", "mustache", "sunglasses", "scarf", "deerstalker", "coat"],
  curl: ["z"],
  walk: ["bamboo", "wheel"],
  peek: [],
  chew: ["bamboo", "cursor", "cursor-bitten", "crumbs"],
  head: ["z", "bang"],
  door: [],
} as const satisfies Record<PandaPose, readonly string[]>;
export type PandaProp = (typeof POSE_PROPS)[PandaPose][number];

/** Disguise props fly off one by one, so each turns around its own pivot. */
export const DISGUISE_PROPS = ["fedora", "mustache", "sunglasses", "scarf", "deerstalker", "coat"] as const;

/** Parts and props that move with a part, so they must sit inside one of the named parts. */
export const POSE_NESTING: Partial<Record<PandaPose, Readonly<Record<string, readonly string[]>>>> = {
  sit: { bamboo: ["arm-left", "arm-right"] },
  walk: { bamboo: ["leg-front"] },
  chew: { bamboo: ["held"], cursor: ["held"], "cursor-bitten": ["held"] },
  door: { knob: ["leaf"] },
};
