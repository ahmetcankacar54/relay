import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SIGN_IN_KEYS,
  pickSignIn,
  sameSignIn,
  type SignIn,
} from "../../shared/extension-auth";

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
  /** The sign-in the folder holds; undefined when it holds none. Throws a `StorageError`. */
  read(dir: string): Promise<SignIn | undefined>;
  /**
   * Puts `signIn`'s keys, and deletes the sign-in keys it lacks, in one batch, then reads the
   * folder again and compares. Throws a `StorageError` on a failure and on a mismatch; the
   * caller restores its backup.
   */
  write(dir: string, signIn: SignIn): Promise<void>;
  /**
   * The names of the keys the folder holds, never a value: what a check logs when it finds no
   * sign-in, so a renamed key can be told from a signed-out extension.
   */
  keyNames?(dir: string): Promise<string[]>;
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

async function readKeys(
  db: Awaited<ReturnType<typeof openDatabase>>,
): Promise<SignIn | undefined> {
  const keys = [...SIGN_IN_KEYS];
  const values = await db.getMany(keys);
  return pickSignIn(keys.map((key, i) => [key, values[i]] as const));
}

export const levelExtensionStorage: ExtensionStorage = {
  available: () =>
    import("classic-level").then(
      () => true,
      () => false,
    ),
  read: (dir) => withDatabase(dir, readKeys),
  keyNames: (dir) =>
    withDatabase(dir, async (db) => {
      const names: string[] = [];
      for await (const key of db.keys({ limit: 200 })) names.push(String(key).slice(0, 80));
      return names;
    }),
  async write(dir, signIn) {
    await withDatabase(dir, (db) =>
      db.batch(
        SIGN_IN_KEYS.map((key) =>
          key in signIn
            ? { type: "put" as const, key, value: signIn[key] }
            : { type: "del" as const, key },
        ),
        { sync: true },
      ),
    );
    // A second, separate open: what the browser will read, not what this handle remembers.
    const back = await withDatabase(dir, readKeys);
    if (!back || !sameSignIn(back, signIn))
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

/** Removes Relay's scratch backups; never throws. */
export async function clearScratch(scratch: string): Promise<void> {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
