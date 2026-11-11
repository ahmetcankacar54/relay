import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenCounts, TokenToday, TokenUsageView } from "../shared/token-usage-view";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
} from "../shared/types";
import {
  buildWidgetSnapshot,
  widgetCountdown,
  widgetMood,
  widgetVisibleKey,
  type WidgetSnapshot,
} from "../shared/widget-snapshot";
import { WIDGET_RELOAD_MS, WidgetFile } from "../electron/core/widget-file";
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
  assert.equal(snap.version, 2);
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
    stale: "Son güncelleme 20:24",
    costTokens: "$444,56 · 1,3 Mr token",
    tokens: "1,3 Mr token",
    apiTitle: "Bugün · API karşılığı",
    others: "Diğer hesaplar",
    todayWord: "bugün",
    inClaude: "Claude’da açık",
    suggested: "önerilen",
    todayLine: "Bugün toplam $444,56 · 1,3 Mr token",
    allToday: "Bugün · tüm hesaplar",
    switch: "Geç",
    left: "kaldı",
    noActive: "Kayıtlı hesap açık değil",
  });
  // Without Relay's accounts and days the widget has no accounts to show.
  assert.equal(snap.active, undefined);
  assert.deepEqual(snap.accounts, []);
  assert.deepEqual(snap.split, []);
  assert.equal(snap.week, undefined);
});

test("English, an estimated cost, no change, the empty day and the scan each read as they should", () => {
  const en = build({ language: "en", today: today({ change: null }) });
  assert.equal(en.text.title, "Today");
  assert.equal(en.text.cost, "$444.56");
  assert.equal(en.text.change, "");
  assert.equal(en.text.stale, "Last updated 20:24");
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
  const file = new WidgetFile(dir, () => reloads.push("all"), () => now);
  const snap = build();
  file.write(snap);
  const written = path.join(dir, "today.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(written, "utf8")), snap);
  if (process.platform !== "win32") assert.equal(fs.statSync(written).mode & 0o777, 0o600);
  if (process.platform !== "win32") assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(reloads, ["all"]);
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
    reloadTimelines: (kind?: string) => calls.push(kind ?? "all"),
  }));
  reload?.("RelayToday");
  // Without a kind, every widget of Relay's.
  reload?.();
  assert.deepEqual(calls, ["RelayToday", "all"]);
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
  const file = new WidgetFile(dir, () => reloads.push("all"), () => NOW);
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

// Accounts, limits and the week.
const ID = {
  personal: "00000000-0000-4000-8000-000000000001",
  vertex: "00000000-0000-4000-8000-000000000002",
  work: "00000000-0000-4000-8000-000000000003",
  spare: "00000000-0000-4000-8000-000000000004",
  fifth: "00000000-0000-4000-8000-000000000005",
};
const person = (id: string, name: string, linked = true): Account => ({
  id,
  name,
  kind: "personal" as Account["kind"],
  group: "default",
  color: "#000",
  createdAt: "2026-01-01T00:00:00Z",
  ...(linked
    ? { desktop: { accountUuid: id, orgId: id, savedAt: "2026-01-01T00:00:00Z" } }
    : {}),
});
const ACCOUNTS = [
  person(ID.personal, "Kişisel"),
  person(ID.vertex, "Vertex"),
  person(ID.work, "İş"),
  person(ID.spare, "Yedek", false),
  person(ID.fifth, "Beşinci"),
];
const reading = (
  id: string,
  fiveHour: number,
  week: number,
  fiveReset = NOW + 110 * 60_000,
): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  checkedAt: new Date(NOW - 60_000).toISOString(),
  fiveHour: { usedPercent: fiveHour, resetsAt: new Date(fiveReset).toISOString() },
  // Saturday 24 October, 21:30 in Istanbul.
  sevenDay: { usedPercent: week, resetsAt: "2026-10-24T18:30:00Z" },
});
const USAGE: Record<string, AccountUsage> = {
  [ID.personal]: reading(ID.personal, 94.6, 68.2),
  [ID.vertex]: reading(ID.vertex, 22, 35, NOW + 3 * 3_600_000),
  [ID.work]: reading(ID.work, 100, 80),
  [ID.fifth]: reading(ID.fifth, 50, 60, NOW + 4 * 3_600_000),
};
const counts = (cost: number, tokens: number): TokenCounts & { estimated: boolean } => ({
  input: 0,
  output: tokens,
  cacheWrite: 0,
  cacheRead: 0,
  responses: 1,
  cost,
  unpriced: 0,
  estimated: false,
});
const DAYS: TokenUsageView["days"] = [
  "2026-10-16",
  "2026-10-17",
  "2026-10-18",
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
].map((date, i) => ({
  date,
  byRow:
    date === "2026-10-22"
      ? {
          [ID.personal]: counts(69.18, 64_200_000),
          [ID.vertex]: counts(12.3, 10_000_000),
          [ID.work]: counts(5, 6_000_000),
          [ID.fifth]: counts(5, 6_300_000),
        }
      : i === 4
        ? { [ID.vertex]: counts(142.1, 90_000_000), terminal: counts(3, 1_000_000) }
        : i === 0
          ? {}
          : { [ID.personal]: counts(10, 5_000_000) },
}));
const withAccounts = (input: Partial<Parameters<typeof buildWidgetSnapshot>[0]> = {}) =>
  build({
    days: DAYS,
    limits: {
      accounts: ACCOUNTS,
      usage: USAGE,
      activeId: ID.personal,
      settings: DEFAULT_SETTINGS,
    },
    hits: 2,
    ...input,
  });
const plainDeep = <T>(value: T): T => JSON.parse(plain(JSON.stringify(value)));

test("the active account carries its limits, its countdown and today's cost and tokens, in Turkish", () => {
  const snap = plainDeep(withAccounts());
  assert.ok(snap.active);
  const { active } = snap;
  assert.equal(active.id, ID.personal);
  assert.equal(active.name, "Kişisel");
  assert.equal(active.fiveHour, 94);
  assert.equal(active.week, 68);
  assert.equal(active.fiveHourResetsAt, NOW + 110 * 60_000);
  assert.equal(active.cost, 69.18);
  assert.equal(active.tokens, 64_200_000);
  assert.equal(active.color, 0);
  assert.deepEqual(active.text, {
    fiveHour: "%94",
    week: "%68",
    limits: "%94 / %68",
    cost: "$69,18",
    tokens: "64,2 Mn",
    costTokens: "$69,18 · 64,2 Mn",
    left: "1:50",
    weekReset: "Cmt 21:30",
    weekShort: "hafta %68",
    weekLine: "Hafta %68 · Cmt 21:30’da yenilenir",
    costChip: "$69,18 bugün",
    tokensChip: "64,2 Mn token",
  });
});

test("other accounts follow the panel: the suggested one first, at most three, and only a ready one links to the review", () => {
  const snap = plainDeep(withAccounts());
  assert.deepEqual(
    snap.accounts.map((a) => [a.name, a.suggested, a.switchable]),
    [
      ["Vertex", true, true],
      ["Beşinci", false, true],
      ["İş", false, false],
    ],
  );
  const [vertex, , work] = snap.accounts;
  assert.equal(vertex.link, `relay://switch?account=${ID.vertex}`);
  assert.equal(work.link, undefined);
  assert.equal(vertex.text.switchTo, "Vertex’e geç · %22");
  assert.equal(vertex.text.limits, "%22 / %35");
  assert.equal(vertex.text.costTokens, "$12,30 · 10 Mn");
  assert.equal(work.text.fiveHour, "%100");
  // An account without a current reading shows no figure rather than an old one.
  const old = plainDeep(
    withAccounts({
      limits: {
        accounts: ACCOUNTS,
        usage: { ...USAGE, [ID.vertex]: { ...USAGE[ID.vertex], stale: true } },
        activeId: ID.personal,
        settings: DEFAULT_SETTINGS,
      },
    }),
  );
  const unknown = old.accounts.find((a) => a.id === ID.vertex);
  assert.ok(unknown);
  assert.equal(unknown.fiveHour, undefined);
  assert.equal(unknown.text.limits, "— / —");
  assert.equal(unknown.switchable, false);
  assert.equal(unknown.text.switchTo, "Vertex’e geç");
});

test("today's split and the week's bars share one set of colours: the active account first, then the rest", () => {
  const snap = plainDeep(withAccounts());
  assert.deepEqual(
    snap.series.map((s) => [s.name, s.color]),
    [
      ["Kişisel", 0],
      ["Vertex", 1],
      ["İş", 2],
      ["Diğer", 3],
    ],
  );
  assert.deepEqual(
    snap.split.map((p) => [p.name, p.text.cost, Math.round(p.share * 1000)]),
    [
      ["Kişisel", "$69,18", 756],
      ["Vertex", "$12,30", 134],
      ["İş", "$5,00", 55],
      ["Diğer", "$5,00", 55],
    ],
  );
  const week = snap.week;
  assert.ok(week);
  assert.deepEqual(
    week.days.map((d) => d.label),
    ["Cum", "Cmt", "Paz", "Pzt", "Sal", "Çar", "Per"],
  );
  assert.deepEqual(week.days.map((d) => d.today), [false, false, false, false, false, false, true]);
  assert.deepEqual(week.days[4].parts, [0, 142.1, 0, 3]);
  assert.equal(week.hits, 2);
  assert.deepEqual(week.text, {
    title: "Son 7 gün",
    cost: "$276,58",
    tokens: "197,5 Mn token",
    average: "Günde $39,51",
    busiest: "En yoğun Sal · $145,10",
    hits: "Limit 2 kez doldu",
    activeWeek: "Kişisel · hafta %68",
  });
});

test("the accounts and the week read in English too, and parts without data are left out", () => {
  const snap = plainDeep(withAccounts({ language: "en", hits: undefined }));
  assert.ok(snap.active && snap.week);
  assert.equal(snap.active.text.weekLine, "Week 68% · renews Sat 21:30");
  assert.equal(snap.active.text.costChip, "$69.18 today");
  assert.equal(snap.active.text.tokensChip, "64.2m tokens");
  assert.equal(snap.accounts[0].text.switchTo, "Switch to Vertex · 22%");
  assert.equal(snap.text.todayLine, "Total today $444.56 · 1.3bn tokens");
  assert.equal(snap.text.switch, "Switch");
  assert.equal(snap.series.at(-1)?.name, "Other");
  assert.equal(snap.week.text.title, "Last 7 days");
  assert.equal(snap.week.text.average, "$39.51 a day");
  assert.equal(snap.week.text.busiest, "Busiest Tue · $145.10");
  assert.equal(snap.week.hits, undefined);
  assert.equal(snap.week.text.hits, "");
  assert.equal(snap.week.text.activeWeek, "Kişisel · week 68%");
  // No account open in Claude: no active part, the others still listed.
  const none = withAccounts({
    limits: { accounts: ACCOUNTS, usage: USAGE, settings: DEFAULT_SETTINGS },
  });
  assert.equal(none.active, undefined);
  assert.equal(none.accounts.length, 3);
  assert.equal(none.week?.text.activeWeek, "");
});

test("the panda is happy, alarmed from 80 % of the five hours, worried at a full limit, asleep with nothing to watch", () => {
  const usage = (fiveHour: number, week: number) =>
    withAccounts({
      limits: {
        accounts: ACCOUNTS,
        usage: { ...USAGE, [ID.personal]: reading(ID.personal, fiveHour, week) },
        activeId: ID.personal,
        settings: DEFAULT_SETTINGS,
      },
    }).mood;
  assert.equal(usage(40, 50), "happy");
  assert.equal(usage(79.9, 50), "happy");
  assert.equal(usage(80, 50), "alert");
  assert.equal(withAccounts().mood, "alert");
  assert.equal(usage(100, 50), "worried");
  assert.equal(usage(30, 100), "worried");
  // No Relay account open in Claude, no accounts at all, or the first scan: asleep.
  assert.equal(
    withAccounts({ limits: { accounts: ACCOUNTS, usage: USAGE, settings: DEFAULT_SETTINGS } }).mood,
    "sleeping",
  );
  assert.equal(build().mood, "sleeping");
  assert.equal(withAccounts({ progress: { complete: false, percent: 30 } }).mood, "sleeping");
  assert.equal(widgetMood("data", {}), "happy");
  assert.equal(plain(withAccounts({ language: "en" }).text.tokens), "1.3bn tokens");
  assert.equal(withAccounts({ language: "en" }).text.apiTitle, "Today · API value");
});

test("the countdown reads h:mm and is empty once the window renewed", () => {
  assert.equal(widgetCountdown(NOW + 110 * 60_000, NOW), "1:50");
  assert.equal(widgetCountdown(NOW + 7 * 60_000 - 30_000, NOW), "0:07");
  assert.equal(widgetCountdown(NOW - 1, NOW), "");
  assert.equal(widgetCountdown(undefined, NOW), "");
});

test("the visible key ignores the countdown but moves with limits and the open account", () => {
  const a = withAccounts();
  assert.equal(widgetVisibleKey(a), widgetVisibleKey(withAccounts({ now: NOW + 60_000 })));
  const higher = withAccounts({
    limits: {
      accounts: ACCOUNTS,
      usage: { ...USAGE, [ID.personal]: reading(ID.personal, 97, 68.2) },
      activeId: ID.personal,
      settings: DEFAULT_SETTINGS,
    },
  });
  assert.notEqual(widgetVisibleKey(a), widgetVisibleKey(higher));
  const switched = withAccounts({
    limits: { accounts: ACCOUNTS, usage: USAGE, activeId: ID.vertex, settings: DEFAULT_SETTINGS },
  });
  assert.notEqual(widgetVisibleKey(a), widgetVisibleKey(switched));
});

test("a switch to another account reloads the widgets at once, whatever the throttle says", () => {
  const dir = tempDir();
  const reloads: string[] = [];
  const file = new WidgetFile(dir, () => reloads.push("all"), () => NOW);
  file.write(withAccounts());
  const usageMoved = withAccounts({
    limits: {
      accounts: ACCOUNTS,
      usage: { ...USAGE, [ID.personal]: reading(ID.personal, 97, 68.2) },
      activeId: ID.personal,
      settings: DEFAULT_SETTINGS,
    },
  });
  file.write(usageMoved);
  assert.equal(reloads.length, 1);
  file.write(
    withAccounts({
      limits: { accounts: ACCOUNTS, usage: USAGE, activeId: ID.vertex, settings: DEFAULT_SETTINGS },
    }),
  );
  assert.equal(reloads.length, 2);
});
