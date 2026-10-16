import type { DesktopOperationKind, DesktopRestartEvent } from "./types";

export const LEAVING_MS = 1_200;
/** After this long behind the closed door the window hides; the menu bar keeps the door. */
export const WAITING_LIMIT_MS = 60_000;
export const RETURNING_MS = { switched: 2_500, back: 1_500, failed: 4_000 } as const;
export const CLOSING_MS = 300;

/** Each disguise is a pair of props worn on the standing panda. */
export const DISGUISES = {
  fedora: ["fedora", "mustache"],
  sunglasses: ["sunglasses", "scarf"],
  deerstalker: ["deerstalker", "coat"],
} as const;
export type Disguise = keyof typeof DISGUISES;
export type SwitchOutcome = "switched" | "back" | "failed";
/** `stalled`: still waiting after the limit, with the window hidden. */
export type SwitchStage = "hidden" | "leaving" | "waiting" | "stalled" | "returning" | "closing";

export interface SwitchSceneState {
  stage: SwitchStage;
  /** When the stage began. */
  since: number;
  /** Counts stories, so the window restarts its animations for a new one. */
  story: number;
  kind?: DesktopOperationKind;
  /** The switch target; the line names it. */
  profileId?: string;
  /** The result, once the operation ended (it may end while the panda still walks). */
  outcome?: SwitchOutcome;
  disguise?: Disguise;
  /** Never worn twice in a row. */
  lastDisguise?: Disguise;
}
export const INITIAL_SCENE: SwitchSceneState = { stage: "hidden", since: 0, story: 0 };

export type SwitchSceneEvent = DesktopRestartEvent | { phase: "tick" };

/** A random disguise other than the previous one. */
export function pickDisguise(previous?: Disguise, random: () => number = Math.random): Disguise {
  const choices = (Object.keys(DISGUISES) as Disguise[]).filter((d) => d !== previous);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}

/** When the stage ends by itself; undefined while it waits for an event. */
export function sceneDeadline(state: SwitchSceneState): number | undefined {
  switch (state.stage) {
    case "leaving":
      return state.since + LEAVING_MS;
    case "waiting":
      return state.since + WAITING_LIMIT_MS;
    case "returning":
      return state.since + RETURNING_MS[state.outcome ?? "back"];
    case "closing":
      return state.since + CLOSING_MS;
    default:
      return undefined;
  }
}

function returning(state: SwitchSceneState, at: number, pick: (previous?: Disguise) => Disguise): SwitchSceneState {
  const disguise = state.outcome === "switched" ? pick(state.lastDisguise) : undefined;
  return { ...state, stage: "returning", since: at, disguise, lastDisguise: disguise ?? state.lastDisguise };
}

/** Finishes every stage whose time is up at `now`; a late timer skips what it slept through. */
function catchUp(state: SwitchSceneState, now: number, pick: (previous?: Disguise) => Disguise): SwitchSceneState {
  let next = state;
  for (let deadline = sceneDeadline(next); deadline !== undefined && deadline <= now; deadline = sceneDeadline(next)) {
    if (next.stage === "leaving")
      next = next.outcome ? returning(next, deadline, pick) : { ...next, stage: "waiting", since: deadline };
    else if (next.stage === "waiting") next = { ...next, stage: "stalled", since: deadline };
    else if (next.stage === "returning") next = { ...next, stage: "closing", since: deadline };
    else next = { ...next, stage: "hidden", since: deadline };
  }
  return next;
}

/** One step of the story: a restart report or a timer tick at `now`. */
export function switchScene(
  state: SwitchSceneState,
  event: SwitchSceneEvent,
  now: number,
  pick: (previous?: Disguise) => Disguise = pickDisguise,
): SwitchSceneState {
  if (event.phase === "start")
    return {
      stage: "leaving",
      since: now,
      story: state.story + 1,
      kind: event.kind,
      profileId: event.profileId,
      lastDisguise: state.lastDisguise,
    };
  const current = catchUp(state, now, pick);
  if (event.phase === "end") {
    // The timer may not have run yet, so the end first sees the stage it really arrives in.
    const outcome: SwitchOutcome = !event.ok ? "failed" : event.kind === "switch" ? "switched" : "back";
    if (current.stage === "leaving") return { ...current, outcome };
    if (current.stage === "waiting" || current.stage === "stalled") return returning({ ...current, outcome }, now, pick);
    return current; // an end without its start
  }
  return current;
}

export type SwitchLanguage = "tr" | "en";
const LINES = {
  tr: {
    restarting: "Claude yeniden başlatılıyor…",
    switching: (name: string) => `${name} hesabına geçiliyor`,
    switched: (name: string) => `${name} hesabındasın`,
    back: "Claude yeniden açıldı",
    failed: "İşlem tamamlanamadı · ayrıntılar Relay’de",
  },
  en: {
    restarting: "Restarting Claude…",
    switching: (name: string) => `Switching to ${name}`,
    switched: (name: string) => `You’re on ${name}`,
    back: "Claude reopened",
    failed: "Couldn’t finish · details in Relay",
  },
};

const returned = (state: SwitchSceneState) => state.stage === "returning" || state.stage === "closing";

/** The line under the scene; an account that is gone falls back to the general lines. */
export function sceneLine(
  state: SwitchSceneState,
  language: SwitchLanguage,
  name: (profileId: string) => string | undefined,
): string {
  const t = LINES[language];
  const target = state.profileId ? name(state.profileId) : undefined;
  if (returned(state)) {
    if (state.outcome === "failed") return t.failed;
    return state.outcome === "switched" && target ? t.switched(target) : t.back;
  }
  if (state.stage === "hidden" || state.stage === "stalled") return "";
  return state.kind === "switch" && target ? t.switching(target) : t.restarting;
}

/** What the switch window draws; sent to its page as is. */
export interface SwitchSceneView {
  /** The stage is drawn on screen. */
  visible: boolean;
  stage: SwitchStage;
  story: number;
  outcome?: SwitchOutcome;
  disguise?: Disguise;
  line: string;
  /** Animate; otherwise each stage is one still image. */
  motion: boolean;
}

export function sceneView(
  state: SwitchSceneState,
  context: { language: SwitchLanguage; name: (profileId: string) => string | undefined; motion: boolean },
): SwitchSceneView {
  return {
    visible: state.stage === "leaving" || state.stage === "waiting" || returned(state),
    stage: state.stage,
    story: state.story,
    outcome: returned(state) ? state.outcome : undefined,
    disguise: returned(state) ? state.disguise : undefined,
    line: sceneLine(state, context.language, context.name),
    motion: context.motion,
  };
}

/** The window shows a drawn stage only with its page ready, the setting on and the menu bar panel closed. */
export function switchWindowVisible(
  view: Pick<SwitchSceneView, "visible"> | undefined,
  window: { loaded: boolean; enabled: boolean; panelOpen: boolean },
) {
  return !!view?.visible && window.loaded && window.enabled && !window.panelOpen;
}

export interface SwitchStoryOptions {
  /** Each new state of the story. */
  show(state: SwitchSceneState): void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  pick?: (previous?: Disguise) => Disguise;
}

/** Runs the story: one timer for the current stage, a new state for every change. */
export class SwitchStory {
  private state = INITIAL_SCENE;
  private timer: unknown;
  constructor(private readonly options: SwitchStoryOptions) {}

  get current() {
    return this.state;
  }

  report(event: DesktopRestartEvent) {
    this.step(event);
  }

  /** Re-reads the clock now (the timer calls this; so can a preview that moves its clock). */
  tick() {
    this.step({ phase: "tick" });
  }

  destroy() {
    if (this.timer !== undefined) (this.options.clearTimeout ?? clearTimeout)(this.timer as never);
    this.timer = undefined;
  }

  private step(event: SwitchSceneEvent) {
    const now = (this.options.now ?? Date.now)();
    const next = switchScene(this.state, event, now, this.options.pick);
    const changed = next !== this.state;
    this.state = next;
    this.destroy();
    const deadline = sceneDeadline(next);
    if (deadline !== undefined)
      this.timer = (this.options.setTimeout ?? setTimeout)(() => this.tick(), Math.max(0, deadline - now));
    if (!changed) return;
    try {
      this.options.show(next);
    } catch {
      // The story is decoration; it never breaks a Desktop operation.
    }
  }
}

/** The switch window's preload API: scenes in, one ready signal out. */
export interface RelaySwitchAPI {
  onScene(callback: (view: SwitchSceneView) => void): () => void;
  /** The page listens; send the story so far. */
  ready(): void;
}
declare global {
  interface Window {
    relaySwitch?: RelaySwitchAPI;
  }
}
