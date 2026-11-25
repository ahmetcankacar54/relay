//! omp's models.yml, edited as text (`omp-models.ts`): Relay owns the lines between its
//! markers, plus any line it parked with its prefix. Binding only inserts lines and prefixes,
//! and unbinding takes exactly those away, so the file comes back byte for byte. A layout
//! Relay cannot edit that safely is refused (`OmpBlock`) instead of guessed at.
//!
//! The binding itself (reading and writing the file) stays with the host's client binding.

use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const OMP_START: &str =
    "# >>> relay gateway (written by Relay; remove it from Relay's Proxy page)";
pub const OMP_END: &str = "# <<< relay gateway";
pub const OMP_PARKED: &str = "# relay-disabled: ";
/// Looks like a Claude sign-in to omp; the gateway never forwards it.
pub const OMP_CLAUDE_PLACEHOLDER: &str = "sk-ant-oat01-relay-gateway";
const PROVIDERS: [&str; 2] = ["anthropic", "openai-codex"];

/// The placeholder key each entry carries.
fn placeholder(provider: &str) -> &'static str {
    if provider == "anthropic" {
        OMP_CLAUDE_PLACEHOLDER
    } else {
        "relay-gateway"
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OmpTarget {
    pub url: String,
    pub key: String,
}

/// Why Relay will not write the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OmpBlock {
    InlineProviders,
    UnsupportedLayout,
    LegacyJson,
}

impl OmpBlock {
    pub fn as_str(self) -> &'static str {
        match self {
            OmpBlock::InlineProviders => "inline-providers",
            OmpBlock::UnsupportedLayout => "unsupported-layout",
            OmpBlock::LegacyJson => "legacy-json",
        }
    }
}

pub fn omp_agent_dir(home: &Path) -> PathBuf {
    home.join(".omp").join("agent")
}

/// The models file omp reads: models.yml, or models.yaml when only that one is there.
pub fn omp_models_file(home: &Path) -> PathBuf {
    let dir = omp_agent_dir(home);
    let yml = dir.join("models.yml");
    let yaml = dir.join("models.yaml");
    if !yml.exists() && yaml.exists() {
        yaml
    } else {
        yml
    }
}

/// omp moves a lone models.json to models.yml when it starts: a file Relay wrote first would
/// hide the user's providers for good.
pub fn omp_legacy_json(home: &Path) -> bool {
    let dir = omp_agent_dir(home);
    dir.join("models.json").exists()
        && !dir.join("models.yml").exists()
        && !dir.join("models.yaml").exists()
}

static PROVIDERS_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\x{FEFF}?(?:"providers"|'providers'|providers):"#).unwrap());
static TRAILING_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+#.*$").unwrap());
static ENTRY_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))\s*:"#).unwrap());
static DOC_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\.\.\.(\s|$)").unwrap());
static DOC_START_BOM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\x{FEFF}?---(\s|$)").unwrap());
static DOC_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---(\s|$)").unwrap());
static EXPLICIT_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\?(\s|$)").unwrap());
static LIST_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*-(\s|$)").unwrap());
static QUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""(?:[^"\\]|\\.)*"|'(?:[^']|'')*'"#).unwrap());
static KEY_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^:]*:").unwrap());
static CLOSER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[}\]]").unwrap());
static BARE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([\w-]+):\s*$").unwrap());

// Lines are split on "\n" only: a "\r" stays on its line, so CRLF files are written back as read.
fn split_lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_string).collect()
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

fn is_comment(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// Lines outside Relay's block (parked lines included, still parked).
fn outside(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in lines {
        let bare = line.trim();
        if bare == OMP_START {
            inside = true;
        } else if bare == OMP_END {
            inside = false;
        } else if !inside {
            out.push(line.clone());
        }
    }
    out
}

fn value_of(line: &str) -> String {
    let rest = PROVIDERS_KEY.replace(line, "");
    TRAILING_COMMENT.replace(&rest, "").trim().to_string()
}

fn providers_at(lines: &[String]) -> Option<usize> {
    lines
        .iter()
        .position(|line| PROVIDERS_KEY.is_match(line) && value_of(line).is_empty())
}

fn empty_inline(line: &str) -> bool {
    if !PROVIDERS_KEY.is_match(line) {
        return false;
    }
    let value = value_of(line);
    value.starts_with('{') && value.ends_with('}') && value[1..value.len() - 1].trim().is_empty()
}

/// The indent of the entries under `providers:` (two spaces when there are none).
fn entry_indent(lines: &[String], at: usize) -> usize {
    for line in &lines[at + 1..] {
        if is_blank(line) || is_comment(line) {
            continue;
        }
        let indent = indent_of(line);
        return if indent == 0 { 2 } else { indent };
    }
    2
}

/// One of Relay's provider names, when the line is an entry of `providers` at this indent.
fn relay_entry(line: &str, indent: usize) -> bool {
    if is_blank(line) || is_comment(line) || indent_of(line) != indent {
        return false;
    }
    ENTRY_NAME
        .captures(line)
        .and_then(|c| c.get(1).or(c.get(2)).or(c.get(3)))
        .is_some_and(|name| PROVIDERS.contains(&name.as_str()))
}

/// [start, end) of each of the user's own entries named like Relay's under `providers:`.
fn own_entries(lines: &[String], at: usize) -> Vec<(usize, usize)> {
    let indent = entry_indent(lines, at);
    let mut ranges = Vec::new();
    let mut i = at + 1;
    while i < lines.len() {
        let line = &lines[i];
        if !is_blank(line) && !is_comment(line) && indent_of(line) == 0 {
            break; // The next top-level key.
        }
        if !relay_entry(line, indent) {
            i += 1;
            continue;
        }
        // The entry holds the lines deeper than it, blank lines between them included.
        let mut end = i + 1;
        for (j, next) in lines.iter().enumerate().skip(i + 1) {
            if is_blank(next) {
                continue;
            }
            if indent_of(next) <= indent {
                break;
            }
            end = j + 1;
        }
        ranges.push((i, end));
        i = end;
    }
    ranges
}

/// Why Relay will not write this text, if it will not.
pub fn omp_blocked(text: &str) -> Option<OmpBlock> {
    let lines = outside(&split_lines(text));
    let keys: Vec<&String> = lines.iter().filter(|l| PROVIDERS_KEY.is_match(l)).collect();
    if keys
        .iter()
        .any(|line| !value_of(line).is_empty() && !empty_inline(line))
    {
        return Some(OmpBlock::InlineProviders);
    }
    if keys.len() > 1 {
        return Some(OmpBlock::UnsupportedLayout);
    }
    // More than one document: Relay's block could land in the wrong one.
    if lines.iter().any(|l| DOC_END.is_match(l)) {
        return Some(OmpBlock::UnsupportedLayout);
    }
    // A `---` after content starts a second document.
    let content = lines
        .iter()
        .position(|l| !is_blank(l) && !is_comment(l) && !DOC_START_BOM.is_match(l));
    if let Some(content) = content {
        if lines
            .iter()
            .enumerate()
            .any(|(i, l)| i > content && DOC_START.is_match(l))
        {
            return Some(OmpBlock::UnsupportedLayout);
        }
    }
    // Explicit `? key` entries hide which keys there are.
    if lines.iter().any(|l| EXPLICIT_KEY.is_match(l)) {
        return Some(OmpBlock::UnsupportedLayout);
    }
    let at = providers_at(&lines)?;
    let first = lines[at + 1..]
        .iter()
        .find(|l| !is_blank(l) && !is_comment(l));
    if first.is_some_and(|l| LIST_ITEM.is_match(l)) {
        return Some(OmpBlock::UnsupportedLayout); // `providers` is a list.
    }
    for (start, end) in own_entries(&lines, at) {
        // A flow map or list not closed on its own line runs past what Relay would park.
        let value = KEY_PREFIX.replace(&lines[start], "");
        let value = QUOTED.replace_all(&value, "''");
        let value = TRAILING_COMMENT.replace(&value, "");
        let value = value.trim();
        let open = value.chars().filter(|c| *c == '{' || *c == '[').count();
        let close = value.chars().filter(|c| *c == '}' || *c == ']').count();
        if open != close {
            return Some(OmpBlock::UnsupportedLayout);
        }
        // An anchor on an entry Relay would park leaves its aliases pointing at nothing.
        if value.starts_with('&') {
            return Some(OmpBlock::UnsupportedLayout);
        }
        if end < lines.len() && CLOSER.is_match(&lines[end]) {
            return Some(OmpBlock::UnsupportedLayout);
        }
    }
    None
}

/// The text with Relay's block removed and parked lines put back.
pub fn omp_unbound(text: &str) -> String {
    outside(&split_lines(text))
        .into_iter()
        .map(|line| match line.find(OMP_PARKED) {
            Some(at) if line[..at].trim().is_empty() => {
                format!("{}{}", &line[..at], &line[at + OMP_PARKED.len()..])
            }
            _ => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether the text holds Relay's block.
pub fn omp_marked(text: &str) -> bool {
    text.split('\n').any(|line| line.trim() == OMP_START)
}

/// Whether the text holds nothing but Relay's block: then Relay wrote all of it.
pub fn omp_relay_only(text: &str) -> bool {
    omp_marked(text) && omp_unbound(text).trim().is_empty()
}

fn json_string(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

/// The text with Relay's providers pointing at the gateway; the user's own of those names
/// parked.
pub fn omp_bound(text: &str, target: &OmpTarget) -> String {
    let mut lines = outside(&split_lines(text));
    let cr = if text.contains("\r\n") { "\r" } else { "" };
    // An empty inline map (`providers: {}`) is parked; Relay's block brings its own.
    if let Some(inline) = lines.iter().position(|l| empty_inline(l)) {
        lines[inline] = format!("{OMP_PARKED}{}", lines[inline]);
    }
    let at = providers_at(&lines);
    let indent = at.map_or(2, |at| entry_indent(&lines, at));
    if let Some(at) = at {
        for (start, end) in own_entries(&lines, at) {
            for line in &mut lines[start..end] {
                if !is_blank(line) {
                    *line = format!("{}{OMP_PARKED}{}", " ".repeat(indent), &line[indent..]);
                }
            }
        }
    }
    let pad = " ".repeat(indent);
    let mut block = vec![OMP_START.to_string()];
    if at.is_none() {
        block.push("providers:".into());
    }
    for name in PROVIDERS {
        block.push(format!("{pad}{name}:"));
        block.push(format!("{pad}{pad}baseUrl: {}", json_string(&target.url)));
        block.push(format!("{pad}{pad}apiKey: {}", json_string(placeholder(name))));
        block.push(format!("{pad}{pad}headers:"));
        block.push(format!("{pad}{pad}{pad}x-relay-key: {}", json_string(&target.key)));
    }
    block.push(OMP_END.into());
    let added: Vec<String> = block.into_iter().map(|line| line + cr).collect();
    match at {
        Some(at) => {
            lines.splice(at + 1..at + 1, added);
        }
        // At the end: before the last newline when the text ends with one, so it still does.
        None if lines.last().is_some_and(String::is_empty) => {
            let last = lines.len() - 1;
            lines.splice(last..last, added);
        }
        None => lines.extend(added),
    }
    lines.join("\n")
}

/// Whether Relay's block sends both providers to this gateway with this key.
pub fn omp_bound_to(text: &str, target: &OmpTarget) -> bool {
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(start) = lines.iter().position(|l| l.trim() == OMP_START) else {
        return false;
    };
    let Some(end) = lines
        .iter()
        .enumerate()
        .position(|(i, l)| i > start && l.trim() == OMP_END)
    else {
        return false;
    };
    let block = &lines[start + 1..end];
    let values = |name: &str| -> Vec<String> {
        let pattern = Regex::new(&format!(r#"^\s*{name}:\s*("(?:[^"\\]|\\.)*")\s*$"#)).unwrap();
        block
            .iter()
            .filter_map(|line| pattern.captures(line))
            .filter_map(|c| serde_json::from_str::<String>(c.get(1)?.as_str()).ok())
            .collect()
    };
    let names: Vec<&str> = block
        .iter()
        .filter_map(|line| BARE_NAME.captures(line))
        .filter_map(|c| c.get(1).map(|m| m.as_str()))
        .collect();
    let urls = values("baseUrl");
    let keys = values("x-relay-key");
    PROVIDERS.iter().all(|name| names.contains(name))
        && urls.len() == PROVIDERS.len()
        && urls.iter().all(|url| *url == target.url)
        && keys.len() == PROVIDERS.len()
        && keys.iter().all(|key| *key == target.key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> OmpTarget {
        OmpTarget {
            url: "http://127.0.0.1:8317".into(),
            key: "relay-sec-k".into(),
        }
    }

    #[test]
    fn binding_round_trips_byte_for_byte() {
        for text in [
            "",
            "providers:\n  anthropic:\n    baseUrl: https://x\n    apiKey: k\n",
            "theme: dark\r\nproviders:\r\n  ollama:\r\n    baseUrl: http://l\r\n",
            "other: 1",
        ] {
            assert_eq!(omp_blocked(text), None, "{text:?}");
            let bound = omp_bound(text, &target());
            assert!(omp_bound_to(&bound, &target()), "{bound}");
            assert_eq!(omp_unbound(&bound), text);
        }
        assert!(omp_relay_only(&omp_bound("", &target())));
        assert_eq!(
            omp_blocked("providers: {anthropic: {}}"),
            Some(OmpBlock::InlineProviders)
        );
        assert_eq!(
            omp_blocked("providers:\n  - a\n"),
            Some(OmpBlock::UnsupportedLayout)
        );
    }
}
