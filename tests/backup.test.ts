import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BackupError,
  collectBackup,
  importBackup,
  openBackup,
  readBackupHeader,
  sealBackup,
  summarizeBackup,
  type BackupContext,
  type BackupHost,
  type ClaudeCodeSignIns,
} from "../electron/core/backup";
import { Store } from "../electron/core/store";
import { createSealer } from "../electron/core/vault-crypto";
import { DEFAULT_PROXY_CONFIG, type ProxyConfig } from "../shared/proxy-types";

/** Fast parameters: the tests check the format, not scrypt's cost. */
const FAST = { logN: 10, r: 8, p: 1 };
const PASS = "correct horse battery";
const GATEWAY: ProxyConfig = { ...DEFAULT_PROXY_CONFIG, port: 9411, apiKey: "relay-test-key", accountOrder: [] };

/** Claude Code's credentials kept in memory by profile path, as one computer's Keychain would. */
function fakeKeychain(): ClaudeCodeSignIns & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    read: async (profile) => items.get(profile),
    write: async (profile, value) => {
      items.set(profile, value);
    },
  };
}

/** One computer: its own data folder, vault key and Keychain. */
function machine(name: string) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `relay-backup-${name}-`));
  const keychain = fakeKeychain();
  const host: BackupHost = { data, sealer: createSealer(crypto.randomBytes(32)), claudeCode: keychain };
  const context: BackupContext = { host, relayVersion: "0.29.0", platform: "darwin", now: () => Date.parse("2026-11-23T10:00:00Z") };
  const store = new Store(data, { backupOnOpen: false });
  return { data, keychain, host, context, store };
}

const desktopUuid = "11111111-2222-4333-8444-555555555555";

/** Machine A with a Claude account (Claude app and Claude Code sign-ins) and a Codex account. */
function seeded() {
  const a = machine("a");
  const vertex = a.store.create({ name: "Vertex", kind: "work", group: "Alto" });
  const codex = a.store.create({ name: "Alto Codex", kind: "personal", provider: "codex" });
  a.store.update((state) => {
    state.settings.usageWarningPercent = 95;
    state.settings.riskAcknowledged = { "early-start": 1 };
    state.settings.planning = { ...state.settings.planning, autoStart: true };
    const account = state.accounts.find((item) => item.id === vertex.id)!;
    account.desktop = { accountUuid: desktopUuid, orgId: "22222222-3333-4444-8555-666666666666", savedAt: "2026-11-20T10:00:00.000Z" };
    account.auth = { loggedIn: true, email: "vertex@example.com", checkedAt: "2026-11-20T10:00:00.000Z" };
  });
  const login = JSON.stringify({ accountUuid: desktopUuid, auth: { oauthAccount: "vertex" }, cookies: { Cookies: "c2VjcmV0" } });
  fs.mkdirSync(path.join(a.data, "desktop-vault", "accounts"), { recursive: true });
  fs.writeFileSync(path.join(a.data, "desktop-vault", "accounts", `${desktopUuid}.bin`), a.host.sealer.seal(login));
  const vertexProfile = path.join(a.data, "profiles", vertex.id);
  fs.writeFileSync(path.join(vertexProfile, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "vertex@example.com" } }));
  a.keychain.items.set(vertexProfile, JSON.stringify({ claudeAiOauth: { accessToken: "at-vertex", refreshToken: "rt-vertex" } }));
  const codexProfile = path.join(a.data, "profiles", codex.id);
  fs.writeFileSync(path.join(codexProfile, "provider-credential.json"), JSON.stringify({ provider: "codex", accessToken: "at-codex" }));
  return { a, vertex, codex, login };
}

test("a backup with sign-ins moves accounts, settings and sign-ins to a computer with another vault key", async () => {
  const { a, vertex, codex, login } = seeded();
  const payload = await collectBackup(
    { settings: a.store.state.settings, accounts: a.store.state.accounts, gateway: GATEWAY },
    true,
    a.context,
  );
  const file = await sealBackup(payload, PASS, FAST);
  assert.ok(!file.includes(Buffer.from("at-vertex")), "nothing secret is readable in the file");
  assert.ok(!file.includes(Buffer.from("Vertex")), "account names are sealed too");

  const b = machine("b");
  const opened = await openBackup(file, PASS);
  const summary = summarizeBackup(opened.payload, b.store.state.accounts);
  assert.deepEqual(
    summary.accounts.map(({ name, provider, signIn, present }) => ({ name, provider, signIn, present })),
    [
      { name: "Vertex", provider: "claude", signIn: true, present: false },
      { name: "Alto Codex", provider: "codex", signIn: true, present: false },
    ],
  );
  const { result, gateway } = await importBackup(opened, "replace", b.store, DEFAULT_PROXY_CONFIG, b.context);
  assert.equal(result.added, 2);
  assert.equal(result.signIns, 2);
  assert.equal(result.signInsFailed, 0);
  assert.deepEqual(gateway, { port: 9411, routingStrategy: GATEWAY.routingStrategy, affinityTtlSeconds: GATEWAY.affinityTtlSeconds, accountOrder: [], apiKey: "relay-test-key" });

  // The registry and settings came over; the accepted risk notes and the gateway stay this computer's.
  const reopened = new Store(b.data, { backupOnOpen: false });
  assert.deepEqual(reopened.state.accounts.map((x) => x.id), [vertex.id, codex.id]);
  assert.equal(reopened.state.accounts[0].auth?.email, "vertex@example.com");
  assert.equal(reopened.state.accounts[0].auth?.loggedIn, true);
  assert.equal(reopened.state.settings.usageWarningPercent, 95);
  assert.deepEqual(reopened.state.settings.riskAcknowledged, {});
  assert.equal(reopened.state.settings.planning.autoStart, false, "early start waits for its risk note here");

  // The Claude app sign-in is sealed with B's key: B opens it, A's key cannot.
  const sealed = fs.readFileSync(path.join(b.data, "desktop-vault", "accounts", `${desktopUuid}.bin`));
  assert.equal(b.host.sealer.unseal(sealed), login);
  assert.throws(() => a.host.sealer.unseal(sealed));

  // Claude Code's credential lands under B's profile path; the profile files follow.
  const vertexProfile = path.join(b.data, "profiles", vertex.id);
  assert.match(b.keychain.items.get(vertexProfile) ?? "", /at-vertex/);
  assert.match(fs.readFileSync(path.join(vertexProfile, ".claude.json"), "utf8"), /vertex@example\.com/);
  assert.match(fs.readFileSync(path.join(b.data, "profiles", codex.id, "provider-credential.json"), "utf8"), /at-codex/);
});

test("a backup without sign-ins carries no secret, and its accounts arrive signed out", async () => {
  const { a, vertex } = seeded();
  const payload = await collectBackup(
    { settings: a.store.state.settings, accounts: a.store.state.accounts, gateway: GATEWAY },
    false,
    a.context,
  );
  assert.equal(payload.sessions, undefined);
  assert.equal(payload.gateway?.apiKey, undefined);
  const file = await sealBackup(payload, PASS, FAST);
  const b = machine("b");
  const opened = await openBackup(file, PASS);
  assert.equal(summarizeBackup(opened.payload, []).signIns, false);
  const { result } = await importBackup(opened, "merge", b.store, DEFAULT_PROXY_CONFIG, b.context);
  assert.deepEqual([result.added, result.signIns, result.before], [2, 0, undefined]);
  const account = b.store.state.accounts.find((x) => x.id === vertex.id)!;
  assert.equal(account.auth?.loggedIn, false);
  assert.equal(account.desktop?.accountUuid, desktopUuid);
  assert.ok(fs.statSync(path.join(b.data, "profiles", vertex.id)).isDirectory());
  assert.equal(fs.existsSync(path.join(b.data, "desktop-vault", "accounts")), false);
  assert.equal(b.keychain.items.size, 0);
});

test("a wrong passphrase and a changed file are refused, never partly read", async () => {
  const { a } = seeded();
  const payload = await collectBackup(
    { settings: a.store.state.settings, accounts: a.store.state.accounts, gateway: GATEWAY },
    true,
    a.context,
  );
  const file = await sealBackup(payload, PASS, FAST);
  const refused = (reason: string) => (error: unknown) => error instanceof BackupError && error.reason === reason;
  await assert.rejects(openBackup(file, "not the passphrase"), refused("wrong-passphrase"));
  for (const at of [10, 30, 60, file.length - 5]) {
    const changed = Buffer.from(file);
    changed[at] ^= 1;
    await assert.rejects(openBackup(changed, PASS), refused("wrong-passphrase"), `byte ${at}`);
  }
  await assert.rejects(openBackup(file.subarray(0, 40), PASS), refused("damaged"));
  await assert.rejects(sealBackup(payload, "short", FAST), refused("short-passphrase"));
});

test("the format is checked before the passphrase is asked", async () => {
  const { a } = seeded();
  const payload = await collectBackup(
    { settings: a.store.state.settings, accounts: a.store.state.accounts, gateway: GATEWAY },
    false,
    a.context,
  );
  const file = await sealBackup(payload, PASS, FAST);
  assert.deepEqual(readBackupHeader(file).params, FAST);
  const newer = Buffer.from(file);
  newer[4] = 2;
  assert.throws(() => readBackupHeader(newer), (e: unknown) => e instanceof BackupError && e.reason === "newer-format");
  await assert.rejects(openBackup(newer, PASS), (e: unknown) => e instanceof BackupError && e.reason === "newer-format");
  assert.throws(() => readBackupHeader(Buffer.from('{"kind":"relay-backup"}')), (e: unknown) => e instanceof BackupError && e.reason === "not-a-backup");
  const greedy = Buffer.from(file);
  greedy[5] = 24;
  assert.throws(() => readBackupHeader(greedy), (e: unknown) => e instanceof BackupError && e.reason === "damaged");
});

test("a replace first saves what was here with the same passphrase; a merge skips accounts already here", async () => {
  const { a, vertex } = seeded();
  const payload = await collectBackup(
    { settings: a.store.state.settings, accounts: a.store.state.accounts, gateway: GATEWAY },
    true,
    a.context,
  );
  const file = await sealBackup(payload, PASS, FAST);

  const b = machine("b");
  const local = b.store.create({ name: "Example", kind: "personal" });
  const localProfile = path.join(b.data, "profiles", local.id);
  b.keychain.items.set(localProfile, JSON.stringify({ claudeAiOauth: { accessToken: "at-local" } }));
  b.store.update((state) => {
    state.settings.usageWarningPercent = 80;
  });

  const merged = await importBackup(await openBackup(file, PASS), "merge", b.store, DEFAULT_PROXY_CONFIG, b.context);
  assert.equal(merged.result.added, 2);
  assert.equal(b.store.state.settings.usageWarningPercent, 80, "a merge keeps this computer's settings");
  const again = await importBackup(await openBackup(file, PASS), "merge", b.store, DEFAULT_PROXY_CONFIG, b.context);
  assert.deepEqual([again.result.added, again.result.skipped], [0, 2]);
  assert.equal(summarizeBackup(payload, b.store.state.accounts).accounts.every((x) => x.present), true);

  const replaced = await importBackup(await openBackup(file, PASS), "replace", b.store, DEFAULT_PROXY_CONFIG, b.context);
  assert.ok(replaced.result.before);
  assert.deepEqual(b.store.state.accounts.map((x) => x.name), ["Vertex", "Alto Codex"]);
  assert.equal(b.store.state.settings.usageWarningPercent, 95);
  assert.ok(fs.existsSync(localProfile), "the dropped account's files stay on disk");

  const before = fs.readFileSync(path.join(b.data, "relay-backups", replaced.result.before!));
  const kept = await openBackup(before, PASS);
  assert.deepEqual(kept.payload.accounts.map((x) => x.name), ["Example", "Vertex", "Alto Codex"]);
  assert.equal((kept.payload.settings as { usageWarningPercent: number }).usageWarningPercent, 80);
  assert.match(kept.payload.sessions?.claudeCode[local.id] ?? "", /at-local/);
  assert.ok(kept.payload.accounts.some((x) => x.id === vertex.id));
});
