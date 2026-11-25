/** The first step: the registry, the language, the vault key and the Antigravity switcher. */
import { app, nativeTheme, powerMonitor, shell } from "electron";
import path from "node:path";
import { resolveLocale } from "../../../shared/i18n/locales";
import { authWindows } from "../../auth-window";
import { antigravityDataDir } from "../../core/antigravity-app";
import { AntigravitySwitcher, AntigravityVault, macAntigravityPorts } from "../../core/antigravity-switch";
import { themeSource } from "../../core/appearance";
import { safeStorageAvailable, safeStorageSealer } from "../../core/desktop-host";
import { loadLanguagePref } from "../../core/language-file";
import { ProcessLock } from "../../core/process-lock";
import { acquireProfileLock } from "../../core/profile-lock";
import { Service } from "../../core/service";
import type { Sealer } from "../../core/vault-crypto";
import { prepareVault } from "../../core/vault-migration";
import { say, setAppLocale } from "../../i18n";
import { antigravityBridge, discardPendingAntigravity } from "../antigravity";
import { profileLocks } from "../desktop-lock";
import { watchRegistry } from "../desktop-support";
import { antigravitySwitcher, languagePref, service, set, usage } from "../state";
import { broadcastChanged, window } from "../windows";

/** This computer's vault key, and why Claude app sign-ins cannot be saved when it is missing. */
export interface BootVault {
  sealer: Sealer;
  error?: string;
}
export async function bootVault(): Promise<BootVault> {
      app.dock?.setIcon(path.join(__dirname, "icon.png"));
      set.service(new Service(
        app.getPath("userData"),
        (event) => {
          if (window && !window.isDestroyed())
            window.webContents.send("relay:terminal", event);
        },
        undefined,
        (flow) => {
          if (flow.status === "connected") {
            usage?.invalidate(flow.accountId);
            usage?.tick();
          }
          // A renewal Relay runs by itself stays off the screens.
          if (!flow.background && window && !window.isDestroyed())
            window.webContents.send("relay:auth", flow);
        },
        (url) => shell.openExternal(url),
        (accountId, kind) => acquireProfileLock(profileLocks(), accountId, kind),
      ));
      // Main speaks before any window opens (tray, menu, widget): the saved language, which
      // installs from before the setting get as Turkish (what they saw), new ones as the system's.
      set.languagePref(loadLanguagePref(service.store.root, service.store.state.accounts.length > 0));
      setAppLocale(resolveLocale(languagePref, app.getPreferredSystemLanguages()));
      // A browser login may finish after its dialog closed or Relay restarted.
      // Recover only credentials that CLIProxyAPI actually saved and validated.
      for (const account of service.store.state.accounts) {
        if (account.provider !== "antigravity" || account.auth?.loggedIn) continue;
        const email = await antigravityBridge(account.id).savedOAuthEmail();
        // Never signed in and nothing saved: a sign-in Relay quit during; nothing can finish it.
        if (!email && !account.auth) {
          await discardPendingAntigravity(account.id);
          continue;
        }
        if (!email) continue;
        service.store.update((state) => {
          const saved = state.accounts.find((item) => item.id === account.id);
          if (saved) saved.auth = {
            loggedIn: true, checkedAt: new Date().toISOString(), email,
            subscription: "Antigravity OAuth",
          };
        });
      }
      // The usage sign-in opens in Relay's own window per account; Windows keeps the browser.
      if (process.platform !== "win32")
        service.auth.browser = authWindows(
          app.getPath("userData"),
          say,
          path.join(__dirname, "icon.png"),
        );
      watchRegistry();
      // A shutdown or restart quits Relay without asking: a veto there would stall the system.
      powerMonitor.on("shutdown", () => {
        set.systemShutdownAt(Date.now());
      });
      nativeTheme.themeSource = themeSource(service.store.state.settings);
      const vaultDir = path.join(app.getPath("userData"), "desktop-vault");
      set.operationLock(new ProcessLock(path.join(vaultDir, "operation.lock"), "app"));
      // Saved sign-ins move from safeStorage to the vault key the relay CLI can read too.
      const legacy = safeStorageSealer();
      // The vault key lives in the macOS Keychain; elsewhere the system's own store (Secret
      // Service or KWallet on Linux, DPAPI on Windows) seals through safeStorage.
      const vault =
        process.platform === "darwin"
          ? await prepareVault({
              vault: vaultDir,
              legacyUnseal: (data) => legacy.unseal(data),
              legacyAvailable: safeStorageAvailable,
              // The desktop smoke test points this at a fake; a packaged Relay never reads it.
              tool: app.isPackaged ? undefined : process.env.RELAY_SECURITY_TOOL,
            })
          : {
              sealer: legacy,
              error: safeStorageAvailable()
                ? undefined
                : process.platform === "linux"
                  ? "No system keyring was found (Secret Service or KWallet), so Claude app sign-ins cannot be saved. Install and unlock gnome-keyring or KWallet, then restart Relay."
                  : "System encryption is unavailable, so Claude app sign-ins cannot be saved.",
            };
      set.vaultSealer(vault.sealer);
      if (process.platform === "darwin")
        set.antigravitySwitcher(new AntigravitySwitcher(
          macAntigravityPorts(antigravityDataDir()),
          new AntigravityVault(vaultDir, (text) => vault.sealer.seal(text), (data) => vault.sealer.unseal(data)),
          () => service.store.state.accounts,
          () => broadcastChanged(),
        ));
      // A sign-in Relay took off this Mac for a new account's sign-in goes back if Relay quit mid-way.
      void antigravitySwitcher?.recover();
      return vault;
}
