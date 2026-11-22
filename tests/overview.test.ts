import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Overview } from "../src/pages/Overview";
import { AccountsBoard } from "../src/pages/overview/AccountsBoard";
import { ActiveAccountCard } from "../src/pages/overview/ActiveAccountCard";
import { TodayCard } from "../src/pages/overview/TodayCard";
import { ProviderPane, relayProviders } from "../src/features/Providers";
import { suggestedAccount } from "../shared/usage";
import { DesktopActionBody } from "../src/app/DesktopActionDialog";
import type { PageId } from "../src/app/routes";
import { fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { i18nValue } from "./i18n";
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
      { value: i18nValue("tr") },
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
  // The card of the account in the Claude app is named for screen readers, not by a heading.
  assert.match(html, /<section aria-label="Claude uygulamasında açık"/);
  assert.match(html, /Kişisel · Max/);
  // One chip: the provider and the plan.
  assert.match(html, /data-provider="claude" title="Planlama için seçildi">[\s\S]*?Claude<span[^>]*>· Max 5×<\/span>/);
  assert.deepEqual(heroStatus(html), { tone: "ok", title: "Açık", text: "Açık" });
  // The hero is a grouped box: the account, then one line per limit with its percent.
  assert.match(html, /data-slot="active-account"/);
  assert.match(html, /role="meter" aria-label="5 saat %38"[^>]*aria-valuenow="38"/);
  assert.match(html, /role="meter" aria-label="Hafta %78"[^>]*aria-valuenow="78"/);
  assert.match(html, /Opus · haftalık/);
  // No suggestion band: the hero's "Sıradaki" line names the suggested account, its five hours,
  // and offers the switch as the filled button.
  assert.doesNotMatch(html, /uyarı eşiğini geçti|Önerilen:/);
  const hint = suggestionBlock(html);
  assert.match(hint, />Sıradaki</);
  assert.match(hint, />Vertex<\/span>/);
  assert.match(hint, />5 saat %12 kullanıldı</);
  assert.match(hint, /<button[^>]*data-variant="default"[^>]*aria-label="Vertex hesabına geç">Geç<\/button>/);
  assert.doesNotMatch(html, /Önerilen üstte|en uygunu üstte|Geçişi incele/);
  // Every other account is a row of the board that opens the account's page: its 5 hours and its week.
  const row = rowFor(html, "Vertex");
  assert.match(row, /^ data-account="vertex" class="[^"]*"><[\s\S]*?<button type="button" data-list-nav=""[^>]*title="Vertex">Vertex<\/button>/);
  assert.match(row, /role="meter" aria-label="5 saat %12"/);
  assert.match(row, /role="meter" aria-label="Hafta %31"/);
  assert.doesNotMatch(row, /<button(?! type="button" data-list-nav)/);
  // The account in the Claude app is the card above, not a row again; the aside counts the usable ones.
  assert.equal(rowsOf(html).length, 1);
  assert.match(listOf(html), /<h2[^>]*>Tüm hesaplar<\/h2>[\s\S]*?>2\/2 kullanılabilir</);
  assert.match(html, /Bugün/);
  // Today's line says the day, how switching runs and early start: there is no automation card.
  assert.match(html, />(?:Çalışma 09:00–18:00|Bugün çalışma yok) · otomatik geçiş kapalı · önceden başlatma kapalı</);
  assert.doesNotMatch(html, />Otomasyon<\/h2>|Otomatik başlatma|Claude uygulaması kapanınca hazırla/);
  // Refresh and bring-to-front live in the page header.
  assert.match(html, /<button[^>]*aria-label="Limitleri yenile"/);
  assert.match(html, /<button[^>]*>Claude uygulamasını aç<\/button>/);
});

test("overview without an active account offers onboarding", () => {
  const emptyHtml = render(relayFor(undefined, [], {}));
  assert.match(emptyHtml, /İlk hesabını ekle/);
  assert.match(emptyHtml, /Her hesabı bir kez bağla\. Sonra buradan geç\./);
  assert.match(/<svg[^>]*data-scene="welcome"[^>]*>/.exec(emptyHtml)?.[0] ?? "", /width="88"/);
  assert.match(emptyHtml, /Hesap ekle/);
  assert.doesNotMatch(emptyHtml, /Henüz hesap yok/);
  assert.doesNotMatch(emptyHtml, /Başka hesap yok/);
  assert.doesNotMatch(emptyHtml, /CLAUDE UYGULAMASINDA AÇIK/);
});

test("unlinked accounts lead to their page instead of offering a switch", async () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Studio", "pro", false);
  const relay = relayFor(active, [active, other], { active: use("active", 10, 10) });
  const html = render(relay);
  const row = rowFor(html, "Studio");
  // The row opens like a link and offers no switch; nothing is suggested.
  assert.match(row, /<button type="button" data-list-nav=""[^>]*title="Studio">Studio<\/button>/);
  assert.doesNotMatch(row, /<button(?! type="button" data-list-nav)/);
  assert.equal(switchButtons(html).length, 0);
  assert.equal(suggestionBlock(html), "");
  // Choosing it opens the account's page, where its sign-in is saved.
  assert.equal(await openRow(relay, "other"), "#/hesaplar/other");
});

/** The board of every other account, up to the end of its section. */
const listOf = (html: string) => {
  const start = html.indexOf('data-slot="accounts-board"');
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
};
const rowsOf = (html: string) => listOf(html).split('data-slot="list-row"').slice(1);
const rowFor = (html: string, name: string) => rowsOf(html).find((r) => r.includes(`>${name}<`)) ?? "";
/** The hero's "Sıradaki" line: the suggested account and its switch. */
const suggestionBlock = (html: string) => {
  const start = html.indexOf('data-slot="suggestion"');
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
};
/** Every "Geç" on the page. */
const switchButtons = (html: string) => html.match(/<button[^>]*>Geç<\/button>/g) ?? [];
/** The status of the account in the Claude app: its tone, the reason on its title and its words. */
const heroStatus = (html: string) => {
  const hero = html.slice(html.indexOf('data-slot="active-account"'));
  const found = /data-slot="status-label" data-tone="(\w+)" title="([^"]*)"[^>]*>[\s\S]*?<span class="truncate">([^<]*)<\/span>/.exec(hero);
  return found ? { tone: found[1], title: found[2], text: found[3] } : undefined;
};
/** Clicks an account's row on the board and returns where it led. */
async function openRow(relay: Relay, id: string): Promise<string> {
  const dom = fakeDom();
  dom.install();
  const location = { hash: "#/genel" };
  Object.assign(globalThis.window, { location });
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nValue("tr") },
          createElement(RelayContext.Provider, { value: relay }, createElement(AccountsBoard, { now: NOW })),
        ),
      ),
    );
    const row = find(dom.container as unknown as Fake, (n) => (n as { attributes?: Map<string, string> }).attributes?.get?.("data-account") === id);
    assert.ok(row, id);
    await act(async () => dom.dispatch(row as never, "click", { detail: 1 }));
    await act(async () => root.unmount());
    return location.hash;
  } finally {
    dom.uninstall();
  }
}

test("the Overview says how switching runs and leaves the choice to its page, and Today opens Planning", async () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const accounts = [active, acct("other", "Vertex", "pro")];
  // The choice and its lock while a handoff runs live in Settings → Switching; the Overview only says it.
  for (const status of ["switching", "continuing", "watching"] as const) {
    const relay = relayFor(active, accounts, { active: use("active", 10, 10) });
    (relay.data as Snapshot).fleet = { enabled: true, status, sourceId: "active", targetId: "active" };
    const html = render(relay);
    assert.doesNotMatch(html, /id="automation-mode"|role="switch"|role="radio"/, status);
    assert.match(html, / · geçiş: limit dolunca · /, status);
  }
  // Today's link opens its page.
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
          { value: i18nValue("tr") },
          createElement(
            RelayContext.Provider,
            { value: relayFor(active, accounts, { active: use("active", 10, 10) }) },
            createElement(TodayCard, { go: (page: string) => void opened.push(page as PageId), now: NOW }),
          ),
        ),
      ),
    );
    const link = find(dom.container as unknown as Fake, (n) => n.tagName === "button" && textOf(n).startsWith("Planlama"));
    assert.ok(link);
    await act(async () => dom.dispatch(link, "click", { detail: 1 }));
    assert.deepEqual(opened, ["planlama"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the hero names the suggested account even when the board lists another first", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const x = acct("x", "Xeno", "max5");
  const y = acct("y", "Yarn", "pro");
  const usage = { active: use("active", 90, 90), x: use("x", 5, 5), y: use("y", 30, 40) };
  const base = render(relayFor(active, [active, x, y], usage));
  // No suggestion, no "Sıradaki" line.
  assert.equal(suggestionBlock(base), "");
  const first = /data-account="(\w+)"/.exec(listOf(base))?.[1];
  const leading = first === "x" ? x : y;
  const other = first === "x" ? y : x;
  const html = render(relayFor(active, [active, x, y], usage, { suggestion: other }));
  assert.match(suggestionBlock(html), new RegExp(`>${other.name}</span>`));
  assert.doesNotMatch(suggestionBlock(html), new RegExp(`>${leading.name}<`));
  // The board keeps its own order.
  assert.equal(/data-account="(\w+)"/.exec(listOf(html))?.[1], first);
});

test("switch actions are withheld or disabled while Desktop is busy, pending or needs recovery", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Vertex", "pro");
  const accounts = [active, other];
  const usage = { active: use("active", 10, 10), other: use("other", 10, 10) };
  // The board offers no switch of its own: its row opens the account.
  assert.equal(switchButtons(render(relayFor(active, accounts, usage))).length, 0);
  /** The hero's switch to the suggested account. */
  const hero = (html: string) => /<button[^>]*aria-label="Vertex hesabına geç">Geç<\/button>/.exec(suggestionBlock(html))?.[0] ?? "";
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
    assert.equal(switchButtons(render(relayFor(active, accounts, usage, extra))).length, 0, label);
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
  // The account in use is past the warning threshold, so the app looks for another.
  const usage = {
    active: use("active", 95, 40),
    stale: { ...use("stale", 0, 0), checkedAt: iso(NOW - 3_600_000) },
    unlinked: use("unlinked", 0, 0),
  };
  // The suggestion the hero shows (useRelay's) passes over both; a fresh, linked account would be the one.
  assert.equal(suggestedAccount(active, [active, stale, unlinked], usage, DEFAULT_SETTINGS, NOW), undefined);
  const fresh = acct("fresh", "Fresh", "pro");
  assert.equal(suggestedAccount(active, [active, stale, unlinked, fresh], { ...usage, fresh: use("fresh", 0, 0) }, DEFAULT_SETTINGS, NOW)?.id, "fresh");
  const html = render(relayFor(active, [active, stale, unlinked], usage));
  assert.equal(rowsOf(html).length, 2);
  assert.equal(suggestionBlock(html), "");
  assert.equal(switchButtons(html).length, 0);
  // The stale account's figures are faded: an old reading.
  assert.match(rowFor(html, "Stale"), /data-slot="limit-line" class="[^"]*opacity-60/);
  assert.doesNotMatch(rowFor(html, "Loose"), /opacity-60/);
});

test("the hero shows the account's status where something is wrong, in a few words with the reason on its title", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const failed = (issue: UsageIssue): AccountUsage => ({ accountId: "active", status: "error", stale: true, issue });
  const stale = { ...use("active", 1, 1), checkedAt: iso(NOW - 3_600_000) };
  const status = (account: Account, usage: AccountUsage, extra: Partial<Relay> = {}) => {
    const found = heroStatus(render(relayFor(account, [account], { active: usage }, extra)));
    return [found?.text, found?.title];
  };
  assert.deepEqual(status(active, failed("expired")), ["Giriş gerekli", "Limit okuma girişi gerekli"]);
  assert.deepEqual(status(active, failed("keychain-locked")), ["Anahtarlık izni", "Anahtarlık izni gerekli"]);
  assert.deepEqual(status(active, failed("renewal-required")), ["Yenilenmeli", "Bağlantı yenilenmeli"]);
  assert.deepEqual(status(active, { ...use("active", 1, 1), connectionRenewalRequired: true }), ["Yenilenmeli", "Bağlantı yenilenmeli"]);
  assert.deepEqual(status({ ...active, auth: undefined }, stale), ["Limit girişi yok", "Limit okuma girişi yok"]);
  // A browser approval in progress for that account.
  const waiting = relayFor(active, [active], { active: stale });
  Object.assign(waiting.data as Snapshot, { authFlows: [{ id: "f", accountId: "active", status: "waiting" }] as unknown as AuthFlow[] });
  assert.equal(heroStatus(render(waiting))?.text, "Tarayıcıda onayla");
  // Stale but healthy: an old reading, quiet; fresh and healthy: in use.
  assert.deepEqual(heroStatus(render(relayFor(active, [active], { active: stale }))), { tone: "off", title: "Eski okuma", text: "Eski okuma" });
  assert.deepEqual(status(active, use("active", 1, 1)), ["Açık", "Açık"]);
  // Another account's problem is on its own page: its board row has no figure to show and opens it.
  const other = acct("other", "Vertex", "pro");
  const row = rowFor(render(relayFor(active, [active, other], { active: use("active", 10, 10), other: { ...failed("expired"), accountId: "other" } })), "Vertex");
  assert.match(row, /^ data-account="other"[\s\S]*?data-list-nav=""[^>]*title="Vertex"/);
  assert.equal(row.match(/>—<\/span>/g)?.length, 2);
});

test("onboarding with saved accounts but none open looks out instead of greeting", () => {
  const other = acct("other", "Studio", "pro");
  const html = render(relayFor(undefined, [other], {}, { hasUnclaimedDesktop: true }));
  assert.match(/<svg[^>]*data-scene="lookout"[^>]*>/.exec(html)?.[0] ?? "", /width="56"/);
  assert.doesNotMatch(html, /data-scene="welcome"|İlk hesabını ekle/);
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
  assert.match(/<svg[^>]*data-scene="lookout"[^>]*>/.exec(html)?.[0] ?? "", /width="32"/);
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
        { value: i18nValue("tr") },
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
  // How switching runs sits between the day and early start.
  assert.match(at(friday), />Çalışma 09:00–17:00 · otomatik geçiş kapalı · önceden başlatma kapalı</);
  // Saturday: the weekend's hours, off by default.
  const saturday = Date.parse("2026-10-24T09:00:00Z");
  assert.match(at(saturday), />Bugün çalışma yok · otomatik geçiş kapalı · önceden başlatma kapalı</);
  assert.match(
    at(saturday, { weekend: { enabled: true, start: "11:00", end: "15:00" } }),
    />Çalışma 11:00–15:00 · otomatik geçiş kapalı · önceden başlatma kapalı</,
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
  // With no automation card, Today's line is where the next start is said.
  assert.doesNotMatch(html, />Sonraki başlatma<\/span>|>Otomasyon<\/h2>/);
  assert.doesNotMatch(html, /Otomatik başlatma/);
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("en") },
      createElement(
        RelayContext.Provider,
        { value: relay },
        createElement(Overview, { go: () => {}, now: NOW }),
      ),
    ),
  );
  assert.match(en, /(?:Work 09:00–18:00|No work today) · automatic switching off · next start \d\d:\d\d Vertex/);
  assert.doesNotMatch(en, /Automatic start/);
  const off = render(
    relayFor(active, [active], { active: use("active", 10, 10) }),
  );
  assert.match(off, / · önceden başlatma kapalı/);
});

test("the onboarding and the today lookout pandas are playful, the welcome and the lookouts alike", () => {
  const playful = (scene: string, size: number) =>
    new RegExp(`<span data-playful="true" class="inline-block shrink-0 overflow-hidden" style="width:${size}px;height:${size}px"><svg[^>]*data-scene="${scene}"`);
  // The welcome (no account yet) is 88 px and the pairing lookout 56 px.
  assert.match(render(relayFor(undefined, [], {})), playful("welcome", 88));
  assert.match(render(relayFor(undefined, [acct("other", "Studio", "pro")], {}, { hasUnclaimedDesktop: true })), playful("lookout", 56));
  // Today's lookout is 32 px.
  const active = acct("active", "Kişisel · Max", "max5");
  const usage = { active: use("active", 10, 10) };
  const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_PLANNING, autoStart: true, accounts: [] } };
  assert.match(render(relayFor(active, [active], usage, { settings })), playful("lookout", 32));
  // An overview with an account open and a plan has no panda to click.
  assert.doesNotMatch(render(relayFor(active, [active], usage)), /data-playful/);
});

test("Today's line, which says how switching runs, is set in text-xs, and nothing on the Overview in 11 px", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const html = render(relayFor(active, [active, acct("other", "Vertex", "pro")], { active: use("active", 10, 10) }));
  assert.match(html, /<div class="[^"]*\btext-xs\b[^"]*"><span>[^<]* · otomatik geçiş kapalı · [^<]*<\/span>/);
  assert.doesNotMatch(html, /text-\[11px\]/);
});

// A friend's first minutes: no Claude app or CLI found yet, Code never opened, no account.
const firstRun = (extra: { desktop?: Partial<DesktopState>; diagnostics?: Partial<Diagnostics>; accounts?: Account[] } = {}) => {
  const accounts = extra.accounts ?? [];
  return relayFor(undefined, accounts, {}, {
    desktop: { available: true, running: false, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, ...extra.desktop },
    data: {
      settings: DEFAULT_SETTINGS, usage: {}, accounts, authFlows: [],
      // The CLI step exists only off macOS: there the Claude app's sign-in reads the limits.
      diagnostics: { platform: "linux", dataDir: "/tmp", desktopSupported: false, executable: undefined, error: "Claude Code bulunamadı.", ...extra.diagnostics },
    } as unknown as Snapshot,
  });
};
const renderIn = (language: "tr" | "en", relay: Relay) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue(language) },
      createElement(RelayContext.Provider, { value: relay }, createElement(Overview, { go: () => {}, now: NOW })),
    ),
  );
const checklist = (html: string) => {
  const start = html.indexOf('aria-label="Relay’i kur"');
  return start < 0 ? "" : html.slice(start, html.indexOf("</ul>", start));
};
const codeOpenNoCli = (diagnostics: Partial<Diagnostics> = {}) =>
  firstRun({
    desktop: { currentAccountUuid: "00000000-0000-4000-8000-000000000001", organizations: ["00000000-0000-4000-8000-000000000002"] },
    diagnostics,
  });
const item = (html: string, key: string) =>
  [...html.matchAll(/<li([^>]*data-step="([^"]+)"[^>]*)>([\s\S]*?)<\/li>/g)]
    .filter((m) => m[2] === key)
    .map((m) => m[1] + m[3])[0] ?? "";

test("a first run lists the prerequisites, each with a mark, a reason and an action; the CLI waits for Code", () => {
  const html = render(firstRun({ desktop: { available: false } }));
  const list = checklist(html);
  assert.ok(list, "the checklist renders");
  const app = item(list, "desktop");
  assert.match(app, /data-met="false"/);
  assert.match(app, /Claude uygulaması/);
  assert.match(app, /Relay için Claude uygulaması gerekir\./);
  assert.match(app, /<a[^>]*href="https:\/\/claude\.ai\/download"[^>]*target="_blank"[^>]*>İndir<\/a>/);
  // Opening Code makes the Claude app download its own Claude Code: no CLI row before it.
  assert.equal(item(list, "cli"), "");
  const code = item(list, "code");
  assert.match(code, /data-met="false"/);
  assert.match(code, /Code sekmesi açıldı/);
  assert.match(code, /Claude uygulamasında sol menüden Code’u bir kez aç\./);
  const cli = item(checklist(render(codeOpenNoCli())), "cli");
  assert.match(cli, /data-met="false"/);
  assert.match(cli, /Claude Code CLI/);
  assert.match(cli, /Bulunamadı/);
  assert.match(cli, /Limitleri okumak için gerekir\./);
  assert.match(cli, /<a[^>]*href="https:\/\/docs\.anthropic\.com\/en\/docs\/claude-code\/setup"[^>]*target="_blank"/);
  assert.match(cli, /<button[^>]*>Dosyayı seç<\/button>/);
});

test("met steps fold into one done line, then the list guides to the accounts and hides once Relay can switch", () => {
  const partial = checklist(render(firstRun()));
  // The Claude app found: folded into the done line, with no Download link.
  assert.equal(item(partial, "desktop"), "");
  assert.match(item(partial, "done"), /Claude uygulaması/);
  assert.doesNotMatch(partial, /İndir/);
  // With the Claude app there, the Code step opens Claude on Code.
  assert.match(item(partial, "code"), /<button[^>]*>Code’u aç<\/button>/);
  assert.match(item(checklist(render(firstRun({ desktop: { running: true } }))), "code"), /<button[^>]*>Code’u aç<\/button>/);
  const codeOpen = {
    desktop: { currentAccountUuid: "00000000-0000-4000-8000-000000000001", organizations: ["00000000-0000-4000-8000-000000000002"] },
    diagnostics: { executable: "/usr/local/bin/claude", version: "2.1.300 (Claude Code)", error: undefined },
  };
  // The prerequisites met, the list goes on: the accounts (one step for both), then when to switch.
  const ready = checklist(render(firstRun(codeOpen)));
  assert.match(item(ready, "done"), /Claude uygulaması · Code sekmesi açıldı/);
  assert.equal(item(ready, "first"), "");
  assert.equal(item(ready, "second"), "");
  // The fixture is Linux: "this computer", not "this Mac".
  assert.match(item(ready, "accounts"), /data-met="false"[\s\S]*Hesaplarını ekle[\s\S]*0 \/ 2[\s\S]*bu bilgisayarda bulunan hesapları tek seferde ekler/);
  // No account yet: the welcome card above holds the only Add account; the later step waits.
  assert.doesNotMatch(item(ready, "accounts"), /<button/);
  assert.doesNotMatch(item(ready, "mode"), /<button/);
  // One account: the step offers its own Add account.
  const one = checklist(render(firstRun({ ...codeOpen, accounts: [acct("one", "Kişisel", "pro")] })));
  assert.match(item(one, "accounts"), /1 \/ 2[\s\S]*Bir hesap daha gerekiyor[\s\S]*<button[^>]*>Hesap ekle<\/button>/);
  // Two accounts: when to switch, with Choose; on macOS the extension is optional.
  const two = [acct("one", "Kişisel", "pro"), acct("two", "Vertex", "pro")];
  const pair = checklist(render(firstRun({ ...codeOpen, accounts: two, diagnostics: { ...codeOpen.diagnostics, platform: "darwin" } })));
  assert.match(item(pair, "done"), /Hesaplarını ekle/);
  assert.match(item(pair, "mode"), /Ne zaman geçileceğini seç[\s\S]*<button[^>]*>Seç<\/button>/);
  assert.match(item(pair, "extension"), /İsteğe bağlı/);
  // A mode chosen and no optional step (Windows): nothing left to say.
  const done = firstRun({ ...codeOpen, accounts: two, diagnostics: { ...codeOpen.diagnostics, platform: "win32" } });
  done.settings = { ...done.settings, autoSwitchMode: "after-exit" };
  assert.equal(checklist(render(done)), "");
  // Linux offers the optional extension step as macOS does.
  const linux = firstRun({ ...codeOpen, accounts: two, diagnostics: { ...codeOpen.diagnostics, platform: "linux" } });
  linux.settings = { ...linux.settings, autoSwitchMode: "after-exit" };
  assert.match(item(checklist(render(linux)), "extension"), /İsteğe bağlı/);
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
    return true;
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
  assert.match(html, /Set up Relay/);
  assert.match(html, /Claude app/);
  assert.match(html, /Relay needs the Claude app\./);
  assert.match(html, />Download<\/a>/);
  assert.match(cli, /Relay uses it to read the limits\./);
  assert.match(cli, />Choose file<\/button>/);
  assert.match(html, /Code tab opened/);
  assert.match(html, /Open Code one time from the Claude app sidebar/);
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

test("Today shows from one connected account and says how switching runs; there is no automation card", () => {
  const one = acct("one", "Kişisel", "pro");
  const loose = acct("loose", "Studio", "pro", false);
  const two = acct("two", "Vertex", "pro");
  const usage = { one: use("one", 10, 10) };
  const single = render(relayFor(one, [one, loose], usage));
  const pair = render(relayFor(one, [one, two], usage));
  for (const html of [single, pair]) {
    assert.match(html, /Planlama →/);
    assert.match(html, / · otomatik geçiş kapalı · /);
    assert.doesNotMatch(html, />Otomasyon<\/h2>|>Otomatik geçiş</);
  }
  // Without a Claude app sign-in there is no day to plan.
  assert.doesNotMatch(render(relayFor(loose, [loose], {})), /Planlama →/);
});

test("the welcome says what to do first, in both languages", () => {
  assert.match(render(firstRun()), /İlk hesabını ekle<\/div><p[^>]*>Her hesabı bir kez bağla\. Sonra buradan geç\.<\/p>/);
  assert.match(renderIn("en", firstRun()), /Add your first account<\/div><p[^>]*>Connect each account one time\. Then switch here\.<\/p>/);
});

const welcomeButton = (html: string) => {
  const card = html.slice(0, html.indexOf('aria-label="Relay’i kur"'));
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
  assert.match(html, /İlk hesabını ekle/);
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Hesap ekle<\/button>/);
  assert.doesNotMatch(html, /Hesabı eşleştir/);
});

test("the Overview's one Geç is the suggestion's, filled, and every other account's row opens its page", async () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const vertex = acct("vertex", "Vertex", "pro");
  const alto = acct("alto", "Alto", "pro");
  const studio = acct("studio", "Studio", "pro", false);
  const usage = { active: use("active", 90, 40), vertex: use("vertex", 0, 10), alto: use("alto", 30, 24) };
  const requested: string[] = [];
  const relay = relayFor(active, [active, vertex, alto, studio], usage, {
    suggestion: vertex,
    requestDesktop: (account: Account, kind: string) => void requested.push(`${account.id}:${kind}`),
  });
  const html = render(relay);
  const buttons = switchButtons(html);
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /data-variant="default"[^>]*class="[^"]*bg-primary[^"]*"[^>]*aria-label="Vertex hesabına geç"/);
  // The rows, linked or not, open the account; none of them switches.
  for (const [name, id] of [["Vertex", "vertex"], ["Alto", "alto"], ["Studio", "studio"]]) {
    assert.match(rowFor(html, name), new RegExp(`^ data-account="${id}"[\\s\\S]*?data-list-nav=""[^>]*title="${name}"`), name);
    assert.doesNotMatch(rowFor(html, name), /<button(?! type="button" data-list-nav)/, name);
  }
  // The hero's Geç asks for the switch, as every switch does.
  const dom = fakeDom();
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nValue("tr") },
          createElement(RelayContext.Provider, { value: relay }, createElement(ActiveAccountCard, { go: () => {}, now: NOW })),
        ),
      ),
    );
    const label = (n: Fake) => (n as { attributes?: Map<string, string> }).attributes?.get("aria-label") ?? "";
    const go = find(dom.container as unknown as Fake, (n) => n.tagName === "button" && label(n) === "Vertex hesabına geç");
    assert.ok(go);
    await act(async () => dom.dispatch(go as never, "click", { detail: 1 }));
    assert.deepEqual(requested, ["vertex:switch"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("a full account's row says when its limit opens and leads to its page, and the review says when it opens", async () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const full = acct("full", "Dolu", "pro");
  const usage = { active: use("active", 10, 10), full: use("full", 100, 40, NOW + 90 * 60_000) };
  const relay = relayFor(active, [active, full], usage);
  const row = rowFor(render(relay), "Dolu");
  // Not dimmed: its five hours say it is full, in red, and when it opens.
  assert.doesNotMatch(row, /opacity-60/);
  assert.match(row, /text-crit">Dolu · 1 sa 30 dk<\/span>/);
  // Its row leads to its page, whose switch says when the limit opens (the Accounts tests check it).
  assert.equal(await openRow(relay, "full"), "#/hesaplar/full");
  // The review before the switch says the limit is full and when it opens.
  const review = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("tr") },
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
      { value: i18nValue("tr") },
      createElement(
        RelayContext.Provider,
        { value: relayFor(active, [active, full], { ...usage, full: use("full", 20, 40) }, { desktopRequest: { accountId: "full", kind: "switch" } }) },
        createElement(DesktopActionBody),
      ),
    ),
  );
  assert.doesNotMatch(plain, /switch-full-limit/);
});

test("Overview rows show each account's five hours and week, fade an old reading, and say when a full one opens", () => {
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
  assert.match(rowFor(html, "Fresh"), /role="meter" aria-label="5 saat %20"/);
  assert.match(rowFor(html, "Fresh"), />%30<\/span>/);
  assert.doesNotMatch(rowFor(html, "Fresh"), /opacity-60/);
  // An old reading keeps its figures and bars, faded.
  assert.equal(rowFor(html, "Old").match(/data-slot="limit-line" class="[^"]*opacity-60/g)?.length, 2);
  assert.match(rowFor(html, "Old"), />%30<\/span>/);
  // Never read: a dash in each column.
  assert.equal(rowFor(html, "None").match(/>—<\/span>/g)?.length, 2);
  // A full limit says so in red, with when it opens.
  assert.match(rowFor(html, "Full"), /text-crit">Dolu · 1 sa<\/span>/);
  // Room first, the full one after, the unread one last.
  assert.deepEqual([...listOf(html).matchAll(/data-account="(\w+)"/g)].map((m) => m[1]), ["fresh", "old", "full", "none"]);
});

test("the hero shows the plan, else the subscription, and says when Claude is closed", () => {
  const active = acct("active", "Kişisel", "max5");
  const usage = { active: use("active", 10, 10) };
  // One chip: the provider, then the plan.
  assert.match(render(relayFor(active, [active], usage)), /data-provider="claude" title="Planlama için seçildi">[\s\S]*?Claude<span[^>]*>· Max 5×<\/span>/);
  const subscribed: Account = { ...active, planning: undefined, auth: { ...active.auth!, subscription: "team" } };
  const html = render(relayFor(subscribed, [subscribed], usage));
  assert.match(html, /data-provider="claude" title="Abonelik · planlama için plan seçilmedi">[\s\S]*?Claude<span[^>]*>· Team<\/span>/);
  // Running, the account is in use: a green dot; closed, the status says so in grey.
  assert.match(html, /data-slot="status-label" data-tone="ok"[^>]*><span aria-hidden="true" class="[^"]*bg-ok[^"]*"><\/span><span class="truncate">Açık<\/span>/);
  const closed = render(relayFor(active, [active], usage, {
    desktop: { available: true, running: false, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "active" },
  }));
  assert.match(closed, /data-slot="status-label" data-tone="off"[^>]*><span aria-hidden="true" class="[^"]*bg-muted-foreground\/40[^"]*"><\/span><span class="truncate">Claude kapalı<\/span>/);
  // A used-up limit draws its line red and the status says the account is full.
  const exhausted = render(relayFor(active, [active], { active: use("active", 100, 40, NOW + 3_600_000) }));
  assert.match(exhausted, /role="meter" aria-label="5 saat %100"[^>]*><div class="h-full rounded-full bg-crit"/);
  assert.deepEqual(heroStatus(exhausted), { tone: "crit", title: "Açık · Dolu", text: "Açık · Dolu" });
});

test("the hero says why its switch to the suggestion is disabled", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const other = acct("other", "Vertex", "pro");
  const usage = { active: use("active", 90, 40), other: use("other", 10, 10) };
  const block = (extra: Partial<Relay>) => {
    const html = render(relayFor(active, [active, other], usage, { suggestion: other, ...extra }));
    const start = html.indexOf('data-slot="suggestion"');
    return html.slice(start, html.indexOf("</section>", start));
  };
  assert.doesNotMatch(block({}), /data-slot="switch-reason"/);
  const recovery = { available: true, running: true, organizations: [], busy: false, recoveryRequired: true, errorRevision: 0, activeProfileId: "active" };
  for (const [extra, reason] of [
    [{ desktopBusy: true }, "Claude uygulamasında bir işlem sürüyor."],
    [{ pendingDesktop: other }, "Önce devam eden Claude uygulaması girişini tamamla veya iptal et."],
    [{ desktop: recovery }, "Önce Claude uygulaması yedeğini geri yükle."],
  ] as [Partial<Relay>, string][]) {
    // Disabled, with the reason on its title and under it.
    assert.match(block(extra), new RegExp(`disabled="" title="${reason}" aria-label="Vertex hesabına geç">Geç</button><p data-slot="switch-reason" class="[^"]*">${reason}</p>`), reason);
  }
});

test("the Overview lists Antigravity's accounts on the board: the account the app uses, its pools, and the move to another", () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const google = (id: string, name: string): Account => ({
    id, name, kind: "personal", group: "personal", color: "blue", createdAt: iso(NOW), provider: "antigravity",
    auth: { loggedIn: true, email: `${id}@example.com`, checkedAt: iso(NOW) },
  });
  const g1 = google("g1", "AG 1");
  const g2 = google("g2", "AG 2");
  const models = (carbon: number): AccountUsage => ({
    accountId: "", status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
    fiveHour: { usedPercent: 0, resetsAt: iso(NOW + 5 * 3_600_000) },
    modelWindows: [
      { key: "antigravity_gemini_4_carbon_high", label: "Gemini 4 Carbon (High)", usedPercent: carbon, resetsAt: iso(NOW + 25 * 60_000) },
      { key: "antigravity_gemini_4_argon", label: "Gemini 4 Argon", usedPercent: 0, resetsAt: iso(NOW + 5 * 3_600_000) },
    ],
  });
  const usage = { active: use("active", 10, 10), g1: models(100), g2: models(6) };
  const withApp = (antigravity: Snapshot["antigravity"]) => {
    const relay = relayFor(active, [active, g1, g2], usage);
    relay.data = { ...relay.data!, antigravity };
    return relay;
  };
  // The board's Antigravity group, with the apostrophes renderToStaticMarkup escapes put back.
  const group = (html: string) => {
    const board = listOf(html).replaceAll("&#x27;", "'");
    const start = board.indexOf('data-slot="list-group" data-provider="antigravity"');
    return start < 0 ? "" : board.slice(start);
  };
  const plainRelay = withApp({ installed: true, canOpen: false, accountId: "g1" });
  const plain = group(render(plainRelay));
  // The account the app uses is marked; its spent pool leads, red, with when it opens; the other pool beside it.
  assert.match(plain, /data-account="g1"[\s\S]*?>AG 1<\/button><span[^>]*>açık<\/span>/);
  assert.match(plain, /data-account="g1"[\s\S]*?Gemini 4 Carbon \(High\)[\s\S]*?text-crit">Dolu · 25 dk</);
  assert.match(plain, /data-account="g1"[\s\S]*?data-slot="other-limit"[^>]*><span[^>]*>Gemini 4 Argon %0</);
  // Never the roomiest pool as "%0" for the other account: its own figure.
  assert.match(plain, /data-account="g2"[\s\S]*?>%6</);
  // Not on macOS Relay cannot move the app: no button on the board. The tray's pane walks through it by hand.
  assert.doesNotMatch(plain, /<button(?! type="button" data-list-nav)/);
  const pane = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("tr") },
      createElement(
        RelayContext.Provider,
        { value: plainRelay },
        createElement(ProviderPane, { view: relayProviders(plainRelay, NOW).find((v) => v.id === "antigravity")!, now: NOW }),
      ),
    ),
  ).replaceAll("&#x27;", "'");
  assert.match(pane, /Antigravity'de hesap menüsünden çıkış yap/);
  // The Antigravity accounts are not in the Claude group.
  const claude = listOf(render(plainRelay)).slice(0, listOf(render(plainRelay)).indexOf('data-provider="antigravity"'));
  assert.doesNotMatch(claude, /data-account="g\d"/);
  // On macOS with both sign-ins kept: the other account's one button moves the app there.
  const saved = group(render(withApp({ installed: true, canOpen: true, canSwitch: true, accountId: "g1", saved: ["g1", "g2"] })));
  assert.match(saved, /<button[^>]*aria-label="Antigravity'yi AG 2 hesabına geçir">Geç<\/button>/);
  assert.doesNotMatch(saved, /hesap menüsünden çıkış yap/);
  const unsaved = group(render(withApp({ installed: true, canOpen: true, canSwitch: true, accountId: "g1", saved: ["g1"] })));
  assert.match(unsaved, />Girişi kaydet<\/button>/);
  const done = group(render(withApp({ installed: true, canOpen: true, canSwitch: true, accountId: "g2", saved: ["g1", "g2"], result: { kind: "switched", accountId: "g2", agyRunning: 1, at: NOW - 1000 } })));
  assert.match(done, /data-slot="antigravity-result"[^>]*>AG 2 hesabına geçildi · açık 1 agy eski hesapta, yeniden başlat/);
  const failed = group(render(withApp({ installed: true, canOpen: true, canSwitch: true, accountId: "g1", saved: ["g1", "g2"], result: { kind: "failed", accountId: "g2", reason: "still-running", at: NOW - 1000 } })));
  assert.match(failed, /Antigravity kapanmadı/);
  const waiting = group(render(withApp({ installed: true, canOpen: true, canSwitch: true, saved: ["g1"], busy: "signing-in", signInFor: "g2" })));
  assert.match(waiting, /data-slot="antigravity-sign-in"[\s\S]*Antigravity'de <b>AG 2<\/b>/);
  // Without Antigravity accounts there is no Antigravity group.
  assert.doesNotMatch(render(relayFor(active, [active], { active: use("active", 10, 10) })), /data-provider="antigravity"/);
});

test("on macOS an Antigravity account's button asks first, and the confirmation switches", async () => {
  const active = acct("active", "Kişisel · Max", "max5");
  const google = (id: string, name: string): Account => ({
    id, name, kind: "personal", group: "personal", color: "blue", createdAt: iso(NOW), provider: "antigravity",
    auth: { loggedIn: true, email: `${id}@example.com`, checkedAt: iso(NOW) },
  });
  const models = (carbon: number): AccountUsage => ({
    accountId: "", status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
    modelWindows: [{ key: "antigravity_gemini_4_carbon_high", label: "Gemini 4 Carbon (High)", usedPercent: carbon, resetsAt: iso(NOW + 25 * 60_000) }],
  });
  const relay = relayFor(active, [active, google("g1", "AG 1"), google("g2", "AG 2")], { active: use("active", 10, 10), g1: models(100), g2: models(6) });
  relay.data = { ...relay.data!, antigravity: { installed: true, canOpen: true, canSwitch: true, accountId: "g1", saved: ["g1", "g2"] } };
  const calls: string[] = [];
  (relay as any).action = async (_key: string, fn: () => Promise<unknown>) => fn();
  (relay as any).api = { switchAntigravity: async (id: string) => void calls.push(`switch:${id}`) };
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const { AccountsBoard } = await import("../src/pages/overview/AccountsBoard");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nValue("tr") },
          createElement(RelayContext.Provider, { value: relay }, createElement(AccountsBoard, { now: NOW })),
        ),
      ),
    );
    const label = (n: Fake) => (n as { attributes?: Map<string, string> }).attributes?.get("aria-label") ?? "";
    const ask = find(dom.container as unknown as Fake, (n) => n.tagName === "button" && label(n) === "Antigravity'yi AG 2 hesabına geçir");
    await act(async () => dom.dispatch(ask as never, "click", { detail: 1 }));
    assert.match(textOf(dom.container as unknown as Fake), /Antigravity kapanıp AG 2 ile açılır\. Çalışan işler durur\./);
    assert.deepEqual(calls, [], "asking does not switch");
    const confirm = find(dom.container as unknown as Fake, (n) => n.tagName === "button" && textOf(n).trim() === "Geç" && !label(n));
    await act(async () => dom.dispatch(confirm as never, "click", { detail: 1 }));
    assert.deepEqual(calls, ["switch:g2"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});
