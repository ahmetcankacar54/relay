/** The last step: once the saved sign-ins are reconciled, every background service starts. */
import { app } from "electron";
import path from "node:path";
import { SignInRenewal } from "../../core/sign-in-renewal";
import { alignDesktopWorkspace } from "../desktop-support";
import { serializeProxy, settleProxyAffinity, startProxy } from "../gateway";
import { meters, notifySignInEnding } from "../notifications";
import { renewSignInQuietly } from "../sign-in-renewal";
import {
  autoSwitch,
  continuation,
  desktop,
  draftRestore,
  fleet,
  keeper,
  service,
  set,
  signInRenewal,
  usage,
} from "../state";
import { broadcastChanged } from "../windows";
export function bootStart() {
      meters.start();
      void service
        .reconcileAuth()
        // A profile saved in the wrong workspace of its own account, before Relay could tell.
        .then(async () => {
          for (const account of service.store.state.accounts)
            await alignDesktopWorkspace(account).catch(() => {});
        })
        .finally(() => {
          // Corroborate legacy profiles before the first quota request. Otherwise
          // updated identity fields can hide that request behind its old cooldown.
          usage.start();
          // Claude Code sign-ins end about 30 days after they were made: renew them before.
          if (process.platform === "darwin") {
            set.signInRenewal(new SignInRenewal({
              file: path.join(app.getPath("userData"), "sign-in-renewal.json"),
              accounts: () => service.store.state.accounts,
              usage: (id) => usage.snapshot()[id],
              renew: renewSignInQuietly,
              notify: notifySignInEnding,
            }));
            // After the first reads have said when each sign-in ends.
            setTimeout(() => void signInRenewal?.tick().catch(() => {}), 3 * 60_000).unref();
            setInterval(() => void signInRenewal?.tick().catch(() => {}), 15 * 60_000).unref();
          }
          try {
            settleProxyAffinity();
          } catch {
            // The lifetime stays as saved; the gateway starts all the same.
          }
          // A gateway that cannot start (the port is taken) shows why on its page; Relay opens.
          if (service.store.state.settings.proxy?.enabled)
            void serializeProxy(startProxy).catch(() => broadcastChanged());
          autoSwitch.start();
          keeper.start();
          continuation.start();
          fleet.start();
          void draftRestore.start();
          broadcastChanged();
          // An unattended switch must not wait on a Keychain consent; ask now,
          // while Relay was just opened by the user.
          if (
            fleet.enabled ||
            continuation.snapshot().enabled ||
            service.store.state.settings.autoSwitchMode !== "off"
          )
            void desktop.verifySavedLogins().catch(() => {});
        })
        .catch(() => {});
}
