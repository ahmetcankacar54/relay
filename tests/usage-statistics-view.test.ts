import test from "node:test";
import assert from "node:assert/strict";
import { buildStatisticsView } from "../shared/usage-statistics-view";
import {
  emptyRollups,
  foldSamples,
  type HourRollup,
  type UsageRollups,
} from "../shared/usage-rollups";
import { usageIdentity, type UsageSample } from "../shared/usage-statistics";
import type { Account } from "../shared/types";
import { planningAccount } from "./planning-fixtures";

const ZONE = "Europe/Istanbul";
// Wednesday 2026-10-14 15:00 in Istanbul (UTC+3).
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function account(id: string, name: string, plan: "pro" | "max5" | "max20") {
  return { ...planningAccount(id, plan), name };
}
const max = account("max", "Max", "max5");
const pro = account("pro", "Pro", "pro");
const unlinked: Account = {
  ...account("none", "None", "pro"),
  auth: undefined,
};
// Linked, but no usage in any range: no row.
const spare = account("spare", "Spare", "max20");
const accounts = [max, pro, unlinked, spare];
const MAX = usageIdentity(max)!;
const PRO = usageIdentity(pro)!;
const OLD = JSON.stringify(["uuid", "gone", "org-gone"]);

const h = (points: number, windows = 0, coveredMinutes = 30): HourRollup => ({
  points,
  windows,
  coveredMinutes,
});

function fixture(): UsageRollups {
  const r = emptyRollups();
  r.hours[MAX] = {
    // Tue 2026-10-13 11:00 Istanbul
    "2026-10-13T08:00:00.000Z": h(4, 1, 60),
    // Sat 2026-10-10: observed but idle
    "2026-10-10T09:00:00.000Z": h(0),
    // Sun 2026-10-11: polled once, no coverage, so not an idle day
    "2026-10-11T09:00:00.000Z": h(0, 0, 0),
    // previous 7-day period
    "2026-10-05T08:00:00.000Z": h(2),
    // older than 90 days: ignored even for range 90
    "2026-06-01T08:00:00.000Z": h(50),
  };
  r.hours[PRO] = {
    // 22:00 UTC is 01:00 on Wed 2026-10-14 in Istanbul
    "2026-10-13T22:00:00.000Z": h(10, 1, 45),
  };
  r.hours[OLD] = { "2026-10-12T09:00:00.000Z": h(0) };
  r.windows[MAX] = [
    { resetAt: "2026-10-01T10:00:00.000Z", maxPercent: 100 },
    { resetAt: "2026-10-13T12:00:00.000Z", maxPercent: 30 },
    { resetAt: "2026-10-13T18:00:00.000Z", maxPercent: 50 },
    // still open at NOW: counted as started, not in averageFill
    { resetAt: "2026-10-14T14:00:00.000Z", maxPercent: 90 },
  ];
  r.windows[PRO] = [{ resetAt: "2026-10-14T02:00:00.000Z", maxPercent: 70 }];
  r.hits = [
    {
      identity: MAX,
      kind: "five-hour",
      at: "2026-10-13T09:00:00.000Z",
      until: "2026-10-13T10:10:00.000Z",
    },
    { identity: PRO, kind: "weekly", at: "2026-10-14T01:00:00.000Z" },
    { identity: OLD, kind: "five-hour", at: "2026-10-12T09:30:00.000Z" },
    // before the range
    { identity: MAX, kind: "five-hour", at: "2026-10-01T09:00:00.000Z" },
  ];
  return r;
}

const build = (over: Partial<Parameters<typeof buildStatisticsView>[0]> = {}) =>
  buildStatisticsView({
    rollups: fixture(),
    available: true,
    accounts,
    range: 7,
    zone: ZONE,
    now: NOW,
    ...over,
  });

test("Pro units scale points by plan capacity and shares split the total", () => {
  const view = build();
  assert.equal(view.status, "available");
  assert.equal(view.range, 7);
  assert.equal(view.totals.proUnits, 30);
  assert.deepEqual(
    view.accounts.map((a) => [
      a.accountId,
      a.former,
      a.name,
      a.plan,
      a.proUnits,
      a.share,
    ]),
    [
      ["max", undefined, "Max", "Max 5×", 20, 66.7],
      ["pro", undefined, "Pro", "Pro", 10, 33.3],
      [undefined, true, "Eski hesap", undefined, 0, 0],
    ],
  );
});

test("daily series buckets by local day in the planning zone", () => {
  const view = build();
  assert.deepEqual(
    view.daily.map((d) => d.date),
    [
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ],
  );
  const byDate = Object.fromEntries(
    view.daily.map((d) => [d.date, d.byAccount]),
  );
  assert.deepEqual(byDate["2026-10-13"], { max: 20 });
  assert.deepEqual(byDate["2026-10-14"], { pro: 10 });
  assert.deepEqual(byDate["2026-10-10"], {});

  const old = build({
    rollups: (() => {
      const r = fixture();
      r.hours[OLD]["2026-10-12T09:00:00.000Z"].points = 3;
      return r;
    })(),
  });
  const oldDay = old.daily.find((d) => d.date === "2026-10-12")!;
  assert.deepEqual(oldDay.byAccount, { former: 3 });
});

test("heatmap is [weekday Mon=0][local hour] in Pro units", () => {
  const view = build();
  assert.equal(view.heatmap.length, 7);
  assert.ok(view.heatmap.every((row) => row.length === 24));
  assert.equal(view.heatmap[1][11], 20);
  assert.equal(view.heatmap[2][1], 10);
  const sum = view.heatmap.flat().reduce((a, b) => a + b, 0);
  assert.equal(sum, 30);
});

test("averageFill uses closed windows started in range; idle days are covered days without use", () => {
  const view = build();
  const row = (id?: string) => view.accounts.find((a) => a.accountId === id)!;
  assert.equal(row("max").averageFill, 40);
  assert.equal(row("pro").averageFill, 70);
  assert.equal(row(undefined).averageFill, undefined);
  assert.equal(row("max").idleDays, 1);
  assert.equal(row("pro").idleDays, 0);
  assert.equal(row(undefined).idleDays, 1);
  assert.equal(view.totals.windows, 4);
});

test("previous period is reported only for ranges up to 45 days", () => {
  assert.equal(build().totals.previousProUnits, 10);
  assert.equal(build({ range: 30 }).totals.previousProUnits, 0);
  assert.equal(build({ range: 90 }).totals.previousProUnits, undefined);
  assert.equal(build({ range: 90 }).totals.proUnits, 40);
});

test("busiest cell and weekday 10–18 work share", () => {
  assert.deepEqual(build().totals.busiest, {
    weekday: 1,
    hour: 11,
    workShare: 66.7,
  });
  const empty = emptyRollups();
  empty.hours[MAX] = { "2026-10-13T08:00:00.000Z": h(0) };
  assert.equal(build({ rollups: empty }).totals.busiest, undefined);
});

function insightRollups(maxFills: number[], proFills: number[]) {
  const r = emptyRollups();
  r.hours[MAX] = { "2026-10-13T08:00:00.000Z": h(1) };
  r.hours[PRO] = { "2026-10-13T08:00:00.000Z": h(1) };
  const windows = (fills: number[]) =>
    fills.map((maxPercent, i) => ({
      resetAt: new Date(
        Date.parse("2026-10-09T10:00:00.000Z") + i * 6 * 3_600_000,
      ).toISOString(),
      maxPercent,
    }));
  r.windows[MAX] = windows(maxFills);
  r.windows[PRO] = windows(proFills);
  return r;
}

test("insight rule 1: highest-capacity account barely fills five or more windows", () => {
  const view = build({ rollups: insightRollups([10, 10, 10, 10, 20], [90]) });
  assert.deepEqual(view.insight, {
    tr: "Max (Max 5×) dönemlerinin ortalama yalnızca %12 kadarını dolduruyor.",
    en: "Max (Max 5×) fills only 12% of its periods.",
  });
});

test("insight rule 2: lowest-capacity account is almost always full", () => {
  // Four windows are not enough for rule 1.
  const view = build({ rollups: insightRollups([10, 10, 10, 10], [90, 85]) });
  assert.deepEqual(view.insight, {
    tr: "Pro (Pro) açıldığında neredeyse hep doluyor.",
    en: "Pro (Pro) is almost always full when it opens.",
  });
});

test("insight: an idle account beside a full one suggests shifting the order", () => {
  // Alto was last used on Thursday the 8th and observed idle every day since,
  // today included; Kişisel fills its windows.
  const alto = account("alto", "Alto", "max5");
  const kisisel = account("kisisel", "Kişisel", "pro");
  const ALTO = usageIdentity(alto)!;
  const KISISEL = usageIdentity(kisisel)!;
  const idleRollups = (idleFrom: number) => {
    const r = emptyRollups();
    r.hours[ALTO] = { "2026-10-08T08:00:00.000Z": h(2) };
    for (let day = idleFrom; day <= 14; day++)
      r.hours[ALTO][`2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`] = h(0);
    // The 11th was not observed: it neither counts nor ends the idle days.
    r.hours[ALTO]["2026-10-11T09:00:00.000Z"] = h(0, 0, 0);
    r.hours[KISISEL] = { "2026-10-13T08:00:00.000Z": h(1) };
    r.windows[KISISEL] = [
      { resetAt: "2026-10-12T10:00:00.000Z", maxPercent: 95 },
      { resetAt: "2026-10-13T10:00:00.000Z", maxPercent: 90 },
    ];
    return r;
  };
  const both = [alto, kisisel];
  assert.deepEqual(build({ accounts: both, rollups: idleRollups(9) }).insight, {
    tr: "Alto 5 gündür boşta; Kişisel ise dönemi açıldığında neredeyse hep doluyor. Alto hesabını sırada öne almak 5 saatlik limite takılmayı azaltır.",
    en: "Alto has sat idle for 5 days; Kişisel is almost always full when it opens. Moving Alto up the order would cut 5-hour limit stops.",
  });
  // Idle for two days only, or a single account's view: the plain note that Kişisel fills.
  const plain = {
    tr: "Kişisel (Pro) açıldığında neredeyse hep doluyor.",
    en: "Kişisel (Pro) is almost always full when it opens.",
  };
  assert.deepEqual(build({ accounts: both, rollups: idleRollups(13) }).insight, plain);
  assert.deepEqual(
    build({ accounts: both, accountId: "kisisel", rollups: idleRollups(9) }).insight,
    plain,
  );
});

test("no insight when neither rule applies", () => {
  assert.equal(
    build({ rollups: insightRollups([50, 50, 50, 50, 50], [60]) }).insight,
    undefined,
  );
});

test("hits are named, newest first, and counted per kind", () => {
  const view = build();
  assert.deepEqual(view.hits, [
    {
      accountId: "pro",
      name: "Pro",
      kind: "weekly",
      at: "2026-10-14T01:00:00.000Z",
    },
    {
      accountId: "max",
      name: "Max",
      kind: "five-hour",
      at: "2026-10-13T09:00:00.000Z",
      until: "2026-10-13T10:10:00.000Z",
    },
    {
      former: true,
      name: "Eski hesap",
      kind: "five-hour",
      at: "2026-10-12T09:30:00.000Z",
    },
  ]);
  assert.deepEqual(view.totals.hits, { fiveHour: 2, weekly: 1 });
});

test("account filter keeps only that account's identity", () => {
  const view = build({ accountId: "pro" });
  assert.equal(view.status, "available");
  assert.deepEqual(
    view.accounts.map((a) => a.accountId),
    ["pro"],
  );
  assert.equal(view.totals.proUnits, 10);
  assert.equal(view.accounts[0].share, 100);
  assert.deepEqual(
    view.hits.map((x) => x.accountId),
    ["pro"],
  );
  assert.equal(build({ accountId: "none" }).status, "empty");
  assert.equal(build({ accountId: "missing" }).status, "empty");
});

test("unavailable and empty states", () => {
  const unavailable = build({ available: false });
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(unavailable.accounts, []);
  assert.equal(build({ rollups: undefined }).status, "empty");
  assert.equal(build({ rollups: emptyRollups() }).status, "empty");
  const stale = emptyRollups();
  stale.hours[MAX] = { "2026-09-01T08:00:00.000Z": h(4) };
  const view = build({ rollups: stale });
  assert.equal(view.status, "empty");
  assert.equal(view.heatmap.length, 7);
  assert.equal(view.daily.length, 7);
});

test("coverage is observed minutes over the range so far", () => {
  const view = build({ range: 7 });
  // Range starts 2026-10-08 00:00 Istanbul (2026-10-07T21:00Z); 6.625 days to NOW.
  // Covered: max 60 + 30, pro 45, former 30 → per-hour max summed = 165 minutes.
  const minutes = (NOW - Date.parse("2026-10-07T21:00:00.000Z")) / 60_000;
  assert.equal(view.coveragePercent, Math.round((165 / minutes) * 1000) / 10);
});

test("a 25-hour DST day totals the sum of its 25 hourly buckets", () => {
  const zone = "Europe/Berlin";
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const r = emptyRollups();
  r.hours[PRO] = {};
  // 2026-10-25 00:00 CEST = 2026-10-24T22:00Z; 2026-10-26 00:00 CET = 23:00Z.
  for (let i = -2; i < 27; i++) {
    const key = new Date(
      Date.parse("2026-10-24T22:00:00.000Z") + i * 3_600_000,
    ).toISOString();
    r.hours[PRO][key] = h(1);
  }
  const view = build({ rollups: r, zone, now });
  const day = view.daily.find((d) => d.date === "2026-10-25")!;
  assert.deepEqual(day.byAccount, { pro: 25 });
  // The repeated 02:00 hour lands in the same heatmap cell (Sunday = 6).
  assert.equal(view.heatmap[6][2], 2);
  assert.equal(
    view.heatmap[6].reduce((a, b) => a + b, 0),
    25,
  );
});

test("rows without in-range hours, windows or hits are dropped", () => {
  const view = build();
  assert.ok(!view.accounts.some((a) => a.accountId === "spare"));
  const r = fixture();
  r.hours[OLD] = { "2026-08-01T09:00:00.000Z": h(5) };
  r.hits = r.hits.filter((hit) => hit.identity !== OLD);
  assert.ok(!build({ rollups: r }).accounts.some((a) => a.former));
});

test("polls every 10 minutes for 7 days with one window a day cover the range", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  const first = Date.parse("2026-10-07T21:00:00.000Z"); // 2026-10-08 00:00 local
  const samples: UsageSample[] = [];
  for (let t = first; t <= now; t += 10 * 60_000) {
    const dayStart = first + Math.floor((t - first) / 86_400_000) * 86_400_000;
    const opened = dayStart + 8 * 3_600_000;
    const open = t >= opened && t < opened + 5 * 3_600_000;
    samples.push({
      accountId: "max",
      identity: MAX,
      checkedAt: new Date(t).toISOString(),
      ...(open
        ? {
            fiveHour: {
              usedPercent: Math.min(100, (t - opened) / 600_000),
              resetsAt: new Date(opened + 5 * 3_600_000).toISOString(),
            },
          }
        : {}),
    });
  }
  const view = build({ rollups: foldSamples(samples, now), now });
  assert.ok(view.coveragePercent >= 99, String(view.coveragePercent));
  assert.equal(view.totals.windows, 7);
  assert.equal(view.accounts.length, 1);
  assert.equal(view.accounts[0].idleDays, 0);
});

test("an open hit whose reset has passed ends at that reset", () => {
  const r = fixture();
  r.hits = [
    {
      identity: MAX,
      kind: "five-hour",
      at: "2026-10-14T08:00:00.000Z",
      resetAt: "2026-10-14T10:00:00.000Z",
    },
    {
      identity: PRO,
      kind: "five-hour",
      at: "2026-10-14T10:00:00.000Z",
      resetAt: "2026-10-14T13:00:00.000Z",
    },
  ];
  const view = build({ rollups: r });
  const hit = (id: string) => view.hits.find((x) => x.accountId === id)!;
  assert.equal(hit("max").until, "2026-10-14T10:00:00.000Z");
  // The reset is still ahead: the hit is ongoing.
  assert.ok(!("until" in hit("pro")));
  // A reset exactly at now has passed.
  r.hits[1].resetAt = new Date(NOW).toISOString();
  assert.equal(
    build({ rollups: r }).hits.find((x) => x.accountId === "pro")!.until,
    new Date(NOW).toISOString(),
  );
});

test("a signed-out account keeps its history under its own name and plan", () => {
  const signedOut: Account = {
    ...max,
    auth: { ...max.auth!, loggedIn: false },
  };
  const view = build({ accounts: [signedOut, pro, unlinked, spare] });
  assert.deepEqual(
    view.accounts.map((a) => [a.accountId, a.former, a.proUnits]),
    [
      ["max", undefined, 20],
      ["pro", undefined, 10],
      [undefined, true, 0],
    ],
  );
  assert.equal(
    view.hits.find((x) => x.at === "2026-10-13T09:00:00.000Z")!.accountId,
    "max",
  );
  const filtered = build({ accounts: [signedOut, pro], accountId: "max" });
  assert.equal(filtered.status, "available");
  assert.equal(filtered.totals.proUnits, 20);
});

test("a signed-in account claims an identity it shares with a signed-out one", () => {
  const stale: Account = {
    ...max,
    id: "stale",
    name: "Stale",
    planning: { plan: "pro", capacityWeight: 1 },
    auth: { ...max.auth!, loggedIn: false },
  };
  const view = build({ accounts: [stale, max, pro] });
  assert.deepEqual(
    view.accounts.map((a) => [a.accountId, a.proUnits]),
    [
      ["max", 20],
      ["pro", 10],
      [undefined, 0],
    ],
  );
  // Among equals the account list order decides.
  const twin: Account = { ...max, id: "twin", name: "Twin" };
  assert.equal(
    build({ accounts: [twin, max, pro] }).accounts[0].accountId,
    "twin",
  );
});

test("the previous period is compared only when recording reaches back to its start", () => {
  // Range 7 at NOW: the previous period starts 2026-10-01 00:00 Istanbul.
  const start = "2026-09-30T21:00:00.000Z";
  const r = emptyRollups();
  r.hours[MAX] = {
    "2026-10-06T08:00:00.000Z": h(2),
    "2026-10-13T08:00:00.000Z": h(4),
  };
  // Recording began inside the previous period: no comparison.
  assert.equal(build({ rollups: r }).totals.previousProUnits, undefined);
  r.hours[MAX][start] = h(0);
  assert.equal(build({ rollups: r }).totals.previousProUnits, 10);
  // Only identities in the view count: Pro's own history starts later.
  r.hours[PRO] = { "2026-10-13T22:00:00.000Z": h(1) };
  assert.equal(
    build({ rollups: r, accountId: "pro" }).totals.previousProUnits,
    undefined,
  );
});
