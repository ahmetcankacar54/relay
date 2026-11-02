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
const usableFile = (p: string) => {
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
};
/** "2.1.309" before "2.1.30" and "2.1.4"; names that are not versions sort last. */
function newestVersionFirst(a: string, b: string) {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : undefined);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}
/**
 * The Claude Code that Claude Desktop downloads for its Code tab, so a Mac with only the Claude
 * app can still read limits: `Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`,
 * newest version first, only where Desktop wrote `.verified` beside it once the download checked
 * out. Desktop removes old versions as it updates, so the path is looked up at every use.
 */
export function desktopBundledClaude(
  home = os.homedir(),
  platform = process.platform,
  usable: (p: string) => boolean = usableFile,
): string | undefined {
  if (platform !== "darwin") return undefined;
  const root = path.join(home, "Library", "Application Support", "Claude", "claude-code");
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const version of list(root).sort(newestVersionFirst))
    for (const hash of list(path.join(root, version))) {
      const dir = path.join(root, version, hash);
      const executable = path.join(dir, "claude.app", "Contents", "MacOS", "claude");
      if (fs.existsSync(path.join(dir, ".verified")) && usable(executable)) return executable;
    }
  return undefined;
}
/** Where a resolved CLI came from: the user's choice, the usual places, or the Claude app's own. */
export function executableSource(
  executable: string,
  explicit: string | undefined,
): "chosen" | "path" | "claude-app" {
  if (explicit) return "chosen";
  return executable.includes(`${path.sep}Claude${path.sep}claude-code${path.sep}`)
    ? "claude-app"
    : "path";
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
  return (
    candidates.find(usableFile) ?? (explicit ? undefined : desktopBundledClaude())
  );
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
