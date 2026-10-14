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
 * panel, then delivers the click. Ignore opens that land within 250 ms of a hide
 * so that click closes the panel instead of reopening it.
 */
export class ToggleGuard {
  private hiddenAt = -Infinity;
  shouldOpen(now: number) {
    return now - this.hiddenAt > 250;
  }
  hidden(now: number) {
    this.hiddenAt = now;
  }
}
/** Left tray click: the popover once it has loaded, else today's native menu. */
export function trayClickAction(panelUsable: boolean): "toggle" | "menu" {
  return panelUsable ? "toggle" : "menu";
}
