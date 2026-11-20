import test from "node:test";
import assert from "node:assert/strict";
import { fullestByPeriod, limitHeadline, modelOnlyUsage } from "../shared/quota-windows";
import { overviewAccounts, usageWindowRows } from "../src/data/selectors";
import { panelRowLine, panelRowState, ringState } from "../src/lib/account-row";
import type { Account, AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-11-19T15:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const t = (tr: string, _en: string) => tr;

/** An Antigravity reading as the reader stores it: the five hours are the roomiest model. */
const antigravity: AccountUsage = {
  accountId: "g1",
  status: "ready",
  stale: false,
  checkedAt: at(-1),
  fiveHour: { usedPercent: 18, resetsAt: at(299) },
  modelWindows: [
    { key: "antigravity_gemini_4_carbon_high", label: "Gemini 4 Carbon (High)", usedPercent: 100, resetsAt: at(25) },
    { key: "antigravity_claude_opus_5_5", label: "Claude Opus 5.5", usedPercent: 62, resetsAt: at(190) },
    { key: "antigravity_gemini_4_argon", label: "Gemini 4 Argon", usedPercent: 18, resetsAt: at(299) },
  ],
};
const claude: AccountUsage = {
  accountId: "c1",
  status: "ready",
  stale: false,
  checkedAt: at(-1),
  fiveHour: { usedPercent: 31, resetsAt: at(130) },
  sevenDay: { usedPercent: 58, resetsAt: at(3 * 1440) },
  modelWindows: [{ key: "seven_day_fable", label: "Fable", model: "fable", usedPercent: 100, resetsAt: at(1440) }],
};

test("an Antigravity account's figure is its fullest model, never the roomiest one the gateway keeps", () => {
  assert.equal(modelOnlyUsage(antigravity), true);
  assert.equal(modelOnlyUsage(claude), false);
  assert.deepEqual(limitHeadline(antigravity, NOW), {
    key: "antigravity_gemini_4_carbon_high",
    label: "Gemini 4 Carbon (High)",
    usedPercent: 100,
    resetsAt: at(25),
    model: true,
  });
  // Once that model's reset has passed it counts as empty, and the next fullest one shows.
  assert.equal(limitHeadline(antigravity, NOW + 30 * 60_000)?.label, "Claude Opus 5.5");
});

test("a Claude account's figure is the fuller of its five hours and its week, a model's own limit aside", () => {
  assert.equal(limitHeadline(claude, NOW)?.key, "seven_day");
  assert.equal(limitHeadline({ ...claude, sevenDay: { usedPercent: 31, resetsAt: at(3 * 1440) } }, NOW)?.key, "five_hour");
  assert.equal(limitHeadline({ ...claude, sevenDay: { usedPercent: 99, resetsAt: at(-5) } }, NOW)?.key, "five_hour");
  assert.equal(limitHeadline(undefined, NOW), undefined);
});

test("Antigravity's limits list its models only, and it has no five-hour period to be open", () => {
  assert.deepEqual(
    usageWindowRows(antigravity).map((r) => r.key),
    ["antigravity_gemini_4_carbon_high", "antigravity_claude_opus_5_5", "antigravity_gemini_4_argon"],
  );
  assert.deepEqual(usageWindowRows(claude).map((r) => r.key), ["five_hour", "seven_day", "seven_day_fable"]);
  const account: Account = { id: "g1", name: "Google · Antigravity", kind: "personal", group: "personal", color: "olive", createdAt: at(-9999), provider: "antigravity", auth: { loggedIn: true, checkedAt: "2026-11-19T00:00:00Z" } };
  const [row] = overviewAccounts(undefined, [account], { g1: antigravity }, NOW);
  assert.equal(row.state, "ready");
  assert.equal(ringState(antigravity, NOW), "full");
  // The panel line names the spent model and when it opens, and shows its percent, not the roomiest model's.
  const line = panelRowLine(row, t as never, "tr", "Europe/Istanbul", NOW);
  assert.match(line, /^Gemini 4 Carbon \(High\) limiti dolu · 18:25/);
  assert.match(line, /%100$/);
});

test("the panel never offers the Claude app switch on a Codex or Antigravity row", () => {
  const relay = { desktopBusy: false, pendingDesktop: undefined, desktop: undefined, data: undefined } as never;
  for (const provider of ["codex", "antigravity"] as const) {
    const account: Account = { id: "x", name: provider, kind: "personal", group: "personal", color: "olive", createdAt: at(0), provider, auth: { loggedIn: true, checkedAt: "2026-11-19T00:00:00Z" } };
    const state = panelRowState({ account, state: "ready", recommended: false }, relay);
    assert.deepEqual(state, { canSwitch: false });
  }
});

test("Antigravity pools: the table's columns take the fullest five hours and the fullest week, named", () => {
  const usage: AccountUsage = {
    accountId: "g",
    status: "ready",
    stale: false,
    checkedAt: at(-1),
    sevenDay: { usedPercent: 40, resetsAt: at(3 * 24 * 60) },
    modelWindows: [
      { key: "antigravity_gemini_5h", label: "Gemini", period: "five_hour", usedPercent: 20, resetsAt: at(100) },
      { key: "antigravity_gemini_weekly", label: "Gemini", period: "seven_day", usedPercent: 98, resetsAt: at(4 * 24 * 60) },
      { key: "antigravity_3p_5h", label: "Claude & GPT", period: "five_hour", usedPercent: 100, resetsAt: at(-5) },
      { key: "antigravity_3p_weekly", label: "Claude & GPT", period: "seven_day", usedPercent: 40, resetsAt: at(3 * 24 * 60) },
    ],
  };
  const cols = fullestByPeriod(usage, NOW);
  // Claude & GPT's five hours have reset: empty again, so Gemini's are the fuller.
  assert.deepEqual([cols.five_hour?.label, cols.five_hour?.usedPercent], ["Gemini", 20]);
  assert.deepEqual([cols.seven_day?.label, cols.seven_day?.usedPercent], ["Gemini", 98]);
  // Rows read in the reader's order, each with its length.
  assert.deepEqual(
    usageWindowRows(usage).map((r) => [r.label.tr, r.period]),
    [
      ["Gemini · 5 saat", "five_hour"],
      ["Gemini · haftalık", "seven_day"],
      ["Claude & GPT · 5 saat", "five_hour"],
      ["Claude & GPT · haftalık", "seven_day"],
    ],
  );
  // Windows of unknown length (an older reading) give no column.
  assert.deepEqual(fullestByPeriod({ modelWindows: [{ key: "antigravity_gemini", label: "Gemini", usedPercent: 50 }] }, NOW), {});
});

