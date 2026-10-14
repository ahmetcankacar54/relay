import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { PlanningPanel } from "../src/features/PlanningPanel";
import { wallTime } from "../shared/planning";
import { dayPlan, planContext } from "../shared/day-plan";
import { presetTempo } from "../shared/tempo";
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
