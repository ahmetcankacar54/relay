import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityBridge } from "../electron/core/antigravity-bridge";

test("Antigravity OAuth bridge starts isolated, waits for Google, then accepts only a saved OAuth credential", async (t) => {
  if (process.platform === "win32") return t.skip("fake executable uses a Unix shebang");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-antigravity-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, "fake-proxy");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const text = fs.readFileSync(process.argv[3], 'utf8');
const port = Number(/  port: (\\d+)/.exec(text)[1]);
const authDir = JSON.parse(/  auth-dir: (.*)/.exec(text)[1]);
let count = 0;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end('{"data":[]}');
  if (req.url.startsWith('/v8/management/oauth/auth-url'))
    return res.end(JSON.stringify({status:'ok', state:'validstate123', url:'https://accounts.google.com/o/oauth2/v2/auth?state=validstate123'}));
  if (req.url.startsWith('/v8/management/oauth/status')) {
    if (++count === 1) return res.end('{"status":"wait"}');
    fs.writeFileSync(authDir + '/antigravity-tester.json', JSON.stringify({type:'antigravity',email:'tester@example.com',refresh_token:'refresh',project_id:'project'}));
    return res.end('{"status":"ok","auth_id":"antigravity-tester.json"}');
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(port, '127.0.0.1');
`, { mode: 0o700 });
  const bridge = new AntigravityBridge(path.join(root, "profile"), path.join(root, "tools"), async () => fake);
  t.after(() => bridge.stop());
  fs.mkdirSync(bridge.profileDir, { recursive: true });
  await bridge.start();
  assert.equal(bridge.endpoint?.url.startsWith("http://127.0.0.1:"), true);
  assert.equal(await bridge.hasCredential(), false);
  const login = await bridge.beginOAuth();
  assert.equal(new URL(login.url).hostname, "accounts.google.com");
  assert.deepEqual(await bridge.pollOAuth(login.state), { status: "wait" });
  assert.deepEqual(await bridge.pollOAuth(login.state), { status: "ok", email: "tester@example.com" });
  assert.equal(await bridge.hasCredential(), true);
  const config = fs.statSync(path.join(bridge.profileDir, "antigravity-proxy.yaml"));
  assert.equal(config.mode & 0o077, 0, "local management key must not be world-readable");
});
