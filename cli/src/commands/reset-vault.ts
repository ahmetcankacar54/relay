import fs from "node:fs";
import path from "node:path";
import { VAULT_KEY_SERVICE, VaultKeyError, loadVaultKey, readVaultKey } from "../../../electron/core/vault-key";
import { readBytes } from "../../../electron/core/desktop-files";
import { isSealedV2 } from "../../../electron/core/vault-crypto";
import { markVaultFormat, sealedFiles } from "../../../electron/core/vault-migration";
import { relayAppRunning } from "../describe";
import type { Command } from "../command";
import { confirm } from "../confirm";
import { openContext } from "../context";
import { CliError, EXIT } from "../io";

/** What a lost key leaves unusable, set aside together. */
const SET_ASIDE = ["accounts", "backups", "drafts", "extension", "journal.json", "pending.json", "format.json"];

/**
 * Starts the vault over when its Keychain key is gone for good: the files it sealed are set
 * aside (never deleted), a new key is made, and every account's Claude app sign-in is cleared
 * so `relay add <name>` can link it again. Refused while the key can be read.
 */
export const resetVault: Command = async ({ io, deps, parsed, t }) => {
  if (parsed.positionals.length)
    throw new CliError(t("resetVault.usageRelayResetVault"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
  if (ctx.vault.kind === "empty")
    throw new CliError(t("resetVault.theVaultIsEmptyNothingTo"), EXIT.failed);
  if (ctx.vault.kind === "newer")
    throw new CliError(
      t("resetVault.aNewerRelayWroteTheVault"),
      EXIT.environment,
    );
  // An old-format vault never had a key: its sign-ins are sealed by Relay.app's own key, which
  // the app moves to the vault key itself. Only files sealed with the vault key can be orphaned.
  if (ctx.vault.kind === "legacy") {
    let anyV2 = false;
    for (const relative of await sealedFiles(ctx.paths.vault)) {
      const data = await readBytes(ctx.paths.vault, relative);
      if (data && isSealedV2(data)) anyV2 = true;
    }
    if (!anyV2)
      throw new CliError(
        t("resetVault.theVaultIsStillInThe"),
        EXIT.failed,
      );
  }
  // A running Relay.app keeps the key it loaded in memory and would go on sealing with it.
  let appRunning = false;
  try {
    appRunning = relayAppRunning(await ctx.deps.processList());
  } catch {
    // Unknown: go on; the operation lock below still guards a running operation.
  }
  if (appRunning)
    throw new CliError(
      t("resetVault.quitRelayAppFirstQThen"),
      EXIT.busy,
    );
  try {
    await readVaultKey(ctx.deps.securityTool);
    throw new CliError(
      t("resetVault.theVaultKeyCanBeRead"),
      EXIT.failed,
    );
  } catch (error) {
    if (!(error instanceof VaultKeyError)) throw error;
    if (error.reason === "locked")
      throw new CliError(
        t("resetVault.theKeychainIsLockedUnlockThe"),
        EXIT.environment,
      );
    if (error.reason === "invalid")
      throw new CliError(
        t("resetVault.theKeychainItemIsDamagedDelete", { VAULT_KEY_SERVICE }),
        EXIT.environment,
      );
  }
  await confirm(
    io,
    t,
    [
      t("resetVault.theVaultKeyIsGoneFrom"),
      t("resetVault.theOldFilesWillBeSet"),
      t("resetVault.thenSaveEachAccountAgainWith"),
    ],
    ctx.yes,
  );
  ctx.lock.tryAcquire("reset");
  try {
    const aside = path.join(ctx.paths.vault, `lost-key-${new Date(io.now()).toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(aside, { recursive: true, mode: 0o700 });
    for (const name of SET_ASIDE) {
      const from = path.join(ctx.paths.vault, name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(aside, name));
    }
    ctx.store.update((s) => {
      for (const account of s.accounts) delete account.desktop;
    });
    await loadVaultKey({ tool: ctx.deps.securityTool, mayCreate: true });
    await markVaultFormat(ctx.paths.vault);
  } finally {
    ctx.lock.release();
  }
  io.stdout(
    t("resetVault.theVaultWasResetSaveEach"),
  );
  return EXIT.ok;
};
