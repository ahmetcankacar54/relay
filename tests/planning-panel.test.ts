import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { PlanningPanel } from "../src/features/PlanningPanel";
import { wallTime } from "../shared/planning";
import { dayPlan, planContext } from "../shared/day-plan";
import { presetTempo, type Tempo } from "../shared/tempo";
import { dayTimeline } from "../src/lib/day-timeline";
import { forecastSummary } from "../src/lib/forecast-text";
import {
  DEFAULT_PLANNING,
  type Account,
  type KeeperSnapshot,
  type PlanningSettings,
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
function render(settings: Partial<PlanningSettings>, keeper?: KeeperSnapshot) {
  return renderToStaticMarkup(
    createElement(PlanningPanel, {
      settings: panelSettings(settings),
      keeper,
      accounts: [a, b],
      usage: {},
      disabled: false,
      t: (tr: string) => tr,
      now: NOW,
      update: () => {},
      updateAccount: () => {},
    }),
  );
}

test("the panel shows the switch, both hour rows and automatic first starts", () => {
  const accounts = [{ id: a.id }, { id: b.id }];
  const html = render({ accounts });
  assert.match(html, /Otomatik pencere başlatma/);
  assert.match(html, /Hafta içi/);
  assert.match(html, /Hafta sonu/);
  const [first, second] = todayPlan({ accounts }).accounts;
  assert.ok(
    html.includes(`Kişisel - Max ilk başlangıç, ${clock(first.firstStart)}`),
  );
  assert.ok(html.includes(`Vertex ilk başlangıç, ${clock(second.firstStart)}`));
  assert.equal(html.match(/>Otomatik</g)?.length, 2);
  assert.doesNotMatch(html, />Elle</);
});

test("a manual first start is marked and can return to automatic", () => {
  const accounts = [{ id: a.id, firstStart: "07:00" }, { id: b.id }];
  const html = render({ accounts });
  assert.match(html, /Kişisel - Max ilk başlangıç, 07:00/);
  assert.match(html, />Elle</);
  assert.equal(html.match(/>Otomatik</g)?.length, 1);
  assert.match(html, /Otomatiğe dön/);
  const automatic = todayPlan({ accounts }).accounts[1];
  assert.equal(automatic.manual, false);
  assert.ok(
    html.includes(`Vertex ilk başlangıç, ${clock(automatic.firstStart)}`),
  );
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
  assert.match(html, /Pencere açık · Sıfırlanma 15:15/);
  assert.match(html, /text-ok-foreground/);
  // Today's count comes from the plan itself; the next start comes from the
  // keeper's live view. The deleted account takes no slot: the plan is the one
  // of the single remaining account.
  const [alone] = todayPlan({ accounts: [{ id: a.id }] }).accounts;
  assert.ok(
    html.includes(
      `Bugün ${alone.windows.length} başlatma planlı · sonraki 17:45 Vertex`,
    ),
  );
  assert.ok(
    html.includes(`Kişisel - Max ilk başlangıç, ${clock(alone.firstStart)}`),
  );
  const empty = render({
    accounts: [{ id: a.id }],
    weekday: { enabled: false, start: "09:00", end: "21:00" },
  });
  assert.match(empty, /Bu gün için plan yok/);
});

test("without a keeper view the summary is drawn from the plan", () => {
  const accounts = [{ id: a.id }, { id: b.id }];
  const html = render({ autoStart: true, accounts });
  const plan = todayPlan({ accounts });
  const count = plan.accounts.reduce((n, p) => n + p.windows.length, 0);
  const next = plan.accounts
    .flatMap((p) => p.windows.map((w) => ({ id: p.accountId, at: w.start })))
    .filter((w) => w.at > NOW)
    .sort((x, y) => x.at - y.at)[0];
  const name = next.id === a.id ? a.name : b.name;
  assert.ok(
    html.includes(
      `Bugün ${count} başlatma planlı · sonraki ${clock(next.at)} ${name}`,
    ),
  );
  assert.match(html, /Pzt–Cum/);
  assert.match(html, /12 sa/);
});

test("a day whose midnight is skipped by DST renders", () => {
  const zone = "Africa/Cairo";
  const html = renderToStaticMarkup(
    createElement(PlanningPanel, {
      settings: {
        ...DEFAULT_PLANNING,
        timeZone: zone,
        accounts: [{ id: a.id }],
      },
      accounts: [a, b],
      usage: {},
      disabled: false,
      t: (tr: string) => tr,
      now: wallTime("2026-04-24", "12:00", zone)!,
      update: () => {},
      updateAccount: () => {},
    }),
  );
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
  assert.match(html, /Durdu: yönetici politikası/);
  assert.match(html, /Yeniden dene/);
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
const tr = (text: string) => text;
// The even spread's warm-ups, fixed by hand: the plan is the even spread.
const evenByHand = [
  { id: a.id, firstStart: "04:50" },
  { id: team.id, firstStart: "06:30" },
  { id: pro.id, firstStart: "08:10" },
];
function renderScenario(accounts: PlanningSettings["accounts"], now: number) {
  return renderToStaticMarkup(
    createElement(PlanningPanel, {
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
      usage: {},
      activeId: a.id,
      disabled: false,
      t: tr,
      now,
      update: () => {},
      updateAccount: () => {},
    }),
  );
}
const laneBlock = (html: string, label: string) =>
  html.match(
    new RegExp(
      `<div class="([^"]*)" title="${label}" aria-label="${label}"[^>]*>([^<]*)<`,
    ),
  );
const count = (html: string, pattern: RegExp) =>
  html.match(pattern)?.length ?? 0;

test("the usage lane shows who works when, with switches and the comparison", () => {
  const now = wednesday("12:00");
  const html = renderScenario(automatic, now);
  assert.match(html, />Kullanım</);
  assert.match(html, />tahmin</);
  assert.match(html, /Kullanım şeridi Relay’in tahmini/);
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
        `${s.accountId ? names[s.accountId] : "Kotasız"} ${clock(s.from)}–${clock(s.to)}`,
      ),
      `${s.accountId} ${clock(s.from)}`,
    );
  assert.equal(
    count(
      html,
      /aria-label="(Kişisel - Max|Vertex Team|Pro|Kotasız) \d\d:\d\d–\d\d:\d\d"/g,
    ),
    view.lane.length,
  );
  // The planned morning is dimmed and named (a block under 8% of the day is
  // not); the live forecast from now is not dimmed.
  const morning = laneBlock(html, "Kişisel - Max 09:00–11:09")!;
  assert.match(morning[1], /opacity-50/);
  assert.equal(morning[2], "Kişisel - Max");
  assert.equal(laneBlock(html, "Vertex Team 11:55–12:00")![2], "");
  const next = view.lane.find((s) => s.from === now)!;
  assert.equal(next.accountId, a.id);
  assert.doesNotMatch(
    laneBlock(html, `Kişisel - Max 12:00–${clock(next.to)}`)![1],
    /opacity-50/,
  );
  // A switch marker wherever work moves to another account: max → pro →
  // vertex by plan, back to max at noon as it is active, then pro, vertex and
  // (after the gap) max again.
  assert.equal(count(html, /bg-foreground\/55/g), 6);
  // The comparison: this plan against the even spread, which has a gap.
  assert.match(html, />Bu plan</);
  assert.match(html, />Eşit aralıklı dağıtım</);
  assert.equal(
    forecastSummary(view.compare!.plan, tr, clock),
    "Kesintisiz · 3 geçiş",
  );
  assert.match(html, /class="block [^"]*font-semibold">Kesintisiz · 3 geçiş</);
  assert.equal(
    forecastSummary(view.compare!.even, tr, clock),
    "14:18–14:50 kotasız · 5 geçiş",
  );
  assert.match(
    html,
    /class="[^"]*text-crit[^"]*">14:18–14:50 kotasız · 5 geçiş</,
  );
});

test("an all-manual plan shows its gap on the lane and no comparison", () => {
  const html = renderScenario(evenByHand, wednesday("08:00"));
  const gap = laneBlock(html, "Kotasız 14:18–14:50")!;
  assert.match(gap[1], /bg-crit\/25/);
  const plan = dayPlan(
    WEDNESDAY,
    scenarioSettings(evenByHand),
    planContext(scenarioAccounts, busyTempo),
  );
  assert.equal(plan.forecast!.outageMinutes, 32);
  // Before work the whole lane is the plan, so its markers are the plan's switches.
  assert.equal(count(html, /bg-foreground\/55/g), plan.forecast!.switches);
  assert.doesNotMatch(html, /Bu plan|Eşit aralıklı dağıtım/);
});
