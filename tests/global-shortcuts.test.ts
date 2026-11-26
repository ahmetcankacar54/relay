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
import { DEFAULT_SETTINGS, type Snapshot } from "../shared/types";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { ShortcutGroup } from "../src/pages/settings/ShortcutSettings";
import { i18nValue } from "./i18n";

const press = (
  code: string,
  mods: Partial<
    Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>
  > = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("accelerators are normalized to one spelling and need ⌘, Ctrl, Alt or Super", () => {
  assert.equal(
    normalizeAccelerator("cmdorctrl+shift+option+space"),
    "CommandOrControl+Alt+Shift+Space",
  );
  assert.equal(normalizeAccelerator("Shift+Ctrl+k"), "Control+Shift+K");
  assert.equal(normalizeAccelerator("Super+Esc"), "Super+Escape");
  assert.equal(normalizeAccelerator("Ctrl++"), "Control+Plus");
  assert.equal(normalizeAccelerator("Alt+Enter"), "Alt+Return");
  assert.equal(normalizeAccelerator("F13"), "F13");
  assert.equal(
    normalizeAccelerator(DEFAULT_SHORTCUTS.openPanel),
    DEFAULT_SHORTCUTS.openPanel,
  );
  // A global key without a modifier, or with Shift alone, would take a letter from typing.
  for (const bad of [
    "R",
    "Shift+R",
    "",
    "Ctrl",
    "Ctrl+Ctrl+R",
    "Ctrl+R+T",
    "Hyper+R",
    "Ctrl+Enterr",
    "Ctrl+ +R",
  ])
    assert.equal(normalizeAccelerator(bad), undefined, bad);
});

test("a key press records by the key's place; ⌘ on a Mac and Ctrl elsewhere read as CommandOrControl", () => {
  // Option+R types "®" on a Mac: the recorder reads the key's code, not its character.
  assert.equal(
    acceleratorFromKeys(
      press("KeyR", { metaKey: true, altKey: true }),
      "darwin",
    ),
    "CommandOrControl+Alt+R",
  );
  assert.equal(
    acceleratorFromKeys(
      press("KeyR", { ctrlKey: true, altKey: true }),
      "win32",
    ),
    "CommandOrControl+Alt+R",
  );
  assert.equal(
    acceleratorFromKeys(press("KeyR", { ctrlKey: true }), "darwin"),
    "Control+R",
  );
  assert.equal(
    acceleratorFromKeys(press("Digit5", { metaKey: true }), "linux"),
    "Super+5",
  );
  assert.equal(
    acceleratorFromKeys(
      press("ArrowUp", { ctrlKey: true, shiftKey: true }),
      "linux",
    ),
    "CommandOrControl+Shift+Up",
  );
  assert.equal(
    acceleratorFromKeys(
      press("Space", { metaKey: true, altKey: true, shiftKey: true }),
      "darwin",
    ),
    DEFAULT_SHORTCUTS.openPanel,
  );
  assert.equal(
    acceleratorFromKeys(press("Comma", { altKey: true }), "win32"),
    "Alt+,",
  );
  assert.equal(acceleratorFromKeys(press("F5"), "win32"), "F5");
  // Only modifiers down yet, Shift alone, or a key Electron cannot name: nothing recorded.
  assert.equal(
    acceleratorFromKeys(press("ShiftLeft", { shiftKey: true }), "darwin"),
    undefined,
  );
  assert.equal(
    acceleratorFromKeys(press("KeyA", { shiftKey: true }), "darwin"),
    undefined,
  );
  assert.equal(
    acceleratorFromKeys(press("IntlBackslash", { ctrlKey: true }), "win32"),
    undefined,
  );
});

test("accelerators read as the platform writes them", () => {
  assert.equal(
    formatAccelerator(DEFAULT_SHORTCUTS.openPanel, "darwin"),
    "⌥⇧⌘Space",
  );
  assert.equal(formatAccelerator("Control+Alt+R", "darwin"), "⌃⌥R");
  assert.equal(
    formatAccelerator(DEFAULT_SHORTCUTS.openPanel, "win32"),
    "Ctrl+Alt+Shift+Space",
  );
  assert.equal(formatAccelerator("Super+Up", "win32"), "Win+Up");
  assert.equal(formatAccelerator("Super+Up", "linux"), "Super+Up");
});

test("a missing choice means the default; opening Relay has one, switching starts off", () => {
  assert.equal(
    shortcutFor(undefined, "openPanel"),
    DEFAULT_SHORTCUTS.openPanel,
  );
  assert.equal(shortcutFor(undefined, "switchToSuggested"), "");
  assert.equal(shortcutFor({ openPanel: "" }, "openPanel"), "");
});

test("Settings pauses the shortcuts while it records, and resumes them when it stops", () => {
  const recorder = fs.readFileSync(
    path.join(
      import.meta.dirname,
      "../src/pages/settings/ShortcutSettings.tsx",
    ),
    "utf8",
  );
  assert.match(
    recorder,
    /api\.pauseShortcuts\(true\)[\s\S]*return \(\) => void api\.pauseShortcuts\(false\)/,
  );
});

test("Settings records each shortcut, offers Clear, and says when another app holds the keys", () => {
  const relay = (shortcuts: Snapshot["shortcuts"], choice = {}) =>
    ({
      api: {},
      busy: "",
      desktop: {
        available: true,
        running: true,
        organizations: [],
        busy: false,
        recoveryRequired: false,
        errorRevision: 0,
      },
      settings: { ...DEFAULT_SETTINGS, shortcuts: choice },
      data: {
        settings: DEFAULT_SETTINGS,
        usage: {},
        accounts: [],
        authFlows: [],
        shortcuts,
        diagnostics: { platform: "darwin" },
      },
      action: async () => {},
    }) as unknown as Relay;
  const render = (value: Relay, language: "tr" | "en") =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: i18nValue(language) },
        createElement(
          RelayContext.Provider,
          { value },
          createElement(ShortcutGroup),
        ),
      ),
    );
  const en = render(relay({ openPanel: "on", switchToSuggested: "off" }), "en");
  assert.match(en, /Keyboard shortcuts/);
  assert.match(en, /id="shortcut-openPanel"[^>]*>⌥⇧⌘Space</);
  assert.match(en, /id="shortcut-switchToSuggested"[^>]*>Off</);
  assert.match(en, />Clear</);
  assert.doesNotMatch(en, /role="alert"/);
  const tr = render(
    relay(
      { openPanel: "taken", switchToSuggested: "on" },
      { switchToSuggested: "Control+Alt+K" },
    ),
    "tr",
  );
  assert.match(tr, /Klavye kısayolları/);
  assert.match(
    tr,
    /role="alert"[^>]*>Bu tuşları başka bir uygulama ya da kısayol kullanıyor/,
  );
  assert.match(tr, />⌃⌥K</);
});
