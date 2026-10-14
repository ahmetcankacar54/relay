import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Overview } from "../src/pages/Overview";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type Snapshot } from "../shared/types";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const acct = (id: string, name: string, plan: "pro" | "max5", desktop = true): Account => ({
  id, name, kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan, capacityWeight: 1 },
  ...(desktop ? { desktop: { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: `${id}@example.com` } } : {}),
});
const use = (id: string, five: number, week: number, reset?: number): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, ...(reset ? { resetsAt: iso(reset) } : {}) },
  sevenDay: { usedPercent: week, resetsAt: iso(NOW + 4 * 86_400_000) },
});

function relayFor(active: Account | undefined, accounts: Account[], usage: Record<string, AccountUsage>, extra: Partial<Relay> = {}): Relay {
  return {
    api: {},
    preview: false,
    error: "",
    notice: "",
    accounts,
    active,
    settings: DEFAULT_SETTINGS,
    busy: "",
    usageBusy: new Set<string>(),
    desktopBusy: false,
    hasUnclaimedDesktop: false,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: active?.id },
    data: { settings: DEFAULT_SETTINGS, usage, accounts, authFlows: [] } as unknown as Snapshot,
    requestDesktop() {},
    setSetupId() {},
    refreshUsage: async () => {},
    action: async () => {},
    ...extra,
  } as unknown as Relay;
}
const render = (relay: Relay) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(RelayContext.Provider, { value: relay }, createElement(Overview, { go: () => {}, now: NOW })),
    ),
  );

test("overview shows the active account, limits, accounts, today and automation", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const vertex = acct("vertex", "Vertex", "pro");
  const usage = {
    active: { ...use("active", 38, 78, NOW + 2 * 3_600_000), modelWindows: [{ key: "seven_day_opus", label: "Opus", usedPercent: 7 }] },
    vertex: use("vertex", 12, 31),
  };
  const html = render(relayFor(active, [active, vertex], usage, { suggestion: vertex }));
  assert.match(html, /CLAUDE DESKTOP&#x27;TA AÇIK|CLAUDE DESKTOP'TA AÇIK/);
  assert.match(html, /Kişisel · Max/);
  assert.match(html, /Max 5×/);
  assert.match(html, /Çalışıyor/);
  assert.match(html, /5 saatlik pencere/);
  assert.match(html, /Haftalık · tüm modeller/);
  assert.match(html, /Haftalık · Opus/);
  assert.match(html, /Önerilen/);
  assert.match(html, /Geçişi incele/);
  assert.match(html, /Geçiş yap/);
  assert.match(html, /Bugün/);
  assert.match(html, /Otomatik başlatma kapalı/);
  assert.match(html, /Kota dolunca geçiş ve devam/);
  assert.match(html, /Otomatik pencere başlatma/);
  assert.match(html, /Claude kapanınca hazırla/);
  assert.match(html, /Limitleri yenile/);
});

test("overview without an active account offers onboarding", () => {
  const emptyHtml = render(relayFor(undefined, [], {}));
  assert.match(emptyHtml, /İlk hesabını bağla/);
  assert.match(emptyHtml, /Hesap ekle/);
  assert.match(emptyHtml, /Başka hesap yok/);
  assert.doesNotMatch(emptyHtml, /CLAUDE DESKTOP&#x27;TA AÇIK|CLAUDE DESKTOP'TA AÇIK/);
});

test("unlinked accounts offer a Desktop link instead of a switch", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Studio", "pro", false);
  const html = render(relayFor(active, [active, other], { active: use("active", 10, 10) }));
  assert.match(html, /Desktop&#x27;a bağlı değil|Desktop'a bağlı değil/);
  assert.match(html, /Desktop&#x27;a bağla|Desktop'a bağla/);
});

const rowsOf = (html: string) => html.split("grid-cols-[1.2fr_1fr_1fr_auto]").slice(1);
const rowFor = (html: string, name: string) => rowsOf(html).find((r) => r.includes(`>${name}<`)) ?? "";
const switchButtons = (html: string) =>
  (html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Geçiş yap<\/button>/g) ?? []);

test("fleet switch is locked while a handoff is switching or continuing", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  for (const status of ["switching", "continuing"] as const) {
    const relay = relayFor(active, [active], { active: use("active", 10, 10) });
    (relay.data as Snapshot).fleet = { enabled: true, status, sourceId: "active", targetId: "active" };
    const html = render(relay);
    const tag = html.match(/<button[^>]*aria-label="Kota dolunca geçiş ve devam"[^>]*>/)?.[0] ?? "";
    assert.match(tag, /disabled=""/, status);
  }
  const relay = relayFor(active, [active], { active: use("active", 10, 10) });
  (relay.data as Snapshot).fleet = { enabled: true, status: "watching" };
  const tag = render(relay).match(/<button[^>]*aria-label="Kota dolunca geçiş ve devam"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(tag, /disabled=""/);
});

test("the suggested account carries the badge even when ranking prefers another", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const x = acct("x", "Xeno", "max5");
  const y = acct("y", "Yarn", "pro");
  const usage = { active: use("active", 90, 90), x: use("x", 5, 5), y: use("y", 30, 40) };
  const base = render(relayFor(active, [active, x, y], usage));
  const ranked = rowFor(base, "Xeno").includes("Önerilen") ? "Xeno" : "Yarn";
  const other = ranked === "Xeno" ? y : x;
  const html = render(relayFor(active, [active, x, y], usage, { suggestion: other }));
  assert.match(rowFor(html, other.name), /Önerilen/);
  assert.doesNotMatch(rowFor(html, ranked), /Önerilen/);
});

test("switch buttons are disabled while Desktop is busy, pending or needs recovery", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Vertex", "pro");
  const accounts = [active, other];
  const usage = { active: use("active", 10, 10), other: use("other", 10, 10) };
  const idle = switchButtons(render(relayFor(active, accounts, usage)));
  assert.equal(idle.length, 1);
  assert.doesNotMatch(idle[0], /disabled=""/);
  const cases: Partial<Relay>[] = [
    { desktopBusy: true },
    { pendingDesktop: other },
    { desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: true, errorRevision: 0, activeProfileId: "active" } },
  ];
  for (const extra of cases) {
    const buttons = switchButtons(render(relayFor(active, accounts, usage, extra)));
    assert.equal(buttons.length, 1);
    assert.match(buttons[0], /disabled=""/, JSON.stringify(Object.keys(extra)));
  }
});

test("stale and unlinked accounts are never recommended", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const stale = acct("stale", "Stale", "pro");
  const unlinked = acct("unlinked", "Loose", "pro", false);
  const html = render(
    relayFor(active, [active, stale, unlinked], {
      active: use("active", 10, 10),
      stale: { ...use("stale", 0, 0), checkedAt: iso(NOW - 3_600_000) },
      unlinked: use("unlinked", 0, 0),
    }),
  );
  assert.equal(rowsOf(html).length, 2);
  assert.doesNotMatch(html, /Önerilen/);
  assert.match(html, /Limit verisi eski/);
});
