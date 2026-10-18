import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readPrivateJson } from "./continuation-journal";

/** Who holds a lock. A holder whose file cannot be read is "unknown". */
export interface LockInfo {
  pid: number;
  token: string;
  by: "app" | "cli" | "unknown";
  kind: string;
  startedAt: string;
}

export class LockBusyError extends Error {
  constructor(readonly holder: LockInfo) {
    super(
      holder.by === "unknown"
        ? "Another Relay process holds the lock."
        : `Relay ${holder.by === "app" ? "(the app)" : "(a terminal)"} is busy with ${holder.kind}, since ${holder.startedAt}.`,
    );
  }
}

export interface LockDeps {
  /** When `pid` started, epoch ms, or undefined when no such process runs. */
  startedAt?: (pid: number) => number | undefined;
  now?: () => number;
}

/** When `pid` started, from `ps -o lstart=`, in epoch ms; undefined when it does not run. */
export function processStartedAt(pid: number): number | undefined {
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const time = Date.parse(out);
    return Number.isFinite(time) ? time : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process that wrote a lock at `startedAt` still holds it: its pid runs, and that
 * pid's process did not start after the lock was written (a reused pid).
 */
export function holderAlive(
  pid: number,
  startedAt: string,
  deps: LockDeps = {},
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    if (error.code === "ESRCH") return false;
  }
  if (pid === process.pid) return true;
  const written = Date.parse(startedAt);
  const began = (deps.startedAt ?? processStartedAt)(pid);
  if (began === undefined) return false;
  return !(Number.isFinite(written) && began > written);
}

function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** Blocks this thread for `ms`; only for the short waits of a synchronous lock. */
export function sleepSync(ms: number) {
  Atomics.wait(sleeper, 0, 0, ms);
}

function validInfo(value: unknown): LockInfo | undefined {
  const v = value as Partial<LockInfo> | null;
  if (
    !v ||
    !Number.isSafeInteger(v.pid) ||
    typeof v.token !== "string" ||
    (v.by !== "app" && v.by !== "cli") ||
    typeof v.kind !== "string" ||
    typeof v.startedAt !== "string"
  )
    return undefined;
  return v as LockInfo;
}

/**
 * A lock file shared by Relay's processes, the menu-bar app and the CLI. It holds the owner's
 * pid, a token, which side it is, what it does and when it began. Taking it is reentrant
 * within one instance. A lock whose holder has gone, or whose pid now belongs to a newer
 * process, is stale and is swept once, if it is still the same file.
 */
export class ProcessLock {
  private depth = 0;
  private token?: string;
  constructor(
    readonly file: string,
    private readonly by: "app" | "cli",
    private readonly deps: LockDeps = {},
  ) {}

  get held(): boolean {
    return this.depth > 0;
  }

  /** The live holder, or undefined when the lock is free or stale. Changes nothing. */
  holder(): LockInfo | undefined {
    const info = this.read();
    if (!info) return undefined;
    if (info.by === "unknown") return info;
    return holderAlive(info.pid, info.startedAt, this.deps) ? info : undefined;
  }

  /** Takes the lock at once, or throws LockBusyError naming its holder. */
  tryAcquire(kind: string): void {
    if (this.depth > 0) {
      this.depth++;
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let last: LockInfo | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      try {
        const fd = fs.openSync(this.file, "wx", 0o600);
        try {
          const info: LockInfo = {
            pid: process.pid,
            token,
            by: this.by,
            kind,
            startedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
          };
          fs.writeFileSync(fd, JSON.stringify(info));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        syncDirectory(path.dirname(this.file));
        this.token = token;
        this.depth = 1;
        return;
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      }
      const before = fs.lstatSync(this.file);
      last = this.read();
      if (!last) {
        // Another process may be writing it this instant: look once more.
        sleepSync(20);
        last = this.read();
      }
      if (!last || last.by === "unknown") {
        // Still unreadable: a writer that died mid-write long ago is stale.
        if (Date.now() - before.mtimeMs < 10_000)
          throw new LockBusyError(last ?? unknownHolder(before));
      } else if (holderAlive(last.pid, last.startedAt, this.deps))
        throw new LockBusyError(last);
      const current = fs.lstatSync(this.file);
      if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev)
        throw new LockBusyError(last ?? unknownHolder(current));
      fs.unlinkSync(this.file);
      syncDirectory(path.dirname(this.file));
    }
    throw new LockBusyError(last ?? unknownHolder(fs.lstatSync(this.file)));
  }

  /** Takes the lock, retrying every 10 ms for up to `waitMs`; only for very short holds. */
  acquireSync(kind: string, waitMs: number): void {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        return this.tryAcquire(kind);
      } catch (error) {
        if (!(error instanceof LockBusyError) || Date.now() >= until) throw error;
        sleepSync(10);
      }
    }
  }

  /** Gives one level back; the file goes with the last one, and only while it is ours. */
  release(): void {
    if (this.depth === 0) return;
    if (--this.depth > 0) return;
    const token = this.token;
    this.token = undefined;
    const info = this.read();
    if (info && info.token === token) {
      try {
        fs.unlinkSync(this.file);
      } catch {
        // Already gone.
      }
    }
  }

  private read(): LockInfo | undefined {
    let raw: unknown;
    try {
      raw = readPrivateJson(this.file, 4096);
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      try {
        return unknownHolder(fs.lstatSync(this.file));
      } catch {
        return undefined;
      }
    }
    return validInfo(raw) ?? unknownHolder(fs.lstatSync(this.file));
  }
}

function unknownHolder(stat: fs.Stats): LockInfo {
  return {
    pid: 0,
    token: "",
    by: "unknown",
    kind: "unknown",
    startedAt: new Date(stat.mtimeMs).toISOString(),
  };
}
