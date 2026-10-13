import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  isTerminalContinuationRecord,
  type ContinuationJournal,
  type ContinuationJournalRecord,
} from "./continuation";

const MAX_BYTES = 1_048_576;
const tails = new Map<string, Promise<void>>();
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;

/** JSON only: no credentials, native code or shell commands are persisted. */
export function privateJournalDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("continuation-directory-invalid");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

export function readPrivateJson(file: string): unknown {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES)
    throw new Error("continuation-file-invalid");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const info = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (
      !info.isFile() ||
      named.isSymbolicLink() ||
      info.dev !== named.dev ||
      info.ino !== named.ino ||
      info.size > MAX_BYTES
    )
      throw new Error("continuation-file-invalid");
    const data = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < data.length) {
      const count = fs.readSync(fd, data, size, data.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_BYTES) throw new Error("continuation-file-too-large");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size)),
    );
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve only after the replacement and its directory entry are durable. */
export function writePrivateJson(file: string, value: unknown) {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > MAX_BYTES)
    throw new Error("continuation-file-too-large");
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw new Error("continuation-file-invalid");
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function syncDirectory(directory: string) {
  // Windows does not expose a directory FlushFileBuffers through Node. The
  // replacement file itself was flushed before the atomic same-directory move.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** All journal instances in a process share one queue, not a per-request lock. */
async function processLock<T>(key: string, action: () => Promise<T>) {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, next);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (tails.get(key) === next) tails.delete(key);
  }
}

export class FileContinuationJournal implements ContinuationJournal {
  readonly directory: string;
  private lockFile: string;
  constructor(
    root: string,
    private now: () => number = Date.now,
  ) {
    this.directory = path.resolve(root);
    privateJournalDirectory(this.directory);
    this.lockFile = path.join(this.directory, "host.lock");
  }
  private file(id: string) {
    if (!idPattern.test(id)) throw new Error("continuation-request-id-invalid");
    return path.join(this.directory, `${id}.journal.json`);
  }
  async read(id: string) {
    const file = this.file(id);
    try {
      return readPrivateJson(file) as ContinuationJournalRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("continuation-journal-unreadable");
    }
  }
  async listPending() {
    const pending: ContinuationJournalRecord[] = [];
    for (const name of fs.readdirSync(this.directory).sort()) {
      if (!name.endsWith(".journal.json")) continue;
      try {
        const value = readPrivateJson(path.join(this.directory, name));
        if (!isTerminalContinuationRecord(value, this.now()))
          pending.push(value as ContinuationJournalRecord);
      } catch {
        // The engine treats this invalid sentinel as a host-wide barrier. A
        // damaged entry is never discarded merely because it cannot be parsed.
        pending.push({ id: `unreadable:${name}` } as ContinuationJournalRecord);
      }
    }
    return pending;
  }
  async write(record: ContinuationJournalRecord) {
    writePrivateJson(this.file(record.id), record);
  }
  async withLock<T>(_requestId: string, action: () => Promise<T>) {
    return processLock(this.directory, async () => {
      const token = randomUUID();
      const fd = this.acquire(token);
      const owner = fs.fstatSync(fd);
      try {
        return await action();
      } finally {
        fs.closeSync(fd);
        // Never remove a lock file someone replaced during an action.
        if (fs.existsSync(this.lockFile)) {
          const named = fs.lstatSync(this.lockFile);
          if (
            !named.isSymbolicLink() &&
            named.dev === owner.dev &&
            named.ino === owner.ino
          ) {
            fs.unlinkSync(this.lockFile);
            syncDirectory(this.directory);
          }
        }
      }
    });
  }
  private acquire(token: string): number {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
          fs.fsyncSync(fd);
          syncDirectory(this.directory);
          return fd;
        } catch (error) {
          fs.closeSync(fd);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = fs.lstatSync(this.lockFile);
        let owner: unknown;
        try {
          owner = readPrivateJson(this.lockFile);
        } catch {
          throw new Error("continuation-host-lock-unreadable");
        }
        const pid = (owner as { pid?: number })?.pid;
        if (!Number.isSafeInteger(pid) || pid! <= 0)
          throw new Error("continuation-host-lock-unreadable");
        try {
          process.kill(pid!, 0);
          throw new Error("continuation-host-locked");
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== "ESRCH")
            throw new Error("continuation-host-locked");
        }
        const current = fs.lstatSync(this.lockFile);
        if (
          current.isSymbolicLink() ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino
        )
          throw new Error("continuation-host-lock-changed");
        fs.unlinkSync(this.lockFile);
        syncDirectory(this.directory);
      }
    }
    throw new Error("continuation-host-locked");
  }
}
