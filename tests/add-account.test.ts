import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddAccountSteps } from "../src/pages/accounts/AddAccountDialog";
import { ProfileFields, profileInput } from "../src/features/ProfileFields";
import { LinkDesktopBody } from "../src/pages/accounts/LinkDesktopDialog";
import { Accounts, intentAllowed } from "../src/pages/Accounts";
import { ConnectionPanels } from "../src/app/ConnectionPanels";
import { DesktopActionReview, type DesktopActionKind } from "../src/features/DesktopActionReview";
import { routeQuery } from "../src/app/routes";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AuthFlow, type DesktopState, type Diagnostics, type RelaySettings, type Snapshot } from "../shared/types";

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

test("profileInput trims and keeps the group only for work accounts that show it", () => {
  assert.deepEqual(profileInput({ name: "  Kişisel Max ", kind: "personal", group: "x" }, true), { name: "Kişisel Max", kind: "personal" });
  assert.deepEqual(profileInput({ name: "Vertex", kind: "work", group: " vertex " }, true), { name: "Vertex", kind: "work", group: "vertex" });
  assert.deepEqual(profileInput({ name: "Ayrı", kind: "work", group: "  " }, true), { name: "Ayrı", kind: "work" });
  assert.deepEqual(profileInput({ name: "Vertex", kind: "work", group: "vertex" }, false), { name: "Vertex", kind: "work" });
});

test("routeQuery reads the intent after the page id", () => {
  assert.equal(routeQuery("#/hesaplar?ekle"), "ekle");
  assert.equal(routeQuery("#/hesaplar?eslestir"), "eslestir");
  assert.equal(routeQuery("#/hesaplar"), "");
  assert.equal(routeQuery(""), "");
});

test("the add-account dialog starts with the Claude app sign-in: no form, one button", () => {
  const html = wrap(relayFor(), createElement(AddAccountSteps, { close() {} }));
  assert.match(html, /Adım 1 \/ 3/);
  assert.match(html, /1 · Claude girişi/);
  assert.match(html, /2 · Limit izni/);
  assert.match(html, /3 · Hazır/);
  assert.match(html, /aria-current="step"/);
  assert.doesNotMatch(html, /Hesap adı/);
  assert.match(html, /Yeni hesapla giriş yap/);
  assert.match(html, /Relay girişi kendisi kaydeder/);
  assert.match(html, /<button[^>]*>Claude’u giriş ekranıyla aç…<\/button>/);
  // An account open in the Claude app that Relay has not saved is offered instead.
  const current = wrap(relayFor({ hasUnclaimedDesktop: true }), createElement(AddAccountSteps, { close() {} }));
  assert.match(current, /Claude uygulamasında açık hesabı ekle/);
  assert.match(current, /<button[^>]*>Bu hesabı ekle…<\/button>/);
});

test("the profile fields' group field and history note follow the sharing mode", () => {
  const form = (mode: RelaySettings["desktopHistoryTransfer"], kind: "personal" | "work") =>
    wrap(
      relayFor({ settings: { ...DEFAULT_SETTINGS, desktopHistoryTransfer: mode } }),
      createElement(ProfileFields, { id: "add-account", value: { name: "x", kind, group: "" }, onChange() {} }),
    );
  // A new install shares within groups: the field and both of its sentences are true.
  const group = form("same-group", "work");
  assert.match(group, /id="add-account-group"/);
  assert.match(group, /Aynı gruptaki şirket hesapları Code geçmişini paylaşır/);
  assert.match(group, /Boş bırakırsan bu şirket hesabı ayrı tutulur\./);
  assert.match(form("same-group", "personal"), /Kişisel hesaplar yerel Code geçmişini paylaşır\./);
  assert.doesNotMatch(form("same-group", "personal"), /id="add-account-group"/);
  // Anywhere else the group is ignored, so there is no field and no group sentence.
  for (const [mode, note] of [
    ["all", /Code geçmişi bağlı tüm hesaplar arasında ortak\. Geçiş sayfasından değiştirebilirsin\./],
    ["selected", /Code geçmişi yalnızca Geçiş sayfasında seçtiğin hesaplar arasında ortak\./],
    ["off", /Code geçmişi hesaplar arasında paylaşılmıyor\./],
  ] as const)
    for (const kind of ["personal", "work"] as const) {
      const html = form(mode, kind);
      assert.doesNotMatch(html, /id="add-account-group"|add-account-groups/, `${mode} ${kind}`);
      assert.match(html, note, `${mode} ${kind}`);
      assert.doesNotMatch(html, /Boş bırakırsan|Aynı gruptaki|yerel Code geçmişini paylaşır/, `${mode} ${kind}`);
    }
});

test("the add-account dialog follows the created profile through its sign-ins", () => {
  // Waiting for a new sign-in in the Claude app: Relay saves it itself.
  const pending = wrap(relayFor({ pendingDesktop: b }), createElement(AddAccountSteps, { close() {}, initial: { step: 1, id: "b" } }));
  assert.match(pending, /Claude uygulamasında giriş bekleniyor/);
  assert.match(pending, /Claude’u Code’da aç/);
  assert.match(pending, /İptal et ve önceki hesaba dön/);
  assert.doesNotMatch(pending, /Girişi kaydet<\/button>/);
  // The account open in Claude, waiting for Code: the automatic save's own line and Open Code.
  const auto = wrap(
    relayFor({ desktop: claude({ autoCapture: { accountId: "b", status: "waiting" } }) }),
    createElement(AddAccountSteps, { close() {}, initial: { step: 1, id: "b" } }),
  );
  assert.match(auto, /Code’u bir kez aç; Relay girişi kendisi kaydeder\./);
  assert.match(auto, /<button[^>]*>Code’u aç<\/button>/);
  // Several workspaces: the pick, by name, never a raw id.
  const choose = wrap(
    relayFor({ desktop: claude({ autoCapture: { accountId: "b", status: "choose-org", orgs: [A, B] } }) }),
    createElement(AddAccountSteps, { close() {}, initial: { step: 1, id: "b" } }),
  );
  assert.match(choose, new RegExp(`<option value="${B}"[^>]*>Çalışma alanı 2</option>`));
  // The usage step: started on its own, with a way to do it later.
  const limit = step(2, relayFor());
  assert.match(limit, /“Studio” için limit izni/);
  assert.match(limit, /Relay’in kendi penceresinde açılır/);
  assert.match(limit, /Limit iznini başlat/);
  assert.match(limit, /Sonra yap/);
});
test("the Desktop link dialog lists unlinked profiles", () => {
  const html = wrap(relayFor({ hasUnclaimedDesktop: true }), createElement(LinkDesktopBody, { picked() {} }));
  assert.match(html, /Claude uygulamasında açık olan hesap/);
  assert.match(html, /Studio/);
  assert.match(html, /Şirket/);
  assert.doesNotMatch(html, /<option[^>]*>Kişisel · Max/);
});

test("the accounts header offers Desktop linking only while an unclaimed Desktop account is open", () => {
  assert.match(wrap(relayFor({ hasUnclaimedDesktop: true }), createElement(Accounts)), /Claude uygulaması hesabını eşleştir/);
  assert.doesNotMatch(wrap(relayFor(), createElement(Accounts)), /Claude uygulaması hesabını eşleştir/);
});

test("connection panels keep their ids, live regions and copy", () => {
  const flow = { id: "f", accountId: "b", status: "waiting", browserReady: true } as unknown as AuthFlow;
  const html = wrap(relayFor({ pendingDesktop: b, flow, flowAccount: b }), createElement(ConnectionPanels));
  assert.match(html, /id="desktop-pending-panel"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="desktop-pending-panel"/);
  assert.match(html, /id="cli-connection-panel"/);
  assert.match(html, /Studio · Claude uygulaması girişi/);
  assert.match(html, /Claude’u Code’da aç/);
  assert.match(html, /Tarayıcı onayı bekleniyor/);
  assert.match(html, /Tarayıcıyı yeniden aç/);
  assert.match(html, /2 \/ 3/);
});

test("hash intents open a dialog only when its header button would be enabled", () => {
  const base = { busy: false, pending: false, recovery: false, count: 3, unclaimed: true, unlinked: true };
  assert.equal(intentAllowed("ekle", base), true);
  assert.equal(intentAllowed("eslestir", base), true);
  assert.equal(intentAllowed("ekle", { ...base, count: 50 }), false);
  assert.equal(intentAllowed("ekle", { ...base, busy: true }), false);
  assert.equal(intentAllowed("ekle", { ...base, pending: true }), false);
  assert.equal(intentAllowed("eslestir", { ...base, recovery: true }), false);
  assert.equal(intentAllowed("eslestir", { ...base, unclaimed: false }), false);
  assert.equal(intentAllowed("eslestir", { ...base, unlinked: false }), false);
  assert.equal(intentAllowed("other", base), false);
});

const A = "6f1c2d3e-4b5a-4c6d-8e7f-001122334455";
const B = "a1b2c3d4-0000-4000-8000-000000000002";
const claude = (extra: Partial<DesktopState> = {}): DesktopState => ({
  available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, ...extra,
});
const withCli = (diagnostics: Partial<Diagnostics>) =>
  ({ settings: DEFAULT_SETTINGS, usage: {}, accounts, authFlows: [], diagnostics: { platform: "darwin", dataDir: "/tmp", desktopSupported: false, ...diagnostics } }) as unknown as Snapshot;
const step = (n: 2 | 3, relay: Relay) => wrap(relay, createElement(AddAccountSteps, { close() {}, initial: { step: n, id: "b" } }));

test("saving a Claude app sign-in warns that macOS may ask for the Mac password once", () => {
  const hint = /macOS bir kez Mac parolanı isteyebilir \(Relay Safe Storage\); “Her Zaman İzin Ver”i seç\./;
  // The add-account dialog's sign-in step, before the sign-in is saved.
  assert.match(wrap(relayFor(), createElement(AddAccountSteps, { close() {} })), hint);
  // The confirmations that save a sign-in say it, and so does a switch, which unseals one.
  const review = (kind: DesktopActionKind, language: "tr" | "en" = "tr") =>
    renderToStaticMarkup(
      createElement(DesktopActionReview, {
        kind,
        busy: false,
        t: (tr: string, en: string) => (language === "tr" ? tr : en),
        confirm() {},
        cancel() {},
      }),
    );
  for (const kind of ["capture", "login", "reconnect", "switch"] as const) assert.match(review(kind), hint, kind);
  for (const kind of ["history", "cancel", "recover"] as const) assert.doesNotMatch(review(kind), hint, kind);
  assert.match(
    review("capture", "en"),
    /macOS may ask for your Mac password once \(Relay Safe Storage\); choose “Always Allow”\./,
  );
});

test("without a usable CLI, the usage step is not started: the reason, the guide and Choose file instead", () => {
  for (const diagnostics of [
    { executable: undefined, error: "Claude Code bulunamadı." },
    { executable: "/usr/local/bin/claude", version: "2.1.200 (Claude Code)" },
  ]) {
    const html = step(2, relayFor({ data: withCli(diagnostics) }));
    assert.doesNotMatch(html, /Limit iznini başlat/, JSON.stringify(diagnostics));
    assert.match(html, /Limitleri okumak için Claude Code gerekir\./);
    assert.match(html, /<a[^>]*href="https:\/\/docs\.anthropic\.com\/en\/docs\/claude-code\/setup"[^>]*target="_blank"/);
    assert.match(html, /<button[^>]*>Dosyayı seç<\/button>/);
    assert.match(html, /Sonra yap/);
  }
  const ready = step(2, relayFor({ data: withCli({ executable: "/usr/local/bin/claude", version: "2.1.300 (Claude Code)" }) }));
  assert.match(ready, /Limit iznini başlat/);
  assert.doesNotMatch(ready, /Dosyayı seç/);
});

test("the first step says why its button is disabled, next to it", () => {
  const reasonAfter = (html: string, label: string) => {
    const button = new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? "";
    assert.match(button, /disabled=""/, label);
    return html.slice(html.indexOf(button) + button.length);
  };
  const first = (relay: Relay) => wrap(relay, createElement(AddAccountSteps, { close() {} }));
  assert.match(
    reasonAfter(first(relayFor({ desktop: claude({ available: false }) })), "Claude’u giriş ekranıyla aç…"),
    /^<small[^>]*>Claude uygulaması bulunamadı; önce onu kur\.<\/small>/,
  );
  // Another profile's sign-in in progress.
  assert.match(
    reasonAfter(first(relayFor({ pendingDesktop: w })), "Claude’u giriş ekranıyla aç…"),
    /^<small[^>]*>Önce devam eden Claude uygulaması girişini tamamla veya iptal et\.<\/small>/,
  );
});

test("the last step suggests the name, type and group from the sign-in", () => {
  const named: Account = {
    ...b, name: "Hesap 2", desktop: a.desktop,
    auth: { loggedIn: true, email: "ahmet@vertex.com", orgName: "Vertex", subscription: "team", checkedAt: iso(NOW) },
  };
  const html = wrap(relayFor({ accounts: [a, named, w] }), createElement(AddAccountSteps, { close() {}, initial: { step: 3, id: "b" } }));
  assert.match(html, /Hesap hazır/);
  assert.match(html, /Claude uygulaması girişi kaydedildi/);
  assert.match(html, /Limit izni verildi · ahmet@vertex\.com/);
  assert.match(html, /Kaydet ve bitir/);
  assert.match(html, /Başka hesap ekle/);
});

test("the workspace pickers name each workspace and never show a raw id", () => {
  const named: Account = { ...w, auth: { loggedIn: true, orgId: B, orgName: "Vertex", checkedAt: iso(NOW) } };
  const relay = relayFor({
    accounts: [a, b, named], hasUnclaimedDesktop: true, pendingDesktop: b, targetOrg: A,
    desktop: claude({ currentAccountUuid: "u", organizations: [A, B] }),
  } as Partial<Relay>);
  const pending = wrap(relay, createElement(ConnectionPanels));
  const setup = wrap(
    relayFor({
      accounts: [a, b, named],
      desktop: claude({ currentAccountUuid: "u", organizations: [A, B], autoCapture: { accountId: "b", status: "choose-org", orgs: [A, B] } }),
    } as Partial<Relay>),
    createElement(AddAccountSteps, { close() {}, initial: { step: 1, id: "b" } }),
  );
  for (const html of [pending, setup]) {
    assert.match(html, new RegExp(`<option value="${A}"[^>]*>Çalışma alanı 1</option>`));
    assert.match(html, new RegExp(`<option value="${B}"[^>]*>Vertex</option>`));
    // An id appears only as a value, never as text.
    assert.doesNotMatch(html, new RegExp(`>[^<]*${A}`));
    assert.doesNotMatch(html, new RegExp(`>[^<]*${B}`));
  }
  // The chosen workspace's short id, muted, at most.
  assert.match(pending, /<span class="[^"]*text-muted-foreground[^"]*">6f1c2d3e<\/span>/);
});

test("the pending sign-in names the Code step while no workspace folder exists", () => {
  const html = wrap(
    relayFor({ pendingDesktop: b, hasUnclaimedDesktop: true, desktop: claude({ currentAccountUuid: "u" }) } as Partial<Relay>),
    createElement(ConnectionPanels),
  );
  assert.match(html, /Claude uygulamasında sol menüden Code’u bir kez aç; liste kendiliğinden dolar\./);
  assert.doesNotMatch(html, /Girişi kaydet<\/button>/);
});

test("with no account, the accounts header hides Desktop linking", () => {
  const html = wrap(relayFor({ accounts: [], active: undefined, hasUnclaimedDesktop: true }), createElement(Accounts));
  assert.doesNotMatch(html, /Claude uygulaması hesabını eşleştir/);
  assert.match(html, /Hesap ekle/);
});

test("disabled accounts header buttons say why, next to them", () => {
  const pending = wrap(relayFor({ pendingDesktop: b }), createElement(Accounts));
  assert.match(pending, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?Hesap ekle<\/button><span[^>]*>Önce devam eden Claude uygulaması girişini tamamla veya iptal et\.<\/span>/);
  const linkedAll = [a, { ...b, desktop: a.desktop }, { ...w, desktop: a.desktop }];
  const allLinked = wrap(relayFor({ accounts: linkedAll, hasUnclaimedDesktop: true }), createElement(Accounts));
  assert.match(allLinked, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?Claude uygulaması hesabını eşleştir<\/button><span[^>]*>Her profilin Claude uygulaması girişi kayıtlı\.<\/span>/);
  const full = Array.from({ length: 50 }, (_, i) => ({ ...b, id: `p${i}` }));
  assert.match(wrap(relayFor({ accounts: full }), createElement(Accounts)), /Hesap ekle<\/button><span[^>]*>En fazla 50 hesap eklenebilir\.<\/span>/);
  // A lock both buttons share is said once, after the second.
  const busy = wrap(relayFor({ desktopBusy: true, hasUnclaimedDesktop: true }), createElement(Accounts));
  assert.equal(busy.match(/Claude uygulamasında bir işlem sürüyor\./g)?.length, 1);
  assert.match(busy, /Hesap ekle<\/button><span[^>]*>Claude uygulamasında bir işlem sürüyor\.<\/span>/);
  // Enabled buttons explain nothing.
  assert.doesNotMatch(wrap(relayFor(), createElement(Accounts)), /Hesap ekle<\/button><span/);
});
