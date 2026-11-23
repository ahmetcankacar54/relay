/** IPC, the main window or a login launch, the link Relay was opened with, and the menu bar. */
import { app } from "electron";
import { relayLinkArgument } from "../../../shared/relay-link";
import { launchedAtLogin } from "../../core/login-item";
import { bindIPC } from "../ipc";
import { openRelayLink, takePendingRelayLink } from "../links";
import { applyLaunchAtLogin } from "../login-item";
import { set } from "../state";
import { startTokenScan } from "../tokens-widget";
import { createTrayStack } from "../tray-setup";
import { createWindow } from "../windows";
export function bootShell() {
      startTokenScan();
      bindIPC();
      set.initialized(true);
      void applyLaunchAtLogin();
      // A login launch stays in the tray; the window opens when the user asks for it.
      const loginLaunch = launchedAtLogin(
        process.argv,
        process.platform,
        process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin,
      );
      if (!loginLaunch) createWindow();
      else if (process.platform === "darwin") app.dock?.hide();
      // A relay:// link Relay was opened with: macOS hands it over before ready,
      // Windows and Linux on the command line.
      const launchLink =
        takePendingRelayLink() ??
        (process.platform === "darwin"
          ? undefined
          : relayLinkArgument(process.argv));
      if (launchLink) openRelayLink(launchLink);
      createTrayStack();
}
