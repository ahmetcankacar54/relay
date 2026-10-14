import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  shell,
  systemPreferences,
} from "electron";
import { themeSource } from "./core/appearance";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { DesktopManager } from "./core/desktop";
import { desktopHost } from "./core/desktop-host";
import { Service } from "./core/service";
import { UsageManager } from "./core/usage";
import { AutoSwitchManager } from "./core/auto-switch";
import { readCredential } from "./core/usage-credentials";
import {
  createAccountSchema,
  planningPatchSchema,
  planningSchema,
  settingsPatchSchema,
} from "./core/store";
import { accountPlanningSchema } from "./core/store";
import { RelayTray } from "./tray";
import { UsageHistory } from "./core/usage-history";
import { planningIdentity } from "../shared/planning";
import { WindowKeeper } from "./core/window-keeper";
import { runQuotaStarter } from "./core/routine-runner";
import { readProfileIdentity } from "./core/profile-identity";
import type { Account, DesktopState } from "../shared/types";
import { ContinuationEngine } from "./core/continuation";
import { FileContinuationJournal } from "./core/continuation-journal";
import {
  DesktopContinuationManager,
  FileDesktopContinuationPersistence,
} from "./core/desktop-continuation";
import {
  automationGuard,
  DesktopAutomationError,
  DesktopContinuationHost,
  nativeDesktopAutomation,
  type DesktopAutomationSnapshot,
} from "./core/desktop-continuation-host";
import {
  NativeDesktopContinuationEvidence,
  type QuotaStop,
} from "./core/desktop-continuation-evidence";
import { CONTINUATION_TEXT } from "./core/continuation";
import { FleetContinuation, type FleetResult } from "./core/fleet-continuation";
import { UsageCredentialRefresher } from "./core/usage-refresh";
import { UsageError } from "./core/usage-credentials";

let window: BrowserWindow | null = null;
let service: Service;
let desktop: DesktopManager;
let usage: UsageManager;
let usageCredentialRefresher: UsageCredentialRefresher;
let autoSwitch: AutoSwitchManager;
let tray: RelayTray | undefined;
let usageHistory: UsageHistory;
let trayTimer: ReturnType<typeof setInterval> | undefined;
let trayLanguage: "tr" | "en" = "tr";
let traySwitchRequest: string | null = null;
let keeper: WindowKeeper;
let observedDesktop: DesktopState | undefined;
let initialized = false;
let continuation: DesktopContinuationManager;
let fleet: FleetContinuation;
let automation: ReturnType<typeof nativeDesktopAutomation>;
let desktopTail: Promise<void> = Promise.resolve();
let desktopTransactionActive = false;
async function withDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  const before = desktopTail;
  let release!: () => void;
  desktopTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await before;
  desktopTransactionActive = true;
  try {
    return await action();
  } finally {
    desktopTransactionActive = false;
    release();
  }
}
function manualDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  if (desktopTransactionActive)
    return Promise.reject(
      new Error(
        "Finish the Desktop handoff before starting another Desktop operation.",
      ),
    );
  if (usageCredentialRefresher?.anyActive)
    return Promise.reject(
      new Error("Wait for the account connection refresh to finish."),
    );
  return withDesktopLock(action);
}
function pendingAuth() {
  return (
    usageCredentialRefresher?.anyActive ||
    service.auth
      .list()
      .some((f) => ["starting", "waiting", "verifying"].includes(f.status))
  );
}
function displayUsage() {
  const current = usage.snapshot();
  for (const account of service.store.state.accounts) {
    if (current[account.id])
      current[account.id] = {
        ...current[account.id],
        lastKnownResets: usageHistory.lastKnownResets(account),
      };
  }
  return current;
}
const keeperAbort = new AbortController();
let quitting = false;
app.setName("Relay");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    showWindow();
  });
  app
    .whenReady()
    .then(async () => {
      app.dock?.setIcon(path.join(__dirname, "icon.png"));
      service = new Service(
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
          if (window && !window.isDestroyed())
            window.webContents.send("relay:auth", flow);
        },
        (url) => shell.openExternal(url),
      );
      nativeTheme.themeSource = themeSource(service.store.state.settings);
      desktop = new DesktopManager(
        path.join(app.getPath("appData"), "Claude"),
        service.store,
        desktopHost(),
      );
      await desktop.initialize();
      usageHistory = new UsageHistory(app.getPath("userData"));
      const readUsageCredential = (profile: string, allowPrompt: boolean) =>
        readCredential(profile, allowPrompt);
      usageCredentialRefresher = new UsageCredentialRefresher({
        read: readUsageCredential,
        executable: async () => {
          const { diagnostics } = await service.panelSnapshot();
          if (!diagnostics.executable || diagnostics.error)
            throw new UsageError("unavailable");
          const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(
            diagnostics.version ?? "",
          );
          if (
            !version ||
            Number(version[1]) < 2 ||
            (Number(version[1]) === 2 && Number(version[2]) === 0) ||
            (Number(version[1]) === 2 &&
              Number(version[2]) === 1 &&
              Number(version[3]) < 296)
          )
            throw new UsageError("unavailable");
          return diagnostics.executable;
        },
        canProceed: (account, profile) => {
          const current = service.store.state.accounts.find(
            (item) => item.id === account.id,
          );
          return (
            !desktopTransactionActive &&
            !service.auth.active(account.id) &&
            !service.runner
              .list()
              .some(
                (run) =>
                  run.accountId === account.id && run.status === "running",
              ) &&
            !!current?.auth?.loggedIn &&
            current.auth.accountUuid === account.auth?.accountUuid &&
            current.auth.orgId === account.auth?.orgId &&
            service.store.profile(account.id) === profile
          );
        },
      });
      usage = new UsageManager(
        service.store,
        readUsageCredential,
        undefined,
        undefined,
        (account, value) => usageHistory.record(account, value),
        (account, credential, force, allowInteraction) =>
          service.transaction(() =>
            usageCredentialRefresher.refresh(
              account,
              service.store.profile(account.id),
              credential,
              force,
              allowInteraction,
            ),
          ),
        (account) =>
          usageCredentialRefresher.hasPending(
            service.store.profile(account.id),
          ),
      );
      automation = nativeDesktopAutomation(
        path.join(__dirname, "desktop-automation"),
      );
      const evidence = new NativeDesktopContinuationEvidence({
        store: service.store,
        desktop,
        automation,
        claudeRoot: path.join(app.getPath("appData"), "Claude"),
        transcriptRoot: path.join(os.homedir(), ".claude"),
      });
      const continuationHost = new DesktopContinuationHost(
        automation,
        evidence,
      );
      continuation = new DesktopContinuationManager({
        capabilities: continuationHost.capabilities,
        engine: new ContinuationEngine(
          continuationHost,
          new FileContinuationJournal(
            path.join(app.getPath("userData"), "continuation-journal"),
          ),
        ),
        persistence: new FileDesktopContinuationPersistence(
          path.join(app.getPath("userData"), "continuation"),
        ),
        observe: async () => {
          if (process.platform !== "darwin")
            throw new DesktopAutomationError("desktop-ui-unsupported");
          const state = await continuationHost.readState();
          return {
            state,
            quotaStop: state.quotaStop,
            ownQuotaWakeup: state.ownQuotaWakeup,
          };
        },
        prepareQuotaStop: async (observation) => {
          const state = await continuationHost.cancelQuotaResume(
            observation.state.contextRevision,
          );
          return {
            state,
            quotaStop: state.quotaStop,
            ownQuotaWakeup: state.ownQuotaWakeup,
          };
        },
        snapshot: () => ({
          accounts: service.store.state.accounts,
          settings: service.store.state.settings,
          usage: usage.snapshot(),
        }),
        withDesktopLock,
        pendingAuth: () => pendingAuth() || !!observedDesktop?.pendingProfileId,
        changed: () => window?.webContents.send("relay:changed"),
      });
      autoSwitch = new AutoSwitchManager(service.store, desktop, usage, {
        withDesktopLock,
        pendingAuth: () =>
          fleet?.enabled ||
          continuation.snapshot().enabled ||
          continuation.snapshot().status === "reconciliation-required" ||
          continuation.snapshot().reason === "continuation-state-unreadable" ||
          pendingAuth(),
        changed: () => {
          if (window && !window.isDestroyed())
            window.webContents.send("relay:changed");
        },
      });
      /** Reopen one stopped conversation on the target, verify it and send once. */
      const continueConversation = async (
        stop: QuotaStop,
        target: Account,
        requestId: string,
        beforeSend: () => void,
      ): Promise<FleetResult> => {
        const sleep = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        let snapshot: DesktopAutomationSnapshot | undefined;
        let openedAt = -Infinity;
        // Claude may still be starting; resend the link until the view loads.
        for (let attempt = 0; attempt < 120 && !snapshot; attempt++) {
          try {
            const view = await automation.inspect();
            if (
              view.localSessionId === stop.localSessionId &&
              view.permissionMode
            )
              snapshot = view;
            else if (Date.now() - openedAt >= 5_000) {
              openedAt = Date.now();
              await automation.openSession(stop.localSessionId);
            }
          } catch {
            // Not ready yet.
          }
          if (!snapshot) await sleep(500);
        }
        if (!snapshot) return "skipped";
        const state = await evidence.read(snapshot);
        if (
          state.identity.profileId !== target.id ||
          state.session.id !== stop.cliSessionId ||
          snapshot.status !== "stopped" ||
          !evidence.unchanged(stop)
        )
          return "skipped";
        if (
          stop.permissionMode &&
          snapshot.permissionMode !== stop.permissionMode
        ) {
          snapshot = await automation.setPermission(
            automationGuard(snapshot),
            stop.permissionMode,
          );
          if (snapshot.permissionMode !== stop.permissionMode) return "skipped";
        }
        // Claude's own "continue when limits reset" would send a second prompt.
        if (snapshot.quotaAutoResume && automation.cancelQuotaResume)
          try {
            snapshot = await automation.cancelQuotaResume(
              automationGuard(snapshot),
            );
          } catch {
            // The banner may be gone on the new account; nothing to cancel.
          }
        if (!snapshot.composerEmpty || snapshot.status !== "stopped")
          return "skipped";
        if ((await evidence.deliveryAfter(stop, requestId)) !== "absent")
          return "unknown";
        beforeSend();
        await automation.send(
          automationGuard(snapshot),
          requestId,
          CONTINUATION_TEXT,
        );
        for (let attempt = 0; attempt < 110; attempt++) {
          const delivery = await evidence.deliveryAfter(stop, requestId);
          if (delivery === "started" || delivery === "unknown") return delivery;
          await sleep(attempt < 10 ? 500 : 2_000);
        }
        const final = await evidence.deliveryAfter(stop, requestId);
        return final === "started" || final === "accepted" ? final : "unknown";
      };
      fleet = new FleetContinuation({
        directory: path.join(app.getPath("userData"), "fleet-continuation"),
        snapshot: () => ({
          accounts: service.store.state.accounts,
          settings: service.store.state.settings,
          usage: usage.snapshot(),
        }),
        desktop: async () => ({
          ...(observedDesktop = await desktop.snapshot()),
          busy: desktop.isBusy || desktopTransactionActive,
        }),
        busy: () =>
          pendingAuth() ||
          continuation.snapshot().enabled ||
          continuation.snapshot().status === "executing" ||
          continuation.snapshot().status === "reconciliation-required",
        stops: (account) => evidence.quotaStops(account),
        quiet: (stops) => evidence.quietExcept(stops),
        quietSync: (stops) => evidence.quietExceptSync(stops),
        unchanged: (stop) => evidence.unchanged(stop),
        automationReady: async () => {
          if (process.platform !== "darwin") return "desktop-ui-unsupported";
          try {
            await automation.inspect();
            return undefined;
          } catch (error) {
            const issue =
              error instanceof DesktopAutomationError
                ? error.issue
                : "desktop-ui-unsupported";
            // Claude being closed is fine: the switch launches it.
            return issue === "claude-not-running" ? undefined : issue;
          }
        },
        switchTo: (targetId, guards) => desktop.switchTo(targetId, guards),
        continueOne: continueConversation,
        withDesktopLock,
        changed: () => window?.webContents.send("relay:changed"),
      });
      observedDesktop = await desktop.snapshot();
      const keeperBlocked = () =>
        !observedDesktop ||
        desktopTransactionActive ||
        observedDesktop.busy ||
        observedDesktop.recoveryRequired ||
        !!observedDesktop.pendingProfileId ||
        pendingAuth() ||
        ["switching", "continuing"].includes(fleet.snapshot().status) ||
        continuation.snapshot().status === "executing";
      keeper = new WindowKeeper({
        directory: path.join(app.getPath("userData"), "window-keeper"),
        state: () => ({
          settings: service.store.state.settings.planning,
          accounts: service.store.state.accounts,
          usage: usage.snapshot(),
          blocked: keeperBlocked(),
          busyAccountIds: service.runner
            .list()
            .filter((run) => run.status === "running")
            .map((run) => run.accountId),
        }),
        refresh: (id) => usage.refresh(id),
        refreshAfterStart: (id) => usage.refreshAfterRequest(id),
        start: async (account) => {
          observedDesktop = await desktop.snapshot();
          const identity = planningIdentity(account);
          await runQuotaStarter(service.store, account, readUsageCredential, {
            signal: keeperAbort.signal,
            guard: async () => {
              observedDesktop = await desktop.snapshot();
              return (
                service.store.state.settings.planning.autoStart &&
                !keeperBlocked() &&
                planningIdentity(service.store.account(account.id)) === identity
              );
            },
          });
        },
        notify: (account, reason) => {
          if (!Notification.isSupported()) return;
          new Notification({
            title: "Relay",
            body:
              trayLanguage === "en"
                ? `Could not start ${account.name}'s usage window (${reason}).`
                : `${account.name} kullanım penceresi başlatılamadı (${reason}).`,
          }).show();
        },
        changed: () => window?.webContents.send("relay:changed"),
      });
      bindIPC();
      initialized = true;
      createWindow();
      tray = new RelayTray({
        getSnapshot: async () => ({
          accounts: service.store.state.accounts,
          usage: usage.snapshot(),
          desktop: {
            ...(observedDesktop = await desktop.snapshot()),
            busy: desktop.isBusy || desktopTransactionActive,
          },
          authBusy: service.auth
            .list()
            .some((f) =>
              ["starting", "waiting", "verifying"].includes(f.status),
            ),
        }),
        showWindow,
        requestSwitch: (profileId) => void traySwitch(profileId),
        quit: () => app.quit(),
        language: () => trayLanguage,
      });
      trayTimer = setInterval(() => tray?.update(), 5000);
      trayTimer.unref();
      void service
        .reconcileAuth()
        .finally(() => {
          // Corroborate legacy profiles before the first quota request. Otherwise
          // updated identity fields can hide that request behind its old cooldown.
          usage.start();
          autoSwitch.start();
          keeper.start();
          continuation.start();
          fleet.start();
          window?.webContents.send("relay:changed");
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
    })
    .catch((error) => {
      dialog.showErrorBox("Relay açılamadı", String(error));
      app.exit(1);
    });
}
function showWindow() {
  if (!initialized) return;
  if (!window && service) createWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
/** Menu-bar switch: one native confirmation, then the normal saved-login switch. */
async function traySwitch(profileId: string) {
  const account = service.store.state.accounts.find((a) => a.id === profileId);
  if (!account) return;
  const en = trayLanguage === "en";
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: [
      en ? "Switch and restart Claude" : "Geç ve Claude’u yeniden başlat",
      en ? "Cancel" : "Vazgeç",
    ],
    defaultId: 0,
    cancelId: 1,
    message: en
      ? `Switch Claude to ${account.name}?`
      : `Claude, ${account.name} hesabına geçsin mi?`,
    detail: en
      ? "Claude quits and reopens with this account. Let running replies finish first; your conversations stay in Claude."
      : "Claude kapanıp bu hesapla yeniden açılır. Çalışan yanıtlar varsa önce bitmelerini bekle; konuşmaların Claude’da kalır.",
  });
  if (response !== 0) return;
  try {
    await manualDesktopLock(() => desktop.switchTo(profileId));
    if (Notification.isSupported())
      new Notification({
        title: "Relay",
        body: en
          ? `Claude switched to ${account.name}.`
          : `Claude, ${account.name} hesabına geçti.`,
      }).show();
  } catch (error) {
    dialog.showErrorBox(
      en ? "Switch failed" : "Geçiş yapılamadı",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    void tray?.update();
    if (window && !window.isDestroyed())
      window.webContents.send("relay:changed");
  }
}
function createWindow() {
  window = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: "Relay",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1916" : "#fbf8f3",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 22, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: "Relay",
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
      {
        label: "Düzenle",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Görünüm",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  const devURL = !app.isPackaged && process.env.RELAY_DEV_URL;
  if (devURL === "http://127.0.0.1:5173") void window.loadURL(devURL);
  else void window.loadFile(path.join(__dirname, "../dist/index.html"));
  window.on("closed", () => {
    window = null;
  });
  window.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      window?.hide();
    }
  });
}
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("Geçersiz IPC kaynağı.");
}
function bindIPC() {
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`relay:${name}`, (event, ...args) => {
      trusted(event);
      return fn(...args);
    });
  const id = z.uuid();
  const key = z.string().min(1).max(100);
  handle("inspect-continuation", () => continuation.inspect());
  handle("arm-continuation", async (targetId, policy) => {
    const targetAccountId = z
      .union([z.literal("automatic"), id])
      .parse(targetId);
    const executionPolicy = z
      .literal("guarded-native-at-most-once")
      .parse(policy);
    // Ask for the saved sign-ins' Keychain consent now, not during the handoff.
    await desktop.verifySavedLogins();
    return continuation.arm({ targetAccountId, executionPolicy });
  });
  handle("disarm-continuation", () => continuation.disarm());
  handle("set-fleet-continuation", async (enabled) => {
    const on = z.boolean().parse(enabled);
    if (on) {
      // Ask for the saved sign-ins' Keychain consent now, not during a handoff.
      await desktop.verifySavedLogins();
      // One monitor at a time: the all-conversations mode replaces a single watch.
      if (continuation.snapshot().enabled) await continuation.disarm();
    }
    const state = fleet.setEnabled(on);
    if (on) void fleet.tick();
    return state;
  });
  handle("reconcile-continuation", () => continuation.resumePending());
  handle("abandon-continuation", () => continuation.abandonPending());
  handle("request-desktop-accessibility", async () => {
    if (process.platform !== "darwin") return false;
    // Register the explicit permission request against the foreground Relay app.
    // A helper-only request can obscure which rebuilt app owns the OS consent.
    systemPreferences.isTrustedAccessibilityClient(true);
    // The child still verifies its real access; the main-process result alone
    // must never authorize Desktop inspection or any automation.
    const granted = (await automation.requestAccessibility?.()) ?? false;
    if (process.platform === "darwin" && !granted)
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    return granted;
  });
  handle("consume-tray-switch", () => {
    const requested = traySwitchRequest;
    traySwitchRequest = null;
    return requested;
  });
  handle("tray-language", (value) => {
    trayLanguage = z.enum(["tr", "en"]).parse(value);
    tray?.update();
  });
  handle("account-planning", (accountId, input) => {
    if (desktop.isBusy || desktopTransactionActive)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const account = service.store.account(id.parse(accountId));
    const planning = accountPlanningSchema.parse(input);
    service.store.update((s) => {
      s.accounts.find((a) => a.id === account.id)!.planning = planning;
    });
    return service.store.account(account.id);
  });
  handle("desktop-snapshot", async () => ({
    ...(await desktop.snapshot()),
    busy:
      desktop.isBusy ||
      desktopTransactionActive ||
      usageCredentialRefresher?.anyActive,
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
  handle("cancel-desktop-login", () =>
    manualDesktopLock(() => desktop.cancelLogin()),
  );
  handle("switch-desktop", (profileId) =>
    manualDesktopLock(() => desktop.switchTo(id.parse(profileId))),
  );
  handle("sync-desktop-history", (profileId) =>
    manualDesktopLock(() => desktop.syncHistory(id.parse(profileId))),
  );
  handle("desktop-history-summary", (profileId) =>
    desktop.historySummary(id.parse(profileId)),
  );
  handle("open-desktop", () => manualDesktopLock(() => desktop.open()));
  handle("recover-desktop", () => manualDesktopLock(() => desktop.recover()));
  handle("update-settings", (input) => {
    if (desktop.isBusy || desktopTransactionActive)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const patch = settingsPatchSchema.parse(input);
    for (const selected of [
      patch.desktopHistoryAccounts,
      patch.autoSwitchAccounts,
    ]) {
      if (
        selected &&
        (new Set(selected).size !== selected.length ||
          selected.some(
            (profileId) =>
              !service.store.state.accounts.some(
                (account) => account.id === profileId,
              ),
          ))
      )
        throw new Error("Select existing Relay accounts once each.");
    }
    service.store.update((s) => {
      Object.assign(s.settings, patch);
    });
    nativeTheme.themeSource = themeSource(service.store.state.settings);
    usage.tick();
    void autoSwitch.tick();
    return service.store.state.settings;
  });
  handle("update-planning", (input) => {
    if (desktop.isBusy || desktopTransactionActive)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const patch = planningPatchSchema.parse(input);
    const next = planningSchema.parse({
      ...service.store.state.settings.planning,
      ...patch,
    });
    if (
      next.accounts.some(
        ({ id }) => !service.store.state.accounts.some((a) => a.id === id),
      )
    )
      throw new Error("Select existing Relay accounts once each.");
    service.store.update((s) => {
      s.settings.planning = next;
    });
    keeper.resume();
    void keeper.tick();
    return next;
  });
  handle("refresh-usage", (accountId, allowPrompt) =>
    usage.refresh(
      id.parse(accountId),
      z.boolean().optional().parse(allowPrompt),
    ),
  );
  handle("panel-snapshot", async () => ({
    ...(await service.panelSnapshot()),
    usage: displayUsage(),
    continuation: continuation.snapshot(),
    fleet: fleet.snapshot(),
    autoSwitch: autoSwitch.snapshot(),
    usageStatistics: usageHistory.snapshot(service.store.state.accounts),
    planning: keeper.snapshot(),
  }));
  handle("snapshot", () =>
    service.transaction(async () => ({
      ...(await service.snapshot()),
      usage: displayUsage(),
      continuation: continuation.snapshot(),
      fleet: fleet.snapshot(),
      autoSwitch: autoSwitch.snapshot(),
      usageStatistics: usageHistory.snapshot(service.store.state.accounts),
      planning: keeper.snapshot(),
    })),
  );
  handle("create-account", (input) =>
    service.store.create(createAccountSchema.parse(input)),
  );
  handle("check-auth", (accountId) =>
    service.transaction(() => {
      const account = id.parse(accountId);
      if (usageCredentialRefresher.isRefreshing(account))
        throw new Error("Wait for the account connection refresh to finish.");
      return service.checkAuth(account);
    }),
  );
  handle("login", (accountId) => {
    if (desktopTransactionActive)
      throw new Error("Finish the Desktop handoff before signing in.");
    return service.transaction(() => {
      const account = id.parse(accountId);
      if (usageCredentialRefresher.isRefreshing(account))
        throw new Error("Wait for the account connection refresh to finish.");
      return service.login(account);
    });
  });
  handle("reopen-login", (accountId, attemptId) =>
    service.auth.reopen(id.parse(accountId), id.parse(attemptId)),
  );
  handle("cancel-login", (accountId, attemptId) =>
    service.auth.cancel(id.parse(accountId), id.parse(attemptId)),
  );
  handle("submit-login-code", (accountId, attemptId, code) =>
    service.auth.submitCode(
      id.parse(accountId),
      id.parse(attemptId),
      z.string().max(4096).parse(code),
    ),
  );
  handle("close-run", (runId) => service.runner.close(id.parse(runId)));
  handle("launch", (input) => service.transaction(() => service.launch(input)));
  handle("switch-account", (runId, accountId) =>
    service.transaction(() =>
      service.switchAccount(id.parse(runId), id.parse(accountId)),
    ),
  );
  handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openDirectory"],
      title: "Proje klasörünü seç",
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("pick-executable", async () => {
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openFile"],
      title: "Claude native çalıştırılabilir dosyasını seç",
    });
    if (!result.canceled) {
      service.store.update((s) => {
        s.executable = result.filePaths[0];
      });
      await service.diagnose();
    }
  });
  handle("import", () => {
    service.store.update((s) => {
      s.importEnabled = true;
    });
  });
  handle("pin", (sessionKey, pinned) =>
    service.pin(key.parse(sessionKey), z.boolean().parse(pinned)),
  );
  handle("cooldown", (accountId, hours) =>
    service.cooldown(
      id.parse(accountId),
      z.number().int().min(0).max(168).parse(hours),
    ),
  );
  handle("transcript", (sessionKey) =>
    service.transcript(key.parse(sessionKey)),
  );
  handle("buffer", (runId) => service.runner.buffer(id.parse(runId)));
  handle("stop", (runId) => service.runner.stop(id.parse(runId)));
  ipcMain.on("relay:write", (event, runId, data) => {
    try {
      trusted(event);
      service.runner.write(id.parse(runId), z.string().max(64_000).parse(data));
    } catch {
      /* Ignore invalid one-way messages. */
    }
  });
  ipcMain.on("relay:resize", (event, runId, cols, rows) => {
    try {
      trusted(event);
      service.runner.resize(
        id.parse(runId),
        z.number().int().min(10).max(500).parse(cols),
        z.number().int().min(3).max(200).parse(rows),
      );
    } catch {
      /* Ignore invalid one-way messages. */
    }
  });
}
app.on("activate", () => {
  showWindow();
});
app.on("window-all-closed", () => {
  if (!tray && process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (!service) return;
  if (usageCredentialRefresher?.anyActive) {
    event.preventDefault();
    showWindow();
    void dialog.showMessageBox({
      type: "info",
      message:
        trayLanguage === "en"
          ? "Refreshing the account connection."
          : "Hesap bağlantısı yenileniyor.",
      detail:
        trayLanguage === "en"
          ? "Relay stayed open to finish the connection safely. Quit again after it completes. Claude and its tasks are unaffected."
          : "Bağlantıyı yarım bırakmamak için Relay açık kaldı. İşlem tamamlandıktan sonra yeniden çıkabilirsiniz. Claude ve görevleri etkilenmez.",
      buttons: [trayLanguage === "en" ? "OK" : "Tamam"],
    });
    return;
  }
  if (quitting) return;
  if (desktop?.isBusy || desktopTransactionActive) {
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
        quitting = true;
        app.quit();
      });
    } else {
      quitting = true;
    }
    return;
  }
  event.preventDefault();
  void dialog
    .showMessageBox({
      type: "question",
      buttons: ["Uygulamaya dön", "Oturumları durdur ve çık"],
      defaultId: 0,
      cancelId: 0,
      message: `${active.length} terminal çalışıyor.`,
      detail:
        "Çıkışta bu işlemler durur. Kaydedilmiş konuşmalar oturum kataloğunda kalır.",
    })
    .then(async (result) => {
      if (result.response !== 1) return;
      try {
        await Promise.all(active.map((r) => service.runner.stop(r.id)));
        await service.auth.dispose();
        quitting = true;
        app.quit();
      } catch (error) {
        dialog.showErrorBox("Çıkış tamamlanmadı", String(error));
      }
    });
});

app.on("will-quit", () => {
  keeperAbort.abort();
  if (trayTimer) clearInterval(trayTimer);
  tray?.destroy();
  usage?.stop();
  autoSwitch?.stop();
  keeper?.stop();
  continuation?.stop();
  fleet?.stop();
});
