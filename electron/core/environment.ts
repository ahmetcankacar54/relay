import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { meetsCliMinimum } from "../../shared/cli-version";
const execFileAsync = promisify(execFile);

// Launch the real CLI directly. Never run a login shell or interpolate shell commands.
export function profileEnvironment(
  profile: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // Prevent inherited credentials/routing/nested-session state selecting a different account.
    if (
      /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|RELAY_)/i.test(
        key,
      ) &&
      key !== "CLAUDE_CODE_GIT_BASH_PATH"
    )
      continue;
    env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = profile;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}
export function resolveExecutable(explicit?: string): string | undefined {
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = explicit
    ? [explicit]
    : [
        path.join(os.homedir(), ".local", "bin", name),
        ...(process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((p) => path.join(p, name)),
        ...(process.platform === "win32"
          ? [path.join(os.homedir(), ".claude", "local", name)]
          : ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]),
      ];
  return candidates.find((p) => {
    if (!path.isAbsolute(p) || /\.(cmd|bat|ps1)$/i.test(p)) return false;
    try {
      fs.accessSync(
        p,
        process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
      );
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}
export async function command(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
) {
  return execFileAsync(executable, args, {
    env,
    cwd,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
  });
}
export function supportsDesktop(
  version: string,
  platform = process.platform,
  arch = process.arch,
): boolean {
  if (platform !== "darwin" && !(platform === "win32" && arch === "x64"))
    return false;
  return meetsCliMinimum(version);
}
