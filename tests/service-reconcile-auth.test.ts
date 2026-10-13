import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Service } from "../electron/core/service";
import type { Account } from "../shared/types";

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-startup-auth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = path.join(root, "Relay");
  const imported = path.join(root, "unused-imported");
  const service = new Service(registry, () => {}, imported);
  const cli = path.join(root, "fixture-cli");
  await fs.writeFile(
    cli,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  console.log('2.1.296');
} else {
  const profile = process.env.CLAUDE_CONFIG_DIR;
  fs.appendFileSync(path.join(profile, 'fixture-status-calls'), 'status\\n');
  fs.writeFileSync(path.join(profile, 'fixture-refresh-state'), 'rotated');
  console.log(fs.readFileSync(path.join(profile, 'fixture-status.json'), 'utf8'));
}
`,
    { mode: 0o700 },
  );
  service.store.update((s) => {
    s.executable = cli;
  });
  async function account(
    name: string,
    authPatch: Partial<NonNullable<Account["auth"]>> = {},
  ) {
    const created = service.store.create({ name, kind: "personal" });
    const auth = {
      loggedIn: true,
      accountUuid: randomUUID(),
      orgId: randomUUID(),
      checkedAt: "2026-01-01T00:00:00.000Z",
      email: `${name}@example.test`,
      ...authPatch,
    };
    service.store.update((s) => {
      s.accounts.find((a) => a.id === created.id)!.auth = auth;
    });
    const profile = service.store.profile(created.id);
    await fs.writeFile(
      path.join(profile, "fixture-refresh-state"),
      "unchanged",
    );
    await fs.writeFile(
      path.join(profile, "fixture-status.json"),
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        accountUuid: randomUUID(),
        orgId: randomUUID(),
        email: auth.email,
        subscriptionType: "max",
      }),
    );
    return service.store.account(created.id);
  }
  return {
    service,
    account,
    restart: () => new Service(registry, () => {}, imported),
    sideEffect: (id: string) =>
      fs.readFile(
        path.join(service.store.profile(id), "fixture-refresh-state"),
        "utf8",
      ),
    calls: async (id: string) => {
      try {
        return (
          await fs.readFile(
            path.join(service.store.profile(id), "fixture-status-calls"),
            "utf8",
          )
        )
          .trim()
          .split("\n").length;
      } catch (error: any) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
    },
  };
}

test(
  "startup preserves enrolled identities without launching a status command that rotates credentials",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const cliOnly = await f.account("cli-only");
    const desktop = await f.account("desktop");
    f.service.store.update((s) => {
      s.accounts.find((a) => a.id === desktop.id)!.desktop = {
        accountUuid: desktop.auth!.accountUuid!,
        orgId: desktop.auth!.orgId!,
        savedAt: "2026-01-01T00:00:00.000Z",
      };
    });
    const before = f.service.store.state.accounts.map((a) =>
      structuredClone(a.auth),
    );
    const restarted = f.restart();
    await restarted.reconcileAuth();
    assert.deepEqual(
      restarted.store.state.accounts.map((a) => a.auth),
      before,
    );
    for (const a of [cliOnly, desktop]) {
      assert.equal(await f.calls(a.id), 0);
      assert.equal(await f.sideEffect(a.id), "unchanged");
    }
    // A manual recheck still asks the official CLI and observes its new identity.
    const rechecked = await restarted.checkAuth(cliOnly.id);
    assert.equal(await f.calls(cliOnly.id), 1);
    assert.equal(await f.sideEffect(cliOnly.id), "rotated");
    assert.notEqual(rechecked.auth!.accountUuid, cliOnly.auth!.accountUuid);
    assert.notEqual(rechecked.auth!.checkedAt, cliOnly.auth!.checkedAt);
    assert.equal(await f.calls(desktop.id), 0);
  },
);

test(
  "non-macOS startup reconciles missing, logged-out, incomplete, failed and Desktop-mismatched identities",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const unknown = await f.account("unknown");
    f.service.store.update((s) => {
      s.accounts.find((a) => a.id === unknown.id)!.auth = undefined;
    });
    const accounts = [
      unknown,
      await f.account("logged-out", { loggedIn: false }),
      await f.account("missing-account", { accountUuid: undefined }),
      await f.account("missing-org", { orgId: undefined }),
      await f.account("failed", { error: "Previous verification failed." }),
      await f.account("different-desktop-account"),
      await f.account("different-desktop-org"),
    ];
    f.service.store.update((s) => {
      for (const a of accounts.slice(-2)) {
        s.accounts.find((current) => current.id === a.id)!.desktop = {
          accountUuid: a.name.endsWith("account")
            ? randomUUID()
            : a.auth!.accountUuid!,
          orgId: a.name.endsWith("org") ? randomUUID() : a.auth!.orgId!,
          savedAt: "2026-01-01T00:00:00.000Z",
        };
      }
    });
    const restarted = f.restart();
    await restarted.reconcileAuth("linux");
    for (const a of accounts) {
      assert.equal(await f.calls(a.id), 1, a.name);
      assert.equal(await f.sideEffect(a.id), "rotated", a.name);
      assert.equal(restarted.store.account(a.id).auth!.loggedIn, true, a.name);
      assert.equal(
        restarted.store.account(a.id).auth!.error,
        undefined,
        a.name,
      );
    }
  },
);

test("macOS startup never launches interactive status checks for unverified profiles", async (t) => {
  const f = await fixture(t);
  const accounts = [
    await f.account("missing-identity", { accountUuid: undefined }),
    await f.account("signed-out", { loggedIn: false }),
    await f.account("failed", { error: "Needs explicit verification" }),
  ];
  const before = JSON.parse(JSON.stringify(f.service.store.state.accounts));
  const restarted = f.restart();
  await restarted.reconcileAuth("darwin");
  for (const account of accounts) {
    assert.equal(await f.calls(account.id), 0);
    assert.equal(await f.sideEffect(account.id), "unchanged");
  }
  assert.deepEqual(restarted.store.state.accounts, before);
});
