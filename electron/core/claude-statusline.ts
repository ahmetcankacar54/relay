import fs from "node:fs";
import path from "node:path";
import { readPrivateJson, writePrivateJson } from "./continuation-journal";

/**
 * Relay in Claude Code's status line: `statusLine` in `~/.claude/settings.json` runs
 * `relay statusline`. Every other key stays as it was. A status line another tool put there is
 * kept in Relay's data folder and comes back when Relay's is taken out. The CLI's
 * `relay statusline install|uninstall` and Relay.app's Settings switch share this code.
 */

/** The status line Relay replaced, in Relay's data folder. */
export const STATUSLINE_PREVIOUS_FILE = "claude-statusline-previous.json";

export interface StatuslineSetup {
  /** Claude Code runs `relay statusline`. */
  installed: boolean;
  /** Another status line is set: installing replaces it, and uninstalling brings it back. */
  other: boolean;
}

/** settings.json is not a JSON object: nothing is changed. */
export class ClaudeSettingsUnreadable extends Error {
  constructor(readonly file: string) {
    super(`${file} is not valid JSON.`);
  }
}

type Json = Record<string, unknown>;

const settingsFile = (claudeDir: string) =>
  path.join(claudeDir, "settings.json");

function readSettings(claudeDir: string): Json {
  const file = settingsFile(claudeDir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Json;
  } catch {
    // Reported below.
  }
  throw new ClaudeSettingsUnreadable(file);
}

/**
 * Writes through a temporary file, so Claude Code never reads half a settings file. Owner-only, as
 * the gateway's binding writes it: the file may hold tokens in `env`.
 */
function writeSettings(claudeDir: string, settings: Json): void {
  const file = settingsFile(claudeDir);
  fs.mkdirSync(claudeDir, { recursive: true });
  const temporary = `${file}.relay-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

/**
 * The shell command that runs `relay statusline` through `executable` (the relay command, or node
 * and the CLI's launcher), every part absolute: Claude Code runs it in a non-login shell, whose PATH
 * may lack an npm or nvm folder. A part with anything but plain path characters is double-quoted.
 * On Windows the separators become forward slashes, since Claude Code runs the command in Git Bash,
 * which would eat backslashes.
 */
export function statuslineCommand(
  executable: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const parts = executable.map((part) => {
    const text = platform === "win32" ? part.replace(/\\/g, "/") : part;
    return /^[\w@%+=:,./-]+$/.test(text)
      ? text
      : `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
  });
  return [...parts, "statusline"].join(" ");
}

/** Whether a `statusLine` value runs Relay's (`relay statusline`, by any path, with or without `--color`). */
export function isRelayStatusline(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const { type, command } = value as Json;
  return (
    type === "command" &&
    typeof command === "string" &&
    /(^|[\s/\\"])relay(\.js)?"?\s+statusline(\s+--color)?\s*$/.test(
      command.trim(),
    )
  );
}

/** Whether Claude Code shows Relay's status line, and whether another one is set. */
export function statuslineSetup(claudeDir: string): StatuslineSetup {
  const current = readSettings(claudeDir).statusLine;
  const installed = isRelayStatusline(current);
  return { installed, other: !installed && current !== undefined };
}

/**
 * Points Claude Code's status line at `command` (see statuslineCommand). Another one is saved in
 * `previousFile` first; with none, an older saved one is dropped, so uninstalling cannot bring back
 * a status line the user removed since. Relay's own with another path is replaced in place.
 */
export function installStatusline(
  claudeDir: string,
  previousFile: string,
  command: string,
): "installed" | "replaced" | "already" {
  const settings = readSettings(claudeDir);
  const current = settings.statusLine;
  const next = { type: "command", command };
  if (isRelayStatusline(current)) {
    if ((current as Json).command === command) return "already";
  } else if (current !== undefined) {
    fs.mkdirSync(path.dirname(previousFile), { recursive: true, mode: 0o700 });
    writePrivateJson(previousFile, { statusLine: current });
  } else fs.rmSync(previousFile, { force: true });
  writeSettings(claudeDir, { ...settings, statusLine: next });
  return current === undefined || isRelayStatusline(current)
    ? "installed"
    : "replaced";
}

/** The status line Relay replaced, or undefined. */
function savedStatusline(previousFile: string): unknown {
  try {
    const saved = readPrivateJson(previousFile) as Json;
    return saved && typeof saved === "object" ? saved.statusLine : undefined;
  } catch {
    return undefined;
  }
}

/** Takes Relay out of Claude Code's status line, putting back the one it replaced. */
export function uninstallStatusline(
  claudeDir: string,
  previousFile: string,
): "removed" | "restored" | "not-installed" {
  const settings = readSettings(claudeDir);
  if (!isRelayStatusline(settings.statusLine)) return "not-installed";
  const previous = savedStatusline(previousFile);
  const { statusLine: _relay, ...rest } = settings;
  writeSettings(
    claudeDir,
    previous === undefined ? rest : { ...rest, statusLine: previous },
  );
  fs.rmSync(previousFile, { force: true });
  return previous === undefined ? "removed" : "restored";
}
