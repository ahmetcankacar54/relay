import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Settings } from "../src/pages/Settings";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Snapshot } from "../shared/types";

const settings = { ...DEFAULT_SETTINGS, usageRefreshMinutes: 0 as const };

function relayFor(): Relay {
  return {
    api: {}, preview: false, error: "", notice: "", accounts: [], active: undefined, settings, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    version: "0.4.2",
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 },
    data: { settings, usage: {}, accounts: [], authFlows: [], diagnostics: { platform: "darwin", version: "2.1.0" } } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {}, setData() {},
  } as unknown as Relay;
}

test("Settings shows appearance, language, refresh interval and technical details", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(RelayContext.Provider, { value: relayFor() }, createElement(Settings)),
    ),
  );
  for (const re of [
    /Görünüm/, /Sistem/, /Açık/, /Koyu/, /Dil/, /Türkçe/, /English/,
    /Limitleri yenileme/, /Elle/, /Bulundu/, /2\.1\.0/,
    // The path the missing-CLI error names: Ayarlar → Claude Code CLI → Dosyayı seç.
    /Claude Code CLI<\/[^>]+>(?:(?!<button)[\s\S])*?2\.1\.0(?:(?!<button)[\s\S])*?<button[^>]*>Dosyayı seç<\/button>/,
    /Yerelde saklanır\. Kontrol sende\./, /Bağımsız araç · 0\.\d+\.\d+/,
  ])
    assert.match(html, re);
});

test("Settings offers the menu bar animation switch, on unless turned off", () => {
  const render = (menuBarAnimation?: boolean) => {
    const relay = relayFor();
    const value = { ...settings, ...(menuBarAnimation === undefined ? {} : { menuBarAnimation }) };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, settings: value } as Relay }, createElement(Settings)),
      ),
    );
  };
  const on = render();
  assert.match(on, /Panda animasyonları/);
  assert.match(on, /Kapalıyken panda yalnızca ifade değiştirir/);
  assert.match(on, /role="switch"[^>]*aria-checked="true"/);
  assert.match(render(false), /role="switch"[^>]*aria-checked="false"/);
});

test("the menu bar animation switch is shown on macOS only", () => {
  const render = (platform: string) => {
    const relay = relayFor();
    const data = { ...relay.data!, diagnostics: { ...relay.data!.diagnostics, platform } } as Snapshot;
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, data } as Relay }, createElement(Settings)),
      ),
    );
  };
  assert.match(render("darwin"), /Panda animasyonları/);
  for (const platform of ["win32", "linux"]) {
    const html = render(platform);
    assert.doesNotMatch(html, /Panda animasyonları/, platform);
    assert.doesNotMatch(html, /menu-bar-animation-label/, platform);
    assert.match(html, /Görünüm/, platform);
  }
});

test("Settings offers the switch window, on unless turned off, on macOS only", () => {
  const render = (extra: { switchWindow?: boolean; platform?: string } = {}) => {
    const relay = relayFor();
    const data = { ...relay.data!, diagnostics: { ...relay.data!.diagnostics, platform: extra.platform ?? "darwin" } } as Snapshot;
    const value = { ...settings, ...(extra.switchWindow === undefined ? {} : { switchWindow: extra.switchWindow }) };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, settings: value, data } as Relay }, createElement(Settings)),
      ),
    );
  };
  const control = (html: string) => /<button[^>]*aria-labelledby="switch-window-label"[^>]*>/.exec(html)?.[0] ?? "";
  const on = render();
  assert.match(on, /Geçişte panda penceresini göster/);
  assert.match(on, /Claude yeniden başlarken menü çubuğunun altında kısa bir sahne oynar\./);
  assert.match(control(on), /aria-checked="true"/);
  assert.match(control(render({ switchWindow: false })), /aria-checked="false"/);
  for (const platform of ["win32", "linux"])
    assert.doesNotMatch(render({ platform }), /Geçişte panda penceresini göster|switch-window-label/, platform);
});

test("Settings offers the panda pranks setting on every platform", () => {
  const render = (extra: { pranks?: "sometimes" | "rarely" | "off"; platform?: string } = {}) => {
    const relay = relayFor();
    const data = { ...relay.data!, diagnostics: { ...relay.data!.diagnostics, platform: extra.platform ?? "darwin" } } as Snapshot;
    const value = { ...settings, ...(extra.pranks === undefined ? {} : { pranks: extra.pranks }) };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, settings: value, data } as Relay }, createElement(Settings)),
      ),
    );
  };
  // The group labelled by the row's label id, then the item that is switched on inside it.
  const selected = (html: string) => {
    const group = /<div[^>]*aria-labelledby="panda-pranks-label"[^>]*>.*?<\/div>/s.exec(html)?.[0] ?? "";
    return [...group.matchAll(/<button[^>]*data-state="on"[^>]*>(.*?)<\/button>/gs)].map((m) => m[1]);
  };
  for (const platform of ["darwin", "win32", "linux"]) {
    const html = render({ platform });
    for (const re of [/Panda şakaları/, /Ara sıra/, /Nadiren/, /Kapalı/, /Seyrek şakalar; hiçbir işlemi geciktirmez\./])
      assert.match(html, re, platform);
    assert.match(html, /id="panda-pranks-label"/, platform);
    assert.deepEqual(selected(html), ["Ara sıra"], platform);
    assert.deepEqual(selected(render({ platform, pranks: "off" })), ["Kapalı"], platform);
    assert.deepEqual(selected(render({ platform, pranks: "rarely" })), ["Nadiren"], platform);
  }
});

test("Settings shows the panda pranks setting in English", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "en", setLanguage() {}, t: (_tr: string, en: string) => en } },
      createElement(RelayContext.Provider, { value: relayFor() }, createElement(Settings)),
    ),
  );
  for (const re of [/Panda pranks/, />Sometimes</, />Rarely</, />Off</, /Rare pranks; they never delay anything\./])
    assert.match(html, re);
});

test("Settings explains the Keychain prompt in Turkish and English, under the technical details", () => {
  const render = (language: "tr" | "en") =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(RelayContext.Provider, { value: relayFor() }, createElement(Settings)),
      ),
    );
  const tr = render("tr");
  const en = render("en");
  const note = (html: string) => /<p class="[^"]*text-muted-foreground[^"]*">(Relay [^<]*(?:Anahtarlık|Keychain)[^<]*)<\/p>/.exec(html)?.[1];
  assert.equal(
    note(tr),
    "Relay kayıtlı girişleri macOS Anahtarlık’ta tuttuğu bir anahtarla şifreler. Yeni bir Relay sürümünden sonra macOS parolanı bir kez sorabilir; “Her Zaman İzin Ver”i seç.",
  );
  assert.equal(
    note(en),
    "Relay encrypts saved sign-ins with a key it keeps in the macOS Keychain. After a new Relay version, macOS may ask for your password once; choose “Always Allow”.",
  );
  // It belongs to the technical details card, after the existing notes.
  assert.ok(tr.indexOf("Teknik bilgiler") < tr.indexOf("Anahtarlık’ta tuttuğu bir anahtarla şifreler"));
  assert.ok(tr.indexOf("Limit okuma girişi resmi Claude Code") < tr.indexOf("Anahtarlık’ta tuttuğu bir anahtarla şifreler"));
  assert.ok(tr.indexOf("Anahtarlık’ta tuttuğu bir anahtarla şifreler") < tr.indexOf("Yerelde saklanır"));
});
