//! Port of `electron/core/diagnostics-bundle.ts`.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

use chrono::{Datelike, Local, TimeZone, Timelike};
use flate2::Compression;
use flate2::write::DeflateEncoder;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::redact::redact;
use crate::shared::types::{Account, RelaySettings};
use crate::store::schema::js_trim;

/// One file of a zip: a name inside the archive and its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    pub data: Vec<u8>,
}

/// DOS date and time, the only clock a zip header holds, in local time; years before 1980
/// cannot be written.
fn dos_time(at_ms: i64) -> (u16, u16) {
    let at = Local
        .timestamp_millis_opt(at_ms)
        .single()
        .unwrap_or_else(|| Local.timestamp_millis_opt(0).single().unwrap_or_default());
    let year = at.year().max(1980) as u32;
    let time = (at.hour() << 11) | (at.minute() << 5) | (at.second() / 2);
    let date = ((year - 1980) << 9) | (at.month() << 5) | at.day();
    (time as u16, date as u16)
}

fn deflate_raw(data: &[u8]) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    // Writing into a Vec cannot fail.
    let _ = encoder.write_all(data);
    encoder.finish().unwrap_or_default()
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(data);
    crc.sum()
}

/// A zip archive of `entries`, each deflated, with UTF-8 names, dated `at_ms` (epoch ms, local
/// time). Small and complete enough for a few log files: no zip64, so the archive stays under
/// 4 GB and 65,535 entries.
pub fn zip_archive(entries: &[ZipEntry], at_ms: i64) -> Vec<u8> {
    let (time, date) = dos_time(at_ms);
    let mut locals = Vec::new();
    let mut centrals = Vec::new();
    let mut offset: u32 = 0;
    for entry in entries {
        let name = entry.name.as_bytes();
        let packed = deflate_raw(&entry.data);
        let crc = crc32(&entry.data);
        let name_length = name.len() as u16;
        let packed_length = packed.len() as u32;
        let size = entry.data.len() as u32;
        let local_start = locals.len();
        locals.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        locals.extend_from_slice(&20u16.to_le_bytes()); // version needed: 2.0, deflate
        locals.extend_from_slice(&0x0800u16.to_le_bytes()); // the name is UTF-8
        locals.extend_from_slice(&8u16.to_le_bytes()); // deflate
        locals.extend_from_slice(&time.to_le_bytes());
        locals.extend_from_slice(&date.to_le_bytes());
        locals.extend_from_slice(&crc.to_le_bytes());
        locals.extend_from_slice(&packed_length.to_le_bytes());
        locals.extend_from_slice(&size.to_le_bytes());
        locals.extend_from_slice(&name_length.to_le_bytes());
        locals.extend_from_slice(&0u16.to_le_bytes());
        debug_assert_eq!(locals.len() - local_start, 30);
        centrals.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        centrals.extend_from_slice(&20u16.to_le_bytes()); // made by: 2.0
        centrals.extend_from_slice(&20u16.to_le_bytes());
        centrals.extend_from_slice(&0x0800u16.to_le_bytes());
        centrals.extend_from_slice(&8u16.to_le_bytes());
        centrals.extend_from_slice(&time.to_le_bytes());
        centrals.extend_from_slice(&date.to_le_bytes());
        centrals.extend_from_slice(&crc.to_le_bytes());
        centrals.extend_from_slice(&packed_length.to_le_bytes());
        centrals.extend_from_slice(&size.to_le_bytes());
        centrals.extend_from_slice(&name_length.to_le_bytes());
        // Extra, comment, disk, internal and external attributes stay 0.
        centrals.extend_from_slice(&[0; 12]);
        centrals.extend_from_slice(&offset.to_le_bytes());
        centrals.extend_from_slice(name);
        locals.extend_from_slice(name);
        locals.extend_from_slice(&packed);
        offset = offset.wrapping_add(30 + u32::from(name_length) + packed_length);
    }
    let count = entries.len() as u16;
    let mut out = locals;
    let directory_length = centrals.len() as u32;
    out.extend_from_slice(&centrals);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&directory_length.to_le_bytes());
    out.extend_from_slice(&offset.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    out
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+").expect("email regex")
});
/// JSON fields whose value is a secret, whatever it looks like. `.` is JavaScript's: no line
/// terminator.
static SECRET_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)("(?:access_?token|refresh_?token|id_?token|session_?key|api_?key|token|secret|password|cookie|authorization)"\s*:\s*)"(?:[^"\\]|\\[^\n\r\u{2028}\u{2029}])*""#,
    )
    .expect("secret field regex")
});
/// `\b` without the `u` flag is ASCII's.
static SECRET_PARAM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?-u:\b)((?:access|refresh|id)_token|code|api_key)=[^&\s"']+"#)
        .expect("secret param regex")
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?-u:\b)(Bearer|Basic)\s+[^\s"',;]+"#).expect("bearer regex")
});
static WORD_CHAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}]$").expect("word char regex"));

fn is_word_char(c: Option<char>) -> bool {
    c.is_some_and(|c| WORD_CHAR.is_match(c.encode_utf8(&mut [0; 4])))
}

/// `text.replace(/(?<![\p{L}\p{N}])word(?![\p{L}\p{N}])/giu, "[account]")`: the regex crate has
/// no look-around, so a match that touches a letter or digit is retried one character later.
fn mask_word(text: &str, word: &str) -> String {
    let Ok(pattern) = Regex::new(&format!("(?i){}", regex::escape(word))) else {
        return text.to_owned();
    };
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while from <= text.len() {
        let Some(found) = pattern.find_at(text, from) else {
            break;
        };
        let before = text[..found.start()].chars().next_back();
        let after = text[found.end()..].chars().next();
        if !is_word_char(before) && !is_word_char(after) && !found.is_empty() {
            out.push_str(&text[copied..found.start()]);
            out.push_str("[account]");
            copied = found.end();
            from = found.end();
        } else {
            from = found.start()
                + text[found.start()..]
                    .chars()
                    .next()
                    .map_or(1, char::len_utf8);
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// `/^([ \t]*)([^\r\n]+)$/` on one piece of text between line breaks: the indent kept outside
/// `redact`, which trims.
fn redact_line(part: &str) -> String {
    if part.is_empty() || part.contains(['\r', '\n']) {
        return part.to_owned();
    }
    let mut indent = part.len() - part.trim_start_matches([' ', '\t']).len();
    if indent == part.len() {
        // `[^\r\n]+` needs a character: the indent gives back its last one.
        indent -= 1;
    }
    let (indent, rest) = part.split_at(indent);
    format!("{indent}{}", redact(rest, usize::MAX))
}

/// Text that is safe to attach to a public bug report. Email addresses, the given account
/// names (as whole words, any case) and the home folder are masked; secret JSON fields, query
/// parameters and Authorization values are cut; then each line goes through `redact`, which
/// removes Anthropic keys, JWTs and long base64 or hex runs.
pub fn redact_diagnostics<S: AsRef<str>>(text: &str, names: &[S], home: Option<&str>) -> String {
    let mut out = EMAIL.replace_all(text, "[email]").into_owned();
    if let Some(home) = home.filter(|home| home.encode_utf16().count() > 1) {
        out = out.replace(home, "~");
    }
    // Longest first, so "Alto Work" is masked whole before "Alto".
    let mut words: Vec<&str> = Vec::new();
    for name in names {
        let word = js_trim(name.as_ref());
        if !word.is_empty() && !words.contains(&word) {
            words.push(word);
        }
    }
    words.sort_by_key(|word| std::cmp::Reverse(word.encode_utf16().count()));
    for word in words {
        out = mask_word(&out, word);
    }
    let out = SECRET_FIELD.replace_all(&out, "${1}\"[redacted]\"");
    let out = SECRET_PARAM.replace_all(&out, "${1}=[redacted]");
    let out = BEARER.replace_all(&out, "${1} [redacted]");
    // `redact` trims each line; the indent stays outside it, so summary.json still reads as JSON.
    let mut result = String::with_capacity(out.len());
    let mut rest: &str = &out;
    while let Some(at) = rest.find('\n') {
        let (line, separator) = match rest[..at].strip_suffix('\r') {
            Some(line) => (line, &rest[at - 1..=at]),
            None => (&rest[..at], &rest[at..=at]),
        };
        result.push_str(&redact_line(line));
        result.push_str(separator);
        rest = &rest[at + 1..];
    }
    result.push_str(&redact_line(rest));
    result
}

fn value_of<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The settings a bug report needs, without names, emails, keys or ids: choices and counts. The
/// planning zone stays, since limits reset by it.
pub fn settings_summary(settings: &RelaySettings, accounts: &[Account]) -> Value {
    let mut providers = Map::new();
    for account in accounts {
        let provider = account.provider.map_or("claude", |p| p.as_str());
        let count = providers.get(provider).and_then(Value::as_u64).unwrap_or(0);
        providers.insert(provider.to_owned(), json!(count + 1));
    }
    let planning = &settings.planning;
    json!({
        "accounts": accounts.len(),
        "providers": providers,
        "desktopConnected": accounts.iter().filter(|a| a.desktop.is_some()).count(),
        "appearance": value_of(&settings.appearance),
        "usageRefreshMinutes": settings.usage_refresh_minutes,
        "usageWarnings": settings.usage_warnings,
        "usageWarningPercent": settings.usage_warning_percent,
        "suggestAccounts": settings.suggest_accounts,
        "desktopHistoryTransfer": value_of(&settings.desktop_history_transfer),
        "autoSwitchMode": value_of(&settings.auto_switch_mode),
        "autoSwitchAccounts": settings.auto_switch_accounts.len(),
        "draftRetype": settings.draft_retype == Some(true),
        "claudeExtension": settings.claude_extension.as_ref().map_or(json!("restart"), |e| value_of(&e.mode)),
        "terminalCli": settings.terminal_cli.as_ref().map_or(json!("follow"), value_of),
        "switchWindow": settings.switch_window != Some(false),
        "launchAtLogin": settings.launch_at_login == Some(true),
        "gateway": settings.proxy.as_ref().is_some_and(|p| p.enabled),
        "planning": {
            "autoStart": planning.auto_start,
            "timeZone": planning.time_zone,
            "tempo": planning.tempo.map_or("auto", |t| t.as_str()),
            "adaptive": planning.adaptive != Some(false),
            "accounts": planning.accounts.len(),
        },
    })
}

/// How many crash dump names the summary lists, newest first.
pub const CRASH_DUMP_NAMES: usize = 5;

fn walk_dumps(dir: &Path, prefix: &str, depth: u32, found: &mut Vec<(String, f64)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = format!("{prefix}{name}");
        let file = entry.path();
        if kind.is_dir() && depth > 0 {
            walk_dumps(&file, &format!("{relative}/"), depth - 1, found);
        } else if kind.is_file()
            && name.ends_with(".dmp")
            && let Ok(meta) = fs::metadata(&file)
            && let Ok(at) = crate::fs_util::mtime_ms(&meta)
        {
            found.push((relative, at));
        }
    }
}

/// The newest minidump names under the crash dump folder (Crashpad keeps them one or two levels
/// down: `completed/` on macOS and Linux, `reports/` on Windows), relative and `/`-separated.
/// Names only; a dump holds memory and never goes into the bundle.
pub fn newest_crash_dumps(folder: &Path, count: usize) -> Vec<String> {
    let mut found = Vec::new();
    walk_dumps(folder, "", 2, &mut found);
    found.sort_by(|a, b| b.1.total_cmp(&a.1));
    found
        .into_iter()
        .take(count)
        .map(|(name, _)| name)
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiagnosticsBundleInput<'a> {
    /// Files to copy in by their base name; one that is missing is left out.
    pub files: &'a [&'a Path],
    /// What goes into summary.json, before redaction.
    pub summary: &'a Value,
    /// Every saved account's name, masked wherever it appears.
    pub names: &'a [String],
    /// The user's home folder, shown as `~`.
    pub home: Option<&'a str>,
    /// When the archive is dated, epoch ms; None means now.
    pub at_ms: Option<i64>,
}

/// The diagnostics zip for a bug report: a redacted copy of each log that exists and a
/// `summary.json`, all through `redact_diagnostics`.
pub fn build_diagnostics_bundle(input: &DiagnosticsBundleInput<'_>) -> Vec<u8> {
    let clean = |text: &str| redact_diagnostics(text, input.names, input.home).into_bytes();
    let mut entries = Vec::new();
    for file in input.files {
        if let Ok(bytes) = fs::read(file) {
            entries.push(ZipEntry {
                name: file
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                data: clean(&String::from_utf8_lossy(&bytes)),
            });
        }
    }
    let summary = serde_json::to_string_pretty(input.summary).unwrap_or_default();
    entries.push(ZipEntry {
        name: "summary.json".into(),
        data: clean(&format!("{summary}\n")),
    });
    zip_archive(&entries, input.at_ms.unwrap_or_else(crate::clock::now_ms))
}
