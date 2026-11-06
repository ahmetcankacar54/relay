import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { jsonBytes, readObject, writeBytes } from "../electron/core/desktop-files";
import { signInFor } from "./extension-world";

const identity = async (claude: string) => (await readObject(claude, "config.json"))?.lastKnownAccountUuid;

test("switch --yes quits Claude once, swaps the sign-in and reopens it", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("switch", "a", "--yes"), 0);
  assert.equal(f.state.quits, 1);
  assert.equal(f.state.starts, 1);
  assert.equal(await identity(f.claude), a.desktop!.accountUuid);
  assert.match(f.out(), /Switched to A/);
  assert.ok(!(f.out() + f.err()).includes("FIXTURE-SECRET"));
});

test("without a terminal and without --yes it exits 4 and quits nothing", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("switch", "A"), 4);
  assert.equal(f.state.quits, 0);
  assert.match(f.err(), /--yes/);
});

test("in a terminal the prompt says what happens; declining quits nothing", async (t) => {
  const f = await cliFixture(t, { tty: true, answers: ["n"] });
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("switch", "A"), 1);
  assert.equal(f.state.quits, 0);
  assert.match(f.out(), /The Claude app will quit and reopen signed in as A/);
  assert.match(f.out(), /Code sessions will stop/);
  assert.match(f.out(), /drafts/);
  assert.match(f.out(), /Code history/);
  const g = await cliFixture(t, { tty: true, answers: ["y"] });
  await g.saved("A");
  await g.saved("B");
  assert.equal(await g.run("switch", "A"), 0);
  assert.equal(g.state.quits, 1);
});

test("the prompt and the result say that the terminal's claude follows the account", async (t) => {
  const f = await cliFixture(t, { tty: true, answers: ["n"] });
  await f.saved("A");
  await f.saved("B");
  // A signed-out terminal in memory: nothing real is read or written.
  f.deps.terminal = {
    keychain: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    config: { read: async () => ({}), writeAccount: async () => {} },
    lock: (action) => action(),
  };
  assert.equal(await f.run("switch", "A"), 1);
  assert.match(f.out(), /terminal claude’s sign-in \(Keychain and ~\/\.claude\.json\) will move to A too/);
  const g = await cliFixture(t, { tty: true, answers: ["y"] });
  await g.saved("A");
  await g.saved("B");
  g.deps.terminal = f.deps.terminal;
  assert.equal(await g.run("switch", "A"), 0);
  assert.match(g.out(), /terminal/i);
  // With the terminal left alone, the prompt does not mention it.
  const h = await cliFixture(t, { tty: true, answers: ["n"] });
  await h.saved("A");
  await h.saved("B");
  assert.equal(await h.run("switch", "A"), 1);
  assert.doesNotMatch(h.out(), /terminal claude/);
});

test("switching to the active account changes nothing", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  assert.equal(await f.run("switch", "A", "--yes"), 0);
  assert.equal(f.state.quits, 0);
  assert.match(f.out(), /already/);
});

test("a pending sign-in or an interrupted switch exits 3 before anything", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  await f.saved("B");
  const vault = path.join(f.home, "desktop-vault");
  await writeBytes(vault, "pending.json", jsonBytes({ profileId: a.id, startedAt: new Date().toISOString() }));
  assert.equal(await f.run("switch", "A", "--yes"), 3);
  assert.match(f.err(), /relay add --resume/);
  await writeBytes(vault, "pending.json", null);
  await writeBytes(vault, "journal.json", jsonBytes({ backup: "11111111-2222-4333-8444-555555555555" }));
  f.clear();
  assert.equal(await f.run("switch", "A", "--yes"), 3);
  assert.match(f.err(), /relay recover/);
  assert.equal(f.state.quits, 0);
});

test("Claude opened during the switch leaves the journal and points to relay recover, which restores it", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const b = await f.saved("B");
  let calls = -1;
  f.state.onQuit = () => {
    calls = 0;
  };
  f.state.onWrite = () => {
    if (calls >= 0 && ++calls >= 2) f.state.running = true;
  };
  assert.equal(await f.run("switch", "A", "--yes"), 1);
  assert.match(f.err(), /relay recover/);
  assert.ok(fs.existsSync(path.join(f.home, "desktop-vault", "journal.json")));
  f.state.onWrite = undefined;
  f.state.onQuit = undefined;
  f.clear();
  assert.equal(await f.run("recover", "--yes"), 0);
  assert.equal(fs.existsSync(path.join(f.home, "desktop-vault", "journal.json")), false);
  assert.equal(await identity(f.claude), b.desktop!.accountUuid);
  void a;
  f.clear();
  assert.equal(await f.run("recover", "--yes"), 0);
  assert.match(f.out(), /No backup to restore/);
});

test("without a desktop session it exits 5 before quitting", async (t) => {
  const f = await cliFixture(t, { gui: false });
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("switch", "A", "--yes"), 5);
  assert.equal(f.state.quits, 0);
});

test("signals during the switch do not stop it; one wait line is printed", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  await f.saved("B");
  f.state.onQuit = () => {
    f.signal("SIGINT");
    f.signal("SIGHUP");
  };
  assert.equal(await f.run("switch", "A", "--yes"), 0);
  assert.equal(await identity(f.claude), a.desktop!.accountUuid);
  assert.equal(f.err().split("\n").filter((l) => /wait/.test(l)).length, 1);
  assert.equal(f.hasSignalHandler(), false);
});

test("a refused Automation permission explains where to grant it", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  await f.saved("B");
  f.state.failQuit = new Error(
    "Command failed: /usr/bin/osascript -e tell application id \"com.anthropic.claudefordesktop\" to quit\n0:62: execution error: Not authorized to send Apple events to Claude. (-1743)",
  );
  assert.equal(await f.run("switch", "A", "--yes"), 5);
  assert.match(f.err(), /Automation/);
});

test("an unknown account name is a usage error", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  assert.equal(await f.run("switch", "Zed", "--yes"), 2);
  assert.equal(await f.run("switch", "--yes"), 2);
});

test("relay switch leaves the Claude extension and its browser alone, and says where to sync it", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const b = await f.saved("B");
  const dir = f.extension.install("brave");
  f.extension.stored.set(dir, signInFor(b.desktop!.accountUuid, 2));
  f.extension.state.running = true;
  assert.equal(await f.run("switch", "A", "--yes"), 0);
  // Nothing quit, nothing opened, nothing read or written.
  assert.deepEqual(f.extension.events, []);
  assert.deepEqual(f.extension.opened, []);
  assert.deepEqual(f.extension.stored.get(dir), signInFor(b.desktop!.accountUuid, 2));
  assert.match(f.out(), /Switched to A/);
  assert.match(f.out(), /This tool cannot change the Claude extension sign-in\. In Relay\.app, use Settings → Switching/);
  assert.ok(!(f.out() + f.err()).includes("SECRET"));
  assert.equal(a.desktop!.accountUuid.length, 36);
});

test("relay switch says nothing about the extension when none is installed", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  await f.saved("B");
  assert.equal(await f.run("switch", "A", "--yes"), 0);
  assert.doesNotMatch(f.out(), /extension/i);
});

test("the prompt never announces a browser quit, since the CLI never quits one", async (t) => {
  const f = await cliFixture(t, { tty: true, answers: ["n"] });
  await f.saved("A");
  await f.saved("B");
  f.extension.install("brave");
  f.extension.state.running = true;
  assert.equal(await f.run("switch", "A"), 1);
  assert.doesNotMatch(f.out(), /Brave/);
  assert.deepEqual(f.extension.events, []);
});

