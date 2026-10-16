import fs from "node:fs";
import path from "node:path";
import type { CarriedConversation } from "./core/desktop-files";
import { planDraftMoves, type DraftOps } from "./core/drafts";

/** Starts the argument that makes Relay's Electron run as the draft helper: `--relay-draft-worker=<job.json>`. */
export const DRAFT_WORKER_FLAG = "--relay-draft-worker=";

export interface DraftJob {
  /** Absolute path of Claude's "Local Storage" directory. */
  storage: string;
  /** Scratch dir the helper owns: root/ (symlink "Local Storage" -> storage) and userData/. */
  scratch: string;
  /** Where the helper writes its DraftResult. */
  result: string;
  from: string;
  to: string;
  conversations: CarriedConversation[];
}

export type DraftResult =
  | { ok: true; moved: number; owned: number; skipped: number }
  | { ok: false; error: string };

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

function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`Draft job: ${name} must be a list.`);
  return value;
}

/** Checks a parsed job file and returns a clean copy of it. Throws when anything is off. */
export function parseDraftJob(value: unknown): DraftJob {
  const raw = object(value, "job");
  return {
    storage: field(raw.storage, "storage", true),
    scratch: field(raw.scratch, "scratch", true),
    result: field(raw.result, "result", true),
    from: field(raw.from, "from"),
    to: field(raw.to, "to"),
    conversations: list(raw.conversations, "conversations").map((entry) => {
      const conversation = object(entry, "conversation");
      return {
        targetAlias: field(conversation.targetAlias, "targetAlias"),
        members: list(conversation.members, "members").map((entry) => {
          const member = object(entry, "member");
          return {
            alias: field(member.alias, "alias"),
            accountUuid: field(member.accountUuid, "accountUuid"),
          };
        }),
      };
    }),
  };
}

/** The helper's window onto Claude's Local Storage. Only `composer-draft:` keys ever pass through it. */
export interface DraftPage {
  /** How many keys the origin holds, of any kind. 0 means Chromium did not open Claude's data. */
  size(): Promise<number>;
  /** Every `composer-draft:` key with its value. */
  read(): Promise<Record<string, string>>;
  /** Sets every `ops.set` key, then removes every `ops.remove` key. */
  apply(ops: DraftOps): Promise<void>;
  /** Asks Chromium to commit what was written. It schedules the commit; it does not wait for the disk. */
  flush(): Promise<void>;
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
 * Moves the drafts of `job.from` to `job.to` through `page`, then reads them back. The read-back
 * shows Chromium's view of Local Storage after the writes, not the disk, so it catches a write
 * that did not take but cannot prove the commit. Never throws.
 *
 * An origin with no keys at all is a failure: when Chromium cannot open Claude's database it
 * deletes and recreates it, or falls back to memory, and either way the job would otherwise
 * report success over nothing.
 */
export async function runDraftJob(
  job: DraftJob,
  page: DraftPage,
): Promise<DraftResult> {
  try {
    if ((await page.size()) === 0) return { ok: false, error: EMPTY_STORAGE };
    const ops = planDraftMoves({
      drafts: await page.read(),
      from: job.from,
      to: job.to,
      conversations: job.conversations,
    });
    if (Object.keys(ops.set).length > 0 || ops.remove.length > 0)
      await page.apply(ops);
    await page.flush();
    const after = await page.read();
    const stuck =
      Object.entries(ops.set).some(([key, value]) => after[key] !== value) ||
      ops.remove.some((key) => Object.hasOwn(after, key));
    if (stuck) return { ok: false, error: "verification failed" };
    return {
      ok: true,
      moved: ops.moved,
      owned: ops.owned,
      skipped: ops.skipped,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
