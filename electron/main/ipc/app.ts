/** Relay itself: how it starts Claude, its updates, shortcuts, separate windows, menu bar title and language. */
import { app, shell } from "electron";
import { z } from "zod";
import { LOCALES, resolveLocale } from "../../../shared/i18n/locales";
import { DEFAULT_MENU_BAR_ITEMS, MENU_BAR_ITEMS, trayTitle } from "../../../shared/tray";
import { releasePage } from "../../core/app-update";
import { WINDOWS_UNSUPPORTED } from "../../core/desktop-windows";
import { writeLanguagePref } from "../../core/language-file";
import { getAppLocale, setAppLocale } from "../../i18n";
import { manualDesktopLock } from "../desktop-lock";
import {
  desktop,
  desktopWindows,
  globalShortcuts,
  languagePref,
  lastTraySnapshot,
  menuBarTitle,
  service,
  set,
  switchDiagnostics,
  tray,
} from "../state";
import { writeWidget } from "../tokens-widget";
import { appUpdates } from "../updates";
import { applyAppMenu, broadcastChanged } from "../windows";
import type { IpcKit } from "./index";
export function registerAppIpc({ handle, id }: IpcKit) {
  // How Relay starts Claude (HTTP/3).
  handle("claude-launch", () => switchDiagnostics?.current ?? { quicOff: false });
  // Relay's own updates.
  handle("update-check", async () => {
    if (!appUpdates) throw new Error("Updates are not available in this copy of Relay.");
    return appUpdates.check();
  });
  handle("update-install", () => {
    if (!appUpdates) throw new Error("Updates are not available in this copy of Relay.");
    return appUpdates.install();
  });
  handle("set-update-auto", (enabled) => {
    if (!appUpdates) throw new Error("Updates are not available in this copy of Relay.");
    appUpdates.setAuto(z.boolean().parse(enabled));
  });
  handle("update-notes", async () => {
    const version = appUpdates?.state().version;
    // Only the release page of a version the feed named, never a URL from the renderer.
    if (version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) await shell.openExternal(releasePage(version));
  });
  // Settings records a shortcut: the registered keys are let go meanwhile, so pressing one is
  // recorded instead of acting. A recorder that never says it ended resumes them after a minute.
  let shortcutResume: NodeJS.Timeout | undefined;
  handle("pause-shortcuts", (paused) => {
    clearTimeout(shortcutResume);
    if (z.boolean().parse(paused)) {
      globalShortcuts?.pause();
      shortcutResume = setTimeout(() => {
        globalShortcuts?.resume();
        broadcastChanged();
      }, 60_000);
      shortcutResume.unref();
      return;
    }
    globalShortcuts?.resume();
    broadcastChanged();
  });
  // Separate Claude windows: an account opened in its own Claude beside the main one.
  handle("set-separate-windows", (enabled) => {
    if (!desktopWindows) throw new Error(WINDOWS_UNSUPPORTED);
    desktopWindows.setEnabled(z.boolean().parse(enabled));
    broadcastChanged();
  });
  const windowAccount = (accountId: unknown) => {
    if (!desktopWindows) throw new Error(WINDOWS_UNSUPPORTED);
    const account = service.store.account(id.parse(accountId));
    if (!account.desktop) throw new Error("Connect this account in Claude Desktop first.");
    return { windows: desktopWindows, accountUuid: account.desktop.accountUuid };
  };
  handle("open-window", async (accountId) => {
    const { windows, accountUuid } = windowAccount(accountId);
    try {
      return await manualDesktopLock(async () => {
        // A sign-in in progress may be for this very account: one holder at a time.
        const state = await desktop.snapshot();
        if (state.pendingProfileId)
          throw new Error("Finish or cancel the current Desktop sign-in first.");
        if (state.recoveryRequired) throw new Error("Restore the interrupted Desktop switch first.");
        return windows.open(accountUuid);
      });
    } finally {
      broadcastChanged();
    }
  });
  handle("close-window", async (accountId) => {
    const { windows, accountUuid } = windowAccount(accountId);
    try {
      await manualDesktopLock(() => windows.close(accountUuid));
    } finally {
      broadcastChanged();
    }
  });
  handle("set-claude-launch", (patch) => {
    const parsed = z
      .object({ quicOff: z.boolean().optional() })
      .strict()
      .parse(patch);
    if (!switchDiagnostics) throw new Error("Invalid Claude launch choice.");
    return switchDiagnostics.set(parsed);
  });
  // What the menu bar title shows; kept beside the registry, redrawn at once.
  handle("menu-bar-title", () =>
    menuBarTitle?.current ?? { items: [...DEFAULT_MENU_BAR_ITEMS] },
  );
  // The title as the menu bar shows it now, and each item's value alone, from the last look.
  handle("menu-bar-now", () => {
    const snapshot = lastTraySnapshot;
    if (!snapshot) return undefined;
    const now = Date.now();
    const alone = (item: (typeof MENU_BAR_ITEMS)[number]) => {
      const text = trayTitle({ ...snapshot, titleItems: [item] }, now, getAppLocale());
      return text === "—" ? "" : text;
    };
    // The saved choice, which the snapshot may not hold yet right after a change.
    const titleItems = menuBarTitle?.current.items ?? snapshot.titleItems;
    return {
      title: trayTitle({ ...snapshot, titleItems }, now, getAppLocale()),
      values: Object.fromEntries(MENU_BAR_ITEMS.map((item) => [item, alone(item)])),
    };
  });
  handle("set-menu-bar-title", (choice) => {
    const parsed = z
      .object({ items: z.array(z.enum(MENU_BAR_ITEMS)).max(MENU_BAR_ITEMS.length) })
      .strict()
      .parse(choice);
    if (!menuBarTitle) throw new Error("Invalid menu bar title.");
    const kept = menuBarTitle.set(parsed);
    void tray?.update();
    return kept;
  });
  handle("set-language", (value) => {
    const pref = z.union([z.literal("system"), z.enum(LOCALES)]).parse(value);
    writeLanguagePref(service.store.root, pref);
    set.languagePref(pref);
    if (setAppLocale(resolveLocale(pref, app.getPreferredSystemLanguages()))) {
      applyAppMenu();
      // The widget's strings are in the app's language too.
      writeWidget(true);
    }
    tray?.update();
  });
  handle("get-language", () => ({
    pref: languagePref,
    locale: getAppLocale(),
  }));
}
