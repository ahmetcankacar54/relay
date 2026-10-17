import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountHealth, usageSignInStatus } from "../src/lib/account-health";
import { Disclosure } from "../src/components/Disclosure";
import type { Account, AccountUsage } from "../shared/types";

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
  assert.deepEqual([h.tone, h.label, h.fix], ["ok", "Açık", undefined]);
  assert.equal(health(base, ready, { active: true, desktopRunning: true }, "en").label, "Running");
});

test("8. everything else that works is ready", () => {
  for (const context of [idle, { ...idle, active: true }, { ...idle, desktopRunning: true }]) {
    const h = health(base, ready, context);
    assert.deepEqual([h.tone, h.label, h.fix], ["ok", "Hazır", undefined]);
  }
  assert.equal(health(base, undefined, idle, "en").label, "Ready");
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
    "Claude uygulaması girişi: Açık · Limit okuma girişi: Bağlı",
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
