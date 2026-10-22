import path from "node:path";

/**
 * Loads widget-center.node, which asks WidgetKit to reload Relay's widgets:
 * one kind, or every kind when called without one.
 * The call must come from Relay's own main process: chronod refuses it from a
 * helper executable (ChronoCoreErrorDomain 10). Undefined where the addon is
 * missing or cannot load; the widget then refreshes itself every 15 minutes.
 */
export function loadWidgetCenter(
  dir: string,
  load: (file: string) => unknown = require,
): ((kind?: string) => void) | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const addon = load(path.join(dir, "widget-center.node")) as {
      reloadTimelines?: unknown;
    };
    const reload = addon?.reloadTimelines;
    if (typeof reload !== "function") throw new Error("no reloadTimelines");
    // Without an argument the addon reloads every timeline.
    return (kind) => void (kind === undefined ? reload() : reload(kind));
  } catch (error) {
    console.warn(
      "Relay widget reloads are off; the widget refreshes itself.",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
