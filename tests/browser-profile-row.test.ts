import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountSheetBody,
  BrowserProfileRow,
} from "../src/pages/accounts/AccountSheet";
import {
  browserOptions,
  browserStatus,
  chosenLabel,
  openResultText,
} from "../src/pages/accounts/browserProfile";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import {
  DEFAULT_SETTINGS,
  type Account,
  type InstalledBrowser,
  type Snapshot,
} from "../shared/types";

const tr = (text: string) => text;
const en = (_: string, text: string) => text;
const NOW = "2026-10-19T10:00:00.000Z";
const base = { kind: "personal", group: "personal", color: "olive", createdAt: NOW } as const;
const vertex: Account = {
  ...base,
  id: "u",
  name: "Vertex",
  browser: { app: "brave", profile: "Default", name: "Work" },
};
const alto: Account = { ...base, id: "k", name: "Alto" };
const accounts = [vertex, alto];
const browsers: InstalledBrowser[] = [
  {
    app: "brave",
    profiles: [
      { profile: "Default", name: "Work", extension: true },
      { profile: "Profile 2", name: "Alto", extension: false },
    ],
  },
  { app: "chrome", profiles: [{ profile: "Default", name: "Your Chrome", extension: true }] },
];

test("options list every profile, mark one without the extension, and disable one another account uses", () => {
  assert.deepEqual(
    browserOptions(alto, accounts, browsers, tr).map((o) => [o.value, o.label, o.disabled]),
    [
      ["brave:Default", "Brave · Work · Vertex kullanıyor", true],
      ["brave:Profile 2", "Brave · Alto · eklenti yok", false],
      ["chrome:Default", "Chrome · Your Chrome", false],
    ],
  );
  // The account's own profile stays selectable.
  assert.equal(browserOptions(vertex, accounts, browsers, en)[0].disabled, false);
  assert.equal(browserOptions(alto, accounts, browsers, en)[0].label, "Brave · Work · used by Vertex");
});

test("the status says what opens after a switch, or what is wrong with it", () => {
  assert.deepEqual(browserStatus(alto, browsers, tr), {
    tone: "off",
    label: "Seçilmedi · geçişten sonra tarayıcıda bir şey açılmaz.",
  });
  assert.deepEqual(browserStatus(vertex, browsers, en), {
    tone: "ok",
    label: "Brave · Work · opened after a switch if it is closed.",
  });
  // Before the list arrives, the saved choice is shown as it is.
  assert.equal(browserStatus(vertex, undefined, tr).tone, "ok");
  const gone = { ...alto, browser: { app: "brave", profile: "Profile 7", name: "Old" } } as Account;
  assert.deepEqual(browserStatus(gone, browsers, tr), {
    tone: "warn",
    label: "Bu profil artık tarayıcıda yok: Brave · Old.",
  });
  const bare = { ...alto, browser: { app: "brave", profile: "Profile 2", name: "Alto" } } as Account;
  assert.deepEqual(browserStatus(bare, browsers, en), {
    tone: "warn",
    label: "Brave · Alto · the Claude extension is not installed in this profile.",
  });
  // A renamed profile shows its current name.
  const renamed = [{ ...browsers[0], profiles: [{ profile: "Default", name: "İş", extension: true }] }];
  assert.equal(chosenLabel(vertex, renamed), "Brave · İş");
});

test("Open now says what it did in both languages", () => {
  assert.equal(openResultText("opened", "Brave · Work", tr), "Tarayıcı profili açıldı: Brave · Work.");
  assert.equal(openResultText("open", "Brave · Work", en), "This profile is already open: Brave · Work.");
  assert.equal(openResultText("missing", "Brave · Work", tr), "Bu profil artık tarayıcıda yok: Brave · Work.");
  assert.equal(openResultText("failed", "Brave · Work", en), "Could not open the browser profile Brave · Work.");
  assert.equal(openResultText("none", "Brave · Work", tr), undefined);
});

function relayFor(platform: string, list: Account[] = accounts): Relay {
  return {
    api: {
      browserProfiles: () => new Promise(() => {}),
      desktopHistorySummary: () => new Promise(() => {}),
    },
    preview: false, error: "", notice: "", accounts: list, active: undefined,
    settings: DEFAULT_SETTINGS, busy: "", usageBusy: new Set<string>(),
    desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 },
    data: {
      settings: DEFAULT_SETTINGS, usage: {}, accounts: list, authFlows: [],
      diagnostics: { platform, desktopSupported: true, dataDir: "/x" },
    } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {},
  } as unknown as Relay;
}
const render = (relay: Relay, child: ReturnType<typeof createElement>, language: "tr" | "en" = "tr") =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language, setLanguage() {}, t: language === "tr" ? tr : en } },
      createElement(RelayContext.Provider, { value: relay }, child),
    ),
  );

test("the row shows the choice, Open now and the one-sign-in explanation", () => {
  const html = render(
    relayFor("darwin"),
    createElement(BrowserProfileRow, { account: vertex, initialBrowsers: browsers }),
  );
  assert.match(html, /Tarayıcı profili/);
  assert.match(html, /Brave · Work · geçişten sonra kapalıysa açılır\./);
  assert.match(html, /Şimdi aç/);
  assert.match(html, /bu hesapla bir kez giriş yap/);
  assert.match(html, /eklentiye giriş yapmaz, girişini okumaz/);
  const none = render(
    relayFor("darwin"),
    createElement(BrowserProfileRow, { account: alto, initialBrowsers: [] }),
    "en",
  );
  assert.match(none, /Choose a profile/);
  assert.doesNotMatch(none, /Open now/);
  assert.match(none, /No supported browser found/);
  assert.match(none, /sign in to the Claude extension there once, with this account/);
});

test("the sheet shows the row on macOS only", () => {
  // Connections open by themselves for an account that needs setup.
  const setup: Account = { ...alto, id: "s", name: "Setup" };
  const list = [...accounts, setup];
  assert.match(
    render(relayFor("darwin", list), createElement(AccountSheetBody, { account: setup })),
    /Tarayıcı profili/,
  );
  assert.doesNotMatch(
    render(relayFor("win32", list), createElement(AccountSheetBody, { account: setup })),
    /Tarayıcı profili/,
  );
});
