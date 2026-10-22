import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTokenUsageView,
  TOKEN_ROW_LABELS,
} from "../shared/token-usage-view";
import { FORMER_KEY, FORMER_NAME } from "../shared/usage-statistics-view";
import type {
  LedgerSnapshot,
  TokenCounts,
} from "../electron/core/token-ledger";
import type { Account } from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
// Wednesday 2026-10-14 15:00 in Istanbul (UTC+3).
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

const named = (id: string, name: string): Account => ({
  ...planningAccount(id, "pro"),
  name,
});
const ann = named("ann", "Ann");
const bob = named("bob", "Bob");
const accounts = [ann, bob];

const counts = (
  input: number,
  output = 0,
  cacheWrite = 0,
  cacheRead = 0,
  responses = 1,
): TokenCounts => ({
  input,
  output,
  cacheWrite,
  cacheRead,
  responses,
  cost: 0,
  unpriced: 0,
});

type Days = LedgerSnapshot["days"];
function ledger(
  days: Days,
  progress: Partial<LedgerSnapshot["progress"]> = {},
): LedgerSnapshot {
  return {
    days,
    progress: {
      scannedBytes: 100,
      totalBytes: 100,
      complete: true,
      ...progress,
    },
  };
}
const build = (
  snapshot: LedgerSnapshot,
  extra: Partial<Parameters<typeof buildTokenUsageView>[0]> = {},
) =>
  buildTokenUsageView({
    ledger: snapshot,
    accounts,
    range: 7,
    zone: ZONE,
    now: NOW,
    ...extra,
  });

test("days fill the whole range, oldest first, ending today in the zone", () => {
  const view = build(ledger({}));
  assert.equal(view.range, 7);
  assert.deepEqual(
    view.days.map((d) => d.date),
    [
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ],
  );
  assert.ok(view.days.every((d) => Object.keys(d.byRow).length === 0));
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.models, []);
  assert.deepEqual(view.totals, counts(0, 0, 0, 0, 0));
});

test("today is the date in the zone, not in UTC, and month ends are crossed", () => {
  // 21:30 UTC on 2026-10-31 is 00:30 on 2026-11-01 in Istanbul.
  const view = build(ledger({}), {
    now: Date.parse("2026-10-31T21:30:00.000Z"),
    range: 30,
  });
  assert.equal(view.days.length, 30);
  assert.equal(view.days[29].date, "2026-11-01");
  assert.equal(view.days[0].date, "2026-10-03");
  const ninety = build(ledger({}), { range: 90 });
  assert.equal(ninety.days.length, 90);
  assert.equal(ninety.days[0].date, "2026-07-17");
  assert.equal(ninety.days[89].date, "2026-10-14");
});

test("days outside the range are left out of every total", () => {
  const view = build(
    ledger({
      "2026-10-07": { "acct:ann": { m: counts(1000) } },
      "2026-10-14": { "acct:ann": { m: counts(7) } },
      "2026-10-15": { "acct:ann": { m: counts(500) } },
    }),
  );
  assert.equal(view.totals.input, 7);
  assert.equal(view.rows[0].totals.input, 7);
});

test("acct and est buckets of one account merge, marked estimated where estimated", () => {
  const view = build(
    ledger({
      "2026-10-12": {
        "acct:ann": { m: counts(100, 10, 5, 1, 2) },
        "est:ann": { m: counts(50, 5, 0, 0, 1) },
      },
      "2026-10-13": { "acct:ann": { m: counts(20, 2, 0, 0, 1) } },
      "2026-10-14": { "est:ann": { m: counts(1, 1, 1, 1, 1) } },
    }),
  );
  assert.equal(view.rows.length, 1);
  const [row] = view.rows;
  assert.equal(row.key, "ann");
  assert.equal(row.kind, "account");
  assert.equal(row.accountId, "ann");
  assert.equal(row.name, "Ann");
  assert.equal(row.estimated, true);
  assert.deepEqual(row.totals, counts(171, 18, 6, 2, 5));
  const byDate = Object.fromEntries(view.days.map((d) => [d.date, d.byRow]));
  assert.deepEqual(byDate["2026-10-12"].ann, {
    ...counts(150, 15, 5, 1, 3),
    estimated: true,
  });
  assert.deepEqual(byDate["2026-10-13"].ann, {
    ...counts(20, 2, 0, 0, 1),
    estimated: false,
  });
  assert.equal(byDate["2026-10-14"].ann.estimated, true);
  assert.deepEqual(byDate["2026-10-11"], {});
});

test("an account with only exact tokens is not estimated", () => {
  const view = build(
    ledger({ "2026-10-13": { "acct:bob": { m: counts(9) } } }),
  );
  assert.equal(view.rows[0].estimated, false);
  assert.equal(view.rows[0].name, "Bob");
});

test("ids that are not Relay accounts share one former row", () => {
  const view = build(
    ledger({
      "2026-10-12": {
        "acct:gone": { m: counts(10) },
        "est:gone2": { m: counts(5) },
      },
      "2026-10-13": { "acct:ann": { m: counts(1) } },
    }),
  );
  const former = view.rows.find((r) => r.kind === "former");
  assert.ok(former);
  assert.equal(former.key, FORMER_KEY);
  assert.equal(former.name, FORMER_NAME);
  assert.equal(former.accountId, undefined);
  assert.equal(former.estimated, true);
  assert.equal(former.totals.input, 15);
  assert.equal(view.rows.filter((r) => r.kind === "former").length, 1);
  assert.deepEqual(view.days[4].byRow[FORMER_KEY], {
    ...counts(15, 0, 0, 0, 2),
    estimated: true,
  });
  assert.equal(TOKEN_ROW_LABELS.former.tr, "Eski hesap");
});

test("terminal and unknown rows carry their labels and are never estimated", () => {
  const view = build(
    ledger({
      "2026-10-13": {
        terminal: { m: counts(40) },
        unknown: { m: counts(30) },
      },
    }),
  );
  const terminal = view.rows.find((r) => r.kind === "terminal")!;
  const unknown = view.rows.find((r) => r.kind === "unknown")!;
  assert.equal(terminal.key, "terminal");
  assert.equal(terminal.name, "Relay dışı terminal");
  assert.equal(terminal.accountId, undefined);
  assert.equal(terminal.estimated, false);
  assert.equal(unknown.key, "unknown");
  assert.equal(unknown.name, "Hesabı bilinmeyen");
  assert.equal(unknown.estimated, false);
  assert.deepEqual(TOKEN_ROW_LABELS.terminal, {
    tr: "Relay dışı terminal",
    en: "Outside-Relay terminal",
  });
  assert.deepEqual(TOKEN_ROW_LABELS.unknown, {
    tr: "Hesabı bilinmeyen",
    en: "Unknown account",
  });
  assert.deepEqual(TOKEN_ROW_LABELS.former, {
    tr: "Eski hesap",
    en: "Former account",
  });
});

test("rows sort by total, largest first, with unknown and terminal last", () => {
  const view = build(
    ledger({
      "2026-10-12": {
        terminal: { m: counts(9000) },
        unknown: { m: counts(8000) },
        "acct:ann": { m: counts(1, 1, 1, 1) },
        "acct:bob": { m: counts(100) },
        "acct:gone": { m: counts(50) },
      },
    }),
  );
  assert.deepEqual(
    view.rows.map((r) => r.key),
    ["bob", FORMER_KEY, "ann", "unknown", "terminal"],
  );
});

test("the account filter keeps one account's row and days", () => {
  const snapshot = ledger({
    "2026-10-12": {
      "acct:ann": { m: counts(10) },
      "est:ann": { m: counts(5) },
      "acct:bob": { m: counts(100) },
      terminal: { m: counts(1000) },
      unknown: { m: counts(2000) },
      "acct:gone": { m: counts(3000) },
    },
  });
  const view = build(snapshot, { accountId: "ann" });
  assert.deepEqual(
    view.rows.map((r) => r.key),
    ["ann"],
  );
  assert.deepEqual(view.days[4].byRow, {
    ann: { ...counts(15, 0, 0, 0, 2), estimated: true },
  });
  assert.equal(view.totals.input, 15);
  assert.deepEqual(view.models, [
    { model: "m", totals: counts(15, 0, 0, 0, 2) },
  ]);
  const none = build(snapshot, { accountId: "nobody" });
  assert.deepEqual(none.rows, []);
  assert.equal(none.totals.input, 0);
});

test("models are totalled across rows and days, largest first", () => {
  const view = build(
    ledger({
      "2026-10-12": {
        "acct:ann": {
          opus: counts(10, 100, 0, 0, 2),
          haiku: counts(1, 1, 0, 0, 1),
        },
        terminal: { opus: counts(5, 5, 0, 0, 1) },
      },
      "2026-10-13": {
        "est:bob": { sonnet: counts(50, 20, 10, 10, 3), haiku: counts(2, 2) },
      },
    }),
  );
  assert.deepEqual(view.models, [
    { model: "opus", totals: counts(15, 105, 0, 0, 3) },
    { model: "sonnet", totals: counts(50, 20, 10, 10, 3) },
    { model: "haiku", totals: counts(3, 3, 0, 0, 2) },
  ]);
  assert.deepEqual(view.totals, counts(68, 128, 10, 10, 8));
});

test("progress is the scanned share, whole, and 100 once complete", () => {
  const running = build(
    ledger({}, { scannedBytes: 1, totalBytes: 3, complete: false }),
  );
  assert.deepEqual(running.progress, { percent: 33, complete: false });
  // Never shows 100 before the scan has finished.
  const nearly = build(
    ledger({}, { scannedBytes: 999, totalBytes: 1000, complete: false }),
  );
  assert.deepEqual(nearly.progress, { percent: 99, complete: false });
  const none = build(
    ledger({}, { scannedBytes: 0, totalBytes: 0, complete: false }),
  );
  assert.deepEqual(none.progress, { percent: 0, complete: false });
  // A new pass resets the byte counts but the first scan stays done.
  const done = build(
    ledger({}, { scannedBytes: 10, totalBytes: 400, complete: true }),
  );
  assert.deepEqual(done.progress, { percent: 100, complete: true });
  // A ledger that cannot be saved says so.
  const unsaved = build(ledger({}, { error: true }));
  assert.deepEqual(unsaved.progress, {
    percent: 100,
    complete: true,
    error: true,
  });
});

test("exactSince is passed on as a date in the zone", () => {
  assert.equal(build(ledger({})).exactSince, undefined);
  // 22:30 UTC on 2026-10-09 is 01:30 on 2026-10-10 in Istanbul.
  const view = build(ledger({}), {
    exactSince: Date.parse("2026-10-09T22:30:00.000Z"),
  });
  assert.equal(view.exactSince, "2026-10-10");
});

test("the view carries only counts, names and ids", () => {
  const view = build(
    ledger({ "2026-10-13": { "acct:ann": { m: counts(1) } } }),
  );
  assert.doesNotThrow(() => structuredClone(view));
  assert.deepEqual(Object.keys(view).sort(), [
    "days",
    "models",
    "pricesChecked",
    "progress",
    "range",
    "rows",
    "today",
    "totals",
    "unpricedModels",
  ]);
});

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("main serves relay:token-usage with a validated input, after up to a second of ticks when stale", () => {
  const main = read("electron/main.ts");
  const start = main.indexOf('handle("token-usage"');
  assert.ok(start >= 0, "token-usage handler");
  const handler = main.slice(start, main.indexOf("\n  });", start));
  assert.match(handler, /usageStatisticsInput\.parse\(input\)/);
  assert.match(handler, /TOKEN_FRESH_MS/);
  assert.match(handler, /await tokenTick\(\)/);
  // Ticks run until the pass is complete or about a second has passed.
  assert.match(handler, /TOKEN_REFRESH_BUDGET_MS/);
  assert.match(handler, /!tokenLastTick\.complete/);
  // The ledger's own "complete" reaches the view, untouched.
  assert.match(handler, /ledger: tokenLedger\.snapshot\(\)/);
  assert.match(handler, /buildTokenUsageView\(/);
  assert.match(main, /const TOKEN_FRESH_MS = 60_000;/);
  assert.match(main, /const TOKEN_REFRESH_BUDGET_MS = 1_000;/);
  assert.match(
    read("electron/preload.ts"),
    /tokenUsage: \(input\) =>\s*ipcRenderer\.invoke\("relay:token-usage", input\)/,
  );
  assert.match(
    read("shared/types.ts"),
    /tokenUsage\(input: \{\s*range: 7 \| 30 \| 90;\s*accountId\?: string;\s*\}\): Promise<TokenUsageView>/,
  );
});

test("main ticks every 2 seconds while a pass is unfinished and every 5 minutes otherwise, never overlapping", () => {
  const main = read("electron/main.ts");
  // The ledger owns "complete"; main keeps no latch of its own.
  assert.doesNotMatch(main, /tokenFirstScanDone/);
  assert.match(main, /tokenLastTick = await tokenLedger\.tick\(\)/);
  assert.match(main, /tokenLastTick = "failed"/);
  // The pace follows how the last tick ended: tokenTickDelay is tested with the ledger.
  assert.match(main, /tokenTickDelay\(tokenLastTick\)/);
  // One tick in flight at a time; later callers share it.
  assert.match(main, /tokenRunning \?\?= /);
  // The next tick is armed only when the last one has ended, on an unref'd timer.
  assert.match(main, /tokenTimer = setTimeout\(/);
  assert.match(main, /tokenTimer\.unref\(\)/);
  // Attribution copies the limit samples at most once a minute, not on every tick.
  assert.match(main, /usageHistory\.recentSamples\(/);
  assert.match(main, /const TOKEN_SAMPLES_REFRESH_MS = 60_000;/);
  assert.match(main, /TOKEN_ATTRIBUTION_WINDOW_MS = 14 \* 86_400_000/);
  assert.match(main, /new TokenLedger\(/);
  assert.match(main, /os\.homedir\(\)/);
  assert.match(main, /"projects"/);
  assert.match(main, /profileAccountId: account\.id/);
});

test("main stops the token scan when Relay quits", () => {
  const main = read("electron/main.ts");
  const quit = main.slice(main.indexOf('app.on("will-quit"'));
  assert.match(quit, /tokenScanStopped = true/);
  assert.match(quit, /if \(tokenTimer\) clearTimeout\(tokenTimer\)/);
});

const slot = (cost: number, input = 0) => ({
  input,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  cost,
});
const priced = (input: number, cost: number, extra: Partial<TokenCounts> = {}) => ({
  ...counts(input),
  cost,
  ...extra,
});

test("costs and unpriced tokens add up across rows, days and models, and estimated costs are marked", () => {
  const view = build(
    ledger({
      "2026-10-13": {
        "acct:ann": { "claude-opus-5-5": priced(10, 1.5, { costEstimated: true }) },
      },
      "2026-10-14": {
        "acct:ann": { "claude-opus-5-5": priced(10, 2) },
        "acct:bob": { mystery: priced(5, 0, { unpriced: 5 }) },
      },
    }),
  );
  assert.equal(view.totals.cost, 3.5);
  assert.equal(view.totals.unpriced, 5);
  assert.equal(view.totals.costEstimated, true);
  assert.equal(view.rows.find((r) => r.key === "ann")?.totals.cost, 3.5);
  assert.equal(view.days.at(-2)?.byRow.ann.costEstimated, true);
  assert.equal(view.days.at(-1)?.byRow.ann.costEstimated, undefined);
  assert.deepEqual(view.unpricedModels, ["mystery"]);
  assert.equal(view.pricesChecked, "2026-10-22");
});

test("today's line runs to the current quarter hour and compares with yesterday up to the same one", () => {
  const snapshot: LedgerSnapshot = {
    ...ledger({
      "2026-10-14": { "acct:ann": { "claude-opus-5-5": priced(100, 9) } },
    }),
    slots: {
      // 15:00 in Istanbul is quarter hour 60.
      "2026-10-14": { "acct:ann": { 4: slot(2), 60: slot(1) }, "acct:bob": { 10: slot(3) } },
      "2026-10-13": { "acct:ann": { 0: slot(1), 60: slot(1), 95: slot(2) }, "acct:bob": { 1: slot(2) } },
    },
    slotsSince: Date.parse("2026-10-01T00:00:00Z"),
  };
  const today = build(snapshot).today;
  assert.equal(today.date, "2026-10-14");
  assert.equal(today.currentSlot, 60);
  assert.equal(today.totals.cost, 9);
  assert.equal(today.slots.length, 96);
  assert.equal(today.slots[4], 2);
  assert.equal(today.slots[10], 3);
  assert.equal(today.slots[60], 1);
  assert.equal(today.slots[59], 0);
  assert.equal(today.slots[61], null);
  // Today 6 against yesterday's 4 up to 15:00 (the 95th slot comes later).
  assert.equal(today.change, 0.5);
  assert.equal(today.yesterdayAverage, 6 / 96);
  assert.equal(today.slotsSince, undefined);
  // The account filter keeps one account's buckets and slots.
  const ann = build(snapshot, { accountId: "ann" }).today;
  assert.equal(ann.slots[10], 0);
  assert.equal(ann.change, 3 / 2 - 1);
});

test("without slots for all of yesterday there is no change and no dashed line", () => {
  const since = Date.parse("2026-10-14T05:00:00Z");
  const snapshot: LedgerSnapshot = {
    ...ledger({}),
    slots: {
      "2026-10-13": { "acct:ann": { 60: slot(1) } },
      "2026-10-14": { "acct:ann": { 60: slot(1) } },
    },
    slotsSince: since,
  };
  const today = build(snapshot).today;
  assert.equal(today.change, null);
  assert.equal(today.yesterdayAverage, null);
  assert.equal(today.slotsSince, since);
  // Yesterday kept whole but with nothing up to now: no change either.
  const quiet = build({
    ...snapshot,
    slots: { "2026-10-13": { "acct:ann": { 90: slot(1) } } },
    slotsSince: 0,
  }).today;
  assert.equal(quiet.change, null);
  assert.equal(quiet.yesterdayAverage, 1 / 96);
  assert.equal(quiet.slotsSince, undefined);
});

test("while a scan runs, today has no change and no dashed line: yesterday may be only partly read", () => {
  const snapshot: LedgerSnapshot = {
    ...ledger({}, { complete: false, scannedBytes: 10 }),
    slots: {
      "2026-10-13": { "acct:ann": { 60: slot(1) } },
      "2026-10-14": { "acct:ann": { 60: slot(5) } },
    },
    slotsSince: 0,
  };
  const today = build(snapshot).today;
  assert.equal(today.change, null);
  assert.equal(today.yesterdayAverage, null);
  assert.equal(today.slots[60], 5);
});

test("a day whose midnight a DST change skips starts at its first hour", () => {
  // Santiago skipped 2026-09-06 00:00 (clocks went to 01:00).
  const zone = "America/Santiago";
  const now = Date.parse("2026-09-07T15:00:00Z");
  const snapshot: LedgerSnapshot = {
    ...ledger({}),
    slots: { "2026-09-06": { "acct:ann": { 60: slot(1) } }, "2026-09-07": { "acct:ann": { 40: slot(1) } } },
    // Slots began during the 6th, after its first hour.
    slotsSince: Date.parse("2026-09-06T12:00:00Z"),
  };
  const today = build(snapshot, { zone, now }).today;
  assert.equal(today.change, null);
  assert.equal(today.yesterdayAverage, null);
});
