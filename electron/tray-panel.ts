import { BrowserWindow, screen } from "electron";
import {
  clampPanelHeight,
  INITIAL_PANEL_LOAD,
  PANEL_WIDTH,
  panelLoadState,
  panelPosition,
  panelRevival,
  pointerOnTray,
  ToggleGuard,
  type PanelLoadEvent,
  type Rect,
} from "../shared/tray-panel";

export interface TrayPanelOptions {
  preload: string;
  /** Loads panel.html (dev server or built file) into the window. */
  load(win: BrowserWindow): void;
  /** The panel was shown or hidden. */
  onVisibilityChange?(): void;
  /** Something that keeps the panel from opening, for the private diagnosis log. */
  onEvent?(event: string, fields: Record<string, unknown>): void;
  now?: () => number;
}

/** The macOS menu bar popover: one hidden window, shown under the tray icon. */
export class TrayPanel {
  private win?: BrowserWindow;
  private anchor?: Rect;
  /** Ready only once the renderer has painted (sent its first size). */
  private load = INITIAL_PANEL_LOAD;
  private readonly guard = new ToggleGuard();
  private readonly now: () => number;
  private readonly onVisibilityChange?: () => void;
  /** When the panel last stopped being ready (or was made); a ready panel does not use it. */
  private unreadySince: number;
  private revivedAt = -Infinity;

  constructor(private readonly options: TrayPanelOptions) {
    this.now = options.now ?? Date.now;
    this.onVisibilityChange = options.onVisibilityChange;
    this.unreadySince = this.now();
    this.create();
  }

  private create() {
    const options = this.options;
    this.load = INITIAL_PANEL_LOAD;
    this.unreadySince = this.now();
    const win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: 520,
      frame: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      fullscreenable: false,
      // NSWindowStyleMaskNonactivatingPanel: the panel can become key (blur and
      // Esc keep working) without activating Relay, so opening it never raises
      // the main window or pulls focus away from the app the user is in.
      type: "panel",
      transparent: true,
      backgroundColor: "#00000000",
      vibrancy: "popover",
      visualEffectState: "active",
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.win = win;
    win.setAlwaysOnTop(true, "pop-up-menu");
    // Also over full-screen Spaces; skipTransformProcessType keeps Relay from
    // being turned into a UIElement app (which would hide its Dock icon).
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // A new document only: did-start-loading also fires for navigations that change nothing.
    win.webContents.on("did-navigate", () => this.dispatch("start"));
    win.webContents.on("did-finish-load", () => this.dispatch("finish"));
    win.webContents.on(
      "did-fail-load",
      (_event, _code, _description, _url, mainFrame) => {
        if (mainFrame) this.dispatch("fail");
      },
    );
    win.webContents.on("render-process-gone", () => this.dispatch("gone"));
    // A blur from a click on the tray icon is followed by that click, which must not reopen the
    // panel; a blur from a click anywhere else must not swallow the next tray click.
    win.on("blur", () =>
      this.hide(pointerOnTray(this.anchor, screen.getCursorScreenPoint())),
    );
    win.on("closed", () => {
      if (this.win === win) this.win = undefined;
    });
    options.load(win);
  }

  /** Whether a tray click may open the panel; otherwise the native menu is used. */
  usable() {
    return this.load.phase === "ready" && !!this.live();
  }

  /**
   * A tray click found the panel unusable and showed the native menu instead. Brings the panel
   * back for the next click: its window again when that is gone, its page again when it failed,
   * crashed out or never painted.
   */
  revive() {
    const now = this.now();
    const win = this.live();
    const fields = {
      phase: this.load.phase,
      crashes: this.load.crashes,
      alive: !!win,
      pageLoading: !!win && !win.webContents.isDestroyed() && win.webContents.isLoading(),
      unreadyFor: now - this.unreadySince,
    };
    const action = panelRevival({ ...fields, sinceRevival: now - this.revivedAt });
    this.options.onEvent?.("tray-panel-unusable", { ...fields, action: action ?? "wait" });
    if (!action) return;
    this.revivedAt = now;
    try {
      if (action === "recreate" || !win) return this.create();
      this.load = INITIAL_PANEL_LOAD;
      this.unreadySince = now;
      win.webContents.reload();
    } catch (error) {
      this.options.onEvent?.("tray-panel-revive-failed", {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  toggle(trayBounds: Rect) {
    const win = this.live();
    if (!win) return;
    if (win.isVisible()) return this.hide();
    if (!this.guard.shouldOpen(this.now())) return;
    this.anchor = trayBounds;
    this.place(win);
    // showInactive + focus on a non-activating panel makes it key without
    // activating the app (plain show() would bring Relay and its main window
    // forward).
    win.showInactive();
    win.focus();
    this.reportVisibility(win, true);
    this.onVisibilityChange?.();
  }

  hide(byTrayClick = false) {
    const win = this.live();
    if (!win || !win.isVisible()) return;
    // Only the panel hides; never app.hide(), which would also hide the main
    // window. Focus returns to the previous app because Relay never activated.
    win.hide();
    this.guard.hidden(this.now(), byTrayClick);
    this.reportVisibility(win, false);
    this.onVisibilityChange?.();
  }

  /** Whether the panel is on screen. */
  isOpen() {
    return !!this.live()?.isVisible();
  }

  /** The renderer's size report; the first one marks the panel as painted. */
  setHeight(height: number) {
    const win = this.live();
    if (!win) return;
    this.dispatch("painted");
    const { workArea } = screen.getDisplayMatching(
      this.anchor ?? win.getBounds(),
    );
    win.setContentSize(PANEL_WIDTH, clampPanelHeight(height, workArea.height));
    if (this.anchor) this.place(win);
  }

  webContents(): Electron.WebContents | undefined {
    return this.live()?.webContents;
  }

  destroy() {
    const win = this.live();
    this.win = undefined;
    if (win) win.destroy();
  }

  private dispatch(event: PanelLoadEvent) {
    const before = this.load;
    this.load = panelLoadState(before, event);
    if (this.load.phase === "ready") return;
    if (before.phase === "ready") {
      this.unreadySince = this.now();
      this.options.onEvent?.("tray-panel-left-ready", { by: event, phase: this.load.phase });
    }
    this.hide();
    if (this.load.phase === "reloading" && before.phase !== "reloading")
      this.live()?.webContents.reload();
  }

  /**
   * Created hidden, the panel's document reads "visible" until it is first shown, so the
   * renderer polls by these reports instead.
   */
  private reportVisibility(win: BrowserWindow, shown: boolean) {
    if (!win.webContents.isDestroyed())
      win.webContents.send("relay:panel-visibility", shown);
  }

  private place(win: BrowserWindow) {
    if (!this.anchor) return;
    const { workArea } = screen.getDisplayMatching(this.anchor);
    const { x, y } = panelPosition(this.anchor, workArea, win.getBounds());
    win.setPosition(x, y);
  }

  private live() {
    return this.win && !this.win.isDestroyed() ? this.win : undefined;
  }
}
