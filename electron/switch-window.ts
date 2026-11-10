import { BrowserWindow, screen } from "electron";
import {
  INITIAL_PANEL_LOAD,
  panelLoadState,
  panelPosition,
  type PanelLoadEvent,
  type Rect,
} from "../shared/tray-panel";
import { switchWindowVisible, type SwitchSceneView } from "../shared/switch-scene";

export const SWITCH_WINDOW_SIZE = { width: 240, height: 150 } as const;

export interface SwitchWindowOptions {
  preload: string;
  /** Loads switch.html (dev server or built file) into the window. */
  load(win: BrowserWindow): void;
  /** The menu bar icon, to open under it; without it the window stays hidden. */
  anchor(): Rect | undefined;
  /** The "show the panda window" setting. */
  enabled(): boolean;
  panelOpen(): boolean;
}

/** How long the window stays loaded after a story ends, so the next switch opens it at once. */
export const SWITCH_WINDOW_RELEASE_MS = 30_000;

/**
 * The story window under the menu bar icon, never focused and transparent to the mouse. It is
 * created when a story starts and destroyed a while after it ends, so between switches Relay
 * keeps no renderer for it.
 */
export class SwitchWindow {
  private win?: BrowserWindow;
  /** Ready once the page has said it listens; one crash reloads it, a second keeps it off. */
  private load = INITIAL_PANEL_LOAD;
  private view?: SwitchSceneView;
  private releaseTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: SwitchWindowOptions) {}

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      ...SWITCH_WINDOW_SIZE,
      frame: false,
      resizable: false,
      movable: false,
      show: false,
      skipTaskbar: true,
      fullscreenable: false,
      focusable: false,
      hasShadow: false,
      type: "panel",
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.win = win;
    this.load = INITIAL_PANEL_LOAD;
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // A new document only: did-start-loading also fires for navigations that change nothing.
    win.webContents.on("did-navigate", () => this.dispatch("start"));
    win.webContents.on("did-fail-load", (_event, _code, _description, _url, mainFrame) => {
      if (mainFrame) this.dispatch("fail");
    });
    win.webContents.on("render-process-gone", () => this.dispatch("gone"));
    win.on("closed", () => {
      if (this.win === win) this.win = undefined;
    });
    this.options.load(win);
    return win;
  }

  /** A new state of the story. */
  show(view: SwitchSceneView) {
    this.view = view;
    if (view.visible && this.options.enabled()) {
      this.cancelRelease();
      // The story is decoration: a window that cannot be made leaves the switch untouched.
      if (!this.live())
        try {
          this.create();
        } catch {
          this.live()?.destroy();
          this.win = undefined;
        }
    }
    this.send();
    this.sync();
    if (!view.visible) this.scheduleRelease();
  }

  /** The page listens now; only this window's main frame may say so. */
  ready(sender: Electron.WebContents, frame: Electron.WebFrameMain | null) {
    const win = this.live();
    if (!win || sender !== win.webContents || frame !== win.webContents.mainFrame) return;
    this.dispatch("painted");
    this.send();
    this.sync();
  }

  /** Shows or hides the window for the current story, setting and menu bar panel. */
  sync() {
    const win = this.live();
    if (!win) return;
    const visible = switchWindowVisible(this.view, {
      loaded: this.load.phase === "ready",
      enabled: this.options.enabled(),
      panelOpen: this.options.panelOpen(),
    });
    if (visible && !win.isVisible()) {
      if (this.place(win)) win.showInactive();
    } else if (!visible && win.isVisible()) win.hide();
  }

  webContents(): Electron.WebContents | undefined {
    return this.live()?.webContents;
  }

  destroy() {
    this.cancelRelease();
    const win = this.live();
    this.win = undefined;
    if (win) win.destroy();
  }

  private scheduleRelease() {
    if (this.releaseTimer || !this.live()) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      if (this.view?.visible) return;
      const win = this.live();
      this.win = undefined;
      win?.destroy();
    }, SWITCH_WINDOW_RELEASE_MS);
    this.releaseTimer.unref();
  }

  private cancelRelease() {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }

  private send() {
    const win = this.live();
    if (win && this.view && this.load.phase === "ready") win.webContents.send("relay:switch-scene", this.view);
  }

  private dispatch(event: PanelLoadEvent) {
    const before = this.load;
    this.load = panelLoadState(before, event);
    if (this.load.phase === "ready") return;
    this.live()?.hide();
    if (this.load.phase === "reloading" && before.phase !== "reloading") this.live()?.webContents.reload();
  }

  private place(win: BrowserWindow) {
    const anchor = this.options.anchor();
    if (!anchor) return false;
    const { workArea } = screen.getDisplayMatching(anchor);
    const { x, y } = panelPosition(anchor, workArea, SWITCH_WINDOW_SIZE);
    win.setPosition(x, y);
    return true;
  }

  private live() {
    return this.win && !this.win.isDestroyed() ? this.win : undefined;
  }
}
