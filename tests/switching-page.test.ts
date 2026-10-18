import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Switching } from "../src/pages/Switching";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type Snapshot } from "../shared/types";

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

test("Switching shows automatic switching, shared history and suggestions in separate cards", () => {
  const html = render(relayFor());
  assert.match(html, /Otomatik geçiş, ortak geçmiş ve hesap önerileri/);
  assert.doesNotMatch(html, /kapanınca hazırlama/);
  assert.match(html, /Otomatik geçiş/);
  assert.match(html, /role="radiogroup"/);
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
    /Kapalıyken taslaklar kurtarılır ve panelde Kopyala ile sunulur\. Açıkken Relay geçişten sonra konuşmayı açar ve taslağı mesaj kutusuna yazar, göndermez\. Erişilebilirlik izni ister\./,
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
    /While off, drafts are rescued and offered in the panel with Copy\. While on, Relay opens the conversation after a switch and types the draft into its message box without sending it\. It needs Accessibility permission\./,
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

test("with Continue at quota and prepare-on-quit both on, the choice reads Kota dolunca", () => {
  const html = render(relayFor({}, { autoSwitchMode: "after-exit" }));
  const checked = [
    ...html.matchAll(/<button[^>]*role="radio"[^>]*>(.*?)<\/button>/g),
  ]
    .filter(([tag]) => tag.includes('aria-checked="true"'))
    .map(([, label]) => label);
  assert.deepEqual(checked, ["Kota dolunca"]);
  assert.doesNotMatch(html, /Otomatik geçişe dahil hesaplar/);
});
