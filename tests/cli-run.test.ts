import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { childReady } from "./lock-child";
import { profileLockHolders } from "../electron/core/profile-lock";

async function setup(t: any, loggedIn = true) {
  const f = await cliFixture(t, { env: { ANTHROPIC_API_KEY: "sk-ant-api-should-not-pass", TERM: "screen-256color" } });
  const a = await f.saved("A");
  if (loggedIn)
    f.store().update((s) => {
      s.accounts[0].auth = { loggedIn: true, checkedAt: new Date().toISOString() };
    });
  const log = path.join(f.temp, "run.log");
  const script = path.join(f.temp, "fake-claude");
  const locks = path.join(f.home, "profiles", ".locks");
  fs.writeFileSync(
    script,
    `#!/bin/sh
echo "dir=$CLAUDE_CONFIG_DIR" >> "${log}"
echo "args=$*" >> "${log}"
echo "key=$ANTHROPIC_API_KEY" >> "${log}"
echo "term=$TERM colorterm=$COLORTERM" >> "${log}"
ls "${locks}/${a.id}" | wc -l | tr -d ' ' | sed 's/^/locks=/' >> "${log}"
exit 7
`,
    { mode: 0o755 },
  );
  f.deps.claude = () => script;
  return { f, a, log: () => fs.readFileSync(log, "utf8"), locks };
}

test("run starts Claude Code with the account's profile and passes its exit code through", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const { f, a, log, locks } = await setup(t);
  assert.equal(await f.run("run", "A", "--", "--resume", "x"), 7);
  const out = log();
  assert.match(out, new RegExp(`dir=${path.join(f.home, "profiles", a.id)}`));
  assert.match(out, /args=--resume x/);
  assert.match(out, /key=\n/);
  assert.match(out, /locks=1/);
  // The user's own terminal, not the app's xterm.js.
  assert.match(out, /term=screen-256color colorterm=\n/);
  assert.deepEqual(profileLockHolders(locks, a.id), []);
});

test("an exclusive holder exits 3 and a disconnected account exits 1", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const { f, a, locks } = await setup(t);
  const child = await childReady("profile-lock-child.ts", [locks, a.id, "exclusive"]);
  t.after(() => child.kill());
  assert.equal(await f.run("run", "A"), 3);
  const g = await setup(t, false);
  assert.equal(await g.f.run("run", "A"), 1);
  assert.match(g.f.err(), /relay connect/);
});

test("SIGTERM and SIGHUP reach the child while it runs; SIGINT is left to the terminal", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  f.store().update((s) => {
    s.accounts[0].auth = { loggedIn: true, checkedAt: new Date().toISOString() };
  });
  const script = path.join(f.temp, "sleepy");
  const ready = path.join(f.temp, "ready");
  fs.writeFileSync(script, `#!/bin/sh\ntrap 'exit 41' INT\ntrap 'exit 42' TERM\ntouch "${ready}"\nwhile true; do sleep 0.05; done\n`, { mode: 0o755 });
  f.deps.claude = () => script;
  const done = f.run("run", "A");
  const end = Date.now() + 5000;
  while (!(f.hasSignalHandler() && fs.existsSync(ready)) && Date.now() < end)
    await new Promise((r) => setTimeout(r, 10));
  f.signal("SIGINT");
  await new Promise((r) => setTimeout(r, 150));
  f.signal("SIGTERM");
  assert.equal(await done, 42);
});
