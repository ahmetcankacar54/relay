export const PANEL_WIDTH = 360;
export interface Rect { x: number; y: number; width: number; height: number }
const EDGE = 8;
const GAP = 4;
/** Below the tray icon, centred on it, kept inside the work area. */
export function panelPosition(tray: Rect, workArea: Rect, size: { width: number; height: number }) {
  const centred = Math.round(tray.x + tray.width / 2 - size.width / 2);
  const x = Math.min(Math.max(centred, workArea.x + EDGE), workArea.x + workArea.width - size.width - EDGE);
  const below = tray.y + tray.height + GAP;
  const y = Math.max(workArea.y, Math.min(below, workArea.y + workArea.height - size.height - EDGE));
  return { x, y };
}
export function clampPanelHeight(height: number, workAreaHeight: number) {
  return Math.min(Math.max(Math.ceil(height), 200), workAreaHeight - 16);
}
/**
 * Clicking the tray icon while the panel is open first blurs (and hides) the
 * panel, then delivers the click. Ignore opens that land within 400 ms of a hide
 * so that click closes the panel instead of reopening it; 400 ms (not 250) also
 * covers a slow, long-press click whose mouse-up arrives late.
 */
export const TOGGLE_GUARD_MS = 400;
export class ToggleGuard {
  private hiddenAt = -Infinity;
  shouldOpen(now: number) {
    return now - this.hiddenAt > TOGGLE_GUARD_MS;
  }
  /**
   * `byTrayClick` false (the panel lost focus to a click somewhere else, or Esc) arms nothing:
   * the user's next tray click, however soon, must open the panel.
   */
  hidden(now: number, byTrayClick = false) {
    this.hiddenAt = byTrayClick ? now : -Infinity;
  }
}
/** Whether the pointer is over the tray icon, with a little slack around it. */
export function pointerOnTray(tray: Rect | undefined, point: { x: number; y: number }, slack = 4) {
  if (!tray) return false;
  return (
    point.x >= tray.x - slack &&
    point.x <= tray.x + tray.width + slack &&
    point.y >= tray.y - slack &&
    point.y <= tray.y + tray.height + slack
  );
}

/**
 * How long after opening the panel a blur under the tray icon is treated as part
 * of the opening click (AppKit status item tracking ending, focus settling), not a
 * click to close. A human cannot see the panel and click to close it within this window.
 */
export const PANEL_OPEN_GUARD_MS = 300;

/**
 * What a blur event on the panel window should do:
 * - If the pointer is over the tray icon right after opening (< PANEL_OPEN_GUARD_MS),
 *   the blur is a transient artifact of the opening click; ignore it so the panel stays open.
 * - If the pointer is over the tray icon after the panel has been open for a while, the user
 *   clicked the tray icon to close the panel: hide it and arm the toggle guard.
 * - Otherwise (clicked into another app, Esc, etc.), hide the panel without arming the toggle guard.
 */
export function panelBlurAction(params: {
  openedAt: number;
  now: number;
  tray: Rect | undefined;
  cursor: { x: number; y: number };
}): "ignore" | "hide-by-tray" | "hide" {
  if (pointerOnTray(params.tray, params.cursor)) {
    return params.now - params.openedAt < PANEL_OPEN_GUARD_MS
      ? "ignore"
      : "hide-by-tray";
  }
  return "hide";
}
/**
 * macOS can order the panel in on no Space at all: it counts as shown, nothing draws it, and
 * every later show of the same window does the same until Relay restarts. A new window lands on
 * the Space as it should, so the panel's window is made again and opens once it has painted.
 * At most one rebuild per this long, so a Mac that keeps every new window off the Space does not
 * reload the panel on every click.
 */
export const PANEL_REBUILD_GAP_MS = 10_000;
/** How long after the click a rebuilt panel may still open by itself. */
export const PANEL_PENDING_OPEN_MS = 5_000;
/** A shown panel that is not on the active Space: make its window again, or only hide it. */
export function panelOffSpaceAction(sinceRebuild: number): "rebuild" | "hide" {
  return sinceRebuild < PANEL_REBUILD_GAP_MS ? "hide" : "rebuild";
}
/** Whether a rebuilt panel that has just painted should still open for the click that rebuilt it. */
export function pendingOpenDue(pending: { at: number } | undefined, now: number) {
  return !!pending && now - pending.at <= PANEL_PENDING_OPEN_MS;
}
/** Left tray click: the popover once it has loaded, else today's native menu. */
export function trayClickAction(panelUsable: boolean): "toggle" | "menu" {
  return panelUsable ? "toggle" : "menu";
}

/**
 * Panel renderer lifecycle. `painted` is the first `relay:panel-size` message,
 * which the renderer sends only after its first layout, so did-finish-load alone
 * never makes the panel usable. One renderer crash reloads it; a second crash
 * keeps it unusable (native menu) until a tray click revives it (`panelRevival`).
 *
 * `start` is a new document in the main frame (Electron's `did-navigate`), never
 * `did-start-loading`: that one also fires for a change of the address inside the page and
 * for a navigation Relay refuses, after which the page stays as it was and never reports a
 * size again, so the panel stayed unusable for the rest of the session.
 */
export interface PanelLoadState {
  phase: "loading" | "ready" | "failed" | "reloading";
  crashes: number;
}
export type PanelLoadEvent = "start" | "finish" | "painted" | "fail" | "gone";
export const INITIAL_PANEL_LOAD: PanelLoadState = { phase: "loading", crashes: 0 };
export const MAX_PANEL_CRASHES = 2;
export function panelLoadState(prev: PanelLoadState, event: PanelLoadEvent): PanelLoadState {
  if (prev.crashes >= MAX_PANEL_CRASHES) return prev;
  switch (event) {
    case "start":
      return { ...prev, phase: "loading" };
    case "finish":
      return prev;
    case "painted":
      return prev.phase === "loading" || prev.phase === "ready" ? { ...prev, phase: "ready" } : prev;
    case "fail":
      return { ...prev, phase: "failed" };
    case "gone": {
      const crashes = prev.crashes + 1;
      return { phase: crashes >= MAX_PANEL_CRASHES ? "failed" : "reloading", crashes };
    }
  }
}

/** How long a panel may stay unpainted with nothing loading before a tray click reloads it. */
export const PANEL_STUCK_MS = 5_000;
/** At most one revival per this long: a page that cannot load is not reloaded on every click. */
export const PANEL_REVIVE_GAP_MS = 10_000;
/**
 * What a tray click does for a panel that cannot open, so the next click finds it working:
 * make its window again when it is gone, or load its page again when that failed, crashed out
 * or never painted. Undefined while it is still loading normally or was revived a moment ago.
 */
export function panelRevival(panel: {
  phase: PanelLoadState["phase"];
  /** The window exists. */
  alive: boolean;
  /** Its page is loading right now. */
  pageLoading: boolean;
  /** How long it has not been ready, in ms. */
  unreadyFor: number;
  /** How long ago it was last revived, in ms. */
  sinceRevival: number;
}): "recreate" | "reload" | undefined {
  if (panel.sinceRevival < PANEL_REVIVE_GAP_MS) return;
  if (!panel.alive) return "recreate";
  if (panel.phase === "ready") return;
  if (panel.phase === "failed") return "reload";
  return !panel.pageLoading && panel.unreadyFor >= PANEL_STUCK_MS ? "reload" : undefined;
}
