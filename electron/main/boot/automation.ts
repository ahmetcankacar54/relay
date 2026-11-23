/** The Claude app's automation helper, the draft restore, and the extension and terminal sign-ins. */
import { app } from "electron";
import path from "node:path";
import { platformBrowserSystem } from "../../core/browser-system";
import { sqliteCookieStorage } from "../../core/cookie-store";
import type { DesktopHost } from "../../core/desktop";
import { nativeDesktopAutomation } from "../../core/desktop-continuation-host";
import { identity, readObject } from "../../core/desktop-files";
import { nativeDesktopWatch, unpackedPath } from "../../core/desktop-watch";
import { lastDraftWipeAt } from "../../core/desktop-wipe";
import { DraftScheduler } from "../../core/draft-main";
import { IDLE_MS, QUIET_MS } from "../../core/draft-restorer";
import { levelExtensionStorage } from "../../core/extension-storage";
import { linuxTerminalPorts, macTerminalPorts, scratchSignInPorts } from "../../core/terminal-identity";
import { desktopLock } from "../desktop-lock";
import { proxySettings } from "../gateway";
import { claudePageBooted, draftRetype, logDraftEvent, writeUiOutline } from "../logs";
import { notifyDrafts, notifyExtensionBroken, notifySignInEnded } from "../notifications";
import { automation, desktop, draftRestore, proxyServer, service, set } from "../state";
import { broadcastChanged } from "../windows";
export function bootAutomation(host: DesktopHost) {
      // The real file, so spawn can run it too (see unpackedPath).
      const automationHelper = unpackedPath(
        path.join(__dirname, "desktop-automation"),
      );
      // While separate windows run, the helper looks only at the main Claude.
      const automationTarget = async () => host.automationTarget?.();
      set.automation(nativeDesktopAutomation(automationHelper, undefined, automationTarget));
      // A diagnosis aid for development; a packaged Relay never reads it.
      if (process.platform === "darwin" && !app.isPackaged && process.env.RELAY_UI_OUTLINE === "1")
        void writeUiOutline(
          automationHelper,
          path.join(app.getPath("userData"), "diagnostics", "ui-outline.json"),
          () => host.running(),
        ).catch(() => {});
      set.draftRestore(new DraftScheduler({
        restorer: {
          automation,
          pending: () => desktop.pendingDraftRecords(),
          mark: (id, state, reason) => desktop.markDraft(id, state, reason),
          remove: (id) => desktop.dismissDraft(id),
          currentAccount: async () =>
            identity(await readObject(desktop.root, "config.json")),
          running: () => host.running(),
          uptimeMs: () => desktop.claudeUptimeMs(),
          // Read in place from Claude's live Local Storage: one key, nothing written.
          wipedAt: () =>
            lastDraftWipeAt(
              path.join(desktop.root, "Local Storage", "leveldb"),
            ),
          // From Claude's own log, macOS only: no link goes into a page still loading.
          ...(process.platform === "darwin" ? { pageBooted: claudePageBooted } : {}),
          withLock: (fn) => desktopLock.restore(fn, () => !desktop.isBusy),
          // The restore holds the lock as one caller: any more are waiting for it.
          yielding: () => desktopLock.callers > 1,
          notify: notifyDrafts,
          sleep: (ms) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms)),
          now: Date.now,
          log: logDraftEvent,
        },
        drafts: () => desktop.pendingDrafts(),
        changed: broadcastChanged,
        retype: draftRetype,
        // Where the user is in Claude, while drafts wait: one long-lived helper, macOS only.
        ...(process.platform === "darwin"
          ? { watch: nativeDesktopWatch(automationHelper, QUIET_MS, IDLE_MS, automationTarget) }
          : {}),
      }));
      // One hook for every switch: tray, panel, automatic, continuation and fleet.
      desktop.onSwitched = () => void draftRestore.afterSwitch();
      // The Claude extension's sign-in follows the account at each switch; macOS and Linux.
      const browserSystem = platformBrowserSystem();
      if (browserSystem) {
        desktop.extension = {
          system: browserSystem,
          storage: levelExtensionStorage,
          cookies: sqliteCookieStorage,
        };
        desktop.onSignInRejected = (account) => {
          notifySignInEnded(account);
          broadcastChanged();
        };
        desktop.onExtensionBroken = (account) => {
          notifyExtensionBroken(account);
          broadcastChanged();
        };
        // A login put back can be refused minutes after the switch: looked at again over half an
        // hour, and every quarter hour after that, so a dropped extension sign-in is told.
        desktop.extensionRecheckMs = [3 * 60_000, 12 * 60_000, 25 * 60_000];
        setInterval(() => {
          void desktop.extensionHealth().then(broadcastChanged, () => {});
        }, 15 * 60_000).unref();
      }
      // So does the terminal's Claude Code sign-in; macOS and Linux. Checked once at start, which
      // links a terminal already signed in to one of the accounts.
      desktop.terminal = macTerminalPorts() ?? linuxTerminalPorts();
      // Bound to the running gateway, Claude Code's requests do not use the terminal sign-in.
      desktop.gatewayBound = () => !!proxyServer && !!proxySettings().clientBindings?.["claude-code"];
      // A sign-in made for the terminal in a scratch folder: kept for the account, and the
      // Keychain item the CLI made for that folder goes with the folder.
      service.terminalAuth.browser = service.auth.browser;
      service.terminalLinkFit = async (accountId, dir) => {
        if (!desktop?.terminal) return "Terminal sign-ins are kept on macOS and Linux only.";
        const ports = scratchSignInPorts(dir);
        try {
          const result = await desktop.adoptTerminalSignIn(accountId, ports);
          if (result === "saved") return true;
          return result === "other-account"
            ? "The approval in the browser came from another Claude account or workspace. Try again with this profile’s account."
            : "The terminal sign-in did not complete. Try again.";
        } finally {
          await ports.keychain.remove().catch(() => undefined);
          broadcastChanged();
        }
      };
      void desktop.checkTerminal().catch(() => undefined);
}
