/**
 * The main process's entry: the process-wide setup that must run first, in this order, then the
 * startup once Electron is ready (main/boot) and the app's lifecycle (main/lifecycle). Everything
 * else lives in `electron/main/`; see docs/development.md, "Main process layout".
 */
import { app, crashReporter, dialog } from "electron";
import { finishPendingReset } from "./core/data-reset";
import { say } from "./i18n";
import { RELAY_SCHEME, relayLinkArgument } from "../shared/relay-link";
import { boot } from "./main/boot";
import { installProcessErrorHandlers } from "./main/errors";
import { registerLifecycle } from "./main/lifecycle";
import { openRelayLink } from "./main/links";
import { showWindow } from "./main/windows";

installProcessErrorHandlers();
// No Relay page embeds another one.
app.on("web-contents-created", (_event, contents) =>
  contents.on("will-attach-webview", (event) => event.preventDefault()),
);
app.setName("Relay");
// A data removal the user confirmed finishes here, before the crash reporter or Chromium opens the
// folder (core/data-reset.ts). The log folder is outside it on macOS.
{
  let logs: string[] = [];
  try {
    logs = [app.getPath("logs")];
  } catch {
    // No log folder yet: nothing there to remove.
  }
  finishPendingReset(app.getPath("userData"), logs);
}
// Crashes leave a minidump in the crash dump folder for a bug report; nothing is ever sent.
crashReporter.start({ uploadToServer: false });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const link = relayLinkArgument(argv);
    if (link) openRelayLink(link);
    else showWindow();
  });
  // macOS: the widgets' relay:// links, including the one that launches Relay.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openRelayLink(url);
  });
  // The packaged app's Info.plist declares the scheme; a development Electron
  // would claim relay:// for the bare Electron app, so it is left alone.
  if (app.isPackaged) {
    try {
      app.setAsDefaultProtocolClient(RELAY_SCHEME);
    } catch {
      // The links then open whichever Relay macOS picks; nothing else depends on it.
    }
  }
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox(say("electronMain.relayDidNotStart"), String(error));
      app.exit(1);
    });
}
registerLifecycle();
