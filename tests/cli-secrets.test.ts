import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { credentialService } from "../electron/core/usage-credentials";
import { writeBytes } from "../electron/core/desktop-files";

const TOKEN = "sk-ant-oat01-SCANTOKENSCANTOKENSCANTOKENSCANTOKEN0000";

test("no command prints a token, a cookie or a fixture secret, on success or failure", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const b = await f.saved("B");
  const transcript: string[] = [];
  const run = async (...argv: string[]) => {
    f.clear();
    await f.run(...argv);
    transcript.push(`$ relay ${argv.join(" ")}\n${f.out()}\n${f.err()}`);
  };
  for (const argv of [["list"], ["list", "--json"], ["status"], ["status", "--json"], ["history"], ["history", "--json"], ["tokens"], ["doctor"], ["doctor", "--json"], ["usage"], ["usage", "--json"]])
    await run(...argv);
  await run("switch", "A", "--yes");
  await run("switch", "B", "--yes");
  f.state.failQuit = new Error(`osascript failed ${TOKEN}`);
  await run("switch", "A", "--yes");
  f.state.failQuit = undefined;
  // Connected limits read the CLI's credential.
  f.store().update((s) => {
    for (const account of s.accounts)
      account.auth = {
        loggedIn: true,
        accountUuid: account.desktop!.accountUuid,
        orgId: account.desktop!.orgId,
        email: `${account.name}@example.test`,
        checkedAt: new Date().toISOString(),
      };
  });
  f.security.setItem(
    credentialService(path.join(f.home, "profiles", a.id)),
    JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000, scopes: ["user:profile"] } }),
  );
  f.deps.request = async (endpoint: string) => {
    if (endpoint === "profile") throw new Error(`HTTP 500 for ${TOKEN}`);
    return {};
  };
  await run("usage");
  await run("usage", "--json");
  // A malformed Claude config would put its first bytes into a JSON parse error.
  await writeBytes(f.claude, "config.json", Buffer.from("FIXTURE-SECRET-broken-config {"));
  await run("switch", "A", "--yes");
  await run("status");
  await run("remove", "A", "--yes");
  await run("add", "C", "--yes");
  const all = transcript.join("\n");
  // V8 quotes only the first bytes of a bad JSON file, so look for any part of the marker.
  assert.ok(!all.includes("FIXTURE"), all);
  assert.ok(!all.includes(TOKEN), all);
  assert.ok(!all.includes("sk-ant-"), all);
  for (const name of fs.existsSync(path.join(f.home, "cli-operations")) ? fs.readdirSync(path.join(f.home, "cli-operations")) : [])
    assert.ok(!fs.readFileSync(path.join(f.home, "cli-operations", name), "utf8").includes("FIXTURE-SECRET"));
  void b;
});
