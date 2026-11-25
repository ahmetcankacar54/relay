/** Relay's own updates, and moving a copy that cannot keep macOS's approval to Applications. */
import { app, dialog } from "electron";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveLocale } from "../../shared/i18n/locales";
import { tFor } from "../../shared/i18n/translate";
import { AppUpdates, RELEASE_FEEDS, UPDATE_BUSY } from "../core/app-update";
import { runDetached } from "../core/detached-exec";
import { bundlePath, bundlePlace, clearOwnQuarantine, forgetsApproval } from "../core/install-location";
import { MacUpdateDriver } from "../core/mac-update";
import { ElectronUpdateDriver } from "../core/win-linux-update";
import { desktopLock } from "./desktop-lock";
import { logDraftEvent } from "./logs";
import { notifyUpdate } from "./notifications";
import { desktop, service } from "./state";
import { broadcastChanged } from "./windows";
/** Relay's own updates; only in a packaged app, or with RELAY_UPDATE_FEED to test one. */
export let appUpdates: AppUpdates | undefined;
/**
 * The share builds are not notarized, so macOS asks once ("Open Anyway") and keeps the answer
 * on the bundle. Run from the disk image or a translocated copy it cannot keep it and asks at
 * every launch: Relay offers to move itself to Applications, where Electron starts it again.
 * From a writable place the download quarantine is cleared so the approval holds (see
 * install-location.ts). True when Relay is moving and this copy quits.
 */
export async function settleInstallLocation(): Promise<boolean> {
  const bundle = bundlePath(app.getPath("exe"));
  if (!bundle) return false;
  const place = bundlePlace(bundle, app.isInApplicationsFolder());
  if (!forgetsApproval(place)) {
    void clearOwnQuarantine(bundle, (file, args) => runDetached(file, args, { timeout: 15_000 }))
      .then((cleared) => logDraftEvent("install-location", { place, quarantineCleared: cleared }));
    return false;
  }
  logDraftEvent("install-location", { place });
  // Settings are not read yet; the system language decides.
  const t = tFor(resolveLocale("system", app.getPreferredSystemLanguages()));
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: [t("electronMain.moveToApplications"), t("electronMain.notNow")],
    defaultId: 0,
    cancelId: 1,
    message: t("electronMain.moveRelayToApplications"),
    detail:
      place === "disk-image"
        ? t("electronMain.whileRelayRunsFromTheDisk")
        : t("electronMain.whileRelayRunsFromItsDownload"),
  });
  if (response !== 0) return false;
  try {
    return app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox(
      t("electronMain.relayWasNotMoved"),
      t("electronMain.dragRelayToApplicationsInFinder") + `\n\n${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
/**
 * Starts Relay's own updates: on macOS Relay downloads, verifies and swaps its app itself; on
 * Windows and Linux electron-updater does. A development run never updates unless
 * RELAY_UPDATE_FEED points it at a test feed; a packaged Relay never reads that variable.
 */
export function startAppUpdates() {
  const testFeed = app.isPackaged ? undefined : process.env.RELAY_UPDATE_FEED;
  if (!app.isPackaged && !testFeed) return;
  const folder = path.join(app.getPath("userData"), "updates");
  const current = app.getVersion();
  const bundle = bundlePath(app.getPath("exe"));
  const mac =
    process.platform === "darwin" && bundle
      ? new MacUpdateDriver({
          feeds: testFeed ? { stable: testFeed, beta: testFeed } : RELEASE_FEEDS,
          channel: () => service.store.state.settings.updateChannel ?? "stable",
          folder,
          current,
          arch: process.arch,
          bundle,
          place: () => bundlePlace(bundle, app.isInApplicationsFolder()),
          pid: process.pid,
          run: (file, args) =>
            new Promise((resolve, reject) =>
              execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
                error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) }),
              ),
            ),
          spawnDetached: (file, args) => {
            // Only PATH: the script's RELAY_UPDATE_* tool overrides (tests set them) never come from
            // Relay's environment, and nothing of it reaches the app the script opens (env -i).
            spawn(file, args, { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } }).unref();
          },
          writable: (dir) => {
            try {
              fs.accessSync(dir, fs.constants.W_OK);
              return true;
            } catch {
              return false;
            }
          },
        })
      : undefined;
  if (process.platform === "darwin" && !mac) return;
  try {
    mac?.prune();
  } catch {
    // Old downloads stay until the next start.
  }
  appUpdates = new AppUpdates({
    folder,
    current,
    driver:
      mac ??
      new ElectronUpdateDriver({
        updater: async () => (await import("electron-updater")).autoUpdater,
        current,
        platform: process.platform,
        env: process.env,
        channel: () => service.store.state.settings.updateChannel ?? "stable",
      }),
    now: Date.now,
    notify: notifyUpdate,
    changed: broadcastChanged,
    busy: () => (desktop?.isBusy || desktopLock.busy ? UPDATE_BUSY : undefined),
    quit: () => {
      app.quit();
      // Still here a while later: the quit was cancelled (running terminals), so the update waits.
      setTimeout(() => appUpdates?.quitCancelled(), 20_000).unref();
    },
    log: logDraftEvent,
  });
  appUpdates.start();
}
