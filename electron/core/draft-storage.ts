import fs from "node:fs/promises";
import path from "node:path";

/** Claude's Chromium Local Storage, under the Claude root. */
export const LOCAL_STORAGE = "Local Storage";
/** The LevelDB directory inside it, which holds the drafts. */
export const LEVELDB = "Local Storage/leveldb";

// The first design (draft preservation) left these behind; this one only removes them.
// Its plaintext backups of Local Storage, `<vault>/drafts/<stamp>`, where the stamp is
// `now.toISOString()` with `:` and `.` replaced by `-`.
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
// Its unfinished copies beside `leveldb`, `leveldb.relay-<uuid>`.
const COPY = `${path.basename(LEVELDB)}.relay-`;
// Where it set Claude's previous leveldb aside. That holds a leveldb Claude used: never removed.
const OLD = `${COPY}old-`;
// Its working dirs beside `leveldb`, `.relay-work-<uuid>`.
const WORK = ".relay-work-";

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
 * Copies `<root>/Local Storage/leveldb` to `<storage>/leveldb`, making `storage` (mode 0700;
 * one that exists already is never copied into). Returns false, making nothing, when Local
 * Storage or leveldb is missing. Throws when either is a symlink or not a directory, and when
 * leveldb holds a link that would lead the copy out of itself: an absolute one, or a relative
 * one that climbs out of leveldb. Followed from the copy, either could reach Claude's own
 * files. Relative links inside are copied as they are, so they lead into the copy.
 */
export async function copyLocalStorage(
  root: string,
  storage: string,
): Promise<boolean> {
  if (!(await realDirectory(path.join(root, LOCAL_STORAGE), LOCAL_STORAGE)))
    return false;
  const live = path.join(root, LEVELDB);
  if (!(await realDirectory(live, LEVELDB))) return false;
  await fs.mkdir(storage, { mode: 0o700 });
  await fs.cp(live, path.join(storage, "leveldb"), {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter: async (source) => {
      if (!(await fs.lstat(source)).isSymbolicLink()) return true;
      const target = await fs.readlink(source);
      const inside = path.relative(
        live,
        path.resolve(path.dirname(source), target),
      );
      if (
        path.isAbsolute(target) ||
        inside === "" ||
        inside === ".." ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside)
      )
        throw new Error(
          `${LEVELDB}/${path.relative(live, source)} leads out of ${LEVELDB}.`,
        );
      return true;
    },
  });
  return true;
}

/**
 * Removes what the first design left beside `<root>/Local Storage/leveldb`: working dirs
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
 * Removes the first design's plaintext backups of Claude's Local Storage: the real directories
 * in `<vault>/drafts` named like a stamp. Everything else there, such as `pending.bin` and
 * `last.json`, stays. Never follows a link, the drafts dir included, and never throws.
 */
export async function removeLegacyDraftBackups(vault: string): Promise<void> {
  const drafts = path.join(vault, "drafts");
  try {
    if (!(await realDirectory(drafts, "The drafts directory"))) return;
    // Dirents come from lstat: a link named like a stamp is not a directory here.
    for (const entry of await fs.readdir(drafts, { withFileTypes: true }))
      if (entry.isDirectory() && STAMP.test(entry.name))
        await fs
          .rm(path.join(drafts, entry.name), { recursive: true, force: true })
          .catch(() => {});
  } catch {}
}
