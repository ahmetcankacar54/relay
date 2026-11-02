import fs from "node:fs";
import path from "node:path";

/** proper-lockfile's rule, which Claude Code uses: a lock not touched for this long is stale. */
export const LOCK_STALE_MS = 60_000;

/** A lock directory was held by another process past the wait. */
export class LockBusyError extends Error {
  constructor(readonly file: string) {
    super(`${path.basename(file)} is held by another process`);
  }
}

/** Claude Code's two OAuth refresh locks for a config dir: `<dir>/.oauth_refresh.lock` and the legacy `<dir>.lock`. */
export function cliRefreshLockPaths(configDir: string): {
  current: string;
  legacy: string;
} {
  let real = configDir;
  try {
    real = fs.realpathSync(configDir);
  } catch {
    // Not there yet; the CLI names the legacy lock after the path as given then.
  }
  return {
    current: path.join(configDir, ".oauth_refresh.lock"),
    legacy: `${real}.lock`,
  };
}

/**
 * Takes the lock directory `file` the way proper-lockfile does: mkdir, waiting up to `waitMs`
 * for a holder that keeps touching it, and taking over one not touched for LOCK_STALE_MS. Only
 * the stale directory that was judged is removed (same inode), so a fresh lock another process
 * made meanwhile is never taken away. Returns the release, which touches it no more and removes
 * it when it is still this one. Throws LockBusyError.
 */
export async function takeLockDir(
  file: string,
  { waitMs = 0, now = Date.now }: { waitMs?: number; now?: () => number } = {},
): Promise<{ ino: number; touch: () => void; release: () => void }> {
  const deadline = now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(file, { mode: 0o700 });
      const ino = fs.lstatSync(file).ino;
      return {
        ino,
        touch: () => {
          try {
            const at = new Date();
            if (fs.lstatSync(file).ino === ino) fs.utimesSync(file, at, at);
          } catch {}
        },
        release: () => {
          try {
            if (fs.lstatSync(file).ino === ino) fs.rmdirSync(file);
          } catch {
            // Gone already.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new LockBusyError(file);
    }
    let judged: fs.Stats;
    try {
      judged = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (now() - judged.mtimeMs > LOCK_STALE_MS) {
      try {
        // Still the directory judged stale, right before it goes.
        const again = fs.lstatSync(file);
        if (again.ino === judged.ino && again.mtimeMs === judged.mtimeMs)
          fs.rmdirSync(file);
      } catch {
        // Taken over by another process meanwhile; mkdir decides.
      }
      continue;
    }
    if (now() >= deadline) throw new LockBusyError(file);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Holds both of Claude Code's OAuth refresh locks for `configDir` while `action` runs, taken in
 * the CLI's own order, touched every 5 s like proper-lockfile so no CLI takes them for stale.
 */
export async function withCliRefreshLock<T>(
  configDir: string,
  action: () => Promise<T>,
  options: { waitMs?: number; now?: () => number } = {},
): Promise<T> {
  if (!fs.existsSync(configDir))
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const { current, legacy } = cliRefreshLockPaths(configDir);
  const held: { touch: () => void; release: () => void }[] = [];
  try {
    for (const file of [current, legacy])
      held.push(await takeLockDir(file, options));
    const timer = setInterval(
      () => held.forEach((lock) => lock.touch()),
      5_000,
    );
    timer.unref();
    try {
      return await action();
    } finally {
      clearInterval(timer);
    }
  } finally {
    for (const lock of held.reverse()) lock.release();
  }
}
