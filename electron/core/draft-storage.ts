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
// What a restore leaves beside `leveldb` while it works (and when it cannot clean up).
const LEFTOVER = `${path.basename(LEVELDB)}.relay-`;
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
 * Removes what an earlier restore left in Local Storage. Never throws.
 * Only runs while `live` is a real directory: when it is missing, a
 * `leveldb.relay-old-*` may be the only copy of Claude's data left on disk.
 */
async function sweepLeftovers(storage: string, live: string): Promise<void> {
  try {
    if (!(await fs.lstat(live)).isDirectory()) return;
    for (const name of await fs.readdir(storage))
      if (name.startsWith(LEFTOVER))
        await fs
          .rm(path.join(storage, name), { recursive: true, force: true })
          .catch(() => {});
  } catch {}
}

/**
 * Removes what an earlier restore left beside `<root>/Local Storage/leveldb`.
 * Never throws. Does nothing unless Local Storage is a real directory and
 * leveldb is in place, so it never reaches through a link and never removes
 * what may be the only copy of Claude's data.
 */
export async function sweepRestoreLeftovers(root: string): Promise<void> {
  const storage = path.join(root, LOCAL_STORAGE);
  try {
    if (!(await fs.lstat(storage)).isDirectory()) return;
  } catch {
    return;
  }
  await sweepLeftovers(storage, path.join(root, LEVELDB));
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
      verbatimSymlinks: true,
    });
  } catch (e) {
    // A half copy must not pass for a backup, or count towards the kept ones.
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return backup;
}

/**
 * Replaces `<root>/Local Storage/leveldb` with an exact copy of
 * `<backup>/leveldb`, where `backup` is what `backupLocalStorage` returned.
 *
 * The copy is made beside the live directory first, then swapped in by two
 * renames (live aside, copy into place), so after any single failure live is
 * either the original or fully replaced, never half deleted. The old directory
 * is removed last; if that fails it is left as a stray `leveldb.relay-old-*`
 * for a later restore to sweep (once leveldb is in place again). `ops.rename` is a seam for tests.
 */
export async function restoreLocalStorage(
  root: string,
  backup: string,
  ops: Pick<typeof fs, "rename"> = fs,
): Promise<void> {
  if (!(await realDirectory(backup, "The backup")))
    throw new Error("The backup does not exist.");
  const source = path.join(backup, "leveldb");
  if (!(await realDirectory(source, "The backup's leveldb")))
    throw new Error("The backup has no leveldb directory.");
  const storage = path.join(root, LOCAL_STORAGE);
  if (!(await realDirectory(storage, LOCAL_STORAGE)))
    await fs.mkdir(storage, { recursive: true, mode: 0o700 });
  const live = path.join(root, LEVELDB);
  await sweepLeftovers(storage, live);

  const tag = randomUUID();
  const copy = path.join(storage, `${LEFTOVER}${tag}`);
  const old = path.join(storage, `${LEFTOVER}old-${tag}`);
  let swapped = false;
  try {
    await fs.cp(source, copy, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    let aside = false;
    try {
      await ops.rename(live, old);
      aside = true;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e; // nothing live to move: fine
    }
    try {
      await ops.rename(copy, live);
      swapped = true;
    } catch (e) {
      // Put the original back. Failing to is not allowed to hide `e`.
      if (aside) await ops.rename(old, live).catch(() => {});
      throw e;
    }
    await fs.rm(old, { recursive: true, force: true }).catch(() => {});
  } finally {
    if (!swapped)
      await fs.rm(copy, { recursive: true, force: true }).catch(() => {});
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
