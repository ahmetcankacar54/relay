/** The Claude app's manager on the vault, its launch choice and the separate windows; then Relay's updates. */
import { app } from "electron";
import path from "node:path";
import { DesktopManager, type DesktopHost } from "../../core/desktop";
import { identity, readObject } from "../../core/desktop-files";
import { desktopHost } from "../../core/desktop-host";
import { DesktopWindows } from "../../core/desktop-windows";
import { SwitchDiagnostics } from "../../core/switch-diagnostics";
import { alignDesktopWorkspace } from "../desktop-support";
import { logDraftEvent } from "../logs";
import { desktop, operationLock, service, set } from "../state";
import { startAppUpdates } from "../updates";
import { broadcastChanged } from "../windows";
import type { BootVault } from "./vault";
export function bootDesktop(vault: BootVault): DesktopHost {
      const host = desktopHost(vault.sealer, () => service.store.state.claudeApp);
      set.desktop(new DesktopManager(
        path.join(app.getPath("appData"), "Claude"),
        service.store,
        host,
      ));
      const lock = operationLock!;
      desktop.operationLock = {
        ensure: (kind) => {
          lock.tryAcquire(kind);
          return () => lock.release();
        },
      };
      // The captures and the vault's reads go to the same log as the restore.
      desktop.onDraftEvent = logDraftEvent;
      // A finished usage sign-in must be the profile's Claude app account; the flow says why not.
      service.signInFit = async (account) => {
        switch (await alignDesktopWorkspace(account)) {
          case "other-account":
            return "The browser signed in with another Claude account; this profile belongs to its Claude app account. Switch to the right account on claude.ai or use “Open in Relay window”, then renew the sign-in.";
          case "no-workspace":
            return "This sign-in belongs to a workspace of the account that the Claude app has not opened yet. Open Code in that workspace in the Claude app, then renew the sign-in.";
          default:
            return undefined;
        }
      };
      // How Relay starts Claude: HTTP/3 kept off once learned.
      const diagnostics = new SwitchDiagnostics(
        path.join(app.getPath("userData"), "switch-diagnostics"),
      );
      set.switchDiagnostics(diagnostics);
      desktop.launchChoice = {
        quicOff: () => diagnostics.current.quicOff,
        learnQuicOff: () => {
          diagnostics.set({ quicOff: true });
          broadcastChanged();
        },
      };
      if (process.platform === "darwin" || process.platform === "linux") {
        const windows = new DesktopWindows({
          folder: path.join(app.getPath("userData"), "claude-windows"),
          host,
          current: async () => identity(await readObject(desktop.root, "config.json")),
          seed: (accountUuid, dir) => desktop.seedWindow(accountUuid, dir),
          seal: (accountUuid, dir) => desktop.sealWindow(accountUuid, dir),
          quicOff: () => diagnostics.current.quicOff,
          now: Date.now,
          log: logDraftEvent,
        });
        set.desktopWindows(windows);
        desktop.windows = {
          openAccounts: () => windows.openAccounts(),
          anyOpen: () => windows.anyOpen(),
          folder: (accountUuid) => windows.folderOf(accountUuid),
        };
        // A window closed by hand gives its sign-in back to the vault within seconds.
        const settle = () =>
          void windows.reconcile().then(
            (sealed) => {
              if (sealed.length) broadcastChanged();
            },
            () => {},
          );
        settle();
        setInterval(settle, 15_000).unref();
      }
      startAppUpdates();
      return host;
}
