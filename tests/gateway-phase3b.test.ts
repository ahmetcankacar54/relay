import test from "node:test";
import assert from "node:assert/strict";
import { calibrateLimits, slotCostBetween, type CostSlots } from "../shared/limit-calibration";
import { withMoveCost } from "../shared/proxy-status";
import { requestDetail, sessionCacheLine, windowShare } from "../src/lib/proxy-ui";
import type { UsageSample } from "../shared/usage-statistics";
import { testT } from "./i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const day = "2026-11-12";
const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 12, hour, minute);
const sample = (accountId: string, time: number, percent: number, resetHour: number): UsageSample => ({
  accountId,
  identity: accountId,
  checkedAt: new Date(time).toISOString(),
  fiveHour: { usedPercent: percent, resetsAt: new Date(at(resetHour)).toISOString() },
});
/** One cost per quarter hour from `from` to `to` (hours, UTC) for `who`. */
function spend(slots: CostSlots, who: string, from: number, to: number, perQuarter: number) {
  slots[day] ??= {};
  slots[day][who] ??= {};
  for (let q = from * 4; q < to * 4; q++) slots[day][who][String(q)] = { cost: perQuarter };
}

test("cost between two times takes each quarter hour's share that falls inside", () => {
  const slots: CostSlots = {};
  spend(slots, "acct:a", 9, 10, 4);
  assert.equal(slotCostBetween(slots, ["acct:a"], at(9), at(10), "UTC"), 16);
  assert.equal(slotCostBetween(slots, ["acct:a"], at(9, 7, ) + 30_000, at(9, 15), "UTC"), 4 * 0.5);
  assert.equal(slotCostBetween(slots, ["acct:b"], at(9), at(10), "UTC"), 0);
});

test("an account's dollars per percent come from windows its own spending explains", () => {
  const slots: CostSlots = {};
  const samples: UsageSample[] = [];
  // Window 1, 00–05: 20 % for $40 (2.0 $/%).
  samples.push(sample("a", at(0, 30), 10, 5), sample("a", at(4, 30), 30, 5));
  spend(slots, "acct:a", 0.5, 4.5, 2.5);
  // Window 2, 05–10: 30 % for $66 (2.2 $/%), part of it estimated.
  samples.push(sample("a", at(5, 30), 0, 10), sample("a", at(9, 30), 30, 10));
  spend(slots, "est:a", 5.5, 9.5, 4.125);
  // Window 3, 10–15: 25 % while most spending sat in "terminal": left out.
  samples.push(sample("a", at(10, 30), 0, 15), sample("a", at(14, 30), 25, 15));
  spend(slots, "acct:a", 10.5, 14.5, 0.5);
  spend(slots, "terminal", 10.5, 14.5, 3);
  // Window 4, 15–20: 60 % with $3 in the table (claude.ai chats): far below the others, left out.
  samples.push(sample("a", at(15, 30), 0, 20), sample("a", at(19, 30), 60, 20));
  spend(slots, "acct:a", 15.5, 19.5, 0.1875);
  // Window 5, 20–24: 2 % is too small a rise to say anything.
  samples.push(sample("a", at(20, 30), 0, 25), sample("a", at(23, 30), 2, 25));
  spend(slots, "acct:a", 20.5, 23.5, 1);

  const result = calibrateLimits({ samples, slots, zone: "UTC", now: at(23, 59) });
  assert.deepEqual(result.a, { accountId: "a", dollarsPerPercent: 2.12, windows: 2, percent: 50, cost: 106 });

  // One window is not enough.
  const one = calibrateLimits({ samples: samples.slice(0, 2), slots, zone: "UTC", now: at(23, 59) });
  assert.equal(one.a, undefined);
  // Readings older than the period are not used.
  assert.deepEqual(calibrateLimits({ samples, slots, zone: "UTC", now: at(23, 59) + 8 * 24 * HOUR }), {});
});

test("moving a session costs its prompt at the write price, and a share of the other accounts' windows", () => {
  const calibrations = {
    a: { accountId: "a", dollarsPerPercent: 2.8, windows: 6, percent: 200, cost: 560 },
    b: { accountId: "b", dollarsPerPercent: 1.5, windows: 5, percent: 200, cost: 300 },
    c: { accountId: "c", dollarsPerPercent: 2.0, windows: 3, percent: 50, cost: 100 },
  };
  const session = { id: "6cf63d7f", accountId: "a", model: "claude-opus-5-5", lastAt: 0, prefixTokens: 200_000, ttlMs: HOUR, requests: 4, subagents: 0, misses: 0 };
  const moved = withMoveCost(session, calibrations);
  // Opus 5.5 writes an hour's cache at $8 per million tokens, five minutes' at $5.
  assert.equal(moved.moveCost?.dollars, 1.6);
  // The median of B and C (the lower of the two middle ones): 1.5.
  assert.equal(moved.moveCost?.percent, 1.07);
  const fiveMinutes = withMoveCost({ ...session, ttlMs: 5 * MINUTE }, calibrations);
  assert.equal(fiveMinutes.moveCost?.dollars, 1);
  assert.equal(withMoveCost(session, {}).moveCost?.percent, undefined, "no calibration, no share");
  assert.equal(withMoveCost(session, { a: calibrations.a }).moveCost?.percent, 0.57, "only its own: that one");
  assert.equal(withMoveCost({ ...session, model: "mystery-model" }, calibrations).moveCost, undefined);
});

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
