import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";

export const VAULT_KEY_SERVICE = "Relay Vault Key";
export const VAULT_KEY_ACCOUNT = "relay-vault";
/** Exit status of `security find-generic-password` when no item matches. */
const ITEM_NOT_FOUND = 44;

/** Why the vault key could not be had: no item, a locked or refusing Keychain, or bad data. */
export class VaultKeyError extends Error {
  constructor(readonly reason: "missing" | "locked" | "invalid") {
    super(
      reason === "missing"
        ? `The Keychain item "${VAULT_KEY_SERVICE}" was not found.`
        : reason === "locked"
          ? `The Keychain item "${VAULT_KEY_SERVICE}" could not be read. Unlock the login keychain and try again.`
          : `The Keychain item "${VAULT_KEY_SERVICE}" does not hold a vault key.`,
    );
  }
}

/**
 * Reads the vault key through `security`, the item's trusted application, so neither Relay
 * nor the CLI is ever prompted after a rebuild or an update.
 */
export function readVaultKey(tool = "/usr/bin/security"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      tool,
      [
        "find-generic-password",
        "-s",
        VAULT_KEY_SERVICE,
        "-a",
        VAULT_KEY_ACCOUNT,
        "-w",
      ],
      { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 4096 },
      (error, stdout) => {
        if (error)
          return reject(
            new VaultKeyError(error.code === ITEM_NOT_FOUND ? "missing" : "locked"),
          );
        const text = String(stdout).trim();
        const key = /^[A-Za-z0-9+/]+={0,2}$/.test(text)
          ? Buffer.from(text, "base64")
          : Buffer.alloc(0);
        if (key.length !== 32) return reject(new VaultKeyError("invalid"));
        resolve(key);
      },
    );
  });
}

/**
 * Adds a new random key through `security -i`, so the key travels on stdin and never in a
 * process's arguments. Interactive `security` exits 0 whatever happens, and another process
 * may have added its own key first, so the key used is always the one read back.
 */
export async function createVaultKey(tool = "/usr/bin/security"): Promise<Buffer> {
  const value = crypto.randomBytes(32).toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tool, ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end(
      `add-generic-password -s "${VAULT_KEY_SERVICE}" -a ${VAULT_KEY_ACCOUNT} -l "${VAULT_KEY_SERVICE}" -w ${value}\nquit\n`,
    );
  });
  return readVaultKey(tool);
}

/** Reads the key; a missing one is created only when `mayCreate` (the vault holds no sealed file). */
export async function loadVaultKey(options: {
  tool?: string;
  mayCreate: boolean;
}): Promise<Buffer> {
  try {
    return await readVaultKey(options.tool);
  } catch (error) {
    if (
      options.mayCreate &&
      error instanceof VaultKeyError &&
      error.reason === "missing"
    )
      return createVaultKey(options.tool);
    throw error;
  }
}
