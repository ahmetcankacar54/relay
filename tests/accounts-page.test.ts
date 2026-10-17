import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Accounts, AccountsEmpty } from "../src/pages/Accounts";
import { AccountSheetBody } from "../src/pages/accounts/AccountSheet";
import { AddAccountSteps } from "../src/pages/accounts/AddAccountDialog";
import { AccountsTable, rowActions } from "../src/pages/accounts/AccountsTable";
import { filterAccounts, groupName, planLabel } from "../src/pages/accounts/accountLabels";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { fakeDom } from "./fake-dom";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type AuthFlow, type Snapshot, type UsageIssue } from "../shared/types";

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
  assert.match(html, /3 hesap · 1 hesapta Claude uygulaması girişi kayıtlı/);
  assert.match(html, /Hesap ekle/);
  assert.match(html, /placeholder="Hesap, e-posta veya grup ara…"/);
  for (const name of ["Kişisel · Max", "Studio", "Şirket"]) assert.match(html, new RegExp(name));
  assert.match(html, /Max 5×/);
  assert.match(html, /<th[^>]*>Durum<\/th>/);
  assert.doesNotMatch(html, /<th[^>]*>(Claude uygulaması|Limit okuma)<\/th>/);
  assert.match(html, /Açık/);
  assert.match(html, /Claude uygulaması girişi yok/);
  assert.doesNotMatch(html, /Bağlı değil|Süresi doldu/);
  assert.match(html, /%38 · %78/);
  assert.match(html, /aria-label="Studio işlemleri"/);
});

test("the accounts table has one Durum column with a fix button only where something is wrong", () => {
  const critical: Account = { ...a, id: "k", name: "Yenilenecek" };
  const table = (list: Account[], language: "tr" | "en" = "tr", relay: Partial<Relay> = {}) =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(
          RelayContext.Provider,
          {
            value: relayFor({
              data: {
                settings: DEFAULT_SETTINGS,
                usage: { ...usage, k: { accountId: "k", status: "error", issue: "expired", stale: true } },
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
  assert.equal(html.match(/<th[ >]/g)?.length, 5);
  assert.match(html, /<th[^>]*>Durum<\/th>/);
  assert.doesNotMatch(html, /<th[^>]*>(Limit okuma|Claude uygulaması)<\/th>/);
  assert.match(table([a], "en"), /<th[^>]*>Status<\/th>/);
  const rows = html.split("<tr").slice(2);
  const [okRow, critRow, offRow] = rows;
  // An ok row shows its label and no inline button; only the ⋯ menu button is there.
  assert.match(okRow, /Açık/);
  assert.doesNotMatch(okRow, /data-size="xs"/);
  assert.match(okRow, /title="Claude uygulaması girişi: Açık · Limit okuma girişi: Bağlı"/);
  // A crit row shows its label and the matching row action's label as a small ghost button.
  assert.match(critRow, /Limit okuma girişi gerekli/);
  assert.match(critRow, /title="Claude uygulaması girişi: Kayıtlı · Limit okuma girişi: Gerekli"/);
  assert.match(critRow, /<button[^>]*data-variant="ghost"[^>]*data-size="xs"[^>]*>Limit okuma girişini yenile<\/button>/);
  // The button's name starts with its visible label and says which account it is for.
  assert.match(critRow, /<button[^>]*aria-label="Limit okuma girişini yenile · Yenilenecek"[^>]*>Limit okuma girişini yenile<\/button>/);
  // An off row offers to save the Claude app sign-in.
  assert.match(offRow, /Claude uygulaması girişi yok/);
  assert.match(offRow, /<button[^>]*data-variant="ghost"[^>]*data-size="xs"[^>]*>Claude uygulaması girişini kaydet<\/button>/);
  // The inline button takes the row action's disabled state.
  const locked = table([critical], "tr", { busy: "x" });
  assert.match(locked, /<button[^>]*disabled=""[^>]*data-size="xs"|<button[^>]*data-size="xs"[^>]*disabled=""/);
  // The labels follow the language.
  assert.match(table([critical], "en"), /Usage sign-in needed/);
  assert.match(table([critical], "en"), /data-size="xs"[^>]*>Renew usage sign-in<\/button>/);
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
  const en = (_: string, english: string) => english;
  const keys = (relay: Relay) => rowActions(a, relay, en).map((x) => x.key);
  const renew = (relay: Relay, t: (tr: string, en: string) => string = (tr) => tr) =>
    rowActions(a, relay, t).find((x) => x.key === "renew");
  for (const value of [undefined, usageOf("a"), usageOf("a", "expired"), usageOf("a", "scope"), usageOf("a", "rate-limited"), usageOf("a", "unavailable")])
    assert.ok(!keys(relayWithUsage("a", value)).includes("renew"), String(value?.issue));
  // Offered for a locked Keychain, with its own wording.
  const keychain = renew(relayWithUsage("a", usageOf("a", "keychain-locked")));
  assert.equal(keychain?.label, "Anahtarlık erişimine izin ver");
  assert.equal(renew(relayWithUsage("a", usageOf("a", "keychain-locked")), en)?.label, "Allow Keychain access");
  // Offered for a connection to renew, however it is reported.
  for (const value of [usageOf("a", "renewal-required"), usageOf("a", undefined, { connectionRenewalRequired: true })]) {
    assert.equal(renew(relayWithUsage("a", value))?.label, "Bağlantıyı yenile");
    assert.equal(renew(relayWithUsage("a", value), en)?.label, "Renew connection");
  }
  // It sits with the sign-in items, before Refresh limits.
  assert.deepEqual(keys(relayWithUsage("a", usageOf("a", "renewal-required"))), [
    "open", "cli", "renew", "desktop-reconnect", "refresh",
  ]);
  // It asks the Keychain, where Refresh limits does not: the prompt is the fix.
  const calls: unknown[][] = [];
  const relay = relayWithUsage("a", usageOf("a", "keychain-locked"), {
    refreshUsage: async (...args: unknown[]) => void calls.push(args),
  } as Partial<Relay>);
  const items = rowActions(a, relay, (tr) => tr);
  items.find((x) => x.key === "renew")!.run();
  items.find((x) => x.key === "refresh")!.run();
  assert.deepEqual(calls, [[a, true], [a]]);
  // It is disabled exactly when Refresh limits is.
  for (const usageBusy of [new Set<string>(), new Set(["a"])]) {
    const busy = rowActions(a, relayWithUsage("a", usageOf("a", "keychain-locked"), { usageBusy }), (tr) => tr);
    assert.equal(busy.find((x) => x.key === "renew")?.disabled, usageBusy.has("a"));
    assert.equal(busy.find((x) => x.key === "renew")?.disabled, busy.find((x) => x.key === "refresh")?.disabled);
  }
});

test("a row with a locked Keychain or a connection to renew offers that renewal inline, by account name", () => {
  const row = (value: AccountUsage, language: "tr" | "en" = "tr") =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(
          RelayContext.Provider,
          { value: relayWithUsage("a", value) },
          createElement(AccountsTable, { accounts: [a], open() {}, link() {} }),
        ),
      ),
    );
  const keychain = row(usageOf("a", "keychain-locked"));
  assert.match(keychain, /Anahtarlık izni gerekli/);
  assert.match(
    keychain,
    /<button[^>]*data-size="xs"[^>]*aria-label="Anahtarlık erişimine izin ver · Kişisel · Max"[^>]*>Anahtarlık erişimine izin ver<\/button>/,
  );
  const renewing = row(usageOf("a", "renewal-required"));
  assert.match(renewing, /Bağlantı yenilenmeli/);
  assert.match(renewing, /aria-label="Bağlantıyı yenile · Kişisel · Max"[^>]*>Bağlantıyı yenile<\/button>/);
  assert.match(row(usageOf("a", undefined, { connectionRenewalRequired: true }), "en"), /aria-label="Renew connection · Kişisel · Max"[^>]*>Renew connection<\/button>/);
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
    startCli: async (account: Account) => void started.push(account.id),
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
          { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
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
    const row = all.find((n) => n.tagName === "tr" && n.attributes.has("tabindex"));
    assert.ok(row, "the row is drawn");
    await act(async () => dom.dispatch(row, "click", { detail: 1 }));
    assert.deepEqual(opened, ["k"]);
    assert.deepEqual(started, ["k"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("an account without a plan shows muted Plan yok text, not a badge", () => {
  const noPlan: Account = { ...b, planning: undefined };
  const html = (language: "tr" | "en") =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(
          RelayContext.Provider,
          { value: relayFor() },
          createElement(AccountsTable, { accounts: [noPlan, a], open() {}, link() {} }),
        ),
      ),
    );
  const tr = html("tr");
  assert.match(tr, /<span[^>]*class="[^"]*text-muted-foreground[^"]*"[^>]*>Plan yok<\/span>/);
  assert.doesNotMatch(tr, /data-slot="badge"[^>]*>Plan yok/);
  assert.doesNotMatch(tr, /Plan seç/);
  assert.match(html("en"), /<span[^>]*text-muted-foreground[^>]*>No plan<\/span>/);
  // A chosen plan is still a badge.
  assert.match(tr, /data-slot="badge"[^>]*>Max 5×/);
});

test("the accounts page shows the empty state", () => {
  const html = wrap(relayFor({ accounts: [], active: undefined }), createElement(Accounts));
  assert.match(html, /Tek panel. Tüm hesapların./);
  assert.match(html, /data-scene="welcome"/);
});

test("the account sheet shows identity, one status, usage and, once opened, connections and history", () => {
  const sheetHtml = wrap(relayFor(), createElement(AccountSheetBody, { account: a, now: NOW }));
  assert.match(sheetHtml, /a@example.com/);
  assert.match(sheetHtml, /Bağlantılar/);
  assert.match(sheetHtml, /Code geçmişi/);
  assert.match(sheetHtml, /5 saatlik/);
  assert.match(sheetHtml, /Claude uygulaması girişi: Açık · Limit okuma girişi: Bağlı/);
  // Both disclosures start closed for a healthy account, so their contents are not rendered.
  assert.doesNotMatch(sheetHtml, /Claude uygulaması girişini yenile…|Limit okuma girişini yenile|Limit okuma girişini doğrula/);
  // An account that needs attention opens its connections.
  const needsSignIn = wrap(
    relayFor({ data: { settings: DEFAULT_SETTINGS, usage: { a: usage.w }, accounts, authFlows: [] } as unknown as Snapshot }),
    createElement(AccountSheetBody, { account: a, now: NOW }),
  );
  assert.match(needsSignIn, /Claude uygulaması girişi/);
  assert.match(needsSignIn, /Limit okuma girişi/);
  assert.match(needsSignIn, /Claude uygulaması girişini yenile…/);
  assert.match(needsSignIn, /Limit okuma girişini yenile/);
  assert.match(needsSignIn, /aria-label="Limit okuma girişini doğrula"/);
  assert.doesNotMatch(needsSignIn, /Desktop girişi|tarayıcı girişi|Tarayıcı girişi/);
});

// A second account with its Claude app sign-in saved, so it can be switched to; `a` stays the active one.
const c: Account = { ...a, id: "c", name: "Üçüncü" };
const sheetFor = (account: Account, extra: Partial<Relay> = {}, usageFor: Record<string, AccountUsage> = {}, authFlows: unknown[] = []) =>
  wrap(
    relayFor({
      data: { settings: DEFAULT_SETTINGS, usage: { ...usage, ...usageFor }, accounts: [...accounts, c], authFlows } as unknown as Snapshot,
      accounts: [...accounts, c],
      ...extra,
    }),
    createElement(AccountSheetBody, { account, now: NOW }),
  );
/** The status block at the top of the sheet: the health label and its one action. */
const statusBlock = (html: string) => {
  const from = html.indexOf('data-slot="account-status"');
  assert.ok(from >= 0, "the sheet has a status block");
  return html.slice(from, html.indexOf("<dl", from));
};
const disclosureState = (html: string, title: string) =>
  new RegExp(`<button[^>]*aria-expanded="(true|false)"[^>]*><span[^>]*>${title}</span>`).exec(html)?.[1];
const expiredC: Record<string, AccountUsage> = { c: { accountId: "c", status: "error", issue: "expired", stale: true } };

test("the sheet header shows the health label and one primary action", () => {
  // A fix wins: the fix's row-action label.
  const crit = statusBlock(sheetFor(c, {}, expiredC));
  assert.match(crit, /Limit okuma girişi gerekli/);
  assert.equal(crit.match(/<button/g)?.length, 1);
  assert.match(crit, /<button[^>]*>Limit okuma girişini yenile<\/button>/);
  const unlinked = statusBlock(sheetFor(b));
  assert.match(unlinked, /Claude uygulaması girişi yok/);
  assert.match(unlinked, /<button[^>]*>Claude uygulaması girişini kaydet<\/button>/);
  // No fix and not the active account: switch.
  const ready = statusBlock(sheetFor(c, {}, { c: { ...usage.a, accountId: "c" } }));
  assert.match(ready, /Hazır/);
  assert.equal(ready.match(/<button/g)?.length, 1);
  assert.match(ready, /<button[^>]*>Geçiş yap<\/button>/);
  // A pending approval has no fix either, so it offers the switch.
  const waiting = statusBlock(sheetFor(c, {}, {}, [{ accountId: "c", status: "waiting" }]));
  assert.match(waiting, /Tarayıcı onayı bekleniyor/);
  assert.match(waiting, /<button[^>]*>Geçiş yap<\/button>/);
  // No fix and the active account: nothing to do.
  const active = statusBlock(sheetFor(a));
  assert.match(active, /Açık/);
  assert.doesNotMatch(active, /<button/);
  // The same single status the table shows.
  assert.match(active, /Claude uygulaması girişi: Açık · Limit okuma girişi: Bağlı/);
});

test("a locked Keychain or a connection to renew is fixed from the header, and the usage row agrees with it", () => {
  const keychain = sheetFor(c, {}, { c: usageOf("c", "keychain-locked") });
  const keychainHead = statusBlock(keychain);
  assert.match(keychainHead, /Anahtarlık izni gerekli/);
  assert.equal(keychainHead.match(/<button/g)?.length, 1);
  assert.match(keychainHead, /<button[^>]*>Anahtarlık erişimine izin ver<\/button>/);
  const renewing = sheetFor(c, {}, { c: usageOf("c", "renewal-required") });
  const renewingHead = statusBlock(renewing);
  assert.match(renewingHead, /Bağlantı yenilenmeli/);
  assert.match(renewingHead, /<button[^>]*>Bağlantıyı yenile<\/button>/);
  // The usage sign-in row says what the header says, not "Bağlı" under a green dot.
  const usageRow = (html: string) =>
    /Limit okuma girişi<\/div><div[^>]*><span[^>]*class="[^"]*(bg-\w+)[^"]*"[^>]*><\/span><span[^>]*>([^<]*)/.exec(html);
  assert.deepEqual(usageRow(renewing)?.slice(1), ["bg-warn", "Yenilenmeli · a@example.com · Limitleri okumak için tarayıcıda onaylanır."]);
  assert.doesNotMatch(renewing, /Bağlı/);
  assert.match(usageRow(keychain)?.[2] ?? "", /^Bağlı · Anahtarlık izni gerekli · a@example\.com/);
  assert.equal(usageRow(keychain)?.[1], "bg-warn");
  assert.deepEqual(usageRow(sheetFor(c, {}, expiredC))?.slice(1, 2), ["bg-crit"]);
  assert.match(usageRow(sheetFor(c, {}, expiredC))?.[2] ?? "", /^Gerekli · /);
  // A connection reported only by the flag reads the same.
  assert.match(
    usageRow(sheetFor(c, {}, { c: usageOf("c", undefined, { connectionRenewalRequired: true }) }))?.[2] ?? "",
    /^Yenilenmeli · /,
  );
  // A healthy account's row (open here only because its sign-in flow is) is green and says Bağlı.
  const flow = { id: "f", accountId: "c", status: "connected" } as unknown as AuthFlow;
  const healthy = usageRow(sheetFor(c, { flow, flowAccount: c }, { c: usageOf("c") }));
  assert.equal(healthy?.[1], "bg-ok");
  assert.match(healthy?.[2] ?? "", /^Bağlı · a@example\.com/);
});

test("the sign-in flow panel keeps the connections open, even for a healthy account", () => {
  const failed = { id: "f", accountId: "a", status: "failed", error: "Sign-in failed badly" } as unknown as AuthFlow;
  // `a` is healthy: running, signed in, usage read.
  assert.equal(disclosureState(sheetFor(a), "Bağlantılar"), "false");
  const withFlow = sheetFor(a, { flow: failed, flowAccount: a });
  assert.equal(disclosureState(withFlow, "Bağlantılar"), "true");
  assert.match(withFlow, /Sign-in failed badly/);
  for (const status of ["cancelled", "connected"])
    assert.equal(
      disclosureState(sheetFor(a, { flow: { ...failed, status } as unknown as AuthFlow, flowAccount: a }), "Bağlantılar"),
      "true",
      status,
    );
  // Another account's flow does not open this one.
  const other = sheetFor(a, { flow: { ...failed, accountId: "b" } as unknown as AuthFlow, flowAccount: b });
  assert.equal(disclosureState(other, "Bağlantılar"), "false");
});

test("the sheet's connections and history are disclosures, open only when the account needs attention", () => {
  const ok = sheetFor(a);
  assert.equal(disclosureState(ok, "Bağlantılar"), "false");
  assert.equal(disclosureState(ok, "Code geçmişi"), "false");
  for (const [name, html] of [
    ["crit", sheetFor(c, {}, expiredC)],
    ["warn", sheetFor(c, {}, { c: { accountId: "c", status: "error", issue: "keychain-locked", stale: true } })],
    ["off", sheetFor(b)],
  ] as const) {
    assert.equal(disclosureState(html, "Bağlantılar"), "true", name);
    assert.match(html, /aria-label="Limit okuma girişini doğrula"/, name);
  }
  // History stays closed either way.
  assert.equal(disclosureState(sheetFor(c, {}, expiredC), "Code geçmişi"), "false");
});

test("the account sheet shows Desktop setup for the account being linked", () => {
  const relay = relayFor({ setupId: "b" });
  const sheetHtml = wrap(relay, createElement(AccountSheetBody, { account: b, now: NOW }));
  assert.match(sheetHtml, /İlk Claude uygulaması girişi/);
  assert.match(sheetHtml, /Claude uygulaması girişini kaydet/);
  assert.doesNotMatch(sheetHtml, /Yerel Code geçmişi/);
  const warnings = wrap(
    relayFor(),
    createElement(AccountSheetBody, {
      account: { ...a, auth: { loggedIn: true, accountUuid: "other", checkedAt: iso(NOW) } },
      now: NOW,
    }),
  );
  assert.match(
    warnings,
    /Claude uygulaması girişi ile limit okuma girişi farklı hesaplara ait\. Limit okuma girişini bu profilin hesabıyla yenile\./,
  );
});

test("row actions follow the Desktop link state and the switch lock", () => {
  const t = (tr: string) => tr;
  const labels = (acct: Account, relay: Relay) => rowActions(acct, relay, t).map((x) => x.label);
  const relay = relayFor();
  assert.deepEqual(labels(a, relay), [
    "Claude’u aç",
    "Limit okuma girişini yenile",
    "Claude uygulaması girişini yenile…",
    "Limitleri yenile",
  ]);
  assert.deepEqual(labels(b, relay), [
    "Limit okuma girişi yap",
    "Claude uygulaması girişini kaydet",
    "Limitleri yenile",
  ]);
  const unlinkedActive = { ...a, desktop: undefined };
  const labelsUnlinked = labels(unlinkedActive, relayFor({ active: unlinkedActive }));
  assert.ok(!labelsUnlinked.includes("Claude’u aç"));
  assert.ok(labelsUnlinked.includes("Claude uygulaması girişini kaydet"));
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
        {
          value: {
            language,
            setLanguage() {},
            t: (tr: string, en: string) => (language === "tr" ? tr : en),
          },
        },
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
          createElement(AccountSheetBody, { account: a, now: NOW }),
        ),
      ],
      [
        "sheet, mismatch",
        render(
          language,
          relayFor(),
          createElement(AccountSheetBody, {
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
          createElement(AccountSheetBody, { account: b, now: NOW }),
        ),
      ],
      [
        "sheet, sign-in pending",
        render(
          language,
          relayFor({ pendingDesktop: b }),
          createElement(AccountSheetBody, { account: b, now: NOW }),
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
          createElement(AccountSheetBody, {
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
