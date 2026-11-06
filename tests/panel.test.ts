import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "../src/panel/Panel";
import { panelHead } from "../src/panel/panel-head";
import { PanelAccounts, confirmSwitch } from "../src/panel/PanelAccounts";
import { PanelDrafts, allowAccessibilityAction, copyDraftAction, dismissDraftAction, draftReason } from "../src/panel/PanelDrafts";
import { PanelSidebar } from "../src/panel/PanelSidebar";
import { PanelExtension, extensionOfferLine, syncExtensionAction } from "../src/panel/PanelExtension";
import { copySidebarRecipeAction, dismissSidebarGapAction, sidebarGapLine } from "../src/lib/sidebar-recipe";
import { relayAction } from "../src/data/relay-action";
import { panelRowState, accountRowSubtitle } from "../src/lib/account-row";
import { PanelActiveCard, panelEyebrow } from "../src/panel/PanelActiveCard";
import { fakeDom } from "./fake-dom";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import type { OverviewRow } from "../src/data/selectors";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type AuthFlow, type DesktopState, type DraftSummary, type ExtensionOffer, type KeeperAdaptation, type KeeperSnapshot, type SidebarGapSummary, type Snapshot, type UsageIssue } from "../shared/types";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const acct = (id: string, name: string, plan: "pro" | "max5" = "pro", desktop = true): Account => ({
  id, name, kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan, capacityWeight: 1 },
  // Usage is read through the usage sign-in, so a healthy account has one.
  auth: { loggedIn: true, email: `${id}@example.com`, checkedAt: iso(NOW) },
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
/** The panel's account rows, each from its <button> on. */
const panelRows = (html: string) =>
  html.split(/<div data-slot="account-row"[^>]*>/).slice(1).map((r) => r.slice(0, r.indexOf("</button>") + "</button>".length));

const row = (state: OverviewRow["state"]): OverviewRow => ({ account: acct("x", "X"), usage: use("x", 1, 1), state, recommended: false });
const idle = { desktopBusy: false, pendingDesktop: undefined, desktop: desktopState("active") } as Pick<Relay, "desktopBusy" | "pendingDesktop" | "desktop">;

test("panelRowState explains why a switch is unavailable", () => {
  const a = acct("a", "A");
  assert.deepEqual(panelRowState(row("ready"), idle), { canSwitch: true });
  assert.deepEqual(panelRowState(row("window-open"), idle), { canSwitch: true });
  assert.deepEqual(panelRowState(row("not-linked"), idle), { canSwitch: false, reason: "not-linked" });
  // A full account can be switched to; the switch says its limit is full.
  assert.deepEqual(panelRowState(row("exhausted"), idle), { canSwitch: true, full: true });
  assert.deepEqual(panelRowState(row("exhausted"), { ...idle, desktopBusy: true }), { canSwitch: false, reason: "busy" });
  assert.deepEqual(panelRowState(row("ready"), { ...idle, desktopBusy: true }), { canSwitch: false, reason: "busy" });
  assert.deepEqual(panelRowState(row("ready"), { ...idle, pendingDesktop: a }), { canSwitch: false, reason: "pending" });
  assert.deepEqual(
    panelRowState(row("ready"), { ...idle, desktop: { ...desktopState("active"), recoveryRequired: true } }),
    { canSwitch: false, reason: "recovery" },
  );
  // An account open in its own window cannot be switched to until it closes.
  const windowed = { ...idle, data: { windows: { supported: true, enabled: true, open: [{ accountId: "x" }], others: 0 } } } as Pick<Relay, "desktopBusy" | "pendingDesktop" | "desktop" | "data">;
  assert.deepEqual(panelRowState(row("ready"), windowed), { canSwitch: false, reason: "window" });
  // Order: not-linked wins over busy.
  assert.deepEqual(panelRowState(row("not-linked"), { ...idle, desktopBusy: true }), { canSwitch: false, reason: "not-linked" });
});

test("accountRowSubtitle keeps the overview wording", () => {
  const t = (tr: string) => tr;
  assert.equal(accountRowSubtitle(row("ready"), t, "tr", "UTC", NOW), "Hazır · dönem başlamadı");
  assert.equal(accountRowSubtitle(row("not-linked"), t, "tr", "UTC", NOW), "Claude uygulaması girişi yok");
  assert.equal(accountRowSubtitle(row("unknown"), t, "tr", "UTC", NOW), "Limit verisi eski");
});

/** Usage that failed with an issue, and so is no longer fresh. */
const failed = (id: string, issue: UsageIssue): AccountUsage => ({ accountId: id, status: "error", stale: true, issue });
/** A row in each state the account's status reports, with the label it must show. */
const problemRows = (): [string, OverviewRow, string, string][] => {
  const x = acct("x", "X");
  const stale = { ...use("x", 1, 1), checkedAt: iso(NOW - 3_600_000) };
  return [
    ["no usage sign-in", { account: { ...x, auth: undefined }, usage: stale, state: "unknown", recommended: false }, "Limit okuma girişi yok", "No usage sign-in"],
    ["expired usage sign-in", { account: x, usage: failed("x", "expired"), state: "unknown", recommended: false }, "Limit okuma girişi gerekli", "Usage sign-in needed"],
    ["locked Keychain", { account: x, usage: failed("x", "keychain-locked"), state: "unknown", recommended: false }, "Anahtarlık izni gerekli", "Keychain access needed"],
    ["connection to renew", { account: x, usage: failed("x", "renewal-required"), state: "unknown", recommended: false }, "Bağlantı yenilenmeli", "Connection needs renewing"],
    // Fresh limits, but the connection must be renewed before the next read: not "Hazır".
    ["connection flag on fresh limits", { account: x, usage: { ...use("x", 1, 1), connectionRenewalRequired: true }, state: "ready", recommended: false }, "Bağlantı yenilenmeli", "Connection needs renewing"],
  ];
};

test("accountRowSubtitle shows the account's status when something is wrong", () => {
  const tr = (a: string) => a;
  const en = (_: string, b: string) => b;
  for (const [name, r, trLabel, enLabel] of problemRows()) {
    assert.equal(accountRowSubtitle(r, tr, "tr", "UTC", NOW), trLabel, name);
    assert.equal(accountRowSubtitle(r, en, "en", "UTC", NOW), enLabel, name);
  }
  // A pending browser approval says so.
  assert.equal(accountRowSubtitle(row("unknown"), tr, "tr", "UTC", NOW, true), "Tarayıcıda onayla");
  // A stale but healthy row keeps its old text, and so do the other healthy states.
  const staleHealthy: OverviewRow = { account: acct("x", "X"), usage: { ...use("x", 1, 1), checkedAt: iso(NOW - 3_600_000) }, state: "unknown", recommended: false };
  assert.equal(accountRowSubtitle(staleHealthy, tr, "tr", "UTC", NOW), "Limit verisi eski");
  assert.equal(accountRowSubtitle(staleHealthy, en, "en", "UTC", NOW), "Usage data is out of date");
  assert.equal(accountRowSubtitle({ ...staleHealthy, usage: use("x", 1, 1), state: "ready" }, tr, "tr", "UTC", NOW), "Hazır · dönem başlamadı");
});

test("panel rows show the account's status when something is wrong", () => {
  for (const [name, r, label] of problemRows()) {
    const other = { ...r.account, id: "other", name: "Other" };
    const html = wrap(
      relayFor(active, [active, other], { active: use("active", 10, 10), other: { ...r.usage!, accountId: "other" } }),
      createElement(PanelAccounts, { now: NOW }),
    );
    // The row's one line names the problem first, then the percents of any reading; its tooltip names it alone.
    assert.match(html, new RegExp(`title="${label}"`), name);
    const reading = r.usage?.checkedAt ? " · %1 · %1" : "";
    assert.match(html, new RegExp(`<span class="block truncate text-muted-foreground text-2xs">${label}${reading}</span>`), name);
    assert.doesNotMatch(html, /Limit verisi eski|Hazır · dönem başlamadı/, name);
  }
  // A browser approval in progress for that account.
  const flows = [{ id: "f", accountId: "vertex", status: "waiting" }] as unknown as AuthFlow[];
  const waiting = relayFor(active, [active, vertex], baseUsage);
  (waiting.data as Snapshot).authFlows = flows;
  assert.match(wrap(waiting, createElement(PanelAccounts, { now: NOW })), /title="Tarayıcıda onayla"/);
});

/** The active card's stale line, as the panel draws it. */
const activeCard = (usage: AccountUsage, account: Account = active, extra: Partial<Relay> = {}) =>
  wrap(relayFor(account, [account], { [account.id]: usage }, extra), createElement(PanelActiveCard, { now: NOW }));

test("the panel's active card names what is wrong instead of out-of-date data", () => {
  const staleActive = { ...use("active", 1, 1), checkedAt: iso(NOW - 3_600_000) };
  // Healthy but stale: today's text and refresh.
  const healthy = activeCard(staleActive);
  assert.match(healthy, /Limit verisi eski ·/);
  assert.match(healthy, /aria-label="Limitleri yenile"/);
  for (const [issue, label, button] of [
    ["keychain-locked", "Anahtarlık izni gerekli", "Anahtarlık erişimine izin ver"],
    ["renewal-required", "Bağlantı yenilenmeli", "Yenilemeye izin ver"],
  ] as const) {
    const html = activeCard(failed("active", issue));
    assert.match(html, new RegExp(`${label} ·`), issue);
    assert.match(html, new RegExp(`aria-label="${button}"`), issue);
    assert.doesNotMatch(html, /Limit verisi eski|aria-label="Limitleri yenile"/, issue);
  }
  // An expired usage sign-in names it; its button is today's refresh.
  const expired = activeCard(failed("active", "expired"));
  assert.match(expired, /Limit okuma girişi gerekli ·/);
  assert.match(expired, /aria-label="Limitleri yenile"/);
  assert.match(activeCard(staleActive, { ...active, auth: undefined }), /Limit okuma girişi yok ·/);
});

test("the panel's active card renews with a prompt, and refreshes without one otherwise", async () => {
  const calls: unknown[][] = [];
  const refreshUsage = async (...args: unknown[]) => void calls.push(args);
  const dom = fakeDom();
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const press = async (usage: AccountUsage, label: string) => {
      await act(async () =>
        root.render(
          createElement(
            I18nContext.Provider,
            { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
            createElement(
              RelayContext.Provider,
              { value: relayFor(active, [active], { active: usage }, { refreshUsage } as Partial<Relay>) },
              createElement(PanelActiveCard, { now: NOW }),
            ),
          ),
        ),
      );
      type Node = { tagName: string; attributes: Map<string, string>; childNodes: Node[] };
      const all = (n: Node): Node[] => [n, ...n.childNodes.flatMap(all)];
      const button = all(dom.container as unknown as Node).find((n) => n.tagName === "button" && n.attributes.get("aria-label") === label);
      assert.ok(button, label);
      await act(async () => dom.dispatch(button, "click", { detail: 1 }));
    };
    await press(failed("active", "keychain-locked"), "Anahtarlık erişimine izin ver");
    await press(failed("active", "renewal-required"), "Yenilemeye izin ver");
    await press({ ...use("active", 1, 1), checkedAt: iso(NOW - 3_600_000) }, "Limitleri yenile");
    await press(failed("active", "expired"), "Limitleri yenile");
    assert.deepEqual(calls, [[active, true], [active, true], [active], [active]]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

const active = acct("active", "Kişisel · Max", "max5");
const vertex = acct("vertex", "Vertex");
const baseUsage = {
  active: { ...use("active", 38, 78, NOW + 2 * 3_600_000), modelWindows: [{ key: "seven_day_opus", label: "Opus", usedPercent: 7 }] },
  vertex: use("vertex", 12, 31),
};

test("panel shows the active account, suggestion, accounts, automation and footer", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { suggestion: vertex }));
  // The active card has no eyebrow: whether Claude runs sits next to the name, with its dot.
  assert.doesNotMatch(html, />Claude uygulamasında açık</);
  assert.match(html, /Kişisel · Max/);
  assert.match(html, /Max 5×/);
  assert.match(html, />Max 5×<\/span><span[^>]*title="Claude uygulamasında açık hesap"><span[^>]*bg-ok[^>]*><\/span>Claude açık</);
  assert.doesNotMatch(html, /Çalışıyor/);
  assert.match(html, /5 saatlik dönem/);
  assert.match(html, /Haftalık · Opus/);
  // No suggestion strip: the accounts heading says the limit is near and the suggestion leads.
  assert.match(html, />Limit dolmak üzere</);
  assert.doesNotMatch(html, /Önerilen:/);
  assert.equal((html.match(/Limit dolmak üzere/g) ?? []).length, 1);
  // The rings' key sits by the heading: the filled dot is the five hours, the hollow one the week.
  assert.match(html, /<span[^>]*rounded-full bg-foreground\/70[^>]*><\/span>5 sa<\/span><span[^>]*><span[^>]*rounded-full border border-foreground\/70[^>]*><\/span>hafta</);
  // The suggested row is the switch: its ring, the name with a small "önerilen", its line and Geç.
  const suggestedRow = panelRows(html).find((r) => r.includes(">Vertex<")) ?? "";
  assert.match(suggestedRow, /^<button type="button" aria-pressed="false" aria-label="Vertex hesabına geç · Vertex · 5 saat %12 kullanıldı · hafta %31 kullanıldı" title="Hazır · dönem başlamadı"/);
  // Its two limits are the ring's, used percent per window.
  assert.match(suggestedRow, /<div role="img" aria-label="Vertex · 5 saat %12 kullanıldı · hafta %31 kullanıldı"/);
  // Its line starts with the two percents.
  assert.match(suggestedRow, />Vertex<\/span><span[^>]*>önerilen<\/span><\/span><span[^>]*>Hazır · %12 · %31<\/span><\/span><span[^>]*>Geç<\/span><\/button>/);
  assert.match(html, />Otomasyon</);
  // Automation reads as rows: the setting's name and its state, each opening its page.
  assert.match(html, /<button type="button" title="Kişisel · Max %78 kullanıldı · Kapalı\. Limit dolunca başka hesaba sen geçersin\."[^>]*>.*?>Otomatik geçiş<\/span><span[^>]*>Kapalı<\/span>/);
  assert.match(html, /<button type="button"[^>]*>.*?>Önceden başlatma<\/span><span[^>]*>Kapalı<\/span>/);
  assert.doesNotMatch(html, /Kapanınca hazırla/);
  assert.match(html, /Relay’i aç/);
  assert.match(html, /1 dk önce güncellendi/);
  assert.match(html, /Çık/);
  assert.match(html, /w-\[360px\]/);
});

test("panel without an active account points to Relay", () => {
  const html = render(relayFor(undefined, [vertex], { vertex: use("vertex", 1, 1) }));
  assert.match(html, /Claude uygulamasında kayıtlı hesap açık değil/);
});

test("with no account yet, the panel offers adding one in the main window", async () => {
  const html = render(relayFor(undefined, [], {}));
  assert.match(html, /Henüz hesap yok ·\s*<button[^>]*>Hesap ekle<\/button>/);
  assert.doesNotMatch(html, /Başka hesap yok/);
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "en", setLanguage() {}, t: (_: string, en: string) => en } },
      createElement(RelayContext.Provider, { value: relayFor(undefined, [], {}) }, createElement(Panel, { now: NOW })),
    ),
  );
  assert.match(en, /No accounts yet ·\s*<button[^>]*>Add account<\/button>/);
  // With accounts but none besides the open one, it stays "no other accounts".
  assert.match(render(relayFor(active, [active], { active: use("active", 1, 1) })), /Başka hesap yok/);
  const opened: unknown[][] = [];
  const relay = relayFor(undefined, [], {}, {
    api: { openPage: async (...args: unknown[]) => void opened.push(args) } as unknown as Relay["api"],
  });
  const { openAddAccount } = await import("../src/panel/PanelAccounts");
  openAddAccount(relay);
  assert.deepEqual(opened, [["hesaplar", "ekle"]]);
});

test("stale usage on the active card says so, and keeps its last rings faded", () => {
  const html = render(relayFor(active, [active], { active: { ...use("active", 1, 1), checkedAt: iso(NOW - 3_600_000) } }));
  assert.match(html, /Limit verisi eski · 1 sa önce okundu ·/);
  // The last known rings stay, on the stale ring's dashed track.
  assert.match(html, /data-slot="limit-rings"/);
  assert.match(html, /data-state="stale"/);
});

test("the active card keeps the last rings while the service cannot be reached, not after a sign-in problem", () => {
  const rings = (usage: AccountUsage) => /data-slot="limit-rings"[^>]*>(?:(?!<\/section)[\s\S])*data-state="stale"/.test(activeCard(usage));
  for (const issue of ["unavailable", "rate-limited"] as const) {
    const kept: AccountUsage = { ...use("active", 40, 20, NOW + 3_600_000), status: "error", stale: true, issue };
    const html = activeCard(kept);
    assert.ok(rings(kept), issue);
    assert.match(html, />%40</, issue);
    assert.match(html, /Limit verisi eski · 1 dk önce okundu ·/, issue);
    assert.match(html, /aria-label="Limitleri yenile"/, issue);
  }
  // A window that has reset since: nothing to keep.
  const reset: AccountUsage = { ...use("active", 40, 20, NOW - 60_000), status: "error", stale: true, issue: "unavailable" };
  assert.ok(!rings(reset));
  assert.match(activeCard(reset), /Limit verisi eski ·/);
  // A locked Keychain or a connection to renew keeps the cache, but the card asks for the fix instead.
  for (const issue of ["keychain-locked", "renewal-required"] as const) {
    const held: AccountUsage = { ...use("active", 40, 20, NOW + 3_600_000), status: "error", stale: true, issue };
    assert.ok(!rings(held), issue);
  }
  // In English.
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "en", setLanguage() {}, t: (_tr: string, en: string) => en } },
      createElement(
        RelayContext.Provider,
        { value: relayFor(active, [active], { active: { ...use("active", 40, 20, NOW + 3_600_000), stale: true } }) },
        createElement(PanelActiveCard, { now: NOW }),
      ),
    ),
  );
  assert.match(en, /Usage data is out of date · read 1 min ago ·/);
});

test("more than six other accounts collapse into an overflow line", () => {
  const others = Array.from({ length: 7 }, (_, i) => acct(`o${i}`, `Other ${i}`));
  const usage = Object.fromEntries([["active", use("active", 10, 10)], ...others.map((o) => [o.id, use(o.id, 10, 10)])]);
  const html = render(relayFor(active, [active, ...others], usage));
  assert.equal(panelRows(html).length, 6);
  assert.match(html, /\+1 hesap · Relay’de gör/);
});

test("Desktop busy withholds every switch and explains why", () => {
  // Two other accounts, the suggested one included.
  const alto = acct("alto", "Alto");
  const usage = { ...baseUsage, alto: use("alto", 20, 20) };
  const idle = panelRows(render(relayFor(active, [active, vertex, alto], usage, { suggestion: vertex })));
  assert.equal(idle.length, 2);
  for (const r of idle) assert.match(r, /aria-label="[^"]* hesabına geç · /);
  assert.equal(idle.filter((r) => r.includes(">Geç<")).length, 1);
  const rows = panelRows(render(relayFor(active, [active, vertex, alto], usage, { suggestion: vertex, desktopBusy: true })));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    // No row offers the switch: its name says why instead, and it is dimmed and drops its Geç.
    assert.match(r, /aria-label="[^"]* · Claude uygulamasında bir işlem sürüyor"/);
    assert.doesNotMatch(r, /hesabına geç/);
    assert.doesNotMatch(r, />Geç</);
    assert.match(r, /^<button[^>]*class="[^"]*opacity-60/);
  }
});

test("recovery required points to Relay", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { desktop: { ...desktopState("active"), recoveryRequired: true } }));
  assert.match(html, /Önce yedeği geri yükle/);
});

test("errors show inside the panel", () => {
  const html = render(relayFor(active, [active, vertex], baseUsage, { error: "Something failed." }));
  assert.match(html, /role="alert"/);
});

test("confirm state warns before switching", () => {
  const relay = relayFor(active, [active, vertex], baseUsage);
  const html = wrap(relay, createElement(PanelAccounts, { now: NOW, initialConfirm: "vertex" }));
  // The open row is pressed, and the confirmation strip under the list warns and offers Vazgeç / Geç.
  assert.match(panelRows(html)[0], /^<button type="button" aria-pressed="true" aria-label="Vertex hesabına geç/);
  const strip = html.slice(html.indexOf('data-slot="switch-confirm"'));
  assert.match(strip, /Claude uygulaması kapanır ve <b>Vertex<\/b> hesabıyla yeniden açılır/);
  assert.match(strip, /<button[^>]*>Vazgeç<\/button><button[^>]*>Geç<\/button>/);
});

test("a full account keeps a tinted switch, and its confirmation says when the limit opens", () => {
  const full = acct("full", "Dolu");
  const usage = { ...baseUsage, full: use("full", 100, 40, NOW + 90 * 60_000) };
  const [row] = panelRows(render(relayFor(active, [active, full], usage))).filter((r) => r.includes(">Dolu<"));
  // Not dimmed and not refused: the row switches, with an amber "Geç" where others have a chevron.
  assert.doesNotMatch(row, /^<button[^>]*class="[^"]*opacity-60/);
  assert.match(row, /aria-label="Dolu hesabına geç · [^"]* · Limit dolu · [^"]+ açılır \(1 sa 30 dk\)"/);
  assert.match(row, /<span class="[^"]*border-warn\/40 bg-warn\/10 text-warn-foreground[^"]*">Geç<\/span><\/button>$/);
  assert.match(row, /title="[^"]*Limit dolu · [^"]+ açılır \(1 sa 30 dk\)"/);
  // The confirmation strip says it first, and its Geç stays enabled.
  const html = wrap(relayFor(active, [active, full], usage), createElement(PanelAccounts, { now: NOW, initialConfirm: "full" }));
  const strip = html.slice(html.indexOf('data-slot="switch-confirm"'));
  assert.match(strip, /<b data-slot="switch-confirm-full" class="block">Limit dolu · [^<]+ açılır \(1 sa 30 dk\)<\/b>/);
  assert.match(strip, /<button[^>]*>Vazgeç<\/button><button(?![^>]*disabled="")[^>]*>Geç<\/button>/);
  // Busy Claude still refuses it, like any other row.
  const busy = panelRows(render(relayFor(active, [active, full], usage, { desktopBusy: true }))).find((r) => r.includes(">Dolu<"))!;
  assert.match(busy, /^<button[^>]*class="[^"]*opacity-60/);
  assert.doesNotMatch(busy, />Geç</);
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
  assert.match(html, /Claude uygulaması girişini tamamla/);
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

test("the early start row names the adopted start while the plan is adapted", () => {
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
  assert.match(pill(keeper(deferred)), />Plan uyarlandı · Vertex 13:30</);
  assert.doesNotMatch(pill(keeper(deferred)), /Sonraki başlatma/);
  // A faster pace alone, or no adaptation: the next start, named with its day
  // (the test's clock is the real one, so the day word varies).
  for (const planning of [keeper({ factor: 1.6, schedule: [] }), keeper()]) {
    const html = pill(planning);
    assert.match(html, />Kişisel · Max [^<]*13:00</);
    assert.doesNotMatch(html, /[Uu]yarlandı/);
  }
  // An entry whose time does not parse is skipped.
  assert.match(
    pill(keeper({ factor: 1, schedule: [{ accountId: "vertex", startAt: "later" }, ...deferred.schedule] })),
    />Plan uyarlandı · Vertex 13:30</,
  );
  assert.match(
    pill(keeper({ factor: 1, schedule: [{ accountId: "vertex", startAt: "later" }] })),
    />Kişisel · Max [^<]*13:00</,
  );
  // Switched on with nothing planned: the early start row says on, not automatic start.
  const earlyStart = /<span class="shrink-0">Önceden başlatma<\/span><span[^>]*>([^<]*)<\/span>/;
  assert.equal(
    earlyStart.exec(
      pill(
        { ...keeper(), next: undefined },
        { ...settings, planning: { ...settings.planning, accounts: [] } },
      ),
    )?.[1],
    "Açık",
  );
  assert.equal(
    earlyStart.exec(
      pill(keeper(), {
        ...settings,
        planning: { ...settings.planning, autoStart: false },
      }),
    )?.[1],
    "Kapalı",
  );
  // Adaptation turned off applies at once.
  assert.doesNotMatch(
    pill(keeper(deferred), { ...settings, planning: { ...settings.planning, adaptive: false } }),
    /[Uu]yarlandı/,
  );
});

test("the panel header shows the panda head for the menu bar pose", () => {
  const active = acct("active", "Kişisel");
  const scene = (usage: Record<string, AccountUsage>, extra: Partial<Relay> = {}) =>
    /<header[\s\S]*?data-scene="([^"]+)"/.exec(render(relayFor(active, [active], usage, extra)))?.[1];
  assert.equal(scene({ active: use("active", 20, 10) }), "head-idle");
  assert.equal(scene({ active: use("active", 95, 10) }), "head-hungry");
  // A full window keeps the wide eyes; the head sleeps while Claude is closed.
  assert.equal(scene({ active: use("active", 100, 10) }), "head-hungry");
  assert.equal(
    scene({ active: use("active", 20, 10) }, { desktop: { ...desktopState("active"), running: false } }),
    "head-sleep",
  );
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
/** Draft re-typing turned on in Settings; it is off unless the user turns it on. */
const retyping: Partial<Relay> = { settings: { ...DEFAULT_SETTINGS, draftRetype: true } };

test("the rescued drafts section lists needs-copy records with reason, Copy and Dismiss, and waiting ones with Copy", () => {
  const html = drafts(withDrafts([
    draft({ title: "Fix the login bug", reason: "lost" }),
    draft({ id: "d2", title: "Waiting for its turn", state: "pending", reason: undefined }),
  ]));
  assert.match(html, /Kurtarılan taslaklar/);
  assert.match(html, /Fix the login bug/);
  assert.match(html, /Claude uygulaması taslağı sildi/);
  assert.match(html, />Kopyala</);
  assert.match(html, />Kapat</);
  assert.equal((html.match(/>Kopyala</g) ?? []).length, 2);
  assert.equal((html.match(/>Kapat</g) ?? []).length, 1);
  assert.match(html, /Waiting for its turn/);
  assert.doesNotMatch(html, /İzin ver/);
});

test("with re-typing on, an accessibility reason offers the permission button", () => {
  const html = drafts(withDrafts([draft({ reason: "accessibility" })], retyping));
  assert.match(html, /Erişilebilirlik izni yok/);
  assert.match(html, />İzin ver</);
  assert.match(html, />Kopyala</);
});

test("with re-typing off, no draft asks for accessibility: Copy and Dismiss only", () => {
  for (const settings of [DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, draftRetype: false }]) {
    const html = drafts(withDrafts([
      draft({ reason: "accessibility" }),
      draft({ id: "d2", title: "Left by hand", reason: "manual" }),
    ], { settings }));
    assert.doesNotMatch(html, /İzin ver/);
    assert.equal((html.match(/>Kopyala</g) ?? []).length, 2);
    assert.equal((html.match(/>Kapat</g) ?? []).length, 2);
    assert.match(html, /Elle yapıştır</);
  }
});

test("the rescued drafts heading is tagged experimental only while re-typing is on", () => {
  const eyebrow = (html: string) => html.split(`<div class="${panelEyebrow}">`)[1]?.split("</div>")[0] ?? "";
  const on = eyebrow(drafts(withDrafts([draft()], retyping)));
  assert.match(on, /Kurtarılan taslaklar/);
  assert.match(on, />deneysel</);
  const off = eyebrow(drafts(withDrafts([draft()])));
  assert.match(off, /Kurtarılan taslaklar/);
  assert.doesNotMatch(off, /deneysel/);
  // In English too.
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "en", setLanguage() {}, t: (_: string, en: string) => en } },
      createElement(RelayContext.Provider, { value: withDrafts([draft()], retyping) }, createElement(PanelDrafts)),
    ),
  );
  assert.match(en, /Rescued drafts/);
  assert.match(en, />experimental</);
});

test("waiting records show the count line and a row each with Copy, never Dismiss", () => {
  const html = drafts(withDrafts([
    draft({ id: "a", title: "First", state: "pending", reason: undefined }),
    draft({ id: "b", to: "other", title: "Second", state: "pending", reason: undefined }),
  ]));
  assert.match(html, /Kurtarılan taslaklar/);
  assert.match(html, /2 taslak geri yazılmayı bekliyor/);
  assert.match(html, /First/);
  assert.match(html, /Second/);
  assert.equal((html.match(/>Bekliyor: konuşmayı açınca geri yazılır</g) ?? []).length, 2);
  assert.equal((html.match(/>Kopyala</g) ?? []).length, 2);
  assert.doesNotMatch(html, />Kapat<|Geçişte geri yazılamayan/);
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
  const reason = classOf("Konuşmaya yazılmış olabilir, yapıştırmadan önce bak");
  assert.ok(name !== undefined && reason !== undefined);
  assert.ok(name.split(" ").includes("truncate"));
  assert.ok(!reason.split(" ").includes("truncate"));
});

test("the attachment note shows only when attachments could not be restored", () => {
  assert.match(drafts(withDrafts([draft({ attachments: true })])), /Ekler geri yüklenmedi/);
  assert.doesNotMatch(drafts(withDrafts([draft({ attachments: false })])), /Ekler geri yüklenmedi/);
});

test("draftReason words every reason in both languages, with a fallback", () => {
  const tr = (a: string) => a;
  const en = (_a: string, b: string) => b;
  const maybeTyped: [string, string] = [
    "Konuşmaya yazılmış olabilir, yapıştırmadan önce bak",
    "Possibly in the conversation already; check before you paste",
  ];
  const unsupported: [string, string] = [
    "Claude uygulamasının arayüzü desteklenmiyor",
    "The Claude app’s interface is not supported",
  ];
  const busy: [string, string] = ["Konuşma meşguldü", "The conversation was busy"];
  const labels: Record<string, [string, string]> = {
    accessibility: ["Erişilebilirlik izni yok", "Accessibility permission missing"],
    "composer-not-empty": ["Mesaj kutusunda zaten yazı vardı", "The message box already had text"],
    "context-changed": ["Ekran değişti", "The screen changed"],
    lost: ["Claude uygulaması taslağı sildi", "The Claude app cleared the draft"],
    busy,
    manual: ["Elle yapıştır", "Paste it yourself"],
    error: ["Geri yazılamadı", "Restore failed"],
    // A draft that may already be in its composer says so, whichever way that came about.
    "maybe-typed": maybeTyped,
    unconfirmed: maybeTyped,
    "delivery-ambiguous": maybeTyped,
    "no-composer": ["Mesaj kutusu yüklenmedi", "The message box did not load"],
    loading: ["Claude uygulaması henüz yüklenmemişti", "The Claude app was not loaded yet"],
    unsupported,
    // The helper's own issue names read as the restorer's.
    "desktop-ui-unsupported": unsupported,
    "desktop-work-active": busy,
    "exact-session-not-observed": ["Konuşma açılamadı", "The conversation did not open"],
    "not-ready": ["Claude uygulaması hazır değildi", "The Claude app was not ready"],
    moved: ["Başka bir ekrana geçtin", "You went to another screen"],
    changed: ["Ekran değişti", "The screen changed"],
    "claude-not-running": ["Claude uygulaması çalışmıyordu", "The Claude app was not running"],
    budget: ["Süre doldu", "Time ran out"],
    // Fast restore's watch window ran out before the user opened the conversation.
    "not-opened": [
      "Konuşmayı 30 dakika içinde açmadın",
      "You did not open the conversation in 30 minutes",
    ],
  };
  for (const [reason, [turkish, english]] of Object.entries(labels)) {
    assert.equal(draftReason(reason, tr), turkish, reason);
    assert.equal(draftReason(reason, en), english, reason);
  }
  for (const reason of [undefined, "", "something-new"]) {
    assert.equal(draftReason(reason, tr), "Geri yazılamadı");
    assert.equal(draftReason(reason, en), "Restore failed");
  }
  // A new-session draft's reasons name its screen where a conversation's would mislead.
  const maybeOnScreen: [string, string] = [
    "Yeni oturum ekranına yazılmış olabilir, yapıştırmadan önce bak",
    "Possibly on the new-session screen already; check before you paste",
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
      "The new-session screen did not open",
    ],
    "not-opened": [
      "Yeni oturum ekranını 30 dakika içinde açmadın",
      "You did not open the new-session screen in 30 minutes",
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
  assert.match(html, /Yeni oturum ekranına yazılmış olabilir, yapıştırmadan önce bak/);
  assert.match(html, /Konuşmaya yazılmış olabilir, yapıştırmadan önce bak/);
});

test("the panel places rescued drafts after the active card and before the accounts", () => {
  // With a suggestion the accounts heading carries the limit warning; the drafts still come first.
  const html = render(withDrafts([draft()], { suggestion: vertex }));
  const at = (re: RegExp) => html.search(re);
  assert.ok(at(/>Claude açık</) >= 0);
  assert.ok(at(/>Claude açık</) < at(/Kurtarılan taslaklar/));
  assert.ok(at(/Kurtarılan taslaklar/) < at(/>Limit dolmak üzere</));
});

test("a draft row's buttons are disabled while that row's action runs", () => {
  const both = [draft({ id: "d1", reason: "accessibility" }), draft({ id: "d2", title: "Other draft" })];
  const disabledCount = (busy: string) => {
    const html = drafts(withDrafts(both, { ...retyping, busy }));
    return (html.match(/disabled=""/g) ?? []).length;
  };
  assert.equal(disabledCount(""), 0);
  // With re-typing on, d1 shows Allow, Copy and Dismiss; d2 shows Copy and Dismiss.
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

const gap = (over: Partial<SidebarGapSummary> = {}): SidebarGapSummary => ({
  id: "g1", to: "Alto", from: ["Vertex"], missingSections: 9, sessions: 157, ...over,
});
const withSidebar = (sidebar: SidebarGapSummary | undefined, extra: Partial<Relay> = {}): Relay => {
  const relay = relayFor(active, [active, vertex], baseUsage, extra);
  relay.data = { ...relay.data, ...(sidebar ? { sidebar } : {}) } as Snapshot;
  return relay;
};
const sidebar = (relay: Relay) => wrap(relay, createElement(PanelSidebar));

test("the sidebar row says what the account lacks and where it comes from, with Copy recipe and Dismiss", () => {
  const html = sidebar(withSidebar(gap()));
  assert.match(html, /Kenar çubuğu düzeni/);
  assert.match(html, /Alto hesabında 9 bölüm eksik, 157 oturum bir bölümde değil/);
  assert.match(html, /Kaynak: Vertex\. Claude bölümleri bir Code oturumunda talimatla kurar\./);
  assert.match(html, />Talimatı kopyala</);
  assert.match(html, />Kapat</);
  // No session id ever reaches the panel.
  assert.doesNotMatch(html, /local_/);
  assert.equal(sidebar(withSidebar(undefined)), "");
});

test("a sidebar offer that only restores the account's own filing names no source", () => {
  const html = sidebar(withSidebar(gap({ from: [] })));
  assert.doesNotMatch(html, /Kaynak:/);
  assert.match(html, /Claude bölümleri bir Code oturumunda talimatla kurar\./);
});

test("the sidebar line names only what is missing, in both languages", () => {
  const tr = (a: string) => a;
  const en = (_: string, b: string) => b;
  assert.equal(sidebarGapLine(gap({ sessions: 0 }), tr), "Alto hesabında 9 bölüm eksik");
  assert.equal(sidebarGapLine(gap({ missingSections: 0, sessions: 3 }), tr), "Alto hesabında 3 oturum bir bölümde değil");
  assert.equal(sidebarGapLine(gap(), en), "On Alto: 9 sections missing, 157 sessions unfiled");
  assert.equal(sidebarGapLine(gap({ missingSections: 1, sessions: 1 }), en), "On Alto: 1 section missing, 1 session unfiled");
});

test("the panel places the sidebar row after rescued drafts and before the accounts", () => {
  const relay = withDrafts([draft()]);
  relay.data = { ...relay.data, sidebar: gap() } as Snapshot;
  const html = render(relay);
  const at = (re: RegExp) => html.search(re);
  assert.ok(at(/Kurtarılan taslaklar/) >= 0);
  assert.ok(at(/Kurtarılan taslaklar/) < at(/Kenar çubuğu düzeni/));
  assert.ok(at(/Kenar çubuğu düzeni/) < at(/>Diğer hesaplar</));
});

test("the sidebar row's buttons are disabled while its action runs", () => {
  const disabled = (busy: string) =>
    (sidebar(withSidebar(gap(), { busy })).match(/disabled=""/g) ?? []).length;
  assert.equal(disabled(""), 0);
  assert.equal(disabled("sidebar-copy:g1"), 2);
  assert.equal(disabled("sidebar-dismiss:g1"), 2);
  assert.equal(disabled("draft-copy:d1"), 0);
});

test("Copy recipe and Dismiss go through relay.action by offer id, and only a copy that worked says so", async () => {
  const calls: string[] = [];
  const keys: string[] = [];
  let copied = 0;
  let fail = false;
  const relay = relayFor(active, [active, vertex], baseUsage, {
    action: async (key: string, fn: () => Promise<unknown>) => {
      keys.push(key);
      await fn().catch(() => {});
    },
    api: {
      copySidebarRecipe: async (id: string) => {
        if (fail) throw new Error("gone");
        calls.push(`copy:${id}`);
      },
      dismissSidebarGap: async (id: string) => void calls.push(`dismiss:${id}`),
    } as unknown as Relay["api"],
  });
  await copySidebarRecipeAction(relay, "g1", () => copied++);
  fail = true;
  await copySidebarRecipeAction(relay, "g1", () => copied++);
  await dismissSidebarGapAction(relay, "g1");
  assert.deepEqual(keys, ["sidebar-copy:g1", "sidebar-copy:g1", "sidebar-dismiss:g1"]);
  assert.deepEqual(calls, ["copy:g1", "dismiss:g1"]);
  assert.equal(copied, 1);
});

const offer = (over: Partial<ExtensionOffer> = {}): ExtensionOffer => ({
  accountId: "u", to: "Vertex", on: "Alto", browser: "Brave", ...over,
});
const withOffer = (extension: ExtensionOffer | undefined, extra: Partial<Relay> = {}): Relay => {
  const relay = relayFor(active, [active, vertex], baseUsage, extra);
  relay.data = { ...relay.data, ...(extension ? { extension } : {}) } as Snapshot;
  return relay;
};
const extensionRow = (relay: Relay) => wrap(relay, createElement(PanelExtension));

test("the extension row says where the extension was left and offers Switch; without an offer it is empty", () => {
  const html = extensionRow(withOffer(offer()));
  assert.match(html, /Tarayıcı eklentisi/);
  assert.match(html, /Eklenti Alto hesabında kaldı/);
  assert.match(html, /Vertex hesabının eklenti girişi kayıtlı\./);
  assert.match(html, />Geçir</);
  // Nothing happens before the user confirms.
  assert.doesNotMatch(html, /Evet, geçir/);
  assert.equal(extensionRow(withOffer(undefined)), "");
  // On the account already, but its sign-in expired: the row offers a fix instead.
  const expired = extensionRow(withOffer(offer({ on: undefined, expired: true })));
  assert.match(expired, /Eklenti girişinin süresi doldu/);
  assert.match(expired, /Claude’un tarayıcı araçları çalışmıyor\./);
  assert.match(expired, />Düzelt</);
  // Nothing saved to put in place: Reconnect opens the steps in Settings, with no confirmation.
  const reconnect = extensionRow(withOffer(offer({ on: undefined, expired: true, reconnect: true })));
  assert.match(reconnect, /Eklenti Vertex hesabına giriş yapamıyor/);
  assert.match(reconnect, />Yeniden bağla</);
  assert.doesNotMatch(reconnect, />Düzelt</);
  assert.match(extensionRow(withOffer(offer(), { busy: "draft-copy:d1" })), /disabled=""/);
});

test("the extension line names a signed-out extension, or an account Relay cannot name", () => {
  const tr = (a: string) => a;
  const en = (_: string, b: string) => b;
  assert.equal(extensionOfferLine(offer({ on: undefined, signedOut: true }), tr), "Eklentide giriş yok");
  assert.equal(extensionOfferLine(offer({ on: undefined }), tr), "Eklenti Vertex hesabına geçmedi");
  assert.equal(extensionOfferLine(offer(), en), "The extension is still on Alto");
  assert.equal(extensionOfferLine(offer({ on: undefined, expired: true }), tr), "Eklenti girişinin süresi doldu");
});

test("the panel places the extension row after rescued drafts and before the sidebar row", () => {
  const relay = withDrafts([draft()]);
  relay.data = { ...relay.data, sidebar: gap(), extension: offer() } as Snapshot;
  const html = render(relay);
  const at = (re: RegExp) => html.search(re);
  assert.ok(at(/Kurtarılan taslaklar/) < at(/Tarayıcı eklentisi/));
  assert.ok(at(/Tarayıcı eklentisi/) < at(/Kenar çubuğu düzeni/));
});

test("Switch runs the extension sync through relay.action and says nothing more when it switched", async () => {
  const keys: string[] = [];
  const said: (string | undefined)[] = [];
  const tr = (a: string) => a;
  const relay = (result: "switched" | "skipped") =>
    withOffer(offer(), {
      api: {
        syncExtension: async () => ({ result, reason: result === "skipped" ? "browser-did-not-quit" : undefined, at: iso(NOW), restarted: true, reopened: true, saved: true }),
      } as unknown as Relay["api"],
      action: async (key: string, fn: () => Promise<unknown>) => {
        keys.push(key);
        await fn();
      },
    });
  await syncExtensionAction(relay("switched"), tr, (line) => said.push(line));
  await syncExtensionAction(relay("skipped"), tr, (line) => said.push(line));
  assert.deepEqual(keys, ["extension-sync", "extension-sync"]);
  assert.deepEqual(said, [undefined, "Tarayıcı kapanmadı; eklentiye dokunulmadı."]);
});
