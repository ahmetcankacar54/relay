/** Settings → Advanced → Back up and Import: the sealed account backups. */
import { app, dialog, shell } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  BACKUP_EXTENSION,
  MIN_BACKUP_PASSPHRASE,
  type BackupExportResult,
  type BackupFileChoice,
  type BackupImportMode,
  type BackupImportResult,
  type BackupSummary,
} from "../../shared/backup";
import {
  BackupError,
  claudeCodeSignIns,
  collectBackup,
  importBackup,
  openBackup,
  readBackupHeader,
  sealBackup,
  summarizeBackup,
  MAX_BACKUP_BYTES,
  type BackupContext,
  type OpenedBackup,
} from "../core/backup";
import { say } from "../i18n";
import { antigravityBridges } from "./antigravity";
import { manualDesktopLock } from "./desktop-lock";
import { recordMainError } from "./errors";
import { applyProxyConfig, proxySettings, serializeProxy } from "./gateway";
import { keeper, service, tray, usage, vaultSealer } from "./state";
import { addTokenRoots } from "./tokens-widget";
import { broadcastChanged, openDialog, window } from "./windows";
/**
 * The backup picked for import, kept in memory between the dialog's steps: the file, then once the
 * passphrase opened it, the payload and its key. The passphrase itself is never kept.
 */
export let pendingBackup: { file: Buffer; opened?: OpenedBackup } | undefined;
/** Where backups read and put back secrets on this computer; refused until the vault is ready. */
function backupContext(): BackupContext {
  if (!vaultSealer) throw new Error(say("dataBackup.errorVaultNotReady"));
  return {
    host: { data: service.store.root, sealer: vaultSealer, claudeCode: claudeCodeSignIns() },
    relayVersion: app.getVersion(),
    platform: process.platform,
    now: Date.now,
  };
}
/** A backup's refusal in the app's language; any other error as it came. */
function backupFailure(error: unknown): unknown {
  if (!(error instanceof BackupError)) return error;
  switch (error.reason) {
    case "not-a-backup":
      return new Error(say("dataBackup.errorNotABackup"));
    case "newer-format":
      return new Error(say("dataBackup.errorNewerFormat"));
    case "wrong-passphrase":
      return new Error(say("dataBackup.errorWrongPassphrase"));
    case "damaged":
      return new Error(say("dataBackup.errorDamaged"));
    case "too-large":
      return new Error(say("dataBackup.errorTooLarge"));
    case "short-passphrase":
      return new Error(say("dataBackup.errorShortPassphrase", { count: MIN_BACKUP_PASSPHRASE }));
  }
}
/**
 * Settings → Advanced → Back up: the accounts, settings and, when chosen, the saved sign-ins,
 * sealed with the passphrase into a file the user places, then shown. Undefined when the dialog
 * was cancelled. The passphrase only derives the key; it is never stored.
 */
export async function exportBackup(passphrase: string, includeSignIns: boolean): Promise<BackupExportResult | undefined> {
  const context = backupContext();
  if ([...passphrase].length < MIN_BACKUP_PASSPHRASE) throw backupFailure(new BackupError("short-passphrase"));
  const options: Electron.SaveDialogOptions = {
    defaultPath: path.join(
      app.getPath("documents"),
      `relay-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXTENSION}`,
    ),
    filters: [{ name: "Relay", extensions: [BACKUP_EXTENSION] }],
  };
  const { canceled, filePath } =
    window && !window.isDestroyed()
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return undefined;
  const { settings, accounts } = service.store.state;
  const payload = await collectBackup({ settings, accounts, gateway: proxySettings() }, includeSignIns, context);
  const file = await sealBackup(payload, passphrase).catch((error: unknown) => {
    throw backupFailure(error);
  });
  await fsp.writeFile(filePath, file, { mode: 0o600 });
  shell.showItemInFolder(filePath);
  return {
    accounts: payload.accounts.length,
    signIns: summarizeBackup(payload, []).accounts.filter((account) => account.signIn).length,
  };
}
/** Import, first step: the file, checked before any passphrase is asked. Undefined when cancelled. */
export async function chooseBackup(): Promise<BackupFileChoice | undefined> {
  const { canceled, filePaths } = await openDialog({
    properties: ["openFile"],
    filters: [{ name: "Relay", extensions: [BACKUP_EXTENSION] }],
  });
  const picked = filePaths[0];
  if (canceled || !picked) return undefined;
  const stat = await fsp.stat(picked);
  if (!stat.isFile()) throw backupFailure(new BackupError("not-a-backup"));
  if (stat.size > MAX_BACKUP_BYTES) throw backupFailure(new BackupError("too-large"));
  const file = await fsp.readFile(picked);
  try {
    readBackupHeader(file);
  } catch (error) {
    throw backupFailure(error);
  }
  pendingBackup = { file };
  return { name: path.basename(picked) };
}
/** Import, second step: opens the picked file with the passphrase and answers what it holds. */
export async function readBackup(passphrase: string): Promise<BackupSummary> {
  const pending = pendingBackup;
  if (!pending) throw new Error(say("dataBackup.errorNoFile"));
  try {
    pending.opened = await openBackup(pending.file, passphrase);
  } catch (error) {
    throw backupFailure(error);
  }
  return summarizeBackup(pending.opened.payload, service.store.state.accounts);
}
/**
 * Import, last step, under the Desktop lock: brings the opened backup in (core/backup.ts), then
 * applies a replace's gateway settings through the gateway's own path and lets go of the accounts
 * a replace took out of the list.
 */
export async function applyBackup(mode: BackupImportMode): Promise<BackupImportResult> {
  const opened = pendingBackup?.opened;
  if (!opened) throw new Error(say("dataBackup.errorNoFile"));
  const context = backupContext();
  const before = service.store.state.accounts.map((account) => account.id);
  const { result, gateway } = await manualDesktopLock(() =>
    service.transaction(() => importBackup(opened, mode, service.store, proxySettings(), context)),
  ).catch((error: unknown) => {
    throw backupFailure(error);
  });
  pendingBackup = undefined;
  const kept = new Set(service.store.state.accounts.map((account) => account.id));
  for (const id of before.filter((id) => !kept.has(id))) {
    antigravityBridges.get(id)?.stop();
    antigravityBridges.delete(id);
    usage.forget(id);
  }
  if (gateway)
    await serializeProxy(() => applyProxyConfig({ ...proxySettings(), ...gateway })).catch((error: unknown) =>
      recordMainError("backup-gateway", error),
    );
  void addTokenRoots();
  keeper.resume();
  void keeper.tick();
  void tray?.update();
  broadcastChanged();
  return result;
}
/** The import dialog was closed: the picked backup is dropped. */
export function forgetPendingBackup() {
  pendingBackup = undefined;
}
