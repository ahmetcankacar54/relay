import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenToday } from "../shared/token-usage-view";
import {
  buildWidgetSnapshot,
  widgetVisibleKey,
  type WidgetSnapshot,
} from "../shared/widget-snapshot";
import {
  WIDGET_KIND,
  WIDGET_RELOAD_MS,
  WidgetFile,
} from "../electron/core/widget-file";
import { loadWidgetCenter } from "../electron/core/widget-center";

const ZONE = "Europe/Istanbul";
// 20:24 in Istanbul.
const NOW = Date.parse("2026-10-22T17:24:00Z");

const today = (extra: Partial<TokenToday> = {}): TokenToday => ({
  date: "2026-10-22",
  totals: {
    input: 8_720,
    output: 3_250_000,
    cacheWrite: 10_000_000,
    cacheRead: 1_300_000_000,
    responses: 900,
    cost: 444.56,
    unpriced: 0,
  },
  slots: Array.from({ length: 96 }, (_, i) => (i > 81 ? null : i / 10)),
  currentSlot: 81,
  change: 0.5719,
  yesterdayAverage: 3.1,
  ...extra,
});
const build = (input: Partial<Parameters<typeof buildWidgetSnapshot>[0]> = {}) =>
  buildWidgetSnapshot({
    today: today(),
    progress: { complete: true, percent: 100 },
    language: "tr",
    zone: ZONE,
    now: NOW,
    ...input,
  });
// Compact units and currency come with a no-break space; read it as a plain one.
const plain = (s: string) => s.replace(/ /g, " ");

test("the widget file carries today's numbers and every string, formatted in Turkish", () => {
  const snap = build();
  assert.equal(snap.version, 1);
  assert.equal(snap.state, "data");
  assert.equal(snap.date, "2026-10-22");
  assert.equal(snap.generatedAt, NOW);
  assert.deepEqual(snap.totals, {
    input: 8_720,
    output: 3_250_000,
    cache: 1_310_000_000,
    total: 1_313_258_720,
  });
  assert.equal(snap.cost, 444.56);
  assert.equal(snap.slots.length, 96);
  assert.equal(snap.slots[82], null);
  const text = Object.fromEntries(
    Object.entries(snap.text).map(([k, v]) => [k, Array.isArray(v) ? v : plain(v)]),
  );
  assert.deepEqual(text, {
    title: "Bugün",
    subtitle: "CLAUDE CODE · TOKEN",
    rows: ["Girdi", "Çıktı", "Önbellek"],
    input: "8,7 B",
    output: "3,3 Mn",
    cache: "1,3 Mr",
    total: "1,3 Mr",
    cost: "$444,56",
    change: "+%57,2",
    status: "",
    empty: "Bugün henüz token yok",
    stale: "Güncel değil · 20:24",
  });
});

test("English, an estimated cost, no change, the empty day and the scan each read as they should", () => {
  const en = build({ language: "en", today: today({ change: null }) });
  assert.equal(en.text.title, "Today");
  assert.equal(en.text.cost, "$444.56");
  assert.equal(en.text.change, "");
  assert.equal(en.text.stale, "Not current · 20:24");
  const estimated = build({
    today: today({ totals: { ...today().totals, costEstimated: true } }),
  });
  assert.equal(estimated.text.cost, "≈$444,56");
  const empty = build({
    today: today({
      totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, responses: 0, cost: 0, unpriced: 0 },
    }),
  });
  assert.equal(empty.state, "empty");
  assert.equal(empty.text.status, "Bugün henüz token yok");
  const scanning = build({ progress: { complete: false, percent: 42 } });
  assert.equal(scanning.state, "scanning");
  assert.equal(scanning.text.status, "Relay tarıyor… %42");
});

test("the visible key ignores when the file was written, and moves with what the widget draws", () => {
  const a = build();
  assert.equal(widgetVisibleKey(a), widgetVisibleKey(build({ now: NOW + 60_000 })));
  const later = build({ today: today({ slots: today().slots.map((v, i) => (i === 81 ? 9 : v)) }) });
  assert.notEqual(widgetVisibleKey(a), widgetVisibleKey(later));
  assert.notEqual(widgetVisibleKey(a), widgetVisibleKey(build({ language: "en" })));
});

const temporary: string[] = [];
test.after(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-widget-"));
  temporary.push(dir);
  return path.join(dir, "widget");
}

test("the widget file is private, and reloads come at most every 5 minutes unless the day changed", () => {
  const dir = tempDir();
  let now = NOW;
  const reloads: string[] = [];
  const file = new WidgetFile(dir, (kind) => reloads.push(kind), () => now);
  const snap = build();
  file.write(snap);
  const written = path.join(dir, "today.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(written, "utf8")), snap);
  assert.equal(fs.statSync(written).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(reloads, [WIDGET_KIND]);
  // The same picture: written again, no reload.
  now += WIDGET_RELOAD_MS * 2;
  file.write(build({ now }));
  assert.equal(reloads.length, 1);
  // A new picture soon after a reload waits for the next write past 5 minutes.
  const changed = (n: number): WidgetSnapshot =>
    build({ now, today: today({ slots: today().slots.map((v, i) => (i === 81 ? n : v)) }) });
  file.write(changed(1));
  assert.equal(reloads.length, 2);
  now += 60_000;
  file.write(changed(2));
  assert.equal(reloads.length, 2);
  now += WIDGET_RELOAD_MS;
  file.write(changed(2));
  assert.equal(reloads.length, 3);
  // A new day reloads at once.
  now += 1_000;
  file.write(build({ now, today: today({ date: "2026-10-23" }) }));
  assert.equal(reloads.length, 4);
});

test("a failing reload or none at all never stops the file", () => {
  const dir = tempDir();
  new WidgetFile(dir, () => {
    throw new Error("chronod said no");
  }).write(build());
  assert.ok(fs.existsSync(path.join(dir, "today.json")));
  const quiet = tempDir();
  new WidgetFile(quiet).write(build());
  assert.ok(fs.existsSync(path.join(quiet, "today.json")));
});

test("the reload addon is optional: a missing or wrong one turns reloads off", (t) => {
  t.mock.method(console, "warn", () => {});
  if (process.platform !== "darwin") {
    assert.equal(loadWidgetCenter("/nowhere"), undefined);
    return;
  }
  const calls: string[] = [];
  const reload = loadWidgetCenter("/addon", () => ({
    reloadTimelines: (kind: string) => calls.push(kind),
  }));
  reload?.("RelayToday");
  assert.deepEqual(calls, ["RelayToday"]);
  assert.equal(
    loadWidgetCenter("/addon", () => {
      throw new Error("not found");
    }),
    undefined,
  );
  assert.equal(loadWidgetCenter("/addon", () => ({})), undefined);
});

test("a language change reloads at once, whatever the throttle says", () => {
  const dir = tempDir();
  const reloads: string[] = [];
  const file = new WidgetFile(dir, (kind) => reloads.push(kind), () => NOW);
  file.write(build());
  // A tick soon after: throttled.
  file.write(build({ today: today({ change: 0.9 }) }));
  assert.equal(reloads.length, 1);
  file.write(build({ language: "en" }), true);
  assert.equal(reloads.length, 2);
  // Forced but what the widget shows already: nothing to redraw.
  file.write(build({ language: "en" }), true);
  assert.equal(reloads.length, 2);
});
