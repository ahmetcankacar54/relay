import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { jsonBytes, readObject, writeBytes } from "../electron/core/desktop-files";

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
  assert.match(f.out(), /Claude Desktop will quit and reopen signed in as A/);
  assert.match(f.out(), /Code sessions will stop/);
  assert.match(f.out(), /drafts/);
  assert.match(f.out(), /Code history/);
  const g = await cliFixture(t, { tty: true, answers: ["y"] });
  await g.saved("A");
  await g.saved("B");
  assert.equal(await g.run("switch", "A"), 0);
  assert.equal(g.state.quits, 1);
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
  assert.match(f.out(), /Nothing to recover/);
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

test("relay switch opens the target's browser profile, and says when it is gone", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const b = await f.saved("B");
  const brave = path.join(f.temp, "home", "Library", "Application Support", "BraveSoftware", "Brave-Browser");
  fs.mkdirSync(brave, { recursive: true });
  fs.writeFileSync(
    path.join(brave, "Local State"),
    JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Alto" } } } }),
  );
  f.store().setBrowser(a.id, { app: "brave", profile: "Profile 2", name: "Alto" });
  assert.equal(await f.run("switch", "A", "--yes"), 0);
  assert.deepEqual(f.opened, [["-n", "-b", "com.brave.Browser", "--args", "--profile-directory=Profile 2"]]);
  assert.match(f.out(), /Opened the browser profile Brave · Alto/);
  // B has none: nothing opens.
  assert.equal(await f.run("switch", "B", "--yes"), 0);
  assert.equal(f.opened.length, 1);
  // A removed profile is reported, and the switch still succeeds.
  f.store().setBrowser(b.id, { app: "brave", profile: "Profile 3", name: "Old" });
  assert.equal(await f.run("switch", "A", "--yes"), 0);
  assert.equal(await f.run("switch", "B", "--yes"), 0);
  assert.match(f.out(), /The browser no longer has this profile: Brave · Old/);
  assert.equal(f.opened.length, 2);
});
