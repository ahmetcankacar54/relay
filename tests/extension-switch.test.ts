import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ExtensionSwitcher, type ExtensionRequest } from "../electron/core/extension-switch";
import { ExtensionVault } from "../electron/core/extension-vault";
import { createSealer } from "../electron/core/vault-crypto";
import { signInAccount, type SignIn } from "../shared/extension-auth";
import { DEFAULT_EXTENSION, type ExtensionSetting } from "../shared/browser-extension";
import { extensionWorld, signInFor } from "./extension-world";

function setup(t: any) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ext-switch-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const world = extensionWorld(temp);
  const dir = world.install("brave");
  const sealer = createSealer(Buffer.alloc(32, 7));
  const vault = new ExtensionVault(
    path.join(temp, "vault"),
    (text) => sealer.seal(text),
    (data) => sealer.unseal(data),
  );
  const scratch = path.join(temp, "scratch");
  const switcher = new ExtensionSwitcher({
    system: world.system,
    storage: world.storage,
    vault,
    scratch,
  });
  const a = randomUUID();
  const b = randomUUID();
  const request = (over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({
    setting: DEFAULT_EXTENSION,
    mayQuit: true,
    target: [b],
    known: [a, b],
    ...over,
  });
  return { temp, world, dir, vault, scratch, switcher, a, b, request };
}
const mode = (m: ExtensionSetting["mode"]): ExtensionSetting => ({ mode: m });

test("a closed browser: the extension's sign-in is saved for its account and the target's is put in place", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.saved, true);
  assert.equal(outcome.restarted, false);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.b, 5));
  // The snapshot on leave: A's sign-in, as it was, is in the vault.
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 1));
  assert.deepEqual(s.world.events, []);
  assert.equal(fs.existsSync(s.scratch), false, "the backup is removed");
});

test("a rotated refresh token is kept: the next switch away saves the newer copy", async (t) => {
  const s = setup(t);
  await s.vault.save(signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 1));
  s.world.stored.set(s.dir, signInFor(s.a, 2)); // the extension renewed A's tokens
  await s.switcher.run(s.request());
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 2));
});

test("the first sign-in is captured at the switch away, when the target has none saved", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "saved");
  assert.equal(outcome.reason, "no-saved-login");
  assert.equal(outcome.saved, true);
  // The extension is left as it is.
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 1));
});

test("a signed-out extension takes the target's saved sign-in and saves nothing", async (t) => {
  const s = setup(t);
  await s.vault.save(signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.saved, false);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.b, 5));
});

test("signed out with nothing saved for the target changes nothing", async (t) => {
  const s = setup(t);
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "unchanged");
  assert.equal(outcome.reason, "no-saved-login");
  assert.equal(s.world.stored.get(s.dir), undefined);
});

test("the extension already on the target is left, and its newer copy is saved", async (t) => {
  const s = setup(t);
  await s.vault.save(signInFor(s.b, 1));
  s.world.stored.set(s.dir, signInFor(s.b, 3));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "unchanged");
  assert.equal(outcome.reason, "already-there");
  assert.equal(outcome.saved, true);
  assert.deepEqual(await s.vault.load([s.b]), signInFor(s.b, 3));
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.b, 3));
});

test("a running browser is quit, left closed while the database is used, and opened again", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.restarted, true);
  assert.equal(outcome.reopened, true);
  assert.deepEqual(s.world.events, ["quit:brave", "launch:brave"]);
  // Never opened while the browser ran: every use of the storage saw it closed.
  assert.ok(s.world.opened.length > 0);
  assert.ok(s.world.opened.every((o) => !o.running));
  assert.equal(s.world.state.running, true);
});

test("the browser is opened again even when the swap failed", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  s.world.state.failWrite = "failed";
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "write-failed");
  assert.deepEqual(s.world.events, ["quit:brave", "launch:brave"]);
});

test("a failed write puts the folder back from the backup; a mismatch says so", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  s.world.state.failWrite = "failed";
  assert.equal((await s.switcher.run(s.request())).reason, "write-failed");
  assert.equal(fs.readFileSync(path.join(s.dir, "data.txt"), "utf8"), "ORIGINAL");
  s.world.state.failWrite = "mismatch";
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.reason, "verify-failed");
  assert.equal(fs.readFileSync(path.join(s.dir, "data.txt"), "utf8"), "ORIGINAL");
  assert.equal(fs.existsSync(s.scratch), false);
});

test("a failed restore keeps the backup and says so", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  s.world.state.failWrite = "failed";
  // The restore cannot run: the folder is gone after the failed write.
  const write = s.world.storage.write;
  s.world.storage.write = async (dir, signIn) => {
    try {
      await write(dir, signIn);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "restore-failed");
  assert.ok(fs.existsSync(s.scratch), "the backup stays");
});

test("a browser that does not quit is left alone, and the extension is not touched", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.state.stuck = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "browser-did-not-quit");
  assert.equal(outcome.restarted, false);
  assert.deepEqual(s.world.events, ["quit:brave"], "asked once, never forced, never launched");
  assert.deepEqual(s.world.opened, []);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
});

test("a browser that cannot be opened again is reported", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.state.failLaunch = true;
  await s.vault.save(signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.restarted, true);
  assert.equal(outcome.reopened, false);
});

test("a running browser is left alone in mode 'closed' and when the switch may not quit it", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  for (const request of [
    s.request({ setting: mode("closed") }),
    s.request({ mayQuit: false }),
  ]) {
    const outcome = await s.switcher.run(request);
    assert.equal(outcome.result, "skipped");
    assert.equal(outcome.reason, "browser-running");
  }
  assert.deepEqual(s.world.events, []);
  assert.deepEqual(s.world.opened, []);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
});

test("a closed browser is used in mode 'closed' and when the switch may not quit it", async (t) => {
  const s = setup(t);
  await s.vault.save(signInFor(s.b, 5));
  for (const request of [s.request({ setting: mode("closed") }), s.request({ mayQuit: false })]) {
    s.world.stored.set(s.dir, signInFor(s.a, 1));
    assert.equal((await s.switcher.run(request)).result, "switched");
  }
  assert.deepEqual(s.world.events, []);
});

test("mode 'off' touches nothing and reads nothing", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  const outcome = await s.switcher.run(s.request({ setting: mode("off") }));
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "off");
  assert.deepEqual(s.world.events, []);
  assert.deepEqual(s.world.opened, []);
});

test("an extension signed in to an account Relay does not have is never overwritten or saved", async (t) => {
  const s = setup(t);
  const stranger = randomUUID();
  s.world.stored.set(s.dir, signInFor(stranger, 1));
  await s.vault.save(signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "unknown-account");
  assert.equal(outcome.saved, false);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(stranger, 1));
  assert.equal(await s.vault.load([stranger]), undefined);
});

test("the target is found by either of its account's uuids", async (t) => {
  const s = setup(t);
  const own = randomUUID();
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(own, 9));
  const outcome = await s.switcher.run(s.request({ target: [s.b, own], known: [s.a, s.b, own] }));
  assert.equal(outcome.result, "switched");
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(own, 9));
});

test("no extension installed, and several browser profiles without a choice, do nothing", async (t) => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ext-none-"));
  t.after(() => fs.rmSync(none, { recursive: true, force: true }));
  const world = extensionWorld(none);
  const sealer = createSealer(Buffer.alloc(32, 7));
  const vault = new ExtensionVault(path.join(none, "vault"), (x) => sealer.seal(x), (d) => sealer.unseal(d));
  const switcher = new ExtensionSwitcher({ system: world.system, storage: world.storage, vault, scratch: path.join(none, "scratch") });
  const request: ExtensionRequest = { setting: DEFAULT_EXTENSION, mayQuit: true, target: [randomUUID()], known: [] };
  world.state.running = true;
  assert.equal((await switcher.run(request)).reason, "not-installed");
  assert.deepEqual(world.events, [], "nothing is quit when there is no extension");

  const braveDir = world.install("brave");
  const chromeDir = world.install("chrome");
  const outcome = await switcher.run(request);
  assert.equal(outcome.reason, "choose-instance");
  assert.deepEqual(world.events, []);
  // Chosen: that one is used, the other is not.
  const sign = randomUUID();
  const withChoice = { ...request, setting: { mode: "closed", browser: { app: "chrome", profile: "Default" } } as const, target: [sign], known: [sign] };
  world.state.running = false;
  await vault.save(signInFor(sign, 4));
  assert.equal((await switcher.run(withChoice)).result, "switched");
  assert.deepEqual(world.stored.get(chromeDir), signInFor(sign, 4));
  assert.equal(world.stored.get(braveDir), undefined);
});

test("a damaged vault file fails the step, never throws, and the browser is opened again", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  const file = path.join(s.temp, "vault", "extension", `${s.b}.bin`);
  fs.writeFileSync(file, Buffer.from("not sealed at all"));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "unreadable");
  assert.deepEqual(s.world.events, ["quit:brave", "launch:brave"]);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
});

test("an outcome never carries a token", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  const text = JSON.stringify(await s.switcher.run(s.request()));
  assert.doesNotMatch(text, /SECRET/);
});

test("the vault keeps each sign-in under the account it names, sealed", async (t) => {
  const s = setup(t);
  const signIn: SignIn = signInFor(s.a, 1);
  await s.vault.save(signIn);
  const file = path.join(s.temp, "vault", "extension", `${s.a}.bin`);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 4).toString(), "RLY2");
  assert.doesNotMatch(bytes.toString("latin1"), /SECRET/);
  assert.equal(signInAccount((await s.vault.load([s.a]))!), s.a);
  assert.equal(await s.vault.load([s.b]), undefined);
  const listed = await s.vault.list();
  assert.deepEqual(listed.map((x) => x.accountUuid), [s.a]);
  // A file copied under another account's name is refused.
  fs.copyFileSync(file, path.join(s.temp, "vault", "extension", `${s.b}.bin`));
  await assert.rejects(s.vault.load([s.b]), /Invalid saved extension sign-in/);
  // A sign-in naming no account is not saved.
  await assert.rejects(s.vault.save({ accessToken: '"x"' }), /names no account/);
});

test("without the LevelDB library nothing is quit, read or written", async (t) => {
  const s = setup(t);
  s.world.state.available = false;
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "unavailable");
  assert.equal(outcome.restarted, false);
  assert.deepEqual(s.world.events, []);
  assert.deepEqual(s.world.opened, []);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
});

test("several browser profiles without a choice: the one whose extension was used last is managed", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ext-recent-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const world = extensionWorld(temp);
  const sealer = createSealer(Buffer.alloc(32, 7));
  const vault = new ExtensionVault(path.join(temp, "vault"), (x) => sealer.seal(x), (d) => sealer.unseal(d));
  const switcher = new ExtensionSwitcher({ system: world.system, storage: world.storage, vault, scratch: path.join(temp, "scratch") });
  const braveDir = world.install("brave");
  const chromeDir = world.install("chrome");
  world.modified.set(braveDir, 2_000);
  world.modified.set(chromeDir, 1_000);
  const sign = randomUUID();
  await vault.save(signInFor(sign, 4));
  const outcome = await switcher.run({ setting: DEFAULT_EXTENSION, mayQuit: true, target: [sign], known: [sign] });
  assert.equal(outcome.result, "switched");
  assert.deepEqual(world.stored.get(braveDir), signInFor(sign, 4));
  assert.equal(world.stored.get(chromeDir), undefined);
});

test("a check reads a copy while the browser runs, links a known account, and quits nothing", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 3));
  const current = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b] });
  assert.equal(current?.state, "signed-in");
  assert.equal(current?.state === "signed-in" && current.accountUuid, s.a.toLowerCase());
  assert.equal(current?.state === "signed-in" && current.known, true);
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 3), "linked: saved in the vault");
  assert.deepEqual(s.world.events, [], "the browser is left running");
  assert.deepEqual(s.world.opened, [], "the live folder is never opened");
  assert.equal(fs.existsSync(`${s.scratch}-peek`), false, "the copy is removed");
  assert.equal(fs.readFileSync(path.join(s.dir, "data.txt"), "utf8"), "ORIGINAL");
});

test("a check of an unknown account, a signed-out extension, or mode off saves nothing", async (t) => {
  const s = setup(t);
  const stranger = randomUUID();
  s.world.stored.set(s.dir, signInFor(stranger, 1));
  const unknown = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a] });
  assert.equal(unknown?.state === "signed-in" && unknown.known, false);
  assert.equal(await s.vault.load([stranger]), undefined);
  s.world.stored.set(s.dir, undefined);
  assert.equal((await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a] }))?.state, "signed-out");
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  assert.equal(await s.switcher.check({ setting: mode("off"), known: [s.a] }), undefined);
  assert.equal(await s.vault.load([s.a]), undefined);
});

test("a check that finds no sign-in reports the key names it saw, never a value", async (t) => {
  const s = setup(t);
  const seen: string[][] = [];
  const switcher = new ExtensionSwitcher({
    system: s.world.system,
    storage: { ...s.world.storage, keyNames: async () => ["oauthState", "settings"] },
    vault: s.vault,
    scratch: s.scratch,
    onUnknownLayout: (names) => void seen.push(names),
  });
  s.world.stored.set(s.dir, undefined);
  assert.equal((await switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a] }))?.state, "signed-out");
  assert.deepEqual(seen, [["oauthState", "settings"]]);
});
