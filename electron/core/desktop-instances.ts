import path from "node:path";

/** One process in a `ps` census: its executable (`comm`) and its whole command line (`args`). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  executable: string;
  args: string;
}

/** A Claude started with its own data folder (`--user-data-dir`), next to the main one. */
export interface ClaudeWindowProcess {
  /** Its data folder, resolved. */
  dir: string;
  /** Its main process. */
  pid: number;
  /** Its main process and every helper under it. */
  pids: number[];
}

export interface ClaudeInstances {
  /** The main Claude's processes: those of the app started without `--user-data-dir`. */
  main: number[];
  /** The main Claude's own process; undefined when there is none, or more than one. */
  mainPid?: number;
  /** Every app process started without `--user-data-dir`: normally one, the main Claude. */
  mainApps: number[];
  windows: ClaudeWindowProcess[];
}

const SWITCH = " --user-data-dir=";

/**
 * The data folder in a command line's `--user-data-dir=` switch, up to the next switch; undefined
 * without one. Chromium gives every helper the switch too, with the default folder for the main
 * Claude's helpers, so only an app's own main process tells main from window.
 */
export function userDataDir(args: string): string | undefined {
  const at = args.indexOf(SWITCH);
  if (at < 0) return undefined;
  const rest = args.slice(at + SWITCH.length);
  const end = rest.indexOf(" --");
  const dir = (end < 0 ? rest : rest.slice(0, end)).trim();
  return dir ? path.resolve(dir) : undefined;
}

/**
 * `ps -axo pid=,ppid=,comm=` and `ps -axo pid=,args=` as rows; lines that are neither are
 * skipped. A process missing from the second listing has empty args.
 */
export function processRows(commands: string, arguments_: string): ProcessRow[] {
  const args = new Map<number, string>();
  for (const line of arguments_.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) args.set(Number(match[1]), match[2]);
  }
  return commands.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    return [{ pid, ppid: Number(match[2]), executable: match[3], args: args.get(pid) ?? "" }];
  });
}

/**
 * Claude Desktop's processes on macOS, split by app (see splitInstances): every process inside
 * the bundle, the app's main process being the bundle's executable. Chrome's native messaging
 * host can outlive Claude and is never counted.
 */
export function macInstances(rows: ProcessRow[], executable: string): ClaudeInstances {
  const marker = executable.indexOf(".app/");
  if (marker < 0) return { main: [], mainApps: [], windows: [] };
  const bundle = executable.slice(0, marker + 5);
  const browserHost = `${bundle}Contents/Helpers/chrome-native-host`;
  const ours = rows.filter(
    (row) =>
      row.executable !== browserHost &&
      (row.executable === executable || row.executable.startsWith(bundle)),
  );
  return splitInstances(rows, ours, (row) => row.executable === executable);
}

/**
 * `ps -eo pid=,ppid=,args=` (Linux) as rows, the command line's first word as the executable;
 * lines that are not a process are skipped.
 */
export function linuxProcessRows(stdout: string): ProcessRow[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) return [];
    const args = match[3].trimEnd();
    return [{ pid: Number(match[1]), ppid: Number(match[2]), executable: args.split(/\s+/)[0], args }];
  });
}

/**
 * Helpers in a Linux install that are never part of a Claude: Chrome owns the native messaging
 * host, and Chromium's crash handler leaves its parent and ends by itself once Claude has.
 */
const LINUX_OUTSIDERS = ["chrome-native-host", "chrome_crashpad_handler"];

/** A path inside a claude-desktop install or a mounted Claude AppImage. */
const inLinuxInstall = (arg: string) => arg.includes("/claude-desktop/") || arg.includes("/.mount_Claude");

/**
 * Whether a Linux command line is Claude Desktop's. Linux builds start through a launcher, a
 * script or an AppImage, so a process counts when its command is the chosen executable, lies
 * inside a claude-desktop install or a mounted Claude AppImage, or shares the executable's name;
 * or when it runs the launcher script or the install's `.asar` as its first argument. Only the
 * command and its first argument are looked at: an editor or `grep` that merely names a file in
 * the install folder is not Claude, and quitting could end it. The Claude Code CLI is also called
 * "claude", so that bare name never matches by itself.
 */
export function linuxClaudeCommand(args: string, executable: string): boolean {
  const name = path.posix.basename(executable);
  const [command = "", first = ""] = args.split(/\s+/);
  return (
    command === executable ||
    inLinuxInstall(command) ||
    (name !== "" && name !== "claude" && path.posix.basename(command) === name) ||
    first === executable ||
    (inLinuxInstall(first) && first.endsWith(".asar"))
  );
}

/**
 * Claude Desktop's processes on Linux, split by app (see splitInstances). A process is Claude's
 * when linuxClaudeCommand says so. An app's main process runs Claude's executable (by path or
 * name), the launcher script or the `.asar`, with no Chromium `--type=` switch, and does not run
 * under another Claude process: zygotes, renderers, the GPU process, the install's own helpers
 * (the VM's virtiofsd, the cowork helper) and Claude's executable run as Node for a server all
 * belong to the app they run under. `self` (Relay) is never Claude.
 */
export function linuxInstances(
  rows: ProcessRow[],
  executable: string,
  self = process.pid,
): ClaudeInstances {
  const name = path.posix.basename(executable);
  const ours = rows.filter(
    (row) =>
      row.pid !== self &&
      !LINUX_OUTSIDERS.includes(path.posix.basename(row.executable)) &&
      linuxClaudeCommand(row.args, executable),
  );
  const claude = new Set(ours.map((row) => row.pid));
  return splitInstances(rows, ours, (row) => {
    if (claude.has(row.ppid) || /(^|\s)--type=/.test(row.args)) return false;
    const first = row.args.split(/\s+/)[1] ?? "";
    return (
      row.executable === executable ||
      (name !== "claude" && path.posix.basename(row.executable) === name) ||
      first === executable ||
      (inLinuxInstall(first) && first.endsWith(".asar"))
    );
  });
}

/**
 * `ours` (a Claude's processes among `rows`) split by app. Every process belongs to the app whose
 * main process (`isApp`) it runs under. The app started without `--user-data-dir` is the main
 * Claude; each one started with it is a window, whoever started it. A process under no app goes
 * to the window whose folder its own switch names, else to the main Claude, so a leftover helper
 * still holds a switch off as it did before windows existed.
 */
function splitInstances(
  rows: ProcessRow[],
  ours: ProcessRow[],
  isApp: (row: ProcessRow) => boolean,
): ClaudeInstances {
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  /** Each app's main process and its data folder; undefined for the main Claude. */
  const apps = new Map<number, string | undefined>();
  for (const row of ours) if (isApp(row)) apps.set(row.pid, userDataDir(row.args));
  const appOf = (pid: number): number | undefined => {
    for (let at = pid, hops = 0; at > 1 && hops < 64; hops++) {
      if (apps.has(at)) return at;
      at = parent.get(at) ?? 0;
    }
    return undefined;
  };
  const windowApps = new Map<string, number>();
  for (const [pid, dir] of apps) if (dir !== undefined) windowApps.set(dir, pid);
  const main: number[] = [];
  const windows = new Map<number, ClaudeWindowProcess>();
  for (const row of ours) {
    let app = appOf(row.pid);
    if (app === undefined) {
      const dir = userDataDir(row.args);
      app = dir === undefined ? undefined : windowApps.get(dir);
    }
    const dir = app === undefined ? undefined : apps.get(app);
    if (app === undefined || dir === undefined) {
      main.push(row.pid);
      continue;
    }
    const entry = windows.get(app) ?? { dir, pid: app, pids: [] };
    entry.pids.push(row.pid);
    windows.set(app, entry);
  }
  const mainApps = [...apps].filter(([, dir]) => dir === undefined).map(([pid]) => pid);
  return {
    main,
    mainPid: mainApps.length === 1 ? mainApps[0] : undefined,
    mainApps,
    windows: [...windows.values()],
  };
}
