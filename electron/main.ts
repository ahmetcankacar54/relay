import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  shell,
  systemPreferences,
} from "electron";
import { themeSource } from "./core/appearance";
import { appMenuTemplate } from "./app-menu";
import { pick } from "./language";
import { routineFailureNotice } from "../shared/routine-failure";
import { localizeError } from "../src/messages";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { ActiveAccountTimeline } from "./core/active-account-timeline";
import { DesktopManager } from "./core/desktop";
import { desktopHost } from "./core/desktop-host";
import { identity, readObject } from "./core/desktop-files";
import { DesktopLock } from "./core/desktop-lock";
import {
  DraftScheduler,
  draftActions,
  draftNotice,
  draftSummaries,
} from "./core/draft-main";
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
import { motionAllowed, readDesktopForTray } from "./core/tray-mascot";
import { TrayPanel } from "./tray-panel";
import { SwitchWindow } from "./switch-window";
import { SwitchStory, sceneView } from "../shared/switch-scene";
import { PAGE_INTENTS, PAGES } from "../src/app/routes";
import { isExternalLink } from "../shared/external-links";
import { readsUsage } from "../shared/cli-version";
import { UsageHistory } from "./core/usage-history";
import { usageStatisticsInput } from "./core/usage-statistics-input";
import { buildStatisticsView } from "../shared/usage-statistics-view";
import { planningIdentity } from "../shared/planning";
import { PACE_WINDOW_MS } from "../shared/adaptive-plan";
import { WindowKeeper, type KeeperDeps } from "./core/window-keeper";
import { TempoTracker } from "./core/tempo-tracker";
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
import { appendUsageIssue } from "./core/usage-issue-log";
import { appendDraftEvent, draftEventFilter } from "./core/draft-diagnostics";
import { UsageError } from "./core/usage-credentials";

let window: BrowserWindow | null = null;
let service: Service;
let desktop: DesktopManager;
let usage: UsageManager;
let usageCredentialRefresher: UsageCredentialRefresher;
let autoSwitch: AutoSwitchManager;
let tray: RelayTray | undefined;
let trayPanel: TrayPanel | undefined;
let switchWindow: SwitchWindow | undefined;
let switchStory: SwitchStory | undefined;
let usageHistory: UsageHistory;
let activeTimeline: ActiveAccountTimeline;
let tempo: TempoTracker;
let trayTimer: ReturnType<typeof setInterval> | undefined;
let trayLanguage: "tr" | "en" = "tr";
/** Main's own copy (menus, dialogs, notifications) in the app's language. */
const say = (tr: string, en: string) => pick(trayLanguage)(tr, en);
let keeper: WindowKeeper;
let observedDesktop: DesktopState | undefined;
let initialized = false;
let continuation: DesktopContinuationManager;
let fleet: FleetContinuation;
let automation: ReturnType<typeof nativeDesktopAutomation>;
let draftRestore: DraftScheduler;
/** Drafts are re-typed into Claude only once the user turns it on; missing means off. */
const draftRetype = () => service.store.state.settings.draftRetype === true;
/**
 * A feature that needs Accessibility is on: re-typing drafts, or continuing conversations at
 * the limit. Only then does Relay ask for it.
 */
function accessibilityWanted() {
  return draftRetype() || fleet.enabled || continuation.snapshot().enabled;
}
/** Whether a draft event is worth logging: a run that does nothing says so once. */
const draftEventAllowed = draftEventFilter();
/**
 * One event of the draft restore, for `draft-events.json` in the user data folder, a short
 * private log that finds where a restore broke. Fields are ids, states, reasons and counts,
 * never a draft's text. Never throws: a log must not disturb a restore.
 */
function logDraftEvent(event: string, fields?: Record<string, unknown>) {
  try {
    if (!draftEventAllowed(event, fields)) return;
    appendDraftEvent(
      path.join(app.getPath("userData"), "draft-events.json"),
      { ...fields, event },
      Date.now(),
    );
  } catch {
    // The log is an aid, never a part of a restore.
  }
}
/**
 * One Desktop operation at a time. The menu bar shows each as it begins rather than at the
 * next poll, and its end, for operations no caller refreshes the tray after.
 */
const desktopLock = new DesktopLock(() => void tray?.update());
function withDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  return desktopLock.run(action);
}
/** A Desktop action the user started: refused during another operation, queued behind a restored draft. */
function manualDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  return desktopLock.manual(action, () =>
    usageCredentialRefresher?.anyActive
      ? new Error("Wait for the account connection refresh to finish.")
      : undefined,
  );
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
      const host = desktopHost();
      desktop = new DesktopManager(
        path.join(app.getPath("appData"), "Claude"),
        service.store,
        host,
      );
      // The captures and the vault's reads go to the same log as the restore.
      desktop.onDraftEvent = logDraftEvent;
      // Which account was open when, from every fresh Desktop reading, set before the first one.
      activeTimeline = new ActiveAccountTimeline(
        path.join(app.getPath("userData"), "active-account-timeline.json"),
      );
      desktop.onState = (state) => activeTimeline.observe(state);
      await desktop.initialize();
      usageHistory = new UsageHistory(app.getPath("userData"));
      tempo = new TempoTracker({
        available: () => usageHistory.rollupsAvailable,
        rollups: () => usageHistory.rollups(),
        accounts: () => service.store.state.accounts,
        settings: () => service.store.state.settings.planning,
      });
      /** The tempo now for the switch rule; a failure falls back to its 10% threshold. */
      const currentTempoRate = () => {
        try {
          return tempo.rateAt();
        } catch {
          return undefined;
        }
      };
      const readUsageCredential = (profile: string, allowPrompt: boolean) =>
        readCredential(profile, allowPrompt);
      usageCredentialRefresher = new UsageCredentialRefresher({
        read: readUsageCredential,
        executable: async () => {
          const { diagnostics } = await service.panelSnapshot();
          if (!diagnostics.executable || diagnostics.error)
            throw new UsageError("unavailable");
          if (!readsUsage(diagnostics.version ?? ""))
            throw new UsageError("unavailable");
          return diagnostics.executable;
        },
        canProceed: (account, profile) => {
          const current = service.store.state.accounts.find(
            (item) => item.id === account.id,
          );
          return (
            !desktopLock.active &&
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
        // A short private log, so the cause of a sign-in warning can be found later.
        (account, issue) =>
          appendUsageIssue(
            path.join(app.getPath("userData"), "usage-issues.json"),
            { accountId: account.id, issue },
            Date.now(),
          ),
      );
      automation = nativeDesktopAutomation(
        path.join(__dirname, "desktop-automation"),
      );
      draftRestore = new DraftScheduler({
        restorer: {
          automation,
          pending: () => desktop.pendingDraftRecords(),
          mark: (id, state, reason) => desktop.markDraft(id, state, reason),
          remove: (id) => desktop.dismissDraft(id),
          currentAccount: async () =>
            identity(await readObject(desktop.root, "config.json")),
          running: () => host.running(),
          uptimeMs: () => desktop.claudeUptimeMs(),
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
      });
      // One hook for every switch: tray, panel, automatic, continuation and fleet.
      desktop.onSwitched = () => void draftRestore.afterSwitch();
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
          tempoRate: currentTempoRate(),
        }),
        withDesktopLock,
        pendingAuth: () => pendingAuth() || !!observedDesktop?.pendingProfileId,
        changed: broadcastChanged,
      });
      autoSwitch = new AutoSwitchManager(service.store, desktop, usage, {
        withDesktopLock,
        tempoRate: currentTempoRate,
        // Continue at quota owns conversations stopped at quota while it or a
        // continuation is on; preparing waits for it, with its own reason.
        continuationOwns: () =>
          !!fleet?.enabled ||
          continuation.snapshot().enabled ||
          continuation.snapshot().status === "reconciliation-required" ||
          continuation.snapshot().reason === "continuation-state-unreadable",
        pendingAuth: () => pendingAuth(),
        changed: broadcastChanged,
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
          tempoRate: currentTempoRate(),
        }),
        desktop: async () => ({
          ...(observedDesktop = await desktop.snapshot()),
          busy: desktop.isBusy || desktopLock.active,
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
        changed: broadcastChanged,
      });
      observedDesktop = await desktop.snapshot();
      const keeperBlocked = () =>
        !observedDesktop ||
        desktopLock.active ||
        observedDesktop.busy ||
        observedDesktop.recoveryRequired ||
        !!observedDesktop.pendingProfileId ||
        pendingAuth() ||
        ["switching", "continuing"].includes(fleet.snapshot().status) ||
        continuation.snapshot().status === "executing";
      /** The last hour of raw usage: today's pace; none without the ledger. */
      const recentUsageSamples = () => {
        try {
          return usageHistory.recentSamples(Date.now() - PACE_WINDOW_MS);
        } catch {
          return [];
        }
      };
      keeper = new WindowKeeper({
        directory: path.join(app.getPath("userData"), "window-keeper"),
        state: () => ({
          settings: service.store.state.settings.planning,
          accounts: service.store.state.accounts,
          usage: usage.snapshot(),
          tempo: tempo.currentOrFallback(),
          blocked: keeperBlocked(),
          busyAccountIds: service.runner
            .list()
            .filter((run) => run.status === "running")
            .map((run) => run.accountId),
          recentSamples: recentUsageSamples(),
          activeId: observedDesktop?.activeProfileId,
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
            body: routineFailureNotice(account.name, reason, trayLanguage),
          }).show();
        },
        adapted: notifyAdapted,
        changed: broadcastChanged,
      });
      bindIPC();
      initialized = true;
      createWindow();
      if (process.platform === "darwin")
        trayPanel = new TrayPanel({
          preload: path.join(__dirname, "preload.cjs"),
          load: (win) => loadPage(win, "panel.html"),
          onVisibilityChange: () => {
            try {
              switchWindow?.sync();
            } catch {
              // The switch window never affects the menu bar panel.
            }
          },
        });
      /** Unreadable attempts only cost the panda its warm-up, never the tray. */
      const recentKeeperAttempts = () => {
        try {
          return keeper.recentAttempts();
        } catch {
          return undefined;
        }
      };
      tray = new RelayTray({
        getSnapshot: async () => {
          const read = await readDesktopForTray({
            // Every 5 s: the shared cached reading. Through observedDesktop it feeds
            // keeperBlocked() and the keeper's activeId between keeper runs; the keeper's
            // start and guard read a fresh snapshot before they act.
            read: () => desktop.cachedSnapshot(),
            busy: () => desktop.isBusy || desktopLock.busy,
            operations: () => desktopLock.operations + desktop.operations,
          });
          observedDesktop = read.state;
          return {
            accounts: service.store.state.accounts,
            usage: usage.snapshot(),
            desktop: { ...read.state, busy: read.busy },
            authBusy: service.auth
              .list()
              .some((f) =>
                ["starting", "waiting", "verifying"].includes(f.status),
              ),
            attempts: recentKeeperAttempts(),
          };
        },
        showWindow,
        requestSwitch: (profileId) => void traySwitch(profileId),
        quit: () => app.quit(),
        language: () => trayLanguage,
        panel: trayPanel,
        motionAllowed: () =>
          motionAllowed(service.store.state.settings, () =>
            systemPreferences.getAnimationSettings(),
          ),
      });
      if (process.platform === "darwin") {
        // The story is decoration: if it cannot start, Relay starts without it.
        try {
          switchWindow = new SwitchWindow({
            preload: path.join(__dirname, "switch-preload.cjs"),
            load: (win) => loadPage(win, "switch.html"),
            anchor: () => tray?.bounds(),
            enabled: () => service.store.state.settings.switchWindow !== false,
            panelOpen: () => !!trayPanel?.isOpen(),
          });
          const story = new SwitchStory({
            show: (state) =>
              switchWindow?.show(
                sceneView(state, {
                  language: trayLanguage,
                  name: (id) =>
                    service.store.state.accounts.find((a) => a.id === id)?.name,
                  motion: motionAllowed(service.store.state.settings, () =>
                    systemPreferences.getAnimationSettings(),
                  ),
                }),
              ),
          });
          switchStory = story;
          // Real restarts only: lock holders that never quit Claude stay silent.
          desktop.onRestart = (event) => story.report(event);
        } catch {
          switchWindow?.destroy();
          switchWindow = undefined;
          switchStory = undefined;
          desktop.onRestart = undefined;
        }
      }
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
    })
    .catch((error) => {
      dialog.showErrorBox(say("Relay açılamadı", "Relay could not start"), String(error));
      app.exit(1);
    });
}
function showWindow() {
  if (!initialized) return;
  if (!window && service) createWindow();
  if (window) {
    // Cmd+Q hides the dock icon with the window; opening it again brings it back.
    // Only when hidden: showing an already visible dock icon re-activates the app.
    if (process.platform === "darwin" && app.dock && !app.dock.isVisible())
      void app.dock.show();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
/**
 * Cmd+Q: close the window and keep Relay running in the menu bar. Without a
 * tray there is nothing to stay for, so it quits. The switch window is not
 * touched; it follows the menu bar panel and the switch story.
 */
function closeToTray() {
  if (!tray) {
    app.quit();
    return;
  }
  window?.hide();
  trayPanel?.hide();
  if (process.platform === "darwin") app.dock?.hide();
}
/** Menu-bar switch: one native confirmation, then the normal saved-login switch. */
async function traySwitch(profileId: string) {
  const account = service.store.state.accounts.find((a) => a.id === profileId);
  if (!account) return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: [
      say(
        "Geç ve Claude uygulamasını yeniden başlat",
        "Switch and restart the Claude app",
      ),
      say("Vazgeç", "Cancel"),
    ],
    defaultId: 0,
    cancelId: 1,
    message: say(
      `Claude uygulaması ${account.name} hesabına geçsin mi?`,
      `Switch the Claude app to ${account.name}?`,
    ),
    detail: say(
      "Claude uygulaması kapanıp bu hesapla yeniden açılır. Çalışan yanıtlar varsa önce bitmelerini bekle; konuşmaların Claude uygulamasında kalır.",
      "The Claude app quits and reopens with this account. Let running replies finish first; your conversations stay in the Claude app.",
    ),
  });
  if (response !== 0) return;
  try {
    await manualDesktopLock(() => desktop.switchTo(profileId));
    notifySwitched(account.name);
  } catch (error) {
    dialog.showErrorBox(
      say("Geçiş yapılamadı", "Switch failed"),
      localizeError(
        error instanceof Error ? error.message : String(error),
        trayLanguage,
      ),
    );
  } finally {
    void tray?.update();
    broadcastChanged();
  }
}
/** Same copy as the menu bar switch; shown after a tray or panel switch. */
function notifySwitched(name: string) {
  if (!Notification.isSupported()) return;
  new Notification({
    title: "Relay",
    body: say(
      `Claude uygulaması ${name} hesabına geçti.`,
      `The Claude app switched to ${name}.`,
    ),
  }).show();
}
/** After a draft restore: how many drafts were typed back, and how many wait in the panel. */
function notifyDrafts(summary: { restored: number; left: number }) {
  const body = draftNotice(summary, trayLanguage);
  if (!body || !Notification.isSupported()) return;
  new Notification({ title: "Relay", body }).show();
}
/** Today's plan was re-planned at today's pace, or is back to normal. */
function notifyAdapted(
  notice: Parameters<NonNullable<KeeperDeps["adapted"]>>[0],
) {
  if (!Notification.isSupported()) return;
  const { accounts, settings } = service.store.state;
  // Clocks in the planning zone, without suffixes.
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.planning.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const list = notice.schedule
    .flatMap(({ accountId, startAt }) => {
      const account = accounts.find((a) => a.id === accountId);
      return account
        ? [`${account.name} ${clock.format(new Date(startAt))}`]
        : [];
    })
    .join(", ");
  const en = trayLanguage === "en";
  new Notification({
    title: "Relay",
    body:
      notice.kind === "normal"
        ? en
          ? "Plan is back to normal."
          : "Plan yeniden normale döndü."
        : en
          ? `Plan updated for today’s pace · restarts: ${list}`
          : `Plan bugünkü hızına göre güncellendi · yeniden başlatma: ${list}`,
  }).show();
}
/** Tell every Relay renderer (main window and menu bar panel) that state changed. */
function broadcastChanged() {
  if (window && !window.isDestroyed()) window.webContents.send("relay:changed");
  trayPanel?.webContents()?.send("relay:changed");
}
/** Loads a Vite entry from the dev server in development, else from dist. */
function loadPage(
  win: BrowserWindow,
  page: "index.html" | "panel.html" | "switch.html",
) {
  const devURL = !app.isPackaged && process.env.RELAY_DEV_URL;
  if (devURL === "http://127.0.0.1:5173")
    void win.loadURL(page === "index.html" ? devURL : `${devURL}/${page}`);
  else void win.loadFile(path.join(__dirname, "../dist", page));
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
  // A link opens in the browser only when it is one of the allow-listed pages; no window opens.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  applyAppMenu();
  loadPage(window, "index.html");
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
/** The application menu in the app's language; main rebuilds it when the language changes. */
function applyAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(trayLanguage, {
        closeToTray: () => closeToTray(),
        quit: () => app.quit(),
        closeWindow: () => closeFocusedWindow(),
      }),
    ),
  );
}
/**
 * Cmd+W. The main window closes as its close button does: it hides and Relay stays in the menu
 * bar. The menu bar panel hides; other windows are left alone.
 */
function closeFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isDestroyed()) return;
  if (focused === window) focused.close();
  else if (focused.webContents === trayPanel?.webContents()) trayPanel?.hide();
}
/** Only the main frames of the main window and the menu bar panel may call Relay. */
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const allowed = [
    window && !window.isDestroyed() ? window.webContents : undefined,
    trayPanel?.webContents(),
  ];
  if (
    !allowed.includes(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error("Geçersiz IPC kaynağı.");
}
/** Panel-only one-way messages; anything else (including the main window) is ignored. */
function fromPanel(event: Electron.IpcMainEvent) {
  const panel = trayPanel?.webContents();
  return (
    !!panel && event.sender === panel && event.senderFrame === panel.mainFrame
  );
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
    // With draft re-typing and continuation off, nothing needs it: never ask.
    if (!accessibilityWanted()) return false;
    // Register the explicit permission request against the foreground Relay app.
    // A helper-only request can obscure which rebuilt app owns the OS consent.
    systemPreferences.isTrustedAccessibilityClient(true);
    // The child still verifies its real access; the main-process result alone
    // must never authorize Desktop inspection or any automation.
    const granted = (await automation.requestAccessibility?.()) ?? false;
    // Drafts left for Copy for want of access go back to waiting for the next run.
    if (granted) void draftRestore.retryAccessibility();
    if (process.platform === "darwin" && !granted)
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    return granted;
  });
  const draft = draftActions({
    drafts: desktop,
    writeClipboard: (text) => clipboard.writeText(text),
    changed: broadcastChanged,
    log: logDraftEvent,
  });
  handle("copy-draft", (draftId) => draft.copy(draftId));
  handle("dismiss-draft", (draftId) => draft.dismiss(draftId));
  // Takes no argument: the renderer cannot name a path to reveal.
  handle("show-diagnostics", async () => {
    // Only these fixed files in the user data folder; no path comes from the renderer.
    const folder = app.getPath("userData");
    const isFile = (file: string) =>
      fsp
        .stat(file)
        .then((stat) => stat.isFile())
        .catch(() => false);
    for (const name of ["draft-events.json", "usage-issues.json"]) {
      const file = path.join(folder, name);
      if (await isFile(file)) return shell.showItemInFolder(file);
    }
    // Neither exists yet: open the folder itself rather than highlight it in its parent.
    const failure = await shell.openPath(folder);
    if (failure) throw new Error(failure);
  });
  handle("tray-language", (value) => {
    const language = z.enum(["tr", "en"]).parse(value);
    const changed = language !== trayLanguage;
    trayLanguage = language;
    if (changed) applyAppMenu();
    tray?.update();
  });
  handle("account-planning", (accountId, input) => {
    if (desktop.isBusy || desktopLock.busy)
      throw new Error(
        "Finish the Desktop operation before changing preferences.",
      );
    const account = service.store.account(id.parse(accountId));
    const planning = accountPlanningSchema.parse(input);
    service.store.update((s) => {
      s.accounts.find((a) => a.id === account.id)!.planning = planning;
    });
    // Capacity shapes the plan: replan as after a planning edit.
    keeper.resume();
    void keeper.tick();
    return service.store.account(account.id);
  });
  // The windows show it; every switch, sign-in or recovery rechecks fresh in main.
  handle("desktop-snapshot", async () => ({
    ...(await desktop.cachedSnapshot()),
    busy:
      desktop.isBusy || desktopLock.busy || usageCredentialRefresher?.anyActive,
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
  // Registered directly so a panel-initiated switch can confirm with a notification.
  ipcMain.handle("relay:switch-desktop", async (event, profileId) => {
    trusted(event);
    const target = id.parse(profileId);
    try {
      const result = await manualDesktopLock(() => desktop.switchTo(target));
      if (event.sender === trayPanel?.webContents()) {
        const account = service.store.state.accounts.find(
          (a) => a.id === target,
        );
        if (account) notifySwitched(account.name);
      }
      return result;
    } finally {
      void tray?.update();
      broadcastChanged();
    }
  });
  handle("open-page", (page, intent) => {
    const target = z.enum(PAGES).parse(page);
    const want = z.enum(PAGE_INTENTS).optional().parse(intent);
    showWindow();
    const contents = window?.webContents;
    if (contents) {
      if (contents.isLoading())
        contents.once("did-finish-load", () =>
          contents.send("relay:navigate", target, want),
        );
      else contents.send("relay:navigate", target, want);
    }
    trayPanel?.hide();
  });
  handle("quit", () => {
    trayPanel?.hide();
    app.quit();
  });
  ipcMain.on("relay:panel-size", (event, height) => {
    try {
      if (!fromPanel(event)) return;
      trayPanel?.setHeight(
        z.number().finite().positive().max(4000).parse(height),
      );
    } catch {
      /* Ignore invalid one-way messages. */
    }
  });
  ipcMain.on("relay:panel-close", (event) => {
    if (fromPanel(event)) trayPanel?.hide();
  });
  ipcMain.on("relay:switch-ready", (event) => {
    try {
      switchWindow?.ready(event.sender, event.senderFrame);
    } catch {
      // Ignore: the story is skipped, nothing else depends on it.
    }
  });
  handle("sync-desktop-history", (profileId) =>
    manualDesktopLock(() => desktop.syncHistory(id.parse(profileId))),
  );
  handle("desktop-history-summary", (profileId) =>
    desktop.historySummary(id.parse(profileId)),
  );
  handle("open-desktop", () => manualDesktopLock(() => desktop.open()));
  handle("recover-desktop", () => manualDesktopLock(() => desktop.recover()));
  handle("update-settings", (input) => {
    if (desktop.isBusy || desktopLock.busy)
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
    const retype = draftRetype();
    service.store.update((s) => {
      Object.assign(s.settings, patch);
    });
    nativeTheme.themeSource = themeSource(service.store.state.settings);
    usage.tick();
    void autoSwitch.tick();
    // Turned off, the drafts still pending go to Copy now, not at the next switch.
    if (draftRetype() !== retype) void draftRestore.retypeChanged();
    return service.store.state.settings;
  });
  handle("update-planning", (input) => {
    if (desktop.isBusy || desktopLock.busy)
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
    planning: keeper.snapshot(),
    drafts: await draftSummaries(desktop),
  }));
  handle("snapshot", () =>
    service.transaction(async () => ({
      ...(await service.snapshot()),
      usage: displayUsage(),
      continuation: continuation.snapshot(),
      fleet: fleet.snapshot(),
      autoSwitch: autoSwitch.snapshot(),
      planning: keeper.snapshot(),
      drafts: await draftSummaries(desktop),
    })),
  );
  handle("usage-statistics", (input) => {
    const { range, accountId } = usageStatisticsInput.parse(input);
    return buildStatisticsView({
      rollups: usageHistory.rollups(),
      available: usageHistory.rollupsAvailable,
      accounts: service.store.state.accounts,
      range,
      ...(accountId ? { accountId } : {}),
      zone: service.store.state.settings.planning.timeZone,
      now: Date.now(),
    });
  });
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
    if (desktopLock.busy)
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
      title: say("Proje klasörünü seç", "Choose the project folder"),
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("pick-executable", async () => {
    // The official installer puts `claude` in the hidden ~/.local/bin.
    const installed = path.join(os.homedir(), ".local", "bin");
    const opensThere = await fsp
      .stat(installed)
      .then((s) => s.isDirectory())
      .catch(() => false);
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openFile", "showHiddenFiles"],
      ...(opensThere ? { defaultPath: installed } : {}),
      title: say(
        "Claude Code CLI dosyasını seç",
        "Choose the Claude Code CLI file",
      ),
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
app.on("browser-window-focus", retryDraftsOnFocus);
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
      message: say(
        "Hesap bağlantısı yenileniyor.",
        "Refreshing the account connection.",
      ),
      detail: say(
        "Bağlantıyı yarım bırakmamak için Relay açık kaldı. İşlem tamamlandıktan sonra yeniden çıkabilirsin. Claude uygulaması ve görevleri etkilenmez.",
        "Relay stayed open to finish the connection safely. Quit again after it completes. The Claude app and its tasks are unaffected.",
      ),
      buttons: [say("Tamam", "OK")],
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
      buttons: [
        say("Relay’e dön", "Back to Relay"),
        say("Oturumları durdur ve çık", "Stop the sessions and quit"),
      ],
      defaultId: 0,
      cancelId: 0,
      message: say(
        `${active.length} terminal çalışıyor.`,
        active.length === 1
          ? "1 terminal is running."
          : `${active.length} terminals are running.`,
      ),
      detail: say(
        "Çıkışta bu işlemler durur. Kaydedilmiş konuşmalar oturum kataloğunda kalır.",
        "Quitting stops them. Saved conversations stay in the session catalogue.",
      ),
    })
    .then(async (result) => {
      if (result.response !== 1) return;
      try {
        await Promise.all(active.map((r) => service.runner.stop(r.id)));
        await service.auth.dispose();
        quitting = true;
        app.quit();
      } catch (error) {
        dialog.showErrorBox(
          say("Çıkış tamamlanmadı", "Quit did not finish"),
          String(error),
        );
      }
    });
});

app.on("will-quit", () => {
  keeperAbort.abort();
  if (trayTimer) clearInterval(trayTimer);
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
