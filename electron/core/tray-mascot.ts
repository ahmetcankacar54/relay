import {
  mascotStep,
  type DesktopEvent,
  type MascotInput,
  type MascotMemory,
  type MascotPose,
} from "../../shared/mascot";

export interface MascotSink {
  update(pose: MascotPose): void;
  destroy(): void;
}

/** Feeds the menu bar panda its pose, and Desktop operation events to a listener. */
export class TrayMascot {
  private memory?: MascotMemory;
  constructor(
    private readonly player: MascotSink,
    private readonly now: () => number = Date.now,
    private readonly onEvent?: (event: DesktopEvent) => void,
  ) {}

  next(input: MascotInput) {
    const step = mascotStep(this.memory, input, this.now());
    this.memory = step.memory;
    this.player.update(step.pose);
    if (step.event) this.onEvent?.(step.event);
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
