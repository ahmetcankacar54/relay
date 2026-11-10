import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  TerminalError,
  TerminalSwitcher,
  TerminalVault,
  adoptTerminalSignIn,
  scratchSignInPorts,
  jsonConfig,
  peekTerminal,
  SECURITY_STDIN_LIMIT,
  securityKeychain,
  type TerminalPorts,
} from "../electron/core/terminal-identity";
import {
  LockBusyError,
  takeLockDir,
  withCliRefreshLock,
} from "../electron/core/cli-refresh-lock";
import { createSealer } from "../electron/core/vault-crypto";
import { terminalIdentities, terminalLine } from "../shared/terminal-identity";

const oauth = (n: number) => ({
  accessToken: `sk-ant-oat01-access-${n}`,
  refreshToken: `sk-ant-ort01-refresh-${n}`,
  expiresAt: 1_900_000_000_000 + n,
  scopes: ["user:inference", "user:profile"],
  subscriptionType: "team",
});
const person = (accountUuid: string, orgId: string, email: string) => ({
  accountUuid,
  organizationUuid: orgId,
  emailAddress: email,
  organizationName: `Org of ${email}`,
});

/** Claude Code's sign-in in memory: the Keychain item's text and `~/.claude.json`. */
function world(
  t: any,
  options: { failWrite?: boolean; failConfig?: boolean } = {},
) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-terminal-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const state: {
    item?: string;
    config: Record<string, any>;
    writes: number;
    /** Who Anthropic says each access token is; missing means it cannot be asked. */
    owners: Map<string, { accountUuid: string; orgId: string }>;
  } = {
    config: { theme: "dark", projects: { "/x": {} } },
    writes: 0,
    owners: new Map(),
  };
  const ports: TerminalPorts = {
    keychain: {
      read: async () => state.item,
      write: async (text) => {
        state.writes++;
        if (!options.failWrite || state.writes > 1) state.item = text;
      },
      remove: async () => {
        state.item = undefined;
      },
    },
    config: {
      read: async () => structuredClone(state.config),
      writeAccount: async (account) => {
        if (options.failConfig) throw new TerminalError("busy");
        if (account === undefined) delete state.config.oauthAccount;
        else state.config.oauthAccount = account;
      },
    },
    lock: (action) => action(),
    owner: async (token) => state.owners.get(token),
  };
  const sealer = createSealer(Buffer.alloc(32, 9));
  const vault = new TerminalVault(
    path.join(temp, "vault"),
    (text) => sealer.seal(text),
    (data) => sealer.unseal(data),
  );
  const a = { accountUuid: randomUUID(), orgId: randomUUID() };
  const b = { accountUuid: randomUUID(), orgId: randomUUID() };
  const signIn = (id: typeof a, n: number, email: string) => {
    state.item = JSON.stringify({
      claudeAiOauth: oauth(n),
      mcpOAuth: { server: { token: "mcp" } },
    });
    state.config.oauthAccount = person(id.accountUuid, id.orgId, email);
    state.owners.set(oauth(n).accessToken, id);
  };
  return {
    temp,
    state,
    ports,
    vault,
    a,
    b,
    signIn,
    switcher: new TerminalSwitcher(ports, vault),
  };
}

test("a switch saves the terminal's sign-in for its account and puts the target's in place", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.saved, true);
  const item = JSON.parse(w.state.item!);
  assert.deepEqual(item.claudeAiOauth, oauth(2));
  // MCP servers' sign-ins in the same item stay.
  assert.deepEqual(item.mcpOAuth, { server: { token: "mcp" } });
  assert.equal(w.state.config.oauthAccount.emailAddress, "b@x");
  assert.equal(w.state.config.theme, "dark");
  assert.deepEqual((await w.vault.load([w.a]))?.oauth, oauth(1));
  assert.equal(outcome.current?.accountUuid, w.b.accountUuid);
  // And back: B's sign-in, as Claude Code renewed it meanwhile, is saved on the way out.
  w.state.item = JSON.stringify({ ...item, claudeAiOauth: oauth(3) });
  const back = await w.switcher.run({
    mode: "follow",
    target: [w.a],
    known: [w.a, w.b],
  });
  assert.equal(back.result, "switched");
  assert.deepEqual(JSON.parse(w.state.item!).claudeAiOauth, oauth(1));
  assert.deepEqual((await w.vault.load([w.b]))?.oauth, oauth(3));
});

test("a sign-in Relay cannot name is never overwritten", async (t) => {
  const w = world(t);
  const stranger = { accountUuid: randomUUID(), orgId: randomUUID() };
  w.signIn(stranger, 1, "other@x");
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const before = w.state.item;
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(outcome.result, "skipped");
  assert.equal(outcome.reason, "unknown-account");
  assert.equal(outcome.current?.email, "other@x");
  assert.equal(outcome.current?.known, false);
  assert.equal(w.state.item, before);
  // The same person in another organization is another account.
  w.signIn({ accountUuid: w.a.accountUuid, orgId: randomUUID() }, 1, "a@x");
  const again = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(again.reason, "unknown-account");
});

test("a target with nothing saved leaves the terminal as it is, its sign-in saved", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  const before = w.state.item;
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(outcome.result, "saved");
  assert.equal(outcome.reason, "no-saved-login");
  assert.equal(w.state.item, before);
  assert.deepEqual((await w.vault.load([w.a]))?.oauth, oauth(1));
  // Saved already and unchanged: nothing new to say.
  const again = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(again.result, "unchanged");
});

test("a signed-out terminal gets the target's sign-in", async (t) => {
  const w = world(t);
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(outcome.result, "switched");
  assert.deepEqual(JSON.parse(w.state.item!), { claudeAiOauth: oauth(2) });
});

test("the terminal already on the target is left alone", async (t) => {
  const w = world(t);
  w.signIn(w.b, 4, "b@x");
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(outcome.reason, "already-there");
  assert.deepEqual(JSON.parse(w.state.item!).claudeAiOauth, oauth(4));
  // The live copy replaced the older saved one.
  assert.deepEqual((await w.vault.load([w.b]))?.oauth, oauth(4));
});

test("a write that does not read back puts the previous sign-in back", async (t) => {
  const w = world(t, { failWrite: true });
  w.signIn(w.a, 1, "a@x");
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const before = w.state.item;
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(outcome.result, "failed");
  assert.equal(outcome.reason, "write-failed");
  assert.equal(w.state.item, before);
  assert.equal(w.state.config.oauthAccount.emailAddress, "a@x");
});

test("mode off and a busy lock change nothing", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const before = w.state.item;
  assert.equal(
    (await w.switcher.run({ mode: "off", target: [w.b], known: [w.a, w.b] }))
      .reason,
    "off",
  );
  const busy = new TerminalSwitcher(
    {
      ...w.ports,
      lock: async () => {
        throw new TerminalError("busy");
      },
    },
    w.vault,
  );
  const outcome = await busy.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.deepEqual([outcome.result, outcome.reason], ["skipped", "busy"]);
  assert.equal(w.state.item, before);
  assert.equal(
    await w.switcher.check({ mode: "off", known: [w.a] }),
    undefined,
  );
});

test("a check links a known sign-in and only reads an unknown one", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  const current = await w.switcher.check({ mode: "follow", known: [w.a, w.b] });
  assert.equal(current?.state, "signed-in");
  assert.equal(current?.known, true);
  assert.deepEqual((await w.vault.load([w.a]))?.oauth, oauth(1));
  assert.deepEqual(
    (await w.vault.list()).map((x) => [x.accountUuid, x.orgId]),
    [[w.a.accountUuid, w.a.orgId]],
  );
  w.signIn(w.b, 2, "b@x");
  await w.switcher.check({ mode: "follow", known: [w.a] });
  assert.equal(await w.vault.load([w.b]), undefined);
  // peek reads only.
  const peeked = await peekTerminal(w.ports, [w.a, w.b]);
  assert.equal(peeked.accountUuid, w.b.accountUuid);
  assert.equal(await w.vault.load([w.b]), undefined);
  w.state.item = "not json";
  assert.equal(
    (await w.switcher.check({ mode: "follow", known: [w.a] }))?.state,
    "unreadable",
  );
});

test("an account's identities are its Desktop one and its own, lowercase and once", () => {
  const a = randomUUID();
  const o = randomUUID();
  assert.deepEqual(
    terminalIdentities({
      desktop: { accountUuid: a.toUpperCase(), orgId: o },
      auth: { accountUuid: a, orgId: o.toUpperCase() },
    }),
    [{ accountUuid: a, orgId: o }],
  );
  assert.deepEqual(terminalIdentities({ auth: { accountUuid: a } }), []);
});

test("the outcome lines name the account and what to do", () => {
  const t = (_tr: string, en: string) => en;
  const at = new Date().toISOString();
  assert.match(
    terminalLine({ result: "switched", saved: true, at }, t, "Work")!,
    /moved to Work/,
  );
  assert.match(
    terminalLine(
      { result: "unchanged", reason: "no-saved-login", saved: false, at },
      t,
      "Work",
    )!,
    /claude auth login/,
  );
  assert.equal(
    terminalLine({ result: "skipped", reason: "off", saved: false, at }, t),
    undefined,
  );
});

test("the Keychain item is read through security, hex decoded, and written with the secret on stdin only", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-terminal-security-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = path.join(dir, "security");
  fs.writeFileSync(
    tool,
    `#!/bin/sh
dir="$(dirname "$0")"
echo "$*" >> "$dir/argv.log"
if [ "$1" = "-i" ]; then cat > "$dir/stdin.log"; exit 0; fi
if [ "$1" = "find-generic-password" ]; then [ -f "$dir/item" ] || exit 44; cat "$dir/item"; exit 0; fi
if [ "$1" = "delete-generic-password" ]; then rm -f "$dir/item"; exit 0; fi
exit 9
`,
    { mode: 0o755 },
  );
  const keychain = securityKeychain("someone", tool, "Test-credentials");
  assert.equal(await keychain.read(), undefined);
  const text = JSON.stringify({ claudeAiOauth: oauth(1) });
  fs.writeFileSync(
    path.join(dir, "item"),
    Buffer.from(text).toString("hex") + "\n",
  );
  assert.equal(await keychain.read(), text);
  await keychain.write(text);
  const argv = fs.readFileSync(path.join(dir, "argv.log"), "utf8");
  assert.doesNotMatch(argv, /access-1|7b22/);
  const stdin = fs.readFileSync(path.join(dir, "stdin.log"), "utf8");
  assert.match(
    stdin,
    new RegExp(
      `^add-generic-password -U -a "someone" -s "Test-credentials" -X "${Buffer.from(text).toString("hex")}"\\nquit\\n$`,
    ),
  );
  await keychain.remove();
  assert.equal(await keychain.read(), undefined);
  // A name it cannot quote stops only the terminal step, at use.
  await assert.rejects(
    securityKeychain('bad"user', tool).read(),
    TerminalError,
  );
});

test("an item too long for one interactive line is written through the arguments, whole", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-terminal-security-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = path.join(dir, "security");
  // Like the real one: an interactive line is cut at 4 KB; the arguments are taken whole.
  fs.writeFileSync(
    tool,
    `#!/bin/sh
dir="$(dirname "$0")"
if [ "$1" = "-i" ]; then head -c 4095 | sed -n 's/.*-X "\\([0-9a-f]*\\).*/\\1/p' | head -1 > "$dir/item"; echo stdin >> "$dir/how.log"; exit 0; fi
if [ "$1" = "add-generic-password" ]; then shift; while [ "$1" != "-X" ]; do shift; done; echo "$2" > "$dir/item"; echo argv >> "$dir/how.log"; exit 0; fi
if [ "$1" = "find-generic-password" ]; then [ -f "$dir/item" ] || exit 44; cat "$dir/item"; exit 0; fi
exit 9
`,
    { mode: 0o755 },
  );
  const keychain = securityKeychain("someone", tool, "Test-credentials");
  // Several MCP servers' sign-ins make the item many kilobytes long.
  const mcpOAuth = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `plugin:server-${i}|0123456789abcdef`,
      { accessToken: `access-${i}-${"a".repeat(300)}`, refreshToken: `refresh-${i}-${"r".repeat(300)}` },
    ]),
  );
  const large = JSON.stringify({ claudeAiOauth: oauth(1), mcpOAuth });
  assert.ok(Buffer.byteLength(large) * 2 > SECURITY_STDIN_LIMIT);
  await keychain.write(large);
  assert.equal(await keychain.read(), large, "nothing is cut");
  const small = JSON.stringify({ claudeAiOauth: oauth(2) });
  await keychain.write(small);
  assert.equal(await keychain.read(), small);
  assert.deepEqual(fs.readFileSync(path.join(dir, "how.log"), "utf8").trim().split("\n"), ["argv", "stdin"]);
  // A refused write through the arguments says so.
  fs.writeFileSync(tool, "#!/bin/sh\nexit 51\n", { mode: 0o755 });
  await assert.rejects(keychain.write(large), TerminalError);
});

test("the config keeps every other key and its mode when the account changes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-terminal-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".claude.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ theme: "dark", oauthAccount: { accountUuid: "old" } }),
    {
      mode: 0o600,
    },
  );
  const config = jsonConfig(file);
  await config.writeAccount({ accountUuid: "new" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    theme: "dark",
    oauthAccount: { accountUuid: "new" },
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await config.writeAccount(undefined);
  assert.deepEqual(await config.read(), { theme: "dark" });
  assert.deepEqual(fs.readdirSync(dir), [".claude.json"]);
  assert.equal(await jsonConfig(path.join(dir, "none.json")).read(), undefined);
});

test("Claude Code's refresh locks are held during the action, waited for, and taken over when stale", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-terminal-lock-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir);
  const lock = path.join(dir, ".oauth_refresh.lock");
  const legacy = `${fs.realpathSync(dir)}.lock`;
  const seen = await withCliRefreshLock(dir, async () => [
    fs.existsSync(lock),
    fs.existsSync(legacy),
  ]);
  assert.deepEqual(seen, [true, true]);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(legacy), false);
  // A CLI holds it: waited for, then given up.
  fs.mkdirSync(lock);
  await assert.rejects(
    withCliRefreshLock(dir, async () => "ran", { waitMs: 300 }),
    (error: unknown) => error instanceof LockBusyError,
  );
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(legacy), false);
  // Released meanwhile: taken.
  setTimeout(() => fs.rmdirSync(lock), 100);
  assert.equal(
    await withCliRefreshLock(dir, async () => "ran", { waitMs: 2_000 }),
    "ran",
  );
  // Left by a CLI that died: stale after a minute, taken over.
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  assert.equal(
    await withCliRefreshLock(dir, async () => "ran", { waitMs: 0 }),
    "ran",
  );
  assert.equal(fs.existsSync(lock), false);
});

test("only the stale lock that was judged is taken over, never a fresh one made meanwhile", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-terminal-takeover-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "x.lock");
  fs.mkdirSync(file);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(file, old, old);
  // Another process takes it over between this one's look and its removal: the clock this one
  // reads moves on by a minute each time, so the fresh lock looks stale on the first look only.
  let reads = 0;
  const now = () => {
    reads++;
    if (reads === 2) {
      fs.rmdirSync(file);
      fs.mkdirSync(file);
    }
    return Date.now();
  };
  await assert.rejects(takeLockDir(file, { waitMs: 0, now }), LockBusyError);
  assert.equal(fs.existsSync(file), true);
  const lock = await takeLockDir(path.join(dir, "y.lock"));
  lock.release();
  assert.equal(fs.existsSync(path.join(dir, "y.lock")), false);
});

test("a token Anthropic says is another account's is neither saved nor replaced", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  // ~/.claude.json names A, but the token is B's (a sign-in by hand caught half written).
  w.state.owners.set(oauth(1).accessToken, w.b);
  const current = await w.switcher.check({ mode: "follow", known: [w.a, w.b] });
  assert.equal(current?.mismatch, true);
  assert.equal(current?.known, false);
  assert.equal(await w.vault.load([w.a]), undefined);
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const before = w.state.item;
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.deepEqual([outcome.result, outcome.reason], ["skipped", "mismatch"]);
  assert.equal(w.state.item, before);
  assert.equal(await w.vault.load([w.a]), undefined);
});

test("a token that cannot be asked about is saved by a switch only, never by a check", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  w.state.owners.clear();
  await w.switcher.check({ mode: "follow", known: [w.a, w.b] });
  assert.equal(await w.vault.load([w.a]), undefined);
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(outcome.result, "switched");
  const parked = await w.vault.load([w.a]);
  assert.deepEqual(parked?.oauth, oauth(1));
  assert.equal(parked?.parked, true);
});

test("a token that cannot be asked about never replaces the only copy taken away at a switch", async (t) => {
  const w = world(t);
  await w.vault.save(w.a, oauth(1), person(w.a.accountUuid, w.a.orgId, "a@x"), true);
  await w.vault.save(w.b, oauth(2), person(w.b.accountUuid, w.b.orgId, "b@x"), true);
  // A write stopped between the Keychain and the config: B's token, the config naming A.
  w.signIn(w.a, 3, "a@x");
  w.state.item = JSON.stringify({ claudeAiOauth: oauth(2) });
  w.state.owners.clear();
  await w.switcher.run({ mode: "follow", target: [w.b], known: [w.a, w.b] });
  assert.deepEqual((await w.vault.load([w.a]))?.oauth, oauth(1));
});

test("a copy saved while in use is put back flagged; one taken away at a switch is not", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  await w.switcher.check({ mode: "follow", known: [w.a, w.b] });
  assert.equal((await w.vault.load([w.a]))?.parked, false);
  // The user signs the terminal in to B by hand; Relay never took A away.
  w.signIn(w.b, 2, "b@x");
  const toA = await w.switcher.run({
    mode: "follow",
    target: [w.a],
    known: [w.a, w.b],
  });
  assert.equal(toA.result, "switched");
  assert.equal(toA.unconfirmed, true);
  assert.match(
    terminalLine(toA, (_tr, en) => en, "A")!,
    /claude auth login/,
  );
  // B was taken away at that switch: still good, and listed so.
  assert.deepEqual(
    (await w.vault.list())
      .map((x) => [x.accountUuid === w.b.accountUuid ? "b" : "a", x.parked])
      .sort(),
    [
      ["a", false],
      ["b", true],
    ],
  );
  const toB = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.equal(toB.result, "switched");
  assert.equal(toB.unconfirmed, undefined);
  // A copy now in use again no longer counts as the only one.
  assert.equal((await w.vault.load([w.b]))?.parked, false);
  assert.equal((await w.vault.load([w.a]))?.parked, true);
});

test("a check waits on Claude Code's lock, only looks while it is busy, and reads on when the vault fails", async (t) => {
  const w = world(t);
  w.signIn(w.a, 1, "a@x");
  let locked = 0;
  const counting = new TerminalSwitcher(
    {
      ...w.ports,
      lock: async (action) => {
        locked++;
        return action();
      },
    },
    w.vault,
  );
  await counting.check({ mode: "follow", known: [w.a] });
  assert.equal(locked, 1);
  w.signIn(w.a, 5, "a@x");
  const busy = new TerminalSwitcher(
    {
      ...w.ports,
      lock: async () => {
        throw new TerminalError("busy");
      },
    },
    w.vault,
  );
  const seen = await busy.check({ mode: "follow", known: [w.a] });
  assert.equal(seen?.state, "signed-in");
  assert.equal(seen?.known, true);
  assert.deepEqual((await w.vault.load([w.a]))?.oauth, oauth(1));
  const broken = new TerminalSwitcher(
    w.ports,
    new TerminalVault(
      path.join(w.temp, "vault"),
      () => {
        throw new Error("no key yet");
      },
      () => {
        throw new Error("no key yet");
      },
    ),
  );
  const read = await broken.check({ mode: "follow", known: [w.a] });
  assert.equal(read?.state, "signed-in");
  assert.equal(read?.known, true);
});

test("a config write that fails leaves both the Keychain item and the config as they were", async (t) => {
  const w = world(t, { failConfig: true });
  w.signIn(w.a, 1, "a@x");
  await w.vault.save(
    w.b,
    oauth(2),
    person(w.b.accountUuid, w.b.orgId, "b@x"),
    true,
  );
  const before = w.state.item;
  const outcome = await w.switcher.run({
    mode: "follow",
    target: [w.b],
    known: [w.a, w.b],
  });
  assert.deepEqual(
    [outcome.result, outcome.reason],
    ["failed", "write-failed"],
  );
  assert.equal(w.state.item, before);
  assert.equal(w.state.config.oauthAccount.emailAddress, "a@x");
});

test("a step that cannot run here, or fails for no named reason, says so", () => {
  const t = (_tr: string, en: string) => en;
  const at = new Date().toISOString();
  assert.match(
    terminalLine(
      { result: "failed", reason: "unsupported", saved: false, at },
      t,
    )!,
    /cannot manage the terminal sign-in/,
  );
  assert.match(
    terminalLine({ result: "failed", saved: false, at }, t)!,
    /cannot change the terminal sign-in/,
  );
  assert.match(
    terminalLine({ result: "switched", saved: true, at }, t, "W")!,
    /Restart open terminal sessions/,
  );
});

test("a sign-in made for the terminal in a scratch folder is kept for its account only, as the one good copy", async (t) => {
  const w = world(t);
  // Nothing signed in there: nothing kept.
  assert.equal(await adoptTerminalSignIn(w.ports, [w.a], w.vault), "signed-out");
  // Approved with another account, or in another workspace of the same account.
  w.signIn(w.b, 2, "b@x");
  assert.equal(await adoptTerminalSignIn(w.ports, [w.a], w.vault), "other-account");
  w.signIn({ accountUuid: w.a.accountUuid, orgId: w.b.orgId }, 3, "a@x");
  assert.equal(await adoptTerminalSignIn(w.ports, [w.a], w.vault), "other-account");
  // The file names the account, the token is someone else's.
  w.signIn(w.a, 4, "a@x");
  w.state.owners.set(oauth(4).accessToken, w.b);
  assert.equal(await adoptTerminalSignIn(w.ports, [w.a], w.vault), "other-account");
  assert.equal(await w.vault.load([w.a]), undefined);
  // The account's own: saved as taken away, so the next switch puts it in the terminal.
  w.signIn(w.a, 5, "a@x");
  assert.equal(await adoptTerminalSignIn(w.ports, [w.a], w.vault), "saved");
  const saved = await w.vault.load([w.a]);
  assert.equal(saved?.parked, true);
  assert.equal(saved?.oauth.accessToken, oauth(5).accessToken);
  // The terminal, on B, follows to A with that sign-in, and its MCP sign-ins stay.
  w.signIn(w.b, 6, "b@x");
  const outcome = await w.switcher.run({ mode: "follow", target: [w.a], known: [w.a, w.b] });
  assert.equal(outcome.result, "switched");
  assert.equal(outcome.unconfirmed, undefined);
  assert.equal(JSON.parse(w.state.item!).claudeAiOauth.accessToken, oauth(5).accessToken);
  assert.equal(JSON.parse(w.state.item!).mcpOAuth.server.token, "mcp");
  assert.equal(w.state.config.oauthAccount.accountUuid, w.a.accountUuid);
});

test("a scratch folder's sign-in is read from its own files, never from the terminal's", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-terminal-link-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = { accountUuid: randomUUID(), orgId: randomUUID() };
  // Off macOS there is no Keychain item: the CLI's private file is the sign-in.
  const ports = scratchSignInPorts(dir, "linux");
  assert.equal(await ports.keychain.read(), undefined);
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth(7) }));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: person(id.accountUuid, id.orgId, "a@x") }));
  assert.equal(JSON.parse((await ports.keychain.read())!).claudeAiOauth.accessToken, oauth(7).accessToken);
  assert.equal((await ports.config.read())?.oauthAccount.accountUuid, id.accountUuid);
  await assert.rejects(ports.keychain.write("{}"));
  await ports.keychain.remove();
  assert.equal(await ports.keychain.read(), undefined);
});
