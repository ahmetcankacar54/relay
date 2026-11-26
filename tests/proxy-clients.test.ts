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
} from "../electron/core/proxy-clients";
import { orderedAccounts, poolAccounts, buildProxyStatus } from "../shared/proxy-status";
import { GatewayRequestLog, REQUEST_LOG_SIZE } from "../electron/core/gateway-request-log";
import { isTailscaleIPv4 } from "../shared/proxy-url";
import { DEFAULT_PROXY_CONFIG } from "../shared/proxy-types";
import { compactCount, moveInOrder, quotaAtRisk } from "../src/lib/proxy-ui";

const target = { url: "http://127.0.0.1:8317", key: "relay-sec-test-key" };

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-clients-"));
}

test("a client file holding the gateway key is owner-only, also over a file that was readable by all", { skip: process.platform === "win32" && "POSIX file modes" }, async () => {
  const dir = home();
  const files = {
    "claude-code": path.join(dir, ".claude", "settings.json"),
    codex: path.join(dir, ".codex", "config.toml"),
    omp: path.join(dir, ".omp", "agent", "models.yml"),
  } as const;
  for (const [id, file] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id === "claude-code" ? "{}" : "", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await bindClient(id as keyof typeof files, target, undefined, dir);
    assert.match(fs.readFileSync(file, "utf8"), /relay-sec-test-key/, id);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, id);
  }
  // Putting the files back while quitting keeps them owner-only too.
  fs.chmodSync(files.codex, 0o644);
  releaseClientSync("codex", undefined, dir);
  assert.equal(fs.statSync(files.codex).mode & 0o777, 0o600);
});

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

test("the request log keeps the newest entries for the feed and caps their length", () => {
  const dir = home();
  try {
    const log = new GatewayRequestLog(path.join(dir, "gateway-requests.jsonl"), { feedSize: REQUEST_LOG_SIZE });
    log.load();
    const now = Date.now();
    for (let i = 0; i < REQUEST_LOG_SIZE + 5; i++) log.record({ at: now + i, status: 200, model: "m".repeat(200) });
    const recent = log.recent();
    assert.equal(recent.length, REQUEST_LOG_SIZE);
    assert.equal(recent.at(-1)?.at, now + REQUEST_LOG_SIZE + 4, "the newest last");
    assert.equal(recent.at(-1)?.model?.length, 80);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

const ompDir = (dir: string) => path.join(dir, ".omp", "agent");
const ompFile = (dir: string, name = "models.yml") => path.join(ompDir(dir), name);
const writeOmp = (dir: string, text: string, name = "models.yml") => {
  fs.mkdirSync(ompDir(dir), { recursive: true });
  fs.writeFileSync(ompFile(dir, name), text);
};
const readOmp = (dir: string, name = "models.yml") => fs.readFileSync(ompFile(dir, name), "utf8");
const ompStatus = (dir: string, bound = true, to = target) =>
  clientStatuses(to, { clientBindings: bound ? { omp: {} } : {} }, dir).find((c) => c.id === "omp")!;
const START = "# >>> relay gateway (written by Relay; remove it from Relay's Proxy page)";
const END = "# <<< relay gateway";
const RELAY_ENTRIES = (pad: string) => [
  `${pad}anthropic:`,
  `${pad}${pad}baseUrl: "http://127.0.0.1:8317"`,
  `${pad}${pad}apiKey: "sk-ant-oat01-relay-gateway"`,
  `${pad}${pad}headers:`,
  `${pad}${pad}${pad}x-relay-key: "relay-sec-test-key"`,
  `${pad}openai-codex:`,
  `${pad}${pad}baseUrl: "http://127.0.0.1:8317"`,
  `${pad}${pad}apiKey: "relay-gateway"`,
  `${pad}${pad}headers:`,
  `${pad}${pad}${pad}x-relay-key: "relay-sec-test-key"`,
];

/** Binds, checks the bound text, then checks that unbinding and quitting both give `before` back. */
async function roundTrip(before: string, bound: (text: string) => void) {
  const dir = home();
  writeOmp(dir, before);
  const saved = await bindClient("omp", target, undefined, dir);
  assert.deepEqual(saved, { created: null });
  bound(readOmp(dir));
  assert.equal(ompStatus(dir).bound, true);
  // Binding again, under another key and back, parks nothing twice and stacks no blocks.
  const once = readOmp(dir);
  await bindClient("omp", { ...target, key: "relay-sec-new" }, saved, dir);
  await bindClient("omp", target, saved, dir);
  assert.equal(readOmp(dir), once);
  await unbindClient("omp", saved, dir);
  assert.equal(readOmp(dir), before);
  await bindClient("omp", target, saved, dir);
  releaseClientSync("omp", saved, dir);
  assert.equal(readOmp(dir), before);
}

test("omp: one click writes models.yml, the next takes it away, leaving no file Relay made", async () => {
  const dir = home();
  fs.mkdirSync(ompDir(dir), { recursive: true });
  assert.equal(ompStatus(dir, false).bound, false);
  const saved = await bindClient("omp", target, undefined, dir);
  assert.deepEqual(saved, { created: "1" });
  const text = readOmp(dir);
  assert.equal(text, [START, "providers:", ...RELAY_ENTRIES("  "), END, ""].join("\n"));
  // Windows has no Unix modes: it reports 0666 whatever was asked.
  if (process.platform !== "win32") assert.equal((fs.statSync(ompFile(dir)).mode & 0o777).toString(8), "600");
  assert.deepEqual([ompStatus(dir).installed, ompStatus(dir).bound, ompStatus(dir).stale], [true, true, false]);
  const moved = ompStatus(dir, true, { ...target, key: "relay-sec-other" });
  assert.deepEqual([moved.bound, moved.stale], [false, true]);
  assert.deepEqual(await bindClient("omp", target, saved, dir), saved);
  assert.equal(readOmp(dir), text);
  await unbindClient("omp", saved, dir);
  assert.equal(fs.existsSync(ompFile(dir)), false);
  // Quitting Relay takes it away the same way; the next start writes it again.
  await bindClient("omp", target, saved, dir);
  releaseClientSync("omp", saved, dir);
  assert.equal(fs.existsSync(ompFile(dir)), false);
  // Disconnecting a binding Relay has no record of still removes a file that is only Relay's.
  await bindClient("omp", target, undefined, dir);
  await unbindClient("omp", undefined, dir);
  assert.equal(fs.existsSync(ompFile(dir)), false);
});

test("omp: the user's own anthropic and openai-codex entries are parked while bound and come back byte for byte", async () => {
  await roundTrip(
    [
      "# my models",
      "providers:",
      "    ollama:",
      "        baseUrl: http://127.0.0.1:11434",
      "        models:",
      "            - id: anthropic",
      "    anthropic:",
      "        baseUrl: https://proxy.example",
      "        # a note inside",
      "",
      "        modelOverrides:",
      "            claude-opus-5: { name: Opus }",
      "    # a comment between entries",
      "",
      "    'openai-codex': { baseUrl: https://other.example }",
      "# other settings",
      "equivalence:",
      "    anthropic: x",
      "",
    ].join("\n"),
    (text) =>
      assert.deepEqual(text.split("\n").slice(1, 30), [
        "providers:",
        START,
        ...RELAY_ENTRIES("    "),
        END,
        "    ollama:",
        "        baseUrl: http://127.0.0.1:11434",
        "        models:",
        "            - id: anthropic",
        "    # relay-disabled: anthropic:",
        "    # relay-disabled:     baseUrl: https://proxy.example",
        "    # relay-disabled:     # a note inside",
        "",
        "    # relay-disabled:     modelOverrides:",
        "    # relay-disabled:         claude-opus-5: { name: Opus }",
        "    # a comment between entries",
        "",
        "    # relay-disabled: 'openai-codex': { baseUrl: https://other.example }",
        "# other settings",
        "equivalence:",
        "    anthropic: x",
      ]),
  );
});

test("omp: a comment less indented than the entry ends it and is never parked", async () => {
  await roundTrip("providers:\n  anthropic:\n    baseUrl: x\n# other settings\nretry: 3\n", (text) =>
    assert.ok(text.includes("  # relay-disabled:   baseUrl: x\n# other settings\nretry: 3\n")),
  );
  await roundTrip("providers:\n    anthropic:\n        baseUrl: x\n  # c\n    ollama: {}\n", (text) =>
    assert.ok(text.includes("    # relay-disabled:     baseUrl: x\n  # c\n    ollama: {}\n")),
  );
});

test("omp: CRLF, a missing last newline, trailing blank lines and an empty file all come back as they were", async () => {
  await roundTrip("retry: 3\r\nproviders:\r\n  anthropic:\r\n    baseUrl: x\r\n", (text) => {
    assert.ok(text.includes(`providers:\r\n${START}\r\n  anthropic:\r\n`));
    assert.ok(text.includes("  # relay-disabled:   baseUrl: x\r\n"));
  });
  await roundTrip("retry: 3", (text) => assert.ok(text.startsWith(`retry: 3\n${START}\nproviders:\n`)));
  await roundTrip("retry: 3\n\n\n", (text) => assert.ok(text.startsWith(`retry: 3\n\n\n${START}\n`) && text.endsWith(`${END}\n`)));
  // An empty file of the user's stays, empty, after Disconnect.
  await roundTrip("", (text) => assert.ok(text.startsWith(START)));
});

test("omp: an empty inline providers map is parked; layouts Relay cannot edit safely block it", async () => {
  await roundTrip("providers: {}\nretry: 3\n", (text) =>
    assert.ok(text.startsWith(`# relay-disabled: providers: {}\nretry: 3\n${START}\nproviders:\n`)),
  );
  for (const [text, reason] of [
    ["providers: { anthropic: { baseUrl: x } }\n", "inline-providers"],
    ["providers: ~\n", "inline-providers"],
    ['"providers": {a: 1}\n', "inline-providers"],
    ["providers:\n  - x\n", "unsupported-layout"],
    ["providers:\n  anthropic: {\n    baseUrl: x\n  }\n", "unsupported-layout"],
    ["providers:\n  ollama: {}\n...\n", "unsupported-layout"],
    ["---\nretry: 1\n---\nretry: 2\n", "unsupported-layout"],
    ["providers:\n  a: {}\n'providers':\n  b: {}\n", "unsupported-layout"],
    ["a: 1\n---\nretry: 3\n", "unsupported-layout"],
    ["providers:\n  ? anthropic\n  : { baseUrl: x }\n", "unsupported-layout"],
    ["providers:\n  anthropic: &a\n    baseUrl: x\n  other: *a\n", "unsupported-layout"],
  ] as const) {
    const dir = home();
    writeOmp(dir, text);
    assert.equal(ompStatus(dir, false).blocked, reason, text);
    await assert.rejects(bindClient("omp", target, undefined, dir));
    assert.equal(readOmp(dir), text);
  }
  // A quoted key is still the providers key: Relay's entries go under it, not a second one.
  await roundTrip("'providers':\n  ollama: {}\n", (text) => assert.ok(text.startsWith(`'providers':\n${START}\n  anthropic:`)));
  // Brackets inside quotes are no unclosed map; a byte order mark does not hide the key.
  await roundTrip('providers:\n  anthropic: { name: "a{b" }\n', (text) =>
    assert.ok(text.includes('  # relay-disabled: anthropic: { name: "a{b" }')),
  );
  await roundTrip("\uFEFFproviders:\n  ollama: {}\n", (text) => assert.ok(text.startsWith(`\uFEFFproviders:\n${START}\n`)));
  // A single leading document marker is fine.
  await roundTrip("---\nretry: 1\n", (text) => assert.ok(text.startsWith(`---\nretry: 1\n${START}`)));
});

test("omp: a blocked file that still holds Relay's block can be disconnected", async () => {
  const dir = home();
  writeOmp(dir, "retry: 3\n");
  const saved = await bindClient("omp", target, undefined, dir);
  fs.appendFileSync(ompFile(dir), "providers: { mine: {} }\n");
  const status = ompStatus(dir);
  assert.deepEqual([status.bound, status.stale, status.blocked], [true, false, "inline-providers"]);
  await unbindClient("omp", saved, dir);
  assert.equal(readOmp(dir), "retry: 3\nproviders: { mine: {} }\n");
});

test("omp: models.yaml is written when omp reads it, a models.json omp has not moved blocks, a symlink stays a link", async () => {
  const yaml = home();
  writeOmp(yaml, "retry: 3\n", "models.yaml");
  const saved = await bindClient("omp", target, undefined, yaml);
  assert.equal(ompStatus(yaml).file, ompFile(yaml, "models.yaml"));
  assert.equal(ompStatus(yaml).bound, true);
  assert.equal(fs.existsSync(ompFile(yaml)), false);
  await unbindClient("omp", saved, yaml);
  assert.equal(readOmp(yaml, "models.yaml"), "retry: 3\n");

  const legacy = home();
  writeOmp(legacy, '{"providers":{}}', "models.json");
  assert.equal(ompStatus(legacy, false).blocked, "legacy-json");
  await assert.rejects(bindClient("omp", target, undefined, legacy));
  assert.equal(fs.existsSync(ompFile(legacy)), false);

  const linked = home();
  const real = path.join(linked, "dotfiles", "models.yml");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "retry: 3\n");
  fs.mkdirSync(ompDir(linked), { recursive: true });
  fs.symlinkSync(real, ompFile(linked));
  const kept = await bindClient("omp", target, undefined, linked);
  assert.ok(fs.lstatSync(ompFile(linked)).isSymbolicLink());
  assert.ok(fs.readFileSync(real, "utf8").includes(START));
  assert.equal(ompStatus(linked).bound, true);
  await unbindClient("omp", kept, linked);
  assert.ok(fs.lstatSync(ompFile(linked)).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), "retry: 3\n");
});

test("omp: a Relay block with only one provider is stale, and binding it again makes the file Relay's own", async () => {
  const dir = home();
  writeOmp(dir, [START, "providers:", ...RELAY_ENTRIES("  ").slice(0, 5), END, ""].join("\n"));
  assert.deepEqual([ompStatus(dir, false).bound, ompStatus(dir, false).stale], [false, true]);
  const saved = await bindClient("omp", target, undefined, dir);
  assert.deepEqual(saved, { created: "1" });
  assert.equal(ompStatus(dir).bound, true);
  await unbindClient("omp", saved, dir);
  assert.equal(fs.existsSync(ompFile(dir)), false);
});

test("omp: a file of the user's that Relay found gone and wrote again on a start is removed on disconnect", async () => {
  const dir = home();
  writeOmp(dir, "retry: 3\n");
  const first = await bindClient("omp", target, undefined, dir);
  assert.deepEqual(first, { created: null });
  fs.rmSync(ompFile(dir));
  const again = await bindClient("omp", target, first, dir);
  assert.deepEqual(again, { created: "1" });
  await unbindClient("omp", again, dir);
  assert.equal(fs.existsSync(ompFile(dir)), false);
});
