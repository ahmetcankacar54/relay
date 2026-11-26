import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { RELAY_CLI_PACKAGE } from "../../shared/cli-package";

/**
 * Where the relay CLI is installed, for the command Relay.app writes into Claude Code's status
 * line. A Mac app started from the Dock gets a bare PATH, so as for `claude` (resolveExecutable)
 * the usual install folders are searched too: npm's global folder, Homebrew, Volta, pnpm and every
 * nvm version. Only then is the user's login shell asked, with a deadline.
 */

/** The longest the login shell may take to answer; the Settings row waits for it. */
export const LOGIN_SHELL_LOOKUP_MS = 2_000;

/** The package's launcher, relative to its folder: `launcher.js` (0.2.0 on), `dist/relay.js` before. */
const LAUNCHERS = ["launcher.js", "dist/relay.js"].map(
  (file) => `${RELAY_CLI_PACKAGE}/${file}`,
);

/** Whether `file` is this package's relay: its launcher, or npm's shim pointing at it. */
export function isRelayCli(file: string): boolean {
  try {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    const real = fs.realpathSync(file).split(path.sep).join("/");
    if (LAUNCHERS.some((launcher) => real.endsWith(`/${launcher}`)))
      return true;
    // npm's Windows shims are scripts that name the package's launcher.
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(4096);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      const text = head.subarray(0, read).toString("utf8").replace(/\\/g, "/");
      return LAUNCHERS.some((launcher) => text.includes(launcher));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * The prebuilt binary npm installed for the 0.2.0 launcher (`launcher.js` runs it), when it is
 * found beside the package: nested in its node_modules or hoisted next to it. Claude Code runs
 * the status line command often, so it gets the binary and no Node start. Otherwise `file`.
 * Never on Windows, where `file` is npm's shim, the command Git Bash (Claude Code's shell) runs.
 */
export function relayCliBinary(
  file: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "win32") return file;
  try {
    const real = fs.realpathSync(file);
    if (!real.split(path.sep).join("/").endsWith(`/${LAUNCHERS[0]}`))
      return file;
    const scoped = `${RELAY_CLI_PACKAGE}-${platform}-${arch}`.split("/");
    const pkg = path.dirname(real);
    for (const dir of [
      path.join(pkg, "node_modules", ...scoped),
      path.join(pkg, "..", "..", ...scoped),
    ]) {
      const binary = path.join(dir, "bin", "relay");
      try {
        if (!fs.statSync(binary).isFile()) continue;
        fs.accessSync(binary, fs.constants.X_OK);
        return binary;
      } catch {
        // Not here: the next place, else the launcher.
      }
    }
  } catch {
    // Unreadable: the launcher still works.
  }
  return file;
}

/** Every nvm-installed Node's bin folder, newest version first. */
function nvmBins(home: string): string[] {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(root)
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map((version) => path.join(root, version, "bin"));
  } catch {
    return [];
  }
}

/** Homebrew's and the system's bin folders, where a Homebrew Node puts npm's global commands. */
export const SYSTEM_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** The files `relay` may be, in order: PATH first, then the usual install folders. */
export function relayCliCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  systemDirs = SYSTEM_BIN_DIRS,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(p.delimiter).filter(Boolean),
    ...(platform === "win32"
      ? [p.join(env.APPDATA ?? p.join(home, "AppData", "Roaming"), "npm")]
      : [
          p.join(home, ".local", "bin"),
          p.join(home, ".npm-global", "bin"),
          p.join(home, ".volta", "bin"),
          platform === "darwin"
            ? p.join(home, "Library", "pnpm")
            : p.join(home, ".local", "share", "pnpm"),
          ...systemDirs,
          ...nvmBins(home),
        ]),
  ];
  // npm's Windows folder has an extensionless sh shim too: the one Git Bash, Claude Code's shell, runs.
  return [...new Set(dirs.map((dir) => p.join(dir, "relay")))];
}

/** `relay` as the user's login shell finds it, or undefined after `timeoutMs`; never on Windows. */
export function loginShellRelay(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LOGIN_SHELL_LOOKUP_MS,
): Promise<string | undefined> {
  const shell = env.SHELL;
  if (process.platform === "win32" || !shell || !path.isAbsolute(shell))
    return Promise.resolve(undefined);
  // The interactive login shell reads the same files a terminal does (nvm lives in .zshrc); a
  // marker keeps whatever those files print apart from the answer.
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", "printf '\\n__RELAY__%s\\n' \"$(command -v relay)\""],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env: { ...env, TERM: "dumb" },
      },
      (_error, stdout) => {
        const match = /__RELAY__(.*)/.exec(String(stdout ?? ""));
        const file = match?.[1]?.trim();
        resolve(file && path.isAbsolute(file) ? file : undefined);
      },
    );
  });
}

/**
 * The installed relay CLI, or undefined when it is not installed (or another program is called
 * `relay`). `loginShell` is asked only when no usual folder has it.
 */
export async function findRelayCli(
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
    /** SYSTEM_BIN_DIRS unless given (tests give none). */
    systemDirs?: string[];
    loginShell?: () => Promise<string | undefined>;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const found = relayCliCandidates(
    env,
    options.home,
    options.platform,
    options.systemDirs,
  ).find(isRelayCli);
  const platform = options.platform ?? process.platform;
  if (found) return relayCliBinary(found, platform);
  const shell = await (options.loginShell ?? (() => loginShellRelay(env)))();
  return shell && isRelayCli(shell)
    ? relayCliBinary(shell, platform)
    : undefined;
}
