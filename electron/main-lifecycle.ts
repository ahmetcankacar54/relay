// Pure rules for the main window's page and for quitting; main.ts wires them to Electron.

/** How long after the last reload a crash still counts toward the reload budget, in ms. */
export const PAGE_RELOAD_WINDOW_MS = 60_000;
/** The wait before each reload in one window: the budget is spent after the last one. */
export const PAGE_RELOAD_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

export type PageCrashAction =
  | { action: "ignore" }
  | { action: "give-up" }
  | { action: "reload"; delayMs: number; reloadsAt: number[] };

/**
 * What to do when the main window's page process ends. A clean exit is left alone; a crash
 * reloads after a growing delay, at most `PAGE_RELOAD_DELAYS_MS.length` times within
 * `PAGE_RELOAD_WINDOW_MS`; past that, or when a reload cannot help, Relay gives up.
 * `reloadsAt` holds the earlier reloads' times; the returned list replaces it.
 */
export function pageCrashAction(
  reason: string,
  reloadsAt: readonly number[],
  now: number,
): PageCrashAction {
  if (reason === "clean-exit") return { action: "ignore" };
  // The page process cannot start, or its files are damaged: a reload cannot help.
  if (reason === "launch-failed" || reason === "integrity-failure") return { action: "give-up" };
  const recent = reloadsAt.filter((at) => now - at < PAGE_RELOAD_WINDOW_MS);
  const delayMs = PAGE_RELOAD_DELAYS_MS[recent.length];
  if (delayMs === undefined) return { action: "give-up" };
  return { action: "reload", delayMs, reloadsAt: [...recent, now] };
}

/** How long a system shutdown or restart signal lifts the quit safeguards, in ms. */
export const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Whether a quit now is part of the system shutdown signalled at `shutdownAt`. A shutdown the
 * user cancelled does not lift the safeguards for later quits.
 */
export function systemShuttingDown(shutdownAt: number | undefined, now: number): boolean {
  return shutdownAt !== undefined && now - shutdownAt >= 0 && now - shutdownAt < SHUTDOWN_GRACE_MS;
}
