import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isSignInEntry, sameSignIn, type SignIn } from "../../shared/extension-auth";

/** Why the extension's storage could not be used: a browser holds it, or it is not a LevelDB. */
export class StorageError extends Error {
  constructor(
    readonly reason: "locked" | "missing" | "failed" | "mismatch",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The extension's `chrome.storage.local` folder, a LevelDB. Only ever used with the browser
 * not running: every call opens the database, and closes it before it returns.
 */
export interface ExtensionStorage {
  /**
   * Whether the LevelDB library can be loaded here. Asked before a browser is quit, so a build
   * without it (the CLI has no dependencies) leaves the browser alone.
   */
  available(): Promise<boolean>;
  /**
   * Every key and value the folder holds (JSON text); the caller picks the sign-in out of them
   * (`pickSignIn`). Throws a `StorageError`.
   */
  read(dir: string): Promise<[string, string][]>;
  /**
   * Puts `signIn`'s keys, and deletes the sign-in entries it lacks, in one batch, then reads the
   * folder again and compares. Keys that are not part of a sign-in are never touched. Throws a
   * `StorageError` on a failure and on a mismatch; the caller restores its backup.
   */
  write(dir: string, signIn: SignIn): Promise<void>;
}

async function openDatabase(dir: string) {
  // A real directory only: a link could lead into somebody else's files.
  let st;
  try {
    st = await fs.lstat(dir);
  } catch {
    throw new StorageError("missing", "The extension's storage folder is missing.");
  }
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new StorageError("failed", "The extension's storage is not a folder.");
  // Loaded when a switch gets here, so Relay and the CLI run without it until then.
  const { ClassicLevel } = await import("classic-level");
  const db = new ClassicLevel<string, string>(dir, {
    keyEncoding: "utf8",
    valueEncoding: "utf8",
    createIfMissing: false,
  });
  try {
    await db.open();
  } catch (error: any) {
    const text = `${error?.message ?? ""} ${error?.cause?.message ?? ""}`;
    throw new StorageError(
      /lock|already held|resource temporarily unavailable/i.test(text)
        ? "locked"
        : "failed",
      "The extension's storage could not be opened.",
    );
  }
  return db;
}

async function withDatabase<T>(
  dir: string,
  use: (db: Awaited<ReturnType<typeof openDatabase>>) => Promise<T>,
): Promise<T> {
  const db = await openDatabase(dir);
  try {
    return await use(db);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("failed", "The extension's storage failed.");
  } finally {
    await db.close().catch(() => {});
  }
}

/** At most this many entries are read: the extension keeps a few dozen. */
const MAX_ENTRIES = 5000;

async function readEntries(
  db: Awaited<ReturnType<typeof openDatabase>>,
): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for await (const [key, value] of db.iterator({ limit: MAX_ENTRIES }))
    entries.push([String(key), String(value)]);
  return entries;
}

/** The entries of `entries` that belong to a sign-in: what a write replaces. */
const signInPart = (entries: [string, string][], keep: SignIn): SignIn =>
  Object.fromEntries(
    entries.filter(([key, value]) => key in keep || isSignInEntry(key, value)),
  );

export const levelExtensionStorage: ExtensionStorage = {
  available: () =>
    import("classic-level").then(
      () => true,
      () => false,
    ),
  read: (dir) => withDatabase(dir, readEntries),
  async write(dir, signIn) {
    await withDatabase(dir, async (db) => {
      const current = signInPart(await readEntries(db), signIn);
      await db.batch(
        [
          ...Object.keys(current)
            .filter((key) => !(key in signIn))
            .map((key) => ({ type: "del" as const, key })),
          ...Object.entries(signIn).map(([key, value]) => ({
            type: "put" as const,
            key,
            value,
          })),
        ],
        { sync: true },
      );
    });
    // A second, separate open: what the browser will read, not what this handle remembers.
    const back = signInPart(await withDatabase(dir, readEntries), signIn);
    if (!sameSignIn(back, signIn))
      throw new StorageError("mismatch", "The extension's sign-in did not read back.");
  },
};

/** Copies `dir` into a new folder in `scratch` (mode 0700) and returns that folder. */
export async function backupFolder(dir: string, scratch: string): Promise<string> {
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  const backup = path.join(scratch, randomUUID());
  await fs.cp(dir, backup, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter: async (source) => {
      if ((await fs.lstat(source)).isSymbolicLink())
        throw new Error("The extension's storage holds a symbolic link.");
      return true;
    },
  });
  return backup;
}

/** Puts `backup`'s files in `dir`, which loses what it held. */
export async function restoreFolder(dir: string, backup: string): Promise<void> {
  for (const name of await fs.readdir(dir))
    await fs.rm(path.join(dir, name), { recursive: true, force: true });
  await fs.cp(backup, dir, { recursive: true, force: true, verbatimSymlinks: true });
}

/** A scratch folder holding the backups of a failed restore says so, and keeps them for a week. */
const KEPT_MARKER = ".kept";
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** Marks `scratch` as the only copy of what a failed restore could not put back. */
export async function keepScratch(scratch: string): Promise<void> {
  await fs.writeFile(path.join(scratch, KEPT_MARKER), "", { mode: 0o600 }).catch(() => {});
}

/** Removes one backup folder; never throws. */
export async function removeBackup(backup: string): Promise<void> {
  await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
}

/**
 * Removes Relay's scratch backups; never throws. A scratch folder marked by `keepScratch` stays
 * for a week: the next switch and the next start must not delete the user's only copy.
 */
export async function clearScratch(scratch: string): Promise<void> {
  const kept = await fs.stat(path.join(scratch, KEPT_MARKER)).catch(() => undefined);
  if (kept && Date.now() - kept.mtimeMs < KEPT_MS) return;
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
