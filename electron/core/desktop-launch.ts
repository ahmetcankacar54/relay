import fs from "node:fs/promises";
import path from "node:path";

/**
 * Whether the claude.ai page of a Claude that Relay started has booted, read from Claude's own
 * main log. Claude writes "Starting app {" as it starts, and "Loaded https://claude.ai (web
 * commit …)" once the page's code runs and reports its build to the app. Until then the window
 * shows only Claude's grey loading skeleton. A start can stay on that skeleton for a minute or
 * more (seen after switches and after Claude's own update restarts); a second start is quick.
 * Relay only reads the log: nothing is written, and a log it cannot read changes nothing.
 */

/** Claude's line as it starts. */
const STARTED = "] Starting app {";
/** The page's report of its build, once its code runs. */
const LOADED = /\] Loaded https:\/\/\S+ \(web commit /;
/** How much of the log before a launch must show a page report, so Relay knows its format. */
const KNOWN_BYTES = 4 * 1024 * 1024;
/** The most of the log read after a launch: its end, where the launch is. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** How long a launch may take to log its start before the watch stops waiting for it. */
export const START_MS = 10_000;
const POLL_MS = 1_000;
/** Every this many polls the watch checks that Claude still runs. */
const RUNNING_EVERY = 5;

/** How far the last launch in a piece of the log got. */
export type LaunchProgress = "none" | "started" | "loaded";
/**
 * What a watch found: `loaded`, the page booted; `stalled`, Claude started and still runs but
 * its page never booted in time; `closed`, Claude was quit meanwhile; `unknown`, no start was
 * logged (Claude was already open, or wrote its log elsewhere) or Claude's state could not be
 * read. Only `stalled` is a reason to start Claude again.
 */
export type PageOutcome = "loaded" | "stalled" | "closed" | "unknown";

/** The last start in `text`, and whether its page reported its build after it. */
export function launchProgress(text: string): LaunchProgress {
  const start = text.lastIndexOf(STARTED);
  if (start < 0) return "none";
  return LOADED.test(text.slice(start)) ? "loaded" : "started";
}

/** Claude's main log and the file it moves a full one to. */
export interface ClaudeLogFiles {
  current: string;
  rotated: string;
}

/** Where Claude Desktop logs on macOS. */
export function macClaudeLog(home: string): ClaudeLogFiles {
  const dir = path.join(home, "Library", "Logs", "Claude");
  return {
    current: path.join(dir, "main.log"),
    rotated: path.join(dir, "main1.log"),
  };
}

async function sizeOf(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return undefined;
  }
}

/** Bytes `start` to `end` of `file` as text, at most the last MAX_READ_BYTES of them. */
async function readRange(file: string, start: number, end: number): Promise<string> {
  const from = Math.max(start, end - MAX_READ_BYTES);
  if (end <= from) return "";
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(end - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Where the log ends now, before a launch; undefined when it cannot be read, or when its recent
 * part holds no page report (Claude logs differently now, so its silence would mean nothing).
 * A log that was just rotated is read on into the file it went to.
 */
export async function markLog(files: ClaudeLogFiles): Promise<number | undefined> {
  try {
    const end = await sizeOf(files.current);
    if (end === undefined) return undefined;
    let recent = await readRange(files.current, Math.max(0, end - KNOWN_BYTES), end);
    if (!LOADED.test(recent) && end < KNOWN_BYTES) {
      const rotated = await sizeOf(files.rotated);
      if (rotated !== undefined)
        recent = await readRange(
          files.rotated,
          Math.max(0, rotated - (KNOWN_BYTES - end)),
          rotated,
        );
    }
    return LOADED.test(recent) ? end : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the log holds after `offset`, where `markLog` left it. When Claude has rotated it since,
 * the rest of the old log comes first, then the new one.
 */
export async function logSince(files: ClaudeLogFiles, offset: number): Promise<string> {
  const end = (await sizeOf(files.current)) ?? 0;
  if (end >= offset) return readRange(files.current, offset, end);
  const rotated = await sizeOf(files.rotated);
  const rest =
    rotated !== undefined && rotated >= offset
      ? await readRange(files.rotated, offset, rotated)
      : "";
  return rest + (await readRange(files.current, 0, end));
}

export interface PageWaitDeps {
  /** The log since the watch began; a failed read counts as nothing new. */
  read(): Promise<string>;
  running(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Reads the log every second until the launch's page reports its build, for at most
 * `timeoutMs`. Stops early when no start is logged within START_MS, and when Claude is quit:
 * it checks every 5 s, and once more before it calls the page stalled.
 */
export async function waitForPage(deps: PageWaitDeps, timeoutMs: number): Promise<PageOutcome> {
  const begun = deps.now();
  for (let polls = 1; ; polls++) {
    const progress = launchProgress(await deps.read().catch(() => ""));
    if (progress === "loaded") return "loaded";
    const waited = deps.now() - begun;
    if (progress === "none" && waited >= START_MS) return "unknown";
    const due = waited >= timeoutMs;
    if (due || polls % RUNNING_EVERY === 0) {
      let running: boolean;
      try {
        running = await deps.running();
      } catch {
        // Unknown: never a reason to start Claude again.
        if (due) return "unknown";
        running = true;
      }
      if (!running) return "closed";
      if (due) return "stalled";
    }
    await deps.sleep(POLL_MS);
  }
}

/** A launch being watched: `wait` tells how the page of the Claude started since did. */
export interface LaunchWatch {
  wait(timeoutMs: number): Promise<PageOutcome>;
}

/**
 * Starts watching Claude's log before a launch; undefined when the log cannot tell. `running`
 * is Claude's full process check.
 */
export async function watchClaudeLaunch(
  files: ClaudeLogFiles,
  running: () => Promise<boolean>,
): Promise<LaunchWatch | undefined> {
  const offset = await markLog(files);
  if (offset === undefined) return undefined;
  return {
    wait: (timeoutMs) =>
      waitForPage(
        {
          read: () => logSince(files, offset),
          running,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: Date.now,
        },
        timeoutMs,
      ),
  };
}
