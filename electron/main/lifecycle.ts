import { app, dialog, systemPreferences } from "electron";
import { say } from "../i18n";
import { systemShuttingDown } from "../main-lifecycle";
import { antigravityBridges } from "./antigravity";
import { desktopLock } from "./desktop-lock";
import { releaseClients } from "./gateway";
import { meters } from "./notifications";
import {
  autoSwitch,
  continuation,
  desktop,
  draftRestore,
  fleet,
  globalShortcuts,
  initialized,
  keeper,
  keeperAbort,
  proxyServer,
  quitting,
  service,
  set,
  switchStory,
  switchWindow,
  systemShutdownAt,
  tray,
  trayPanel,
  trayTimer,
  usage,
  usageCredentialRefresher,
} from "./state";
import { stopTokenScan } from "./tokens-widget";
import { appUpdates } from "./updates";
import { showWindow } from "./windows";
/** The least often a window gaining focus retries the drafts left for want of accessibility. */
const ACCESSIBILITY_RETRY_MS = 30_000;
let accessibilityRetriedAt = -Infinity;
/**
 * Someone who grants accessibility in System Settings comes back to Relay's window or panel:
 * look, never asking, and once it is granted retry the drafts left for Copy for want of it,
 * each at most once while Relay runs. Looking is cheap, so every focus looks; only a retry
 * waits 30 s for the next.
 */
function retryDraftsOnFocus() {
  if (process.platform !== "darwin" || !initialized) return;
  let trusted: boolean;
  try {
    trusted = systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    // A focus change never fails because of this check.
    return;
  }
  if (trusted !== true) return;
  const now = Date.now();
  if (now - accessibilityRetriedAt < ACCESSIBILITY_RETRY_MS) return;
  accessibilityRetriedAt = now;
  void draftRestore?.retryAccessibility({ once: true });
}
/** The app's own events: activation, focus, closing the last window, and quitting. */
export function registerLifecycle() {
app.on("activate", () => {
  showWindow();
});
app.on("browser-window-focus", retryDraftsOnFocus);
app.on("window-all-closed", () => {
  if (!tray && process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (!service) return;
  // The system is going down: nothing may hold it up; running work ends with Relay.
  if (systemShuttingDown(systemShutdownAt, Date.now())) {
    set.quitting(true);
    return;
  }
  if (usageCredentialRefresher?.anyActive) {
    event.preventDefault();
    showWindow();
    void dialog.showMessageBox({
      type: "info",
      message: say("electronMain.aUsageSignInRenewalIs"),
      detail: say("electronMain.relayStaysOpenUntilTheRenewal"),
      buttons: [say("electronMain.ok")],
    });
    return;
  }
  if (quitting) return;
  if (desktop?.isBusy || desktopLock.busy) {
    event.preventDefault();
    return;
  }
  const active = service.runner.list().filter((r) => r.status === "running");
  if (!active.length) {
    if (
      service.auth
        .list()
        .some((f) => ["starting", "waiting", "verifying"].includes(f.status))
    ) {
      event.preventDefault();
      void service.auth.dispose().then(() => {
        set.quitting(true);
        app.quit();
      });
    } else {
      set.quitting(true);
    }
    return;
  }
  event.preventDefault();
  void dialog
    .showMessageBox({
      type: "question",
      buttons: [
        say("electronMain.backToRelay"),
        say("electronMain.stopAndQuit"),
      ],
      defaultId: 0,
      cancelId: 0,
      message: say("electronMain.terminalsRunning", { count: active.length }),
    })
    .then(async (result) => {
      if (result.response !== 1) return;
      try {
        await Promise.all(active.map((r) => service.runner.stop(r.id)));
        await service.auth.dispose();
        set.quitting(true);
        app.quit();
      } catch (error) {
        dialog.showErrorBox(
          say("electronMain.quitDidNotFinish"),
          String(error),
        );
      }
    });
});

app.on("will-quit", () => {
  // Here, not in "before-quit": that one can still be vetoed (a busy switch, a running
  // terminal), which would leave Relay open with its gateway down.
  void proxyServer?.stop();
  // Without the gateway a client still pointed at it cannot answer at all; the next start
  // points it back.
  try {
    releaseClients();
  } catch {}
  for (const bridge of antigravityBridges.values()) bridge.stop();
  appUpdates?.stop();
  globalShortcuts?.dispose();
  meters.stop();
  keeperAbort.abort();
  if (trayTimer) clearInterval(trayTimer);
  stopTokenScan();
  tray?.destroy();
  trayPanel?.destroy();
  switchStory?.destroy();
  switchWindow?.destroy();
  usage?.stop();
  autoSwitch?.stop();
  keeper?.stop();
  continuation?.stop();
  fleet?.stop();
  draftRestore?.stop();
});
}
