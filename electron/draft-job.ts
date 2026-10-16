import fs from "node:fs";
import path from "node:path";

/** Starts the argument that makes Relay's Electron run as the draft helper: `--relay-draft-worker=<job.json>`. */
export const DRAFT_WORKER_FLAG = "--relay-draft-worker=";

export interface DraftJob {
  /**
   * Absolute path of the directory the helper opens as Local Storage: `<scratch>/copy`, which
   * holds Relay's private copy of Claude's leveldb, outside Claude's directory.
   */
  storage: string;
  /**
   * The run's scratch dir, `<tmp>/relay-drafts-*`. Relay puts the copy (copy/) in it, the helper
   * its root/ (symlink "Local Storage" -> storage), userData/ and result, and Relay removes it
   * after the run.
   */
  scratch: string;
  /** Where the helper writes its DraftResult. */
  result: string;
  /** The Electron version Relay read from Claude.app. The helper's own must have its major. */
  claudeElectron: string;
}

/** What the helper answers: on success, every `composer-draft:` key of Local Storage with its raw value. */
export type DraftResult =
  { ok: true; drafts: Record<string, string> } | { ok: false; error: string };

/** The job file's path from the process arguments, or undefined when this is not a helper run. */
export function draftJobPath(argv: string[]): string | undefined {
  const arg = argv.find(
    (value) =>
      value.startsWith(DRAFT_WORKER_FLAG) &&
      value.length > DRAFT_WORKER_FLAG.length,
  );
  return arg?.slice(DRAFT_WORKER_FLAG.length);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The major version of an Electron version such as "44.7.2", or undefined when it has none. */
export function electronMajor(version: string | undefined): number | undefined {
  const match = /^(\d+)(?:\.|$)/.exec(version?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
}

/**
 * Why the helper must not open the job's Local Storage, or undefined when it may: its own
 * Electron (`helper`) must have the major of the one Relay read from Claude.app (`claude`), or
 * its Chromium could migrate or rebuild the database. Relay checks its main process before the
 * switch; this checks the process that opens the database.
 */
export function helperElectronMismatch(
  claude: string,
  helper: string | undefined,
): string | undefined {
  const major = electronMajor(claude);
  return major !== undefined && major === electronMajor(helper)
    ? undefined
    : `helper Electron ${helper} differs from Claude Desktop ${claude}`;
}

function field(value: unknown, name: string, absolute = false): string {
  if (typeof value !== "string" || value === "")
    throw new Error(`Draft job: ${name} must be a non-empty string.`);
  // A relative path would resolve against whatever directory the helper starts in.
  if (absolute && !path.isAbsolute(value))
    throw new Error(`Draft job: ${name} must be an absolute path.`);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Draft job: ${name} must be an object.`);
  return value as Record<string, unknown>;
}

/** Checks a parsed job file and returns a clean copy of it. Throws when anything is off. */
export function parseDraftJob(value: unknown): DraftJob {
  const raw = object(value, "job");
  return {
    storage: field(raw.storage, "storage", true),
    scratch: field(raw.scratch, "scratch", true),
    result: field(raw.result, "result", true),
    claudeElectron: field(raw.claudeElectron, "claudeElectron"),
  };
}

/** The helper's window onto Claude's Local Storage. It can only look: it offers no way to write. */
export interface DraftPage {
  /** How many keys the origin holds, of any kind. 0 means Chromium did not open Claude's data. */
  size(): Promise<number>;
  /** Every `composer-draft:` key with its value. */
  read(): Promise<Record<string, string>>;
}

/** Why a job fails when Chromium gave the helper no data to work on. */
export const EMPTY_STORAGE = "Claude's Local Storage opened empty";

/**
 * Throws unless `storage` is a real directory holding a real `leveldb` directory. A link or a
 * missing path is refused, so Chromium is never pointed at something it would create or
 * rebuild inside Claude's directory.
 */
export function assertLocalStorage(storage: string): void {
  for (const [dir, name] of [
    [storage, "Local Storage"],
    [path.join(storage, "leveldb"), "Local Storage/leveldb"],
  ]) {
    let real = false;
    try {
      // lstat, so a link is not followed.
      real = fs.lstatSync(dir).isDirectory();
    } catch {
      // Missing or unreadable: not a real directory.
    }
    if (!real) throw new Error(`${name} is not a real directory.`);
  }
}

/**
 * Reads every `composer-draft:` key of Claude's Local Storage through `page`, and writes nothing.
 * Never throws.
 *
 * An origin with no keys at all is a failure: when Chromium cannot open Claude's database it
 * deletes and recreates it, or falls back to memory, and either way the job would otherwise
 * report success over nothing.
 */
export async function runDraftJob(
  _job: DraftJob,
  page: DraftPage,
): Promise<DraftResult> {
  try {
    if ((await page.size()) === 0) return { ok: false, error: EMPTY_STORAGE };
    return { ok: true, drafts: await page.read() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
