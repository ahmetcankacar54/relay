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
// An unfinished copy beside `leveldb`, `leveldb.relay-<uuid>`, as an earlier restore left them.
const COPY = `${path.basename(LEVELDB)}.relay-`;
// Where a swap sets Claude's previous leveldb aside. Only the run that made one removes it,
// once its swap succeeded; the sweep never does.
const OLD = `${COPY}old-`;
// The working dir beside `leveldb` that holds the copy the helper edits: `.relay-work-<uuid>/leveldb`.
const WORK = ".relay-work-";
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

/** True when `<root>/Local Storage/leveldb` is a real directory. Never throws. */
async function leveldbInPlace(root: string): Promise<boolean> {
  try {
    return (await fs.lstat(path.join(root, LEVELDB))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Removes what an earlier draft step left beside `<root>/Local Storage/leveldb`: working dirs
 * (`.relay-work-*`) and unfinished copies (`leveldb.relay-<uuid>`). Never throws, and never
 * deletes a `leveldb.relay-old-*`, which holds a leveldb Claude used. Does nothing unless Local
 * Storage is a real directory and leveldb is in place, so it never reaches through a link and
 * never removes what may be the only copy of Claude's data.
 */
export async function sweepDraftLeftovers(root: string): Promise<void> {
  const storage = path.join(root, LOCAL_STORAGE);
  try {
    if (!(await fs.lstat(storage)).isDirectory()) return;
    if (!(await leveldbInPlace(root))) return;
    for (const name of await fs.readdir(storage))
      if (
        name.startsWith(WORK) ||
        (name.startsWith(COPY) && !name.startsWith(OLD))
      )
        await fs
          .rm(path.join(storage, name), { recursive: true, force: true })
          .catch(() => {});
  } catch {}
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
 * Copies `<root>/Local Storage/leveldb` to a new working dir beside it,
 * `<root>/Local Storage/.relay-work-<uuid>/leveldb`, and returns the working dir. Claude never
 * opens it. Throws when Local Storage or leveldb is missing or not a real directory, and when
 * the copy fails, after removing what it copied.
 */
export async function makeWorkingCopy(root: string): Promise<string> {
  const storage = path.join(root, LOCAL_STORAGE);
  const live = path.join(root, LEVELDB);
  if (
    !(await realDirectory(storage, LOCAL_STORAGE)) ||
    !(await realDirectory(live, LEVELDB))
  )
    throw new Error(`${LEVELDB} is missing.`);
  const work = path.join(storage, `${WORK}${randomUUID()}`);
  await fs.mkdir(work, { mode: 0o700 });
  try {
    await fs.cp(live, path.join(work, "leveldb"), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  } catch (e) {
    // A half copy must never be swapped in.
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return work;
}

/**
 * Writes the working copy to disk: every regular file in `<work>/leveldb`, then the directory
 * itself. After a crash, the leveldb a swap put in place is then not one only the page cache held.
 */
export async function syncWorkingCopy(work: string): Promise<void> {
  const copy = path.join(work, "leveldb");
  for (const entry of await fs.readdir(copy, { withFileTypes: true }))
    if (entry.isFile()) await syncPath(path.join(copy, entry.name));
  await syncPath(copy);
}

async function syncPath(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Thrown by `swapInWorkingCopy` when the copy could not be put in place and the original could
 * not be put back either. Live is then not Claude's leveldb as it was, whatever sits there: it
 * may be missing, or hold one Claude made meanwhile. The original is in the
 * `leveldb.relay-old-*` beside it, and the copy is still in the working dir.
 */
export class PutBackFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PutBackFailed";
  }
}

/**
 * Puts `<work>/leveldb` in place of `<root>/Local Storage/leveldb` by two renames: live aside to
 * `leveldb.relay-old-<uuid>`, then the copy into its place. Returns where the old leveldb is now.
 *
 * After any single failure live is either the original or fully replaced, never half deleted:
 * when the second rename fails, the original is renamed back. Throws when the swap did not
 * happen, with the second rename's error; as a `PutBackFailed` when the original could not be
 * put back either. `ops.rename` is a seam for tests.
 */
export async function swapInWorkingCopy(
  root: string,
  work: string,
  ops: Pick<typeof fs, "rename"> = fs,
): Promise<string> {
  const live = path.join(root, LEVELDB);
  const old = path.join(root, LOCAL_STORAGE, `${OLD}${randomUUID()}`);
  await ops.rename(live, old);
  try {
    await ops.rename(path.join(work, "leveldb"), live);
  } catch (e) {
    // Put the original back. Failing to is not allowed to hide `e`.
    try {
      await ops.rename(old, live);
    } catch {
      throw new PutBackFailed(e);
    }
    throw e;
  }
  return old;
}

/**
 * Removes a working dir made by `makeWorkingCopy`. Never throws. Like the sweep, it does
 * nothing while Claude's leveldb is missing. After a `PutBackFailed` it is not called at all:
 * a leveldb Claude made meanwhile may sit at live, and the copy is kept with the original.
 */
export async function discardWorkingCopy(
  root: string,
  work: string,
): Promise<void> {
  if (!(await leveldbInPlace(root))) return;
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
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
