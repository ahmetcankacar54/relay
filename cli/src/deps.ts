import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { macBrowserSystem, type BrowserSystem } from "../../electron/core/browser-system";
import { levelExtensionStorage, type ExtensionStorage } from "../../electron/core/extension-storage";
import type { DesktopHost } from "../../electron/core/desktop";
import { nodeDesktopHost } from "../../electron/core/desktop-host-node";
import { resolveExecutable } from "../../electron/core/environment";
import { requestUsageJson } from "../../electron/core/usage";
import type { Sealer } from "../../electron/core/vault-crypto";

const exec = promisify(execFile);

/** What the CLI reaches outside its own process; tests replace each part. */
export interface CliDeps {
  host(sealer: Sealer, apps: string[]): DesktopHost;
  securityTool: string;
  request: typeof requestUsageJson;
  /** The Claude Code CLI, `explicit` first. */
  claude(explicit?: string): string | undefined;
  spawn: typeof spawn;
  /** `ps -axo pid=,ppid=,comm=`. */
  processList(): Promise<string>;
  /** The installed Relay.app's version, or undefined when none is installed. */
  relayAppVersion(): Promise<string | undefined>;
  /** Whether this runs in a logged-in macOS desktop session, not over SSH. */
  guiSession(): boolean;
  /** The bundle the detached worker runs. */
  selfPath: string;
  /** Claude Code's transcripts, for the history summary. */
  transcriptRoot: string;
  /** The browsers and the Claude extension's storage; undefined when a switch leaves the extension alone. */
  extension?: { system: BrowserSystem; storage: ExtensionStorage };
  platform: NodeJS.Platform;
}

export const RELAY_APPS = [
  "/Applications/Relay.app",
  path.join(os.homedir(), "Applications", "Relay.app"),
];

async function readAppVersion(apps: string[]): Promise<string | undefined> {
  for (const app of apps) {
    try {
      const { stdout } = await exec(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", path.join(app, "Contents", "Info.plist")],
        { timeout: 5000 },
      );
      const version = stdout.trim();
      if (/^\d+\.\d+\.\d+/.test(version)) return version;
    } catch {
      // Not installed there.
    }
  }
  return undefined;
}

export function defaultDeps(): CliDeps {
  return {
    host: (sealer, apps) => nodeDesktopHost({ sealer, apps }),
    securityTool: "/usr/bin/security",
    request: requestUsageJson,
    claude: (explicit) => resolveExecutable(explicit),
    spawn,
    processList: async () =>
      (
        await exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
          timeout: 5000,
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout,
    relayAppVersion: () => readAppVersion(RELAY_APPS),
    guiSession: () => {
      try {
        return (
          execFileSync("/bin/launchctl", ["managername"], {
            encoding: "utf8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "ignore"],
          }).trim() === "Aqua"
        );
      } catch {
        // Unknown: let Claude's own quit say so.
        return true;
      }
    },
    selfPath: process.argv[1] ?? "",
    transcriptRoot: path.join(os.homedir(), ".claude"),
    extension:
      process.platform === "darwin"
        ? { system: macBrowserSystem(), storage: levelExtensionStorage }
        : undefined,
    platform: process.platform,
  };
}
