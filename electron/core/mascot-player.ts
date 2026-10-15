import type { MascotPose } from "../../shared/mascot";
import { BLINK_FRAME, POSE_FRAME, type MascotFrame } from "../../shared/mascot-frames";

/** The idle panda blinks this often, at a random moment in between. */
export const BLINK_MIN_MS = 3 * 60_000;
export const BLINK_MAX_MS = 6 * 60_000;
/** How long the eyes stay closed. */
export const BLINK_MS = 150;
/** A blink this late (the Mac slept) is skipped instead of played. */
export const LATE_FRAME_MS = 2_000;

export interface MascotPlayerDeps {
  show(frame: MascotFrame): void;
  /** Read right before each blink: the setting and macOS Reduce motion. */
  motionAllowed(): boolean;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
}

/** Shows the menu bar panda's pose; the idle panda blinks every few minutes. */
export class MascotPlayer {
  private pose: MascotPose = "idle";
  private shown?: MascotFrame;
  /** The tray refused the last image; the next update tries again. */
  private failed = false;
  private timer?: unknown;
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

  update(pose: MascotPose) {
    if (this.destroyed) return;
    if (pose === this.pose && !this.failed) return;
    this.pose = pose;
    this.rest();
  }

  destroy() {
    this.destroyed = true;
    this.clear();
  }

  /** The pose's frame, and a blink timer when idle. */
  private rest() {
    this.clear();
    if (this.show(POSE_FRAME[this.pose])) this.scheduleBlink();
  }

  private scheduleBlink() {
    if (this.pose !== "idle" || this.destroyed) return;
    const delay = BLINK_MIN_MS + this.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
    const due = this.now() + delay;
    this.timer = this.setTimer(() => this.blink(due), delay);
  }

  private blink(due: number) {
    this.timer = undefined;
    if (this.destroyed) return;
    if (this.now() - due > LATE_FRAME_MS || !this.deps.motionAllowed()) return this.scheduleBlink();
    if (!this.show(BLINK_FRAME)) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.show(POSE_FRAME[this.pose])) this.scheduleBlink();
    }, BLINK_MS);
  }

  private clear() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** False when the tray refused the image. */
  private show(frame: MascotFrame) {
    if (frame === this.shown && !this.failed) return true;
    try {
      this.deps.show(frame);
      this.shown = frame;
      this.failed = false;
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }
}
