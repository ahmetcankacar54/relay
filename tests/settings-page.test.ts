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
    /Limitleri yenileme/, /Elle/, /Claude CLI dosyasını seç/, /Bulundu/, /2\.1\.0/,
    /Yerelde saklanır\. Kontrol sende\./, /Bağımsız araç · 0\.\d+\.\d+/,
  ])
    assert.match(html, re);
});
