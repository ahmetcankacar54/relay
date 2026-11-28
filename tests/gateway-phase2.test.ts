import test from "node:test";
import assert from "node:assert/strict";
import { gatewayLine, requestDetail } from "../src/lib/proxy-ui";
import { testT } from "./i18n";

test("the feed says who asked, what kind of request, how long and how much was cached", () => {
  const tr = testT("tr");
  const en = testT("en");
  const entry = {
    client: "claude-code",
    requestClass: "subagent",
    ms: 1430,
    tokens: { input: 3, cacheRead: 9_000, cacheWrite: 997, output: 412 },
  };
  assert.equal(requestDetail(entry, tr, "tr-TR"), "Claude Code · alt ajan · 1,4 sn · 10K girdi, %90 önbellekten · 412 çıktı");
  assert.equal(requestDetail(entry, en, "en-US"), "Claude Code · subagent · 1.4 s · 10K in, 90% cached · 412 out");
  assert.equal(requestDetail({ client: "curl", ms: 220, note: "refused" }, en, "en-US"), "curl · 220 ms · not a limit: Anthropic turned the request down");
  assert.equal(requestDetail({}, en, "en-US"), "");
});

test("the Overview says which tools go through the gateway and where the last request went", () => {
  const en = testT("en");
  const now = Date.UTC(2026, 10, 13, 12);
  const accounts = [{ id: "a", name: "Alto" }];
  const recent = [{ at: now - 120_000, accountId: "a" }];
  const claude = { id: "claude-code", bound: true };
  assert.deepEqual(gatewayLine({ running: true, clients: [claude], recent, accounts }, en, now), {
    tone: "ok",
    text: "Claude Code goes through the gateway, not the Claude app's account · last request Alto, 2 min ago",
  });
  assert.deepEqual(gatewayLine({ running: false, clients: [claude, { id: "codex", bound: true }], accounts }, en, now), {
    tone: "crit",
    text: "Claude Code and Codex CLI are bound to the gateway, but it is off: requests fail.",
  });
  const all = [claude, { id: "codex", bound: true }, { id: "omp", bound: true }];
  assert.equal(
    gatewayLine({ running: false, clients: all, accounts }, en, now)?.text,
    "Claude Code, Codex CLI and omp are bound to the gateway, but it is off: requests fail.",
  );
  assert.equal(gatewayLine({ running: false, clients: [{ id: "codex", bound: false }], accounts }, en, now), undefined);
  assert.equal(gatewayLine({ running: true, clients: [], accounts }, en, now), undefined);
  assert.equal(gatewayLine(undefined, en, now), undefined);
});
