import test from "node:test";
import assert from "node:assert/strict";
import { trayTitle, trayTooltip, type TraySnapshot } from "../shared/tray";
import { PANEL_WIDTH, clampPanelHeight, panelPosition } from "../shared/tray-panel";
import type { Account, AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const account = { id: "a", name: "A", kind: "personal", group: "personal", color: "olive", createdAt: "2026-10-01T00:00:00Z",
  desktop: { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: "2026-10-01T00:00:00Z" } } as Account;
const usage = (five: number, checked = NOW - 60_000): AccountUsage => ({
  accountId: "a", status: "ready", stale: false, checkedAt: new Date(checked).toISOString(),
  fiveHour: { usedPercent: five, resetsAt: new Date(NOW + 3_600_000).toISOString() },
  sevenDay: { usedPercent: 10, resetsAt: new Date(NOW + 86_400_000).toISOString() },
});
const snap = (u?: AccountUsage, active = "a"): TraySnapshot => ({
  accounts: [account], usage: u ? { a: u } : ({} as Record<string, AccountUsage>),
  desktop: { available: true, running: true, organizations: [], activeProfileId: active, busy: false, recoveryRequired: false, errorRevision: 0 },
});

test("tray title shows the active account's five-hour percent used, compact", () => {
  assert.equal(trayTitle(snap(usage(37.6)), NOW), "37%");
  // From 80 % on, the time left until the window renews (an hour here) follows the percent.
  assert.equal(trayTitle(snap(usage(90)), NOW), "90% · 1:00");
  assert.equal(trayTitle(snap(usage(94)), NOW, "en"), "94% · 1:00");
  assert.equal(trayTitle(snap(usage(94)), NOW, "tr"), "%94 · 1:00");
  // Only a full window reads 100.
  assert.equal(trayTitle(snap(usage(99.9)), NOW, "tr"), "%99 · 1:00");
  assert.equal(trayTitle(snap(usage(100)), NOW, "tr"), "%100 · 1:00");
  assert.equal(trayTitle(snap(usage(0)), NOW, "tr"), "%0");
  assert.equal(trayTitle(snap(usage(20, NOW - 3_600_000)), NOW), "");
  assert.equal(trayTitle(snap(undefined), NOW), "");
  assert.equal(trayTitle(snap(usage(20), "missing"), NOW), "");
});

test("the tooltip says what the title's number is", () => {
  assert.equal(trayTooltip(snap(usage(94)), "tr", NOW), "Relay — A · %94 kullanıldı · 1:00 sonra yenilenir");
  assert.equal(trayTooltip(snap(usage(94)), "en", NOW), "Relay — A · 94% used · renews in 1:00");
  assert.equal(trayTooltip(snap(usage(20, NOW - 3_600_000)), "en", NOW), "Relay — A");
});

test("the panel opens under the icon and stays on screen", () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: PANEL_WIDTH, height: 500 };
  assert.deepEqual(panelPosition({ x: 700, y: 0, width: 30, height: 24 }, work, size), { x: 535, y: 28 });
  assert.deepEqual(panelPosition({ x: 1420, y: 0, width: 30, height: 24 }, work, size), { x: 1072, y: 28 });
  assert.deepEqual(panelPosition({ x: 2, y: 0, width: 30, height: 24 }, work, size), { x: 8, y: 28 });
  assert.equal(clampPanelHeight(50, 875), 200);
  assert.equal(clampPanelHeight(2000, 875), 859);
  assert.equal(clampPanelHeight(512.4, 875), 513);
});
