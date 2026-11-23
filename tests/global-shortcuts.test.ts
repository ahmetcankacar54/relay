import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_SHORTCUTS,
  acceleratorFromKeys,
  formatAccelerator,
  normalizeAccelerator,
  shortcutFor,
} from "../shared/shortcuts";
import { GlobalShortcuts, shortcutSwitchTarget, type ShortcutHost } from "../electron/core/global-shortcuts";
import { settingsPatchSchema, settingsSchema } from "../electron/core/store";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type Snapshot } from "../shared/types";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { ShortcutGroup } from "../src/pages/settings/ShortcutSettings";
import { planningAccount, planningUsage } from "./planning-fixtures";
import { i18nValue } from "./i18n";

const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("accelerators are normalized to one spelling and need ⌘, Ctrl, Alt or Super", () => {
  assert.equal(normalizeAccelerator("cmdorctrl+shift+option+space"), "CommandOrControl+Alt+Shift+Space");
  assert.equal(normalizeAccelerator("Shift+Ctrl+k"), "Control+Shift+K");
  assert.equal(normalizeAccelerator("Super+Esc"), "Super+Escape");
  assert.equal(normalizeAccelerator("Ctrl++"), "Control+Plus");
  assert.equal(normalizeAccelerator("Alt+Enter"), "Alt+Return");
  assert.equal(normalizeAccelerator("F13"), "F13");
  assert.equal(normalizeAccelerator(DEFAULT_SHORTCUTS.openPanel), DEFAULT_SHORTCUTS.openPanel);
  // A global key without a modifier, or with Shift alone, would take a letter from typing.
  for (const bad of ["R", "Shift+R", "", "Ctrl", "Ctrl+Ctrl+R", "Ctrl+R+T", "Hyper+R", "Ctrl+Enterr", "Ctrl+ +R"])
    assert.equal(normalizeAccelerator(bad), undefined, bad);
});

test("a key press records by the key's place; ⌘ on a Mac and Ctrl elsewhere read as CommandOrControl", () => {
  // Option+R types "®" on a Mac: the recorder reads the key's code, not its character.
  assert.equal(acceleratorFromKeys(press("KeyR", { metaKey: true, altKey: true }), "darwin"), "CommandOrControl+Alt+R");
  assert.equal(acceleratorFromKeys(press("KeyR", { ctrlKey: true, altKey: true }), "win32"), "CommandOrControl+Alt+R");
  assert.equal(acceleratorFromKeys(press("KeyR", { ctrlKey: true }), "darwin"), "Control+R");
  assert.equal(acceleratorFromKeys(press("Digit5", { metaKey: true }), "linux"), "Super+5");
  assert.equal(acceleratorFromKeys(press("ArrowUp", { ctrlKey: true, shiftKey: true }), "linux"), "CommandOrControl+Shift+Up");
  assert.equal(acceleratorFromKeys(press("Space", { metaKey: true, altKey: true, shiftKey: true }), "darwin"), DEFAULT_SHORTCUTS.openPanel);
  assert.equal(acceleratorFromKeys(press("Comma", { altKey: true }), "win32"), "Alt+,");
  assert.equal(acceleratorFromKeys(press("F5"), "win32"), "F5");
  // Only modifiers down yet, Shift alone, or a key Electron cannot name: nothing recorded.
  assert.equal(acceleratorFromKeys(press("ShiftLeft", { shiftKey: true }), "darwin"), undefined);
  assert.equal(acceleratorFromKeys(press("KeyA", { shiftKey: true }), "darwin"), undefined);
  assert.equal(acceleratorFromKeys(press("IntlBackslash", { ctrlKey: true }), "win32"), undefined);
});

test("accelerators read as the platform writes them", () => {
  assert.equal(formatAccelerator(DEFAULT_SHORTCUTS.openPanel, "darwin"), "⌥⇧⌘Space");
  assert.equal(formatAccelerator("Control+Alt+R", "darwin"), "⌃⌥R");
  assert.equal(formatAccelerator(DEFAULT_SHORTCUTS.openPanel, "win32"), "Ctrl+Alt+Shift+Space");
  assert.equal(formatAccelerator("Super+Up", "win32"), "Win+Up");
  assert.equal(formatAccelerator("Super+Up", "linux"), "Super+Up");
});

test("a missing choice means the default; opening Relay has one, switching starts off", () => {
  assert.equal(shortcutFor(undefined, "openPanel"), DEFAULT_SHORTCUTS.openPanel);
  assert.equal(shortcutFor(undefined, "switchToSuggested"), "");
  assert.equal(shortcutFor({ openPanel: "" }, "openPanel"), "");
});

/** electron's globalShortcut, with keys `held` by another app. */
function fakeHost(held: string[] = []) {
  const registered = new Map<string, () => void>();
  const host: ShortcutHost & { registered: typeof registered; held: Set<string>; calls: string[] } = {
    registered,
    held: new Set(held),
    calls: [],
    register(accelerator, callback) {
      host.calls.push(`+${accelerator}`);
      if (host.held.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      host.calls.push(`-${accelerator}`);
      registered.delete(accelerator);
    },
  };
  return host;
}

test("shortcuts register at start, follow every change, and let go at quit", () => {
  const host = fakeHost();
  const ran: string[] = [];
  const shortcuts = new GlobalShortcuts(host, {
    openPanel: () => ran.push("open"),
    switchToSuggested: () => ran.push("switch"),
  });
  assert.deepEqual(shortcuts.apply(undefined), { openPanel: "on", switchToSuggested: "off" });
  assert.deepEqual([...host.registered.keys()], [DEFAULT_SHORTCUTS.openPanel]);
  host.registered.get(DEFAULT_SHORTCUTS.openPanel)!();
  assert.deepEqual(ran, ["open"]);
  // Applying the same choice again touches nothing.
  host.calls.length = 0;
  shortcuts.apply({});
  assert.equal(host.calls.length, 0);
  // A new key replaces the old; switching turned on.
  shortcuts.apply({ openPanel: "Control+Alt+K", switchToSuggested: "Control+Alt+J" });
  assert.deepEqual([...host.registered.keys()].sort(), ["Control+Alt+J", "Control+Alt+K"]);
  assert.ok(host.calls.includes(`-${DEFAULT_SHORTCUTS.openPanel}`));
  host.registered.get("Control+Alt+J")!();
  assert.deepEqual(ran, ["open", "switch"]);
  // Two actions trade keys in one change.
  assert.deepEqual(shortcuts.apply({ openPanel: "Control+Alt+J", switchToSuggested: "Control+Alt+K" }), {
    openPanel: "on",
    switchToSuggested: "on",
  });
  host.registered.get("Control+Alt+J")!();
  assert.deepEqual(ran, ["open", "switch", "open"]);
  // Cleared: off and unregistered.
  assert.deepEqual(shortcuts.apply({ openPanel: "", switchToSuggested: "Control+Alt+K" }), {
    openPanel: "off",
    switchToSuggested: "on",
  });
  assert.deepEqual([...host.registered.keys()], ["Control+Alt+K"]);
  shortcuts.dispose();
  assert.equal(host.registered.size, 0);
  assert.deepEqual(shortcuts.status(), { openPanel: "off", switchToSuggested: "off" });
});

test("a key another app holds is reported, not thrown, and retried at the next change", () => {
  const host = fakeHost([DEFAULT_SHORTCUTS.openPanel]);
  const logged: string[] = [];
  const shortcuts = new GlobalShortcuts(host, { openPanel: () => {}, switchToSuggested: () => {} }, (event) =>
    logged.push(event),
  );
  assert.deepEqual(shortcuts.apply(undefined), { openPanel: "taken", switchToSuggested: "off" });
  assert.equal(host.registered.size, 0);
  // The same key for both actions: the second one is taken.
  assert.deepEqual(shortcuts.apply({ openPanel: "Alt+F1", switchToSuggested: "Alt+F1" }), {
    openPanel: "on",
    switchToSuggested: "taken",
  });
  // The other app let go: the next apply takes it.
  host.held.clear();
  assert.deepEqual(shortcuts.apply({}), { openPanel: "on", switchToSuggested: "off" });
  // Electron throws for a key this platform cannot register: unavailable, logged.
  const throwing = new GlobalShortcuts(
    {
      register: () => {
        throw new Error("conversion failed");
      },
      unregister: () => {},
    },
    { openPanel: () => {}, switchToSuggested: () => {} },
    (event) => logged.push(event),
  );
  assert.deepEqual(throwing.apply({}), { openPanel: "taken", switchToSuggested: "off" });
  assert.deepEqual(logged, ["shortcut-register-failed"]);
  // An action that fails is logged, never thrown into Electron.
  const failing = fakeHost();
  new GlobalShortcuts(
    failing,
    {
      openPanel: () => {
        throw new Error("no window");
      },
      switchToSuggested: () => {},
    },
    (event) => logged.push(event),
  ).apply({});
  failing.registered.get(DEFAULT_SHORTCUTS.openPanel)!();
  assert.deepEqual(logged, ["shortcut-register-failed", "shortcut-failed"]);
});

test("a choice is saved only as Relay's own spelling; a stored one never rejects the registry", () => {
  assert.ok(settingsPatchSchema.safeParse({ shortcuts: { openPanel: "Control+Alt+K", switchToSuggested: "" } }).success);
  assert.ok(settingsPatchSchema.safeParse({ updateChannel: "beta" }).success);
  for (const bad of [{ openPanel: "ctrl+alt+k" }, { openPanel: "K" }, { other: "Alt+K" }, { openPanel: 4 }])
    assert.equal(settingsPatchSchema.safeParse({ shortcuts: bad }).success, false, JSON.stringify(bad));
  assert.equal(settingsPatchSchema.safeParse({ updateChannel: "nightly" }).success, false);
  const saved = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, shortcuts: { openPanel: "Hyper+K" } });
  assert.ok(saved.success);
});

const NOW = Date.parse("2026-10-13T06:00:00Z");
/** A Claude account saved for the Claude app, with its limits read now. */
function linked(id: string, fiveHour = 0): [Account, AccountUsage] {
  const account = { ...planningAccount(id, "max5"), desktop: { accountUuid: id, orgId: `org-${id}`, savedAt: new Date(NOW).toISOString() } };
  return [account, { ...planningUsage(account, NOW), fiveHour: { usedPercent: fiveHour } }];
}

test("switch-to-suggested offers the panel's suggested account, never the active or a separate window's", () => {
  const [vertex, vertexUsage] = linked("vertex", 95);
  const [alto, altoUsage] = linked("alto", 10);
  const [birch, birchUsage] = linked("birch", 60);
  const accounts = [vertex, alto, birch];
  const usage = { vertex: vertexUsage, alto: altoUsage, birch: birchUsage };
  const base = { activeId: "vertex", accounts, usage, settings: DEFAULT_SETTINGS, now: NOW, inWindows: new Set<string>() };
  // Vertex is past the warning: the suggestion is the roomiest other account.
  assert.equal(shortcutSwitchTarget(base)?.id, "alto");
  // Alto is open in its own Claude window: the next one.
  assert.equal(shortcutSwitchTarget({ ...base, inWindows: new Set(["alto"]) })?.id, "birch");
  // Without a warning, the panel's badge: the top of its ranking.
  assert.equal(shortcutSwitchTarget({ ...base, usage: { ...usage, vertex: { ...vertexUsage, fiveHour: { usedPercent: 5 } } } })?.id, "alto");
  // An account whose Claude app and usage sign-ins disagree, or not saved for the Claude app, is skipped.
  const mismatched = { ...alto, auth: { ...alto.auth!, accountUuid: "someone-else" } };
  const unlinked = { ...birch, desktop: undefined };
  assert.equal(shortcutSwitchTarget({ ...base, accounts: [vertex, mismatched, unlinked] }), undefined);
  // Nothing to offer when every other account is full.
  assert.equal(
    shortcutSwitchTarget({ ...base, usage: { ...usage, alto: { ...altoUsage, fiveHour: { usedPercent: 100, resetsAt: new Date(NOW + 3_600_000).toISOString() } }, birch: { ...birchUsage, fiveHour: { usedPercent: 100, resetsAt: new Date(NOW + 3_600_000).toISOString() } } } }),
    undefined,
  );
});

test("while Settings records, the keys are let go; a change meanwhile is registered on resume", () => {
  const host = fakeHost();
  const shortcuts = new GlobalShortcuts(host, { openPanel: () => {}, switchToSuggested: () => {} });
  shortcuts.apply({});
  shortcuts.pause();
  // The registered combination now reaches the recorder instead of Relay.
  assert.equal(host.registered.size, 0);
  // The states stay as they were, so Settings does not flash "taken" while recording.
  assert.deepEqual(shortcuts.status(), { openPanel: "on", switchToSuggested: "off" });
  shortcuts.pause();
  // The recorded key is saved while paused: kept, not registered yet.
  shortcuts.apply({ openPanel: "Control+Alt+K" });
  assert.equal(host.registered.size, 0);
  assert.deepEqual(shortcuts.resume(), { openPanel: "on", switchToSuggested: "off" });
  assert.deepEqual([...host.registered.keys()], ["Control+Alt+K"]);
  // Resuming twice, or without a pause, changes nothing.
  host.calls.length = 0;
  shortcuts.resume();
  assert.equal(host.calls.length, 0);
  // Quitting while paused registers nothing again.
  shortcuts.pause();
  shortcuts.dispose();
  shortcuts.resume();
  assert.equal(host.registered.size, 0);
});

test("main wires the shortcuts: the panel or the window, the menu bar's confirmation, and unregistering at quit", () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, "../electron/main.ts"), "utf8");
  // Recording pauses them through a trusted, validated call that resumes by itself if left on.
  const pauseHandler = main.slice(main.indexOf('handle("pause-shortcuts"'), main.indexOf("// Separate Claude windows"));
  assert.match(pauseHandler, /z\.boolean\(\)\.parse\(paused\)/);
  assert.match(pauseHandler, /globalShortcuts\?\.pause\(\)/);
  assert.match(pauseHandler, /setTimeout\(/);
  const recorder = fs.readFileSync(path.join(import.meta.dirname, "../src/pages/settings/ShortcutSettings.tsx"), "utf8");
  assert.match(recorder, /api\.pauseShortcuts\(true\)[\s\S]*return \(\) => void api\.pauseShortcuts\(false\)/);
  const switchFn = main.slice(main.indexOf("async function switchFromShortcut"), main.indexOf("/** Accounts the extension notice"));
  assert.match(switchFn, /await traySwitch\(target\.id\)/);
  assert.doesNotMatch(switchFn, /desktop\.switchTo/);
  const openFn = main.slice(main.indexOf("function openFromShortcut"), main.indexOf("/** A shortcut's switch question"));
  assert.match(openFn, /trayPanel\.toggle\(bounds\)/);
  assert.match(openFn, /showWindow\(\)/);
  const quit = main.slice(main.indexOf('app.on("will-quit"'));
  assert.match(quit, /globalShortcuts\?\.dispose\(\)/);
  assert.match(main, /if \(patch\.shortcuts\) globalShortcuts\?\.apply\(/);
});

test("Settings records each shortcut, offers Clear, and says when another app holds the keys", () => {
  const relay = (shortcuts: Snapshot["shortcuts"], choice = {}) =>
    ({
      api: {},
      busy: "",
      desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 },
      settings: { ...DEFAULT_SETTINGS, shortcuts: choice },
      data: { settings: DEFAULT_SETTINGS, usage: {}, accounts: [], authFlows: [], shortcuts, diagnostics: { platform: "darwin" } },
      action: async () => {},
    }) as unknown as Relay;
  const render = (value: Relay, language: "tr" | "en") =>
    renderToStaticMarkup(
      createElement(I18nContext.Provider, { value: i18nValue(language) }, createElement(RelayContext.Provider, { value }, createElement(ShortcutGroup))),
    );
  const en = render(relay({ openPanel: "on", switchToSuggested: "off" }), "en");
  assert.match(en, /Keyboard shortcuts/);
  assert.match(en, /id="shortcut-openPanel"[^>]*>⌥⇧⌘Space</);
  assert.match(en, /id="shortcut-switchToSuggested"[^>]*>Off</);
  assert.match(en, />Clear</);
  assert.doesNotMatch(en, /role="alert"/);
  const tr = render(relay({ openPanel: "taken", switchToSuggested: "on" }, { switchToSuggested: "Control+Alt+K" }), "tr");
  assert.match(tr, /Klavye kısayolları/);
  assert.match(tr, /role="alert"[^>]*>Bu tuşları başka bir uygulama ya da kısayol kullanıyor/);
  assert.match(tr, />⌃⌥K</);
});
