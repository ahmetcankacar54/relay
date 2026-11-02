import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Switching, extensionCarry } from "../src/pages/Switching";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type ExtensionStatus, type Snapshot } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const desktop = {
  accountUuid: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  savedAt: iso(NOW),
  email: "a@example.com",
};
const a: Account = {
  id: "a",
  name: "Kişisel · Max",
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: iso(NOW),
  desktop,
  auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const accounts = [a];
const baseSettings = {
  ...DEFAULT_SETTINGS,
  autoSwitchMode: "off" as const,
  desktopHistoryTransfer: "all" as const,
};

function relayFor(
  data: Record<string, unknown> = {},
  settingsOverride: Record<string, unknown> = {},
): Relay {
  const settings = { ...baseSettings, ...settingsOverride };
  return {
    api: {},
    preview: false,
    error: "",
    notice: "",
    accounts,
    active: a,
    settings,
    busy: "",
    usageBusy: new Set<string>(),
    desktopBusy: false,
    hasUnclaimedDesktop: false,
    targetOrg: "",
    historyRevision: 0,
    desktop: {
      available: true,
      running: true,
      organizations: [],
      busy: false,
      recoveryRequired: false,
      errorRevision: 0,
      activeProfileId: "a",
    },
    data: {
      settings,
      usage: {},
      accounts,
      authFlows: [],
      diagnostics: { platform: "darwin" },
      fleet: { enabled: true, status: "watching", stopped: 3 },
      ...data,
    } as unknown as Snapshot,
    requestDesktop() {},
    setSetupId() {},
    cancelDesktopRequest() {},
    setOrg() {},
    setNotice() {},
    startCli: async () => {},
    refreshUsage: async () => {},
    action: async () => {},
    setData() {},
  } as unknown as Relay;
}
const render = (relay: Relay) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(
        RelayContext.Provider,
        { value: relay },
        createElement(Switching),
      ),
    ),
  );

test("Switching is a flow: the status, when to switch, what comes along, then the settings", () => {
  const html = render(relayFor());
  assert.match(html, /Ne zaman geçilir, yanında neler gelir/);
  assert.doesNotMatch(html, /kapanınca hazırlama/);
  assert.match(html, /data-slot="switch-status"/);
  assert.match(html, /Ne zaman geçilsin\?/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /Geçişte neler gelir\?/);
  for (const id of ["gecis-gecmis", "gecis-eklenti", "gecis-taslak", "gecis-oneri"])
    assert.match(html, new RegExp(`href="#${id}"`), id);
  assert.ok(html.indexOf("Ne zaman geçilsin?") < html.indexOf("Geçişte neler gelir?"));
  assert.match(html, /Ortak Code geçmişi/);
  assert.match(html, /Tüm hesaplar arasında/);
  assert.match(html, /Açık hesapla birleştir/);
  assert.match(html, /Limit yaklaşınca hesap öner/);
  assert.doesNotMatch(html, /Menü çubuğundan bir hesap seçip/);
  assert.doesNotMatch(html, /Pencere kapanınca Relay/);
  assert.doesNotMatch(html, /Bu konuşmayı izle/);
});

test("the history scope and its local-only limit are one note", () => {
  const historyNotes = (html: string) =>
    [...html.matchAll(/<p class="text-\[13px\] text-muted-foreground">([^<]*)<\/p>/g)]
      .map(([, text]) => text)
      .filter((text) => /Code geçmişi/.test(text));
  const local =
    "Yalnızca yerel Code geçmişi paylaşılır; Chat ve bulut oturumları eşitlenmez.";
  assert.deepEqual(historyNotes(render(relayFor())), [
    `Claude uygulaması girişi kayıtlı tüm hesaplar, kişisel ya da şirket, Code geçmişini paylaşır. ${local}`,
  ]);
  const selected = historyNotes(
    render(relayFor({}, { desktopHistoryTransfer: "selected" })),
  );
  assert.deepEqual(selected, [
    `Seçili hesaplar, farklı şirketlerden olsalar da Code geçmişini paylaşır. ${local}`,
  ]);
  assert.deepEqual(
    historyNotes(render(relayFor({}, { desktopHistoryTransfer: "same-group" }))),
    [local],
  );
  assert.doesNotMatch(
    render(relayFor()),
    /Yalnızca yerel Code geçmişi; Chat/,
  );
});

/** The description under "Geçmişi paylaş". */
const shareDescription = (html: string) =>
  /for="history-transfer"[^>]*>Geçmişi paylaş<\/label><p[^>]*>([^<]*)<\/p>/.exec(html)?.[1];

test("Paylaşma says history is not shared, and never that it is", () => {
  const off = render(relayFor({}, { desktopHistoryTransfer: "off" }));
  const notes = [
    ...off.matchAll(/<p class="text-\[13px\] text-muted-foreground">([^<]*)<\/p>/g),
  ]
    .map(([, text]) => text)
    .filter((text) => /Code geçmişi/.test(text));
  assert.deepEqual(notes, ["Code geçmişi hesaplar arasında paylaşılmaz."]);
  assert.equal(shareDescription(off), "Hesaplar arasında birleştirilmez.");
  assert.doesNotMatch(off, /paylaşılır/);
  assert.doesNotMatch(off, /Her hesap geçişinde birleştirilir/);
  assert.match(off, /Code konuşmaların her hesapta ayrı kalır\./);
  assert.doesNotMatch(off, /diğer hesapta da görünür/);
  // In English too.
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      {
        value: {
          language: "en",
          setLanguage() {},
          t: (_: string, en: string) => en,
        },
      },
      createElement(
        RelayContext.Provider,
        { value: relayFor({}, { desktopHistoryTransfer: "off" }) },
        createElement(Switching),
      ),
    ),
  );
  assert.match(en, /Code history is not shared between accounts\./);
  assert.match(en, /Not merged between accounts\./);
  assert.doesNotMatch(en, /Only local Code history is shared|Merged on every account switch/);
  // The sharing modes keep their wording, and the header says where the conversations appear.
  const where: Record<string, RegExp> = {
    all: /Geçişten sonra Code konuşmaların bağlı her hesapta görünür\./,
    "same-group": /Geçişten sonra Code konuşmaların aynı gruptaki hesaplarda görünür\./,
    selected: /Geçişten sonra Code konuşmaların seçtiğin hesaplarda görünür\./,
  };
  for (const mode of ["all", "same-group", "selected"]) {
    const html = render(relayFor({}, { desktopHistoryTransfer: mode }));
    assert.equal(shareDescription(html), "Her hesap geçişinde birleştirilir.", mode);
    assert.match(html, /Yalnızca yerel Code geçmişi paylaşılır; Chat ve bulut oturumları eşitlenmez\./, mode);
    assert.doesNotMatch(html, /hesaplar arasında paylaşılmaz|Hesaplar arasında birleştirilmez/, mode);
    assert.match(html, where[mode], mode);
    assert.doesNotMatch(html, /diğer hesapta da görünür/, mode);
  }
  const english = (mode: string) =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "en", setLanguage() {}, t: (_tr: string, en: string) => en } },
        createElement(
          RelayContext.Provider,
          { value: relayFor({}, { desktopHistoryTransfer: mode }) },
          createElement(Switching),
        ),
      ),
    );
  assert.match(english("all"), /appear in every connected account\./);
  assert.match(english("same-group"), /appear in the accounts of the same group\./);
  assert.match(english("selected"), /appear in the accounts you picked\./);
  assert.match(english("off"), /Your Code conversations stay separate in each account\./);
});

test("Switching offers draft re-typing, off unless turned on, marked experimental", () => {
  const control = (html: string) =>
    /<button[^>]*id="draft-retype"[^>]*>/.exec(html)?.[0] ?? "";
  const off = render(relayFor());
  assert.match(off, /for="draft-retype"[^>]*>[\s\S]*Taslakları Claude uygulamasına yeniden yaz/);
  assert.match(off, />Deneysel</);
  assert.match(
    off,
    /Kapalıyken taslaklar kurtarılır ve panelde “Kopyala” düğmesiyle sunulur\. Açıkken Relay geçişten sonra konuşmayı açar ve taslağı mesaj kutusuna yazar, göndermez\. Erişilebilirlik izni ister\./,
  );
  assert.match(control(off), /role="switch"/);
  assert.match(control(off), /aria-checked="false"/);
  assert.match(control(render(relayFor({}, { draftRetype: false }))), /aria-checked="false"/);
  assert.match(control(render(relayFor({}, { draftRetype: true }))), /aria-checked="true"/);
  const en = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      {
        value: {
          language: "en",
          setLanguage() {},
          t: (_: string, en: string) => en,
        },
      },
      createElement(
        RelayContext.Provider,
        { value: relayFor() },
        createElement(Switching),
      ),
    ),
  );
  assert.match(en, /Re-type drafts into the Claude app/);
  assert.match(en, />Experimental</);
  assert.match(
    en,
    /While off, drafts are rescued and offered in the panel with “Copy”\. While on, Relay opens the conversation after a switch and types the draft into its message box without sending it\. It needs Accessibility permission\./,
  );
});

test("the single-conversation watch card appears only while a legacy watch needs attention", () => {
  const html = render(
    relayFor({
      continuation: {
        status: "armed",
        reason: "awaiting-quota-stop",
        enabled: true,
        executable: true,
      },
    }),
  );
  assert.match(html, /Bu konuşmayı izle|İzlemeyi kapat/);
});

test("with Continue at quota and prepare-on-quit both on, the choice reads Limit dolunca", () => {
  const html = render(relayFor({}, { autoSwitchMode: "after-exit" }));
  const checked = [
    ...html.matchAll(/<button[^>]*role="radio"[^>]*>(.*?)<\/button>/g),
  ]
    .filter(([tag]) => tag.includes('aria-checked="true"'))
    .map(([, inner]) => /<span class="text-sm font-semibold">(.*?)<\/span>/.exec(inner)?.[1]);
  assert.deepEqual(checked, ["Limit dolunca"]);
  assert.doesNotMatch(html, /Otomatik geçişe dahil hesaplar/);
});

/** The "Geçişte neler gelir?" section, up to the details. */
const carry = (html: string) =>
  html.slice(html.indexOf("Geçişte neler gelir?"), html.indexOf(">Ayrıntılar</h2>"));

test("each carry card holds its main control, bound to the same setting as the details", () => {
  const html = carry(render(relayFor()));
  // Code history: the sharing select, with the details' options and the current choice.
  assert.match(html, /<label for="carry-history" class="sr-only">Geçmişi paylaş<\/label>/);
  assert.match(html, /<button[^>]*id="carry-history"[^>]*>[\s\S]*?Tüm hesaplar arasında/);
  assert.match(html, />Tüm hesaplarda görünür</);
  // Drafts: "Konuşmaya yeniden yaz · Deneysel", off unless turned on.
  const retype = (h: string) => /<input[^>]*id="carry-retype"[^>]*>/.exec(h)?.[0] ?? "";
  assert.match(html, /Konuşmaya yeniden yaz<span[^>]*>Deneysel<\/span>/);
  assert.match(retype(html), /type="checkbox"/);
  assert.doesNotMatch(retype(html), /checked/);
  assert.match(retype(carry(render(relayFor({}, { draftRetype: true })))), /checked=""/);
  // Suggestions: the toggle, disabled while usage warnings are off.
  const suggest = (h: string) => /<button[^>]*id="carry-suggest"[^>]*>/.exec(h)?.[0] ?? "";
  assert.match(suggest(html), /role="switch"/);
  assert.match(suggest(html), /aria-checked="true"/);
  const quiet = carry(render(relayFor({}, { usageWarnings: false })));
  assert.match(suggest(quiet), /disabled=""/);
  assert.match(quiet, />Limit uyarıları kapalı</);
  // Each card still jumps to its full settings.
  for (const id of ["gecis-gecmis", "gecis-eklenti", "gecis-taslak", "gecis-oneri"])
    assert.match(html, new RegExp(`<a href="#${id}" aria-label="[^"]+ · ayrıntılar"[^>]*>Ayrıntılar</a>`), id);
});

test("the sidebar card offers Copy recipe for the open account's missing sections", () => {
  const gap = { id: "g1", to: "Kişisel · Max", from: ["Vertex"], missingSections: 9, sessions: 157 };
  const html = carry(render(relayFor({ sidebar: gap })));
  assert.match(html, />Kenar çubuğu bölümleri</);
  assert.match(html, /Kişisel · Max hesabında 9 bölüm eksik, 157 oturum bir bölümde değil\. Kaynak: Vertex\./);
  assert.match(html, /<button[^>]*>Talimatı kopyala<\/button>/);
  assert.match(
    carry(render({ ...relayFor({ sidebar: gap }), busy: "sidebar-copy:g1" } as Relay)),
    /<button[^>]*disabled=""[^>]*>Talimatı kopyala<\/button>/,
  );
  const none = carry(render(relayFor()));
  assert.match(none, />Açık hesapta eksik bölüm yok\.</);
  assert.doesNotMatch(none, /Talimatı kopyala/);
});

test("the extension card says where the extension stands for the open account, with Check when it helps", () => {
  const t = (tr: string) => tr;
  const status = (over: Partial<ExtensionStatus> = {}): ExtensionStatus =>
    ({
      setting: { mode: "restart" },
      instances: [{ app: "chrome", profile: "Default", name: "Kişi 1", opened: true }],
      target: { app: "chrome", profile: "Default", name: "Kişi 1", opened: true },
      picked: "only",
      saved: [],
      ...over,
    }) as ExtensionStatus;
  assert.deepEqual(extensionCarry(undefined, a, accounts, t, "tr"), { value: "Kontrol ediliyor…", check: false });
  assert.deepEqual(extensionCarry(null, a, accounts, t, "tr"), { value: "Bu Mac’te yok", check: false });
  assert.deepEqual(extensionCarry(status({ setting: { mode: "off" } }), a, accounts, t, "tr"), {
    value: "Kapalı",
    tone: "off",
    check: false,
  });
  // Before a check: the linked count, and Check.
  assert.deepEqual(extensionCarry(status(), a, accounts, t, "tr"), { value: "0 hesap bağlı", check: true });
  // On this account now: linked, nothing to do.
  const here = status({ current: { state: "signed-in", accountUuid: desktop.accountUuid } } as Partial<ExtensionStatus>);
  assert.deepEqual(extensionCarry(here, a, accounts, t, "tr"), {
    value: "Bağlı · eklenti şu an bu hesapta",
    tone: "ok",
    check: false,
  });
  // Signed out after a check: the guide's line, and Check again.
  const out = status({ current: { state: "signed-out" } } as Partial<ExtensionStatus>);
  assert.deepEqual(extensionCarry(out, a, accounts, t, "tr"), {
    value: "Bağlı değil · eklentide giriş yok",
    tone: "warn",
    check: true,
  });
  // Rendered before the status loads, the card says it is checking.
  assert.match(carry(render(relayFor())), />Tarayıcı eklentisi<[\s\S]*?Kontrol ediliyor…/);
});

test("the Details links scroll to their card instead of letting the hash router read them", () => {
  const source = readFileSync(new URL("../src/pages/Switching.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{\(event\) => jumpTo\(event, href\)\}/);
  assert.match(source, /event\.preventDefault\(\);[\s\S]*getElementById\(href\.slice\(1\)\)/);
});

test("the main window and the menu bar panel sit inside an error boundary", () => {
  for (const entry of ["../src/main.tsx", "../src/panel/main.tsx"])
    assert.match(readFileSync(new URL(entry, import.meta.url), "utf8"), /<ErrorBoundary>/, entry);
});
