import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Claude's Chromium Local Storage, under the Claude root. */
export const LOCAL_STORAGE = "Local Storage";
/** The LevelDB directory inside it, which holds the drafts. */
export const LEVELDB = "Local Storage/leveldb";

const DRAFTS = "drafts";
// `now.toISOString()` with `:` and `.` replaced by `-`.
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

/**
 * True when `target` is a real directory and false when it does not exist.
 * Throws on a symlink or any other kind of file, so nothing is ever read or
 * written through a link.
 */
async function realDirectory(target: string, name: string): Promise<boolean> {
  let st;
  try {
    st = await fs.lstat(target);
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`${name} is a symbolic link.`);
  if (!st.isDirectory()) throw new Error(`${name} is not a directory.`);
  return true;
}

/**
 * Copies `<root>/Local Storage/leveldb` to `<vault>/drafts/<stamp>/leveldb`
 * and returns `<vault>/drafts/<stamp>`, or undefined when leveldb is missing.
 * Throws when leveldb (or Local Storage) is a symlink or not a directory, and
 * when a backup with the same stamp already exists.
 */
export async function backupLocalStorage(
  root: string,
  vault: string,
  now: Date,
): Promise<string | undefined> {
  if (!(await realDirectory(path.join(root, LOCAL_STORAGE), LOCAL_STORAGE)))
    return undefined;
  const source = path.join(root, LEVELDB);
  if (!(await realDirectory(source, LEVELDB))) return undefined;

  const drafts = path.join(vault, DRAFTS);
  if (!(await realDirectory(drafts, "The drafts directory")))
    await fs.mkdir(drafts, { recursive: true, mode: 0o700 });
  const backup = path.join(drafts, stamp(now));
  // Not recursive: a backup that already has this stamp must not be mixed into.
  await fs.mkdir(backup, { mode: 0o700 });
  try {
    await fs.cp(source, path.join(backup, "leveldb"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  } catch (e) {
    // A half copy must not pass for a backup, or count towards the kept ones.
    await fs.rm(backup, { recursive: true, force: true });
    throw e;
  }
  return backup;
}

/**
 * Replaces `<root>/Local Storage/leveldb` with an exact copy of
 * `<backup>/leveldb`, where `backup` is what `backupLocalStorage` returned.
 * The copy is made beside the live directory first, so a backup that cannot be
 * read leaves the live directory as it was.
 */
export async function restoreLocalStorage(
  root: string,
  backup: string,
): Promise<void> {
  const source = path.join(backup, "leveldb");
  if (!(await realDirectory(source, "The backup's leveldb")))
    throw new Error("The backup has no leveldb directory.");
  const storage = path.join(root, LOCAL_STORAGE);
  if (!(await realDirectory(storage, LOCAL_STORAGE)))
    await fs.mkdir(storage, { recursive: true, mode: 0o700 });

  const live = path.join(root, LEVELDB);
  const copy = `${live}.relay-${randomUUID()}`;
  try {
    await fs.cp(source, copy, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await fs.rm(live, { recursive: true, force: true });
    await fs.rename(copy, live);
  } finally {
    await fs.rm(copy, { recursive: true, force: true });
  }
}

/**
 * Deletes all but the `keep` newest `<vault>/drafts/<stamp>` directories.
 * Only real directories named like a stamp are considered, so `last.json`,
 * other entries and anything outside `<vault>/drafts` are never touched.
 */
export async function pruneDraftBackups(
  vault: string,
  keep = 3,
): Promise<void> {
  if (!Number.isInteger(keep) || keep < 0)
    throw new RangeError("keep must be a non-negative integer.");
  const drafts = path.join(vault, DRAFTS);
  if (!(await realDirectory(drafts, "The drafts directory"))) return;
  const stamps = (await fs.readdir(drafts, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && STAMP.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of stamps.slice(keep))
    await fs.rm(path.join(drafts, name), { recursive: true, force: true });
}
