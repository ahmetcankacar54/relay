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
