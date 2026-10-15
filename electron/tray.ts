import { Menu, nativeImage, Tray, type Rectangle } from "electron";
import {
  buildTrayMenu,
  canRequestTraySwitch,
  trayTitle,
  trayTooltip,
  type TrayCommand,
  type TrayLanguage,
  type TrayMenuItem,
  type TraySnapshot,
} from "../shared/tray";
import { TrayMenuLifecycle } from "./core/tray-menu-lifecycle";
import { trayIcons } from "./tray-icons";
import { trayClickAction } from "../shared/tray-panel";
import { MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";
import { mascotTrayFrames } from "./mascot-tray-frames";
import { MascotPlayer } from "./core/mascot-player";
import { TrayMascot } from "./core/tray-mascot";

export interface RelayTrayOptions {
  getSnapshot(): TraySnapshot | Promise<TraySnapshot>;
  showWindow(): void;
  /** Confirm natively, then switch Claude Desktop to this saved account. */
  requestSwitch(profileId: string): void;
  quit(): void;
  language?(): TrayLanguage;
  /** macOS menu bar popover; when present, left click toggles it instead of the menu. */
  panel?: { toggle(bounds: Rectangle): void; usable(): boolean };
  /** Whether the menu bar panda may animate (setting and Reduce motion); poses change regardless. */
  motionAllowed?(): boolean;
}

function image(
  representations: readonly { scaleFactor: number; png: string }[],
  template: boolean,
) {
  const icon = nativeImage.createEmpty();
  for (const representation of representations)
    icon.addRepresentation({
      scaleFactor: representation.scaleFactor,
      buffer: Buffer.from(representation.png, "base64"),
    });
  icon.setTemplateImage(template);
  return icon;
}
/** Every panda frame, decoded once; macOS tints template images for the menu bar. */
function mascotImages() {
  return new Map<MascotFrame, Electron.NativeImage>(
    MASCOT_FRAMES.map((frame) => [frame, image(mascotTrayFrames[frame], true)]),
  );
}

export class RelayTray {
  private readonly tray: Tray;
  private menu?: Menu;
  private readonly mascot?: TrayMascot;
  private revision = 0;
  private destroyed = false;
  /**
   * macOS with a panel: left click opens the popover. The full native menu is
   * still built but only popped up when the panel failed to load.
   */
  private readonly panelMode: boolean;
  private readonly menuLifecycle = new TrayMenuLifecycle<TrayMenuItem[]>({
    apply: (items, generation) => this.installMenu(items, generation),
    schedule: (callback) => setImmediate(callback),
    onApplyError: () => void this.update(),
  });

  constructor(private readonly options: RelayTrayOptions) {
    // macOS shows the panda; other platforms keep the colored R.
    const frames = process.platform === "darwin" ? mascotImages() : undefined;
    this.tray = new Tray(frames ? frames.get("idle")! : image(trayIcons.color, false));
    this.tray.setToolTip("Relay");
    if (frames)
      this.mascot = new TrayMascot(
        new MascotPlayer({
          show: (frame) => this.tray.setImage(frames.get(frame)!),
          motionAllowed: () => options.motionAllowed?.() ?? true,
        }),
      );
    const panel = options.panel;
    this.panelMode = process.platform === "darwin" && !!panel;
    if (panel && this.panelMode) {
      this.tray.on("click", () => {
        if (this.destroyed) return;
        if (trayClickAction(panel.usable()) === "toggle")
          panel.toggle(this.tray.getBounds());
        else if (this.menu) this.tray.popUpContextMenu(this.menu);
        else this.popUpShortMenu();
      });
      this.tray.on("right-click", () => this.popUpShortMenu());
    } else {
      // Native context menus are retained for Linux AppIndicator support. Menus
      // are refreshed by update(); clicks are revalidated against a fresh state.
      this.tray.on("double-click", () => this.options.showWindow());
      if (process.platform === "win32")
        this.tray.on("click", () => this.tray.popUpContextMenu());
    }
    void this.update();
  }

  async update() {
    const revision = ++this.revision;
    try {
      const snapshot = await this.options.getSnapshot();
      if (this.destroyed || revision !== this.revision) return;
      this.mascot?.next(snapshot);
      if (process.platform === "darwin") {
        const title = trayTitle(snapshot);
        this.tray.setTitle(title ? " " + title : "");
      }
      this.tray.setToolTip(trayTooltip(snapshot));
      const items = buildTrayMenu(snapshot, this.options.language?.() ?? "en");
      this.menuLifecycle.update(items, JSON.stringify(items));
    } catch {
      // Opening Relay remains available if a read-only snapshot fails. A stale
      // menu must not offer an action against unknown Desktop state.
      if (this.destroyed || revision !== this.revision) return;
      this.mascot?.unavailable();
      if (process.platform === "darwin") this.tray.setTitle("");
      const items: TrayMenuItem[] = [
        {
          type: "normal",
          label: "Open Relay",
          enabled: true,
          command: { type: "show" },
        },
        { type: "normal", label: "Desktop status unavailable", enabled: false },
        { type: "separator" },
        {
          type: "normal",
          label: "Quit Relay",
          enabled: true,
          command: { type: "quit" },
        },
      ];
      try {
        this.menuLifecycle.update(items, JSON.stringify(items));
        this.tray.setToolTip("Relay");
      } catch {
        // Retain the existing menu if even a native fallback cannot be built.
        // Every account action still rechecks Desktop state before review.
      }
    }
  }

  /** Right click in panel mode: open the main window or quit. */
  private popUpShortMenu() {
    if (this.destroyed) return;
    const en = (this.options.language?.() ?? "en") === "en";
    this.tray.popUpContextMenu(
      Menu.buildFromTemplate([
        {
          label: en ? "Open Relay" : "Relay’i aç",
          click: () => this.options.showWindow(),
        },
        { type: "separator" },
        {
          label: en ? "Quit Relay" : "Çık",
          click: () => this.options.quit(),
        },
      ]),
    );
  }

  private installMenu(items: TrayMenuItem[], generation: number) {
    const menu = Menu.buildFromTemplate(
      items.map((item): Electron.MenuItemConstructorOptions =>
        item.type === "separator"
          ? item
          : {
              type: item.type,
              label: item.label,
              checked: item.checked,
              enabled: item.enabled,
              ...(item.command
                ? { click: () => void this.run(item.command!) }
                : {}),
            },
      ),
    );
    menu.on("menu-will-show", () => {
      if (!this.destroyed && this.menu === menu)
        this.menuLifecycle.opened(generation);
    });
    menu.on("menu-will-close", () => {
      if (!this.destroyed && this.menu === menu)
        this.menuLifecycle.closed(generation);
    });
    const previous = this.menu;
    this.menu = menu;
    try {
      // In panel mode the menu is popped up on demand, never attached, so a
      // left click reaches the panel.
      if (!this.panelMode) this.tray.setContextMenu(menu);
    } catch (error) {
      this.menu = previous;
      throw error;
    }
  }

  private async run(command: TrayCommand) {
    if (this.destroyed) return;
    if (command.type === "show") return this.options.showWindow();
    if (command.type === "quit") return this.options.quit();
    try {
      const snapshot = await this.options.getSnapshot();
      if (this.destroyed) return;
      if (canRequestTraySwitch(snapshot, command.profileId))
        this.options.requestSwitch(command.profileId);
      else this.options.showWindow();
    } catch {
      if (!this.destroyed) this.options.showWindow();
    }
    void this.update();
  }

  destroy() {
    this.destroyed = true;
    this.revision++;
    this.menuLifecycle.destroy();
    this.mascot?.destroy();
    if (!this.tray.isDestroyed()) this.tray.destroy();
    this.menu = undefined;
  }
}
