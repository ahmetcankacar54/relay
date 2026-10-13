import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { UsageIssue } from "../../shared/types";
export class UsageError extends Error {
  constructor(
    readonly issue: UsageIssue,
    readonly retryAt?: number,
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
export async function readCredential(
  profile: string,
  allowPrompt: boolean,
  helper: string,
  platform = process.platform,
): Promise<UsageCredential> {
  if ((await fs.lstat(profile)).isSymbolicLink())
    throw new UsageError("credentials-missing");
  if (platform === "darwin") {
    // Security.framework can explicitly forbid prompts, unlike the `security -w` CLI.
    return new Promise((resolve, reject) => {
      const child = execFile(
        helper,
        allowPrompt ? ["--allow-prompt"] : [],
        {
          timeout: allowPrompt ? 120_000 : 20_000,
          maxBuffer: 65_536,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error)
            return reject(
              new UsageError(
                error.code === 4 ? "credentials-missing" : "keychain-locked",
              ),
            );
          try {
            resolve(parseCredential(stdout));
          } catch (e) {
            reject(e);
          }
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(credentialService(profile));
    });
  }
  try {
    const file = path.join(profile, ".credentials.json");
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw 0;
    return parseCredential(await fs.readFile(file, "utf8"));
  } catch {
    throw new UsageError("credentials-missing");
  }
}
