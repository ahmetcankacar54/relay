/** Why an action the user started is refused while another Desktop operation runs. */
export const DESKTOP_HANDOFF =
  "Finish the Desktop handoff before starting another Desktop operation.";

/**
 * Relay's Desktop lock: one Desktop operation at a time, in the order they ask. A draft
 * restore takes it per record, and only when it is free, so it never holds anything up for
 * long. An action the user starts during a restore record waits for that record and then runs;
 * the restore's next record finds the lock taken and stops, leaving the rest pending.
 */
export class DesktopLock {
  private tail: Promise<void> = Promise.resolve();
  private holder?: "operation" | "restore";
  /** Callers holding the lock or waiting for it. */
  private count = 0;
  /** Of those, the ones that are not a draft restore. */
  private others = 0;
  private begun = 0;
  /** `changed` is told inside the lock as each holder begins, and as it ends. */
  constructor(private readonly changed: () => void = () => {}) {}

  /** Something holds the lock, a draft restore included. */
  get active(): boolean {
    return this.holder !== undefined;
  }
  /** A draft restore holds the lock. */
  get restoring(): boolean {
    return this.holder === "restore";
  }
  /**
   * An operation other than a draft restore holds the lock or waits for it: what the user is
   * shown as Desktop being busy, and what refuses the user's own Desktop actions.
   */
  get busy(): boolean {
    return this.others > 0;
  }
  /** Callers holding the lock or waiting for it. */
  get callers(): number {
    return this.count;
  }
  /** Operations other than draft restores begun so far; it only grows. */
  get operations(): number {
    return this.begun;
  }

  /** Runs `action` holding the lock, once every caller before it is done. */
  run<T>(action: () => Promise<T>): Promise<T> {
    return this.hold(action, "operation");
  }

  /**
   * Runs an action the user started. It is refused while another operation holds the lock or
   * waits for it, and then when `refuse` gives a reason; behind a draft restore it waits.
   */
  manual<T>(
    action: () => Promise<T>,
    refuse?: () => Error | undefined,
  ): Promise<T> {
    if (this.busy) return Promise.reject(new Error(DESKTOP_HANDOFF));
    const refused = refuse?.();
    if (refused) return Promise.reject(refused);
    return this.hold(action, "operation");
  }

  /**
   * The draft restorer's `withLock`: undefined at once, without running `fn`, when anything
   * holds the lock or waits for it, or `free()` says Desktop is busy. Otherwise `fn` runs
   * holding it, and whatever `fn` throws, an Error or not, comes out unchanged.
   */
  restore<T>(
    fn: () => Promise<T>,
    free: () => boolean = () => true,
  ): Promise<T | undefined> {
    if (this.count > 0 || !free()) return Promise.resolve(undefined);
    return this.hold(fn, "restore");
  }

  private async hold<T>(
    action: () => Promise<T>,
    kind: "operation" | "restore",
  ): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.count++;
    if (kind === "operation") this.others++;
    await before;
    this.holder = kind;
    if (kind === "operation") this.begun++;
    try {
      this.tell();
      return await action();
    } finally {
      this.holder = undefined;
      this.count--;
      if (kind === "operation") this.others--;
      release();
      this.tell();
    }
  }

  private tell(): void {
    try {
      this.changed();
    } catch {
      // A listener never changes how a Desktop operation ends.
    }
  }
}
