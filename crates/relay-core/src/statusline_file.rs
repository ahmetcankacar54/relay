//! Port of `electron/core/statusline-file.ts`: the snapshot `relay statusline` reads,
//! `<userData>/statusline.json` (version 1).

use std::path::Path;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike, Utc};
use indexmap::IndexMap;
use relay_i18n::{Args, Locale, translate};

use crate::continuation_journal::{MAX_BYTES, PrivateJsonError, write_private_json};
use crate::shared::percent::percent_used;
use crate::shared::proxy_types::ProxySessionState;
use crate::shared::statusline::{
    STATUSLINE_FILE, STATUSLINE_GATEWAY_SESSIONS, STATUSLINE_SNAPSHOT_VERSION, StatuslineAccount,
    StatuslineGateway, StatuslineSnapshot, StatuslineText, StatuslineWindow,
};
use crate::shared::terminal_identity::{TerminalMode, terminal_identities};
use crate::shared::time_zones::parse_time_zone;
use crate::shared::tr_dative::clock_locative;
use crate::shared::types::js::{JsMap, date_parse};
use crate::shared::types::{Account, AccountProvider, AccountUsage, UsageWindow};
use crate::shared::usage::fresh_usage;

pub struct StatuslineSnapshotInput<'a> {
    pub accounts: &'a [Account],
    pub usage: &'a IndexMap<String, AccountUsage>,
    pub desktop_account_id: Option<&'a str>,
    pub terminal_mode: TerminalMode,
    /// The gateway's live sessions; `None` while it is not running.
    pub gateway_sessions: Option<&'a [ProxySessionState]>,
    /// Relay's profiles folder, `<userData>/profiles`.
    pub profiles: &'a str,
    pub language: Locale,
    /// The planning time zone, as every other surface of Relay shows times in.
    pub zone: &'a str,
    pub now: f64,
}

/// Past this, a renewal names its weekday too ("Sat 21:30").
const SAME_DAY_MS: f64 = 20.0 * 60.0 * 60_000.0;

/// `Intl.DateTimeFormat(FORMAT_LOCALE[language], { weekday: "short" })`, Sunday first, as
/// Node's ICU prints them.
fn weekdays(language: Locale) -> [&'static str; 7] {
    match language {
        Locale::En => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        Locale::Tr => ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"],
        Locale::De => ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
        Locale::Fr => ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
        Locale::Es => ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
        Locale::PtBr => ["dom.", "seg.", "ter.", "qua.", "qui.", "sex.", "sáb."],
        Locale::It => ["dom", "lun", "mar", "mer", "gio", "ven", "sab"],
        Locale::Ja => ["日", "月", "火", "水", "木", "金", "土"],
        Locale::Ko => ["일", "월", "화", "수", "목", "금", "토"],
        Locale::ZhHans => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
        Locale::ZhHant => ["週日", "週一", "週二", "週三", "週四", "週五", "週六"],
        Locale::Ru => ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
        Locale::Uk => ["нд", "пн", "вт", "ср", "чт", "пт", "сб"],
        Locale::Pl => ["niedz.", "pon.", "wt.", "śr.", "czw.", "pt.", "sob."],
        Locale::Nl => ["zo", "ma", "di", "wo", "do", "vr", "za"],
    }
}

/// The local `(weekday from Sunday, hour, minute)` of `at` in `zone`; an unknown zone is the
/// system's own, as the TS falls back when `Intl` refuses it.
fn local_clock(at: f64, zone: &str) -> Option<(usize, u32, u32)> {
    let utc: DateTime<Utc> = Utc.timestamp_millis_opt(at.trunc() as i64).single()?;
    let parts = |weekday: chrono::Weekday, hour, minute| {
        (weekday.num_days_from_sunday() as usize, hour, minute)
    };
    Some(match parse_time_zone(zone) {
        Some(tz) => {
            let local = utc.with_timezone(&tz);
            parts(local.weekday(), local.hour(), local.minute())
        }
        None => {
            let local = utc.with_timezone(&Local);
            parts(local.weekday(), local.hour(), local.minute())
        }
    })
}

/// `/\d{1,2}:\d{2}$/`: where the trailing clock of `time` starts.
fn trailing_clock(time: &str) -> Option<usize> {
    let bytes = time.as_bytes();
    let n = bytes.len();
    if n < 4 || !bytes[n - 2..].iter().all(u8::is_ascii_digit) || bytes[n - 3] != b':' {
        return None;
    }
    if !bytes[n - 4].is_ascii_digit() {
        return None;
    }
    Some(if n >= 5 && bytes[n - 5].is_ascii_digit() {
        n - 5
    } else {
        n - 4
    })
}

fn window(
    read: Option<&UsageWindow>,
    now: f64,
    zone: &str,
    language: Locale,
) -> Option<StatuslineWindow> {
    let used = percent_used(read.map(|w| w.used_percent))?;
    let at = date_parse(read.and_then(|w| w.resets_at.as_deref()).unwrap_or(""));
    if !at.is_finite() || at <= now {
        return Some(StatuslineWindow {
            used,
            resets_at: None,
            resets: None,
        });
    }
    let (weekday, hour, minute) = local_clock(at, zone)?;
    let hour = format!("{hour:02}:{minute:02}");
    let time = if at - now > SAME_DAY_MS {
        let day = weekdays(language)[weekday];
        format!("{} {hour}", day.strip_suffix('.').unwrap_or(day))
    } else {
        hour
    };
    let time_locative = match trailing_clock(&time) {
        Some(start) => format!("{}{}", &time[..start], clock_locative(&time[start..])),
        None => time.clone(),
    };
    Some(StatuslineWindow {
        used,
        resets_at: Some(at),
        resets: Some(translate(
            language,
            "statusline.resets",
            &Args::new()
                .set("time", time)
                .set("timeLocative", time_locative),
        )),
    })
}

/// The snapshot `relay statusline` reads: Claude accounts with their sign-ins and current
/// limits, the sessions the gateway carried, and every label already in the app's language.
pub fn build_statusline_snapshot(input: &StatuslineSnapshotInput<'_>) -> StatuslineSnapshot {
    let StatuslineSnapshotInput {
        language,
        zone,
        now,
        ..
    } = *input;
    let t = |id: &str, args: Args| translate(language, id, &args);
    let accounts: Vec<StatuslineAccount> = input
        .accounts
        .iter()
        .filter(|account| {
            account.provider.unwrap_or(AccountProvider::Claude) == AccountProvider::Claude
        })
        .map(|account| {
            let usage = input.usage.get(&account.id);
            let fresh =
                fresh_usage(usage, now) && usage.is_some_and(|u| u.account_id == account.id);
            let usage = usage.filter(|_| fresh);
            StatuslineAccount {
                id: account.id.clone(),
                name: account.name.clone(),
                identities: terminal_identities(
                    account
                        .desktop
                        .as_ref()
                        .map(|d| (d.account_uuid.as_str(), d.org_id.as_str())),
                    account
                        .auth
                        .as_ref()
                        .map(|a| (a.account_uuid.as_deref(), a.org_id.as_deref())),
                ),
                five_hour: usage.and_then(|u| window(u.five_hour.as_ref(), now, zone, language)),
                week: usage.and_then(|u| window(u.seven_day.as_ref(), now, zone, language)),
            }
        })
        .collect();
    let known = |id: &str| accounts.iter().any(|a| a.id == id);
    // Claude Code names its session in a header the gateway keys it by: `hdr:<session id>`.
    let gateway = input.gateway_sessions.map(|sessions| {
        let mut sessions: Vec<&ProxySessionState> = sessions
            .iter()
            .filter(|s| s.session_key.starts_with("hdr:") && known(&s.account_id))
            .collect();
        sessions.sort_by(|a, b| {
            b.last_active_at
                .partial_cmp(&a.last_active_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut map = JsMap::new();
        for s in sessions.into_iter().take(STATUSLINE_GATEWAY_SESSIONS) {
            map.insert(s.session_key[4..].to_owned(), s.account_id.clone());
        }
        StatuslineGateway { sessions: map }
    });
    StatuslineSnapshot {
        version: STATUSLINE_SNAPSHOT_VERSION,
        generated_at: now,
        format_locale: language.format_locale().to_owned(),
        profiles: input.profiles.to_owned(),
        desktop_account_id: input
            .desktop_account_id
            .filter(|id| !id.is_empty() && known(id))
            .map(str::to_owned),
        terminal_follows: input.terminal_mode != TerminalMode::Off,
        gateway,
        text: StatuslineText {
            five_hour: t(
                "statusline.fiveHour",
                Args::new().set("percent", "{percent}"),
            ),
            week: t("widgetSnapshot.week", Args::new().set("pct", "{percent}")),
            via_gateway: t("statusline.viaGateway", Args::new()),
            updated_ago: t("statusline.updatedAgo", Args::new().set("age", "{age}")),
        },
        accounts,
    }
}

/// Writes `<dir>/statusline.json` through a private temporary file, so a reader never sees half
/// of it.
pub fn write_statusline_file(
    dir: &Path,
    snapshot: &StatuslineSnapshot,
) -> Result<(), PrivateJsonError> {
    write_private_json(&dir.join(STATUSLINE_FILE), snapshot, MAX_BYTES)
}
