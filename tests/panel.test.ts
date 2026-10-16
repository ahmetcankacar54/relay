import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "../src/panel/Panel";
import { panelHead } from "../src/panel/panel-head";
import { PanelAccounts, confirmSwitch } from "../src/panel/PanelAccounts";
import { PanelDrafts, allowAccessibilityAction, copyDraftAction, dismissDraftAction, draftReason } from "../src/panel/PanelDrafts";
import { relayAction } from "../src/data/relay-action";
import { panelRowState, accountRowSubtitle } from "../src/lib/account-row";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import type { OverviewRow } from "../src/data/selectors";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type DesktopState, type DraftSummary, type KeeperAdaptation, type KeeperSnapshot, type Snapshot } from "../shared/types";

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

const draft = (over: Partial<DraftSummary> = {}): DraftSummary => ({
  id: "d1", to: "vertex", title: "Fix the login bug", newSession: false, attachments: false,
  state: "needs-copy", reason: "lost", capturedAt: iso(NOW), ...over,
});
const withDrafts = (drafts: DraftSummary[] | undefined, extra: Partial<Relay> = {}): Relay => {
  const relay = relayFor(active, [active, vertex], baseUsage, extra);
  relay.data = { ...relay.data, ...(drafts ? { drafts } : {}) } as Snapshot;
  return relay;
};
const drafts = (relay: Relay) => wrap(relay, createElement(PanelDrafts));

test("the rescued drafts section lists only needs-copy records with reason, Copy and Dismiss", () => {
  const html = drafts(withDrafts([
    draft({ title: "Fix the login bug", reason: "lost" }),
    draft({ id: "d2", title: "Waiting for its turn", state: "pending", reason: undefined }),
  ]));
  assert.match(html, /Kurtarılan taslaklar/);
  assert.match(html, /Fix the login bug/);
  assert.match(html, /Desktop taslağı sildi/);
  assert.match(html, />Kopyala</);
  assert.match(html, />Kapat</);
  assert.equal((html.match(/>Kopyala</g) ?? []).length, 1);
  assert.doesNotMatch(html, /Waiting for its turn/);
  assert.doesNotMatch(html, /İzin ver/);
});

test("an accessibility reason offers the permission button", () => {
  const html = drafts(withDrafts([draft({ reason: "accessibility" })]));
  assert.match(html, /Erişilebilirlik izni yok/);
  assert.match(html, />İzin ver</);
  assert.match(html, />Kopyala</);
});

test("pending records show only the count line", () => {
  const html = drafts(withDrafts([
    draft({ id: "a", title: "First secret", state: "pending", reason: undefined }),
    draft({ id: "b", to: "other", title: "Second secret", state: "pending", reason: undefined }),
  ]));
  assert.match(html, /Kurtarılan taslaklar/);
  assert.match(html, /2 taslak geri yazılmayı bekliyor/);
  assert.doesNotMatch(html, /First secret|Second secret|Kopyala|Kapat/);
});

test("no drafts render nothing", () => {
  assert.equal(drafts(withDrafts(undefined)), "");
  assert.equal(drafts(withDrafts([])), "");
  assert.doesNotMatch(render(withDrafts([])), /Kurtarılan taslaklar/);
});

test("pending and needs-copy records show the count line and the rows together", () => {
  const html = drafts(withDrafts([
    draft({ id: "a", state: "pending", reason: undefined }),
    draft({ id: "b", title: "Rescued one", reason: "busy" }),
  ]));
  assert.match(html, /1 taslak geri yazılmayı bekliyor/);
  assert.match(html, /Rescued one/);
  assert.match(html, /Konuşma meşguldü/);
  assert.equal((html.match(/Kurtarılan taslaklar/g) ?? []).length, 1);
});

test("a new-session draft is named Yeni oturum and an empty title is Adsız konuşma", () => {
  const html = drafts(withDrafts([
    draft({ id: "n", newSession: true, title: "should not show" }),
    draft({ id: "e", title: "" }),
  ]));
  assert.match(html, /Yeni oturum/);
  assert.match(html, /Adsız konuşma/);
  assert.doesNotMatch(html, /should not show/);
  // A title of only spaces is no title either, and a real one is shown trimmed.
  const blank = drafts(withDrafts([draft({ title: " \t\n " })]));
  assert.match(blank, /title="Adsız konuşma"[^>]*>Adsız konuşma</);
  const padded = drafts(withDrafts([draft({ title: "  Fix login  " })]));
  assert.match(padded, /title="Fix login"[^>]*>Fix login</);
});

test("a draft's reason wraps while its name stays on one line", () => {
  const html = drafts(withDrafts([draft({ title: "Fix the login bug", reason: "maybe-typed" })]));
  const classOf = (text: string) =>
    new RegExp(`<div class="([^"]*)"[^>]*>${text}</div>`).exec(html)?.[1];
  const name = classOf("Fix the login bug");
  const reason = classOf("Konuşmaya yazılmış olabilir, yapıştırmadan önce bakın");
  assert.ok(name !== undefined && reason !== undefined);
  assert.ok(name.split(" ").includes("truncate"));
  assert.ok(!reason.split(" ").includes("truncate"));
});

test("the attachment note shows only when attachments could not be restored", () => {
  assert.match(drafts(withDrafts([draft({ attachments: true })])), /Ekleri geri yüklenemedi/);
  assert.doesNotMatch(drafts(withDrafts([draft({ attachments: false })])), /Ekleri geri yüklenemedi/);
});

test("draftReason words every reason in both languages, with a fallback", () => {
  const tr = (a: string) => a;
  const en = (_a: string, b: string) => b;
  const maybeTyped: [string, string] = [
    "Konuşmaya yazılmış olabilir, yapıştırmadan önce bakın",
    "It may already be in the conversation; check before pasting",
  ];
  const unsupported: [string, string] = [
    "Desktop arayüzü desteklenmiyor",
    "Desktop's interface is not supported",
  ];
  const busy: [string, string] = ["Konuşma meşguldü", "The conversation was busy"];
  const labels: Record<string, [string, string]> = {
    accessibility: ["Erişilebilirlik izni yok", "Accessibility permission missing"],
    "composer-not-empty": ["Mesaj kutusu doluydu", "The message box was not empty"],
    "context-changed": ["Ekran değişti", "The screen changed"],
    lost: ["Desktop taslağı sildi", "Desktop cleared the draft"],
    busy,
    manual: ["Elle yapıştırın", "Paste it yourself"],
    error: ["Geri yazılamadı", "Could not be restored"],
    // A draft that may already be in its composer says so, whichever way that came about.
    "maybe-typed": maybeTyped,
    unconfirmed: maybeTyped,
    "delivery-ambiguous": maybeTyped,
    "no-composer": ["Mesaj kutusu bulunamadı", "No message box was found"],
    unsupported,
    // The helper's own issue names read as the restorer's.
    "desktop-ui-unsupported": unsupported,
    "desktop-work-active": busy,
    "exact-session-not-observed": ["Konuşma açılamadı", "The conversation could not be opened"],
    "not-ready": ["Desktop hazır değildi", "Desktop was not ready"],
    moved: ["Başka bir ekrana geçtiniz", "You went to another screen"],
    changed: ["Ekran değişti", "The screen changed"],
    "claude-not-running": ["Claude çalışmıyordu", "Claude was not running"],
    budget: ["Süre doldu", "Ran out of time"],
  };
  for (const [reason, [turkish, english]] of Object.entries(labels)) {
    assert.equal(draftReason(reason, tr), turkish, reason);
    assert.equal(draftReason(reason, en), english, reason);
  }
  for (const reason of [undefined, "", "something-new"]) {
    assert.equal(draftReason(reason, tr), "Geri yazılamadı");
    assert.equal(draftReason(reason, en), "Could not be restored");
  }
  // A new-session draft's reasons name its screen where a conversation's would mislead.
  const maybeOnScreen: [string, string] = [
    "Yeni oturum ekranına yazılmış olabilir, yapıştırmadan önce bakın",
    "It may already be on the new-session screen; check before pasting",
  ];
  const screenBusy: [string, string] = [
    "Yeni oturum ekranı meşguldü",
    "The new-session screen was busy",
  ];
  const fresh: Record<string, [string, string]> = {
    ...labels,
    "maybe-typed": maybeOnScreen,
    unconfirmed: maybeOnScreen,
    "delivery-ambiguous": maybeOnScreen,
    busy: screenBusy,
    "desktop-work-active": screenBusy,
    "exact-session-not-observed": [
      "Yeni oturum ekranı açılamadı",
      "The new-session screen could not be opened",
    ],
  };
  for (const [reason, [turkish, english]] of Object.entries(fresh)) {
    assert.equal(draftReason(reason, tr, true), turkish, reason);
    assert.equal(draftReason(reason, en, true), english, reason);
  }
  for (const reason of [undefined, "", "something-new"])
    assert.equal(draftReason(reason, tr, true), "Geri yazılamadı");
});

test("a new-session draft's row words its reason for the new-session screen", () => {
  const html = drafts(withDrafts([
    draft({ id: "n", newSession: true, title: "", reason: "maybe-typed" }),
    draft({ id: "c", title: "A conversation", reason: "maybe-typed" }),
  ]));
  assert.match(html, /Yeni oturum ekranına yazılmış olabilir, yapıştırmadan önce bakın/);
  assert.match(html, /Konuşmaya yazılmış olabilir, yapıştırmadan önce bakın/);
});

test("the panel places rescued drafts after the suggestion and before the accounts", () => {
  const html = render(withDrafts([draft()], { suggestion: vertex }));
  const at = (re: RegExp) => html.search(re);
  assert.ok(at(/Limit dolmak üzere/) >= 0);
  assert.ok(at(/Limit dolmak üzere/) < at(/Kurtarılan taslaklar/));
  assert.ok(at(/Kurtarılan taslaklar/) < at(/>Hesaplar</));
});

test("a draft row's buttons are disabled while that row's action runs", () => {
  const both = [draft({ id: "d1", reason: "accessibility" }), draft({ id: "d2", title: "Other draft" })];
  const disabledCount = (busy: string) => {
    const html = drafts(withDrafts(both, { busy }));
    return (html.match(/disabled=""/g) ?? []).length;
  };
  assert.equal(disabledCount(""), 0);
  // d1 shows Allow, Copy and Dismiss; d2 shows Copy and Dismiss.
  assert.equal(disabledCount("draft-copy:d1"), 3);
  assert.equal(disabledCount("draft-dismiss:d2"), 2);
  // The permission key belongs to every row that offers it: here only d1.
  assert.equal(disabledCount("draft-accessibility"), 3);
  assert.equal(disabledCount("switch:vertex"), 0);
});

test("copy, dismiss and permission go through relay.action by record id", async () => {
  const calls: string[] = [];
  const keys: string[] = [];
  const relay = relayFor(active, [active, vertex], baseUsage, {
    action: async (key: string, fn: () => Promise<unknown>) => { keys.push(key); await fn(); },
    api: {
      copyDraft: async (id: string) => void calls.push(`copy:${id}`),
      dismissDraft: async (id: string) => void calls.push(`dismiss:${id}`),
      requestDesktopAccessibility: async () => { calls.push("accessibility"); return true; },
    } as unknown as Relay["api"],
  });
  await copyDraftAction(relay, "d1");
  await dismissDraftAction(relay, "d2");
  await allowAccessibilityAction(relay);
  assert.deepEqual(keys, ["draft-copy:d1", "draft-dismiss:d2", "draft-accessibility"]);
  assert.deepEqual(calls, ["copy:d1", "dismiss:d2", "accessibility"]);
});
