import test from "node:test";
import assert from "node:assert/strict";
import { overviewAccounts, sidebarStatus, tempoRateNow, usageWindowRows } from "../src/data/selectors";
import { presetTempo } from "../shared/tempo";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type Snapshot } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const acct = (id: string, plan: "pro" | "max5", desktop = true): Account => ({
  id, name: id, kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan, capacityWeight: 1 },
  ...(desktop ? { desktop: { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW) } } : {}),
});
const use = (id: string, five: number, week: number, reset?: number): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, ...(reset ? { resetsAt: iso(reset) } : {}) },
  sevenDay: { usedPercent: week, resetsAt: iso(NOW + 4 * 86_400_000) },
});

test("overview lists other accounts best first and recommends one usable account", () => {
  const [active, pro, max, full, unlinked] = [acct("active", "max5"), acct("pro", "pro"), acct("max", "max5"), acct("full", "max5"), acct("unlinked", "pro", false)];
  const rows = overviewAccounts(active, [active, pro, max, full, unlinked], {
    pro: use("pro", 0, 10),
    max: use("max", 20, 30, NOW + 3_600_000),
    full: use("full", 100, 40, NOW + 7_200_000),
  }, NOW);
  assert.deepEqual(rows.map((r) => r.account.id), ["max", "pro", "full", "unlinked"]);
  assert.deepEqual(rows.map((r) => r.state), ["window-open", "ready", "exhausted", "not-linked"]);
  assert.deepEqual(rows.map((r) => r.recommended), [true, false, false, false]);
  assert.equal(rows[2].availableAt, iso(NOW + 7_200_000));
});

test("overview orders like switching: the soonest reset that holds half an hour at the tempo", () => {
  const [active, soon, max] = [acct("active", "max5"), acct("soon", "pro"), acct("max", "max5")];
  // soon: 50 Pro units until its reset in 30 minutes; max: 400 until its reset in an hour.
  const usage = { soon: use("soon", 50, 10, NOW + 1_800_000), max: use("max", 20, 10, NOW + 3_600_000) };
  const order = (rate?: number) =>
    overviewAccounts(active, [active, soon, max], usage, NOW, rate).map((r) => [r.account.id, r.recommended]);
  assert.deepEqual(order(), [["soon", true], ["max", false]]);
  assert.deepEqual(order(200), [["max", true], ["soon", false]]);
});

test("the tempo rate is read from the keeper's tempo when the main process reported one", () => {
  const tempo = { ...presetTempo("heavy"), weekday: Array.from({ length: 24 }, (_, hour) => hour) };
  const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_SETTINGS.planning, timeZone: "UTC" } };
  const data = { planning: { tempo } } as unknown as Snapshot;
  // 2026-10-14 is a Wednesday; 10:00 UTC reads the weekday profile's hour 10.
  assert.equal(tempoRateNow(data, settings, NOW), 10);
  assert.equal(tempoRateNow({ planning: {} } as unknown as Snapshot, settings, NOW), undefined);
  assert.equal(tempoRateNow(undefined, settings, NOW), undefined);
});

test("stale usage is never recommended", () => {
  const a = acct("a", "max5");
  const stale = { ...use("a", 0, 0), checkedAt: iso(NOW - 3_600_000) };
  const [row] = overviewAccounts(undefined, [a], { a: stale }, NOW);
  assert.equal(row.state, "unknown");
  assert.equal(row.recommended, false);
});

test("sidebar status reflects automation switches", () => {
  const base = { settings: DEFAULT_SETTINGS, accounts: [acct("a", "pro")] } as unknown as Snapshot;
  assert.deepEqual(sidebarStatus(base), { accounts: 1, planning: false, switching: false, proxyRunning: false });
  const on = { ...base, settings: { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_SETTINGS.planning, autoStart: true } }, fleet: { enabled: true, status: "watching" } } as unknown as Snapshot;
  assert.deepEqual(sidebarStatus(on), { accounts: 1, planning: true, switching: true, proxyRunning: false });
  assert.deepEqual(sidebarStatus(undefined), { accounts: 0, planning: false, switching: false, proxyRunning: false });
  // The gateway rides on the desktop state: running shows its address, a wildcard host through loopback.
  const desktop = (running: boolean, host = "127.0.0.1") =>
    ({ proxyStatus: { running, host, port: 8317, stats: {}, accounts: [] } }) as never;
  assert.deepEqual(sidebarStatus(base, desktop(true)), {
    accounts: 1, planning: false, switching: false, proxyRunning: true, proxyAddress: "127.0.0.1:8317",
  });
  assert.equal(sidebarStatus(base, desktop(true, "0.0.0.0")).proxyAddress, "127.0.0.1:8317");
  assert.equal(sidebarStatus(base, desktop(false)).proxyRunning, false);
  assert.equal("proxyAddress" in sidebarStatus(base, desktop(false)), false);
});

test("usage rows include model windows after the main ones", () => {
  const rows = usageWindowRows({ ...use("a", 38, 78), modelWindows: [{ key: "seven_day_opus", label: "Opus", usedPercent: 7 }] });
  assert.deepEqual(rows.map((r) => [r.key, r.label.tr, r.usedPercent]), [
    ["five_hour", "5 saatlik dönem", 38],
    ["seven_day", "Haftalık · tüm modeller", 78],
    ["seven_day_opus", "Haftalık · Opus", 7],
  ]);
  assert.deepEqual(usageWindowRows(undefined), []);
});
