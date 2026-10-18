import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";

test("doctor reports each check, with an old Claude Code CLI as a warning", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const claude = path.join(f.temp, "fake-claude");
  fs.writeFileSync(claude, `#!/bin/sh\necho "2.1.200 (Claude Code)"\n`, { mode: 0o755 });
  f.deps.claude = () => claude;
  assert.equal(await f.run("doctor", "--json"), 0);
  const checks = Object.fromEntries(JSON.parse(f.out()).map((c: any) => [c.check, c]));
  assert.equal(checks.vault.status, "ok");
  assert.equal(checks.key.status, "ok");
  assert.equal(checks["claude-cli"].status, "warn");
  assert.match(checks["claude-cli"].detail, /2\.1\.296/);
  assert.equal(checks.platform.status, "ok");
  assert.ok(checks.automation);
  f.clear();
  assert.equal(await f.run("doctor"), 0);
  assert.match(f.out(), /Automation/);
});

test("a locked key fails the check and exits 5", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  fs.writeFileSync(path.join(f.security.dir, "force-exit"), "51");
  assert.equal(await f.run("doctor", "--json"), 5);
  const key = JSON.parse(f.out()).find((c: any) => c.check === "key");
  assert.equal(key.status, "fail");
});
