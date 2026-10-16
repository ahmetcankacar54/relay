import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  jsonBytes,
  writeBytes,
  type CarriedConversation,
} from "./desktop-files";
import { DRAFT_KEY_PREFIX } from "./drafts";
import {
  backupLocalStorage,
  discardWorkingCopy,
  makeWorkingCopy,
  pruneDraftBackups,
  sweepDraftLeftovers,
} from "./draft-storage";
import {
  DRAFT_WORKER_FLAG,
  electronMajor,
  errorMessage,
  type DraftJob,
  type DraftResult,
} from "../draft-job";

/** How long Relay waits for the draft helper before it kills it. */
const HELPER_TIMEOUT_MS = 10_000;
/** The helper's scratch dirs are `<tmp>/relay-drafts-*`, where `tmp` defaults to os.tmpdir(). */
const SCRATCH_PREFIX = "relay-drafts-";
/** A scratch dir older than this was left by a Relay that stopped mid-step: the helper gets 10 s. */
const STALE_SCRATCH_MS = 10 * 60_000;
const ELECTRON_UNKNOWN = "Claude Desktop's Electron version is unknown";
/** Why every run ends as skipped until the drafts it reads are stored. */
const CAPTURE_PENDING = "capture pending";

export type DraftOutcome =
  | { status: "skipped"; reason: string }
  /** `restored` is true when Claude's leveldb is as it was, false when it may not be. */
  | { status: "failed"; error: string; restored: boolean };

/**
 * The draft step of a switch, while Claude is closed. For now it only runs the read-only helper:
 * what the helper reads is not stored yet, so every run that gets as far as the helper ends as
 * skipped with reason "capture pending".
 *
 * Local Storage is backed up to the vault, then copied to a working dir beside Claude's leveldb,
 * and `run` reads only that copy. Whatever `run` answers, the copy is dropped and Claude's
 * leveldb is never replaced.
 *
 * `blocked`, when set, says why drafts cannot be read on this machine. `claudeElectron` is the
 * Electron version the same gate read from Claude.app; the helper refuses to open the copy under
 * another major. With `blocked`, or without `claudeElectron`, the step is recorded as skipped,
 * with no backup and no run.
 *
 * `running` says whether Claude is running; a check that throws counts as running. It is asked
 * at the start and just before `run`. Once Claude runs, its Local Storage is not touched any more.
 *
 * The helper's scratch dir is made in `tmp`, which defaults to os.tmpdir(), and stale ones
 * there are removed.
 *
 * The outcome is written to `<vault>/drafts/last.json`, with a reason but never draft text.
 * Never throws.
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
  claudeElectron?: string;
  running: () => Promise<boolean>;
  tmp?: string;
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
  const running = async () => {
    try {
      return await input.running();
    } catch {
      return true; // Unknown is treated as running.
    }
  };
  // All before the sweeps, so a skipped step deletes nothing in Claude's Local Storage.
  if (input.blocked) return { status: "skipped", reason: input.blocked };
  const claudeElectron = input.claudeElectron;
  if (!claudeElectron) return { status: "skipped", reason: ELECTRON_UNKNOWN };
  if (await running()) return claudeRunning();
  const tmp = input.tmp ?? os.tmpdir();
  await sweepStaleScratch(tmp);
  await sweepDraftLeftovers(root);

  try {
    // Pruned before the new backup is made, so the backup this run depends on is never among
    // those removed, even when the clock went back.
    await pruneDraftBackups(vault, 2);
  } catch {
    // Old backups stay a little longer; the step goes on.
  }
  let backup: string | undefined;
  try {
    backup = await backupLocalStorage(root, vault, input.now);
  } catch (error) {
    // Nothing has been touched yet, and nothing runs without a backup.
    return { status: "skipped", reason: errorMessage(error) };
  }
  if (!backup) return { status: "skipped", reason: "no Local Storage" };

  let work: string;
  try {
    work = await makeWorkingCopy(root);
  } catch (error) {
    return { status: "skipped", reason: errorMessage(error) };
  }
  try {
    return await moveInCopy(input, work, claudeElectron, tmp, running);
  } finally {
    // Claude's leveldb was never replaced, so the copy has no use left.
    await discardWorkingCopy(root, work);
  }
}

/** Runs the helper on the working copy in `work`, and ends the step as pending whatever it answered. */
async function moveInCopy(
  input: Parameters<typeof preserveDrafts>[0],
  work: string,
  claudeElectron: string,
  tmp: string,
  running: () => Promise<boolean>,
): Promise<DraftOutcome> {
  let scratch: string;
  try {
    scratch = await fs.mkdtemp(path.join(tmp, SCRATCH_PREFIX));
  } catch (error) {
    return { status: "skipped", reason: errorMessage(error) };
  }
  try {
    if (await running()) return claudeRunning();
    try {
      await input.run({
        storage: work,
        scratch,
        result: path.join(scratch, "result.json"),
        claudeElectron,
      });
    } catch {
      // A failed run is no different from a finished one while nothing is stored.
    }
    return { status: "skipped", reason: CAPTURE_PENDING };
  } finally {
    // The helper leaves a link to the working copy in here. rm removes the link itself, never
    // what it points to.
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const claudeRunning = (): DraftOutcome => ({
  status: "skipped",
  reason: "Claude is running",
});

/**
 * Removes the helper scratch dirs in `tmp` that are older than ten minutes: a Relay that crashed
 * or was killed mid-step leaves one behind, with its link. Never throws.
 */
async function sweepStaleScratch(tmp: string): Promise<void> {
  try {
    for (const entry of await fs.readdir(tmp, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(SCRATCH_PREFIX))
        continue;
      const dir = path.join(tmp, entry.name);
      try {
        if (Date.now() - (await fs.lstat(dir)).mtimeMs > STALE_SCRATCH_MS)
          // rm removes the link inside, never what it points to.
          await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // The next one may still go.
      }
    }
  } catch {
    // The temp dir cannot be listed: nothing to remove.
  }
}

/** What `runHelper` needs from Relay's process, injected so tests never start Electron. */
export interface HelperDeps {
  /** Relay's own executable: Relay's Electron doubles as the helper. */
  execPath: string;
  /** Packaged, the entry picks the helper from the flag alone. */
  packaged: boolean;
  /** The directory that holds `draft-worker.cjs`, for an unpackaged Relay. */
  dir: string;
  /** Relay's environment. The helper gets a copy without ELECTRON_RUN_AS_NODE. */
  env: NodeJS.ProcessEnv;
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  writeFile: (
    file: string,
    data: string,
    options: { mode: number; flag: string },
  ) => Promise<void>;
  readFile: (file: string, encoding: "utf8") => Promise<string>;
}

/**
 * Starts the draft helper on `job` and resolves with its result once it has exited, or been
 * killed past its time. The result file is read only then.
 */
export async function runHelper(
  job: DraftJob,
  deps: HelperDeps,
): Promise<DraftResult> {
  const jobPath = path.join(job.scratch, "job.json");
  // New and private: an existing file is never reused.
  await deps.writeFile(jobPath, JSON.stringify(job), {
    mode: 0o600,
    flag: "wx",
  });
  const flag = DRAFT_WORKER_FLAG + jobPath;
  const env = { ...deps.env };
  // Set, it would start Relay's Electron as plain Node instead of as the helper.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = deps.spawn(
    deps.execPath,
    deps.packaged ? [flag] : [path.join(deps.dir, "draft-worker.cjs"), flag],
    { stdio: "ignore", env },
  );
  const exit = await awaitHelper(child);
  let text: string | undefined;
  try {
    text = await deps.readFile(job.result, "utf8");
  } catch {
    // No result file: helperOutcome reports it.
  }
  return helperOutcome(exit, text);
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

/** Most drafts a helper may report. Claude holds a few dozen at most. */
const MAX_DRAFTS = 500;
/** Most characters, keys and values together, a helper may report. */
const MAX_DRAFT_CHARS = 4 * 1024 * 1024;

/**
 * The drafts of a helper's answer, or undefined when it is not a plain map from `composer-draft:`
 * keys to strings within the limits.
 */
function validDrafts(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_DRAFTS) return undefined;
  const drafts: Record<string, string> = {};
  let chars = 0;
  for (const [key, text] of entries) {
    if (!key.startsWith(DRAFT_KEY_PREFIX) || typeof text !== "string")
      return undefined;
    chars += key.length + text.length;
    if (chars > MAX_DRAFT_CHARS) return undefined;
    drafts[key] = text;
  }
  return drafts;
}

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
  const drafts = result.ok === true ? validDrafts(result.drafts) : undefined;
  if (!drafts) return noResult;
  if (exit.signal)
    return { ok: false, error: `the helper was stopped by ${exit.signal}` };
  if (exit.code !== 0)
    return { ok: false, error: `the helper exited with code ${exit.code}` };
  return { ok: true, drafts };
}

/**
 * Why Relay's Electron must not open Claude's Local Storage, or undefined when it may. Relay's
 * Chromium reads and writes Claude's LevelDB itself, so both must be the same major version:
 * another one could migrate or rebuild the database.
 */
export function electronMismatch(
  claudeVersion: string | undefined,
  relayVersion: string | undefined,
): string | undefined {
  const claude = electronMajor(claudeVersion);
  if (claude === undefined) return ELECTRON_UNKNOWN;
  const relay = electronMajor(relayVersion);
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
