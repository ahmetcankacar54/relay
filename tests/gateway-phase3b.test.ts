import test from "node:test";
import assert from "node:assert/strict";
import { requestDetail, sessionCacheLine, windowShare } from "../src/lib/proxy-ui";
import { testT } from "./i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("the page words a move's cost and a miss's share of the 5-hour window", () => {
  const tr = testT("tr");
  const en = testT("en");
  assert.equal(windowShare(0.43, tr, "tr-TR"), "~%0,4");
  assert.equal(windowShare(0.04, en, "en-US"), "<0.1%");
  assert.equal(windowShare(12.4, en, "en-US"), "~12%");
  const now = Date.UTC(2026, 10, 13, 12);
  const session = { lastAt: now - 10 * MINUTE, ttlMs: HOUR, prefixTokens: 200_000, subagents: 0, misses: 0, moveCost: { dollars: 2, percent: 1.33 } };
  assert.equal(
    sessionCacheLine(session, now, tr, "tr-TR").detail,
    "10 dk önce · 200K token önbellekte (1 saatlik) · başka hesaba taşınırsa ≈ $2,00, 5 saatlik limitte ~%1,3",
  );
  assert.equal(
    sessionCacheLine({ ...session, lastAt: now - 2 * HOUR }, now, en, "en-US").detail,
    "2 h ago · coming back writes ~200K tokens again (≈ $2.00, ~1.3% of a 5-hour window)",
  );
  assert.equal(
    requestDetail({ cost: 0.6, miss: { reason: "account", tokens: 94_000 } }, tr, "tr-TR", 1.5),
    "≈ $0,60 · önbellek ıskası (hesap değişti), ~94K yeniden yazıldı, 5 saatlik limitte ~%0,4",
  );
});
