import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddAccountSteps, profileInput } from "../src/pages/accounts/AddAccountDialog";
import { LinkDesktopBody } from "../src/pages/accounts/LinkDesktopDialog";
import { Accounts } from "../src/pages/Accounts";
import { ConnectionPanels } from "../src/app/ConnectionPanels";
import { routeQuery } from "../src/app/routes";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AuthFlow, type Snapshot } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const a: Account = {
  id: "a", name: "Kişisel · Max", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  desktop: { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW) },
};
const b: Account = { id: "b", name: "Studio", kind: "personal", group: "personal", color: "blue", createdAt: iso(NOW) };
const w: Account = { id: "w", name: "Şirket", kind: "work", group: "work:Ekip", color: "plum", createdAt: iso(NOW) };
const accounts = [a, b, w];

function relayFor(extra: Partial<Relay> = {}): Relay {
  return {
    api: {}, preview: false, error: "", notice: "", accounts, active: a, settings: DEFAULT_SETTINGS, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "a" },
    data: { settings: DEFAULT_SETTINGS, usage: {}, accounts, authFlows: [] } as unknown as Snapshot,
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

test("profileInput trims and keeps the group only for work accounts", () => {
  assert.deepEqual(profileInput("  Kişisel Max ", "personal", "x"), { name: "Kişisel Max", kind: "personal" });
  assert.deepEqual(profileInput("Vertex", "work", " vertex "), { name: "Vertex", kind: "work", group: "vertex" });
  assert.deepEqual(profileInput("Ayrı", "work", "  "), { name: "Ayrı", kind: "work" });
});

test("routeQuery reads the intent after the page id", () => {
  assert.equal(routeQuery("#/hesaplar?ekle"), "ekle");
  assert.equal(routeQuery("#/hesaplar?eslestir"), "eslestir");
  assert.equal(routeQuery("#/hesaplar"), "");
  assert.equal(routeQuery(""), "");
});

test("the add-account dialog shows the three steps and the profile form", () => {
  const html = wrap(relayFor(), createElement(AddAccountSteps, { close() {} }));
  assert.match(html, /Profil/);
  assert.match(html, /Desktop bağlantısı/);
  assert.match(html, /Limit bağlantısı/);
  assert.match(html, /Hesap adı/);
  assert.match(html, /placeholder="Örn. Kişisel Max"/);
  assert.match(html, /Kişisel/);
  assert.match(html, /Şirket/);
  assert.match(html, /Kişisel hesapların Code geçmişi aynı grupta korunur./);
  assert.match(html, /Profil oluştur/);
  assert.match(html, /aria-current="step"/);
});

test("the add-account dialog walks the Desktop and limit steps for the created profile", () => {
  const desktopStep = wrap(relayFor(), createElement(AddAccountSteps, { close() {}, initial: { step: 2, id: "b" } }));
  assert.match(desktopStep, /Desktop ilk kurulumu/);
  assert.match(desktopStep, /Desktop bağlantısını başlat…/);
  assert.match(desktopStep, /Atla/);
  const pending = wrap(relayFor({ pendingDesktop: b }), createElement(AddAccountSteps, { close() {}, initial: { step: 2, id: "b" } }));
  assert.match(pending, /Claude’da giriş bekleniyor/);
  const limitStep = wrap(relayFor(), createElement(AddAccountSteps, { close() {}, initial: { step: 3, id: "b" } }));
  assert.match(limitStep, /Tarayıcıda bağla/);
  assert.match(limitStep, /Bitti/);
});

test("the Desktop link dialog lists unlinked profiles", () => {
  const html = wrap(relayFor({ hasUnclaimedDesktop: true }), createElement(LinkDesktopBody, { picked() {} }));
  assert.match(html, /Claude’da açık olan hesap/);
  assert.match(html, /Studio/);
  assert.match(html, /Şirket/);
  assert.doesNotMatch(html, /<option[^>]*>Kişisel · Max/);
});

test("the accounts header offers Desktop linking only while an unclaimed Desktop account is open", () => {
  assert.match(wrap(relayFor({ hasUnclaimedDesktop: true }), createElement(Accounts)), /Desktop hesabını eşleştir/);
  assert.doesNotMatch(wrap(relayFor(), createElement(Accounts)), /Desktop hesabını eşleştir/);
});

test("connection panels keep their ids, live regions and copy", () => {
  const flow = { id: "f", accountId: "b", status: "waiting", browserReady: true } as unknown as AuthFlow;
  const html = wrap(relayFor({ pendingDesktop: b, flow, flowAccount: b }), createElement(ConnectionPanels));
  assert.match(html, /id="desktop-pending-panel"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="desktop-pending-panel"/);
  assert.match(html, /id="cli-connection-panel"/);
  assert.match(html, /Studio · Desktop bağlantısı/);
  assert.match(html, /Claude’u yeniden aç/);
  assert.match(html, /Tarayıcı onayı bekleniyor/);
  assert.match(html, /Tarayıcıyı yeniden aç/);
  assert.match(html, /2 \/ 3/);
});
