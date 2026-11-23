import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The main process's source, for the tests that read it: main.ts imports Electron, so they read
 * its text instead. `electron/main.ts` is only the bootstrap; the rest lives in `electron/main/`.
 * The files are read in this order: the bootstrap and the state, then the domain modules, the boot
 * steps in the order they run and the menu bar they end with, the IPC handlers in the order they
 * are bound, and the lifecycle last. tests/main-split.test.ts checks the list is the folder.
 */
const DOMAIN_MODULES = [
  "errors",
  "logs",
  "desktop-lock",
  "desktop-usage",
  "windows",
  "login-item",
  "desktop-support",
  "notifications",
  "links",
  "sign-in-renewal",
  "updates",
  "statusline",
  "gateway-requests",
  "tokens-widget",
  "antigravity",
  "gateway",
  "backup",
  "data-reset",
  "tray-actions",
  "continue-conversation",
];
const BOOT_MODULES = [
  "boot/index",
  "boot/vault",
  "boot/desktop",
  "boot/usage",
  "boot/automation",
  "boot/continuation",
  "boot/fleet-keeper",
  "boot/shell",
  "boot/start",
  "tray-setup",
];
const IPC_MODULES = [
  "ipc/trust",
  "ipc/index",
  "ipc/continuation",
  "ipc/diagnostics-backup",
  "ipc/app",
  "ipc/accounts",
  "ipc/desktop",
  "ipc/proxy",
  "ipc/antigravity",
  "ipc/settings",
  "ipc/snapshots",
];
const moduleFile = (name: string) => `electron/main/${name}.ts`;
const BOOT_FILES = BOOT_MODULES.map(moduleFile);
const IPC_FILES = IPC_MODULES.map(moduleFile);
const MAIN_FILES = [
  "electron/main.ts",
  moduleFile("state"),
  ...DOMAIN_MODULES.map(moduleFile),
  ...BOOT_FILES,
  ...IPC_FILES,
  moduleFile("lifecycle"),
];

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const join = (files: string[]) => files.map(read).join("\n");

/** Every file under `electron/main/`, as repository paths. */
function moduleFiles(dir = "electron/main"): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? moduleFiles(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );
}

/** The listed files, so a test can check that the list is the folder: no module is left unread. */
export function listedMainFiles(): string[] {
  return [...MAIN_FILES];
}

/** The files under `electron/main/` now. */
export function mainModuleFiles(): string[] {
  return moduleFiles();
}

/** The whole main process: the bootstrap and every module. */
export function mainSource(): string {
  return join(MAIN_FILES);
}

/** The startup steps in the order they run, ending with the menu bar they set up. */
export function bootSource(): string {
  return join(BOOT_FILES);
}

/** The IPC handlers in the order they are bound. */
export function ipcSource(): string {
  return join(IPC_FILES);
}

/** One module's source, by its path under `electron/main/` without `.ts` (`"lifecycle"`, `"ipc/app"`). */
export function mainModule(name: string): string {
  return read(moduleFile(name));
}
