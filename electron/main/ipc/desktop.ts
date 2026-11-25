/** The Claude app: its extension and terminal sign-ins, captures and switches, history, and the panel's messages. */
import { app, ipcMain, shell } from "electron";
import { z } from "zod";
import { PAGE_INTENTS, PAGES } from "../../../src/app/routes";
import { openAntigravityApp } from "../../core/antigravity-app";
import { openCodeTab } from "../../core/code-tab";
import { detectProviders, executeOneClickCascade } from "../../core/provider-discovery";
import { desktopLock, manualDesktopLock } from "../desktop-lock";
import { proxyStatus } from "../gateway";
import { takeLinkedSwitch } from "../links";
import { claudePageBooted } from "../logs";
import { notifyExtensionLeft, notifySwitched } from "../notifications";
import {
  autoCapture,
  desktop,
  service,
  switchWindow,
  tray,
  trayPanel,
  usage,
  usageCredentialRefresher,
} from "../state";
import { broadcastChanged, openPage, window } from "../windows";
import type { IpcKit } from "./index";
import { fromPanel, trusted } from "./trust";
export function registerDesktopIpc({ handle, id }: IpcKit) {
  handle("extension-status", () => desktop.extensionStatus());
  // The panel's extension offer follows a sync at once. Not a check: the settings card checks
  // again whenever the settings it reads change, and a broadcast would bring it new ones.
  handle("extension-sync", () => desktop.syncExtension().finally(broadcastChanged));
  handle("extension-web", () => desktop.openClaudeWeb());
  handle("extension-settings", () => {
    openPage("gecis");
    trayPanel?.hide();
  });
  handle("extension-check", () => desktop.checkExtension());
  handle("extension-link", (accountId) => desktop.checkExtension(id.parse(accountId)));
  handle("terminal-status", () => desktop.terminalStatus());
  handle("terminal-check", () => desktop.checkTerminal());
  handle("terminal-sync", () => desktop.syncTerminal().finally(broadcastChanged));
  handle("terminal-link", (accountId) =>
    service.transaction(() => service.linkTerminal(id.parse(accountId))),
  );
  handle("terminal-link-cancel", (accountId, attemptId) =>
    service.terminalAuth.cancel(id.parse(accountId), id.parse(attemptId)),
  );
  handle("detect-providers", () =>
    detectProviders(service.store.state.accounts, {
      claudeDesktopRoot: desktop.root,
    }),
  );
  handle("one-click-connect", async (input) => {
    const result = await executeOneClickCascade(input, {
      store: service.store,
      desktopRoot: desktop.root,
      captureDesktop: (profileId, orgId) =>
        manualDesktopLock(() => desktop.capture(profileId, orgId)),
      beginDesktopLogin: (profileId) =>
        manualDesktopLock(() => desktop.beginLogin(profileId)),
      armAutoCapture: (profileId) => autoCapture?.arm(profileId),
      checkTerminal: () => desktop.checkTerminal(),
      checkExtension: (profileId) => desktop.checkExtension(profileId),
      refreshUsage: (profileId) => usage.refresh(profileId),
    });
    void tray?.update();
    broadcastChanged();
    return result;
  });
  handle("desktop-snapshot", async () => ({
    ...(await desktop.cachedSnapshot()),
    proxyStatus: proxyStatus(),
    ...(autoCapture?.state() ? { autoCapture: autoCapture.state() } : {}),
    busy:
      desktop.isBusy || desktopLock.busy || usageCredentialRefresher?.anyActive,
  }));
  handle("dismiss-desktop-error", (revision) =>
    desktop.dismissError(z.number().int().nonnegative().parse(revision)),
  );
  handle("capture-desktop", (profileId, orgId) =>
    manualDesktopLock(() =>
      desktop.capture(id.parse(profileId), id.parse(orgId)),
    ),
  );
  handle("begin-desktop-login", (profileId) =>
    manualDesktopLock(() => desktop.beginLogin(id.parse(profileId))),
  );
  handle("cancel-desktop-login", async () => {
    autoCapture?.disarm();
    await manualDesktopLock(() => desktop.cancelLogin());
  });
  handle("arm-auto-capture", (profileId) => autoCapture?.arm(id.parse(profileId)));
  handle("disarm-auto-capture", (profileId) =>
    autoCapture?.disarm(profileId === undefined ? undefined : id.parse(profileId)),
  );
  handle("choose-auto-capture-org", (profileId, orgId) =>
    autoCapture?.choose(id.parse(profileId), id.parse(orgId)),
  );
  // Registered directly so a panel-initiated switch can confirm with a notification.
  ipcMain.handle("relay:switch-desktop", async (event, profileId) => {
    trusted(event);
    const target = id.parse(profileId);
    try {
      const result = await manualDesktopLock(() => desktop.switchTo(target));
      const account = service.store.state.accounts.find((a) => a.id === target);
      if (account && event.sender === trayPanel?.webContents())
        notifySwitched(account.name);
      if (account) notifyExtensionLeft(account);
      return result;
    } finally {
      void tray?.update();
      broadcastChanged();
    }
  });
  // Main window only: the widget's switch request is never the panel's to take.
  ipcMain.handle("relay:take-switch-request", (event) => {
    trusted(event);
    if (event.sender !== window?.webContents) return undefined;
    return takeLinkedSwitch();
  });
  handle("open-page", (page, intent) => {
    openPage(
      z.enum(PAGES).parse(page),
      z.enum(PAGE_INTENTS).optional().parse(intent),
    );
    trayPanel?.hide();
  });
  handle("quit", () => {
    trayPanel?.hide();
    app.quit();
  });
  ipcMain.on("relay:panel-size", (event, height) => {
    try {
      if (!fromPanel(event)) return;
      trayPanel?.setHeight(
        z.number().finite().positive().max(4000).parse(height),
      );
    } catch {
      /* Ignore invalid one-way messages. */
    }
  });
  ipcMain.on("relay:panel-close", (event) => {
    if (fromPanel(event)) trayPanel?.hide();
  });
  ipcMain.on("relay:switch-ready", (event) => {
    try {
      switchWindow?.ready(event.sender, event.senderFrame);
    } catch {
      // Ignore: the story is skipped, nothing else depends on it.
    }
  });
  handle("sync-desktop-history", (profileId) =>
    manualDesktopLock(() => desktop.syncHistory(id.parse(profileId))),
  );
  handle("desktop-history-summary", (profileId) =>
    desktop.historySummary(id.parse(profileId)),
  );
  handle("open-desktop", () => manualDesktopLock(() => desktop.open()));
  handle("open-antigravity", () => openAntigravityApp());
  // Setup's "Open Code": the fixed claude:// link to Code's new-session screen, macOS and Linux
  // (where Claude's package registers the link and hands it to the running Claude).
  handle("open-code-tab", () =>
    manualDesktopLock(async () => {
      if (process.platform !== "darwin" && process.platform !== "linux") return desktop.open();
      await openCodeTab({
        open: () => desktop.open(),
        booted: claudePageBooted,
        running: async () => (await desktop.snapshot()).running,
        openLink: (url) => shell.openExternal(url),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
      });
    }),
  );
  handle("recover-desktop", () => manualDesktopLock(() => desktop.recover()));
}
