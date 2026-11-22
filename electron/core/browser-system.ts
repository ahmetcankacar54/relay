import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  BROWSERS,
  CLAUDE_EXTENSION_ID,
  PROFILE_FOLDER,
  browserApps,
  localStateProfiles,
  type BrowserApp,
  type ExtensionInstance,
} from "../../shared/browser-extension";
import { runDetached } from "./detached-exec";
import { pidAlive } from "./desktop-processes";

/**
 * What Relay reads and runs to find and restart a browser: its `Local State`, `Preferences`,
 * the target of its `SingletonLock` link, the process list, and `osascript` and `open` (on Linux
 * /proc, a signal and the browser's own launcher).
 */
export interface BrowserSystem {
  /** ~/Library/Application Support; on Linux $XDG_CONFIG_HOME (~/.config). */
  support: string;
  /** The browsers' layout: macOS when unset; Linux has its own folders and fewer browsers. */
  platform?: "linux";
  /** This machine's name, which a Linux `SingletonLock` link starts with ("host-pid"). */
  hostname?: string;
  readText(file: string): string | undefined;
  exists(file: string): boolean;
  /** macOS refuses to let Relay read the file (privacy protection), as opposed to it missing. */
  denied?(file: string): boolean;
  /** The newest modification time (ms) of a folder's files; undefined when it cannot be read. */
  modifiedAt(dir: string): number | undefined;
  readLink(file: string): string | undefined;
  alive(pid: number): boolean;
  /** Every process's executable path, one per line: from `ps` on macOS, /proc on Linux. */
  processes(): Promise<string>;
  /** Asks the browser to quit as a user would; resolves once asked, not once it has quit. */
  quit(app: BrowserApp): Promise<void>;
  /** Opens the browser in the background, restoring the windows it had. */
  launch(app: BrowserApp): Promise<void>;
  /** Opens `url` in the browser, in front, in the profile folder `profile`. */
  openUrl(app: BrowserApp, url: string, profile: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Local State is a few hundred kilobytes; anything far larger is not one. */
const MAX_JSON = 16 * 1024 * 1024;

const readText = (file: string) => {
  try {
    if (fs.statSync(file).size > MAX_JSON) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const modifiedAt = (dir: string) => {
  try {
    let newest = fs.statSync(dir).mtimeMs;
    for (const name of fs.readdirSync(dir))
      newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs);
    return newest;
  } catch {
    return undefined;
  }
};
const readLink = (file: string) => {
  try {
    return fs.readlinkSync(file);
  } catch {
    return undefined;
  }
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function macBrowserSystem(home = os.homedir()): BrowserSystem {
  const processes = async () =>
    (
      await runDetached("/bin/ps", ["-axo", "comm="], {
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  return {
    support: path.join(home, "Library", "Application Support"),
    readText,
    exists: (file) => fs.existsSync(file),
    denied: (file) => {
      try {
        fs.accessSync(file, fs.constants.R_OK);
        fs.closeSync(fs.openSync(file, "r"));
        return false;
      } catch (error: any) {
        return error?.code === "EPERM" || error?.code === "EACCES";
      }
    },
    modifiedAt,
    readLink,
    alive: pidAlive,
    processes,
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
    openUrl: async (app, url, profile) => {
      const args = [`--profile-directory=${profile}`, url];
      // `open` hands arguments only to a browser it starts. A running one is reached through its
      // own executable: Chromium passes a second start's command line to the running browser,
      // which opens the page in that profile. Only HOME and PATH travel, never Relay's environment.
      // Only a browser installed in an Applications folder is run; any other goes through `open`.
      const main = `.app/Contents/MacOS/${BROWSERS[app].executable}`;
      const installed = ["/Applications/", `${path.join(home, "Applications")}/`];
      const running = (await processes())
        .split("\n")
        .map((line) => line.trim())
        .find(
          (line) =>
            installed.some((dir) => line.startsWith(dir)) &&
            path.normalize(line) === line &&
            line.endsWith(main),
        );
      if (running)
        await runDetached(running, args, {
          timeout: 15_000,
          env: { HOME: home, PATH: "/usr/bin:/bin" },
        });
      else
        await runDetached("/usr/bin/open", ["-b", BROWSERS[app].bundleId, "--args", ...args], {
          timeout: 15_000,
        });
    },
    sleep,
  };
}

// --- Linux -------------------------------------------------------------------------------------

/** One process of this user, from /proc: its executable and its command line. */
export interface LinuxProcess {
  pid: number;
  exe: string;
  args: string[];
}

/** The processes /proc lets this user see whole: other users' `exe` links cannot be read. */
function linuxProcesses(): LinuxProcess[] {
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!/^\d+$/.test(name)) return [];
    try {
      // A binary replaced by an update reads "<path> (deleted)" until the browser restarts.
      const exe = fs.readlinkSync(`/proc/${name}/exe`).replace(/ \(deleted\)$/, "");
      const args = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      return [{ pid: Number(name), exe, args }];
    } catch {
      return [];
    }
  });
}

/** A `SingletonLock` link's target, "host-pid"; undefined for anything else. */
export function lockOwner(target: string | undefined): { host: string; pid: number } | undefined {
  const match = target?.match(/^(.*)-(\d+)$/);
  const pid = Number(match?.[2]);
  return match && Number.isSafeInteger(pid) && pid > 0 ? { host: match[1], pid } : undefined;
}

/**
 * The browser's main processes, the ones to ask to quit: the one its `SingletonLock` names when
 * that is this machine's and still a browser process, else every process of its executables that
 * is not a helper (`--type=…`: renderers, zygotes, GPU). A recycled pid is never signalled: its
 * executable must be named like the browser's.
 */
export function linuxMainPids(
  app: BrowserApp,
  lockTarget: string | undefined,
  hostname: string,
  processes: LinuxProcess[],
): number[] {
  const executables = BROWSERS[app].linux?.executables ?? [];
  const names = new Set(executables.map((exe) => path.basename(exe)));
  const main = (p: LinuxProcess) => !p.args.some((arg) => arg.startsWith("--type="));
  const lock = lockOwner(lockTarget);
  if (lock && lock.host === hostname) {
    const owner = processes.find((p) => p.pid === lock.pid);
    if (owner && names.has(path.basename(owner.exe)) && main(owner)) return [owner.pid];
  }
  return processes.filter((p) => executables.includes(p.exe) && main(p)).map((p) => p.pid);
}

/** The first of `commands` that is an executable file in one of `dirs`. */
export function findCommand(
  commands: string[],
  dirs: string[],
  executable: (file: string) => boolean,
): string | undefined {
  for (const command of commands)
    for (const dir of dirs) {
      if (!path.isAbsolute(dir)) continue;
      const file = path.join(dir, command);
      if (executable(file)) return file;
    }
  return undefined;
}

/**
 * The part of Relay's environment a browser it starts gets: the graphical session (X11 or
 * Wayland, D-Bus, XDG folders, locale), never Electron's own variables or an AppImage's library
 * path, which would break the browser.
 */
export function sessionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep =
    /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|DESKTOP_SESSION|SSH_AUTH_SOCK|KDE_FULL_SESSION|KDE_SESSION_VERSION|GNOME_DESKTOP_SESSION_ID|GTK_THEME|QT_QPA_PLATFORMTHEME|XDG_[A-Z_]+|LC_[A-Z_]+)$/;
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => keep.test(key) && value !== undefined),
  );
}

/**
 * Linux: browsers under $XDG_CONFIG_HOME, found running through their `SingletonLock` or /proc,
 * quit with SIGTERM to the main process, started through their launcher on PATH.
 *
 * SIGTERM is what the desktop sends at logout: Chromium saves the session and closes, but there
 * is no quit that a "leave this page" or "downloads in progress" prompt can hold up as on macOS.
 * So the prompt may not be shown and the browser may close anyway; the default mode ("guide")
 * and "closed" never quit it.
 */
export function linuxBrowserSystem(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): BrowserSystem {
  const xdg = env.XDG_CONFIG_HOME;
  const support = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  const hostname = os.hostname();
  const command = (app: BrowserApp) => {
    const dirs = [...(env.PATH ?? "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"];
    return findCommand(BROWSERS[app].linux?.commands ?? [], dirs, (file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  };
  // The browser outlives Relay: its own process group, no pipes, not waited for. A second start
  // of a running browser hands its command line to the running one and exits.
  const start = (app: BrowserApp, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const file = command(app);
      if (!file) return reject(new Error(`${BROWSERS[app].name} was not found on PATH.`));
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        env: sessionEnvironment({ ...env, HOME: home }),
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  const system: BrowserSystem = {
    support,
    platform: "linux",
    hostname,
    readText,
    exists: (file) => fs.existsSync(file),
    modifiedAt,
    readLink,
    alive: pidAlive,
    processes: async () =>
      linuxProcesses()
        .map((p) => p.exe)
        .join("\n"),
    quit: async (app) => {
      const pids = linuxMainPids(
        app,
        readLink(path.join(dataDir(system, app), "SingletonLock")),
        hostname,
        linuxProcesses(),
      );
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Gone already: the wait decides.
        }
      }
    },
    // The flag restores the last session whatever the browser's own startup setting says.
    launch: (app) => start(app, ["--restore-last-session"]),
    openUrl: (app, url, profile) => start(app, [`--profile-directory=${profile}`, url]),
    sleep,
  };
  return system;
}

/** The browser adapter of this platform; undefined where Relay has none (Windows). */
export function platformBrowserSystem(
  platform = process.platform,
): BrowserSystem | undefined {
  if (platform === "darwin") return macBrowserSystem();
  if (platform === "linux") return linuxBrowserSystem();
  return undefined;
}

export const dataDir = (system: BrowserSystem, app: BrowserApp) =>
  path.join(
    system.support,
    (system.platform === "linux" ? BROWSERS[app].linux?.dataDir : undefined) ??
      BROWSERS[app].dataDir,
  );

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
  return browserApps(system.platform).flatMap((app) => {
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
 * Browsers whose data folder is there but macOS does not let Relay read: their extension cannot be
 * found until Relay has Full Disk Access.
 */
export function deniedBrowsers(system: BrowserSystem): BrowserApp[] {
  return browserApps(system.platform).filter(
    (app) =>
      system.exists(dataDir(system, app)) &&
      !!system.denied?.(path.join(dataDir(system, app), "Local State")),
  );
}

/**
 * Whether the browser runs: the process its `SingletonLock` link names ("host-pid") is alive,
 * or its main executable is in the process list. Either one counts: a stale link is not
 * running, and a browser started with another user data dir still holds its own profiles.
 * On Linux a link made on another machine (a shared home) counts as running: the browser there
 * holds the profile, and Chromium itself refuses it.
 */
export async function browserRunning(
  system: BrowserSystem,
  app: BrowserApp,
): Promise<boolean> {
  const lock = lockOwner(system.readLink(path.join(dataDir(system, app), "SingletonLock")));
  if (lock && system.hostname !== undefined && lock.host !== system.hostname) return true;
  if (lock && system.alive(lock.pid)) return true;
  const lines = (await system.processes()).split("\n").map((line) => line.trim());
  if (system.platform === "linux") {
    const executables = BROWSERS[app].linux?.executables ?? [];
    return lines.some((line) => executables.includes(line));
  }
  const main = `.app/Contents/MacOS/${BROWSERS[app].executable}`;
  return lines.some((line) => line.endsWith(main));
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
