import path from "node:path";
import {
  widgetVisibleKey,
  type WidgetSnapshot,
} from "../../shared/widget-snapshot";
import {
  privateJournalDirectory,
  writePrivateJson,
} from "./continuation-journal";

/** The widget kind in RelayWidget.swift. */
export const WIDGET_KIND = "RelayToday";
/** Reloads are budgeted by the system: at most one this often, unless the day changed. */
export const WIDGET_RELOAD_MS = 5 * 60_000;

/**
 * Writes the widget's file, `<dir>/today.json`, and asks the system to redraw
 * the widget when what it shows changed. The directory holds nothing else:
 * the widget's sandbox may read this one directory of Relay's data.
 */
export class WidgetFile {
  private readonly file: string;
  private reloadedKey?: string;
  private reloadedDate?: string;
  private reloadedAt = -Infinity;

  constructor(
    private readonly dir: string,
    private readonly reload?: (kind: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dir, "today.json");
  }

  write(snapshot: WidgetSnapshot) {
    privateJournalDirectory(this.dir);
    writePrivateJson(this.file, snapshot);
    if (!this.reload) return;
    const key = widgetVisibleKey(snapshot);
    if (key === this.reloadedKey) return;
    const now = this.now();
    if (
      snapshot.date === this.reloadedDate &&
      now - this.reloadedAt < WIDGET_RELOAD_MS
    )
      return;
    this.reloadedKey = key;
    this.reloadedDate = snapshot.date;
    this.reloadedAt = now;
    try {
      this.reload(WIDGET_KIND);
    } catch {
      // The widget refreshes itself every 15 minutes anyway.
    }
  }
}
