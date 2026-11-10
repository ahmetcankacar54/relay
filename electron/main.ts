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
import { localizeError } from "../shared/error-text";
import {
  bundlePath,
  bundlePlace,
  clearOwnQuarantine,
  forgetsApproval,
} from "./core/install-location";
import { runDetached } from "./core/detached-exec";
import {
  AppUpdates,
  LATEST_RELEASE_FEED,
  UPDATE_BUSY,
  releasePage,
} from "./core/app-update";
import { MacUpdateDriver } from "./core/mac-update";
import { ElectronUpdateDriver } from "./core/win-linux-update";
import { openCodeTab } from "./core/code-tab";
import { AutoCapture } from "./core/auto-capture";
import { authWindows, forgetSignInSession } from "./auth-window";
import { desktopCliWorkspaceMismatch } from "../shared/account-state";
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { z } from "zod";
import { ActiveAccountTimeline } from "./core/active-account-timeline";
import { DesktopManager } from "./core/desktop";
import { DesktopUsageReader, safeStoragePassword } from "./core/desktop-usage";
import { claudeWebRequest } from "./desktop-usage-request";
import {
  desktopHost,
  safeStorageAvailable,
  safeStorageSealer,
} from "./core/desktop-host";
import { identity, readObject } from "./core/desktop-files";
import {
  DesktopWindows,
  WINDOWS_UNSUPPORTED,
  type SessionOwner,
} from "./core/desktop-windows";
import { desktopAccountFor } from "../shared/desktop-account";
import { DesktopLock } from "./core/desktop-lock";
import { lastDraftWipeAt } from "./core/desktop-wipe";
import { nativeDesktopWatch, unpackedPath } from "./core/desktop-watch";
import { waitForConversation } from "./core/fleet-show";
import { macClaudeLog, pageBooted } from "./core/desktop-launch";
import { IDLE_MS, QUIET_MS } from "./core/draft-restorer";
import {
  DraftScheduler,
  draftActions,
  draftNotice,
  draftSummaries,
} from "./core/draft-main";
import { sidebarActions, sidebarSummary } from "./core/sidebar-main";
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
import { macBrowserSystem } from "./core/browser-system";
import { levelExtensionStorage } from "./core/extension-storage";
import { macTerminalPorts } from "./core/terminal-identity";
import { sqliteCookieStorage } from "./core/cookie-store";
import { RelayTray } from "./tray";
import { motionAllowed, readDesktopForTray } from "./core/tray-mascot";
import { TrayPanel } from "./tray-panel";
import { SwitchWindow } from "./switch-window";
import {
  SwitchStory,
  sceneView,
  type SwitchSceneView,
} from "../shared/switch-scene";
import {
  intentHash,
  PAGE_INTENTS,
  PAGES,
  type Destination,
  type PageIntent,
} from "../src/app/routes";
import { isExternalLink } from "../shared/external-links";
import { readsUsage } from "../shared/cli-version";
import { UsageHistory } from "./core/usage-history";
import { usageStatisticsInput } from "./core/usage-statistics-input";
import { lostFoundCollection } from "../shared/lost-found";
import { buildStatisticsView } from "../shared/usage-statistics-view";
import { buildTokenUsageView } from "../shared/token-usage-view";
import { buildWidgetSnapshot } from "../shared/widget-snapshot";
import {
  parseRelayLink,
  RELAY_SCHEME,
  relayLinkArgument,
} from "../shared/relay-link";
import { tempoAt } from "../shared/tempo";
import type { UsageSample } from "../shared/usage-statistics";
import { attribute } from "./core/token-attribution";
import { TokenLedger, tokenTickDelay } from "./core/token-ledger";
import { WidgetFile } from "./core/widget-file";
import { loadWidgetCenter } from "./core/widget-center";
import { localDate, planningIdentity, wallTime } from "../shared/planning";
import { PACE_WINDOW_MS } from "../shared/adaptive-plan";
import {
  automationMode,
  automationModeWrites,
} from "../shared/automation-mode";
import { WindowKeeper, type KeeperDeps } from "./core/window-keeper";
import { TempoTracker } from "./core/tempo-tracker";
import { runQuotaStarter } from "./core/routine-runner";
import { readProfileIdentity } from "./core/profile-identity";
import type {
  Account,
  AntigravityOAuthPoll,
  DesktopState,
  FleetContinuationState,
  ProxyStatus,
  SeparateWindows,
} from "../shared/types";
import {
  AFFINITY_REVISION,
  currentAffinityTtl,
  DEFAULT_PROXY_CONFIG,
  type ProxyConfig,
} from "../shared/proxy-types";
import { ProxyServer } from "./core/proxy/proxy-server";
import {
  buildProxyStatus,
  generateProxyKey,
  poolAccounts,
  proxyConfigurePatch,
} from "./core/proxy/proxy-status";
import {
  PROXY_CLIENTS,
  bindClient,
  clientStatuses,
  tailscaleAddress,
  unbindClient,
  type ClientTarget,
} from "./core/proxy/proxy-clients";
import { gatewayUrl } from "../shared/proxy-url";
import { listenOAuthCallback, type CallbackServer } from "./core/oauth-callback-server";
import { proxyExtrasSchema, type ProxyExtras } from "./core/proxy/proxy-status";
import {
  detectProviders,
  executeOneClickCascade,
} from "./core/provider-discovery";
import { AntigravityBridge } from "./core/antigravity-bridge";
import { readCodexCredential } from "./core/provider-credentials";
import { readAntigravityUsage, readCodexUsage } from "./core/provider-usage";
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
import {
  FleetContinuation,
  fleetNotice,
  type FleetResult,
} from "./core/fleet-continuation";
import { UsageCredentialRefresher, anthropicUnreachable } from "./core/usage-refresh";
import { ProcessLock } from "./core/process-lock";
import { prepareVault } from "./core/vault-migration";
import {
  acquireProfileLock,
  anyExclusiveProfileLock,
} from "./core/profile-lock";
import { appendUsageIssue } from "./core/usage-issue-log";
import { appendDraftEvent, draftEventFilter } from "./core/draft-diagnostics";
import { SwitchDiagnostics } from "./core/switch-diagnostics";
import { MenuBarTitle } from "./core/menu-bar-title";
import {
  DEFAULT_MENU_BAR_ITEMS,
  MENU_BAR_ITEMS,
  trayTitle,
  type TraySnapshot,
  type TrayToday,
} from "../shared/tray";
import { UsageError } from "./core/usage-credentials";
import { WindowRelease } from "./window-release";

let window: BrowserWindow | null = null;
/**
 * A closed main window stays loaded a minute, then its renderer is freed; showWindow creates it
 * again. A sign-in or a Desktop operation in progress keeps it.
 */
/** The main window was closed to the menu bar; showing it again clears this. */
let closedToTray = false;
const windowRelease = new WindowRelease({
  // Only a window closed to the menu bar: Cmd+H, a minimized window and macOS occlusion
  // also hide it, and such a window must stay.
  hidden: () =>
    closedToTray &&
    !!window &&
    !window.isDestroyed() &&
    !window.isVisible() &&
    !window.isMinimized(),
  busy: () =>
    !initialized ||
    desktop.isBusy ||
    desktopLock.busy ||
    !!observedDesktop?.pendingProfileId ||
    service.auth
      .list()
      .some((f) => ["starting", "waiting", "verifying"].includes(f.status)),
  release: () => {
    const released = window;
    window = null;
    released?.destroy();
  },
});
let service: Service;
let desktop: DesktopManager;
/** Saves a Claude app sign-in by itself once the user has signed in and opened Code. */
let autoCapture: AutoCapture | undefined;
let switchDiagnostics: SwitchDiagnostics | undefined;
/** Accounts opened in a separate Claude window beside the main one; macOS only. */
let desktopWindows: DesktopWindows | undefined;
/** Relay's own updates; only in a packaged app, or with RELAY_UPDATE_FEED to test one. */
let appUpdates: AppUpdates | undefined;
/** Which account's window holds each Claude Code session, for token attribution. */
let windowSessionOwners = new Map<string, SessionOwner>();
let usage: UsageManager;
/**
 * Usage read through each account's Claude app sign-in. Whether the user allowed the Keychain
 * read of "Claude Safe Storage" is remembered in a small file, never the password itself.
 */
function desktopUsageSource() {
  const marker = path.join(app.getPath("userData"), "desktop-usage-keychain.json");
  const reader = new DesktopUsageReader({
    cookieFiles: (accountUuid) => desktop.loginCookieFiles(accountUuid),
    password: safeStoragePassword({
      allowed: async () => JSON.parse(await fsp.readFile(marker, "utf8"))?.allowed === true,
      remember: async (allowed) =>
        allowed
          ? fsp.writeFile(marker, JSON.stringify({ allowed: true }), { mode: 0o600 })
          : fsp.rm(marker, { force: true }),
    }),
    request: claudeWebRequest,
  });
  return {
    usable: (account: Account) => DesktopUsageReader.usable(account),
    read: (account: Account, allowPrompt: boolean) => reader.read(account, allowPrompt),
  };
}
let usageCredentialRefresher: UsageCredentialRefresher;
let autoSwitch: AutoSwitchManager;
let tray: RelayTray | undefined;
/** What the menu bar title shows, kept beside the registry. */
let menuBarTitle: MenuBarTitle | undefined;
/** Today's tokens and API value for the menu bar title, taken from the ledger when the widget is written. */
let trayToday: TrayToday | undefined;
/** The menu bar's last snapshot, so Settings can show what it shows. */
let lastTraySnapshot: TraySnapshot | undefined;
let trayPanel: TrayPanel | undefined;
let switchWindow: SwitchWindow | undefined;
let switchStory: SwitchStory | undefined;
let usageHistory: UsageHistory;
let activeTimeline: ActiveAccountTimeline;
let tempo: TempoTracker;
let trayTimer: ReturnType<typeof setInterval> | undefined;
// Token usage: the ledger of transcripts read so far, and the ticks that read
// them, at the pace `tokenTickDelay` sets.
/** The Usage page asks for ticks first when the last one is older than this. */
const TOKEN_FRESH_MS = 60_000;
/** How long the Usage page waits, at most, for those ticks to finish the pass. */
const TOKEN_REFRESH_BUDGET_MS = 1_000;
/** Limit samples are kept 14 days; older responses cannot be estimated from them. */
const TOKEN_ATTRIBUTION_WINDOW_MS = 14 * 86_400_000;
/** The limit samples are copied for attribution at most this often. */
const TOKEN_SAMPLES_REFRESH_MS = 60_000;
let tokenLedger: TokenLedger | undefined;
/** `~/.claude/projects`, then the profile of each account that has written transcripts. */
const tokenRoots: { dir: string; profileAccountId?: string }[] = [];
let tokenTimer: ReturnType<typeof setTimeout> | undefined;
let tokenRunning: Promise<void> | undefined;
/** How the last tick ended; before the first, as a pass yet to finish. */
let tokenLastTick: { complete: boolean } | "failed" = { complete: false };
let tokenTickedAt = 0;
/** The limit samples attribution reads, copied at most once a minute and never once per row. */
let tokenSamples: UsageSample[] = [];
let tokenSamplesAt = -Infinity;
let tokenScanStopped = false;
/** The macOS widget's file, rewritten after every tick and at local midnight. */
let widgetFile: WidgetFile | undefined;
let widgetMidnight: ReturnType<typeof setTimeout> | undefined;
/** The account open in Claude when the widget file was last written. */
let widgetActiveId: string | undefined;
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
 * One event of the fleet ("Kota dolunca devam"), for `fleet-events.json` in the user data
 * folder: each change of its state with what it waited on, and how each conversation's
 * continuation ended. Fields are short ids, states, reasons, counts and process names, never
 * a conversation's text. Never throws.
 */
function logFleetEvent(event: string, fields?: Record<string, unknown>) {
  try {
    appendDraftEvent(
      path.join(app.getPath("userData"), "fleet-events.json"),
      { ...fields, event },
      Date.now(),
    );
  } catch {
    // The log is an aid, never a part of a switch.
  }
}
/** Whether the running Claude's page has booted, from its own log; undefined when it cannot tell. */
const claudePageBooted = () =>
  process.platform === "darwin"
    ? pageBooted(macClaudeLog(os.homedir()))
    : Promise.resolve(undefined);
/**
 * Claude's controls, as roles and labels, written once to `file` for a developer whose Claude
 * no longer matches what the helper looks for (Relay started with RELAY_UI_OUTLINE=1). It waits
 * up to two minutes for Claude to run; the helper's issue, if any, is written instead.
 */
async function writeUiOutline(helper: string, file: string, running: () => Promise<boolean>) {
  for (let tries = 0; tries < 24 && !(await running().catch(() => false)); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  const ask = (command: string) =>
    new Promise<unknown>((resolve) => {
      const child = execFile(
        helper,
        [],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          try {
            resolve(error ? { ok: false, error: error.message } : JSON.parse(stdout));
          } catch {
            resolve({ ok: false, error: "unreadable" });
          }
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ command }));
    });
  const result = { at: new Date().toISOString(), inspect: await ask("inspect"), outline: await ask("outline") };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(result, null, 1), { mode: 0o600 });
}
/**
 * One Desktop operation at a time. The menu bar shows each as it begins rather than at the
 * next poll, and its end, for operations no caller refreshes the tray after.
 */
/**
 * The lock Relay's processes share (the app and the relay CLI): each holder of the in-process
 * lock takes it too, so a terminal never quits Claude in the middle of the app's work.
 */
let operationLock: ProcessLock | undefined;
const desktopLock = new DesktopLock(() => void tray?.update(), {
  acquire: (kind) => operationLock?.tryAcquire(kind),
  release: () => operationLock?.release(),
});
/** Per-account profile locks, shared with the relay CLI. */
const profileLocks = () =>
  path.join(app.getPath("userData"), "profiles", ".locks");
function withDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  return desktopLock.run(action);
}
/** A Desktop action the user started: refused during another operation, queued behind a restored draft. */
function manualDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  return desktopLock.manual(action, () =>
    usageCredentialRefresher?.anyActive ||
    anyExclusiveProfileLock(profileLocks(), process.pid)
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
/**
 * Roots are only ever appended, so the indexes the ledger keeps into them stay
 * valid; an account that starts a terminal after launch is read from its next pass.
 */
async function addTokenRoots() {
  for (const account of service.store.state.accounts) {
    if (tokenRoots.some((root) => root.profileAccountId === account.id))
      continue;
    const dir = path.join(service.store.profile(account.id), "projects");
    if (await fsp.stat(dir).then((stat) => stat.isDirectory(), () => false))
      tokenRoots.push({ dir, profileAccountId: account.id });
  }
}
/** A new copy of the limit samples when the last is a minute old, or the clock went back. */
function refreshTokenSamples() {
  const now = Date.now();
  const age = now - tokenSamplesAt;
  if (age >= 0 && age < TOKEN_SAMPLES_REFRESH_MS) return;
  tokenSamples = usageHistory.recentSamples(now - TOKEN_ATTRIBUTION_WINDOW_MS);
  tokenSamplesAt = now;
}
async function tokenTickOnce() {
  if (!tokenLedger) return;
  try {
    await addTokenRoots();
    refreshTokenSamples();
    if (desktopWindows)
      windowSessionOwners = await desktopWindows.sessionOwners().catch(() => windowSessionOwners);
    tokenLastTick = await tokenLedger.tick();
    writeWidget();
  } catch {
    // A scan that fails (a full disk, a bad time zone) never disturbs Relay; it
    // is tried again at the slow pace.
    tokenLastTick = "failed";
  } finally {
    tokenTickedAt = Date.now();
  }
}
/** One tick at a time: a caller during a tick shares it instead of starting another. */
function tokenTick(): Promise<void> {
  tokenRunning ??= tokenTickOnce().finally(() => {
    tokenRunning = undefined;
  });
  return tokenRunning;
}
/** The next tick is armed only when the last has ended, on a timer that never holds Relay open. */
function scheduleTokenTick() {
  if (tokenScanStopped) return;
  if (tokenTimer) clearTimeout(tokenTimer);
  tokenTimer = setTimeout(
    () => {
      tokenTimer = undefined;
      void tokenTick().finally(scheduleTokenTick);
    },
    tokenTickDelay(tokenLastTick),
  );
  tokenTimer.unref();
}
/** Today's numbers for the widget and the menu bar title, from the ledger as it stands; never disturbs Relay. */
function writeWidget(force = false) {
  widgetActiveId = observedDesktop?.activeProfileId;
  if (!tokenLedger || !widgetFile) return;
  try {
    const zone = service.store.state.settings.planning.timeZone;
    const now = Date.now();
    const ledger = tokenLedger.snapshot();
    const { scannedBytes, totalBytes, complete } = ledger.progress;
    const percent = complete
      ? 100
      : totalBytes > 0
        ? Math.min(99, Math.floor((scannedBytes / totalBytes) * 100))
        : 0;
    const { accounts, settings } = service.store.state;
    const tokens = buildTokenUsageView({ ledger, accounts, range: 7, zone, now });
    // The menu bar title reads today's figures from here, so its 5-second timer never reads the
    // ledger; until the first pass is done they are partial and left out.
    const totals = tokens.today.totals;
    trayToday = complete
      ? {
          date: tokens.today.date,
          tokens: totals.input + totals.output + totals.cacheWrite + totals.cacheRead,
          cost: totals.cost ?? 0,
          ...(totals.costEstimated ? { costEstimated: true } : {}),
        }
      : undefined;
    widgetFile.write(
      buildWidgetSnapshot({
        today: tokens.today,
        days: tokens.days,
        progress: { complete, percent },
        language: trayLanguage,
        zone,
        now,
        limits: {
          accounts,
          usage: usage?.snapshot() ?? {},
          activeId: observedDesktop?.activeProfileId,
          settings,
          rate: widgetTempoRate(now),
        },
        hits: widgetLimitHits(zone, now),
      }),
      force,
    );
  } catch {
    // A widget file that cannot be written leaves the widget saying Relay is not current.
  }
}
/** The keeper's tempo now, as the panel ranks accounts with it; undefined without one. */
function widgetTempoRate(now: number) {
  try {
    const tempo = keeper?.snapshot().tempo;
    return tempo
      ? tempoAt(tempo, service.store.state.settings.planning, now)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Limits reached in the last seven days, as the Usage page counts them; undefined without history. */
function widgetLimitHits(zone: string, now: number) {
  try {
    if (!usageHistory?.rollupsAvailable) return undefined;
    const view = buildStatisticsView({
      rollups: usageHistory.rollups(),
      available: true,
      accounts: service.store.state.accounts,
      range: 7,
      zone,
      now,
    });
    if (view.status === "unavailable") return undefined;
    return view.totals.hits.fiveHour + view.totals.hits.weekly;
  } catch {
    return undefined;
  }
}
/** At local midnight the widget starts the new day, even with nothing to count. */
function scheduleWidgetMidnight() {
  if (widgetMidnight) clearTimeout(widgetMidnight);
  if (tokenScanStopped) return;
  let wait = 60 * 60_000;
  try {
    const zone = service.store.state.settings.planning.timeZone;
    const now = Date.now();
    const today = localDate(now, zone);
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const midnight = wallTime(tomorrow, "00:00", zone);
    if (midnight !== undefined && midnight > now)
      wait = Math.min(wait, midnight - now + 1_000);
  } catch {
    // An invalid zone: try again within the hour.
  }
  widgetMidnight = setTimeout(() => {
    writeWidget();
    scheduleWidgetMidnight();
  }, wait);
  widgetMidnight.unref();
}
function startTokenScan() {
  try {
    tokenRoots.push({ dir: path.join(os.homedir(), ".claude", "projects") });
    tokenLedger = new TokenLedger({
      file: path.join(app.getPath("userData"), "token-ledger.json"),
      roots: tokenRoots,
      attribute: (row) =>
        attribute(row, {
          timeline: activeTimeline,
          samples: tokenSamples,
          accounts: service.store.state.accounts,
          windowOwner: (sessionId, time) => {
            const owner = windowSessionOwners.get(sessionId.toLowerCase());
            return owner && time <= owner.until ? owner.accountUuid : undefined;
          },
        }),
      zone: () => service.store.state.settings.planning.timeZone,
    });
    widgetFile = new WidgetFile(
      path.join(app.getPath("userData"), "widget"),
      loadWidgetCenter(__dirname),
    );
    writeWidget();
    scheduleWidgetMidnight();
    scheduleTokenTick();
  } catch {
    // Without a ledger the Usage page's token card reports an error; Relay runs on.
    tokenLedger = undefined;
  }
}
const keeperAbort = new AbortController();
let quitting = false;
app.setName("Relay");
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
    .then(async () => {
      // Moving restarts Relay from Applications; this copy quits.
      if (process.platform === "darwin" && app.isPackaged && (await settleInstallLocation()))
        return;
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
        (accountId, kind) => acquireProfileLock(profileLocks(), accountId, kind),
      );
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
      nativeTheme.themeSource = themeSource(service.store.state.settings);
      const vaultDir = path.join(app.getPath("userData"), "desktop-vault");
      operationLock = new ProcessLock(path.join(vaultDir, "operation.lock"), "app");
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
      const host = desktopHost(vault.sealer, () => service.store.state.claudeApp);
      desktop = new DesktopManager(
        path.join(app.getPath("appData"), "Claude"),
        service.store,
        host,
      );
      const lock = operationLock;
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
            return "Tarayıcıda başka bir Claude hesabıyla giriş yapıldı; bu profil Claude uygulamasındaki hesabına ait. claude.ai’da doğru hesaba geç ya da “Relay penceresinde aç”ı kullan, sonra girişi yenile.";
          case "no-workspace":
            return "Bu giriş, hesabın Claude uygulamasında henüz açılmamış bir çalışma alanına ait. Claude uygulamasında o çalışma alanında Code’u aç, sonra girişi yenile.";
          default:
            return undefined;
        }
      };
      // How Relay starts Claude: HTTP/3 kept off once learned.
      const diagnostics = new SwitchDiagnostics(
        path.join(app.getPath("userData"), "switch-diagnostics"),
      );
      switchDiagnostics = diagnostics;
      desktop.launchChoice = {
        quicOff: () => diagnostics.current.quicOff,
        learnQuicOff: () => {
          diagnostics.set({ quicOff: true });
          broadcastChanged();
        },
      };
      if (process.platform === "darwin") {
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
        desktopWindows = windows;
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
      // Which account was open when, from every fresh Desktop reading, set before the first one.
      activeTimeline = new ActiveAccountTimeline(
        path.join(app.getPath("userData"), "active-account-timeline.json"),
      );
      desktop.onState = (state) => activeTimeline.observe(state);
      await desktop.initialize();
      autoCapture = new AutoCapture({
        snapshot: () => desktop.snapshot(),
        accounts: () => service.store.state.accounts,
        capture: (accountId, orgId) =>
          manualDesktopLock(() => desktop.capture(accountId, orgId)),
        changed: broadcastChanged,
        now: Date.now,
      });
      // Reads Claude only while armed.
      setInterval(() => void autoCapture?.tick(), 2_000).unref();
      if (vault.error) desktop.reportVaultError(vault.error);
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
        // A renewal that fell on a dropped network waits two minutes, not a new sign-in.
        unreachable: () => anthropicUnreachable(),
        profileLock: (accountId) =>
          acquireProfileLock(profileLocks(), accountId, "exclusive"),
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
        (account, issue, detail) =>
          appendUsageIssue(
            path.join(app.getPath("userData"), "usage-issues.json"),
            { accountId: account.id, issue, detail },
            Date.now(),
          ),
        // Without a Claude Code sign-in, the Claude app's own sign-in reads the limits (macOS).
        process.platform === "darwin" ? desktopUsageSource() : undefined,
        // Codex through its ChatGPT sign-in, Antigravity through its CLIProxyAPI sidecar.
        async (account) => {
          if (account.provider === "codex")
            return readCodexUsage(await readCodexCredential(service.store.profile(account.id)));
          if (account.provider === "antigravity") {
            const bridge = antigravityBridge(account.id);
            if (!(await bridge.hasCredential()))
              throw new UsageError("expired", undefined, "antigravity: no saved Google sign-in");
            return readAntigravityUsage((request) => bridge.googleCall(request), await bridge.projectId());
          }
          throw new UsageError("unsupported", undefined, "provider quota endpoint unavailable");
        },
      );
      // The real file, so spawn can run it too (see unpackedPath).
      const automationHelper = unpackedPath(
        path.join(__dirname, "desktop-automation"),
      );
      // While separate windows run, the helper looks only at the main Claude.
      const automationTarget = async () => host.automationTarget?.();
      automation = nativeDesktopAutomation(automationHelper, undefined, automationTarget);
      if (process.platform === "darwin" && process.env.RELAY_UI_OUTLINE === "1")
        void writeUiOutline(
          automationHelper,
          path.join(app.getPath("userData"), "diagnostics", "ui-outline.json"),
          () => host.running(),
        ).catch(() => {});
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
      });
      // One hook for every switch: tray, panel, automatic, continuation and fleet.
      desktop.onSwitched = () => void draftRestore.afterSwitch();
      // The Claude extension's sign-in follows the account at each switch; macOS only.
      if (process.platform === "darwin") {
        desktop.extension = {
          system: macBrowserSystem(),
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
      }
      // So does the terminal's Claude Code sign-in; macOS only. Checked once at start, which links
      // a terminal already signed in to one of the accounts.
      desktop.terminal = macTerminalPorts();
      void desktop.checkTerminal().catch(() => undefined);
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
          new Promise<void>((resolve) => setTimeout(resolve, ms));
        const conversation = stop.localSessionId
          .replace(/^local_/, "")
          .slice(0, 8);
        /** Leaves the conversation as it is, and says why in the fleet's log. */
        const skip = (why: string, fields: Record<string, unknown> = {}) => {
          logFleetEvent("continue-skip", { conversation, why, ...fields });
          return "skipped" as const;
        };
        const shown = await waitForConversation(stop.localSessionId, {
          inspect: () => automation.inspect(),
          open: (id) => automation.openSession(id),
          booted: claudePageBooted,
          unchanged: () => evidence.unchanged(stop),
          now: Date.now,
          sleep,
        });
        if (!("shown" in shown))
          return skip(shown.skipped, {
            shown: shown.last?.localSessionId === stop.localSessionId,
            permissionMode: !!shown.last?.permissionMode,
            screen: shown.last?.screen ?? null,
            panes: shown.last?.panes ?? null,
            opened: shown.opened,
            issue: shown.issue ?? null,
          });
        let snapshot = shown.shown;
        const state = await evidence.read(snapshot);
        if (state.identity.profileId !== target.id) return skip("account");
        if (state.session.id !== stop.cliSessionId) return skip("session");
        if (snapshot.status !== "stopped")
          return skip("status", { status: snapshot.status });
        if (!evidence.unchanged(stop)) return skip("moved-on");
        if (
          stop.permissionMode &&
          snapshot.permissionMode !== stop.permissionMode
        ) {
          snapshot = await automation.setPermission(
            automationGuard(snapshot),
            stop.permissionMode,
          );
          if (snapshot.permissionMode !== stop.permissionMode)
            return skip("permission-mode");
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
        if (snapshot.status !== "stopped")
          return skip("status", { status: snapshot.status });
        if (!snapshot.composerEmpty)
          return skip("composer-not-empty", {
            composerChars: snapshot.composerChars ?? null,
          });
        const before = await evidence.deliveryAfter(stop, requestId);
        if (before !== "absent") {
          logFleetEvent("continue-unsent", { conversation, delivery: before });
          return "unknown";
        }
        beforeSend();
        try {
          const sent = await automation.send(
            automationGuard(snapshot),
            requestId,
            CONTINUATION_TEXT,
          );
          // Send was pressed: how the text went in and what the screen showed next.
          logFleetEvent("continue-sent", {
            conversation,
            acceptedVisible: sent.acceptedVisible,
            written: sent.written ?? null,
            submitted: sent.submitted ?? null,
            ...(sent.after ?? {}),
          });
        } catch (error) {
          // Past the guard a failed send may have typed or sent: never sent again, but said why.
          logFleetEvent("continue-send-failed", {
            conversation,
            issue:
              error instanceof DesktopAutomationError ? error.issue : "failed",
            step:
              error instanceof DesktopAutomationError
                ? (error.step ?? "guard")
                : null,
          });
          throw error;
        }
        // The transcript, not the screen, says whether the turn arrived.
        const delivered = <T extends string>(delivery: T, polls: number) => {
          logFleetEvent("continue-delivery", { conversation, delivery, polls });
          return delivery;
        };
        for (let attempt = 0; attempt < 110; attempt++) {
          const delivery = await evidence.deliveryAfter(stop, requestId);
          if (delivery === "started" || delivery === "unknown")
            return delivered(delivery, attempt + 1);
          await sleep(attempt < 10 ? 500 : 2_000);
        }
        const final = await evidence.deliveryAfter(stop, requestId);
        delivered(final, 111);
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
        // A stop after the last reading: read again now, past the one-minute success cache.
        refreshUsage: (id) => usage.refreshAfterRequest(id),
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
        log: logFleetEvent,
        quietDetail: () => evidence.quietDetail(),
        finished: notifyFleet,
        // What the stopped sessions left running (dev servers, builds), stopped at the switch.
        backgroundCommands: () => evidence.backgroundCommands(),
        stopBackground: (allowed) => evidence.stopBackground(allowed),
        answerQuitGuard: async () => {
          try {
            return (await automation.answerQuitGuard?.()) === true;
          } catch {
            return false;
          }
        },
      });
      // Before the single choice both records could be saved on. The fleet wins,
      // as the mode reads; turning it off later must not leave prepare-on-quit on.
      const savedMode = automationModeWrites(
        automationMode(service.store.state.settings, fleet.snapshot()),
      ).autoSwitchMode;
      if (savedMode !== service.store.state.settings.autoSwitchMode)
        try {
          service.store.update((s) => {
            s.settings.autoSwitchMode = savedMode;
          });
        } catch {
          // A refused write keeps the pair; the fleet still wins while it is on.
        }
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
            title: say("Önceden başlatılamadı", "Early start failed"),
            body: routineFailureNotice(account.name, reason, trayLanguage),
          }).show();
        },
        adapted: notifyAdapted,
        changed: broadcastChanged,
      });
      startTokenScan();
      bindIPC();
      initialized = true;
      createWindow();
      // A relay:// link Relay was opened with: macOS hands it over before ready,
      // Windows and Linux on the command line.
      const launchLink =
        pendingRelayLink ??
        (process.platform === "darwin"
          ? undefined
          : relayLinkArgument(process.argv));
      pendingRelayLink = undefined;
      if (launchLink) openRelayLink(launchLink);
      if (process.platform === "darwin")
        trayPanel = new TrayPanel({
          preload: path.join(__dirname, "preload.cjs"),
          load: (win) => loadPage(win, "panel.html"),
          onEvent: logDraftEvent,
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
      menuBarTitle = new MenuBarTitle(path.join(app.getPath("userData"), "menu-bar.json"));
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
          alignWorkspacesLater();
          // The widgets show the account open in Claude: a switch reaches them now.
          if (read.state.activeProfileId !== widgetActiveId) writeWidget();
          return (lastTraySnapshot = {
            accounts: service.store.state.accounts,
            usage: usage.snapshot(),
            desktop: { ...read.state, busy: read.busy },
            authBusy: service.auth
              .list()
              .some((f) =>
                ["starting", "waiting", "verifying"].includes(f.status),
              ),
            attempts: recentKeeperAttempts(),
            // The title names a switch's target and gives a full window's reset in the planning zone.
            switchingTo: desktop.switchingTo,
            timeZone: service.store.state.settings.planning.timeZone,
            // The items the user chose for the title, and today's figures some of them show.
            titleItems: menuBarTitle?.current.items,
            today: trayToday,
          });
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
                  percent: (id) => usage.snapshot()[id]?.fiveHour?.usedPercent,
                  motion: motionAllowed(service.store.state.settings, () =>
                    systemPreferences.getAnimationSettings(),
                  ),
                }),
              ),
          });
          switchStory = story;
          // Real restarts only: lock holders that never quit Claude stay silent.
          // A start names the account Claude had open, for the window's from → to line.
          desktop.onRestart = (event) =>
            story.report(
              event.phase === "start"
                ? { ...event, fromId: observedDesktop?.activeProfileId }
                : event,
            );
          // The window exists only during a story, so the smoke test starts one scene through it.
          // A packaged Relay has no such hook.
          if (!app.isPackaged)
            Object.assign(globalThis, {
              relaySmokeSwitchScene: (view: SwitchSceneView) =>
                switchWindow?.show(view),
            });
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
        // A profile saved in the wrong workspace of its own account, before Relay could tell.
        .then(async () => {
          for (const account of service.store.state.accounts)
            await alignDesktopWorkspace(account).catch(() => {});
        })
        .finally(() => {
          // Corroborate legacy profiles before the first quota request. Otherwise
          // updated identity fields can hide that request behind its old cooldown.
          usage.start();
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
    })
    .catch((error) => {
      dialog.showErrorBox(say("Relay açılamadı", "Relay did not start"), String(error));
      app.exit(1);
    });
}
/**
 * The share builds are not notarized, so macOS asks once ("Open Anyway") and keeps the answer
 * on the bundle. Run from the disk image or a translocated copy it cannot keep it and asks at
 * every launch: Relay offers to move itself to Applications, where Electron starts it again.
 * From a writable place the download quarantine is cleared so the approval holds (see
 * install-location.ts). True when Relay is moving and this copy quits.
 */
async function settleInstallLocation(): Promise<boolean> {
  const bundle = bundlePath(app.getPath("exe"));
  if (!bundle) return false;
  const place = bundlePlace(bundle, app.isInApplicationsFolder());
  if (!forgetsApproval(place)) {
    void clearOwnQuarantine(bundle, (file, args) => runDetached(file, args, { timeout: 15_000 }))
      .then((cleared) => logDraftEvent("install-location", { place, quarantineCleared: cleared }));
    return false;
  }
  logDraftEvent("install-location", { place });
  // Settings are not read yet; the system language decides.
  const t = pick(app.getLocale().toLowerCase().startsWith("tr") ? "tr" : "en");
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: [t("Uygulamalar klasörüne taşı", "Move to Applications"), t("Şimdi değil", "Not now")],
    defaultId: 0,
    cancelId: 1,
    message: t("Relay’i Uygulamalar klasörüne taşı", "Move Relay to Applications"),
    detail:
      place === "disk-image"
        ? t(
            "Relay disk görüntüsünden çalıştığı sürece macOS her açılışta izin ister. Relay kendini Uygulamalar klasörüne taşır ve oradan açılır.",
            "While Relay runs from the disk image, macOS asks for approval at every launch. Relay moves itself to Applications and opens from there.",
          )
        : t(
            "Relay indirildiği yerden çalıştığı sürece macOS her açılışta izin ister. Relay kendini Uygulamalar klasörüne taşır ve oradan açılır.",
            "While Relay runs from its download location, macOS asks for approval at every launch. Relay moves itself to Applications and opens from there.",
          ),
  });
  if (response !== 0) return false;
  try {
    return app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox(
      t("Relay taşınamadı", "Relay was not moved"),
      t(
        "Relay’i Finder’da Uygulamalar klasörüne sürükle, disk görüntüsünü çıkar ve Relay’i Uygulamalar’dan aç.",
        "Drag Relay to Applications in Finder, eject the disk image and open Relay from Applications.",
      ) + `\n\n${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
/** Shows the main window on `target`: a window made now opens there, a loaded one is told to go. */
function openPage(target: Destination, want?: PageIntent) {
  const fresh = !window;
  showWindow(intentHash(target, want));
  const contents = window?.webContents;
  if (contents && !fresh) {
    if (contents.isLoading())
      contents.once("did-finish-load", () =>
        contents.send("relay:navigate", target, want),
      );
    else contents.send("relay:navigate", target, want);
  }
}
function showWindow(hash?: string) {
  if (!initialized) return;
  if (!window && service) createWindow(hash);
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
  if (window) closeWindowToTray();
  trayPanel?.hide();
  if (process.platform === "darwin") app.dock?.hide();
}
/** The main window went to the menu bar: free its renderer if it stays there. */
function closeWindowToTray() {
  closedToTray = true;
  windowRelease.arm();
}
/** How long a widget's switch link waits for the main window to take it. */
const LINKED_SWITCH_MS = 2 * 60_000;
/** A widget's Geç: the account whose switch review the main window opens next. */
let linkedSwitch: { accountId: string; at: number } | undefined;
/** A link that came before Relay was ready. */
let pendingRelayLink: string | undefined;
/**
 * A relay:// link from a widget. `relay://switch?account=<id>` shows the main
 * window and asks it for its usual switch review of that account, the one its
 * own Switch buttons open; nothing here switches. Anything else, or an id that
 * is not one of Relay's accounts, only shows Relay or is ignored.
 */
function openRelayLink(url: string) {
  if (!initialized) {
    pendingRelayLink = url;
    return;
  }
  const link = parseRelayLink(url, service.store.state.accounts);
  if (!link) return;
  if (link.kind === "switch")
    linkedSwitch = { accountId: link.accountId, at: Date.now() };
  showWindow();
  trayPanel?.hide();
  // A window still loading takes the request when its page starts.
  const contents = window?.webContents;
  if (link.kind === "switch" && contents && !contents.isLoading())
    contents.send("relay:switch-request");
}
/** The main window takes the widget's switch request once; an old one is dropped. */
function takeLinkedSwitch() {
  const request = linkedSwitch;
  linkedSwitch = undefined;
  if (!request || Date.now() - request.at > LINKED_SWITCH_MS) return undefined;
  return service.store.state.accounts.some((a) => a.id === request.accountId)
    ? request.accountId
    : undefined;
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
      "Claude uygulaması kapanır ve bu hesapla yeniden açılır. Önce çalışan yanıtların bitmesini bekle.",
      "The Claude app quits and reopens with this account. Wait for running replies to finish first.",
    ),
  });
  if (response !== 0) return;
  try {
    await manualDesktopLock(() => desktop.switchTo(profileId));
    notifySwitched(account.name);
    notifyExtensionLeft(account);
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
/** Accounts the extension notice was shown for since Relay started: once each, not every switch. */
const extensionNoticeShown = new Set<string>();
/**
 * After a manual switch whose extension step left the Claude browser extension on another
 * account (mode "guide", or "closed" with the browser open): Claude's browser tools only work
 * when the extension is on the conversation's account, so the user hears it here and not only
 * in the panel. A click opens Settings → Switching.
 */
function notifyExtensionLeft(target: Account) {
  const outcome = desktop.extensionOutcome;
  if (
    !Notification.isSupported() ||
    outcome?.result !== "skipped" ||
    (outcome.reason !== "guide-mismatch" && outcome.reason !== "browser-running") ||
    Date.now() - Date.parse(outcome.at) > 5 * 60_000 ||
    extensionNoticeShown.has(target.id)
  )
    return;
  extensionNoticeShown.add(target.id);
  const current = outcome.current;
  const on =
    current?.state === "signed-in" && current.accountUuid
      ? service.store.state.accounts.find((a) =>
          [a.desktop?.accountUuid, a.auth?.accountUuid].some(
            (uuid) => uuid?.toLowerCase() === current.accountUuid!.toLowerCase(),
          ),
        )?.name
      : undefined;
  const notice = new Notification({
    title: on
      ? say(`Eklenti ${on} hesabında kaldı`, `Extension still on ${on}`)
      : say("Eklenti geçmedi", "Extension not switched"),
    body: say(
      `Claude’un tarayıcı araçları ${target.name} ile çalışmıyor; düzeltmek için tıkla.`,
      `Claude’s browser tools do not work with ${target.name}; click to fix.`,
    ),
  });
  notice.on("click", () => openPage("gecis"));
  notice.show();
}
/**
 * After a step put a claude.ai login in place and the extension could not sign in to `account`
 * with it: Relay forgot that login, and Claude's browser tools stay off until the user signs in
 * again. A click opens Settings → Switching, where the reconnect steps are.
 */
function notifyExtensionBroken(account: Account) {
  if (!Notification.isSupported()) return;
  const notice = new Notification({
    title: say("Eklenti giriş yapamıyor", "Extension cannot sign in"),
    body: say(
      `Claude’un tarayıcı araçları ${account.name} ile çalışmıyor; yeniden bağlamak için tıkla.`,
      `Claude’s browser tools do not work with ${account.name}; click to reconnect.`,
    ),
  });
  notice.on("click", () => openPage("gecis"));
  notice.show();
}
/** Says that an account's saved Claude sign-in ended; a click opens the account. */
function notifySignInEnded(account: Account) {
  if (!Notification.isSupported()) return;
  const notice = new Notification({
    title: say("Claude girişi sona ermiş", "Claude sign-in ended"),
    body: say(
      `${account.name} hesabının kayıtlı girişi artık geçerli değil; yeniden giriş yapmak için tıkla.`,
      `The saved sign-in of ${account.name} no longer works; click to sign in again.`,
    ),
  });
  notice.on("click", () => openPage("hesaplar"));
  notice.show();
}
/** Says once per version that a downloaded update is ready; a click opens Overview's banner. */
function notifyUpdate(version: string) {
  if (!Notification.isSupported()) return;
  const notice = new Notification({
    title: say("Güncelleme hazır", "Update ready"),
    body: say(
      `Relay ${version} sürümünü kurmak için tıkla.`,
      `Click to install Relay ${version}.`,
    ),
  });
  notice.on("click", () => openPage("genel"));
  notice.show();
}
/**
 * Starts Relay's own updates: on macOS Relay downloads, verifies and swaps its app itself; on
 * Windows and Linux electron-updater does. A development run never updates unless
 * RELAY_UPDATE_FEED points it at a test feed.
 */
function startAppUpdates() {
  const testFeed = process.env.RELAY_UPDATE_FEED;
  if (!app.isPackaged && !testFeed) return;
  const folder = path.join(app.getPath("userData"), "updates");
  const current = app.getVersion();
  const bundle = bundlePath(app.getPath("exe"));
  const mac =
    process.platform === "darwin" && bundle
      ? new MacUpdateDriver({
          feed: testFeed ?? LATEST_RELEASE_FEED,
          folder,
          current,
          arch: process.arch,
          bundle,
          place: () => bundlePlace(bundle, app.isInApplicationsFolder()),
          pid: process.pid,
          run: (file, args) =>
            new Promise((resolve, reject) =>
              execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
                error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) }),
              ),
            ),
          spawnDetached: (file, args) => {
            // Nothing of Relay's environment reaches the app the script opens (it uses env -i).
            spawn(file, args, { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } }).unref();
          },
          writable: (dir) => {
            try {
              fs.accessSync(dir, fs.constants.W_OK);
              return true;
            } catch {
              return false;
            }
          },
        })
      : undefined;
  if (process.platform === "darwin" && !mac) return;
  try {
    mac?.prune();
  } catch {
    // Old downloads stay until the next start.
  }
  appUpdates = new AppUpdates({
    folder,
    current,
    driver:
      mac ??
      new ElectronUpdateDriver({
        updater: async () => (await import("electron-updater")).autoUpdater,
        current,
        platform: process.platform,
        env: process.env,
      }),
    now: Date.now,
    notify: notifyUpdate,
    changed: broadcastChanged,
    busy: () => (desktop?.isBusy || desktopLock.busy ? UPDATE_BUSY : undefined),
    quit: () => {
      app.quit();
      // Still here a while later: the quit was cancelled (running terminals), so the update waits.
      setTimeout(() => appUpdates?.quitCancelled(), 20_000).unref();
    },
    log: logDraftEvent,
  });
  appUpdates.start();
}
/** Same copy as the menu bar switch; shown after a tray or panel switch. */
function notifySwitched(name: string) {
  if (!Notification.isSupported()) return;
  new Notification({
    title: say("Geçiş tamamlandı", "Switch complete"),
    body: say(
      `Claude uygulaması ${name} hesabına geçti.`,
      `The Claude app switched to ${name}.`,
    ),
  }).show();
}
/** After the fleet switched at the limit: where Claude went, and what became of the conversations. */
function notifyFleet(
  last: NonNullable<FleetContinuationState["last"]>,
  reason?: string,
) {
  if (!Notification.isSupported()) return;
  const name =
    service.store.state.accounts.find((a) => a.id === last.targetId)?.name ??
    say("diğer", "another");
  new Notification({
    title: say("Otomatik geçiş", "Automatic switch"),
    body: fleetNotice(last, name, trayLanguage, reason),
  }).show();
}
/** After a draft restore: how many drafts were typed back, and how many wait in the panel. */
function notifyDrafts(summary: { restored: number; left: number }) {
  const body = draftNotice(summary, trayLanguage);
  if (!body || !Notification.isSupported()) return;
  new Notification({ title: say("Kurtarılan taslaklar", "Rescued drafts"), body }).show();
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
    title: en ? "Early start" : "Önceden başlatma",
    body:
      notice.kind === "normal"
        ? en
          ? "The plan is back to normal."
          : "Plan normale döndü."
        : en
          ? `Plan adapted to today’s pace: ${list}`
          : `Plan bugünkü hıza uyarlandı: ${list}`,
  }).show();
}
/**
 * Reloads the account list when another process (the relay CLI) writes it, and tells the
 * windows and the menu bar. Relay's own writes are noticed and skipped by `reload`.
 */
function watchRegistry() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    fs.watch(service.store.root, (_event, name) => {
      if (name !== "state.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          if (!service.store.reload()) return;
        } catch {
          // A file still being replaced is read at its next change.
          return;
        }
        broadcastChanged();
        void tray?.update();
      }, 250);
    });
  } catch {
    // Without a watch, another process's changes show after Relay restarts.
  }
}
/** Tell every Relay renderer (main window and menu bar panel) that state changed. */
/** The accounts open in a separate Claude window, for the windows; undefined off macOS. */
async function separateWindows(): Promise<SeparateWindows | undefined> {
  if (!desktopWindows) return undefined;
  const { windows, others } = await desktopWindows
    .running(2_000)
    .catch(() => ({ windows: [], others: 0 }));
  const accounts = service.store.state.accounts;
  return {
    supported: true,
    enabled: desktopWindows.enabled,
    open: windows.flatMap((window) => {
      const account = desktopAccountFor({ accountUuid: window.accountUuid }, accounts);
      return account
        ? [{ accountId: account.id, ...(window.openedAt ? { openedAt: window.openedAt } : {}) }]
        : [];
    }),
    others,
  };
}
/**
 * The Proxy Gateway (Settings → Proxy): one local server that routes requests over the accounts
 * by their limits. Started with the app when turned on, stopped when Relay quits. Every start,
 * stop and restart runs one after the other, so a quick toggle can never leave two servers.
 */
let proxyServer: ProxyServer | undefined;
const antigravityBridges = new Map<string, AntigravityBridge>();
const pendingAntigravityOAuth = new Map<string, string>();
const antigravityOAuthOutcomes = new Map<string, AntigravityOAuthPoll>();
const antigravityOAuthPolls = new Map<string, Promise<AntigravityOAuthPoll>>();
const antigravityOAuthTimers = new Map<string, ReturnType<typeof setInterval>>();
/** Relay's own listener on Google's redirect port while a sign-in waits. */
const antigravityCallbackServers = new Map<string, CallbackServer>();
/** The port Antigravity's Google OAuth client sends the browser back to. */
const ANTIGRAVITY_CALLBACK_PORT = 51121;
let antigravityStarting = false;

function antigravityBridge(accountId: string): AntigravityBridge {
  const account = service.store.account(accountId);
  if (account.provider !== "antigravity") throw new Error(say("Antigravity hesabı değil.", "Not an Antigravity account."));
  let bridge = antigravityBridges.get(accountId);
  if (!bridge) {
    bridge = new AntigravityBridge(
      service.store.profile(accountId),
      path.join(app.getPath("userData"), "tools"),
    );
    antigravityBridges.set(accountId, bridge);
  }
  return bridge;
}

async function discardPendingAntigravity(accountId: string): Promise<void> {
  pendingAntigravityOAuth.delete(accountId);
  antigravityCallbackServers.get(accountId)?.close();
  antigravityCallbackServers.delete(accountId);
  const timer = antigravityOAuthTimers.get(accountId);
  if (timer) clearInterval(timer);
  antigravityOAuthTimers.delete(accountId);
  antigravityBridges.get(accountId)?.stop();
  antigravityBridges.delete(accountId);
  service.store.update((state) => {
    state.accounts = state.accounts.filter((account) => account.id !== accountId);
  });
  await fsp.rm(path.join(service.store.root, "profiles", accountId), { recursive: true, force: true });
  broadcastChanged();
}

async function pollAntigravityOAuth(accountId: string, state: string): Promise<AntigravityOAuthPoll> {
  const completed = antigravityOAuthOutcomes.get(accountId);
  if (completed) return completed;
  if (pendingAntigravityOAuth.get(accountId) !== state)
    throw new Error(say("Antigravity girişi artık beklemede değil.", "Antigravity sign-in is no longer pending."));
  const inFlight = antigravityOAuthPolls.get(accountId);
  if (inFlight) return inFlight;
  const work = (async (): Promise<AntigravityOAuthPoll> => {
    const status = await antigravityBridge(accountId).pollOAuth(state);
    if (status.status === "wait") return status;
    if (status.status === "error") {
      await discardPendingAntigravity(accountId);
      const result: AntigravityOAuthPoll = status;
      antigravityOAuthOutcomes.set(accountId, result);
      return result;
    }
    const duplicate = service.store.state.accounts.find((a) =>
      a.id !== accountId && a.provider === "antigravity" &&
      a.auth?.email?.toLowerCase() === status.email.toLowerCase());
    if (duplicate) {
      await discardPendingAntigravity(accountId);
      const result: AntigravityOAuthPoll = { status: "error", error: say("Bu Antigravity hesabı zaten bağlı.", "This Antigravity account is already connected.") };
      antigravityOAuthOutcomes.set(accountId, result);
      return result;
    }
    service.store.update((savedState) => {
      const account = savedState.accounts.find((a) => a.id === accountId);
      if (!account) throw new Error(say("OAuth girişi sırasında hesap kayboldu.", "Account disappeared during OAuth sign-in."));
      account.auth = {
        loggedIn: true, checkedAt: new Date().toISOString(), email: status.email,
        subscription: "Antigravity OAuth",
      };
    });
    pendingAntigravityOAuth.delete(accountId);
    antigravityCallbackServers.get(accountId)?.close();
    antigravityCallbackServers.delete(accountId);
    const timer = antigravityOAuthTimers.get(accountId);
    if (timer) clearInterval(timer);
    antigravityOAuthTimers.delete(accountId);
    broadcastChanged();
    const result: AntigravityOAuthPoll = {
      status: "ok",
      result: {
        account: service.store.account(accountId),
        layers: { desktop: "skipped", usage: "skipped", terminal: "skipped", extensionAndProxy: "done" },
      },
    };
    antigravityOAuthOutcomes.set(accountId, result);
    return result;
  })();
  antigravityOAuthPolls.set(accountId, work);
  try { return await work; } finally { antigravityOAuthPolls.delete(accountId); }
}
/** Why the gateway is not running although it is turned on, shown on its page. */
let proxyError: string | undefined;
let proxyQueue: Promise<unknown> = Promise.resolve();
/** How long a read sign-in is reused before the Keychain is asked again. */
const PROXY_CREDENTIAL_TTL_MS = 20_000;
const serializeProxy = <T>(task: () => Promise<T>): Promise<T> => {
  const run = proxyQueue.then(task);
  proxyQueue = run.catch(() => {});
  return run;
};
/**
 * The pool order, the accounts left out and the bound clients live in their own file beside the
 * registry: the registry's proxy settings are strict, so 0.18.2 (and older) can still read it.
 */
const proxyExtrasFile = () => path.join(service.store.root, "proxy-pool.json");
let proxyExtrasCache: ProxyExtras | undefined;
function proxyExtras(): ProxyExtras {
  if (proxyExtrasCache) return proxyExtrasCache;
  try {
    proxyExtrasCache = proxyExtrasSchema.parse(JSON.parse(fs.readFileSync(proxyExtrasFile(), "utf8")));
  } catch {
    // Missing or unreadable: an empty pool setup, every account in, no client bound.
    proxyExtrasCache = {};
  }
  return proxyExtrasCache;
}
const proxySettings = (): ProxyConfig => ({
  ...DEFAULT_PROXY_CONFIG,
  ...service.store.state.settings.proxy,
  ...proxyExtras(),
});
const saveProxySettings = (config: ProxyConfig) => {
  const { accountOrder, excludedAccountIds, clientBindings, affinityRevision, ...base } = config;
  const extras: ProxyExtras = {
    ...(accountOrder ? { accountOrder } : {}),
    ...(excludedAccountIds ? { excludedAccountIds } : {}),
    ...(affinityRevision !== undefined ? { affinityRevision } : {}),
    ...(clientBindings ? { clientBindings } : {}),
  };
  if (JSON.stringify(extras) !== JSON.stringify(proxyExtras())) {
    const temp = `${proxyExtrasFile()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(extras, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, proxyExtrasFile());
    proxyExtrasCache = extras;
  }
  service.store.update((s) => {
    s.settings.proxy = base;
  });
};
/**
 * Moves a saved affinity lifetime that is the old five-minute default to the hour Claude Code's
 * cache lives, once: the revision beside the registry says it was done, so a lifetime chosen
 * afterwards stays. Before the gateway starts.
 */
function settleProxyAffinity() {
  const extras = proxyExtras();
  if ((extras.affinityRevision ?? 0) >= AFFINITY_REVISION) return;
  const saved = service.store.state.settings.proxy;
  // Never used: nothing is saved, and the gateway takes the default when it is first turned on.
  if (!saved) {
    const next: ProxyExtras = { ...extras, affinityRevision: AFFINITY_REVISION };
    const temp = `${proxyExtrasFile()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, proxyExtrasFile());
    proxyExtrasCache = next;
    return;
  }
  saveProxySettings({
    ...proxySettings(),
    affinityRevision: AFFINITY_REVISION,
    affinityTtlSeconds:
      currentAffinityTtl(saved.affinityTtlSeconds, extras.affinityRevision) ??
      DEFAULT_PROXY_CONFIG.affinityTtlSeconds,
  });
}
/** Where bound clients dial the gateway: the saved address and key (none before the first start). */
const clientTarget = (config: ProxyConfig): ClientTarget | undefined =>
  config.apiKey ? { url: gatewayUrl(config.host, config.port), key: config.apiKey } : undefined;
function proxyStatus(): ProxyStatus {
  const config = proxySettings();
  const state = proxyServer?.getState();
  const running = state?.status === "running";
  return buildProxyStatus({
    running,
    config: running && state ? { ...config, port: state.port, host: state.host } : config,
    metrics: proxyServer?.getMetrics(),
    accounts: service.store.state.accounts,
    usage: usage?.snapshot() ?? {},
    now: Date.now(),
    error: proxyError,
    recent: proxyServer?.stats.recent() ?? [],
    tailscaleAddress: tailscaleAddress(),
    clients: clientStatuses(clientTarget(config), config),
  });
}
/** Rewrites the clients Relay bound, after the address or key changed, so they keep working. */
async function rebindClients(config: ProxyConfig): Promise<void> {
  const target = clientTarget(config);
  if (!target) return;
  for (const id of PROXY_CLIENTS) {
    const previous = config.clientBindings?.[id];
    if (previous) await bindClient(id, target, previous).catch(() => {});
  }
}
/** Starts the gateway on the saved port and host; a first start also creates the client key. */
async function startProxy(): Promise<void> {
  if (proxyServer) return;
  let config = proxySettings();
  if (!config.apiKey) {
    config = { ...config, apiKey: generateProxyKey() };
    saveProxySettings(config);
  }
  const credentials = new Map<string, { token: string; until: number }>();
  const server = new ProxyServer({
    config,
    antigravityResolver: async (account) => {
      if (account.provider !== "antigravity" || !account.auth?.loggedIn) return undefined;
      const bridge = antigravityBridge(account.id);
      if (!(await bridge.hasCredential())) return undefined;
      await bridge.start();
      return bridge.endpoint;
    },
    credentialResolver: async (account) => {
      const cached = credentials.get(account.id);
      if (cached && cached.until > Date.now()) return cached.token;
      credentials.delete(account.id);
      try {
        const credential =
          account.provider === "codex"
            ? await readCodexCredential(service.store.profile(account.id))
            : await readCredential(service.store.profile(account.id), false);
        if (!credential) return undefined;
        // An expired token would only earn a 401; leave the account to the others.
        if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) return undefined;
        credentials.set(account.id, {
          token: credential.accessToken,
          until: Math.min(Date.now() + PROXY_CREDENTIAL_TTL_MS, credential.expiresAt ?? Infinity),
        });
        return credential.accessToken;
      } catch {
        return undefined;
      }
    },
    onCredentialRejected: (accountId) => credentials.delete(accountId),
    // The accounts as saved now and the limits as Relay last read them: quota-aware routing.
    // Only the accounts left in the pool, in its order (strict priority reads the order).
    usageProvider: () => ({
      accounts: poolAccounts(service.store.state.accounts, proxySettings()),
      usageMap: usage?.snapshot() ?? {},
    }),
  });
  try {
    await server.start();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    proxyError =
      code === "EADDRINUSE"
        ? say(
            `${config.host}:${config.port} kullanımda. Başka bir port seç.`,
            `${config.host}:${config.port} is already in use. Choose another port.`,
          )
        : (error as Error).message;
    throw new Error(proxyError);
  }
  proxyServer = server;
  proxyError = undefined;
}
async function stopProxy(): Promise<void> {
  const server = proxyServer;
  proxyServer = undefined;
  await server?.stop().catch(() => {});
}
/**
 * Saves `next`. A running gateway takes a new routing strategy, session time or client key at
 * once, keeping its open streams and sessions; only a new host or port restarts it, and the old
 * settings return if it cannot start there.
 */
async function applyProxyConfig(next: ProxyConfig): Promise<void> {
  const previous = proxySettings();
  saveProxySettings(next);
  if (next.host !== previous.host || next.port !== previous.port || next.apiKey !== previous.apiKey)
    await rebindClients(next);
  if (!proxyServer) return;
  if (next.host === previous.host && next.port === previous.port) {
    proxyServer.updateConfig({
      routingStrategy: next.routingStrategy,
      affinityTtlSeconds: next.affinityTtlSeconds,
      apiKey: next.apiKey,
    });
    return;
  }
  await stopProxy();
  try {
    await startProxy();
  } catch (error) {
    saveProxySettings(previous);
    await rebindClients(previous);
    await startProxy().catch(() => {});
    throw error;
  }
}
/**
 * Whether a profile's usage sign-in is its Claude app sign-in's account and workspace. One
 * Claude account can have several workspaces (organizations); a profile saved in another one
 * than its usage sign-in names can never be read or switched to, however often the user signs
 * in again. Where the Claude app has that workspace, the profile moves to it ("moved").
 */
async function alignDesktopWorkspace(
  account: Account,
): Promise<"fits" | "moved" | "other-account" | "no-workspace"> {
  const bound = account.desktop;
  const auth = account.auth;
  if ((account.provider ?? "claude") !== "claude" || !bound || !auth?.loggedIn) return "fits";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (auth.accountUuid && !same(auth.accountUuid, bound.accountUuid)) return "other-account";
  if (!auth.accountUuid || !auth.orgId || same(auth.orgId, bound.orgId)) return "fits";
  if (!(await desktop.rebindOrg(account.id, auth.orgId))) return "no-workspace";
  usage?.invalidate(account.id);
  usage?.tick();
  void tray?.update();
  broadcastChanged();
  return "moved";
}
/**
 * A profile left in another workspace than its usage sign-in (the Claude app had not opened
 * that workspace yet) moves once the app has: looked at with the tray's reading, at most twice
 * a minute, and only for profiles that are out of step.
 */
let workspacesAlignedAt = 0;
function alignWorkspacesLater() {
  const now = Date.now();
  if (now - workspacesAlignedAt < 30_000 || !desktop || desktop.isBusy) return;
  workspacesAlignedAt = now;
  void desktop.noteSignOuts();
  for (const account of service.store.state.accounts)
    if (desktopCliWorkspaceMismatch(account) && !service.auth.active(account.id))
      void alignDesktopWorkspace(account).catch(() => {});
}
function broadcastChanged() {
  if (window && !window.isDestroyed()) window.webContents.send("relay:changed");
  trayPanel?.webContents()?.send("relay:changed");
}
/** Loads a Vite entry from the dev server in development, else from dist. */
function loadPage(
  win: BrowserWindow,
  page: "index.html" | "panel.html" | "switch.html",
  /** `#/planlama`: the page the main window opens on. */
  hash?: string,
) {
  const devURL = !app.isPackaged && process.env.RELAY_DEV_URL;
  if (devURL === "http://127.0.0.1:5173")
    void win.loadURL(
      page === "index.html" ? `${devURL}/${hash ?? ""}` : `${devURL}/${page}`,
    );
  else
    void win.loadFile(
      path.join(__dirname, "../dist", page),
      hash ? { hash: hash.replace(/^#/, "") } : undefined,
    );
}
function createWindow(hash?: string) {
  window = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: "Relay",
    icon: path.join(__dirname, "icon.png"),
    // On macOS the sidebar shows the system material (the `vibrant` variant in src/styles/theme.css);
    // elsewhere the window takes the page colour, so nothing flashes before the page draws.
    ...(process.platform === "darwin"
      ? { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const, backgroundColor: "#00000000" }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f0f11" : "#f4f4f5" }),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // 16 px from the left: the three buttons end at 68 px, inside the 84 px collapsed rail.
    trafficLightPosition: { x: 16, y: 19 },
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
  loadPage(window, "index.html", hash);
  const own = window;
  own.on("closed", () => {
    if (window !== own) return;
    windowRelease.cancel();
    window = null;
  });
  own.on("show", () => {
    closedToTray = false;
    windowRelease.cancel();
  });
  own.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      own.hide();
      closeWindowToTray();
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
  const sidebar = sidebarActions({
    gaps: desktop,
    writeClipboard: (text) => clipboard.writeText(text),
    changed: broadcastChanged,
    log: logDraftEvent,
  });
  handle("copy-sidebar-recipe", (gapId) => sidebar.copy(gapId));
  handle("dismiss-sidebar-gap", (gapId) => sidebar.dismiss(gapId));
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
  // How Relay starts Claude (HTTP/3).
  handle("claude-launch", () => switchDiagnostics?.current ?? { quicOff: false });
  // Relay's own updates.
  handle("update-check", async () => {
    if (!appUpdates) throw new Error("Updates are not available in this copy of Relay.");
    return appUpdates.check();
  });
  handle("update-install", () => {
    if (!appUpdates) throw new Error("Updates are not available in this copy of Relay.");
    return appUpdates.install();
  });
  handle("set-update-auto", (enabled) => {
    if (!appUpdates) throw new Error("Updates are not available in this copy of Relay.");
    appUpdates.setAuto(z.boolean().parse(enabled));
  });
  handle("update-notes", async () => {
    const version = appUpdates?.state().version;
    // Only the release page of a version the feed named, never a URL from the renderer.
    if (version && /^\d+\.\d+\.\d+$/.test(version)) await shell.openExternal(releasePage(version));
  });
  // Separate Claude windows: an account opened in its own Claude beside the main one.
  handle("set-separate-windows", (enabled) => {
    if (!desktopWindows) throw new Error(WINDOWS_UNSUPPORTED);
    desktopWindows.setEnabled(z.boolean().parse(enabled));
    broadcastChanged();
  });
  const windowAccount = (accountId: unknown) => {
    if (!desktopWindows) throw new Error(WINDOWS_UNSUPPORTED);
    const account = service.store.account(id.parse(accountId));
    if (!account.desktop) throw new Error("Connect this account in Claude Desktop first.");
    return { windows: desktopWindows, accountUuid: account.desktop.accountUuid };
  };
  handle("open-window", async (accountId) => {
    const { windows, accountUuid } = windowAccount(accountId);
    try {
      return await manualDesktopLock(async () => {
        // A sign-in in progress may be for this very account: one holder at a time.
        const state = await desktop.snapshot();
        if (state.pendingProfileId)
          throw new Error("Finish or cancel the current Desktop sign-in first.");
        if (state.recoveryRequired) throw new Error("Restore the interrupted Desktop switch first.");
        return windows.open(accountUuid);
      });
    } finally {
      broadcastChanged();
    }
  });
  handle("close-window", async (accountId) => {
    const { windows, accountUuid } = windowAccount(accountId);
    try {
      await manualDesktopLock(() => windows.close(accountUuid));
    } finally {
      broadcastChanged();
    }
  });
  handle("set-claude-launch", (patch) => {
    const parsed = z
      .object({ quicOff: z.boolean().optional() })
      .strict()
      .parse(patch);
    if (!switchDiagnostics) throw new Error("Invalid Claude launch choice.");
    return switchDiagnostics.set(parsed);
  });
  // What the menu bar title shows; kept beside the registry, redrawn at once.
  handle("menu-bar-title", () =>
    menuBarTitle?.current ?? { items: [...DEFAULT_MENU_BAR_ITEMS] },
  );
  // The title as the menu bar shows it now, and each item's value alone, from the last look.
  handle("menu-bar-now", () => {
    const snapshot = lastTraySnapshot;
    if (!snapshot) return undefined;
    const now = Date.now();
    const alone = (item: (typeof MENU_BAR_ITEMS)[number]) => {
      const text = trayTitle({ ...snapshot, titleItems: [item] }, now, trayLanguage);
      return text === "—" ? "" : text;
    };
    // The saved choice, which the snapshot may not hold yet right after a change.
    const titleItems = menuBarTitle?.current.items ?? snapshot.titleItems;
    return {
      title: trayTitle({ ...snapshot, titleItems }, now, trayLanguage),
      values: Object.fromEntries(MENU_BAR_ITEMS.map((item) => [item, alone(item)])),
    };
  });
  handle("set-menu-bar-title", (choice) => {
    const parsed = z
      .object({ items: z.array(z.enum(MENU_BAR_ITEMS)).max(MENU_BAR_ITEMS.length) })
      .strict()
      .parse(choice);
    if (!menuBarTitle) throw new Error("Invalid menu bar title.");
    const kept = menuBarTitle.set(parsed);
    void tray?.update();
    return kept;
  });
  handle("tray-language", (value) => {
    const language = z.enum(["tr", "en"]).parse(value);
    const changed = language !== trayLanguage;
    trayLanguage = language;
    if (changed) applyAppMenu();
    // The widget's strings are in the app's language too.
    if (changed) writeWidget(true);
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
  handle("extension-status", () => desktop.extensionStatus());
  // The panel's extension offer follows a sync at once. Not a check: the settings card checks
  // again whenever the settings it reads change, and a broadcast would bring it new ones.
  handle("extension-sync", () => desktop.syncExtension().finally(broadcastChanged));
  handle("extension-web", () => desktop.openClaudeWeb());
  handle("extension-settings", () => {
    openPage("gecis");
    trayPanel?.hide();
  });
  handle("extension-check", () => desktop.checkExtension());
  handle("extension-link", (accountId) => desktop.checkExtension(id.parse(accountId)));
  handle("terminal-status", () => desktop.terminalStatus());
  handle("terminal-check", () => desktop.checkTerminal());
  handle("terminal-sync", () => desktop.syncTerminal().finally(broadcastChanged));
  // The windows show it; every switch, sign-in or recovery rechecks fresh in main.
  handle("proxy-status", () => proxyStatus());
  handle("proxy-toggle", (enabled) =>
    serializeProxy(async () => {
      const on = z.boolean().parse(enabled);
      const config = proxySettings();
      saveProxySettings({ ...config, enabled: on });
      if (on) {
        try {
          await startProxy();
        } catch (error) {
          // Switched back off, so the page does not claim a gateway that is not there.
          saveProxySettings({ ...proxySettings(), enabled: false });
          broadcastChanged();
          throw error;
        }
      } else {
        await stopProxy();
        proxyError = undefined;
      }
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("proxy-configure", (input) =>
    serializeProxy(async () => {
      const patch = proxyConfigurePatch.parse(input);
      await applyProxyConfig({ ...proxySettings(), ...patch });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("proxy-regenerate-key", () =>
    serializeProxy(async () => {
      await applyProxyConfig({ ...proxySettings(), apiKey: generateProxyKey() });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("copy-text", (text) => {
    clipboard.writeText(z.string().max(16_384).parse(text));
  });
  handle("proxy-bind-client", (input) =>
    serializeProxy(async () => {
      const clientId = z.enum(["claude-code", "codex"]).parse(input);
      let config = proxySettings();
      if (!config.apiKey) {
        config = { ...config, apiKey: generateProxyKey() };
        saveProxySettings(config);
      }
      const saved = await bindClient(clientId, clientTarget(config)!, config.clientBindings?.[clientId]);
      saveProxySettings({ ...proxySettings(), clientBindings: { ...config.clientBindings, [clientId]: saved } });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("proxy-unbind-client", (input) =>
    serializeProxy(async () => {
      const clientId = z.enum(["claude-code", "codex"]).parse(input);
      const config = proxySettings();
      await unbindClient(clientId, config.clientBindings?.[clientId]);
      const bindings = { ...config.clientBindings };
      delete bindings[clientId];
      saveProxySettings({ ...config, clientBindings: bindings });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("detect-providers", () =>
    detectProviders(service.store.state.accounts, {
      claudeDesktopRoot: desktop.root,
    }),
  );
  handle("one-click-connect", async (input) => {
    const result = await executeOneClickCascade(input, {
      store: service.store,
      desktopRoot: desktop.root,
      captureDesktop: (profileId, orgId) =>
        manualDesktopLock(() => desktop.capture(profileId, orgId)),
      beginDesktopLogin: (profileId) =>
        manualDesktopLock(() => desktop.beginLogin(profileId)),
      armAutoCapture: (profileId) => autoCapture?.arm(profileId),
      checkTerminal: () => desktop.checkTerminal(),
      checkExtension: (profileId) => desktop.checkExtension(profileId),
      refreshUsage: (profileId) => usage.refresh(profileId),
    });
    void tray?.update();
    broadcastChanged();
    return result;
  });
  handle("antigravity-oauth-start", async (raw) => {
    // Checked and claimed before any await: a double click must not start two sign-ins on the
    // helper's one callback port.
    if (pendingAntigravityOAuth.size || antigravityStarting)
      throw new Error(say("Önce açık Antigravity girişini tamamla.", "Finish the pending Antigravity sign-in first."));
    const input = createAccountSchema.parse({ ...raw, provider: "antigravity" });
    antigravityStarting = true;
    const account = (() => {
      try {
        return service.store.create(input);
      } catch (error) {
        antigravityStarting = false;
        throw error;
      }
    })();
    try {
      const bridge = antigravityBridge(account.id);
      // Relay answers Google's redirect itself: the browser gets a short page and Relay comes
      // forward. If the port is taken, CLIProxyAPI's own forwarder is the way back.
      const callback = await listenOAuthCallback({
        port: ANTIGRAVITY_CALLBACK_PORT,
        path: "/oauth-callback",
        timeoutMs: 10 * 60_000,
        handle: async (address) => {
          const expected = pendingAntigravityOAuth.get(account.id);
          try {
            if (!expected) throw new Error(say("Bekleyen giriş yok.", "No sign-in is pending."));
            await bridge.submitCallback(expected, address);
            return {
              title: say("Giriş alındı", "Signed in"),
              body: say("Relay’e dönebilirsin; bu sekme kapanabilir.", "You can go back to Relay; this tab can be closed."),
            };
          } catch {
            return {
              title: say("Giriş tamamlanamadı", "Sign-in not finished"),
              body: say("Relay’e dönüp yeniden dene.", "Go back to Relay and try again."),
            };
          } finally {
            showWindow();
            if (process.platform === "darwin") app.focus({ steal: true });
          }
        },
      });
      if (callback) antigravityCallbackServers.set(account.id, callback);
      const { state, url } = await bridge.beginOAuth({ forwarder: !callback });
      pendingAntigravityOAuth.set(account.id, state);
      await shell.openExternal(url);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (Date.now() - startedAt > 10 * 60_000) {
          void discardPendingAntigravity(account.id).then(() => {
            antigravityOAuthOutcomes.set(account.id, { status: "error", error: say("Antigravity girişi zaman aşımına uğradı.", "Antigravity sign-in timed out.") });
          });
          return;
        }
        void pollAntigravityOAuth(account.id, state).catch(() => {});
      }, 1500);
      timer.unref();
      antigravityOAuthTimers.set(account.id, timer);
      broadcastChanged();
      return { accountId: account.id, state };
    } catch (error) {
      await discardPendingAntigravity(account.id);
      throw error;
    } finally {
      antigravityStarting = false;
    }
  });
  handle("antigravity-oauth-cancel", async (raw) => {
    const input = z.object({ accountId: z.uuid(), state: z.string().min(8).max(128) }).strict().parse(raw);
    // Only the sign-in that is still pending; a finished one is an account like any other.
    if (pendingAntigravityOAuth.get(input.accountId) !== input.state) return;
    await discardPendingAntigravity(input.accountId);
    antigravityOAuthOutcomes.set(input.accountId, {
      status: "error",
      error: say("Antigravity girişi iptal edildi.", "Antigravity sign-in was cancelled."),
    });
  });
  handle("antigravity-oauth-callback", async (raw) => {
    const input = z
      .object({ accountId: z.uuid(), state: z.string().min(8).max(128), url: z.string().min(1).max(4_096) })
      .strict()
      .parse(raw);
    if (pendingAntigravityOAuth.get(input.accountId) !== input.state)
      throw new Error(say("Antigravity girişi artık beklemede değil.", "Antigravity sign-in is no longer pending."));
    await antigravityBridge(input.accountId).submitCallback(input.state, input.url);
  });
  handle("antigravity-oauth-poll", async (raw) => {
    const input = z.object({ accountId: z.uuid(), state: z.string().min(8).max(128) }).strict().parse(raw);
    return pollAntigravityOAuth(input.accountId, input.state);
  });
  handle("desktop-snapshot", async () => ({
    ...(await desktop.cachedSnapshot()),
    proxyStatus: proxyStatus(),
    ...(autoCapture?.state() ? { autoCapture: autoCapture.state() } : {}),
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
  handle("cancel-desktop-login", async () => {
    autoCapture?.disarm();
    await manualDesktopLock(() => desktop.cancelLogin());
  });
  handle("arm-auto-capture", (profileId) => autoCapture?.arm(id.parse(profileId)));
  handle("disarm-auto-capture", (profileId) =>
    autoCapture?.disarm(profileId === undefined ? undefined : id.parse(profileId)),
  );
  handle("choose-auto-capture-org", (profileId, orgId) =>
    autoCapture?.choose(id.parse(profileId), id.parse(orgId)),
  );
  // Registered directly so a panel-initiated switch can confirm with a notification.
  ipcMain.handle("relay:switch-desktop", async (event, profileId) => {
    trusted(event);
    const target = id.parse(profileId);
    try {
      const result = await manualDesktopLock(() => desktop.switchTo(target));
      const account = service.store.state.accounts.find((a) => a.id === target);
      if (account && event.sender === trayPanel?.webContents())
        notifySwitched(account.name);
      if (account) notifyExtensionLeft(account);
      return result;
    } finally {
      void tray?.update();
      broadcastChanged();
    }
  });
  // Main window only: the widget's switch request is never the panel's to take.
  ipcMain.handle("relay:take-switch-request", (event) => {
    trusted(event);
    if (event.sender !== window?.webContents) return undefined;
    return takeLinkedSwitch();
  });
  handle("open-page", (page, intent) => {
    openPage(
      z.enum(PAGES).parse(page),
      z.enum(PAGE_INTENTS).optional().parse(intent),
    );
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
  // Setup's "Open Code": the fixed claude:// link to Code's new-session screen, macOS only.
  handle("open-code-tab", () =>
    manualDesktopLock(async () => {
      if (process.platform !== "darwin") return desktop.open();
      await openCodeTab({
        open: () => desktop.open(),
        booted: claudePageBooted,
        running: async () => (await desktop.snapshot()).running,
        openLink: (url) => shell.openExternal(url),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
      });
    }),
  );
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
    windows: await separateWindows(),
    update: appUpdates?.state(),
    usage: displayUsage(),
    continuation: continuation.snapshot(),
    fleet: fleet.snapshot(),
    autoSwitch: autoSwitch.snapshot(),
    planning: keeper.snapshot(),
    drafts: await draftSummaries(desktop),
    sidebar: await sidebarSummary(desktop),
    extension: await desktop.extensionOffer(),
  }));
  handle("snapshot", () =>
    service.transaction(async () => ({
      ...(await service.snapshot()),
      windows: await separateWindows(),
      update: appUpdates?.state(),
      usage: displayUsage(),
      continuation: continuation.snapshot(),
      fleet: fleet.snapshot(),
      autoSwitch: autoSwitch.snapshot(),
      planning: keeper.snapshot(),
      drafts: await draftSummaries(desktop),
      sidebar: await sidebarSummary(desktop),
      extension: await desktop.extensionOffer(),
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
      hours: {
        weekday: service.store.state.settings.planning.weekday,
        weekend: service.store.state.settings.planning.weekend,
      },
      now: Date.now(),
    });
  });
  handle("token-usage", async (input) => {
    const { range, accountId } = usageStatisticsInput.parse(input);
    if (!tokenLedger)
      throw new Error(
        say("Token kaydı açılamadı.", "Relay cannot read the token usage."),
      );
    if (Date.now() - tokenTickedAt > TOKEN_FRESH_MS) {
      // Ticks until the pass is complete or about a second has passed.
      const until = Date.now() + TOKEN_REFRESH_BUDGET_MS;
      do await tokenTick();
      while (
        tokenLastTick !== "failed" &&
        !tokenLastTick.complete &&
        Date.now() < until
      );
    }
    const exactSince = activeTimeline.exactSince();
    return buildTokenUsageView({
      ledger: tokenLedger.snapshot(),
      accounts: service.store.state.accounts,
      range,
      ...(accountId ? { accountId } : {}),
      zone: service.store.state.settings.planning.timeZone,
      now: Date.now(),
      ...(exactSince === undefined ? {} : { exactSince }),
    });
  });
  const lostFoundSource = () => {
    const ledger = tokenLedger?.snapshot();
    return {
      rollups: usageHistory.rollups(),
      segments: activeTimeline.list(),
      ledgerDays: ledger?.days ?? {},
      ...(ledger?.slots ? { ledgerSlots: ledger.slots } : {}),
      ...(ledger?.slotsSince === undefined
        ? {}
        : { slotsSince: ledger.slotsSince }),
      accounts: service.store.state.accounts,
      zone: service.store.state.settings.planning.timeZone,
      now: Date.now(),
    };
  };
  handle("lost-found-collection", () => lostFoundCollection(lostFoundSource()));
  handle("create-account", (input) =>
    service.store.create(createAccountSchema.parse(input)),
  );
  handle("update-account", (accountId, input) => {
    const updated = service.store.edit(id.parse(accountId), createAccountSchema.parse(input));
    void tray?.update();
    broadcastChanged();
    return updated;
  });
  // Under the Desktop lock, so no switch to the account starts while it goes. Its usage history
  // and token counts stay: they are the user's record; its profile's transcripts are gone.
  handle("remove-account", (accountId) => {
    const account = id.parse(accountId);
    if (desktop.isBusy)
      throw new Error(
        "Finish the Desktop handoff before starting another Desktop operation.",
      );
    return manualDesktopLock(() =>
      service.transaction(async () => {
        antigravityBridges.get(account)?.stop();
        antigravityBridges.delete(account);
        pendingAntigravityOAuth.delete(account);
        const oauthTimer = antigravityOAuthTimers.get(account);
        if (oauthTimer) clearInterval(oauthTimer);
        antigravityOAuthTimers.delete(account);
        const removed = await service.remove(account, {
          vault: path.join(app.getPath("userData"), "desktop-vault"),
          locks: profileLocks(),
          desktop: () => desktop.snapshot(),
        });
        usage.forget(account);
        void forgetSignInSession(account).catch(() => {});
        keeper.resume();
        void keeper.tick();
        void autoSwitch.tick();
        return removed;
      }),
    ).finally(() => {
      void tray?.update();
      broadcastChanged();
    });
  });
  handle("check-auth", (accountId) =>
    service.transaction(() => {
      const account = id.parse(accountId);
      if (usageCredentialRefresher.isRefreshing(account))
        throw new Error("Wait for the account connection refresh to finish.");
      return service.checkAuth(account).then(async (checked) => {
        await alignDesktopWorkspace(checked).catch(() => {});
        return service.store.account(account);
      });
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
  handle("reopen-login", (accountId, attemptId, where) =>
    service.auth.reopen(
      id.parse(accountId),
      id.parse(attemptId),
      z.enum(["window", "browser"]).optional().parse(where),
    ),
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
      title: say("Proje klasörünü seç", "Select the project folder"),
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
        "Select the Claude Code CLI file",
      ),
    });
    if (!result.canceled) {
      service.store.update((s) => {
        s.executable = result.filePaths[0];
      });
      await service.diagnose();
    }
  });
  handle("pick-claude-app", async () => {
    const mac = process.platform === "darwin";
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openFile"],
      ...(mac ? { defaultPath: "/Applications" } : {}),
      title: say("Claude uygulamasını seç", "Select the Claude app"),
    });
    if (result.canceled || !result.filePaths[0]) return;
    // The store's change reaches every window, which reads the Desktop state again.
    service.store.update((s) => {
      s.claudeApp = result.filePaths[0];
    });
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
        "Limit okuma girişi yenileniyor.",
        "A usage sign-in renewal is in progress.",
      ),
      detail: say(
        "Relay, yenileme bitene kadar açık kalır. Sonra yeniden çık.",
        "Relay stays open until the renewal ends. Then quit again.",
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
        say("Durdur ve çık", "Stop and quit"),
      ],
      defaultId: 0,
      cancelId: 0,
      message: say(
        `${active.length} terminal çalışıyor.`,
        active.length === 1
          ? "1 terminal is running."
          : `${active.length} terminals are running.`,
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
  // Here, not in "before-quit": that one can still be vetoed (a busy switch, a running
  // terminal), which would leave Relay open with its gateway down.
  void proxyServer?.stop();
  for (const bridge of antigravityBridges.values()) bridge.stop();
  appUpdates?.stop();
  keeperAbort.abort();
  if (trayTimer) clearInterval(trayTimer);
  tokenScanStopped = true;
  if (tokenTimer) clearTimeout(tokenTimer);
  if (widgetMidnight) clearTimeout(widgetMidnight);
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
