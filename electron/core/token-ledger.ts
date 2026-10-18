import fs from "node:fs/promises";
import fsSync, { constants, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { localDate } from "../../shared/planning";
import {
  privateJournalDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./continuation-journal";
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
type Usage = Omit<TokenCounts, "responses">;

/** The response a transcript's last rows belong to, and what it has added so far. */
interface LastResponse extends Usage {
  date: string;
  who: string;
  model: string;
}

/** What is kept of a transcript: where reading stopped, never its text. */
interface FileState {
  dev: number;
  ino: number;
  /** Size when last looked at. */
  size: number;
  /** Bytes consumed, always just after a newline. */
  offset: number;
  mtimeMs: number;
  /** `${message.id}:${requestId}` of the last response read. */
  lastKey?: string;
  /** Where that response was counted; absent when it was skipped, as a copy. */
  last?: LastResponse;
  /** Shrunk or replaced: never read again, and its counted tokens stay. */
  broken?: true;
}

interface Saved {
  version: 1;
  /** The time zone the days are in. */
  zone?: string;
  files: Record<string, FileState>;
  days: Days;
  /** The length of each day's seen file that goes with these offsets. */
  seen: Record<string, number>;
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
/** Days of seen hashes kept in memory, least recently used dropped first. */
const SEEN_DAYS_IN_MEMORY = 16;
const HASH_BYTES = 8;
const SEEN_FILE = /^(\d{4}-\d{2}-\d{2})\.bin$/;
/** While a scan spans ticks, the ledger is written at most this often. */
const PERSIST_EVERY_MS = 10_000;
/** Claude Code's own stand-in replies, not responses from the API. */
const SYNTHETIC_MODEL = "<synthetic>";
const MAX_MODEL_LENGTH = 100;
/** Real ids are about 30 characters. */
const MAX_ID_LENGTH = 200;
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const USAGE = Buffer.from('"usage"');
const ASSISTANT = Buffer.from('"assistant"');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE_FIELDS = ["input", "output", "cacheWrite", "cacheRead"] as const;
const FIELDS = [...USAGE_FIELDS, "responses"] as const;

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

function code(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function usageOf(usage: Record<string, unknown>): Usage {
  return {
    input: amount(usage.input_tokens),
    output: amount(usage.output_tokens),
    cacheWrite: amount(usage.cache_creation_input_tokens),
    cacheRead: amount(usage.cache_read_input_tokens),
  };
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

function hashOf(key: string): string {
  return createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, HASH_BYTES * 2);
}

function syncDirectory(directory: string) {
  const fd = fsSync.openSync(directory, "r");
  try {
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
}

class SeenStoreError extends Error {
  constructor() {
    super("token-ledger-seen-invalid");
  }
}

/**
 * The responses each day already counted, across all transcripts: a resumed or
 * forked session copies earlier rows, timestamps included, into a new file.
 * Each day is an append-only file of 8-byte hashes of
 * `${message.id}:${requestId}`, never any text, and only a few days are held
 * in memory.
 */
class SeenDays {
  /** The length of each day's file on disk, as of the last flush. */
  readonly bytes = new Map<string, number>();
  /** Loaded days, least recently used first. */
  private readonly loaded = new Map<string, Set<string>>();
  /** Hashes added since the last flush. */
  private readonly pending = new Map<string, string[]>();

  constructor(private readonly dir: string) {}

  get inMemory() {
    return this.loaded.size;
  }

  has(date: string, hash: string) {
    return this.day(date).has(hash);
  }

  add(date: string, hash: string) {
    this.day(date).add(hash);
    const list = this.pending.get(date);
    if (list) list.push(hash);
    else this.pending.set(date, [hash]);
  }

  dates(): string[] {
    return [
      ...new Set([
        ...this.bytes.keys(),
        ...this.loaded.keys(),
        ...this.pending.keys(),
      ]),
    ];
  }

  /** Forget a day and delete its file. */
  drop(date: string) {
    this.loaded.delete(date);
    this.pending.delete(date);
    this.bytes.delete(date);
    try {
      fsSync.unlinkSync(this.file(date));
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
  }

  /** Forget everything in memory. */
  forget() {
    this.loaded.clear();
    this.pending.clear();
    this.bytes.clear();
  }

  /** Delete every seen file; a symlink in the directory's place goes, not its target. */
  removeAll() {
    fsSync.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Append the new hashes durably, before any offset that read them is saved. */
  async flush() {
    if (!this.pending.size) return;
    privateJournalDirectory(this.dir);
    let created = false;
    for (const [date, hashes] of this.pending) {
      const handle = await fs.open(
        this.file(date),
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new SeenStoreError();
        const whole = stat.size - (stat.size % HASH_BYTES);
        // A torn append from a crash is cut off.
        if (whole !== stat.size) await handle.truncate(whole);
        await handle.appendFile(Buffer.from(hashes.join(""), "hex"));
        await handle.sync();
        created ||= whole === 0;
        this.bytes.set(date, whole + hashes.length * HASH_BYTES);
      } finally {
        await handle.close();
      }
      this.pending.delete(date);
    }
    if (created) syncDirectory(this.dir);
  }

  /**
   * Cut each day's file back to the length the saved ledger knew, and make it
   * private again. Hashes past that length belong to rows whose counts were
   * lost with an unsaved ledger; those rows are read again from the saved
   * offsets, and count again, once. False when the files cannot be trusted.
   */
  restore(saved: Record<string, unknown>): boolean {
    try {
      const info = fsSync.lstatSync(this.dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      for (const name of fsSync.readdirSync(this.dir)) {
        const date = SEEN_FILE.exec(name)?.[1];
        if (date && !this.restoreDay(date, amount(saved[date]))) return false;
      }
      return true;
    } catch (error) {
      return code(error) === "ENOENT" && this.bytes.size === 0;
    }
  }

  private restoreDay(date: string, saved: number): boolean {
    const file = this.file(date);
    try {
      const info = fsSync.lstatSync(file);
      if (!info.isFile()) return false;
      const length = Math.min(saved, info.size);
      const keep = length - (length % HASH_BYTES);
      if (keep === 0) {
        fsSync.unlinkSync(file);
        return true;
      }
      if (info.size > keep) fsSync.truncateSync(file, keep);
      fsSync.chmodSync(file, 0o600);
      this.bytes.set(date, keep);
      return true;
    } catch (error) {
      if (code(error) !== "ENOENT") return false;
      this.bytes.delete(date);
      return true;
    }
  }

  private file(date: string) {
    return path.join(this.dir, `${date}.bin`);
  }

  private day(date: string): Set<string> {
    let set = this.loaded.get(date);
    if (set) this.loaded.delete(date);
    else {
      set = this.read(date);
      if (this.loaded.size >= SEEN_DAYS_IN_MEMORY)
        this.loaded.delete(this.loaded.keys().next().value!);
    }
    this.loaded.set(date, set);
    return set;
  }

  /** Only a missing file is an empty day; any other failure fails the tick. */
  private read(date: string): Set<string> {
    const set = new Set<string>();
    const data = this.readFile(date);
    if (data)
      for (let at = 0; at + HASH_BYTES <= data.length; at += HASH_BYTES)
        set.add(data.toString("hex", at, at + HASH_BYTES));
    for (const hash of this.pending.get(date) ?? []) set.add(hash);
    return set;
  }

  private readFile(date: string): Buffer | undefined {
    let fd: number;
    try {
      const info = fsSync.lstatSync(this.dir);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new SeenStoreError();
      fd = fsSync.openSync(this.file(date), READ_FLAGS);
    } catch (error) {
      if (code(error) === "ENOENT") return;
      throw error;
    }
    try {
      if (!fsSync.fstatSync(fd).isFile()) throw new SeenStoreError();
      return fsSync.readFileSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
  }
}

function restoreLast(value: unknown): LastResponse | undefined {
  if (
    !isRecord(value) ||
    typeof value.date !== "string" ||
    !DATE.test(value.date) ||
    typeof value.who !== "string" ||
    typeof value.model !== "string"
  )
    return;
  return {
    date: value.date,
    who: value.who,
    model: value.model,
    input: amount(value.input),
    output: amount(value.output),
    cacheWrite: amount(value.cacheWrite),
    cacheRead: amount(value.cacheRead),
  };
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
  const last =
    typeof lastKey === "string" ? restoreLast(value.last) : undefined;
  return {
    dev,
    ino,
    size,
    offset,
    mtimeMs,
    ...(typeof lastKey === "string" ? { lastKey } : {}),
    ...(last ? { last } : {}),
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
  private readonly seen: SeenDays;
  private days: Days = Object.create(null);
  /** The zone `days` are in; undefined until the first tick names one. */
  private bucketZone?: string;
  /** The seen files could not be trusted: empty everything before counting. */
  private mustStartOver = false;
  private dirty = false;
  private lastPersist = -Infinity;
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
    this.seen = new SeenDays(
      path.join(path.dirname(this.file), "token-ledger-seen"),
    );
    this.load();
  }

  /** For tests: how many days of seen hashes are in memory. */
  get seenDaysInMemory() {
    return this.seen.inMemory;
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
    if (
      this.mustStartOver ||
      (this.bucketZone !== undefined && this.bucketZone !== zone)
    )
      this.startOver(zone);
    else if (this.bucketZone === undefined) {
      this.bucketZone = zone;
      this.dirty = true;
    }
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
    // The hashes reach the disk before any offset that read them.
    await this.seen.flush();
    if (
      this.dirty &&
      (complete || this.now() - this.lastPersist >= PERSIST_EVERY_MS)
    )
      this.persist();
    return { complete };
  }

  /**
   * Empty the counts, offsets and seen files together. The empty ledger is
   * saved before the seen files go: loading it after a crash in between
   * deletes them anyway. Until this succeeds, every tick tries it again.
   */
  private startOver(zone: string) {
    this.mustStartOver = true;
    this.files.clear();
    this.days = Object.create(null);
    this.pass = undefined;
    this.cursor = undefined;
    this.bucketZone = zone;
    this.seen.forget();
    this.persist();
    this.seen.removeAll();
    this.mustStartOver = false;
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

  /**
   * Read a transcript from its offset; false when the budget paused it. A
   * transcript that cannot be opened, inspected or read is left for the next
   * pass, so one bad file never stalls the scan.
   */
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
      handle = await fs.open(entry.file, READ_FLAGS);
    } catch {
      return true;
    }
    try {
      let stat: Stats;
      try {
        stat = await handle.stat();
      } catch {
        return true;
      }
      if (!stat.isFile()) return true;
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
        let bytesRead: number;
        try {
          ({ bytesRead } = await handle.read(
            chunk,
            0,
            Math.min(chunk.length, stat.size - position),
            position,
          ));
        } catch {
          return true;
        }
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
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Count one complete line. A response streams as several contiguous rows
   * with one id pair and a usage that only grows: the first row is counted,
   * and each later one adds what grew, to the same bucket.
   */
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
    if (message.model === SYNTHETIC_MODEL || typeof message.id !== "string")
      return;
    // Ids out of shape are counted without being deduplicated.
    const key =
      isId(message.id) && isId(row.requestId)
        ? `${message.id}:${row.requestId}`
        : undefined;
    const time =
      typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(time)) return;
    const usage = usageOf(message.usage);
    if (key !== undefined && key === state.lastKey) {
      const last = state.last;
      if (!last || last.date < tick.cutoff) return;
      const counts = bucket(this.days, last.date, last.who, last.model);
      for (const field of USAGE_FIELDS)
        if (usage[field] > last[field]) {
          counts[field] += usage[field] - last[field];
          last[field] = usage[field];
        }
      return;
    }
    const date = localDate(time, tick.zone);
    const skip = () => {
      if (key === undefined) delete state.lastKey;
      else state.lastKey = key;
      delete state.last;
    };
    if (date < tick.cutoff) return skip();
    // A copy keeps its timestamp, so it is on the same day as the original.
    const hash = key === undefined ? undefined : hashOf(key);
    if (hash !== undefined && this.seen.has(date, hash)) return skip();
    const who = whoOf(
      this.attribute({
        time,
        entrypoint:
          typeof row.entrypoint === "string" ? row.entrypoint : undefined,
        profileAccountId,
      }),
    );
    const model =
      typeof message.model === "string" &&
      message.model.length > 0 &&
      message.model.length <= MAX_MODEL_LENGTH
        ? message.model
        : "unknown";
    const counts = bucket(this.days, date, who, model);
    for (const field of USAGE_FIELDS) counts[field] += usage[field];
    counts.responses += 1;
    if (key === undefined || hash === undefined) {
      delete state.lastKey;
      delete state.last;
      return;
    }
    state.lastKey = key;
    state.last = { date, who, model, ...usage };
    this.seen.add(date, hash);
  }

  /**
   * Drop days older than 120 days with their seen hashes, and the state of
   * files last written well before that. Such a file is skipped as too old if
   * seen again, and if it was written to since, its old rows fall on dropped
   * days, so nothing re-counts.
   */
  private prune(tick: Tick) {
    for (const date of Object.keys(this.days))
      if (date < tick.cutoff) {
        delete this.days[date];
        this.dirty = true;
      }
    for (const date of this.seen.dates())
      if (date < tick.cutoff) {
        this.seen.drop(date);
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
      ...(this.bucketZone === undefined ? {} : { zone: this.bucketZone }),
      files: Object.fromEntries(this.files),
      days: this.days,
      seen: Object.fromEntries(this.seen.bytes),
    };
    writePrivateJson(this.file, saved, LEDGER_MAX_BYTES);
    this.dirty = false;
    this.lastPersist = this.now();
  }

  /**
   * A ledger that cannot be read starts empty, and so do the seen hashes, or
   * the rescan would find every response already seen. Seen files that
   * cannot be trusted empty the ledger too, on the first tick.
   */
  private load() {
    let value: Record<string, any> = {};
    try {
      const saved = readPrivateJson(this.file, LEDGER_MAX_BYTES);
      if (isRecord(saved) && saved.version === 1) value = saved;
    } catch {
      // No ledger yet, or an unreadable one.
    }
    if (typeof value.zone === "string") this.bucketZone = value.zone;
    if (!this.seen.restore(isRecord(value.seen) ? value.seen : {})) {
      this.mustStartOver = true;
      this.seen.forget();
      return;
    }
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
