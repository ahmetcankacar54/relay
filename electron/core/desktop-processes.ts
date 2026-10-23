/**
 * A real `ps -axo pid=,comm=` listing always holds launchd. An empty or unreadable one means the
 * lookup failed (for example, its output was cut short), not that Claude is closed.
 */
export function assertProcessListing(stdout: string): void {
  if (!/^\s*\d+\s+\S/m.test(stdout))
    throw new Error("The process list could not be read.");
}

/** Runs `attempt`, and once more after `waitMs` if it fails; the second failure is reported. */
export async function retryOnce<T>(
  attempt: () => Promise<T>,
  waitMs: number,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  try {
    return await attempt();
  } catch {
    await sleep(waitMs);
    return attempt();
  }
}

// Chrome owns this native messaging host. It can outlive Claude's windows and
// must not make an otherwise clean Desktop shutdown look like a running app.
export function macDesktopPids(stdout: string, executable: string): number[] {
  const marker = executable.indexOf(".app/");
  if (marker < 0) return [];
  const bundle = executable.slice(0, marker + 5);
  const browserHost = `${bundle}Contents/Helpers/chrome-native-host`;
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || match[2] === browserHost) return [];
    return match[2] === executable || match[2].startsWith(bundle)
      ? [Number(match[1])]
      : [];
  });
}

/**
 * Claude Desktop's pids in a Linux `ps -eo pid=,args=` listing. Linux builds start through a
 * launcher script or an AppImage, so a process counts when an argument is the chosen executable,
 * lies inside a claude-desktop install or a mounted Claude AppImage, or shares the executable's
 * name. The Claude Code CLI is also called "claude", so that bare name never matches by itself;
 * `self` (Relay) is never Claude.
 */
export function linuxDesktopPids(
  stdout: string,
  executable: string,
  self = process.pid,
): number[] {
  const name = executable.slice(executable.lastIndexOf("/") + 1);
  const byName = name !== "" && name !== "claude";
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === self) return [];
    const hit = match[2].split(/\s+/).some(
      (arg) =>
        arg === executable ||
        arg.includes("/claude-desktop/") ||
        arg.includes("/.mount_Claude") ||
        (byName && arg.slice(arg.lastIndexOf("/") + 1) === name),
    );
    return hit ? [Number(match[1])] : [];
  });
}

/**
 * The pid of Claude's main process in a `ps -axo pid=,comm=` listing: the one running the app's
 * executable itself, not a helper. Undefined when there is none, or more than one.
 */
export function macMainPid(
  stdout: string,
  executable: string,
): number | undefined {
  const pids = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
  return pids.length === 1 ? pids[0] : undefined;
}

/** `ps -o etime=`, `[[dd-]hh:]mm:ss`, in milliseconds; undefined when it is not that. */
export function parseEtime(text: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d{2}):)?(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [days, hours, minutes, seconds] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** How long a Claude pid seen alive is trusted before the next full listing. */
export const LIVENESS_LISTING_MS = 60_000;

/**
 * Whether Claude runs, with fewer full process listings. Every listing remembers Claude's main
 * pid (else its first one). For display, `seemsRunning` answers from that pid while it is alive
 * and the listing is under a minute old; it lists again when no pid is known, the pid is gone or
 * the minute is over. Quits, launches and writes use `running` and `pids`, which always list.
 */
export class ClaudeLiveness {
  private known?: { pid: number; at: number };
  constructor(
    private readonly deps: {
      /** A full listing; throws when it fails or comes back empty. */
      list(): Promise<{ pids: number[]; main?: number }>;
      /** `process.kill(pid, 0)`: the pid exists. */
      alive(pid: number): boolean;
      now(): number;
    },
  ) {}
  async pids(): Promise<number[]> {
    const { pids, main } = await this.deps.list();
    const pid = main ?? pids[0];
    this.known = pid === undefined ? undefined : { pid, at: this.deps.now() };
    return pids;
  }
  async running(): Promise<boolean> {
    return (await this.pids()).length > 0;
  }
  /** For display only: may still say running for a pid reused within the minute. */
  async seemsRunning(): Promise<boolean> {
    const known = this.known;
    if (
      known &&
      this.deps.now() - known.at < LIVENESS_LISTING_MS &&
      this.deps.alive(known.pid)
    )
      return true;
    return this.running();
  }
}

/** `process.kill(pid, 0)` as a test: a pid that exists but is not ours still counts. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
