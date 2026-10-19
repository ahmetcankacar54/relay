import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";

test("a lost vault key points to reset-vault, which sets the old files aside and lets accounts be saved again", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const b = await f.saved("B"); // Desktop is signed in to B
  f.security.removeItem("Relay Vault Key");
  assert.equal(await f.run("switch", "A", "--yes"), 5);
  assert.match(f.err(), /relay reset-vault/);
  f.clear();
  assert.equal(await f.run("reset-vault"), 4);
  assert.equal(await f.run("reset-vault", "--yes"), 0);
  const vault = path.join(f.home, "desktop-vault");
  assert.equal(fs.existsSync(path.join(vault, "accounts")), false);
  const lost = fs.readdirSync(vault).find((name) => name.startsWith("lost-key-"))!;
  assert.ok(fs.existsSync(path.join(vault, lost, "accounts")));
  assert.notEqual(f.security.stored(), "");
  assert.ok(f.store().state.accounts.every((a) => a.desktop === undefined));
  f.clear();
  assert.equal(await f.run("add", "B", "--yes"), 0);
  assert.equal(f.store().account(b.id).desktop?.accountUuid, b.desktop!.accountUuid);
});

test("reset-vault refuses while the key is readable", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  assert.equal(await f.run("reset-vault", "--yes"), 1);
  assert.match(f.err(), /nothing to reset/i);
  assert.ok(f.store().state.accounts[0].desktop);
});

test("reset-vault refuses a vault still in the old format: there was never a key to lose", async (t) => {
  const f = await cliFixture(t);
  const vault = path.join(f.home, "desktop-vault");
  fs.mkdirSync(path.join(vault, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(vault, "accounts", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin"), "v10old");
  assert.equal(await f.run("reset-vault", "--yes"), 1);
  assert.match(f.err(), /old format/);
  assert.ok(fs.existsSync(path.join(vault, "accounts", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin")));
  assert.equal(fs.readdirSync(vault).some((name) => name.startsWith("lost-key-")), false);
});

test("reset-vault refuses while Relay.app runs, since it keeps its own key in memory", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  f.security.removeItem("Relay Vault Key");
  f.deps.processList = async () => "  501     1 /Applications/Relay.app/Contents/MacOS/Relay\n";
  assert.equal(await f.run("reset-vault", "--yes"), 3);
  assert.match(f.err(), /Quit Relay\.app/);
  assert.ok(f.store().state.accounts[0].desktop);
});
