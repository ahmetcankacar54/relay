import fs from "node:fs/promises";
import path from "node:path";
import { readObject } from "./desktop-files";

/** How many switch backups (`<vault>/backups/<id>.bin`) the vault keeps. */
export const SWITCH_BACKUP_LIMIT = 20;

const BACKUP =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.bin$/i;

/**
 * Removes all but the newest `keep` switch backups, by modification time. The backup the
 * recovery journal (`journal.json`) names is never removed, however old: recovery restores
 * exactly that one. A journal that cannot be read removes nothing. Never throws, so pruning can
 * never fail a switch; returns how many backups it removed.
 */
export async function pruneSwitchBackups(
  vault: string,
  keep = SWITCH_BACKUP_LIMIT,
): Promise<number> {
  try {
    const journal = await readObject(vault, "journal.json");
    const referenced =
      typeof journal?.backup === "string"
        ? journal.backup.toLowerCase()
        : undefined;
    const dir = path.join(vault, "backups");
    const found: { name: string; id: string; mtime: number }[] = [];
    for (const name of await fs.readdir(dir)) {
      const match = BACKUP.exec(name);
      if (!match) continue;
      const stat = await fs.lstat(path.join(dir, name));
      if (!stat.isFile()) continue;
      found.push({ name, id: match[1].toLowerCase(), mtime: stat.mtimeMs });
    }
    found.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    let removed = 0;
    for (const backup of found.slice(keep)) {
      if (backup.id === referenced) continue;
      await fs.rm(path.join(dir, backup.name), { force: true });
      removed++;
    }
    return removed;
  } catch {
    // An old backup left behind costs a little disk; a failed switch costs far more.
    return 0;
  }
}
