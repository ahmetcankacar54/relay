import fs from "node:fs";
import path from "node:path";
import { DesktopManager } from "../../electron/core/desktop";
import { ProcessLock } from "../../electron/core/process-lock";
import { relayPaths, type RelayPaths } from "../../electron/core/relay-paths";
import { STATE_SCHEMA, Store } from "../../electron/core/store";
import { createSealer, type Sealer } from "../../electron/core/vault-crypto";
import { DesktopWindows } from "../../electron/core/desktop-windows";
import { VAULT_KEY_SERVICE, VaultKeyError, loadVaultKey } from "../../electron/core/vault-key";
import {
  markVaultFormat,
  vaultState,
  type VaultState,
} from "../../electron/core/vault-migration";
import type { Flags } from "./args";
import { defaultDeps, type CliDeps } from "./deps";
import { appOlderMessage, olderThan, updateAppMessage } from "./guards";
import { pickLang, translator } from "./i18n";
import type { Locale } from "../../shared/i18n/locales";
import type { T } from "../../shared/i18n/translate";
import { CliError, EXIT, type CliIO } from "./io";
import { colorEnabled } from "./output";

export interface CliContext {
  paths: RelayPaths;
  store: Store;
  desktop: DesktopManager;
  /** The operation lock shared with Relay.app. */
  lock: ProcessLock;
  t: T;
  lang: Locale;
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
const closedSealer = (t: T): Sealer => {
  const refuse = () => {
    throw new Error(t("srcContext.theVaultIsNotOpenFor"));
  };
  return { seal: refuse, unseal: refuse };
};

/**
 * Everything a command needs, after the checks that keep the CLI from damaging what Relay.app
 * or a newer version wrote. `write`: the command changes the registry or the vault. `desktop`:
 * it runs a Desktop operation, so the vault key is loaded and DesktopManager initialized.
 * `macOS`: the command needs macOS's own tools. A Desktop operation that writes does too: the
 * CLI opens the vault through the macOS Keychain; on Windows and Linux only Relay.app holds its key.
 */
export async function openContext(
  io: CliIO,
  partial: Partial<CliDeps>,
  flags: Flags,
  needs: { write: boolean; desktop: boolean; macOS?: boolean },
): Promise<CliContext> {
  const deps = { ...defaultDeps(), ...partial };
  const lang = pickLang(flags.lang as string | undefined, io.env);
  const t = translator(lang);
  if (deps.platform !== "darwin" && (needs.macOS || (needs.desktop && needs.write)))
    throw new CliError(t("srcContext.savingAndSwitchingWorksOnMacosOnly"), EXIT.environment);
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
      throw new CliError(appOlderMessage(t), EXIT.environment);
    if (store.fileSchema > STATE_SCHEMA)
      throw new CliError(
        t("srcContext.aNewerRelayWroteTheAccount"),
        EXIT.environment,
      );
  }
  const vault = await vaultState(paths.vault);
  if (needs.desktop && vault.kind === "newer")
    throw new CliError(
      t("srcContext.aNewerRelayWroteTheVault"),
      EXIT.environment,
    );
  if (needs.desktop && needs.write && vault.kind === "legacy")
    throw new CliError(
      appVersion !== undefined && !olderThan(appVersion, "0.12.0")
        ? t("srcContext.relayAppHasNotMovedThe")
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
          ? t("srcContext.theKeychainItemIsMissingSo", { VAULT_KEY_SERVICE })
          : error.reason === "locked"
            ? t("srcContext.theKeychainItemCouldNotBe", { VAULT_KEY_SERVICE })
            : t("srcContext.theKeychainItemDoesNotHold", { VAULT_KEY_SERVICE }),
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
  // And the terminal's Claude Code sign-in.
  desktop.terminal = deps.terminal;
  // The app's separate Claude windows: a switch to an account open in one is refused here too,
  // and the main Claude takes over a closed window's conversations.
  const windows = new DesktopWindows({
    folder: path.join(paths.data, "claude-windows"),
    host,
    current: async () => undefined,
    seed: async () => {
      throw new Error("relay opens no separate windows.");
    },
    seal: async () => false,
    now: Date.now,
  });
  desktop.windows = {
    openAccounts: () => windows.openAccounts(),
    anyOpen: () => windows.anyOpen(),
    folder: (accountUuid) => windows.folderOf(accountUuid),
  };
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
