import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  jsonBytes,
  writeBytes,
  type CarriedConversation,
} from "./desktop-files";
import {
  DRAFT_KEY_PREFIX,
  selectDrafts,
  type CapturedDraft,
} from "./drafts";
import { copyLocalStorage, sweepDraftLeftovers } from "./draft-storage";
import { MAX_SIDEBAR_CHARS, SIDEBAR_KEYS } from "./sidebar-keys";
import type { DraftSlots } from "./draft-vault";
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
/** Why a step stops when Claude is open: a copy of a leveldb Claude is writing could be torn. */
export const CLAUDE_RUNNING = "Claude is running";
/** Most characters of an error or reason `last.json` keeps. */
const MAX_REASON_CHARS = 300;

export type CaptureOutcome =
  | { status: "captured"; count: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/**
 * The draft step of a switch, while Claude is closed: reads the unsent drafts of account `from`
 * and hands those worth re-typing for account `to` to `store`, as `selectDrafts` picks them
 * from the carried `conversations`, with B's `titles`.
 *
 * Nothing in Claude's directory is written. Its leveldb is copied into a new scratch dir in
 * `tmp` (os.tmpdir() when unset), as `<scratch>/copy/leveldb`, and `run` reads only that copy.
 * The scratch dir, which holds the copy and the helper's result file and so the drafts' text,
 * is removed whatever happens. Before the copy, scratch dirs left in `tmp` by an earlier step
 * and what the first design left in Claude's Local Storage are swept.
 *
 * `blocked`, when set, says why drafts cannot be read now. `claudeElectron` is the Electron
 * version the same gate read from Claude.app; the helper refuses to open the copy under another
 * major. With `blocked`, or without `claudeElectron`, the step is skipped before anything is
 * swept or copied. `running`, when given, is asked once the copy is made: a Claude that opened
 * meanwhile, or a check that throws, skips the step before the run, and the copy is dropped.
 *
 * After a successful read, `store` gets the drafts kept, possibly none, and the slots read for
 * `to`: every carried conversation and the new-session screen. `sidebar`, when given, gets the
 * sidebar keys the helper read (undefined when it read none) before that; whatever it does, it
 * never changes the step's outcome.
 *
 * A run that fails, throws or answers nothing, and a copy or a store that fails, end the step
 * as failed. The outcome is written to `lastJson` (`<vault>/drafts/last.json`) with counts and
 * reasons cut to 300 characters, never draft text. Never throws.
 */
export async function captureDrafts(input: {
  root: string;
  from: string;
  to: string;
  conversations: CarriedConversation[];
  titles: Record<string, string>;
  run: (job: DraftJob) => Promise<DraftResult>;
  store: (to: string, drafts: CapturedDraft[], slots: DraftSlots) => Promise<void>;
  sidebar?: (raw: Record<string, string> | undefined) => Promise<void>;
  lastJson: string;
  now: Date;
  blocked?: string;
  claudeElectron?: string;
  running?: () => Promise<boolean>;
  tmp?: string;
}): Promise<CaptureOutcome> {
  let outcome: CaptureOutcome;
  try {
    outcome = await capture(input);
  } catch (error) {
    outcome = { status: "failed", error: errorMessage(error) };
  }
  // Whatever produced an error or a reason, only its start is kept.
  if (outcome.status === "failed")
    outcome = { ...outcome, error: outcome.error.slice(0, MAX_REASON_CHARS) };
  else if (outcome.status === "skipped")
    outcome = { ...outcome, reason: outcome.reason.slice(0, MAX_REASON_CHARS) };
  try {
    // Written as `drafts/last.json` under the vault, so a linked drafts dir is refused too.
    const drafts = path.dirname(input.lastJson);
    await writeBytes(
      path.dirname(drafts),
      path.join(path.basename(drafts), path.basename(input.lastJson)),
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

async function capture(
  input: Parameters<typeof captureDrafts>[0],
): Promise<CaptureOutcome> {
  // All before the sweeps, so a skipped step deletes nothing.
  if (input.blocked) return { status: "skipped", reason: input.blocked };
  const claudeElectron = input.claudeElectron;
  if (!claudeElectron) return { status: "skipped", reason: ELECTRON_UNKNOWN };
  const tmp = input.tmp ?? os.tmpdir();
  await sweepStaleDraftScratch(tmp);
  await sweepDraftLeftovers(input.root);

  const scratch = await fs.mkdtemp(path.join(tmp, SCRATCH_PREFIX));
  try {
    const storage = path.join(scratch, "copy");
    if (!(await copyLocalStorage(input.root, storage)))
      return { status: "skipped", reason: "no Local Storage" };
    if (input.running) {
      let running = true; // Unknown counts as running.
      try {
        running = await input.running();
      } catch {}
      if (running) return { status: "skipped", reason: CLAUDE_RUNNING };
    }
    const result: DraftResult | undefined = await input.run({
      storage,
      scratch,
      result: path.join(scratch, "result.json"),
      claudeElectron,
    });
    if (result?.ok !== true)
      return {
        status: "failed",
        error:
          result?.ok === false && result.error ? result.error : "no result",
      };
    try {
      await input.sidebar?.(result.sidebar);
    } catch {
      // The sidebar is a side matter of the step: the drafts still go on.
    }
    const drafts = selectDrafts({
      drafts: result.drafts,
      from: input.from,
      conversations: input.conversations,
      titles: input.titles,
    });
    // Even with none kept: an older draft in a slot read here is no longer the account's.
    await input.store(input.to, drafts, {
      aliases: input.conversations.map(({ targetAlias }) => targetAlias),
      newSession: true,
    });
    return { status: "captured", count: drafts.length };
  } finally {
    // The helper leaves a link to the copy in here. rm removes the link itself, never what it
    // points to.
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Removes the helper scratch dirs in `tmp` that are older than ten minutes: a Relay that crashed
 * or was killed mid-step leaves one behind, with its copy, its link and the helper's result.
 * Run before every step and when Relay starts. Never throws.
 */
export async function sweepStaleDraftScratch(tmp: string): Promise<void> {
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

/** The largest result file Relay reads: well above a real answer, capped at 4 MiB of text. */
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

/**
 * Starts the draft helper on `job` and resolves with its result once it has exited, or been
 * killed past its time. The result file is read only then, only when it is a plain file of at
 * most 16 MiB, and removed right after: it holds the drafts' text.
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
    // lstat, so a link is not followed. Anything else is no result.
    const st = await fs.lstat(job.result);
    if (st.isFile() && st.size <= MAX_RESULT_BYTES)
      text = await deps.readFile(job.result, "utf8");
  } catch {
    // No result file: helperOutcome reports it.
  } finally {
    // Before the text is parsed. The scratch dir goes later, whatever this leaves.
    await fs.rm(job.result, { force: true }).catch(() => {});
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
 * for: until it is gone it may still have the copy open, or write its result file, and the
 * scratch dir that holds both must not be removed before.
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
 * The sidebar keys of a helper's answer, or undefined when it is not a plain map from
 * `SIDEBAR_KEYS` to strings within the limit.
 */
function validSidebar(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const sidebar: Record<string, string> = {};
  let chars = 0;
  for (const [key, text] of Object.entries(value)) {
    if (!(SIDEBAR_KEYS as readonly string[]).includes(key) || typeof text !== "string")
      return undefined;
    chars += key.length + text.length;
    if (chars > MAX_SIDEBAR_CHARS) return undefined;
    sidebar[key] = text;
  }
  return sidebar;
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
  // A sidebar answer that is off is only left out: the drafts stand on their own.
  const sidebar = validSidebar(result.sidebar);
  return { ok: true, drafts, ...(sidebar ? { sidebar } : {}) };
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

/** Why drafts cannot be captured on this machine, or undefined when they can. */
export function draftsBlockedReason(
  platform: string,
  claudeVersion: string | undefined,
  relayVersion: string | undefined,
): string | undefined {
  if (platform !== "darwin") return "drafts move only on macOS";
  return electronMismatch(claudeVersion, relayVersion);
}
