import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Usage } from "../src/pages/Usage";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type Snapshot } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const desktop = { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: "a@example.com" };
const a: Account = {
  id: "a", name: "Kişisel · Max", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  desktop, auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const b: Account = { ...a, id: "b", name: "İş · Team", desktop: { ...desktop, email: "b@example.com" }, auth: { loggedIn: true, email: "b@example.com", checkedAt: iso(NOW) } };
const accounts = [a, b];
const settings = { ...DEFAULT_SETTINGS, autoSwitchMode: "off" as const, desktopHistoryTransfer: "all" as const };

const period = (points: number) => ({
  days: 7 as const, observedFiveHourPoints: points, windowsObserved: 3, samples: 40,
  coveredMinutes: 600, coveragePercent: 12.5, partial: true as const,
});
const stat = (id: string, points: number) => ({
  accountId: id, status: "available" as const,
  periods: { sevenDay: period(points), thirtyDay: { ...period(points * 2), days: 30 as const } },
});

function relayFor(): Relay {
  return {
    api: {}, preview: false, error: "", notice: "", accounts, active: a, settings, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "a" },
    data: {
      settings, usage: {}, accounts, authFlows: [], diagnostics: { platform: "darwin" },
      usageStatistics: { a: stat("a", 42), b: stat("b", 7) },
    } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {}, setData() {},
  } as unknown as Relay;
}
const render = (relay: Relay) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(RelayContext.Provider, { value: relay }, createElement(Usage)),
    ),
  );

test("Usage shows statistics for both accounts and the warning preferences", () => {
  const html = render(relayFor());
  assert.match(html, /7 gün/);
  assert.match(html, /30 gün/);
  assert.match(html, /Kişisel · Max/);
  assert.match(html, /İş · Team/);
  assert.match(html, /42 puan/);
  assert.match(html, /Limit uyarıları/);
  assert.match(html, /Uyarı eşiği/);
  assert.match(html, /%20 kalınca/);
  assert.match(html, /Veri kaynağı ve sınırlar/);
});

test("Usage leaves the refresh interval and suggestions to other pages", () => {
  const html = render(relayFor());
  assert.doesNotMatch(html, /Limit yaklaşınca hesap öner/);
  assert.doesNotMatch(html, /Yenileme sıklığı|Otomatik yenileme/);
});
