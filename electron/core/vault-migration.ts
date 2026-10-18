import fs from "node:fs/promises";
import path from "node:path";
import { isSealedV2, type Sealer } from "./vault-crypto";
import { jsonBytes, readBytes, readObject, writeBytes } from "./desktop-files";

/** The vault format this build reads and writes. */
export const VAULT_FORMAT = 2;

export type VaultState =
  | { kind: "empty" }
  | { kind: "ready" }
  | { kind: "legacy"; files: string[] }
  | { kind: "newer"; version: number };

/** The folders whose `.bin` files are sealed, and the draft vault's one file. */
const SEALED_DIRS = ["accounts", "backups"];
const DRAFTS = "drafts/pending.bin";

async function isPlainFile(file: string) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every sealed file in the vault, as paths relative to it, sorted. */
export async function sealedFiles(vault: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of SEALED_DIRS) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(vault, dir));
    } catch (error: any) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.sort())
      if (name.endsWith(".bin") && (await isPlainFile(path.join(vault, dir, name))))
        found.push(`${dir}/${name}`);
  }
  if (await isPlainFile(path.join(vault, DRAFTS))) found.push(DRAFTS);
  return found;
}

async function markerVersion(vault: string): Promise<number | undefined> {
  const marker = await readObject(vault, "format.json");
  if (!marker) return undefined;
  if (!Number.isSafeInteger(marker.version) || marker.version < 1)
    throw new Error("Invalid vault format marker.");
  return marker.version;
}

/** Old files not in format 2 yet, read without changing anything. */
async function legacyFiles(vault: string, files: string[]) {
  const legacy: string[] = [];
  for (const relative of files) {
    const data = await readBytes(vault, relative);
    if (data && !isSealedV2(data)) legacy.push(relative);
  }
  return legacy;
}

/**
 * What the vault holds: a newer format than this build knows; format 2 (marked, or every
 * sealed file already in it); nothing sealed yet; or old files still to migrate.
 */
export async function vaultState(vault: string): Promise<VaultState> {
  const version = await markerVersion(vault);
  if (version !== undefined && version > VAULT_FORMAT)
    return { kind: "newer", version };
  if (version === VAULT_FORMAT) return { kind: "ready" };
  const files = await sealedFiles(vault);
  if (!files.length) return { kind: "empty" };
  const legacy = await legacyFiles(vault, files);
  return legacy.length ? { kind: "legacy", files: legacy } : { kind: "ready" };
}

export async function markVaultFormat(vault: string): Promise<void> {
  await writeBytes(vault, "format.json", jsonBytes({ version: VAULT_FORMAT }));
}

/** Moves an unreadable file under `unreadable/`, keeping its relative path; never deletes it. */
async function moveAside(vault: string, relative: string) {
  let target = path.join(vault, "unreadable", relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.access(target);
    target += `.${Date.now()}`;
  } catch {
    // Free.
  }
  await fs.rename(path.join(vault, relative), target);
}

/**
 * Re-seals every old file in format 2, keeping its modification time, and writes the marker
 * once none is left. A run stopped half-way resumes, since format-2 files are skipped. A file
 * the old seal cannot open is moved aside, except the backup journal.json names: recovery
 * depends on it, so the migration stops there and changes nothing more.
 */
export async function migrateVault(
  vault: string,
  sealer: Sealer,
  legacyUnseal: (data: Buffer) => string,
): Promise<{ migrated: number; movedAside: string[] }> {
  const journal = await readObject(vault, "journal.json");
  const recovery =
    typeof journal?.backup === "string"
      ? `backups/${journal.backup.toLowerCase()}.bin`
      : undefined;
  let migrated = 0;
  const movedAside: string[] = [];
  for (const relative of await sealedFiles(vault)) {
    const data = await readBytes(vault, relative);
    if (!data || isSealedV2(data)) continue;
    let text: string;
    try {
      text = legacyUnseal(data);
    } catch {
      if (relative.toLowerCase() === recovery)
        throw new Error(
          "The recovery backup named in journal.json could not be opened, so the vault was not migrated further.",
        );
      await moveAside(vault, relative);
      movedAside.push(relative);
      continue;
    }
    const file = path.join(vault, relative);
    const { atime, mtime } = await fs.stat(file);
    await writeBytes(vault, relative, sealer.seal(text));
    await fs.utimes(file, atime, mtime);
    migrated++;
  }
  if (!(await legacyFiles(vault, await sealedFiles(vault))).length)
    await markVaultFormat(vault);
  return { migrated, movedAside };
}
