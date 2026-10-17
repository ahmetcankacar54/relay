import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAutomationMode } from "../src/features/automation-actions";
import { Switching } from "../src/pages/Switching";
import { Banners } from "../src/app/Banners";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type RelayAPI,
  type RelaySettings,
  type Snapshot,
} from "../shared/types";

type AutomationApi = Pick<
  RelayAPI,
  "setFleetContinuation" | "updateSettings" | "disarmContinuation"
>;

/** Records every write in order; `refuse` makes the fleet write fail. */
function fakeApi(refuse?: Error) {
  const calls: string[] = [];
  const api = {
    async setFleetContinuation(enabled: boolean) {
      calls.push(`setFleetContinuation:${enabled}`);
      if (refuse) throw refuse;
      return { enabled, status: enabled ? "watching" : "off" };
    },
    async updateSettings(patch: Partial<RelaySettings>) {
      calls.push(`updateSettings:${patch.autoSwitchMode}`);
      return { ...DEFAULT_SETTINGS, ...patch };
    },
    async disarmContinuation() {
      calls.push("disarmContinuation");
      return {
        status: "off",
        reason: "disabled",
        canArm: false,
        enabled: false,
        executable: false,
      };
    },
  } as unknown as AutomationApi;
  return { api, calls };
}

test("applying quota turns the fleet on, then prepare-on-quit off", async () => {
  const { api, calls } = fakeApi();
  await applyAutomationMode(api, "quota", {
    fleetEnabled: false,
    autoSwitchMode: "after-exit",
    legacyWatch: false,
  });
  assert.deepEqual(calls, ["setFleetContinuation:true", "updateSettings:off"]);
});

test("a refused fleet leaves prepare-on-quit untouched", async () => {
  const refused = new Error("keychain-denied");
  const { api, calls } = fakeApi(refused);
  await assert.rejects(
    applyAutomationMode(api, "quota", {
      fleetEnabled: false,
      autoSwitchMode: "after-exit",
      legacyWatch: false,
    }),
    (error) => error === refused,
  );
  assert.deepEqual(calls, ["setFleetContinuation:true"]);
  assert.ok(!calls.some((call) => call.startsWith("updateSettings")));
});

test("choosing a mode turns the legacy watch off first", async () => {
  const first = fakeApi();
  await applyAutomationMode(first.api, "after-exit", {
    fleetEnabled: true,
    autoSwitchMode: "off",
    legacyWatch: true,
  });
  assert.deepEqual(first.calls, [
    "disarmContinuation",
    "setFleetContinuation:false",
    "updateSettings:after-exit",
  ]);
  // Turning the fleet on disarms the legacy watch in main already.
  const quota = fakeApi();
  await applyAutomationMode(quota.api, "quota", {
    fleetEnabled: false,
    autoSwitchMode: "off",
    legacyWatch: true,
  });
  assert.deepEqual(quota.calls, ["setFleetContinuation:true"]);
});

test("no redundant writes", async () => {
  const current = {
    off: { fleetEnabled: false, autoSwitchMode: "off" },
    "after-exit": { fleetEnabled: false, autoSwitchMode: "after-exit" },
    quota: { fleetEnabled: true, autoSwitchMode: "off" },
  } as const;
  for (const mode of ["off", "after-exit", "quota"] as const) {
    const { api, calls } = fakeApi();
    await applyAutomationMode(api, mode, {
      ...current[mode],
      legacyWatch: false,
    });
    assert.deepEqual(calls, [], mode);
  }
});

// The relay fixture from tests/switching-page.test.ts, with a second account.
const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const linked = (n: number, email: string) => ({
  accountUuid: `00000000-0000-4000-8000-00000000000${n}`,
  orgId: "00000000-0000-4000-8000-000000000009",
  savedAt: iso(NOW),
  email,
});
const a: Account = {
  id: "a",
  name: "Kişisel · Max",
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: iso(NOW),
  desktop: linked(1, "a@example.com"),
  auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const b: Account = {
  ...a,
  id: "b",
  name: "Kişisel · İkinci",
  desktop: linked(2, "b@example.com"),
  auth: { loggedIn: true, email: "b@example.com", checkedAt: iso(NOW) },
};
const accounts = [a, b];
const baseSettings = {
  ...DEFAULT_SETTINGS,
  autoSwitchMode: "off" as const,
  desktopHistoryTransfer: "all" as const,
};
const usage = (id: string, five: number): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, resetsAt: iso(NOW + 3_600_000) },
  sevenDay: { usedPercent: 40, resetsAt: iso(NOW + 86_400_000) },
});
const fullUsage = { a: usage("a", 100), b: usage("b", 10) };
const otherWork = {
  enabled: true,
  status: "waiting",
  reason: "not-quiescent:busyWorkers",
  sourceId: "a",
  targetId: "b",
  stopped: 2,
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
    dismissError: async () => {},
    startCli: async () => {},
    refreshUsage: async () => {},
    action: async () => {},
    setData() {},
  } as unknown as Relay;
}
const render = (
  relay: Relay,
  element: ReactElement = createElement(Switching),
) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(RelayContext.Provider, { value: relay }, element),
    ),
  );
const radios = (html: string) =>
  [...html.matchAll(/<button[^>]*role="radio"[^>]*>(.*?)<\/button>/g)].map(
    ([tag, label]) => ({ label, checked: tag.includes('aria-checked="true"') }),
  );

test("the Switching card shows one choice with the status and a switch-now button", () => {
  const html = render(relayFor({ fleet: otherWork, usage: fullUsage }));
  assert.match(html, /Otomatik geçiş/);
  const items = radios(html);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.filter((item) => item.checked).map((item) => item.label),
    ["Kota dolunca"],
  );
  assert.ok(
    html.includes(
      "Kişisel · Max %100 · 2 konuşma kota yüzünden durdu. Claude’da başka iş çalışıyor; bitince Kişisel · İkinci’ye geçip devam ettiririm. Şimdi geçersen devam mesajını sen yazarsın.",
    ),
  );
  assert.ok(html.includes("Şimdi Kişisel · İkinci’ye geç"));
  assert.doesNotMatch(html, /Kota dolunca geçiş ve devam/);
  assert.doesNotMatch(html, /Claude kapanınca sıradaki hesabı hazırla/);
});

test("the after-exit card lists accounts and the quota card does not", () => {
  const afterExit = render(
    relayFor(
      {
        fleet: { enabled: false, status: "off" },
        autoSwitch: { status: "watching", reason: "quota-available" },
      },
      { autoSwitchMode: "after-exit" },
    ),
  );
  assert.deepEqual(
    radios(afterExit)
      .filter((item) => item.checked)
      .map((item) => item.label),
    ["Claude kapanınca"],
  );
  assert.match(afterExit, /Otomatik geçişe dahil hesaplar/);
  assert.match(afterExit, /Hedefte en az %10 limit kalmalı/);
  assert.doesNotMatch(afterExit, /Relay açık kalmalı/);

  const quota = render(
    relayFor({
      fleet: {
        enabled: true,
        status: "watching",
        reason: "awaiting-quota-stop",
        sourceId: "a",
      },
    }),
  );
  assert.doesNotMatch(quota, /Otomatik geçişe dahil hesaplar/);
  assert.match(
    quota,
    /Relay açık kalmalı\. Çalışan iş bitmeden Claude yeniden başlatılmaz; her konuşmaya en fazla bir devam mesajı gider\./,
  );
});

test("the banner appears only when the status asks for it", () => {
  const calm = render(
    relayFor(
      {
        fleet: { enabled: false, status: "off" },
        autoSwitch: { status: "watching", reason: "quota-available" },
      },
      { autoSwitchMode: "after-exit" },
    ),
    createElement(Banners),
  );
  assert.doesNotMatch(calm, /Otomatik geçiş ·/);
  const waiting = render(
    relayFor({ fleet: otherWork, usage: fullUsage }),
    createElement(Banners),
  );
  assert.match(waiting, /Otomatik geçiş ·/);
  assert.ok(waiting.includes("Şimdi Kişisel · İkinci’ye geç"));
});
