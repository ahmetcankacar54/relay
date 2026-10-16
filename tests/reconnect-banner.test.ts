import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Banners, reconnectCause } from "../src/app/Banners";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type Snapshot,
  type UsageIssue,
} from "../shared/types";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const account = (loggedIn = true): Account => ({
  id: "a",
  name: "Kişisel · Max",
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: iso(NOW),
  auth: { loggedIn, email: "a@example.com", checkedAt: iso(NOW) },
});
const usage = (issue?: UsageIssue): AccountUsage => ({
  accountId: "a",
  status: "error",
  stale: true,
  ...(issue ? { issue } : {}),
});
const pick = (language: Language) => (tr: string, en: string) =>
  language === "tr" ? tr : en;

const CAUSES: [string, UsageIssue | undefined, string, string][] = [
  [
    "expired",
    "expired",
    "oturumun süresi doldu ve yenilenemedi",
    "the session expired and could not be renewed",
  ],
  [
    "credentials-missing",
    "credentials-missing",
    "kayıtlı giriş bulunamadı",
    "the saved sign-in was not found",
  ],
  [
    "scope",
    "scope",
    "giriş kullanım verisine erişemiyor",
    "the sign-in cannot read usage",
  ],
  [
    "identity-mismatch",
    "identity-mismatch",
    "giriş başka bir hesaba ait",
    "the sign-in belongs to another account",
  ],
  [
    "anything else",
    "unavailable",
    "bağlantı kullanılamıyor",
    "the connection is unavailable",
  ],
  [
    "no issue at all",
    undefined,
    "bağlantı kullanılamıyor",
    "the connection is unavailable",
  ],
];

test("reconnectCause names the cause for every row, in both languages", () => {
  const out = account(false);
  assert.equal(
    reconnectCause(out, usage("expired"), pick("tr")),
    "giriş yapılmamış",
  );
  assert.equal(reconnectCause(out, undefined, pick("en")), "not signed in");
  for (const [name, issue, tr, en] of CAUSES) {
    assert.equal(reconnectCause(account(), usage(issue), pick("tr")), tr, name);
    assert.equal(reconnectCause(account(), usage(issue), pick("en")), en, name);
  }
  // A missing usage record is not a crash.
  assert.equal(
    reconnectCause(account(), undefined, pick("tr")),
    "bağlantı kullanılamıyor",
  );
});

function relayFor(usages: Record<string, AccountUsage>): Relay {
  const accounts = [account()];
  return {
    api: {},
    preview: false,
    error: "",
    notice: "",
    accounts,
    active: accounts[0],
    settings: DEFAULT_SETTINGS,
    busy: "",
    usageBusy: new Set<string>(),
    desktopBusy: false,
    desktop: {
      available: true,
      running: true,
      organizations: [],
      busy: false,
      recoveryRequired: false,
      errorRevision: 0,
    },
    data: {
      settings: DEFAULT_SETTINGS,
      usage: usages,
      accounts,
      authFlows: [],
    } as unknown as Snapshot,
    setNotice() {},
    startCli: async () => {},
    refreshUsage: async () => {},
    dismissError: async () => {},
  } as unknown as Relay;
}
const render = (relay: Relay, language: Language = "tr") =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language, setLanguage() {}, t: pick(language) } },
      createElement(
        RelayContext.Provider,
        { value: relay },
        createElement(Banners),
      ),
    ),
  );

test("the sign-in banner says what is wrong and what Reconnect does", () => {
  const tr = render(relayFor({ a: usage("expired") }));
  assert.match(
    tr,
    /Kişisel · Max · tarayıcı girişinin yenilenmesi gerekiyor: oturumun süresi doldu ve yenilenemedi\./,
  );
  assert.match(
    tr,
    /Yeniden bağlan, tarayıcıda bu hesabın Claude girişini açar\. Girişi onaylayınca uyarı kapanır\./,
  );
  assert.match(tr, /<button[^>]*>Yeniden bağlan<\/button>/);
  const en = render(relayFor({ a: usage("scope") }), "en");
  assert.match(
    en,
    /Kişisel · Max · the browser sign-in needs to be renewed: the sign-in cannot read usage\./,
  );
  assert.match(
    en,
    /Reconnect opens this account’s Claude sign-in in the browser\. The warning closes once you approve it\./,
  );
});

test("the explanation belongs to the sign-in banner only, not to the renewal banner", () => {
  const html = render(relayFor({ a: usage("renewal-required") }));
  assert.match(html, /Bağlantıyı yenile/);
  assert.doesNotMatch(html, /Yeniden bağlan, tarayıcıda/);
  assert.doesNotMatch(html, /oturumun süresi doldu/);
});
