import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import { DesktopManager, type DesktopHost } from "../electron/core/desktop";
import { jsonBytes, writeBytes } from "../electron/core/desktop-files";
import { ExtensionVault } from "../electron/core/extension-vault";
import { createSealer } from "../electron/core/vault-crypto";
import { extensionWorld, signInFor } from "./extension-world";

/** Claude folder, Relay store, a fake Claude host and a fake browser world. */
async function fixture(t: any) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-ext-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "Claude");
  await fs.mkdir(root);
  const store = new Store(path.join(temp, "Relay"));
  const sealer = createSealer(Buffer.alloc(32, 3));
  const log: string[] = [];
  let running = false;
  const host: DesktopHost = {
    available: async () => true,
    running: async () => running,
    quit: async () => {
      log.push("claude-quit");
      running = false;
    },
    launch: async () => {
      log.push("claude-launch");
      running = true;
    },
    seal: (text) => sealer.seal(text),
    unseal: (data) => sealer.unseal(data),
    draftScratchDir: path.join(temp, "tmp"),
  };
  const world = extensionWorld(temp);
  const dir = world.install("brave");
  // One log for both: the order of what happens is the point.
  const events = world.events;
  const push = events.push.bind(events);
  log.push = (...items: string[]) => push(...items);
  const manager = new DesktopManager(root, store, host, path.join(temp, ".claude"));
  manager.extension = { system: world.system, storage: world.storage };
  await manager.initialize();
  const vault = new ExtensionVault(
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
    await fs.mkdir(path.join(root, "claude-code-sessions", accountUuid, orgId), { recursive: true });
    await manager.capture(a.id, orgId);
    events.length = 0;
    return store.account(a.id);
  }
  return { temp, store, manager, world, dir, vault, account, events, setRunning: (v: boolean) => (running = v) };
}

test("a restarting switch puts the target's extension sign-in in place before Claude opens, quitting and reopening a running browser", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // Claude is on B
  f.setRunning(true);
  f.world.state.running = true;
  await f.vault.save(a.desktop!.accountUuid, signInFor(a.desktop!.accountUuid, 1));
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  await f.manager.switchTo(a.id);
  assert.deepEqual(f.events, ["claude-quit", "quit:brave", "launch:brave", "claude-launch"]);
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(a.desktop!.accountUuid, 1));
  assert.deepEqual(await f.vault.load([b.desktop!.accountUuid]), signInFor(b.desktop!.accountUuid, 2));
  assert.equal(f.manager.extensionOutcome?.result, "switched");
  assert.ok(f.world.opened.every((o) => !o.running));
});

test("a switch that keeps Claude closed never quits the browser", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  f.setRunning(false);
  f.world.state.running = true;
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  await f.vault.save(a.desktop!.accountUuid, signInFor(a.desktop!.accountUuid, 1));
  await f.manager.switchTo(a.id, { closedOnly: true, expectedActiveProfileId: b.id });
  assert.deepEqual(f.events, []);
  assert.equal(f.manager.extensionOutcome?.result, "skipped");
  assert.equal(f.manager.extensionOutcome?.reason, "browser-running");
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  // The browser is closed: the same kind of switch swaps.
  f.world.state.running = false;
  f.world.stored.set(f.dir, signInFor(a.desktop!.accountUuid, 3));
  await f.vault.save(b.desktop!.accountUuid, signInFor(b.desktop!.accountUuid, 4));
  await f.manager.switchTo(b.id, { closedOnly: true, expectedActiveProfileId: a.id });
  assert.equal(f.manager.extensionOutcome?.result, "switched");
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(b.desktop!.accountUuid, 4));
});

test("an extension step that fails never fails the switch", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.world.storage.read = async () => {
    throw new Error("disk on fire");
  };
  await f.manager.switchTo(a.id);
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  assert.equal(f.manager.extensionOutcome?.result, "failed");
  assert.equal((await f.manager.snapshot()).error, undefined);
  // A throwing sealer does not either.
  f.manager.extension = undefined;
  await f.manager.switchTo((await f.account("C")).id);
});

test("mode 'off' leaves the extension and the browser alone; no extension port does too", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.world.state.running = true;
  f.store.update((s) => {
    s.settings.claudeExtension = { mode: "off" };
  });
  await f.manager.switchTo(a.id);
  assert.equal(f.manager.extensionOutcome?.reason, "off");
  assert.ok(!f.events.some((e) => e.includes("brave")));
  assert.deepEqual(f.world.opened, []);
});

test("a switch that does not change the Claude account does not run the extension step", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.manager.switchTo(a.id); // A is open in Claude already? it is the last captured
  f.world.opened.length = 0;
  const before = f.manager.extensionOutcome;
  await f.manager.switchTo(a.id);
  assert.deepEqual(f.world.opened, []);
  assert.equal(f.manager.extensionOutcome, before);
});

test("sync now runs the step for the active account and quits a running browser; the status lists what is saved", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // active
  f.world.state.running = true;
  f.world.stored.set(f.dir, signInFor(a.desktop!.accountUuid, 2));
  await f.vault.save(b.desktop!.accountUuid, signInFor(b.desktop!.accountUuid, 7));
  assert.equal(await f.manager.extensionQuitsBrowser(), "Brave");
  const outcome = await f.manager.syncExtension();
  assert.equal(outcome.result, "switched");
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(b.desktop!.accountUuid, 7));
  assert.deepEqual(f.events, ["quit:brave", "launch:brave"]);
  const status = (await f.manager.extensionStatus())!;
  assert.equal(status.setting.mode, "restart");
  assert.equal(status.target?.app, "brave");
  assert.equal(status.restoresTabs, false);
  assert.deepEqual(status.saved.map((s) => s.accountUuid).sort(), [a.desktop!.accountUuid, b.desktop!.accountUuid].sort());
  assert.equal(status.last?.result, "switched");
  // Claude was not touched.
  assert.ok(!f.events.includes("claude-quit"));
  // Mode "closed" and a running browser: nothing is quit, and nothing is announced.
  f.store.update((s) => {
    s.settings.claudeExtension = { mode: "closed" };
  });
  assert.equal(await f.manager.extensionQuitsBrowser(), undefined);
});

test("a build without the LevelDB library never announces or quits a browser", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  await f.account("B");
  f.world.state.available = false;
  f.world.state.running = true;
  assert.equal(await f.manager.extensionQuitsBrowser(), undefined);
  await f.manager.switchTo(a.id);
  assert.equal(f.manager.extensionOutcome?.reason, "unavailable");
  assert.ok(!f.events.some((e) => e.includes("brave")));
});

test("sync now needs Claude on a saved account, and is not available without the extension port", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.syncExtension(), /saved account first/);
  await f.account("A");
  f.manager.extension = undefined;
  await assert.rejects(f.manager.syncExtension(), /not supported here/);
  assert.equal(await f.manager.extensionStatus(), undefined);
});
