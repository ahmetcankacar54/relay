export interface TrayRefreshSteps<S> {
  /** Still the newest refresh of a live tray. */
  current(): boolean;
  snapshot(): S | Promise<S>;
  /** The menu bar panda; it never decides what the menu shows. */
  mascot?: { next(snapshot: S): void; unavailable(): void };
  /** Title, tooltip and menu for a snapshot. */
  show(snapshot: S): void;
  /** The fallback menu when the snapshot or its menu could not be built. */
  unavailable(): void;
}

function quietly(step: () => void) {
  try {
    step();
  } catch {
    // Each part fails alone; the tray keeps what it had.
  }
}

/**
 * One tray refresh. Only a failed snapshot rests the panda; a failing panda
 * never turns a healthy snapshot into the fallback menu. Never rejects.
 */
export async function refreshTray<S>(steps: TrayRefreshSteps<S>): Promise<void> {
  let snapshot: S;
  try {
    snapshot = await steps.snapshot();
  } catch {
    if (!steps.current()) return;
    quietly(() => steps.mascot?.unavailable());
    quietly(() => steps.unavailable());
    return;
  }
  if (!steps.current()) return;
  quietly(() => steps.mascot?.next(snapshot));
  try {
    steps.show(snapshot);
  } catch {
    quietly(() => steps.unavailable());
  }
}
