import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  authStatus,
  readProfileIdentity,
} from "../electron/core/profile-identity";
import { Service } from "../electron/core/service";

async function fixture(t: any) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-profile-identity-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = {
    accountUuid: randomUUID(),
    organizationUuid: randomUUID(),
    emailAddress: "person@example.test",
    organizationName: "Fixture company",
  };
  const status = {
    loggedIn: true,
    authMethod: "claude.ai",
    email: identity.emailAddress,
    orgId: identity.organizationUuid,
    orgName: identity.organizationName,
    subscriptionType: "team",
  };
  return { root, identity, status };
}

test("isolated profile identity returns only safe metadata and never credential fields", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, ".claude.json"),
    JSON.stringify({
      oauthAccount: { ...f.identity, accessToken: "never-return-this" },
      secret: "never-return-this",
    }),
  );
  const metadata = await readProfileIdentity(f.root);
  assert.deepEqual(metadata, {
    accountUuid: f.identity.accountUuid,
    orgId: f.identity.organizationUuid,
    email: f.identity.emailAddress,
    orgName: f.identity.organizationName,
  });
  assert(!JSON.stringify(metadata).includes("never-return-this"));
  const auth = authStatus(f.status, undefined, metadata, "now");
  assert.equal(auth.accountUuid, f.identity.accountUuid);
  assert.equal(auth.orgId, f.identity.organizationUuid);
  assert.equal(auth.orgName, f.identity.organizationName);
});

test("email alone does not corroborate a different organization or stale metadata", async (t) => {
  const f = await fixture(t);
  const metadata = {
    accountUuid: f.identity.accountUuid,
    orgId: f.identity.organizationUuid,
    email: f.identity.emailAddress,
  };
  assert.equal(
    authStatus({ ...f.status, orgId: randomUUID() }, undefined, metadata, "now")
      .accountUuid,
    undefined,
  );
  assert.equal(
    authStatus(
      { ...f.status, email: "other@example.test" },
      undefined,
      metadata,
      "now",
    ).accountUuid,
    undefined,
  );
  assert.equal(
    authStatus({ ...f.status, orgId: undefined }, undefined, metadata, "now")
      .accountUuid,
    undefined,
  );
});

test("profile metadata rejects symlinks, oversized files and malformed identities", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, ".claude.json");
  await fs.writeFile(file, " ".repeat(1024 * 1024 + 1));
  assert.equal(await readProfileIdentity(f.root), undefined);
  await fs.writeFile(
    file,
    JSON.stringify({ oauthAccount: { ...f.identity, accountUuid: "invalid" } }),
  );
  assert.equal(await readProfileIdentity(f.root), undefined);
  await fs.writeFile(file, "{broken");
  assert.equal(await readProfileIdentity(f.root), undefined);
  if (process.platform !== "win32") {
    const actual = path.join(f.root, "other.json");
    await fs.writeFile(actual, JSON.stringify({ oauthAccount: f.identity }));
    await fs.rm(file);
    await fs.symlink(actual, file);
    assert.equal(await readProfileIdentity(f.root), undefined);
    const profileLink = path.join(f.root, "profile-link");
    await fs.symlink(f.root, profileLink);
    assert.equal(await readProfileIdentity(profileLink), undefined);
  }
});

test("legacy config metadata takes priority without silently falling back to another identity", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, ".claude.json"),
    JSON.stringify({ oauthAccount: f.identity }),
  );
  await fs.writeFile(path.join(f.root, ".config.json"), "{}");
  assert.equal(await readProfileIdentity(f.root), undefined);
});

test("a logged-out status preserves known email and identity while clearing loggedIn", async (t) => {
  const f = await fixture(t);
  const previous = {
    loggedIn: true,
    email: f.identity.emailAddress,
    accountUuid: f.identity.accountUuid,
    orgId: f.identity.organizationUuid,
    orgName: f.identity.organizationName,
    subscription: "max",
    checkedAt: "old",
  };
  const auth = authStatus({ loggedIn: false }, previous, undefined, "new");
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.email, previous.email);
  assert.equal(auth.accountUuid, previous.accountUuid);
  assert.equal(auth.orgId, previous.orgId);
  assert.equal(auth.checkedAt, "new");
  assert.throws(() => authStatus(null, previous, undefined, "new"));
});

test(
  "CLI status failures retain known identity; a successful reconnect persists its new organization",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const f = await fixture(t);
    const service = new Service(
      path.join(f.root, "Relay"),
      () => {},
      path.join(f.root, "imported"),
    );
    const account = service.store.create({ name: "Fixture", kind: "personal" });
    const profile = service.store.profile(account.id);
    const cli = path.join(f.root, "fixture-cli");
    await fs.writeFile(
      cli,
      `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); if(process.argv.includes('--version')) console.log('2.1.296'); else console.log(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'fixture-status.json'), 'utf8'));`,
      { mode: 0o700 },
    );
    service.store.update((s) => {
      s.executable = cli;
    });
    await fs.writeFile(
      path.join(profile, ".claude.json"),
      JSON.stringify({ oauthAccount: f.identity }),
    );
    const statusFile = path.join(profile, "fixture-status.json");
    await fs.writeFile(statusFile, JSON.stringify(f.status));
    const connected = await service.checkAuth(account.id);
    assert.equal(connected.auth?.accountUuid, f.identity.accountUuid);
    assert.equal(connected.auth?.orgId, f.identity.organizationUuid);
    await fs.writeFile(statusFile, "not JSON");
    const failed = await service.checkAuth(account.id);
    assert.equal(failed.auth?.loggedIn, false);
    assert.equal(failed.auth?.email, connected.auth?.email);
    assert.equal(failed.auth?.accountUuid, connected.auth?.accountUuid);
    assert(failed.auth?.error);
    const orgId = randomUUID();
    const accountUuid = randomUUID();
    await fs.writeFile(
      path.join(profile, ".claude.json"),
      JSON.stringify({
        oauthAccount: { ...f.identity, accountUuid, organizationUuid: orgId },
      }),
    );
    await fs.writeFile(statusFile, JSON.stringify({ ...f.status, orgId }));
    const reconnected = await service.checkAuth(account.id);
    assert.equal(reconnected.auth?.loggedIn, true);
    assert.equal(reconnected.auth?.accountUuid, accountUuid);
    assert.equal(reconnected.auth?.orgId, orgId);
    assert.equal(reconnected.auth?.error, undefined);
    assert.equal(
      new Service(
        service.store.root,
        () => {},
        path.join(f.root, "imported"),
      ).store.account(account.id).auth?.orgId,
      orgId,
    );
  },
);
