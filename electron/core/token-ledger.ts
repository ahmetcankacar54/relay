import fs from "node:fs/promises";
import { constants, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import { localDate } from "../../shared/planning";
import { readPrivateJson, writePrivateJson } from "./continuation-journal";
import type { Attribution } from "./token-attribution";

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  responses: number;
}
/** `${date}|${who}|${model}`; who = `acct:<id>` | `est:<id>` | "terminal" | "unknown". */
export type BucketKey = string;
export interface LedgerSnapshot {
  /** date → who → model → counts */
  days: Record<string, Record<string, Record<string, TokenCounts>>>;
  progress: { scannedBytes: number; totalBytes: number; complete: boolean };
}

export interface TokenLedgerOptions {
  /** The ledger file, `<userData>/token-ledger.json`. */
  file: string;
  /** Transcript roots; one under a Relay profile carries its account. */
  roots: { dir: string; profileAccountId?: string }[];
  attribute: (row: {
    time: number;
    entrypoint?: string;
    profileAccountId?: string;
  }) => Attribution;
  /** The planning time zone that days are calendar dates in. */
  zone: () => string;
  now?: () => number;
  /** Wall time one tick may work for; it may finish the chunk it is in. */
  budgetMs?: number;
  /** A transcript first seen untouched for longer is never read. */
  maxAgeDays?: number;
}

type Days = LedgerSnapshot["days"];

/** What is kept of a transcript: where reading stopped, never its text. */
interface FileState {
  dev: number;
  ino: number;
  /** Size when last looked at. */
  size: number;
  /** Bytes consumed, always just after a newline. */
  offset: number;
  mtimeMs: number;
  /** `${message.id}:${requestId}` of the last response counted. */
  lastKey?: string;
  /** Shrunk or replaced: never read again, and its counted tokens stay. */
  broken?: true;
}

interface Saved {
  version: 1;
  files: Record<string, FileState>;
  days: Days;
}

/** One walk of the roots and read of what they hold, possibly over many ticks. */
interface Pass {
  /** Directories still to list, as a stack. */
  dirs: { dir: string; depth: number; root: number }[];
  /** Transcripts to read, in the order found. */
  files: { file: string; root: number }[];
  next: number;
}

/** A read the budget paused in the middle of a file. */
interface Cursor {
  file: string;
  position: number;
  /** The unfinished line so far; dropped once it is over the line limit. */
  pending: Buffer[];
  lineBytes: number;
}

interface Tick {
  started: number;
  deadline: number;
  zone: string;
  /** The oldest date kept. */
  cutoff: string;
}

const DAY_MS = 86_400_000;
const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** `<project>/<session>/subagents/<agent>.jsonl` is four levels below a root. */
const MAX_DEPTH = 4;
const KEEP_DAYS = 120;
/**
 * The 1 MiB default of the private JSON helpers is too small: the owner's
 * transcripts are thousands of files, each with a path and offsets here.
 * Offsets and counts must stay in one file to be written atomically together.
 */
const LEDGER_MAX_BYTES = 16 * 1024 * 1024;
const USAGE = Buffer.from('"usage"');
const ASSISTANT = Buffer.from('"assistant"');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = [
  "input",
  "output",
  "cacheWrite",
  "cacheRead",
  "responses",
] as const;

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function whoOf(attribution: Attribution): string {
  switch (attribution.kind) {
    case "account":
      return `${attribution.estimated ? "est" : "acct"}:${attribution.accountId}`;
    case "terminal":
      return "terminal";
    default:
      return "unknown";
  }
}

/** Null-prototype maps, so a model named `__proto__` is just a key. */
function bucket(
  days: Days,
  date: string,
  who: string,
  model: string,
): TokenCounts {
  const byWho = (days[date] ??= Object.create(null));
  const byModel = (byWho[who] ??= Object.create(null));
  return (byModel[model] ??= {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    responses: 0,
  });
}

function restoreFile(value: unknown): FileState | undefined {
  if (!isRecord(value)) return;
  const { dev, ino, size, offset, mtimeMs, lastKey, broken } = value;
  if (
    ![dev, ino, size, offset, mtimeMs].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  )
    return;
  return {
    dev,
    ino,
    size,
    offset,
    mtimeMs,
    ...(typeof lastKey === "string" ? { lastKey } : {}),
    ...(broken === true ? { broken } : {}),
  };
}

/**
 * Counts the tokens of Claude Code responses from transcript JSONL files, by
 * day, account and model. Transcripts are append-only and add up to gigabytes,
 * so each file is read once: its offset is persisted with the counts, and a
 * later tick reads only what was appended. A tick works within a time budget
 * and yields between chunks; a first scan spreads over many ticks and resumes
 * after a restart. Only counts, model names, dates and ids are kept.
 */
export class TokenLedger {
  private readonly file: string;
  private readonly roots: TokenLedgerOptions["roots"];
  private readonly attribute: TokenLedgerOptions["attribute"];
  private readonly zone: () => string;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly maxAgeDays: number;
  private readonly files = new Map<string, FileState>();
  private days: Days = Object.create(null);
  private dirty = false;
  private complete = false;
  private pass?: Pass;
  private cursor?: Cursor;
  private chunk?: Buffer;
  private running?: Promise<{ complete: boolean }>;

  constructor(options: TokenLedgerOptions) {
    this.file = options.file;
    this.roots = options.roots;
    this.attribute = options.attribute;
    this.zone = options.zone;
    this.now = options.now ?? Date.now;
    this.budgetMs = options.budgetMs ?? 200;
    this.maxAgeDays = options.maxAgeDays ?? 90;
    this.load();
  }

  /** One budgeted pass of work; resumable. Overlapping calls share it. */
  tick(): Promise<{ complete: boolean }> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  snapshot(): LedgerSnapshot {
    let scannedBytes = 0;
    let totalBytes = 0;
    for (const state of this.files.values()) {
      if (state.broken) continue;
      scannedBytes += state.offset;
      totalBytes += state.size;
    }
    return {
      days: structuredClone(this.days),
      progress: { scannedBytes, totalBytes, complete: this.complete },
    };
  }

  private async run(): Promise<{ complete: boolean }> {
    const started = this.now();
    const zone = this.zone();
    const tick: Tick = {
      started,
      deadline: started + this.budgetMs,
      zone,
      // An invalid zone throws here, before anything is read.
      cutoff: localDate(started - KEEP_DAYS * DAY_MS, zone),
    };
    const pass = (this.pass ??= {
      dirs: this.roots
        .map((root, index) => ({ dir: root.dir, depth: 0, root: index }))
        .reverse(),
      files: [],
      next: 0,
    });
    const remaining = () =>
      pass.dirs.length > 0 || pass.next < pass.files.length;
    // At least one step per tick, so a tiny budget still makes progress.
    while (remaining()) {
      if (pass.dirs.length) await this.visit(pass, pass.dirs.pop()!, tick);
      else if (await this.read(pass.files[pass.next], tick)) pass.next++;
      if (this.now() >= tick.deadline) break;
    }
    const complete = !remaining();
    if (complete) this.pass = undefined;
    this.complete = complete;
    this.prune(tick);
    if (this.dirty) this.persist();
    return { complete };
  }

  /** List one directory: transcripts to read, and directories to list. */
  private async visit(
    pass: Pass,
    at: { dir: string; depth: number; root: number },
    tick: Tick,
  ) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(at.dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs: Pass["dirs"] = [];
    const files: string[] = [];
    // Symlinks are neither files nor directories here, so they are skipped.
    for (const entry of entries) {
      const full = path.join(at.dir, entry.name);
      if (entry.isDirectory()) {
        if (at.depth + 1 < MAX_DEPTH && entry.name !== "tool-results")
          dirs.push({ dir: full, depth: at.depth + 1, root: at.root });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
    pass.dirs.push(...dirs.reverse());
    const stats = await Promise.all(
      files.map((file) => fs.lstat(file).catch(() => undefined)),
    );
    files.forEach((file, index) => {
      const stat = stats[index];
      if (stat && this.observe(file, stat, tick.started))
        pass.files.push({ file, root: at.root });
    });
  }

  /** Track a transcript found on disk; whether it has anything to read. */
  private observe(file: string, stat: Stats, now: number): boolean {
    if (!stat.isFile()) return false;
    const state = this.files.get(file);
    if (!state) {
      if (stat.mtimeMs < now - this.maxAgeDays * DAY_MS) return false;
      this.files.set(file, {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        offset: 0,
        mtimeMs: stat.mtimeMs,
      });
      this.dirty = true;
      return true;
    }
    if (state.mtimeMs !== stat.mtimeMs) {
      state.mtimeMs = stat.mtimeMs;
      this.dirty = true;
    }
    if (state.broken) return false;
    if (
      stat.dev !== state.dev ||
      stat.ino !== state.ino ||
      stat.size < state.offset
    ) {
      state.broken = true;
      this.dirty = true;
      return false;
    }
    if (stat.size !== state.size) {
      state.size = stat.size;
      this.dirty = true;
    }
    return true;
  }

  /** Read a transcript from its offset; false when the budget paused it. */
  private async read(
    entry: { file: string; root: number },
    tick: Tick,
  ): Promise<boolean> {
    const state = this.files.get(entry.file);
    const cursor = this.cursor?.file === entry.file ? this.cursor : undefined;
    this.cursor = undefined;
    if (!state || state.broken || (!cursor && state.offset >= state.size))
      return true;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        entry.file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      return true;
    }
    try {
      const stat = await handle.stat();
      if (
        stat.dev !== state.dev ||
        stat.ino !== state.ino ||
        stat.size < state.offset
      ) {
        state.broken = true;
        this.dirty = true;
        return true;
      }
      if (stat.size !== state.size) {
        state.size = stat.size;
        this.dirty = true;
      }
      const resume =
        cursor &&
        cursor.position <= stat.size &&
        cursor.position - cursor.lineBytes === state.offset
          ? cursor
          : undefined;
      let position = resume?.position ?? state.offset;
      let pending = resume?.pending ?? [];
      let lineBytes = resume?.lineBytes ?? 0;
      const profileAccountId = this.roots[entry.root]?.profileAccountId;
      const chunk = (this.chunk ??= Buffer.allocUnsafe(CHUNK_BYTES));
      while (position < stat.size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, stat.size - position),
          position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        const view = chunk.subarray(0, bytesRead);
        let start = 0;
        for (
          let end = view.indexOf(10, start);
          end !== -1;
          end = view.indexOf(10, start)
        ) {
          const length = lineBytes + end - start;
          // Oversized lines are skipped without parsing.
          if (length <= MAX_LINE_BYTES) {
            const tail = view.subarray(start, end);
            this.line(
              state,
              pending.length ? Buffer.concat([...pending, tail]) : tail,
              profileAccountId,
              tick,
            );
          }
          state.offset += length + 1;
          this.dirty = true;
          pending = [];
          lineBytes = 0;
          start = end + 1;
        }
        // A line with no newline yet stays unconsumed: offset stops before it.
        if (start < view.length) {
          lineBytes += view.length - start;
          if (lineBytes <= MAX_LINE_BYTES)
            pending.push(Buffer.from(view.subarray(start)));
          else pending = [];
        }
        await yieldToEventLoop();
        if (position < stat.size && this.now() >= tick.deadline) {
          this.cursor = { file: entry.file, position, pending, lineBytes };
          return false;
        }
      }
      return true;
    } finally {
      await handle.close();
    }
  }

  /** Count one complete line, if it is a response not counted yet. */
  private line(
    state: FileState,
    bytes: Buffer,
    profileAccountId: string | undefined,
    tick: Tick,
  ) {
    if (bytes.indexOf(USAGE) === -1 || bytes.indexOf(ASSISTANT) === -1) return;
    let row: unknown;
    try {
      row = JSON.parse(bytes.toString("utf8"));
    } catch {
      return;
    }
    if (!isRecord(row) || row.type !== "assistant") return;
    const message = row.message;
    if (!isRecord(message) || !isRecord(message.usage)) return;
    // A streamed response is several contiguous rows with one id pair.
    const key =
      typeof message.id === "string"
        ? `${message.id}:${row.requestId}`
        : undefined;
    if (key !== undefined && key === state.lastKey) return;
    const time =
      typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(time)) return;
    const date = localDate(time, tick.zone);
    const who =
      date < tick.cutoff
        ? undefined
        : whoOf(
            this.attribute({
              time,
              entrypoint:
                typeof row.entrypoint === "string" ? row.entrypoint : undefined,
              profileAccountId,
            }),
          );
    if (key === undefined) delete state.lastKey;
    else state.lastKey = key;
    if (who === undefined) return;
    const model =
      typeof message.model === "string" && message.model
        ? message.model
        : "unknown";
    const usage = message.usage;
    const counts = bucket(this.days, date, who, model);
    counts.input += amount(usage.input_tokens);
    counts.output += amount(usage.output_tokens);
    counts.cacheWrite += amount(usage.cache_creation_input_tokens);
    counts.cacheRead += amount(usage.cache_read_input_tokens);
    counts.responses += 1;
  }

  /**
   * Drop days older than 120 days, and the state of files last written well
   * before that. Such a file is skipped as too old if seen again, and if it was
   * written to since, its old rows fall on dropped days, so nothing re-counts.
   */
  private prune(tick: Tick) {
    for (const date of Object.keys(this.days))
      if (date < tick.cutoff) {
        delete this.days[date];
        this.dirty = true;
      }
    const forgetBefore =
      tick.started - (Math.max(this.maxAgeDays, KEEP_DAYS) + 2) * DAY_MS;
    for (const [file, state] of this.files)
      if (state.mtimeMs < forgetBefore) {
        this.files.delete(file);
        this.dirty = true;
      }
  }

  private persist() {
    const saved: Saved = {
      version: 1,
      files: Object.fromEntries(this.files),
      days: this.days,
    };
    writePrivateJson(this.file, saved, LEDGER_MAX_BYTES);
    this.dirty = false;
  }

  private load() {
    let value: unknown;
    try {
      value = readPrivateJson(this.file, LEDGER_MAX_BYTES);
    } catch {
      return;
    }
    if (!isRecord(value) || value.version !== 1) return;
    if (isRecord(value.files))
      for (const [file, raw] of Object.entries(value.files)) {
        const state = restoreFile(raw);
        if (state) this.files.set(file, state);
      }
    if (isRecord(value.days))
      for (const [date, byWho] of Object.entries(value.days)) {
        if (!DATE.test(date) || !isRecord(byWho)) continue;
        for (const [who, byModel] of Object.entries(byWho)) {
          if (!isRecord(byModel)) continue;
          for (const [model, raw] of Object.entries(byModel)) {
            if (!isRecord(raw)) continue;
            const counts = bucket(this.days, date, who, model);
            for (const field of FIELDS) counts[field] += amount(raw[field]);
          }
        }
      }
  }
}
