import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProviders, executeOneClickCascade, oneClickConnectSchema } from "../electron/core/provider-discovery";
import { Store } from "../electron/core/store";

function home(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-discovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const jwt = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const byProvider = (list: Awaited<ReturnType<typeof detectProviders>>) =>
  Object.fromEntries(list.map((s) => [s.provider, s]));

test("nothing on disk detects nothing, for all three providers", async (t) => {
  const dir = home(t);
  const found = byProvider(
    await detectProviders([], { homeDir: dir, claudeDesktopRoot: path.join(dir, "Claude"), env: {} }),
  );
  assert.equal(found.claude.detected, false);
  assert.equal(found.codex.detected, false);
  assert.equal(found.antigravity.detected, false);
});

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const CHATGPT_ID = "33333333-3333-4333-8333-333333333333";
const codexSession = (dir: string, exp = FUTURE, accountId = CHATGPT_ID, email = "dev@example.com") =>
  write(path.join(dir, ".codex", "auth.json"), {
    tokens: {
      access_token: jwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" } }),
      refresh_token: "rt-never-copied",
      // The id token expires long before the access token.
      id_token: jwt({ email, exp: Math.floor(Date.now() / 1000) - 10 }),
      account_id: accountId,
    },
  });

test("Codex is read from ~/.codex/auth.json, with the email and plan its tokens state", async (t) => {
  const dir = home(t);
  codexSession(dir);
  const found = byProvider(
    await detectProviders([], { homeDir: dir, claudeDesktopRoot: path.join(dir, "Claude"), env: {} }),
  );
  assert.equal(found.codex.detected, true);
  assert.equal(found.codex.email, "dev@example.com");
  assert.equal(found.codex.plan, "pro");
  assert.equal(found.codex.source, path.join("~", ".codex", "auth.json"));
  assert.equal(found.antigravity.detected, false);
});

test("an expired Codex CLI sign-in is not offered, and no plan is made up", async (t) => {
  const dir = home(t);
  write(path.join(dir, ".codex", "auth.json"), { tokens: { access_token: jwt({ exp: 1 }) } });
  const found = byProvider(
    await detectProviders([], { homeDir: dir, claudeDesktopRoot: path.join(dir, "Claude"), env: {} }),
  );
  assert.equal(found.codex.detected, false);
  assert.equal(found.codex.plan, undefined);
});

test("Antigravity uses its own OAuth flow, never a Gemini API key from the environment", async (t) => {
  const dir = home(t);
  write(path.join(dir, ".antigravity", "auth.json"), { access_token: "ag", email: "ag@example.com" });
  const file = byProvider(
    await detectProviders([], { homeDir: dir, claudeDesktopRoot: path.join(dir, "Claude"), env: {} }),
  );
  assert.equal(file.antigravity.detected, false);
  const empty = home(t);
  const env = byProvider(
    await detectProviders([], {
      homeDir: empty,
      claudeDesktopRoot: path.join(empty, "Claude"),
      env: { GEMINI_API_KEY: "AIza-test-key" },
    }),
  );
  assert.equal(env.antigravity.detected, false);
});

test("Claude is detected from the Claude app's sign-in, not from the Claude Code CLI's tokens", async (t) => {
  const dir = home(t);
  write(path.join(dir, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "cl", subscriptionType: "max" } });
  const cliOnly = byProvider(
    await detectProviders([], { homeDir: dir, claudeDesktopRoot: path.join(dir, "Claude"), env: {} }),
  );
  assert.equal(cliOnly.claude.detected, false);
  const accountUuid = "11111111-1111-4111-8111-111111111111";
  write(path.join(dir, "Claude", "config.json"), { lastKnownAccountUuid: accountUuid, "oauth:tokenCacheV2": "sealed" });
  const desktop = byProvider(
    await detectProviders([], { homeDir: dir, claudeDesktopRoot: path.join(dir, "Claude"), env: {} }),
  );
  assert.equal(desktop.claude.detected, true);
  assert.equal(desktop.claude.source, "Claude Desktop");
  assert.equal(desktop.claude.plan, undefined);
});

test("a Codex sign-in that is already an account says which one", async (t) => {
  const dir = home(t);
  codexSession(dir);
  const store = new Store(path.join(dir, "relay"));
  const existing = store.create({ name: "Work Codex", kind: "personal", provider: "codex" });
  store.update((s) => {
    s.accounts[0].auth = { loggedIn: true, checkedAt: new Date().toISOString(), accountUuid: CHATGPT_ID };
  });
  const found = byProvider(
    await detectProviders(store.state.accounts, { homeDir: dir, claudeDesktopRoot: path.join(dir, "Claude"), env: {} }),
  );
  assert.equal(found.codex.alreadyLinkedAccountId, existing.id);
  assert.equal(found.codex.alreadyLinkedAccountName, "Work Codex");
});

test("the one-click schema accepts Claude and Codex; Antigravity has a separate OAuth flow", () => {
  for (const provider of ["claude", "codex"] as const)
    assert.equal(oneClickConnectSchema.parse({ provider, name: " A ", kind: "personal" }).name, "A");
  assert.throws(() => oneClickConnectSchema.parse({ provider: "antigravity", name: "A", kind: "personal" }));
  assert.throws(() => oneClickConnectSchema.parse({ provider: "other", name: "A", kind: "personal" }));
  assert.throws(() => oneClickConnectSchema.parse({ provider: "codex", name: "", kind: "personal" }));
  assert.throws(() => oneClickConnectSchema.parse({ provider: "codex", name: "A", kind: "personal", extra: 1 }));
  assert.throws(() => oneClickConnectSchema.parse({ provider: "claude", name: "A", kind: "personal", email: "x@y.z" }));
});

test("one click imports the Codex CLI's ChatGPT sign-in without its refresh token, expiring with the access token", async (t) => {
  const dir = home(t);
  codexSession(dir);
  const store = new Store(path.join(dir, "relay"));
  const result = await executeOneClickCascade(
    { provider: "codex", name: "OpenAI · Codex", kind: "personal" },
    { store, desktopRoot: path.join(dir, "Claude"), homeDir: dir, env: {}, checkOpenAiKey: async () => assert.fail("no key to check") },
  );
  assert.equal(result.account.provider, "codex");
  assert.equal(result.account.auth?.loggedIn, true);
  assert.equal(result.account.auth?.email, "dev@example.com");
  assert.equal(result.account.auth?.accountUuid, CHATGPT_ID);
  assert.equal(result.account.auth?.subscription, "pro");
  assert.deepEqual(result.layers, { desktop: "skipped", usage: "skipped", terminal: "skipped", extensionAndProxy: "done" });
  const file = path.join(store.profile(result.account.id), "provider-credential.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.kind, "chatgpt");
  assert.equal(saved.expiresAt, FUTURE * 1000);
  assert.equal(JSON.stringify(saved).includes("rt-never-copied"), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The same sign-in again is refused instead of making a duplicate.
  await assert.rejects(
    executeOneClickCascade(
      { provider: "codex", name: "Again", kind: "personal" },
      { store, desktopRoot: path.join(dir, "Claude"), homeDir: dir, env: {} },
    ),
    /already the account OpenAI · Codex/,
  );
});

test("one click checks an OpenAI API key with OpenAI before saving it, and saves nothing when it is refused", async (t) => {
  const dir = home(t);
  const store = new Store(path.join(dir, "relay"));
  const checked: string[] = [];
  await assert.rejects(
    executeOneClickCascade(
      { provider: "codex", name: "Key", kind: "personal", apiKey: "sk-bad" },
      { store, desktopRoot: path.join(dir, "Claude"), homeDir: dir, env: {}, checkOpenAiKey: async (k) => (checked.push(k), "rejected") },
    ),
    /rejected this API key/,
  );
  await assert.rejects(
    executeOneClickCascade(
      { provider: "codex", name: "Key", kind: "personal", apiKey: "not-a-key" },
      { store, desktopRoot: path.join(dir, "Claude"), homeDir: dir, env: {} },
    ),
    /starts with sk-/,
  );
  assert.equal(store.state.accounts.length, 0);
  const ok = await executeOneClickCascade(
    { provider: "codex", name: "Key", kind: "personal", apiKey: "sk-good" },
    { store, desktopRoot: path.join(dir, "Claude"), homeDir: dir, env: {}, checkOpenAiKey: async (k) => (checked.push(k), "ok") },
  );
  assert.deepEqual(checked, ["sk-bad", "sk-good"]);
  assert.equal(ok.account.auth?.loggedIn, true);
  assert.equal(ok.account.auth?.subscription, "API key");
});

test("one click never creates a Codex account without a usable credential", async (t) => {
  const dir = home(t);
  const store = new Store(path.join(dir, "relay"));
  await assert.rejects(
    executeOneClickCascade(
      { provider: "codex", name: "codex", kind: "personal" },
      { store, desktopRoot: path.join(dir, "Claude"), homeDir: dir, env: {} },
    ),
    /No usable credential/,
  );
  assert.equal(store.state.accounts.length, 0);
});

test("an Antigravity token cannot enter the Codex one-click flow", async (t) => {
  const dir = home(t);
  const store = new Store(path.join(dir, "relay"));
  await assert.rejects(
    executeOneClickCascade(
      { provider: "antigravity", name: "Google", kind: "personal", apiKey: "oauth-token" },
      { store, desktopRoot: path.join(dir, "Claude"), homeDir: dir, env: {} },
    ),
    /invalid_enum_value|Invalid option/,
  );
  assert.equal(store.state.accounts.length, 0);
});

test("one click on Claude with no current Desktop session starts the sign-in and says it is needed", async (t) => {
  const dir = home(t);
  const store = new Store(path.join(dir, "relay"));
  const began: string[] = [];
  const armed: string[] = [];
  const result = await executeOneClickCascade(
    { provider: "claude", name: "Kişisel · Claude", kind: "personal" },
    {
      store,
      desktopRoot: path.join(dir, "Claude"),
      homeDir: dir,
      env: {},
      beginDesktopLogin: async (id) => void began.push(id),
      armAutoCapture: (id) => void armed.push(id),
    },
  );
  assert.equal(result.account.provider, "claude");
  assert.equal(result.needsSignIn, true);
  assert.equal(result.layers.desktop, "pending");
  assert.equal(result.account.auth, undefined, "no sign-in is claimed before the capture");
  assert.deepEqual(began, [result.account.id]);
  assert.deepEqual(armed, [result.account.id]);
});

const accountUuid = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

test("one click on Claude captures the current Desktop sign-in when Code has its one workspace", async (t) => {
  const dir = home(t);
  const root = path.join(dir, "Claude");
  write(path.join(root, "config.json"), { lastKnownAccountUuid: accountUuid, "oauth:tokenCacheV2": "sealed" });
  fs.mkdirSync(path.join(root, "claude-code-sessions", accountUuid, orgId), { recursive: true });
  // The Claude Code CLI's tokens are never copied into the new profile.
  write(path.join(dir, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "cli", refreshToken: "cli-rt" } });
  const store = new Store(path.join(dir, "relay"));
  const captured: string[][] = [];
  const result = await executeOneClickCascade(
    { provider: "claude", name: "Kişisel · Claude", kind: "personal" },
    {
      store,
      desktopRoot: root,
      homeDir: dir,
      env: {},
      captureDesktop: async (id, org) => void captured.push([id, org]),
      beginDesktopLogin: async () => assert.fail("a current session needs no sign-in"),
    },
  );
  assert.deepEqual(captured, [[result.account.id, orgId]]);
  assert.equal(result.needsSignIn, undefined);
  assert.equal(fs.existsSync(path.join(store.profile(result.account.id), ".credentials.json")), false);
});

test("one click on Claude waits for Code instead of faking its workspace folder", async (t) => {
  const dir = home(t);
  const root = path.join(dir, "Claude");
  write(path.join(root, "config.json"), { lastKnownAccountUuid: accountUuid, "oauth:tokenCacheV2": "sealed" });
  write(path.join(dir, ".claude.json"), { oauthAccount: { accountUuid, organizationUuid: orgId } });
  const store = new Store(path.join(dir, "relay"));
  const armed: string[] = [];
  const result = await executeOneClickCascade(
    { provider: "claude", name: "Kişisel · Claude", kind: "personal" },
    {
      store,
      desktopRoot: root,
      homeDir: dir,
      env: {},
      captureDesktop: async () => assert.fail("no workspace to capture yet"),
      beginDesktopLogin: async () => assert.fail("the current sign-in is kept"),
      armAutoCapture: (id) => void armed.push(id),
    },
  );
  assert.deepEqual(armed, [result.account.id]);
  assert.equal(result.layers.desktop, "pending");
  assert.equal(fs.existsSync(path.join(root, "claude-code-sessions")), false);
});
