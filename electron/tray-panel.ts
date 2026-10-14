import { BrowserWindow, screen } from "electron";
import {
  clampPanelHeight,
  PANEL_WIDTH,
  panelPosition,
  ToggleGuard,
  type Rect,
} from "../shared/tray-panel";

export interface TrayPanelOptions {
  preload: string;
  /** Loads panel.html (dev server or built file) into the window. */
  load(win: BrowserWindow): void;
  now?: () => number;
}

/** The macOS menu bar popover: one hidden window, shown under the tray icon. */
export class TrayPanel {
  private win?: BrowserWindow;
  private anchor?: Rect;
  private readonly guard = new ToggleGuard();
  private readonly now: () => number;

  constructor(options: TrayPanelOptions) {
    this.now = options.now ?? Date.now;
    const win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: 520,
      frame: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      fullscreenable: false,
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
    win.setVisibleOnAllWorkspaces(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("blur", () => this.hide());
    win.on("closed", () => {
      this.win = undefined;
    });
    options.load(win);
  }

  toggle(trayBounds: Rect) {
    const win = this.live();
    if (!win) return;
    if (win.isVisible()) return this.hide();
    if (!this.guard.shouldOpen(this.now())) return;
    this.anchor = trayBounds;
    this.place(win);
    win.show();
    win.focus();
  }

  hide() {
    const win = this.live();
    if (!win || !win.isVisible()) return;
    win.hide();
    this.guard.hidden(this.now());
  }

  setHeight(height: number) {
    const win = this.live();
    if (!win) return;
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
