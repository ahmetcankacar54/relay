import fs from "node:fs/promises";
import path from "node:path";
import { createHash, type Hash } from "node:crypto";
import { DesktopAutomationError } from "./desktop-continuation-host";

type Row = Record<string, any>;

/** What quota-stop polling needs from a transcript, without keeping its rows. */
export interface TranscriptSummary {
  /** Size of the complete transcript. */
  bytes: number;
  sha256: string;
  /** Every working directory a row was written from, resolved. */
  cwds: ReadonlySet<string>;
  /** The latest main-chain user or assistant row. */
  last?: Row;
  /** When `last` is a task notification, the latest other main-chain row before it. */
  beforeNotifications?: Row;
  /**
   * What started the turn of the latest main-chain assistant row: the user row right before it
   * was a person's prompt, a background task's notification, or a tool's result.
   */
  trigger?: TurnTrigger;
}

/** What a main-chain user row is, as the start of the assistant turn after it. */
export type TurnTrigger = "prompt" | "task-notification" | "tool";

/** The kind of a main-chain user row: a task notification, a tool result, or a prompt. */
export function turnTrigger(row: Row): TurnTrigger {
  if (isTaskNotification(row)) return "task-notification";
  const content = row.message?.content;
  return Array.isArray(content) && content.some((c) => c?.type === "tool_result")
    ? "tool"
    : "prompt";
}

/**
 * A prompt Claude Code wrote itself when a background task finished, not one
 * a person sent. Older transcripts lack `origin`; their text still says so.
 */
export function isTaskNotification(row: Row) {
  if (row.type !== "user") return false;
  if (row.origin !== undefined) return row.origin?.kind === "task-notification";
  const content = row.message?.content;
  return (
    typeof content === "string" && content.startsWith("<task-notification>")
  );
}

interface Scan {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes consumed so far, always just after a newline. */
  offset: number;
  /** The bytes just before `offset`, to notice a rewritten file. */
  edge: Buffer;
  /** SHA-256 of bytes [0, offset). */
  hash: Hash;
  cwds: Set<string>;
  last?: Row;
  beforeNotifications?: Row;
  /** The kind of the latest main-chain user row, and of the one before the latest assistant row. */
  lastUser?: TurnTrigger;
  trigger?: TurnTrigger;
  /** A malformed or oversized line was consumed; its file is never usable. */
  invalid: boolean;
}

const EDGE_BYTES = 64;
const incomplete = () =>
  new DesktopAutomationError("desktop-observation-incomplete");

/**
 * Reads Claude Code transcripts incrementally. Transcripts are append-only
 * JSONL files up to tens of megabytes that quota-stop polling looks at every
 * few seconds; a full read and parse of each one kept hundreds of megabytes in
 * memory and the CPU busy. Each scan reads only what was appended since the
 * previous one and keeps a running hash instead of the rows. It accepts and
 * refuses exactly what `parseDesktopTranscript` does: a file must end with a
 * newline, and every non-empty line must be a JSON object within the length
 * limit.
 */
export class TranscriptScanner {
  /** Transcript bytes read from disk, for tests. */
  bytesRead = 0;
  private readonly scans = new Map<string, Scan>();
  private readonly maxBytes: number;
  private readonly maxLineLength: number;
  private readonly chunkBytes: number;
  constructor(
    options: {
      maxBytes?: number;
      maxLineLength?: number;
      chunkBytes?: number;
    } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxLineLength = options.maxLineLength ?? 2_097_152;
    this.chunkBytes = options.chunkBytes ?? 1024 * 1024;
  }

  async scan(file: string): Promise<TranscriptSummary> {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxBytes) throw incomplete();
      let scan = this.scans.get(file);
      const unchanged =
        scan &&
        scan.dev === stat.dev &&
        scan.ino === stat.ino &&
        scan.size === stat.size &&
        scan.mtimeMs === stat.mtimeMs;
      if (!unchanged) {
        if (!scan || !(await this.continues(handle, scan, stat))) {
          scan = {
            dev: stat.dev,
            ino: stat.ino,
            size: -1,
            mtimeMs: -1,
            offset: 0,
            edge: Buffer.alloc(0),
            hash: createHash("sha256"),
            cwds: new Set(),
            invalid: false,
          };
          this.scans.set(file, scan);
        }
        await this.read(handle, scan, stat.size);
        scan.size = stat.size;
        scan.mtimeMs = stat.mtimeMs;
      }
      if (scan!.invalid || scan!.offset !== stat.size) throw incomplete();
      return {
        bytes: scan!.offset,
        sha256: scan!.hash.copy().digest("hex"),
        cwds: new Set(scan!.cwds),
        last: scan!.last,
        beforeNotifications: scan!.beforeNotifications,
        trigger: scan!.trigger,
      };
    } finally {
      await handle.close();
    }
  }

  /** Forget every transcript not in `files`. */
  retain(files: ReadonlySet<string>) {
    for (const file of this.scans.keys())
      if (!files.has(file)) this.scans.delete(file);
  }

  /** The same file, grown or not, with the consumed prefix still in place. */
  private async continues(
    handle: fs.FileHandle,
    scan: Scan,
    stat: { dev: number; ino: number; size: number },
  ) {
    if (
      scan.dev !== stat.dev ||
      scan.ino !== stat.ino ||
      stat.size < scan.offset
    )
      return false;
    const edge = Buffer.alloc(scan.edge.length);
    const { bytesRead } = await handle.read(
      edge,
      0,
      edge.length,
      scan.offset - edge.length,
    );
    this.bytesRead += bytesRead;
    return bytesRead === edge.length && edge.equals(scan.edge);
  }

  private async read(handle: fs.FileHandle, scan: Scan, size: number) {
    const chunk = Buffer.alloc(this.chunkBytes);
    // A line split across chunks; copied, because the chunk buffer is reused.
    let pending: Buffer[] = [];
    let position = scan.offset;
    while (position < size && !scan.invalid) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position,
      );
      if (bytesRead === 0) break;
      this.bytesRead += bytesRead;
      position += bytesRead;
      const view = chunk.subarray(0, bytesRead);
      let start = 0;
      for (
        let end = view.indexOf(10, start);
        end !== -1 && !scan.invalid;
        end = view.indexOf(10, start)
      ) {
        this.consume(scan, [...pending, view.subarray(start, end + 1)]);
        pending = [];
        start = end + 1;
      }
      if (start < view.length && !scan.invalid)
        pending.push(Buffer.from(view.subarray(start)));
    }
  }

  /** One complete line, newline included. */
  private consume(scan: Scan, pieces: Buffer[]) {
    for (const piece of pieces) scan.hash.update(piece);
    scan.offset += pieces.reduce((total, piece) => total + piece.length, 0);
    scan.edge = lastBytes([scan.edge, ...pieces], EDGE_BYTES);
    const bytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    const text = bytes.toString("utf8", 0, bytes.length - 1);
    if (!text) return;
    let row: unknown;
    try {
      if (text.length > this.maxLineLength) throw incomplete();
      row = JSON.parse(text);
    } catch {
      scan.invalid = true;
      return;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      scan.invalid = true;
      return;
    }
    const value = row as Row;
    if (typeof value.cwd === "string") scan.cwds.add(path.resolve(value.cwd));
    if (
      !value.isSidechain &&
      !value.isMeta &&
      ["user", "assistant"].includes(value.type)
    ) {
      if (!isTaskNotification(value)) scan.beforeNotifications = undefined;
      else if (scan.last && !isTaskNotification(scan.last))
        scan.beforeNotifications = scan.last;
      scan.last = value;
      if (value.type === "user") scan.lastUser = turnTrigger(value);
      else scan.trigger = scan.lastUser;
    }
  }
}

function lastBytes(parts: Buffer[], count: number) {
  const taken: Buffer[] = [];
  for (let index = parts.length - 1; index >= 0 && count > 0; index--) {
    const part = parts[index].subarray(
      Math.max(0, parts[index].length - count),
    );
    taken.unshift(part);
    count -= part.length;
  }
  return Buffer.concat(taken);
}
