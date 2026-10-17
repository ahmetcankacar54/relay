import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Overview } from "../src/pages/Overview";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_PLANNING, DEFAULT_SETTINGS, type Account, type AccountUsage, type AuthFlow, type Snapshot, type UsageIssue } from "../shared/types";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const acct = (id: string, name: string, plan: "pro" | "max5", desktop = true): Account => ({
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
  assert.match(html, /CLAUDE DESKTOP’TA AÇIK/);
  assert.match(html, /Kişisel · Max/);
  assert.match(html, /Max 5×/);
  assert.match(html, /Çalışıyor/);
  assert.match(html, /5 saatlik dönem/);
  assert.match(html, /Haftalık · tüm modeller/);
  assert.match(html, /Haftalık · Opus/);
  assert.match(html, /Önerilen/);
  // The suggestion band keeps its text; the suggested row's own "Geçiş yap" is the one switch offer.
  assert.match(html, /Kişisel · Max limiti uyarı eşiğini geçti\. Önerilen: <b>Vertex<\/b>/);
  assert.doesNotMatch(html, /Geçişi incele/);
  assert.equal(html.match(/Geçiş yap/g)?.length, 1);
  assert.match(html, /Bugün/);
  assert.match(html, /Önceden başlatma kapalı/);
  assert.doesNotMatch(html, /Otomatik başlatma/);
  assert.match(html, /<label[^>]*for="automation-mode"[^>]*>Otomatik geçiş<\/label>/);
  assert.match(html, /Kapalı\. Kota dolunca hesabı sen değiştirirsin\./);
  assert.match(html, /Limit dönemlerini önceden başlat/);
  assert.doesNotMatch(html, /Claude kapanınca hazırla/);
  assert.match(html, /Limitleri yenile/);
});

test("overview without an active account offers onboarding", () => {
  const emptyHtml = render(relayFor(undefined, [], {}));
  assert.match(emptyHtml, /Merhaba, ben Relay’in kuryesiyim/);
  assert.match(emptyHtml, /İlk hesabını bağlayalım/);
  assert.match(/<svg[^>]*data-scene="welcome"[^>]*>/.exec(emptyHtml)?.[0] ?? "", /width="120"/);
  assert.match(emptyHtml, /Hesap ekle/);
  assert.match(emptyHtml, /Başka hesap yok/);
  assert.doesNotMatch(emptyHtml, /CLAUDE DESKTOP’TA AÇIK/);
});

test("unlinked accounts offer a Desktop link instead of a switch", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Studio", "pro", false);
  const html = render(relayFor(active, [active, other], { active: use("active", 10, 10) }));
  assert.match(html, /Claude uygulaması girişi yok/);
  // The accessible name is the visible label; the full name rides on title only.
  const saveButton = /<button[^>]*>Girişi kaydet<\/button>/.exec(html)?.[0] ?? "";
  assert.match(saveButton, /title="Claude uygulaması girişini kaydet"/);
  assert.doesNotMatch(saveButton, /aria-label=/);
});

const rowsOf = (html: string) => html.split("grid-cols-[1.2fr_1fr_1fr_auto]").slice(1);
const rowFor = (html: string, name: string) => rowsOf(html).find((r) => r.includes(`>${name}<`)) ?? "";
const switchButtons = (html: string) =>
  (html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Geçiş yap<\/button>/g) ?? []);

test("the automation choice is locked while a handoff is switching or continuing", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const select = (html: string) => html.match(/<button[^>]*id="automation-mode"[^>]*>/)?.[0] ?? "";
  for (const status of ["switching", "continuing"] as const) {
    const relay = relayFor(active, [active], { active: use("active", 10, 10) });
    (relay.data as Snapshot).fleet = { enabled: true, status, sourceId: "active", targetId: "active" };
    assert.match(select(render(relay)), /disabled=""/, status);
  }
  const relay = relayFor(active, [active], { active: use("active", 10, 10) });
  (relay.data as Snapshot).fleet = { enabled: true, status: "watching" };
  const html = render(relay);
  assert.ok(select(html), "the automation-mode select renders");
  assert.doesNotMatch(select(html), /disabled=""/);
  assert.match(html, /Kota dolunca/);
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

test("overview rows show the account's status where something is wrong, and stale healthy rows keep theirs", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Vertex", "pro");
  const failed = (issue: UsageIssue): AccountUsage => ({ accountId: "other", status: "error", stale: true, issue });
  const stale = { ...use("other", 1, 1), checkedAt: iso(NOW - 3_600_000) };
  const subtitle = (account: Account, usage: AccountUsage, extra: Partial<Relay> = {}) =>
    /<div class="truncate text-xs text-muted-foreground">([^<]*)<\/div>/.exec(
      rowFor(render(relayFor(active, [active, account], { active: use("active", 10, 10), other: usage }, extra)), "Vertex"),
    )?.[1];
  assert.equal(subtitle(other, failed("expired")), "Pro · Limit okuma girişi gerekli");
  assert.equal(subtitle(other, failed("keychain-locked")), "Pro · Anahtarlık izni gerekli");
  assert.equal(subtitle(other, failed("renewal-required")), "Pro · Bağlantı yenilenmeli");
  assert.equal(subtitle(other, { ...use("other", 1, 1), connectionRenewalRequired: true }), "Pro · Bağlantı yenilenmeli");
  assert.equal(subtitle({ ...other, auth: undefined }, stale), "Pro · Limit okuma girişi yok");
  // A browser approval in progress for that account.
  const flows = { authFlows: [{ id: "f", accountId: "other", status: "waiting" }] as unknown as AuthFlow[] };
  const waiting = relayFor(active, [active, other], { active: use("active", 10, 10), other: stale });
  Object.assign(waiting.data as Snapshot, flows);
  assert.match(rowFor(render(waiting), "Vertex"), /Tarayıcı onayı bekleniyor/);
  // Stale but healthy: the old text.
  assert.equal(subtitle(other, stale), "Pro · Limit verisi eski");
  assert.equal(subtitle(other, use("other", 1, 1)), "Pro · Hazır · dönem başlamadı");
});

test("onboarding with saved accounts but none open looks out instead of greeting", () => {
  const other = acct("other", "Studio", "pro");
  const html = render(relayFor(undefined, [other], {}, { hasUnclaimedDesktop: true }));
  assert.match(/<svg[^>]*data-scene="lookout"[^>]*>/.exec(html)?.[0] ?? "", /width="72"/);
  assert.doesNotMatch(html, /data-scene="welcome"|Merhaba, ben Relay’in kuryesiyim/);
  assert.match(html, /Desktop hesabı eşleştirilmedi/);
});

test("today's card shows a lookout panda when automatic start has no planned account", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const usage = { active: use("active", 10, 10) };
  const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_PLANNING, autoStart: true, accounts: [] } };
  const html = render(relayFor(active, [active], usage, { settings }));
  assert.match(html, /Plana hesap eklenmedi/);
  assert.match(/<svg[^>]*data-scene="lookout"[^>]*>/.exec(html)?.[0] ?? "", /width="40"/);
  assert.doesNotMatch(render(relayFor(active, [active], usage)), /data-scene="lookout"/);
});

test("today's card calls automatic start early start in both languages", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const vertex = acct("vertex", "Vertex", "pro");
  const usage = {
    active: use("active", 10, 10),
    vertex: use("vertex", 10, 10),
  };
  const settings = {
    ...DEFAULT_SETTINGS,
    planning: {
      ...DEFAULT_PLANNING,
      autoStart: true,
      accounts: [{ id: "active" }, { id: "vertex" }],
    },
  };
  const planning = {
    enabled: true,
    running: false,
    accounts: [],
    attempts: [],
    plannedToday: 2,
    next: { accountId: "vertex", at: iso(NOW + 3_600_000) },
  };
  const relay = relayFor(active, [active, vertex], usage, {
    settings,
    data: {
      settings,
      usage,
      accounts: [active, vertex],
      authFlows: [],
      planning,
    } as unknown as Snapshot,
  });
  const html = render(relay);
  assert.match(html, /Önceden başlatma açık · sonraki \d\d:\d\d Vertex/);
  assert.doesNotMatch(html, /Otomatik başlatma/);
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      {
        value: {
          language: "en",
          setLanguage() {},
          t: (_tr: string, en: string) => en,
        },
      },
      createElement(
        RelayContext.Provider,
        { value: relay },
        createElement(Overview, { go: () => {}, now: NOW }),
      ),
    ),
  );
  assert.match(en, /Early start on · next/);
  assert.doesNotMatch(en, /Automatic start/);
  const off = render(
    relayFor(active, [active], { active: use("active", 10, 10) }),
  );
  assert.match(off, /Önceden başlatma kapalı/);
});

test("the onboarding and the today lookout pandas are playful, the welcome and the lookouts alike", () => {
  const playful = (scene: string, size: number) =>
    new RegExp(`<span data-playful="true" class="inline-block shrink-0 overflow-hidden" style="width:${size}px;height:${size}px"><svg[^>]*data-scene="${scene}"`);
  // The welcome (no account yet) is 120 px and the pairing lookout 72 px.
  assert.match(render(relayFor(undefined, [], {})), playful("welcome", 120));
  assert.match(render(relayFor(undefined, [acct("other", "Studio", "pro")], {}, { hasUnclaimedDesktop: true })), playful("lookout", 72));
  // Today's lookout is 40 px.
  const active = acct("active", "Kişisel · Max", "max5");
  const usage = { active: use("active", 10, 10) };
  const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_PLANNING, autoStart: true, accounts: [] } };
  assert.match(render(relayFor(active, [active], usage, { settings })), playful("lookout", 40));
  // An overview with an account open and a plan has no panda to click.
  assert.doesNotMatch(render(relayFor(active, [active], usage)), /data-playful/);
});

test("the automation card's status lines are set in text-xs, not 11 px", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const html = render(relayFor(active, [active], { active: use("active", 10, 10) }));
  const card = html.slice(html.indexOf("Limit dönemlerini önceden başlat"));
  assert.match(card, /<div class="truncate text-xs text-muted-foreground">Kapalı<\/div>/);
  assert.doesNotMatch(card, /text-\[11px\]/);
});
