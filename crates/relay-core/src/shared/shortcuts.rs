//! Port of `shared/shortcuts.ts`: global shortcuts as Electron accelerators in Relay's spelling.

use super::model_prices::js_trim;
use super::types::{ShortcutAction, ShortcutSettings};

pub const SHORTCUT_ACTIONS: [ShortcutAction; 2] = [ShortcutAction::OpenPanel, ShortcutAction::SwitchToSuggested];

/// `DEFAULT_SHORTCUTS[action]`: opening Relay gets a four-key chord (Ctrl+Alt with a letter is
/// AltGr on Windows; with Space no layout types a character); switching is off until picked.
pub const fn default_shortcut(action: ShortcutAction) -> &'static str {
    match action {
        ShortcutAction::OpenPanel => "CommandOrControl+Alt+Shift+Space",
        ShortcutAction::SwitchToSuggested => "",
    }
}

/// The accelerator an action uses now; "" when it is off.
pub fn shortcut_for(choice: Option<&ShortcutSettings>, action: ShortcutAction) -> String {
    choice
        .and_then(|c| c.get(action))
        .cloned()
        .unwrap_or_else(|| default_shortcut(action).to_string())
}

/// Modifiers in the order Relay writes them, with the spellings Electron also accepts.
fn modifier(lower: &str) -> Option<&'static str> {
    Some(match lower {
        "commandorcontrol" | "cmdorctrl" => "CommandOrControl",
        "command" | "cmd" => "Command",
        "control" | "ctrl" => "Control",
        "alt" | "option" => "Alt",
        "shift" => "Shift",
        "super" | "meta" => "Super",
        _ => return None,
    })
}

const MODIFIER_ORDER: [&str; 6] = ["CommandOrControl", "Command", "Control", "Alt", "Shift", "Super"];

/// Named keys, as Electron spells them.
const NAMED_KEYS: [&str; 56] = [
    "Space", "Tab", "Backspace", "Delete", "Insert", "Return", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Escape",
    "Plus", "PrintScreen", "num0", "num1", "num2", "num3", "num4", "num5", "num6", "num7", "num8", "num9", "numdec", "numadd", "numsub",
    "nummult", "numdiv", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15", "F16", "F17", "F18",
    "F19", "F20", "F21", "F22", "F23", "F24",
];

fn named_key(lower: &str) -> Option<String> {
    match lower {
        "enter" => return Some("Return".into()),
        "esc" => return Some("Escape".into()),
        _ => {}
    }
    NAMED_KEYS.iter().find(|k| k.to_lowercase() == lower).map(|k| (*k).to_string())
}

const PUNCTUATION: &str = "`-=[]\\;',./";

/// One key: a letter, a digit, punctuation or a named key; `None` otherwise.
fn key_name(text: &str) -> Option<String> {
    let mut chars = text.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphanumeric() {
            return Some(c.to_ascii_uppercase().to_string());
        }
        if PUNCTUATION.contains(c) {
            return Some(text.to_string());
        }
    }
    named_key(&text.to_lowercase())
}

/// `/^F\d+$/`.
fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// `text.replace(/\+\+$/, "+Plus")`: "+" both joins and names a key.
fn plus_key(text: &str) -> String {
    match text.strip_suffix("++") {
        Some(head) => format!("{head}+Plus"),
        None => text.to_string(),
    }
}

/// `text` as one Electron accelerator in Relay's spelling (modifiers in a fixed order, then one
/// key), or `None` when it is not one Relay registers. A global shortcut needs ⌘, Ctrl, Alt or
/// Super unless its key is a function key: Shift alone would take a capital letter from typing.
pub fn normalize_accelerator(text: &str) -> Option<String> {
    let joined = plus_key(js_trim(text));
    let mut parts: Vec<&str> = joined.split('+').collect();
    if parts.iter().any(|part| js_trim(part).is_empty()) {
        return None;
    }
    let key = key_name(js_trim(parts.pop()?))?;
    let mut modifiers: Vec<&'static str> = Vec::new();
    for part in parts {
        let m = modifier(&js_trim(part).to_lowercase())?;
        if modifiers.contains(&m) {
            return None;
        }
        modifiers.push(m);
    }
    let strong = modifiers.iter().any(|m| *m != "Shift");
    if !strong && !is_function_key(&key) {
        return None;
    }
    let mut out: Vec<&str> = MODIFIER_ORDER.into_iter().filter(|m| modifiers.contains(m)).collect();
    out.push(&key);
    Some(out.join("+"))
}

/// The part of a keydown event a shortcut is recorded from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KeyPress {
    pub code: String,
    pub meta_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub shift_key: bool,
}

/// `KeyboardEvent.code` values that are not keyName spellings.
fn code_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "Enter" | "NumpadEnter" => "Return",
        "Backquote" => "`",
        "Minus" => "-",
        "Equal" => "=",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backslash" => "\\",
        "Semicolon" => ";",
        "Quote" => "'",
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "NumpadAdd" => "numadd",
        "NumpadSubtract" => "numsub",
        "NumpadMultiply" => "nummult",
        "NumpadDivide" => "numdiv",
        "NumpadDecimal" => "numdec",
        _ => return None,
    })
}

/// The accelerator a key press records, by the key's place (`code`). ⌘ on a Mac and Ctrl
/// elsewhere become CommandOrControl. `None` while only modifiers are down, or when the press is
/// no shortcut Relay registers.
pub fn accelerator_from_keys(press: &KeyPress, platform: &str) -> Option<String> {
    let code = press.code.as_str();
    let key = if let Some(k) = code_key(code) {
        k.to_string()
    } else if let Some(letter) = code.strip_prefix("Key").filter(|l| l.len() == 1 && l.as_bytes()[0].is_ascii_uppercase()) {
        letter.to_string()
    } else if let Some(d) = code
        .strip_prefix("Digit")
        .map(|d| ("", d))
        .or_else(|| code.strip_prefix("Numpad").map(|d| ("num", d)))
        .filter(|(_, d)| d.len() == 1 && d.as_bytes()[0].is_ascii_digit())
    {
        format!("{}{}", d.0, d.1)
    } else {
        key_name(code)?
    };
    let mac = platform == "darwin";
    let flags = [
        ((if mac { press.meta_key } else { press.ctrl_key }), "CommandOrControl"),
        (mac && press.ctrl_key, "Control"),
        (press.alt_key, "Alt"),
        (press.shift_key, "Shift"),
        (!mac && press.meta_key, "Super"),
    ];
    let mut parts: Vec<&str> = flags.into_iter().filter(|(on, _)| *on).map(|(_, m)| m).collect();
    parts.push(&key);
    normalize_accelerator(&parts.join("+"))
}

fn mac_symbol(name: &str) -> Option<&'static str> {
    Some(match name {
        "CommandOrControl" | "Command" | "Super" => "⌘",
        "Control" => "⌃",
        "Alt" => "⌥",
        "Shift" => "⇧",
        "Space" => "Space",
        "Return" => "↩",
        "Up" => "↑",
        "Down" => "↓",
        "Left" => "←",
        "Right" => "→",
        "Escape" => "⎋",
        "Backspace" => "⌫",
        "Delete" => "⌦",
        "Plus" => "+",
        _ => return None,
    })
}

/// An accelerator as a person reads it: ⌃⌥⇧⌘ symbols on a Mac (in Apple's order), "Ctrl+Alt+…"
/// elsewhere.
pub fn format_accelerator(accelerator: &str, platform: &str) -> String {
    let joined = plus_key(accelerator);
    let mut parts: Vec<&str> = joined.split('+').collect();
    let key = parts.pop().unwrap_or("");
    if platform == "darwin" {
        let order = ["Control", "Alt", "Shift", "CommandOrControl", "Command", "Super"];
        let mut out: String = order.into_iter().filter(|m| parts.contains(m)).filter_map(mac_symbol).collect();
        out.push_str(mac_symbol(key).unwrap_or(key));
        return out;
    }
    let name = |m: &str| -> Option<&'static str> {
        Some(match m {
            "CommandOrControl" | "Command" | "Control" => "Ctrl",
            "Alt" => "Alt",
            "Shift" => "Shift",
            "Super" if platform == "win32" => "Win",
            "Super" => "Super",
            "Plus" => "+",
            _ => return None,
        })
    };
    let mut out: Vec<&str> = Vec::new();
    for part in parts {
        let shown = name(part).unwrap_or(part);
        if !out.contains(&shown) {
            out.push(shown);
        }
    }
    out.push(name(key).unwrap_or(key));
    out.join("+")
}
