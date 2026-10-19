import fs from "node:fs/promises";
import path from "node:path";
import { createSealer, isSealedV2, type Sealer } from "./vault-crypto";
import { VAULT_KEY_SERVICE, VaultKeyError, loadVaultKey } from "./vault-key";
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
 * once none is left. A run stopped half-way resumes, since format-2 files are skipped. Every old
 * file is opened before anything changes:
 * - none opens, and none was migrated before: the old seal is unusable this run (macOS refused
 *   it), so nothing moves and no marker is written; the next start tries again;
 * - the backup journal.json names does not open: recovery depends on it, so nothing moves;
 * - otherwise each file that does not open is moved aside, never deleted.
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
  const opened = new Map<string, string>();
  const failed: string[] = [];
  let anyV2 = false;
  for (const relative of await sealedFiles(vault)) {
    const data = await readBytes(vault, relative);
    if (data && isSealedV2(data)) anyV2 = true;
    if (!data || isSealedV2(data)) continue;
    try {
      opened.set(relative, legacyUnseal(data));
    } catch {
      failed.push(relative);
    }
  }
  // Nothing opening at all means the old seal was refused this run, unless an earlier run
  // already migrated files with it: then what is left is damaged, and is set aside below.
  if (failed.length && !opened.size && !anyV2)
    throw new Error(
      "None of the old vault files could be opened, so nothing was moved. Relay tries again at its next start.",
    );
  if (recovery && failed.some((relative) => relative.toLowerCase() === recovery))
    throw new Error(
      "The recovery backup named in journal.json could not be opened, so the vault was not migrated.",
    );
  let migrated = 0;
  for (const [relative, text] of opened) {
    const file = path.join(vault, relative);
    const { atime, mtime } = await fs.stat(file);
    await writeBytes(vault, relative, sealer.seal(text));
    await fs.utimes(file, atime, mtime);
    migrated++;
  }
  for (const relative of failed) await moveAside(vault, relative);
  if (!(await legacyFiles(vault, await sealedFiles(vault))).length)
    await markVaultFormat(vault);
  return { migrated, movedAside: failed };
}

/** A sealer for a vault that cannot be used: every seal, and every format-2 unseal, says why. */
function refusingSealer(message: string, legacyUnseal?: (data: Buffer) => string): Sealer {
  return {
    seal: () => {
      throw new Error(message);
    },
    unseal: (data) => {
      if (legacyUnseal && !isSealedV2(data)) return legacyUnseal(data);
      throw new Error(message);
    },
  };
}

/**
 * Readies the app's vault at startup: loads the Keychain key, creating it only while no
 * format-2 file needs an existing one; migrates old files; marks the format. It never throws:
 * `error` says what went wrong, and the sealer then refuses with that message, except that old
 * files stay readable through `legacyUnseal`.
 */
export async function prepareVault(options: {
  vault: string;
  legacyUnseal: (data: Buffer) => string;
  /** Whether the old seal can be used now; false when macOS refused its key this run. */
  legacyAvailable?: () => boolean;
  tool?: string;
}): Promise<{
  sealer: Sealer;
  migration?: { migrated: number; movedAside: string[] };
  error?: string;
}> {
  const { vault, legacyUnseal, tool } = options;
  let state: VaultState;
  try {
    state = await vaultState(vault);
  } catch (error) {
    const message = `Relay's vault could not be read: ${(error as Error).message}`;
    return { sealer: refusingSealer(message, legacyUnseal), error: message };
  }
  if (state.kind === "newer") {
    const message = `Relay's vault was written by a newer version (format ${state.version}). Update Relay.`;
    return { sealer: refusingSealer(message), error: message };
  }
  // A key is only ever made for a vault no format-2 file depends on: one a migration stopped
  // half-way through already has some, sealed with the key that is missing now.
  let anyV2 = false;
  if (state.kind === "legacy")
    for (const relative of await sealedFiles(vault)) {
      const data = await readBytes(vault, relative);
      if (data && isSealedV2(data)) anyV2 = true;
    }
  let key: Buffer;
  try {
    key = await loadVaultKey({
      tool,
      mayCreate: state.kind === "empty" || (state.kind === "legacy" && !anyV2),
    });
  } catch (error) {
    const lost = error instanceof VaultKeyError && error.reason !== "locked";
    const message =
      state.kind === "ready" || anyV2
        ? `The Keychain item "${VAULT_KEY_SERVICE}" could not be read, so saved Desktop sign-ins cannot be opened. ${(error as Error).message}${lost ? " To start over, run relay reset-vault (npm i -g @ahmetcankacar/relay) and save each account again." : ""}`
        : `The Keychain item "${VAULT_KEY_SERVICE}" could not be read. ${(error as Error).message}`;
    return { sealer: refusingSealer(message, legacyUnseal), error: message };
  }
  const sealer = createSealer(key, legacyUnseal);
  try {
    if (state.kind === "legacy") {
      if (options.legacyAvailable && !options.legacyAvailable())
        return {
          sealer,
          error:
            "Relay could not open its old vault this time (macOS did not allow access to its key). Nothing was moved; Relay tries again at its next start.",
        };
      const migration = await migrateVault(vault, sealer, legacyUnseal);
      return migration.movedAside.length
        ? {
            sealer,
            migration,
            error: `${migration.movedAside.length} vault file(s) could not be opened and were set aside in desktop-vault/unreadable. Save the affected accounts again.`,
          }
        : { sealer, migration };
    }
    await markVaultFormat(vault);
    return { sealer };
  } catch (error) {
    return { sealer, error: (error as Error).message };
  }
}
