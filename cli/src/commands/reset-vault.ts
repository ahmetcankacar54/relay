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
 * aside (never deleted), a new key is made, and every account's Claude Desktop link is cleared
 * so `relay add <name>` can link it again. Refused while the key can be read.
 */
export const resetVault: Command = async ({ io, deps, parsed, t }) => {
  if (parsed.positionals.length)
    throw new CliError(t("Kullanım: relay reset-vault", "Usage: relay reset-vault"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: true, desktop: false });
  if (ctx.vault.kind === "empty")
    throw new CliError(t("Kasa boş; sıfırlanacak bir şey yok.", "The vault is empty; nothing to reset."), EXIT.failed);
  if (ctx.vault.kind === "newer")
    throw new CliError(
      t("Kasayı daha yeni bir Relay yazmış; relay'i güncelleyin. Hiçbir şey değişmedi.", "A newer Relay wrote the vault; update relay. Nothing changed."),
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
        t(
          "Kasa hâlâ eski biçimde; kaybolabilecek bir anahtarı hiç olmadı. Relay.app 0.12'yi açın, kasayı kendisi taşır. Hiçbir şey değişmedi.",
          "The vault is still in the old format, so it never had a key to lose. Open Relay.app 0.12; it migrates the vault itself. Nothing changed.",
        ),
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
      t(
        "Önce Relay.app'ten çıkın (⌥⌘Q), sonra bunu yeniden çalıştırın; açık uygulama eski anahtarı bellekte tutar. Hiçbir şey değişmedi.",
        "Quit Relay.app first (⌥⌘Q), then run this again; a running app keeps the old key in memory. Nothing changed.",
      ),
      EXIT.busy,
    );
  try {
    await readVaultKey(ctx.deps.securityTool);
    throw new CliError(
      t("Kasa anahtarı okunabiliyor; sıfırlanacak bir şey yok.", "The vault key can be read; nothing to reset."),
      EXIT.failed,
    );
  } catch (error) {
    if (!(error instanceof VaultKeyError)) throw error;
    if (error.reason === "locked")
      throw new CliError(
        t("Keychain kilitli: Mac'in kilidini açıp yeniden deneyin. Hiçbir şey değişmedi.", "The Keychain is locked: unlock the Mac and try again. Nothing changed."),
        EXIT.environment,
      );
    if (error.reason === "invalid")
      throw new CliError(
        t(
          `Keychain'deki "${VAULT_KEY_SERVICE}" öğesi bozuk. Önce silin: security delete-generic-password -s "${VAULT_KEY_SERVICE}" — sonra yeniden çalıştırın.`,
          `The Keychain item "${VAULT_KEY_SERVICE}" is damaged. Delete it first: security delete-generic-password -s "${VAULT_KEY_SERVICE}" — then run this again.`,
        ),
        EXIT.environment,
      );
  }
  await confirm(
    io,
    t,
    [
      t(
        "Keychain'deki kasa anahtarı kayıp, bu yüzden kayıtlı Claude Desktop girişleri artık açılamıyor.",
        "The vault key is gone from the Keychain, so the saved Claude Desktop sign-ins can no longer be opened.",
      ),
      t(
        "Eski dosyalar desktop-vault/lost-key-… klasörüne ayrılacak, yeni bir anahtar oluşturulacak ve hesapların Claude Desktop bağlantıları silinecek.",
        "The old files will be set aside in desktop-vault/lost-key-…, a new key will be made, and every account's Claude Desktop link will be cleared.",
      ),
      t(
        "Sonra her hesabı, Claude Desktop'ta o hesap açıkken relay add <ad> ile yeniden kaydedin.",
        "Then save each account again with relay add <name> while it is signed in to Claude Desktop.",
      ),
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
    t(
      "Kasa sıfırlandı. Her hesabı, Claude Desktop'ta o hesap açıkken relay add <ad> ile yeniden kaydedin.",
      "The vault was reset. Save each account again with relay add <name> while it is signed in to Claude Desktop.",
    ),
  );
  return EXIT.ok;
};
