import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import { callbackHtml, listenOAuthCallback } from "../electron/core/oauth-callback-server";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("Relay answers the redirect itself: hands the address on, shows its own page, then stops listening", async () => {
  const port = await freePort();
  const seen: string[] = [];
  const server = await listenOAuthCallback({
    port,
    path: "/oauth-callback",
    timeoutMs: 60_000,
    handle: async (address) => {
      seen.push(address);
      return { title: "Giriş alındı", body: "Relay’e dönebilirsin <script>" };
    },
  });
  assert.ok(server);
  // Anything but the callback path is not answered.
  const other = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
  assert.equal(other.status, 404);
  const response = await fetch(`http://127.0.0.1:${port}/oauth-callback?state=abc12345&code=4/x`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /<h1>Giriş alındı<\/h1>/);
  // Text is escaped, never markup.
  assert.match(html, /Relay’e dönebilirsin &lt;script&gt;/);
  assert.doesNotMatch(html, /Authentication successful/);
  assert.deepEqual(seen, [`http://localhost:${port}/oauth-callback?state=abc12345&code=4/x`]);
  // One sign-in, one callback: the port is free again shortly after.
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth-callback?state=again`));
  server.close();
});

test("a taken port is left alone so the helper's own forwarder can take the redirect", async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as net.AddressInfo).port;
  const server = await listenOAuthCallback({ port, path: "/oauth-callback", timeoutMs: 1_000, handle: async () => ({ title: "", body: "" }) });
  assert.equal(server, undefined);
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

test("a failed hand-off still answers the browser with Relay's page", async () => {
  const port = await freePort();
  const server = await listenOAuthCallback({
    port,
    path: "/oauth-callback",
    timeoutMs: 60_000,
    handle: async () => {
      throw new Error("boom");
    },
  });
  const response = await fetch(`http://127.0.0.1:${port}/oauth-callback?state=x`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /boom/);
  server?.close();
});

test("the page follows the system appearance and closes itself", () => {
  const html = callbackHtml({ title: "Signed in", body: "You can go back to Relay." });
  assert.match(html, /color-scheme:light dark/);
  assert.match(html, /window\.close\(\)/);
});

test("main listens on Google's port before it asks for the sign-in address, and only falls back to the forwarder", () => {
  const main = fs.readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /const ANTIGRAVITY_CALLBACK_PORT = 51121;/);
  assert.match(main, /const callback = await listenOAuthCallback\(\{[\s\S]*?await bridge\.submitCallback\(expected, address\);[\s\S]*?showWindow\(\);[\s\S]*?const \{ state, url \} = await bridge\.beginOAuth\(\{ forwarder: !callback \}\);/);
  const bridge = fs.readFileSync(new URL("../electron/core/antigravity-bridge.ts", import.meta.url), "utf8");
  assert.match(bridge, /`\/oauth\/auth-url\?provider=antigravity\$\{forwarder \? "&is_webui=true" : ""\}`/);
});
