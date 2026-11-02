import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Overview } from "../src/pages/Overview";
import { AutomationCard } from "../src/pages/overview/AutomationCard";
import { AccountsCard } from "../src/pages/overview/AccountsCard";
import { DesktopActionBody } from "../src/app/DesktopActionDialog";
import type { PageId } from "../src/app/routes";
import { fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_PLANNING, DEFAULT_SETTINGS, type Account, type AccountUsage, type AuthFlow, type DesktopState, type Diagnostics, type Snapshot, type UsageIssue } from "../shared/types";

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
  assert.match(html, /Claude uygulamasında açık/);
  assert.match(html, /Kişisel · Max/);
  assert.match(html, /Max 5×/);
  assert.match(html, /Çalışıyor/);
  // The hero is the large ring with the account beside it.
  assert.match(html, /<div role="img" aria-label="5 saatlik dönem %38 · Haftalık · tüm modeller %78"[^>]*style="width:140px;height:140px"/);
  assert.match(html, /Haftalık · tüm modeller/);
  assert.match(html, /Haftalık · Opus/);
  // No suggestion band: the hero says the limit is near and offers the suggested account, and the
  // accounts card's heading says so too, with the suggestion leading.
  assert.doesNotMatch(html, /uyarı eşiğini geçti|Önerilen:/);
  const hint = suggestionBlock(html);
  assert.match(hint, />Limit dolmak üzere</);
  assert.match(hint, /En uygun hesap <b>Vertex<\/b>: %12 kullanıldı\./);
  assert.match(hint, /<button[^>]*>Vertex hesabına geç<\/button>/);
  assert.match(html, />Önerilen üstte</);
  assert.doesNotMatch(html, /en uygunu üstte</);
  // The suggested row carries a small "önerilen" by its name, and the row links to the account's page.
  const row = rowFor(html, "Vertex");
  assert.match(row, /<a href="#\/hesaplar\/vertex"/);
  assert.match(row, />Vertex<\/span><span[^>]*>önerilen<\/span>/);
  // Its figures are the row's own ring and percents, used percent per window.
  assert.match(row, /role="img" aria-label="Vertex · 5 saat %12 kullanıldı · hafta %31 kullanıldı"/);
  assert.match(row, /<b[^>]*>%12<\/b><span[^>]*> \/ %31<\/span>/);
  assert.doesNotMatch(html, /Geçişi incele/);
  // The suggested row's "Geç" is the filled one.
  assert.match(row, /<button[^>]*aria-label="Vertex hesabına geç"[^>]*class="[^"]*bg-primary[^"]*"[^>]*>Geç<\/button>/);
  // The list ends in "Hesap ekle" with the rings' key under it.
  assert.match(listOf(html), /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Hesap ekle(?:(?!<\/button>)[\s\S])*?<\/button>/);
  assert.match(html, /kalın: 5 saatlik dönem/);
  assert.match(html, /ince: hafta/);
  assert.match(html, /Bugün/);
  assert.match(html, /(?:Çalışma 09:00–18:00|Bugün çalışma yok) · önceden başlatma kapalı/);
  assert.doesNotMatch(html, /Otomatik başlatma/);
  // Automation is a group of rows, each saying how a setting stands.
  const automation = automationRows(html);
  assert.equal(automation.length, 2);
  assert.match(automation[0], />Otomatik geçiş</);
  assert.match(automation[0], /Kapalı\. Limit dolunca başka hesaba sen geçersin\./);
  assert.match(automation[1], />Önceden başlatma</);
  assert.match(automation[1], />Kapalı</);
  assert.doesNotMatch(html, /Claude uygulaması kapanınca hazırla/);
  // Refresh and bring-to-front live in the page header.
  assert.match(html, /<button[^>]*aria-label="Limitleri yenile"/);
  assert.match(html, /<button[^>]*>Claude uygulamasını aç<\/button>/);
});

test("overview without an active account offers onboarding", () => {
  const emptyHtml = render(relayFor(undefined, [], {}));
  assert.match(emptyHtml, /Merhaba, ben Relay’in kuryesiyim/);
  assert.match(emptyHtml, /Her hesabı bir kez bağla, sonra buradan geç\./);
  assert.match(/<svg[^>]*data-scene="welcome"[^>]*>/.exec(emptyHtml)?.[0] ?? "", /width="120"/);
  assert.match(emptyHtml, /Hesap ekle/);
  assert.doesNotMatch(emptyHtml, /Henüz hesap yok/);
  assert.doesNotMatch(emptyHtml, /Başka hesap yok/);
  assert.doesNotMatch(emptyHtml, /CLAUDE UYGULAMASINDA AÇIK/);
});

test("unlinked accounts lead to their page instead of offering a switch", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Studio", "pro", false);
  const html = render(relayFor(active, [active, other], { active: use("active", 10, 10) }));
  const row = rowFor(html, "Studio");
  // The row says the sign-in is not saved; the full reason rides on its title.
  assert.match(row, />Pro · giriş kaydedilmedi</);
  assert.match(row, /<a href="#\/hesaplar\/other" title="Claude uygulaması girişi yok"/);
  // No switch: the row ends in a chevron and opens the account, whose page saves the sign-in.
  assert.doesNotMatch(row, />Geç</);
  assert.doesNotMatch(html, />önerilen</);
});

/** The other-accounts list, up to the rings' key under it. */
const listOf = (html: string) => {
  const start = html.indexOf('data-slot="account-list"');
  return start < 0 ? "" : html.slice(start, html.indexOf("kalın: 5 saatlik dönem", start));
};
const rowsOf = (html: string) => listOf(html).split('data-slot="account-row"').slice(1);
const rowFor = (html: string, name: string) => rowsOf(html).find((r) => r.includes(`>${name}<`)) ?? "";
/** The hero's "limit is near" block. */
const suggestionBlock = (html: string) => {
  const start = html.indexOf('data-slot="suggestion"');
  return start < 0 ? "" : html.slice(start, html.indexOf("</button>", start) + "</button>".length);
};
/** The Overview automation group's rows. */
const automationRows = (html: string) => {
  const start = html.indexOf(">Otomasyon</h2>");
  if (start < 0) return [];
  return html.slice(start, html.indexOf("</section>", start)).match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
};
/** The small "önerilen" next to the suggested account's name. */
const suggested = />önerilen</;
const switchButtons = (html: string) =>
  (listOf(html).match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Geç<\/button>/g) ?? []);

test("the Overview automation rows open their pages instead of setting the choice inline", async () => {
  const active = acct("active", "Kişisel · Max", "max5");
  // The automation card needs two connected accounts.
  const accounts = [active, acct("other", "Vertex", "pro")];
  // The choice and its lock while a handoff runs live in Settings → Automation; Overview only shows rows.
  for (const status of ["switching", "continuing", "watching"] as const) {
    const relay = relayFor(active, accounts, { active: use("active", 10, 10) });
    (relay.data as Snapshot).fleet = { enabled: true, status, sourceId: "active", targetId: "active" };
    const html = render(relay);
    assert.doesNotMatch(html, /id="automation-mode"|role="switch"/, status);
    const rows = automationRows(html);
    assert.equal(rows.length, 2, status);
    for (const row of rows) assert.doesNotMatch(row, /disabled=""/, status);
  }
  // Each row opens its page.
  const opened: PageId[] = [];
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
          createElement(
            RelayContext.Provider,
            {
              // Outside macOS the extension row is not drawn.
              value: relayFor(active, accounts, { active: use("active", 10, 10) }, {
                api: { extensionStatus: async () => null } as unknown as Relay["api"],
              }),
            },
            createElement(AutomationCard, { go: (page: string) => void opened.push(page as PageId), now: NOW }),
          ),
        ),
      ),
    );
    const container = dom.container as unknown as Fake;
    for (const name of ["Otomatik geçiş", "Önceden başlatma"]) {
      const row = find(container, (n) => n.tagName === "button" && textOf(n).startsWith(name));
      assert.ok(row, name);
      await act(async () => dom.dispatch(row, "click", { detail: 1 }));
    }
    assert.deepEqual(opened, ["gecis", "planlama"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the suggested account is marked even when ranking prefers another", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const x = acct("x", "Xeno", "max5");
  const y = acct("y", "Yarn", "pro");
  const usage = { active: use("active", 90, 90), x: use("x", 5, 5), y: use("y", 30, 40) };
  const base = render(relayFor(active, [active, x, y], usage));
  const ranked = suggested.test(rowFor(base, "Xeno")) ? "Xeno" : "Yarn";
  const other = ranked === "Xeno" ? y : x;
  const html = render(relayFor(active, [active, x, y], usage, { suggestion: other }));
  assert.match(rowFor(html, other.name), suggested);
  assert.doesNotMatch(rowFor(html, ranked), suggested);
});

test("switch actions are withheld or disabled while Desktop is busy, pending or needs recovery", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Vertex", "pro");
  const accounts = [active, other];
  const usage = { active: use("active", 10, 10), other: use("other", 10, 10) };
  const idle = switchButtons(render(relayFor(active, accounts, usage)));
  assert.equal(idle.length, 1);
  assert.doesNotMatch(idle[0], /disabled=""/);
  /** The hero's switch to the suggested account. */
  const hero = (html: string) => /<button[^>]*>Vertex hesabına geç<\/button>/.exec(suggestionBlock(html))?.[0] ?? "";
  const offered = hero(render(relayFor(active, accounts, usage, { suggestion: other })));
  assert.ok(offered);
  assert.doesNotMatch(offered, /disabled=""/);
  const cases: Partial<Relay>[] = [
    { desktopBusy: true },
    { pendingDesktop: other },
    { desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: true, errorRevision: 0, activeProfileId: "active" } },
  ];
  for (const extra of cases) {
    const label = JSON.stringify(Object.keys(extra));
    const html = render(relayFor(active, accounts, usage, extra));
    // The row drops its "Geç" and says why on its title.
    assert.equal(switchButtons(html).length, 0, label);
    assert.match(rowFor(html, "Vertex"), /title="[^"]*Şu an geçilemez"/, label);
    // The hero's switch to the suggestion is disabled.
    const offer = hero(render(relayFor(active, accounts, usage, { ...extra, suggestion: other })));
    assert.ok(offer, label);
    assert.match(offer, /disabled=""/, label);
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
  assert.doesNotMatch(html, suggested);
  // The stale account can still be switched to, quietly; the unlinked one cannot.
  assert.equal(switchButtons(html).length, 1);
  assert.match(rowFor(html, "Stale"), /aria-label="Stale hesabına geç"[^>]*class="[^"]*border bg-card/);
  assert.doesNotMatch(rowFor(html, "Loose"), />Geç</);
  // Without a suggestion the heading only says how the rows are ordered.
  assert.match(html, />en uygunu üstte</);
  assert.doesNotMatch(html, /dolmak üzere/);
  assert.match(rowFor(html, "Stale"), /Limit verisi eski/);
});

test("overview rows show the account's status where something is wrong, and stale healthy rows keep theirs", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Vertex", "pro");
  const failed = (issue: UsageIssue): AccountUsage => ({ accountId: "other", status: "error", stale: true, issue });
  const stale = { ...use("other", 1, 1), checkedAt: iso(NOW - 3_600_000) };
  /** The row's one status line and, on its title, the full status. */
  const status = (account: Account, usage: AccountUsage) => {
    const row = rowFor(render(relayFor(active, [active, account], { active: use("active", 10, 10), other: usage })), "Vertex");
    return [
      /<span class="block truncate text-muted-foreground text-xs">([^<]*)<\/span>/.exec(row)?.[1],
      /<a [^>]*title="([^"]*)"/.exec(row)?.[1],
    ];
  };
  // The line leads with the plan; the title is the status alone.
  assert.deepEqual(status(other, failed("expired")), ["Pro · limit okuma girişi gerekli", "Limit okuma girişi gerekli"]);
  assert.deepEqual(status(other, failed("keychain-locked")), ["Pro · anahtarlık izni gerekli", "Anahtarlık izni gerekli"]);
  assert.deepEqual(status(other, failed("renewal-required")), ["Pro · bağlantı yenilenmeli", "Bağlantı yenilenmeli"]);
  assert.deepEqual(status(other, { ...use("other", 1, 1), connectionRenewalRequired: true }), ["Pro · bağlantı yenilenmeli", "Bağlantı yenilenmeli"]);
  assert.deepEqual(status({ ...other, auth: undefined }, stale), ["Pro · limit okuma girişi yok", "Limit okuma girişi yok"]);
  // A browser approval in progress for that account.
  const flows = { authFlows: [{ id: "f", accountId: "other", status: "waiting" }] as unknown as AuthFlow[] };
  const waiting = relayFor(active, [active, other], { active: use("active", 10, 10), other: stale });
  Object.assign(waiting.data as Snapshot, flows);
  assert.match(rowFor(render(waiting), "Vertex"), /Tarayıcı onayı bekleniyor/);
  // Stale but healthy: the line says how old the reading is.
  assert.deepEqual(status(other, stale), ["Pro · limit verisi 1 sa önce okundu", "Limit verisi eski"]);
  assert.deepEqual(status(other, use("other", 1, 1)), ["Pro · hazır", "Hazır · dönem başlamadı"]);
});

test("onboarding with saved accounts but none open looks out instead of greeting", () => {
  const other = acct("other", "Studio", "pro");
  const html = render(relayFor(undefined, [other], {}, { hasUnclaimedDesktop: true }));
  assert.match(/<svg[^>]*data-scene="lookout"[^>]*>/.exec(html)?.[0] ?? "", /width="72"/);
  assert.doesNotMatch(html, /data-scene="welcome"|Merhaba, ben Relay’in kuryesiyim/);
  assert.match(html, /Claude uygulaması hesabı eşleştirilmedi/);
  // Every profile has a Claude app sign-in, so the button adds, as its click does.
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Hesap ekle<\/button>/);
  assert.doesNotMatch(html, /Hesabı eşleştir</);
});

test("today's card shows a lookout panda when automatic start has no planned account", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const usage = { active: use("active", 10, 10) };
  const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_PLANNING, autoStart: true, accounts: [] } };
  const html = render(relayFor(active, [active], usage, { settings }));
  assert.match(html, / · plana hesap eklenmedi/);
  assert.match(/<svg[^>]*data-scene="lookout"[^>]*>/.exec(html)?.[0] ?? "", /width="40"/);
  assert.doesNotMatch(render(relayFor(active, [active], usage)), /data-scene="lookout"/);
});

test("today's card names the day's work hours and early start, with an hour axis under the rows", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const usage = { active: use("active", 10, 10) };
  const at = (now: number, planning: Partial<typeof DEFAULT_PLANNING> = {}) => {
    const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_PLANNING, weekday: { enabled: true, start: "09:00", end: "17:00" }, ...planning } };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(
          RelayContext.Provider,
          { value: relayFor(active, [active], usage, { settings }) },
          createElement(Overview, { go: () => {}, now }),
        ),
      ),
    );
  };
  // A Friday noon in Istanbul: the weekday's hours.
  const friday = Date.parse("2026-10-23T09:00:00Z");
  assert.match(at(friday), />Çalışma 09:00–17:00 · önceden başlatma kapalı</);
  // Saturday: the weekend's hours, off by default.
  const saturday = Date.parse("2026-10-24T09:00:00Z");
  assert.match(at(saturday), />Bugün çalışma yok · önceden başlatma kapalı</);
  assert.match(
    at(saturday, { weekend: { enabled: true, start: "11:00", end: "15:00" } }),
    />Çalışma 11:00–15:00 · önceden başlatma kapalı</,
  );
  // The axis: 00 06 12 18 24, at the day's quarters, the ends inside the track.
  const axis = [...at(friday).matchAll(/<span class="absolute top-0([^"]*)" style="left:([\d.]+)%">(\d\d)<\/span>/g)].map(
    ([, shift, left, hour]) => `${hour}@${Number(left).toFixed(0)}${shift.trim() ? ` ${shift.trim()}` : ""}`,
  );
  assert.deepEqual(axis, ["00@0", "06@25 -translate-x-1/2", "12@50 -translate-x-1/2", "18@75 -translate-x-1/2", "24@100 -translate-x-full"]);
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
  assert.match(html, / · sonraki başlatma \d\d:\d\d Vertex/);
  // The automation card names the next start's day, as Planning does.
  assert.match(html, />Sonraki başlatma<\/span>/);
  assert.match(html, /Vertex (bugün|yarın) \d\d:\d\d</);
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
  assert.match(en, /(?:Work 09:00–18:00|No work today) · next start/);
  assert.doesNotMatch(en, /Automatic start/);
  const off = render(
    relayFor(active, [active], { active: use("active", 10, 10) }),
  );
  assert.match(off, / · önceden başlatma kapalı/);
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
  const html = render(relayFor(active, [active, acct("other", "Vertex", "pro")], { active: use("active", 10, 10) }));
  const [switching] = automationRows(html);
  assert.match(switching, /<span class="block truncate text-xs text-muted-foreground">[^<]*Kapalı\. Limit dolunca başka hesaba sen geçersin\.<\/span>/);
  assert.doesNotMatch(html.slice(html.indexOf(">Otomasyon</h2>")), /text-\[11px\]/);
});

// A friend's first minutes: no Claude app or CLI found yet, Code never opened, no account.
const firstRun = (extra: { desktop?: Partial<DesktopState>; diagnostics?: Partial<Diagnostics>; accounts?: Account[] } = {}) => {
  const accounts = extra.accounts ?? [];
  return relayFor(undefined, accounts, {}, {
    desktop: { available: true, running: false, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, ...extra.desktop },
    data: {
      settings: DEFAULT_SETTINGS, usage: {}, accounts, authFlows: [],
      diagnostics: { platform: "darwin", dataDir: "/tmp", desktopSupported: false, executable: undefined, error: "Claude Code bulunamadı.", ...extra.diagnostics },
    } as unknown as Snapshot,
  });
};
const renderIn = (language: "tr" | "en", relay: Relay) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
      createElement(RelayContext.Provider, { value: relay }, createElement(Overview, { go: () => {}, now: NOW })),
    ),
  );
const checklist = (html: string) => {
  const start = html.indexOf('aria-label="Başlamadan önce"');
  return start < 0 ? "" : html.slice(start, html.indexOf("</ul>", start));
};
const codeOpenNoCli = (diagnostics: Partial<Diagnostics> = {}) =>
  firstRun({
    desktop: { currentAccountUuid: "00000000-0000-4000-8000-000000000001", organizations: ["00000000-0000-4000-8000-000000000002"] },
    diagnostics,
  });
const item = (html: string, key: string) =>
  [...html.matchAll(/<li([^>]*data-prerequisite="([^"]+)"[^>]*)>([\s\S]*?)<\/li>/g)]
    .filter((m) => m[2] === key)
    .map((m) => m[1] + m[3])[0] ?? "";

test("a first run lists the prerequisites, each with a mark, a reason and an action; the CLI waits for Code", () => {
  const html = render(firstRun({ desktop: { available: false } }));
  const list = checklist(html);
  assert.ok(list, "the checklist renders");
  const app = item(list, "desktop");
  assert.match(app, /data-met="false"/);
  assert.match(app, /Claude uygulaması/);
  assert.match(app, /Relay, Claude uygulamasında hesaplar arasında geçiş yapar\./);
  assert.match(app, /<a[^>]*href="https:\/\/claude\.ai\/download"[^>]*target="_blank"[^>]*>İndir<\/a>/);
  // Opening Code makes the Claude app download its own Claude Code: no CLI row before it.
  assert.equal(item(list, "cli"), "");
  const code = item(list, "code");
  assert.match(code, /data-met="false"/);
  assert.match(code, /Code sekmesi açıldı/);
  assert.match(code, /Code’u bir kez aç; Claude Code da böylece iner\./);
  const cli = item(checklist(render(codeOpenNoCli())), "cli");
  assert.match(cli, /data-met="false"/);
  assert.match(cli, /Claude Code CLI/);
  assert.match(cli, /Bulunamadı/);
  assert.match(cli, /Limitleri okumak için gerekir\./);
  assert.match(cli, /<a[^>]*href="https:\/\/docs\.anthropic\.com\/en\/docs\/claude-code\/setup"[^>]*target="_blank"/);
  assert.match(cli, /<button[^>]*>Dosyayı seç<\/button>/);
});

test("met prerequisites are ticked and the list hides once all three are met", () => {
  const partial = checklist(render(firstRun()));
  assert.match(item(partial, "desktop"), /data-met="true"[\s\S]*Bulundu/);
  assert.doesNotMatch(item(partial, "desktop"), /İndir/);
  // With the Claude app there, the Code step opens Claude on Code.
  assert.match(item(partial, "code"), /<button[^>]*>Code’u aç<\/button>/);
  assert.match(item(checklist(render(firstRun({ desktop: { running: true } }))), "code"), /<button[^>]*>Code’u aç<\/button>/);
  const ready = render(
    firstRun({
      desktop: { currentAccountUuid: "00000000-0000-4000-8000-000000000001", organizations: ["00000000-0000-4000-8000-000000000002"] },
      diagnostics: { executable: "/usr/local/bin/claude", version: "2.1.300 (Claude Code)", error: undefined },
    }),
  );
  assert.equal(checklist(ready), "");
  // Until both snapshots arrive, nothing is ticked or crossed.
  const loading = relayFor(undefined, [], {});
  assert.equal(checklist(render(loading)), "");
});

test("an outdated CLI names the version found and the minimum", () => {
  const cli = item(checklist(render(codeOpenNoCli({ executable: "/usr/local/bin/claude", version: "2.1.200 (Claude Code)", error: undefined }))), "cli");
  assert.match(cli, /data-met="false"/);
  assert.match(cli, /2\.1\.200 \(Claude Code\) · 2\.1\.296 veya üstü gerekir/);
  // A CLI the Claude app accepts but that cannot read limits is not ticked.
  const between = item(checklist(render(codeOpenNoCli({ executable: "/usr/local/bin/claude", version: "2.1.290 (Claude Code)", error: undefined }))), "cli");
  assert.match(between, /data-met="false"/);
  assert.match(between, /2\.1\.290 \(Claude Code\) · 2\.1\.296 veya üstü gerekir/);
});

test("the CLI's Choose file reuses the Settings picker", async () => {
  const calls: string[] = [];
  const relay = firstRun();
  relay.action = (async (name: string, fn: () => Promise<unknown>) => {
    calls.push(name);
    await fn();
  }) as Relay["action"];
  relay.api = { pickExecutable: async () => void calls.push("pick") } as unknown as Relay["api"];
  const { chooseCliFile } = await import("../src/features/CliSetup");
  chooseCliFile(relay);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["executable", "pick"]);
});

test("the checklist speaks English with the glossary names", () => {
  const html = renderIn("en", firstRun({ desktop: { available: false } }));
  const cli = renderIn("en", codeOpenNoCli());
  assert.match(html, /Before you start/);
  assert.match(html, /Claude app/);
  assert.match(html, /Relay switches the Claude app between accounts\./);
  assert.match(html, />Download<\/a>/);
  assert.match(cli, /Needed to read usage limits\./);
  assert.match(cli, />Choose file<\/button>/);
  assert.match(html, /Code tab opened/);
  assert.match(html, /Open Code once from the Claude app’s sidebar/);
});

test("with no account, the overview offers the first one once and hides Today and automation", () => {
  const html = render(firstRun());
  // The greeting's button is the only offer; the empty accounts card is not shown.
  assert.equal(html.match(/>Hesap ekle<\/button>/g)?.length, 1);
  assert.doesNotMatch(html, /Henüz hesap yok/);
  assert.doesNotMatch(html, /Başka hesap yok/);
  assert.doesNotMatch(html, /Planlama →/);
  assert.doesNotMatch(html, /Otomatik geçiş/);
  assert.doesNotMatch(html, /Otomasyon/);
  const en = renderIn("en", firstRun());
  assert.equal(en.match(/>Add account<\/button>/g)?.length, 1);
});

test("Today shows from one connected account, automation from two", () => {
  const one = acct("one", "Kişisel", "pro");
  const loose = acct("loose", "Studio", "pro", false);
  const two = acct("two", "Vertex", "pro");
  const usage = { one: use("one", 10, 10) };
  const single = render(relayFor(one, [one, loose], usage));
  assert.match(single, /Planlama →/);
  assert.doesNotMatch(single, /Otomatik geçiş/);
  const pair = render(relayFor(one, [one, two], usage));
  assert.match(pair, /Planlama →/);
  assert.match(pair, /Otomatik geçiş/);
});

test("the welcome says what Relay does, in both languages", () => {
  assert.match(render(firstRun()), /Merhaba, ben Relay’in kuryesiyim<\/div><p[^>]*>Claude hesapların arasında tek tıkla geç; Code konuşmaların seninle gelsin\.<\/p>/);
  assert.match(renderIn("en", firstRun()), /Switch between your Claude accounts in one click; your Code conversations come with you\./);
});

const welcomeButton = (html: string) => {
  const card = html.slice(0, html.indexOf('aria-label="Başlamadan önce"'));
  const button = /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Hesap ekle<\/button>/.exec(card)?.[0] ?? "";
  return { button, after: card.slice(card.indexOf(button) + button.length) };
};

test("the welcome button says why it is disabled, next to it", () => {
  const reason = (html: string) => {
    const { button, after } = welcomeButton(html);
    assert.match(button, /disabled=""/);
    return after;
  };
  assert.match(reason(render(firstRun({ desktop: { available: false } }))), /^<p[^>]*>Claude uygulaması bulunamadı; önce onu kur\.<\/p>/);
  assert.match(reason(render(firstRun({ desktop: { recoveryRequired: true } }))), /^<p[^>]*>Önce Claude uygulaması yedeğini geri yükle\.<\/p>/);
  const busy = firstRun();
  busy.desktopBusy = true;
  assert.match(reason(render(busy)), /^<p[^>]*>Claude uygulamasında bir işlem sürüyor\.<\/p>/);
  // Enabled, it explains nothing.
  const idle = welcomeButton(render(firstRun()));
  assert.doesNotMatch(idle.button, /disabled=""/);
  assert.doesNotMatch(idle.after, /^<p/);
});

test("with no profile yet, an unlinked Claude sign-in is added, not linked", () => {
  const relay = firstRun({ desktop: { currentAccountUuid: "00000000-0000-4000-8000-000000000001" } });
  relay.hasUnclaimedDesktop = true;
  const html = render(relay);
  assert.match(html, /Merhaba, ben Relay’in kuryesiyim/);
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Hesap ekle<\/button>/);
  assert.doesNotMatch(html, /Hesabı eşleştir/);
});

test("every account that can be switched to has its own Geç, filled only for the suggested one", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const vertex = acct("vertex", "Vertex", "pro");
  const alto = acct("alto", "Alto", "pro");
  const studio = acct("studio", "Studio", "pro", false);
  const html = render(
    relayFor(active, [active, vertex, alto, studio], {
      active: use("active", 90, 40),
      vertex: use("vertex", 0, 10),
      alto: use("alto", 30, 24),
    }, { suggestion: vertex }),
  );
  const geç = (name: string) => /<button[^>]*aria-label="([^"]*) hesabına geç"[^>]*class="([^"]*)"[^>]*>Geç<\/button>/.exec(rowFor(html, name));
  assert.match(geç("Vertex")?.[2] ?? "", /bg-primary/);
  assert.match(geç("Alto")?.[2] ?? "", /border bg-card/);
  assert.doesNotMatch(geç("Alto")?.[2] ?? "", /bg-primary/);
  // Without a Claude app sign-in there is nothing to switch to: the row opens the account.
  assert.equal(geç("Studio"), null);
  assert.equal(switchButtons(html).length, 2);
});

test("a full account keeps its switch on the Overview, tinted, and the review says when it opens", async () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const full = acct("full", "Dolu", "pro");
  const usage = { active: use("active", 10, 10), full: use("full", 100, 40, NOW + 90 * 60_000) };
  const requested: string[] = [];
  const relay = relayFor(active, [active, full], usage, {
    requestDesktop: (account: Account, kind: string) => void requested.push(`${account.id}:${kind}`),
  });
  const row = rowFor(render(relay), "Dolu");
  // Not dimmed: its switch is there, amber instead of the quiet outline, and says why.
  assert.doesNotMatch(row, /opacity-60/);
  const [button = ""] = switchButtons(render(relay));
  assert.match(button, /aria-label="Dolu hesabına geç · Limit dolu · [^"]+ açılır \(1 sa 30 dk\)"/);
  assert.match(button, /class="[^"]*border-warn\/40 bg-warn\/10 text-warn-foreground/);
  // Clicking it opens the same review as any switch.
  const dom = fakeDom();
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
          createElement(RelayContext.Provider, { value: relay }, createElement(AccountsCard, { go: () => {}, now: NOW })),
        ),
      ),
    );
    const label = (n: Fake) => (n as { attributes?: Map<string, string> }).attributes?.get("aria-label") ?? "";
    const target = find(dom.container as unknown as Fake, (n) => n.tagName === "button" && label(n).startsWith("Dolu hesabına geç"));
    assert.ok(target);
    await act(async () => dom.dispatch(target as never, "click", { detail: 1 }));
    assert.deepEqual(requested, ["full:switch"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
  // The review before the switch says the limit is full and when it opens.
  const review = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(
        RelayContext.Provider,
        { value: relayFor(active, [active, full], usage, { desktopRequest: { accountId: "full", kind: "switch" } }) },
        createElement(DesktopActionBody),
      ),
    ),
  );
  assert.match(review, /data-slot="switch-full-limit"[^>]*>Bu hesabın limiti dolu; [^<]+ açılır \(1 sa 30 dk sonra\)\. O zamana kadar bu hesapla yeni mesaj gönderemezsin\.</);
  const plain = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(
        RelayContext.Provider,
        { value: relayFor(active, [active, full], { ...usage, full: use("full", 20, 40) }, { desktopRequest: { accountId: "full", kind: "switch" } }) },
        createElement(DesktopActionBody),
      ),
    ),
  );
  assert.doesNotMatch(plain, /switch-full-limit/);
});

test("Overview rings say how far each reading can be trusted, and the key explains the faded ones", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const fresh = acct("fresh", "Fresh", "pro");
  const old = acct("old", "Old", "pro");
  const none = acct("none", "None", "pro");
  const full = acct("full", "Full", "pro");
  const usage = {
    active: use("active", 10, 10),
    fresh: use("fresh", 20, 30),
    old: { ...use("old", 20, 30), checkedAt: iso(NOW - 2 * 3_600_000) },
    full: use("full", 100, 30, NOW + 3_600_000),
  };
  const html = render(relayFor(active, [active, fresh, old, none, full], usage));
  const ring = (name: string) => /<div role="img"[^>]*>/.exec(rowFor(html, name))?.[0] ?? "";
  assert.doesNotMatch(ring("Fresh"), /data-state/);
  assert.match(ring("Old"), /data-state="stale"/);
  assert.match(ring("Old"), /aria-label="Old · 5 saat %20 kullanıldı · hafta %30 kullanıldı · limit verisi eski"/);
  assert.match(ring("None"), /data-state="unknown"/);
  assert.match(ring("Full"), /data-state="full"/);
  // The stale row's line says how old its reading is; the key under the list says what faded rings mean.
  assert.match(rowFor(html, "Old"), />Pro · limit verisi 2 sa önce okundu</);
  assert.match(html, /kesikli: veri eski/);
  // Without a stale row the key keeps its two entries.
  const current = render(relayFor(active, [active, fresh], { active: use("active", 10, 10), fresh: use("fresh", 20, 30) }));
  assert.match(current, /ince: hafta/);
  assert.doesNotMatch(current, /eski veri/);
});

test("the hero shows the plan, else the subscription, and a hollow dot while Claude is closed", () => {
  const active = acct("active", "Kişisel", "max5");
  const usage = { active: use("active", 10, 10) };
  assert.match(render(relayFor(active, [active], usage)), /<span data-slot="badge"[^>]*>Max 5×<\/span>/);
  const subscribed: Account = { ...active, planning: undefined, auth: { ...active.auth!, subscription: "team" } };
  const html = render(relayFor(subscribed, [subscribed], usage));
  assert.match(html, /<span data-slot="badge"[^>]*title="Abonelik · planlama için plan seçilmedi"[^>]*>Team<\/span>/);
  // Running is a filled dot; closed is a ring.
  assert.match(html, /<span aria-hidden="true" class="[^"]*bg-ok[^"]*"><\/span>Çalışıyor/);
  const closed = render(relayFor(active, [active], usage, {
    desktop: { available: true, running: false, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "active" },
  }));
  assert.match(closed, /<span aria-hidden="true" class="[^"]*border-\[1\.5px\] border-muted-foreground\/60[^"]*"><\/span>Kapalı/);
  // A used-up limit draws the hero's rings critical.
  const exhausted = render(relayFor(active, [active], { active: use("active", 100, 40, NOW + 3_600_000) }));
  assert.match(exhausted, /<div role="img"[^>]*data-state="full"[^>]*style="width:140px;height:140px"/);
});

test("the hero says why its switch to the suggestion is disabled", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Vertex", "pro");
  const usage = { active: use("active", 90, 40), other: use("other", 10, 10) };
  const block = (extra: Partial<Relay>) => {
    const html = render(relayFor(active, [active, other], usage, { suggestion: other, ...extra }));
    const start = html.indexOf('data-slot="suggestion"');
    return html.slice(start, html.indexOf("</div>", start));
  };
  assert.doesNotMatch(block({}), /<p class="text-xs text-muted-foreground">/);
  const recovery = { available: true, running: true, organizations: [], busy: false, recoveryRequired: true, errorRevision: 0, activeProfileId: "active" };
  for (const [extra, reason] of [
    [{ desktopBusy: true }, "Claude uygulamasında bir işlem sürüyor."],
    [{ pendingDesktop: other }, "Önce devam eden Claude uygulaması girişini tamamla veya iptal et."],
    [{ desktop: recovery }, "Önce Claude uygulaması yedeğini geri yükle."],
  ] as [Partial<Relay>, string][]) {
    assert.match(block(extra), new RegExp(`disabled=""[^>]*>Vertex hesabına geç</button><p class="text-xs text-muted-foreground">${reason}</p>`), reason);
  }
});
