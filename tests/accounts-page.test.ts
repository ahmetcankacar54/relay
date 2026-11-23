import test from "node:test";
import type { TerminalStatus } from "../shared/terminal-identity";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Accounts, AccountsEmpty } from "../src/pages/Accounts";
import { AccountDetail, accountFromHash, accountHash } from "../src/pages/accounts/AccountDetail";
import { AccountDetailBody, historyLine } from "../src/pages/accounts/account-detail/Body";
import { AddAccountSteps } from "../src/pages/accounts/AddAccountDialog";
import { AccountsTable, rowActions } from "../src/pages/accounts/AccountsTable";
import { RemoveAccountBody, removedNotice } from "../src/pages/accounts/RemoveAccountDialog";
import { accountPlan, filterAccounts, groupName, planLabel } from "../src/pages/accounts/accountLabels";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { i18nValue, testT } from "./i18n";
import { fakeDom } from "./fake-dom";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type AuthFlow, type ExtensionStatus, type Snapshot, type UsageIssue } from "../shared/types";

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
    api: {
      desktopHistorySummary: () => new Promise(() => {}),
      extensionStatus: async () => undefined,
      checkExtension: async () => undefined,
      terminalStatus: async () => undefined,
      checkTerminal: async () => undefined,
    },
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
      { value: i18nValue("tr") },
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
  const t = testT("tr");
  assert.equal(groupName(a, t), "Kişisel");
  assert.equal(groupName(w, t), "Ekip");
  assert.equal(groupName({ ...w, group: "work:w" }, t), "Ayrı çalışma alanı");
});

/** The list's rows, in order: each starts at its `data-slot="list-row"`. */
const listRows = (html: string) => html.split('data-slot="list-row"').slice(1);
/** A reading taken a minute ago, so the account reads as fresh against the clock the list uses. */
const readNow = (value: AccountUsage): AccountUsage => ({ ...value, checkedAt: new Date(Date.now() - 60_000).toISOString() });

test("the accounts page lists accounts with their status and limits", () => {
  const html = wrap(relayFor({ data: { settings: DEFAULT_SETTINGS, usage: { ...usage, a: readNow(usage.a) }, accounts, authFlows: [] } as unknown as Snapshot }), createElement(Accounts));
  assert.match(html, /<h1[^>]*>Hesaplar/);
  // The description is the count alone; which accounts are linked is each row's status.
  assert.match(html, /<p[^>]*>3 hesap<\/p>/);
  assert.doesNotMatch(html, /hesapta Claude uygulaması girişi kayıtlı/);
  assert.match(html, /Hesap ekle/);
  assert.match(html, /placeholder="Ara…"/);
  for (const name of ["Kişisel · Max", "Studio", "Şirket"]) assert.match(html, new RegExp(name));
  assert.match(html, /Max 5×/);
  // Two lines per account, no column header: the status under the name, each limit labelled.
  assert.doesNotMatch(html, /data-slot="list-head"/);
  for (const row of listRows(html)) assert.match(row, /data-slot="row-limits"[^>]*>.*>5 saat<.*>Hafta</);
  const [active, studio, work] = listRows(html);
  assert.match(active, /data-slot="status-label" data-tone="ok"[^>]*>.*>Kullanımda<\/span>/);
  assert.match(studio, /data-slot="status-label" data-tone="off" title="Claude uygulaması girişi yok"[^>]*>.*>Uygulama girişi yok<\/span>/);
  assert.match(work, />Uygulama girişi yok<\/span>/);
  assert.doesNotMatch(html, /Bağlı değil|Süresi doldu/);
  // Each limit is a percent with a short bar under it.
  assert.match(active, />%38<.*role="meter" aria-label="5 saat %38"/);
  assert.match(active, />%78<.*role="meter" aria-label="Hafta %78"/);
  // The connections and the e-mails are on the account's page, not in the list.
  assert.doesNotMatch(html, /Bağlantılar|aria-label="Claude uygulaması: kayıtlı"|aria-label="Limit okuma girişi: Bağlı"|data-slot="connection-legend"/);
  assert.doesNotMatch(html, /a@example\.com|deniz\.kaya@vertex\.com/);
  assert.match(html, /aria-label="Studio işlemleri"/);
});

test("the accounts list has one Durum column with a fix button only where something is wrong", () => {
  const critical: Account = { ...a, id: "k", name: "Yenilenecek" };
  const table = (list: Account[], language: "tr" | "en" = "tr", relay: Partial<Relay> = {}) =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: i18nValue(language) },
        createElement(
          RelayContext.Provider,
          {
            value: relayFor({
              data: {
                settings: DEFAULT_SETTINGS,
                usage: { ...usage, a: readNow(usage.a), k: { accountId: "k", status: "error", issue: "expired", stale: true } },
                accounts: list,
                authFlows: [],
              } as unknown as Snapshot,
              ...relay,
            }),
          },
          createElement(AccountsTable, { accounts: list, open() {}, link() {} }),
        ),
      ),
    );
  const html = table([a, critical, b]);
  assert.doesNotMatch(html, /data-slot="list-head"/);
  assert.match(listRows(table([a], "en"))[0], /data-slot="row-limits"[^>]*>.*>5 hours<.*>Week</);
  const [okRow, critRow, offRow] = listRows(html);
  // An ok row shows its status and no inline button; only the ⋯ menu button is there.
  assert.match(okRow, />Kullanımda<\/span>/);
  assert.doesNotMatch(okRow, /data-size="xs"/);
  // A crit row says it in a few words, the full reason in the title, and offers the fix in one word.
  assert.match(critRow, /data-slot="status-label" data-tone="crit" title="Limit okuma girişi gerekli"[^>]*>.*>Giriş gerekli<\/span>/);
  // The button's name is the menu item's label and says which account it is for.
  assert.match(
    critRow,
    /<button[^>]*data-variant="outline"[^>]*data-size="xs"[^>]*aria-label="Limit okuma girişini yenile · Yenilenecek" title="Limit okuma girişini yenile">Bağla<\/button>/,
  );
  // An off row offers to save the Claude app sign-in.
  assert.match(offRow, />Uygulama girişi yok<\/span>/);
  assert.match(offRow, /<button[^>]*data-size="xs"[^>]*aria-label="Claude uygulaması girişini kaydet · Studio"[^>]*>Kaydet<\/button>/);
  // At most one visible step per row.
  for (const row of [critRow, offRow]) assert.equal(row.match(/data-size="xs"/g)?.length, 1);
  // The inline button takes the row action's disabled state.
  const locked = table([critical], "tr", { busy: "x" });
  assert.match(locked, /<button[^>]*disabled=""[^>]*data-size="xs"|<button[^>]*data-size="xs"[^>]*disabled=""/);
  // The words follow the language.
  assert.match(table([critical], "en"), /title="Usage sign-in needed"[^>]*>.*>Sign-in needed<\/span>/);
  assert.match(table([critical], "en"), /data-size="xs"[^>]*aria-label="Renew usage sign-in · Yenilenecek"[^>]*>Connect<\/button>/);
});

/** An account's usage, as the relay's snapshot reports it. */
const usageOf = (id: string, issue?: UsageIssue, extra: Partial<AccountUsage> = {}): AccountUsage =>
  ({ accountId: id, status: issue ? "error" : "ready", stale: !!issue, issue, ...extra }) as AccountUsage;
const relayWithUsage = (id: string, value: AccountUsage | undefined, extra: Partial<Relay> = {}) =>
  relayFor({
    data: { settings: DEFAULT_SETTINGS, usage: { [id]: value }, accounts, authFlows: [] } as unknown as Snapshot,
    ...extra,
  });

test("the menu offers a prompting renewal only while the Keychain or the connection needs it", () => {
  const en = testT("en");
  const keys = (relay: Relay) => rowActions(a, relay, en, "en").map((x) => x.key);
  const renew = (relay: Relay, language: "tr" | "en" = "tr") =>
    rowActions(a, relay, testT(language), language).find((x) => x.key === "renew");
  for (const value of [undefined, usageOf("a"), usageOf("a", "expired"), usageOf("a", "scope"), usageOf("a", "rate-limited"), usageOf("a", "unavailable")])
    assert.ok(!keys(relayWithUsage("a", value)).includes("renew"), String(value?.issue));
  // Offered for a locked Keychain, with its own wording.
  const keychain = renew(relayWithUsage("a", usageOf("a", "keychain-locked")));
  assert.equal(keychain?.label, "Anahtarlık erişimine izin ver");
  assert.equal(renew(relayWithUsage("a", usageOf("a", "keychain-locked")), "en")?.label, "Allow Keychain access");
  // Offered for a connection to renew, however it is reported.
  for (const value of [usageOf("a", "renewal-required"), usageOf("a", undefined, { connectionRenewalRequired: true })]) {
    assert.equal(renew(relayWithUsage("a", value))?.label, "Yenilemeye izin ver");
    assert.equal(renew(relayWithUsage("a", value), "en")?.label, "Allow renewal");
  }
  // It sits with the sign-in items, before Refresh limits.
  assert.deepEqual(keys(relayWithUsage("a", usageOf("a", "renewal-required"))), [
    "open", "cli", "renew", "desktop-reconnect", "refresh", "remove",
  ]);
  // It asks the Keychain, where Refresh limits does not: the prompt is the fix.
  const calls: unknown[][] = [];
  const relay = relayWithUsage("a", usageOf("a", "keychain-locked"), {
    refreshUsage: async (...args: unknown[]) => void calls.push(args),
  } as Partial<Relay>);
  const items = rowActions(a, relay, testT("tr"), "tr");
  items.find((x) => x.key === "renew")!.run();
  items.find((x) => x.key === "refresh")!.run();
  assert.deepEqual(calls, [[a, true], [a]]);
  // It is disabled exactly when Refresh limits is.
  for (const usageBusy of [new Set<string>(), new Set(["a"])]) {
    const busy = rowActions(a, relayWithUsage("a", usageOf("a", "keychain-locked"), { usageBusy }), testT("tr"), "tr");
    assert.equal(busy.find((x) => x.key === "renew")?.disabled, usageBusy.has("a"));
    assert.equal(busy.find((x) => x.key === "renew")?.disabled, busy.find((x) => x.key === "refresh")?.disabled);
  }
});

test("a row with a locked Keychain or a connection to renew offers that renewal inline, by account name", () => {
  const row = (value: AccountUsage, language: "tr" | "en" = "tr") =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: i18nValue(language) },
        createElement(
          RelayContext.Provider,
          { value: relayWithUsage("a", value) },
          createElement(AccountsTable, { accounts: [a], open() {}, link() {} }),
        ),
      ),
    );
  // The status is short, its reason the title; the button is one word, named in full for assistive technology.
  const keychain = row(usageOf("a", "keychain-locked"));
  assert.match(keychain, /data-slot="status-label"[^>]*title="Anahtarlık izni gerekli"[^>]*>.*>Anahtarlık izni<\/span>/);
  assert.match(
    keychain,
    /<button[^>]*data-size="xs"[^>]*aria-label="Anahtarlık erişimine izin ver · Kişisel · Max" title="Anahtarlık erişimine izin ver">Yenile<\/button>/,
  );
  const renewing = row(usageOf("a", "renewal-required"));
  assert.match(renewing, /title="Bağlantı yenilenmeli"[^>]*>.*>Yenilenmeli<\/span>/);
  assert.match(renewing, /aria-label="Yenilemeye izin ver · Kişisel · Max"[^>]*>Yenile<\/button>/);
  assert.match(row(usageOf("a", undefined, { connectionRenewalRequired: true }), "en"), /aria-label="Allow renewal · Kişisel · Max"[^>]*>Renew<\/button>/);
});

/** The drawn tree, read from the fake DOM. */
interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  childNodes: FakeNode[];
}
const drawn = (node: FakeNode, found: FakeNode[] = []): FakeNode[] => {
  found.push(node);
  for (const child of node.childNodes) drawn(child, found);
  return found;
};

test("the inline fix button runs its action and does not also open the sheet", async () => {
  const critical: Account = { ...a, id: "k", name: "Yenilenecek" };
  const started: string[] = [];
  const opened: string[] = [];
  const relay = relayWithUsage("k", usageOf("k", "expired"), {
    accounts: [critical],
    startCli: async (account: Account) => (started.push(account.id), "ran" as const),
  } as Partial<Relay>);
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
          createElement(
            RelayContext.Provider,
            { value: relay },
            createElement(AccountsTable, { accounts: [critical], open: (id) => void opened.push(id), link() {} }),
          ),
        ),
      ),
    );
    const all = drawn(dom.container as unknown as FakeNode);
    const fix = all.find((n) => n.tagName === "button" && n.attributes.get("data-size") === "xs");
    assert.ok(fix, "the inline fix button is drawn");
    assert.equal(fix.attributes.get("aria-label"), "Limit okuma girişini yenile · Yenilenecek");
    await act(async () => dom.dispatch(fix, "click", { detail: 1 }));
    assert.deepEqual(started, ["k"], "it runs the row action");
    assert.deepEqual(opened, [], "and the click stops at the button");
    // The same click on the row itself opens the sheet, so the check above is not vacuous.
    const row = all.find((n) => n.attributes?.get("data-slot") === "list-row");
    assert.ok(row, "the row is drawn");
    await act(async () => dom.dispatch(row, "click", { detail: 1 }));
    assert.deepEqual(opened, ["k"]);
    assert.deepEqual(started, ["k"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("while a search shows every match, the section headers are labels and leave the saved closed set alone", async () => {
  const stored: Record<string, string> = { "relay.accounts.collapsed": JSON.stringify(["provider:claude"]) };
  const writes: string[] = [];
  const dom = fakeDom({
    localStorage: () => ({ getItem: (key: string) => stored[key] ?? null, setItem: (key: string) => void writes.push(key) }),
  });
  dom.install();
  Object.assign(globalThis.window, { location: { hash: "" } });
  Object.assign(globalThis.document, { querySelector: () => null });
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nValue("tr") },
          createElement(RelayContext.Provider, { value: relayFor() }, createElement(Accounts)),
        ),
      ),
    );
    const headers = () => drawn(dom.container as unknown as FakeNode).filter((n) => n.attributes?.get("data-slot") === "list-group");
    const rows = () => drawn(dom.container as unknown as FakeNode).filter((n) => n.attributes?.get("data-slot") === "list-row");
    // Closed and not searching: the provider's header is a button and its rows are not drawn.
    assert.equal(headers()[0]?.tagName, "button");
    assert.equal(rows().length, 0);
    const input = drawn(dom.container as unknown as FakeNode).find((n) => n.tagName === "input" && n.attributes.get("placeholder") === "Ara…");
    assert.ok(input, "the search field is drawn");
    await act(async () => {
      // React reads a text field's `type` property, which the fake keeps only as an attribute.
      Object.assign(input, { type: input.attributes.get("type") ?? "text", value: "Stu" });
      dom.dispatch(input, "input");
    });
    // The match shows, its closed section opened for it, and no header is a button that could close it.
    assert.equal(rows().length, 1);
    assert.ok(headers().length > 0);
    for (const header of headers()) assert.equal(header.tagName, "div");
    for (const header of headers()) await act(async () => dom.dispatch(header, "click", { detail: 1 }));
    assert.deepEqual(writes, []);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("accountPlan names a Claude account's tier, else its subscription, else nothing", () => {
  const plan = (account: Account) => {
    const found = accountPlan(account);
    return found && { label: found.label, source: found.source };
  };
  // The plan picked for planning wins over the subscription word.
  assert.deepEqual(plan({ ...a, auth: { ...a.auth!, subscription: "team" } }), { label: "Max 5×", source: "chosen" });
  // The tier read from the sign-in is detected.
  assert.deepEqual(plan({ ...a, auth: { ...a.auth!, plan: "max5" } }), { label: "Max 5×", source: "detected" });
  // Without one, the subscription the usage sign-in reported.
  const unplanned = (subscription?: string): Account => ({ ...a, planning: undefined, auth: { ...a.auth!, subscription } });
  assert.deepEqual(plan(unplanned("max")), { label: "Max", source: "detected" });
  assert.deepEqual(plan(unplanned("pro")), { label: "Pro", source: "detected" });
  assert.deepEqual(plan(unplanned("team")), { label: "Team", source: "detected" });
  assert.deepEqual(plan(unplanned("enterprise")), { label: "Enterprise", source: "detected" });
  assert.deepEqual(plan(unplanned("custom")), { label: "Custom", source: "detected" });
  // An "unknown" plan is not a plan.
  assert.deepEqual(plan({ ...unplanned("max"), planning: { plan: "unknown", capacityWeight: 1 } }), { label: "Max", source: "detected" });
  // Neither known.
  assert.equal(accountPlan(unplanned(undefined)), undefined);
  assert.equal(accountPlan(unplanned("unknown")), undefined);
  assert.equal(accountPlan({ ...a, planning: undefined, auth: undefined }), undefined);
});

test("an account without a plan shows its subscription beside its name, saying so, or nothing", () => {
  const noPlan: Account = { ...b, planning: undefined };
  const subscribed: Account = { ...w, id: "s", planning: undefined, auth: { ...w.auth!, subscription: "team" } };
  const html = (language: "tr" | "en") =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: i18nValue(language) },
        createElement(
          RelayContext.Provider,
          { value: relayFor() },
          createElement(AccountsTable, { accounts: [noPlan, subscribed, a], open() {}, link() {} }),
        ),
      ),
    );
  const tr = html("tr");
  assert.doesNotMatch(tr, /Plan yok|No plan/);
  // The short plan sits beside the name, its source in the title; an account with neither shows none.
  // Claude's accounts span two work groups, so the personal ones come first, then the team's.
  const [none, chosen, team] = listRows(tr);
  // No plan tag; the only thing beside the name is its work group.
  assert.match(none, /title="Studio">Studio<\/button>/);
  assert.doesNotMatch(none, /rounded-sm bg-secondary px-1\.5 py-px/);
  assert.match(team, /title="Şirket">Şirket<\/button><span[^>]*title="Abonelik · planlama için plan seçilmedi">Team<\/span>/);
  assert.doesNotMatch(tr, /Plan seç/);
  assert.match(html("en"), /title="Subscription · no plan selected for planning">Team<\/span>/);
  // A chosen plan says so.
  assert.match(chosen, /<span[^>]*title="Planlama için seçildi">Max 5×<\/span>/);
});

test("the accounts page shows the empty state", () => {
  const html = wrap(relayFor({ accounts: [], active: undefined }), createElement(Accounts));
  assert.match(html, /<h3[^>]*>Henüz hesap yok<\/h3>/);
  assert.match(html, /Önce Claude uygulamasında açık hesabı ekle\./);
  assert.match(html, /data-scene="welcome"/);
});

test("an account page lives at #/hesaplar/<id>", () => {
  assert.equal(accountHash("a b"), "#/hesaplar/a%20b");
  assert.equal(accountFromHash("#/hesaplar/a%20b"), "a b");
  assert.equal(accountFromHash("#/hesaplar"), undefined);
  assert.equal(accountFromHash("#/hesaplar?ekle"), undefined);
  assert.equal(accountFromHash("#/genel"), undefined);
  // A malformed escape is no account, not a thrown URIError.
  assert.equal(accountFromHash("#/hesaplar/%E0%A4%A"), undefined);
  assert.equal(accountFromHash("#/hesaplar/%"), undefined);
});

test("each connection keeps its refresh button left of its action, in shared columns, with a plain check", () => {
  const html = wrap(relayFor(), createElement(AccountDetailBody, { account: a, now: NOW }));
  // One grid for the list; each row is a subgrid of it, so the columns line up across rows.
  assert.match(html, /data-slot="connection-list" class="grid grid-cols-\[auto_minmax\(0,1fr\)_auto_auto\]/);
  const rows = html.split('data-slot="connection"').slice(1);
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.match(row, /grid-cols-subgrid/);
    assert.ok(row.indexOf('data-slot="connection-refresh"') < row.indexOf('data-slot="connection-action"'));
  }
  // The usage sign-in row: the refresh button, then Renew.
  const usage = rows.find((r) => r.includes("Limit okuma girişi")) ?? "";
  assert.match(usage, /data-slot="connection-refresh"[^>]*><button[^>]*aria-label="Limit okuma girişini doğrula"[\s\S]*data-slot="connection-action"[^>]*><button[^>]*>Yenile<\/button>/);
  // The leading check has no ground of its own.
  const mark = /<span aria-hidden="true" class="([^"]*)"/.exec(rows[0])?.[1] ?? "";
  assert.match(mark, /size-5/);
  assert.doesNotMatch(mark, /bg-/);
});

test("the account page shows identity, usage, the connections and a closed history", () => {
  const html = wrap(relayFor(), createElement(AccountDetailBody, { account: a, now: NOW }));
  assert.match(html, /a@example.com/);
  // Three sections, each titled above its card; the plan is set on the Planning page, not here.
  assert.deepEqual([...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]), ["Limitler", "Bağlantılar", "Hesap"]);
  assert.doesNotMatch(html, /<h2[^>]*>Planlama<\/h2>/);
  assert.match(html, /<dt[^>]*>Planda<\/dt><dd[^>]*><a href="#\/planlama"[^>]*>Evet · Planlama ›<\/a>/);
  // The limits read as lines: name, percent and a meter.
  assert.match(html, /role="meter" aria-label="5 saat %38"/);
  assert.match(html, /role="meter" aria-label="Hafta %78"/);
  // The connections are always shown, each one line: its name (what it is for on hover), state and action.
  assert.match(html, /data-slot="connections"/);
  assert.match(html, /<span[^>]*title="Claude uygulamasını bu hesapla açar\.">Claude uygulaması<\/span>/);
  assert.match(html, />Yenile…<\/button>/);
  assert.match(html, /<span[^>]*title="Limitleri okur\.">Limit okuma girişi<\/span>/);
  assert.match(html, /aria-label="Limit okuma girişini doğrula"/);
  // Secondary buttons are outline.
  assert.match(html, /<button[^>]*data-variant="outline"[^>]*>Yenile…<\/button>/);
  assert.match(html, /<h2[^>]*>Bağlantılar<\/h2><div[^>]*><span[^>]*>2 \/ 2 hazır<\/span>/);
  // History is a disclosure that starts closed, saying whether it is shared.
  assert.equal(disclosureState(html, "Code geçmişi"), "false");
  assert.match(html, /data-slot="disclosure-summary"[^>]*>paylaşılmıyor</);
  // There is no status strip: the header says it.
  assert.doesNotMatch(html, /data-slot="account-status"/);
  assert.doesNotMatch(html, /Desktop girişi|tarayıcı girişi|Tarayıcı girişi/);
});

// A second account with its Claude app sign-in saved, so it can be switched to; `a` stays the active one.
const c: Account = { ...a, id: "c", name: "Üçüncü" };
const relayOf = (extra: Partial<Relay> = {}, usageFor: Record<string, AccountUsage> = {}, authFlows: unknown[] = []) =>
  relayFor({
    data: { settings: DEFAULT_SETTINGS, usage: { ...usage, ...usageFor }, accounts: [...accounts, c], authFlows } as unknown as Snapshot,
    accounts: [...accounts, c],
    ...extra,
  });
const sheetFor = (account: Account, extra: Partial<Relay> = {}, usageFor: Record<string, AccountUsage> = {}, authFlows: unknown[] = []) =>
  wrap(relayOf(extra, usageFor, authFlows), createElement(AccountDetailBody, { account, now: NOW }));
/** The page header: the name, the health pill and the actions. */
const headerOf = (account: Account, extra: Partial<Relay> = {}, usageFor: Record<string, AccountUsage> = {}, authFlows: unknown[] = []) => {
  const html = wrap(
    relayOf(extra, usageFor, authFlows),
    createElement(AccountDetail, { account, back() {} }),
  );
  return html.slice(html.indexOf("<header"), html.indexOf("</header>"));
};
/** The page header's primary actions: buttons other than Back and the ⋯ menu. */
const primaryButtons = (header: string) =>
  (header.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? []).filter(
    (b) => !/aria-haspopup="menu"/.test(b) && !/>Hesaplar<\/button>$/.test(b),
  );
const disclosureState = (html: string, title: string) =>
  new RegExp(`<button[^>]*aria-expanded="(true|false)"[^>]*><span[^>]*>${title}</span>`).exec(html)?.[1];
const expiredC: Record<string, AccountUsage> = { c: { accountId: "c", status: "error", issue: "expired", stale: true } };

/** A status label's tone, title and words. */
const statusOf = (html: string) =>
  /data-slot="status-label" data-tone="(\w+)" title="([^"]*)"[^>]*><span[^>]*><\/span><span[^>]*>([^<]*)<\/span>/.exec(html)?.slice(1);

test("the page header shows the status and one primary action, with the rest in its menu", () => {
  // A fix wins: the fix's row-action label. The page header has room, so it says the reason itself
  // (the list says the few words, the reason as their title), in the same tone.
  const crit = headerOf(c, {}, expiredC);
  assert.deepEqual(statusOf(crit), ["crit", "Limit okuma girişi gerekli", "Limit okuma girişi gerekli"]);
  assert.equal(primaryButtons(crit).length, 1);
  assert.match(primaryButtons(crit)[0], />Limit okuma girişini yenile<\/button>$/);
  assert.match(crit, /aria-label="Üçüncü işlemleri"/);
  assert.match(crit, />Hesaplar<\/button>/);
  // The header shows the account's dot, not a letter avatar, and one chip with the provider and plan.
  assert.match(crit, /<span aria-hidden="true" class="[^"]*rounded-full[^"]*bg-account-olive/);
  assert.match(crit, /data-slot="badge"[^>]*data-provider="claude"[^>]*>.*Claude<span[^>]*>· Max 5×<\/span><\/span>/);
  // No Proxy button in the header.
  assert.doesNotMatch(crit, />Proxy</);
  const unlinked = headerOf(b);
  assert.deepEqual(statusOf(unlinked), ["off", "Claude uygulaması girişi yok", "Claude uygulaması girişi yok"]);
  assert.match(primaryButtons(unlinked)[0], />Claude uygulaması girişini kaydet<\/button>$/);
  // No fix and not the active account: switch.
  const ready = headerOf(c, {}, { c: readNow({ ...usage.a, accountId: "c" }) });
  assert.deepEqual(statusOf(ready), ["ok", "Hazır", "Hazır"]);
  assert.equal(primaryButtons(ready).length, 1);
  assert.match(primaryButtons(ready)[0], />Geç<\/button>$/);
  // A pending approval has no fix either, so it offers the switch.
  const waiting = headerOf(c, {}, {}, [{ accountId: "c", status: "waiting" }]);
  assert.match(waiting, /Tarayıcıda onayla/);
  assert.match(primaryButtons(waiting)[0], />Geç<\/button>$/);
  // No fix and the account in use: nothing to do.
  const active = headerOf(a, {}, { a: readNow(usage.a) });
  assert.deepEqual(statusOf(active), ["ok", "Kullanımda", "Kullanımda"]);
  assert.equal(primaryButtons(active).length, 0);
  // The same status the list shows for the account.
  const listed = wrap(relayOf({}, expiredC), createElement(AccountsTable, { accounts: [c], open() {}, link() {} }));
  assert.deepEqual(statusOf(listed), ["crit", "Limit okuma girişi gerekli", "Giriş gerekli"]);
});

test("a problem is said by the header's status; the usage row agrees with it, and there is no strip", () => {
  const header = (usageFor: Record<string, AccountUsage>) => statusOf(headerOf(c, {}, usageFor));
  const keychain = sheetFor(c, {}, { c: usageOf("c", "keychain-locked") });
  assert.deepEqual(header({ c: usageOf("c", "keychain-locked") }), ["warn", "Anahtarlık izni gerekli", "Anahtarlık izni gerekli"]);
  const renewing = sheetFor(c, {}, { c: usageOf("c", "renewal-required") });
  assert.deepEqual(header({ c: usageOf("c", "renewal-required") })?.slice(1), ["Bağlantı yenilenmeli", "Bağlantı yenilenmeli"]);
  assert.deepEqual(header(expiredC)?.slice(1), ["Limit okuma girişi gerekli", "Limit okuma girişi gerekli"]);
  // The strip under the header is gone: the header says it once.
  for (const html of [keychain, renewing, sheetFor(c, {}, expiredC), sheetFor(b)]) assert.doesNotMatch(html, /data-slot="account-status"/);
  // The usage row says what the header says, not "Bağlı" under a green dot.
  const usageRow = (html: string) =>
    /Limit okuma girişi<\/span><span[^>]*><span[^>]*class="[^"]*(bg-\w+)[^"]*"[^>]*><\/span><span[^>]*>([^<]*)/.exec(html);
  assert.deepEqual(usageRow(renewing)?.slice(1), ["bg-warn", "Yenilenmeli"]);
  assert.doesNotMatch(renewing, />Bağlı</);
  assert.deepEqual(usageRow(keychain)?.slice(1), ["bg-warn", "Bağlı · Anahtarlık izni gerekli"]);
  assert.deepEqual(usageRow(sheetFor(c, {}, expiredC))?.slice(1), ["bg-crit", "Gerekli"]);
  // A connection reported only by the flag reads the same.
  assert.equal(usageRow(sheetFor(c, {}, { c: usageOf("c", undefined, { connectionRenewalRequired: true }) }))?.[2], "Yenilenmeli");
  const healthy = usageRow(sheetFor(c, {}, { c: usageOf("c") }));
  assert.deepEqual(healthy?.slice(1), ["bg-ok", "Bağlı"]);
});

test("this account's sign-in flow shows inside its usage row, and only there", () => {
  const failed = { id: "f", accountId: "a", status: "failed", error: "Sign-in failed badly" } as unknown as AuthFlow;
  const withFlow = sheetFor(a, { flow: failed, flowAccount: a });
  assert.match(withFlow, /Sign-in failed badly/);
  // The page frame does not draw it a second time.
  const page = wrap(relayOf({ flow: failed, flowAccount: a }), createElement(AccountDetail, { account: a, back() {} }));
  assert.equal(page.match(/Sign-in failed badly/g)?.length, 1);
  // Another account's flow is not drawn in this one.
  assert.doesNotMatch(sheetFor(a, { flow: { ...failed, accountId: "b" } as unknown as AuthFlow, flowAccount: b }), /Sign-in failed badly/);
});

test("the Claude app setup opens under its row for this account only", () => {
  const healthy = { c: { ...usage.a, accountId: "c" } };
  const setup = /aria-label="Claude uygulaması girişi"/;
  assert.doesNotMatch(sheetFor(c, {}, healthy), setup);
  assert.match(sheetFor(c, { setupId: "c" }, healthy), setup);
  assert.doesNotMatch(sheetFor(c, { setupId: "b" }, healthy), setup);
  const relay = relayFor({ setupId: "b" });
  const html = wrap(relay, createElement(AccountDetailBody, { account: b, now: NOW }));
  assert.match(html, setup);
  assert.match(html, /Bu hesaba geçmek için Claude uygulaması girişini bir kez kaydet\./);
  assert.match(html, />Girişi kaydet<\/button>/);
  assert.doesNotMatch(html, /Yerel Code geçmişi/);
});

test("sign-ins of two different accounts are said on the page and fixed from its header", () => {
  const mismatched: Account = { ...a, auth: { loggedIn: true, accountUuid: "other", checkedAt: iso(NOW) } };
  const html = wrap(relayFor(), createElement(AccountDetailBody, { account: mismatched, now: NOW }));
  assert.match(
    html,
    /Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait\. Limit okuma girişini bu profilin hesabıyla yenile\./,
  );
  const head = headerOf(mismatched);
  assert.deepEqual(statusOf(head), ["crit", "Limit okuma girişi gerekli", "Limit okuma girişi gerekli"]);
  assert.match(primaryButtons(head)[0], />Limit okuma girişi yap<\/button>$/);
});

test("a table row whose sign-ins belong to different accounts needs the usage sign-in", () => {
  const mismatched: Account = { ...c, auth: { loggedIn: true, email: "c@example.com", accountUuid: "other", checkedAt: iso(NOW) } };
  const html = wrap(
    relayFor({ accounts: [mismatched], data: { settings: DEFAULT_SETTINGS, usage: { c: { ...usage.a, accountId: "c" } }, accounts: [mismatched], authFlows: [] } as unknown as Snapshot }),
    createElement(AccountsTable, { accounts: [mismatched], open() {}, link() {} }),
  );
  assert.deepEqual(statusOf(html), ["crit", "Limit okuma girişi gerekli", "Giriş gerekli"]);
  assert.match(html, /aria-label="Limit okuma girişini yenile · Üçüncü"[^>]*>Bağla<\/button>/);
});

test("row actions follow the Desktop link state and the switch lock", () => {
  const t = testT("tr");
  const labels = (acct: Account, relay: Relay) => rowActions(acct, relay, t, "tr").map((x) => x.label);
  const relay = relayFor();
  assert.deepEqual(labels(a, relay), [
    "Claude uygulamasını aç",
    "Limit okuma girişini yenile",
    "Claude uygulaması girişini yenile…",
    "Limitleri yenile",
    "Hesabı kaldır",
  ]);
  assert.deepEqual(labels(b, relay), [
    "Limit okuma girişi yap",
    "Claude uygulaması girişini kaydet",
    "Limitleri yenile",
    "Hesabı kaldır",
  ]);
  const unlinkedActive = { ...a, desktop: undefined };
  const labelsUnlinked = labels(unlinkedActive, relayFor({ active: unlinkedActive }));
  assert.ok(!labelsUnlinked.includes("Claude uygulamasını aç"));
  assert.ok(labelsUnlinked.includes("Claude uygulaması girişini kaydet"));
  const linked = { ...b, id: "c", desktop };
  assert.ok(labels(linked, relay).includes("Geç"));
  for (const extra of [
    { desktopBusy: true },
    { pendingDesktop: b },
    { desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: true, errorRevision: 0, activeProfileId: "a" } },
  ] as Partial<Relay>[]) {
    const r = relayFor(extra);
    const open = rowActions(a, r, t, "tr").find((x) => x.label === "Claude uygulamasını aç");
    const sw = rowActions(linked, r, t, "tr").find((x) => x.label === "Geç");
    assert.equal(open?.disabled, true, JSON.stringify(Object.keys(extra)));
    assert.equal(sw?.disabled, true);
  }
  assert.equal(rowActions(a, relay, t, "tr").find((x) => x.label === "Claude uygulamasını aç")?.disabled, false);
});

test("the accounts empty state looks out when a filter hides every account", () => {
  const html = wrap(relayFor(), createElement(AccountsEmpty, { hasAccounts: true }));
  assert.match(html, /data-scene="lookout"/);
  assert.match(html, /Eşleşen hesap yok/);
  assert.doesNotMatch(html, /data-scene="welcome"/);
});

test("the accounts empty state's panda is playful, the greeting and the lookout alike", () => {
  const playful = (scene: string) =>
    new RegExp(`<span data-playful="true" class="inline-block shrink-0 overflow-hidden" style="width:72px;height:72px"><svg[^>]*data-scene="${scene}"`);
  assert.match(wrap(relayFor(), createElement(AccountsEmpty, { hasAccounts: false })), playful("welcome"));
  assert.match(wrap(relayFor(), createElement(AccountsEmpty, { hasAccounts: true })), playful("lookout"));
  // And on the page itself, with no accounts at all.
  assert.match(wrap(relayFor({ accounts: [], active: undefined }), createElement(Accounts)), playful("welcome"));
  // A page with accounts has no panda to click.
  assert.doesNotMatch(wrap(relayFor(), createElement(Accounts)), /data-playful/);
});

// The old Desktop / connection / CLI wording must not come back next to the two sign-in names.
const OLD_TR =
  /Desktop bağlantı|Desktop’a bağla|Desktop ve limit|kullanım bağlantı|CLI bağlantı|Limit bağlantısı|Desktop girişi|tarayıcı girişi|Desktop ilk kurulumu/i;
const OLD_EN =
  /Desktop connection|Connect Desktop|Link to Desktop|Desktop sign-in|browser sign-in|usage connection|limit connection|CLI connection|First Desktop setup/i;

test("no view mixes the old Desktop and connection wording with the two sign-in names", () => {
  const issues: UsageIssue[] = [
    "connect-cli",
    "credentials-missing",
    "renewal-required",
    "expired",
    "scope",
    "identity-mismatch",
  ];
  const render = (
    language: "tr" | "en",
    relay: Relay,
    child: ReturnType<typeof createElement>,
  ) =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: i18nValue(language) },
        createElement(RelayContext.Provider, { value: relay }, child),
      ),
    );
  for (const [language, forbidden] of [
    ["tr", OLD_TR],
    ["en", OLD_EN],
  ] as const) {
    const views: [string, string][] = [
      ["accounts page", render(language, relayFor(), createElement(Accounts))],
      [
        "accounts page, unclaimed Desktop",
        render(
          language,
          relayFor({ hasUnclaimedDesktop: true }),
          createElement(Accounts),
        ),
      ],
      [
        "sheet, saved",
        render(
          language,
          relayFor(),
          createElement(AccountDetailBody, { account: a, now: NOW }),
        ),
      ],
      [
        "sheet, mismatch",
        render(
          language,
          relayFor(),
          createElement(AccountDetailBody, {
            account: {
              ...a,
              auth: {
                loggedIn: true,
                accountUuid: "other",
                checkedAt: iso(NOW),
              },
            },
            now: NOW,
          }),
        ),
      ],
      [
        "sheet, first sign-in open",
        render(
          language,
          relayFor({ setupId: "b" }),
          createElement(AccountDetailBody, { account: b, now: NOW }),
        ),
      ],
      [
        "sheet, sign-in pending",
        render(
          language,
          relayFor({ pendingDesktop: b }),
          createElement(AccountDetailBody, { account: b, now: NOW }),
        ),
      ],
      ...[1, 2, 3].map((step): [string, string] => [
        `add dialog, step ${step}`,
        render(
          language,
          relayFor(),
          createElement(AddAccountSteps, {
            close() {},
            initial: { step: step as 1 | 2 | 3, id: "b" },
          }),
        ),
      ]),
      ...issues.map((issue): [string, string] => [
        `sheet, usage issue ${issue}`,
        render(
          language,
          relayFor({
            data: {
              settings: DEFAULT_SETTINGS,
              usage: {
                b: { accountId: "b", status: "error", issue, stale: true },
              },
              accounts,
              authFlows: [],
            } as unknown as Snapshot,
          }),
          createElement(AccountDetailBody, {
            account: {
              ...b,
              auth: {
                loggedIn: true,
                email: "b@example.com",
                checkedAt: iso(NOW),
              },
            },
            now: NOW,
          }),
        ),
      ]),
    ];
    for (const [name, html] of views)
      assert.doesNotMatch(html, forbidden, `${language}: ${name}`);
  }
});

test("the connections count only what a switch needs; the extension and the terminal are optional", () => {
  const brave = { app: "brave", profile: "Default", name: "Kişisel", opened: true } as const;
  const extension = (over: Partial<ExtensionStatus> = {}): ExtensionStatus => ({
    setting: { mode: "restart" },
    instances: [brave],
    target: brave,
    saved: [{ accountUuid: desktop.accountUuid, savedAt: iso(NOW) }],
    ...over,
  });
  // The terminal is off here; the test after this one counts it.
  const mac = (extensionStatus?: ExtensionStatus, platform = "darwin", terminalStatus: TerminalStatus = { mode: "off", saved: [] }) =>
    wrap(
      relayFor({
        data: { settings: DEFAULT_SETTINGS, usage, accounts, authFlows: [], diagnostics: { platform } } as unknown as Snapshot,
      }),
      createElement(AccountDetailBody, { account: a, now: NOW, extensionStatus, terminalStatus }),
    );
  const count = (html: string) => /<h2[^>]*>Bağlantılar<\/h2><div[^>]*><span[^>]*>([^<]*)<\/span>/.exec(html)?.[1];
  // The Claude app sign-in and the usage sign-in: the same count with or without the optional rows.
  assert.equal(count(mac(extension())), "2 / 2 hazır");
  assert.equal(count(mac(extension({ saved: [] }))), "2 / 2 hazır");
  assert.equal(count(mac()), "2 / 2 hazır");
  assert.equal(count(mac(extension({ setting: { mode: "off" } }))), "2 / 2 hazır");
  assert.equal(count(mac(extension(), "win32")), "2 / 2 hazır");
  const saved = { mode: "follow", saved: [{ accountUuid: desktop.accountUuid, orgId: desktop.orgId, savedAt: iso(NOW), parked: true }] } as TerminalStatus;
  assert.equal(count(mac(extension(), "darwin", saved)), "2 / 2 hazır");
  // The optional rows say so, and keep their own steps behind a closed "how to connect" line.
  const missing = mac(extension(), "darwin", { mode: "follow", saved: [] });
  assert.equal(count(missing), "2 / 2 hazır");
  assert.equal(missing.match(/>isteğe bağlı</g)?.length, 2);
  const terminal = missing.slice(missing.lastIndexOf('data-slot="connection"'));
  assert.match(terminal, /title="Bu hesaba o da geçer\.">Terminal<\/span><span[^>]*>isteğe bağlı<\/span>/);
  assert.equal(disclosureState(terminal, "Nasıl bağlanır\\?"), "false");
  assert.doesNotMatch(terminal, /“Bağla”ya bas/);
  assert.match(terminal, /<button[^>]*data-variant="outline"[^>]*>.*Bağla<\/button>/);
  assert.doesNotMatch(mac(extension(), "win32"), />isteğe bağlı</);
});

test("the closed Code history row says whether, and with how many accounts, it is shared", () => {
  const t = testT("tr");
  const en = testT("en");
  assert.equal(historyLine(0, "same-group", t), "paylaşılmıyor");
  assert.equal(historyLine(2, "same-group", t), "aynı gruptaki 2 hesapla paylaşılıyor");
  assert.equal(historyLine(2, "all", t), "2 hesapla paylaşılıyor");
  assert.equal(historyLine(1, "same-group", en), "shared with 1 account in the same group");
  assert.equal(historyLine(0, "off", en), "not shared");
  // On the page: `c` is in `a`'s group with a saved Claude app sign-in, so the next merge brings its history.
  const summary = (html: string) => /data-slot="disclosure-summary"[^>]*>([^<]*)</.exec(html)?.[1];
  assert.equal(summary(sheetFor(a)), "aynı gruptaki 1 hesapla paylaşılıyor");
  assert.equal(summary(sheetFor(a, { settings: { ...DEFAULT_SETTINGS, desktopHistoryTransfer: "off" } })), "paylaşılmıyor");
});

/** A table of `a` (active), `c` and `b`, with `c` suggested unless said otherwise. */
const suggestedTable = (extra: Partial<Relay> = {}, usageFor: Record<string, AccountUsage> = {}, language: "tr" | "en" = "tr") =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue(language) },
      createElement(
        RelayContext.Provider,
        { value: relayOf({ suggestion: c, ...extra }, { a: readNow(usage.a), c: readNow({ ...usage.a, accountId: "c" }), ...usageFor }) },
        createElement(AccountsTable, { accounts: [a, c, b], open() {}, link() {} }),
      ),
    ),
  );
const rowsOf = listRows;

test("the suggested account's row offers its switch inline, filled", () => {
  const [activeRow, suggestedRow, otherRow] = rowsOf(suggestedTable());
  // The filled Geç is the mark: there is no "önerilen" chip any more.
  assert.match(suggestedRow, /<button[^>]*data-variant="default"[^>]*data-size="xs"[^>]*aria-label="Geç · Üçüncü"[^>]*>Geç<\/button>/);
  assert.match(suggestedRow, />Hazır<\/span>/);
  assert.doesNotMatch(suggestedTable(), /önerilen/);
  for (const row of [activeRow, otherRow]) assert.doesNotMatch(row, />Geç<\/button>/);
  // No suggestion, no inline switch.
  const plain = suggestedTable({ suggestion: undefined });
  assert.doesNotMatch(plain, />Geç<\/button>/);
  // It takes the switch lock.
  assert.match(rowsOf(suggestedTable({ desktopBusy: true }))[1], /<button[^>]*disabled=""[^>]*>Geç<\/button>/);
  assert.match(rowsOf(suggestedTable({}, {}, "en"))[1], /aria-label="Switch · Üçüncü"[^>]*>Switch<\/button>/);
});

test("a stale row says its reading is old, fades its limits and offers a Refresh button", () => {
  const checkedAt = new Date(Date.now() - 2 * 3_600_000 - 60_000).toISOString();
  const stale = { c: { accountId: "c", status: "ready", stale: true, checkedAt, fiveHour: { usedPercent: 20 } } as AccountUsage };
  const row = rowsOf(suggestedTable({ suggestion: undefined }, stale))[1];
  // A quiet status, the longer reason on hover; the age chip is gone from the list.
  assert.deepEqual(statusOf(row), ["off", "Limit verisi eski", "Eski okuma"]);
  assert.doesNotMatch(row, /data-slot="data-age"/);
  assert.match(row, /data-slot="limit-line" class="[^"]*opacity-60/);
  assert.match(row, /<button[^>]*data-variant="outline"[^>]*data-size="xs"[^>]*aria-label="Limitleri yenile · Üçüncü" title="Limitleri yenile">Yenile<\/button>/);
  assert.match(rowsOf(suggestedTable({ suggestion: undefined }, stale, "en"))[1], />Old reading<\/span>.*aria-label="Refresh limits · Üçüncü"[^>]*>Refresh<\/button>/);
  // A fresh row has neither.
  const fresh = rowsOf(suggestedTable({ suggestion: undefined }))[1];
  assert.doesNotMatch(fresh, /Eski okuma|opacity-60|>Yenile<\/button>/);
  // It takes Refresh limits' busy state.
  assert.match(rowsOf(suggestedTable({ suggestion: undefined, usageBusy: new Set(["c"]) }, stale))[1], /<button[^>]*disabled=""[^>]*>Yenile<\/button>/);
});

test("the inline switch and refresh run the ⋯ menu's own actions, without opening the account", async () => {
  const checkedAt = new Date(Date.now() - 3_600_000).toISOString();
  const switched: [string, string][] = [];
  const refreshed: string[] = [];
  const opened: string[] = [];
  const relay = relayOf(
    {
      suggestion: c,
      requestDesktop: (account: Account, kind: string) => void switched.push([account.id, kind]),
      refreshUsage: async (account: Account) => void refreshed.push(account.id),
    } as Partial<Relay>,
    { c: { ...usage.a, accountId: "c" }, b: { accountId: "b", status: "ready", stale: true, checkedAt } as AccountUsage },
  );
  const dom = fakeDom();
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const linkedB: Account = { ...b, desktop, auth: { loggedIn: true, email: "b@example.com", checkedAt } };
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nValue("tr") },
          createElement(
            RelayContext.Provider,
            { value: relay },
            createElement(AccountsTable, { accounts: [c, linkedB], open: (id) => void opened.push(id), link() {} }),
          ),
        ),
      ),
    );
    const buttons = drawn(dom.container as unknown as FakeNode).filter(
      (n) => n.tagName === "button" && n.attributes.get("data-size") === "xs",
    );
    const by = (label: string) => buttons.find((n) => n.attributes.get("aria-label") === label);
    const go = by("Geç · Üçüncü");
    const refresh = by("Limitleri yenile · Studio");
    assert.ok(go && refresh, "both inline buttons are drawn");
    await act(async () => dom.dispatch(go, "click", { detail: 1 }));
    await act(async () => dom.dispatch(refresh, "click", { detail: 1 }));
    assert.deepEqual(switched, [["c", "switch"]]);
    assert.deepEqual(refreshed, ["b"]);
    assert.deepEqual(opened, []);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("a row that needs a step says so in its status and offers that step; the connection icons and their key are gone", () => {
  const html = suggestedTable();
  const [activeRow, , unlinkedRow] = rowsOf(html);
  // `b` has no Claude app sign-in: a quiet status and the one step that fixes it.
  assert.deepEqual(statusOf(unlinkedRow), ["off", "Claude uygulaması girişi yok", "Uygulama girişi yok"]);
  assert.match(unlinkedRow, /aria-label="Claude uygulaması girişini kaydet · Studio"[^>]*>Kaydet<\/button>/);
  assert.doesNotMatch(activeRow, /data-size="xs"/);
  // A sign-in to renew is a step too, in red, with its own button.
  const critical = rowsOf(suggestedTable({}, { c: { accountId: "c", status: "error", issue: "expired", stale: true } }))[1];
  assert.deepEqual(statusOf(critical), ["crit", "Limit okuma girişi gerekli", "Giriş gerekli"]);
  assert.match(critical, /aria-label="Limit okuma girişini yenile · Üçüncü"[^>]*>Bağla<\/button>/);
  // The fix wins over the suggested switch: one visible action per row.
  assert.doesNotMatch(critical, />Geç<\/button>/);
  // The icons and their key live on the account's page now.
  assert.doesNotMatch(html, /data-slot="connection-legend"|data-step=|role="img"/);
  const en = suggestedTable({}, {}, "en");
  assert.match(rowsOf(en)[2], />No app sign-in<\/span>.*>Save<\/button>/);
  assert.doesNotMatch(en, /data-slot="connection-legend"/);
});

test("a search that matches nothing is named and can be cleared", () => {
  const html = wrap(relayFor(), createElement(AccountsEmpty, { hasAccounts: true, query: " stu ", clearQuery() {} }));
  assert.match(html, /<h3[^>]*>“stu” ile eşleşen hesap yok<\/h3>/);
  assert.match(html, /<button[^>]*data-variant="link"[^>]*>Aramayı temizle<\/button>/);
  assert.doesNotMatch(html, /Aramayı veya filtreyi değiştir/);
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("en") },
      createElement(RelayContext.Provider, { value: relayFor() }, createElement(AccountsEmpty, { hasAccounts: true, query: "stu", clearQuery() {} })),
    ),
  );
  assert.match(en, /No accounts match “stu”/);
  assert.match(en, />Clear search<\/button>/);
  // Only a filter hides them: the general lookout, nothing to clear.
  const filtered = wrap(relayFor(), createElement(AccountsEmpty, { hasAccounts: true, query: "", clearQuery() {} }));
  assert.match(filtered, /Eşleşen hesap yok/);
  assert.doesNotMatch(filtered, /Aramayı temizle/);
});

test("the menu offers to remove an account, except the one open in the Claude app, and says why", () => {
  const t = testT("tr");
  const asked: string[] = [];
  const removeOf = (acct: Account, relay: Relay) =>
    rowActions(acct, relay, t, "tr", undefined, { remove: (id) => asked.push(id) }).find((x) => x.key === "remove")!;
  const relay = relayOf();
  // The active account cannot go: switch first.
  const active = removeOf(a, relay);
  assert.equal(active.label, "Hesabı kaldır");
  assert.equal(active.tone, "destructive");
  assert.equal(active.disabled, true);
  assert.equal(active.note, "Önce başka bir hesaba geç");
  // Another account can; choosing it asks (the dialog), it does not remove.
  const other = removeOf(c, relay);
  assert.equal(other.disabled, false);
  assert.equal(other.note, undefined);
  other.run();
  assert.deepEqual(asked, ["c"]);
  // Main refuses these too; the menu says so first.
  for (const [extra, note] of [
    [{ desktopBusy: true }, "Claude uygulamasında bir işlem sürüyor"],
    [{ pendingDesktop: c }, "Önce Claude uygulaması girişini tamamla ya da iptal et"],
  ] as [Partial<Relay>, string][]) {
    const item = removeOf(c, relayOf(extra));
    assert.equal(item.disabled, true, note);
    assert.equal(item.note, note);
  }
  const pending = { id: "f", accountId: "c", status: "waiting" };
  assert.equal(removeOf(c, relayOf({}, {}, [pending])).note, "Önce limit okuma girişini tamamla ya da iptal et");
  const running = relayOf();
  (running.data as { runs?: unknown[] }).runs = [{ accountId: "c", status: "running" }];
  assert.equal(removeOf(c, running).note, "Önce çalışan oturumu durdur");
  // In English too.
  const en = rowActions(a, relay, testT("en"), "en").find((x) => x.key === "remove")!;
  assert.equal(en.label, "Remove account");
  assert.equal(en.note, "Switch to another account first");
});

test("the remove dialog says what goes and what stays, and removes only on confirm", async () => {
  const removed: string[] = [];
  const notices: string[] = [];
  const calls: string[] = [];
  const relay = relayOf({
    api: { removeAccount: async (id: string) => (calls.push(id), { signedOut: true }) } as unknown as Relay["api"],
    action: async (_key: string, fn: () => Promise<unknown>) => (await fn(), true),
    setNotice: (text: string) => void notices.push(text),
  });
  const body = () => createElement(RemoveAccountBody, { account: c, close() {}, removed: (id: string) => void removed.push(id) });
  const html = wrap(relay, body());
  // The question, then the two lists.
  assert.match(html, /Üçüncü Relay’den kaldırılsın mı\?/);
  assert.match(html, /data-slot="remove-goes".*Silinir.*Kayıtlı Claude uygulaması girişi.*Limit okuma girişi ve terminal oturumları.*Tarayıcı eklentisi girişi/);
  assert.match(html, /data-slot="remove-stays".*Kalır.*Claude uygulamasının kendi verisi.*Kullanım geçmişi ve token sayıları/);
  assert.match(html, /<button[^>]*data-variant="ghost"[^>]*>Vazgeç<\/button><button[^>]*data-variant="destructive"[^>]*>.*Hesabı kaldır<\/button>/);
  assert.equal(calls.length, 0);
  // Confirming removes through the API, says so, and lets the page go back.
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
          createElement(RelayContext.Provider, { value: relay }, body()),
        ),
      ),
    );
    type Node = { tagName?: string; attributes: Map<string, string>; childNodes: Node[] };
    const all = (n: Node, found: Node[] = []): Node[] => {
      found.push(n);
      for (const child of n.childNodes) all(child, found);
      return found;
    };
    const button = all(dom.container as unknown as Node).find(
      (n) => n.tagName === "button" && n.attributes.get("data-variant") === "destructive",
    );
    assert.ok(button);
    await act(async () => dom.dispatch(button as never, "click", { detail: 1 }));
    await act(async () => {});
    assert.deepEqual(calls, ["c"]);
    assert.deepEqual(removed, ["c"]);
    assert.deepEqual(notices, ["Üçüncü kaldırıldı."]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
  // A usage sign-in left signed in is said.
  assert.equal(
    removedNotice("Üçüncü", { signedOut: false }, testT("tr")),
    "Üçüncü kaldırıldı. Limit okuma girişinden çıkış yapılamadı; Anahtarlık’taki kaydı kalabilir.",
  );
  assert.equal(removedNotice("C", {}, testT("en")), "Removed C.");
});

test("a full account keeps its switch, quieter, saying when its limit opens", () => {
  const t = testT("tr");
  const full = (now: number): Record<string, AccountUsage> => ({
    c: {
      accountId: "c", status: "ready", stale: false, checkedAt: iso(now - 60_000),
      fiveHour: { usedPercent: 100, resetsAt: iso(now + 90 * 60_000) },
      sevenDay: { usedPercent: 40, resetsAt: iso(now + 3 * 86_400_000) },
    },
  });
  const zone = DEFAULT_SETTINGS.planning.timeZone;
  const opens = new Intl.DateTimeFormat("tr-TR", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(NOW + 90 * 60_000);
  const sw = rowActions(c, relayOf({}, full(NOW)), t, "tr", undefined, { now: NOW }).find((x) => x.key === "switch")!;
  assert.equal(sw.disabled, false);
  assert.equal(sw.tone, "warn");
  assert.match(sw.note ?? "", new RegExp(`^Limit dolu · ${opens}’[a-z]+ açılır \\(1 sa 30 dk\\)$`));
  // An account with room has a plain switch.
  const plain = rowActions(c, relayOf(), t, "tr", undefined, { now: NOW }).find((x) => x.key === "switch")!;
  assert.equal(plain.tone, undefined);
  assert.equal(plain.note, undefined);
  // The account's page: the switch is still its primary action, quieter (outline), the note in its title.
  const header = headerOf(c, {}, full(Date.now()));
  const [primary] = primaryButtons(header);
  assert.match(primary, /^<button[^>]*data-variant="outline"/);
  assert.match(primary, /title="Limit dolu · [^"]+ açılır \([^"]+\)"/);
  assert.match(primary, />Geç<\/button>$/);
  assert.doesNotMatch(header, /data-slot="switch-note"/);
  // The header's status says the limit is full and when it opens.
  assert.deepEqual(statusOf(header)?.slice(0, 1), ["crit"]);
  assert.match(statusOf(header)?.[2] ?? "", /^Dolu · 1 sa (29|30) dk$/);
  // An account with room keeps the filled switch, without a title.
  const [roomy] = primaryButtons(headerOf(c, {}, { c: readNow({ ...usage.a, accountId: "c" }) }));
  assert.match(roomy, /^<button[^>]*data-variant="default"/);
  assert.doesNotMatch(roomy, /title=/);
});

test("separate windows: the menu opens one, then offers it forward or closed, and holds the switch", () => {
  const en = testT("en");
  const windows = (open: string[], enabled = true) =>
    relayFor({
      data: {
        settings: DEFAULT_SETTINGS, usage, accounts, authFlows: [],
        windows: { supported: true, enabled, open: open.map((accountId) => ({ accountId })), others: 0 },
      } as unknown as Snapshot,
      active: w,
    } as Partial<Relay>);
  const keys = (relay: Relay) => rowActions(a, relay, en, "en").map((x) => x.key);
  assert.ok(!keys(windows([], false)).some((key) => key.startsWith("window")));
  // Turned off with a window open: it can still be brought forward and closed.
  assert.deepEqual(keys(windows(["a"], false)).slice(0, 3), ["switch", "window-show", "window-close"]);
  assert.deepEqual(keys(windows([])).slice(0, 2), ["switch", "window"]);
  const open = rowActions(a, windows(["a"]), en, "en");
  assert.deepEqual(open.map((x) => x.key).slice(0, 3), ["switch", "window-show", "window-close"]);
  const sw = open.find((x) => x.key === "switch")!;
  assert.equal(sw.disabled, true);
  assert.equal(sw.note, "Close its separate window first");
  assert.equal(open.find((x) => x.key === "remove")!.disabled, true);
  assert.equal(open.find((x) => x.key === "desktop-reconnect")!.disabled, true);
  // The main Claude's own account is never offered a window.
  assert.ok(!rowActions(w, windows([]), en, "en").some((x) => x.key.startsWith("window")));
  // Its calls go to the window API.
  const calls: string[] = [];
  const relay = windows(["a"]);
  (relay as any).action = async (_key: string, fn: () => Promise<unknown>) => fn();
  (relay as any).api = { ...relay.api, openWindow: async (id: string) => void calls.push(`open:${id}`), closeWindow: async (id: string) => void calls.push(`close:${id}`) };
  for (const item of rowActions(a, relay, en, "en")) if (item.key.startsWith("window")) item.run();
  assert.deepEqual(calls, ["open:a", "close:a"]);
});
