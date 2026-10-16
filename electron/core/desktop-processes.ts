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
