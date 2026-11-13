import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindClient,
  clientStatuses,
  releaseClientSync,
  tailscaleAddress,
  unbindClient,
} from "../electron/core/proxy/proxy-clients";
import { orderedAccounts, poolAccounts, buildProxyStatus } from "../electron/core/proxy/proxy-status";
import { ProxyStats, REQUEST_LOG_SIZE } from "../electron/core/proxy/proxy-stats";
import { isTailscaleIPv4 } from "../shared/proxy-url";
import { DEFAULT_PROXY_CONFIG } from "../shared/proxy-types";
import { compactCount, moveInOrder, quotaAtRisk } from "../src/lib/proxy-ui";

const target = { url: "http://127.0.0.1:8317", key: "relay-sec-test-key" };

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-clients-"));
}

test("binding Claude Code writes the gateway into settings.json and unbinding restores the old values", async () => {
  const dir = home();
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: "https://old.example", OTHER: "1" } }));
  const saved = await bindClient("claude-code", target, undefined, dir);
  assert.deepEqual(saved, {
    ANTHROPIC_BASE_URL: "https://old.example",
    ANTHROPIC_AUTH_TOKEN: null,
    CLAUDE_CODE_PROMPT_CACHE_TTL: null,
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: null,
  });
  const bound = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(bound.model, "opus");
  assert.deepEqual(bound.env, {
    ANTHROPIC_BASE_URL: target.url,
    OTHER: "1",
    ANTHROPIC_AUTH_TOKEN: target.key,
    CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
  });
  const [claude] = clientStatuses(target, { clientBindings: { "claude-code": saved } }, dir);
  assert.equal(claude.installed, true);
  assert.equal(claude.bound, true);
  assert.equal(claude.stale, false);
  // A new key: still Relay's binding, but out of date until it is written again.
  const stale = clientStatuses({ ...target, key: "relay-sec-new" }, { clientBindings: { "claude-code": saved } }, dir)[0];
  assert.deepEqual([stale.bound, stale.stale], [false, true]);
  // A rebind keeps the first saved values.
  assert.deepEqual(await bindClient("claude-code", { ...target, key: "relay-sec-new" }, saved, dir), saved);
  await unbindClient("claude-code", saved, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    model: "opus",
    env: { ANTHROPIC_BASE_URL: "https://old.example", OTHER: "1" },
  });
});

test("unbinding Claude Code drops an env block Relay emptied", async () => {
  const dir = home();
  const saved = await bindClient("claude-code", target, undefined, dir);
  await unbindClient("claude-code", saved, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")), {});
});

test("the cache lifetime and hint headers are added only where the user set none, and only Relay's go on unbind", async () => {
  const dir = home();
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" } }));
  const saved = await bindClient("claude-code", target, undefined, dir);
  assert.equal("CLAUDE_CODE_PROMPT_CACHE_TTL" in saved, false, "the user's own lifetime is not Relay's to restore");
  const env = JSON.parse(fs.readFileSync(file, "utf8")).env;
  assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, "5m");
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");
  // Changed by the user while bound: a rebind and the unbind both leave it.
  fs.writeFileSync(file, JSON.stringify({ env: { ...env, CLAUDE_CODE_GATEWAY_HINT_HEADERS: "0" } }));
  await bindClient("claude-code", target, saved, dir);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "0");
  await unbindClient("claude-code", saved, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).env, {
    CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "0",
  });
});

test("a binding from before the extras reads as out of date, and writing it again adds them", async () => {
  const dir = home();
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: target.url, ANTHROPIC_AUTH_TOKEN: target.key } }));
  const old = { ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null };
  const before = clientStatuses(target, { clientBindings: { "claude-code": old } }, dir)[0];
  assert.deepEqual([before.bound, before.stale], [false, true]);
  const saved = await bindClient("claude-code", target, old, dir);
  assert.deepEqual(saved, { ...old, CLAUDE_CODE_PROMPT_CACHE_TTL: null, CLAUDE_CODE_GATEWAY_HINT_HEADERS: null });
  assert.equal(clientStatuses(target, { clientBindings: { "claude-code": saved } }, dir)[0].bound, true);
});

test("a file Relay left bound is not taken for the user's values, and a binding with nothing to change is not rewritten", async () => {
  const dir = home();
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Relay crashed while bound: the file holds the gateway and an older Relay key.
  fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: target.url, ANTHROPIC_AUTH_TOKEN: "relay-sec-older" } }));
  const saved = await bindClient("claude-code", target, undefined, dir);
  assert.equal(saved.ANTHROPIC_BASE_URL, null);
  assert.equal(saved.ANTHROPIC_AUTH_TOKEN, null);
  const mtime = fs.statSync(file).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bindClient("claude-code", target, saved, dir);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test("quitting puts both clients' files back synchronously and keeps nothing of Relay's in them", async () => {
  const dir = home();
  const claude = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://mine.example" } }));
  const codexFile = path.join(dir, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, 'model_provider = "openai"\n');
  const savedClaude = await bindClient("claude-code", target, undefined, dir);
  const savedCodex = await bindClient("codex", target, undefined, dir);
  releaseClientSync("claude-code", savedClaude, dir);
  releaseClientSync("codex", savedCodex, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(claude, "utf8")), { env: { ANTHROPIC_BASE_URL: "https://mine.example" } });
  assert.equal(fs.readFileSync(codexFile, "utf8"), 'model_provider = "openai"\n');
  // The next start binds again from the saved values.
  await bindClient("claude-code", target, savedClaude, dir);
  assert.equal(JSON.parse(fs.readFileSync(claude, "utf8")).env.ANTHROPIC_BASE_URL, target.url);
});

test("an unreadable settings.json is reported, never overwritten", async () => {
  const dir = home();
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  assert.equal(clientStatuses(target, {}, dir)[0].blocked, "unreadable-settings");
  await assert.rejects(bindClient("claude-code", target, undefined, dir));
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("binding Codex adds Relay's provider, parks an existing one, and unbinding puts the file back", async () => {
  const dir = home();
  const file = path.join(dir, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = 'model = "gpt-5"\nmodel_provider = "openai"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n';
  fs.writeFileSync(file, original);
  await bindClient("codex", target, undefined, dir);
  const text = fs.readFileSync(file, "utf8");
  // The top-level key comes before any table, as TOML requires.
  assert.ok(text.indexOf('model_provider = "relay"') < text.indexOf("[profiles.fast]"));
  assert.match(text, /# relay-disabled: model_provider = "openai"/);
  assert.match(text, /\[model_providers\.relay\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:8317\/v1"[\s\S]*experimental_bearer_token = "relay-sec-test-key"/);
  const codex = clientStatuses(target, { clientBindings: { codex: {} } }, dir)[1];
  assert.deepEqual([codex.bound, codex.stale], [true, false]);
  // Binding twice leaves one copy of each block.
  await bindClient("codex", target, {}, dir);
  assert.equal(fs.readFileSync(file, "utf8").match(/\[model_providers\.relay\]/g)?.length, 1);
  await unbindClient("codex", {}, dir);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("a tool whose folder is missing reads as not installed and not bound", () => {
  const [claude, codex] = clientStatuses(target, {}, home());
  assert.deepEqual([claude.installed, claude.bound, codex.installed, codex.bound], [false, false, false, false]);
});

test("Tailscale's 100.64.0.0/10 range is recognised on a network interface", () => {
  assert.equal(isTailscaleIPv4("100.101.12.34"), true);
  assert.equal(isTailscaleIPv4("100.63.0.1"), false);
  assert.equal(isTailscaleIPv4("192.168.1.2"), false);
  const found = tailscaleAddress({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "", mac: "", cidr: null }],
    utun4: [{ address: "100.88.1.2", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }],
  } as ReturnType<typeof os.networkInterfaces>);
  assert.equal(found, "100.88.1.2");
});

test("the pool keeps its saved order, leaves excluded accounts out, and reports both windows", () => {
  const accounts = ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase(), kind: "personal", group: "personal", color: "olive", createdAt: "2026-11-01T00:00:00.000Z" }) as never);
  const config = { ...DEFAULT_PROXY_CONFIG, accountOrder: ["c", "gone", "a"], excludedAccountIds: ["a"] };
  assert.deepEqual(orderedAccounts(accounts, config).map((a: { id: string }) => a.id), ["c", "a", "b"]);
  assert.deepEqual(poolAccounts(accounts, config).map((a: { id: string }) => a.id), ["c", "b"]);
  const now = Date.parse("2026-11-09T12:00:00Z");
  const status = buildProxyStatus({
    running: true,
    config,
    accounts,
    usage: {
      c: {
        status: "ready",
        fiveHour: { usedPercent: 40, resetsAt: "2026-11-09T13:00:00Z" },
        sevenDay: { usedPercent: 70, resetsAt: "2026-11-10T12:00:00Z" },
      } as never,
    },
    now,
    metrics: {
      totalRequests: 3,
      activeSessions: 0,
      requestsByAccount: { c: 3 },
      tokensByAccount: { c: { input: 1, output: 2, cacheRead: 30, cacheWrite: 4 } },
      cacheHitRatio: 0.9,
    },
  });
  const c = status.accounts[0];
  assert.equal(c.id, "c");
  assert.deepEqual(
    [c.fiveHourPercent, c.fiveHourResetMinutes, c.weeklyPercent, c.weeklyResetMinutes, c.inPool, c.requests, c.tokens?.cacheRead],
    [40, 60, 70, 1_440, true, 3, 30],
  );
  assert.equal(status.accounts[1].inPool, false);
});

test("the request log keeps the newest entries first and caps its length", () => {
  const stats = new ProxyStats();
  for (let i = 0; i < REQUEST_LOG_SIZE + 5; i++) stats.recordLog({ at: i, status: 200, model: "m".repeat(200) });
  const recent = stats.recent();
  assert.equal(recent.length, REQUEST_LOG_SIZE);
  assert.equal(recent[0].at, REQUEST_LOG_SIZE + 4);
  assert.equal(recent[0].model?.length, 80);
  stats.reset();
  assert.deepEqual(stats.recent(), []);
});

test("quota at risk: a weekly window resetting within two days with a quarter or more left", () => {
  assert.deepEqual(quotaAtRisk({ weeklyPercent: 60, weeklyResetMinutes: 600 }), { percent: 40, minutes: 600 });
  assert.equal(quotaAtRisk({ weeklyPercent: 90, weeklyResetMinutes: 600 }), undefined);
  assert.equal(quotaAtRisk({ weeklyPercent: 10, weeklyResetMinutes: 5 * 1_440 }), undefined);
  assert.equal(quotaAtRisk({}), undefined);
  assert.deepEqual(moveInOrder(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveInOrder(["a", "b"], "a", -1), ["a", "b"]);
  assert.equal(compactCount(412_000, "tr-TR"), "412K");
  assert.equal(compactCount(1_250_000, "tr-TR"), "1,3M");
});
