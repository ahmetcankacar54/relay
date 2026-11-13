import test from "node:test";
import assert from "node:assert/strict";
import { classShareLine, requestDetail, sessionCacheLine } from "../src/lib/proxy-ui";

const tr = (a: string) => a;
const en = (_a: string, b: string) => b;
const MINUTE = 60_000;

test("a session's cache reads as warm with its minutes left, or cold with what coming back writes", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const session = { lastAt: now - 18 * MINUTE, ttlMs: 60 * MINUTE, prefixTokens: 183_600, subagents: 2, misses: 1, lastMiss: { reason: "account" } };
  assert.deepEqual(sessionCacheLine(session, now, tr, "tr-TR"), {
    warm: true,
    state: "sıcak · 42 dk",
    detail: "18 dk önce · 183,6K token önbellekte (1 saatlik) · 2 alt ajan · 1 ıska, son: hesap değişti",
  });
  assert.deepEqual(sessionCacheLine({ ...session, ttlMs: 5 * MINUTE, subagents: 0, misses: 0 }, now, en, "en-US"), {
    warm: false,
    state: "cold",
    detail: "18 min ago · coming back writes ~183.6K tokens again",
  });
});

test("today's traffic by class is shared by API-price cost, or by tokens when nothing has a price", () => {
  const shares = [
    { requestClass: "subagent", tokens: 50_000, cost: 0.51 },
    { requestClass: "main", tokens: 900_000, cost: 0.47 },
    { requestClass: "other", tokens: 10, cost: 0.02 },
  ];
  assert.equal(classShareLine(shares, tr), "Bugün, API fiyatıyla: alt ajan %51 · ana konuşma %47 · diğer %2");
  assert.equal(
    classShareLine(shares.map((s) => ({ ...s, cost: 0 })), en),
    "Today, in tokens: subagent 5% · main 95%",
  );
  assert.equal(classShareLine([], en), "");
});

test("a request's detail adds its API-price cost and a cache miss with its reason", () => {
  assert.equal(
    requestDetail({ client: "claude-code", requestClass: "main", ms: 2_700, cost: 0.4312, miss: { reason: "expired", tokens: 183_000 } }, tr, "tr-TR"),
    "Claude Code · ana konuşma · 2,7 sn · ≈ $0,43 · önbellek ıskası (süresi doldu), ~183K yeniden yazıldı",
  );
  assert.equal(requestDetail({ cost: 0.0042 }, en, "en-US"), "≈ $0.004");
});
