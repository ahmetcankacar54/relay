import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountHealth, displayedIssue, renewalIssue, usageSignInStatus } from "../src/lib/account-health";
import { accountRowSubtitle } from "../src/lib/account-row";
import { displayedIssue as sharedDisplayedIssue } from "../shared/account-state";
import { Disclosure } from "../src/components/Disclosure";
import { reconnectIssues } from "../src/app/Banners";
import { UsageCard } from "../src/features/UsageCard";
import { rowActions } from "../src/pages/accounts/AccountsTable";
import type { Relay } from "../src/data/relay-context";
import type { AccountFix } from "../src/lib/account-health";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type UsageIssue } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const desktop = {
  accountUuid: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  savedAt: iso(NOW),
};
const base: Account = {
  id: "a", name: "Kişisel", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  desktop, auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const noDesktop: Account = { ...base, desktop: undefined };
const noAuth: Account = { ...base, auth: undefined };
const ready: AccountUsage = { accountId: "a", status: "ready", stale: false, checkedAt: iso(NOW) };
const issue = (value: NonNullable<AccountUsage["issue"]>): AccountUsage => ({
  accountId: "a", status: "error", issue: value, stale: true,
});
const idle = { active: false, desktopRunning: false, waiting: false };
const tr = (language: "tr" | "en") => (a: string, b: string) => (language === "tr" ? a : b);
const health = (
  account: Account,
  usage: AccountUsage | undefined,
  context: Partial<typeof idle> = {},
  language: "tr" | "en" = "tr",
) => accountHealth(account, usage, { ...idle, ...context }, tr(language));

test("1. a pending browser approval wins over every other problem and has no fix", () => {
  const h = health(base, ready, { waiting: true });
  assert.equal(h.tone, "warn");
  assert.equal(h.label, "Tarayıcı onayı bekleniyor");
  assert.equal(h.fix, undefined);
  assert.equal(health(base, ready, { waiting: true }, "en").label, "Waiting for browser approval");
  // Even with no Claude app sign-in and an expired usage sign-in.
  const worst = health(noDesktop, issue("expired"), { waiting: true });
  assert.equal(worst.label, "Tarayıcı onayı bekleniyor");
  assert.equal(worst.fix, undefined);
});

test("2. no Claude app sign-in is off and offers to save it", () => {
  const h = health(noDesktop, ready);
  assert.deepEqual([h.tone, h.label, h.fix], ["off", "Claude uygulaması girişi yok", "desktop-link"]);
  assert.equal(health(noDesktop, ready, {}, "en").label, "No Claude app sign-in");
  // It outranks an expired usage sign-in.
  assert.equal(health(noDesktop, issue("expired")).label, "Claude uygulaması girişi yok");
});

test("3. a usage sign-in that needs renewing is critical and offers the usage sign-in", () => {
  for (const value of ["expired", "credentials-missing", "scope", "identity-mismatch"] as const) {
    const h = health(base, issue(value));
    assert.deepEqual([h.tone, h.label, h.fix], ["crit", "Limit okuma girişi gerekli", "cli"], value);
  }
  assert.equal(health(base, issue("expired"), {}, "en").label, "Usage sign-in needed");
  // A signed-out usage sign-in (an identity that is no longer logged in) is the same problem.
  const loggedOut: Account = { ...base, auth: { loggedIn: false, checkedAt: iso(NOW) } };
  assert.equal(health(loggedOut, ready).label, "Limit okuma girişi gerekli");
  // It outranks a locked Keychain.
  assert.equal(health(loggedOut, issue("keychain-locked")).label, "Limit okuma girişi gerekli");
});

test("4. a locked Keychain is a warning that a prompting renewal fixes", () => {
  const h = health(base, issue("keychain-locked"));
  assert.deepEqual([h.tone, h.label, h.fix], ["warn", "Anahtarlık izni gerekli", "renew"]);
  assert.equal(health(base, issue("keychain-locked"), {}, "en").label, "Keychain access needed");
});

test("5. a connection that needs renewing is a warning that a prompting renewal fixes", () => {
  for (const usage of [issue("renewal-required"), { ...ready, connectionRenewalRequired: true }]) {
    const h = health(base, usage);
    assert.deepEqual([h.tone, h.label, h.fix], ["warn", "Bağlantı yenilenmeli", "renew"]);
  }
  assert.equal(health(base, issue("renewal-required"), {}, "en").label, "Connection needs renewing");
  // It outranks a missing usage sign-in.
  assert.equal(health(noAuth, issue("renewal-required")).label, "Bağlantı yenilenmeli");
});

test("6. no usage sign-in is a warning that offers the usage sign-in", () => {
  const h = health(noAuth, undefined);
  assert.deepEqual([h.tone, h.label, h.fix], ["warn", "Limit okuma girişi yok", "cli"]);
  assert.equal(health(noAuth, undefined, {}, "en").label, "No usage sign-in");
});

test("7. the active account with Claude open is running", () => {
  const h = health(base, ready, { active: true, desktopRunning: true });
  assert.deepEqual([h.tone, h.label, h.fix], ["ok", "Çalışıyor", undefined]);
  assert.equal(health(base, ready, { active: true, desktopRunning: true }, "en").label, "Running");
});

test("8. everything else that works is ready", () => {
  for (const context of [idle, { ...idle, active: true }, { ...idle, desktopRunning: true }]) {
    const h = health(base, ready, context);
    assert.deepEqual([h.tone, h.label, h.fix], ["ok", "Hazır", undefined]);
  }
  assert.equal(health(base, ready, idle, "en").label, "Ready");
});

test("an account never read yet says there is no usage data, wherever it is shown", () => {
  for (const usage of [
    undefined,
    { accountId: "a", status: "idle" as const, stale: false },
    { accountId: "a", status: "loading" as const, stale: false },
  ]) {
    const name = usage?.status ?? "none";
    const h = health(base, usage);
    assert.deepEqual([h.tone, h.label, h.fix], ["off", "Limit verisi yok", undefined], name);
    assert.equal(health(base, usage, {}, "en").label, "No usage data yet", name);
    // Not "Çalışıyor" either while the account is open in Claude.
    assert.equal(health(base, usage, { active: true, desktopRunning: true }).label, "Limit verisi yok", name);
    // The Overview and the panel rows read the same status.
    const row = { account: base, usage, state: "unknown" as const, recommended: false };
    assert.equal(accountRowSubtitle(row, tr("tr"), "tr", "UTC", NOW), "Limit verisi yok", name);
    assert.equal(accountRowSubtitle(row, tr("en"), "en", "UTC", NOW), "No usage data yet", name);
  }
  // A sign-in problem still outranks it.
  assert.equal(health(noAuth, undefined).label, "Limit okuma girişi yok");
  // Loading again over an earlier reading stays ready.
  assert.equal(health(base, { ...ready, status: "loading" }).label, "Hazır");
});

test("a failed or old usage read is out of date, not ready, wherever the account is shown", () => {
  // Studio: a transient error (rate-limited, or the service down) keeps the previous limits, marked stale.
  const studio: AccountUsage = {
    accountId: "a", status: "error", issue: "rate-limited", stale: true,
    checkedAt: iso(NOW - 3 * 3_600_000), fiveHour: { usedPercent: 40 }, sevenDay: { usedPercent: 10 },
    retryAt: iso(NOW + 600_000),
  };
  for (const usage of [
    studio,
    { ...studio, issue: "unavailable" as const },
    // Old limits the service marks stale on its own.
    { ...ready, stale: true, checkedAt: iso(NOW - 3_600_000) },
    // A failed read with nothing kept.
    { accountId: "a", status: "error" as const, issue: "unavailable" as const, stale: false },
  ]) {
    const h = health(base, usage);
    assert.deepEqual([h.tone, h.label, h.fix], ["warn", "Limit verisi eski", undefined], usage.issue ?? "stale");
    assert.equal(health(base, usage, {}, "en").label, "Usage data is out of date");
    // The Overview and the panel rows read the same status.
    const row = { account: base, usage, state: "unknown" as const, recommended: false };
    assert.equal(accountRowSubtitle(row, tr("tr"), "tr", "UTC", NOW), "Limit verisi eski");
  }
  // The active account with Claude open is not "Çalışıyor" on old limits either.
  assert.equal(health(base, studio, { active: true, desktopRunning: true }).label, "Limit verisi eski");
  // A sign-in problem still outranks it.
  assert.equal(health(noAuth, studio).label, "Limit okuma girişi yok");
  // A fresh read stays ready, also while the next one loads.
  assert.equal(health(base, ready).label, "Hazır");
  assert.equal(health(base, { ...ready, status: "loading" }).label, "Hazır");
});

test("an account with several problems shows the highest one, and the next once it clears", () => {
  // Claude app sign-in saved, usage sign-in expired, a browser approval pending.
  assert.equal(health(base, issue("expired"), { waiting: true }).label, "Tarayıcı onayı bekleniyor");
  assert.equal(health(base, issue("expired")).label, "Limit okuma girişi gerekli");
});

test("detail names both sign-ins for each Claude app state", () => {
  const app = (account: Account, context: Partial<typeof idle>, language: "tr" | "en" = "tr") =>
    health(account, ready, context, language).detail;
  assert.equal(
    app(base, { active: true, desktopRunning: true }),
    "Claude uygulaması girişi: Çalışıyor · Limit okuma girişi: Bağlı",
  );
  assert.equal(app(base, {}), "Claude uygulaması girişi: Kayıtlı · Limit okuma girişi: Bağlı");
  assert.equal(app(noDesktop, {}), "Claude uygulaması girişi: Yok · Limit okuma girişi: Bağlı");
  assert.equal(
    app(base, { active: true, desktopRunning: true }, "en"),
    "Claude app sign-in: Running · Usage sign-in: Connected",
  );
  assert.equal(app(base, {}, "en"), "Claude app sign-in: Saved · Usage sign-in: Connected");
  assert.equal(app(noDesktop, {}, "en"), "Claude app sign-in: None · Usage sign-in: Connected");
  // Running means this account is the one Claude has open.
  assert.match(app(base, { desktopRunning: true }), /Claude uygulaması girişi: Kayıtlı/);
  assert.match(app(base, { active: true }), /Claude uygulaması girişi: Kayıtlı/);
});

test("detail names both sign-ins for each usage sign-in state", () => {
  const usageState = (account: Account, usage: AccountUsage | undefined, language: "tr" | "en" = "tr") =>
    health(account, usage, {}, language).detail.split(" · ").at(-1);
  assert.equal(usageState(base, ready), "Limit okuma girişi: Bağlı");
  assert.equal(usageState(base, undefined), "Limit okuma girişi: Bağlı");
  assert.equal(usageState(base, issue("renewal-required")), "Limit okuma girişi: Yenilenmeli");
  assert.equal(usageState(base, { ...ready, connectionRenewalRequired: true }), "Limit okuma girişi: Yenilenmeli");
  assert.equal(usageState(base, issue("expired")), "Limit okuma girişi: Gerekli");
  assert.equal(usageState(base, issue("scope")), "Limit okuma girişi: Gerekli");
  assert.equal(usageState(noAuth, undefined), "Limit okuma girişi: Yok");
  assert.equal(usageState(base, ready, "en"), "Usage sign-in: Connected");
  assert.equal(usageState(base, issue("renewal-required"), "en"), "Usage sign-in: Needs renewing");
  assert.equal(usageState(base, issue("expired"), "en"), "Usage sign-in: Needed");
  assert.equal(usageState(noAuth, undefined, "en"), "Usage sign-in: None");
  // A pending approval does not change what the sign-ins are.
  assert.equal(
    health(base, issue("expired"), { waiting: true }).detail,
    "Claude uygulaması girişi: Kayıtlı · Limit okuma girişi: Gerekli",
  );
});

test("the usage sign-in row's status agrees with the header's tone and the detail's usage state", () => {
  const status = (
    account: Account,
    usage: AccountUsage | undefined,
    waiting = false,
    language: "tr" | "en" = "tr",
  ) => usageSignInStatus(account, usage, waiting, tr(language));
  const loggedOut: Account = { ...base, auth: { loggedIn: false, checkedAt: iso(NOW) } };
  const cases: [string, Account, AccountUsage | undefined, string, string][] = [
    ["row 3", base, issue("expired"), "Gerekli", "Needed"],
    ["row 3, logged out", loggedOut, ready, "Gerekli", "Needed"],
    ["row 4", base, issue("keychain-locked"), "Bağlı · Anahtarlık izni gerekli", "Connected · Keychain access needed"],
    ["row 5", base, issue("renewal-required"), "Yenilenmeli", "Needs renewing"],
    ["row 5, connection flag", base, { ...ready, connectionRenewalRequired: true }, "Yenilenmeli", "Needs renewing"],
    ["row 6", noAuth, undefined, "Yok", "None"],
  ];
  for (const [name, account, usage, trLabel, enLabel] of cases) {
    const h = health(account, usage);
    const row = status(account, usage);
    assert.ok(h.tone !== "ok" && h.tone !== "off", name);
    // The row and the header never disagree about how bad it is.
    assert.equal(row.tone, h.tone, name);
    assert.equal(row.label, trLabel, name);
    assert.equal(status(account, usage, false, "en").label, enLabel, name);
    // Where the detail names the state in one word, the row starts with that word.
    assert.ok(h.detail.endsWith(`Limit okuma girişi: ${row.label.split(" · ")[0]}`), name);
  }
  assert.deepEqual(status(base, ready), { tone: "ok", label: "Bağlı" });
  assert.deepEqual(status(base, undefined, false, "en"), { tone: "ok", label: "Connected" });
  // A pending approval says so, whatever the sign-in's state.
  assert.deepEqual(status(base, issue("expired"), true), { tone: "warn", label: "Tarayıcı onayı bekleniyor" });
  assert.equal(status(base, ready, true, "en").label, "Waiting for browser approval");
});

test("a disclosure is a button that opens its content, and renders nothing while closed", () => {
  const render = (props: { defaultOpen?: boolean }) =>
    renderToStaticMarkup(
      createElement(Disclosure, { title: "Bağlantılar", ...props, children: createElement("p", null, "İçerik") }),
    );
  const closed = render({});
  assert.match(closed, /<button[^>]*aria-expanded="false"/);
  assert.match(closed, /<button[^>]*aria-controls="[^"]+"/);
  assert.match(closed, /Bağlantılar/);
  assert.doesNotMatch(closed, /İçerik/);
  assert.doesNotMatch(closed, /rotate-90/);
  const open = render({ defaultOpen: true });
  assert.match(open, /<button[^>]*aria-expanded="true"/);
  assert.match(open, /İçerik/);
  assert.match(open, /rotate-90/);
  // The button names the content it controls.
  const id = /aria-controls="([^"]+)"/.exec(open)?.[1];
  assert.ok(id);
  assert.ok(open.includes(`id="${id}"`));
});

test("displayedIssue reads the issue, else a connection to renew", () => {
  assert.equal(displayedIssue(undefined), undefined);
  assert.equal(displayedIssue(ready), undefined);
  assert.equal(displayedIssue({ ...ready, connectionRenewalRequired: true }), "renewal-required");
  assert.equal(displayedIssue(issue("expired")), "expired");
  // A reported issue wins over the flag: it is what the last read hit.
  assert.equal(displayedIssue({ ...issue("rate-limited"), connectionRenewalRequired: true }), "rate-limited");
  assert.equal(displayedIssue({ ...issue("keychain-locked"), connectionRenewalRequired: true }), "keychain-locked");
});

test("displayedIssue lives in shared/ and the app's helper is the same function", () => {
  assert.equal(typeof sharedDisplayedIssue, "function");
  assert.equal(sharedDisplayedIssue, displayedIssue);
  assert.equal(sharedDisplayedIssue({ ...ready, connectionRenewalRequired: true }), "renewal-required");
  assert.equal(sharedDisplayedIssue({ ...issue("rate-limited"), connectionRenewalRequired: true }), "rate-limited");
  assert.equal(sharedDisplayedIssue(undefined), undefined);
});

test("a connection flag left over from before does not ask for a renewal while the service is rate-limited or down", () => {
  for (const value of ["rate-limited", "unavailable"] as const) {
    const usage: AccountUsage = { ...issue(value), connectionRenewalRequired: true };
    assert.equal(renewalIssue(usage), undefined, value);
    // Renewing cannot run then, so the status falls through to the next rows: the failed read.
    const h = health(base, usage);
    assert.deepEqual([h.tone, h.label, h.fix], ["warn", "Limit verisi eski", undefined], value);
    assert.equal(h.detail, "Claude uygulaması girişi: Kayıtlı · Limit okuma girişi: Bağlı", value);
    assert.equal(health(noAuth, usage).label, "Limit okuma girişi yok", value);
    assert.deepEqual(usageSignInStatus(base, usage, false, tr("tr")), { tone: "ok", label: "Bağlı" }, value);
  }
  // Without the service problem, the flag still asks for the renewal.
  assert.equal(health(base, { ...ready, connectionRenewalRequired: true }).label, "Bağlantı yenilenmeli");
});

test("the status, the banner, the usage card and the row menu read the same issue", () => {
  const issues: UsageIssue[] = [
    "connect-cli", "credentials-missing", "keychain-locked", "renewal-required", "expired",
    "scope", "identity-mismatch", "rate-limited", "unavailable", "unsupported",
  ];
  const usages: [string, AccountUsage | undefined][] = [
    ["no usage", undefined],
    ["ready", ready],
    ["ready + flag", { ...ready, connectionRenewalRequired: true }],
    ...issues.flatMap((value): [string, AccountUsage][] => [
      [value, issue(value)],
      [`${value} + flag`, { ...issue(value), connectionRenewalRequired: true }],
    ]),
  ];
  const relay = (usage: AccountUsage | undefined) =>
    ({
      desktop: { available: true, running: false, recoveryRequired: false },
      desktopBusy: false,
      busy: "",
      usageBusy: new Set<string>(),
      data: { usage: { a: usage }, authFlows: [] },
    }) as unknown as Relay;
  const card = (usage: AccountUsage | undefined) =>
    renderToStaticMarkup(
      createElement(UsageCard, {
        usage,
        settings: DEFAULT_SETTINGS,
        now: NOW,
        language: "en",
        t: (_tr: string, en: string) => en,
        refresh() {},
        connect() {},
      }),
    );
  for (const [name, usage] of usages) {
    const renew = health(base, usage).fix === "renew";
    const banner = reconnectIssues([base], { a: usage }, new Set())[0];
    assert.equal(banner?.action === "renew", renew, `banner: ${name}`);
    if (banner) assert.equal(banner.issue, displayedIssue(usage), `banner key: ${name}`);
    assert.equal(/>(Allow renewal|Allow Keychain access)<\/button>/.test(card(usage)), renew, `usage card: ${name}`);
    assert.equal(rowActions(base, relay(usage), (t) => t).some((x) => x.key === "renew"), renew, `row menu: ${name}`);
  }
});

test("3. a usage sign-in of another account than the Claude app's is critical, before the lesser problems", () => {
  const other = { accountUuid: "00000000-0000-4000-8000-0000000000ff" };
  const mismatched: Account = { ...base, auth: { ...base.auth!, ...other } };
  const otherOrg: Account = { ...base, auth: { ...base.auth!, orgId: "00000000-0000-4000-8000-0000000000ee" } };
  for (const [name, account] of [["account", mismatched], ["organization", otherOrg]] as const)
    for (const usage of [ready, undefined, issue("keychain-locked"), issue("renewal-required"), { ...ready, connectionRenewalRequired: true }]) {
      const h = health(account, usage, { active: true, desktopRunning: true });
      assert.deepEqual([h.tone, h.label, h.fix], ["crit", "Limit okuma girişi gerekli", "cli"], `${name}: ${usage?.issue}`);
      assert.match(h.detail, /Limit okuma girişi: Gerekli$/, name);
      // The sheet's usage sign-in row agrees.
      assert.deepEqual(usageSignInStatus(account, usage, false, tr("tr")), { tone: "crit", label: "Gerekli" }, name);
    }
  assert.equal(health(mismatched, ready, {}, "en").label, "Usage sign-in needed");
  // A pending approval and a missing Claude app sign-in still come first.
  assert.equal(health(mismatched, ready, { waiting: true }).label, "Tarayıcı onayı bekleniyor");
  // The same identity is no mismatch.
  const same: Account = { ...base, auth: { ...base.auth!, accountUuid: desktop.accountUuid, orgId: desktop.orgId } };
  assert.equal(health(same, ready).label, "Hazır");
});

test("the status names only the fixes its rows produce", () => {
  // The fixes are only the ones a status row produces: Save, the usage sign-in and the prompting renew.
  const fixes: Record<AccountFix, true> = { "desktop-link": true, cli: true, renew: true };
  const produced = new Set(
    [
      health(noDesktop, ready),
      health(base, issue("expired")),
      health(base, issue("keychain-locked")),
      health(base, issue("renewal-required")),
      health(noAuth, undefined),
    ].map((h) => h.fix),
  );
  assert.deepEqual([...produced].sort(), Object.keys(fixes).sort());
});
