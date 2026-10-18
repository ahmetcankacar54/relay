import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readObject, readBytes, safeFile, scopePath } from "./desktop-files";
import { TranscriptScanner, type TranscriptSummary } from "./transcript-scan";
import type { Account } from "../../shared/types";
import type { Store } from "./store";
import type { DesktopManager } from "./desktop";
import {
  privateJournalDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./continuation-journal";
import type {
  ContinuationCheckpoint,
  ContinuationDelivery,
  ContinuationIdentity,
  ContinuationReceipt,
  ContinuationSession,
} from "./continuation";
import {
  DesktopAutomationError,
  type DesktopAutomation,
  type DesktopAutomationSnapshot,
  type DesktopContinuationEvidence,
  type DesktopContinuationObservation,
} from "./desktop-continuation-host";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST = /^[A-Za-z0-9._:-]{1,128}$/;
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
type Row = Record<string, any>;
export interface DesktopProcess {
  pid: number;
  ppid: number;
  executable: string;
  args: string;
}

/** Native installs use a version filename; npm installs can run under Node. */
export function isDesktopClaudeEngine(process: DesktopProcess): boolean {
  const executable = process.executable.replaceAll("\\", "/");
  if (
    /(?:^|\/)claude(?:-code)?(?:\.exe)?$/i.test(executable) ||
    /\/claude-code\//i.test(executable) ||
    /\/(?:\.local\/share\/claude\/versions|\.claude\/local)\/[^/]+$/i.test(
      executable,
    )
  )
    return true;
  // Restrict argument-based recognition to JS runtimes. A shell's task prompt or
  // an unrelated process mentioning a package path must not masquerade as the
  // one permitted source engine.
  if (!/(?:^|\/)(?:node|nodejs|bun)(?:\.exe)?$/i.test(executable)) return false;
  const entryPrefix = process.args.replaceAll("\\", "/").split(/\s+--/)[0];
  if (entryPrefix.includes("/node_modules/@anthropic-ai/claude-code/"))
    return true;
  return /(?:^|\s)\/(?:[^\s]*\/)?claude(?:-code)?(?:\.(?:js|cjs|mjs))?(?=\s|$)/i.test(
    entryPrefix,
  );
}

/** Parse two OS snapshots rather than splitting executable paths on spaces. */
export function combineDesktopProcesses(
  commands: string,
  arguments_: string,
): string {
  const args = new Map<number, string>();
  for (const line of arguments_.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) args.set(Number(m[1]), m[2]);
  }
  const processes = commands
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!m)
        throw new DesktopAutomationError("desktop-observation-incomplete");
      const pid = Number(m[1]);
      return {
        pid,
        ppid: Number(m[2]),
        executable: m[3],
        args: args.get(pid) ?? "",
      };
    });
  return JSON.stringify(processes);
}
async function collectProcesses() {
  const [commands, arguments_] = await Promise.all([
    exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
    }),
    exec("/bin/ps", ["-axo", "pid=,args="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
    }),
  ]);
  return combineDesktopProcesses(commands.stdout, arguments_.stdout);
}
function collectProcessesSync() {
  return combineDesktopProcesses(
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
      encoding: "utf8",
    }),
    execFileSync("/bin/ps", ["-axo", "pid=,args="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
      encoding: "utf8",
    }),
  );
}

/** A local Code conversation whose latest turn ended with a usage limit. */
export interface QuotaStop {
  localSessionId: string;
  cliSessionId: string;
  projectKey: string;
  /** Claude's UI label for the conversation's mode, when it is one Relay restores. */
  permissionMode?: string;
  turnId: string;
  stoppedAt: number;
  transcriptRelative: string;
  transcriptBytes: number;
  transcriptSha256: string;
}
/** Index values to the labels Claude shows; bypass and others are left alone. */
export function uiPermissionMode(value: unknown) {
  return (
    {
      default: "Manual",
      auto: "Auto",
      plan: "Plan",
      acceptEdits: "Accept edits",
    } as Record<string, string>
  )[typeof value === "string" ? value : ""];
}
/** Inputs measured outside the process table. */
export interface QuiescenceInputs {
  /** Recently written Claude Code transcripts, other than the selected one, whose turn is unfinished. */
  busyTranscripts?: number;
  /** Processes whose CPU time advanced since the previous observation. Undefined: not measured yet. */
  activePids?: ReadonlySet<number>;
}

/**
 * Decide whether restarting Claude would interrupt work.
 *
 * Desktop keeps one Claude Code engine alive per open conversation, wrapped in a
 * `disclaimer` helper, even when the conversation is idle. Engine activity is
 * therefore judged from transcripts (an unfinished turn is busy), not from the
 * mere presence of a process. Any other process Claude started (a tool, a
 * background job, an MCP server) blocks only while it is using CPU. Processes
 * outside Claude's tree, such as a terminal Claude Code CLI or the browser
 * extension's native host, are unaffected by a Desktop restart and are ignored.
 */
export function desktopProcessQuiescence(
  raw: string,
  appPid: number,
  sessionId: string,
  selectedStopped: boolean,
  inputs: QuiescenceInputs = {},
) {
  const result = {
    coverage: "unknown" as "unknown" | "guarded-local",
    busyWorkers: 0,
    subagents: 0,
    pendingTasks: 0,
    waiting: 0,
    queuedPrompts: 0,
    scheduledWakeups: 0,
    unknownWork: 0,
  };
  let rows: DesktopProcess[];
  try {
    const input = JSON.parse(raw);
    if (!Array.isArray(input) || input.length > 100_000) throw 0;
    rows = input;
    const seen = new Set<number>();
    for (const r of rows) {
      if (
        !Number.isSafeInteger(r.pid) ||
        r.pid <= 0 ||
        !Number.isSafeInteger(r.ppid) ||
        r.ppid < 0 ||
        seen.has(r.pid) ||
        typeof r.executable !== "string" ||
        typeof r.args !== "string"
      )
        throw 0;
      seen.add(r.pid);
    }
    if (!rows.some((r) => r.pid === appPid)) throw 0;
  } catch {
    result.unknownWork = 1;
    return result;
  }
  const app = rows.find((r) => r.pid === appPid)!;
  if (!/\/Claude\.app\/Contents\/MacOS\/Claude$/.test(app.executable)) {
    result.unknownWork = 1;
    return result;
  }
  const bundle = app.executable.slice(0, app.executable.indexOf(".app/") + 5);
  const descendants = new Set<number>([appPid]);
  let prior = -1;
  while (prior !== descendants.size) {
    prior = descendants.size;
    for (const row of rows)
      if (descendants.has(row.ppid)) descendants.add(row.pid);
  }
  // The selected conversation itself must have finished its turn.
  if (!selectedStopped) result.busyWorkers++;
  result.busyWorkers += inputs.busyTranscripts ?? 0;
  for (const row of rows) {
    if (row.pid === appPid || !descendants.has(row.pid)) continue;
    // Claude's own helpers (Chromium processes, engine wrappers, crash reporter).
    if (row.executable.startsWith(`${bundle}Contents/`)) continue;
    if (isDesktopClaudeEngine(row)) continue;
    if (!inputs.activePids || inputs.activePids.has(row.pid))
      result.unknownWork++;
  }
  result.coverage = "guarded-local";
  return result;
}

/** Turn state of a transcript's main chain: an unfinished turn means work is in progress. */
export function transcriptTurnState(rows: Row[]): "idle" | "busy" {
  const tail = rows
    .filter(
      (r) =>
        !r.isSidechain && !r.isMeta && ["user", "assistant"].includes(r.type),
    )
    .at(-1);
  if (!tail) return "idle";
  if (tail.type === "user")
    return /^\[Request interrupted/.test(transcriptMessageText(tail).trim())
      ? "idle"
      : "busy";
  if (transcriptError(tail)) return "idle";
  const content = tail.message?.content;
  if (Array.isArray(content) && content.some((c) => c?.type === "tool_use"))
    return "busy";
  return ["end_turn", "stop_sequence", "max_tokens", "refusal"].includes(
    tail.message?.stop_reason,
  )
    ? "idle"
    : "busy";
}

/** Parse `ps -o pid=,time=` cumulative CPU times ([dd-][hh:]mm:ss.ss) in seconds. */
export function parseCpuTimes(output: string) {
  const times = new Map<number, number>();
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(?:(\d+)-)?([\d:.]+)\s*$/.exec(line);
    if (!m) continue;
    const parts = m[3].split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) continue;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    times.set(Number(m[1]), seconds + Number(m[2] ?? 0) * 86_400);
  }
  return times;
}
/** Transcripts written within this window are considered possibly live. */
const LIVE_TRANSCRIPT_MS = 2 * 60 * 60_000;
/** CPU seconds a process may use between observations and still count as idle. */
const IDLE_CPU_SECONDS = 0.3;
const TAIL_BYTES = 512 * 1024;
/** A conversation no project folder held is probed across every folder at most this often. */
const FOLDER_PROBE_MS = 60_000;

function transcriptTail(data: Buffer) {
  const start = Math.max(0, data.length - TAIL_BYTES);
  const rows: Row[] = [];
  for (const line of data
    .subarray(start)
    .toString("utf8")
    .split("\n")
    .slice(start ? 1 : 0)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
    } catch {
      // A line Claude is still appending; the next observation reads it.
    }
  }
  return rows;
}

interface CheckpointRecord {
  version: 1;
  requestId: string;
  checkpoint: ContinuationCheckpoint;
  source: ContinuationIdentity;
  target?: ContinuationIdentity;
  localSessionId: string;
  transcriptRelative: string;
  transcriptBytes: number;
  transcriptSha256: string;
  createdAt: number;
}
export interface DesktopEvidenceOptions {
  store: Store;
  desktop: DesktopManager;
  automation: DesktopAutomation;
  claudeRoot: string;
  transcriptRoot: string;
  processes?: () => Promise<string>;
  processesSync?: () => string;
  /** `ps -axo pid=,time=` output; injectable for tests. */
  cpuTimes?: () => string | Promise<string>;
  now?: () => number;
}
export function transcriptMessageText(row: Row) {
  const content = row.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}
export function parseDesktopTranscript(data: Buffer) {
  if (
    data.length > 64 * 1024 * 1024 ||
    (data.length && data[data.length - 1] !== 10)
  )
    throw new DesktopAutomationError("desktop-observation-incomplete");
  const rows: Row[] = [];
  for (const line of data.toString("utf8").split("\n")) {
    if (!line) continue;
    if (line.length > 2_097_152)
      throw new DesktopAutomationError("desktop-observation-incomplete");
    let row: Row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new DesktopAutomationError("desktop-observation-incomplete");
    }
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new DesktopAutomationError("desktop-observation-incomplete");
    rows.push(row);
  }
  return rows;
}
/** Use the same persisted error forms for stop detection and delivery receipts. */
function transcriptError(row: Row): "quota" | "other" | undefined {
  const reasons = [
    row.error,
    row.error?.type,
    row.errorType,
    row.apiError?.type,
    row.message?.stop_reason,
  ];
  if (
    reasons.some((reason) =>
      ["rate_limit", "rate_limit_error", "rate-limit", "usage_limit"].includes(
        reason,
      ),
    )
  )
    return "quota";
  if (
    row.isApiErrorMessage === true ||
    row.error ||
    row.errorType ||
    row.apiError
  )
    return "other";
  return undefined;
}

export function latestQuotaEndedTurn(rows: Row[]) {
  const turns = rows.filter(
    (r) =>
      !r.isSidechain && !r.isMeta && ["user", "assistant"].includes(r.type),
  );
  const tail = turns.at(-1);
  if (!tail || tail.type !== "assistant" || !UUID.test(tail.uuid ?? "")) return;
  if (transcriptError(tail) !== "quota") return;
  return {
    turnId: tail.uuid as string,
    timestamp: Date.parse(tail.timestamp ?? ""),
  };
}

export function continuationTurn(rows: Row[], requestId?: string) {
  const users = rows.filter(
    (r) =>
      r.type === "user" &&
      !r.isMeta &&
      !r.isSidechain &&
      transcriptMessageText(r),
  );
  const user = users.at(-1);
  if (!user || !UUID.test(user.uuid ?? "")) return;
  const marker = /\[Relay continuation: ([A-Za-z0-9._:-]{1,128})\]\s*$/.exec(
    transcriptMessageText(user),
  );
  if (!marker || (requestId && marker[1] !== requestId)) return;
  const byId = new Map(
    rows.filter((r) => UUID.test(r.uuid ?? "")).map((r) => [r.uuid, r]),
  );
  const descends = (row: Row) => {
    let cursor: Row | undefined = row;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.uuid)) {
      if (cursor.uuid === user.uuid) return true;
      seen.add(cursor.uuid);
      cursor = byId.get(cursor.parentUuid);
    }
    return false;
  };
  // The resumed turn alternates assistant and tool-result rows while it works.
  // Its latest successful assistant row in the marker's chain proves it started.
  // A persisted API error alone (for example another quota stop) only proves
  // the input was accepted, never that work resumed.
  const assistants = rows.filter(
    (r) =>
      r.type === "assistant" &&
      !r.isMeta &&
      !r.isSidechain &&
      UUID.test(r.uuid ?? ""),
  );
  const chained = assistants.filter(descends);
  if (assistants.length && !chained.length) return;
  const started = chained.filter((r) => !transcriptError(r)).at(-1);
  return started
    ? { requestId: marker[1], user, assistant: started }
    : { requestId: marker[1], user };
}

export class NativeDesktopContinuationEvidence implements DesktopContinuationEvidence {
  private readonly recordsRoot: string;
  private readonly now: () => number;
  private revision = 0;
  private signature = "";
  private last?: DesktopContinuationObservation;
  constructor(private readonly options: DesktopEvidenceOptions) {
    this.recordsRoot = path.join(
      options.store.root,
      "continuation-checkpoints",
    );
    this.now = options.now ?? Date.now;
    privateJournalDirectory(this.recordsRoot);
  }
  private cpu?: { at: number; times: Map<number, number> };
  private family = new Set<number>();
  private readonly scanner = new TranscriptScanner();
  /** Each conversation's project folder, from a probe of every folder that found it in one. */
  private readonly projectFolders = new Map<string, string>();
  /** When each conversation no single folder held was last probed. */
  private readonly unplaced = new Map<string, number>();
  /** Count other recently written transcripts whose turn is unfinished. */
  private busyTranscripts(excluded: ReadonlySet<string>) {
    const root = path.join(this.options.transcriptRoot, "projects");
    const cutoff = this.now() - LIVE_TRANSCRIPT_MS;
    let busy = 0;
    let folders: fsSync.Dirent[];
    try {
      folders = fsSync.readdirSync(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      let names: string[];
      try {
        names = fsSync.readdirSync(path.join(root, folder.name));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const relative = `projects/${folder.name}/${name}`;
        if (excluded.has(relative)) continue;
        const file = path.join(root, folder.name, name);
        try {
          const stat = fsSync.lstatSync(file);
          if (!stat.isFile() || stat.mtimeMs < cutoff) continue;
          const length = Math.min(stat.size, TAIL_BYTES);
          const buffer = Buffer.alloc(length);
          const fd = fsSync.openSync(file, "r");
          try {
            fsSync.readSync(fd, buffer, 0, length, stat.size - length);
          } finally {
            fsSync.closeSync(fd);
          }
          const data =
            stat.size > length
              ? Buffer.concat([Buffer.from("\n"), buffer])
              : buffer;
          if (transcriptTurnState(transcriptTail(data)) === "busy") busy++;
        } catch {
          busy++;
        }
      }
    }
    return busy;
  }
  /** Processes whose CPU time advanced since the previous sample (undefined on the first). */
  private async activePids() {
    const output = this.options.cpuTimes
      ? await this.options.cpuTimes()
      : (
          await exec("/bin/ps", ["-axo", "pid=,time="], {
            timeout: 3000,
            maxBuffer: 2_097_152,
          })
        ).stdout;
    return this.sampleCpu(output);
  }
  /** `activePids` for the synchronous checks right before a quit and each write. */
  private activePidsSync() {
    const output = this.options.cpuTimes
      ? this.options.cpuTimes()
      : execFileSync("/bin/ps", ["-axo", "pid=,time="], {
          timeout: 3000,
          maxBuffer: 2_097_152,
          encoding: "utf8",
        });
    // An injected reading that must be awaited cannot be here: not measured.
    return typeof output === "string" ? this.sampleCpu(output) : undefined;
  }
  private sampleCpu(output: string) {
    const times = parseCpuTimes(output);
    const now = this.now();
    const previous = this.cpu;
    this.cpu = { at: now, times };
    if (!previous || now - previous.at > 120_000) return undefined;
    const active = new Set<number>();
    for (const [pid, seconds] of times) {
      const before = previous.times.get(pid);
      if (before === undefined || seconds - before > IDLE_CPU_SECONDS)
        active.add(pid);
    }
    return active;
  }
  private async measure(
    excluded: string | ReadonlySet<string>,
  ): Promise<QuiescenceInputs> {
    const busyTranscripts = this.busyTranscripts(
      typeof excluded === "string" ? new Set([excluded]) : excluded,
    );
    return { busyTranscripts, activePids: await this.activePids() };
  }
  /** `measure` for the synchronous checks right before a quit and each write. */
  private measureSync(
    excluded: string | ReadonlySet<string>,
  ): QuiescenceInputs {
    return {
      busyTranscripts: this.busyTranscripts(
        typeof excluded === "string" ? new Set([excluded]) : excluded,
      ),
      activePids: this.activePidsSync(),
    };
  }
  /** Remember Claude's process tree so engines orphaned by a quit are noticed. */
  private remember(raw: string, appPid: number) {
    try {
      const rows = JSON.parse(raw) as DesktopProcess[];
      const family = new Set<number>([appPid]);
      let size = -1;
      while (size !== family.size) {
        size = family.size;
        for (const row of rows) if (family.has(row.ppid)) family.add(row.pid);
      }
      this.family = family;
    } catch {
      // Keep the previous family; an unreadable census already blocks.
    }
  }
  private async transcript(cliId: string, cwd: string) {
    const folders = await fs.readdir(
      path.join(this.options.transcriptRoot, "projects"),
      { withFileTypes: true },
    );
    const found: { relative: string; data: Buffer; rows: Row[] }[] = [];
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const relative = `projects/${folder.name}/${cliId}.jsonl`;
      const data = await readBytes(this.options.transcriptRoot, relative);
      if (!data) continue;
      const rows = parseDesktopTranscript(data);
      // Rows record the shell's working directory, which moves as tools `cd`.
      // The session belongs to the project if any row was written from it.
      const paths = rows
        .filter((row) => typeof row.cwd === "string")
        .map((row) => path.resolve(row.cwd));
      if (!paths.includes(path.resolve(cwd)))
        throw new DesktopAutomationError("exact-session-not-observed");
      found.push({ relative, data, rows });
    }
    if (found.length !== 1)
      throw new DesktopAutomationError("exact-session-not-observed");
    return found[0];
  }
  /**
   * `transcript` for quota-stop polling: the same file and project checks, but
   * read incrementally instead of loading and parsing every row on each poll.
   * Each file looked at is added to `scanned`.
   */
  private async scannedTranscript(
    cliId: string,
    cwd: string,
    folders: () => Promise<string[]>,
    scanned: Set<string>,
  ) {
    // The folder a probe found it in alone is looked at first, and alone.
    const known = this.projectFolders.get(cliId);
    if (known !== undefined) {
      const found = await this.scannedIn([known], cliId, cwd, scanned);
      if (found.length === 1) return found[0];
      this.projectFolders.delete(cliId);
    }
    const now = this.now();
    for (const [id, at] of this.unplaced)
      if (now - at >= FOLDER_PROBE_MS || now < at) this.unplaced.delete(id);
    if (this.unplaced.has(cliId))
      throw new DesktopAutomationError("exact-session-not-observed");
    // A transcript still being written fails here and is probed again next time.
    const found = await this.scannedIn(await folders(), cliId, cwd, scanned);
    if (found.length !== 1) {
      this.unplaced.set(cliId, now);
      throw new DesktopAutomationError("exact-session-not-observed");
    }
    this.projectFolders.set(cliId, found[0].folder);
    return found[0];
  }
  /** The transcripts of `cliId` in `folders`, each scanned and added to `scanned`. */
  private async scannedIn(
    folders: string[],
    cliId: string,
    cwd: string,
    scanned: Set<string>,
  ) {
    const found: {
      folder: string;
      relative: string;
      summary: TranscriptSummary;
    }[] = [];
    for (const folder of folders) {
      const relative = `projects/${folder}/${cliId}.jsonl`;
      const file = path.resolve(this.options.transcriptRoot, relative);
      try {
        await fs.lstat(file);
      } catch (error: any) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      // No symbolic link anywhere on the path, as readBytes requires.
      await safeFile(this.options.transcriptRoot, relative);
      scanned.add(file);
      const summary = await this.scanner.scan(file);
      if (!summary.cwds.has(path.resolve(cwd)))
        throw new DesktopAutomationError("exact-session-not-observed");
      found.push({ folder, relative, summary });
    }
    return found;
  }
  /**
   * Local Code conversations of `account` whose latest turn ended with a usage
   * limit within `withinMs`, most recent first. Read from Claude's index and
   * transcripts only; nothing in Claude is touched.
   */
  async quotaStops(
    account: Account,
    withinMs = 6 * 60 * 60_000,
  ): Promise<QuotaStop[]> {
    if (!account.desktop) return [];
    const relative = scopePath("claude-code-sessions", account.desktop);
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.options.claudeRoot, relative));
    } catch {
      return [];
    }
    const cutoff = this.now() - withinMs;
    const stops: QuotaStop[] = [];
    let listing: Promise<string[]> | undefined;
    const folders = () =>
      (listing ??= fs
        .readdir(path.join(this.options.transcriptRoot, "projects"), {
          withFileTypes: true,
        })
        .then((entries) =>
          entries.filter((entry) => entry.isDirectory()).map((e) => e.name),
        ));
    const scanned = new Set<string>();
    for (const name of names) {
      const local = /^(local_[0-9a-f-]{36})\.json$/i.exec(name);
      if (!local) continue;
      // Polled every few seconds: skip records untouched since the window.
      try {
        const stat = await fs.stat(
          path.join(this.options.claudeRoot, relative, name),
        );
        if (stat.mtimeMs < cutoff) continue;
      } catch {
        continue;
      }
      let metadata;
      try {
        metadata = await readObject(
          this.options.claudeRoot,
          `${relative}/${name}`,
        );
      } catch {
        continue;
      }
      if (
        !metadata ||
        metadata.archived ||
        metadata.isArchived ||
        !UUID.test(metadata.cliSessionId ?? "") ||
        typeof metadata.cwd !== "string" ||
        !path.isAbsolute(metadata.cwd) ||
        !(Number(metadata.lastActivityAt) >= cutoff)
      )
        continue;
      let transcript;
      try {
        transcript = await this.scannedTranscript(
          metadata.cliSessionId,
          metadata.cwd,
          folders,
          scanned,
        );
      } catch {
        continue;
      }
      const { last } = transcript.summary;
      const ended = latestQuotaEndedTurn(last ? [last] : []);
      if (
        !ended ||
        !Number.isFinite(ended.timestamp) ||
        ended.timestamp < cutoff ||
        ended.timestamp > this.now()
      )
        continue;
      stops.push({
        localSessionId: local[1],
        cliSessionId: metadata.cliSessionId.toLowerCase(),
        projectKey: path.resolve(metadata.cwd),
        permissionMode: uiPermissionMode(metadata.permissionMode),
        turnId: ended.turnId,
        stoppedAt: ended.timestamp,
        transcriptRelative: transcript.relative,
        transcriptBytes: transcript.summary.bytes,
        transcriptSha256: transcript.summary.sha256,
      });
    }
    this.scanner.retain(scanned);
    return stops.sort((a, b) => b.stoppedAt - a.stoppedAt);
  }
  /**
   * Why restarting Claude would interrupt work other than these stopped
   * conversations, or undefined when nothing else is running.
   */
  async quietExcept(stops: QuotaStop[]) {
    const raw = await (this.options.processes ?? collectProcesses)();
    const app = this.claudeApp(raw);
    if (typeof app !== "number") return app;
    return this.quietReason(
      raw,
      app,
      await this.measure(new Set(stops.map((stop) => stop.transcriptRelative))),
    );
  }
  /** Synchronous variant for the checks immediately before quit and writes. */
  quietExceptSync(stops: QuotaStop[]) {
    const raw = (this.options.processesSync ?? collectProcessesSync)();
    const app = this.claudeApp(raw);
    if (typeof app !== "number") return app;
    return this.quietReason(
      raw,
      app,
      this.measureSync(new Set(stops.map((stop) => stop.transcriptRelative))),
    );
  }
  /** Claude's main pid in a census, its tree remembered; undefined while Claude is closed. */
  private claudeApp(raw: string): number | "quiescence-unverified" | undefined {
    let rows: DesktopProcess[];
    try {
      rows = JSON.parse(raw);
    } catch {
      return "quiescence-unverified";
    }
    const app = rows.find((row) =>
      /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(row.executable),
    );
    // A closed Claude cannot be interrupted.
    if (!app) return undefined;
    this.remember(raw, app.pid);
    return app.pid;
  }
  private quietReason(raw: string, appPid: number, inputs: QuiescenceInputs) {
    const q = desktopProcessQuiescence(raw, appPid, "", true, inputs);
    if (q.coverage !== "guarded-local") return "quiescence-unverified";
    for (const [key, value] of Object.entries(q))
      if (key !== "coverage" && value !== 0) return `not-quiescent:${key}`;
    return undefined;
  }
  /** The stopped transcript still ends where it was observed. */
  unchanged(stop: QuotaStop) {
    try {
      const data = fsSync.readFileSync(
        path.join(this.options.transcriptRoot, stop.transcriptRelative),
      );
      return (
        data.length === stop.transcriptBytes &&
        sha(data) === stop.transcriptSha256
      );
    } catch {
      return false;
    }
  }
  /** Delivery of one continuation marker appended after the observed stop. */
  async deliveryAfter(
    stop: QuotaStop,
    requestId: string,
  ): Promise<"absent" | "accepted" | "started" | "unknown"> {
    const data = await readBytes(
      this.options.transcriptRoot,
      stop.transcriptRelative,
    );
    if (
      !data ||
      data.length < stop.transcriptBytes ||
      sha(data.subarray(0, stop.transcriptBytes)) !== stop.transcriptSha256
    )
      return "unknown";
    let appended: Row[];
    try {
      appended = parseDesktopTranscript(data.subarray(stop.transcriptBytes));
    } catch {
      return "unknown";
    }
    const marker = `[Relay continuation: ${requestId}]`;
    const users = appended.filter(
      (r) =>
        r.type === "user" &&
        !r.isMeta &&
        !r.isSidechain &&
        transcriptMessageText(r).includes(marker),
    );
    if (!users.length) return "absent";
    if (users.length !== 1) return "unknown";
    const turn = continuationTurn(appended, requestId);
    if (!turn || turn.user.uuid !== users[0].uuid) return "unknown";
    return turn.assistant ? "started" : "accepted";
  }
  async read(
    snapshot: DesktopAutomationSnapshot,
  ): Promise<DesktopContinuationObservation> {
    const desktop = await this.options.desktop.snapshot();
    if (
      !snapshot.localSessionId ||
      !desktop.currentAccountUuid ||
      desktop.recoveryRequired ||
      desktop.pendingProfileId
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    const aliases = this.options.store.state.accounts.filter(
      (account) =>
        account.desktop?.accountUuid.toLowerCase() ===
        desktop.currentAccountUuid!.toLowerCase(),
    );
    const matches = [];
    for (const account of aliases) {
      const metadata = await readObject(
        this.options.claudeRoot,
        `${scopePath("claude-code-sessions", account.desktop!)}/${snapshot.localSessionId}.json`,
      );
      if (metadata) matches.push({ account, metadata });
    }
    if (matches.length !== 1)
      throw new DesktopAutomationError("exact-session-not-observed");
    const { account, metadata } = matches[0];
    const scopes = desktop.organizations ?? [];
    const organizationLabel = account.auth?.orgName
      ?.trim()
      .normalize("NFC")
      .toLocaleLowerCase();
    const uiLabel = snapshot.accountLabel
      ?.trim()
      .normalize("NFC")
      .toLocaleLowerCase();
    const uniqueScope =
      scopes.length === 1 &&
      scopes[0].toLowerCase() === account.desktop!.orgId.toLowerCase();
    const labeledScope =
      organizationLabel &&
      uiLabel &&
      uiLabel.endsWith(organizationLabel) &&
      scopes.includes(account.desktop!.orgId);
    // An account often has empty folders for other organizations it belongs to,
    // and its UI label is usually a name, not the organization. The open
    // conversation's own record identifies the organization when it exists only
    // under the registered one.
    let sessionScope =
      !uniqueScope &&
      !labeledScope &&
      scopes.some(
        (org) => org.toLowerCase() === account.desktop!.orgId.toLowerCase(),
      );
    for (const org of sessionScope ? scopes : [])
      if (
        org.toLowerCase() !== account.desktop!.orgId.toLowerCase() &&
        (await readBytes(
          this.options.claudeRoot,
          `${scopePath("claude-code-sessions", { accountUuid: account.desktop!.accountUuid, orgId: org })}/${snapshot.localSessionId}.json`,
        ))
      )
        sessionScope = false;
    if (!uniqueScope && !labeledScope && !sessionScope)
      throw new DesktopAutomationError("desktop-observation-incomplete");
    if (
      !UUID.test(metadata.cliSessionId ?? "") ||
      typeof metadata.cwd !== "string" ||
      !path.isAbsolute(metadata.cwd) ||
      metadata.archived ||
      metadata.isArchived ||
      !snapshot.permissionMode
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    const transcript = await this.transcript(
      metadata.cliSessionId,
      metadata.cwd,
    );
    const tail = transcript.rows
      .filter(
        (r) =>
          ["user", "assistant"].includes(r.type) && !r.isMeta && !r.isSidechain,
      )
      .at(-1);
    const ended = latestQuotaEndedTurn(transcript.rows);
    const continuation = continuationTurn(transcript.rows);
    const now = this.now();
    const freshEnd =
      snapshot.quotaStopped &&
      snapshot.status === "stopped" &&
      ended &&
      Number.isFinite(ended.timestamp) &&
      ended.timestamp <= now;
    const selectedEnded =
      snapshot.status === "stopped" &&
      tail?.type === "assistant" &&
      (Boolean(ended) ||
        ["end_turn", "max_tokens", "stop_sequence"].includes(
          tail.message?.stop_reason,
        ));
    const processes = await (this.options.processes ?? collectProcesses)();
    this.remember(processes, snapshot.pid);
    const quiescence = desktopProcessQuiescence(
      processes,
      snapshot.pid,
      metadata.cliSessionId,
      selectedEnded,
      await this.measure(transcript.relative),
    );
    if (
      metadata.remoteSessionId ||
      metadata.sshHost ||
      metadata.sessionType === "remote" ||
      metadata.sessionType === "ssh"
    ) {
      quiescence.coverage = "unknown";
      quiescence.unknownWork++;
    }
    if (!snapshot.composerEmpty) quiescence.queuedPrompts++;
    if (snapshot.status === "waiting") quiescence.waiting++;
    // Work in other conversations is measured from transcripts and processes.
    // Labels such as "Running" or "Scheduled" also appear in ordinary rows, so
    // only the selected conversation's own quota-resume timer counts here.
    if (snapshot.quotaAutoResume) quiescence.scheduledWakeups++;
    const session: ContinuationSession = {
      id: metadata.cliSessionId.toLowerCase(),
      projectKey: path.resolve(metadata.cwd),
      transcriptRevision: sha(transcript.data),
      permissionMode: snapshot.permissionMode,
      status: snapshot.status,
      lastTurnId: UUID.test(tail?.uuid ?? "") ? tail!.uuid : undefined,
      lastRequestId: continuation?.requestId,
    };
    const identity = {
      profileId: account.id,
      accountUuid: account.desktop!.accountUuid.toLowerCase(),
      orgId: account.desktop!.orgId.toLowerCase(),
    };
    const signature = sha(
      JSON.stringify({
        identity,
        session,
        localSessionId: snapshot.localSessionId,
        ui: snapshot.contextFingerprint,
        quiescence,
      }),
    );
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision++;
    }
    const value: DesktopContinuationObservation = {
      contextRevision: this.revision,
      observedAt: now,
      identity,
      session,
      quiescence,
      localSessionId: snapshot.localSessionId,
      ownQuotaWakeup: Boolean(
        freshEnd &&
        snapshot.quotaAutoResume &&
        quiescence.scheduledWakeups === 1,
      ),
      ...(freshEnd
        ? {
            quotaStop: {
              sessionId: session.id,
              turnId: ended!.turnId,
              observedAt: now,
              reason: "rate-limit" as const,
            },
          }
        : {}),
    };
    this.last = value;
    return structuredClone(value);
  }
  private file(requestId: string) {
    if (!REQUEST.test(requestId))
      throw new DesktopAutomationError("desktop-ui-unsupported");
    return `${requestId}.json`;
  }
  async checkpoint(input: {
    requestId: string;
    session: ContinuationSession;
    expectedContextRevision: number;
  }) {
    const current = await this.read(await this.options.automation.inspect());
    if (
      current.contextRevision !== input.expectedContextRevision ||
      current.session.id !== input.session.id ||
      current.session.transcriptRevision !== input.session.transcriptRevision
    )
      throw new DesktopAutomationError("context-changed");
    const account = this.options.store.account(current.identity.profileId);
    const metadata = await readObject(
      this.options.claudeRoot,
      `${scopePath("claude-code-sessions", account.desktop!)}/${current.localSessionId}.json`,
    );
    const transcript = await this.transcript(input.session.id, metadata!.cwd);
    const checkpoint = {
      id: input.requestId,
      session: structuredClone(input.session),
    };
    const record: CheckpointRecord = {
      version: 1,
      requestId: input.requestId,
      checkpoint,
      source: current.identity,
      localSessionId: current.localSessionId,
      transcriptRelative: transcript.relative,
      transcriptBytes: transcript.data.length,
      transcriptSha256: sha(transcript.data),
      createdAt: this.now(),
    };
    writePrivateJson(
      path.join(this.recordsRoot, this.file(input.requestId)),
      record,
    );
    return checkpoint;
  }
  async localSessionId(checkpoint: ContinuationCheckpoint) {
    const record = await this.record(checkpoint.id);
    if (
      record.checkpoint.session.id !== checkpoint.session.id ||
      record.checkpoint.session.transcriptRevision !==
        checkpoint.session.transcriptRevision
    )
      throw new DesktopAutomationError("context-changed");
    return record.localSessionId;
  }
  private async record(requestId: string): Promise<CheckpointRecord> {
    const value = readPrivateJson(
      path.join(this.recordsRoot, this.file(requestId)),
    ) as CheckpointRecord;
    if (
      !value ||
      value.version !== 1 ||
      value.requestId !== requestId ||
      !value.checkpoint ||
      !/^local_[0-9a-f-]{36}$/i.test(value.localSessionId ?? "") ||
      !Number.isSafeInteger(value.transcriptBytes) ||
      !/^[a-f0-9]{64}$/.test(value.transcriptSha256 ?? "")
    )
      throw new DesktopAutomationError("desktop-observation-incomplete");
    return value as CheckpointRecord;
  }
  async switchAccount(input: {
    requestId: string;
    target: ContinuationIdentity;
    expectedContextRevision: number;
  }) {
    const current = await this.read(await this.options.automation.inspect());
    if (
      current.contextRevision !== input.expectedContextRevision ||
      current.quiescence.coverage !== "guarded-local" ||
      Object.entries(current.quiescence).some(
        ([key, value]) => key !== "coverage" && value !== 0,
      ) ||
      !current.quotaStop
    )
      throw new DesktopAutomationError("desktop-work-active");
    const target = this.options.store.account(input.target.profileId);
    if (
      target.desktop?.accountUuid.toLowerCase() !==
        input.target.accountUuid.toLowerCase() ||
      target.desktop?.orgId.toLowerCase() !== input.target.orgId.toLowerCase()
    )
      throw new DesktopAutomationError("context-changed");
    const record = await this.record(input.requestId);
    record.target = input.target;
    writePrivateJson(
      path.join(this.recordsRoot, this.file(input.requestId)),
      record,
    );
    // DesktopManager rechecks this predicate immediately before graceful quit and
    // before each write. No frozen last-known-safe process list authorizes restart.
    const canProceed = () => {
      try {
        const raw = (this.options.processesSync ?? collectProcessesSync)();
        const parsed = JSON.parse(raw) as DesktopProcess[];
        if (!parsed.some((p) => p.pid === currentSnapshot.pid)) {
          // After graceful quit, an engine of the old Claude that is still alive
          // could still write; a newly started Claude also blocks the write.
          return !parsed.some(
            (p) =>
              (this.family.has(p.pid) && isDesktopClaudeEngine(p)) ||
              /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(p.executable),
          );
        }
        this.remember(raw, currentSnapshot.pid);
        const q = desktopProcessQuiescence(
          raw,
          currentSnapshot.pid,
          current.session.id,
          true,
          this.measureSync(record.transcriptRelative),
        );
        const config = JSON.parse(
          fsSync.readFileSync(
            path.join(this.options.claudeRoot, "config.json"),
            "utf8",
          ),
        );
        const unchanged =
          sha(
            fsSync.readFileSync(
              path.join(this.options.transcriptRoot, record.transcriptRelative),
            ),
          ) === current.session.transcriptRevision;
        return (
          unchanged &&
          config.lastKnownAccountUuid?.toLowerCase() ===
            current.identity.accountUuid &&
          q.coverage === "guarded-local" &&
          Object.entries(q).every(
            ([key, value]) => key === "coverage" || value === 0,
          )
        );
      } catch {
        return false;
      }
    };
    const currentSnapshot = await this.options.automation.inspect();
    const beforeQuit = async () => {
      const fresh = await this.read(await this.options.automation.inspect());
      if (
        fresh.contextRevision !== input.expectedContextRevision ||
        fresh.identity.profileId !== current.identity.profileId ||
        fresh.session.id !== current.session.id ||
        fresh.session.transcriptRevision !==
          current.session.transcriptRevision ||
        fresh.session.permissionMode !== current.session.permissionMode ||
        fresh.session.status !== "stopped" ||
        !fresh.quotaStop ||
        fresh.quiescence.coverage !== "guarded-local" ||
        Object.entries(fresh.quiescence).some(
          ([key, value]) => key !== "coverage" && value !== 0,
        )
      )
        throw new DesktopAutomationError("desktop-work-active");
    };
    await this.options.desktop.switchTo(input.target.profileId, {
      canProceed,
      beforeQuit,
    });
    // Graceful launch is asynchronous and can land on a homepage. Establish the
    // exact target alias before the engine's post-switch identity/session read.
    let lastIssue: unknown;
    // Claude may need a while after a cold launch, and a link delivered before
    // its Code view is ready can be dropped: resend it every five seconds.
    let openedAt = -Infinity;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const desktop = await this.options.desktop.snapshot();
        if (
          desktop.currentAccountUuid?.toLowerCase() !==
          input.target.accountUuid.toLowerCase()
        )
          throw new DesktopAutomationError("context-changed");
        const view = await this.options.automation.inspect();
        if (view.localSessionId !== record.localSessionId) {
          if (Date.now() - openedAt >= 5_000) {
            openedAt = Date.now();
            await this.options.automation.openSession(record.localSessionId);
          }
        } else {
          const targetState = await this.read(view);
          if (
            targetState.identity.profileId !== input.target.profileId ||
            targetState.session.id !== record.checkpoint.session.id ||
            targetState.session.projectKey !==
              record.checkpoint.session.projectKey ||
            targetState.session.transcriptRevision !==
              record.checkpoint.session.transcriptRevision
          )
            throw new DesktopAutomationError("exact-session-not-observed");
          return;
        }
      } catch (error) {
        lastIssue = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw lastIssue ?? new DesktopAutomationError("exact-session-not-observed");
  }
  async lookupDelivery(requestId: string): Promise<ContinuationDelivery> {
    let record: CheckpointRecord;
    try {
      record = await this.record(requestId);
    } catch {
      return { status: "unknown" };
    }
    const data = await readBytes(
      this.options.transcriptRoot,
      record.transcriptRelative,
    );
    if (
      !data ||
      data.length < record.transcriptBytes ||
      sha(data.subarray(0, record.transcriptBytes)) !== record.transcriptSha256
    )
      return { status: "unknown" };
    const appended = parseDesktopTranscript(
      data.subarray(record.transcriptBytes),
    );
    const marker = `[Relay continuation: ${requestId}]`;
    const users = appended.filter(
      (r) =>
        r.type === "user" &&
        !r.isMeta &&
        !r.isSidechain &&
        transcriptMessageText(r).includes(marker),
    );
    if (!users.length) return { status: "absent" };
    if (users.length !== 1 || !record.target || !UUID.test(users[0].uuid ?? ""))
      return { status: "unknown" };
    const state = await this.read(await this.options.automation.inspect());
    if (
      state.identity.profileId !== record.target.profileId ||
      state.identity.accountUuid !== record.target.accountUuid ||
      state.identity.orgId !== record.target.orgId ||
      state.session.id !== record.checkpoint.session.id ||
      state.session.projectKey !== record.checkpoint.session.projectKey ||
      state.session.permissionMode !==
        record.checkpoint.session.permissionMode ||
      state.localSessionId !== record.localSessionId
    )
      return { status: "unknown" };
    const turn = continuationTurn(appended, requestId);
    if (!turn || turn.user.uuid !== users[0].uuid) return { status: "unknown" };
    if (!turn.assistant) return { status: "accepted" };
    const receipt: ContinuationReceipt = {
      requestId,
      identity: record.target,
      sessionId: state.session.id,
      projectKey: state.session.projectKey,
      permissionMode: state.session.permissionMode,
      beforeRevision: record.checkpoint.session.transcriptRevision,
      afterRevision: sha(data),
      turnId: turn.assistant.uuid,
    };
    return { status: "started", receipt };
  }
}
