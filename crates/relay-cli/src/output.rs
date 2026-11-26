//! Port of `cli/src/output.ts`: colors, tables and JSON output.

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::args::Flags;
use crate::io::CliIo;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Bold,
    Dim,
    Green,
    Yellow,
    Red,
    Cyan,
}

const fn codes(style: Style) -> (u8, u8) {
    match style {
        Style::Bold => (1, 22),
        Style::Dim => (2, 22),
        Style::Green => (32, 39),
        Style::Yellow => (33, 39),
        Style::Red => (31, 39),
        Style::Cyan => (36, 39),
    }
}

/// Colors only on a terminal, without NO_COLOR and without --no-color.
pub fn color_enabled(io: &CliIo, flags: &Flags) -> bool {
    io.is_tty && !io.var_set("NO_COLOR") && !flags.truthy("no-color")
}

pub fn paint(enabled: bool, style: Style, text: &str) -> String {
    if !enabled {
        return text.to_owned();
    }
    let (on, off) = codes(style);
    format!("\x1b[{on}m{text}\x1b[{off}m")
}

/// `text.replace(/\x1b\[\d+m/g, "")`.
fn strip_codes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("\x1b[") {
        let after = &rest[at + 2..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && after.as_bytes().get(digits) == Some(&b'm') {
            out.push_str(&rest[..at]);
            rest = &after[digits + 1..];
        } else {
            out.push_str(&rest[..at + 2]);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// Visible width, ignoring color codes: the NFC form's length in UTF-16 units, as JS counts.
pub fn width(text: &str) -> usize {
    strip_codes(text).nfc().map(char::len_utf16).sum()
}

/// `text.length` in JS.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.padEnd(n)`.
pub fn pad_end(text: &str, n: usize) -> String {
    let len = js_len(text);
    let mut out = text.to_owned();
    for _ in len..n {
        out.push(' ');
    }
    out
}

/// Columns padded to their widest cell, two spaces apart, headers first.
pub fn table(headers: &[String], rows: &[Vec<String>]) -> String {
    let all: Vec<&[String]> = std::iter::once(headers)
        .chain(rows.iter().map(Vec::as_slice))
        .collect();
    let widths: Vec<usize> = (0..headers.len())
        .map(|column| {
            all.iter()
                .map(|row| row.get(column).map_or(0, |c| width(c)))
                .max()
                .unwrap_or(0)
        })
        .collect();
    all.iter()
        .map(|row| {
            let cells: Vec<String> = row
                .iter()
                .enumerate()
                .map(|(column, cell)| {
                    if column == row.len() - 1 {
                        cell.clone()
                    } else {
                        let pad = widths
                            .get(column)
                            .copied()
                            .unwrap_or(0)
                            .saturating_sub(width(cell));
                        format!("{cell}{}", " ".repeat(pad))
                    }
                })
                .collect();
            js_trim_end(&cells.join("  ")).to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(|c: char| c != '\u{85}' && (c.is_whitespace() || c == '\u{feff}'))
}

pub fn print_json(io: &CliIo, value: &Value) {
    io.out(&crate::json::stringify_pretty(value));
}
