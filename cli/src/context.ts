import fs from "node:fs";
import path from "node:path";
import { DesktopManager } from "../../electron/core/desktop";
import { ProcessLock } from "../../electron/core/process-lock";
import { relayPaths, type RelayPaths } from "../../electron/core/relay-paths";
import { STATE_SCHEMA, Store } from "../../electron/core/store";
import { createSealer, type Sealer } from "../../electron/core/vault-crypto";
import { VAULT_KEY_SERVICE, VaultKeyError, loadVaultKey } from "../../electron/core/vault-key";
import {
  markVaultFormat,
  vaultState,
  type VaultState,
} from "../../electron/core/vault-migration";
import type { Flags } from "./args";
import { defaultDeps, type CliDeps } from "./deps";
import { olderThan, updateAppMessage } from "./guards";
import { pickLang, translator, type Lang, type Translate } from "./i18n";
import { CliError, EXIT, type CliIO } from "./io";
import { colorEnabled } from "./output";

export interface CliContext {
  paths: RelayPaths;
  store: Store;
  desktop: DesktopManager;
  /** The operation lock shared with Relay.app. */
  lock: ProcessLock;
  t: Translate;
  lang: Lang;
  io: CliIO;
  deps: CliDeps;
  flags: Flags;
  json: boolean;
  yes: boolean;
  color: boolean;
  vault: VaultState;
  appVersion?: string;
}

/** A sealer for commands that never open the vault. */
const closedSealer = (t: Translate): Sealer => {
  const refuse = () => {
    throw new Error(t("Kasa bu komut için açılmadı.", "The vault is not open for this command."));
  };
  return { seal: refuse, unseal: refuse };
};

/**
 * Everything a command needs, after the checks that keep the CLI from damaging what Relay.app
 * or a newer version wrote. `write`: the command changes the registry or the vault. `desktop`:
 * it runs a Desktop operation, so the vault key is loaded and DesktopManager initialized.
 */
export async function openContext(
  io: CliIO,
  partial: Partial<CliDeps>,
  flags: Flags,
  needs: { write: boolean; desktop: boolean },
): Promise<CliContext> {
  const deps = { ...defaultDeps(), ...partial };
  const lang = pickLang(flags.lang as string | undefined, io.env);
  const t = translator(lang);
  if (deps.platform !== "darwin")
    throw new CliError(t("relay yalnız macOS'ta çalışır.", "relay works on macOS only."), EXIT.environment);
  const paths = relayPaths(io.env);
  const appVersion = await deps.relayAppVersion();
  const stateExisted = fs.existsSync(path.join(paths.data, "state.json"));
  const store = new Store(paths.data, {
    by: "cli",
    backupOnOpen: false,
    migrateOnOpen: false,
    // A registry without a schema is Relay 0.11's; it is only taken over without an app.
    adoptUnversioned: appVersion === undefined,
  });
  if (needs.write) {
    if (appVersion !== undefined && olderThan(appVersion, "0.12.0"))
      throw new CliError(updateAppMessage(t), EXIT.environment);
    if (appVersion !== undefined && stateExisted && store.fileSchema < STATE_SCHEMA)
      throw new CliError(updateAppMessage(t), EXIT.environment);
    if (store.fileSchema > STATE_SCHEMA)
      throw new CliError(
        t(
          "Hesap listesini daha yeni bir Relay yazmış. relay'i güncelleyin: npm i -g @ahmetcankacar/relay",
          "A newer Relay wrote the account list. Update relay: npm i -g @ahmetcankacar/relay",
        ),
        EXIT.environment,
      );
  }
  const vault = await vaultState(paths.vault);
  if (needs.desktop && vault.kind === "newer")
    throw new CliError(
      t(
        "Kasayı daha yeni bir Relay yazmış. relay'i güncelleyin: npm i -g @ahmetcankacar/relay",
        "A newer Relay wrote the vault. Update relay: npm i -g @ahmetcankacar/relay",
      ),
      EXIT.environment,
    );
  if (needs.desktop && needs.write && vault.kind === "legacy")
    throw new CliError(
      appVersion !== undefined && !olderThan(appVersion, "0.12.0")
        ? t(
            "Relay.app kasayı henüz yeni biçime taşımadı. Relay.app'i açın ve Keychain sorusuna (\"Relay Safe Storage\") izin verin; sorun sürerse uygulamadaki uyarıya bakın.",
            "Relay.app has not moved the vault to the new format yet. Open Relay.app and allow its Keychain prompt (\"Relay Safe Storage\"); if it persists, see the warning the app shows.",
          )
        : updateAppMessage(t),
      EXIT.environment,
    );
  let sealer = closedSealer(t);
  if (needs.desktop && needs.write) {
    try {
      sealer = createSealer(
        await loadVaultKey({ tool: deps.securityTool, mayCreate: vault.kind === "empty" }),
      );
    } catch (error) {
      if (!(error instanceof VaultKeyError)) throw error;
      throw new CliError(
        error.reason === "missing"
          ? t(
              `Keychain'de "${VAULT_KEY_SERVICE}" öğesi yok, bu yüzden kayıtlı girişler açılamıyor. Baştan başlamak için: relay reset-vault`,
              `The Keychain item "${VAULT_KEY_SERVICE}" is missing, so saved sign-ins cannot be opened. To start over: relay reset-vault`,
            )
          : error.reason === "locked"
            ? t(
                `Keychain'deki "${VAULT_KEY_SERVICE}" öğesi okunamadı. Mac'in kilidini (oturum anahtar zincirini) açıp yeniden deneyin.`,
                `The Keychain item "${VAULT_KEY_SERVICE}" could not be read. Unlock the Mac's login keychain and try again.`,
              )
            : t(
                `Keychain'deki "${VAULT_KEY_SERVICE}" öğesi bir kasa anahtarı değil.`,
                `The Keychain item "${VAULT_KEY_SERVICE}" does not hold a vault key.`,
              ),
        EXIT.environment,
      );
    }
    if (!fs.existsSync(path.join(paths.vault, "format.json"))) await markVaultFormat(paths.vault);
  }
  const host = deps.host(sealer, paths.claudeApps);
  // The CLI never captures drafts; its own scratch folder keeps the start-up sweep away from
  // a capture Relay.app may be running.
  host.draftScratchDir = path.join(paths.data, "cli-scratch");
  const desktop = new DesktopManager(paths.claude, store, host, deps.transcriptRoot);
  // The Claude extension's sign-in follows the account here too; its backup stays out of the app's.
  desktop.extension = deps.extension;
  desktop.extensionScratchDir = path.join(paths.data, "cli-scratch", "extension");
  const lock = new ProcessLock(path.join(paths.vault, "operation.lock"), "cli");
  desktop.operationLock = {
    ensure: (kind) => {
      lock.tryAcquire(kind);
      return () => lock.release();
    },
  };
  if (needs.desktop) await desktop.initialize();
  return {
    paths,
    store,
    desktop,
    lock,
    t,
    lang,
    io,
    deps,
    flags,
    json: !!flags.json,
    yes: !!flags.yes,
    color: colorEnabled(io, flags),
    vault,
    appVersion,
  };
}
