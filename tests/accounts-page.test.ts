import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Accounts, AccountsEmpty } from "../src/pages/Accounts";
import { AccountSheetBody } from "../src/pages/accounts/AccountSheet";
import { AddAccountSteps } from "../src/pages/accounts/AddAccountDialog";
import { rowActions } from "../src/pages/accounts/AccountsTable";
import { filterAccounts, groupName, planLabel } from "../src/pages/accounts/accountLabels";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type Snapshot, type UsageIssue } from "../shared/types";

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
  assert.match(html, /<th[^>]*>Claude uygulaması<\/th>/);
  assert.match(html, /<th[^>]*>Limit okuma<\/th>/);
  assert.match(html, /Açık/);
  assert.match(html, /Bağlı değil/);
  assert.match(html, /Süresi doldu/);
  assert.match(html, /%38 · %78/);
  assert.match(html, /aria-label="Studio işlemleri"/);
});

test("the accounts page shows the empty state", () => {
  const html = wrap(relayFor({ accounts: [], active: undefined }), createElement(Accounts));
  assert.match(html, /Tek panel. Tüm hesapların./);
  assert.match(html, /data-scene="welcome"/);
});

test("the account sheet shows identity, connections, usage and history", () => {
  const sheetHtml = wrap(relayFor(), createElement(AccountSheetBody, { account: a, now: NOW }));
  assert.match(sheetHtml, /a@example.com/);
  assert.match(sheetHtml, /Bağlantılar/);
  assert.match(sheetHtml, /Claude uygulaması girişi/);
  assert.match(sheetHtml, /Limit okuma girişi/);
  assert.match(sheetHtml, /Claude uygulaması girişini yenile…/);
  assert.match(sheetHtml, /Code geçmişi/);
  assert.match(sheetHtml, /Limit okuma girişini yenile/);
  assert.doesNotMatch(sheetHtml, /Desktop girişi|tarayıcı girişi|Tarayıcı girişi/);
  assert.match(sheetHtml, /aria-label="Limit okuma girişini doğrula"/);
  assert.match(sheetHtml, /5 saatlik/);
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
