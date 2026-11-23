import test from "node:test";
import { SwitchingPage } from "../src/pages/Settings";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Usage, UsageStatisticsSection, WarningThreshold } from "../src/pages/Usage";
import { SummaryTiles } from "../src/pages/usage/SummaryTiles";
import { AccountBalance } from "../src/pages/usage/AccountBalance";
import { costSummary } from "../src/pages/usage/cost-summary";
import type { TokenUsageView } from "../shared/token-usage-view";
import { costGuides, DailyChart, guideLabel } from "../src/pages/usage/DailyChart";
import { UsageHeatmap } from "../src/pages/usage/UsageHeatmap";
import { LimitHits } from "../src/pages/usage/LimitHits";
import { StatisticsHeader } from "../src/pages/usage/StatisticsHeader";
import {
  StatisticsRequests,
  STATISTICS_THROTTLE_MS,
  statisticsFailed,
  statisticsLoading,
} from "../src/pages/usage/useUsageStatistics";
import { errorMessage } from "../src/data/error-message";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type Snapshot } from "../shared/types";
import type { UsageStatisticsView } from "../shared/usage-statistics-view";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { fakeDom, readableText, textOf, type Fake } from "./fake-dom";
import { i18nValue } from "./i18n";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const ZONE = "Europe/Istanbul";
const iso = (ms: number) => new Date(ms).toISOString();
const desktop = { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: "a@example.com" };
const a: Account = {
  id: "a", name: "Kişisel · Max", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan: "max5", capacityWeight: 1 },
  desktop, auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const b: Account = {
  ...a, id: "b", name: "Vertex", planning: { plan: "team", capacityWeight: 8 },
  desktop: { ...desktop, email: "b@example.com" }, auth: { loggedIn: true, email: "b@example.com", checkedAt: iso(NOW) },
};
// Never connected: no usage identity.
const c: Account = { id: "c", name: "Studio", kind: "personal", group: "personal", color: "blue", createdAt: iso(NOW) };
const accounts = [a, b, c];
const settings = {
  ...DEFAULT_SETTINGS,
  planning: { ...DEFAULT_SETTINGS.planning, timeZone: ZONE },
};

const dates = Array.from({ length: 30 }, (_, i) =>
  new Date(Date.parse("2026-09-15T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10),
);
const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
heatmap[1][14] = 120;
heatmap[3][10] = 60;
const view: UsageStatisticsView = {
  range: 30,
  status: "available",
  coveragePercent: 83.4,
  totals: {
    proUnits: 1840.4,
    previousProUnits: 1643.2,
    windows: 96,
    hits: { fiveHour: 6, weekly: 1 },
    busiest: { weekday: 1, hour: 14, workShare: 71.2 },
    busiestWindow: { start: 13, end: 16 },
    periods: 18.4,
  },
  accounts: [
    { accountId: "a", name: "Kişisel · Max", plan: "Max 5×", proUnits: 1067.2, share: 58, averageFill: 71.3, idleDays: 2 },
    { accountId: "b", name: "Vertex", plan: "Team", proUnits: 496.8, share: 27, averageFill: 44, idleDays: 6 },
    { former: true, name: "Eski hesap", proUnits: 276.4, share: 15, idleDays: 1 },
  ],
  daily: dates.map((date): UsageStatisticsView["daily"][number] => ({
    date,
    byAccount:
      date === "2026-10-14" ? { a: 80, b: 40 }
      : date === "2026-10-12" ? { former: 20 }
      : date === "2026-10-09" ? { a: 240.4 }
      : {},
  })),
  heatmap,
  // Deliberately not newest first: the list sorts.
  hits: [
    { accountId: "b", name: "Vertex", kind: "five-hour", at: "2026-10-09T08:05:00.000Z", until: "2026-10-09T10:35:00.000Z" },
    { accountId: "a", name: "Kişisel · Max", kind: "five-hour", at: "2026-10-14T12:40:00.000Z", until: "2026-10-14T13:50:00.000Z" },
    { former: true, name: "Eski hesap", kind: "weekly", at: "2026-10-12T08:05:00.000Z" },
  ],
  insight: { id: "usageStatisticsView.fillsOnlyOfItsPeriods", params: { label: "Vertex (Team)", fill: 0.09 } },
};
const emptyView = (status: UsageStatisticsView["status"]): UsageStatisticsView => ({
  range: 30, status, coveragePercent: 0,
  totals: { proUnits: 0, windows: 0, hits: { fiveHour: 0, weekly: 0 } },
  accounts: [], daily: dates.map((date) => ({ date, byAccount: {} })),
  heatmap: Array.from({ length: 7 }, () => Array<number>(24).fill(0)), hits: [],
});

function relayFor(): Relay {
  return {
    api: {}, preview: false, error: "", notice: "", accounts, active: a, settings, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "a" },
    data: {
      settings, usage: {}, accounts, authFlows: [], diagnostics: { platform: "darwin" },
    } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {}, setData() {},
  } as unknown as Relay;
}
/** The page inside the shell's providers: the sections' ⓘ tips need the tooltip provider, as in the shell. */
const tree = (child: ReactElement, language: Language = "tr") =>
  createElement(
    TooltipProvider,
    null,
    createElement(
      I18nContext.Provider,
      { value: i18nValue(language) },
      createElement(RelayContext.Provider, { value: relayFor() }, child),
    ),
  );
const render = (child: ReactElement, language: Language = "tr") => renderToStaticMarkup(tree(child, language));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "’");

/** Token cells: `n` input tokens and their API value. */
const tokenCell = (n: number, cost: number, estimated = false) => ({
  input: n, output: 0, cacheWrite: 0, cacheRead: 0, responses: 1, cost, estimated,
});
const zeroCounts = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, responses: 0 };
// The same 30 days from the token ledger: the 14th $160 (a, b and the terminal), the 9th $30 for a, estimated.
const tokenView = {
  range: 30,
  days: dates.map((date) => ({
    date,
    byRow:
      date === "2026-10-14"
        ? { a: tokenCell(1_500_000, 120), b: tokenCell(600_000, 39.5), terminal: tokenCell(100_000, 0.5) }
        : date === "2026-10-09"
          ? { a: tokenCell(300_000, 30, true) }
          : {},
  })),
  rows: [
    { key: "a", kind: "account", accountId: "a", name: "Kişisel · Max", estimated: true, totals: { ...zeroCounts, input: 1_800_000, cost: 150 } },
    { key: "b", kind: "account", accountId: "b", name: "Vertex", estimated: false, totals: { ...zeroCounts, input: 600_000, cost: 39.5 } },
    { key: "terminal", kind: "terminal", estimated: false, totals: { ...zeroCounts, input: 100_000, cost: 0.5 } },
  ],
  totals: { ...zeroCounts, input: 2_500_000_000, cost: 190 },
} as unknown as TokenUsageView;
test("summary tiles speak only of limits: full periods, periods started, hits and the busiest hours", () => {
  const html = text(render(createElement(SummaryTiles, { view })));
  assert.match(html, /Kullanılan18 dolu dönem/);
  assert.match(html, /önceki 30 güne göre \+%12/);
  assert.match(html, /Başlayan dönem96günde ortalama 3,2/);
  assert.match(html, /Limite takılma76 beş saatlik, 1 haftalık/);
  assert.match(html, /En yoğun saatler13:00–16:00çalışma saatlerinde %71/);
  assert.doesNotMatch(html, /Pro birimi|API karşılığı|token/);
  // How much of the range Relay could read, and what the numbers count, is behind the section's ⓘ, not on the page.
  const markup = render(createElement(SummaryTiles, { view }));
  assert.match(markup, /data-slot="summary-tiles"[\s\S]*?<h2[^>]*>Özet<\/h2>[\s\S]*?aria-label="Nasıl çalışır"/);
  assert.doesNotMatch(html, /Bu aralığın %83 kadarında/);
  // The unit stays on one line in smaller type beside the large number.
  assert.match(render(createElement(SummaryTiles, { view })), /18 <span class="[^"]*whitespace-nowrap[^"]*">dolu dönem<\/span>/);
  const en = text(render(createElement(SummaryTiles, { view }), "en"));
  assert.match(en, /18 full periods/);
  assert.match(en, /\+12% vs the previous 30 days/);
  assert.match(en, /6 five-hour, 1 weekly/);
  assert.match(en, /71% in work hours/);
});

test("summary tiles explain a missing previous period and a range without one", () => {
  const noPrevious = { ...view, totals: { ...view.totals, previousProUnits: 0 } };
  assert.match(text(render(createElement(SummaryTiles, { view: noPrevious }))), /önceki 30 günde veri yok/);
  const ninety = { ...view, range: 90 as const, totals: { ...view.totals, previousProUnits: undefined } };
  const html = text(render(createElement(SummaryTiles, { view: ninety })));
  assert.match(html, /son 90 gün/);
  assert.doesNotMatch(html, /önceki/);
  const lower = { ...view, totals: { ...view.totals, previousProUnits: 2000 } };
  assert.match(text(render(createElement(SummaryTiles, { view: lower }))), /−%8/);
  assert.match(text(render(createElement(SummaryTiles, { view: lower }), "en")), /−8% vs the previous/);
});

test("account balance is a table: share, average fill and idle days under their headers, then the insight", () => {
  const html = render(createElement(AccountBalance, { view, accounts }));
  const plain = text(html);
  assert.match(plain, /Hesap dengesiHesapPayOrt\. doluluk/);
  assert.match(html, /data-slot="badge"[^>]*>Max 5×</);
  assert.match(html, /data-slot="badge"[^>]*>Team · 8</);
  assert.match(plain, /Kişisel · MaxMax 5×%58%712 gün/);
  assert.match(plain, /Eski hesap%15—1 gün/);
  assert.match(plain, /Vertex \(Team\) dönemlerinin ortalama yalnızca %9 kadarını dolduruyor\./);
  assert.doesNotMatch(plain, / · doluluk|boşta \d/);
  // Share bars take each account's own colour, as its dot (both fixture accounts are olive); a former account is grey.
  assert.match(html, /bg-account-olive[^"]*" style="width:58%"/);
  assert.match(html, /bg-account-olive[^"]*" style="width:27%"/);
  assert.match(html, /bg-account-none[^"]*" style="width:15%"/);
  const en = text(render(createElement(AccountBalance, { view, accounts }), "en"));
  assert.match(en, /Former account/);
  assert.match(en, /2 days/);
  assert.match(en, /1 day(?!s)/);
});

/** The daily chart's days as its screen-reader list ("Günlük değerler", "Daily values") says them, one line each. */
const dayLines = (html: string) => {
  const list = html.slice(html.search(/aria-label="(Günlük değerler|Daily values)"/));
  return [...list.slice(0, list.indexOf("</ul>")).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
};

test("the daily chart's series are the accounts in their own colours, and each day says its total and a limit hit", () => {
  // Recharts draws the bars and the pointer's day detail in the browser only; the page's markup carries the
  // series' colours and, for screen readers and as the chart's table, every day with its total and its hit.
  const html = render(createElement(DailyChart, { view, accounts, zone: ZONE }));
  assert.match(html, /--color-a: var\(--account-olive\)/);
  assert.match(html, /--color-b: var\(--account-olive\)/);
  assert.match(html, /--color-former: var\(--account-none\)/);
  const days = dayLines(html);
  assert.equal(days.at(-1), "14 Ekim Çarşamba: 120 dolu dönem, limite takıldı");
  assert.equal(days[0], "15 Eylül Salı: 0 dolu dönem");
  assert.equal(dayLines(render(createElement(DailyChart, { view, accounts, zone: ZONE }), "en")).at(-1), "Wednesday 14 October: 120 full periods, limit hit");
});

test("the daily chart draws one labelled bar group per day, in full periods, and marks hit days", () => {
  const html = render(createElement(DailyChart, { view, accounts, zone: ZONE }));
  // One line per day in the chart's list, each in full periods.
  const days = dayLines(html);
  assert.equal(days.length, 30);
  for (const day of days) assert.match(day, /^[^:]+: [\d.,]+ dolu dönem(, limite takıldı)?$/);
  // The 9th, the 12th and the 14th had a limit hit.
  assert.deepEqual(days.filter((day) => day.endsWith(", limite takıldı")).map((day) => day.split(":")[0]), [
    "9 Ekim Cuma",
    "12 Ekim Pazartesi",
    "14 Ekim Çarşamba",
  ]);
  assert.match(html, /<section data-slot="daily-chart"[^>]*>[\s\S]*?<h2[^>]*>Günlük<\/h2>/);
  assert.doesNotMatch(html, /<title>/);
  // On the Limits tab the chart has no unit switch.
  assert.doesNotMatch(html, /data-slot="toggle-group"/);
  const plain = text(html);
  assert.match(plain, /30 günde [\d.,]+ dolu dönem\. En yoğun gün 9 Eki: 240\./);
  const en = dayLines(render(createElement(DailyChart, { view, accounts, zone: ZONE }), "en"));
  assert.ok(en.includes("Wednesday 14 October: 120 full periods, limit hit"), en.join("\n"));
});

test("the daily chart's $ guides sit at round values from the data's scale", () => {
  assert.deepEqual(costGuides(160), [75, 150]);
  assert.deepEqual(costGuides(300), [150, 300]);
  assert.deepEqual(costGuides(99), [40, 80]);
  assert.deepEqual(costGuides(1.2), [0.5, 1]);
  assert.equal(costGuides(0.05), undefined);
  assert.equal(costGuides(0), undefined);
  // Their labels drop the cents a round value does not need.
  assert.equal(guideLabel(75, "tr"), "$75");
  assert.equal(guideLabel(2.5, "tr"), "$2,5");
  assert.equal(guideLabel(1500, "en"), "$1,500");
});

test("given a token view the daily chart still switches to tokens and the API value", () => {
  const html = render(createElement(DailyChart, { view, tokens: tokenView, accounts, zone: ZONE }));
  // The measure switch sits beside the section's title, the API value named for screen readers.
  const toggle = /<h2[^>]*>Günlük<\/h2>[\s\S]*?(<div[^>]*data-slot="toggle-group"[^>]*>)/.exec(html)?.[1] ?? "";
  assert.match(toggle, /aria-label="Ölçü"/);
  assert.match(html, /aria-label="API karşılığı"/);
  // It starts on the limits, in full periods.
  assert.equal(dayLines(html).at(-1), "14 Ekim Çarşamba: 120 dolu dönem, limite takıldı");
});

test("the heatmap has 7 × 24 cells in five even steps, day and hour totals, and the busiest hours", () => {
  const html = render(createElement(UsageHeatmap, { view }));
  assert.equal((html.match(/data-step="\d"/g) ?? []).length, 168);
  assert.match(html, /role="img" aria-label="Gün ve saate göre kullanım\. En yoğun saatler 13:00–16:00\."/);
  assert.match(html, /data-step="5"[^>]*title="Sal 14:00 · en yoğun saate göre %100"|title="Sal 14:00 · en yoğun saate göre %100"[^>]*data-step="5"/);
  assert.match(html, /title="Pzt 03:00 · kullanım yok"/);
  assert.match(html, /data-slot="usage-heatmap"[^>]*>[\s\S]*?<h2[^>]*>Çalışma saatleri<\/h2>/);
  const plain = text(html);
  // The busiest hours and the share in work hours are the summary's tile, not a list under the grid.
  assert.doesNotMatch(html, /<dl/);
  assert.doesNotMatch(plain, /Çalışma saatlerinde%/);
  assert.doesNotMatch(plain, /Pro birimi|10–18/);
  // A range without use says so under the grid.
  assert.match(text(render(createElement(UsageHeatmap, { view: emptyView("available") }))), /Bu aralıkta kullanım yok\./);
});

test("limit hits are a table, newest first, with how long each stayed full", () => {
  const html = text(render(createElement(LimitHits, { view, zone: ZONE })));
  assert.match(html, /ZamanHesapLimitDolu kaldı/);
  const first = html.indexOf("14 Eki 15:40");
  const second = html.indexOf("12 Eki 11:05");
  const third = html.indexOf("9 Eki 11:05");
  assert.ok(first >= 0 && second > first && third > second, html);
  assert.match(html, /Kişisel · Max5 saatlik1 sa 10 dk/);
  assert.match(html, /Eski hesaphaftalıksürüyor/);
  const en = text(render(createElement(LimitHits, { view, zone: ZONE }), "en"));
  assert.match(en, /Former accountweeklyongoing/);
  const quiet = text(render(createElement(LimitHits, { view: { ...view, hits: [] }, zone: ZONE })));
  assert.match(quiet, /Bu aralıkta limite takılma yok/);
});

test("the statistics section is limits only, in its order, with the explanation behind the summary's ⓘ", () => {
  const html = render(
    createElement(UsageStatisticsSection, { state: { view, loading: false }, accounts, zone: ZONE }),
  );
  // The summary, the days, the balance beside the hits, then the working hours: each a titled section.
  const titles = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ["Özet", "Günlük", "Hesap dengesi", "Limite takılmalar", "Çalışma saatleri"]);
  assert.match(text(html), /Kullanılan/);
  // How the numbers are made is the summary's ⓘ, not a disclosure at the bottom.
  assert.match(html, /data-slot="summary-tiles"[\s\S]*?aria-label="Nasıl çalışır"/);
  assert.doesNotMatch(html, /<details|Bu sayılar nasıl hesaplanıyor/);
  // Tokens and the API value live on their own tab, even when a token view is given.
  const withTokens = render(
    createElement(UsageStatisticsSection, { state: { view, loading: false }, accounts, zone: ZONE, tokens: tokenView }),
  );
  assert.doesNotMatch(withTokens, /data-slot="toggle-group"|range-tokens|API karşılığı \$/);
});

test("the statistics section shows the empty, unavailable, no-identity, loading and error states", () => {
  const section = (state: Parameters<typeof UsageStatisticsSection>[0]["state"], accountId?: string) =>
    text(render(createElement(UsageStatisticsSection, { state, accounts, zone: ZONE, accountId })));
  assert.match(section({ view: emptyView("empty"), loading: false }), /Henüz veri yok/);
  const unavailable = section({ view: emptyView("unavailable"), loading: false });
  assert.match(unavailable, /Kullanım geçmişi okunamadı/);
  assert.match(unavailable, /Canlı limitler çalışmaya devam eder/);
  assert.match(section({ view: emptyView("empty"), loading: false }, "c"), /Bu hesap için kullanım kaydı yok/);
  // A connected account with no rows yet is still "collecting".
  assert.match(section({ view: emptyView("empty"), loading: false }, "a"), /Henüz veri yok/);
  // A signed-out account keeps the history recorded under its identity.
  const signedOut: Account = { ...a, id: "d", name: "Signed out", auth: { ...a.auth!, loggedIn: false } };
  const withSignedOut = text(render(createElement(UsageStatisticsSection, {
    state: { view: emptyView("empty"), loading: false }, accounts: [...accounts, signedOut], zone: ZONE, accountId: "d",
  })));
  assert.match(withSignedOut, /Henüz veri yok/);
  assert.doesNotMatch(withSignedOut, /Bu hesap için kullanım kaydı yok/);
  assert.match(section({ loading: true }), /İstatistikler yükleniyor/);
  assert.match(section({ loading: false, error: "boom" }), /İstatistikler alınamadı/);
  // A failed refresh keeps the last view under a short alert.
  const stale = render(createElement(UsageStatisticsSection, { state: { view, loading: false, error: "boom" }, accounts, zone: ZONE }));
  assert.match(stale, /role="alert"[^>]*>.*İstatistikler yenilenemedi\..*boom/);
  assert.match(text(stale), /Hesap dengesi/);
  assert.doesNotMatch(text(stale), /İstatistikler alınamadı/);
  for (const html of [section({ view: emptyView("empty"), loading: false }), section({ loading: true })])
    assert.doesNotMatch(html, /Hesap dengesi|Limite takılmalar/);

  const en = (state: Parameters<typeof UsageStatisticsSection>[0]["state"], accountId?: string) =>
    text(render(createElement(UsageStatisticsSection, { state, accounts, zone: ZONE, accountId }), "en"));
  assert.match(en({ view: emptyView("empty"), loading: false }), /No data yet/);
  assert.match(en({ view: emptyView("unavailable"), loading: false }), /Cannot read the usage history/);
  assert.match(en({ view: emptyView("empty"), loading: false }, "c"), /No usage record for this account/);
});

test("the header offers 7/30/90 days and an account filter", () => {
  const html = render(
    createElement(StatisticsHeader, { range: 30, onRange() {}, accountId: undefined, onAccount() {}, accounts }),
  );
  const plain = text(html);
  for (const label of ["7 gün", "30 gün", "90 gün", "Tüm hesaplar"]) assert.match(plain, new RegExp(label));
  assert.match(html, /aria-checked="true"[^>]*>30 gün|data-state="on"[^>]*>30 gün/);
  const filtered = text(
    render(createElement(StatisticsHeader, { range: 7, onRange() {}, accountId: "b", onAccount() {}, accounts }), "en"),
  );
  assert.match(filtered, /Vertex/);
  assert.match(filtered, /7 days/);
});

test("Usage's limits page has the range and account filter, and no tabs", () => {
  const markup = render(createElement(Usage));
  const html = text(markup);
  assert.match(markup, /<h1[^>]*>Limit geçmişi<\/h1>/);
  assert.doesNotMatch(markup, /role="tab"/);
  assert.doesNotMatch(html, /Token ve ücretRozetler/);
  // History only: today's limits of every account are on the Overview, not a board here.
  assert.doesNotMatch(markup, /data-slot="limits-now"|>Şu an</);
  // The warnings moved to Settings → Notifications.
  assert.doesNotMatch(html, /Uyarılar/);
  assert.match(html, /30 gün/);
  assert.match(html, /Tüm hesaplar/);
  assert.match(html, /İstatistikler yükleniyor/);
  // Only the page's own section is drawn.
  assert.doesNotMatch(html, /Token kullanımı|Kayıp Eşya Bürosu|Limit uyarıları/);
  assert.match(render(createElement(Usage), "en"), /<h1[^>]*>Limit history<\/h1>/);
});

test("each Usage page draws its own section, and the range and account filter only with limits and tokens", async () => {
  for (const [section, shows, hides] of [
    ["limits", /İstatistikler yükleniyor/, /Token kullanımı|Rozet koleksiyonu/],
    ["lost", /Rozet koleksiyonu/, /30 gün|Tüm hesaplar/],
    // The token page names itself to assistive tech; on screen its loading line is what shows first.
    ["tokens", /Token kaydı yükleniyor/, /İstatistikler yükleniyor/],
  ] as const) {
    const dom = fakeDom({ localStorage: () => ({ getItem: () => null, setItem() {} }) });
    dom.install();
    readableText();
    const relay = {
      ...relayFor(),
      api: {
        usageStatistics: () => new Promise(() => {}),
        tokenUsage: () => new Promise(() => {}),
        lostFoundCollection: () => new Promise(() => {}),
        onChanged: () => () => {},
      },
    } as unknown as Relay;
    try {
      const { createRoot } = await import("react-dom/client");
      const root = createRoot(dom.container as unknown as Element);
      await act(async () =>
        root.render(
          createElement(
            I18nContext.Provider,
            { value: i18nValue("tr") },
            createElement(RelayContext.Provider, { value: relay }, createElement(Usage, { section })),
          ),
        ),
      );
      const shown = textOf(dom.container as unknown as Fake);
      assert.match(shown, shows, section);
      assert.doesNotMatch(shown, hides, section);
      await act(async () => root.unmount());
    } finally {
      dom.uninstall();
    }
  }
});

test("the warning threshold is phrased as what is used, for the stored values 80, 90 and 95", () => {
  const tr = text(render(createElement(WarningThreshold, { labelledBy: "x" })));
  for (const used of [80, 90, 95]) assert.match(tr, new RegExp(`%${used} kullanılınca`));
  assert.doesNotMatch(tr, /kalınca|Kalan yüzde/);
  const en = text(render(createElement(WarningThreshold, { labelledBy: "x" }), "en"));
  for (const used of [80, 90, 95]) assert.match(en, new RegExp(`At ${used}% used`));
  assert.doesNotMatch(en, /% remaining|% left|Remaining percentage/);
});

test("Settings calls the warning threshold's scope usage, not a window, in English", () => {
  const html = text(render(createElement(SwitchingPage), "en"));
  assert.match(html, /For the 5-hour and weekly periods\./);
  assert.doesNotMatch(html, /usage window/);
});

test("Usage leaves the refresh interval and suggestions to other pages", () => {
  const html = render(createElement(Usage));
  assert.doesNotMatch(html, /Limit yaklaşınca hesap öner/);
  assert.doesNotMatch(html, /Yenileme sıklığı|Otomatik yenileme/);
});

test("IPC errors lose Electron's remote-method prefix", () => {
  assert.equal(errorMessage(new Error("Error invoking remote method 'relay:usage-statistics': Error: Kayıt okunamadı")), "Kayıt okunamadı");
  assert.equal(errorMessage(new Error("Error invoking remote method 'relay:usage-statistics': TypeError: boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(new Error("local")), "local");
});

test("statistics requests: only the latest response applies and changes refetch at most every 30 s", () => {
  const requests = new StatisticsRequests();
  assert.equal(requests.wait(5_000), 0);
  const first = requests.start(1_000);
  const second = requests.start(2_000);
  assert.equal(requests.current(first), false);
  assert.equal(requests.current(second), true);
  assert.equal(STATISTICS_THROTTLE_MS, 30_000);
  assert.equal(requests.wait(2_000), 30_000);
  assert.equal(requests.wait(22_000), 10_000);
  assert.equal(requests.wait(32_000), 0);
  assert.equal(requests.wait(60_000), 0);
});

test("statistics state keeps the last view while reloading and drops it after a failure", () => {
  const loaded = { view, loading: false };
  assert.deepEqual(statisticsLoading(loaded), { view, loading: true });
  const failed = statisticsFailed(new Error("Error invoking remote method 'relay:usage-statistics': Error: boom"));
  assert.deepEqual(failed, { loading: false, error: "boom" });
  // The error stays until the next response settles.
  assert.deepEqual(statisticsLoading(failed), { loading: true, error: "boom" });
  assert.deepEqual(statisticsFailed("down"), { loading: false, error: "down" });
});

const ninetyDays = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.parse("2026-07-17T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10),
);
const ninety: UsageStatisticsView = {
  ...view,
  range: 90,
  daily: ninetyDays.map((date, i): UsageStatisticsView["daily"][number] => ({ date, byAccount: i >= 80 ? { a: 12_345 - i } : {} })),
  // Hits on three adjacent days.
  hits: ["2026-10-10T09:00:00.000Z", "2026-10-11T09:00:00.000Z", "2026-10-12T09:00:00.000Z"].map((at) => ({
    accountId: "a", name: "Kişisel · Max", kind: "five-hour" as const, at,
  })),
};

test("on a 90-day chart each hit day is marked on its own day, adjacent ones too", () => {
  // Recharts places the ▲ on its day's bar in the browser; the days list marks the same days, one each.
  const days = dayLines(render(createElement(DailyChart, { view: ninety, accounts, zone: ZONE })));
  assert.equal(days.length, 90);
  const hit = days.flatMap((day, i) => (day.endsWith(", limite takıldı") ? [i] : []));
  assert.deepEqual(hit.map((i) => days[i].split(":")[0]), ["10 Ekim Cumartesi", "11 Ekim Pazar", "12 Ekim Pazartesi"]);
  assert.deepEqual(hit, [hit[0], hit[0] + 1, hit[0] + 2]);
});

test("the daily chart writes five-digit days in full, with the thousands separator", () => {
  // The y labels are Recharts' (drawn in the browser) and use the same number format as these lines.
  const html = render(createElement(DailyChart, { view: ninety, accounts, zone: ZONE }));
  assert.ok(dayLines(html).includes("5 Ekim Pazartesi: 12.265 dolu dönem"), dayLines(html).slice(78, 82).join("\n"));
  assert.match(text(html), /En yoğun gün 5 Eki: 12\.265\./);
});

test("statistics cards reuse their number and date formatters", (t) => {
  render(createElement(UsageHeatmap, { view }));
  const numbers = t.mock.method(Intl, "NumberFormat");
  const dates = t.mock.method(Intl, "DateTimeFormat");
  render(createElement(UsageHeatmap, { view }));
  assert.equal(numbers.mock.callCount(), 0);
  assert.equal(dates.mock.callCount(), 0);
});

test("statistics messages carry the panda for their state, none while loading", () => {
  const scene = (state: Parameters<typeof UsageStatisticsSection>[0]["state"], accountId?: string) =>
    /data-scene="([^"]+)"/.exec(render(createElement(UsageStatisticsSection, { state, accounts, zone: ZONE, accountId })))?.[1];
  assert.equal(scene({ loading: false, error: "boom" }), "trouble");
  assert.equal(scene({ view: emptyView("unavailable"), loading: false }), "trouble");
  assert.equal(scene({ view: emptyView("empty"), loading: false }), "collecting");
  assert.equal(scene({ view: emptyView("empty"), loading: false }, "c"), "lookout");
  assert.equal(scene({ loading: false }), "lookout");
  assert.equal(scene({ loading: true }), undefined);
});

test("every statistics message panda is playful: a click on it plays a trick", () => {
  const html = (state: Parameters<typeof UsageStatisticsSection>[0]["state"], accountId?: string) =>
    render(createElement(UsageStatisticsSection, { state, accounts, zone: ZONE, accountId }));
  const playful = /<span data-playful="true" class="inline-block shrink-0 overflow-hidden" style="width:72px;height:72px"><svg[^>]*data-scene="([^"]+)"/;
  assert.equal(playful.exec(html({ loading: false, error: "boom" }))?.[1], "trouble");
  assert.equal(playful.exec(html({ view: emptyView("unavailable"), loading: false }))?.[1], "trouble");
  assert.equal(playful.exec(html({ view: emptyView("empty"), loading: false }))?.[1], "collecting");
  assert.equal(playful.exec(html({ view: emptyView("empty"), loading: false }, "c"))?.[1], "lookout");
  assert.equal(playful.exec(html({ loading: false }))?.[1], "lookout");
  // Loading draws no panda, and a statistics view has none to click.
  assert.doesNotMatch(html({ loading: true }), /data-playful/);
  assert.doesNotMatch(html({ view, loading: false }), /data-playful/);
});

test("the Limits tab's tiles and balance never show tokens or the API value", () => {
  assert.doesNotMatch(text(render(createElement(SummaryTiles, { view }))), /API karşılığı|token/);
  assert.doesNotMatch(text(render(createElement(AccountBalance, { view, accounts }))), /\$/);
});

test("the cost summary takes the range's total, its daily average and the account rows", () => {
  const priced = costSummary({
    range: 7,
    days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-1${i}`, byRow: {} })),
    rows: [
      { key: "a", kind: "account", accountId: "a", estimated: false, totals: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, responses: 1, cost: 60 } },
      { key: "b", kind: "account", accountId: "b", estimated: true, totals: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, responses: 1, cost: 10 } },
      { key: "terminal", kind: "terminal", estimated: false, totals: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, responses: 1, cost: 0.5 } },
    ],
    totals: { input: 3, output: 3, cacheWrite: 0, cacheRead: 0, responses: 3, cost: 70.5 },
  } as unknown as TokenUsageView);
  assert.deepEqual(priced, {
    total: 70.5,
    estimated: false,
    perDay: 70.5 / 7,
    byAccount: { a: { cost: 60, estimated: false }, b: { cost: 10, estimated: true } },
  });
  assert.equal(costSummary(undefined), undefined);
  assert.equal(costSummary({ range: 7, days: [], rows: [], totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, responses: 0 } } as unknown as TokenUsageView), undefined);
});
