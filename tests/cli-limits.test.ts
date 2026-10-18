import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { credentialService } from "../electron/core/usage-credentials";
import { childReady } from "./lock-child";

const TOKEN = "sk-ant-oat01-FAKEACCESSTOKENFORTESTS0000000000000000";
const REFRESH = "sk-ant-ort01-FAKEREFRESHTOKENFORTESTS000000000000000";

/** A fake `claude` that answers `auth status --json` with the given identity and logs every call. */
function fakeClaude(dir: string, status: Record<string, unknown>, opts: { version?: string } = {}) {
  const file = path.join(dir, "fake-claude");
  const log = path.join(dir, "claude.log");
  fs.writeFileSync(
    file,
    `#!/bin/sh
echo "$*|$CLAUDE_CONFIG_DIR" >> "${log}"
case "$1 $2" in
  "auth status") echo '${JSON.stringify(status)}';;
  "--version ") echo "${opts.version ?? "2.1.300"} (Claude Code)";;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return { file, log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

test("connect signs the account's profile in with the official CLI and stores who it is", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const claude = fakeClaude(f.temp, {
    loggedIn: true,
    authMethod: "claude.ai",
    email: "a@example.test",
    accountUuid: a.desktop!.accountUuid,
    orgId: a.desktop!.orgId,
  });
  f.deps.claude = () => claude.file;
  assert.equal(await f.run("connect", "A"), 0);
  const profile = path.join(f.home, "profiles", a.id);
  assert.match(claude.log(), new RegExp(`^auth login --claudeai\\|${profile}$`, "m"));
  const auth = f.store().account(a.id).auth!;
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.accountUuid, a.desktop!.accountUuid);
  assert.match(f.out(), /a@example\.test/);
});

test("a login to another account is signed out again and fails", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const claude = fakeClaude(f.temp, {
    loggedIn: true,
    authMethod: "claude.ai",
    email: "other@example.test",
    accountUuid: crypto.randomUUID(),
    orgId: a.desktop!.orgId,
  });
  f.deps.claude = () => claude.file;
  assert.equal(await f.run("connect", "A"), 1);
  assert.match(claude.log(), /auth logout/);
  assert.match(f.err(), /other@example\.test/);
  assert.equal(f.store().account(a.id).auth, undefined);
});

async function connected(t: any, opts: { expiresAt?: number; five?: number; seven?: number | null } = {}) {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  f.store().update((s) => {
    s.accounts[0].auth = {
      loggedIn: true,
      accountUuid: a.desktop!.accountUuid,
      orgId: a.desktop!.orgId,
      email: "a@example.test",
      checkedAt: new Date().toISOString(),
    };
  });
  const profile = path.join(f.home, "profiles", a.id);
  f.security.setItem(
    credentialService(profile),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: TOKEN,
        refreshToken: REFRESH,
        expiresAt: opts.expiresAt ?? Date.now() + 3_600_000,
        scopes: ["user:inference", "user:profile"],
      },
    }),
  );
  const resets = new Date(Date.now() + (2 * 60 + 10) * 60_000 + 30_000).toISOString();
  f.deps.request = async (endpoint: string) =>
    endpoint === "profile"
      ? { account: { uuid: a.desktop!.accountUuid, email_address: "a@example.test" }, organization: { uuid: a.desktop!.orgId } }
      : {
          five_hour: { utilization: opts.five ?? 94, resets_at: resets },
          ...(opts.seven === null ? {} : { seven_day: { utilization: opts.seven ?? 40, resets_at: resets } }),
        };
  const claude = fakeClaude(f.temp, {});
  f.deps.claude = () => claude.file;
  return { f, a, claude };
}

test("usage --json shows how much of each window is used, as Claude's usage page does", async (t) => {
  const { f, a } = await connected(t);
  assert.equal(await f.run("usage", "--json"), 0);
  const [row] = JSON.parse(f.out());
  assert.equal(row.id, a.id);
  assert.equal(row.status, "ready");
  assert.equal(row.fiveHour.usedPercent, 94);
  assert.equal(row.sevenDay.usedPercent, 40);
  f.clear();
  assert.equal(await f.run("usage"), 0);
  assert.match(f.out(), /94% used · resets in 2 h 10 min/);
  f.clear();
  await f.run("usage", "--lang", "tr");
  assert.match(f.out(), /%94 kullanıldı · 2 sa 10 dk sonra yenilenir/);
  assert.ok(!(f.out() + f.err()).includes(TOKEN) && !(f.out() + f.err()).includes("FIXTURE-SECRET"));
});

test("a seat that reports no weekly limit says so", async (t) => {
  const { f } = await connected(t, { seven: null });
  await f.run("usage", "--json");
  assert.equal(JSON.parse(f.out())[0].sevenDay, "not-reported");
});

test("an expiring credential is not renewed while another process holds the profile lock", async (t) => {
  const { f, a, claude } = await connected(t, { expiresAt: Date.now() + 60_000 });
  const child = await childReady("profile-lock-child.ts", [path.join(f.home, "profiles", ".locks"), a.id, "exclusive"]);
  t.after(() => child.kill());
  await f.run("usage");
  assert.match(f.out(), /another process is renewing it/);
  assert.ok(!/auth|--print|refresh/.test(claude.log().replace(/--version.*\n?/g, "")));
  assert.ok(!(f.out() + f.err()).includes(TOKEN));
});

test("an account without a connection gets the connect hint", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  assert.equal(await f.run("usage"), 0);
  assert.match(f.out(), /relay connect/);
  f.clear();
  await f.run("usage", "--json");
  assert.equal(JSON.parse(f.out())[0].status, "not-connected");
});
