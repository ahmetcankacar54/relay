import test from "node:test";
import assert from "node:assert/strict";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PlanSettings, PlanningPanel, planningModel, type PlanningPanelProps } from "../src/features/PlanningPanel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { I18nContext } from "../src/data/i18n";
import type { Locale } from "../shared/i18n/locales";
import { i18nValue, testT } from "./i18n";
import { AdaptiveRow } from "../src/pages/planning/AdaptiveRow";
import { Switch } from "../src/components/ui/switch";
import { wallTime } from "../shared/planning";
import { dayPlan, planContext } from "../shared/day-plan";
import { presetTempo, type Tempo } from "../shared/tempo";
import { liveForecast } from "../shared/live-forecast";
import { dayTimeline } from "../src/lib/day-timeline";
import { forecastSummary } from "../src/lib/forecast-text";
import { planningUsage } from "./planning-fixtures";
import {
  DEFAULT_PLANNING,
  type Account,
  type AccountUsage,
  type KeeperAccountStatus,
  type KeeperAdaptation,
  type KeeperSnapshot,
  type PlanningSettings,
  type TempoChoice,
} from "../shared/types";

const ZONE = "Europe/Istanbul";
const NOW = wallTime("2026-10-13", "10:00", ZONE)!;
const account = (name: string): Account => ({
  id: randomUUID(),
  name,
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: new Date(NOW).toISOString(),
  planning: { plan: "max5", capacityWeight: 1 },
});
const [a, b] = [account("Kişisel - Max"), account("Vertex")];
const panelSettings = (settings: Partial<PlanningSettings>) => ({
  ...DEFAULT_PLANNING,
  timeZone: ZONE,
  weekday: { enabled: true, start: "09:00", end: "21:00" },
  ...settings,
});
/** Today's plan with the default tempo the panel assumes without a keeper tempo. */
const todayPlan = (settings: Partial<PlanningSettings>) =>
  dayPlan(
    "2026-10-13",
    panelSettings(settings),
    planContext([a, b], presetTempo("medium", "default")),
  );
const clock = (time: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(time);
/** The early start group's next start row with exactly this value. */
const nextStartRow = (value: string) =>
  new RegExp(
    `data-slot="next-start"[^>]*><span>Sonraki başlatma</span><span[^>]*>${value}</span>`,
  );
/** The hh:mm shown in an account's first-start field, found by its label. */
const firstStart = (html: string, account: string) =>
  new RegExp(
    `>${account} ilk başlangıç</label>.*?role="spinbutton".*?\\svalue="(\\d\\d:\\d\\d)"`,
  ).exec(html)?.[1];
/** Inside the shell's Turkish language and tooltip providers (the ⓘ notes need both). */
const shell = (props: PlanningPanelProps, child: ReactElement) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue(props.language) },
      createElement(TooltipProvider, null, child),
    ),
  );
/** The page. */
const page = (props: PlanningPanelProps) => shell(props, createElement(PlanningPanel, props));
/** The "Plan ayarları" sheet's content for the same props (the sheet itself opens only in a browser). */
const sheetProps = (props: PlanningPanelProps) => ({
  settings: props.settings,
  model: planningModel(props),
  accounts: props.accounts,
  disabled: props.disabled,
  update: props.update,
  t: props.t,
  platform: props.platform,
  now: props.now,
});
const sheet = (props: PlanningPanelProps) => shell(props, createElement(PlanSettings, sheetProps(props)));
const panelProps = (settings: Partial<PlanningSettings>, keeper?: KeeperSnapshot): PlanningPanelProps => ({
  settings: panelSettings(settings),
  keeper,
  accounts: [a, b],
  usage: {},
  disabled: false,
  t: testT("tr"),
  language: "tr",
  now: NOW,
  update: () => {},
  updateAccount: () => {},
});
function render(settings: Partial<PlanningSettings>, keeper?: KeeperSnapshot) {
  return page(panelProps(settings, keeper));
}
function renderSheet(settings: Partial<PlanningSettings>, keeper?: KeeperSnapshot) {
  return sheet(panelProps(settings, keeper));
}
/** An account's status in the plan's list: its tone, its few words and its full sentence (the title). */
const statusOf = (html: string, sentence: string) =>
  html.match(new RegExp(`data-tone="(\\w+)" title="${sentence}"[^>]*>.*?<span class="truncate">([^<]*)</span>`))?.slice(1, 3);
/** Today's live forecast under "Sıradaki": its dot's tone and its text. */
const nextForecast = (html: string) =>
  html.match(/data-slot="live-forecast"[^>]*><span[^>]*class="[^"]*bg-(ok|warn)[^"]*"><\/span>([^<]*)</)?.slice(1, 3);

test("the sheet holds the switch and both hour rows; the page shows automatic first starts", () => {
  const accounts = [{ id: a.id }, { id: b.id }];
  const html = render({ accounts });
  const settings = renderSheet({ accounts });
  assert.match(settings, /Çalışma saatlerinde limit dönemlerini açık tut/);
  assert.match(settings, /Hafta içi/);
  assert.match(settings, /Hafta sonu/);
  const [first, second] = todayPlan({ accounts }).accounts;
  assert.equal(firstStart(html, "Kişisel - Max"), clock(first.firstStart));
  assert.equal(firstStart(html, "Vertex"), clock(second.firstStart));
  // An automatic start needs no word; only a manual one offers the way back.
  assert.doesNotMatch(html, /Otomatiğe dön/);
});

test("the page is the plan: today first, then the plan's accounts; the settings are in the sheet", () => {
  const html = render({ accounts: [{ id: a.id }, { id: b.id }] });
  const today = html.indexOf(">Bugün<");
  const list = html.indexOf(">Plandaki hesaplar<");
  const accountRows = html.indexOf("ilk başlangıç</label>");
  assert.ok(today >= 0, "Bugün is drawn");
  assert.ok(today < list, "Bugün before the plan's accounts");
  assert.ok(list < accountRows, "the list heading before its rows");
  assert.doesNotMatch(html, /Çalışma saatlerinde limit dönemlerini açık tut|Hafta içi|Saat dilimi/);
  // The sheet: early start, then the hours and tempo, then the time zone.
  const settings = renderSheet({ accounts: [{ id: a.id }, { id: b.id }] });
  const early = settings.indexOf("Çalışma saatlerinde limit dönemlerini açık tut");
  const hours = settings.indexOf("Hafta içi");
  const zone = settings.indexOf("Saat dilimi");
  assert.ok(early >= 0 && early < hours && hours < zone);
});

test("a manual first start is marked and can return to automatic", () => {
  const accounts = [{ id: a.id, firstStart: "07:00" }, { id: b.id }];
  const html = render({ accounts });
  assert.equal(firstStart(html, "Kişisel - Max"), "07:00");
  // The manual time offers the way back, once; its title says it was set by hand.
  assert.equal(html.match(/title="Elle seçildi"[^>]*>Otomatiğe dön</g)?.length, 1);
  const automatic = todayPlan({ accounts }).accounts[1];
  assert.equal(automatic.manual, false);
  assert.equal(firstStart(html, "Vertex"), clock(automatic.firstStart));
  // A badge beside each time says whose time it is.
  assert.equal(html.match(/data-variant="outline"[^>]*>Elle</g)?.length, 1);
  assert.equal(html.match(/data-variant="outline"[^>]*>Otomatik</g)?.length, 1);
  // The plan's rows sit in their own list section under an "In the plan" header.
  assert.match(html, /data-slot="list-group"[^>]*>.*?Planda.*?data-slot="list-section" id="plan-included"[^>]*>.*?data-account=/);
});

test("without a work day ahead an automatic first start shows a dash, not a made-up time", () => {
  const off = { enabled: false, start: "09:00", end: "18:00" };
  const html = render({ accounts: [{ id: a.id }], weekday: off, weekend: off });
  assert.equal(firstStart(html, "Kişisel - Max"), undefined);
  assert.match(html, />—<\/span><span data-slot="badge"[^>]*>Otomatik</);
  assert.doesNotMatch(html, /value="09:00"/);
});

test("on Windows the keep-running switch cannot be turned on, says why, and can be turned off", () => {
  const toggleOf = (html: string) =>
    html.match(/<button[^>]*aria-label="Çalışma saatlerinde limit dönemlerini açık tut"[^>]*>/)?.[0] ?? "";
  const off = sheet({ ...panelProps({ accounts: [{ id: a.id }], autoStart: false }), platform: "win32" });
  assert.match(toggleOf(off), /role="switch"/);
  assert.match(toggleOf(off), /aria-checked="false"/);
  assert.match(toggleOf(off), /disabled=""/);
  assert.match(off, /Windows&#x27;ta kullanılamaz/);
  // Already on (settings from another machine): it stays usable so it can be switched off.
  const on = sheet({ ...panelProps({ accounts: [{ id: a.id }], autoStart: true }), platform: "win32" });
  assert.match(toggleOf(on), /aria-checked="true"/);
  assert.doesNotMatch(toggleOf(on), /disabled=""/);
  assert.match(on, /Windows&#x27;ta kullanılamaz/);
  assert.doesNotMatch(sheet(panelProps({ accounts: [{ id: a.id }] })), /Windows/);
});

test("keeper status, an empty plan and deleted accounts render safely", () => {
  const keeper: KeeperSnapshot = {
    enabled: true,
    running: false,
    plannedToday: 4,
    attempts: [],
    accounts: [
      {
        accountId: a.id,
        state: "active",
        resetsAt: new Date(
          wallTime("2026-10-13", "15:15", ZONE)!,
        ).toISOString(),
      },
    ],
    next: {
      accountId: b.id,
      at: new Date(wallTime("2026-10-13", "17:45", ZONE)!).toISOString(),
    },
  };
  const html = render(
    { autoStart: true, accounts: [{ id: a.id }, { id: randomUUID() }] },
    keeper,
  );
  assert.deepEqual(statusOf(html, "Dönem açık · 15:15’te yenilenir"), ["ok", "Dönem açık · 15:15"]);
  // Today's count comes from the plan itself; the next start comes from the
  // keeper's live view. The deleted account takes no slot: the plan is the one
  // of the single remaining account.
  const settings = renderSheet(
    { autoStart: true, accounts: [{ id: a.id }, { id: randomUUID() }] },
    keeper,
  );
  const [alone] = todayPlan({ accounts: [{ id: a.id }] }).accounts;
  assert.ok(settings.includes(`>Bugün ${alone.windows.length} başlatma planlı<`));
  assert.match(settings, nextStartRow("Vertex bugün 17:45"));
  assert.match(html, /data-slot="next-stat"[\s\S]*?>Vertex bugün 17:45</);
  assert.equal(firstStart(html, "Kişisel - Max"), clock(alone.firstStart));
  const empty = render({
    accounts: [{ id: a.id }],
    weekday: { enabled: false, start: "09:00", end: "21:00" },
  });
  assert.match(empty, /Bu gün için plan yok/);
});

test("an account the keeper has switched off says early start is off", () => {
  const keeper: KeeperSnapshot = {
    enabled: false,
    running: false,
    plannedToday: 0,
    attempts: [],
    accounts: [{ accountId: a.id, state: "off" }],
  };
  const html = render({ autoStart: false, accounts: [{ id: a.id }] }, keeper);
  assert.deepEqual(statusOf(html, "Önceden başlatma kapalı"), ["off", "Başlatma kapalı"]);
  assert.match(html, /data-slot="next-stat"[\s\S]*?>Önceden başlatma kapalı</);
  assert.doesNotMatch(html, /Otomatik başlatma/);
  // Switched off, the sheet has no next start row.
  assert.doesNotMatch(renderSheet({ autoStart: false, accounts: [{ id: a.id }] }, keeper), /data-slot="next-start"/);
});

test("without a keeper view the summary is drawn from the plan", () => {
  const accounts = [{ id: a.id }, { id: b.id }];
  const html = renderSheet({ autoStart: true, accounts });
  const plan = todayPlan({ accounts });
  const count = plan.accounts.reduce((n, p) => n + p.windows.length, 0);
  const next = plan.accounts
    .flatMap((p) => p.windows.map((w) => ({ id: p.accountId, at: w.start })))
    .filter((w) => w.at > NOW)
    .sort((x, y) => x.at - y.at)[0];
  const name = next.id === a.id ? a.name : b.name;
  assert.ok(html.includes(`>Bugün ${count} başlatma planlı<`));
  assert.match(html, nextStartRow(`${name} bugün ${clock(next.at)}`));
  assert.match(html, /Pzt–Cum/);
  assert.match(html, /12 sa/);
});

test("a day whose midnight is skipped by DST renders", () => {
  const zone = "Africa/Cairo";
  const html = page({
    settings: {
      ...DEFAULT_PLANNING,
      timeZone: zone,
      accounts: [{ id: a.id }],
    },
    accounts: [a, b],
    usage: {},
    disabled: false,
    t: testT("tr"),
    language: "tr",
    now: wallTime("2026-04-24", "12:00", zone)!,
    update: () => {},
    updateAccount: () => {},
  });
  assert.match(html, /Bugün/);
});

test("a stopped account says why and offers to try again", () => {
  const html = render(
    { autoStart: true, accounts: [{ id: a.id }] },
    {
      enabled: true,
      running: false,
      plannedToday: 3,
      attempts: [],
      accounts: [
        {
          accountId: a.id,
          state: "blocked",
          reason: "routine-policy-unverified",
        },
      ],
    },
  );
  assert.deepEqual(statusOf(html, "Durdu: yönetici politikası[^\"]*"), ["crit", "Durdu"]);
  assert.match(html, />Yeniden dene</);
});

// The capacity scenario (Max 5×, Team weight 2, Pro) on a busy Wednesday,
// 09:00–18:00, planned with the keeper's learned tempo.
const WEDNESDAY = "2026-10-14";
const busyHours: Record<number, number> = {
  9: 220,
  10: 242,
  11: 242,
  12: 110,
  13: 198,
  14: 242,
  15: 242,
  16: 220,
  17: 154,
};
const busyTempo: Tempo = {
  source: "learned",
  weekday: Array.from({ length: 24 }, (_, hour) => busyHours[hour] ?? 205),
  weekend: Array.from({ length: 24 }, () => 205),
  rate: { weekday: 205, weekend: 205 },
  days: { weekday: 15, weekend: 2 },
};
const team: Account = {
  ...account("Vertex Team"),
  planning: { plan: "team", capacityWeight: 2 },
};
const pro: Account = {
  ...account("Pro"),
  planning: { plan: "pro", capacityWeight: 1 },
};
const scenarioAccounts = [a, team, pro];
const names: Record<string, string> = Object.fromEntries(
  scenarioAccounts.map((x) => [x.id, x.name]),
);
const wednesday = (clock: string) => wallTime(WEDNESDAY, clock, ZONE)!;
const scenarioSettings = (accounts: PlanningSettings["accounts"]) =>
  panelSettings({
    autoStart: true,
    weekday: { enabled: true, start: "09:00", end: "18:00" },
    accounts,
  });
const automatic = scenarioAccounts.map(({ id }) => ({ id }));
const tr = testT("tr");
// The even spread's warm-ups, fixed by hand: the plan is the even spread.
const evenByHand = [
  { id: a.id, firstStart: "04:50" },
  { id: team.id, firstStart: "06:30" },
  { id: pro.id, firstStart: "08:10" },
];
const scenarioProps = (
  accounts: PlanningSettings["accounts"],
  now: number,
  activeId = a.id,
  usage: Record<string, AccountUsage> = {},
): PlanningPanelProps => ({
  settings: scenarioSettings(accounts),
  keeper: {
    enabled: true,
    running: false,
    plannedToday: 0,
    attempts: [],
    accounts: [],
    tempo: busyTempo,
  },
  accounts: scenarioAccounts,
  usage,
  activeId,
  disabled: false,
  t: tr,
  language: "tr",
  now,
  update: () => {},
  updateAccount: () => {},
});
function renderScenario(...args: Parameters<typeof scenarioProps>) {
  return page(scenarioProps(...args));
}
function renderScenarioSheet(...args: Parameters<typeof scenarioProps>) {
  return sheet(scenarioProps(...args));
}
/**
 * The plan stat as [value classes, plan warm-ups, value, even warm-ups, note]. The warm-ups are
 * the titles of the value and the note, and each shows as a line under them too.
 */
function planStat(html: string) {
  const stat = html.match(
    /data-slot="plan-stat"[^>]*>.*?<strong class="([^"]*)" title="([^"]*)">([^<]*)<\/strong><small class="[^"]*">([^<]*)<\/small><div data-slot="stat-compare"[^>]*><span class="[^"]*" title="([^"]*)">([^<]*)<\/span><small class="[^"]*">([^<]*)<\/small><\/div>/,
  );
  if (!stat) return undefined;
  const [, valueClass, planWarmUps, value, planLine, evenWarmUps, note, evenLine] = stat;
  assert.equal(planLine, planWarmUps);
  assert.equal(evenLine, evenWarmUps);
  return [valueClass, planWarmUps, value, evenWarmUps, note];
}
/** The lane block with this label: its fill's classes and its name, if shown. */
function laneBlock(html: string, label: string) {
  const block = html.match(
    new RegExp(
      `title="${label}" aria-label="${label}"[^>]*><span class="([^"]*)".*?</div>`,
    ),
  );
  if (!block) return undefined;
  const name = block[0].match(/<span class="(relative [^"]*)">([^<]*)<\/span>/);
  return { fill: block[1], nameClass: name?.[1] ?? "", name: name?.[2] ?? "" };
}
const count = (html: string, pattern: RegExp) =>
  html.match(pattern)?.length ?? 0;

test("the usage lane shows who works when, with switches and the comparison", () => {
  const now = wednesday("12:00");
  const html = renderScenario(automatic, now);
  assert.match(html, />Kullanım</);
  assert.match(html, />tahmin</);
  // A small legend instead of a paragraph: one word per mark.
  const legend = /data-slot="timeline-legend"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  assert.deepEqual(
    [...legend.matchAll(/<\/i>([^<]*)<\/li>/g)].map(([, word]) => word),
    ["Çalışma", "Tahmin", "Limit dolu", "Geçiş"],
  );
  assert.doesNotMatch(html, /Kullanım şeridi, Relay’in tahminidir/);
  const view = dayTimeline({
    settings: scenarioSettings(automatic),
    accounts: scenarioAccounts,
    usage: {},
    now,
    tempo: busyTempo,
    activeId: a.id,
  });
  // One block per lane segment, named by its account (or no quota) and time.
  for (const s of view.lane)
    assert.ok(
      laneBlock(
        html,
        `${s.accountId ? names[s.accountId] : "Limit dolu"} ${clock(s.from)}–${clock(s.to)}`,
      ),
      `${s.accountId} ${clock(s.from)}`,
    );
  assert.equal(
    count(
      html,
      /aria-label="(Kişisel - Max|Vertex Team|Pro|Limit dolu) \d\d:\d\d–\d\d:\d\d"/g,
    ),
    view.lane.length,
  );
  // The planned morning's fill is dimmed, not its name, which is dark on the
  // tone in both themes and ellipsized from the end; a block under 8% of the
  // day has no name. The live forecast from now is not dimmed.
  const morning = laneBlock(html, "Kişisel - Max 09:00–11:09")!;
  // Each account works in its own colour, the dot's token.
  assert.match(morning.fill, /bg-account-olive/);
  assert.match(morning.fill, /opacity-50 dark:opacity-65/);
  assert.equal(morning.name, "Kişisel - Max");
  assert.match(morning.nameClass, /min-w-0 truncate/);
  assert.match(
    morning.nameClass,
    /text-foreground dark:text-primary-foreground/,
  );
  assert.doesNotMatch(morning.nameClass, /opacity/);
  assert.equal(laneBlock(html, "Vertex Team 11:55–12:00")!.name, "");
  const next = view.lane.find((s) => s.from === now)!;
  assert.equal(next.accountId, a.id);
  assert.doesNotMatch(
    laneBlock(html, `Kişisel - Max 12:00–${clock(next.to)}`)!.fill,
    /opacity-50/,
  );
  // A switch marker wherever work moves to another account: max → pro →
  // vertex by plan, then (the seam at now is none) pro, vertex and, after the
  // gap, max again.
  assert.equal(count(html, /-ml-px w-0\.5 rounded-\[1px\] bg-foreground\/55/g), 5);
  // The comparison: this plan, and under it the even spread, which has a gap.
  assert.match(html, />Bu plan</);
  assert.equal(
    forecastSummary(view.compare!.plan, tr, clock),
    "Kesintisiz · 3 geçiş",
  );
  assert.equal(
    forecastSummary(view.compare!.even, tr, clock),
    "14:18–14:50 limit dolu · 5 geçiş",
  );
  // Who warms up when, by name in planned order, is each line's title: never a cut sentence.
  const [valueClass, planWarmUps, value, evenWarmUps, note] = planStat(html)!;
  assert.equal(value, "Kesintisiz · 3 geçiş");
  assert.doesNotMatch(valueClass, /text-crit/);
  assert.equal(planWarmUps, "Önceden başlatma: Kişisel - Max 06:15 · Vertex Team 08:15 · Pro 06:30");
  assert.equal(note, "Eşit dağıtımda: 14:18–14:50 limit dolu · 5 geçiş");
  assert.equal(evenWarmUps, "Önceden başlatma: Kişisel - Max 04:50 · Vertex Team 06:30 · Pro 08:10");
  assert.doesNotMatch(html, /truncate[^"]*" title="Önceden başlatma/);
});

test("with automatic start off the comparison says nothing is warmed up", () => {
  const html = renderPlanning({
    planned: scenarioAccounts,
    tempo: busyTempo,
    now: wednesday("12:00"),
    settings: { autoStart: false },
  });
  assert.match(html, />Bu plan</);
  const [, planWarmUps, value, evenWarmUps, note] = planStat(html)!;
  assert.equal(value, "Kesintisiz · 3 geçiş");
  assert.equal(note, "Eşit dağıtımda: 14:18–14:50 limit dolu · 5 geçiş");
  assert.deepEqual([planWarmUps, evenWarmUps], ["Önceden başlatma kapalı", "Önceden başlatma kapalı"]);
  assert.match(html, /data-slot="next-stat"[\s\S]*?>Önceden başlatma kapalı</);
  assert.doesNotMatch(html, /Önceden başlatma: /);
  assert.doesNotMatch(html, /Otomatik başlatma/);
});

test("an all-manual plan shows its gap on the lane and no comparison", () => {
  const html = renderScenario(evenByHand, wednesday("08:00"));
  // Before work the lane is already live from the work start.
  const gap = laneBlock(html, "Limit dolu 14:18–14:50")!;
  assert.match(gap.fill, /bg-crit\/25/);
  assert.doesNotMatch(gap.fill, /opacity-50/);
  const plan = dayPlan(
    WEDNESDAY,
    scenarioSettings(evenByHand),
    planContext(scenarioAccounts, busyTempo),
  );
  assert.equal(plan.forecast!.outageMinutes, 32);
  // With the windows as planned the live forecast is the plan's, switches and all.
  assert.equal(count(html, /-ml-px w-0\.5 rounded-\[1px\] bg-foreground\/55/g), plan.forecast!.switches);
  assert.doesNotMatch(html, /data-slot="plan-stat"|Eşit dağıtımda/);
});

// Tempo, forecast pill and per-account window lines.
const unknownPlan: Account = {
  ...account("Eski"),
  planning: { plan: "unknown", capacityWeight: 1 },
};
const noPlan: Account = { ...account("Yeni"), planning: undefined };
function renderPlanning({
  planned,
  now = wednesday("08:00"),
  tempo,
  choice,
  settings,
  language = "tr",
}: {
  planned: Account[];
  now?: number;
  /** The keeper's tempo; without it the page falls back to the settings. */
  tempo?: Tempo;
  choice?: TempoChoice;
  settings?: Partial<PlanningSettings>;
  language?: Locale;
}) {
  return page(planningProps({ planned, now, tempo, choice, settings, language }));
}
function planningProps({
  planned,
  now = wednesday("08:00"),
  tempo,
  choice,
  settings,
  language = "tr",
}: Parameters<typeof renderPlanning>[0]): PlanningPanelProps {
  return {
    settings: {
      ...scenarioSettings(planned.map(({ id }) => ({ id }))),
      ...(choice ? { tempo: choice } : {}),
      ...settings,
    },
    keeper: {
      enabled: true,
      running: false,
      plannedToday: 0,
      attempts: [],
      accounts: [],
      ...(tempo ? { tempo } : {}),
    },
    accounts: [a, b, team, pro, unknownPlan, noPlan],
    usage: {},
    activeId: a.id,
    disabled: false,
    t: testT(language),
    language,
    now,
    update: () => {},
    updateAccount: () => {},
  };
}
const renderPlanningSheet = (options: Parameters<typeof renderPlanning>[0]) => sheet(planningProps(options));
/** The tempo toggle item with this label (its whole button). */
const toggleItem = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";

test("the sheet's tempo row shows the learned tempo and how long a window lasts at it", () => {
  const html = renderPlanningSheet({ planned: [a, b, pro], tempo: busyTempo });
  assert.match(html, />Çalışma saatleri ve tempo</);
  assert.match(html, />Tempo</);
  assert.match(html, />ne hızla tüketiyorsun</);
  assert.match(toggleItem(html, "Otomatik"), /data-state="on"/);
  for (const label of ["Hafif", "Orta", "Yoğun"])
    assert.match(toggleItem(html, label), /data-state="off"/, label);
  assert.ok(
    html.includes("Yoğun gün ≈ 205 Pro birimi/sa, son 4 haftanın 17 iş gününden"),
  );
  // Each plan once (both Max 5× accounts share a line), largest first; the
  // unplanned Team account is not listed.
  assert.ok(
    html.includes(
      "Bu tempoyla bir dönem: Max 5× ~2 sa 25 dk, Pro ~30 dk yeter.",
    ),
  );
  assert.ok(
    renderScenarioSheet(automatic, wednesday("08:00")).includes(
      "Bu tempoyla bir dönem: Max 5× ~2 sa 25 dk, Team · 2 ~1 sa, Pro ~30 dk yeter.",
    ),
  );
});

test("the default and a fixed tempo say so, and the toggle shows the choice", () => {
  const fallback = renderPlanningSheet({ planned: [a, pro] });
  // The words show; the rate in Pro units is the title.
  assert.match(
    fallback,
    /title="Veri birikene kadar orta tempo ≈ 50 Pro birimi\/sa">Veri birikene kadar orta tempo<\/p>/,
  );
  assert.match(toggleItem(fallback, "Otomatik"), /data-state="on"/);
  assert.ok(
    fallback.includes(
      "Bu tempoyla bir dönem: Max 5× ~10 sa, Pro ~2 sa yeter.",
    ),
  );
  const heavy = renderPlanningSheet({ planned: [a, pro], choice: "heavy" });
  assert.match(heavy, /title="Sabit tempo ≈ 120 Pro birimi\/sa">Sabit tempo<\/p>/);
  assert.doesNotMatch(heavy, /Sabit tempo ≈ 120 Pro birimi\/sa ·/);
  assert.match(toggleItem(heavy, "Yoğun"), /data-state="on"/);
  assert.match(toggleItem(heavy, "Otomatik"), /data-state="off"/);
  assert.ok(
    heavy.includes(
      "Bu tempoyla bir dönem: Max 5× ~4 sa 10 dk, Pro ~50 dk yeter.",
    ),
  );
});

test("the next stat forecasts the day before work and the rest of it during work", () => {
  const before = renderScenario(automatic, wednesday("08:00"));
  assert.deepEqual(nextForecast(before), ["ok", "Tahmin: Kesintisiz · 3 geçiş"]);
  // During work: the live forecast from now, as the lane shows it.
  const now = wednesday("12:00");
  const settings = scenarioSettings(automatic);
  const context = planContext(scenarioAccounts, busyTempo);
  const rest = liveForecast({
    plan: dayPlan(WEDNESDAY, settings, context),
    settings,
    context,
    usage: {},
    activeId: a.id,
    now,
  })!;
  assert.equal(
    forecastSummary(rest, tr, clock),
    "16:02–16:15 limit dolu · 3 geçiş",
  );
  const during = renderScenario(automatic, now);
  assert.deepEqual(nextForecast(during), ["warn", "Bugün kalan: 16:02–16:15 limit dolu · 3 geçiş"]);
  assert.doesNotMatch(during, /Tahmin: /);
  // The tempo's source is the sheet's to say, not the page's.
  assert.doesNotMatch(during, /tempoyla</);
  assert.ok(renderPlanningSheet({ planned: [a], choice: "heavy" }).includes("Sabit tempo ≈ 120 Pro birimi/sa"));
  assert.ok(renderPlanningSheet({ planned: [a] }).includes("Veri birikene kadar orta tempo"));
  // Nothing planned: no forecast, the empty state asks for accounts.
  const empty = renderPlanning({ planned: [] });
  assert.doesNotMatch(empty, /Tahmin: |Bugün kalan: /);
  assert.match(empty, /data-slot="planning-empty"[\s\S]*Hangi hesaplar sırayla kullanılsın\?[\s\S]*>Hesap seç</);
  // Automatic start off: no forecast; the sheet says what turning it on does.
  const offOptions = { planned: scenarioAccounts, tempo: busyTempo, settings: { autoStart: false } };
  assert.doesNotMatch(renderPlanning(offOptions), /Tahmin: |Bugün kalan: /);
  assert.match(renderPlanningSheet(offOptions), />Açınca dönemler planlanan saatlerde başlar\.</);
});

test("before work the pill forecasts the day as the lane does", () => {
  // The Mac slept through the 06:15 and 06:30 warm-ups: at 08:00 every
  // window is closed, so the live forecast is not the plan's own and the pill
  // must not repeat the plan's. (The account Desktop is on does not count
  // before work.)
  const now = wednesday("08:00");
  const usage: Record<string, AccountUsage> = Object.fromEntries(
    scenarioAccounts.map((x) => [
      x.id,
      {
        accountId: x.id,
        status: "ready",
        stale: false,
        checkedAt: new Date(now).toISOString(),
        fiveHour: { usedPercent: 0 },
        sevenDay: {
          usedPercent: 20,
          resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
        },
      },
    ]),
  );
  const view = dayTimeline({
    settings: scenarioSettings(automatic),
    accounts: scenarioAccounts,
    usage,
    now,
    tempo: busyTempo,
    activeId: team.id,
  });
  const summary = forecastSummary(view.live!.forecast, tr, clock);
  assert.equal(summary, "2 aralıkta limit dolu, ilki 12:52–13:00 · 5 geçiş");
  const html = renderScenario(automatic, now, team.id, usage);
  assert.deepEqual(nextForecast(html), ["warn", `Tahmin: ${summary}`]);
  assert.doesNotMatch(html, /Tahmin: Kesintisiz|Bugün kalan: /);
});

test("each planned account says how long its window lasts and when it works today", () => {
  const html = renderScenario(automatic, wednesday("08:00"));
  const line = (text: string) =>
    new RegExp(
      `<small class="[^"]*text-muted-foreground[^"]*">${text}</small>`,
    );
  assert.match(
    html,
    line("Bir dönem ~2 sa 25 dk yeter · bugün 09:00–11:09, 14:13–18:00"),
  );
  assert.match(html, line("Bir dönem ~1 sa yeter · bugün 11:55–14:13"));
  assert.match(html, line("Bir dönem ~30 dk yeter · bugün 11:09–11:55"));
  // At 10:00 Max's block runs across now: the planned and the live part read
  // as one range.
  assert.ok(
    renderScenario(automatic, wednesday("10:00")).includes(
      "Bir dönem ~2 sa 25 dk yeter · bugün 09:00–14:03, 16:15–18:00",
    ),
  );
  // An account without a chosen plan asks for one instead.
  const unknown = renderPlanning({
    planned: [a, unknownPlan, noPlan],
    tempo: busyTempo,
  });
  assert.equal(
    count(
      unknown,
      /<small class="[^"]*text-warn-foreground[^"]*">Plan türünü seç; 1× sayılıyor<\/small>/g,
    ),
    2,
  );
  assert.equal(count(unknown, />Bir dönem ~/g), 1);
});

test("the notes wait behind an ⓘ: the order in the list, the overnight hours in the sheet", () => {
  const html = renderScenario(automatic, wednesday("08:00"));
  assert.match(html, /data-slot="planning-accounts"[\s\S]*?aria-label="Nasıl çalışır"/);
  assert.doesNotMatch(html, /Sıra yalnızca eşitlikte öncelik verir/);
  assert.doesNotMatch(html, /Sıra, otomatik saatlerin dağıtım sırasıdır/);
  const settings = renderScenarioSheet(automatic, wednesday("08:00"));
  assert.match(settings, /id="planning-hours"[\s\S]*?aria-label="Nasıl çalışır"/);
  assert.doesNotMatch(settings, /Bitiş başlangıçtan önceyse aralık ertesi güne uzar\./);
  // The notes' words are the tooltips'.
  const source = readFileSync(new URL("../src/features/PlanningPanel.tsx", import.meta.url), "utf8");
  for (const id of ["planningPanel.relaySetsTheStartTimesFrom", "planningPanel.anEndBeforeTheStartRuns"] as const)
    assert.ok(source.includes(`info={t("${id}")}`), id);
  assert.match(tr("planningPanel.relaySetsTheStartTimesFrom"), /Sıra yalnızca eşitlikte öncelik verir/);
  assert.equal(tr("planningPanel.anEndBeforeTheStartRuns"), "Bitiş başlangıçtan önceyse aralık ertesi güne uzar.");
});

// Saturday work with a learned weekend rate well below the weekday one.
const SATURDAY = "2026-10-17";
const weekendTempo: Tempo = {
  ...busyTempo,
  weekend: Array.from({ length: 24 }, () => 60),
  rate: { weekday: 205, weekend: 60 },
  days: { weekday: 15, weekend: 6 },
};
const weekendHours: Partial<PlanningSettings> = {
  weekend: { enabled: true, start: "11:00", end: "17:00" },
};

test("on a weekend work day the tempo row and the account rows use the weekend rate", () => {
  const options = {
    planned: [a, pro],
    tempo: weekendTempo,
    now: wallTime(SATURDAY, "08:00", ZONE)!,
    settings: weekendHours,
  };
  const html = renderPlanning(options);
  const settings = renderPlanningSheet(options);
  assert.ok(
    settings.includes(
      "Hafta sonu yoğun gün ≈ 60 Pro birimi/sa, son 4 haftanın 21 iş gününden",
    ),
  );
  assert.ok(
    settings.includes(
      "Bu tempoyla bir dönem: Max 5× ~8 sa 20 dk, Pro ~1 sa 40 dk yeter.",
    ),
  );
  assert.ok(html.includes("Bir dönem ~8 sa 20 dk yeter · bugün 11:00–17:00"));
  assert.ok(html.includes(">Bir dönem ~1 sa 40 dk yeter<"));
  assert.doesNotMatch(html + settings, /205 Pro birimi|~2 sa 25 dk/);
  // A weekend that learned no rate of its own reads as the busy day.
  assert.ok(
    renderPlanningSheet({
      planned: [a, pro],
      tempo: busyTempo,
      now: wallTime(SATURDAY, "08:00", ZONE)!,
      settings: weekendHours,
    }).includes("Yoğun gün ≈ 205 Pro birimi/sa, son 4 haftanın 17 iş gününden"),
  );
});

test("after work the pill and the rows describe the next work day", () => {
  // Friday 23:30: Saturday is next, with its own hours and rate.
  const now = wallTime("2026-10-16", "23:30", ZONE)!;
  const saturday = dayPlan(
    SATURDAY,
    { ...scenarioSettings(automatic), ...weekendHours },
    planContext(scenarioAccounts, weekendTempo),
  );
  assert.equal(
    forecastSummary(saturday.forecast!, tr, clock),
    "Kesintisiz · geçiş yok",
  );
  const options = {
    planned: scenarioAccounts,
    tempo: weekendTempo,
    now,
    settings: weekendHours,
  };
  const html = renderPlanning(options);
  assert.equal(nextForecast(html)?.[1], "Yarın tahmini: Kesintisiz · geçiş yok");
  assert.doesNotMatch(html, /Tahmin: /);
  assert.equal(
    firstStart(html, "Kişisel - Max"),
    clock(saturday.accounts[0].firstStart),
  );
  assert.ok(renderPlanningSheet(options).includes("Hafta sonu yoğun gün ≈ 60 Pro birimi/sa"));
  // The window lasts as on Saturday; today's ranges are still today's.
  assert.ok(
    html.includes(
      "Bir dönem ~8 sa 20 dk yeter · bugün 09:00–11:09, 14:13–18:00",
    ),
  );
});

test("a fixed tempo applies at once, before the keeper reports it", () => {
  // The keeper snapshot still carries the learned tempo.
  const options = { planned: [a, pro], tempo: busyTempo, choice: "heavy" as const };
  const html = renderPlanning(options);
  const sheetHtml = renderPlanningSheet(options);
  assert.ok(sheetHtml.includes("Sabit tempo ≈ 120 Pro birimi/sa"));
  assert.ok(
    sheetHtml.includes(
      "Bu tempoyla bir dönem: Max 5× ~4 sa 10 dk, Pro ~50 dk yeter.",
    ),
  );
  assert.match(html, />Bir dönem ~4 sa 10 dk yeter/);
  assert.doesNotMatch(html + sheetHtml, /Yoğun gün|~2 sa 25 dk/);
  const settings = scenarioSettings([{ id: a.id }, { id: pro.id }]);
  const view = dayTimeline({
    settings,
    accounts: [a, pro],
    usage: {},
    now: wednesday("08:00"),
    tempo: presetTempo("heavy"),
    activeId: a.id,
  });
  assert.ok(
    html.includes(
      `Tahmin: ${forecastSummary(view.live!.forecast, tr, clock)}<`,
    ),
  );
});

test("a pill for a later day says which day it forecasts", () => {
  // Friday 23:30 with Saturday work: tomorrow.
  const friday = wallTime("2026-10-16", "23:30", ZONE)!;
  assert.match(
    renderPlanning({
      planned: scenarioAccounts,
      tempo: weekendTempo,
      now: friday,
      settings: weekendHours,
      language: "en",
    }),
    /<\/span>Tomorrow: No gaps · no switches</,
  );
  // Without weekend work Monday is next: its weekday name.
  const monday = dayPlan(
    "2026-10-19",
    scenarioSettings(automatic),
    planContext(scenarioAccounts, busyTempo),
  );
  const summary = forecastSummary(monday.forecast!, tr, clock);
  assert.equal(summary, "Kesintisiz · 3 geçiş");
  const html = renderPlanning({
    planned: scenarioAccounts,
    tempo: busyTempo,
    now: friday,
  });
  assert.equal(nextForecast(html)?.[1], `Pazartesi tahmini: ${summary}`);
  assert.doesNotMatch(html, /Tahmin: |Yarın tahmini: /);
  assert.match(
    renderPlanning({
      planned: scenarioAccounts,
      tempo: busyTempo,
      now: friday,
      language: "en",
    }),
    /<\/span>Monday: No gaps · 3 switches</,
  );
});

// Today's adaptation: the keeper saw a faster pace and moved Pro's next start.
const iso = (time: number) => new Date(time).toISOString();
const adapted = (
  factor: number,
  schedule: [Account, string][],
): KeeperAdaptation => ({
  factor,
  schedule: schedule.map(([x, clock]) => ({
    accountId: x.id,
    startAt: iso(wednesday(clock)),
  })),
});
const adaptedProps = ({
  now = wednesday("12:00"),
  settings,
  adaptation = adapted(1.6, [[pro, "13:30"]]),
  statuses = [
    {
      accountId: pro.id,
      state: "waiting",
      reason: "adapted",
      nextStartAt: iso(wednesday("13:30")),
    },
  ],
  usage = {},
  language = "tr" as Locale,
  update = () => {},
}: {
  now?: number;
  settings?: Partial<PlanningSettings>;
  adaptation?: KeeperAdaptation;
  statuses?: KeeperAccountStatus[];
  usage?: Record<string, AccountUsage>;
  language?: Locale;
  update?: (patch: Partial<PlanningSettings>) => void;
} = {}) => ({
  settings: { ...scenarioSettings(automatic), ...settings },
  keeper: {
    enabled: true,
    running: false,
    plannedToday: 0,
    attempts: [],
    accounts: statuses,
    tempo: busyTempo,
    adaptation,
  },
  accounts: scenarioAccounts,
  usage,
  activeId: a.id,
  disabled: false,
  t: testT(language),
  language,
  now,
  update,
  updateAccount: () => {},
});
const renderAdapted = (options?: Parameters<typeof adaptedProps>[0]) =>
  page(adaptedProps(options) as PlanningPanelProps);
const renderAdaptedSheet = (options?: Parameters<typeof adaptedProps>[0]) =>
  sheet(adaptedProps(options) as PlanningPanelProps);
/** A badge's classes by its exact text. */
const badgeClass = (html: string, text: string) =>
  html.match(
    new RegExp(
      `<span data-slot="badge"[^>]*class="([^"]*)"[^>]*>${text}</span>`,
    ),
  )?.[1];
/** The switch with this label (its opening tag). */
const switchTag = (html: string, label: string) =>
  html.match(
    new RegExp(`<button[^>]*role="switch"[^>]*aria-label="${label}"[^>]*>`),
  )?.[0] ?? "";
/** The first element of this component type in a rendered tree (unexpanded). */
function findElement(node: unknown, type: unknown): ReactElement | undefined {
  if (Array.isArray(node))
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
  if (!isValidElement(node)) return undefined;
  if (node.type === type) return node;
  return findElement((node.props as { children?: unknown }).children, type);
}

test("an adapted day shows the pace, the adapted forecast and the deferred start", () => {
  // Fresh usage at noon: no window open, so Pro waits for its adopted 13:30.
  const now = wednesday("12:00");
  const usage = Object.fromEntries(
    scenarioAccounts.map((x) => [x.id, planningUsage(x, now)]),
  );
  const html = renderAdapted({ usage });
  // The sheet: the switch under the tempo row, on.
  const settings = renderAdaptedSheet({ usage });
  assert.match(settings, />Uyarla</);
  assert.match(settings, />Gün içinde hızına göre planı güncelle</);
  const toggle = switchTag(settings, "Uyarla");
  assert.match(toggle, /aria-checked="true"/);
  assert.doesNotMatch(toggle, / disabled=""/);
  assert.ok(settings.indexOf(">ne hızla tüketiyorsun<") < settings.indexOf(">Uyarla<"));
  assert.ok(settings.indexOf(">Uyarla<") < settings.indexOf("Saat dilimi"));
  // The next stat: today's pace and the adapted plan, in the warning tone.
  for (const text of ["Bugün plandan 1,6 kat hızlısın", "Plan uyarlandı"]) {
    const classes = badgeClass(html, text);
    assert.ok(classes, text);
    assert.match(classes, /bg-warn\/15/);
    assert.match(classes, /text-warn-foreground/);
  }
  // The pill and the lane forecast the rest of the day at today's pace with
  // the adopted start (16:02–17:00 without them).
  const view = dayTimeline({
    settings: scenarioSettings(automatic),
    accounts: scenarioAccounts,
    usage,
    now,
    tempo: busyTempo,
    activeId: a.id,
    adaptation: { factor: 1.6, schedule: { [pro.id]: wednesday("13:30") } },
  });
  const summary = forecastSummary(view.live!.forecast, tr, clock);
  assert.equal(summary, "14:48–17:00 limit dolu · 3 geçiş");
  assert.equal(nextForecast(html)?.[1], `Bugün kalan: ${summary}`);
  assert.ok(laneBlock(html, "Limit dolu 14:48–17:00"));
  assert.doesNotMatch(html, /16:02–17:00/);
  // Pro's window row: its planned window is closed by now (only the past
  // part stays), nothing until 13:30, then a window from it.
  assert.match(html, /title="11:30–12:00"/);
  assert.match(html, /title="13:30–18:30"/);
  assert.doesNotMatch(html, /title="11:30–16:30"/);
  // Pro's row: the adopted start, in the warning tone.
  assert.deepEqual(statusOf(html, "Plan uyarlandı · 13:30’da başlatılacak"), ["warn", "Uyarlandı · 13:30"]);
  // Each window lasts as long as it does at today's pace (1.6 × 205 an
  // hour); the tempo row keeps the plan's own.
  assert.match(html, />Bir dönem ~1 sa 30 dk yeter · bugün /);
  assert.match(html, />Bir dönem ~35 dk yeter/);
  assert.match(html, />Bir dönem ~20 dk yeter/);
  assert.match(
    settings,
    /Bu tempoyla bir dönem: Max 5× ~2 sa 25 dk, Team · 2 ~1 sa, Pro ~30 dk yeter\./,
  );
});

test("the adapt switch follows the setting, needs automatic start and sends the change", () => {
  // Its note describes it.
  const html = renderAdaptedSheet();
  const described = switchTag(html, "Uyarla").match(
    /aria-describedby="([^"]+)"/,
  )?.[1];
  assert.ok(described);
  assert.match(
    html,
    new RegExp(
      `<small id="${described}"[^>]*>Gün içinde hızına göre planı güncelle</small>`,
    ),
  );
  assert.match(
    switchTag(renderAdaptedSheet({ settings: { adaptive: false } }), "Uyarla"),
    /aria-checked="false"/,
  );
  const off = switchTag(
    renderAdaptedSheet({ settings: { autoStart: false } }),
    "Uyarla",
  );
  assert.match(off, / disabled=""/);
  // Turning it off sends just that.
  const patches: Partial<PlanningSettings>[] = [];
  const panel = PlanSettings(
    sheetProps(adaptedProps({ update: (patch) => patches.push(patch) }) as PlanningPanelProps),
  );
  const row = findElement(panel, AdaptiveRow)!;
  assert.ok(row);
  const toggle = findElement(
    AdaptiveRow(row.props as Parameters<typeof AdaptiveRow>[0]),
    Switch,
  )!;
  (
    toggle.props as { onCheckedChange: (checked: boolean) => void }
  ).onCheckedChange(false);
  assert.deepEqual(patches, [{ adaptive: false }]);
});

test("a start deferred before the account's active range shows the adopted time", () => {
  // At 06:00 Pro's warm-up (06:30) is moved to 09:30; the keeper still
  // reports the account as outside its range.
  const html = renderAdapted({
    now: wednesday("06:00"),
    adaptation: adapted(1, [[pro, "09:30"]]),
    statuses: [
      {
        accountId: pro.id,
        state: "outside",
        nextStartAt: iso(wednesday("06:30")),
      },
      {
        accountId: team.id,
        state: "outside",
        nextStartAt: iso(wednesday("08:15")),
      },
    ],
  });
  assert.deepEqual(statusOf(html, "Plan uyarlandı · 09:30’da başlatılacak"), ["warn", "Uyarlandı · 09:30"]);
  assert.doesNotMatch(html, /Sonraki başlatma 06:30/);
  assert.deepEqual(statusOf(html, "Sonraki başlatma 08:15"), ["ok", "Sonraki 08:15"]);
});

test("only what was adapted shows, and nothing once adaptation is off", () => {
  const pace = renderAdapted({ adaptation: adapted(1.6, []), statuses: [] });
  assert.ok(badgeClass(pace, "Bugün plandan 1,6 kat hızlısın"));
  assert.equal(badgeClass(pace, "Plan uyarlandı"), undefined);
  const moved = renderAdapted({ adaptation: adapted(1, [[pro, "13:30"]]) });
  assert.ok(badgeClass(moved, "Plan uyarlandı"));
  assert.doesNotMatch(moved, /hızlısın/);
  // Turned off on the page: neither chip nor the adopted forecast, before
  // the keeper's next report.
  const off = renderAdapted({ settings: { adaptive: false } });
  assert.doesNotMatch(off, /hızlısın|Plan uyarlandı|Uyarlandı/);
  // Pro's adapted wait reads as a plain next start, and windows last as at
  // the plan's tempo.
  assert.deepEqual(statusOf(off, "Sonraki başlatma 13:30"), ["ok", "Sonraki 13:30"]);
  assert.match(off, />Bir dönem ~30 dk yeter/);
  assert.doesNotMatch(off, />Bir dönem ~20 dk yeter/);
  assert.equal(nextForecast(off)?.[1], "Bugün kalan: 16:02–16:15 limit dolu · 3 geçiş");
  assert.doesNotMatch(
    renderScenario(automatic, wednesday("12:00")),
    /hızlısın|Plan uyarlandı|Uyarlandı/,
  );
  // In English, with one decimal.
  const en = renderAdapted({
    adaptation: adapted(2, [[pro, "13:30"]]),
    language: "en",
  });
  assert.ok(badgeClass(en, "Today: 2.0× the planned pace"));
  assert.ok(badgeClass(en, "Plan adapted"));
  assert.deepEqual(statusOf(en, "Plan adapted · starts at 13:30"), ["warn", "Adapted · 13:30"]);
  const enSheet = renderAdaptedSheet({ adaptation: adapted(2, [[pro, "13:30"]]), language: "en" });
  assert.match(enSheet, />Adapt</);
  assert.match(enSheet, />Update the plan for today’s pace</);
});

test("an unreadable adopted time is left out", () => {
  // The keeper's list carries a time that does not parse: no chip, no
  // adopted start, and the account keeps the keeper's own status.
  const html = renderAdapted({
    now: wednesday("06:00"),
    adaptation: {
      factor: 1,
      schedule: [{ accountId: pro.id, startAt: "later" }],
    },
    statuses: [
      {
        accountId: pro.id,
        state: "outside",
        nextStartAt: iso(wednesday("06:30")),
      },
    ],
  });
  assert.doesNotMatch(html, /Plan uyarlandı|Uyarlandı/);
  assert.deepEqual(statusOf(html, "Sonraki başlatma 06:30"), ["ok", "Sonraki 06:30"]);
});
