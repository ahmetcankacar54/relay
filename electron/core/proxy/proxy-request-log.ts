import fs from "node:fs";
import path from "node:path";
import type { ProxyRequestLog } from "../../../shared/proxy-types";

/** How long the gateway's requests are kept: past the token table's own rescans of recent days. */
export const REQUEST_LOG_KEEP_DAYS = 35;
const DAY_MS = 86_400_000;
/** At most this many requests are kept, the newest. */
const MAX_ENTRIES = 50_000;
/** Past this size the file is compacted at the next append. */
const MAX_FILE_BYTES = 40 * 1024 * 1024;
/** A file larger than this is not read at all (not one this log wrote). */
const MAX_READ_BYTES = 64 * 1024 * 1024;

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** One line read back: only the known fields, each in shape and capped, or nothing. */
export function cleanEntry(raw: unknown): ProxyRequestLog | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const at = count(row.at);
  const status = count(row.status);
  if (at === undefined || status === undefined || status > 999) return undefined;
  const entry: ProxyRequestLog = { at, status };
  const strings: [keyof ProxyRequestLog, number][] = [
    ["accountId", 64],
    ["provider", 20],
    ["model", 80],
    ["note", 40],
    ["requestId", 128],
    ["client", 40],
    ["requestClass", 40],
    ["error", 160],
  ];
  for (const [key, max] of strings) {
    const value = text(row[key], max);
    if (value !== undefined) (entry as unknown as Record<string, unknown>)[key] = value;
  }
  if (row.failover === true) entry.failover = true;
  if (row.affinity === true) entry.affinity = true;
  const ms = count(row.ms);
  if (ms !== undefined) entry.ms = ms;
  if (row.tokens && typeof row.tokens === "object") {
    const tokens: NonNullable<ProxyRequestLog["tokens"]> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = count((row.tokens as Record<string, unknown>)[key]);
      if (value) tokens[key] = value;
    }
    if (Object.keys(tokens).length) entry.tokens = tokens;
  }
  return entry;
}

/**
 * The gateway's requests on disk, one JSON line each (`gateway-requests.jsonl`): which account
 * served each one, how it went and the tokens it reported, never what was asked or answered. It
 * also answers which account served a provider request id, so the token table can put Claude
 * Code's gateway responses on that account instead of guessing.
 */
export class GatewayRequestLog {
  private byRequestId = new Map<string, string>();
  private latest: ProxyRequestLog[] = [];

  constructor(
    private readonly file: string,
    private readonly options: { now?: () => number; feedSize?: number } = {},
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Reads what is kept, drops what is too old (rewriting the file when it dropped any), and
   * indexes the request ids. Answers the newest entries, newest last, for the live feed.
   */
  load(): ProxyRequestLog[] {
    const entries = this.read();
    this.byRequestId.clear();
    for (const entry of entries)
      if (entry.requestId && entry.accountId) this.byRequestId.set(entry.requestId, entry.accountId);
    this.latest = entries.slice(-(this.options.feedSize ?? 40));
    return this.latest.slice();
  }

  /** The newest entries, newest last. */
  recent(): ProxyRequestLog[] {
    return this.latest.slice();
  }

  /** The account that served a request id, while the log keeps it. */
  accountFor(requestId: string): string | undefined {
    return this.byRequestId.get(requestId);
  }

  /** Known as soon as the answer's headers arrive, before the request is done and recorded. */
  bind(requestId: string, accountId: string): void {
    this.byRequestId.set(requestId, accountId);
  }

  /** Adds one request. A failed write leaves the log as it was; the gateway goes on. */
  record(entry: ProxyRequestLog): void {
    const clean = cleanEntry(entry);
    if (!clean) return;
    if (clean.requestId && clean.accountId) this.byRequestId.set(clean.requestId, clean.accountId);
    this.latest.push(clean);
    const size = this.options.feedSize ?? 40;
    if (this.latest.length > size) this.latest.splice(0, this.latest.length - size);
    try {
      this.append(JSON.stringify(clean) + "\n");
    } catch {
      // Not saved; the request was served all the same.
    }
  }

  private read(): ProxyRequestLog[] {
    let raw: string;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) return [];
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const oldest = this.now() - REQUEST_LOG_KEEP_DAYS * DAY_MS;
    const lines = raw.split("\n").filter(Boolean);
    const entries: ProxyRequestLog[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = cleanEntry(parsed);
      if (entry && entry.at >= oldest) entries.push(entry);
    }
    entries.sort((a, b) => a.at - b.at);
    const kept = entries.slice(-MAX_ENTRIES);
    if (kept.length !== lines.length) {
      try {
        this.rewrite(kept);
      } catch {
        // Kept as it was; the next start tries again.
      }
    }
    return kept;
  }

  private append(line: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile()) return;
      if (stat.size > MAX_FILE_BYTES) this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = fs.openSync(
      this.file,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fs.writeFileSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  }

  private rewrite(entries: ProxyRequestLog[]): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.file);
  }
}
