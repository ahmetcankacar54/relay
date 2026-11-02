import { mascotPose, type MascotInput, type MascotPose } from "../../shared/mascot";

export interface MascotSink {
  update(pose: MascotPose): void;
  destroy(): void;
}

/** Feeds the menu bar panda the pose for each tray snapshot. */
export class TrayMascot {
  constructor(
    private readonly player: MascotSink,
    private readonly now: () => number = Date.now,
  ) {}

  next(input: MascotInput) {
    this.player.update(mascotPose(input, this.now()));
  }

  /** The snapshot could not be read: rest on idle. */
  unavailable() {
    this.player.update("idle");
  }

  destroy() {
    this.player.destroy();
  }
}

/**
 * Reads Desktop state for a tray snapshot. A read that overlapped an operation
 * counts as busy: its state may predate the switch.
 */
export async function readDesktopForTray<T>(deps: {
  read(): Promise<T>;
  busy(): boolean;
  operations(): number;
}): Promise<{ state: T; busy: boolean }> {
  const before = deps.operations();
  const busyBefore = deps.busy();
  const state = await deps.read();
  return { state, busy: busyBefore || deps.busy() || deps.operations() !== before };
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
