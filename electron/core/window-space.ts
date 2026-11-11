import path from "node:path";

/**
 * Whether a window that is on screen is on the Space the user is looking at, from its
 * getNativeWindowHandle(). Undefined when it cannot tell (the window is not on screen, the
 * handle is not a view).
 */
export type ActiveSpaceCheck = (handle: Buffer) => boolean | undefined;

/**
 * Loads window-space.node. Undefined where the addon is missing or cannot load: a panel that
 * macOS puts on no Space then stays unseen until Relay restarts, as before the addon.
 */
export function loadWindowSpace(
  dir: string,
  load: (file: string) => unknown = require,
): ActiveSpaceCheck | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const addon = load(path.join(dir, "window-space.node")) as {
      onActiveSpace?: unknown;
    };
    const check = addon?.onActiveSpace;
    if (typeof check !== "function") throw new Error("no onActiveSpace");
    return (handle) => {
      const answer: unknown = check(handle);
      return typeof answer === "boolean" ? answer : undefined;
    };
  } catch (error) {
    console.warn(
      "Relay cannot check which Space its menu bar panel is on.",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
