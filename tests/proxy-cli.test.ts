import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import { cliFixture } from "./cli-fixture";
import { parseCommand } from "../cli/src/args";

test("relay proxy takes --port and --host, and rejects bad values", async (t) => {
  assert.equal(
    parseCommand(["proxy", "env", "--port", "9000", "--host", "::1"]).flags
      .port,
    "9000",
  );
  assert.throws(
    () => parseCommand(["list", "--port", "1"]),
    /does not take --port|list/,
  );

  const f = await cliFixture(t);
  assert.equal(await f.run("proxy", "env", "--port", "9000"), 0);
  // Plain lines: usable with eval.
  assert.equal(
    f.out(),
    'export ANTHROPIC_BASE_URL="http://127.0.0.1:9000"\nexport CODEX_BASE_URL="http://127.0.0.1:9000"',
  );
  f.clear();
  assert.equal(await f.run("proxy", "env", "--host", "0.0.0.0"), 0);
  assert.match(f.out(), /http:\/\/127\.0\.0\.1:8317/);
  f.clear();
  assert.equal(await f.run("proxy", "env", "--host", "::1"), 0);
  assert.match(f.out(), /http:\/\/\[::1\]:8317/);

  for (const port of ["0", "70000", "abc", "-1"]) {
    assert.equal(await f.run("proxy", "env", "--port", port), 2, port);
  }
  assert.equal(await f.run("proxy", "frobnicate"), 2);
});

test("relay proxy status reports a running and a stopped gateway", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        state: { status: "running", activeSessionsCount: 2 },
        metrics: { totalRequests: 5, cacheHitRatio: 0.5 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });

  const f = await cliFixture(t);
  assert.equal(await f.run("proxy", "status", "--port", String(port)), 0);
  assert.match(f.out(), /is running/);
  assert.match(f.out(), /Total Requests: 5/);
  assert.match(f.out(), /Cache Hit Ratio: 50\.0%/);

  f.clear();
  assert.equal(
    await f.run("proxy", "status", "--json", "--port", String(port)),
    0,
  );
  assert.equal(JSON.parse(f.out()).running, true);

  server.close();
  server.closeAllConnections();
  f.clear();
  assert.equal(
    await f.run("proxy", "status", "--json", "--port", String(port)),
    0,
  );
  assert.equal(JSON.parse(f.out()).running, false);
});
