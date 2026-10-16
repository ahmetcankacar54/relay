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

test("Switching shows fleet, after-exit preparation, shared history and suggestions in separate cards", () => {
  const html = render(relayFor());
  assert.match(html, /Kota dolunca geçiş ve devam/);
  assert.match(html, /İzleniyor/);
  assert.match(html, /Claude kapanınca sıradaki hesabı hazırla/);
  assert.match(html, /Ortak Code geçmişi/);
  assert.match(html, /Tüm hesaplar arasında/);
  assert.match(html, /Açık hesapla birleştir/);
  assert.match(html, /Limit yaklaşınca hesap öner/);
  assert.match(
    html,
    /Menü çubuğundan bir hesap seçip tek onayla geçebilirsin. Pencere kapanınca Relay menü çubuğunda çalışmaya devam eder./,
  );
  assert.doesNotMatch(html, /Bu konuşmayı izle/);
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

test("while Continue at quota is on, the prepare-on-quit row says the switch waits", () => {
  const hold =
    /Kota dolunca devam açıkken bu geçiş bekler; kota dolan konuşmalar Claude açıldığında devam ettirilir\./;
  const afterExit = { autoSwitchMode: "after-exit" as const };
  assert.match(render(relayFor({}, afterExit)), hold);
  // Not while the fleet is off, and not when the switch itself is off.
  assert.doesNotMatch(
    render(
      relayFor(
        { fleet: { enabled: false, status: "off", stopped: 0 } },
        afterExit,
      ),
    ),
    hold,
  );
  assert.doesNotMatch(render(relayFor()), hold);
});
