import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cascadeCredentials } from "../electron/core/onboard-cascade";

test("cascadeCredentials populates CLI ~/.claude.json, Keychain and CookieVault in single step", async () => {
  const tmpHome = path.join(os.tmpdir(), `relay-home-test-${Date.now()}`);
  await fsp.mkdir(tmpHome, { recursive: true });

  let savedVaultUuid = "";
  let savedSnapshot: any = null;
  let writtenKeychainText = "";

  const mockCookieVault = {
    async save(uuid: string, snapshot: any) {
      savedVaultUuid = uuid;
      savedSnapshot = snapshot;
    },
  };

  const mockKeychain = {
    async write(text: string) {
      writtenKeychainText = text;
    },
  };

  try {
    const result = await cascadeCredentials(
      {
        accountId: "acc-1234",
        accountUuid: "00000000-0000-0000-0000-000000000001",
        email: "onboard@company.com",
        orgId: "org-test-uuid",
        sessionKey: "sk-ant-sid01-mock-session-key",
      },
      {
        homeDir: tmpHome,
        keychain: mockKeychain,
        cookieVault: mockCookieVault,
        skipCdp: true,
      },
    );

    assert.equal(result.cliConfigured, true);
    assert.equal(result.keychainConfigured, true);
    assert.equal(result.cookieVaultConfigured, true);

    // Verify ~/.claude.json content
    const claudeJsonContent = await fsp.readFile(
      path.join(tmpHome, ".claude.json"),
      "utf8",
    );
    const parsed = JSON.parse(claudeJsonContent);
    assert.equal(parsed.oauthAccount.emailAddress, "onboard@company.com");
    assert.equal(
      parsed.oauthAccount.accountUuid,
      "00000000-0000-0000-0000-000000000001",
    );
    assert.equal(parsed.oauthAccount.organizationUuid, "org-test-uuid");

    // Verify Keychain payload
    assert.ok(writtenKeychainText);
    const parsedKeychain = JSON.parse(writtenKeychainText);
    assert.equal(
      parsedKeychain.claudeAiOauth.sessionKey,
      "sk-ant-sid01-mock-session-key",
    );

    // Verify CookieVault snapshot matching CookieSnapshot schema
    assert.equal(savedVaultUuid, "00000000-0000-0000-0000-000000000001");
    assert.equal(savedSnapshot.rows[0].name, "sessionKey");
    assert.equal(savedSnapshot.rows[0].value, "sk-ant-sid01-mock-session-key");
    assert.equal(savedSnapshot.rows[0].is_secure, 1n);
  } finally {
    await fsp.rm(tmpHome, { recursive: true, force: true });
  }
});
