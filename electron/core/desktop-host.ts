import { app, safeStorage } from "electron";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { DesktopHost } from "./desktop";
import { nodeDesktopHost } from "./desktop-host-node";
import { draftsBlockedReason, runHelper } from "./draft-transfer";
import type { Sealer } from "./vault-crypto";

/** Whether safeStorage can be used now; false when macOS refused its key. */
export const safeStorageAvailable = () => safeStorage.isEncryptionAvailable();

/** Electron's safeStorage as a sealer: the vault's format before 0.12. */
export function safeStorageSealer(): Sealer {
  return {
    seal: (text) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error(
          "System encryption is unavailable. Desktop sign-in was not saved.",
        );
      return safeStorage.encryptString(text);
    },
    unseal: (data) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("System encryption is unavailable.");
      return safeStorage.decryptString(data);
    },
  };
}

/** The app's Desktop host: the Node host, plus draft capture through Relay's own Electron. */
export function desktopHost(
  sealer: Sealer,
  chosen?: () => string | undefined,
): DesktopHost {
  const base = nodeDesktopHost({ sealer, chosen });
  return {
    ...base,
    draftsBlocked: async () =>
      draftsBlockedReason(
        process.platform,
        process.platform === "darwin" ? await base.claudeElectron?.() : undefined,
        process.versions.electron,
      ),
    readDrafts: (job) =>
      runHelper(job, {
        execPath: process.execPath,
        packaged: app.isPackaged,
        // dist-electron, beside main.cjs, once bundled.
        dir: __dirname,
        env: process.env,
        spawn,
        writeFile: fs.promises.writeFile,
        readFile: fs.promises.readFile,
      }),
  };
}
