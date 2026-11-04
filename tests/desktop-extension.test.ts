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
import { CookieVault } from "../electron/core/cookie-vault";
import { extensionWorld, loginFor, signInFor } from "./extension-world";

/** Claude folder, Relay store, a fake Claude host and a fake browser world. */
async function fixture(t: any, options: { defaultSetting?: boolean } = {}) {
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
  manager.extension = { system: world.system, storage: world.storage, cookies: world.cookies };
  // Writing to a browser is opt-in; these tests are about the modes that do.
  if (!options.defaultSetting)
    store.update((s) => {
      s.settings.claudeExtension = { mode: "restart" };
    });
  await manager.initialize();
  const vault = new ExtensionVault(
    path.join(store.root, "desktop-vault"),
    (x) => sealer.seal(x),
    (d) => sealer.unseal(d),
  );
  const cookieVault = new CookieVault(
    path.join(store.root, "desktop-vault"),
    (x) => sealer.seal(x),
    (d) => sealer.unseal(d),
  );
  const profile = path.dirname(path.dirname(dir));
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
  return { temp, store, manager, world, dir, profile, vault, cookieVault, account, events, setRunning: (v: boolean) => (running = v) };
}

test("a restarting switch puts the target's extension sign-in in place before Claude opens, quitting and reopening a running browser", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // Claude is on B
  f.setRunning(true);
  f.world.state.running = true;
  await f.vault.save(a.desktop!.accountUuid, signInFor(a.desktop!.accountUuid, 1));
  await f.cookieVault.save(a.desktop!.accountUuid, loginFor(a.desktop!.accountUuid, 1));
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  await f.manager.switchTo(a.id);
  assert.deepEqual(f.events, ["claude-quit", "quit:brave", "launch:brave", "claude-launch"]);
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(a.desktop!.accountUuid, 1));
  assert.deepEqual(f.world.web.get(f.profile), loginFor(a.desktop!.accountUuid, 1));
  assert.deepEqual(await f.cookieVault.load([b.desktop!.accountUuid]), loginFor(b.desktop!.accountUuid, 2));
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
  await f.cookieVault.save(a.desktop!.accountUuid, loginFor(a.desktop!.accountUuid, 1));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  await f.manager.switchTo(a.id, { closedOnly: true, expectedActiveProfileId: b.id });
  assert.deepEqual(f.events, []);
  assert.equal(f.manager.extensionOutcome?.result, "skipped");
  assert.equal(f.manager.extensionOutcome?.reason, "browser-running");
  assert.equal((await f.manager.snapshot()).activeProfileId, a.id);
  // The browser is closed: the same kind of switch swaps.
  f.world.state.running = false;
  f.world.stored.set(f.dir, signInFor(a.desktop!.accountUuid, 3));
  f.world.web.set(f.profile, loginFor(a.desktop!.accountUuid, 3));
  await f.vault.save(b.desktop!.accountUuid, signInFor(b.desktop!.accountUuid, 4));
  await f.cookieVault.save(b.desktop!.accountUuid, loginFor(b.desktop!.accountUuid, 4));
  await f.manager.switchTo(b.id, { closedOnly: true, expectedActiveProfileId: a.id });
  assert.equal(f.manager.extensionOutcome?.result, "switched");
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(b.desktop!.accountUuid, 4));
  assert.deepEqual(f.world.web.get(f.profile), loginFor(b.desktop!.accountUuid, 4));
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
  f.world.web.set(f.profile, loginFor(a.desktop!.accountUuid, 2));
  await f.vault.save(b.desktop!.accountUuid, signInFor(b.desktop!.accountUuid, 7));
  await f.cookieVault.save(b.desktop!.accountUuid, loginFor(b.desktop!.accountUuid, 7));
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
  assert.deepEqual(status.cookiesSaved!.map((s) => s.accountUuid).sort(), [a.desktop!.accountUuid, b.desktop!.accountUuid].sort());
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

test("without a saved choice Relay only guides: nothing is written and no browser is quit", async (t) => {
  const f = await fixture(t, { defaultSetting: true });
  const a = await f.account("A");
  const b = await f.account("B");
  f.setRunning(true);
  f.world.state.running = true;
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  await f.vault.save(a.desktop!.accountUuid, signInFor(a.desktop!.accountUuid, 1));
  await f.cookieVault.save(a.desktop!.accountUuid, loginFor(a.desktop!.accountUuid, 1));
  assert.equal(await f.manager.extensionQuitsBrowser(), undefined);
  await f.manager.switchTo(a.id);
  assert.deepEqual(f.events, ["claude-quit", "claude-launch"]);
  assert.equal(f.manager.extensionOutcome?.reason, "guide-mismatch");
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(b.desktop!.accountUuid, 2));
  assert.deepEqual(f.world.web.get(f.profile), loginFor(b.desktop!.accountUuid, 2));
  assert.equal((await f.manager.extensionStatus())!.setting.mode, "guide");
});

test("in mode 'guide' the panel is offered the extension, and sync now brings it along, quitting and reopening the browser", async (t) => {
  const f = await fixture(t, { defaultSetting: true });
  const a = await f.account("A");
  const b = await f.account("B");
  f.world.state.running = true;
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  await f.vault.save(a.desktop!.accountUuid, signInFor(a.desktop!.accountUuid, 1));
  await f.cookieVault.save(a.desktop!.accountUuid, loginFor(a.desktop!.accountUuid, 1));
  // Before Relay has seen anything, there is nothing to offer.
  assert.equal(await f.manager.extensionOffer(), undefined);
  await f.manager.switchTo(a.id);
  assert.equal(f.manager.extensionOutcome?.reason, "guide-mismatch");
  assert.deepEqual(await f.manager.extensionOffer(), {
    accountId: a.id,
    to: "A",
    on: "B",
    browser: "Brave",
  });
  f.events.length = 0;
  const outcome = await f.manager.syncExtension();
  assert.equal(outcome.result, "switched");
  assert.deepEqual(f.events, ["quit:brave", "launch:brave"]);
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(a.desktop!.accountUuid, 1));
  assert.deepEqual(f.world.web.get(f.profile), loginFor(a.desktop!.accountUuid, 1));
  // The setting stays "guide", and the offer is gone.
  assert.equal((await f.manager.extensionStatus())!.setting.mode, "guide");
  assert.equal(await f.manager.extensionOffer(), undefined);
});

test("no extension offer without the account's saved pair, in mode 'off', or once a check finds it on the account", async (t) => {
  const f = await fixture(t, { defaultSetting: true });
  const a = await f.account("A");
  const b = await f.account("B");
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  // Only the extension's hints are saved for A: half a pair cannot be put in place.
  await f.vault.save(a.desktop!.accountUuid, signInFor(a.desktop!.accountUuid, 1));
  await f.manager.switchTo(a.id);
  assert.equal(f.manager.extensionOutcome?.reason, "guide-mismatch");
  assert.equal(await f.manager.extensionOffer(), undefined);
  await f.cookieVault.save(a.desktop!.accountUuid, loginFor(a.desktop!.accountUuid, 1));
  assert.equal((await f.manager.extensionOffer())?.on, "B");
  f.store.update((s) => {
    s.settings.claudeExtension = { mode: "off" };
  });
  assert.equal(await f.manager.extensionOffer(), undefined);
  // Sync now does not override "off".
  assert.equal((await f.manager.syncExtension()).reason, "off");
  f.store.update((s) => {
    s.settings.claudeExtension = { mode: "guide" };
  });
  // The user signs the extension in to A by hand and checks.
  f.world.stored.set(f.dir, signInFor(a.desktop!.accountUuid, 3));
  await f.manager.checkExtension();
  assert.equal(await f.manager.extensionOffer(), undefined);
});

test("the extension check logs who it saw, how many instances there are, which one and whether it was opened", async (t) => {
  const f = await fixture(t, { defaultSetting: true });
  const a = await f.account("A");
  const logged: Record<string, unknown>[] = [];
  f.manager.onDraftEvent = (event, fields) => {
    if (event === "extension-check") logged.push(fields ?? {});
  };
  f.world.stored.set(f.dir, signInFor(a.desktop!.accountUuid, 1));
  await f.manager.checkExtension();
  assert.deepEqual(logged.pop(), {
    state: "signed-in",
    known: true,
    other: false,
    account: a.desktop!.accountUuid.slice(0, 8),
    instances: 1,
    target: "brave:Default",
    opened: true,
  });
  // Another claude.ai account: `other`, and no account id.
  f.world.stored.set(f.dir, signInFor(randomUUID(), 1));
  await f.manager.checkExtension();
  assert.deepEqual(logged.pop(), { state: "signed-in", known: false, other: true, instances: 1, target: "brave:Default", opened: true });
  // Only an unopened one, chosen: signed out, and it says so.
  f.world.install("chrome", "Default", "Kişi 1", { opened: false });
  f.store.update((s) => {
    s.settings.claudeExtension = { mode: "guide", browser: { app: "chrome", profile: "Default" } };
  });
  await f.manager.checkExtension();
  assert.deepEqual(logged.pop(), { state: "signed-out", instances: 2, target: "chrome:Default", opened: false });
  assert.deepEqual((await f.manager.extensionStatus())?.current, { state: "signed-out", unopened: true, at: (await f.manager.extensionStatus())?.current?.at });
  // An unopened extension has nothing to bring along: no offer.
  await f.vault.save(a.desktop!.accountUuid, signInFor(a.desktop!.accountUuid, 1));
  await f.cookieVault.save(a.desktop!.accountUuid, loginFor(a.desktop!.accountUuid, 1));
  assert.equal(await f.manager.extensionOffer(), undefined);
  // None at all: "none".
  await fs.rm(path.join(f.world.support, "BraveSoftware"), { recursive: true, force: true });
  await fs.rm(path.join(f.world.support, "Google"), { recursive: true, force: true });
  await f.manager.checkExtension();
  assert.deepEqual(logged.pop(), { state: "none", instances: 0 });
});

test("an extension on Desktop's account whose sign-in expired is offered a fix, and syncing removes the record", async (t) => {
  const f = await fixture(t, { defaultSetting: true });
  const a = await f.account("A");
  await f.manager.switchTo(a.id);
  const uuid = a.desktop!.accountUuid;
  f.world.stored.set(f.dir, {
    ...signInFor(uuid, 2),
    lastAuthFailureReason: JSON.stringify("session_expired"),
  });
  f.world.web.set(f.profile, loginFor(uuid, 2));
  await f.cookieVault.save(uuid, loginFor(uuid, 2));
  await f.manager.checkExtension();
  assert.deepEqual(await f.manager.extensionOffer(), {
    accountId: a.id,
    to: "A",
    expired: true,
    browser: "Brave",
  });
  const outcome = await f.manager.syncExtension();
  assert.deepEqual(
    { result: outcome.result, reason: outcome.reason, cleared: outcome.cleared },
    { result: "unchanged", reason: "already-there", cleared: true },
  );
  assert.deepEqual(f.world.stored.get(f.dir), signInFor(uuid, 2));
  assert.equal(await f.manager.extensionOffer(), undefined);
  // Settings and the account page stop saying it expired without waiting for another check.
  const current = (await f.manager.extensionStatus())!.current;
  assert.equal(current?.state === "signed-in" && current.accountUuid, uuid.toLowerCase());
  assert.equal(current?.state === "signed-in" && current.expired, undefined);
});

test("after a switch, an extension that cannot sign in with the login put in place is caught, the login is forgotten, and reconnecting clears it", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B"); // Claude is on B
  const ua = a.desktop!.accountUuid;
  f.manager.extensionVerifyMs = 0;
  f.manager.extensionOffline = async () => false;
  const broken: string[] = [];
  f.manager.onExtensionBroken = (account) => broken.push(account.name);
  f.setRunning(true);
  f.world.state.running = true;
  await f.vault.save(ua, signInFor(ua, 1));
  // The login Relay kept for A is not A's: the extension's silent sign-in fails at start.
  await f.cookieVault.save(ua, loginFor(ua, 1));
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  const launch = f.world.system.launch;
  f.world.system.launch = async (app) => {
    await launch(app);
    f.world.stored.set(f.dir, {
      ...f.world.stored.get(f.dir)!,
      lastAuthFailureReason: JSON.stringify("session_expired"),
    });
  };
  await f.manager.switchTo(a.id);
  assert.equal(f.manager.extensionOutcome?.result, "switched");
  await f.manager.extensionVerified;
  assert.deepEqual(broken, ["A"]);
  assert.equal(await f.cookieVault.load([ua]), undefined, "the login that failed is forgotten");
  assert.deepEqual(await f.vault.load([ua]), signInFor(ua, 1), "A's hints stay");
  const status = (await f.manager.extensionStatus())!;
  assert.equal(status.broken?.accountUuid, ua.toLowerCase());
  assert.deepEqual(await f.manager.extensionOffer(), {
    accountId: a.id,
    to: "A",
    expired: true,
    reconnect: true,
    browser: "Brave",
  });
  // The user signs in to claude.ai with A and to the extension: a check sees it and keeps both.
  f.world.stored.set(f.dir, signInFor(ua, 3));
  f.world.web.set(f.profile, loginFor(ua, 3));
  const after = (await f.manager.checkExtension())!;
  assert.equal(after.broken, undefined);
  assert.equal(after.current?.state === "signed-in" && after.current.expired, undefined);
  assert.deepEqual(await f.cookieVault.load([ua]), loginFor(ua, 3));
  assert.equal(await f.manager.extensionOffer(), undefined);
});

test("a switch whose extension signs in fine forgets nothing", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  const ua = a.desktop!.accountUuid;
  f.manager.extensionVerifyMs = 0;
  f.manager.extensionOffline = async () => false;
  f.manager.onExtensionBroken = () => assert.fail("nothing is broken");
  f.setRunning(true);
  f.world.state.running = true;
  await f.vault.save(ua, signInFor(ua, 1));
  await f.cookieVault.save(ua, loginFor(ua, 1));
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  await f.manager.switchTo(a.id);
  await f.manager.extensionVerified;
  assert.deepEqual(await f.cookieVault.load([ua]), loginFor(ua, 1));
  assert.equal((await f.manager.extensionStatus())!.broken, undefined);
});

test("a failed sign-in while Anthropic cannot be reached forgets nothing", async (t) => {
  const f = await fixture(t);
  const a = await f.account("A");
  const b = await f.account("B");
  const ua = a.desktop!.accountUuid;
  f.manager.extensionVerifyMs = 0;
  f.manager.extensionOffline = async () => true;
  f.manager.onExtensionBroken = () => assert.fail("offline proves nothing");
  f.setRunning(true);
  f.world.state.running = true;
  await f.vault.save(ua, signInFor(ua, 1));
  await f.cookieVault.save(ua, loginFor(ua, 1));
  f.world.stored.set(f.dir, signInFor(b.desktop!.accountUuid, 2));
  f.world.web.set(f.profile, loginFor(b.desktop!.accountUuid, 2));
  const launch = f.world.system.launch;
  f.world.system.launch = async (app) => {
    await launch(app);
    f.world.stored.set(f.dir, { ...f.world.stored.get(f.dir)!, lastAuthFailureReason: '"session_expired"' });
  };
  await f.manager.switchTo(a.id);
  await f.manager.extensionVerified;
  assert.deepEqual(await f.cookieVault.load([ua]), loginFor(ua, 1));
});

test("Open claude.ai opens it in the managed browser", async (t) => {
  const f = await fixture(t);
  await f.manager.openClaudeWeb();
  assert.deepEqual(f.events, ["open:brave:Default:https://claude.ai/"]);
});
