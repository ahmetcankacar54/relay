import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONFIG_SYNC_BACKUP_LIMIT,
  accountLocalEnv,
  pruneConfigSyncBackups,
  syncProfileConfig,
} from "../electron/core/config-sync";
import { Store, settingsPatchSchema } from "../electron/core/store";
import { DesktopManager, type DesktopHost } from "../electron/core/desktop";
import { jsonBytes, writeBytes } from "../electron/core/desktop-files";
import { DEFAULT_SETTINGS, type ConfigSyncSettings } from "../shared/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { ConfigSyncPreference } from "../src/features/ConfigSyncPreference";
import { testT } from "./i18n";

const ALL: ConfigSyncSettings = {
  mcpServers: true,
  skills: true,
  settings: true,
  claudeMd: true,
};
const NOW = Date.parse("2026-11-23T10:00:00Z");
/** Seconds since the epoch, `minutes` after NOW, for utimes. */
const at = (minutes: number) => NOW / 1000 + minutes * 60;
/** Two account profiles and the backups folder, in a temporary folder. */
interface Dirs {
  root: string;
  from: string;
  to: string;
  backups: string;
}
function temp(t: { after(fn: () => void): void }): Dirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const from = path.join(root, "profiles", "a");
  const to = path.join(root, "profiles", "b");
  fs.mkdirSync(from, { recursive: true });
  fs.mkdirSync(to, { recursive: true });
  return { root, from, to, backups: path.join(root, "config-sync-backups") };
}
function write(file: string, value: unknown, minutes?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  if (minutes !== undefined) fs.utimesSync(file, at(minutes), at(minutes));
}
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const sync = (dirs: Dirs, choice: Partial<ConfigSyncSettings> = ALL) =>
  syncProfileConfig({
    from: dirs.from,
    to: dirs.to,
    backups: dirs.backups,
    choice: {
      mcpServers: false,
      skills: false,
      settings: false,
      claudeMd: false,
      ...choice,
    },
    now: () => NOW,
  });
const vertex = { type: "stdio", command: "vertex-mcp", args: ["--port", "1"] };

test("an MCP server added on account A appears on B; B's own servers and sign-in stay", async (t) => {
  const dirs = temp(t);
  write(path.join(dirs.from, ".claude.json"), {
    oauthAccount: {
      accountUuid: "from-account",
      emailAddress: "a@example.com",
    },
    userID: "from-user",
    mcpServers: { vertex },
  });
  write(path.join(dirs.from, ".credentials.json"), {
    claudeAiOauth: { accessToken: "secret-a" },
  });
  write(path.join(dirs.to, ".claude.json"), {
    oauthAccount: { accountUuid: "to-account", emailAddress: "b@example.com" },
    mcpServers: { alto: { type: "http", url: "https://example.com/mcp" } },
  });
  const result = await sync(dirs, { mcpServers: true });
  assert.equal(result.mcpServers, 1);
  assert.equal(result.backup, undefined);
  const config = json(path.join(dirs.to, ".claude.json"));
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["alto", "vertex"]);
  assert.deepEqual(config.mcpServers.vertex, vertex);
  assert.equal(config.oauthAccount.accountUuid, "to-account");
  assert.equal(config.userID, undefined);
  assert.equal(fs.existsSync(path.join(dirs.to, ".credentials.json")), false);
  // Windows has no owner-only file mode to check.
  if (process.platform !== "win32")
    assert.equal(
      fs.statSync(path.join(dirs.to, ".claude.json")).mode & 0o777,
      0o600,
    );
  // A second switch finds nothing to carry.
  assert.equal((await sync(dirs, { mcpServers: true })).mcpServers, 0);
});

test("a profile without a config gets one with only the MCP servers", async (t) => {
  const dirs = temp(t);
  write(path.join(dirs.from, ".claude.json"), {
    oauthAccount: { accountUuid: "x" },
    mcpServers: { vertex },
  });
  await sync(dirs, { mcpServers: true });
  assert.deepEqual(json(path.join(dirs.to, ".claude.json")), {
    mcpServers: { vertex },
  });
});

test("a server both accounts have: the newer copy wins and the loser is backed up", async (t) => {
  const dirs = temp(t);
  const mine = { ...vertex, args: ["--port", "2"] };
  write(path.join(dirs.from, ".claude.json"), { mcpServers: { vertex } }, 10);
  write(
    path.join(dirs.to, ".claude.json"),
    { mcpServers: { vertex: mine } },
    5,
  );
  const result = await sync(dirs, { mcpServers: true });
  assert.equal(result.mcpServers, 1);
  assert.deepEqual(
    json(path.join(dirs.to, ".claude.json")).mcpServers.vertex,
    vertex,
  );
  assert.ok(result.backup?.startsWith(dirs.backups));
  assert.deepEqual(json(path.join(result.backup!, "mcpServers.json")), {
    vertex: mine,
  });

  // The account switched to changed it later: its copy stays, and nothing is backed up.
  const later = temp(t);
  write(path.join(later.from, ".claude.json"), { mcpServers: { vertex } }, 5);
  write(
    path.join(later.to, ".claude.json"),
    { mcpServers: { vertex: mine } },
    10,
  );
  const kept = await sync(later, { mcpServers: true });
  assert.equal(kept.mcpServers, 0);
  assert.equal(kept.backup, undefined);
  assert.deepEqual(
    json(path.join(later.to, ".claude.json")).mcpServers.vertex,
    mine,
  );
});

test("settings: only the allow-listed keys travel, and no key, token or endpoint does", async (t) => {
  const dirs = temp(t);
  write(
    path.join(dirs.from, "settings.json"),
    {
      permissions: { allow: ["Bash(npm test)"] },
      model: "opus",
      hooks: { Stop: [] },
      statusLine: { type: "command", command: "relay statusline" },
      env: {
        DISABLE_TELEMETRY: "1",
        ANTHROPIC_AUTH_TOKEN: "from-token",
        ANTHROPIC_API_KEY: "from-key",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
        GITHUB_TOKEN: "from-github",
      },
      apiKeyHelper: "/usr/local/bin/key-helper",
      forceLoginMethod: "console",
    },
    10,
  );
  write(
    path.join(dirs.to, "settings.json"),
    { env: { ANTHROPIC_AUTH_TOKEN: "to-token" }, theme: "dark" },
    5,
  );
  const result = await sync(dirs, { settings: true });
  assert.equal(result.settings, 5);
  const settings = json(path.join(dirs.to, "settings.json"));
  assert.deepEqual(settings, {
    env: { ANTHROPIC_AUTH_TOKEN: "to-token", DISABLE_TELEMETRY: "1" },
    theme: "dark",
    permissions: { allow: ["Bash(npm test)"] },
    model: "opus",
    hooks: { Stop: [] },
    statusLine: { type: "command", command: "relay statusline" },
  });
  for (const name of [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "GITHUB_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
  ])
    assert.ok(accountLocalEnv(name), name);
  for (const name of [
    "DISABLE_TELEMETRY",
    "MAX_THINKING_TOKENS",
    "MONKEY_PATCH",
  ])
    assert.equal(accountLocalEnv(name), false, name);
  // Nothing of B's was replaced, so nothing was backed up.
  assert.equal(result.backup, undefined);
});

test("settings: an older key on the switched-to side is replaced and backed up without its secrets", async (t) => {
  const dirs = temp(t);
  write(
    path.join(dirs.from, "settings.json"),
    { model: "opus", env: { MAX_THINKING_TOKENS: "8000" } },
    10,
  );
  write(
    path.join(dirs.to, "settings.json"),
    {
      model: "sonnet",
      env: { MAX_THINKING_TOKENS: "1", ANTHROPIC_API_KEY: "to-key" },
    },
    5,
  );
  const result = await sync(dirs, { settings: true });
  // B's API key stays whoever wins; its replaced variables are backed up without it.
  assert.equal(result.settings, 2);
  assert.deepEqual(json(path.join(dirs.to, "settings.json")), {
    model: "opus",
    env: { ANTHROPIC_API_KEY: "to-key", MAX_THINKING_TOKENS: "8000" },
  });
  assert.deepEqual(json(path.join(result.backup!, "settings.json")), {
    model: "sonnet",
    env: { MAX_THINKING_TOKENS: "1" },
  });
});

test("skills and agents travel by name; a newer one replaces the older after a backup", async (t) => {
  const dirs = temp(t);
  write(path.join(dirs.from, "skills", "review", "SKILL.md"), "review v2", 10);
  write(path.join(dirs.from, "skills", "deploy", "SKILL.md"), "deploy", 10);
  write(path.join(dirs.from, "agents", "tester.md"), "tester", 10);
  write(path.join(dirs.to, "skills", "review", "SKILL.md"), "review v1", 5);
  fs.utimesSync(path.join(dirs.to, "skills", "review"), at(5), at(5));
  write(path.join(dirs.to, "skills", "mine", "SKILL.md"), "mine", 5);
  const result = await sync(dirs, { skills: true });
  assert.equal(result.entries, 3);
  assert.equal(
    fs.readFileSync(path.join(dirs.to, "skills", "review", "SKILL.md"), "utf8"),
    "review v2",
  );
  assert.equal(
    fs.readFileSync(path.join(dirs.to, "skills", "deploy", "SKILL.md"), "utf8"),
    "deploy",
  );
  assert.equal(
    fs.readFileSync(path.join(dirs.to, "skills", "mine", "SKILL.md"), "utf8"),
    "mine",
  );
  assert.equal(
    fs.readFileSync(path.join(dirs.to, "agents", "tester.md"), "utf8"),
    "tester",
  );
  assert.equal(
    fs.readFileSync(
      path.join(result.backup!, "skills", "review", "SKILL.md"),
      "utf8",
    ),
    "review v1",
  );
  assert.deepEqual(fs.readdirSync(path.join(dirs.to, "skills")).sort(), [
    "deploy",
    "mine",
    "review",
  ]);
  // Copied as is, a second switch carries nothing.
  assert.equal((await sync(dirs, { skills: true })).entries, 0);
});

test("CLAUDE.md: newer wins with a backup, older stays", async (t) => {
  const dirs = temp(t);
  write(path.join(dirs.from, "CLAUDE.md"), "use tabs", 10);
  write(path.join(dirs.to, "CLAUDE.md"), "use spaces", 5);
  const result = await sync(dirs, { claudeMd: true });
  assert.equal(result.claudeMd, true);
  assert.equal(
    fs.readFileSync(path.join(dirs.to, "CLAUDE.md"), "utf8"),
    "use tabs",
  );
  assert.equal(
    fs.readFileSync(path.join(result.backup!, "CLAUDE.md"), "utf8"),
    "use spaces",
  );
  write(path.join(dirs.from, "CLAUDE.md"), "older", 1);
  assert.equal((await sync(dirs, { claudeMd: true })).claudeMd, false);
  assert.equal(
    fs.readFileSync(path.join(dirs.to, "CLAUDE.md"), "utf8"),
    "use tabs",
  );
});

test("nothing is chosen: nothing changes", async (t) => {
  const dirs = temp(t);
  write(path.join(dirs.from, ".claude.json"), { mcpServers: { vertex } });
  write(path.join(dirs.from, "CLAUDE.md"), "rules");
  const result = await sync(dirs, {});
  assert.deepEqual(result, {
    mcpServers: 0,
    entries: 0,
    settings: 0,
    claudeMd: false,
    failed: [],
  });
  assert.deepEqual(fs.readdirSync(dirs.to), []);
});

test("an unreadable config is left alone and named, while the other items still sync", async (t) => {
  const dirs = temp(t);
  write(path.join(dirs.from, ".claude.json"), { mcpServers: { vertex } });
  write(path.join(dirs.to, ".claude.json"), "{broken");
  write(path.join(dirs.from, "CLAUDE.md"), "rules");
  const result = await sync(dirs);
  assert.deepEqual(result.failed, ["mcpServers"]);
  assert.equal(
    fs.readFileSync(path.join(dirs.to, ".claude.json"), "utf8"),
    "{broken",
  );
  assert.equal(result.claudeMd, true);
});

test("backups are pruned to the newest 10", async (t) => {
  assert.equal(CONFIG_SYNC_BACKUP_LIMIT, 10);
  const dirs = temp(t);
  for (let i = 0; i < 12; i++)
    fs.mkdirSync(
      path.join(
        dirs.backups,
        new Date(NOW - (20 - i) * 60_000).toISOString().replace(/[:.]/g, "-"),
      ),
      {
        recursive: true,
      },
    );
  // An unrelated folder is never touched.
  fs.mkdirSync(path.join(dirs.backups, "keep-me"));
  write(path.join(dirs.from, "CLAUDE.md"), "new", 10);
  write(path.join(dirs.to, "CLAUDE.md"), "old", 5);
  const result = await sync(dirs, { claudeMd: true });
  const left = fs
    .readdirSync(dirs.backups)
    .filter((n) => n !== "keep-me")
    .sort();
  assert.equal(left.length, 10);
  assert.equal(left.at(-1), path.basename(result.backup!));
  assert.ok(fs.existsSync(path.join(dirs.backups, "keep-me")));
  assert.equal(await pruneConfigSyncBackups(dirs.backups), 0);
});

test("the setting is off by default and a patch takes all four choices", () => {
  assert.deepEqual(DEFAULT_SETTINGS.configSync, {
    mcpServers: false,
    skills: false,
    settings: false,
    claudeMd: false,
  });
  assert.deepEqual(settingsPatchSchema.parse({ configSync: ALL }), {
    configSync: ALL,
  });
  assert.throws(() =>
    settingsPatchSchema.parse({ configSync: { mcpServers: true } }),
  );
  assert.throws(() =>
    settingsPatchSchema.parse({ configSync: { ...ALL, oauth: true } }),
  );
});

test("a Desktop switch carries account A's MCP server into account B's profile", async (t) => {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "relay-config-sync-switch-"),
  );
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "Claude");
  await fsp.mkdir(root);
  const store = new Store(path.join(dir, "Relay"));
  let running = false;
  const host: DesktopHost = {
    available: async () => true,
    running: async () => running,
    quit: async () => {
      running = false;
    },
    launch: async () => {
      running = true;
    },
    seal: (s) =>
      Buffer.from("TEST-ENCRYPTED:" + Buffer.from(s).toString("base64")),
    unseal: (b) => Buffer.from(b.toString().slice(15), "base64").toString(),
    draftScratchDir: path.join(dir, "tmp"),
  };
  const manager = new DesktopManager(
    root,
    store,
    host,
    path.join(dir, ".claude"),
  );
  await manager.initialize();
  const events: string[] = [];
  manager.onDraftEvent = (event) => events.push(event);
  const account = async (name: string) => {
    const created = store.create({ name, kind: "personal" });
    const accountUuid = randomUUID(),
      orgId = randomUUID();
    await writeBytes(
      root,
      "config.json",
      jsonBytes({
        "oauth:tokenCacheV2": `encrypted:${name}`,
        lastKnownAccountUuid: accountUuid,
      }),
    );
    await fsp.mkdir(
      path.join(root, "claude-code-sessions", accountUuid, orgId),
      { recursive: true },
    );
    await writeBytes(root, "Cookies", Buffer.from(`cookie-${name}`));
    await manager.capture(created.id, orgId);
    return store.account(created.id);
  };
  const a = await account("Vertex");
  const b = await account("Alto"); // Alto is open in Claude
  await manager.switchTo(a.id);
  write(path.join(store.profile(a.id), ".claude.json"), {
    mcpServers: { vertex },
  });

  // Off by default: the switch to B leaves B's profile alone.
  await manager.switchTo(b.id);
  assert.equal(
    fs.existsSync(path.join(store.profile(b.id), ".claude.json")),
    false,
  );

  await manager.switchTo(a.id);
  store.update((s) => {
    s.settings.configSync = {
      ...ALL,
      skills: false,
      settings: false,
      claudeMd: false,
    };
  });
  await manager.switchTo(b.id);
  assert.deepEqual(
    json(path.join(store.profile(b.id), ".claude.json")).mcpServers,
    { vertex },
  );
  assert.ok(events.includes("config-sync"));
});

test("Settings → Switching shows the four choices, off by default", () => {
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ConfigSyncPreference, {
        settings: { ...DEFAULT_SETTINGS, configSync: undefined },
        update: () => {},
        disabled: false,
        t: testT("en"),
      }),
    ),
  );
  assert.match(html, /Same setup in every account/);
  for (const key of ["mcpServers", "skills", "settings", "claudeMd"])
    assert.match(
      html,
      new RegExp(
        `id="config-sync-${key}"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="config-sync-${key}"`,
      ),
    );
  assert.match(
    html,
    /MCP servers[\s\S]*Skills and agents[\s\S]*Claude Code settings[\s\S]*CLAUDE\.md/,
  );
  const source = fs.readFileSync(
    new URL("../src/pages/settings/SwitchingTabs.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<ConfigSyncPreference settings=\{settings\} update=\{update\}/,
  );
});
