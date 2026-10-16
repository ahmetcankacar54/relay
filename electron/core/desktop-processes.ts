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
