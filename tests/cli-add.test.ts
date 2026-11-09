import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { jsonBytes, readObject, writeBytes } from "../electron/core/desktop-files";

const identity = async (claude: string) => (await readObject(claude, "config.json"))?.lastKnownAccountUuid;
const pendingFile = (home: string) => path.join(home, "desktop-vault", "pending.json");
async function until(check: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("add saves the unsaved account signed in to Claude Desktop", async (t) => {
  const f = await cliFixture(t);
  const signed = await f.accountInDesktop();
  assert.equal(await f.run("add", "Kişisel", "--yes"), 0);
  const [account] = f.store().state.accounts;
  assert.equal(account.name, "Kişisel");
  assert.equal(account.desktop?.accountUuid, signed.accountUuid);
  assert.equal(account.desktop?.orgId, signed.orgs[0]);
  assert.equal(f.state.quits, 1);
  assert.match(f.out(), /Saved Kişisel/);
  assert.ok(!(f.out() + f.err()).includes("FIXTURE-SECRET"));
});

test("add --work --group makes a work account in that group", async (t) => {
  const f = await cliFixture(t);
  await f.accountInDesktop();
  assert.equal(await f.run("add", "Work", "--work", "--group", "Vertex", "--yes"), 0);
  const [account] = f.store().state.accounts;
  assert.equal(account.kind, "work");
  assert.equal(account.group, "work:Vertex");
});

test("add --new signs a new account in and waits for it", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const done = f.run("add", "B", "--new", "--yes", "--poll-ms", "10");
  t.after(() => f.signal("SIGINT"));
  await until(() => fs.existsSync(pendingFile(f.home)));
  const signed = await f.accountInDesktop();
  assert.equal(await done, 0);
  const b = f.store().state.accounts.find((x) => x.name === "B")!;
  assert.equal(b.desktop?.accountUuid, signed.accountUuid);
  assert.equal(fs.existsSync(pendingFile(f.home)), false);
  assert.match(f.out(), /Sign in/);
  void a;
});

test("several workspaces: no terminal exits 2; --org or a numbered answer picks one", async (t) => {
  const f = await cliFixture(t);
  const signed = await f.accountInDesktop(2);
  assert.equal(await f.run("add", "W", "--yes"), 2);
  assert.equal(f.store().state.accounts.length, 0);
  assert.equal(await f.run("add", "W", "--yes", "--org", signed.orgs[1]), 0);
  assert.equal(f.store().state.accounts[0].desktop?.orgId, signed.orgs[1]);
  const g = await cliFixture(t, { tty: true, answers: ["2", "y"] });
  const other = await g.accountInDesktop(2);
  assert.equal(await g.run("add", "W"), 0);
  const second = /2\) ([0-9a-f-]{36})/.exec(g.out())![1];
  assert.ok((other.orgs as string[]).includes(second));
  assert.equal(g.store().state.accounts[0].desktop?.orgId, second);
});

test("Ctrl+C while waiting keeps the sign-in pending; --cancel restores the previous one", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const done = f.run("add", "C", "--new", "--yes", "--poll-ms", "20");
  t.after(() => f.signal("SIGINT"));
  // The wait listens for Ctrl+C from the line it prints; before it, the operation's own shield does.
  await until(() => f.out().includes("open the Code tab once; waiting"));
  f.signal("SIGINT");
  assert.equal(await done, 1);
  assert.ok(fs.existsSync(pendingFile(f.home)));
  assert.match(f.out() + f.err(), /relay add --resume/);
  assert.match(f.out() + f.err(), /relay add --cancel/);
  f.clear();
  assert.equal(await f.run("add", "--cancel", "--yes"), 0);
  assert.equal(fs.existsSync(pendingFile(f.home)), false);
  assert.equal(await identity(f.claude), a.desktop!.accountUuid);
  assert.deepEqual(f.store().state.accounts.map((x) => x.name), ["A"]);
});

test("--resume finishes a pending sign-in", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const first = f.run("add", "C", "--new", "--yes", "--poll-ms", "20");
  t.after(() => f.signal("SIGINT"));
  await until(() => f.out().includes("open the Code tab once; waiting"));
  f.signal("SIGINT");
  assert.equal(await first, 1);
  const signed = await f.accountInDesktop();
  assert.equal(await f.run("add", "--resume", "--yes", "--poll-ms", "10"), 0);
  assert.equal(f.store().state.accounts.find((x) => x.name === "C")?.desktop?.accountUuid, signed.accountUuid);
});

test("a duplicate name exits 2, and an unlinked account of that name is linked instead", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  assert.equal(await f.run("add", "a", "--new", "--yes"), 2);
  const store = f.store();
  const bare = store.create({ name: "Bare", kind: "personal" });
  const signed = await f.accountInDesktop();
  assert.equal(await f.run("add", "bare", "--yes"), 0);
  const linked = f.store().account(bare.id);
  assert.equal(linked.desktop?.accountUuid, signed.accountUuid);
  assert.equal(f.store().state.accounts.length, 2);
});

test("add --new stops waiting when the sign-in is finished or cancelled elsewhere", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const done = f.run("add", "C", "--new", "--yes", "--poll-ms", "10");
  t.after(() => f.signal("SIGINT"));
  await until(() => fs.existsSync(pendingFile(f.home)));
  fs.rmSync(pendingFile(f.home));
  assert.equal(await done, 1);
  assert.match(f.out() + f.err(), /no longer pending/);
});

test("a worker gives up waiting for a sign-in after its time limit", async (t) => {
  const f = await cliFixture(t, { env: { RELAY_WORKER: "1", RELAY_SIGNIN_LIMIT_MS: "60" } });
  await f.saved("A");
  assert.equal(await f.run("add", "C", "--new", "--yes", "--poll-ms", "10"), 1);
  assert.match(f.out() + f.err(), /relay add --resume/);
  assert.ok(fs.existsSync(pendingFile(f.home)));
});

test("signing back in with an account that is already saved says so while waiting", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const done = f.run("add", "C", "--new", "--yes", "--poll-ms", "10");
  t.after(() => f.signal("SIGINT"));
  await until(() => f.out().includes("open the Code tab once; waiting"));
  await writeBytes(f.claude, "config.json", jsonBytes({ "oauth:tokenCacheV2": "FIXTURE-SECRET-again", lastKnownAccountUuid: a.desktop!.accountUuid }));
  await until(() => f.out().includes("already saved"));
  assert.match(f.out(), /signed in as A, which is already saved/);
  f.signal("SIGINT");
  assert.equal(await done, 1);
});

test("add refuses a provider other than Claude before touching Claude or the account list", async (t) => {
  const f = await cliFixture(t);
  for (const provider of ["codex", "antigravity", "antigravty", "gemini"]) {
    assert.equal(await f.run("add", "X", "--provider", provider, "--yes"), 2, provider);
    assert.match(f.err(), /only adds Claude accounts|yalnızca Claude/);
    f.clear();
  }
  assert.equal(f.store().state.accounts.length, 0);
});
