import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopHost } from "./desktop";
import {
  assertProcessListing,
  ClaudeLiveness,
  macDesktopPids,
  macMainPid,
  parseEtime,
  pidAlive,
  retryOnce,
} from "./desktop-processes";
import type { Sealer } from "./vault-crypto";
const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The default Claude.app bundles, first found wins. */
export const CLAUDE_APPS = [
  "/Applications/Claude.app",
  path.join(os.homedir(), "Applications", "Claude.app"),
];
/** The executable of the first of `apps` (Claude.app bundles) that has one. */
export function claudeExecutable(apps: string[]): string | undefined {
  return apps
    .filter((app) => path.isAbsolute(app))
    .map((app) => path.join(app, "Contents", "MacOS", "Claude"))
    .find((p) => fs.existsSync(p));
}
/**
 * Claude Desktop as a plain Node process sees it: its processes, quitting and launching it,
 * and the vault's seal. Draft capture needs Relay's own Electron and is not here.
 */
export function nodeDesktopHost(options: {
  sealer: Sealer;
  apps?: string[];
}): DesktopHost {
  const candidates =
    process.platform === "darwin"
      ? (options.apps ?? CLAUDE_APPS).map((app) =>
          path.join(app, "Contents", "MacOS", "Claude"),
        )
      : process.platform === "win32"
        ? [
            path.join(
              process.env.LOCALAPPDATA ?? "",
              "AnthropicClaude/claude.exe",
            ),
            path.join(
              process.env.LOCALAPPDATA ?? "",
              "Programs/Claude/Claude.exe",
            ),
          ]
        : [];
  const executable = candidates.find(
    (p) => path.isAbsolute(p) && fs.existsSync(p),
  );
  /** Every process's pid and executable. macOS only. */
  const macListing = () =>
    // A busy main process can cut ps short (its timeout fires before the output is read), so
    // an empty listing is a failure, not "closed"; one retry rides out such a moment.
    retryOnce(async () => {
      const { stdout } = await exec("/bin/ps", ["-axo", "pid=,comm="], {
        timeout: 5000,
      });
      assertProcessListing(stdout);
      return stdout;
    }, 250);
  /** Claude's pids, and its main pid on macOS, from one full listing. */
  const listClaude = async (): Promise<{ pids: number[]; main?: number }> => {
    if (!executable) return { pids: [] };
    if (process.platform === "darwin") {
      const listing = await macListing();
      return {
        pids: macDesktopPids(listing, executable),
        main: macMainPid(listing, executable),
      };
    }
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name Claude -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress",
      ],
      { timeout: 5000, windowsHide: true },
    );
    if (!stdout.trim()) return { pids: [] };
    const result = JSON.parse(stdout);
    return {
      pids: (Array.isArray(result) ? result : [result])
        .filter(
          (p) =>
            typeof p.Path === "string" &&
            p.Path.toLowerCase() === executable.toLowerCase(),
        )
        .map((p) => Number(p.Id))
        .filter(Number.isSafeInteger),
    };
  };
  // Every full listing goes through it, so the tray's check can skip most of them.
  const liveness = new ClaudeLiveness({
    list: listClaude,
    alive: pidAlive,
    now: Date.now,
  });
  const pids = () => liveness.pids();
  /** The Electron version inside Claude.app, or undefined when it cannot be read. macOS only. */
  const readClaudeElectron = async (): Promise<string | undefined> => {
    if (!executable) return undefined;
    const bundle = executable.slice(0, executable.indexOf(".app/") + 4);
    try {
      const { stdout } = await exec(
        "/usr/bin/plutil",
        [
          "-extract",
          "CFBundleVersion",
          "raw",
          path.join(
            bundle,
            "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist",
          ),
        ],
        { timeout: 5000 },
      );
      return stdout.trim();
    } catch {
      return undefined;
    }
  };
  return {
    available: async () => !!executable,
    running: () => liveness.running(),
    seemsRunning: () => liveness.seemsRunning(),
    quit: async () => {
      const active = await pids();
      if (!active.length) return;
      if (process.platform === "darwin")
        await exec(
          "/usr/bin/osascript",
          [
            "-e",
            'tell application id "com.anthropic.claudefordesktop" to quit',
          ],
          { timeout: 20_000 },
        );
      else {
        try {
          await exec(
            "taskkill.exe",
            active.flatMap((pid) => ["/PID", String(pid)]),
            { timeout: 20_000, windowsHide: true },
          );
        } catch (error) {
          if ((await pids()).length) throw error;
        }
      }
      for (let i = 0; i < 40; i++) {
        if (!(await pids()).length) return;
        await delay(250);
      }
      throw new Error(
        "Claude Desktop did not close. Finish running work and quit Claude, then try again. No files changed.",
      );
    },
    launch: async () => {
      if (!executable) throw new Error("Claude Desktop is not installed.");
      if (process.platform === "darwin")
        await exec(
          "/usr/bin/open",
          ["-a", executable.slice(0, executable.indexOf(".app/") + 4)],
          { timeout: 10_000 },
        );
      else
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, [], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
    },
    seal: (text) => options.sealer.seal(text),
    unseal: (data) => options.sealer.unseal(data),
    claudeElectron: async () =>
      process.platform === "darwin" ? readClaudeElectron() : undefined,
    claudeUptimeMs: async () => {
      if (process.platform !== "darwin" || !executable) return undefined;
      try {
        const main = macMainPid(await macListing(), executable);
        if (main === undefined) return undefined;
        const { stdout } = await exec(
          "/bin/ps",
          ["-o", "etime=", "-p", String(main)],
          { timeout: 5000 },
        );
        return parseEtime(stdout);
      } catch {
        // Gone between the two reads, or ps failed: the uptime is unknown.
        return undefined;
      }
    },
  };
}
