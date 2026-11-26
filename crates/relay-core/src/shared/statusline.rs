//! Port of `shared/statusline.ts`: Claude Code's status line, as `relay statusline` prints it.
//!
//! Relay.app writes a small snapshot, `<userData>/statusline.json`, every time what it shows may
//! have changed; the command reads that file and the JSON Claude Code passes on stdin, and
//! nothing else. Claude Code runs the command after every answer, so this module loads no catalog:
//! the app writes every label already translated. The two `Intl` formats the line needs (a
//! percent and a short relative age) are tabled below from Node's ICU for Relay's locales.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::terminal_identity::TerminalIdentity;
use super::types::js::{self, JsMap};

/// The snapshot's file name in Relay's data folder.
pub const STATUSLINE_FILE: &str = "statusline.json";
/// The layout this reader understands.
pub const STATUSLINE_SNAPSHOT_VERSION: f64 = 1.0;
/// Past this age the line says when Relay last wrote it: the app may be closed.
pub const STATUSLINE_STALE_MS: f64 = 15.0 * 60_000.0;
/// Sessions the gateway routed that the snapshot remembers, the most recent first.
pub const STATUSLINE_GATEWAY_SESSIONS: usize = 200;

/// A limit period as Relay last read it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineWindow {
    /// Percent used, 0–100, rounded down.
    #[serde(serialize_with = "js::ser_num")]
    pub used: f64,
    /// When the period renews, epoch milliseconds.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub resets_at: Option<f64>,
    /// "resets 14:30" / "14:30’da yenilenir", in the app's language and time zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets: Option<String>,
}

/// A Claude account Claude Code can be on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineAccount {
    pub id: String,
    pub name: String,
    /// The Claude sign-ins (person and organization, lowercase) that are this account's.
    #[serde(default)]
    pub identities: Vec<TerminalIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<StatuslineWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<StatuslineWindow>,
}

/// While the gateway runs: each Claude Code session id it served, and the account it last used.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct StatuslineGateway {
    pub sessions: JsMap<String>,
}

/// Templates in the app's language; `{percent}`, `{age}` are filled in here.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatuslineText {
    pub five_hour: String,
    pub week: String,
    pub via_gateway: String,
    pub updated_ago: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineSnapshot {
    #[serde(serialize_with = "js::ser_num")]
    pub version: f64,
    #[serde(serialize_with = "js::ser_num")]
    pub generated_at: f64,
    /// The BCP 47 tag the texts are in; numbers and ages are formatted with it at read time.
    #[serde(default)]
    pub format_locale: String,
    /// Relay's account profiles folder: a CLAUDE_CONFIG_DIR inside it is that account.
    #[serde(default)]
    pub profiles: String,
    /// The account open in the Claude app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_account_id: Option<String>,
    /// The terminal's `claude` follows the Claude app's account at a switch.
    #[serde(default)]
    pub terminal_follows: bool,
    pub accounts: Vec<StatuslineAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<StatuslineGateway>,
    pub text: StatuslineText,
}

/// Claude Code's stdin JSON object, read the way the TS reads it: by property, whatever the
/// value's type.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StatuslineInput(pub Map<String, Value>);

/// A rate-limit window from stdin: `used_percentage` and `resets_at` when they are numbers.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LiveWindow {
    pub used_percentage: Option<f64>,
    pub resets_at: Option<f64>,
}

impl StatuslineInput {
    /// `session_id` when it is a string.
    pub fn session_id(&self) -> Option<&str> {
        self.0.get("session_id").and_then(Value::as_str)
    }

    /// `rate_limits[name]` (`five_hour`, `seven_day`), when it is an object.
    pub fn rate_limit(&self, name: &str) -> Option<LiveWindow> {
        let window = self
            .0
            .get("rate_limits")?
            .as_object()?
            .get(name)?
            .as_object()?;
        Some(LiveWindow {
            used_percentage: window.get("used_percentage").and_then(Value::as_f64),
            resets_at: window.get("resets_at").and_then(Value::as_f64),
        })
    }
}

/// Claude Code's stdin JSON; anything unreadable is an empty object, so the line still shows.
pub fn parse_statusline_input(text: Option<&str>) -> StatuslineInput {
    let Some(text) = text.filter(|t| !js_trim(t).is_empty()) else {
        return StatuslineInput::default();
    };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => StatuslineInput(map),
        _ => StatuslineInput::default(),
    }
}

fn js_trim(text: &str) -> &str {
    super::model_prices::js_trim(text)
}

/// The snapshot, or `None` when the file is missing, unreadable or another layout.
pub fn parse_statusline_snapshot(text: Option<&str>) -> Option<StatuslineSnapshot> {
    let value: Value = serde_json::from_str(text.filter(|t| !t.is_empty())?).ok()?;
    let object = value.as_object()?;
    if object.get("version").and_then(Value::as_f64) != Some(STATUSLINE_SNAPSHOT_VERSION)
        || !object.get("generatedAt").is_some_and(Value::is_number)
        || !object.get("accounts").is_some_and(Value::is_array)
        || !object.get("text").is_some_and(Value::is_object)
    {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// Who Claude Code is signed in to, from its `.claude.json` (`oauthAccount`); `None` when signed
/// out.
pub fn claude_sign_in(text: Option<&str>) -> Option<TerminalIdentity> {
    let value: Value = serde_json::from_str(text.filter(|t| !t.is_empty())?).ok()?;
    let account = value.as_object()?.get("oauthAccount")?.as_object()?;
    let account_uuid = account.get("accountUuid")?.as_str()?;
    let org_id = account.get("organizationUuid")?.as_str()?;
    Some(TerminalIdentity {
        account_uuid: account_uuid.to_lowercase(),
        org_id: org_id.to_lowercase(),
    })
}

/// Node's `path` for this platform, as far as the line needs it.
mod node_path {
    #[cfg(windows)]
    fn is_sep(c: char) -> bool {
        c == '/' || c == '\\'
    }
    #[cfg(not(windows))]
    fn is_sep(c: char) -> bool {
        c == '/'
    }
    #[cfg(windows)]
    const SEP: &str = "\\";
    #[cfg(not(windows))]
    const SEP: &str = "/";

    /// The root a path starts with: `/`, or on Windows `C:\`, `C:` or `\`.
    fn split_root(p: &str) -> (&str, &str) {
        #[cfg(windows)]
        {
            let b = p.as_bytes();
            if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                return if b.len() >= 3 && is_sep(b[2] as char) {
                    (&p[..3], &p[3..])
                } else {
                    (&p[..2], &p[2..])
                };
            }
        }
        match p.chars().next() {
            Some(c) if is_sep(c) => (&p[..1], &p[1..]),
            _ => ("", p),
        }
    }

    pub fn is_absolute(p: &str) -> bool {
        let (root, _) = split_root(p);
        !root.is_empty() && root.chars().last().is_some_and(is_sep)
    }

    /// `path.resolve(p)`: against the working directory, `.` and `..` resolved, no trailing
    /// separator.
    pub fn resolve(p: &str) -> String {
        let joined = if is_absolute(p) {
            p.to_string()
        } else {
            let cwd = std::env::current_dir()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("{cwd}{SEP}{p}")
        };
        let (root, rest) = split_root(&joined);
        let mut parts: Vec<&str> = Vec::new();
        for part in rest.split(is_sep) {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(part),
            }
        }
        let root = root.replace('/', SEP);
        format!("{root}{}", parts.join(SEP))
    }

    fn trim_trailing(p: &str) -> &str {
        let (root, _) = split_root(p);
        let trimmed = p.trim_end_matches(is_sep);
        if trimmed.len() < root.len() {
            root
        } else {
            trimmed
        }
    }

    /// `path.dirname(p)`.
    pub fn dirname(p: &str) -> String {
        let p = trim_trailing(p);
        let (root, rest) = split_root(p);
        match rest.rfind(is_sep) {
            Some(i) => {
                let head = rest[..i].trim_end_matches(is_sep);
                if head.is_empty() {
                    root.to_string()
                } else {
                    format!("{root}{head}")
                }
            }
            None if root.is_empty() => ".".to_string(),
            None => root.to_string(),
        }
    }

    /// `path.basename(p)`.
    pub fn basename(p: &str) -> String {
        let p = trim_trailing(p);
        let (_, rest) = split_root(p);
        rest.rsplit(is_sep).next().unwrap_or("").to_string()
    }
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let resolved = node_path::resolve(p);
        if cfg!(any(windows, target_os = "macos")) {
            resolved.to_lowercase()
        } else {
            resolved
        }
    };
    norm(a) == norm(b)
}

/// The account this session is on (`None` when none) and whether the gateway carried it.
#[derive(Debug, Clone, PartialEq)]
pub struct StatuslineAccountMatch<'a> {
    pub account: Option<&'a StatuslineAccount>,
    pub via_gateway: bool,
}

/// The account this Claude Code session is on, first match wins:
/// 1. the gateway served the session (`session_id`) through an account;
/// 2. CLAUDE_CONFIG_DIR is a Relay profile, as `relay run` and Relay's terminals set it;
/// 3. the sign-in in Claude Code's `.claude.json` is one of Relay's accounts;
/// 4. no sign-in could be read and the terminal follows the Claude app: the app's account.
///
/// `sign_in` is called only when it is needed.
pub fn statusline_account<'a>(
    snapshot: &'a StatuslineSnapshot,
    input: &StatuslineInput,
    config_dir: Option<&str>,
    sign_in: impl FnOnce() -> Option<TerminalIdentity>,
) -> StatuslineAccountMatch<'a> {
    let by_id = |id: Option<&str>| id.and_then(|id| snapshot.accounts.iter().find(|a| a.id == id));
    let routed = input.session_id().and_then(|session| {
        by_id(
            snapshot
                .gateway
                .as_ref()
                .and_then(|g| g.sessions.get(session))
                .map(String::as_str),
        )
    });
    if let Some(account) = routed {
        return StatuslineAccountMatch {
            account: Some(account),
            via_gateway: true,
        };
    }
    if let Some(dir) = config_dir.filter(|d| !d.is_empty())
        && node_path::is_absolute(dir)
        && same_path(&node_path::dirname(dir), &snapshot.profiles)
        && let Some(account) = by_id(Some(&node_path::basename(dir)))
    {
        return StatuslineAccountMatch {
            account: Some(account),
            via_gateway: false,
        };
    }
    if let Some(who) = sign_in() {
        let account = snapshot.accounts.iter().find(|a| {
            a.identities
                .iter()
                .any(|x| x.account_uuid == who.account_uuid && x.org_id == who.org_id)
        });
        return StatuslineAccountMatch {
            account,
            via_gateway: false,
        };
    }
    let account = if snapshot.terminal_follows {
        by_id(snapshot.desktop_account_id.as_deref())
    } else {
        None
    };
    StatuslineAccountMatch {
        account,
        via_gateway: false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatuslineStyle {
    Bold,
    Dim,
    Green,
    Yellow,
    Red,
}

/// Everything the line is made from; `paint` adds color, or returns the text as it is.
pub struct StatuslineRender<'a> {
    pub snapshot: &'a StatuslineSnapshot,
    pub input: &'a StatuslineInput,
    /// Claude Code's CLAUDE_CONFIG_DIR, when it set one.
    pub config_dir: Option<&'a str>,
    pub sign_in: Box<dyn FnOnce() -> Option<TerminalIdentity> + 'a>,
    pub now: f64,
    pub paint: &'a dyn Fn(StatuslineStyle, &str) -> String,
}

/// `template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole)`.
fn fill(template: &str, key: &str, value: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let word = after
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        if word > 0 && after.as_bytes().get(word) == Some(&b'}') {
            let name = &after[..word];
            if name == key {
                out.push_str(value);
            } else {
                out.push_str(&rest[open..open + word + 2]);
            }
            rest = &after[word + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// A live window from Claude Code's own stdin: newer than any read, for the session's own account.
fn live_used(window: Option<LiveWindow>, now: f64) -> Option<f64> {
    let window = window?;
    let used = window.used_percentage.filter(|u| u.is_finite())?;
    if let Some(resets_at) = window.resets_at
        && resets_at * 1000.0 <= now
    {
        return None;
    }
    Some(used.clamp(0.0, 100.0).floor())
}

/// A read window, unless the period it counts has renewed since.
fn current(window: Option<&StatuslineWindow>, now: f64) -> Option<&StatuslineWindow> {
    window.filter(|w| w.resets_at.is_none_or(|at| at > now))
}

fn percent_style(used: f64) -> StatuslineStyle {
    if used >= 100.0 {
        StatuslineStyle::Red
    } else if used >= 80.0 {
        StatuslineStyle::Yellow
    } else {
        StatuslineStyle::Green
    }
}

/// The two `Intl` formats of one locale, from Node 24's ICU. Templates hold `{}` for the number;
/// the first of each pair is the plural "one" form (only `1` reaches it in these locales).
struct FormatData {
    tag: &'static str,
    /// `Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0, useGrouping: false })`.
    percent: (&'static str, &'static str),
    /// `Intl.RelativeTimeFormat(locale, { style: "short", numeric: "always" })` for the past.
    minute: (&'static str, &'static str),
    hour: (&'static str, &'static str),
    day: (&'static str, &'static str),
    /// The grouping separator and the minimum grouping digits.
    group: (&'static str, u8),
}

#[rustfmt::skip]
const FORMATS: [FormatData; 17] = [
    FormatData { tag: "en", percent: ("", "%"), minute: ("{} min. ago", "{} min. ago"), hour: ("{} hr. ago", "{} hr. ago"), day: ("{} day ago", "{} days ago"), group: (",", 1) },
    FormatData { tag: "en-GB", percent: ("", "%"), minute: ("{} min ago", "{} min ago"), hour: ("{} hr ago", "{} hr ago"), day: ("{} day ago", "{} days ago"), group: (",", 1) },
    FormatData { tag: "tr", percent: ("%", ""), minute: ("{} dk. önce", "{} dk. önce"), hour: ("{} sa. önce", "{} sa. önce"), day: ("{} gün önce", "{} gün önce"), group: (".", 1) },
    FormatData { tag: "de", percent: ("", "\u{a0}%"), minute: ("vor {} Min.", "vor {} Min."), hour: ("vor {} Std.", "vor {} Std."), day: ("vor {} Tag", "vor {} Tagen"), group: (".", 1) },
    FormatData { tag: "fr", percent: ("", "\u{a0}%"), minute: ("il y a {}\u{a0}min", "il y a {}\u{a0}min"), hour: ("il y a {}\u{a0}h", "il y a {}\u{a0}h"), day: ("il y a {}\u{a0}j", "il y a {}\u{a0}j"), group: ("\u{202f}", 1) },
    FormatData { tag: "es", percent: ("", "\u{a0}%"), minute: ("hace {} min", "hace {} min"), hour: ("hace {} h", "hace {} h"), day: ("hace {} d", "hace {} d"), group: (".", 2) },
    FormatData { tag: "pt", percent: ("", "%"), minute: ("há {} min.", "há {} min."), hour: ("há {} h", "há {} h"), day: ("há {} dia", "há {} dias"), group: (".", 1) },
    FormatData { tag: "it", percent: ("", "%"), minute: ("{} min fa", "{} min fa"), hour: ("{} h fa", "{} h fa"), day: ("{} g fa", "{} gg fa"), group: (".", 2) },
    FormatData { tag: "ja", percent: ("", "%"), minute: ("{} 分前", "{} 分前"), hour: ("{} 時間前", "{} 時間前"), day: ("{} 日前", "{} 日前"), group: (",", 1) },
    FormatData { tag: "ko", percent: ("", "%"), minute: ("{}분 전", "{}분 전"), hour: ("{}시간 전", "{}시간 전"), day: ("{}일 전", "{}일 전"), group: (",", 1) },
    FormatData { tag: "zh-CN", percent: ("", "%"), minute: ("{}分钟前", "{}分钟前"), hour: ("{}小时前", "{}小时前"), day: ("{}天前", "{}天前"), group: (",", 1) },
    FormatData { tag: "zh-TW", percent: ("", "%"), minute: ("{} 分鐘前", "{} 分鐘前"), hour: ("{} 小時前", "{} 小時前"), day: ("{} 天前", "{} 天前"), group: (",", 1) },
    FormatData { tag: "zh-HK", percent: ("", "%"), minute: ("{} 分鐘前", "{} 分鐘前"), hour: ("{} 小時前", "{} 小時前"), day: ("{} 日前", "{} 日前"), group: (",", 1) },
    FormatData { tag: "ru", percent: ("", "\u{a0}%"), minute: ("{} мин. назад", "{} мин. назад"), hour: ("{} ч назад", "{} ч назад"), day: ("{} дн. назад", "{} дн. назад"), group: ("\u{a0}", 1) },
    FormatData { tag: "uk", percent: ("", "%"), minute: ("{} хв тому", "{} хв тому"), hour: ("{} год тому", "{} год тому"), day: ("{} дн. тому", "{} дн. тому"), group: ("\u{a0}", 1) },
    FormatData { tag: "pl", percent: ("", "%"), minute: ("{} min temu", "{} min temu"), hour: ("{} godz. temu", "{} godz. temu"), day: ("{} dzień temu", "{} dni temu"), group: ("\u{a0}", 2) },
    FormatData { tag: "nl", percent: ("", "%"), minute: ("{} min. geleden", "{} min. geleden"), hour: ("{} uur geleden", "{} uur geleden"), day: ("{} dag geleden", "{} dgn geleden"), group: (".", 1) },
];

fn format_data(tag: &str) -> &'static FormatData {
    FORMATS.iter().find(|f| f.tag == tag).unwrap_or(&FORMATS[0])
}

/// Whether `tag` is a structurally valid BCP 47 tag, as far as `Intl` constructors throw on one
/// that is not: a 2–3 or 5–8 letter language, then 1–8 character alphanumeric subtags.
fn well_formed(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    let lang_ok = matches!(language.len(), 2 | 3 | 5..=8)
        && language.bytes().all(|b| b.is_ascii_alphabetic());
    lang_ok
        && parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// The table entry for a locale tag: its language's, with the regional data Relay's own
/// `FORMAT_LOCALE` tags need (en-GB, zh-TW); `None` for a tag `Intl` refuses (RangeError).
fn resolve_format(tag: &str) -> Option<&'static FormatData> {
    if !well_formed(tag) {
        return None;
    }
    let mut parts = tag.split('-');
    let language = parts.next().unwrap_or("").to_ascii_lowercase();
    let mut script = None;
    let mut region = None;
    for part in parts.take_while(|p| p.len() > 1) {
        match part.len() {
            4 if part.bytes().all(|b| b.is_ascii_alphabetic()) => {
                script = Some(part.to_ascii_lowercase())
            }
            2 | 3 if region.is_none() => region = Some(part.to_ascii_uppercase()),
            _ => {}
        }
    }
    Some(match language.as_str() {
        "en" if region.as_deref() == Some("GB") => format_data("en-GB"),
        "zh" if matches!(region.as_deref(), Some("HK" | "MO")) => format_data("zh-HK"),
        "zh" if script.as_deref() == Some("hant") || region.as_deref() == Some("TW") => {
            format_data("zh-TW")
        }
        "zh" => format_data("zh-CN"),
        other => FORMATS
            .iter()
            .find(|f| f.tag == other)
            .unwrap_or(&FORMATS[0]),
    })
}

/// An integer with the locale's grouping separators.
fn grouped(n: u64, data: &FormatData) -> String {
    let digits = n.to_string();
    let (sep, min) = data.group;
    if digits.len() < 4 + usize::from(min) - 1 {
        return digits;
    }
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push_str(sep);
        }
        out.push(c);
    }
    out
}

/// `percent.format(used / 100)`: rounded half away from zero to a whole percent, no grouping.
fn format_percent(used: f64, data: &FormatData) -> String {
    let ratio = used / 100.0;
    // ICU rounds the shortest decimal that reads back as `ratio`, not the binary value.
    let text = format!("{}", ratio.abs());
    let (int, frac) = text.split_once('.').unwrap_or((&text, ""));
    let mut digits = format!("{int}{frac:0<2}");
    let rest = digits.split_off(int.len() + 2);
    let mut whole: u128 = digits.parse().unwrap_or(0);
    if rest.as_bytes().first().is_some_and(|d| *d >= b'5') {
        whole += 1;
    }
    let sign = if ratio.is_sign_negative() { "-" } else { "" };
    format!("{sign}{}{whole}{}", data.percent.0, data.percent.1)
}

/// "17 min ago" in the snapshot's language.
fn age_text(data: &FormatData, ms: f64) -> String {
    let minutes = (ms / 60_000.0).floor().max(1.0);
    let (forms, n) = if minutes < 60.0 {
        (data.minute, minutes)
    } else {
        let hours = (minutes / 60.0).floor();
        if hours < 48.0 {
            (data.hour, hours)
        } else {
            (data.day, (hours / 24.0).floor())
        }
    };
    let template = if n == 1.0 { forms.0 } else { forms.1 };
    template.replacen("{}", &grouped(n as u64, data), 1)
}

/// One line: the account, its five-hour and weekly use, when the five-hour period renews,
/// whether the gateway carried the session, and the snapshot's age once it is old. The
/// percentages Claude Code passes on stdin win over Relay's last read. Empty when there is
/// nothing to show.
pub fn render_statusline(render: StatuslineRender<'_>) -> String {
    let StatuslineRender {
        snapshot,
        input,
        config_dir,
        sign_in,
        now,
        paint,
    } = render;
    let found = statusline_account(snapshot, input, config_dir, sign_in);
    let data = resolve_format(&snapshot.format_locale).unwrap_or(&FORMATS[0]);
    let five_hour_read = current(found.account.and_then(|a| a.five_hour.as_ref()), now);
    let week_read = current(found.account.and_then(|a| a.week.as_ref()), now);
    let five_hour =
        live_used(input.rate_limit("five_hour"), now).or(five_hour_read.map(|w| w.used));
    let week = live_used(input.rate_limit("seven_day"), now).or(week_read.map(|w| w.used));
    let mut parts: Vec<String> = Vec::new();
    if let Some(account) = found.account {
        parts.push(paint(StatuslineStyle::Bold, &account.name));
    }
    if found.via_gateway {
        parts.push(snapshot.text.via_gateway.clone());
    }
    let used = |template: &str, value: f64| {
        fill(
            template,
            "percent",
            &paint(percent_style(value), &format_percent(value, data)),
        )
    };
    if let Some(value) = five_hour {
        parts.push(used(&snapshot.text.five_hour, value));
    }
    if let Some(value) = week {
        parts.push(used(&snapshot.text.week, value));
    }
    // The next renewal: the five-hour period's, or the week's for an account without one.
    let resets = match five_hour_read.and_then(|w| w.resets.as_deref()) {
        Some(resets) => Some(resets),
        None if five_hour.is_none() => week_read.and_then(|w| w.resets.as_deref()),
        None => None,
    };
    if let Some(resets) = resets.filter(|r| !r.is_empty()) {
        parts.push(paint(StatuslineStyle::Dim, resets));
    }
    if parts.is_empty() {
        return String::new();
    }
    let age = now - snapshot.generated_at;
    if age > STATUSLINE_STALE_MS {
        let data = resolve_format(&snapshot.format_locale).unwrap_or_else(|| format_data("en"));
        parts.push(paint(
            StatuslineStyle::Yellow,
            &fill(&snapshot.text.updated_ago, "age", &age_text(data, age)),
        ));
    }
    parts.join(" · ")
}
