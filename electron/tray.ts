import { Menu, nativeImage, Tray } from "electron";
import {
  buildTrayMenu,
  canRequestTraySwitch,
  trayTooltip,
  type TrayCommand,
  type TrayLanguage,
  type TrayMenuItem,
  type TraySnapshot,
} from "../shared/tray";
import { TrayMenuLifecycle } from "./core/tray-menu-lifecycle";
import { trayIcons } from "./tray-icons";

export interface RelayTrayOptions {
  getSnapshot(): TraySnapshot | Promise<TraySnapshot>;
  showWindow(): void;
  /** Confirm natively, then switch Claude Desktop to this saved account. */
  requestSwitch(profileId: string): void;
  quit(): void;
  language?(): TrayLanguage;
}

export class RelayTray {
  private readonly tray: Tray;
  private menu?: Menu;
  private revision = 0;
  private destroyed = false;
  private readonly menuLifecycle = new TrayMenuLifecycle<TrayMenuItem[]>({
    apply: (items, generation) => this.installMenu(items, generation),
    schedule: (callback) => setImmediate(callback),
    onApplyError: () => void this.update(),
  });

  constructor(private readonly options: RelayTrayOptions) {
    const template = process.platform === "darwin";
    const representations = template ? trayIcons.template : trayIcons.color;
    const icon = nativeImage.createEmpty();
    for (const representation of representations) {
      icon.addRepresentation({
        scaleFactor: representation.scaleFactor,
        buffer: Buffer.from(representation.png, "base64"),
      });
    }
    icon.setTemplateImage(template);
    this.tray = new Tray(icon);
    this.tray.setToolTip("Relay");
    // Native context menus are retained for Linux AppIndicator support. Menus
    // are refreshed by update(); clicks are revalidated against a fresh state.
    this.tray.on("double-click", () => this.options.showWindow());
    if (process.platform === "win32")
      this.tray.on("click", () => this.tray.popUpContextMenu());
    void this.update();
  }

  async update() {
    const revision = ++this.revision;
    try {
      const snapshot = await this.options.getSnapshot();
      if (this.destroyed || revision !== this.revision) return;
      const items = buildTrayMenu(snapshot, this.options.language?.() ?? "en");
      this.menuLifecycle.update(items, JSON.stringify(items));
      this.tray.setToolTip(trayTooltip(snapshot));
    } catch {
      // Opening Relay remains available if a read-only snapshot fails. A stale
      // menu must not offer an action against unknown Desktop state.
      if (this.destroyed || revision !== this.revision) return;
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
      this.tray.setContextMenu(menu);
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
    if (!this.tray.isDestroyed()) this.tray.destroy();
    this.menu = undefined;
  }
}
