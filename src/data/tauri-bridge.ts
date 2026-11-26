// The Tauri shell's window bridge: the same RelayAPI the Electron preload exposes, over the two
// Tauri commands `relay_invoke` and `relay_send` and the app's push events. Every method keeps
// its Electron channel name (electron/preload.ts, electron/switch-preload.ts).
//
// Push events carry the Electron `webContents.send` arguments as one JSON array payload:
// `emit_to(label, "relay:navigate", [page, intent])`, `emit_to(label, "relay:changed", [])`.
// A window listens for its own label only, as `webContents.send` reaches one window: a plain
// `listen` would also hear events emitted to the other windows.
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  RelaySwitchAPI,
  SwitchSceneView,
} from "../../shared/switch-scene";
import type { RelayAPI } from "../../shared/types";

/** `onChanged`, `onAuth`, …: an `on` followed by a capital (not `oneClickConnect`). */
type ListenerMethod = {
  [K in keyof RelayAPI]: K extends `on${infer Rest}`
    ? Rest extends Capitalize<Rest>
      ? K
      : never
    : never;
}[keyof RelayAPI];
type SendMethod =
  "setPanelHeight" | "closePanel" | "terminalWrite" | "terminalResize";
export type InvokeMethod = Exclude<keyof RelayAPI, ListenerMethod | SendMethod>;

/** Request and reply calls: `ipcRenderer.invoke` in Electron, `relay_invoke` here. */
export const CHANNELS = {
  inspectContinuation: "relay:inspect-continuation",
  armContinuation: "relay:arm-continuation",
  disarmContinuation: "relay:disarm-continuation",
  setFleetContinuation: "relay:set-fleet-continuation",
  reconcileContinuation: "relay:reconcile-continuation",
  abandonContinuation: "relay:abandon-continuation",
  requestDesktopAccessibility: "relay:request-desktop-accessibility",
  copyDraft: "relay:copy-draft",
  dismissDraft: "relay:dismiss-draft",
  copySidebarRecipe: "relay:copy-sidebar-recipe",
  dismissSidebarGap: "relay:dismiss-sidebar-gap",
  updateAccountPlanning: "relay:account-planning",
  setAccountSwitchAt: "relay:account-switch-at",
  testRemoteNotify: "relay:test-remote-notify",
  extensionStatus: "relay:extension-status",
  syncExtension: "relay:extension-sync",
  openClaudeWeb: "relay:extension-web",
  openExtensionSettings: "relay:extension-settings",
  checkExtension: "relay:extension-check",
  linkExtension: "relay:extension-link",
  terminalStatus: "relay:terminal-status",
  checkTerminal: "relay:terminal-check",
  syncTerminal: "relay:terminal-sync",
  linkTerminal: "relay:terminal-link",
  cancelTerminalLink: "relay:terminal-link-cancel",
  showDiagnostics: "relay:show-diagnostics",
  exportDiagnostics: "relay:export-diagnostics",
  exportBackup: "relay:backup-export",
  chooseBackup: "relay:backup-choose",
  openBackup: "relay:backup-open",
  importBackup: "relay:backup-import",
  cancelBackup: "relay:backup-cancel",
  resetData: "relay:reset-data",
  claudeLaunch: "relay:claude-launch",
  setClaudeLaunch: "relay:set-claude-launch",
  checkUpdate: "relay:update-check",
  installUpdate: "relay:update-install",
  setUpdateAuto: "relay:set-update-auto",
  openUpdateNotes: "relay:update-notes",
  pauseShortcuts: "relay:pause-shortcuts",
  setSeparateWindows: "relay:set-separate-windows",
  openWindow: "relay:open-window",
  closeWindow: "relay:close-window",
  menuBarTitle: "relay:menu-bar-title",
  setMenuBarTitle: "relay:set-menu-bar-title",
  menuBarNow: "relay:menu-bar-now",
  setLanguage: "relay:set-language",
  getLanguage: "relay:get-language",
  openPage: "relay:open-page",
  takeSwitchRequest: "relay:take-switch-request",
  quit: "relay:quit",
  updateSettings: "relay:update-settings",
  acknowledgeRisk: "relay:acknowledge-risk",
  proxyStatus: "relay:proxy-status",
  proxyToggle: "relay:proxy-toggle",
  proxyConfigure: "relay:proxy-configure",
  proxyRegenerateKey: "relay:proxy-regenerate-key",
  proxyBindClient: "relay:proxy-bind-client",
  proxyUnbindClient: "relay:proxy-unbind-client",
  proxyOverflowConfigure: "relay:proxy-overflow-configure",
  proxyOverflowSaveUpstream: "relay:proxy-overflow-save-upstream",
  proxyOverflowRemoveUpstream: "relay:proxy-overflow-remove-upstream",
  proxyOverflowTest: "relay:proxy-overflow-test",
  copyText: "relay:copy-text",
  detectProviders: "relay:detect-providers",
  oneClickConnect: "relay:one-click-connect",
  startAntigravityOAuth: "relay:antigravity-oauth-start",
  pollAntigravityOAuth: "relay:antigravity-oauth-poll",
  cancelAntigravityOAuth: "relay:antigravity-oauth-cancel",
  submitAntigravityCallback: "relay:antigravity-oauth-callback",
  updatePlanning: "relay:update-planning",
  refreshUsage: "relay:refresh-usage",
  claudeAppAccess: "relay:claude-app-access",
  claudeStatusline: "relay:claude-statusline",
  renewSignInNow: "relay:renew-sign-in-now",
  desktopSnapshot: "relay:desktop-snapshot",
  usageStatistics: "relay:usage-statistics",
  tokenUsage: "relay:token-usage",
  lostFoundCollection: "relay:lost-found-collection",
  dismissDesktopError: "relay:dismiss-desktop-error",
  captureDesktop: "relay:capture-desktop",
  beginDesktopLogin: "relay:begin-desktop-login",
  cancelDesktopLogin: "relay:cancel-desktop-login",
  switchDesktop: "relay:switch-desktop",
  syncDesktopHistory: "relay:sync-desktop-history",
  desktopHistorySummary: "relay:desktop-history-summary",
  openDesktop: "relay:open-desktop",
  openAntigravity: "relay:open-antigravity",
  switchAntigravity: "relay:switch-antigravity",
  saveAntigravitySignIn: "relay:save-antigravity-sign-in",
  cancelAntigravitySignIn: "relay:cancel-antigravity-sign-in",
  openCodeTab: "relay:open-code-tab",
  armAutoCapture: "relay:arm-auto-capture",
  disarmAutoCapture: "relay:disarm-auto-capture",
  chooseAutoCaptureOrg: "relay:choose-auto-capture-org",
  recoverDesktop: "relay:recover-desktop",
  panelSnapshot: "relay:panel-snapshot",
  snapshot: "relay:snapshot",
  createAccount: "relay:create-account",
  updateAccount: "relay:update-account",
  removeAccount: "relay:remove-account",
  checkAuth: "relay:check-auth",
  login: "relay:login",
  reopenLogin: "relay:reopen-login",
  cancelLogin: "relay:cancel-login",
  submitLoginCode: "relay:submit-login-code",
  closeRun: "relay:close-run",
  launch: "relay:launch",
  switchAccount: "relay:switch-account",
  pickFolder: "relay:pick-folder",
  pickExecutable: "relay:pick-executable",
  pickClaudeApp: "relay:pick-claude-app",
  importHistory: "relay:import",
  setPinned: "relay:pin",
  setCooldown: "relay:cooldown",
  transcript: "relay:transcript",
  terminalBuffer: "relay:buffer",
  stop: "relay:stop",
} as const satisfies Record<InvokeMethod, string>;

/** Fire-and-forget calls: `ipcRenderer.send` in Electron, `relay_send` here. */
export const SEND_CHANNELS = {
  setPanelHeight: "relay:panel-size",
  closePanel: "relay:panel-close",
  terminalWrite: "relay:write",
  terminalResize: "relay:resize",
} as const satisfies Record<SendMethod, string>;

/** Push events from the app: `ipcRenderer.on` in Electron, `listen` here. */
export const EVENT_CHANNELS = {
  onNavigate: "relay:navigate",
  onSwitchRequest: "relay:switch-request",
  onPanelVisibility: "relay:panel-visibility",
  onChanged: "relay:changed",
  onAuth: "relay:auth",
  onTerminal: "relay:terminal",
} as const satisfies Record<ListenerMethod, string>;

/** The channel that hands Electron's localStorage over once (crates/relay-app legacy_storage). */
export const LEGACY_STORAGE_CHANNEL = "relay:legacy-ui-storage";

/** True inside a Tauri webview. */
export const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * A failed call rejects with the Error Electron's `ipcRenderer.invoke` gives, so
 * `errorMessage` (src/data/error-message.ts) and every caller read it the same way.
 */
function remoteError(channel: string, error: unknown): Error {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : JSON.stringify(error);
  return new Error(
    `Error invoking remote method '${channel}': Error: ${message}`,
  );
}

/**
 * Settles once every listener subscribed so far is registered. Electron's `ipcRenderer.on` is
 * synchronous, so the UI subscribes and then asks (the switch window's `onScene` then `ready`);
 * Tauri's `listen` is not, so each call waits for the subscriptions made before it.
 */
let listening: Promise<unknown> = Promise.resolve();

function invokeChannel<T>(channel: string, args: unknown[]): Promise<T> {
  return listening
    .then(() => invoke<T>("relay_invoke", { channel, args }))
    .catch((error: unknown) => {
      throw remoteError(channel, error);
    });
}

function sendChannel(channel: string, args: unknown[]): void {
  // Electron's send has no reply; a refused send is only worth a log line.
  void listening
    .then(() => invoke("relay_send", { channel, args }))
    .catch((error: unknown) => console.error(error));
}

/**
 * Subscribes at once and returns a synchronous unsubscribe, as the preload's listeners do.
 * An unsubscribe called before `listen` settles unlistens as soon as it does.
 */
function subscribe(
  channel: string,
  deliver: (args: unknown[]) => void,
): () => void {
  let unlisten: UnlistenFn | undefined;
  let stopped = false;
  const registered = getCurrentWebview()
    .listen<unknown[]>(channel, (event) => deliver(event.payload))
    .then(
      (off) => {
        if (stopped) void off();
        else unlisten = off;
      },
      (error: unknown) => console.error(error),
    );
  listening = Promise.all([listening, registered]);
  return () => {
    if (stopped) return;
    stopped = true;
    void unlisten?.();
  };
}

type Method = (...args: unknown[]) => unknown;

export function tauriRelayApi(): RelayAPI {
  const api: Record<string, Method> = {};
  for (const [method, channel] of Object.entries(CHANNELS))
    api[method] = (...args) => invokeChannel(channel, args);
  for (const [method, channel] of Object.entries(SEND_CHANNELS))
    api[method] = (...args) => sendChannel(channel, args);
  for (const [method, channel] of Object.entries(EVENT_CHANNELS))
    api[method] = (callback) =>
      subscribe(channel, (args) => (callback as Method)(...args));
  // The preload hands the panel a strict boolean.
  api.onPanelVisibility = (callback) =>
    subscribe(EVENT_CHANNELS.onPanelVisibility, ([shown]) =>
      (callback as Method)(shown === true),
    );
  return api as unknown as RelayAPI;
}

export function tauriSwitchApi(): RelaySwitchAPI {
  return {
    onScene: (callback) =>
      subscribe("relay:switch-scene", ([view]) =>
        callback(view as SwitchSceneView),
      ),
    ready: () => sendChannel("relay:switch-ready", []),
  };
}

/**
 * Copies Electron's localStorage (sidebar size, update "later", Private mode, dismissals,
 * language, lost and found) into this webview once, before the first render. A key the webview
 * already has keeps its value.
 */
export async function applyLegacyStorage(): Promise<void> {
  const stored = await invokeChannel<Record<string, unknown> | null>(
    LEGACY_STORAGE_CHANNEL,
    [],
  );
  if (!stored) return;
  for (const [key, value] of Object.entries(stored))
    if (typeof value === "string" && localStorage.getItem(key) === null)
      localStorage.setItem(key, value);
}
