import path from "node:path";
import {
  widgetVisibleKey,
  type WidgetSnapshot,
} from "../../shared/widget-snapshot";
import {
  privateJournalDirectory,
  writePrivateJson,
} from "./continuation-journal";

/** The widget kinds in RelayWidget.swift; a reload asks for all of them at once. */
export const WIDGET_KINDS = [
  "RelayToday",
  "RelayAccount",
  "RelayAccounts",
  "RelayAccountsToday",
  "RelayWeek",
] as const;
/**
 * Reloads are budgeted by the system (roughly 40–70 a day for an app in the
 * background): at most one this often, unless the day, the language or the account open in Claude changed.
 */
export const WIDGET_RELOAD_MS = 15 * 60_000;

/**
 * Writes the widget's file, `<dir>/today.json`, and asks the system to redraw
 * the widget when what it shows changed. The directory holds nothing else:
 * the widget's sandbox may read this one directory of Relay's data.
 */
export class WidgetFile {
  private readonly file: string;
  private reloadedKey?: string;
  private reloadedDate?: string;
  private reloadedActive?: string;
  private reloadedAt = -Infinity;

  constructor(
    private readonly dir: string,
    /** Reloads every widget of Relay's. */
    private readonly reload?: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dir, "today.json");
  }

  /** `force`: reload now whatever the throttle says, as for a new language. */
  write(snapshot: WidgetSnapshot, force = false) {
    privateJournalDirectory(this.dir);
    writePrivateJson(this.file, snapshot);
    if (!this.reload) return;
    const key = widgetVisibleKey(snapshot);
    if (key === this.reloadedKey) return;
    const now = this.now();
    const active = snapshot.active?.id;
    if (
      !force &&
      snapshot.date === this.reloadedDate &&
      active === this.reloadedActive &&
      now - this.reloadedAt < WIDGET_RELOAD_MS
    )
      return;
    this.reloadedKey = key;
    this.reloadedDate = snapshot.date;
    this.reloadedActive = active;
    this.reloadedAt = now;
    try {
      this.reload();
    } catch {
      // The widget refreshes itself every 15 minutes anyway.
    }
  }
}
