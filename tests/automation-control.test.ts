import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAutomationMode } from "../src/features/automation-actions";
import { afterExitChips } from "../src/features/AutomationControl";
import { Switching } from "../src/pages/Switching";
import { Overview } from "../src/pages/Overview";
import { Planning } from "../src/pages/Planning";
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

/** Records every write in order; `refuse` makes the fleet write fail, `refuseSettings` the settings write. */
function fakeApi(refuse?: Error, refuseSettings?: Error) {
  const calls: string[] = [];
  const api = {
    async setFleetContinuation(enabled: boolean) {
      calls.push(`setFleetContinuation:${enabled}`);
      if (refuse) throw refuse;
      return { enabled, status: enabled ? "watching" : "off" };
    },
    async updateSettings(patch: Partial<RelaySettings>) {
      calls.push(`updateSettings:${patch.autoSwitchMode}`);
      if (refuseSettings) throw refuseSettings;
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

test("applying after-exit turns prepare-on-quit on, then the fleet off", async () => {
  const { api, calls } = fakeApi();
  await applyAutomationMode(api, "after-exit", {
    fleetEnabled: true,
    autoSwitchMode: "off",
    legacyWatch: false,
  });
  // Both on for a moment still reads as Limit dolunca: the fleet wins.
  assert.deepEqual(calls, [
    "updateSettings:after-exit",
    "setFleetContinuation:false",
  ]);
});

test("a refused prepare-on-quit write leaves the fleet on", async () => {
  const refused = new Error("settings-write-failed");
  const { api, calls } = fakeApi(undefined, refused);
  await assert.rejects(
    applyAutomationMode(api, "after-exit", {
      fleetEnabled: true,
      autoSwitchMode: "off",
      legacyWatch: false,
    }),
    (error) => error === refused,
  );
  assert.deepEqual(calls, ["updateSettings:after-exit"]);
});

test("applying off turns the fleet off, then prepare-on-quit", async () => {
  const { api, calls } = fakeApi();
  await applyAutomationMode(api, "off", {
    fleetEnabled: true,
    autoSwitchMode: "after-exit",
    legacyWatch: false,
  });
  assert.deepEqual(calls, ["setFleetContinuation:false", "updateSettings:off"]);
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
    "updateSettings:after-exit",
    "setFleetContinuation:false",
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
// The pages read the clock, and only a reading under 15 minutes old confirms
// a full account, so the fixture is dated now.
const NOW = Date.now();
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
/** The choice cards: each card's title, and whether it is the chosen one. */
const radios = (html: string) =>
  [...html.matchAll(/<button[^>]*role="radio"[^>]*>(.*?)<\/button>/g)].map(([tag, inner]) => ({
    label: (/<span class="text-sm font-semibold">(.*?)<\/span>/.exec(inner)?.[1] ?? "").replace(/&#x27;/g, "'"),
    checked: tag.includes('aria-checked="true"'),
  }));

test("the Switching card shows one choice with the status and a switch-now button", () => {
  const html = render(relayFor({ fleet: otherWork, usage: fullUsage }));
  assert.match(html, /Ne zaman geçilsin\?/);
  const items = radios(html);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.filter((item) => item.checked).map((item) => item.label),
    ["Limit dolunca"],
  );
  assert.ok(
    html
      .replace(/<[^>]+>/g, "")
      .includes(
        "Kişisel · Max %100 kullanıldı · 2 konuşma limit dolduğu için durdu. Claude uygulamasında başka iş çalışıyor; bitince Kişisel · İkinci’ye geçip devam ettiririm. Şimdi geçersen devam mesajını sen yazarsın.",
      ),
  );
  assert.ok(html.includes("Şimdi Kişisel · İkinci’ye geç"));
  assert.doesNotMatch(html, /Kota dolunca geçiş ve devam/);
  assert.doesNotMatch(html, /Claude uygulaması kapanınca sıradaki hesabı hazırla/);
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
    ["Claude uygulamasını kapatınca"],
  );
  assert.match(afterExit, /Otomatik geçişe dahil hesaplar/);
  assert.match(afterExit, /Hedefte limitin en fazla %90’ı kullanılmış olmalı/);
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
    /Relay açık kalmalı\. Çalışan iş bitmeden Claude uygulaması yeniden başlatılmaz; her konuşmaya en fazla bir devam mesajı gider\./,
  );
});

/** The account chips: each one's text, and whether it is pressed. */
const chips = (html: string) =>
  [...html.matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map(
    ([, pressed, inner]) => `${pressed === "true" ? "✓ " : ""}${inner.replace(/<[^>]+>/g, "")}`,
  );

test("the after-exit accounts are chips saying which is open, which is next and whose data is old", () => {
  const afterExit = (data: Record<string, unknown>, selected = ["a", "b"]) =>
    render(
      relayFor(
        { fleet: { enabled: false, status: "off" }, ...data },
        { autoSwitchMode: "after-exit", autoSwitchAccounts: selected },
      ),
    );
  // b has room and a fresh reading: the next switch goes to it.
  const fresh = afterExit({ usage: { a: usage("a", 60), b: usage("b", 10) } });
  assert.deepEqual(chips(fresh), ["✓ Kişisel · Max· şu an açık", "✓ Kişisel · İkinci· sıradaki"]);
  // An old reading is not chosen by, and the chip says so.
  const old = { ...usage("b", 10), checkedAt: iso(NOW - 60 * 60_000) };
  assert.deepEqual(chips(afterExit({ usage: { a: usage("a", 60), b: old } })), [
    "✓ Kişisel · Max· şu an açık",
    "✓ Kişisel · İkinci· limit verisi eski · seçilmez",
  ]);
  // An unselected account is never next; its chip is not pressed.
  assert.deepEqual(chips(afterExit({ usage: { a: usage("a", 60), b: usage("b", 10) } }, ["a"])), [
    "✓ Kişisel · Max· şu an açık",
    "Kişisel · İkinci",
  ]);
  // The other modes show no chips.
  assert.deepEqual(chips(render(relayFor({ usage: fullUsage }))), []);
  assert.deepEqual(chips(render(relayFor({ fleet: { enabled: false, status: "off" } }))), []);
});

test("next is the watch's target when it has one, else the best selected account by the switch rule", () => {
  const c: Account = { ...b, id: "c", name: "Üçüncü", desktop: linked(3, "c@example.com") };
  const settings = { ...baseSettings, autoSwitchMode: "after-exit" as const, autoSwitchAccounts: ["a", "b", "c"] };
  const states = (input: Partial<Parameters<typeof afterExitChips>[0]>) =>
    afterExitChips({
      accounts: [a, b, c],
      settings,
      usage: { a: usage("a", 100), b: usage("b", 10), c: usage("c", 95) },
      activeId: "a",
      now: NOW,
      ...input,
    }).map((chip) => chip.state);
  // c is over 90%, so b is next.
  assert.deepEqual(states({}), ["open", "next", undefined]);
  // The watch's own pick wins.
  assert.deepEqual(states({ targetId: "c" }), ["open", undefined, "next"]);
  // Nobody with room: no next.
  assert.deepEqual(states({ usage: { a: usage("a", 100), b: usage("b", 92), c: usage("c", 95) } }), [
    "open",
    undefined,
    undefined,
  ]);
  // Without a Claude app sign-in the chip asks for one instead.
  const unsigned = { ...b, desktop: undefined };
  assert.deepEqual(
    afterExitChips({ accounts: [a, unsigned], settings, usage: {}, activeId: "a", now: NOW }).map((x) => x.state),
    ["open", "sign-in"],
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

const SWITCH_NOW = "Şimdi Kişisel · İkinci’ye geç";
const count = (html: string, text: string) => html.split(text).length - 1;
const overview = createElement(Overview, { go() {}, now: NOW });

test("Switching and Overview show the offer inline, not in the page banner", () => {
  const relay = relayFor({ fleet: otherWork, usage: fullUsage });
  for (const [label, element] of [
    ["Switching", createElement(Switching)],
    ["Overview", overview],
  ] as const) {
    const html = render(relay, element);
    assert.doesNotMatch(html, /Otomatik geçiş ·/, label);
    assert.equal(count(html, SWITCH_NOW), 1, label);
    assert.equal(count(html, "2 konuşma limit dolduğu için durdu."), 1, label);
  }
  // Pages without the inline status keep the banner.
  const planning = render(relay, createElement(Planning));
  assert.match(planning, /Otomatik geçiş ·/);
  assert.equal(count(planning, SWITCH_NOW), 1);
});

test("Overview has no suggestion band: automation's switch-now stays its one offer and the suggestion leads the accounts", () => {
  const offered = render(
    { ...relayFor({ fleet: otherWork, usage: fullUsage }), suggestion: b },
    overview,
  );
  assert.doesNotMatch(offered, /uyarı eşiğini geçti/);
  assert.doesNotMatch(offered, /Geçişi incele/);
  assert.equal(count(offered, SWITCH_NOW), 1);
  // Without an automation offer there is still no band: the accounts card's heading names the
  // near limit and puts the suggestion first, and nothing offers a switch-now.
  const suggested = render(
    {
      ...relayFor({ usage: { a: usage("a", 90), b: usage("b", 10) } }),
      suggestion: b,
    },
    overview,
  );
  assert.doesNotMatch(suggested, /uyarı eşiğini geçti/);
  assert.match(suggested, /limiti dolmak üzere · önerilen üstte/);
  assert.match(suggested, />önerilen</);
  assert.doesNotMatch(suggested, /Geçişi incele/);
  assert.equal(count(suggested, SWITCH_NOW), 0);
});

test("the status line keeps the usage prefix out of the live announcement", () => {
  const html = render(relayFor({ fleet: otherWork, usage: fullUsage }));
  const live = [
    ...html.matchAll(/<span role="status" aria-live="polite">(.*?)<\/span>/g),
  ].map(([, text]) => text);
  assert.deepEqual(live, [
    "2 konuşma limit dolduğu için durdu. Claude uygulamasında başka iş çalışıyor; bitince Kişisel · İkinci’ye geçip devam ettiririm. Şimdi geçersen devam mesajını sen yazarsın.",
  ]);
  // The prefix is still shown, just outside the live region.
  assert.ok(html.includes('Kişisel · Max %100 kullanıldı · <span role="status"'));
});

/** Source files (posix paths) the static, non-type imports reach from `entry`. */
function imported(entry: string): Set<string> {
  const root = path.resolve(import.meta.dirname, "..");
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const [, spec] of source.matchAll(
      /^(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm,
    )) {
      const base = spec.startsWith("@/")
        ? path.posix.join("src", spec.slice(2))
        : spec.startsWith(".")
          ? path.posix.join(path.posix.dirname(file), spec)
          : undefined;
      if (base === undefined) continue;
      const found = [".ts", ".tsx"]
        .map((ext) => base + ext)
        .find((f) => fs.existsSync(path.join(root, f)));
      if (found) visit(found);
    }
  };
  visit(entry);
  return seen;
}

test("the menu bar panel does not bundle the Switching card", () => {
  const panel = imported("src/panel/main.tsx");
  assert.ok(panel.has("src/panel/PanelAutomation.tsx"));
  assert.ok(panel.has("src/features/useAutomation.ts"));
  assert.ok(!panel.has("src/features/AutomationControl.tsx"));
  assert.ok(!panel.has("src/features/SwitchPreferences.tsx"));
  // The page banners and the automation card no longer import each other.
  assert.ok(
    !imported("src/features/AutomationControl.tsx").has("src/app/Banners.tsx"),
  );
});
