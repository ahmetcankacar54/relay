import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Usage } from "../src/pages/Usage";
import { DayDetail, DayTable, TokenUsage, TokenUsageCard, chartDays, todaySeries, tokenColumns, tokenNotes } from "../src/pages/usage/TokenUsage";
import { CostBreakdown } from "../src/pages/usage/CostBreakdown";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { TOKEN_SCAN_POLL_MS } from "../src/pages/usage/useTokenUsage";
import { formatTokens } from "../src/pages/usage/format";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type RelayAPI, type Snapshot } from "../shared/types";
import { TOKEN_ROW_LABELS, type TokenCounts, type TokenRow, type TokenUsageView } from "../shared/token-usage-view";
import { dayTip, fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const ZONE = "Europe/Istanbul";
const iso = (ms: number) => new Date(ms).toISOString();
const a: Account = {
  id: "a", name: "Kişisel · Max", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
};
const b: Account = { ...a, id: "b", name: "Vertex" };
const accounts = [a, b];
const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_SETTINGS.planning, timeZone: ZONE } };

const counts = (input: number, output = 0, cacheWrite = 0, cacheRead = 0, responses = 1): TokenCounts => ({
  input, output, cacheWrite, cacheRead, responses,
});
const sum = (...all: TokenCounts[]): TokenCounts =>
  all.reduce((to, c) => ({
    input: to.input + c.input, output: to.output + c.output, cacheWrite: to.cacheWrite + c.cacheWrite,
    cacheRead: to.cacheRead + c.cacheRead, responses: to.responses + c.responses,
  }), counts(0, 0, 0, 0, 0));

const DATES = ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
// Day cells. "a" is exact on the 14th and estimated on the 13th.
const cell = (c: TokenCounts, estimated = false) => ({ ...c, estimated });
const byDate: Record<string, TokenUsageView["days"][number]["byRow"]> = {
  "2026-10-14": { a: cell(counts(1_000_000, 200_000, 50_000, 800_000)), b: cell(counts(100_000, 20_000, 0, 5_000)) },
  "2026-10-13": { a: cell(counts(900_000, 100_000, 0, 0), true) },
  "2026-10-12": { unknown: cell(counts(40_000, 5_000)), terminal: cell(counts(0, 0, 0, 3_000)) },
  "2026-10-11": { former: cell(counts(7_000, 1_000)) },
};
const row = (key: string, kind: TokenRow["kind"], totals: TokenCounts, extra: Partial<TokenRow> = {}): TokenRow => ({
  key, kind, estimated: false, totals, ...extra,
});
const rowTotal = (key: string) => sum(...Object.values(byDate).flatMap((r) => (r[key] ? [r[key]] : [])));
const rows: TokenRow[] = [
  row("a", "account", rowTotal("a"), { accountId: "a", name: "Kişisel · Max", estimated: true }),
  row("b", "account", rowTotal("b"), { accountId: "b", name: "Vertex" }),
  row("former", "former", rowTotal("former"), { name: "Eski hesap" }),
  row("unknown", "unknown", rowTotal("unknown"), { name: "Hesabı bilinmeyen" }),
  row("terminal", "terminal", rowTotal("terminal"), { name: "Relay dışı terminal" }),
];
const view: TokenUsageView = {
  range: 7,
  days: DATES.map((date) => ({ date, byRow: byDate[date] ?? {} })),
  rows,
  totals: { ...sum(...rows.map((r) => r.totals)), cost: 1234.5 },
  models: [
    { model: "claude-opus-4", totals: counts(1_500_000, 250_000, 50_000, 800_000) },
    { model: "claude-sonnet-4", totals: counts(547_000, 76_000, 0, 8_000) },
  ],
  progress: { percent: 100, complete: true },
  exactSince: "2026-10-12",
  today: {
    date: "2026-10-14",
    totals: { ...counts(1_100_000, 220_000, 50_000, 805_000), cost: 444.56 },
    // 10:00Z is 13:00 in Istanbul: quarter hour 52.
    slots: Array.from({ length: 96 }, (_, i) => (i > 52 ? null : i % 4)),
    currentSlot: 52,
    change: 0.5719,
    yesterdayAverage: 1.5,
  },
  unpricedModels: [],
  pricesChecked: "2026-10-22",
};

function relayFor(api: Partial<RelayAPI> = {}): Relay {
  return {
    api, preview: false, error: "", notice: "", accounts, active: a, settings, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "a" },
    data: { settings, usage: {}, accounts, authFlows: [], diagnostics: { platform: "darwin" } } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {}, setData() {},
  } as unknown as Relay;
}
const i18n = (language: Language) => ({
  language,
  setLanguage() {},
  t: (tr: string, en: string) => (language === "tr" ? tr : en),
});
const tree = (child: ReactElement, language: Language = "tr", relay: Relay = relayFor()) =>
  createElement(
    TooltipProvider,
    null,
    createElement(
      I18nContext.Provider,
      { value: i18n(language) },
      createElement(RelayContext.Provider, { value: relay }, child),
    ),
  );
// Compact units come with a no-break space ("1,2 Mn"); the assertions below read it as a plain one.
const plainSpaces = (html: string) => html.replace(/\u00a0/g, " ");
const render = (child: ReactElement, language: Language = "tr") => plainSpaces(renderToStaticMarkup(tree(child, language)));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "’");
const card = (state: Parameters<typeof TokenUsageCard>[0]["state"], language: Language = "tr") =>
  render(createElement(TokenUsageCard, { state, accounts }), language);
const shown = (language: Language = "tr") => card({ view, loading: false }, language);
/** The chart's <svg>, not the panda drawn in the "Panda anlatsın" button. */
const chartOf = (container: Fake) =>
  find(container, (n) => n.tagName === "svg" && (n as { attributes?: Map<string, string> }).attributes?.get?.("role") === "group")!;
/** The day table on its own: the card folds it under "Gün gün tablo". */
const dayTable = (language: Language = "tr") =>
  render(createElement(DayTable, { view, columns: tokenColumns(view, accounts, i18n(language).t), metric: "total" }), language);
/** Markup as seen on screen: without the text only screen readers hear. */
const visible = (html: string) => text(html.replace(/<span class="sr-only">[^<]*<\/span>/g, ""));

test("formatTokens is compact, with the language's own units", () => {
  assert.equal(plainSpaces(formatTokens(1_234_567, "tr")), "1,2 Mn");
  // Intl keeps the number and its unit together with a no-break space.
  assert.equal(formatTokens(1_234_567, "tr"), "1,2\u00a0Mn");
  assert.equal(formatTokens(1_234_567, "en"), "1.2m");
  assert.equal(plainSpaces(formatTokens(12_345, "tr")), "12,3 B");
  assert.equal(formatTokens(999, "tr"), "999");
  assert.equal(formatTokens(0, "en"), "0");
});

test("the summary is three tiles: today, the range's total split by kind, and its API value", () => {
  const html = shown();
  assert.match(html, /aria-label="Token kullanımı"/);
  const tiles = [...html.matchAll(/data-slot="token-tile"[^>]*><div[^>]*>([^<]+)<\/div><div[^>]*>([^<]+)<\/div>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tiles, [
    ["Bugün", "2,2 Mn"],
    ["Toplam · 7 gün", "3,2 Mn"],
    ["API karşılığı", "$1.234,50"],
  ]);
  const plain = text(html);
  // The range's split by kind is one quiet line under its total, and the API value says it per day.
  assert.match(plain, /3,2 MnGirdi 2 Mn · Çıktı 326 B · Önbellek 858 B/);
  assert.match(plain, /günde \$176,36/);
  // The exact count stays one hover away.
  assert.match(html, /title="3\.231\.000"/);

  const en = shown("en");
  assert.match(en, /aria-label="Token usage"/);
  assert.match(text(en), /Total · 7 days/);
  for (const label of ["Input", "Output", "Cache", "API value"]) assert.match(text(en), new RegExp(label));
  assert.doesNotMatch(text(en), /Girdi|Çıktı|Önbellek/);
});

test("the metric toggle offers total, input, output, cache and the API value, total first", () => {
  const html = shown();
  assert.match(html, /data-slot="toggle-group"/);
  const items = [...html.matchAll(/data-slot="toggle-group-item"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(items, ["Toplam", "Girdi", "Çıktı", "Önbellek", "API karşılığı"]);
  assert.match(html, /data-state="on"[^>]*>Toplam</);
  assert.deepEqual(
    [...shown("en").matchAll(/data-slot="toggle-group-item"[^>]*>([^<]+)</g)].map((m) => m[1]),
    ["Total", "Input", "Output", "Cache", "API value"],
  );
});

test("the chart stacks one part per row and day with tokens, each in its account's own colour", () => {
  const columns = tokenColumns(view, accounts, (tr) => tr);
  const days = chartDays(view, columns, "total" as never);
  // 14th: a and b; 13th: a; 12th: unknown and terminal; 11th: former.
  assert.equal(days.reduce((sum, day) => sum + day.parts.length, 0), 6);
  assert.deepEqual(days.at(-1)!.parts.map((p) => p.column.key), ["a", "b"]);
  // Colour follows the account (both fixture accounts are olive), never its place in the list.
  assert.deepEqual(
    columns.map((c) => [c.key, c.color]),
    [
      ["a", "var(--account-olive)"],
      ["b", "var(--account-olive)"],
      ["former", "var(--account-none)"],
      ["unknown", "var(--muted-foreground)"],
      ["terminal", "var(--account-none)"],
    ],
  );
  // The days are also a list for screen readers, one item each.
  const html = shown();
  const list = html.slice(html.indexOf('data-slot="token-days"'));
  assert.equal((list.slice(0, list.indexOf("</ul>")).match(/<li>/g) ?? []).length, 7);
  // The rows under the total name every row (each with its own small curve).
  // The small curves' own <style> blocks carry no words.
  const legend = text(html.slice(html.indexOf('data-slot="trend-series"'), html.indexOf("</ul>", html.indexOf('data-slot="trend-series"'))).replace(/<style[\s\S]*?<\/style>/g, ""));
  for (const name of ["Kişisel · Max", "Vertex", "Eski hesap", "Hesabı bilinmeyen", "Relay dışı terminal"])
    assert.match(legend, new RegExp(name));
});

test("each day adds up its rows; the busiest day sets the chart's top", () => {
  const days = chartDays(view, tokenColumns(view, accounts, (tr) => tr), "total" as never);
  const total = (date: string) => days.find((d) => d.date === date)!.total;
  // The 14th is the busiest day (2.175 million): a holds 2.05 of it, b 0.125.
  assert.equal(total("2026-10-14"), 2_175_000);
  assert.deepEqual(days.at(-1)!.parts.map((p) => p.value), [2_050_000, 125_000]);
  // The 13th's 1 million is a bit under half of it, and estimated.
  assert.equal(total("2026-10-13"), 1_000_000);
  assert.equal(days.find((d) => d.date === "2026-10-13")!.parts[0].estimated, true);
  assert.equal(total("2026-10-08"), 0);
});

test("each row under the total sums it over the range, ≈ when any of its days was estimated", () => {
  const html = shown();
  const at = html.indexOf('data-slot="trend-series"');
  const legend = text(html.slice(at, html.indexOf("</ul>", at)).replace(/<style[\s\S]*?<\/style>/g, ""));
  assert.match(legend, /Kişisel · Max≈3,1 Mn/);
  assert.match(legend, /Vertex125 B/);
  assert.match(legend, /Hesabı bilinmeyen45 B/);
  assert.match(legend, /Relay dışı terminal3 B/);
});

test("the range's model mix and the price list are behind the chart's ⓘ, and the day table is folded", () => {
  const tr = (a: string) => a;
  const en = (_: string, e: string) => e;
  assert.match(tokenNotes(view, "total" as never, tr, "tr").join(" "), /Aralıktaki modeller: claude-opus-4 %80 · claude-sonnet-4 %20/);
  assert.match(tokenNotes(view, "total" as never, en, "en").join(" "), /Models in this range: claude-opus-4 80% · claude-sonnet-4 20%/);
  const plain = text(shown());
  assert.doesNotMatch(plain, /Aralıktaki modeller/);
  assert.match(shown(), /data-slot="token-chart"[\s\S]*?aria-label="Nasıl çalışır"/);
  // The table is one click away, under its own heading.
  assert.match(plain, /Gün gün tablo/);
  assert.match(shown(), /aria-expanded="false"/);
  assert.doesNotMatch(shown(), /<table/);
  // The browser's own slow tooltip is gone: the chart draws its own.
  assert.doesNotMatch(shown(), /<title>/);
});

test("the table lists days newest first with the rows from the view, then the total", () => {
  const html = dayTable();
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const head = [...table.slice(0, table.indexOf("<tbody")).matchAll(/<th(?:\s[^>]*)?>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(head, ["Gün", "Kişisel · Max", "Vertex", "Eski hesap", "Hesabı bilinmeyen", "Relay dışı terminal", "Toplam"]);
  const body = table.slice(table.indexOf("<tbody"));
  const days = [...body.matchAll(/<th[^>]*scope="row"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(days, ["14 Eki", "13 Eki", "12 Eki", "11 Eki", "10 Eki", "9 Eki", "8 Eki"]);
  const rowOf = (day: string) => {
    const at = body.indexOf(`>${day}</th>`);
    return body.slice(at, body.indexOf("</tr>", at));
  };
  const cellsOf = (day: string) => [...rowOf(day).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => visible(m[1]));
  assert.deepEqual(cellsOf("14 Eki"), ["2,1 Mn", "125 B", "—", "—", "—", "2,2 Mn"]);
  assert.deepEqual(cellsOf("13 Eki"), ["≈1 Mn", "—", "—", "—", "—", "≈1 Mn"]);
  assert.deepEqual(cellsOf("12 Eki"), ["—", "—", "—", "45 B", "3 B", "48 B"]);
  assert.deepEqual(cellsOf("8 Eki"), ["—", "—", "—", "—", "—", "—"]);
});

test("only estimated cells carry the ≈ tooltip", () => {
  const html = dayTable();
  const tooltip = "Limit ölçümlerinden tahmin edildi";
  const estimated = [...html.matchAll(/<td[^>]*title="Limit ölçümlerinden tahmin edildi"[^>]*>(.*?)<\/td>/g)];
  // The 13th's account cell and its total.
  assert.deepEqual(estimated.map((c) => visible(c[1])), ["≈1 Mn", "≈1 Mn"]);
  assert.equal(html.split(tooltip).length - 1, 2);
  assert.match(dayTable("en"), /title="Estimated from limit samples"/);
});

test("estimated cells and chart days tell screen readers they are estimated, not only the tooltip", () => {
  const html = dayTable();
  const cells = [...html.matchAll(/<td[^>]*title="Limit ölçümlerinden tahmin edildi"[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  assert.equal(cells.length, 2);
  // The ≈ is hidden from screen readers, which hear "tahmini" instead.
  for (const cell of cells) assert.equal(cell, '<span aria-hidden="true">≈</span><span class="sr-only">tahmini </span>1 Mn');
  assert.match(dayTable("en"), /<span aria-hidden="true">≈<\/span><span class="sr-only">estimated <\/span>1m<\/td>/);
  // Exact cells say nothing of the kind.
  assert.equal(html.split('class="sr-only"').length - 1, 2);
  // Each chart day names its rows in the spoken list, the estimated ones as such.
  const chart = shown();
  assert.match(chart, /<li>13 Eki: 1 Mn; Kişisel · Max tahmini 1 Mn<\/li>/);
  assert.match(chart, /<li>14 Eki: 2,2 Mn; Kişisel · Max 2,1 Mn; Vertex 125 B<\/li>/);
  assert.match(chart, /<li>8 Eki: 0<\/li>/);
  assert.match(shown("en"), /<li>13 Oct: 1m; Kişisel · Max estimated 1m<\/li>/);
});

test("the coverage note says since when accounts match exactly, in both languages", () => {
  const tr = (a: string) => a;
  const en = (_: string, e: string) => e;
  assert.match(
    tokenNotes(view, "total" as never, tr, "tr").join(" "),
    /Hesap eşleşmesi 12 Eki tarihinden beri kesin\. Önceki günler limit ölçümlerinden tahmin edildi\./,
  );
  const english = tokenNotes(view, "total" as never, en, "en").join(" ");
  assert.doesNotMatch(english, /Relay's/);
  assert.match(english, /Account matches are exact from 12 Oct\. Earlier days are estimated from limit samples\./);
  assert.doesNotMatch(tokenNotes({ ...view, exactSince: undefined }, "total" as never, tr, "tr").join(" "), /Hesap eşleşmesi/);
});

test("the progress note shows while the scan is incomplete, and only then", () => {
  const scanning = { ...view, progress: { percent: 42, complete: false } };
  assert.match(text(card({ view: scanning, loading: false })), /Konuşma kayıtları taranıyor… %42/);
  assert.match(text(card({ view: scanning, loading: false }, "en")), /Relay scans the conversation logs… 42%/);
  assert.doesNotMatch(text(shown()), /taranıyor/);
});

test("a range without tokens shows the empty state instead of the chart and table", () => {
  const empty: TokenUsageView = {
    ...view, days: DATES.map((date) => ({ date, byRow: {} })), rows: [], totals: counts(0, 0, 0, 0, 0), models: [],
    exactSince: undefined,
  };
  const html = card({ view: empty, loading: false });
  assert.match(html, /aria-label="Token kullanımı"/);
  assert.match(text(html), /Bu aralıkta token kaydı yok\./);
  assert.doesNotMatch(html, /<svg|<table/);
  assert.match(text(card({ view: empty, loading: false }, "en")), /No token records in this range\./);
});

test("while the scan runs, an empty range shows only the scanning note", () => {
  const empty: TokenUsageView = {
    ...view, days: DATES.map((date) => ({ date, byRow: {} })), rows: [], totals: counts(0, 0, 0, 0, 0), models: [],
    progress: { percent: 5, complete: false },
  };
  const tr = text(card({ view: empty, loading: false }));
  assert.match(tr, /Konuşma kayıtları taranıyor… %5/);
  assert.doesNotMatch(tr, /Bu aralıkta token kaydı yok/);
  assert.doesNotMatch(tr, /Hesap eşleşmesi/);
  const en = text(card({ view: empty, loading: false }, "en"));
  assert.match(en, /Relay scans the conversation logs… 5%/);
  assert.doesNotMatch(en, /No token records/);
});

test("a ledger that cannot be saved says so, in both languages", () => {
  const unsaved: TokenUsageView = { ...view, progress: { percent: 100, complete: true, error: true } };
  assert.match(
    text(card({ view: unsaved, loading: false })),
    /Token kayıtları saklanamıyor\./,
  );
  assert.match(
    text(card({ view: unsaved, loading: false }, "en")),
    /Relay cannot save the token records\./,
  );
  assert.doesNotMatch(text(shown()), /kaydedilemiyor/);
});

test("the card shows loading and failure states, and keeps the last view under a failed refresh", () => {
  assert.match(card({ loading: true }), /aria-label="Token kullanımı"[\s\S]*Token kaydı yükleniyor/);
  assert.match(text(card({ loading: true }, "en")), /Relay loads the token usage…/);
  const failed = card({ loading: false, error: "boom" });
  assert.match(failed, /role="alert"/);
  assert.match(text(failed), /Token kullanımı alınamadı[\s\S]*boom/);
  assert.match(text(card({ loading: false, error: "boom" }, "en")), /Cannot load token usage/);
  const stale = card({ view, loading: false, error: "boom" });
  assert.match(stale, /role="alert"[^>]*>[\s\S]*Token kullanımı yenilenemedi\.[\s\S]*boom/);
  assert.match(text(stale), /Girdi/);
  assert.match(card({ view, loading: true }), /aria-busy="true"/);
});

test("rows that are not accounts take their labels from the shared label table", () => {
  assert.equal(TOKEN_ROW_LABELS.terminal.en, "Terminal outside Relay");
  const en = text(shown("en"));
  for (const kind of ["former", "terminal", "unknown"] as const) assert.match(en, new RegExp(TOKEN_ROW_LABELS[kind].en));
  assert.doesNotMatch(en, /Eski hesap|Hesabı bilinmeyen|Relay dışı terminal/);
});

test("Usage keeps the token card on its own page, not on the limits page", () => {
  assert.doesNotMatch(render(createElement(Usage)), /Token kullanımı/);
  const tokens = render(createElement(Usage, { section: "tokens" }));
  assert.match(text(tokens), /Token ve ücret/);
  assert.match(tokens, /aria-label="Token kullanımı"/);
});

// The hook, mounted in a fake browser.
interface Pending {
  input: { range: number; accountId?: string };
  resolve(view: TokenUsageView): void;
  reject(error: Error): void;
}
function apiStub() {
  const calls: Pending[] = [];
  let changed: (() => void) | undefined;
  const api = {
    tokenUsage: (input: Pending["input"]) =>
      new Promise<TokenUsageView>((resolve, reject) => calls.push({ input, resolve, reject })),
    onChanged: (callback: () => void) => {
      changed = callback;
      return () => {
        changed = undefined;
      };
    },
  } as unknown as RelayAPI;
  return { api, calls, changed: () => changed?.(), listening: () => changed !== undefined };
}

test("TokenUsage loads on mount, on a new range or account, and follows its Relay", async () => {
  const stub = apiStub();
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const mount = (range: 7 | 30 | 90, accountId?: string) =>
      act(async () => root.render(tree(createElement(TokenUsage, { range, accountId }), "tr", relayFor(stub.api))));
    await mount(30);
    assert.deepEqual(stub.calls.map((c) => c.input), [{ range: 30 }]);
    assert.match(textOf(dom.container), /Token kaydı yükleniyor/);
    assert.ok(stub.listening());
    await act(async () => stub.calls[0].resolve(view));
    assert.match(textOf(dom.container), /Toplam · \d+ gün3,2 Mn/);
    await mount(7, "b");
    assert.deepEqual(stub.calls.map((c) => c.input), [{ range: 30 }, { range: 7, accountId: "b" }]);
    // The stale answer of the earlier request is dropped; the view stays.
    await act(async () => stub.calls[0].reject(new Error("late")));
    assert.doesNotMatch(textOf(dom.container), /late/);
    await act(async () => stub.calls[1].reject(new Error("Error invoking remote method 'relay:token-usage': Error: boom")));
    assert.match(textOf(dom.container), /Token kullanımı yenilenemedi\.\s*boom/);
    await act(async () => root.unmount());
    assert.equal(stub.listening(), false);
  } finally {
    dom.uninstall();
  }
});

test("TokenUsage asks again while the scan runs, and stops once it is complete", async (t) => {
  const stub = apiStub();
  const dom = fakeDom();
  dom.install();
  readableText();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(TokenUsage, { range: 30 }), "tr", relayFor(stub.api))));
    await act(async () => stub.calls[0].resolve({ ...view, progress: { percent: 10, complete: false } }));
    assert.equal(stub.calls.length, 1);
    await act(async () => t.mock.timers.tick(TOKEN_SCAN_POLL_MS));
    assert.equal(stub.calls.length, 2);
    await act(async () => stub.calls[1].resolve({ ...view, progress: { percent: 55, complete: false } }));
    assert.match(textOf(dom.container), /taranıyor… %55/);
    await act(async () => t.mock.timers.tick(TOKEN_SCAN_POLL_MS));
    assert.equal(stub.calls.length, 3);
    await act(async () => stub.calls[2].resolve(view));
    assert.doesNotMatch(textOf(dom.container), /taranıyor/);
    await act(async () => t.mock.timers.tick(TOKEN_SCAN_POLL_MS * 4));
    assert.equal(stub.calls.length, 3);
    await act(async () => root.unmount());
  } finally {
    t.mock.timers.reset();
    dom.uninstall();
  }
});

test("choosing a metric redraws the chart and the table for it; cache is write plus read", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(TokenUsageCard, { state: { view, loading: false }, accounts }))));
    const click = (label: string) => {
      const item = find(dom.container as unknown as Fake, (n) => n.tagName === "button" && textOf(n) === label);
      assert.ok(item, label);
      return act(async () => dom.dispatch(item, "click", { detail: 1 }));
    };
    const table = () => textOf(find(dom.container as unknown as Fake, (n) => n.tagName === "table"));
    await click("Gün gün tablo");
    assert.match(table(), /14 Eki2,1 Mn125 B———2,2 Mn/);
    // 14th: a has 800 000 read + 50 000 written, b 5 000 read. The 13th had none, and the terminal 3 000 read.
    await click("Önbellek");
    assert.match(table(), /14 Eki850 B5 B———855 B13 Eki——————12 Eki————3 B3 B/);
    await click("Çıktı");
    assert.match(table(), /14 Eki200 B20 B———220 B13 Eki≈tahmini 100 B————≈tahmini 100 B12 Eki———5 B—5 B11 Eki——1 B——1 B/);
    await click("Girdi");
    assert.match(table(), /14 Eki1 Mn100 B———1,1 Mn13 Eki≈tahmini 900 B————≈tahmini 900 B/);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("a day's detail names each row with its value and share; an estimated day and an empty day say so", () => {
  const columns = tokenColumns(view, accounts, (tr) => tr);
  const days = chartDays(view, columns, "total" as never);
  const detail = (date: string, language: Language = "tr") =>
    text(render(createElement(DayDetail, { day: days.find((d) => d.date === date)!, metric: "total" as never, metricLabel: language === "tr" ? "Toplam" : "Total" }), language));
  // The 14th (a Wednesday): the total, then each row with its share of the day.
  assert.equal(detail("2026-10-14"), "14 Ekim ÇarşambaToplam2,2 MnKişisel · Max2,1 Mn%94Vertex125 B%6");
  assert.equal(detail("2026-10-13"), "13 Ekim SalıToplam≈1 MnKişisel · Max≈1 Mn%100≈ Limit ölçümlerinden tahmin edildi");
  assert.equal(detail("2026-10-08"), "8 Ekim PerşembeToplam0Bu gün token yok.");
  assert.match(detail("2026-10-14", "en"), /^Wednesday 14 OctoberTotal2\.2m/);
});

test("Escape on the chart only puts the panda's day back; one a menu already handled leaves it", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(TokenUsageCard, { state: { view, loading: false }, accounts }))));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake, name: string) => (n as { attributes?: Map<string, string> }).attributes?.get?.(name);
    const slot = (name: string) => find(container, (n) => attr(n, "data-slot") === name);
    const panda = () => {
      const button = find(container, (n) => n.tagName === "button" && textOf(n) === "Panda anlatsın");
      assert.ok(button);
      return act(async () => dom.dispatch(button, "click", { detail: 1 }));
    };
    await panda();
    assert.ok(slot("panda-bench"));
    await act(async () => dom.dispatch(slot("token-chart-box")!, "keydown", { key: "Escape" }));
    assert.equal(slot("panda-bench"), undefined);
    assert.equal(attr(slot("token-chart-box")!, "data-taken"), undefined);
    // An Escape a menu already handled leaves the bench open; a plain one closes it.
    await panda();
    const escape = (handled: boolean) => {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
      if (handled) event.preventDefault();
      return act(async () => void (globalThis.document as unknown as EventTarget).dispatchEvent(event));
    };
    await escape(true);
    assert.ok(slot("panda-bench"));
    await escape(false);
    assert.equal(slot("panda-bench"), undefined);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the panda takes the busiest day apart: its parts and its lines one by one, with that day lit", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(TokenUsageCard, { state: { view, loading: false }, accounts }))));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake, name: string) => (n as { attributes?: Map<string, string> }).attributes?.get?.(name);
    const slot = (name: string) => find(container, (n) => attr(n, "data-slot") === name);
    const button = (label: string) => find(container, (n) => n.tagName === "button" && textOf(n) === label);
    const click = (label: string) => {
      const target = button(label);
      assert.ok(target, label);
      return act(async () => dom.dispatch(target, "click", { detail: 1 }));
    };
    const line = () => textOf(slot("panda-line"));
    const classed = (name: string) => {
      const count = (node: Fake): number =>
        (attr(node, "class")?.split(" ").includes(name) ? 1 : 0) + (node.childNodes ?? []).reduce((sum, c) => sum + count(c), 0);
      return count(container);
    };
    assert.equal(slot("panda-bench"), undefined);
    await click("Panda anlatsın");
    // The 14th is the busiest day: 2.2 million, mostly Kişisel · Max.
    const bench = textOf(slot("panda-bench"));
    assert.match(bench, /^14 Ekim ÇarşambaToplam 2,2 Mn/);
    assert.match(bench, /Önbellek okuma805 B %37Önbellek yazma50 B %2,3Girdi1,1 Mn %51Çıktı220 B %10/);
    // 220 000 output tokens are about 340 pages.
    assert.match(line(), /^Claude bugün ≈ 340 sayfa yazdı; .+ kadar\.$/);
    // Screen readers hear the day and the line once, when asked.
    assert.equal(textOf(slot("panda-say")), `14 Ekim Çarşamba: ${line()}`);
    // That day stays lit on the chart and the others fade; the bar itself does not move.
    assert.equal(attr(slot("token-chart-box")!, "data-taken"), "2026-10-14");
    assert.equal(classed("token-taken"), 0);
    await click("Bir daha");
    assert.equal(line(), "Claude bugün 2 milyon token okudu; bir insan durmadan okusa 4 gün sürerdi.");
    assert.equal(textOf(slot("panda-say")), "14 Ekim Çarşamba: Claude bugün 2 milyon token okudu; bir insan durmadan okusa 4 gün sürerdi.");
    await click("Bir daha");
    assert.equal(line(), "Bu günün yükünü büyük ölçüde Kişisel · Max çekti: %94.");
    // Asking about the same day again is one more line, too.
    await click("Panda anlatsın");
    assert.match(line(), /^Bu 7 günde Claude ≈ 500 sayfa yazdı/);
    await click("Kapat");
    assert.equal(slot("panda-bench"), undefined);
    assert.equal(textOf(slot("panda-say")), "");
    assert.equal(attr(slot("token-chart-box")!, "data-taken"), undefined);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("asked about an empty day, the panda only dozes, with nothing more to say", () => {
  const columns = tokenColumns(view, accounts, (tr) => tr);
  // The 8th has no tokens: its detail says so, and the panda's lines for it are the one doze.
  const empty = chartDays(view, columns, "total" as never).find((d) => d.date === "2026-10-08")!;
  assert.equal(empty.total, 0);
  assert.equal(text(render(createElement(DayDetail, { day: empty, metric: "total" as never, metricLabel: "Toplam" }))), "8 Ekim PerşembeToplam0Bu gün token yok.");
});

test("the Bugün tile shows today's tokens, their API value, the change and the line up to now", () => {
  const html = shown();
  const today = html.slice(html.indexOf('data-slot="token-today"'));
  const plain = text(today);
  assert.match(plain, /Bugün/);
  assert.match(plain, /Girdi\s*1,1 Mn/);
  assert.match(plain, /Önbellek\s*855 B/);
  assert.match(html, /data-slot="token-today-cost"[^>]*>(<!-- -->)?\$444,56</);
  assert.match(html, /data-slot="token-today-change"[^>]*>▲ (<!-- -->)?\+%57,2</);
  assert.match(html, /data-slot="token-today-yesterday"/);
  // The line stops at the current quarter hour: 53 points.
  assert.equal(todaySeries(view.today).length, 53);
  assert.match(plain, /53 çeyrek; en yüksek \$3,00; dünkü ortalama \$1,50/);
  const en = text(shown("en"));
  assert.match(en, /Today/);
  assert.match(en, /\$444\.56/);
  assert.match(en, /\+57\.2%/);
});

test("the Bugün card says since when the line is kept, and has no change or dashed line without yesterday", () => {
  const since = Date.parse("2026-10-14T08:30:00Z");
  const html = card({
    view: { ...view, today: { ...view.today, change: null, yesterdayAverage: null, slotsSince: since } },
    loading: false,
  });
  assert.match(text(html), /Gün içi çizgi için \d\d:\d\d öncesinde veri yok\./);
  assert.match(text(card({
    view: { ...view, today: { ...view.today, change: null, yesterdayAverage: null, slotsSince: since } },
    loading: false,
  }, "en")), /No line data before \d\d:\d\d\./);
  assert.doesNotMatch(html, /token-today-change|token-today-yesterday/);
});

test("the API value metric shows dollars in the legend and table, and the price list and unpriced models are named", () => {
  const html = card({
    view: { ...view, unpricedModels: ["mystery"], totals: { ...view.totals, unpriced: 1500 } },
    loading: false,
  });
  const plain = text(html);
  assert.match(tokenNotes(view, "cost" as never, (tr) => tr, "tr").join(" "), /Fiyatlar: Anthropic API liste fiyatları, 22 Eki 2026\./);
  assert.match(plain, /1,5 B token, fiyatı bilinmeyen modellerden geldi; tutara katılmadı \(mystery\)\./);
  assert.match(
    text(card({ view: { ...view, unpricedModels: ["mystery"], totals: { ...view.totals, unpriced: 1500 } }, loading: false }, "en")),
    /1\.5K tokens are from models with no known price and are not in the amount \(mystery\)\./i,
  );
  const table = render(
    createElement(DayTable, {
      view: {
        ...view,
        days: [{ date: "2026-10-14", byRow: { a: { ...cell(counts(1)), cost: 2.5, costEstimated: true as const } } }],
      },
      columns: tokenColumns(view, accounts, (tr) => tr),
      metric: "cost" as never,
    }),
  );
  assert.match(text(table), /≈\s*tahmini\s*\$2,50/);
});

test("the cost card splits the API value by account and by model, largest first, ≈ where estimated", () => {
  const priced: TokenUsageView = {
    ...view,
    rows: [
      { ...rows[1], totals: { ...rows[1].totals, cost: 10 } },
      { ...rows[0], totals: { ...rows[0].totals, cost: 90 } },
    ],
    totals: { ...view.totals, cost: 100 },
    models: [
      { model: "claude-sonnet-4", totals: { ...view.models[1].totals, cost: 25 } },
      { model: "claude-opus-4", totals: { ...view.models[0].totals, cost: 75 } },
    ],
  };
  const plain = text(render(createElement(CostBreakdown, { view: priced, accounts })));
  assert.match(plain, /^API karşılığıBu token’ların API liste fiyatıyla tutarı\./);
  assert.match(plain, /Aboneliğinin ücreti değildir/);
  assert.match(plain, /Hesaba göre.*Kişisel · Max%90≈\$90,00.*Vertex%10\$10,00/);
  assert.match(plain, /Modele göre.*claude-opus-4%75\$75,00.*claude-sonnet-4%25\$25,00/);
  // The total and its daily average are the summary's tile, not repeated here.
  assert.doesNotMatch(plain, /günde \$/);
  assert.doesNotMatch(plain, /son 7 gün/);
  const english = text(render(createElement(CostBreakdown, { view: priced, accounts }), "en"));
  assert.match(english, /API value.*By account.*By model/);
  assert.match(english, /It is not your subscription price\./);
});

test("the cost card stays out when nothing in the range was priced", () => {
  assert.equal(render(createElement(CostBreakdown, { view: { ...view, totals: { ...view.totals, cost: 0 } }, accounts })), "");
});
