import { app } from "electron";
import { beginReset } from "../core/data-reset";
import { setLaunchAtLogin } from "../core/login-item";
import { PROXY_CLIENTS, unbindClient } from "../core/proxy/proxy-clients";
import { securityKeychain } from "../core/terminal-identity";
import { credentialService } from "../core/usage-credentials";
import { VAULT_KEY_ACCOUNT, VAULT_KEY_SERVICE } from "../core/vault-key";
import { say } from "../i18n";
import { manualDesktopLock, pendingAuth } from "./desktop-lock";
import { proxySettings, saveProxySettings, serializeProxy, stopProxy } from "./gateway";
import { loginItemHost } from "./login-item";
import { desktopWindows, service, set } from "./state";
/**
 * Settings → Advanced → Remove Relay's data, the running half (core/data-reset.ts): refused during
 * a Desktop operation, a running terminal, a sign-in or with separate Claude windows open; then the
 * gateway stops, its clients get their own settings back, the login item and Relay's Keychain items
 * go, and Relay relaunches to empty its folder before anything opens it.
 */
export async function resetData(): Promise<void> {
  if (await desktopWindows?.anyOpen()) throw new Error(say("dataReset.busyWindows"));
  const tool = app.isPackaged ? undefined : process.env.RELAY_SECURITY_TOOL;
  await manualDesktopLock(() =>
    beginReset({
      root: app.getPath("userData"),
      busy: () =>
        service.runner.list().some((run) => run.status === "running")
          ? say("dataReset.busyTerminals")
          : pendingAuth()
            ? say("dataReset.busySignIn")
            : undefined,
      stopGateway: () => serializeProxy(stopProxy),
      unbindClients: () =>
        serializeProxy(async () => {
          const bindings = proxySettings().clientBindings ?? {};
          for (const id of PROXY_CLIENTS) {
            const saved = bindings[id];
            if (saved) await unbindClient(id, saved);
          }
          saveProxySettings({ ...proxySettings(), enabled: false, clientBindings: {} });
        }),
      removeLoginItem: async () => {
        if (app.isPackaged) await setLaunchAtLogin(false, loginItemHost());
      },
      // Elsewhere the profiles' sign-ins are files in the folder and the vault key is the system's.
      removeSecrets: async () => {
        if (process.platform !== "darwin") return;
        for (const account of service.store.state.accounts)
          await securityKeychain(undefined, tool, credentialService(service.store.profile(account.id))).remove();
        await securityKeychain(VAULT_KEY_ACCOUNT, tool, VAULT_KEY_SERVICE).remove();
      },
      relaunch: () => {
        set.quitting(true);
        app.relaunch();
        app.quit();
      },
    }),
  );
}
