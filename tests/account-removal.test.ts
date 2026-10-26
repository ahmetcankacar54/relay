import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AccountRemovalRefused,
  removalBlock,
  removeAccount,
  type AccountRemoval,
} from "../electron/core/account-removal";
import { acquireProfileLock, ProfileLockBusyError } from "../electron/core/profile-lock";
import { Service } from "../electron/core/service";
import { Store } from "../electron/core/store";
import { UsageManager } from "../electron/core/usage";
import { localizeError } from "../shared/error-text";
import type { Account, DesktopState } from "../shared/types";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** A registry with two accounts, each with its profile, sealed sign-ins and the lists naming it. */
function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-remove-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const vault = path.join(root, "desktop-vault");
  const locks = path.join(root, "profiles", ".locks");
  const make = (name: string) => {
    const created = store.create({ name, kind: "personal" });
    const desktop = randomUUID();
    const auth = randomUUID();
    store.update((s) => {
      const a = s.accounts.find((x) => x.id === created.id)!;
      a.desktop = { accountUuid: desktop, orgId: randomUUID(), savedAt: new Date().toISOString() };
      a.auth = { loggedIn: true, accountUuid: auth, checkedAt: new Date().toISOString() };
    });
    fs.writeFileSync(path.join(store.profile(created.id), ".credentials.json"), "{}");
    // The sealed Claude app sign-in, and the extension's and the browser's under either uuid.
    const files = [
      `accounts/${desktop}.bin`,
      `extension/${desktop}.bin`,
      `extension/${auth}.bin`,
      `extension-cookies/${desktop}.bin`,
    ].map((relative) => path.join(vault, relative));
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "sealed");
    }
    return { id: created.id, profile: store.profile(created.id), files };
  };
  const a = make("A");
  const b = make("B");
  store.update((s) => {
    s.settings.desktopHistoryAccounts = [a.id, b.id];
    s.settings.autoSwitchAccounts = [a.id, b.id];
    s.settings.planning.accounts = [{ id: a.id }, { id: b.id }];
  });
  const state: Pick<DesktopState, "activeProfileId" | "pendingProfileId"> = { activeProfileId: a.id };
  const signedOut: string[] = [];
  const options = (extra: Partial<AccountRemoval> = {}): AccountRemoval => ({
    store,
    vault,
    locks,
    desktop: async () => ({ ...state }),
    signOut: async (profile) => {
      signedOut.push(profile);
      return true;
    },
    ...extra,
  });
  return { root, store, vault, locks, a, b, state, signedOut, options };
}

test("removing an account deletes its profile and its sealed sign-ins, and drops it from every list", async (t) => {
  const f = fixture(t);
  const result = await removeAccount(f.b.id, f.options());
  assert.deepEqual(result, { signedOut: true });
  // Its usage sign-in was signed out in its own profile, before the profile went.
  assert.deepEqual(f.signedOut, [f.b.profile]);
  assert.equal(fs.existsSync(f.b.profile), false);
  for (const file of f.b.files) assert.equal(fs.existsSync(file), false, file);
  // The other account keeps everything.
  assert.ok(fs.existsSync(f.a.profile));
  for (const file of f.a.files) assert.ok(fs.existsSync(file), file);
  const s = new Store(f.root).state;
  assert.deepEqual(s.accounts.map((a) => a.name), ["A"]);
  assert.deepEqual(s.settings.desktopHistoryAccounts, [f.a.id]);
  assert.deepEqual(s.settings.autoSwitchAccounts, [f.a.id]);
  assert.deepEqual(s.settings.planning.accounts, [{ id: f.a.id }]);
  // Its lock folder goes too.
  assert.equal(fs.existsSync(path.join(f.locks, f.b.id)), false);
});

test("the account open in the Claude app, and one whose sign-in is pending, are refused and kept", async (t) => {
  const f = fixture(t);
  assert.equal(removalBlock(f.a.id, f.state), "active");
  assert.equal(removalBlock(f.b.id, f.state), undefined);
  assert.equal(removalBlock(f.b.id, { pendingProfileId: f.b.id }), "pending");
  await assert.rejects(removeAccount(f.a.id, f.options()), (error: unknown) => {
    assert.ok(error instanceof AccountRemovalRefused);
    assert.equal(error.reason, "active");
    return true;
  });
  // Desktop is read again at removal: a sign-in begun since the question was asked counts.
  f.state.pendingProfileId = f.b.id;
  await assert.rejects(removeAccount(f.b.id, f.options()), (error: unknown) => {
    assert.ok(error instanceof AccountRemovalRefused);
    assert.equal(error.reason, "pending");
    return true;
  });
  assert.deepEqual(f.signedOut, []);
  assert.equal(new Store(f.root).state.accounts.length, 2);
  for (const file of [...f.a.files, ...f.b.files]) assert.ok(fs.existsSync(file), file);
  // Both refusals read in both languages.
  for (const reason of ["active", "pending"] as const) {
    const message = new AccountRemovalRefused(reason).message;
    assert.notEqual(localizeError(message, "tr"), message, reason);
    assert.doesNotMatch(localizeError(message, "tr"), /Desktop/);
  }
});

test("a held profile lock refuses the removal before anything is deleted", async (t) => {
  const f = fixture(t);
  const release = acquireProfileLock(f.locks, f.b.id, "shared");
  t.after(release);
  await assert.rejects(removeAccount(f.b.id, f.options()), ProfileLockBusyError);
  assert.deepEqual(f.signedOut, []);
  assert.ok(fs.existsSync(f.b.profile));
  assert.equal(new Store(f.root).state.accounts.length, 2);
  assert.notEqual(localizeError("Claude Code is running with this account.", "tr"), "Claude Code is running with this account.");
});

test("a usage sign-in that cannot be signed out is said, and the account still goes", async (t) => {
  const f = fixture(t);
  const failing = await removeAccount(f.b.id, f.options({ signOut: async () => { throw new Error("no network"); } }));
  assert.deepEqual(failing, { signedOut: false });
  assert.equal(fs.existsSync(f.b.profile), false);
  // Without a CLI it is not signed out either; without a usage sign-in there is nothing to say.
  const g = fixture(t);
  assert.deepEqual(await removeAccount(g.b.id, g.options({ signOut: undefined })), { signedOut: false });
  g.store.update((s) => {
    s.accounts.find((a) => a.id === g.a.id)!.auth = undefined;
  });
  g.state.activeProfileId = undefined;
  assert.deepEqual(await removeAccount(g.a.id, g.options()), {});
  assert.deepEqual(g.signedOut, []);
});

test("the app's removal refuses a running terminal and a usage sign-in in progress, and signs out with the CLI", async (t) => {
  const f = fixture(t);
  const service = new Service(f.root, () => {}, path.join(f.root, "unused-imported"));
  const log = path.join(f.root, "cli.log");
  const cli = path.join(f.root, "fixture-cli");
  fs.writeFileSync(
    cli,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.296"; exit 0; fi\necho "$*|$CLAUDE_CONFIG_DIR" >> "${log}"\n`,
    { mode: 0o755 },
  );
  service.store.update((s) => {
    s.executable = cli;
  });
  const options = { vault: f.vault, locks: f.locks, desktop: async () => ({ activeProfileId: f.a.id }) };
  const list = service.runner.list.bind(service.runner);
  service.runner.list = () => [{ accountId: f.b.id, status: "running" } as ReturnType<typeof list>[number]];
  await assert.rejects(service.remove(f.b.id, options), /Bu hesapta çalışan oturumu önce durdur\./);
  service.runner.list = list;
  const active = service.auth.active.bind(service.auth);
  service.auth.active = (id: string) => id === f.b.id;
  await assert.rejects(service.remove(f.b.id, options), /limit okuma girişini tamamla ya da iptal et/);
  service.auth.active = active;
  await assert.rejects(service.remove(f.a.id, options), AccountRemovalRefused);
  assert.equal(fs.existsSync(log), false);
  assert.deepEqual(await service.remove(f.b.id, options), { signedOut: true });
  assert.equal(fs.readFileSync(log, "utf8").trim(), `auth logout|${f.b.profile}`);
  assert.deepEqual(service.store.state.accounts.map((a: Account) => a.name), ["A"]);
});

test("the usage cache forgets a removed account, and a read still running ends quietly", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const manager = new UsageManager(
    f.store,
    async () => {
      await held;
      return { accessToken: "fixture", scopes: ["user:profile"] };
    },
    async () => ({}),
  );
  const unhandled: unknown[] = [];
  const listen = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  t.after(() => process.off("unhandledRejection", listen));
  void manager.refresh(f.b.id);
  await removeAccount(f.b.id, f.options());
  manager.forget(f.b.id);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
  assert.deepEqual(Object.keys(manager.snapshot()), [f.a.id]);
});

test("the app removes an account through one IPC handler under the Desktop lock", () => {
  const main = source("../electron/main.ts");
  const start = main.indexOf('handle("remove-account",');
  assert.ok(start >= 0);
  const handler = main.slice(start, main.indexOf('handle("check-auth",', start));
  // Refused during a Desktop operation, then run under the lock and the service's transaction.
  assert.match(handler, /if \(desktop\.isBusy\)/);
  assert.match(handler, /manualDesktopLock\(\(\) =>\s*service\.transaction\(/);
  assert.match(handler, /service\.remove\(account, \{/);
  assert.match(handler, /desktop: \(\) => desktop\.snapshot\(\)/);
  // What the app keeps outside the registry is let go; the usage history is not touched.
  assert.match(handler, /usage\.forget\(account\);/);
  assert.doesNotMatch(handler, /usageHistory|tokenLedger/);
  assert.match(handler, /broadcastChanged\(\);/);
  assert.match(
    source("../electron/preload.ts"),
    /removeAccount: \(id\) => ipcRenderer\.invoke\("relay:remove-account", id\),/,
  );
  assert.match(source("../shared/types.ts"), /removeAccount\(accountId: string\): Promise<AccountRemoved>;/);
  // The relay CLI removes through the same function.
  assert.match(source("../cli/src/commands/remove.ts"), /removeAccount\(account\.id, \{/);
});
