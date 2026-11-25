/**
 * The main process's late-bound singletons: made once at startup (main/boot), read everywhere.
 * Importers read them as live bindings and write them only through `set`, whose setters return
 * what they were given so an assignment used as a value keeps its meaning. Never copy one of
 * these into a module-level constant: it would keep `undefined`.
 */
import type { AntigravitySwitcher } from "../core/antigravity-switch";
import type { AutoCapture } from "../core/auto-capture";
import type { AutoSwitchManager } from "../core/auto-switch";
import type { ActiveAccountTimeline } from "../core/active-account-timeline";
import type { DesktopManager } from "../core/desktop";
import type { DesktopContinuationManager } from "../core/desktop-continuation";
import type { DesktopAutomation } from "../core/desktop-continuation-host";
import type { DesktopWindows } from "../core/desktop-windows";
import type { DraftScheduler } from "../core/draft-main";
import type { FleetContinuation } from "../core/fleet-continuation";
import type { GlobalShortcuts } from "../core/global-shortcuts";
import type { MenuBarTitle } from "../core/menu-bar-title";
import type { ProcessLock } from "../core/process-lock";
import type { ProxyServer } from "../core/proxy/proxy-server";
import type { Service } from "../core/service";
import type { SignInRenewal } from "../core/sign-in-renewal";
import type { SwitchDiagnostics } from "../core/switch-diagnostics";
import type { TempoTracker } from "../core/tempo-tracker";
import type { UsageManager } from "../core/usage";
import type { UsageHistory } from "../core/usage-history";
import type { UsageCredentialRefresher } from "../core/usage-refresh";
import type { Sealer } from "../core/vault-crypto";
import type { WindowKeeper } from "../core/window-keeper";
import type { SwitchWindow } from "../switch-window";
import type { RelayTray } from "../tray";
import type { TrayPanel } from "../tray-panel";
import type { LanguagePref } from "../../shared/i18n/locales";
import type { SwitchStory } from "../../shared/switch-scene";
import type { TraySnapshot } from "../../shared/tray";
import type { DesktopState } from "../../shared/types";

export let service: Service;
export let desktop: DesktopManager;
/** This computer's vault key, once ready: account backups unseal and seal sign-ins with it. */
export let vaultSealer: Sealer | undefined;
/** Saves a Claude app sign-in by itself once the user has signed in and opened Code. */
export let autoCapture: AutoCapture | undefined;
export let switchDiagnostics: SwitchDiagnostics | undefined;
/** Accounts opened in a separate Claude window beside the main one; macOS only. */
export let desktopWindows: DesktopWindows | undefined;
export let usage: UsageManager;
export let usageCredentialRefresher: UsageCredentialRefresher;
export let autoSwitch: AutoSwitchManager;
export let tray: RelayTray | undefined;
/** What the menu bar title shows, kept beside the registry. */
export let menuBarTitle: MenuBarTitle | undefined;
/** The menu bar's last snapshot, so Settings can show what it shows. */
export let lastTraySnapshot: TraySnapshot | undefined;
export let trayPanel: TrayPanel | undefined;
/** The global shortcuts (Settings → General), registered once the tray exists. */
export let globalShortcuts: GlobalShortcuts | undefined;
export let switchWindow: SwitchWindow | undefined;
export let switchStory: SwitchStory | undefined;
export let usageHistory: UsageHistory;
export let activeTimeline: ActiveAccountTimeline;
export let tempo: TempoTracker;
export let trayTimer: ReturnType<typeof setInterval> | undefined;
/** The saved language choice (language.json); `appLocale` is what it resolves to. */
export let languagePref: LanguagePref = "system";
export let keeper: WindowKeeper;
export let observedDesktop: DesktopState | undefined;
export let initialized = false;
export let continuation: DesktopContinuationManager;
export let fleet: FleetContinuation;
export let automation: DesktopAutomation;
export let draftRestore: DraftScheduler;
/**
 * The lock Relay's processes share (the app and the relay CLI): each holder of the in-process
 * lock takes it too, so a terminal never quits Claude in the middle of the app's work.
 */
export let operationLock: ProcessLock | undefined;
export const keeperAbort = new AbortController();
export let quitting = false;
/** When the system said it is shutting down or restarting: quitting is not vetoed shortly after. */
export let systemShutdownAt: number | undefined;
export let signInRenewal: SignInRenewal | undefined;
/**
 * The Proxy Gateway (Settings → Proxy): one local server that routes requests over the accounts
 * by their limits. Started with the app when turned on, stopped when Relay quits. Every start,
 * stop and restart runs one after the other, so a quick toggle can never leave two servers.
 */
export let proxyServer: ProxyServer | undefined;
/** Moves the Antigravity app and agy between saved accounts; macOS only. */
export let antigravitySwitcher: AntigravitySwitcher | undefined;

/** The only writers of the bindings above; each returns the value it set. */
export const set = {
  service: (value: Service) => (service = value),
  desktop: (value: DesktopManager) => (desktop = value),
  vaultSealer: (value: Sealer) => (vaultSealer = value),
  autoCapture: (value: AutoCapture) => (autoCapture = value),
  switchDiagnostics: (value: SwitchDiagnostics) => (switchDiagnostics = value),
  desktopWindows: (value: DesktopWindows) => (desktopWindows = value),
  usage: (value: UsageManager) => (usage = value),
  usageCredentialRefresher: (value: UsageCredentialRefresher) => (usageCredentialRefresher = value),
  autoSwitch: (value: AutoSwitchManager) => (autoSwitch = value),
  tray: (value: RelayTray) => (tray = value),
  menuBarTitle: (value: MenuBarTitle) => (menuBarTitle = value),
  lastTraySnapshot: (value: TraySnapshot) => (lastTraySnapshot = value),
  trayPanel: (value: TrayPanel) => (trayPanel = value),
  globalShortcuts: (value: GlobalShortcuts) => (globalShortcuts = value),
  switchWindow: (value: SwitchWindow | undefined) => (switchWindow = value),
  switchStory: (value: SwitchStory | undefined) => (switchStory = value),
  usageHistory: (value: UsageHistory) => (usageHistory = value),
  activeTimeline: (value: ActiveAccountTimeline) => (activeTimeline = value),
  tempo: (value: TempoTracker) => (tempo = value),
  trayTimer: (value: ReturnType<typeof setInterval>) => (trayTimer = value),
  languagePref: (value: LanguagePref) => (languagePref = value),
  keeper: (value: WindowKeeper) => (keeper = value),
  observedDesktop: (value: DesktopState) => (observedDesktop = value),
  initialized: (value: boolean) => (initialized = value),
  continuation: (value: DesktopContinuationManager) => (continuation = value),
  fleet: (value: FleetContinuation) => (fleet = value),
  automation: (value: DesktopAutomation) => (automation = value),
  draftRestore: (value: DraftScheduler) => (draftRestore = value),
  operationLock: (value: ProcessLock) => (operationLock = value),
  quitting: (value: boolean) => (quitting = value),
  systemShutdownAt: (value: number) => (systemShutdownAt = value),
  signInRenewal: (value: SignInRenewal) => (signInRenewal = value),
  proxyServer: (value: ProxyServer | undefined) => (proxyServer = value),
  antigravitySwitcher: (value: AntigravitySwitcher) => (antigravitySwitcher = value),
};
