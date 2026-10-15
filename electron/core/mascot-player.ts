import type { MascotCue, MascotPose } from "../../shared/mascot";
import {
  CUE_SEQUENCE,
  DISGUISES,
  POSE_FIDGETS,
  POSE_FRAME,
  POSE_LOOP,
  returnSequence,
  type Disguise,
  type MascotFrame,
  type MascotSequence,
} from "../../shared/mascot-frames";

/** A loop longer than this rests on its still frame until the pose changes. */
export const LOOP_LIMIT_MS = 60_000;
export const FIDGET_MIN_MS = 3 * 60_000;
export const FIDGET_MAX_MS = 6 * 60_000;
/** A frame this late (the Mac slept) drops its sequence instead of catching up. */
export const LATE_FRAME_MS = 2_000;

export interface MascotPlayerDeps {
  show(frame: MascotFrame): void;
  /** Read before every frame: the setting and macOS Reduce motion. */
  motionAllowed(): boolean;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
}

interface Playing {
  kind: "loop" | "once" | "fidget";
  sequence: MascotSequence;
  index: number;
  startedAt: number;
  dueAt: number;
}

/** Plays the menu bar panda: still poses, loops, one-off cues and fidgets. */
export class MascotPlayer {
  private pose: MascotPose = "idle";
  private shown?: MascotFrame;
  private playing?: Playing;
  private frameTimer?: unknown;
  private fidgetTimer?: unknown;
  private fidgetTurn = 0;
  private disguise?: Disguise;
  private destroyed = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly random: () => number;

  constructor(private readonly deps: MascotPlayerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = deps.random ?? Math.random;
    this.rest();
  }

  update(pose: MascotPose, cue?: MascotCue) {
    if (this.destroyed) return;
    const changed = pose !== this.pose;
    this.pose = pose;
    if (cue && this.deps.motionAllowed())
      return this.play("once", cue === "return" ? returnSequence(this.nextDisguise()) : CUE_SEQUENCE[cue]);
    if (!changed) return;
    // A one-off finishes first; it returns to whatever the pose is then.
    if (this.playing?.kind === "once") return;
    this.rest();
  }

  destroy() {
    this.destroyed = true;
    this.stop();
  }

  /** A random disguise, never the previous one. */
  private nextDisguise() {
    const options = DISGUISES.filter((d) => DISGUISES.length < 2 || d !== this.disguise);
    const pick = options[Math.min(options.length - 1, Math.floor(this.random() * options.length))];
    this.disguise = pick;
    return pick;
  }

  /** The pose's loop when motion is allowed, else its still frame and a fidget timer. */
  private rest() {
    this.stop();
    const loop = POSE_LOOP[this.pose];
    if (loop && this.deps.motionAllowed()) return this.play("loop", loop);
    if (this.show(POSE_FRAME[this.pose])) this.scheduleFidget();
  }

  private play(kind: Playing["kind"], sequence: MascotSequence) {
    this.stop();
    const now = this.now();
    this.playing = { kind, sequence, index: 0, startedAt: now, dueAt: now };
    this.step();
  }

  private step() {
    this.frameTimer = undefined;
    const playing = this.playing;
    if (!playing || this.destroyed) return;
    const now = this.now();
    const late = now - playing.dueAt > LATE_FRAME_MS;
    const tooLong = playing.kind === "loop" && now - playing.startedAt >= LOOP_LIMIT_MS;
    if (late || tooLong || !this.deps.motionAllowed()) {
      this.playing = undefined;
      // A loop cut short stays still until the pose changes; anything else may fidget.
      if (this.show(POSE_FRAME[this.pose]) && !POSE_LOOP[this.pose]) this.scheduleFidget();
      return;
    }
    if (playing.index >= playing.sequence.frames.length) {
      if (playing.kind !== "loop") {
        this.playing = undefined;
        return this.rest();
      }
      playing.index = 0;
    }
    if (!this.show(playing.sequence.frames[playing.index++])) {
      this.playing = undefined;
      return;
    }
    const interval = 1000 / playing.sequence.fps;
    playing.dueAt = now + interval;
    this.frameTimer = this.setTimer(() => this.step(), interval);
  }

  private scheduleFidget() {
    if (this.fidgetTimer !== undefined) this.clearTimer(this.fidgetTimer);
    this.fidgetTimer = undefined;
    const fidgets = POSE_FIDGETS[this.pose];
    if (!fidgets?.length || this.destroyed) return;
    const delay = FIDGET_MIN_MS + this.random() * (FIDGET_MAX_MS - FIDGET_MIN_MS);
    this.fidgetTimer = this.setTimer(() => {
      this.fidgetTimer = undefined;
      if (this.playing || this.destroyed) return;
      if (!this.deps.motionAllowed()) return this.scheduleFidget();
      this.play("fidget", fidgets[this.fidgetTurn++ % fidgets.length]);
    }, delay);
  }

  private stop() {
    if (this.frameTimer !== undefined) this.clearTimer(this.frameTimer);
    if (this.fidgetTimer !== undefined) this.clearTimer(this.fidgetTimer);
    this.frameTimer = this.fidgetTimer = undefined;
    this.playing = undefined;
  }

  /** False when the tray refused the image; the caller stops its sequence. */
  private show(frame: MascotFrame) {
    if (frame === this.shown) return true;
    try {
      this.deps.show(frame);
      this.shown = frame;
      return true;
    } catch {
      return false;
    }
  }
}
