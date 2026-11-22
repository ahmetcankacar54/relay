// Kept free of browser-only imports so it can be unit tested under Node.
/**
 * Runs one action at a time. Resolves true once `fn` resolved (a failed refresh after it is
 * shown but does not undo that), false when another action held the lock and nothing ran, or
 * when `fn` failed and its error is shown.
 */
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
  return async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true;
    deps.setBusy(key);
    deps.setError("");
    deps.setNotice("");
    let done = false;
    try {
      await fn();
      done = true;
      await deps.refresh();
    } catch (e) {
      deps.showError(e);
    } finally {
      lock.current = false;
      deps.setBusy("");
    }
    return done;
  };
}

/**
 * How a call through `relayAction` went: it ran, the lock refused it while another action ran
 * (nothing ran), or it failed (its error is shown).
 */
export type ActionOutcome = "ran" | "refused" | "failed";

/**
 * `action` with its outcome told apart, for a caller that tries again: only a refused call may be
 * tried again; a failed one was tried and its error shown.
 */
export function attemptAction(
  action: (key: string, fn: () => Promise<unknown>) => Promise<boolean>,
) {
  return async (key: string, fn: () => Promise<unknown>): Promise<ActionOutcome> => {
    let started = false;
    const done = await action(key, () => {
      started = true;
      return fn();
    });
    return done ? "ran" : started ? "failed" : "refused";
  };
}

/**
 * One read at a time; calls while one runs share exactly one follow-up, since a change seen
 * meanwhile may be newer than what the running read sees. A read applies its result only when
 * nothing made it stale: no local change bumped `epoch` since it started, and no follow-up is
 * queued (an action's change after it started; the follow-up applies the newer state).
 */
export function serialRead<T>(
  epoch: { current: number },
  read: () => Promise<T>,
  apply: (value: T) => void,
): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  let followUp: Promise<T> | undefined;
  const run = () => {
    const started = epoch.current;
    const request = read().then((value) => {
      if (started === epoch.current && !followUp) apply(value);
      return value;
    });
    inFlight = request;
    const settle = () => {
      if (inFlight === request) inFlight = undefined;
    };
    request.then(settle, settle);
    return request;
  };
  return () => {
    if (followUp) return followUp;
    const running = inFlight;
    if (!running) return run();
    const next = running
      .catch(() => undefined)
      .then(() => {
        followUp = undefined;
        return run();
      });
    followUp = next;
    return next;
  };
}

/**
 * Runs a call that changes no Relay state (opening a page or a link, quitting) outside the
 * action lock, so a running action never swallows it: no busy key, no refresh. A failure is
 * shown like an action's.
 */
export function relayReport(showError: (e: unknown) => void) {
  return async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      showError(e);
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
    /** The visibilitychange event, or a reported show. */
    shown() {
      if (visibility() === "hidden" || !dirty) return;
      dirty = false;
      refresh();
    },
  };
}

/**
 * The menu bar panel's visibility as main reports it. The panel window is created hidden, and
 * its document reads "visible" until it is first shown, so it counts as hidden until main
 * reports it shown, then follows each report.
 */
export function reportedVisibility() {
  let shown = false;
  return {
    visibility: (): DocumentVisibilityState => (shown ? "visible" : "hidden"),
    report(next: boolean) {
      shown = next;
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
