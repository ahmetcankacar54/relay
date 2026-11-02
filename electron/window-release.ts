/** How long a closed main window stays loaded, so opening it again at once is instant. */
export const WINDOW_RELEASE_MS = 60_000;

export interface WindowReleaseOptions {
  /** The window exists and is not on screen. */
  hidden(): boolean;
  /** Something still reports to the window: a sign-in or a Desktop operation. */
  busy(): boolean;
  /** Destroys the window; the next showWindow creates it again. */
  release(): void;
  delayMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Frees the main window's renderer once it has stayed hidden a while. Opening it again loads
 * the page anew (under a second); a window still busy waits for another round.
 */
export class WindowRelease {
  private timer: unknown;
  private readonly set: (fn: () => void, ms: number) => unknown;
  private readonly clear: (handle: unknown) => void;
  constructor(private readonly options: WindowReleaseOptions) {
    this.set =
      options.setTimeout ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref();
        return handle;
      });
    this.clear =
      options.clearTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The window was hidden: release it later unless it is shown first. */
  arm() {
    this.cancel();
    this.timer = this.set(
      () => this.fire(),
      this.options.delayMs ?? WINDOW_RELEASE_MS,
    );
  }

  /** The window was shown or is gone. */
  cancel() {
    if (this.timer !== undefined) this.clear(this.timer);
    this.timer = undefined;
  }

  private fire() {
    this.timer = undefined;
    if (!this.options.hidden()) return;
    if (this.options.busy()) return this.arm();
    this.options.release();
  }
}
