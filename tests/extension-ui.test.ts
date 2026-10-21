import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSheetBody, ExtensionRow } from "../src/pages/accounts/AccountSheet";
import { ExtensionPreference } from "../src/features/ExtensionPreference";
import {
  instanceLine,
  modeOptions,
  modeSentence,
  rowStatus,
  startupLine,
} from "../src/lib/extension-ui";
import { extensionLine } from "../shared/extension-text";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import type { ExtensionOutcome, ExtensionStatus } from "../shared/browser-extension";
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
const brave = { app: "brave", profile: "Default", name: "Kişisel" } as const;
const status = (over: Partial<ExtensionStatus> = {}): ExtensionStatus => ({
  setting: { mode: "restart" },
  instances: [brave],
  target: brave,
  restoresTabs: false,
  saved: [{ accountUuid: ID, savedAt: "2026-10-20T08:00:00.000Z" }],
  ...over,
});

test("the row says whether the account's sign-in is saved, matching the uuid in any case", () => {
  assert.deepEqual(rowStatus(vertex, status(), tr, "tr"), { tone: "ok", label: "Giriş kayıtlı · 20 Eki" });
  assert.equal(rowStatus(vertex, status(), en, "en").label, "Sign-in saved · 20 Oct");
  assert.equal(rowStatus(alto, status(), tr, "tr").tone, "warn");
  assert.match(rowStatus(alto, status(), tr, "tr").label, /bir kez giriş yap; Relay bir sonraki geçişte kaydeder/);
  assert.match(rowStatus(alto, status(), en, "en").label, /Sign in to the extension once with this account/);
  assert.equal(rowStatus(alto, undefined, tr, "tr").label, "…");
});

test("the row says when the feature is off or there is no extension", () => {
  assert.match(rowStatus(vertex, status({ setting: { mode: "off" } }), tr, "tr").label, /Kapalı · Relay eklentiye dokunmaz/);
  assert.match(rowStatus(vertex, status({ instances: [], target: undefined }), en, "en").label, /No Claude extension found/);
});

test("each mode has a label and a sentence in both languages", () => {
  assert.deepEqual(modeOptions(en).map((o) => o.value), ["restart", "closed", "off"]);
  for (const mode of ["restart", "closed", "off"] as const) {
    assert.ok(modeSentence(mode, tr).length > 10);
    assert.notEqual(modeSentence(mode, tr), modeSentence(mode, en));
  }
  assert.match(modeSentence("restart", en), /closed for a moment and opened again with its tabs/);
  assert.match(modeSentence("closed", en), /only when the browser is closed/);
});

test("the card names the instance, asks to choose among several, and explains the startup setting", () => {
  assert.equal(instanceLine(status(), en), "Brave · Kişisel · extension installed");
  assert.match(
    instanceLine(status({ instances: [brave, { app: "chrome", profile: "Default", name: "Your Chrome" }], target: undefined }), en),
    /several browser profiles/,
  );
  assert.match(instanceLine(status({ instances: [], target: undefined }), tr), /bulunamadı/);
  assert.match(startupLine(status(), en)!, /new tab page by its own setting, so Relay restores the session itself/);
  assert.match(startupLine(status({ restoresTabs: true }), en)!, /opens the last session by its own setting/);
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
  assert.equal(extensionLine(outcome({}), en), "The extension's sign-in was switched.");
  assert.match(extensionLine(outcome({ result: "saved", reason: "no-saved-login" }), tr)!, /Eklenti girişi kaydedildi/);
  assert.match(extensionLine(outcome({ result: "unchanged", reason: "no-saved-login" }), en)!, /no saved extension sign-in/);
  assert.equal(extensionLine(outcome({ result: "unchanged", reason: "already-there" }), en), undefined);
  assert.equal(extensionLine(outcome({ result: "skipped", reason: "off" }), en), undefined);
  assert.equal(extensionLine(outcome({ result: "skipped", reason: "not-installed" }), en), undefined);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "browser-running" }), tr)!, /Tarayıcı açık olduğu için/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "browser-did-not-quit" }), en)!, /did not quit/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "unknown-account" }), en)!, /does not have/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "choose-instance" }), en)!, /several browser profiles/);
  assert.match(extensionLine(outcome({ result: "skipped", reason: "unavailable" }), en)!, /use Relay\.app: Switching → Claude browser extension → Sync now/);
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

function relayFor(platform: string, list: Account[]): Relay {
  return {
    api: {
      extensionStatus: () => new Promise(() => {}),
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

test("the account row shows the sign-in state, and no browser profile picker is left", () => {
  const html = render(
    relayFor("darwin", [vertex, alto]),
    createElement(ExtensionRow, { account: vertex, initialStatus: status() }),
  );
  assert.match(html, /Tarayıcı eklentisi/);
  assert.match(html, /Giriş kayıtlı · 20 Eki/);
  assert.doesNotMatch(html, /Tarayıcı profili|Şimdi aç|Open now/);
  const none = render(
    relayFor("darwin", [vertex, alto]),
    createElement(ExtensionRow, { account: alto, initialStatus: status() }),
    "en",
  );
  assert.match(none, /Not saved yet\. Sign in to the extension once with this account/);
});

test("the sheet shows the row on macOS only", () => {
  const setup: Account = { ...alto, id: "s", name: "Setup" };
  const list = [vertex, alto, setup];
  assert.match(
    render(relayFor("darwin", list), createElement(AccountSheetBody, { account: setup })),
    /Tarayıcı eklentisi/,
  );
  assert.doesNotMatch(
    render(relayFor("win32", list), createElement(AccountSheetBody, { account: setup })),
    /Tarayıcı eklentisi/,
  );
});

test("the settings card shows the mode with its sentence, the instance, the startup note and Sync now", () => {
  const html = render(
    relayFor("darwin", [vertex]),
    createElement(ExtensionPreference, { initialStatus: status() }),
  );
  assert.match(html, /Claude tarayıcı eklentisi/);
  assert.match(html, /Tarayıcıyı kapatıp yeniden aç/);
  assert.match(html, /Açık bir tarayıcıyı kısa süreliğine kapatıp sekmeleriyle yeniden açar/);
  assert.match(html, /Brave · Kişisel · eklenti yüklü/);
  assert.match(html, /Relay oturumu kendisi geri yükler/);
  assert.match(html, /Şimdi eşitle/);
  // One instance: no picker for the profile.
  assert.doesNotMatch(html, /Eklentinin tarayıcı profili/);
  const several = render(
    relayFor("darwin", [vertex]),
    createElement(ExtensionPreference, {
      initialStatus: status({
        instances: [brave, { app: "chrome", profile: "Default", name: "Your Chrome" }],
        target: undefined,
      }),
    }),
    "en",
  );
  assert.match(several, /The extension&#x27;s browser profile/);
  assert.match(several, /Choose a profile/);
  // Not on this Mac: the card is not drawn at all.
  assert.equal(render(relayFor("darwin", [vertex]), createElement(ExtensionPreference, {})), "");
});
