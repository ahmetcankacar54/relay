import { app } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Account } from "../../shared/types";
import { readBytes, writeBytes } from "../core/desktop-files";
import { DESKTOP_USAGE_MARKER, DesktopUsageReader, safeStoragePassword } from "../core/desktop-usage";
import { linuxSafeStoragePassword } from "../core/linux-safe-storage";
import type { Sealer } from "../core/vault-crypto";
import { claudeWebRequest } from "../desktop-usage-request";
import { desktop } from "./state";
/**
 * Usage read through each account's Claude app sign-in. Whether the user allowed the Keychain
 * (Linux: keyring) read of "Claude Safe Storage" is remembered in a small file, never the
 * password itself.
 */
/** Reads through each account's Claude app sign-in; also lends the renewal its claude.ai session. */
export let desktopUsageReader: DesktopUsageReader | undefined;
/** Whether the user allowed Relay to read the Claude app's sign-in (the marker, never the password). */
export async function desktopUsageAllowed() {
  try {
    const marker = path.join(app.getPath("userData"), DESKTOP_USAGE_MARKER);
    return JSON.parse(await fsp.readFile(marker, "utf8"))?.allowed === true;
  } catch {
    return false;
  }
}
/** The vault file that keeps the Claude Safe Storage password, sealed (macOS). */
const SAFE_STORAGE_KEPT = "claude-safe-storage.bin";
export function desktopUsageSource(sealer: Sealer) {
  const marker = path.join(app.getPath("userData"), DESKTOP_USAGE_MARKER);
  const vaultDir = path.join(app.getPath("userData"), "desktop-vault");
  const consent = {
    allowed: desktopUsageAllowed,
    remember: async (allowed: boolean) =>
      allowed
        ? fsp.writeFile(marker, JSON.stringify({ allowed: true }), { mode: 0o600 })
        : Promise.all([fsp.rm(marker, { force: true }), writeBytes(vaultDir, SAFE_STORAGE_KEPT, null)]).then(() => {}),
  };
  const reader = (desktopUsageReader = new DesktopUsageReader({
    cookieFiles: (accountUuid) => desktop.loginCookieFiles(accountUuid),
    password:
      process.platform === "linux"
        ? linuxSafeStoragePassword(consent)
        : safeStoragePassword({
            ...consent,
            // macOS: kept sealed after one read, since "Always Allow" never sticks for security.
            saved: {
              load: async () => {
                const data = await readBytes(vaultDir, SAFE_STORAGE_KEPT);
                return data ? sealer.unseal(data) || undefined : undefined;
              },
              // Written whole or not at all, so a crash never leaves a file that cannot be unsealed.
              store: async (password) => writeBytes(vaultDir, SAFE_STORAGE_KEPT, sealer.seal(password)),
              clear: async () => writeBytes(vaultDir, SAFE_STORAGE_KEPT, null),
            },
          }),
    request: claudeWebRequest,
  }));
  return {
    usable: (account: Account) => DesktopUsageReader.usable(account),
    read: (account: Account, allowPrompt: boolean) => reader.read(account, allowPrompt),
  };
}
