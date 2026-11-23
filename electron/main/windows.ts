/** The main window, its pages and menu, and what opens over it (dialogs, the diagnostics zip). */
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from "electron";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExternalLink } from "../../shared/external-links";
import { intentHash, type Destination, type PageIntent } from "../../src/app/routes";
import { appMenuTemplate, bugReportUrl, DOCUMENTATION_URL } from "../app-menu";
import { buildDiagnosticsBundle, newestCrashDumps, settingsSummary } from "../core/diagnostics-bundle";
import { redact } from "../core/redact";
import { getAppLocale, say } from "../i18n";
import { pageCrashAction } from "../main-lifecycle";
import { WindowRelease } from "../window-release";
import { desktopLock } from "./desktop-lock";
import { recordMainError } from "./errors";
import { desktop, initialized, observedDesktop, quitting, service, tray, trayPanel } from "./state";
export let window: BrowserWindow | null = null;
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
/** Shows the main window on `target`: a window made now opens there, a loaded one is told to go. */
export function openPage(target: Destination, want?: PageIntent) {
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
export function showWindow(hash?: string) {
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
/** Tell every Relay renderer (main window and menu bar panel) that state changed. */
export function broadcastChanged() {
  if (window && !window.isDestroyed()) window.webContents.send("relay:changed");
  trayPanel?.webContents()?.send("relay:changed");
}
/** The Vite dev server the pages come from in development; undefined when they load from dist. */
function devServer(): string | undefined {
  const devURL = !app.isPackaged && process.env.RELAY_DEV_URL;
  return devURL === "http://127.0.0.1:5173" ? devURL : undefined;
}
/** The built pages: index.html, panel.html, switch.html. */
const PAGES_DIR = path.join(__dirname, "../dist");
/** Loads a Vite entry from the dev server in development, else from dist. */
export function loadPage(
  win: BrowserWindow,
  page: "index.html" | "panel.html" | "switch.html",
  /** `#/planlama`: the page the main window opens on. */
  hash?: string,
) {
  const devURL = devServer();
  if (devURL)
    void win.loadURL(
      page === "index.html" ? `${devURL}/${hash ?? ""}` : `${devURL}/${page}`,
    );
  else
    void win.loadFile(
      path.join(PAGES_DIR, page),
      hash ? { hash: hash.replace(/^#/, "") } : undefined,
    );
}
/** Whether a frame shows one of Relay's own pages, from where `loadPage` loads them. */
export function relayPage(url: string | undefined): boolean {
  if (!url) return false;
  const devURL = devServer();
  if (devURL) return url.startsWith(`${devURL}/`);
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && fileURLToPath(parsed).startsWith(PAGES_DIR + path.sep);
  } catch {
    return false;
  }
}
/** How long the main window's page may stay unresponsive before it is restarted. */
const UNRESPONSIVE_RESTART_MS = 10_000;
export function createWindow(hash?: string) {
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
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? "#100f0e" : "#f5f4f2" }),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // 16 px from the left: the three buttons end at 68 px, inside the 84 px collapsed rail.
    trafficLightPosition: { x: 16, y: 19 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
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
  // A crashed or killed page loads again after a growing delay, a few times a minute at most; a
  // page that stays hung is ended, and then loads again.
  let pageReloadsAt: number[] = [];
  let pageReload: ReturnType<typeof setTimeout> | undefined;
  own.webContents.on("render-process-gone", (_event, details) => {
    if (own.isDestroyed()) return;
    const next = pageCrashAction(details.reason, pageReloadsAt, Date.now());
    if (next.action === "ignore") return;
    clearTimeout(pageReload);
    if (next.action === "give-up") {
      recordMainError(
        "render-process-gone",
        `${details.reason} (exit code ${details.exitCode}); the window is no longer reloaded`,
      );
      dialog.showErrorBox(
        say("electronMain.relayWindowStopped"),
        say("electronMain.relayWindowKeptStopping"),
      );
      return;
    }
    pageReloadsAt = next.reloadsAt;
    pageReload = setTimeout(() => {
      if (!own.isDestroyed()) own.webContents.reload();
    }, next.delayMs);
  });
  own.on("closed", () => clearTimeout(pageReload));
  let hung: ReturnType<typeof setTimeout> | undefined;
  own.on("unresponsive", () => {
    clearTimeout(hung);
    hung = setTimeout(() => {
      if (!own.isDestroyed()) own.webContents.forcefullyCrashRenderer();
    }, UNRESPONSIVE_RESTART_MS);
    hung.unref();
  });
  own.on("responsive", () => clearTimeout(hung));
  own.on("closed", () => clearTimeout(hung));
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
      // Linux desktops without a tray area would leave a hidden window unreachable.
      if (process.platform === "linux") own.minimize();
      else own.hide();
      closeWindowToTray();
    }
  });
}
/** The application menu in the app's language; main rebuilds it when the language changes. */
export function applyAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(getAppLocale(), {
        closeToTray: () => closeToTray(),
        quit: () => app.quit(),
        closeWindow: () => closeFocusedWindow(),
        openDocumentation: () => void shell.openExternal(DOCUMENTATION_URL),
        reportBug: () =>
          void shell.openExternal(
            bugReportUrl(app.getVersion(), process.platform, process.getSystemVersion()),
          ),
        exportDiagnostics: () =>
          void exportDiagnostics().catch((error: unknown) => {
            recordMainError("export-diagnostics", error);
            dialog.showErrorBox(say("electronMain.diagnosticsWereNotExported"), redact(error));
          }),
      }),
    ),
  );
}
/** The logs a diagnostics zip copies, each redacted; a missing one is left out. */
function diagnosticsFiles() {
  const userData = app.getPath("userData");
  return [
    path.join(app.getPath("logs"), "main-errors.log"),
    ...["usage-issues.json", "draft-events.json", "fleet-events.json"].map((name) =>
      path.join(userData, name),
    ),
  ];
}
/**
 * Help → Export diagnostics, and Settings → Advanced: the redacted zip for a bug report, saved
 * where the user picks and shown in Finder or Explorer. False when the dialog was cancelled.
 * Names, emails and tokens never leave: every file goes through `redactDiagnostics`.
 */
export async function exportDiagnostics() {
  const at = new Date();
  const options: Electron.SaveDialogOptions = {
    defaultPath: path.join(
      app.getPath("downloads"),
      `relay-diagnostics-${at.toISOString().slice(0, 10)}.zip`,
    ),
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  };
  const { canceled, filePath } =
    window && !window.isDestroyed()
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return false;
  const { accounts, settings } = service.store.state;
  const zip = await buildDiagnosticsBundle({
    files: diagnosticsFiles(),
    names: accounts.flatMap((account) => [account.name, account.auth?.orgName ?? ""]),
    home: os.homedir(),
    at,
    summary: {
      createdAt: at.toISOString(),
      relay: app.getVersion(),
      packaged: app.isPackaged,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      os: {
        platform: process.platform,
        arch: process.arch,
        version: process.getSystemVersion(),
        release: os.release(),
      },
      locale: { app: getAppLocale(), system: app.getLocale() },
      settings: settingsSummary(settings, accounts),
      crashDumps: await newestCrashDumps(app.getPath("crashDumps")),
    },
  });
  await fsp.writeFile(filePath, zip, { mode: 0o600 });
  shell.showItemInFolder(filePath);
  return true;
}
/** An open-file dialog over the main window while it is there, else on its own. */
export function openDialog(options: Electron.OpenDialogOptions) {
  return window && !window.isDestroyed()
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options);
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
