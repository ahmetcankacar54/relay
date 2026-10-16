import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "../src/panel/Panel";
import { panelHead } from "../src/panel/panel-head";
import { PanelAccounts, confirmSwitch } from "../src/panel/PanelAccounts";
import { relayAction } from "../src/data/relay-action";
import { panelRowState, accountRowSubtitle } from "../src/lib/account-row";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import type { OverviewRow } from "../src/data/selectors";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type DesktopState, type KeeperAdaptation, type KeeperSnapshot, type Snapshot } from "../shared/types";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const acct = (id: string, name: string, plan: "pro" | "max5" = "pro", desktop = true): Account => ({
  id, name, kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan, capacityWeight: 1 },
  ...(desktop ? { desktop: { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: `${id}@example.com` } } : {}),
});
const use = (id: string, five: number, week: number, reset?: number): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, ...(reset ? { resetsAt: iso(reset) } : {}) },
  sevenDay: { usedPercent: week, resetsAt: iso(NOW + 4 * 86_400_000) },
});
const desktopState = (activeProfileId?: string): DesktopState => ({
  available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId,
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
    desktop: desktopState(active?.id),
    data: { settings: DEFAULT_SETTINGS, usage, accounts, authFlows: [] } as unknown as Snapshot,
    requestDesktop() {},
    setSetupId() {},
    refreshUsage: async () => {},
    action: async () => {},
    dismissError: async () => {},
    ...extra,
  } as unknown as Relay;
}
const wrap = (relay: Relay, el: ReactElement) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(RelayContext.Provider, { value: relay }, el),
    ),
  );
const render = (relay: Relay) => wrap(relay, createElement(Panel, { now: NOW }));

const row = (state: OverviewRow["state"]): OverviewRow => ({ account: acct("x", "X"), state, recommended: false });
const idle = { desktopBusy: false, pendingDesktop: undefined, desktop: desktopState("active") } as Pick<Relay, "desktopBusy" | "pendingDesktop" | "desktop">;

test("panelRowState explains why a switch is unavailable", () => {
  const a = acct("a", "A");
  assert.deepEqual(panelRowState(row("ready"), idle), { canSwitch: true });
  assert.deepEqual(panelRowState(row("window-open"), idle), { canSwitch: true });
  assert.deepEqual(panelRowState(row("not-linked"), idle), { canSwitch: false, reason: "not-linked" });
  assert.deepEqual(panelRowState(row("exhausted"), idle), { canSwitch: false, reason: "exhausted" });
  assert.deepEqual(panelRowState(row("ready"), { ...idle, desktopBusy: true }), { canSwitch: false, reason: "busy" });
  assert.deepEqual(panelRowState(row("ready"), { ...idle, pendingDesktop: a }), { canSwitch: false, reason: "pending" });
  assert.deepEqual(
    panelRowState(row("ready"), { ...idle, desktop: { ...desktopState("active"), recoveryRequired: true } }),
    { canSwitch: false, reason: "recovery" },
  );
  // Order: not-linked wins over busy.
  assert.deepEqual(panelRowState(row("not-linked"), { ...idle, desktopBusy: true }), { canSwitch: false, reason: "not-linked" });
});

test("accountRowSubtitle keeps the overview wording", () => {
  const t = (tr: string) => tr;
  assert.equal(accountRowSubtitle(row("ready"), t, "tr", "UTC", NOW), "Hazır · pencere yok");
  assert.equal(accountRowSubtitle(row("not-linked"), t, "tr", "UTC", NOW), "Desktop’a bağlı değil");
  assert.equal(accountRowSubtitle(row("unknown"), t, "tr", "UTC", NOW), "Limit verisi eski");
});

const active = acct("active", "Kişisel · Max", "max5");
const vertex = acct("vertex", "Vertex");
const baseUsage = {
  active: { ...use("active", 38, 78, NOW + 2 * 3_600_000), modelWindows: [{ key: "seven_day_opus", label: "Opus", usedPercent: 7 }] },
  vertex: use("vertex", 12, 31),
};

test("panel shows the active account, suggestion, accounts, automation and footer", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { suggestion: vertex }));
  assert.match(html, /Claude Desktop’ta açık/);
  assert.match(html, /Kişisel · Max/);
  assert.match(html, /Max 5×/);
  assert.match(html, /Çalışıyor/);
  assert.match(html, /5 saatlik pencere/);
  assert.match(html, /Haftalık · Opus/);
  assert.match(html, /Limit dolmak üzere/);
  assert.match(html, /Önerilen/);
  // The name has its own line; the badge sits on the subtitle line so names stay readable.
  assert.match(html, /title="Vertex"[^>]*>Vertex<\/div><div[^>]*>.*Önerilen/);
  assert.match(html, /title="Pro · Hazır · pencere yok"/);
  assert.match(html, /Hesaplar/);
  assert.match(html, /Kota dolunca devam/);
  assert.match(html, /Otomatik başlatma kapalı/);
  assert.match(html, /Kapanınca hazırla/);
  assert.match(html, /Relay’i aç/);
  assert.match(html, /Güncellendi 1 dk önce/);
  assert.match(html, /Çık/);
  assert.match(html, /w-\[360px\]/);
});

test("panel without an active account points to Relay", () => {
  const html = render(relayFor(undefined, [vertex], { vertex: use("vertex", 1, 1) }));
  assert.match(html, /Claude’da kayıtlı hesap açık değil/);
});

test("stale usage on the active card says so", () => {
  const html = render(relayFor(active, [active], { active: { ...use("active", 1, 1), checkedAt: iso(NOW - 3_600_000) } }));
  assert.match(html, /Limit verisi eski/);
  assert.doesNotMatch(html, /5 saatlik pencere/);
});

test("more than six other accounts collapse into an overflow line", () => {
  const others = Array.from({ length: 7 }, (_, i) => acct(`o${i}`, `Other ${i}`));
  const usage = Object.fromEntries([["active", use("active", 10, 10)], ...others.map((o) => [o.id, use(o.id, 10, 10)])]);
  const html = render(relayFor(active, [active, ...others], usage));
  assert.equal(html.split("grid-cols-[1fr_72px_72px_auto]").length - 1, 6);
  assert.match(html, /\+1 hesap · Relay’de gör/);
});

test("Desktop busy disables every switch and explains why", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { suggestion: vertex, desktopBusy: true }));
  assert.match(html, /Desktop işlemi sürüyor/);
  const all = (html.match(/>Geç</g) ?? []).length;
  assert.ok(all >= 2);
  assert.equal(all, (html.match(/disabled=""[^>]*>Geç</g) ?? []).length);
});

test("recovery required points to Relay", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { desktop: { ...desktopState("active"), recoveryRequired: true } }));
  assert.match(html, /Önce Desktop yedeğini geri yükle/);
});

test("errors show inside the panel", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { error: "Something failed." }));
  assert.match(html, /role="alert"/);
});

test("confirm state warns before switching", () => {
  const relay = relayFor(active, [active, vertex], baseUsage);
  const html = wrap(relay, createElement(PanelAccounts, { now: NOW, initialConfirm: "vertex" }));
  assert.match(html, /Claude kapanıp <b>Vertex<\/b> ile yeniden açılır/);
  assert.match(html, /Vazgeç/);
  assert.match(html, /Onayla/);
});

test("a running switch replaces the confirm box with progress", () => {
  const relay = relayFor(active, [active, vertex], baseUsage, { busy: "switch:vertex" });
  const html = wrap(relay, createElement(PanelAccounts, { now: NOW, initialConfirm: "vertex" }));
  assert.match(html, /Vertex hesabına geçiliyor…/);
  assert.doesNotMatch(html, /Onayla/);
  assert.equal((html.match(/>Geç</g) ?? []).length, (html.match(/disabled=""[^>]*>Geç</g) ?? []).length);
});

test("the active name keeps a tooltip when truncated", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage));
  assert.match(html, /title="Kişisel · Max"[^>]*>Kişisel · Max</);
});

test("a pending Desktop connection explains itself and links to accounts", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { pendingDesktop: vertex }));
  assert.match(html, /Desktop bağlantısı tamamlanmayı bekliyor/);
  const opened: string[] = [];
  const relay = relayFor(active, [active, vertex], baseUsage, {
    pendingDesktop: vertex,
    api: { openPage: async (page: string) => void opened.push(page) } as unknown as Relay["api"],
  });
  // The link target is checked through the exported handler.
  return import("../src/panel/PanelActiveCard").then(({ openPendingDesktop }) => {
    openPendingDesktop(relay);
    assert.deepEqual(opened, ["hesaplar"]);
  });
});

test("a rejected switch clears the confirmation and shows the error", async () => {
  const errors: unknown[] = [];
  let busy = "";
  let refreshed = false;
  const lock = { current: false };
  const action = relayAction(lock, {
    setBusy: (k) => (busy = k),
    setError() {},
    setNotice() {},
    refresh: async () => void (refreshed = true),
    showError: (e) => void errors.push(e),
  });
  const relay = relayFor(active, [active, vertex], baseUsage, {
    action,
    api: { switchDesktop: async () => { throw new Error("Claude did not quit."); } } as unknown as Relay["api"],
  });
  let cleared = false;
  await new Promise<void>((resolve) => confirmSwitch(relay, "vertex", () => { cleared = true; resolve(); }));
  assert.equal(cleared, true);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /Claude did not quit/);
  assert.equal(refreshed, false);
  assert.equal(busy, "");
  assert.equal(lock.current, false);
});

test("the planning pill names the adopted start while the plan is adapted", () => {
  // 10:00 / 10:30 UTC are 13:00 / 13:30 in Istanbul, the planning zone.
  const settings = {
    ...DEFAULT_SETTINGS,
    planning: { ...DEFAULT_SETTINGS.planning, autoStart: true, accounts: [{ id: "active" }, { id: "vertex" }] },
  };
  const keeper = (adaptation?: KeeperAdaptation): KeeperSnapshot => ({
    enabled: true,
    running: false,
    accounts: [],
    attempts: [],
    plannedToday: 2,
    next: { accountId: "active", at: "2026-10-15T10:00:00.000Z" },
    ...(adaptation ? { adaptation } : {}),
  });
  const pill = (planning: KeeperSnapshot, planningSettings = settings) =>
    render(
      relayFor(active, [active, vertex], baseUsage, {
        settings: planningSettings,
        data: { settings: planningSettings, usage: baseUsage, accounts: [active, vertex], authFlows: [], planning } as unknown as Snapshot,
      }),
    );
  const deferred = { factor: 1.6, schedule: [{ accountId: "vertex", startAt: "2026-10-15T10:30:00.000Z" }] };
  assert.match(pill(keeper(deferred)), />Uyarlandı · Vertex 13:30</);
  assert.doesNotMatch(pill(keeper(deferred)), /Sonraki başlatma/);
  // A faster pace alone, or no adaptation: the next start as before.
  for (const planning of [keeper({ factor: 1.6, schedule: [] }), keeper()]) {
    const html = pill(planning);
    assert.match(html, />Sonraki başlatma 13:00 · Kişisel · Max</);
    assert.doesNotMatch(html, /Uyarlandı/);
  }
  // An entry whose time does not parse is skipped.
  assert.match(
    pill(keeper({ factor: 1, schedule: [{ accountId: "vertex", startAt: "later" }, ...deferred.schedule] })),
    />Uyarlandı · Vertex 13:30</,
  );
  assert.match(
    pill(keeper({ factor: 1, schedule: [{ accountId: "vertex", startAt: "later" }] })),
    />Sonraki başlatma 13:00 · Kişisel · Max</,
  );
  // Adaptation turned off applies at once.
  assert.doesNotMatch(
    pill(keeper(deferred), { ...settings, planning: { ...settings.planning, adaptive: false } }),
    /Uyarlandı/,
  );
});

test("the panel header shows the panda head for the menu bar pose", () => {
  const active = acct("active", "Kişisel");
  const scene = (usage: Record<string, AccountUsage>, extra: Partial<Relay> = {}) =>
    /<header[\s\S]*?data-scene="([^"]+)"/.exec(render(relayFor(active, [active], usage, extra)))?.[1];
  assert.equal(scene({ active: use("active", 20, 10) }), "head-idle");
  assert.equal(scene({ active: use("active", 95, 10) }), "head-hungry");
  assert.equal(scene({ active: use("active", 100, 10) }), "head-sleep");
  assert.equal(
    scene({ active: use("active", 20, 10) }, { desktop: { ...desktopState("active"), recoveryRequired: true } }),
    "head-alert",
  );
  // The 18 px head is not playful: a click on it does nothing.
  const html = render(relayFor(active, [active], { active: use("active", 20, 10) }));
  assert.match(html, /<header[\s\S]*?data-scene="head-idle"/);
  assert.doesNotMatch(html, /data-playful/);
});

test("the panel head rests on idle until the panel has data", () => {
  assert.equal(panelHead(undefined, desktopState("a"), NOW), "head-idle");
  assert.equal(panelHead({ accounts: [], usage: {} }, desktopState(), NOW), "head-idle");
});

test("the panel head follows the keeper's attempts like the menu bar", () => {
  const active = acct("active", "Kişisel");
  const data = { accounts: [active], usage: { active: use("active", 95, 10) } };
  // Without an attempt the active account at 95% is hungry.
  assert.equal(panelHead(data, desktopState("active"), NOW), "head-hungry");
  // A window warm-up shows the warming pose, whose head is idle.
  const attempts = [
    { id: "1", accountId: "active", identityKey: "k", at: iso(NOW - 30_000), status: "started" as const },
  ];
  assert.equal(panelHead({ ...data, planning: { attempts } }, desktopState("active"), NOW), "head-idle");
});
