import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { PlanningPanel } from "../src/PlanningPanel";
import { wallTime } from "../shared/planning";
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
function render(settings: Partial<PlanningSettings>, keeper?: KeeperSnapshot) {
  return renderToStaticMarkup(
    createElement(PlanningPanel, {
      settings: {
        ...DEFAULT_PLANNING,
        timeZone: ZONE,
        weekday: { enabled: true, start: "09:00", end: "21:00" },
        ...settings,
      },
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
  const html = render({ accounts: [{ id: a.id }, { id: b.id }] });
  assert.match(html, /Otomatik pencere başlatma/);
  assert.match(html, /Hafta içi/);
  assert.match(html, /Hafta sonu/);
  assert.match(html, /Kişisel - Max ilk başlangıç, 05:15/);
  assert.match(html, /Vertex ilk başlangıç, 07:45/);
  assert.equal(html.match(/>Otomatik</g)?.length, 2);
  assert.doesNotMatch(html, />Elle</);
});

test("a manual first start is marked and can return to automatic", () => {
  const html = render({
    accounts: [{ id: a.id, firstStart: "07:00" }, { id: b.id }],
  });
  assert.match(html, /Kişisel - Max ilk başlangıç, 07:00/);
  assert.match(html, />Elle</);
  assert.equal(html.match(/>Otomatik</g)?.length, 1);
  assert.match(html, /Otomatiğe dön/);
  assert.match(html, /Vertex ilk başlangıç, 04:30/);
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
  assert.match(html, /Pencere açık · 15:15&#x27;te sıfırlanır/);
  // Today's count comes from the plan itself (06:30, 11:30, 16:30); the next
  // start comes from the keeper's live view.
  assert.match(html, /Bugün 3 başlatma planlı · sonraki 17:45 Vertex/);
  // The deleted account takes no stagger slot: one planned account warms up at 06:30.
  assert.match(html, /Kişisel - Max ilk başlangıç, 06:30/);
  const empty = render({
    accounts: [{ id: a.id }],
    weekday: { enabled: false, start: "09:00", end: "21:00" },
  });
  assert.match(empty, /Bu gün için plan yok/);
});

test("without a keeper view the summary is drawn from the plan", () => {
  const html = render({
    autoStart: true,
    accounts: [{ id: a.id }, { id: b.id }],
  });
  assert.match(html, /Bugün 7 başlatma planlı · sonraki 10:15 Kişisel - Max/);
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
