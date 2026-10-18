// Kept free of browser-only imports so it can be unit tested under Node.
export function relayAction(
  lock: { current: boolean },
  deps: {
    setBusy(k: string): void;
    setError(e: string): void;
    setNotice(n: string): void;
    refresh(): Promise<unknown>;
    showError(e: unknown): void;
  },
) {
  return async (key: string, fn: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    deps.setBusy(key);
    deps.setError("");
    deps.setNotice("");
    try {
      await fn();
      await deps.refresh();
    } catch (e) {
      deps.showError(e);
    } finally {
      lock.current = false;
      deps.setBusy("");
    }
  };
}

/**
 * The error to show after a background refresh succeeded. A refresh's own earlier failure is
 * over once a refresh works again; an error something else set in the meantime stays.
 */
export function errorAfterRefresh(
  current: string,
  refreshError: string | undefined,
): string {
  return refreshError !== undefined && current === refreshError ? "" : current;
}

/**
 * Refreshes for a broadcast at once while the window is visible. A hidden window only
 * remembers that something changed, and refreshes once when it is shown again.
 */
export function hiddenRefresh(
  visibility: () => DocumentVisibilityState,
  refresh: () => void,
) {
  let dirty = false;
  return {
    /** A broadcast, or a poll skipped while hidden. */
    changed() {
      if (visibility() === "hidden") dirty = true;
      else refresh();
    },
    /** The visibilitychange event. */
    shown() {
      if (visibility() === "hidden" || !dirty) return;
      dirty = false;
      refresh();
    },
  };
}

/** A window that passes pollWhenHidden false skips its poll while it is hidden. */
export function shouldPoll(
  options: { pollWhenHidden?: boolean },
  visibility: DocumentVisibilityState,
): boolean {
  return options.pollWhenHidden !== false || visibility !== "hidden";
}
