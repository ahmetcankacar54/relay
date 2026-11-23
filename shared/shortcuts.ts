import type { ShortcutAction, ShortcutSettings } from "./types";

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "openPanel",
  "switchToSuggested",
];

/**
 * What a missing setting means. Opening Relay gets a four-key chord: Ctrl+Alt with a letter is
 * AltGr on Windows (typing "Ł" on a Polish keyboard), and Ctrl+Alt+Shift+R records the screen on
 * GNOME; with Space no layout types a character. Switching is off until the user picks a key.
 */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  openPanel: "CommandOrControl+Alt+Shift+Space",
  switchToSuggested: "",
};

/** The accelerator an action uses now; "" when it is off. */
export function shortcutFor(
  choice: ShortcutSettings | undefined,
  action: ShortcutAction,
) {
  return choice?.[action] ?? DEFAULT_SHORTCUTS[action];
}

/** Modifiers in the order Relay writes them, with the spellings Electron also accepts. */
const MODIFIERS: Record<string, string> = {
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  command: "Command",
  cmd: "Command",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  meta: "Super",
};
const MODIFIER_ORDER = [
  "CommandOrControl",
  "Command",
  "Control",
  "Alt",
  "Shift",
  "Super",
];

/** Named keys, by their lower-case spelling, as Electron spells them. */
const NAMED_KEYS: Record<string, string> = Object.fromEntries(
  [
    "Space",
    "Tab",
    "Backspace",
    "Delete",
    "Insert",
    "Return",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Escape",
    "Plus",
    "PrintScreen",
    "num0",
    "num1",
    "num2",
    "num3",
    "num4",
    "num5",
    "num6",
    "num7",
    "num8",
    "num9",
    "numdec",
    "numadd",
    "numsub",
    "nummult",
    "numdiv",
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ].map((key) => [key.toLowerCase(), key]),
);
Object.assign(NAMED_KEYS, { enter: "Return", esc: "Escape" });
const PUNCTUATION = "`-=[]\\;',./";

/** One key: a letter, a digit, punctuation or a named key; undefined otherwise. */
function keyName(text: string) {
  if (/^[a-z0-9]$/i.test(text)) return text.toUpperCase();
  if (text.length === 1 && PUNCTUATION.includes(text)) return text;
  return NAMED_KEYS[text.toLowerCase()];
}

/**
 * `text` as one Electron accelerator in Relay's spelling (modifiers in a fixed order, then one
 * key), or undefined when it is not one Relay registers. A global shortcut takes the keys from
 * every app, so it needs ⌘, Ctrl, Alt or Super unless its key is a function key: Shift alone
 * would take a capital letter from typing.
 */
export function normalizeAccelerator(text: string): string | undefined {
  // "+" both joins and names a key: "Ctrl++" is Ctrl and Plus.
  const parts = text.trim().replace(/\+\+$/, "+Plus").split("+");
  if (parts.some((part) => !part.trim())) return undefined;
  const key = keyName(parts.pop()!.trim());
  if (!key) return undefined;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS[part.trim().toLowerCase()];
    if (!modifier || modifiers.has(modifier)) return undefined;
    modifiers.add(modifier);
  }
  const strong = [...modifiers].some((m) => m !== "Shift");
  if (!strong && !/^F\d+$/.test(key)) return undefined;
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join("+");
}

/** The part of a keydown event a shortcut is recorded from. */
export interface KeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `KeyboardEvent.code` values that are not keyName spellings. */
const CODES: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  NumpadEnter: "Return",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
};

/**
 * The accelerator a key press records, by the key's place (`code`) so Option on a Mac or AltGr
 * does not turn R into "®". ⌘ on a Mac and Ctrl elsewhere become CommandOrControl, so the choice
 * reads the same on every computer. Undefined while only modifiers are down, or when the press
 * is no shortcut Relay registers (normalizeAccelerator).
 */
export function acceleratorFromKeys(
  press: KeyPress,
  platform: string,
): string | undefined {
  const code = press.code;
  const key =
    CODES[code] ??
    (/^Key[A-Z]$/.test(code)
      ? code.slice(3)
      : /^(?:Digit|Numpad)\d$/.test(code)
        ? (code.startsWith("Numpad") ? "num" : "") + code.slice(-1)
        : keyName(code));
  if (!key) return undefined;
  const mac = platform === "darwin";
  const modifiers = [
    (mac ? press.metaKey : press.ctrlKey) && "CommandOrControl",
    mac && press.ctrlKey && "Control",
    press.altKey && "Alt",
    press.shiftKey && "Shift",
    !mac && press.metaKey && "Super",
  ].filter(Boolean);
  return normalizeAccelerator([...modifiers, key].join("+"));
}

const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: "⌘",
  Command: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Super: "⌘",
  Space: "Space",
  Return: "↩",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  Plus: "+",
};

/**
 * An accelerator as a person reads it: ⌃⌥⇧⌘ symbols on a Mac (in Apple's order), "Ctrl+Alt+…"
 * elsewhere.
 */
export function formatAccelerator(accelerator: string, platform: string) {
  const parts = accelerator.replace(/\+\+$/, "+Plus").split("+");
  const key = parts.pop() ?? "";
  if (platform === "darwin") {
    const order = [
      "Control",
      "Alt",
      "Shift",
      "CommandOrControl",
      "Command",
      "Super",
    ];
    const mods = order
      .filter((m) => parts.includes(m))
      .map((m) => MAC_SYMBOLS[m]);
    return [...mods, MAC_SYMBOLS[key] ?? key].join("");
  }
  const names: Record<string, string> = {
    CommandOrControl: "Ctrl",
    Command: "Ctrl",
    Control: "Ctrl",
    Alt: "Alt",
    Shift: "Shift",
    Super: platform === "win32" ? "Win" : "Super",
    Plus: "+",
  };
  return [...new Set(parts.map((m) => names[m] ?? m)), names[key] ?? key].join(
    "+",
  );
}
