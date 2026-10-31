import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import { DesktopManager, type DesktopHost } from "../electron/core/desktop";
import { jsonBytes, writeBytes } from "../electron/core/desktop-files";
import {
  TerminalVault,
  type TerminalPorts,
} from "../electron/core/terminal-identity";
import { createSealer } from "../electron/core/vault-crypto";

const oauth = (n: number) => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
});

/** Claude folder, Relay store, a fake Claude host and the terminal's sign-in in memory. */
async function fixture(t: any) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-desktop-terminal-"),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "Claude");
  await fs.mkdir(root);
  const store = new Store(path.join(temp, "Relay"));
  const sealer = createSealer(Buffer.alloc(32, 5));
  let running = false;
  const host: DesktopHost = {
    available: async () => true,
    running: async () => running,
    quit: async () => {
      running = false;
    },
    launch: async () => {
      running = true;
    },
    seal: (text) => sealer.seal(text),
    unseal: (data) => sealer.unseal(data),
    draftScratchDir: path.join(temp, "tmp"),
  };
  const terminal: { item?: string; config: Record<string, any> } = {
    config: {},
  };
  const owners = new Map<string, { accountUuid: string; orgId: string }>();
  const ports: TerminalPorts = {
    keychain: {
      read: async () => terminal.item,
      write: async (text) => {
        terminal.item = text;
      },
      remove: async () => {
        terminal.item = undefined;
      },
    },
    config: {
      read: async () => structuredClone(terminal.config),
      writeAccount: async (account) => {
        terminal.config.oauthAccount = account;
      },
    },
    lock: (action) => action(),
    owner: async (token) => owners.get(token),
  };
  const manager = new DesktopManager(
    root,
    store,
    host,
    path.join(temp, ".claude"),
  );
  manager.terminal = ports;
  await manager.initialize();
  const vault = new TerminalVault(
    path.join(store.root, "desktop-vault"),
    (x) => sealer.seal(x),
    (d) => sealer.unseal(d),
  );
  async function account(name: string) {
    const a = store.create({ name, kind: "personal" });
    const accountUuid = randomUUID(),
      orgId = randomUUID();
    await writeBytes(
      root,
      "config.json",
      jsonBytes({
        "oauth:tokenCacheV2": `encrypted:${name}`,
        lastKnownAccountUuid: accountUuid,
      }),
    );
    await fs.mkdir(
      path.join(root, "claude-code-sessions", accountUuid, orgId),
      { recursive: true },
    );
    await manager.capture(a.id, orgId);
    return store.account(a.id);
  }
  const signIn = (
    desktop: { accountUuid: string; orgId: string },
    n: number,
  ) => {
    terminal.item = JSON.stringify({ claudeAiOauth: oauth(n) });
    owners.set(oauth(n).accessToken, desktop);
    terminal.config.oauthAccount = {
      accountUuid: desktop.accountUuid,
      organizationUuid: desktop.orgId,
    };
  };
  return { store, manager, vault, terminal, ports, account, signIn };
}

test("a switch brings the terminal's Claude Code to the account, after linking it with a check", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // Claude is on B
  // The terminal was signed in to A once: a check links it.
  f.signIn(a.desktop!, 1);
  const status = await f.manager.checkTerminal();
  assert.equal(status?.current?.known, true);
  assert.equal(status?.saved.length, 1);
  // Then to B by hand; the switch to A saves B's on the way out and puts A's back.
  f.signIn(b.desktop!, 2);
  await f.manager.switchTo(a.id);
  assert.deepEqual(JSON.parse(f.terminal.item!).claudeAiOauth, oauth(1));
  assert.equal(
    f.terminal.config.oauthAccount.accountUuid,
    a.desktop!.accountUuid,
  );
  assert.deepEqual((await f.vault.load([b.desktop!]))?.oauth, oauth(2));
  assert.equal((await f.manager.terminalStatus())?.last?.result, "switched");
  // Sync now with nothing to change says so.
  const sync = await f.manager.syncTerminal();
  assert.equal(sync.reason, "already-there");
});

test("mode off leaves the terminal alone at a switch", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  f.store.update((s) => {
    s.settings.terminalCli = "off";
  });
  await f.vault.save(
    a.desktop!,
    oauth(1),
    { accountUuid: a.desktop!.accountUuid, organizationUuid: a.desktop!.orgId },
    true,
  );
  f.signIn(b.desktop!, 2);
  await f.manager.switchTo(a.id);
  assert.deepEqual(JSON.parse(f.terminal.item!).claudeAiOauth, oauth(2));
  assert.equal((await f.manager.terminalStatus())?.last?.reason, "off");
});

test("a terminal step that fails never fails the switch", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.ports.keychain.read = async () => {
    throw new Error("Keychain on fire");
  };
  await f.manager.switchTo(a.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  assert.equal((await f.manager.terminalStatus())?.last?.result, "failed");
});
