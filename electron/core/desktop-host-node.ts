import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { runDetached } from "./detached-exec";
import type { DesktopHost, LaunchOptions } from "./desktop";
import {
  assertProcessListing,
  ClaudeLiveness,
  parseEtime,
  pidAlive,
  retryOnce,
} from "./desktop-processes";
import {
  linuxInstances,
  linuxProcessRows,
  macInstances,
  processRows,
  type ClaudeInstances,
} from "./desktop-instances";
import type { Sealer } from "./vault-crypto";
import { claudeLog, claudeSignOuts, claudeSignedOut, watchClaudeLaunch } from "./desktop-launch";
const execFileAsync = promisify(execFile);
/** On macOS every command runs out of the terminal's process group; see runDetached. */
const exec = (
  file: string,
  args: string[],
  options: {
    timeout: number;
    maxBuffer?: number;
    windowsHide?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string }> =>
  process.platform === "win32"
    ? execFileAsync(file, args, { ...options, encoding: "utf8" })
    : runDetached(file, args, options);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * The environment `open` gets when it starts Claude on macOS: none, so Launch Services gives
 * Claude the user's standard one (HOME, PATH, TMPDIR…) and nothing of Relay's own.
 */
export const CLEAN_LAUNCH_ENV: NodeJS.ProcessEnv = Object.freeze({});
/**
 * The environment Claude gets when Relay starts it on Linux: the session's own (display,
 * D-Bus, XDG folders, locale, PATH…) without what is Relay's or a Claude Code session's that
 * started Relay (CLAUDECODE, its session id and account, ELECTRON_RUN_AS_NODE…), as a start
 * from the desktop gives it. Electron moves the desktop's name aside for Relay's tray icon
 * (ORIGINAL_XDG_CURRENT_DESKTOP); Claude gets the real one back.
 */
export function linuxLaunchEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (
      value !== undefined &&
      !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|ELECTRON_|RELAY_|NODE_OPTIONS$|NODE_PATH$|CHROME_DESKTOP$|ORIGINAL_XDG_CURRENT_DESKTOP$|APPIMAGE$|APPDIR$|ARGV0$|OWD$)/.test(
        key,
      )
    )
      env[key] = value;
  if (source.ORIGINAL_XDG_CURRENT_DESKTOP)
    env.XDG_CURRENT_DESKTOP = source.ORIGINAL_XDG_CURRENT_DESKTOP;
  return env;
}
/** Claude's command-line switches for a launch, Chromium's own: no HTTP/3. */
export function launchArgs(options?: LaunchOptions): string[] {
  // Never a debugging or network-override switch such as --log-net-log: Claude (3.6556 and
  // later) refuses to start with one on its command line.
  return options?.quicOff ? ["--disable-quic"] : [];
}
/**
 * Asks the macOS app with `pid` to quit as its Quit menu item would (so Claude still asks about
 * work left running), or brings it forward. Prints "gone" when no app has that pid.
 */
export function appScript(action: "terminate" | "activate", pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid process id.");
  const call =
    action === "terminate" ? "app.terminate" : "app.activateWithOptions($.NSApplicationActivateAllWindows)";
  return `ObjC.import("AppKit"); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); app.isNil() ? "gone" : String(${call})`;
}
/** `open`'s arguments for a Claude: a new app when `fresh`, with `args` as its switches. */
export function openArgs(bundle: string, args: string[], fresh: boolean): string[] {
  return [...(fresh ? ["-n"] : []), "-a", bundle, ...(args.length ? ["--args", ...args] : [])];
}
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
 * Where Claude Desktop is usually installed, in the order tried. On Linux: the official package's
 * launcher (/usr/bin/claude-desktop, linked into /usr/lib/claude-desktop), the community
 * packages' places and a Claude AppImage in ~/Applications.
 */
export function claudeCandidates(
  platform: NodeJS.Platform = process.platform,
  options: { apps?: string[]; home?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  // The paths of the platform asked about, also when another one asks (as tests do).
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin")
    return (options.apps ?? CLAUDE_APPS).map((app) =>
      p.join(app, "Contents", "MacOS", "Claude"),
    );
  if (platform === "win32")
    return [
      p.join(env.LOCALAPPDATA ?? "", "AnthropicClaude/claude.exe"),
      p.join(env.LOCALAPPDATA ?? "", "Programs/Claude/Claude.exe"),
    ];
  if (platform !== "linux") return [];
  const appImages = (() => {
    try {
      return fs
        .readdirSync(p.join(home, "Applications"))
        .filter((f) => /claude.*\.appimage$/i.test(f))
        .map((f) => p.join(home, "Applications", f));
    } catch {
      return [];
    }
  })();
  return [
    "/usr/bin/claude-desktop",
    "/usr/local/bin/claude-desktop",
    p.join(home, ".local", "bin", "claude-desktop"),
    "/opt/Claude/claude-desktop",
    "/opt/Claude/claude",
    "/usr/lib/claude-desktop/claude-desktop",
    ...appImages,
  ];
}

/**
 * The executable to run: the one the user chose (a Claude.app on macOS is opened to its
 * executable), else the first default that exists.
 */
export function resolveClaudeExecutable(
  chosen: string | undefined,
  candidates: string[],
  exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
  if (chosen && path.isAbsolute(chosen)) {
    // An .app bundle exists only on macOS, so its executable is joined the macOS way.
    const file = chosen.endsWith(".app")
      ? path.posix.join(chosen, "Contents", "MacOS", "Claude")
      : chosen;
    if (exists(file)) return file;
  }
  return candidates.find((p) => path.isAbsolute(p) && exists(p));
}

/**
 * The Electron version of a Linux Claude: the `version` file Electron ships beside its
 * executable, found through the launcher's link (/usr/bin/claude-desktop leads into
 * /usr/lib/claude-desktop), else in the official package's folder. Undefined when none reads
 * as a version.
 */
export function linuxElectronVersion(
  executable: string,
  files: { realpath(p: string): string; read(p: string): string } = {
    realpath: (p) => fs.realpathSync(p),
    read: (p) => fs.readFileSync(p, "utf8"),
  },
): string | undefined {
  const dirs = new Set<string>();
  try {
    dirs.add(path.posix.dirname(files.realpath(executable)));
  } catch {
    // A launcher that is gone: the other places may still tell.
  }
  dirs.add(path.posix.dirname(executable));
  dirs.add("/usr/lib/claude-desktop");
  for (const dir of dirs)
    try {
      const version = files.read(path.posix.join(dir, "version")).trim();
      if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) return version;
    } catch {
      // No version file here.
    }
  return undefined;
}

/**
 * Claude Desktop as a plain Node process sees it: its processes, quitting and launching it,
 * and the vault's seal. Draft capture needs Relay's own Electron and is not here.
 */
export function nodeDesktopHost(options: {
  sealer: Sealer;
  apps?: string[];
  /** The location the user chose in Settings, read on every use so a new choice applies at once. */
  chosen?: () => string | undefined;
}): DesktopHost {
  const candidates = claudeCandidates(process.platform, { apps: options.apps });
  const exe = () => resolveClaudeExecutable(options.chosen?.(), candidates);
  /** Every process's pid, parent, executable and command line. macOS only. */
  const macListing = () =>
    // A busy main process can cut ps short (its timeout fires before the output is read), so
    // an empty listing is a failure, not "closed"; one retry rides out such a moment.
    retryOnce(async () => {
      const [commands, arguments_] = await Promise.all([
        exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
        exec("/bin/ps", ["-axo", "pid=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
      ]);
      assertProcessListing(commands.stdout);
      assertProcessListing(arguments_.stdout);
      return processRows(commands.stdout, arguments_.stdout);
    }, 250);
  /** Every process's pid, parent and command line. Linux only. */
  const linuxListing = () =>
    retryOnce(async () => {
      const { stdout } = await exec("/bin/ps", ["-eo", "pid=,ppid=,args="], {
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assertProcessListing(stdout);
      return linuxProcessRows(stdout);
    }, 250);
  /** The main Claude and its windows, from one full listing. macOS and Linux only. */
  const instances = async (): Promise<ClaudeInstances> => {
    const executable = exe();
    if (!executable) return { main: [], mainApps: [], windows: [] };
    return process.platform === "linux"
      ? linuxInstances(await linuxListing(), executable)
      : macInstances(await macListing(), executable);
  };
  const bundleOf = (executable: string) => executable.slice(0, executable.indexOf(".app/") + 4);
  const app = (action: "terminate" | "activate", pid: number) =>
    exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", appScript(action, pid)], {
      timeout: 10_000,
    });
  /**
   * The main Claude's pids, and its main pid on macOS, from one full listing. A window (a Claude
   * with its own data folder) is never part of it.
   */
  let seenWindows = 0;
  const listClaude = async (): Promise<{ pids: number[]; main?: number }> => {
    const executable = exe();
    if (!executable) return { pids: [] };
    if (process.platform === "linux") {
      const claude = linuxInstances(await linuxListing(), executable);
      seenWindows = claude.windows.length;
      return { pids: claude.main, main: claude.mainPid };
    }
    if (process.platform === "darwin") {
      const claude = macInstances(await macListing(), executable);
      seenWindows = claude.windows.length;
      return { pids: claude.main, main: claude.mainPid };
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
  /**
   * Starts `executable` on its own, outside Relay's process group. On Linux it gets the
   * session's environment (linuxLaunchEnv) and the home folder, as a start from the desktop does.
   */
  const spawnDetached = (executable: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        ...(process.platform === "linux"
          ? { env: linuxLaunchEnv(process.env), cwd: os.homedir() }
          : {}),
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  /** The Electron version inside Claude.app, or undefined when it cannot be read. macOS only. */
  const readClaudeElectron = async (): Promise<string | undefined> => {
    const executable = exe();
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
    available: async () => !!exe(),
    running: () => liveness.running(),
    seemsRunning: () => liveness.seemsRunning(),
    quit: async (answerGuard) => {
      const active = await pids();
      if (!active.length) return;
      if (process.platform === "darwin")
        try {
          // By bundle id, AppleScript could reach a window instead; then each main app by pid.
          const { windows, mainApps } = await instances();
          if (windows.length) for (const pid of mainApps) await app("terminate", pid);
          else
            await exec(
              "/usr/bin/osascript",
              [
                "-e",
                'tell application id "com.anthropic.claudefordesktop" to quit',
              ],
              { timeout: 20_000 },
            );
        } catch (error) {
          // Claude answers "canceled" while it asks the user about work left running; the
          // looks below decide whether it closed.
          if (!(await pids()).length) return;
          if (!answerGuard) throw error;
        }
      else if (process.platform === "linux") {
        // Electron quits on SIGTERM as from its menu, its helpers with it: only the main Claude's
        // own process is asked, never a window's. Leftovers without one are asked themselves.
        const { mainApps } = await instances();
        for (const pid of mainApps.length ? mainApps : active) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
      } else {
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
        // Still open after 2 s, and again 3 s later: Claude may be asking before it quits.
        if (answerGuard && (i === 8 || i === 20))
          try {
            await answerGuard();
          } catch {
            // Unanswered: the quit fails below as it would without an answer.
          }
        await delay(250);
      }
      throw new Error(
        "Claude Desktop did not close. Finish running work and quit Claude, then try again. No files changed.",
      );
    },
    launch: async (launchOptions) => {
      const executable = exe();
      if (!executable) throw new Error("Claude Desktop is not installed.");
      const args = launchArgs(launchOptions);
      if (process.platform === "darwin") {
        // While a window runs, `open -a` could only bring that one forward: the main Claude
        // comes forward by pid when it runs, and otherwise starts as a new app.
        const { windows, mainPid } = await instances();
        if (windows.length && mainPid !== undefined) {
          await app("activate", mainPid);
          return;
        }
        await exec(
          "/usr/bin/open",
          openArgs(bundleOf(executable), args, windows.length > 0),
          // `open` hands its own environment to the app it starts. Relay's may come from
          // whatever started Relay, such as a Claude Code session (CLAUDECODE, its session
          // id, socket and account); with none, Claude gets what a Dock launch gives it.
          { timeout: 10_000, env: CLEAN_LAUNCH_ENV },
        );
      } else await spawnDetached(executable, args);
    },
    // Claude's log is only known on macOS and Linux.
    watchLaunch: async () => {
      const log = claudeLog(os.homedir());
      return log ? watchClaudeLaunch(log, () => liveness.running()) : undefined;
    },
    signedOut: async () => {
      const log = claudeLog(os.homedir());
      return log ? claudeSignedOut(log) : undefined;
    },
    signOuts: async () => {
      const log = claudeLog(os.homedir());
      return log ? claudeSignOuts(log) : [];
    },
    seal: (text) => options.sealer.seal(text),
    unseal: (data) => options.sealer.unseal(data),
    claudeElectron: async () => {
      if (process.platform === "darwin") return readClaudeElectron();
      const executable = exe();
      return process.platform === "linux" && executable
        ? linuxElectronVersion(executable)
        : undefined;
    },
    windows: async () =>
      process.platform === "darwin" || process.platform === "linux"
        ? (await instances()).windows
        : [],
    launchWindow: async (dir, launchOptions) => {
      const executable = exe();
      if (process.platform !== "darwin" && process.platform !== "linux")
        throw new Error("Separate Claude windows need macOS or Linux.");
      if (!executable) throw new Error("Claude Desktop is not installed.");
      const args = [`--user-data-dir=${dir}`, ...launchArgs(launchOptions)];
      if (process.platform === "linux") await spawnDetached(executable, args);
      else
        await exec("/usr/bin/open", openArgs(bundleOf(executable), args, true), {
          timeout: 10_000,
          env: CLEAN_LAUNCH_ENV,
        });
    },
    quitWindow: async (pid) => {
      if (process.platform !== "linux") {
        await app("terminate", pid);
        return;
      }
      // Only a window's own main process, seen in a fresh listing: never a reused pid.
      if (!(await instances()).windows.some((window) => window.pid === pid)) return;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    },
    activateWindow: async (pid) => {
      if (process.platform !== "linux") {
        await app("activate", pid);
        return;
      }
      // Started again on its folder, Claude hands over to the one running there, which brings
      // its window forward.
      const executable = exe();
      const window = (await instances()).windows.find((w) => w.pid === pid);
      if (executable && window) await spawnDetached(executable, [`--user-data-dir=${window.dir}`]);
    },
    windowsSeen: () => seenWindows,
    automationTarget: async () => {
      if (process.platform !== "darwin") return undefined;
      const { windows, mainPid } = await instances();
      return windows.length ? (mainPid ?? null) : undefined;
    },
    claudeUptimeMs: async () => {
      const executable = exe();
      if ((process.platform !== "darwin" && process.platform !== "linux") || !executable)
        return undefined;
      try {
        const main = (await instances()).mainPid;
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
