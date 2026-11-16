import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  TerminalSwitcher,
  TerminalVault,
  credentialsFile,
  linuxTerminalPorts,
  macTerminalPorts,
} from "../electron/core/terminal-identity";
import { createSealer } from "../electron/core/vault-crypto";

const oauth = (n: number) => ({
  accessToken: `sk-ant-oat01-access-${n}`,
  refreshToken: `sk-ant-ort01-refresh-${n}`,
  expiresAt: 1_900_000_000_000 + n,
  scopes: ["user:inference", "user:profile"],
  subscriptionType: "team",
});

const tempHome = (t: { after: (fn: () => void) => void }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-terminal-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("the Linux ports are the plain claude's, on Linux only", (t) => {
  const home = tempHome(t);
  assert.equal(linuxTerminalPorts(home, "darwin"), undefined);
  assert.equal(linuxTerminalPorts(home, "win32"), undefined);
  assert.equal(macTerminalPorts(home, "linux"), undefined);
  assert.ok(linuxTerminalPorts(home, "linux"));
});

test("the credentials file is read, written privately and atomically, and removed", async (t) => {
  const home = tempHome(t);
  const dir = path.join(home, ".claude");
  const file = path.join(dir, ".credentials.json");
  const item = linuxTerminalPorts(home, "linux")!.keychain;
  // No folder yet: nothing signed in; a write makes the folder private too.
  assert.equal(await item.read(), undefined);
  await item.write(JSON.stringify({ claudeAiOauth: oauth(1) }));
  assert.equal(mode(file), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.deepEqual(JSON.parse((await item.read())!).claudeAiOauth, oauth(1));
  // A file Claude Code left readable becomes private at the next write, and nothing is left beside it.
  fs.chmodSync(file, 0o644);
  await item.write(JSON.stringify({ claudeAiOauth: oauth(2) }));
  assert.equal(mode(file), 0o600);
  assert.deepEqual(fs.readdirSync(dir), [".credentials.json"]);
  await item.remove();
  assert.equal(await item.read(), undefined);
  // Removing what is not there is fine, as the Keychain's "not found" is.
  await item.remove();
});

test("a link or folder where the credentials file belongs is refused, never followed or replaced", async (t) => {
  const home = tempHome(t);
  const target = path.join(home, "elsewhere.json");
  fs.writeFileSync(target, "{}");
  const file = path.join(home, ".credentials.json");
  fs.symlinkSync(target, file);
  const item = credentialsFile(file);
  await assert.rejects(item.read(), (e: any) => e.reason === "unreadable");
  await assert.rejects(item.write("{}"), (e: any) => e.reason === "write-failed");
  await assert.rejects(item.remove(), (e: any) => e.reason === "write-failed");
  assert.equal(fs.readlinkSync(file), target);
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
});

test("a switch through the Linux ports keeps MCP sign-ins and other keys, and the config's other keys", async (t) => {
  const home = tempHome(t);
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, ".credentials.json");
  const a = { accountUuid: randomUUID(), orgId: randomUUID() };
  const b = { accountUuid: randomUUID(), orgId: randomUUID() };
  const account = (id: typeof a, email: string) => ({
    accountUuid: id.accountUuid,
    organizationUuid: id.orgId,
    emailAddress: email,
  });
  fs.writeFileSync(
    file,
    JSON.stringify({ claudeAiOauth: oauth(1), mcpOAuth: { server: { token: "mcp" } }, future: 1 }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ theme: "dark", oauthAccount: account(a, "a@x") }),
  );
  const owners = new Map([
    [oauth(1).accessToken, a],
    [oauth(2).accessToken, b],
  ]);
  const ports = { ...linuxTerminalPorts(home, "linux")!, owner: async (token: string) => owners.get(token) };
  const sealer = createSealer(Buffer.alloc(32, 9));
  const vault = new TerminalVault(
    path.join(home, "vault"),
    (text) => sealer.seal(text),
    (data) => sealer.unseal(data),
  );
  await vault.save(b, oauth(2), account(b, "b@x"), true);
  const outcome = await new TerminalSwitcher(ports, vault).run({
    mode: "follow",
    target: [b],
    known: [a, b],
  });
  assert.equal(outcome.result, "switched");
  const item = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(item.claudeAiOauth, oauth(2));
  assert.deepEqual(item.mcpOAuth, { server: { token: "mcp" } });
  assert.equal(item.future, 1);
  assert.equal(mode(file), 0o600);
  const config = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.equal(config.oauthAccount.emailAddress, "b@x");
  assert.equal(config.theme, "dark");
  assert.deepEqual((await vault.load([a]))?.oauth, oauth(1));
  // Claude Code's refresh locks were taken and given back.
  assert.deepEqual(fs.readdirSync(dir).sort(), [".credentials.json"]);
});
