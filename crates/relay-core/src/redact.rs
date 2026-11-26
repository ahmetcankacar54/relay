//! Port of `electron/core/redact.ts`: error text that is safe to print or record.

/// What `redact` gives for something that is neither an error nor text.
pub const UNKNOWN_ERROR: &str = "Unknown error";
/// What `redact` gives for a JSON parse error, whose message may quote a secret.
pub const INVALID_JSON: &str = "A file holds invalid JSON data.";
/// The default length cap, in UTF-16 code units as JS counts them.
pub const MAX: usize = 300;

const REDACTED: &str = "[redacted]";

/// Error text that is safe to print or record: its first line, at most `max` characters, with
/// anything that looks like a credential replaced by "[redacted]". That covers Anthropic keys
/// and tokens, JWTs, and base64 or hex runs of 32 characters or more. Uuids and absolute paths
/// stay readable. A JSON parse error says only that, never the text it quotes.
pub fn redact(text: &str, max: usize) -> String {
    // V8 quotes the bytes a JSON parse choked on, and those may be a secret.
    if [
        "is not valid JSON",
        "Unexpected token",
        "Unexpected end of JSON",
        "Unexpected non-whitespace",
        "in JSON at position",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        return INVALID_JSON.to_owned();
    }
    let line = text.split('\n').next().unwrap_or("");
    let line = line.strip_suffix('\r').unwrap_or(line);
    let line = replace_api_keys(line);
    let line = replace_jwts(&line);
    let line = replace_long_runs(&line);
    let line = line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    truncate(line, max)
}

/// `redact` for an error: a `serde_json` error (the `SyntaxError` of this port) gives only
/// [`INVALID_JSON`], so its message, which can quote the data, never shows.
pub fn redact_error(error: &(dyn std::error::Error + 'static), max: usize) -> String {
    if error.downcast_ref::<serde_json::Error>().is_some() {
        return INVALID_JSON.to_owned();
    }
    redact(&error.to_string(), max)
}

/// JS `\w`, plus `-`.
fn word_or_dash(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `/sk-ant-[\w-]+/g`.
fn replace_api_keys(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("sk-ant-") {
        let after = &rest[at + 7..];
        let run = after
            .find(|c: char| !word_or_dash(c))
            .unwrap_or(after.len());
        if run == 0 {
            out.push_str(&rest[..at + 7]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..at]);
        out.push_str(REDACTED);
        rest = &after[run..];
    }
    out.push_str(rest);
    out
}

/// Maximal runs of `class` characters as byte ranges.
fn runs(text: &str, class: fn(char) -> bool) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut start = None;
    for (i, c) in text.char_indices() {
        match (class(c), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                found.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        found.push((s, text.len()));
    }
    found
}

/// `/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g`. The class excludes `.`, so a match is three
/// consecutive maximal runs joined by single dots, each at least 8 long.
fn replace_jwts(text: &str) -> String {
    let r = runs(text, word_or_dash);
    let joined = |a: (usize, usize), b: (usize, usize)| {
        text.as_bytes().get(a.1) == Some(&b'.') && b.0 == a.1 + 1
    };
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut k = 0;
    while k + 2 < r.len() {
        let (a, b, c) = (r[k], r[k + 1], r[k + 2]);
        if a.1 - a.0 >= 8 && b.1 - b.0 >= 8 && c.1 - c.0 >= 8 && joined(a, b) && joined(b, c) {
            out.push_str(&text[copied..a.0]);
            out.push_str(REDACTED);
            copied = c.1;
            k += 3;
        } else {
            k += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

fn uuid_shaped(run: &str) -> bool {
    let b = run.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `/[A-Za-z0-9+/_=-]{32,}/g`, keeping uuids and runs that start with `/` (paths).
fn replace_long_runs(text: &str) -> String {
    let class = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '_' | '=' | '-');
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (start, end) in runs(text, class) {
        let run = &text[start..end];
        if end - start < 32 || uuid_shaped(run) || run.starts_with('/') {
            continue;
        }
        out.push_str(&text[copied..start]);
        out.push_str(REDACTED);
        copied = end;
    }
    out.push_str(&text[copied..]);
    out
}

/// `line.length > max ? line.slice(0, max - 1) + "…" : line`, lengths in UTF-16 units.
fn truncate(line: &str, max: usize) -> String {
    if line.encode_utf16().count() <= max {
        return line.to_owned();
    }
    let mut units = 0;
    let mut out = String::new();
    for c in line.chars() {
        units += c.len_utf16();
        if units > max.saturating_sub(1) {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}
