/**
 * The panda's looping motion runs only while someone can see it. A hidden window can keep
 * painting every frame of an infinite animation: the menu bar panel's document reads "visible"
 * until the panel is first shown. `data-motion-paused` on <html> holds every panda still
 * (theme.css); other animations run on.
 */
export const MOTION_PAUSED = "data-motion-paused";

export function setMotionPaused(
  paused: boolean,
  root: Pick<Element, "toggleAttribute"> = document.documentElement,
) {
  root.toggleAttribute(MOTION_PAUSED, paused);
}

type Listener = () => void;
interface Target {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

/**
 * The main window: still while it is hidden or another app is in front. Returns the cleanup.
 */
export function pauseMotionWithoutAttention(
  win: Target = window,
  doc: Target &
    Pick<Document, "visibilityState" | "hasFocus" | "documentElement"> = document,
) {
  const sync = () =>
    setMotionPaused(
      doc.visibilityState !== "visible" || !doc.hasFocus(),
      doc.documentElement,
    );
  win.addEventListener("focus", sync);
  win.addEventListener("blur", sync);
  doc.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    win.removeEventListener("focus", sync);
    win.removeEventListener("blur", sync);
    doc.removeEventListener("visibilitychange", sync);
  };
}
