import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayRequestLog } from "../electron/core/gateway-request-log";

test("the request log adds up today's answers by request class, the costliest first", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-class-share-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const log = new GatewayRequestLog(path.join(dir, "gateway-requests.jsonl"), { now: () => now });
  log.load();
  log.record({ at: now, status: 200, requestClass: "main", tokens: { input: 2, cacheRead: 1000, output: 10 }, cost: 0.02 });
  log.record({ at: now, status: 200, requestClass: "subagent", tokens: { input: 5, cacheWrite: 30_000, output: 400 }, cost: 0.31 });
  log.record({ at: now, status: 200, requestClass: "subagent", tokens: { input: 5, cacheWrite: 20_000, output: 100 }, cost: 0.2 });
  log.record({ at: now, status: 429, requestClass: "main" });
  log.record({ at: now - 2 * 86_400_000, status: 200, requestClass: "main", tokens: { input: 1 }, cost: 9 });
  assert.deepEqual(log.todayByClass(), [
    { requestClass: "subagent", requests: 2, tokens: 50_510, cost: 0.51 },
    { requestClass: "main", requests: 1, tokens: 1012, cost: 0.02 },
  ]);
  // Read back after a restart.
  const again = new GatewayRequestLog(path.join(dir, "gateway-requests.jsonl"), { now: () => now });
  again.load();
  assert.deepEqual(again.todayByClass().map((s) => s.requestClass), ["subagent", "main"]);
});
