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
 * Claude Desktop's processes on macOS, split by app. Every process inside the bundle belongs to
 * the app whose main process (the bundle's executable) it runs under. The app started without
 * `--user-data-dir` is the main Claude; each one started with it is a window, whoever started it.
 * A process under no app goes to the window whose folder its own switch names, else to the main
 * Claude, so a leftover helper still holds a switch off as it did before windows existed. Chrome's
 * native messaging host can outlive Claude and is never counted.
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
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  /** Each app's main process and its data folder; undefined for the main Claude. */
  const apps = new Map<number, string | undefined>();
  for (const row of ours)
    if (row.executable === executable) apps.set(row.pid, userDataDir(row.args));
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
