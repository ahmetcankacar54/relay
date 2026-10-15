import {
  mascotStep,
  type MascotCue,
  type MascotInput,
  type MascotMemory,
  type MascotPose,
} from "../../shared/mascot";

export interface MascotSink {
  update(pose: MascotPose, cue?: MascotCue): void;
  destroy(): void;
}

/** Feeds the menu bar panda the pose and one-off cue of each tray snapshot. */
export class TrayMascot {
  private memory?: MascotMemory;
  constructor(
    private readonly player: MascotSink,
    private readonly now: () => number = Date.now,
  ) {}

  next(input: MascotInput) {
    const step = mascotStep(this.memory, input, this.now());
    this.memory = step.memory;
    this.player.update(step.pose, step.cue);
  }

  /** The snapshot could not be read: rest on idle, keep the memory for the next one. */
  unavailable() {
    this.player.update("idle");
  }

  destroy() {
    this.player.destroy();
  }
}

/**
 * Reads Desktop state for a tray snapshot with the Desktop operation count. A
 * read that overlapped an operation counts as busy: its state may predate the
 * switch, so the panda only returns on a later read.
 */
export async function readDesktopForTray<T>(deps: {
  read(): Promise<T>;
  busy(): boolean;
  operations(): number;
}): Promise<{ state: T; busy: boolean; operations: number }> {
  const before = deps.operations();
  const busyBefore = deps.busy();
  const state = await deps.read();
  const operations = deps.operations();
  return { state, busy: busyBefore || deps.busy() || operations !== before, operations };
}

/** The setting must not be off and macOS Reduce motion must be off. */
export function motionAllowed(
  settings: { menuBarAnimation?: boolean },
  animation: () => { prefersReducedMotion: boolean },
) {
  if (settings.menuBarAnimation === false) return false;
  try {
    return !animation().prefersReducedMotion;
  } catch {
    return true;
  }
}
