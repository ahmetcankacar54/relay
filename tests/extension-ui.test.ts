import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDetailBody, ExtensionRow } from "../src/pages/accounts/AccountDetail";
import { ExtensionPreference } from "../src/features/ExtensionPreference";
import {
  instanceLine,
  modeOptions,
  modeSentence,
  pairedAccounts,
  extensionGuide,
  startupLine,
} from "../src/lib/extension-ui";
import { extensionLine } from "../shared/extension-text";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { FOCUS_CHECK_MS, focusChecks, useExtensionStatus } from "../src/data/useExtension";
import { fakeDom } from "./fake-dom";
import { BROWSER_APPS, BROWSERS, chooseInstance, type ExtensionOutcome, type ExtensionStatus } from "../shared/browser-extension";
import { DEFAULT_SETTINGS, type Account, type Snapshot } from "../shared/types";

const tr = (text: string) => text;
const en = (_: string, text: string) => text;
const NOW = "2026-10-21T10:00:00.000Z";
const base = { kind: "personal", group: "personal", color: "olive", createdAt: NOW } as const;
const ID = "11111111-1111-4111-8111-111111111111";
const vertex: Account = {
  ...base,
  id: "u",
  name: "Vertex",
  desktop: { accountUuid: ID.toUpperCase(), orgId: "22222222-2222-4222-8222-222222222222", savedAt: NOW },
};
const alto: Account = { ...base, id: "k", name: "Alto" };
const brave = { app: "brave", profile: "Default", name: "Kişisel", opened: true } as const;
const status = (over: Partial<ExtensionStatus> = {}): ExtensionStatus => ({
  setting: { mode: "restart" },
  instances: [brave],
  target: brave,
  restoresTabs: false,
  saved: [{ accountUuid: ID, savedAt: "2026-10-20T08:00:00.000Z" }],
  cookiesSaved: [],
  ...over,
});

const ANKA = "33333333-3333-4333-8333-333333333333";
const ankaLinked: Account = { ...alto, desktop: { accountUuid: ANKA, orgId: ID, savedAt: NOW, email: "alto@example.com" } };
const guide = (account: Account, over: Partial<ExtensionStatus> = {}, t: (tr: string, en: string) => string = tr, language: "tr" | "en" = "tr") =>
  extensionGuide(account, status(over), [vertex, ankaLinked], t, language);
const signedIn = (accountUuid: string) => ({ state: "signed-in" as const, accountUuid, known: true, at: NOW });

test("a saved sign-in reads as linked, matching the uuid in any case", () => {
  assert.deepEqual(
    { tone: guide(vertex).tone, label: guide(vertex).label },
    { tone: "ok", label: "Bağlı" },
  );
  assert.equal(guide(vertex, {}, en, "en").detail, "Saved 20 Oct. Switching to this account brings the extension along.");
  assert.equal(guide(vertex).where, "Brave · Kişisel");
  // The extension on this account now says so.
  assert.equal(guide(vertex, { current: signedIn(ID) }).label, "Bağlı, şu an bu hesapta");
  assert.equal(extensionGuide(alto, undefined, [], tr, "tr").label, "Kontrol ediliyor…");
});

test("an unlinked account gets the steps to link it, for each thing the extension is on", () => {
  // Not checked yet: it is being checked.
  assert.equal(guide(ankaLinked).action, "check");
  // Signed out: open it, sign in with this email, check.
  const out = guide(ankaLinked, { current: { state: "signed-out", at: NOW } });
  assert.equal(out.tone, "warn");
  assert.match(out.label, /Eklentide giriş yok/);
  assert.deepEqual(out.steps, [
    "Tarayıcıda Claude eklentisini aç.",
    "alto@example.com ile giriş yap.",
    "“Kontrol et”e bas.",
  ]);
  assert.match(out.detail ?? "", /tanıyamıyor/);
  // On another of Relay's accounts: sign out first, and that account stays saved.
  const other = guide(ankaLinked, { current: signedIn(ID) });
  assert.match(other.label, /Eklenti Vertex hesabında/);
  assert.match(other.steps?.[0] ?? "", /çıkış yap/);
  assert.match(other.detail ?? "", /Vertex için kayıt Relay’de duruyor/);
  // On an account Relay does not have.
  const stranger = guide(ankaLinked, { current: { state: "signed-in", known: false, other: true, at: NOW } });
  assert.match(stranger.label, /Eklenti başka bir claude\.ai hesabında/);
  assert.match(stranger.detail ?? "", /Relay’deki hiçbir hesaba ait değil/);
  // Signed in, but no account can be told: the user links it as this one.
  const untold = guide(ankaLinked, { current: { state: "signed-in", known: false, at: NOW } });
  assert.match(untold.label, /Eklentideki hesap tanınamadı/);
  assert.equal(untold.action, "claim");
  assert.match(untold.steps?.[0] ?? "", /alto@example\.com/);
  // Unreadable: try again.
  const unreadable = guide(ankaLinked, { current: { state: "unreadable", at: NOW } });
  assert.equal(unreadable.tone, "crit");
  assert.equal(unreadable.action, "check");
});

test("the guide says when the feature is off, there is no extension, or no browser can be told apart", () => {
  assert.equal(guide(vertex, { setting: { mode: "off" } }).label, "Kapalı");
  assert.equal(guide(vertex, { setting: { mode: "off" } }).action, "settings");
  assert.match(guide(vertex, { instances: [], target: undefined }, en, "en").label, /No Claude extension found/);
  assert.equal(guide(vertex, { target: undefined }).action, "settings");
  // Picked as the one used last: said next to the browser.
  assert.equal(guide(vertex, { picked: "recent" }).where, "Brave · Kişisel (en son kullanılan)");
});

test("with several browsers and none chosen, the one whose extension was used last is followed", () => {
  const chrome = { app: "chrome", profile: "Default", name: "Kişi 1", opened: true, usedAt: 1 } as const;
  const braveUsed = { ...brave, usedAt: 2 };
  assert.equal(chooseInstance([chrome, braveUsed], undefined), braveUsed);
  assert.equal(chooseInstance([chrome, braveUsed], { app: "chrome", profile: "Default" }), chrome);
  // Without dates nothing can be told apart: none is followed.
  assert.equal(chooseInstance([{ ...chrome, usedAt: undefined }, brave], undefined), undefined);
});

test("each mode has a label and a sentence in both languages", () => {
  assert.deepEqual(modeOptions(en).map((o) => o.value), ["off", "guide", "closed", "restart"]);
  for (const mode of ["restart", "closed", "guide", "off"] as const) {
    assert.ok(modeSentence(mode, tr).length > 10);
    assert.notEqual(modeSentence(mode, tr), modeSentence(mode, en));
  }
  assert.match(modeSentence("restart", en), /closed for a moment and opened again with its tabs/);
  assert.match(modeSentence("closed", en), /only when the browser is closed/);
  // The modes that write to the browser say that claude.ai follows, and how to avoid that.
  for (const mode of ["restart", "closed"] as const) {
    assert.match(modeSentence(mode, en), /changes that login too, so claude\.ai tabs open on the new account/);
    assert.match(modeSentence(mode, en), /separate browser profile/);
    assert.match(modeSentence(mode, tr), /claude\.ai oturumunu da değiştirir/);
    assert.match(modeSentence(mode, tr), /ayrı bir tarayıcı profilinde/);
  }
  // Guide writes nothing and quits nothing; off says it never touches.
  assert.match(modeSentence("guide", en), /changes nothing in the browser or the extension and never quits the browser/);
  assert.doesNotMatch(modeSentence("guide", en), /changes that login/);
  assert.equal(modeOptions(en).find((o) => o.value === "guide")?.label, "Only tell me");
  assert.equal(modeOptions(tr).find((o) => o.value === "guide")?.label, "Sadece haber ver");
});

test("the card names the instance, asks to choose among several, and explains the startup setting", () => {
  assert.equal(instanceLine(status(), en), "Brave · Kişisel · extension installed");
  assert.match(
    instanceLine(status({ instances: [brave, { app: "chrome", profile: "Default", name: "Your Chrome", opened: true }], target: undefined }), en),
    /several browser profiles/,
  );
  assert.match(instanceLine(status({ instances: [], target: undefined }), tr), /bulunamadı/);
  assert.match(startupLine(status(), en)!, /new tab page by its own setting, so Relay restores the tabs itself/);
  assert.match(startupLine(status({ restoresTabs: true }), en)!, /reopens the last tabs by its own setting/);
  assert.equal(startupLine(status({ target: undefined }), en), undefined);
});

const outcome = (over: Partial<ExtensionOutcome>): ExtensionOutcome => ({
  result: "switched",
  at: NOW,
  restarted: false,
  saved: true,
  ...over,
});

test("each outcome says what happened, or nothing when there is nothing to say", () => {
  assert.equal(extensionLine(outcome({}), en), "The extension’s sign-in was switched.");
  assert.match(extensionLine(outcome({ result: "saved", reason: "no-saved-login" }), tr)!, /Eklentinin önceki girişi kaydedildi/);
  assert.match(extensionLine(outcome({ result: "unchanged", reason: "no-saved-login" }), en)!, /no saved extension sign-in/);
  assert.equal(extensionLine(outcome({ result: "unchanged", reason: "already-there" }), en), undefined);
  assert.equal(extensionLine(outcome({ result: "skipped", reason: "off" }), en), undefined);
  assert.equal(extensionLine(outcome({ result: "skipped", reason: "not-installed" }), en), undefined);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "browser-running" }), tr)!, /Tarayıcı açık olduğu için/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "browser-did-not-quit" }), en)!, /did not quit/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "unknown-account" }), en)!, /does not have/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "choose-instance" }), en)!, /several browser profiles/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "unavailable" }), en)!, /use Relay\.app: Settings → What comes along → Claude browser extension → Sync now/);
  assert.match(extensionLine(outcome({ result: "failed", reason: "write-failed" }), en)!, /was put back/);
  assert.match(extensionLine(outcome({ result: "failed", reason: "locked" }), en)!, /open in another process/);
  assert.match(extensionLine(outcome({ result: "failed", reason: "restore-failed" }), en)!, /extension-scratch/);
  assert.match(extensionLine(outcome({ result: "failed", reason: "unreadable" }), en)!, /Could not read/);
  // A browser Relay quit and could not open again is said even when the step had nothing to say.
  assert.match(
    extensionLine(outcome({ result: "unchanged", reason: "already-there", restarted: true, reopened: false }), en)!,
    /Could not open the browser again/,
  );
  assert.match(
    extensionLine(outcome({ restarted: true, reopened: false }), tr)!,
    /Eklenti girişi değişti\. Tarayıcı yeniden açılamadı/,
  );
});

function relayFor(platform: string, list: Account[], extension?: ExtensionStatus["setting"]): Relay {
  const settings = extension ? { ...DEFAULT_SETTINGS, claudeExtension: extension } : DEFAULT_SETTINGS;
  return {
    api: {
      extensionStatus: () => new Promise(() => {}),
      checkExtension: () => new Promise(() => {}),
      desktopHistorySummary: () => new Promise(() => {}),
    },
    preview: false, error: "", notice: "", accounts: list, active: undefined,
    settings, busy: "", usageBusy: new Set<string>(),
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

test("the account row shows the state and its steps, and no browser profile picker is left", () => {
  const html = render(
    relayFor("darwin", [vertex, alto]),
    createElement(ExtensionRow, { account: vertex, initialStatus: status() }),
  );
  assert.match(html, /Tarayıcı eklentisi/);
  assert.match(html, />Bağlı<\/span>.*Nasıl çalışır\?/);
  assert.doesNotMatch(html, /Tarayıcı profili|Şimdi aç|Open now/);
  const none = render(
    relayFor("darwin", [vertex, ankaLinked]),
    createElement(ExtensionRow, {
      account: ankaLinked,
      initialStatus: status({ current: { state: "signed-out", at: NOW } }),
    }),
    "en",
  );
  assert.match(none, /The extension is signed out/);
  assert.match(none, /<ol[^>]*>.*Sign in with alto@example\.com\./);
  assert.match(none, />Check<\/button>/);
});

test("the sheet shows the row on macOS only", () => {
  const setup: Account = { ...alto, id: "s", name: "Setup" };
  const list = [vertex, alto, setup];
  assert.match(
    render(relayFor("darwin", list), createElement(AccountDetailBody, { account: setup })),
    /Tarayıcı eklentisi/,
  );
  assert.doesNotMatch(
    render(relayFor("win32", list), createElement(AccountDetailBody, { account: setup })),
    /Tarayıcı eklentisi/,
  );
});

test("the settings card shows the mode with its sentence, the instance, the startup note and Sync now", () => {
  // Nothing chosen yet: Relay only guides.
  const guided = render(
    relayFor("darwin", [vertex]),
    createElement(ExtensionPreference, { initialStatus: status({ setting: { mode: "guide" } }), openDetails: true }),
  );
  assert.match(guided, /Sadece haber ver/);
  assert.match(guided, /Geçişte Relay tarayıcıda ve eklentide hiçbir şeyi değiştirmez/);
  assert.match(guided, /menü çubuğu panelinde “Geçir” çıkar/);
  assert.doesNotMatch(guided, /claude\.ai oturumunu da değiştirir/);
  const html = render(
    relayFor("darwin", [vertex], { mode: "restart" }),
    createElement(ExtensionPreference, { initialStatus: status(), openDetails: true }),
  );
  assert.match(html, /Claude tarayıcı eklentisi/);
  assert.match(html, />Tarayıcıyı kapatıp aç</);
  // Closed, Gelişmiş keeps the profile, Sync now and the long sentences out of sight.
  const closed = render(
    relayFor("darwin", [vertex], { mode: "restart" }),
    createElement(ExtensionPreference, { initialStatus: status() }),
  );
  assert.match(closed, /Eklenti de geçsin/);
  assert.match(closed, />Gelişmiş</);
  assert.doesNotMatch(closed, /Şimdi eşitle|Açık bir tarayıcıyı kısa süreliğine/);
  assert.match(html, /Açık bir tarayıcıyı kısa süreliğine kapatıp sekmeleriyle yeniden açar/);
  assert.match(html, /claude\.ai oturumunu da değiştirir/);
  assert.match(html, /Brave · Kişisel · eklenti yüklü/);
  assert.match(html, /Relay onları kendisi geri yükler/);
  assert.match(html, /Şimdi eşitle/);
  // One instance: no picker for the profile.
  assert.doesNotMatch(html, /Eklentinin tarayıcı profili/);
  const several = render(
    relayFor("darwin", [vertex]),
    createElement(ExtensionPreference, {
      initialStatus: status({
        instances: [brave, { app: "chrome", profile: "Default", name: "Your Chrome", opened: true }],
        target: undefined,
      }),
    }),
    "en",
  );
  assert.match(several, /The extension’s browser profile/);
  assert.match(several, /Choose a profile/);
  // Not on this Mac: the card is not drawn at all.
  assert.equal(render(relayFor("darwin", [vertex]), createElement(ExtensionPreference, {})), "");
});

test("the new reasons have a sentence in both languages, and none names a token or a cookie", () => {
  for (const reason of ["guide-mismatch", "ambiguous-owner", "schema-changed", "journal-pending"] as const) {
    const o = outcome({ result: "skipped", reason });
    const trText = extensionLine(o, tr);
    const enText = extensionLine(o, en);
    assert.ok(trText && enText, reason);
    assert.doesNotMatch(trText + enText, /sessionKey|token|SECRET/i);
  }
  assert.match(extensionLine(outcome({ result: "failed", reason: "schema-changed" }), en)!, /cookie layout/);
  assert.match(extensionLine(outcome({ result: "failed", reason: "journal-pending" }), en)!, /not closed cleanly/);
});

test("a pair is complete only with the extension's hints and the claude.ai login both saved", () => {
  const uuid = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const mk = (name: string, n: number): Account => ({ ...base, id: name, name, desktop: { accountUuid: uuid(n).toUpperCase(), orgId: ID, savedAt: NOW } });
  const accounts = [mk("Vertex", 1), mk("Kişisel", 2), mk("Alto", 3), alto];
  const saved = (n: number) => ({ accountUuid: uuid(n), savedAt: NOW });
  const result = pairedAccounts(status({ saved: [saved(1), saved(2)], cookiesSaved: [saved(1), saved(3)] }), accounts);
  assert.deepEqual(result, { paired: ["Vertex"], half: ["Kişisel", "Alto"] });
  assert.deepEqual(pairedAccounts(status({ saved: [], cookiesSaved: [] }), accounts), { paired: [], half: [] });
  const html = render(
    relayFor("darwin", accounts, { mode: "closed" }),
    createElement(ExtensionPreference, { initialStatus: status({ setting: { mode: "closed" }, saved: [saved(1), saved(2)], cookiesSaved: [saved(1), saved(3)] }), openDetails: true }),
    "en",
  );
  assert.match(html, /Saved accounts/);
  assert.match(html, /Extension sign-in and claude\.ai login both saved: Vertex\./);
  assert.match(html, /Missing one of the two: Kişisel, Alto\./);
});

test("the extension check runs again when the setting changes, not for each snapshot's fresh copy of it", async () => {
  let checks = 0;
  // One api for the window's life, as the app's; the settings are a new copy each time.
  const api = {
    checkExtension: async () => {
      checks++;
      return undefined;
    },
    extensionStatus: async () => undefined,
  };
  const relay = (mode: "restart" | "guide") =>
    ({ api, settings: { ...DEFAULT_SETTINGS, claudeExtension: { mode } } }) as unknown as Relay;
  function Probe() {
    useExtensionStatus({ check: true });
    return null;
  }
  const dom = fakeDom();
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const draw = (value: Relay) =>
      act(async () =>
        root.render(createElement(RelayContext.Provider, { value }, createElement(Probe))),
      );
    await draw(relay("restart"));
    await draw(relay("restart"));
    await draw(relay("restart"));
    assert.equal(checks, 1);
    await draw(relay("guide"));
    assert.equal(checks, 2);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("an account without a saved Claude app sign-in is told to save it first, never to sign out", () => {
  // Alto has no uuid: whatever the extension is on, nothing can be linked to it yet.
  for (const current of [
    undefined,
    { state: "signed-out", at: NOW } as const,
    { state: "signed-in", known: false, other: true, at: NOW } as const,
    { state: "signed-in", known: false, at: NOW } as const,
    signedIn(ID),
  ]) {
    const g = guide(alto, current ? { current } : {});
    assert.equal(g.tone, "warn");
    assert.match(g.label, /Önce Claude uygulaması girişini kaydet/);
    assert.equal(g.steps, undefined);
    assert.equal(g.action, undefined);
    assert.doesNotMatch(g.detail ?? "", /çıkış/);
  }
  assert.match(guide(alto, {}, en, "en").label, /Save the Claude app sign-in first/);
});

test("an extension that was never opened is to be opened and signed in to, then checked", () => {
  const unopened = { ...brave, opened: false };
  const g = guide(ankaLinked, {
    instances: [unopened],
    target: unopened,
    current: { state: "signed-out", unopened: true, at: NOW },
  });
  assert.equal(g.tone, "warn");
  assert.match(g.label, /Eklenti hiç açılmamış/);
  assert.equal(g.steps?.[0], "Eklentiyi tarayıcıda bir kez aç.");
  assert.equal(g.action, "check");
  assert.match(
    extensionLine({ result: "skipped", reason: "not-opened", at: NOW, restarted: false, saved: false }, en) ?? "",
    /never opened/,
  );
});

test("the browsers looked in are every browser Relay knows, in both places", () => {
  const names = BROWSER_APPS.map((app) => BROWSERS[app].name);
  assert.ok(names.includes("Arc") && names.includes("Chrome Canary") && names.includes("Comet"));
  const none = { instances: [], target: undefined };
  const line = instanceLine(status(none), en);
  const detail = guide(vertex, none, en, "en").detail ?? "";
  for (const name of names) {
    assert.ok(line.includes(name), name);
    assert.ok(detail.includes(name), name);
  }
  assert.match(detail, /, Dia and Comet\.$/);
  assert.match(guide(vertex, none).detail ?? "", / ve Comet\.$/);
});

test("a focus checks again only while shown, at most once every few seconds", () => {
  assert.equal(focusChecks(10_000, undefined, true), true);
  assert.equal(focusChecks(10_000, 10_000 - FOCUS_CHECK_MS + 1, true), false);
  assert.equal(focusChecks(10_000, 10_000 - FOCUS_CHECK_MS, true), true);
  assert.equal(focusChecks(10_000, undefined, false), false);
});

test("coming back to the window checks the extension again, throttled and only with check", async () => {
  let checks = 0;
  const api = {
    checkExtension: async () => {
      checks++;
      return undefined;
    },
    extensionStatus: async () => undefined,
  };
  const value = { api, settings: { ...DEFAULT_SETTINGS, claudeExtension: { mode: "guide" } } } as unknown as Relay;
  function Probe({ check }: { check: boolean }) {
    useExtensionStatus({ check });
    return null;
  }
  const dom = fakeDom();
  dom.install();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const draw = (check: boolean) =>
      act(async () => root.render(createElement(RelayContext.Provider, { value }, createElement(Probe, { check }))));
    const focus = () => act(async () => void dom.emit("focus"));
    await draw(true);
    assert.equal(checks, 1);
    // Right after the check on open: too soon.
    await focus();
    assert.equal(checks, 1);
    now += FOCUS_CHECK_MS;
    await focus();
    assert.equal(checks, 2);
    await focus();
    assert.equal(checks, 2);
    // Hidden: a focus does nothing.
    now += FOCUS_CHECK_MS;
    dom.setVisibility("hidden");
    await focus();
    assert.equal(checks, 2);
    dom.setVisibility("visible");
    await focus();
    assert.equal(checks, 3);
    // Without check there is no focus listener at all.
    await draw(false);
    assert.equal(dom.windowListeners("focus"), 0);
    await act(async () => root.unmount());
  } finally {
    Date.now = realNow;
    dom.uninstall();
  }
});
