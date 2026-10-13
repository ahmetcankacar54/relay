import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Account } from "../../shared/types";

type Auth = NonNullable<Account["auth"]>;
export interface ProfileIdentity {
  accountUuid: string;
  orgId: string;
  email: string;
  orgName?: string;
}
const uuid = z.uuid();
const text = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim() && value.trim().length <= limit
    ? value.trim()
    : undefined;
const validUuid = (value: unknown) =>
  uuid.safeParse(value).success ? (value as string).toLowerCase() : undefined;

// Read only non-secret identity fields from this isolated CLI profile. Never read
// credential files or fall back to the user's default Claude configuration.
export async function readProfileIdentity(
  profile: string,
): Promise<ProfileIdentity | undefined> {
  try {
    const directory = await fs.lstat(profile);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    for (const name of [".config.json", ".claude.json"]) {
      let file;
      try {
        const target = path.join(profile, name);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) return;
        file = await fs.open(
          target,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        );
      } catch (error: any) {
        if (error.code === "ENOENT") continue;
        return;
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) return;
        const buffer = Buffer.alloc(Math.min(stat.size + 1, 1024 * 1024 + 1));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1024 * 1024) return;
        const value = JSON.parse(
          buffer.subarray(0, bytesRead).toString("utf8"),
        );
        const identity = value?.oauthAccount;
        const accountUuid = validUuid(identity?.accountUuid);
        const orgId = validUuid(identity?.organizationUuid);
        const email = text(identity?.emailAddress, 254);
        if (!accountUuid || !orgId || !email) return;
        return {
          accountUuid,
          orgId,
          email,
          orgName: text(identity?.organizationName, 150),
        };
      } finally {
        await file.close();
      }
    }
  } catch {
    // Missing, malformed or unsupported metadata leaves the identity unknown.
  }
}

export function authStatus(
  value: unknown,
  previous: Auth | undefined,
  metadata: ProfileIdentity | undefined,
  checkedAt: string,
): Auth {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid CLI authentication status.");
  const status = value as Record<string, unknown>;
  if (typeof status.loggedIn !== "boolean")
    throw new Error("Invalid CLI authentication status.");
  if (!status.loggedIn || status.authMethod !== "claude.ai")
    return {
      ...previous,
      loggedIn: false,
      checkedAt,
      error: status.loggedIn
        ? "Bu profil Claude aboneliği ile giriş gerektiriyor."
        : undefined,
    };
  const email = text(status.email, 254);
  const orgId = validUuid(status.orgId);
  // Email alone cannot distinguish personal and company subscriptions. Trust the
  // metadata UUID only when both its email and organization match auth status.
  const corroborated =
    !!metadata &&
    !!email &&
    !!orgId &&
    metadata.email.toLowerCase() === email.toLowerCase() &&
    metadata.orgId === orgId;
  return {
    loggedIn: true,
    checkedAt,
    email,
    orgId,
    orgName:
      text(status.orgName, 150) ??
      (corroborated ? metadata.orgName : undefined),
    accountUuid:
      validUuid(status.accountUuid) ??
      (corroborated ? metadata.accountUuid : undefined),
    subscription: text(status.subscriptionType, 64),
  };
}
