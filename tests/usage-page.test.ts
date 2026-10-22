import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Usage, UsageStatisticsSection, UsageWarnings } from "../src/pages/Usage";
import { SummaryTiles } from "../src/pages/usage/SummaryTiles";
import { AccountBalance } from "../src/pages/usage/AccountBalance";
import { DailyChart } from "../src/pages/usage/DailyChart";
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
import { dayTip, fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";

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
  insight: {
    tr: "Vertex (Team) dönemlerinin ortalama yalnızca %9 kadarını dolduruyor.",
    en: "Vertex (Team) fills only 9% of its windows.",
  },
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
const i18n = (language: Language) => ({
  language,
  setLanguage() {},
  t: (tr: string, en: string) => (language === "tr" ? tr : en),
});
const tree = (child: ReactElement, language: Language = "tr") =>
  createElement(
    I18nContext.Provider,
    { value: i18n(language) },
    createElement(RelayContext.Provider, { value: relayFor() }, child),
  );
const render = (child: ReactElement, language: Language = "tr") => renderToStaticMarkup(tree(child, language));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "’");

test("summary tiles format totals, change, windows, hits and the busiest time", () => {
  const html = text(render(createElement(SummaryTiles, { view })));
  assert.match(html, /1\.840 Pro birimi/);
  assert.match(html, /önceki 30 güne göre \+%12/);
  assert.match(html, /Başlayan dönem/);
  assert.match(html, /96/);
  assert.match(html, /günde ortalama 3,2/);
  assert.match(html, /Limite takılma7/);
  assert.match(html, /5 sa: 6 · haftalık: 1/);
  assert.match(html, /Salı 14:00/);
  assert.match(html, /hafta içi 10–18 arası %71/);

  // The unit stays on one line in smaller type beside the large number.
  assert.match(render(createElement(SummaryTiles, { view })), /1\.840 <span class="[^"]*whitespace-nowrap[^"]*">Pro birimi<\/span>/);

  const en = text(render(createElement(SummaryTiles, { view }), "en"));
  assert.match(en, /1,840 Pro units/);
  assert.match(en, /\+12% vs the previous 30 days/);
  assert.match(en, /3\.2 per day on average/);
  assert.match(en, /5 h: 6 · weekly: 1/);
  assert.match(en, /Tuesday 14:00/);
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

test("account balance lists names, plan badges, share, fill, idle days and the insight", () => {
  const html = render(createElement(AccountBalance, { view, accounts }));
  const plain = text(html);
  assert.match(plain, /Hesap dengesi/);
  assert.match(plain, /Kişisel · Max/);
  assert.match(html, /data-slot="badge"[^>]*>Max 5×</);
  assert.match(html, /data-slot="badge"[^>]*>Team · 8</);
  assert.match(plain, /%58/);
  assert.match(plain, /doluluk %71/);
  assert.match(plain, /boşta 2 gün/);
  assert.match(plain, /Eski hesap/);
  assert.match(plain, /doluluk —/);
  assert.match(plain, /Vertex \(Team\) dönemlerinin ortalama yalnızca %9 kadarını dolduruyor\./);
  // Share bars use the account tones, in account order; former rows after every account.
  assert.match(html, /bg-tone-1[^"]*" style="width:58%"/);
  assert.match(html, /bg-tone-2[^"]*" style="width:27%"/);
  assert.match(html, /bg-tone-4[^"]*" style="width:15%"/);
  // Rows share the parent's columns, so every share bar ends at the same x.
  assert.match(html, /sm:grid-cols-\[minmax\(0,9rem\)_1fr_auto_auto\]/);
  assert.equal((html.match(/class="[^"]*col-span-full[^"]*grid-cols-subgrid|class="[^"]*grid-cols-subgrid[^"]*col-span-full/g) ?? []).length, 3);
  // A filtered view keeps each account's colour.
  const filtered = render(createElement(AccountBalance, { view: { ...view, accounts: [view.accounts[1]] }, accounts }));
  assert.match(filtered, /bg-tone-2[^"]*" style="width:27%"/);

  const en = text(render(createElement(AccountBalance, { view, accounts }), "en"));
  assert.match(en, /Former account/);
  assert.doesNotMatch(en, /Eski hesap/);
  assert.match(en, /fill 71%/);
  assert.match(en, /idle 2 days/);
  assert.match(en, /idle 1 day(?!s)/);
  assert.match(en, /Vertex \(Team\) fills only 9% of its windows\./);
});

test("pointing at a day of the daily chart details each account and a limit hit", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(DailyChart, { view, accounts, zone: ZONE }))));
    const container = dom.container as unknown as Fake;
    const svg = find(container, (n) => n.tagName === "svg") as Fake & { box: { left: number; top: number; width: number; height: number } };
    svg.box = { left: 0, top: 0, width: 440, height: 146 };
    // The right edge is the newest day, the 14th, which hit a limit.
    await act(async () => dom.dispatch(svg, "pointermove", { clientX: 439, clientY: 60 }));
    assert.equal(dayTip(container), "14 Ekim ÇarşambaPro birimi120Kişisel · Max80Vertex40▲ Limite takıldı");
    await act(async () => dom.dispatch(svg, "keydown", { key: "Home" }));
    assert.equal(dayTip(container), "15 Eylül SalıPro birimi0Bu gün kullanım yok.");
    await act(async () => dom.dispatch(svg, "pointerout", { relatedTarget: null }));
    assert.equal(dayTip(container), undefined);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the daily chart draws one labelled bar group per day and marks hit days", () => {
  const html = render(createElement(DailyChart, { view, accounts, zone: ZONE }));
  const groups = html.match(/<g[^>]*aria-label="[^"]+: [\d.,]+ Pro birimi[^"]*"/g) ?? [];
  assert.equal(groups.length, 30);
  assert.match(html, /aria-label="14 Eki: 120 Pro birimi, limite takıldı"/);
  assert.match(html, /aria-label="9 Eki: 240 Pro birimi, limite takıldı"/);
  assert.match(html, /aria-label="15 Eyl: 0 Pro birimi"/);
  assert.equal((html.match(/<path d="[^"]+" fill="var\(--crit\)"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /▲<\/text>/);
  // Tones follow the account list; former rows come after every account.
  assert.match(html, /fill="var\(--tone-1\)"/);
  assert.match(html, /fill="var\(--tone-2\)"/);
  assert.match(html, /fill="var\(--tone-4\)"/);
  assert.doesNotMatch(html, /fill="var\(--tone-3\)"/);
  // The detail is the chart's own box on hover, not the browser's slow tooltip.
  assert.doesNotMatch(html, /<title>/);
  const plain = text(html);
  assert.match(plain, /30 günde toplam 1\.840 Pro birimi; en yoğun gün 9 Eki \(240\)\./);
  assert.match(plain, /▲ limite takılan günleri gösterir\./);

  const en = render(createElement(DailyChart, { view, accounts, zone: ZONE }), "en");
  assert.match(en, /aria-label="14 Oct: 120 Pro units, limit hit"/);
  assert.match(en, /Former account/);
});

test("the heatmap has 7 × 24 cells and names the busiest cell", () => {
  const html = render(createElement(UsageHeatmap, { view }));
  const cells = html.match(/title="[^"]+ \d\d:00 · [\d.,]+ Pro birimi"/g) ?? [];
  assert.equal(cells.length, 168);
  assert.match(html, /role="img" aria-label="[^"]*En yoğun: Salı 14:00, 120 Pro birimi/);
  assert.match(html, /title="Salı 14:00 · 120 Pro birimi"/);
  // Opacity follows the busiest cell.
  assert.match(html, /title="Perşembe 10:00 · 60 Pro birimi"[^>]*style="opacity:0\.5"|style="opacity:0\.5"[^>]*title="Perşembe 10:00/);
  assert.match(text(html), /Pzt/);
});

test("limit hits are listed newest first with how long they lasted", () => {
  const html = text(render(createElement(LimitHits, { view, zone: ZONE })));
  const first = html.indexOf("14 Eki 15:40");
  const second = html.indexOf("12 Eki 11:05");
  const third = html.indexOf("9 Eki 11:05");
  assert.ok(first >= 0 && second > first && third > second, html);
  assert.match(html, /Kişisel · Max · 5 saatlik · 1 sa 10 dk boyunca dolu/);
  assert.match(html, /Eski hesap · haftalık · sürüyor/);
  assert.match(html, /Vertex · 5 saatlik · 2 sa 30 dk boyunca dolu/);
  assert.match(html, /son 30 gün/);

  const en = text(render(createElement(LimitHits, { view, zone: ZONE }), "en"));
  assert.match(en, /full for 1 h 10 min/);
  assert.match(en, /Former account · weekly · ongoing/);
  const quiet = text(render(createElement(LimitHits, { view: { ...view, hits: [] }, zone: ZONE })));
  assert.match(quiet, /Bu dönemde limite takılma yok/);
});

test("the statistics section shows the full layout with the footnote", () => {
  const html = render(
    createElement(UsageStatisticsSection, { state: { view, loading: false }, accounts, zone: ZONE }),
  );
  const plain = text(html);
  for (const part of ["Toplam kullanım", "Hesap dengesi", "Günlük kullanım", "Ne zaman çalışıyorum?", "Limite takılmalar"])
    assert.match(plain, new RegExp(part.replace("?", "\\?")));
  assert.match(html, /grid-cols-2[^"]* lg:grid-cols-4/);
  assert.match(html, /lg:grid-cols-\[1\.5fr_1fr\]/);
  assert.match(plain, /token, mesaj ya da maliyet değildir/);
  assert.match(plain, /Gözlem kapsamı: %83/);
  assert.match(plain, /güncel plan kapasitesiyle/);
});

test("the statistics section shows the empty, unavailable, no-identity, loading and error states", () => {
  const section = (state: Parameters<typeof UsageStatisticsSection>[0]["state"], accountId?: string) =>
    text(render(createElement(UsageStatisticsSection, { state, accounts, zone: ZONE, accountId })));
  assert.match(section({ view: emptyView("empty"), loading: false }), /Veri birikiyor/);
  const unavailable = section({ view: emptyView("unavailable"), loading: false });
  assert.match(unavailable, /Kayıt okunamadı/);
  assert.match(unavailable, /Canlı limitler çalışmaya devam eder/);
  assert.match(section({ view: emptyView("empty"), loading: false }, "c"), /Bu hesap için kullanım kaydı yok/);
  // A connected account with no rows yet is still "collecting".
  assert.match(section({ view: emptyView("empty"), loading: false }, "a"), /Veri birikiyor/);
  // A signed-out account keeps the history recorded under its identity.
  const signedOut: Account = { ...a, id: "d", name: "Signed out", auth: { ...a.auth!, loggedIn: false } };
  const withSignedOut = text(render(createElement(UsageStatisticsSection, {
    state: { view: emptyView("empty"), loading: false }, accounts: [...accounts, signedOut], zone: ZONE, accountId: "d",
  })));
  assert.match(withSignedOut, /Veri birikiyor/);
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
  assert.match(en({ view: emptyView("empty"), loading: false }), /Collecting data/);
  assert.match(en({ view: emptyView("unavailable"), loading: false }), /Usage history could not be read/);
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

test("Usage is four tabs and opens the limits, with the range and account filter, by default", () => {
  const html = text(render(createElement(Usage)));
  assert.match(html, /LimitlerToken ve ücretKayıp EşyaUyarılar/);
  assert.match(html, /30 gün/);
  assert.match(html, /Tüm hesaplar/);
  assert.match(html, /İstatistikler yükleniyor/);
  // Only the open tab is drawn.
  assert.doesNotMatch(html, /Token kullanımı|Kayıp Eşya Bürosu|Limit uyarıları/);
  assert.match(text(render(createElement(Usage), "en")), /LimitsTokens and costLost and foundWarnings/);
});

test("the warnings tab holds the warning preferences and the data source", () => {
  const html = text(render(createElement(UsageWarnings)));
  assert.match(html, /Limit uyarıları/);
  assert.match(html, /Uyarı eşiği/);
  assert.match(html, /%80 kullanılınca/);
  assert.match(html, /Veri kaynağı ve sınırlar/);
});

test("Usage reopens the tab last open, and shows the range and account filter only with limits and tokens", async () => {
  for (const [stored, shows, hides] of [
    ["warnings", /Limit uyarıları/, /30 gün|Tüm hesaplar/],
    ["lost", /Kayıp Eşya Bürosu/, /30 gün|Tüm hesaplar/],
    ["tokens", /Token kullanımı.*/, /İstatistikler yükleniyor/],
    ["nonsense", /İstatistikler yükleniyor/, /Limit uyarıları/],
  ] as const) {
    const dom = fakeDom({ localStorage: () => ({ getItem: () => stored, setItem() {} }) });
    dom.install();
    readableText();
    const relay = {
      ...relayFor(),
      api: {
        usageStatistics: () => new Promise(() => {}),
        tokenUsage: () => new Promise(() => {}),
        lostFound: () => new Promise(() => {}),
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
            { value: i18n("tr") },
            createElement(RelayContext.Provider, { value: relay }, createElement(Usage)),
          ),
        ),
      );
      const shown = textOf(dom.container as unknown as Fake);
      assert.match(shown, shows, stored);
      assert.doesNotMatch(shown, hides, stored);
      await act(async () => root.unmount());
    } finally {
      dom.uninstall();
    }
  }
});

test("the warning threshold is phrased as what is used, for the stored values 80, 90 and 95", () => {
  const tr = text(render(createElement(UsageWarnings)));
  for (const used of [80, 90, 95]) assert.match(tr, new RegExp(`%${used} kullanılınca`));
  assert.doesNotMatch(tr, /kalınca|Kalan yüzde/);
  const en = text(render(createElement(UsageWarnings), "en"));
  for (const used of [80, 90, 95]) assert.match(en, new RegExp(`At ${used}% used`));
  assert.doesNotMatch(en, /% remaining|% left|Remaining percentage/);
});

test("Usage calls the warning threshold's scope a limit, not a window, in English", () => {
  const html = text(render(createElement(UsageWarnings), "en"));
  assert.match(html, /Applies to either the 5-hour or weekly usage limit\./);
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

test("statistics state keeps the last view while loading and after a failure", () => {
  const loaded = { view, loading: false };
  assert.deepEqual(statisticsLoading(loaded), { view, loading: true });
  const failed = statisticsFailed(statisticsLoading(loaded), new Error("Error invoking remote method 'relay:usage-statistics': Error: boom"));
  assert.deepEqual(failed, { view, loading: false, error: "boom" });
  // The error stays until the next response settles.
  assert.deepEqual(statisticsLoading(failed), { view, loading: true, error: "boom" });
  assert.deepEqual(statisticsFailed({ loading: true }, "down"), { loading: false, error: "down" });
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

test("hit markers on a 90-day chart fit their day and never overlap", () => {
  const html = render(createElement(DailyChart, { view: ninety, accounts, zone: ZONE }));
  const marks = [...html.matchAll(/<path d="M ([\d.]+) [\d.]+ L ([\d.]+) /g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(marks.length, 3);
  for (const [left, right] of marks) assert.ok(right - left > 0 && right - left <= 4, `${left}–${right}`);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i][0] > marks[i - 1][1], JSON.stringify(marks));
  const month = render(createElement(DailyChart, { view, accounts, zone: ZONE }));
  for (const m of month.matchAll(/<path d="M ([\d.]+) [\d.]+ L ([\d.]+) /g))
    assert.ok(Number(m[2]) - Number(m[1]) <= 6);
});

test("the daily chart's y labels fit five-digit maxima", () => {
  const html = render(createElement(DailyChart, { view: ninety, accounts, zone: ZONE }));
  const label = html.match(/<text x="([\d.]+)"[^>]*>12\.265<\/text>/);
  assert.ok(label, html.slice(0, 600));
  // End-anchored at x: six characters of about 5 units each fit left of it.
  assert.ok(Number(label[1]) >= 6 * 5, label[1]);
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
