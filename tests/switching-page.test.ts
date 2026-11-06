import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationTab, CarryTab } from "../src/pages/settings/SwitchingTabs";

/** Settings' Automation tab, then its What comes along tab: what used to be the Switching page. */
const Switching = () => createElement(Fragment, null, createElement(AutomationTab), createElement(CarryTab));
import { RelayContext, type Relay } from "../src/data/relay-context";
import { historyScopeNote } from "../src/features/SwitchPreferences";
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

test("Automation is the status, when to switch and the suggestion; What comes along is one card per part", () => {
  const html = render(relayFor());
  assert.doesNotMatch(html, /kapanınca hazırlama/);
  assert.match(html, /data-slot="switch-status"/);
  assert.match(html, /Ne zaman geçilsin\?/);
  assert.match(html, /role="radiogroup"/);
  // Each part once: no summary cards repeating the settings below them.
  assert.doesNotMatch(html, /Geçişte neler gelir\?|>Ayrıntılar</);
  for (const id of ["gecis-gecmis", "gecis-eklenti", "gecis-terminal", "gecis-taslak", "gecis-oneri", "gecis-kenar"])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.ok(html.indexOf("Ne zaman geçilsin?") < html.indexOf("Ortak Code geçmişi"));
  assert.match(html, /Ortak Code geçmişi/);
  assert.match(html, /Tüm hesaplar arasında/);
  assert.match(html, /Açık hesapla birleştir/);
  assert.match(html, /Limit yaklaşınca hesap öner/);
  assert.doesNotMatch(html, /Menü çubuğundan bir hesap seçip/);
  assert.doesNotMatch(html, /Pencere kapanınca Relay/);
  assert.doesNotMatch(html, /Bu konuşmayı izle/);
});

test("the history scope and its local-only limit are one note, under Gelişmiş", () => {
  const tr = (text: string) => text;
  const local =
    "Yalnızca yerel Code geçmişi paylaşılır; Chat ve bulut oturumları eşitlenmez.";
  assert.equal(
    historyScopeNote("all", tr),
    `Claude uygulaması girişi kayıtlı tüm hesaplar, kişisel ya da şirket, Code geçmişini paylaşır. ${local}`,
  );
  assert.equal(
    historyScopeNote("selected", tr),
    `Seçili hesaplar, farklı şirketlerden olsalar da Code geçmişini paylaşır. ${local}`,
  );
  assert.equal(historyScopeNote("same-group", tr), local);
  assert.equal(historyScopeNote("off", tr), "");
  // Closed by default: the card shows the select and the merge, the note waits under Gelişmiş.
  const html = render(relayFor());
  assert.match(html.slice(html.indexOf('id="gecis-gecmis"')), /Açık hesapla birleştir[\s\S]*>Gelişmiş</);
  assert.doesNotMatch(html, /Yalnızca yerel Code geçmişi/);
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
  assert.deepEqual(notes, []);
  assert.equal(shareDescription(off), undefined);
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
  assert.doesNotMatch(en, /Not merged between accounts|Merged on every account switch/);
  assert.doesNotMatch(en, /Relay shares only local Code history/);
  // The sharing modes keep their wording, and the header says where the conversations appear.
  const where: Record<string, RegExp> = {
    all: /Geçişten sonra Code konuşmaların bağlı her hesapta görünür\./,
    "same-group": /Geçişten sonra Code konuşmaların aynı gruptaki hesaplarda görünür\./,
    selected: /Geçişten sonra Code konuşmaların seçtiğin hesaplarda görünür\./,
  };
  for (const mode of ["all", "same-group", "selected"]) {
    const html = render(relayFor({}, { desktopHistoryTransfer: mode }));
    assert.equal(shareDescription(html), undefined, mode);
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
  assert.match(english("selected"), /appear in the accounts you selected\./);
  assert.match(english("off"), /Your Code conversations stay separate in each account\./);
});

test("Switching offers draft re-typing, off unless turned on, marked experimental", () => {
  const control = (html: string) =>
    /<button[^>]*id="draft-retype"[^>]*>/.exec(html)?.[0] ?? "";
  const off = render(relayFor());
  assert.match(off, /for="draft-retype"[^>]*>[\s\S]*Taslakları Claude uygulamasına yeniden yaz/);
  assert.match(off, />Deneysel</);
  assert.match(off, /Geçişten sonra taslağı mesaj kutusuna yazar, göndermez\. Erişilebilirlik izni ister\./);
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
  assert.match(en, /After a switch, types the draft into the message box but does not send it\. Needs Accessibility permission\./);
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

/** The sidebar sections card. */
const carry = (html: string) => html.slice(html.indexOf('id="gecis-kenar"'));

test("each setting appears once: the history scope, draft re-typing and the suggestion have one control each", () => {
  const html = render(relayFor());
  assert.equal(html.match(/id="history-transfer"/g)?.length, 1);
  assert.equal(html.match(/id="draft-retype"/g)?.length, 1);
  assert.equal(html.match(/id="usage-suggestions"/g)?.length, 1);
  assert.doesNotMatch(html, /carry-history|carry-retype|carry-suggest/);
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

test("the main window and the menu bar panel sit inside an error boundary", () => {
  for (const entry of ["../src/main.tsx", "../src/panel/main.tsx"])
    assert.match(readFileSync(new URL(entry, import.meta.url), "utf8"), /<ErrorBoundary>/, entry);
});
