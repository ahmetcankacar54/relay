import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  jsonBytes,
  writeBytes,
  type CarriedConversation,
} from "./desktop-files";
import {
  LEVELDB,
  LOCAL_STORAGE,
  backupLocalStorage,
  pruneDraftBackups,
  restoreLocalStorage,
  sweepRestoreLeftovers,
} from "./draft-storage";
import { errorMessage, type DraftJob, type DraftResult } from "../draft-job";

/** How long Relay waits for the draft helper before it kills it. */
const HELPER_TIMEOUT_MS = 10_000;

export type DraftOutcome =
  | { status: "moved"; moved: number; owned: number; skipped: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string; restored: boolean };

/**
 * Moves `from`'s unsent drafts to `to` in Claude's Local Storage, while Claude is closed.
 *
 * Local Storage is backed up first, and the backup is put back when `run` fails or throws.
 * `blocked`, when set, says why drafts cannot move on this machine: the step is then recorded
 * as skipped, with no backup and no run. The outcome is written to `<vault>/drafts/last.json`,
 * with counts or a reason but never draft text. Never throws.
 */
export async function preserveDrafts(input: {
  root: string;
  vault: string;
  from: string;
  to: string;
  conversations: CarriedConversation[];
  run: (job: DraftJob) => Promise<DraftResult>;
  now: Date;
  blocked?: string;
}): Promise<DraftOutcome> {
  let outcome: DraftOutcome;
  try {
    outcome = await transfer(input);
  } catch (error) {
    // Not expected: every step that can fail handles its own failure.
    outcome = { status: "failed", error: errorMessage(error), restored: false };
  }
  try {
    await writeBytes(
      input.vault,
      "drafts/last.json",
      jsonBytes({
        at: input.now.toISOString(),
        from: input.from,
        to: input.to,
        ...outcome,
      }),
    );
  } catch {
    // The record is only there to explain what happened.
  }
  return outcome;
}

async function transfer(
  input: Parameters<typeof preserveDrafts>[0],
): Promise<DraftOutcome> {
  const { root, vault } = input;
  await sweepRestoreLeftovers(root);
  if (input.blocked) return { status: "skipped", reason: input.blocked };

  let backup: string | undefined;
  try {
    // Pruned before the new backup is made, so the backup this run depends on is never among
    // those removed, even when the clock went back, and no more than three ever exist.
    await pruneDraftBackups(vault, 2);
    backup = await backupLocalStorage(root, vault, input.now);
  } catch (error) {
    // Nothing has been touched yet, and nothing runs without a backup.
    return { status: "skipped", reason: errorMessage(error) };
  }
  if (!backup) return { status: "skipped", reason: "no Local Storage" };

  let scratch: string;
  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "relay-drafts-"));
  } catch (error) {
    return { status: "skipped", reason: errorMessage(error) };
  }
  try {
    let result: DraftResult | undefined;
    try {
      result = await input.run({
        storage: path.join(root, LOCAL_STORAGE),
        scratch,
        result: path.join(scratch, "result.json"),
        from: input.from,
        to: input.to,
        conversations: input.conversations,
      });
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    }
    // Field by field, so nothing else the run answered reaches last.json.
    if (result?.ok === true)
      return {
        status: "moved",
        moved: result.moved,
        owned: result.owned,
        skipped: result.skipped,
      };
    return await putBack(root, backup, result?.error || "no result");
  } finally {
    // The helper leaves a link to Claude's Local Storage in here. rm removes the link itself,
    // never what it points to.
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Puts `backup` back in place of Claude's leveldb after a failed run. */
async function putBack(
  root: string,
  backup: string,
  error: string,
): Promise<DraftOutcome> {
  try {
    await restoreLocalStorage(root, backup);
    return { status: "failed", error, restored: true };
  } catch (restoreError) {
    const why = `${error}; the restore failed: ${errorMessage(restoreError)}`;
    const live = path.join(root, LEVELDB);
    // A leveldb that is there is left as it is. Two failed renames can leave none at all, and
    // Claude would then start with an empty Local Storage: copy the backup straight in.
    if (!(await missing(live)))
      return { status: "failed", error: why, restored: false };
    try {
      await fs.cp(path.join(backup, "leveldb"), live, {
        recursive: true,
        verbatimSymlinks: true,
      });
      return {
        status: "failed",
        error: why,
        restored: (await fs.lstat(live)).isDirectory(),
      };
    } catch (copyError) {
      return {
        status: "failed",
        error: `${why}; the copy failed: ${errorMessage(copyError)}`,
        restored: false,
      };
    }
  }
}

async function missing(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return false;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

/** How the helper process ended. */
export interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The helper ran past its time and was killed. */
  timedOut: boolean;
  /** Why the helper could not be started at all. */
  error?: string;
}

/**
 * Resolves once the helper has exited. Past `ms` it is killed with SIGKILL and still waited
 * for: until it is gone it may hold Claude's LevelDB lock, and Claude must not start before.
 */
export function awaitHelper(
  child: ChildProcess,
  ms = HELPER_TIMEOUT_MS,
): Promise<HelperExit> {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // A failed kill is reported as an "error" event; the wait goes on.
      }
    }, ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
    // `on`, not `once`: an unhandled second "error" would throw in Relay's main process.
    child.on("error", (error) => {
      // Only a helper that never started has no exit to wait for.
      if (child.pid !== undefined) return;
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        timedOut,
        error: errorMessage(error),
      });
    });
  });
}

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * What the helper's exit and the text of its result file add up to. A written success counts
 * only when the helper also exited by itself with code 0.
 */
export function helperOutcome(
  exit: HelperExit,
  resultText: string | undefined,
): DraftResult {
  if (exit.timedOut) return { ok: false, error: "timed out" };
  if (exit.error) return { ok: false, error: exit.error };
  const noResult: DraftResult = { ok: false, error: "no result" };
  let value: unknown;
  try {
    value = JSON.parse(resultText ?? "");
  } catch {
    return noResult;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return noResult;
  const result = value as Record<string, unknown>;
  if (result.ok === false)
    return typeof result.error === "string" && result.error !== ""
      ? { ok: false, error: result.error }
      : noResult;
  if (
    result.ok !== true ||
    !count(result.moved) ||
    !count(result.owned) ||
    !count(result.skipped)
  )
    return noResult;
  if (exit.signal)
    return { ok: false, error: `the helper was stopped by ${exit.signal}` };
  if (exit.code !== 0)
    return { ok: false, error: `the helper exited with code ${exit.code}` };
  return {
    ok: true,
    moved: result.moved,
    owned: result.owned,
    skipped: result.skipped,
  };
}

const major = (version: string | undefined) => {
  const match = /^(\d+)(?:\.|$)/.exec(version?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
};

/**
 * Why Relay's Electron must not open Claude's Local Storage, or undefined when it may. Relay's
 * Chromium reads and writes Claude's LevelDB itself, so both must be the same major version:
 * another one could migrate or rebuild the database.
 */
export function electronMismatch(
  claudeVersion: string | undefined,
  relayVersion: string | undefined,
): string | undefined {
  const claude = major(claudeVersion);
  if (claude === undefined)
    return "Claude Desktop's Electron version is unknown";
  const relay = major(relayVersion);
  if (relay === undefined) return "Relay's Electron version is unknown";
  if (claude !== relay)
    return `Claude Desktop runs Electron ${claudeVersion!.trim()}, Relay ${relayVersion!.trim()}`;
  return undefined;
}

/** Why drafts cannot move on this machine, or undefined when they can. */
export function draftsBlockedReason(
  platform: string,
  claudeVersion: string | undefined,
  relayVersion: string | undefined,
): string | undefined {
  if (platform !== "darwin") return "drafts move only on macOS";
  return electronMismatch(claudeVersion, relayVersion);
}
