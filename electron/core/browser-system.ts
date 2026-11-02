import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_APPS,
  BROWSERS,
  CLAUDE_EXTENSION_ID,
  PROFILE_FOLDER,
  localStateProfiles,
  type BrowserApp,
  type ExtensionInstance,
} from "../../shared/browser-extension";
import { runDetached } from "./detached-exec";
import { pidAlive } from "./desktop-processes";

/**
 * What Relay reads and runs to find and restart a browser: its `Local State`, `Preferences`,
 * the target of its `SingletonLock` link, the process list, and `osascript` and `open`.
 */
export interface BrowserSystem {
  /** ~/Library/Application Support */
  support: string;
  readText(file: string): string | undefined;
  exists(file: string): boolean;
  /** The newest modification time (ms) of a folder's files; undefined when it cannot be read. */
  modifiedAt(dir: string): number | undefined;
  readLink(file: string): string | undefined;
  alive(pid: number): boolean;
  /** Every process's executable path, from `ps`. */
  processes(): Promise<string>;
  /** Asks the browser to quit as a user would; resolves once asked, not once it has quit. */
  quit(app: BrowserApp): Promise<void>;
  /** Opens the browser in the background, restoring the windows it had. */
  launch(app: BrowserApp): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Local State is a few hundred kilobytes; anything far larger is not one. */
const MAX_JSON = 16 * 1024 * 1024;

export function macBrowserSystem(home = os.homedir()): BrowserSystem {
  return {
    support: path.join(home, "Library", "Application Support"),
    readText: (file) => {
      try {
        if (fs.statSync(file).size > MAX_JSON) return undefined;
        return fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    exists: (file) => fs.existsSync(file),
    modifiedAt: (dir) => {
      try {
        let newest = fs.statSync(dir).mtimeMs;
        for (const name of fs.readdirSync(dir))
          newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs);
        return newest;
      } catch {
        return undefined;
      }
    },
    readLink: (file) => {
      try {
        return fs.readlinkSync(file);
      } catch {
        return undefined;
      }
    },
    alive: pidAlive,
    processes: async () =>
      (
        await runDetached("/bin/ps", ["-axo", "comm="], {
          timeout: 5000,
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout,
    quit: async (app) => {
      // Guarded: `tell … to quit` on an app that is not running would launch it first.
      const id = BROWSERS[app].bundleId;
      await runDetached(
        "/usr/bin/osascript",
        [
          "-e",
          `if application id "${id}" is running then tell application id "${id}" to quit`,
        ],
        { timeout: 20_000 },
      );
    },
    launch: async (app) => {
      // -g keeps focus where it is. The flag restores the last session whatever the browser's
      // own startup setting says, so a quit for the swap never loses the user's tabs.
      await runDetached(
        "/usr/bin/open",
        ["-g", "-b", BROWSERS[app].bundleId, "--args", "--restore-last-session"],
        { timeout: 15_000 },
      );
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const dataDir = (system: BrowserSystem, app: BrowserApp) =>
  path.join(system.support, BROWSERS[app].dataDir);

/** `Local State` or a profile's `Preferences` as JSON; undefined when missing or invalid. */
export function readJson(system: BrowserSystem, file: string): unknown {
  const text = system.readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The folder holding the extension's `chrome.storage.local` in a profile. */
export const extensionStorageDir = (
  system: BrowserSystem,
  app: BrowserApp,
  profile: string,
) => {
  if (!PROFILE_FOLDER.test(profile)) throw new Error("Invalid browser profile.");
  return path.join(
    dataDir(system, app),
    profile,
    "Local Extension Settings",
    CLAUDE_EXTENSION_ID,
  );
};

/** The folder the extension is installed in, in a profile; it has no storage until first opened. */
export const extensionInstallDir = (
  system: BrowserSystem,
  app: BrowserApp,
  profile: string,
) => {
  if (!PROFILE_FOLDER.test(profile)) throw new Error("Invalid browser profile.");
  return path.join(dataDir(system, app), profile, "Extensions", CLAUDE_EXTENSION_ID);
};

/**
 * Every browser profile that has the extension, in the browsers' own order: those with its
 * storage, and those where it is installed but was never opened (`opened` false).
 */
export function extensionInstances(system: BrowserSystem): ExtensionInstance[] {
  return BROWSER_APPS.flatMap((app) => {
    const state = readJson(system, path.join(dataDir(system, app), "Local State"));
    return localStateProfiles(state).flatMap((p) => {
      const storage = extensionStorageDir(system, app, p.profile);
      const opened = system.exists(storage);
      if (!opened && !system.exists(extensionInstallDir(system, app, p.profile))) return [];
      const usedAt = opened ? system.modifiedAt(storage) : undefined;
      return [
        {
          app,
          profile: p.profile,
          name: p.name,
          opened,
          ...(usedAt === undefined ? {} : { usedAt }),
        },
      ];
    });
  });
}

/**
 * Whether the browser runs: the process its `SingletonLock` link names ("host-pid") is alive,
 * or its main executable is in the process list. Either one counts: a stale link is not
 * running, and a browser started with another user data dir still holds its own profiles.
 */
export async function browserRunning(
  system: BrowserSystem,
  app: BrowserApp,
): Promise<boolean> {
  const target = system.readLink(path.join(dataDir(system, app), "SingletonLock"));
  const pid = Number(target?.match(/-(\d+)$/)?.[1]);
  if (Number.isSafeInteger(pid) && pid > 0 && system.alive(pid)) return true;
  const main = `.app/Contents/MacOS/${BROWSERS[app].executable}`;
  return (await system.processes())
    .split("\n")
    .some((line) => line.trim().endsWith(main));
}

/**
 * Asks the browser to quit and waits for it, never forcing it: a "downloads in progress" or
 * "leave this page" prompt keeps it open and the caller leaves it alone. False when it is
 * still running after `waitMs`.
 */
export async function quitBrowser(
  system: BrowserSystem,
  app: BrowserApp,
  waitMs = 30_000,
): Promise<boolean> {
  try {
    await system.quit(app);
  } catch {
    // Not asked, or asked and the answer was lost: the wait below decides.
  }
  for (let waited = 0; waited <= waitMs; waited += 250) {
    if (!(await browserRunning(system, app))) return true;
    await system.sleep(250);
  }
  return false;
}
