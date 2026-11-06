import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ExtensionSwitcher, type ExtensionRequest } from "../electron/core/extension-switch";
import { ExtensionVault } from "../electron/core/extension-vault";
import { createSealer } from "../electron/core/vault-crypto";
import type { SignIn } from "../shared/extension-auth";
import { DEFAULT_EXTENSION, type ExtensionSetting } from "../shared/browser-extension";
import { CookieVault } from "../electron/core/cookie-vault";
import { extensionWorld, loginFor, signInFor } from "./extension-world";

function setup(t: any, ports: Partial<ConstructorParameters<typeof ExtensionSwitcher>[0]> = {}) {
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
  const cookieVault = new CookieVault(
    path.join(temp, "vault"),
    (text) => sealer.seal(text),
    (data) => sealer.unseal(data),
  );
  const scratch = path.join(temp, "scratch");
  const switcher = new ExtensionSwitcher({
    system: world.system,
    storage: world.storage,
    cookies: world.cookies,
    vault,
    cookieVault,
    scratch,
    ...ports,
  });
  const profile = path.dirname(path.dirname(dir));
  const a = randomUUID();
  const b = randomUUID();
  const request = (over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({
    setting: { mode: "restart" },
    mayQuit: true,
    target: [b],
    known: [a, b],
    ...over,
  });
  return { temp, world, dir, profile, vault, cookieVault, scratch, switcher, a, b, request };
}
const mode = (m: ExtensionSetting["mode"]): ExtensionSetting => ({ mode: m });

test("a closed browser: the extension's sign-in is saved for its account and the target's is put in place", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.a, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 1));
  await s.cookieVault.save(s.b, loginFor(s.b, 1));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.b, signInFor(s.b, 1));
  await s.cookieVault.save(s.b, loginFor(s.b, 1));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  s.world.state.failWrite = "failed";
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "write-failed");
  assert.deepEqual(s.world.events, ["quit:brave", "launch:brave"]);
});

test("a failed write puts the folder back from the backup; a mismatch says so", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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

test("the backups of a failed restore survive the next switch", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  s.world.state.failWrite = "failed";
  const write = s.world.storage.write;
  s.world.storage.write = async (dir, signIn) => {
    try {
      await write(dir, signIn);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal((await s.switcher.run(s.request())).reason, "restore-failed");
  const kept = fs.readdirSync(s.scratch).filter((name) => name !== ".kept");
  assert.equal(kept.length, 1);
  // A later, healthy switch must not take the only copy away.
  s.world.storage.write = write;
  s.world.state.failWrite = undefined;
  fs.mkdirSync(s.dir, { recursive: true });
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.switcher.run(s.request());
  assert.ok(fs.existsSync(path.join(s.scratch, kept[0])), "the earlier backup stays");
  assert.deepEqual(fs.readdirSync(s.scratch).filter((name) => name !== ".kept"), kept, "this run's own backup is gone");
});

test("after an interrupted swap nothing is saved from the profile, and the next swap mends it", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.a, signInFor(s.a, 7));
  await s.cookieVault.save(s.a, loginFor(s.a, 7));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const savedA = await s.vault.load([s.a]);
  const savedLoginA = await s.cookieVault.load([s.a]);
  await s.vault.markSwap();
  assert.equal(await s.vault.swapInterrupted(), true);
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.saved, false, "the doubtful pair is not saved");
  assert.deepEqual(await s.vault.load([s.a]), savedA);
  assert.deepEqual(await s.cookieVault.load([s.a]), savedLoginA);
  assert.equal(await s.vault.swapInterrupted(), false, "the mark goes once the pair is in place");
});

test("a browser that does not quit is left alone, and the extension is not touched", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.state.stuck = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.restarted, true);
  assert.equal(outcome.reopened, false);
});

test("a running browser is left alone in mode 'closed' and when the switch may not quit it", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(own, signInFor(own, 9));
  await s.cookieVault.save(own, loginFor(own, 9));
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
  const cookieVault = new CookieVault(path.join(none, "vault"), (x) => sealer.seal(x), (d) => sealer.unseal(d));
  const switcher = new ExtensionSwitcher({ system: world.system, storage: world.storage, cookies: world.cookies, vault, cookieVault, scratch: path.join(none, "scratch") });
  const request: ExtensionRequest = { setting: { mode: "restart" }, mayQuit: true, target: [randomUUID()], known: [] };
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
  await vault.save(sign, signInFor(sign, 4));
  await cookieVault.save(sign, loginFor(sign, 4));
  assert.equal((await switcher.run(withChoice)).result, "switched");
  assert.deepEqual(world.stored.get(chromeDir), signInFor(sign, 4));
  assert.equal(world.stored.get(braveDir), undefined);
});

test("a damaged vault file fails the step, never throws, and the browser is opened again", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const text = JSON.stringify(await s.switcher.run(s.request()));
  assert.doesNotMatch(text, /SECRET/);
});

test("the vault keeps each sign-in under the account it names, sealed", async (t) => {
  const s = setup(t);
  const signIn: SignIn = signInFor(s.a, 1);
  await s.vault.save(s.a, signIn);
  const file = path.join(s.temp, "vault", "extension", `${s.a}.bin`);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 4).toString(), "RLY2");
  assert.doesNotMatch(bytes.toString("latin1"), /SECRET/);
  assert.deepEqual(await s.vault.load([s.a.toUpperCase()]), signIn);
  assert.equal(await s.vault.load([s.b]), undefined);
  const listed = await s.vault.list();
  assert.deepEqual(listed.map((x) => x.accountUuid), [s.a]);
  // A file copied under another account's name is refused.
  fs.copyFileSync(file, path.join(s.temp, "vault", "extension", `${s.b}.bin`));
  await assert.rejects(s.vault.load([s.b]), /Invalid saved extension sign-in/);
  // A sign-in without an account is not saved.
  await assert.rejects(s.vault.save("not-a-uuid", { accessToken: '"x"' }), /names no account/);
});

test("without the LevelDB library nothing is quit, read or written", async (t) => {
  const s = setup(t);
  s.world.state.available = false;
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
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
  const cookieVault = new CookieVault(path.join(temp, "vault"), (x) => sealer.seal(x), (d) => sealer.unseal(d));
  const switcher = new ExtensionSwitcher({ system: world.system, storage: world.storage, cookies: world.cookies, vault, cookieVault, scratch: path.join(temp, "scratch") });
  const braveDir = world.install("brave");
  const chromeDir = world.install("chrome");
  world.modified.set(braveDir, 2_000);
  world.modified.set(chromeDir, 1_000);
  const sign = randomUUID();
  await vault.save(sign, signInFor(sign, 4));
  await cookieVault.save(sign, loginFor(sign, 4));
  const outcome = await switcher.run({ setting: { mode: "restart" }, mayQuit: true, target: [sign], known: [sign] });
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

test("a check that finds no account of Relay's reports the key names it saw, never a value", async (t) => {
  const s = setup(t);
  const seen: string[][] = [];
  const switcher = new ExtensionSwitcher({
    system: s.world.system,
    storage: s.world.storage,
    vault: s.vault,
    scratch: s.scratch,
    onUnknownLayout: (names) => void seen.push(names),
  });
  s.world.stored.set(s.dir, { settings: '{"x":1}', oauthState: '"abc"' });
  assert.equal((await switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a] }))?.state, "signed-out");
  assert.deepEqual(seen, [["settings", "oauthState"]]);
  assert.doesNotMatch(JSON.stringify(seen), /abc|"x"/);
});

test("data naming no account: the user's claim links it, and Relay then remembers who it put in place", async (t) => {
  const s = setup(t);
  // Tokens only, no account uuid anywhere.
  const bare = (n: number): SignIn => ({ oauth: JSON.stringify({ access_token: `sk-ant-oat01-SECRET${n}AAAAAA` }) });
  s.world.stored.set(s.dir, bare(1));
  const unknown = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b] });
  assert.deepEqual([unknown?.state, unknown?.state === "signed-in" && unknown.known], ["signed-in", false]);
  // A claim for an account Relay does not have is ignored.
  const stray = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b], claim: randomUUID() });
  assert.equal(stray?.state === "signed-in" && stray.known, false);
  const claimed = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b], claim: s.a });
  assert.equal(claimed?.state === "signed-in" && claimed.accountUuid, s.a.toLowerCase());
  assert.deepEqual(await s.vault.load([s.a]), bare(1));
  // A switch to B: the bare sign-in is saved as A's (the owner), B's is put in, B becomes the owner.
  await s.vault.save(s.b, bare(5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  s.world.web.set(s.profile, loginFor(s.a, 2));
  s.world.stored.set(s.dir, bare(2));
  assert.equal((await s.switcher.run(s.request({ target: [s.b] }))).result, "switched");
  assert.deepEqual(await s.vault.load([s.a]), bare(2));
  assert.deepEqual(s.world.stored.get(s.dir), bare(5));
  assert.equal(await s.vault.owner(), s.b.toLowerCase());
  // And back: B's rotated copy is kept, A's is put in.
  s.world.stored.set(s.dir, bare(6));
  assert.equal((await s.switcher.run(s.request({ target: [s.a] }))).result, "switched");
  assert.deepEqual(await s.vault.load([s.b]), bare(6));
  assert.deepEqual(s.world.stored.get(s.dir), bare(2));
});

test("a sign-in naming another account is never taken for the remembered one", async (t) => {
  const s = setup(t);
  await s.vault.setOwner(s.a);
  const stranger = randomUUID();
  s.world.stored.set(s.dir, signInFor(stranger, 1));
  const current = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b], claim: s.a });
  assert.equal(current?.state === "signed-in" && current.known, false);
  assert.equal(await s.vault.load([s.a]), undefined);
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  assert.equal((await s.switcher.run(s.request())).reason, "unknown-account");
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(stranger, 1));
});

test("the pair: the profile's claude.ai login is saved for the account the hints name, and the target's pair is put in place", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.b, 5));
  assert.deepEqual(s.world.web.get(s.profile), loginFor(s.b, 5));
  // The snapshot on leave: A's login, as the profile held it, is sealed in the vault.
  assert.deepEqual(await s.cookieVault.load([s.a]), loginFor(s.a, 1));
  assert.equal(fs.existsSync(s.scratch), false);
  assert.equal(fs.existsSync(`${s.scratch}-cookies`), false);
});

test("a login is sealed: no cookie byte or account uuid is readable in the vault file", async (t) => {
  const s = setup(t);
  await s.cookieVault.save(s.a, loginFor(s.a, 1));
  const raw = fs.readFileSync(path.join(s.temp, "vault", "extension-cookies", `${s.a.toLowerCase()}.bin`));
  assert.doesNotMatch(raw.toString("latin1"), /SESSION-SECRET|sessionKey|claude\.ai/);
  assert.deepEqual((await s.cookieVault.list()).map((x) => x.accountUuid), [s.a.toLowerCase()]);
  // Another account's file is not opened for this one.
  fs.copyFileSync(
    path.join(s.temp, "vault", "extension-cookies", `${s.a.toLowerCase()}.bin`),
    path.join(s.temp, "vault", "extension-cookies", `${s.b.toLowerCase()}.bin`),
  );
  await assert.rejects(s.cookieVault.load([s.b]));
});

test("a vault record holding rows that are not a login is refused, on save and on load", async (t) => {
  const s = setup(t);
  const bad = loginFor(s.a, 1);
  bad.rows.push({ ...bad.rows[0], host_key: ".bank.example", name: "session" });
  await assert.rejects(s.cookieVault.save(s.a, bad));
  await assert.rejects(s.cookieVault.save("not-a-uuid", loginFor(s.a, 1)));
});

test("a target with hints but no saved login is not half-swapped", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "saved");
  assert.equal(outcome.reason, "no-saved-login");
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
  assert.deepEqual(s.world.web.get(s.profile), loginFor(s.a, 1));
  // Both of A's halves were kept.
  assert.deepEqual(await s.cookieVault.load([s.a]), loginFor(s.a, 1));
});

test("a failed cookie write puts both the hints and the cookie files back", async (t) => {
  for (const [fail, reason] of [
    ["mismatch", "verify-failed"],
    ["schema-changed", "schema-changed"],
    ["journal-pending", "journal-pending"],
    ["locked", "locked"],
    ["failed", "write-failed"],
  ] as const) {
    const s = setup(t);
    s.world.stored.set(s.dir, signInFor(s.a, 1));
    s.world.web.set(s.profile, loginFor(s.a, 1));
    await s.vault.save(s.b, signInFor(s.b, 5));
    await s.cookieVault.save(s.b, loginFor(s.b, 5));
    s.world.state.failCookieWrite = fail;
    const outcome = await s.switcher.run(s.request());
    assert.equal(outcome.result, "failed");
    assert.equal(outcome.reason, reason);
    assert.equal(fs.readFileSync(path.join(s.profile, "Cookies"), "utf8"), s.profile, "the cookie file is back");
    assert.equal(fs.readFileSync(path.join(s.dir, "data.txt"), "utf8"), "ORIGINAL");
    assert.equal(fs.existsSync(`${s.scratch}-cookies`), false);
  }
});

test("a failed restore keeps both backups", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  s.world.state.failCookieWrite = "mismatch";
  // The cookie file becomes a folder, so putting it back fails.
  const real = s.world.cookies.write;
  s.world.cookies.write = async (dir, snapshot) => {
    try {
      await real(dir, snapshot);
    } finally {
      fs.rmSync(path.join(dir, "Cookies"), { force: true });
      fs.mkdirSync(path.join(dir, "Cookies"));
    }
  };
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.reason, "restore-failed");
  assert.equal(fs.existsSync(`${s.scratch}-cookies`), true);
});

test("a web login nobody can name is never overwritten", async (t) => {
  const s = setup(t);
  // The extension is signed out, yet the profile is logged in to claude.ai as someone.
  s.world.web.set(s.profile, loginFor(randomUUID(), 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "unknown-account");
  assert.equal(s.world.stored.get(s.dir), undefined);
  assert.notDeepEqual(s.world.web.get(s.profile), loginFor(s.b, 5));
});

test("a web login newer than the hints is not saved under the hints' account", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.modified.set(s.dir, 1_700_000_000_000);
  // Created an hour after the hints were last written: the user signed in to claude.ai again.
  s.world.web.set(s.profile, loginFor(s.a, 1, 1_700_000_000_000 + 3_600_000));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "ambiguous-owner");
  assert.equal(await s.cookieVault.load([s.a]), undefined);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
});

test("a claude.ai login cookie this build does not list stops the swap", async (t) => {
  const layouts: Record<string, string>[] = [];
  const s = setup(t, { onCookieLayout: (detail) => void layouts.push(detail) });
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  const web = loginFor(s.a, 1);
  web.unlisted = ["sessionKeyV9"];
  s.world.web.set(s.profile, web);
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.reason, "schema-changed");
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
  // The log learns which cookie it was, by name.
  assert.deepEqual(layouts, [{ why: "unlisted", names: "sessionKeyV9" }]);
});

test("without SQLite nothing is quit, read or written", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.state.cookiesAvailable = false;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.reason, "unavailable");
  assert.deepEqual(s.world.events, []);
  assert.deepEqual(s.world.opened, []);
});

test("a switcher built without the cookie ports changes nothing", async (t) => {
  const s = setup(t);
  const bare = new ExtensionSwitcher({ system: s.world.system, storage: s.world.storage, vault: s.vault, scratch: s.scratch });
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  assert.equal((await bare.run(s.request())).reason, "unavailable");
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
});

test("the cookie database is only opened with the browser closed, and the browser comes back", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.deepEqual(s.world.events, ["quit:brave", "launch:brave"]);
  assert.ok(s.world.opened.some((o) => o.dir === s.profile));
  assert.ok(s.world.opened.every((o) => !o.running));
});

test("mode 'guide' writes nothing and quits nothing; it says when the extension is on another account", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.a, 1));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const off = await s.switcher.run(s.request({ setting: mode("guide") }));
  assert.equal(off.result, "skipped");
  assert.equal(off.reason, "guide-mismatch");
  assert.equal(off.restarted, false);
  assert.deepEqual(s.world.events, []);
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.a, 1));
  assert.deepEqual(s.world.web.get(s.profile), loginFor(s.a, 1));
  // What the check saw is kept, so switching modes later needs no new sign-in.
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 1));
  assert.deepEqual(await s.cookieVault.load([s.a]), loginFor(s.a, 1));
  // On the target already: nothing to say.
  const there = await s.switcher.run(s.request({ setting: mode("guide"), target: [s.a] }));
  assert.equal(there.result, "unchanged");
  // Signed out also reads as "not on the target".
  s.world.stored.set(s.dir, undefined);
  assert.equal((await s.switcher.run(s.request({ setting: mode("guide") }))).reason, "guide-mismatch");
});

test("a check keeps the profile's login only when none is saved, never over a saved one", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.a, 1));
  assert.equal((await s.switcher.check({ setting: mode("restart"), known: [s.a, s.b] }))?.state, "signed-in");
  assert.deepEqual(await s.cookieVault.load([s.a]), loginFor(s.a, 1));
  // The running browser's database changed (a rotated cookie); a check does not replace the saved one.
  s.world.web.set(s.profile, loginFor(s.a, 2));
  await s.switcher.check({ setting: mode("restart"), known: [s.a, s.b] });
  assert.deepEqual(await s.cookieVault.load([s.a]), loginFor(s.a, 1));
  assert.deepEqual(s.world.events, []);
  assert.equal(fs.existsSync(`${s.scratch}-peek`), false);
});

test("a login that is not the extension's account's (newer than the hints) is not kept by a check", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.modified.set(s.dir, 1_700_000_000_000);
  s.world.web.set(s.profile, loginFor(s.a, 1, 1_700_000_000_000 + 3_600_000));
  await s.switcher.check({ setting: mode("restart"), known: [s.a, s.b] });
  assert.equal(await s.cookieVault.load([s.a]), undefined);
});

test("Arc, Chrome Beta, Dev and Canary, Dia and Comet are looked in, each in its own folder", async (t) => {
  const s = setup(t);
  const arc = s.world.install("arc", "Default", "Arc");
  const canary = s.world.install("chrome-canary", "Profile 1", "Canary");
  s.world.install("chrome-beta");
  s.world.install("chrome-dev");
  s.world.install("dia");
  s.world.install("comet");
  assert.equal(arc, path.join(s.world.support, "Arc", "User Data", "Default", "Local Extension Settings", "fcoeoabgfenejglbffodgkkbkcdhcgfn"));
  assert.ok(canary.startsWith(path.join(s.world.support, "Google", "Chrome Canary", "Profile 1")));
  assert.deepEqual(
    s.switcher.instances().map((i) => `${i.app}:${i.profile}:${i.opened}`),
    [
      "brave:Default:true",
      "arc:Default:true",
      "chrome-beta:Default:true",
      "chrome-dev:Default:true",
      "chrome-canary:Profile 1:true",
      "dia:Default:true",
      "comet:Default:true",
    ],
  );
  // A chosen one of them is read like any other.
  s.world.stored.set(arc, signInFor(s.a, 2));
  const current = await s.switcher.check({ setting: { mode: "guide", browser: { app: "arc", profile: "Default" } }, known: [s.a] });
  assert.equal(current?.state === "signed-in" && current.accountUuid, s.a.toLowerCase());
});

test("an extension installed but never opened is listed, reads as signed out, and is never swapped", async (t) => {
  const s = setup(t);
  const dir = s.world.install("chrome", "Default", "Kişi 1", { opened: false });
  // A profile without the extension at all is not listed.
  const localState = path.join(s.world.support, "Google", "Chrome", "Local State");
  const local = JSON.parse(fs.readFileSync(localState, "utf8"));
  local.profile.info_cache["Profile 2"] = { name: "Bare" };
  fs.writeFileSync(localState, JSON.stringify(local));
  fs.mkdirSync(path.join(s.world.support, "Google", "Chrome", "Profile 2"), { recursive: true });
  const instances = s.switcher.instances();
  assert.deepEqual(
    instances.map((i) => `${i.app}:${i.profile}:${i.opened}`),
    ["chrome:Default:false", "brave:Default:true"],
  );
  assert.equal(instances[0].usedAt, undefined);
  const chrome = { app: "chrome", profile: "Default" } as const;
  const current = await s.switcher.check({ setting: { mode: "guide", browser: chrome }, known: [s.a, s.b] });
  assert.deepEqual(current, { state: "signed-out", unopened: true, at: current?.at });
  assert.deepEqual(s.world.opened, [], "nothing is opened for it");
  // A swap leaves it alone, even with a complete pair saved and the browser running.
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  s.world.state.running = true;
  const swap = await s.switcher.run(s.request({ setting: { mode: "restart", browser: chrome } }));
  assert.deepEqual({ result: swap.result, reason: swap.reason, restarted: swap.restarted }, { result: "skipped", reason: "not-opened", restarted: false });
  assert.deepEqual(s.world.events, [], "the browser is not quit");
  assert.deepEqual(s.world.opened, []);
  assert.equal(fs.existsSync(dir), false, "no storage is made for it");
  // Mode "guide" says so too, with what it saw.
  const guide = await s.switcher.run(s.request({ setting: { mode: "guide", browser: chrome } }));
  assert.equal(guide.reason, "not-opened");
  assert.equal(guide.current?.state === "signed-out" && guide.current.unopened, true);
  // The only one found is managed: Brave gone, Chrome is still left alone.
  fs.rmSync(path.join(s.world.support, "BraveSoftware"), { recursive: true, force: true });
  assert.equal((await s.switcher.run(s.request())).reason, "not-opened");
});

/** What extension 1.0.105 keeps after a failed sign-in: tools are refused until one works. */
const failed = (signIn: SignIn): SignIn => ({
  ...signIn,
  lastAuthFailureReason: JSON.stringify("session_expired"),
  startupReauthState: JSON.stringify({ terminal: true, stop: "definitive", lastProbeAt: 1 }),
  pairingOrgMismatch: JSON.stringify({ org: "11111111-1111-4111-8111-111111111111" }),
});

test("a failed sign-in's record is never saved with an account and never put back", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, failed(signInFor(s.a, 1)));
  // A record Relay 0.14.1 kept for B along with its failure.
  fs.mkdirSync(path.join(s.temp, "vault", "extension"), { recursive: true });
  const sealer = createSealer(Buffer.alloc(32, 7));
  fs.writeFileSync(
    path.join(s.temp, "vault", "extension", `${s.b}.bin`),
    sealer.seal(
      JSON.stringify({ accountUuid: s.b, savedAt: "2026-11-02T20:12:07.000Z", signIn: failed(signInFor(s.b, 5)) }),
    ),
  );
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await s.switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.b, 5), "B's record goes without its failure");
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 1), "A is kept without its failure");
  assert.deepEqual(await s.vault.load([s.b]), signInFor(s.b, 5));
});

test("already on the target with a failed sign-in's record: the record goes, nothing else changes", async (t) => {
  const s = setup(t);
  await s.vault.save(s.b, signInFor(s.b, 1));
  await s.cookieVault.save(s.b, loginFor(s.b, 1));
  s.world.web.set(s.profile, loginFor(s.b, 2));
  s.world.stored.set(s.dir, failed(signInFor(s.b, 3)));
  const outcome = await s.switcher.run(s.request());
  assert.deepEqual(
    { result: outcome.result, reason: outcome.reason, cleared: outcome.cleared, saved: outcome.saved },
    { result: "unchanged", reason: "already-there", cleared: true, saved: true },
  );
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.b, 3));
  assert.deepEqual(s.world.web.get(s.profile), loginFor(s.b, 2), "the claude.ai login is left as it is");
  assert.deepEqual(await s.vault.load([s.b]), signInFor(s.b, 3));
  // Without a record there is nothing to write.
  const opened = s.world.opened.length;
  const again = await s.switcher.run(s.request());
  assert.equal(again.cleared, undefined);
  assert.equal(
    s.world.opened.slice(opened).filter((o) => o.dir === s.dir).length,
    1,
    "the folder is only read",
  );
});

test("the record goes even when the target's claude.ai login was never saved", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, failed(signInFor(s.b, 3)));
  const outcome = await s.switcher.run(s.request());
  assert.deepEqual(
    { result: outcome.result, reason: outcome.reason, cleared: outcome.cleared },
    { result: "unchanged", reason: "already-there", cleared: true },
  );
  assert.deepEqual(s.world.stored.get(s.dir), signInFor(s.b, 3));
});

test("a failed removal of the record puts the folder back", async (t) => {
  const s = setup(t);
  await s.vault.save(s.b, signInFor(s.b, 1));
  await s.cookieVault.save(s.b, loginFor(s.b, 1));
  s.world.web.set(s.profile, loginFor(s.b, 2));
  s.world.stored.set(s.dir, failed(signInFor(s.b, 3)));
  s.world.state.failWrite = "failed";
  const outcome = await s.switcher.run(s.request());
  assert.deepEqual({ result: outcome.result, reason: outcome.reason }, { result: "failed", reason: "write-failed" });
  assert.equal(fs.readFileSync(path.join(s.dir, "data.txt"), "utf8"), "ORIGINAL");
  assert.equal(fs.existsSync(s.scratch), false);
});

test("a check says when the extension's sign-in expired, and saves it without the record", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, failed(signInFor(s.a, 3)));
  const current = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b] });
  assert.equal(current?.state === "signed-in" && current.accountUuid, s.a.toLowerCase());
  assert.equal(current?.state === "signed-in" && current.expired, true);
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 3));
  s.world.stored.set(s.dir, signInFor(s.a, 4));
  const fresh = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b] });
  assert.equal(fresh?.state === "signed-in" && fresh.expired, undefined);
});

/** A login on an organization: the browser encrypts the same organization id to the same bytes. */
const onOrg = (login: ReturnType<typeof loginFor>, org: string) => ({
  ...login,
  rows: [
    ...login.rows,
    {
      ...login.rows[0],
      name: "lastActiveOrg",
      encrypted_value: new Uint8Array(Buffer.from(`v10ORG-${org}`)),
    },
  ],
});

test("a claude.ai login already saved for another account is never kept as the hints' account's", async (t) => {
  const s = setup(t);
  const told: string[] = [];
  const switcher = new ExtensionSwitcher({
    system: s.world.system,
    storage: s.world.storage,
    cookies: s.world.cookies,
    vault: s.vault,
    cookieVault: s.cookieVault,
    scratch: s.scratch,
    onForeignLogin: (account, other, why) => told.push(`${account}:${other}:${why}`),
  });
  // The user signed in to claude.ai with B while the extension stayed on A: the login is B's.
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.b, 5));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const outcome = await switcher.run(s.request());
  assert.equal(outcome.result, "switched");
  assert.deepEqual(await s.vault.load([s.a]), signInFor(s.a, 1), "A's hints are kept");
  assert.equal(await s.cookieVault.load([s.a]), undefined, "B's login is not kept as A's");
  assert.deepEqual(told, [`${s.a}:${s.b}:same-login`]);
});

test("a login on another account's organization is not kept when their organizations differ", async (t) => {
  const s = setup(t);
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  // A second claude.ai login of B (another session), on B's organization.
  s.world.web.set(s.profile, onOrg(loginFor(s.a, 9), "org-b"));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, onOrg(loginFor(s.b, 5), "org-b"));
  await s.switcher.run(s.request({ orgs: { [s.a]: "org-a", [s.b]: "org-b" } }));
  assert.equal(await s.cookieVault.load([s.a]), undefined);
  // Two seats of one organization share it: that says nothing, and the login is kept.
  const s2 = setup(t);
  s2.world.stored.set(s2.dir, signInFor(s2.a, 1));
  s2.world.web.set(s2.profile, onOrg(loginFor(s2.a, 9), "org-team"));
  await s2.vault.save(s2.b, signInFor(s2.b, 5));
  await s2.cookieVault.save(s2.b, onOrg(loginFor(s2.b, 5), "org-team"));
  await s2.switcher.run(s2.request({ orgs: { [s2.a]: "org-team", [s2.b]: "org-team" } }));
  assert.deepEqual(await s2.cookieVault.load([s2.a]), onOrg(loginFor(s2.a, 9), "org-team"));
});

test("a check never keeps another account's claude.ai login either", async (t) => {
  const s = setup(t);
  s.world.state.running = true;
  s.world.stored.set(s.dir, signInFor(s.a, 3));
  s.world.web.set(s.profile, loginFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  const current = await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b] });
  assert.equal(current?.state === "signed-in" && current.accountUuid, s.a.toLowerCase());
  assert.equal(await s.cookieVault.load([s.a]), undefined);
  // Its own login is kept.
  s.world.web.set(s.profile, loginFor(s.a, 3));
  await s.switcher.check({ setting: DEFAULT_EXTENSION, known: [s.a, s.b] });
  assert.deepEqual(await s.cookieVault.load([s.a]), loginFor(s.a, 3));
});

test("a rejected login is forgotten, waits for a reconnect, and is never kept for that account again", async (t) => {
  const s = setup(t);
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  await s.cookieVault.reject(s.b);
  assert.equal(await s.cookieVault.load([s.b]), undefined);
  assert.deepEqual(await s.cookieVault.list(), [], "the rejection file is not an account's");
  assert.equal((await s.cookieVault.waiting())?.accountUuid, s.b.toLowerCase());
  assert.equal(await s.cookieVault.isRejected(s.b, loginFor(s.b, 5)), true);
  assert.equal(await s.cookieVault.isRejected(s.b, loginFor(s.b, 5, 1_800_000_000_000)), false);
  assert.equal(await s.cookieVault.isRejected(s.a, loginFor(s.b, 5)), false);
  // The switch away from B saves B's hints, never that login again.
  s.world.stored.set(s.dir, signInFor(s.b, 6));
  s.world.web.set(s.profile, loginFor(s.b, 5));
  await s.vault.save(s.a, signInFor(s.a, 1));
  await s.cookieVault.save(s.a, loginFor(s.a, 1));
  await s.switcher.run(s.request({ target: [s.a] }));
  assert.deepEqual(await s.vault.load([s.b]), signInFor(s.b, 6));
  assert.equal(await s.cookieVault.load([s.b]), undefined);
  // Signed in fine again: no longer waiting; the login stays rejected.
  await s.cookieVault.reconnected(s.b);
  assert.equal(await s.cookieVault.waiting(), undefined);
  assert.equal(await s.cookieVault.isRejected(s.b, loginFor(s.b, 5)), true);
});

test("a login saved under the same account's other uuid is not another account's", async (t) => {
  const s = setup(t);
  const alias = randomUUID();
  s.world.stored.set(s.dir, signInFor(s.a, 1));
  s.world.web.set(s.profile, loginFor(s.a, 2));
  await s.cookieVault.save(alias, loginFor(s.a, 2));
  await s.vault.save(s.b, signInFor(s.b, 5));
  await s.cookieVault.save(s.b, loginFor(s.b, 5));
  await s.switcher.run(s.request({ known: [s.a, s.b, alias], groups: [[s.a, alias], [s.b]] }));
  assert.deepEqual(await s.cookieVault.load([s.a]), loginFor(s.a, 2));
});
