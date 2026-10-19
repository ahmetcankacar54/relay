import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_APPS,
  BROWSERS,
  CLAUDE_EXTENSION_ID,
  lastActiveProfiles,
  localStateProfiles,
  openArgs,
  type AccountBrowser,
  type BrowserApp,
  type BrowserOpenResult,
  type InstalledBrowser,
} from "../../shared/browser-profiles";
import { runDetached } from "./detached-exec";
import { pidAlive } from "./desktop-processes";

/**
 * What Relay reads and runs to open a browser profile. It reads a browser's `Local State`, the
 * target of its `SingletonLock` link, and whether the Claude extension's folder exists; never the
 * extension's storage, cookies or any sign-in.
 */
export interface BrowserSystem {
  /** ~/Library/Application Support */
  support: string;
  readText(file: string): string | undefined;
  exists(file: string): boolean;
  readLink(file: string): string | undefined;
  alive(pid: number): boolean;
  /** Runs /usr/bin/open with these arguments. */
  open(args: string[]): Promise<void>;
}

/** Local State is a few hundred kilobytes; anything far larger is not one. */
const MAX_LOCAL_STATE = 16 * 1024 * 1024;

export function macBrowserSystem(home = os.homedir()): BrowserSystem {
  return {
    support: path.join(home, "Library", "Application Support"),
    readText: (file) => {
      try {
        if (fs.statSync(file).size > MAX_LOCAL_STATE) return undefined;
        return fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    exists: (file) => fs.existsSync(file),
    readLink: (file) => {
      try {
        return fs.readlinkSync(file);
      } catch {
        return undefined;
      }
    },
    alive: pidAlive,
    open: async (args) => {
      await runDetached("/usr/bin/open", args, { timeout: 15_000 });
    },
  };
}

const dataDir = (system: BrowserSystem, app: BrowserApp) =>
  path.join(system.support, BROWSERS[app].dataDir);

function localState(system: BrowserSystem, app: BrowserApp): unknown {
  const text = system.readText(path.join(dataDir(system, app), "Local State"));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Each browser with a `Local State`, and its profiles. */
export function installedBrowsers(system: BrowserSystem): InstalledBrowser[] {
  return BROWSER_APPS.flatMap((app) => {
    const state = localState(system, app);
    if (state === undefined) return [];
    return [
      {
        app,
        profiles: localStateProfiles(state).map((p) => ({
          ...p,
          extension: system.exists(
            path.join(
              dataDir(system, app),
              p.profile,
              "Extensions",
              CLAUDE_EXTENSION_ID,
            ),
          ),
        })),
      },
    ];
  });
}

/** Whether the browser runs: the process its `SingletonLock` link names ("host-pid") is alive. */
export function browserRunning(
  system: BrowserSystem,
  app: BrowserApp,
): boolean {
  const target = system.readLink(
    path.join(dataDir(system, app), "SingletonLock"),
  );
  const pid = Number(target?.match(/-(\d+)$/)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 && system.alive(pid);
}

/**
 * Opens an account's profile unless it already has a window: the browser runs and lists it as
 * active. Never quits, restarts or brings the browser forward, and never throws: a failure here
 * must not change how a switch ends.
 */
export async function openBrowserProfile(
  system: BrowserSystem,
  choice: AccountBrowser,
): Promise<BrowserOpenResult> {
  try {
    const state = localState(system, choice.app);
    if (!localStateProfiles(state).some((p) => p.profile === choice.profile))
      return "missing";
    if (
      browserRunning(system, choice.app) &&
      lastActiveProfiles(state).includes(choice.profile)
    )
      return "open";
    await system.open(openArgs(choice.app, choice.profile));
    return "opened";
  } catch {
    return "failed";
  }
}
