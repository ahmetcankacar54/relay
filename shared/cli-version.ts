/**
 * The oldest Claude Code CLI Relay works with. `supportsDesktop` (electron/core/environment.ts)
 * gates on it, and the Overview checklist names it; both read it from here.
 */
export const MIN_CLI_VERSION = "2.1.285";

const parts = (version: string) =>
  version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);

/** Whether a `claude --version` output is MIN_CLI_VERSION or later. */
export function meetsCliMinimum(version: string): boolean {
  const found = parts(version);
  if (!found) return false;
  const min = parts(MIN_CLI_VERSION)!;
  for (let i = 0; i < 3; i++)
    if (found[i] !== min[i]) return found[i] > min[i];
  return true;
}
