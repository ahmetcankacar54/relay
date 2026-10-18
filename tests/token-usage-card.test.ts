import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Usage } from "../src/pages/Usage";
import { TokenUsage, TokenUsageCard } from "../src/pages/usage/TokenUsage";
import { TOKEN_SCAN_POLL_MS } from "../src/pages/usage/useTokenUsage";
import { formatTokens } from "../src/pages/usage/format";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type RelayAPI, type Snapshot } from "../shared/types";
import { TOKEN_ROW_LABELS, type TokenCounts, type TokenRow, type TokenUsageView } from "../shared/token-usage-view";
import { fakeDom } from "./fake-dom";

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
  totals: sum(...rows.map((r) => r.totals)),
  models: [
    { model: "claude-opus-4", totals: counts(1_500_000, 250_000, 50_000, 800_000) },
    { model: "claude-sonnet-4", totals: counts(547_000, 76_000, 0, 8_000) },
  ],
  progress: { percent: 100, complete: true },
  exactSince: "2026-10-12",
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
    I18nContext.Provider,
    { value: i18n(language) },
    createElement(RelayContext.Provider, { value: relay }, child),
  );
// Compact units come with a no-break space ("1,2 Mn"); the assertions below read it as a plain one.
const plainSpaces = (html: string) => html.replace(/\u00a0/g, " ");
const render = (child: ReactElement, language: Language = "tr") => plainSpaces(renderToStaticMarkup(tree(child, language)));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "’");
const card = (state: Parameters<typeof TokenUsageCard>[0]["state"], language: Language = "tr") =>
  render(createElement(TokenUsageCard, { state, accounts }), language);
const shown = (language: Language = "tr") => card({ view, loading: false }, language);
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

test("the card names itself, totals the range and splits it into four tiles", () => {
  const html = shown();
  const plain = text(html);
  assert.match(plain, /Token kullanımı/);
  assert.match(plain, /Toplam 3,2 Mn/);
  const tiles = [...html.matchAll(/data-slot="token-tile"[^>]*><div[^>]*>([^<]+)<\/div><div[^>]*>([^<]+)<\/div>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tiles, [
    ["Girdi", "2 Mn"],
    ["Çıktı", "326 B"],
    ["Önbellek yazma", "50 B"],
    ["Önbellek okuma", "808 B"],
  ]);
  // The exact count stays one hover away.
  assert.match(html, /title="2\.047\.000"/);

  const en = text(shown("en"));
  assert.match(en, /Token usage/);
  assert.match(en, /Total 3\.2m/);
  for (const label of ["Input", "Output", "Cache write", "Cache read"]) assert.match(en, new RegExp(label));
  assert.doesNotMatch(en, /Girdi|Çıktı|Önbellek/);
});

test("the metric toggle offers total, input, output and cache, total first", () => {
  const html = shown();
  assert.match(html, /data-slot="toggle-group"/);
  const items = [...html.matchAll(/data-slot="toggle-group-item"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(items, ["Toplam", "Girdi", "Çıktı", "Önbellek"]);
  assert.match(html, /data-state="on"[^>]*>Toplam</);
  assert.deepEqual(
    [...shown("en").matchAll(/data-slot="toggle-group-item"[^>]*>([^<]+)</g)].map((m) => m[1]),
    ["Total", "Input", "Output", "Cache"],
  );
});

test("the chart stacks one coloured segment per account and day with tokens", () => {
  const html = shown();
  const segments = html.match(/<rect[^>]*data-slot="token-segment"[^>]*>/g) ?? [];
  // 14th: a and b; 13th: a; 12th: unknown and terminal; 11th: former.
  assert.equal(segments.length, 6);
  assert.equal((html.match(/<g[^>]*role="img"[^>]*aria-label="[^"]+: [^"]+"/g) ?? []).length, 7);
  // Accounts take their position's tone; the former row comes after every account.
  assert.match(html, /fill="var\(--tone-1\)"/);
  assert.match(html, /fill="var\(--tone-2\)"/);
  assert.match(html, /fill="var\(--tone-3\)"/);
  assert.doesNotMatch(html, /fill="var\(--tone-4\)"/);
  // Terminal and unknown are muted.
  assert.equal((html.match(/<rect[^>]*data-slot="token-segment"[^>]*class="[^"]*fill-muted-foreground[^"]*"/g) ?? []).length, 2);
  // The legend names every row.
  const legend = text(html.slice(html.indexOf("<ul"), html.indexOf("</ul>")));
  for (const name of ["Kişisel · Max", "Vertex", "Eski hesap", "Hesabı bilinmeyen", "Relay dışı terminal"])
    assert.match(legend, new RegExp(name));
});

test("a segment's height follows the day's share of the busiest day", () => {
  const heights = (html: string) =>
    [...html.matchAll(/<rect[^>]*data-slot="token-segment"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  const all = heights(shown());
  assert.equal(all.length, 6);
  const plot = 114;
  const near = (expected: number) => all.some((h) => Math.abs(h - expected) < 0.01);
  // The 14th is the busiest day (2.175 million) and fills the whole plot: a holds 2.05, b 0.125 of it.
  assert.ok(near((2_050_000 / 2_175_000) * plot));
  assert.ok(near((125_000 / 2_175_000) * plot));
  // The 13th's 1 million is a bit under half of it.
  assert.ok(near((1_000_000 / 2_175_000) * plot));
});

test("a day's tooltip lists each account's value with ≈ when estimated, and the model mix", () => {
  const html = shown();
  const title = (date: string) => {
    const label = text(html).includes(date) ? date : date;
    return new RegExp(`<title>${label}\\n([^<]*)</title>`).exec(html)?.[1] ?? "";
  };
  const fourteenth = title("14 Eki");
  assert.match(fourteenth, /Kişisel · Max 2,1 Mn/);
  assert.match(fourteenth, /Vertex 125 B/);
  assert.doesNotMatch(fourteenth, /≈/);
  const thirteenth = title("13 Eki");
  assert.match(thirteenth, /Kişisel · Max ≈1 Mn/);
  const twelfth = title("12 Eki");
  assert.match(twelfth, /Hesabı bilinmeyen 45 B/);
  assert.match(twelfth, /Relay dışı terminal 3 B/);
  assert.match(fourteenth, /Aralıktaki modeller: claude-opus-4 %80 · claude-sonnet-4 %20/);
  assert.match(html, /<title>8 Eki<\/title>/);

  const en = shown("en");
  assert.match(en, /Former account 8k/);
  assert.match(en, /Models in this range: claude-opus-4 80% · claude-sonnet-4 20%/);
  assert.match(en, /Outside-Relay terminal 3k/);
});

test("the table lists days newest first with the rows from the view, then the total", () => {
  const html = shown();
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
  const html = shown();
  const tooltip = "Limit ölçümlerinden tahmin edildi";
  const estimated = [...html.matchAll(/<td[^>]*title="Limit ölçümlerinden tahmin edildi"[^>]*>(.*?)<\/td>/g)];
  // The 13th's account cell and its total.
  assert.deepEqual(estimated.map((c) => visible(c[1])), ["≈1 Mn", "≈1 Mn"]);
  assert.equal(html.split(tooltip).length - 1, 2);
  assert.match(shown("en"), /title="Estimated from limit samples"/);
});

test("estimated cells and chart days tell screen readers they are estimated, not only the tooltip", () => {
  const html = shown();
  const cells = [...html.matchAll(/<td[^>]*title="Limit ölçümlerinden tahmin edildi"[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  assert.equal(cells.length, 2);
  // The ≈ is hidden from screen readers, which hear "tahmini" instead.
  for (const cell of cells) assert.equal(cell, '<span aria-hidden="true">≈</span><span class="sr-only">tahmini </span>1 Mn');
  assert.match(shown("en"), /<span aria-hidden="true">≈<\/span><span class="sr-only">estimated <\/span>1m<\/td>/);
  // Exact cells say nothing of the kind.
  assert.equal(html.split('class="sr-only"').length - 1, 2);
  // Each chart day names its rows, the estimated ones as such.
  assert.match(html, /<g[^>]*role="img"[^>]*aria-label="13 Eki: 1 Mn; Kişisel · Max tahmini 1 Mn"/);
  assert.match(html, /<g[^>]*role="img"[^>]*aria-label="14 Eki: 2,2 Mn; Kişisel · Max 2,1 Mn; Vertex 125 B"/);
  assert.match(html, /<g[^>]*role="img"[^>]*aria-label="8 Eki: 0"/);
  assert.match(shown("en"), /aria-label="13 Oct: 1m; Kişisel · Max estimated 1m"/);
});

test("the coverage note says since when accounts match exactly, in both languages", () => {
  assert.match(
    text(shown()),
    /Kesin hesap eşleşmesi 12 Eki tarihinden beri tutuluyor; öncesi Relay’in limit ölçümlerinden tahmin edildi \(en fazla 14 gün\)\./,
  );
  const en = shown("en");
  assert.ok(en.includes("Relay’s limit samples (up to 14 days)."));
  assert.doesNotMatch(en, /Relay's/);
  assert.match(text(en), /Exact account matching since 12 Oct; earlier days are estimated/);
  assert.doesNotMatch(text(card({ view: { ...view, exactSince: undefined }, loading: false })), /Kesin hesap eşleşmesi/);
});

test("the progress note shows while the scan is incomplete, and only then", () => {
  const scanning = { ...view, progress: { percent: 42, complete: false } };
  assert.match(text(card({ view: scanning, loading: false })), /Konuşma kayıtları taranıyor… %42/);
  assert.match(text(card({ view: scanning, loading: false }, "en")), /Scanning conversation logs… 42%/);
  assert.doesNotMatch(text(shown()), /taranıyor/);
});

test("a range without tokens shows the empty state instead of the chart and table", () => {
  const empty: TokenUsageView = {
    ...view, days: DATES.map((date) => ({ date, byRow: {} })), rows: [], totals: counts(0, 0, 0, 0, 0), models: [],
    exactSince: undefined,
  };
  const html = card({ view: empty, loading: false });
  assert.match(text(html), /Token kullanımı/);
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
  assert.doesNotMatch(tr, /Kesin hesap eşleşmesi/);
  const en = text(card({ view: empty, loading: false }, "en"));
  assert.match(en, /Scanning conversation logs… 5%/);
  assert.doesNotMatch(en, /No token records/);
});

test("a ledger that cannot be saved says so, in both languages", () => {
  const unsaved: TokenUsageView = { ...view, progress: { percent: 100, complete: true, error: true } };
  assert.match(
    text(card({ view: unsaved, loading: false })),
    /Token kaydı kaydedilemiyor; Relay’i yeniden başlatınca tarama baştan yapılır\./,
  );
  assert.match(
    text(card({ view: unsaved, loading: false }, "en")),
    /Token records cannot be saved; the scan restarts after Relay restarts\./,
  );
  assert.doesNotMatch(text(shown()), /kaydedilemiyor/);
});

test("the card shows loading and failure states, and keeps the last view under a failed refresh", () => {
  assert.match(text(card({ loading: true })), /Token kullanımı[\s\S]*Token kaydı yükleniyor/);
  assert.match(text(card({ loading: true }, "en")), /Loading token usage/);
  const failed = card({ loading: false, error: "boom" });
  assert.match(failed, /role="alert"/);
  assert.match(text(failed), /Token kullanımı alınamadı[\s\S]*boom/);
  assert.match(text(card({ loading: false, error: "boom" }, "en")), /Could not load token usage/);
  const stale = card({ view, loading: false, error: "boom" });
  assert.match(stale, /role="alert"[^>]*>[\s\S]*Token kullanımı yenilenemedi\.[\s\S]*boom/);
  assert.match(text(stale), /Girdi/);
  assert.match(card({ view, loading: true }), /aria-busy="true"/);
});

test("rows that are not accounts take their labels from the shared label table", () => {
  assert.equal(TOKEN_ROW_LABELS.terminal.en, "Outside-Relay terminal");
  const en = text(shown("en"));
  for (const kind of ["former", "terminal", "unknown"] as const) assert.match(en, new RegExp(TOKEN_ROW_LABELS[kind].en));
  assert.doesNotMatch(en, /Eski hesap|Hesabı bilinmeyen|Relay dışı terminal/);
});

test("Usage puts the token card under the statistics and above the warnings", () => {
  const html = text(render(createElement(Usage)));
  assert.match(html, /Token kullanımı/);
  assert.ok(html.indexOf("İstatistikler yükleniyor") < html.indexOf("Token kullanımı"));
  assert.ok(html.indexOf("Token kullanımı") < html.indexOf("Uyarılar"));
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
// The fake browser keeps no text of its own: a lone string child goes through `textContent`, and a text
// node's update through `nodeValue`. This makes both readable.
type Fake = Record<string, unknown> & { childNodes: Fake[]; tagName: string };
function readableText() {
  const doc = globalThis.document as unknown as Record<string, (...args: unknown[]) => Fake>;
  const element = doc.createElement;
  const textNode = doc.createTextNode;
  doc.createElement = (tag) => {
    const el = element.call(doc, tag);
    let text = "";
    Object.defineProperty(el, "textContent", {
      get: () => text,
      set(value: string) {
        text = value;
        el.childNodes.length = 0;
      },
    });
    return el;
  };
  doc.createTextNode = (value) => {
    const node = textNode.call(doc, value);
    Object.defineProperty(node, "nodeValue", { get: () => node.data, set: (v: string) => void (node.data = v) });
    return node;
  };
}
const textOf = (node: unknown): string => {
  const n = node as { data?: string; childNodes?: unknown[]; textContent?: string };
  return plainSpaces((n.data ?? "") + (typeof n.textContent === "string" ? n.textContent : "") + (n.childNodes ?? []).map(textOf).join(""));
};
const find = (node: Fake, match: (node: Fake) => boolean): Fake | undefined =>
  match(node) ? node : node.childNodes.map((child) => find(child, match)).find(Boolean);

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
    assert.match(textOf(dom.container), /Toplam 3,2 Mn/);
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
