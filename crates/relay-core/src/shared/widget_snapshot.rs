//! Port of `shared/widget-snapshot.ts`: what the macOS widgets draw, written by Relay to
//! `<userData>/widget/today.json`. Every string is formatted here, so the widget only lays them
//! out; it never formats numbers or translates. Parts Relay has no real data for are omitted, and
//! the widget leaves them out.
//!
//! The structs serialize in the key order the TS object literals build (`JSON.stringify`), which
//! is what the widget's file holds; the interface order differs in places.

use std::collections::HashSet;

use chrono::{Datelike, NaiveDate};
use relay_i18n::{Args, Locale, translate};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

use super::account_state::desktop_cli_mismatch;
use super::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, rank_continuation_targets,
};
use super::number_format::{Decimal, body, format_change, format_cost, format_tokens, symbols};
use super::percent::{format_percent, percent_used};
use super::planning::local_parts;
use super::quota_windows::{limit_headline, model_only_usage, quota_windows, spent_model_windows};
use super::relay_link::relay_switch_link;
use super::token_usage_view::{TokenCell, TokenCounts, TokenDay, TokenToday};
use super::tr_dative::{clock_locative, with_dative};
use super::types::js::{
    JsMap, Num, date_parse, number_string, round, ser_num, ser_opt_num, sort_by,
};
use super::types::{
    Account, AccountProvider, AccountUsage, AutoSwitchStrategy, ModelWindow, RelaySettings,
    literal_enum,
};
use super::usage::{fresh_usage, suggested_account};

/// The file's layout; the widget reads only this version.
pub const WIDGET_SNAPSHOT_VERSION: u32 = 2;
/// Other accounts the widget lists, the suggested one first.
pub const WIDGET_OTHER_ACCOUNTS: usize = 3;
/// Accounts with a colour of their own in the stacked bars; the rest share one.
pub const WIDGET_SERIES: usize = 3;
/// The series of everything past the first three accounts: former, terminal, unknown and the rest.
pub const WIDGET_REST_KEY: &str = "rest";
/// The open account's five-hour use from which the panda looks alarmed.
pub const WIDGET_ALERT_PERCENT: f64 = 80.0;

literal_enum!(
    /// "data", "empty" (no tokens today yet) or "scanning" (the first scan is running).
    WidgetState { Data = "data", Empty = "empty", Scanning = "scanning" }
);

literal_enum!(
    /// The panda's face in the widgets: "happy" while all is well, "alert" (wide eyes) once the
    /// open account's five-hour window is 80 % used, "worried" when one of its limits is full, and
    /// "sleeping" while there is nothing to watch: the first scan runs, or no Relay account is open
    /// in Claude. The widget also lets it sleep once the file is 30 minutes old.
    WidgetMood { Happy = "happy", Alert = "alert", Worried = "worried", Sleeping = "sleeping" }
);

fn ser_locale<S: Serializer>(locale: &Locale, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(locale.as_str())
}

fn de_locale<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Locale, D::Error> {
    let text = String::deserialize(deserializer)?;
    Locale::parse(&text).ok_or_else(|| serde::de::Error::custom(format!("unknown locale {text}")))
}

/// One account's strings, every one formatted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetAccountText {
    /// "%94"; "—" while unknown.
    pub five_hour: String,
    pub week: String,
    /// "%22 / %35": five hours, then the week.
    pub limits: String,
    pub cost: String,
    pub tokens: String,
    /// "$69,18 · 64,2 Mn"
    pub cost_tokens: String,
    /// Time left in the five-hour window when the file was written ("1:50"); "" without one.
    pub left: String,
    /// When the week renews ("Cmt 21:30"); "" without one.
    pub week_reset: String,
    /// "hafta %68"; "" while unknown.
    pub week_short: String,
}

/// One account's limits and today's use; `T` is its text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetAccount<T> {
    pub id: String,
    pub name: String,
    /// Percent used of the five-hour window, 0–100 rounded down; omitted while unknown or old.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub five_hour: Option<f64>,
    /// Percent used of the week, 0–100 rounded down; omitted while unknown or old.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub week: Option<f64>,
    /// When the five-hour window renews, epoch milliseconds; the widget counts down to it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub five_hour_resets_at: Option<f64>,
    /// Today's API value and tokens on this account.
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
    #[serde(serialize_with = "ser_num")]
    pub tokens: f64,
    /// Its colour in the stacked bars: 0–2, or 3 for the rest.
    pub color: usize,
    pub text: T,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetActiveText {
    #[serde(flatten)]
    pub base: WidgetAccountText,
    /// "Hafta %68 · Cmt 21:30’da yenilenir"; "" while unknown.
    pub week_line: String,
    /// "$69,18 bugün"
    pub cost_chip: String,
    /// "64,2 Mn token"
    pub tokens_chip: String,
}

/// The account open in Claude.
pub type WidgetActive = WidgetAccount<WidgetActiveText>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetOtherText {
    #[serde(flatten)]
    pub base: WidgetAccountText,
    /// "Vertex’a geç · %22"
    pub switch_to: String,
}

/// Another account, as the panel ranks it. Its `text` stays where the account's line put it,
/// before `suggested`, as the TS spread writes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetOther {
    #[serde(flatten)]
    pub account: WidgetAccount<WidgetOtherText>,
    /// The account Relay suggests switching to (the panel's badge).
    pub suggested: bool,
    /// Its Claude app sign-in is saved and its limit is not full: Relay can review a switch to it.
    pub switchable: bool,
    /// `relay://switch?account=<id>` while switchable: opens Relay's switch review, never switches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// A series of the stacked bars: an account, or the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetSeries {
    pub key: String,
    pub name: String,
    pub color: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetCostText {
    pub cost: String,
}

/// Today's cost share of one series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WidgetSplitPart {
    #[serde(flatten)]
    pub series: WidgetSeries,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
    /// Of today's cost, 0–1.
    #[serde(serialize_with = "ser_num")]
    pub share: f64,
    pub text: WidgetCostText,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WidgetDay {
    pub date: String,
    /// "Pzt" / "Mon"
    pub label: String,
    pub today: bool,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
    /// The cost of each series that day, in `series` order.
    #[serde(serialize_with = "super::types::js::ser_nums")]
    pub parts: Vec<f64>,
}

/// A label and its figure ("Günde" and "$58,80"); a row without a figure reads as its label alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetPair {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub figure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetWeekText {
    pub title: String,
    pub cost: String,
    /// "412 Mn token"
    pub tokens: String,
    /// "Günde $58,80"
    pub average: String,
    /// "En yoğun Sal · $142,10"; "" with no cost at all.
    pub busiest: String,
    /// "Limit 2 kez doldu"; "" when `hits` is omitted.
    pub hits: String,
    /// "Kişisel · hafta %68"; "" without an active account's week.
    pub active_week: String,
    /// The lines above that apply, in order, as label and figure for the widget to set side by side.
    pub pairs: Vec<WidgetPair>,
}

/// The last seven days, oldest first, ending today.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WidgetWeek {
    pub days: Vec<WidgetDay>,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
    #[serde(serialize_with = "ser_num")]
    pub tokens: f64,
    /// The cost per day.
    #[serde(serialize_with = "ser_num")]
    pub average: f64,
    /// Times a limit was reached in these days; omitted while Relay's history is unavailable.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub hits: Option<f64>,
    pub text: WidgetWeekText,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WidgetTotals {
    #[serde(serialize_with = "ser_num")]
    pub input: f64,
    #[serde(serialize_with = "ser_num")]
    pub output: f64,
    #[serde(serialize_with = "ser_num")]
    pub cache: f64,
    #[serde(serialize_with = "ser_num")]
    pub total: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshotText {
    pub title: String,
    pub subtitle: String,
    pub rows: [String; 3],
    pub input: String,
    pub output: String,
    pub cache: String,
    pub total: String,
    pub cost: String,
    /// "" without a change.
    pub change: String,
    /// The line under the title while `state` is not "data".
    pub status: String,
    /// What a new day shows before Relay writes it: the widget switches to it at midnight.
    pub empty: String,
    /// Shown in place of the subtitle once the file is 30 minutes old.
    pub stale: String,
    /// "$91,48 · 86,5 Mn token"
    pub cost_tokens: String,
    /// "86,5 Mn token"
    pub tokens: String,
    /// "Bugün · API karşılığı": the Today widget's title.
    pub api_title: String,
    /// "Diğer hesaplar": the heading over the other accounts.
    pub others: String,
    /// "bugün": the heading over their cost today.
    pub today_word: String,
    /// "Claude’da açık": over the active account's name.
    pub in_claude: String,
    /// "önerilen": beside the suggested account's name.
    pub suggested: String,
    /// "Bugün toplam $91,48 · 86,5 Mn token"
    pub today_line: String,
    /// "Bugün · tüm hesaplar"
    pub all_today: String,
    /// "Geç"
    pub switch: String,
    /// What follows a countdown: "kaldı" / "left".
    pub left: String,
    /// The account widgets' line while none of Relay's accounts is open in Claude.
    pub no_active: String,
}

/// What the macOS widgets draw (`today.json`), in the key order the TS writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshot {
    /// Always 2.
    pub version: u32,
    #[serde(serialize_with = "ser_num")]
    pub generated_at: f64,
    pub date: String,
    pub zone: String,
    pub state: WidgetState,
    pub mood: WidgetMood,
    /// The language every string below is in; the widget's own fallbacks follow it.
    #[serde(serialize_with = "ser_locale", deserialize_with = "de_locale")]
    pub locale: Locale,
    pub totals: WidgetTotals,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
    #[serde(serialize_with = "ser_opt_num")]
    pub change: Option<f64>,
    /// The API value per quarter hour today; null after the current one.
    #[serde(serialize_with = "ser_opt_nums")]
    pub slots: Vec<Option<f64>>,
    #[serde(serialize_with = "ser_opt_num")]
    pub yesterday_average: Option<f64>,
    /// The account open in Claude; omitted when none of Relay's accounts is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<WidgetActive>,
    /// Up to three other accounts, the suggested one first.
    pub accounts: Vec<WidgetOther>,
    /// The stacked bars' series, in colour order.
    pub series: Vec<WidgetSeries>,
    /// Today's cost per series, in series order; empty without cost today.
    pub split: Vec<WidgetSplitPart>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<WidgetWeek>,
    pub text: WidgetSnapshotText,
}

fn ser_opt_nums<S: Serializer>(values: &[Option<f64>], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(values.iter().map(|v| v.map(Num)))
}

/// The first scan's progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WidgetProgress {
    pub complete: bool,
    pub percent: f64,
}

/// Relay's accounts and limits; without them the widget shows no accounts.
#[derive(Debug, Clone, Copy)]
pub struct WidgetLimits<'a> {
    pub accounts: &'a [Account],
    pub usage: &'a JsMap<AccountUsage>,
    /// The account open in Claude.
    pub active_id: Option<&'a str>,
    pub settings: &'a RelaySettings,
    /// The keeper's tempo now, Pro units per hour, as the panel ranks with it.
    pub rate: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
pub struct WidgetSnapshotInput<'a> {
    pub today: &'a TokenToday,
    pub progress: WidgetProgress,
    pub language: Locale,
    pub zone: &'a str,
    pub now: f64,
    /// The token view's days (the last seven, ending today): per-account costs and the week.
    pub days: Option<&'a [TokenDay]>,
    pub limits: Option<WidgetLimits<'a>>,
    /// Limits reached in the seven days, when Relay's history is available.
    pub hits: Option<f64>,
}

/// The limits `widget_mood` reads: `Pick<WidgetAccount, "fiveHour" | "week">`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WidgetMoodLimits {
    pub five_hour: Option<f64>,
    pub week: Option<f64>,
}

impl<T> WidgetAccount<T> {
    pub fn mood_limits(&self) -> WidgetMoodLimits {
        WidgetMoodLimits {
            five_hour: self.five_hour,
            week: self.week,
        }
    }
}

pub fn widget_mood(state: WidgetState, active: Option<WidgetMoodLimits>) -> WidgetMood {
    let Some(active) = active else {
        return WidgetMood::Sleeping;
    };
    if state == WidgetState::Scanning {
        return WidgetMood::Sleeping;
    }
    let five = active.five_hour.unwrap_or(0.0);
    if five >= 100.0 || active.week.unwrap_or(0.0) >= 100.0 {
        return WidgetMood::Worried;
    }
    if five >= WIDGET_ALERT_PERCENT {
        return WidgetMood::Alert;
    }
    WidgetMood::Happy
}

/// `Intl.DateTimeFormat(locale, { weekday: "short" })` without a trailing period, Sunday first.
fn weekdays(language: Locale) -> [&'static str; 7] {
    match language {
        Locale::En => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        Locale::Tr => ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"],
        Locale::De => ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
        Locale::Fr => ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"],
        Locale::Es => ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
        Locale::PtBr => ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"],
        Locale::It => ["dom", "lun", "mar", "mer", "gio", "ven", "sab"],
        Locale::Ja => ["日", "月", "火", "水", "木", "金", "土"],
        Locale::Ko => ["일", "월", "화", "수", "목", "금", "토"],
        Locale::ZhHans => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
        Locale::ZhHant => ["週日", "週一", "週二", "週三", "週四", "週五", "週六"],
        Locale::Ru => ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
        Locale::Uk => ["нд", "пн", "вт", "ср", "чт", "пт", "сб"],
        Locale::Pl => ["niedz", "pon", "wt", "śr", "czw", "pt", "sob"],
        Locale::Nl => ["zo", "ma", "di", "wo", "do", "vr", "za"],
    }
}

/// The clock in `zone` as every locale's `{ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }`
/// writes it ("20:24"). An unknown zone reads as UTC (the TS throws; Relay's zones are valid).
fn time_of(time: f64, zone: &str) -> String {
    local_parts(time, zone)
        .map(|p| format!("{:02}:{:02}", p.hour, p.minute))
        .unwrap_or_default()
}

fn weekday_of(time: f64, zone: &str, language: Locale) -> String {
    local_parts(time, zone)
        .and_then(|p| NaiveDate::from_ymd_opt(p.year, p.month, p.day))
        .map(|d| weekdays(language)[d.weekday().num_days_from_sunday() as usize].to_string())
        .unwrap_or_default()
}

/// "Pzt" / "Mon" for a calendar date.
fn day_label(date: &str, language: Locale) -> String {
    weekday_of(date_parse(&format!("{date}T12:00:00Z")), "UTC", language)
}

/// `Intl.NumberFormat(locale, { style: "percent" }).format(value / 100)`.
fn intl_percent(value: f64, language: Locale) -> String {
    let s = symbols(language);
    if !value.is_finite() {
        let text = if value.is_nan() { "NaN" } else { "∞" };
        let sign = if value == f64::NEG_INFINITY { "-" } else { "" };
        return format!("{sign}{}{text}{}", s.percent_prefix, s.percent_suffix);
    }
    let mut decimal = Decimal::from_f64(value / 100.0);
    decimal.shift(2);
    decimal.round(0);
    let sign = if decimal.negative && !decimal.is_zero() {
        "-"
    } else {
        ""
    };
    format!(
        "{sign}{}{}{}",
        s.percent_prefix,
        body(&decimal, 0, true, s.min_grouping, &s),
        s.percent_suffix
    )
}

/// Time left until `at` as "h:mm" ("1:50", "0:07"); "" when past or unknown.
pub fn widget_countdown(at: Option<f64>, now: f64) -> String {
    let Some(at) = at.filter(|at| at.is_finite() && *at > now) else {
        return String::new();
    };
    let minutes = ((at - now) / 60_000.0).ceil();
    format!(
        "{}:{:0>2}",
        number_string((minutes / 60.0).floor()),
        number_string(minutes % 60.0)
    )
}

fn tokens_of(c: Option<&TokenCounts>) -> f64 {
    c.map_or(0.0, |c| c.input + c.output + c.cache_write + c.cache_read)
}

#[derive(Default)]
struct Known {
    five_hour: Option<f64>,
    week: Option<f64>,
    five_hour_resets_at: Option<f64>,
    week_resets_at: Option<f64>,
}

/// A window's percent used, when the reading is the account's own and current.
fn limits_of(account: &Account, usage: Option<&AccountUsage>, now: f64) -> Known {
    let Some(usage) = usage.filter(|u| u.account_id == account.id && fresh_usage(Some(u), now))
    else {
        return Known::default();
    };
    let future = |at: f64| (at.is_finite() && at > now).then_some(at);
    // An Antigravity account's limits are per model: its figure is the fullest model, never the
    // roomiest one its five-hour window holds for the gateway.
    if model_only_usage(Some(usage)) {
        let head = limit_headline(Some(usage), now);
        let at = date_parse(
            head.as_ref()
                .and_then(|h| h.resets_at.as_deref())
                .unwrap_or(""),
        );
        return Known {
            five_hour: percent_used(head.map(|h| h.used_percent)),
            five_hour_resets_at: future(at),
            ..Known::default()
        };
    }
    let reset = |w: &Option<super::types::UsageWindow>| {
        date_parse(
            w.as_ref()
                .and_then(|w| w.resets_at.as_deref())
                .unwrap_or(""),
        )
    };
    Known {
        five_hour: percent_used(usage.five_hour.as_ref().map(|w| w.used_percent)),
        week: percent_used(usage.seven_day.as_ref().map(|w| w.used_percent)),
        five_hour_resets_at: future(reset(&usage.five_hour)),
        week_resets_at: future(reset(&usage.seven_day)),
    }
}

fn t(language: Locale, id: &str) -> String {
    translate(language, id, &Args::new())
}

pub fn build_widget_snapshot(input: &WidgetSnapshotInput<'_>) -> WidgetSnapshot {
    let WidgetSnapshotInput {
        today,
        progress,
        language,
        zone,
        now,
        ..
    } = *input;
    let totals = &today.totals;
    let cache = totals.cache_write + totals.cache_read;
    let total = totals.input + totals.output + cache;
    let cost = totals.cost.unwrap_or(0.0);
    let state = if !progress.complete {
        WidgetState::Scanning
    } else if total == 0.0 {
        WidgetState::Empty
    } else {
        WidgetState::Data
    };
    let percent = intl_percent(progress.percent, language);
    let money = |value: f64, estimated: bool| {
        format!(
            "{}{}",
            if estimated { "≈" } else { "" },
            format_cost(value, language)
        )
    };
    let token_word = t(language, "widgetSnapshot.tokens");
    let cost_text = money(cost, totals.cost_estimated == Some(true));
    let cost_tokens = format!(
        "{cost_text} · {} {token_word}",
        format_tokens(total, language)
    );
    let parts = build_accounts(input, &money);
    let no_tokens = t(language, "widgetSnapshot.noTokensYetToday");
    WidgetSnapshot {
        version: WIDGET_SNAPSHOT_VERSION,
        generated_at: now,
        date: today.date.clone(),
        zone: zone.to_string(),
        state,
        mood: widget_mood(state, parts.active.as_ref().map(WidgetAccount::mood_limits)),
        locale: language,
        totals: WidgetTotals {
            input: totals.input,
            output: totals.output,
            cache,
            total,
        },
        cost,
        change: today.change,
        slots: today.slots.clone(),
        yesterday_average: today.yesterday_average,
        active: parts.active,
        accounts: parts.accounts,
        series: parts.series,
        split: parts.split,
        week: parts.week,
        text: WidgetSnapshotText {
            title: t(language, "common.today"),
            subtitle: t(language, "widgetSnapshot.claudeCodeTokens"),
            rows: [
                t(language, "widgetSnapshot.input"),
                t(language, "widgetSnapshot.output"),
                t(language, "common.cache"),
            ],
            input: format_tokens(totals.input, language),
            output: format_tokens(totals.output, language),
            cache: format_tokens(cache, language),
            total: format_tokens(total, language),
            cost: cost_text,
            change: today
                .change
                .map(|c| format_change(c, language))
                .unwrap_or_default(),
            status: match state {
                WidgetState::Scanning => translate(
                    language,
                    "widgetSnapshot.scan",
                    &Args::new().set("percent", percent),
                ),
                WidgetState::Empty => no_tokens.clone(),
                WidgetState::Data => String::new(),
            },
            empty: no_tokens,
            stale: translate(
                language,
                "widgetSnapshot.lastUpdated",
                &Args::new().set("timeOf", time_of(now, zone)),
            ),
            tokens: format!("{} {token_word}", format_tokens(total, language)),
            today_line: translate(
                language,
                "widgetSnapshot.totalToday",
                &Args::new().set("costTokens", cost_tokens.as_str()),
            ),
            cost_tokens,
            api_title: t(language, "widgetSnapshot.todayApiValue"),
            others: t(language, "widgetSnapshot.otherAccounts"),
            today_word: t(language, "widgetSnapshot.today"),
            in_claude: t(language, "widgetSnapshot.openInClaude"),
            suggested: t(language, "widgetSnapshot.suggested"),
            all_today: t(language, "widgetSnapshot.todayAllAccounts"),
            switch: t(language, "common.switch"),
            left: t(language, "widgetSnapshot.left"),
            no_active: t(language, "widgetSnapshot.noSavedAccountIsOpen"),
        },
    }
}

struct AccountsPart {
    active: Option<WidgetActive>,
    accounts: Vec<WidgetOther>,
    series: Vec<WidgetSeries>,
    split: Vec<WidgetSplitPart>,
    week: Option<WidgetWeek>,
}

fn cell_cost(c: &TokenCell) -> f64 {
    c.counts.cost.unwrap_or(0.0)
}

/// The accounts, the stacked bars' series, today's split and the week.
fn build_accounts(
    input: &WidgetSnapshotInput<'_>,
    money: &dyn Fn(f64, bool) -> String,
) -> AccountsPart {
    let WidgetSnapshotInput {
        limits,
        language,
        zone,
        now,
        today,
        ..
    } = *input;
    let lang = language;
    let days: Vec<&TokenDay> = input
        .days
        .unwrap_or(&[])
        .iter()
        .filter(|d| d.date.as_str() <= today.date.as_str())
        .collect();
    let empty_row = JsMap::new();
    let today_row: &JsMap<TokenCell> = days
        .iter()
        .find(|d| d.date == today.date)
        .map_or(&empty_row, |d| &d.by_row);
    let all: &[Account] = limits.map_or(&[], |l| l.accounts);
    let active_index = all
        .iter()
        .position(|a| limits.and_then(|l| l.active_id) == Some(a.id.as_str()));
    let active = active_index.map(|i| &all[i]);
    let pct = |value: Option<f64>| format_percent(value, lang);

    // Series: the active account first, then Relay's order, by cost in the days shown.
    let mut spent: Vec<(String, f64)> = Vec::new();
    for day in &days {
        for (key, counts) in &day.by_row {
            match spent.iter_mut().find(|(k, _)| k == key) {
                Some((_, v)) => *v += cell_cost(counts),
                None => spent.push((key.clone(), cell_cost(counts))),
            }
        }
    }
    let spent_of = |id: &str| spent.iter().find(|(k, _)| k == id).map_or(0.0, |(_, v)| *v);
    let ordered: Vec<&Account> = active
        .into_iter()
        .chain(
            all.iter()
                .enumerate()
                .filter(|(i, _)| Some(*i) != active_index)
                .map(|(_, a)| a),
        )
        .collect();
    let own: Vec<&Account> = ordered
        .into_iter()
        .filter(|a| spent_of(&a.id) > 0.0)
        .take(WIDGET_SERIES)
        .collect();
    let mut series: Vec<WidgetSeries> = own
        .iter()
        .enumerate()
        .map(|(color, a)| WidgetSeries {
            key: a.id.clone(),
            name: a.name.clone(),
            color,
        })
        .collect();
    let rest_spent = spent
        .iter()
        .any(|(key, value)| *value > 0.0 && !own.iter().any(|a| &a.id == key));
    if rest_spent {
        series.push(WidgetSeries {
            key: WIDGET_REST_KEY.into(),
            name: t(lang, "widgetSnapshot.other"),
            color: WIDGET_SERIES,
        });
    }
    let series_of = |key: &str| {
        series
            .iter()
            .position(|s| s.key == key)
            .or_else(|| series.iter().position(|s| s.key == WIDGET_REST_KEY))
    };
    let color_of = |key: &str| {
        series
            .iter()
            .find(|s| s.key == key)
            .map_or(WIDGET_SERIES, |s| s.color)
    };
    let byseries = |by_row: &JsMap<TokenCell>| {
        let mut parts = vec![0.0; series.len()];
        for (key, counts) in by_row {
            if let Some(i) = series_of(key) {
                parts[i] += cell_cost(counts);
            }
        }
        parts
    };

    let line = |account: &Account| -> WidgetAccount<WidgetAccountText> {
        let known = limits_of(account, limits.and_then(|l| l.usage.get(&account.id)), now);
        let counts = today_row.get(&account.id);
        let cost = counts.map_or(0.0, cell_cost);
        let tokens = tokens_of(counts.map(|c| &c.counts));
        let cost_text = money(
            cost,
            counts.and_then(|c| c.counts.cost_estimated) == Some(true),
        );
        let tokens_text = format_tokens(tokens, lang);
        WidgetAccount {
            id: account.id.clone(),
            name: account.name.clone(),
            five_hour: known.five_hour,
            week: known.week,
            five_hour_resets_at: known.five_hour_resets_at,
            cost,
            tokens,
            color: color_of(&account.id),
            text: WidgetAccountText {
                five_hour: pct(known.five_hour),
                week: pct(known.week),
                limits: format!("{} / {}", pct(known.five_hour), pct(known.week)),
                cost_tokens: format!("{cost_text} · {tokens_text}"),
                cost: cost_text,
                tokens: tokens_text,
                left: widget_countdown(known.five_hour_resets_at, now),
                week_reset: known.week_resets_at.map_or_else(String::new, |at| {
                    format!("{} {}", weekday_of(at, zone, lang), time_of(at, zone))
                }),
                week_short: known.week.map_or_else(String::new, |week| {
                    translate(
                        lang,
                        "widgetSnapshot.week",
                        &Args::new().set("pct", pct(Some(week))),
                    )
                }),
            },
        }
    };

    let mut active_line: Option<WidgetActive> = None;
    if let (Some(_), Some(active)) = (limits, active) {
        let base = line(active);
        let week = base.week;
        let text = base.text.clone();
        let week_line = match week {
            None => String::new(),
            Some(week) if !text.week_reset.is_empty() => translate(
                lang,
                "widgetSnapshot.weekRenews",
                &Args::new()
                    .set("pct", pct(Some(week)))
                    .set("weekReset", text.week_reset.as_str())
                    .set(
                        "weekResetLocative",
                        trailing_clock_locative(&text.week_reset),
                    ),
            ),
            Some(week) => translate(
                lang,
                "widgetSnapshot.week2",
                &Args::new().set("pct", pct(Some(week))),
            ),
        };
        active_line = Some(WidgetAccount {
            text: WidgetActiveText {
                cost_chip: translate(
                    lang,
                    "widgetSnapshot.today2",
                    &Args::new().set("textCost", text.cost.as_str()),
                ),
                tokens_chip: format!("{} {}", text.tokens, t(lang, "widgetSnapshot.tokens")),
                week_line,
                base: text,
            },
            id: base.id,
            name: base.name,
            five_hour: base.five_hour,
            week: base.week,
            five_hour_resets_at: base.five_hour_resets_at,
            cost: base.cost,
            tokens: base.tokens,
            color: base.color,
        });
    }

    let mut others: Vec<WidgetOther> = Vec::new();
    if let Some(limits) = limits {
        let suggestion =
            suggested_account(active, all, limits.usage, limits.settings, now, limits.rate)
                .map(|a| a.id.clone());
        // The panel's ranking and badge (src/panel/PanelAccounts.tsx `panelRows`).
        let mut rows = overview_accounts(
            active,
            all,
            limits.usage,
            now,
            limits.rate,
            &HashSet::new(),
            limits.settings.auto_switch_strategy,
        );
        if let Some(id) = &suggestion {
            for row in &mut rows {
                row.recommended = &row.account.id == id;
            }
        }
        let chosen = rows
            .iter()
            .filter(|r| r.recommended)
            .chain(rows.iter().filter(|r| !r.recommended))
            .take(WIDGET_OTHER_ACCOUNTS);
        for row in chosen {
            let account = row.account;
            let base = line(account);
            let linked = account
                .desktop
                .as_ref()
                .is_some_and(|d| !d.account_uuid.is_empty() && !d.org_id.is_empty())
                && !desktop_cli_mismatch(account);
            let switchable =
                linked && matches!(row.state, OverviewState::Ready | OverviewState::WindowOpen);
            let figure = match base.five_hour {
                None => String::new(),
                Some(_) => format!(" · {}", base.text.five_hour),
            };
            let switch_to = translate(
                lang,
                "widgetSnapshot.switchTo",
                &Args::new()
                    .set("accountName", account.name.as_str())
                    .set("figure", figure)
                    .set("accountNameDative", with_dative(&account.name)),
            );
            others.push(WidgetOther {
                account: WidgetAccount {
                    id: base.id,
                    name: base.name,
                    five_hour: base.five_hour,
                    week: base.week,
                    five_hour_resets_at: base.five_hour_resets_at,
                    cost: base.cost,
                    tokens: base.tokens,
                    color: base.color,
                    text: WidgetOtherText {
                        base: base.text,
                        switch_to,
                    },
                },
                suggested: row.recommended,
                switchable,
                link: switchable.then(|| relay_switch_link(&account.id)),
            });
        }
    }

    let today_cost = today_row.values().fold(0.0, |sum, c| sum + cell_cost(c));
    let split: Vec<WidgetSplitPart> = if today_cost > 0.0 {
        let costs = byseries(today_row);
        series
            .iter()
            .zip(costs)
            .filter(|(_, cost)| *cost > 0.0)
            .map(|(s, cost)| WidgetSplitPart {
                series: s.clone(),
                cost,
                share: cost / today_cost,
                text: WidgetCostText {
                    cost: money(cost, false),
                },
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut week: Option<WidgetWeek> = None;
    if !days.is_empty() {
        let rows: Vec<WidgetDay> = days
            .iter()
            .map(|d| WidgetDay {
                date: d.date.clone(),
                label: day_label(&d.date, lang),
                today: d.date == today.date,
                cost: d.by_row.values().fold(0.0, |sum, c| sum + cell_cost(c)),
                parts: byseries(&d.by_row),
            })
            .collect();
        let cost = rows.iter().fold(0.0, |sum, d| sum + d.cost);
        let tokens = days.iter().fold(0.0, |sum, d| {
            sum + d
                .by_row
                .values()
                .fold(0.0, |s, c| s + tokens_of(Some(&c.counts)))
        });
        let average = cost / rows.len() as f64;
        let busiest = rows.iter().fold(None::<&WidgetDay>, |best, d| {
            if d.cost > best.map_or(0.0, |b| b.cost) {
                Some(d)
            } else {
                best
            }
        });
        let active_week = match &active_line {
            Some(a) if a.week.is_some() => format!("{} · {}", a.name, a.text.base.week_short),
            _ => String::new(),
        };
        let hits = input.hits;
        let mut pairs = vec![WidgetPair {
            label: t(lang, "widgetSnapshot.perDay"),
            figure: Some(money(average, false)),
        }];
        if let Some(b) = busiest {
            pairs.push(WidgetPair {
                label: translate(
                    lang,
                    "widgetSnapshot.busiestDay",
                    &Args::new().set("busiestLabel", b.label.as_str()),
                ),
                figure: Some(money(b.cost, false)),
            });
        }
        match hits {
            None => {}
            Some(0.0) => pairs.push(WidgetPair {
                label: t(lang, "widgetSnapshot.noLimitReached"),
                figure: None,
            }),
            Some(h) => pairs.push(WidgetPair {
                label: t(lang, "widgetSnapshot.limitReachedLabel"),
                figure: Some(translate(
                    lang,
                    "widgetSnapshot.limitReachedTimes",
                    &Args::new().set("hits", h),
                )),
            }),
        }
        let text = WidgetWeekText {
            title: t(lang, "widgetSnapshot.last7Days"),
            cost: money(cost, false),
            tokens: format!(
                "{} {}",
                format_tokens(tokens, lang),
                t(lang, "widgetSnapshot.tokens")
            ),
            average: translate(
                lang,
                "widgetSnapshot.aDay",
                &Args::new().set("money", money(average, false)),
            ),
            busiest: busiest.map_or_else(String::new, |b| {
                translate(
                    lang,
                    "widgetSnapshot.busiest",
                    &Args::new()
                        .set("busiestLabel", b.label.as_str())
                        .set("money", money(b.cost, false)),
                )
            }),
            hits: match hits {
                None => String::new(),
                Some(0.0) => t(lang, "widgetSnapshot.noLimitReached"),
                Some(h) => translate(
                    lang,
                    "widgetSnapshot.limitReached",
                    &Args::new().set("inputHits", h),
                ),
            },
            active_week,
            pairs,
        };
        week = Some(WidgetWeek {
            days: rows,
            cost,
            tokens,
            average,
            hits,
            text,
        });
    }

    AccountsPart {
        active: active_line,
        accounts: others,
        series,
        split,
        week,
    }
}

/// `text.replace(/\d{1,2}:\d{2}$/, (c) => clockLocative(c))`.
fn trailing_clock_locative(text: &str) -> String {
    let b = text.as_bytes();
    let n = b.len();
    if n < 4
        || !b[n - 2..].iter().all(u8::is_ascii_digit)
        || b[n - 3] != b':'
        || !b[n - 4].is_ascii_digit()
    {
        return text.to_string();
    }
    let start = if n >= 5 && b[n - 5].is_ascii_digit() {
        n - 5
    } else {
        n - 4
    };
    format!("{}{}", &text[..start], clock_locative(&text[start..]))
}

// The panel's ranking (`src/data/selectors.ts`), as the widget lists the other accounts.

literal_enum!(OverviewState {
    Ready = "ready",
    WindowOpen = "window-open",
    Exhausted = "exhausted",
    NotLinked = "not-linked",
    Unknown = "unknown",
});

/// One account of the panel's list.
#[derive(Debug, Clone, PartialEq)]
pub struct OverviewRow<'a> {
    pub account: &'a Account,
    pub usage: Option<&'a AccountUsage>,
    pub state: OverviewState,
    pub available_at: Option<String>,
    pub recommended: bool,
}

/// `limitFull`: a fresh reading with a window used up gives when the account opens again (the
/// latest of those windows' resets, `Some(None)` when none is known); `None` while no window is
/// full. A model's own window does not count: the other models still answer.
pub fn limit_full(u: Option<&AccountUsage>, now: f64) -> Option<Option<String>> {
    if !fresh_usage(u, now) {
        return None;
    }
    let full: Vec<_> = quota_windows(u)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| w.used_percent >= 100.0)
        .collect();
    if full.is_empty() {
        return None;
    }
    // By time: the same instant can be written with different offsets or precision.
    let mut resets: Vec<&str> = full
        .iter()
        .filter_map(|w| w.resets_at.as_deref())
        .filter(|r| !r.is_empty() && date_parse(r).is_finite())
        .collect();
    sort_by(&mut resets, |a, b| date_parse(a) - date_parse(b));
    Some(resets.last().map(|r| r.to_string()))
}

/// `modelLimitFull`: the model windows of a fresh reading that are used up.
pub fn model_limit_full(u: Option<&AccountUsage>, now: f64) -> Vec<&ModelWindow> {
    if fresh_usage(u, now) {
        spent_model_windows(u, now)
    } else {
        Vec::new()
    }
}

/// `overviewAccounts`: the other accounts best first, by the switch rule (`rate`: the tempo, Pro
/// units per hour; `strategy`: Settings → Switching's). One open in its own Claude window
/// (`in_windows`, by id) cannot be switched to, so it is never recommended.
pub fn overview_accounts<'a>(
    active: Option<&Account>,
    accounts: &'a [Account],
    usage: &'a JsMap<AccountUsage>,
    now: f64,
    rate: Option<f64>,
    in_windows: &HashSet<String>,
    strategy: Option<AutoSwitchStrategy>,
) -> Vec<OverviewRow<'a>> {
    let candidates: Vec<ContinuationTargetCandidate<'a>> = accounts
        .iter()
        .filter(|a| Some(a.id.as_str()) != active.map(|a| a.id.as_str()))
        .map(|account| ContinuationTargetCandidate {
            account,
            usage: usage.get(&account.id),
        })
        .collect();
    let ranked = rank_continuation_targets(
        &candidates,
        Some(RankingContext {
            now,
            rate,
            strategy,
        }),
    );
    // Only a Claude account is switched to in the Claude app; Codex and Antigravity accounts feed
    // the gateway.
    let claude =
        |a: &Account| a.provider.unwrap_or(AccountProvider::Claude) == AccountProvider::Claude;
    let order = ranked
        .iter()
        .filter(|r| claude(r.account) && r.account.desktop.is_some())
        .chain(ranked.iter().filter(|r| !claude(r.account)))
        .chain(
            ranked
                .iter()
                .filter(|r| claude(r.account) && r.account.desktop.is_none()),
        );
    let mut rows: Vec<OverviewRow<'a>> = order
        .map(|r| {
            let account = r.account;
            let u = usage.get(&account.id);
            let mut available_at = None;
            let state = if claude(account) && account.desktop.is_none() {
                OverviewState::NotLinked
            } else if !fresh_usage(u, now) {
                OverviewState::Unknown
            } else if let Some(at) = limit_full(u, now) {
                available_at = at;
                OverviewState::Exhausted
            // Antigravity has no five-hour period: its five-hour window is only its roomiest model.
            } else if !model_only_usage(u)
                && u.and_then(|u| u.five_hour.as_ref())
                    .and_then(|w| w.resets_at.as_deref())
                    .is_some_and(|at| !at.is_empty() && date_parse(at) > now)
            {
                OverviewState::WindowOpen
            } else {
                OverviewState::Ready
            };
            OverviewRow {
                account,
                usage: u,
                state,
                available_at,
                recommended: false,
            }
        })
        .collect();
    let pickable: Vec<usize> = (0..rows.len())
        .filter(|&i| {
            let r = &rows[i];
            claude(r.account)
                && !in_windows.contains(&r.account.id)
                && matches!(r.state, OverviewState::Ready | OverviewState::WindowOpen)
        })
        .collect();
    // A spent model limit (Fable's week) leaves the account usable: it is recommended only when no
    // other is clear.
    let pick = pickable
        .iter()
        .copied()
        .find(|&i| model_limit_full(rows[i].usage, now).is_empty())
        .or_else(|| pickable.first().copied());
    if let Some(i) = pick {
        rows[i].recommended = true;
    }
    rows
}

/// What the widget would draw differently: a new file whose key is unchanged needs no reload.
/// `generatedAt`, the stale line and the countdowns move on every write; the widget counts down
/// by itself from the reset time.
pub fn widget_visible_key(snapshot: &WidgetSnapshot) -> String {
    let mut text = value(&snapshot.text);
    if let Value::Object(map) = &mut text {
        map.shift_remove("stale");
    }
    let account = |a: Value, resets_at: Option<f64>| -> Value {
        let Value::Object(mut shown) = a else {
            return a;
        };
        let mut rest = shown.get("text").cloned().unwrap_or(Value::Null);
        if let Value::Object(t) = &mut rest {
            t.shift_remove("left");
        }
        // Costs and tokens are drawn from their text.
        shown.shift_remove("cost");
        shown.shift_remove("tokens");
        // The minute the window renews: a new window moves it by hours.
        shown.insert(
            "fiveHourResetsAt".into(),
            resets_at.map_or(Value::Null, |at| num(round(at / 60_000.0))),
        );
        shown.insert("text".into(), rest);
        Value::Object(shown)
    };
    let cents = |v: f64| num(round(v * 100.0));
    let key = json!([
        snapshot.date,
        snapshot.state,
        snapshot.mood,
        text,
        snapshot
            .slots
            .iter()
            .map(|v| v.map_or(Value::Null, cents))
            .collect::<Vec<_>>(),
        snapshot.yesterday_average.map_or(Value::Null, cents),
        snapshot
            .active
            .as_ref()
            .map_or(Value::Null, |a| account(value(a), a.five_hour_resets_at)),
        snapshot
            .accounts
            .iter()
            .map(|a| account(value(a), a.account.five_hour_resets_at))
            .collect::<Vec<_>>(),
        value(&snapshot.series),
        snapshot
            .split
            .iter()
            .map(|p| json!([p.series.key, p.text.cost]))
            .collect::<Vec<_>>(),
        snapshot.week.as_ref().map_or(Value::Null, |w| {
            json!([
                value(&w.text),
                w.days
                    .iter()
                    .map(|d| json!([
                        d.label,
                        d.parts.iter().map(|p| cents(*p)).collect::<Vec<_>>()
                    ]))
                    .collect::<Vec<_>>()
            ])
        }),
    ]);
    serde_json::to_string(&key).unwrap_or_default()
}

/// A number as `JSON.stringify` writes it.
fn num(value: f64) -> Value {
    serde_json::to_value(Num(value)).unwrap_or(Value::Null)
}

fn value<T: Serialize + ?Sized>(part: &T) -> Value {
    serde_json::to_value(part).unwrap_or(Value::Null)
}
