/**
 * The oldest Claude Code CLI Relay works with. `supportsDesktop` (electron/core/environment.ts)
 * gates on it.
 */
export const MIN_CLI_VERSION = "2.1.285";

/**
 * The oldest Claude Code CLI Relay can read usage limits with. The usage credential refresher
 * (electron/main.ts) refuses older ones, and the Overview checklist and the add-account dialog
 * name it: their ✓ means the CLI can read limits.
 */
export const USAGE_CLI_VERSION = "2.1.296";

const parts = (version: string) =>
  version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);

/** Whether a `claude --version` output is `min` or later. */
function atLeast(version: string, min: string): boolean {
  const found = parts(version);
  if (!found) return false;
  const floor = parts(min)!;
  for (let i = 0; i < 3; i++)
    if (found[i] !== floor[i]) return found[i] > floor[i];
  return true;
}

/** Whether a `claude --version` output is MIN_CLI_VERSION or later. */
export const meetsCliMinimum = (version: string) =>
  atLeast(version, MIN_CLI_VERSION);

/** Whether a `claude --version` output is USAGE_CLI_VERSION or later: it can read limits. */
export const readsUsage = (version: string) =>
  atLeast(version, USAGE_CLI_VERSION);
