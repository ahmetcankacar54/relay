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

export interface RelayTrayOptions {
  getSnapshot(): TraySnapshot | Promise<TraySnapshot>;
  showWindow(): void;
  /** Open the existing account-switch review in Relay. Never switch directly. */
  requestSwitch(profileId: string): void;
  quit(): void;
  language?(): TrayLanguage;
}

// Small, antialiased opposing arrows. PNGs work on Electron's three supported
// platforms; macOS applies its own menu-bar foreground via template mode.
const icon20 =
  "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAV0lEQVR4nGOQkJFloCamqmHkGHgeigWoaeB/fIaSaqAAIUNxuYBYfJ7uBlLdy3SPFIqSjQCSARQnbPSwoshAggFPqoEUJR26GEh1L1M9UmiSbMjGVDcQAE2pzT0CBP3nAAAAAElFTkSuQmCC";
const icon40 =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAsUlEQVR4nO3WQQ6AIAwEQJ7hQf/G/z+BHjQxRBRaul0Jhz0RyCSbkoZl3QJz3AET+GdgPJLOREZgyiJCIoEiJKpiMdIS2AVpDVQjJQ/3zCfy7dAad2VcIH3F9EPijrMGqnHWQDUODWzGISsW4bTALgAr4B1X9eEigU84GmAJR1ExHNcCdMHVAks4yNJQA3Rdu4YA0ldMPySuyNYLcKTkUglJAywhqYA5kqpiaNwBE2idHVysOz7T5+oJAAAAAElFTkSuQmCC";
const colorIcon20 =
  "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAV0lEQVR4nGPQ6tvPQE1MVcPIMfA8FAtQ08D/+Awl1UABQobicgGx+DzdDaS6l+keKRQlGwEkAyhO2OhhRZGBBAOeVAMpSjp0MZDqXqZ6pNAk2ZCNqW4gACVLmLsMaz5lAAAAAElFTkSuQmCC";
const colorIcon40 =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAsUlEQVR4nO3W0Q2AIAwEUOZxKiZyJUdDPzQxxCoUej0JH/dFIC+5lDQs6xaY4w6YwD8D45F0JjICUxYVEglUIVEVq5GWwC5Ia2AzUvNwz3wi3w6tcVfGBdJXTD8k7jhrYDPOGtiMQwOrcciKVbhWYBeAFfCOK/pwkcAnHA1QwlFUDMfVAF1wpUAJB1kaSoCua9cQQPqK6YfEFVl7AY7UXJKQNEAJSQXMkVQVQ+MOmEDr7Af+aSed4ODfAAAAAElFTkSuQmCC";

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
    const icon = nativeImage.createFromBuffer(
      Buffer.from(template ? icon20 : colorIcon20, "base64"),
    );
    icon.addRepresentation({
      scaleFactor: 2,
      buffer: Buffer.from(template ? icon40 : colorIcon40, "base64"),
    });
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
      this.options.showWindow();
      if (canRequestTraySwitch(snapshot, command.profileId))
        this.options.requestSwitch(command.profileId);
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
