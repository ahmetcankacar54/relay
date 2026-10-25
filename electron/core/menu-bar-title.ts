import fs from "node:fs";
import path from "node:path";
import type { MenuBarItem, MenuBarTitleChoice } from "../../shared/types";
import { DEFAULT_MENU_BAR_ITEMS, menuBarItems } from "../../shared/tray";

/**
 * What the macOS menu bar title shows, chosen outside Relay's registry so a change never asks the
 * registry for a new layout (an older `relay` CLI would refuse to write one). It lives in
 * `<userData>/menu-bar.json`; a missing or unreadable file is the title Relay has always shown, the
 * five-hour percent alone.
 */
export class MenuBarTitle {
  private items: MenuBarItem[];
  constructor(
    /** The choice's file, its folder created when first saved. */
    readonly file: string,
  ) {
    this.items = this.read();
  }
  private read(): MenuBarItem[] {
    try {
      return menuBarItems(JSON.parse(fs.readFileSync(this.file, "utf8"))?.items);
    } catch {
      return [...DEFAULT_MENU_BAR_ITEMS];
    }
  }
  get current(): MenuBarTitleChoice {
    return { items: [...this.items] };
  }
  /** Replaces the items, as `menuBarItems` keeps them; resolves with the choice as kept. */
  set(choice: MenuBarTitleChoice): MenuBarTitleChoice {
    const items = menuBarItems(choice.items);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify({ items }), { mode: 0o600 });
    this.items = items;
    return this.current;
  }
}
