import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Account } from "../../shared/types";
import type { CookieSnapshot } from "./cookie-store";
import { TERMINAL_SERVICE, securityKeychain } from "./terminal-identity";
import {
  setCookiesViaCdp,
  discoverDevToolsEndpoint,
  getChromiumSupportDir,
} from "./cdp-cookie-switch";

export interface CascadeInput {
  accountId: string;
  accountUuid?: string;
  email?: string;
  orgId?: string;
  sessionKey?: string;
  oauthToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface CascadeResult {
  cliConfigured: boolean;
  keychainConfigured: boolean;
  cookieVaultConfigured: boolean;
  cdpHotSwapped: boolean;
  errors: string[];
}

/**
 * Automatically bridges credentials across CLI, Desktop, and Browser Extension
 * so the user only has to authenticate once during onboarding (Single Sign-In Cascade).
 */
export async function cascadeCredentials(
  input: CascadeInput,
  options: {
    homeDir?: string;
    keychain?: { write(text: string): Promise<void> };
    cookieVault?: {
      save(uuid: string, snapshot: CookieSnapshot): Promise<void>;
    };
    userDataDir?: string;
    skipCdp?: boolean;
  } = {},
): Promise<CascadeResult> {
  const home = options.homeDir || os.homedir();
  const errors: string[] = [];
  let cliConfigured = false;
  let keychainConfigured = false;
  let cookieVaultConfigured = false;
  let cdpHotSwapped = false;

  const targetUuid = input.accountUuid || input.accountId;

  // 1. Cascade into CLI global configuration (~/.claude.json) with atomic write and mode 0o600
  try {
    const claudeJsonPath = path.join(home, ".claude.json");
    let claudeConfig: Record<string, any> = {};
    let existingMode = 0o600;

    try {
      const stat = await fs.stat(claudeJsonPath);
      existingMode = stat.mode & 0o777;
      const existing = await fs.readFile(claudeJsonPath, "utf8");
      claudeConfig = JSON.parse(existing);
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        throw new Error(`Unreadable ~/.claude.json: ${e.message}`);
      }
    }

    if (input.email || input.accountUuid || input.sessionKey) {
      claudeConfig.oauthAccount = {
        accountUuid: targetUuid,
        emailAddress: input.email || "user@relay.local",
        organizationUuid: input.orgId || "org-relay",
      };
      const tmpFile = `${claudeJsonPath}.relay-${randomUUID()}`;
      try {
        await fs.writeFile(tmpFile, JSON.stringify(claudeConfig, null, 2), {
          mode: existingMode,
        });
        await fs.rename(tmpFile, claudeJsonPath);
        cliConfigured = true;
      } finally {
        await fs.rm(tmpFile, { force: true });
      }
    }
  } catch (err: any) {
    errors.push(`CLI config cascade failed: ${err.message || String(err)}`);
  }

  // 2. Cascade into macOS Keychain matching Claude Code's exact claudeAiOauth key
  if (
    (options.keychain || process.platform === "darwin") &&
    (input.oauthToken || input.sessionKey)
  ) {
    try {
      const keychain =
        options.keychain ||
        securityKeychain(
          os.userInfo().username,
          "/usr/bin/security",
          TERMINAL_SERVICE,
        );
      const credentialPayload = {
        claudeAiOauth: {
          accessToken: input.oauthToken || `sk-ant-session-${input.sessionKey}`,
          refreshToken: input.refreshToken,
          expiresAt:
            input.expiresAt ||
            new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          sessionKey: input.sessionKey,
        },
      };
      await keychain.write(JSON.stringify(credentialPayload));
      keychainConfigured = true;
    } catch (err: any) {
      errors.push(`Keychain cascade failed: ${err.message || String(err)}`);
    }
  }

  // 3. Cascade into Relay CookieVault adhering to CookieSnapshot schema
  if (input.sessionKey && options.cookieVault) {
    try {
      const snapshot: CookieSnapshot = {
        version: "1",
        columns: [
          "host_key",
          "top_frame_site_key",
          "name",
          "value",
          "path",
          "is_secure",
          "is_httponly",
          "creation_utc",
        ],
        rows: [
          {
            host_key: ".claude.ai",
            top_frame_site_key: "",
            name: "sessionKey",
            value: input.sessionKey,
            path: "/",
            is_secure: 1n,
            is_httponly: 1n,
            creation_utc: BigInt(Date.now()) * 1000n,
          },
        ],
        unlisted: [],
      };
      await options.cookieVault.save(targetUuid, snapshot);
      cookieVaultConfigured = true;
    } catch (err: any) {
      errors.push(`CookieVault cascade failed: ${err.message || String(err)}`);
    }
  }

  // 4. If browser is open, attempt live CDP hot-swap immediately
  if (input.sessionKey && !options.skipCdp) {
    try {
      const baseSupport =
        options.userDataDir ||
        path.join(getChromiumSupportDir(), "Google/Chrome");
      const endpoint = await discoverDevToolsEndpoint(baseSupport);
      if (endpoint) {
        const cdpRes = await setCookiesViaCdp(endpoint.browserWsUrl, [
          {
            name: "sessionKey",
            value: input.sessionKey,
            domain: ".claude.ai",
            path: "/",
            secure: true,
            httpOnly: true,
          },
        ]);
        if (cdpRes.success) {
          cdpHotSwapped = true;
        }
      }
    } catch {
      // CDP is opportunistic; failure does not block the cascade
    }
  }

  return {
    cliConfigured,
    keychainConfigured,
    cookieVaultConfigured,
    cdpHotSwapped,
    errors,
  };
}
