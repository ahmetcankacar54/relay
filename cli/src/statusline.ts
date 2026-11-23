import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { relayPaths } from "../../electron/core/relay-paths";
import {
  STATUSLINE_FILE,
  claudeSignIn,
  parseStatuslineInput,
  parseStatuslineSnapshot,
  renderStatusline,
  type StatuslineSnapshot,
  type StatuslineStyle,
} from "../../shared/statusline";

/**
 * `relay statusline` without the rest of the CLI: this module and what it imports are bundled on
 * their own (dist/relay-statusline.js), so Claude Code gets its line in a few milliseconds. It reads
 * two small files and stdin; it never opens the account list, the vault, the Keychain or the network.
 */

const CODES: Record<StatuslineStyle, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  green: [32, 39],
  yellow: [33, 39],
  red: [31, 39],
};

/** How long stdin may stay open before the line is drawn without it. */
export const STDIN_WAIT_MS = 250;

/** Claude Code's JSON on stdin; nothing from a terminal, and whatever came once `waitMs` passed. */
export function readStdin(stream: Readable & { isTTY?: boolean }, waitMs = STDIN_WAIT_MS): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  // The executor form: the project's TypeScript lib predates Promise.withResolvers.
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      // A stdin left open must not keep the process alive after the line is printed.
      stream.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, waitMs);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", done);
    stream.once("error", done);
  });
}

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * The snapshot Relay.app wrote in its data folder (as `relayPaths` finds it on this platform, or
 * RELAY_HOME), or undefined when there is none yet.
 */
export function readStatuslineSnapshot(
  env: NodeJS.ProcessEnv,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): StatuslineSnapshot | undefined {
  return parseStatuslineSnapshot(readText(path.join(relayPaths(env, home, platform).data, STATUSLINE_FILE)));
}

export interface StatuslineRun {
  /** Claude Code's stdin JSON. */
  stdin: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  now: number;
  color: boolean;
}

/** The status line for this session; empty when there is nothing to show for it. */
export function statuslineText(snapshot: StatuslineSnapshot, run: StatuslineRun): string {
  const home = run.home ?? os.homedir();
  const configDir = run.env.CLAUDE_CONFIG_DIR || undefined;
  return renderStatusline({
    snapshot,
    input: parseStatuslineInput(run.stdin),
    configDir,
    // Claude Code keeps its sign-in's name in `.claude.json`: in CLAUDE_CONFIG_DIR, else the home folder.
    signIn: () => claudeSignIn(readText(path.join(configDir && path.isAbsolute(configDir) ? configDir : home, ".claude.json"))),
    now: run.now,
    paint: (style, text) => (run.color ? `\x1b[${CODES[style][0]}m${text}\x1b[${CODES[style][1]}m` : text),
  });
}

/** Colors: `--color`, or stdout is a terminal; never with NO_COLOR or `--no-color`. */
export function statuslineColor(flags: { color?: boolean; noColor?: boolean }, isTTY: boolean, env: NodeJS.ProcessEnv) {
  if (flags.noColor || env.NO_COLOR) return false;
  return !!flags.color || isTTY;
}
