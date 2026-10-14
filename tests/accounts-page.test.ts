import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Accounts } from "../src/pages/Accounts";
import { AccountSheetBody } from "../src/pages/accounts/AccountSheet";
import { rowActions } from "../src/pages/accounts/AccountsTable";
import { filterAccounts, groupName, planLabel } from "../src/pages/accounts/accountLabels";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type Snapshot } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const desktop = { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: "a@example.com" };
const a: Account = {
  id: "a", name: "Kişisel · Max", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan: "max5", capacityWeight: 5 }, desktop,
  auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const b: Account = {
  id: "b", name: "Studio", kind: "personal", group: "personal", color: "blue", createdAt: iso(NOW),
  planning: { plan: "pro", capacityWeight: 1 },
};
const w: Account = {
  id: "w", name: "Şirket", kind: "work", group: "work:Ekip", color: "plum", createdAt: iso(NOW),
  planning: { plan: "team", capacityWeight: 3 },
  auth: { loggedIn: true, email: "deniz.kaya@vertex.com", orgName: "Vertex", checkedAt: iso(NOW) },
};
const usage: Record<string, AccountUsage> = {
  a: { accountId: "a", status: "ready", stale: false, checkedAt: iso(NOW - 60_000), fiveHour: { usedPercent: 38 }, sevenDay: { usedPercent: 78 } },
  w: { accountId: "w", status: "error", issue: "expired", stale: true },
};
const accounts = [a, b, w];

function relayFor(extra: Partial<Relay> = {}): Relay {
  return {
    api: { desktopHistorySummary: () => new Promise(() => {}) },
    preview: false, error: "", notice: "", accounts, active: a, settings: DEFAULT_SETTINGS, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "a" },
    data: { settings: DEFAULT_SETTINGS, usage, accounts, authFlows: [] } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {},
    ...extra,
  } as unknown as Relay;
}
const wrap = (relay: Relay, child: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(RelayContext.Provider, { value: relay }, child),
    ),
  );

test("filterAccounts matches name, email, organization and group and applies the filter", () => {
  assert.deepEqual(filterAccounts(accounts, "vertex", "all", "tr").map((x) => x.id), [w.id]);
  assert.deepEqual(filterAccounts(accounts, "ekip", "all", "tr").map((x) => x.id), [w.id]);
  assert.deepEqual(filterAccounts(accounts, "", "work", "tr").map((x) => x.id), [w.id]);
  assert.deepEqual(filterAccounts(accounts, "", "personal", "tr").map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(filterAccounts(accounts, "", "connected", "tr").map((x) => x.id), [a.id]);
  assert.deepEqual(filterAccounts(accounts, "", "all", "tr").map((x) => x.id), [a.id, b.id, w.id]);
});

test("planLabel and groupName describe an account", () => {
  assert.equal(planLabel({ ...a, planning: { plan: "max5", capacityWeight: 5 } }), "Max 5×");
  assert.equal(planLabel({ ...a, planning: undefined }), undefined);
  const t = (tr: string) => tr;
  assert.equal(groupName(a, t), "Kişisel");
  assert.equal(groupName(w, t), "Ekip");
  assert.equal(groupName({ ...w, group: "work:w" }, t), "Ayrı çalışma alanı");
});

test("the accounts page lists accounts with their connection states", () => {
  const html = wrap(relayFor(), createElement(Accounts));
  assert.match(html, /<h1[^>]*>Hesaplar/);
  assert.match(html, /3 hesap · 1’i Desktop’a bağlı/);
  assert.match(html, /Hesap ekle/);
  assert.match(html, /placeholder="Hesap, e-posta veya grup ara…"/);
  for (const name of ["Kişisel · Max", "Studio", "Şirket"]) assert.match(html, new RegExp(name));
  assert.match(html, /Max 5×/);
  assert.match(html, /Açık/);
  assert.match(html, /Bağlı değil/);
  assert.match(html, /Süresi doldu/);
  assert.match(html, /%38 · %78/);
  assert.match(html, /aria-label="Studio işlemleri"/);
});

test("the accounts page shows the empty state", () => {
  const html = wrap(relayFor({ accounts: [], active: undefined }), createElement(Accounts));
  assert.match(html, /Tek panel. Tüm hesapların./);
});

test("the account sheet shows identity, connections, usage and history", () => {
  const sheetHtml = wrap(relayFor(), createElement(AccountSheetBody, { account: a, now: NOW }));
  assert.match(sheetHtml, /a@example.com/);
  assert.match(sheetHtml, /Bağlantılar/);
  assert.match(sheetHtml, /Claude Desktop/);
  assert.match(sheetHtml, /Desktop girişini yenile…/);
  assert.match(sheetHtml, /Code geçmişi/);
  assert.match(sheetHtml, /Girişi yenile/);
  assert.match(sheetHtml, /aria-label="CLI bağlantısını doğrula"/);
  assert.match(sheetHtml, /5 saatlik/);
});

test("the account sheet shows Desktop setup for the account being linked", () => {
  const relay = relayFor({ setupId: "b" });
  const sheetHtml = wrap(relay, createElement(AccountSheetBody, { account: b, now: NOW }));
  assert.match(sheetHtml, /Desktop ilk kurulumu/);
  assert.match(sheetHtml, /Desktop’a bağla/);
  assert.doesNotMatch(sheetHtml, /Yerel Code geçmişi/);
  const warnings = wrap(
    relayFor(),
    createElement(AccountSheetBody, {
      account: { ...a, auth: { loggedIn: true, accountUuid: "other", checkedAt: iso(NOW) } },
      now: NOW,
    }),
  );
  assert.match(warnings, /Desktop ve limit bağlantısı farklı hesaplara ait/);
});

test("row actions follow the Desktop link state and the switch lock", () => {
  const t = (tr: string) => tr;
  const labels = (acct: Account, relay: Relay) => rowActions(acct, relay, t).map((x) => x.label);
  const relay = relayFor();
  assert.deepEqual(labels(a, relay), ["Claude’u aç", "Girişi yenile", "Desktop girişini yenile…", "Limitleri yenile"]);
  assert.deepEqual(labels(b, relay), ["Girişi yenile", "Desktop’a bağla", "Limitleri yenile"]);
  const unlinkedActive = { ...a, desktop: undefined };
  const labelsUnlinked = labels(unlinkedActive, relayFor({ active: unlinkedActive }));
  assert.ok(!labelsUnlinked.includes("Claude’u aç"));
  assert.ok(labelsUnlinked.includes("Desktop’a bağla"));
  const linked = { ...b, id: "c", desktop };
  assert.ok(labels(linked, relay).includes("Geçiş yap"));
  for (const extra of [
    { desktopBusy: true },
    { pendingDesktop: b },
    { desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: true, errorRevision: 0, activeProfileId: "a" } },
  ] as Partial<Relay>[]) {
    const r = relayFor(extra);
    const open = rowActions(a, r, t).find((x) => x.label === "Claude’u aç");
    const sw = rowActions(linked, r, t).find((x) => x.label === "Geçiş yap");
    assert.equal(open?.disabled, true, JSON.stringify(Object.keys(extra)));
    assert.equal(sw?.disabled, true);
  }
  assert.equal(rowActions(a, relay, t).find((x) => x.label === "Claude’u aç")?.disabled, false);
});
