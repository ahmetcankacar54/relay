import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { UsageIssue } from "../../shared/types";
export class UsageError extends Error {
  constructor(
    readonly issue: UsageIssue,
    readonly retryAt?: number,
    /**
     * Where and why, for the private diagnosis log: a step, an HTTP status, an error type
     * ("usage 403 permission_error", "refresh: no network"). Never a credential.
     */
    readonly detail?: string,
  ) {
    super(issue);
  }
}
export interface UsageCredential {
  accessToken: string;
  expiresAt?: number;
  scopes: string[];
  /** Main-process only. Never expose credentials through snapshots or IPC. */
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  clientId?: string;
}
export function credentialService(profile: string) {
  // Relay always uses an absolute, isolated CLAUDE_CONFIG_DIR. Never fall back to the default service.
  return `Claude Code-credentials-${createHash("sha256").update(path.resolve(profile).normalize("NFC")).digest("hex").slice(0, 8)}`;
}
/** `security -w` prints non-printable secrets as hex; the CLI stores JSON text. */
function decodeSecret(output: string) {
  const text = output.trim();
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    const decoded = Buffer.from(text, "hex").toString("utf8");
    if (decoded.trimStart().startsWith("{")) return decoded;
  }
  return text;
}
export function parseCredential(raw: string): UsageCredential {
  try {
    const value = JSON.parse(raw)?.claudeAiOauth;
    if (
      !value ||
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      value.accessToken.length > 16_384 ||
      /[\x00-\x20\x7f]/.test(value.accessToken) ||
      (typeof value.expiresAt === "number" && !Number.isFinite(value.expiresAt))
    )
      throw 0;
    return {
      accessToken: value.accessToken,
      expiresAt:
        typeof value.expiresAt === "number" ? value.expiresAt : undefined,
      scopes: Array.isArray(value.scopes)
        ? value.scopes.filter((s: unknown) => typeof s === "string")
        : [],
      ...(typeof value.refreshToken === "string" &&
      value.refreshToken.length > 0 &&
      value.refreshToken.length <= 16_384 &&
      !/[\x00-\x20\x7f]/.test(value.refreshToken)
        ? { refreshToken: value.refreshToken }
        : {}),
      ...(typeof value.refreshTokenExpiresAt === "number" &&
      Number.isFinite(value.refreshTokenExpiresAt)
        ? { refreshTokenExpiresAt: value.refreshTokenExpiresAt }
        : {}),
      ...(typeof value.clientId === "string" &&
      /^[A-Za-z0-9._:-]{1,200}$/.test(value.clientId)
        ? { clientId: value.clientId }
        : {}),
    };
  } catch {
    throw new UsageError("credentials-missing");
  }
}
/** Exit status of `security find-generic-password` when no item matches. */
const SECURITY_ITEM_NOT_FOUND = 44;
/**
 * Reads the official CLI's credential for one isolated profile.
 *
 * On macOS the CLI stores it in the login Keychain through `/usr/bin/security`,
 * and that tool is the item's trusted application. Reading it through the same
 * Apple-signed tool therefore needs no consent dialog and does not depend on
 * Relay's own code signature, so rebuilding or updating Relay never re-prompts.
 * A background read is bounded: if macOS unexpectedly asks for consent, the
 * child is terminated (closing its dialog) and the account reports
 * `keychain-locked` until the user explicitly allows access.
 */
export async function readCredential(
  profile: string,
  allowPrompt: boolean,
  tool = "/usr/bin/security",
  platform = process.platform,
  missingRetryMs = MISSING_RETRY_MS,
): Promise<UsageCredential> {
  if ((await fs.lstat(profile)).isSymbolicLink())
    throw new UsageError("credentials-missing");
  if (platform === "darwin") {
    const find = () =>
      new Promise<{ code?: number | string | null; stdout: string }>((resolve) => {
        execFile(
          tool,
          ["find-generic-password", "-s", credentialService(profile), "-w"],
          {
            timeout: allowPrompt ? 120_000 : 15_000,
            killSignal: "SIGKILL",
            maxBuffer: 65_536,
            windowsHide: true,
          },
          (error, stdout) =>
            resolve({ code: error ? (error.code ?? "failed") : undefined, stdout }),
        );
      });
    let found = await find();
    // The CLI rewrites its item when it renews a sign-in; a read in that moment finds none.
    if (found.code === SECURITY_ITEM_NOT_FOUND) {
      await new Promise((resolve) => setTimeout(resolve, missingRetryMs));
      found = await find();
    }
    // The CLI falls back to a private file when Keychain rejects its write.
    if (found.code === SECURITY_ITEM_NOT_FOUND) return readCredentialFile(profile);
    if (found.code !== undefined)
      throw new UsageError("keychain-locked", undefined, `keychain: security exit ${found.code}`);
    return parseCredential(decodeSecret(found.stdout));
  }
  return readCredentialFile(profile);
}
/** How long a read that found no Keychain item waits before it looks once more. */
export const MISSING_RETRY_MS = 1_500;
async function readCredentialFile(profile: string) {
  try {
    const file = path.join(profile, ".credentials.json");
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw 0;
    return parseCredential(await fs.readFile(file, "utf8"));
  } catch {
    throw new UsageError("credentials-missing", undefined, "no Keychain item or credentials file");
  }
}
