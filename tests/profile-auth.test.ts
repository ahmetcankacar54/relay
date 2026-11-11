import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProfileAuth } from "../electron/core/profile-auth";
import { diagnoseCli } from "../electron/core/cli-diagnostics";

function script(t: any, body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-profile-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "claude");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile);
  return { file, profile, dir };
}
const ACCOUNT = "0b7b2d6e-3c1f-4f8e-9a51-2a8d1c4b5e6f";
const ORG = "1c8c3e7f-4d20-4a9f-8b62-3b9e2d5c6f70";

test("readProfileAuth reads `auth status --json` in the profile and reports the account", { skip: process.platform === "win32" && "needs a POSIX shell: the stand-in is a shell script" }, async (t) => {
  const s = script(
    t,
    `[ "$1 $2 $3" = "auth status --json" ] || exit 9
case "$CLAUDE_CONFIG_DIR" in */profile) ;; *) exit 8;; esac
echo '{"loggedIn":true,"authMethod":"claude.ai","email":"a@example.test","orgId":"${ORG}","orgName":"Org","subscriptionType":"max","accountUuid":"${ACCOUNT}"}'`,
  );
  const auth = await readProfileAuth(s.file, s.profile, undefined, () => "2026-10-19T09:00:00.000Z");
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.accountUuid, ACCOUNT);
  assert.equal(auth.orgId, ORG);
  assert.equal(auth.email, "a@example.test");
  assert.equal(auth.checkedAt, "2026-10-19T09:00:00.000Z");
});

test("readProfileAuth reports a failed status as signed out with the error text", async (t) => {
  const s = script(t, "exit 1");
  const auth = await readProfileAuth(s.file, s.profile, undefined);
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.error, "Limit okuma girişi doğrulanamadı. Limit okuma girişini yenile.");
});

test("diagnoseCli reports the version and whether it supports Desktop", { skip: process.platform === "win32" && "needs a POSIX shell: the stand-in is a shell script" }, async (t) => {
  const s = script(t, `echo "2.1.300 (Claude Code)"`);
  const d = await diagnoseCli(s.file, s.dir);
  assert.equal(d.executable, s.file);
  assert.equal(d.version, "2.1.300 (Claude Code)");
  assert.equal(d.dataDir, s.dir);
  assert.equal(d.error, undefined);
});

test("diagnoseCli says when no CLI is found", async (t) => {
  const s = script(t, "exit 0");
  const d = await diagnoseCli(path.join(s.dir, "missing"), s.dir);
  assert.match(d.error!, /Claude Code bulunamadı/);
});
