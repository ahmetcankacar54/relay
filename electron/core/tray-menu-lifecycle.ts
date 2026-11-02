interface MenuVersion<T> {
  fingerprint: string;
  value: T;
}

interface TrayMenuLifecycleOptions<T> {
  apply(value: T, generation: number): void;
  schedule(callback: () => void): void;
  onApplyError?(error: unknown): void;
}

/** Replacing a macOS tray menu releases its native controller, which cancels an
 * open menu. Keep the current menu until tracking has ended, and avoid replacing
 * it at all when polling produces the same visible items and commands. */
export class TrayMenuLifecycle<T> {
  private current?: MenuVersion<T> & { generation: number };
  private pending?: MenuVersion<T>;
  private generation = 0;
  private openGeneration?: number;
  private closingGeneration?: number;
  private destroyed = false;

  constructor(private readonly options: TrayMenuLifecycleOptions<T>) {}

  update(value: T, fingerprint: string) {
    if (this.destroyed) return;
    if (this.current?.fingerprint === fingerprint) {
      // The newest poll may undo a change queued while the menu was open.
      this.pending = undefined;
      return;
    }
    if (
      this.openGeneration !== undefined ||
      this.closingGeneration !== undefined
    ) {
      this.pending = { value, fingerprint };
      return;
    }
    this.install({ value, fingerprint });
  }

  opened(generation: number) {
    if (this.destroyed || this.current?.generation !== generation) return;
    this.openGeneration = generation;
  }

  closed(generation: number) {
    if (
      this.destroyed ||
      this.current?.generation !== generation ||
      this.openGeneration !== generation
    )
      return;
    this.openGeneration = undefined;
    // Even a poll arriving from another close listener must wait until the
    // native close callback has returned. The menu may reopen before this runs.
    this.closingGeneration = generation;
    this.options.schedule(() => {
      if (
        this.destroyed ||
        this.current?.generation !== generation ||
        this.closingGeneration !== generation
      )
        return;
      this.closingGeneration = undefined;
      if (this.openGeneration !== undefined) return;
      const pending = this.pending;
      this.pending = undefined;
      if (pending && pending.fingerprint !== this.current.fingerprint) {
        try {
          this.install(pending);
        } catch (error) {
          this.options.onApplyError?.(error);
        }
      }
    });
  }

  destroy() {
    this.destroyed = true;
    this.pending = undefined;
    this.openGeneration = undefined;
    this.closingGeneration = undefined;
  }

  private install(version: MenuVersion<T>) {
    const previous = this.current;
    const generation = ++this.generation;
    this.current = { ...version, generation };
    try {
      this.options.apply(version.value, generation);
    } catch (error) {
      this.current = previous;
      throw error;
    }
  }
}
