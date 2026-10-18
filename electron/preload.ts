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
  updateAccountPlanning: (id, input) =>
    ipcRenderer.invoke("relay:account-planning", id, input),
  showDiagnostics: () => ipcRenderer.invoke("relay:show-diagnostics"),
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
  updatePlanning: (patch: unknown) =>
    ipcRenderer.invoke("relay:update-planning", patch),
  refreshUsage: (id, allowPrompt) =>
    ipcRenderer.invoke("relay:refresh-usage", id, allowPrompt),
  desktopSnapshot: () => ipcRenderer.invoke("relay:desktop-snapshot"),
  usageStatistics: (input) =>
    ipcRenderer.invoke("relay:usage-statistics", input),
  tokenUsage: (input) => ipcRenderer.invoke("relay:token-usage", input),
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
  recoverDesktop: () => ipcRenderer.invoke("relay:recover-desktop"),
  panelSnapshot: () => ipcRenderer.invoke("relay:panel-snapshot"),
  snapshot: () => ipcRenderer.invoke("relay:snapshot"),
  createAccount: (input) => ipcRenderer.invoke("relay:create-account", input),
  checkAuth: (id) => ipcRenderer.invoke("relay:check-auth", id),
  login: (id) => ipcRenderer.invoke("relay:login", id),
  reopenLogin: (id, attempt) =>
    ipcRenderer.invoke("relay:reopen-login", id, attempt),
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
