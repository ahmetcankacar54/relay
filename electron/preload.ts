import { contextBridge, ipcRenderer } from "electron";
import type { RelayAPI, TerminalEvent, AuthFlow } from "../shared/types";
const api: RelayAPI = {
  inspectContinuation: () => ipcRenderer.invoke("relay:inspect-continuation"),
  armContinuation: (id, policy) =>
    ipcRenderer.invoke("relay:arm-continuation", id, policy),
  disarmContinuation: () => ipcRenderer.invoke("relay:disarm-continuation"),
  setFleetContinuation: (enabled: boolean) =>
    ipcRenderer.invoke("relay:set-fleet-continuation", enabled),
  reconcileContinuation: () =>
    ipcRenderer.invoke("relay:reconcile-continuation"),
  abandonContinuation: () => ipcRenderer.invoke("relay:abandon-continuation"),
  requestDesktopAccessibility: () =>
    ipcRenderer.invoke("relay:request-desktop-accessibility"),
  copyDraft: (id) => ipcRenderer.invoke("relay:copy-draft", id),
  dismissDraft: (id) => ipcRenderer.invoke("relay:dismiss-draft", id),
  copySidebarRecipe: (id) =>
    ipcRenderer.invoke("relay:copy-sidebar-recipe", id),
  dismissSidebarGap: (id) =>
    ipcRenderer.invoke("relay:dismiss-sidebar-gap", id),
  updateAccountPlanning: (id, input) =>
    ipcRenderer.invoke("relay:account-planning", id, input),
  extensionStatus: () => ipcRenderer.invoke("relay:extension-status"),
  syncExtension: () => ipcRenderer.invoke("relay:extension-sync"),
  openClaudeWeb: () => ipcRenderer.invoke("relay:extension-web"),
  openExtensionSettings: () => ipcRenderer.invoke("relay:extension-settings"),
  checkExtension: () => ipcRenderer.invoke("relay:extension-check"),
  linkExtension: (accountId: string) => ipcRenderer.invoke("relay:extension-link", accountId),
  terminalStatus: () => ipcRenderer.invoke("relay:terminal-status"),
  checkTerminal: () => ipcRenderer.invoke("relay:terminal-check"),
  syncTerminal: () => ipcRenderer.invoke("relay:terminal-sync"),
  showDiagnostics: () => ipcRenderer.invoke("relay:show-diagnostics"),
  claudeLaunch: () => ipcRenderer.invoke("relay:claude-launch"),
  setClaudeLaunch: (patch) => ipcRenderer.invoke("relay:set-claude-launch", patch),
  checkUpdate: () => ipcRenderer.invoke("relay:update-check"),
  installUpdate: () => ipcRenderer.invoke("relay:update-install"),
  setUpdateAuto: (enabled) => ipcRenderer.invoke("relay:set-update-auto", enabled),
  openUpdateNotes: () => ipcRenderer.invoke("relay:update-notes"),
  setSeparateWindows: (enabled) => ipcRenderer.invoke("relay:set-separate-windows", enabled),
  openWindow: (accountId) => ipcRenderer.invoke("relay:open-window", accountId),
  closeWindow: (accountId) => ipcRenderer.invoke("relay:close-window", accountId),
  menuBarTitle: () => ipcRenderer.invoke("relay:menu-bar-title"),
  setMenuBarTitle: (choice) => ipcRenderer.invoke("relay:set-menu-bar-title", choice),
  menuBarNow: () => ipcRenderer.invoke("relay:menu-bar-now"),
  setTrayLanguage: (language) =>
    ipcRenderer.invoke("relay:tray-language", language),
  openPage: (page, intent) =>
    ipcRenderer.invoke("relay:open-page", page, intent),
  onNavigate: (callback) => {
    const listener = (_: unknown, page: string, intent?: string) =>
      callback(page as never, intent as never);
    ipcRenderer.on("relay:navigate", listener);
    return () => ipcRenderer.removeListener("relay:navigate", listener);
  },
  takeSwitchRequest: () => ipcRenderer.invoke("relay:take-switch-request"),
  onSwitchRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("relay:switch-request", listener);
    return () => ipcRenderer.removeListener("relay:switch-request", listener);
  },
  setPanelHeight: (height) => ipcRenderer.send("relay:panel-size", height),
  closePanel: () => ipcRenderer.send("relay:panel-close"),
  onPanelVisibility: (callback) => {
    const listener = (_: unknown, shown: unknown) => callback(shown === true);
    ipcRenderer.on("relay:panel-visibility", listener);
    return () => ipcRenderer.removeListener("relay:panel-visibility", listener);
  },
  quit: () => ipcRenderer.invoke("relay:quit"),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("relay:changed", listener);
    return () => ipcRenderer.removeListener("relay:changed", listener);
  },
  updateSettings: (input) => ipcRenderer.invoke("relay:update-settings", input),
  proxyStatus: () => ipcRenderer.invoke("relay:proxy-status"),
  proxyToggle: (enabled) => ipcRenderer.invoke("relay:proxy-toggle", enabled),
  proxyConfigure: (input) => ipcRenderer.invoke("relay:proxy-configure", input),
  proxyRegenerateKey: () => ipcRenderer.invoke("relay:proxy-regenerate-key"),
  proxyBindClient: (id) => ipcRenderer.invoke("relay:proxy-bind-client", id),
  proxyUnbindClient: (id) => ipcRenderer.invoke("relay:proxy-unbind-client", id),
  copyText: (text) => ipcRenderer.invoke("relay:copy-text", text),
  detectProviders: () => ipcRenderer.invoke("relay:detect-providers"),
  oneClickConnect: (input) => ipcRenderer.invoke("relay:one-click-connect", input),
  startAntigravityOAuth: (input) => ipcRenderer.invoke("relay:antigravity-oauth-start", input),
  pollAntigravityOAuth: (input) => ipcRenderer.invoke("relay:antigravity-oauth-poll", input),
  cancelAntigravityOAuth: (input) => ipcRenderer.invoke("relay:antigravity-oauth-cancel", input),
  submitAntigravityCallback: (input) => ipcRenderer.invoke("relay:antigravity-oauth-callback", input),
  updatePlanning: (patch: unknown) =>
    ipcRenderer.invoke("relay:update-planning", patch),
  refreshUsage: (id, allowPrompt) =>
    ipcRenderer.invoke("relay:refresh-usage", id, allowPrompt),
  desktopSnapshot: () => ipcRenderer.invoke("relay:desktop-snapshot"),
  usageStatistics: (input) =>
    ipcRenderer.invoke("relay:usage-statistics", input),
  tokenUsage: (input) => ipcRenderer.invoke("relay:token-usage", input),
  lostFoundCollection: () => ipcRenderer.invoke("relay:lost-found-collection"),
  dismissDesktopError: (revision) =>
    ipcRenderer.invoke("relay:dismiss-desktop-error", revision),
  captureDesktop: (id, org) =>
    ipcRenderer.invoke("relay:capture-desktop", id, org),
  beginDesktopLogin: (id) =>
    ipcRenderer.invoke("relay:begin-desktop-login", id),
  cancelDesktopLogin: () => ipcRenderer.invoke("relay:cancel-desktop-login"),
  switchDesktop: (id) => ipcRenderer.invoke("relay:switch-desktop", id),
  syncDesktopHistory: (id) =>
    ipcRenderer.invoke("relay:sync-desktop-history", id),
  desktopHistorySummary: (id) =>
    ipcRenderer.invoke("relay:desktop-history-summary", id),
  openDesktop: () => ipcRenderer.invoke("relay:open-desktop"),
  openCodeTab: () => ipcRenderer.invoke("relay:open-code-tab"),
  armAutoCapture: (id) => ipcRenderer.invoke("relay:arm-auto-capture", id),
  disarmAutoCapture: (id) => ipcRenderer.invoke("relay:disarm-auto-capture", id),
  chooseAutoCaptureOrg: (id, orgId) =>
    ipcRenderer.invoke("relay:choose-auto-capture-org", id, orgId),
  recoverDesktop: () => ipcRenderer.invoke("relay:recover-desktop"),
  panelSnapshot: () => ipcRenderer.invoke("relay:panel-snapshot"),
  snapshot: () => ipcRenderer.invoke("relay:snapshot"),
  createAccount: (input) => ipcRenderer.invoke("relay:create-account", input),
  updateAccount: (id, input) => ipcRenderer.invoke("relay:update-account", id, input),
  removeAccount: (id) => ipcRenderer.invoke("relay:remove-account", id),
  checkAuth: (id) => ipcRenderer.invoke("relay:check-auth", id),
  login: (id) => ipcRenderer.invoke("relay:login", id),
  reopenLogin: (id, attempt, where) =>
    ipcRenderer.invoke("relay:reopen-login", id, attempt, where),
  cancelLogin: (id, attempt) =>
    ipcRenderer.invoke("relay:cancel-login", id, attempt),
  submitLoginCode: (id, attempt, code) =>
    ipcRenderer.invoke("relay:submit-login-code", id, attempt, code),
  closeRun: (id) => ipcRenderer.invoke("relay:close-run", id),
  onAuth: (callback) => {
    const listener = (_: unknown, flow: AuthFlow) => callback(flow);
    ipcRenderer.on("relay:auth", listener);
    return () => ipcRenderer.removeListener("relay:auth", listener);
  },
  launch: (input) => ipcRenderer.invoke("relay:launch", input),
  switchAccount: (runId, accountId) =>
    ipcRenderer.invoke("relay:switch-account", runId, accountId),
  pickFolder: () => ipcRenderer.invoke("relay:pick-folder"),
  pickExecutable: () => ipcRenderer.invoke("relay:pick-executable"),
  pickClaudeApp: () => ipcRenderer.invoke("relay:pick-claude-app"),
  importHistory: () => ipcRenderer.invoke("relay:import"),
  setPinned: (key, pinned) => ipcRenderer.invoke("relay:pin", key, pinned),
  setCooldown: (id, hours) => ipcRenderer.invoke("relay:cooldown", id, hours),
  transcript: (key) => ipcRenderer.invoke("relay:transcript", key),
  terminalBuffer: (id) => ipcRenderer.invoke("relay:buffer", id),
  terminalWrite: (id, data) => ipcRenderer.send("relay:write", id, data),
  terminalResize: (id, cols, rows) =>
    ipcRenderer.send("relay:resize", id, cols, rows),
  stop: (id) => ipcRenderer.invoke("relay:stop", id),
  onTerminal: (callback) => {
    const listener = (_: unknown, event: TerminalEvent) => callback(event);
    ipcRenderer.on("relay:terminal", listener);
    return () => ipcRenderer.removeListener("relay:terminal", listener);
  },
};
contextBridge.exposeInMainWorld("relay", api);
