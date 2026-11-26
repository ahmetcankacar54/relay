//! Port of `shared/tray.ts`: the menu bar item's title and tooltip, and the tray menu, from a tray
//! snapshot. The `Intl` number and clock formats it uses are ported for Relay's format locales.

use std::borrow::Cow;

use relay_i18n::{Args, Locale, translate};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::account_state::desktop_cli_mismatch;
use super::mascot::{HUNGRY_PERCENT, MascotInput, MascotRest, active_reading, mascot_rest};
use super::number_format::{Decimal, body, format_cost, symbols};
use super::percent::{format_percent, percent_used};
use super::planning::{local_date, local_parts, system_time_zone};
use super::time_zones::valid_time_zone;
use super::tr_dative::clock_locative;
use super::types::js::{JsMap, date_parse, iso, max, ser_num, trim};
use super::types::{
    Account, AccountUsage, DesktopState, MenuBarItem, UsageStatus, UsageWindow, WindowAttempt,
};
use super::usage::{fresh_usage, last_known_usage, window_holds};

/// Today so far across all accounts and terminals, from the token ledger once its first pass is
/// done.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayToday {
    /// The planning-zone date the figures are for.
    pub date: String,
    /// Every kind of token: input, output and cache.
    #[serde(serialize_with = "ser_num")]
    pub tokens: f64,
    /// Their API value, in USD.
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
    /// Part of the cost was estimated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_estimated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySnapshot {
    pub accounts: Vec<Account>,
    pub usage: JsMap<AccountUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<DesktopState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_busy: Option<bool>,
    /// The keeper's recent window starts, for the menu bar panda.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<Vec<WindowAttempt>>,
    /// The account a running Desktop switch opens; the title names it while Desktop is busy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switching_to: Option<String>,
    /// The planning time zone, for the clock a full window reopens at; the system's when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    /// What the title shows, in order; the five-hour percent alone when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_items: Option<Vec<MenuBarItem>>,
    /// Today's tokens and API value, for the title's items that show them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub today: Option<TrayToday>,
}

impl TraySnapshot {
    /// The parts the panda reads (`MascotInput`, which the TS snapshot also is).
    pub fn mascot_input(&self) -> MascotInput<'_> {
        MascotInput {
            accounts: &self.accounts,
            usage: &self.usage,
            desktop: self.desktop.as_ref(),
            attempts: self.attempts.as_deref(),
        }
    }
}

impl<'a> From<&'a TraySnapshot> for MascotInput<'a> {
    fn from(snapshot: &'a TraySnapshot) -> Self {
        snapshot.mascot_input()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum TrayCommand {
    Show,
    #[serde(rename_all = "camelCase")]
    ReviewSwitch {
        profile_id: String,
    },
    Quit,
}

/// A row of a menu item (`normal` or `checkbox`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrayMenuEntry {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<TrayCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TrayMenuItem {
    Separator,
    Normal(TrayMenuEntry),
    Checkbox(TrayMenuEntry),
}

impl TrayMenuItem {
    /// The row of a `normal` or `checkbox` item.
    pub fn entry(&self) -> Option<&TrayMenuEntry> {
        match self {
            TrayMenuItem::Separator => None,
            TrayMenuItem::Normal(entry) | TrayMenuItem::Checkbox(entry) => Some(entry),
        }
    }
}

const SHOW: &str = "common.openRelay";
const QUIT: &str = "appMenu.quitRelay";
const UNKNOWN_ACTIVE: &str = "tray.noSavedAccountActive";
const EMPTY: &str = "tray.addAnAccountInRelay";
const REVIEW: &str = "tray.selectAnAccountToSwitch";
const UNAVAILABLE: &str = "tray.claudeAppNotFound";
const STATUS_UNAVAILABLE: &str = "tray.claudeAppStatusUnavailable";
const LOADING: &str = "tray.relayChecksTheClaudeApp";
const BUSY: &str = "tray.aClaudeAppActionIsRunning";
const PENDING: &str = "tray.finishTheClaudeAppSignIn";
const AUTH_BUSY: &str = "tray.finishTheUsageSignInFirst";
const RECOVERY: &str = "tray.restoreTheBackupFirst";
const UNLINKED: &str = "common.saveClaudeAppSignIn";
const MISMATCH: &str = "tray.signInsBelongToDifferentAccounts";
const OUTDATED: &str = "tray.usageDataIsOutOfDate";
const FIVE_HOUR: &str = "tray.n5H";
const WEEK: &str = "tray.week";

fn t(language: Locale, id: &str) -> String {
    translate(language, id, &Args::new())
}

fn normal(label: String, enabled: bool, command: Option<TrayCommand>) -> TrayMenuItem {
    TrayMenuItem::Normal(TrayMenuEntry {
        label,
        checked: None,
        enabled,
        command,
    })
}

/// `name.replace(/[\r\n\t]/g, " ")`.
fn one_line(name: &str) -> String {
    name.replace(['\r', '\n', '\t'], " ")
}

/// Native menus interpret ampersands as access keys on some platforms. Keep user-provided names
/// readable and prevent line breaks from adding false rows.
pub fn tray_account_name(name: &str) -> String {
    one_line(name).replace('&', "&&")
}

/// The percent used of a window, without its word ("94%"); "?" for a reading that cannot be right.
fn quota_used(used: Option<f64>, language: Locale) -> String {
    match used {
        Some(used) if used.is_finite() && (0.0..=100.0).contains(&used) => {
            format_percent(percent_used(Some(used)), language)
        }
        _ => "?".into(),
    }
}

/// An account's two windows for its menu row ("5 h 22% · week 92% used"). A reading that is old
/// only because the service could not be reached keeps its figures, marked as last known, until
/// each window resets ("5 h ~22% · week ~92% used · usage data is out of date").
pub fn tray_usage_label(
    account_id: &str,
    usage: Option<&AccountUsage>,
    language: Locale,
    now: f64,
) -> String {
    let own = usage.is_some_and(|u| u.account_id == account_id);
    let fresh = own
        && fresh_usage(usage, now)
        && date_parse(usage.and_then(|u| u.checked_at.as_deref()).unwrap_or("")) <= now + 60_000.0;
    let five_label = t(language, FIVE_HOUR);
    let week_label = t(language, WEEK);
    let shown = fresh || (own && last_known_usage(usage, now));
    let Some(usage) = usage.filter(|_| shown) else {
        let read = usage
            .and_then(|u| u.checked_at.as_deref())
            .is_some_and(|c| !c.is_empty());
        let outdated = if read {
            format!(" · {}", t(language, OUTDATED))
        } else {
            String::new()
        };
        return format!("{five_label} ? · {week_label} ?{outdated}");
    };
    let figure = |window: Option<&UsageWindow>| {
        if !fresh && !window_holds(window, now) {
            return "?".to_string();
        }
        let used = quota_used(window.map(|w| w.used_percent), language);
        if fresh || used == "?" {
            used
        } else {
            format!("{LAST_KNOWN_MARK}{used}")
        }
    };
    let five = figure(usage.five_hour.as_ref());
    let week = figure(usage.seven_day.as_ref());
    // One word covers both figures; with nothing to describe it is left out.
    let line = if five == "?" && week == "?" {
        format!("{five_label} ? · {week_label} ?")
    } else {
        translate(
            language,
            "tray.usageLine",
            &Args::new()
                .set("fiveLabel", five_label)
                .set("weekLabel", week_label)
                .set("five", five)
                .set("week", week),
        )
    };
    if fresh {
        line
    } else {
        format!("{line} · {}", t(language, OUTDATED))
    }
}

fn blocked_label(snapshot: &TraySnapshot, language: Locale) -> Option<String> {
    let Some(desktop) = &snapshot.desktop else {
        return Some(t(language, LOADING));
    };
    let id = if desktop.recovery_required {
        RECOVERY
    } else if desktop.busy {
        BUSY
    } else if desktop
        .pending_profile_id
        .as_deref()
        .is_some_and(|p| !p.is_empty())
    {
        PENDING
    } else if snapshot.auth_busy == Some(true) {
        AUTH_BUSY
    } else if !desktop.available {
        UNAVAILABLE
    } else {
        return None;
    };
    Some(t(language, id))
}

/// The account has a saved Claude app identity.
fn connected(account: &Account) -> bool {
    account
        .desktop
        .as_ref()
        .is_some_and(|d| !d.account_uuid.is_empty() && !d.org_id.is_empty())
}

pub fn can_request_tray_switch(snapshot: &TraySnapshot, profile_id: &str) -> bool {
    let account = snapshot.accounts.iter().find(|a| a.id == profile_id);
    blocked_label(snapshot, Locale::En).is_none()
        && account.is_some_and(|a| connected(a) && !desktop_cli_mismatch(a))
        && snapshot
            .desktop
            .as_ref()
            .and_then(|d| d.active_profile_id.as_deref())
            != Some(profile_id)
}

/// The menu when a snapshot could not be read: opening Relay and quitting stay; no account action
/// is offered against unknown Claude app state.
pub fn unavailable_tray_menu(language: Locale) -> Vec<TrayMenuItem> {
    vec![
        normal(t(language, SHOW), true, Some(TrayCommand::Show)),
        normal(t(language, STATUS_UNAVAILABLE), false, None),
        TrayMenuItem::Separator,
        normal(t(language, QUIT), true, Some(TrayCommand::Quit)),
    ]
}

fn active_profile_id(snapshot: &TraySnapshot) -> Option<&str> {
    snapshot
        .desktop
        .as_ref()
        .and_then(|d| d.active_profile_id.as_deref())
}

fn active_account(snapshot: &TraySnapshot) -> Option<&Account> {
    let id = active_profile_id(snapshot)?;
    snapshot.accounts.iter().find(|a| a.id == id)
}

/// These commands only open a review. Executing a Desktop switch is deliberately outside this
/// menu's contract and remains behind Relay's restart confirmation.
pub fn build_tray_menu(snapshot: &TraySnapshot, language: Locale, now: f64) -> Vec<TrayMenuItem> {
    let active = active_account(snapshot);
    let blocked = blocked_label(snapshot, language);
    let mut menu = vec![
        normal(t(language, SHOW), true, Some(TrayCommand::Show)),
        normal(
            match active {
                Some(active) => translate(
                    language,
                    "tray.activeName",
                    &Args::new().set("name", tray_account_name(&active.name)),
                ),
                None => t(language, UNKNOWN_ACTIVE),
            },
            false,
            None,
        ),
        TrayMenuItem::Separator,
        normal(blocked.unwrap_or_else(|| t(language, REVIEW)), false, None),
    ];
    for account in &snapshot.accounts {
        let detail = if !connected(account) {
            t(language, UNLINKED)
        } else if desktop_cli_mismatch(account) {
            t(language, MISMATCH)
        } else {
            tray_usage_label(&account.id, snapshot.usage.get(&account.id), language, now)
        };
        let enabled = can_request_tray_switch(snapshot, &account.id);
        menu.push(TrayMenuItem::Checkbox(TrayMenuEntry {
            label: format!("{} · {detail}", tray_account_name(&account.name)),
            checked: Some(active_profile_id(snapshot) == Some(account.id.as_str())),
            enabled,
            command: enabled.then(|| TrayCommand::ReviewSwitch {
                profile_id: account.id.clone(),
            }),
        }));
    }
    if snapshot.accounts.is_empty() {
        menu.push(normal(t(language, EMPTY), false, None));
    }
    menu.push(TrayMenuItem::Separator);
    menu.push(normal(t(language, QUIT), true, Some(TrayCommand::Quit)));
    menu
}

/// Every item the title can show, in the order Settings lists them.
pub const MENU_BAR_ITEMS: [MenuBarItem; 6] = [
    MenuBarItem::FiveHour,
    MenuBarItem::Week,
    MenuBarItem::Reset,
    MenuBarItem::Tokens,
    MenuBarItem::Cost,
    MenuBarItem::Account,
];
/// The title Relay has always shown: the five-hour percent, with its reset once it matters.
pub const DEFAULT_MENU_BAR_ITEMS: [MenuBarItem; 1] = [MenuBarItem::FiveHour];
/// At most this many items: macOS hides a status item that no longer fits, the panda with it.
pub const MENU_BAR_MAX_ITEMS: usize = 4;

/// The title's items as kept: known ones, each once, at most MENU_BAR_MAX_ITEMS in the order
/// given; anything that is not a list (`None` = undefined) is the default. An empty list leaves
/// the panda alone.
pub fn menu_bar_items(value: Option<&Value>) -> Vec<MenuBarItem> {
    let Some(Value::Array(values)) = value else {
        return DEFAULT_MENU_BAR_ITEMS.to_vec();
    };
    let mut items: Vec<MenuBarItem> = Vec::new();
    for value in values {
        let known = value
            .as_str()
            .and_then(|text| MENU_BAR_ITEMS.into_iter().find(|i| i.as_str() == text));
        if let Some(item) = known.filter(|item| !items.contains(item)) {
            items.push(item);
        }
    }
    items.truncate(MENU_BAR_MAX_ITEMS);
    items
}

/// The mark before a figure kept from the last reading while a newer one cannot be read.
pub const LAST_KNOWN_MARK: &str = "~";
/// Between the title's parts; with thin spaces once there are more than three, so the item stays
/// short.
const SEPARATOR: &str = " · ";
const NARROW_SEPARATOR: &str = "\u{2009}·\u{2009}";

/// The Desktop-active account's reading for the title.
struct TitleReading<'a> {
    usage: Cow<'a, AccountUsage>,
    /// The last known one, not fresh.
    stale: bool,
}

/// The Desktop-active account's reading for the title: fresh as the panda reads it, else the last
/// known one (`stale`) while only a passing issue or its age keeps it from being fresh. Each of
/// its windows counts until it resets (`held_window`).
fn title_reading(snapshot: &TraySnapshot, now: f64) -> Option<TitleReading<'_>> {
    let active = active_account(snapshot)?;
    if let Some(fresh) = active_reading(snapshot.mascot_input(), now) {
        return Some(TitleReading {
            usage: fresh,
            stale: false,
        });
    }
    let u = snapshot.usage.get(&active.id)?;
    last_known_usage(Some(u), now).then_some(TitleReading {
        usage: Cow::Borrowed(u),
        stale: true,
    })
}

/// A window of the title's reading, while it holds.
fn held_window<'r>(
    reading: Option<&'r TitleReading<'_>>,
    week: bool,
    now: f64,
) -> Option<&'r UsageWindow> {
    let usage = &reading?.usage;
    let window = if week {
        usage.seven_day.as_ref()
    } else {
        usage.five_hour.as_ref()
    };
    window.filter(|w| window_holds(Some(w), now))
}

/// Today's figures, while they are still today's in the planning time zone.
fn today_figures(snapshot: &TraySnapshot, now: f64) -> Option<&TrayToday> {
    let today = snapshot.today.as_ref()?;
    let zone = snapshot.time_zone.clone().unwrap_or_else(system_time_zone);
    // An unknown zone makes the TS `Intl` throw: no figures then.
    if !valid_time_zone(&zone) {
        return None;
    }
    (local_date(now, &zone) == today.date).then_some(today)
}

/// `Math.max(0, value)` of a finite value, else 0.
fn non_negative(value: f64) -> f64 {
    max([0.0, if value.is_finite() { value } else { 0.0 }])
}

/// Tokens in millions, short: "12,4M" / "12.4M"; whole millions from 100M ("184M"); from a
/// billion, billions ("1,8Mr" / "1.8B"; "milyar" in Turkish, where B would read as "bin"), so a
/// busy day's cache reads never make the menu bar title long.
pub fn tray_tokens(tokens: f64, language: Locale) -> String {
    let count = non_negative(tokens);
    let billions = count >= 999.5e6;
    let value = if billions { count / 1e9 } else { count / 1e6 };
    let digits = if value < 99.95 { 1 } else { 0 };
    let symbols = symbols(language);
    let mut decimal = Decimal::from_f64(value);
    decimal.round(digits);
    let text = body(&decimal, digits, true, symbols.min_grouping, &symbols);
    translate(
        language,
        if billions {
            "tray.billions"
        } else {
            "tray.millions"
        },
        &Args::new().set("value", text),
    )
}

/// Where the dollar sign goes in a locale's currency pattern (`narrowSymbol`).
fn currency_affixes(locale: Locale) -> (&'static str, &'static str) {
    match locale {
        Locale::En | Locale::Tr | Locale::Ja | Locale::Ko | Locale::ZhHans | Locale::ZhHant => {
            ("$", "")
        }
        Locale::PtBr | Locale::Nl => ("$\u{a0}", ""),
        Locale::De
        | Locale::Fr
        | Locale::Es
        | Locale::It
        | Locale::Ru
        | Locale::Uk
        | Locale::Pl => ("", "\u{a0}$"),
    }
}

/// An API value, short: "$18,20" / "$18.20"; whole dollars from $100 ("$184"); "≈" when partly
/// estimated.
pub fn tray_cost(cost: f64, language: Locale, estimated: bool) -> String {
    let value = non_negative(cost);
    let text = if value < 99.995 {
        format_cost(value, language)
    } else {
        let symbols = symbols(language);
        let (prefix, suffix) = currency_affixes(language);
        let mut decimal = Decimal::from_f64(value);
        decimal.round(0);
        let digits = body(&decimal, 0, true, symbols.min_grouping, &symbols);
        format!("{prefix}{digits}{suffix}")
    };
    format!("{}{text}", if estimated { "≈" } else { "" })
}

/// How long ago a reading was taken: "12 dk önce" / "12 min ago".
fn read_ago(checked_at: &str, now: f64, language: Locale) -> String {
    let minutes = max([0.0, ((now - date_parse(checked_at)) / 60_000.0).floor()]);
    if minutes == 0.0 || minutes.is_nan() {
        return t(language, "tray.justNow");
    }
    if minutes < 60.0 {
        return translate(
            language,
            "tray.minutesAgo",
            &Args::new().set("minutes", minutes),
        );
    }
    let hours = (minutes / 60.0).floor();
    if hours < 24.0 {
        return translate(language, "tray.hoursAgo", &Args::new().set("hours", hours));
    }
    translate(
        language,
        "tray.daysAgo",
        &Args::new().set("days", (hours / 24.0).floor()),
    )
}

/// From this percent used on, the menu bar also says when the five-hour window renews; the panda
/// gets hungry.
pub const TRAY_RESET_FROM: f64 = HUNGRY_PERCENT;
/// The title shows at most this many characters of the account a switch opens.
pub const TRAY_NAME_MAX: usize = 14;
/// The account item, which stays in the title, shows fewer.
pub const TRAY_ITEM_NAME_MAX: usize = 10;

/// The account a running Desktop switch opens, while Desktop is busy with it.
fn switch_target(snapshot: &TraySnapshot) -> Option<&Account> {
    if !snapshot.desktop.as_ref().is_some_and(|d| d.busy) {
        return None;
    }
    let id = snapshot
        .switching_to
        .as_deref()
        .filter(|id| !id.is_empty())?;
    snapshot.accounts.iter().find(|a| a.id == id)
}

/// `String.prototype.trimEnd`.
fn trim_end(text: &str) -> &str {
    text.trim_end_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// A name on one line, cut to `max` characters (TRAY_NAME_MAX); the "…" that follows it in the
/// title also marks the cut.
pub fn tray_short_name(name: &str, max: usize) -> String {
    let line = one_line(name);
    let chars: Vec<char> = trim(&line).chars().collect();
    if chars.len() <= max {
        return chars.into_iter().collect();
    }
    // `slice(0, max - 1)`: a max of 0 counts back from the end, as in JavaScript.
    let end = if max == 0 { chars.len() - 1 } else { max - 1 };
    let cut: String = chars[..end].iter().collect();
    trim_end(&cut).to_string()
}

/// The clock time `resets_at` comes at ("22:50"), in the time zone given or the system's; `None`
/// when past or unknown. Every format locale writes `HH:mm` (`hourCycle: "h23"`), so the
/// language does not change the text.
pub fn tray_reset_clock(
    resets_at: Option<&str>,
    now: f64,
    _language: Locale,
    time_zone: Option<&str>,
) -> Option<String> {
    let at = resets_at.map_or(f64::NAN, date_parse);
    if !at.is_finite() || at <= now {
        return None;
    }
    // An unknown zone: the system's clock is still right for the menu bar. (The TS reads an empty
    // zone the same way once its system-zone format is cached, which the first title builds.)
    let zone = match time_zone.filter(|zone| valid_time_zone(zone)) {
        Some(zone) => zone.to_string(),
        None => system_time_zone(),
    };
    let parts = local_parts(at, &zone)?;
    Some(format!("{:02}:{:02}", parts.hour, parts.minute))
}

/// Whole minutes left until `resets_at`, rounded up; `None` when past or unknown.
fn minutes_left(resets_at: Option<&str>, now: f64) -> Option<f64> {
    let at = resets_at.map_or(f64::NAN, date_parse);
    if !at.is_finite() || at <= now {
        return None;
    }
    Some(((at - now) / 60_000.0).ceil())
}

/// Time left until `resets_at` as "h:mm" ("1:50", "0:07"); `None` when past or unknown.
pub fn tray_countdown(resets_at: Option<&str>, now: f64) -> Option<String> {
    let minutes = minutes_left(resets_at, now)?;
    Some(format!(
        "{}:{:02}",
        (minutes / 60.0).floor(),
        (minutes % 60.0) as u64
    ))
}

/// Why the limit items show "—" unless a last known reading stands in: the panda sleeps. During
/// another Desktop operation Claude may be closed for a moment.
fn tray_rest(snapshot: &TraySnapshot, now: f64) -> Option<MascotRest> {
    if snapshot.desktop.as_ref().is_some_and(|d| d.busy) {
        return None;
    }
    mascot_rest(snapshot.mascot_input(), now)
}

fn title_items(snapshot: &TraySnapshot) -> &[MenuBarItem] {
    snapshot
        .title_items
        .as_deref()
        .unwrap_or(&DEFAULT_MENU_BAR_ITEMS)
}

fn resets_at(window: Option<&UsageWindow>) -> Option<&str> {
    window.and_then(|w| w.resets_at.as_deref())
}

/// The title in words: the account's name and, when known, the percent used of its five-hour
/// window with the word the title leaves out, and when the window renews (at a clock time once it
/// is full). Figures kept from the last reading carry its mark and say how old they are. It names
/// the week's percent and today's tokens and API value when the title shows them. During a switch
/// it names the account being opened; while the panda sleeps with no figure to show, why.
pub fn tray_tooltip(snapshot: &TraySnapshot, language: Locale, now: f64) -> String {
    if let Some(target) = switch_target(snapshot) {
        return translate(
            language,
            "tray.relaySwitchesTo",
            &Args::new().set("name", one_line(&target.name)),
        );
    }
    let active = active_account(snapshot);
    let items = title_items(snapshot);
    let rest = tray_rest(snapshot, now);
    let reading = if rest == Some(MascotRest::Closed) {
        None
    } else {
        title_reading(snapshot, now)
    };
    let mut parts: Vec<String> = active.map(|a| one_line(&a.name)).into_iter().collect();
    if rest == Some(MascotRest::Closed) {
        parts.push(t(language, "tray.claudeAppClosed"));
    } else if let Some(reading) = &reading {
        let mark = if reading.stale { LAST_KNOWN_MARK } else { "" };
        let window = held_window(Some(reading), false, now);
        let used = window.map(|w| w.used_percent);
        if let Some(used) = used {
            let percent = format_percent(percent_used(Some(used)), language);
            parts.push(translate(
                language,
                "tray.fiveHourUsed",
                &Args::new().set("percent", format!("{mark}{percent}")),
            ));
        }
        let clock = if percent_used(used) == Some(100.0) {
            tray_reset_clock(
                resets_at(window),
                now,
                language,
                snapshot.time_zone.as_deref(),
            )
        } else {
            None
        };
        let left = minutes_left(resets_at(window), now);
        // A full window opens again at a clock time; one with room renews after the time left.
        if let Some(clock) = clock {
            let locative = clock_locative(&clock);
            parts.push(translate(
                language,
                "tray.opensAt",
                &Args::new()
                    .set("clock", clock)
                    .set("clockLocative", locative),
            ));
        } else if let Some(left) = left {
            let left = translate(
                language,
                "tray.timeLeft",
                &Args::new()
                    .set("hours", (left / 60.0).floor())
                    .set("minutes", left % 60.0),
            );
            parts.push(translate(
                language,
                "tray.renewsIn",
                &Args::new().set("left", left),
            ));
        }
        if let Some(week) =
            held_window(Some(reading), true, now).filter(|_| items.contains(&MenuBarItem::Week))
        {
            let percent = format_percent(percent_used(Some(week.used_percent)), language);
            parts.push(translate(
                language,
                "tray.weekUsed",
                &Args::new()
                    .set("weekLabel", t(language, WEEK))
                    .set("percent", format!("{mark}{percent}")),
            ));
        }
        if reading.stale {
            let checked = reading.usage.checked_at.as_deref().unwrap_or("");
            parts.push(translate(
                language,
                "tray.usageDataIsOutOfDateRead",
                &Args::new().set("ago", read_ago(checked, now, language)),
            ));
        }
    } else if rest == Some(MascotRest::Unknown) {
        parts.push(t(language, OUTDATED));
    }
    if let Some(today) = today_figures(snapshot, now) {
        let mut figures = Vec::new();
        if items.contains(&MenuBarItem::Tokens) {
            figures.push(translate(
                language,
                "tray.tokens",
                &Args::new().set("tokens", tray_tokens(today.tokens, language)),
            ));
        }
        if items.contains(&MenuBarItem::Cost) {
            let cost = tray_cost(today.cost, language, today.cost_estimated == Some(true));
            figures.push(translate(
                language,
                "tray.apiValue",
                &Args::new().set("cost", cost),
            ));
        }
        if !figures.is_empty() {
            parts.push(translate(
                language,
                "tray.today",
                &Args::new().set("figures", figures.join(", ")),
            ));
        }
    }
    if parts.is_empty() {
        "Relay".into()
    } else {
        format!("Relay — {}", parts.join(" · "))
    }
}

/// Menu-bar text, from the items the user chose (`title_items`) in their order. By default it is
/// the percent used of the Desktop-active account's five-hour window alone, compact ("%94" /
/// "94%"; the tooltip adds the word), empty when unknown. Without the reset's own item, from 80 %
/// on, when the window's end starts to matter, the percent adds the time left until it renews
/// ("%94 · 1:50") if fewer than four items are chosen, and a full window gives the clock it
/// reopens at instead ("22:50", in the planning time zone). The other items are the week's
/// percent, the time left, today's tokens ("12,4M") and API value ("$18,20") and the account's
/// name; past three parts they are joined more narrowly.
///
/// When the last read failed only because the service could not be reached, or the reading has
/// grown old, its figures stay, each marked "~" ("~%94"), until their window resets; the panda
/// sleeps over them. With Claude closed, or limits a sign-in problem keeps unknown, the limit
/// items show one "—". While a switch runs the title names the account being opened ("Max…").
pub fn tray_title(snapshot: &TraySnapshot, now: f64, language: Locale) -> String {
    if let Some(target) = switch_target(snapshot) {
        return format!("{}…", tray_short_name(&target.name, TRAY_NAME_MAX));
    }
    let items = title_items(snapshot);
    let rest = tray_rest(snapshot, now);
    let reading = if rest == Some(MascotRest::Closed) {
        None
    } else {
        title_reading(snapshot, now)
    };
    let reading = reading.as_ref();
    // A limit item without a figure: a dash while the panda sleeps, else nothing yet.
    let missing = || -> Vec<String> {
        if rest.is_some() {
            vec!["—".into()]
        } else {
            Vec::new()
        }
    };
    let mark = |text: String| {
        if reading.is_some_and(|r| r.stale) {
            format!("{LAST_KNOWN_MARK}{text}")
        } else {
            text
        }
    };
    let five = held_window(reading, false, now);
    let five_used = percent_used(five.map(|w| w.used_percent));
    // A full window stays full until it resets, so its clock holds for a last known reading too.
    let clock = if five_used == Some(100.0) {
        tray_reset_clock(
            resets_at(five),
            now,
            language,
            snapshot.time_zone.as_deref(),
        )
    } else {
        None
    };
    let today = today_figures(snapshot, now);
    let parts: Vec<String> = items
        .iter()
        .flat_map(|item| -> Vec<String> {
            match item {
                MenuBarItem::FiveHour => {
                    let Some(five_used) = five_used else {
                        return missing();
                    };
                    let percent = mark(format_percent(Some(five_used), language));
                    // Without an item of its own, the reset joins the percent once it starts to
                    // matter, while that leaves the title at most MENU_BAR_MAX_ITEMS parts.
                    if items.contains(&MenuBarItem::Reset) {
                        return vec![percent];
                    }
                    if let Some(clock) = &clock {
                        return vec![clock.clone()];
                    }
                    let left = if five_used >= TRAY_RESET_FROM && items.len() < MENU_BAR_MAX_ITEMS {
                        tray_countdown(resets_at(five), now)
                    } else {
                        None
                    };
                    std::iter::once(percent).chain(left).collect()
                }
                MenuBarItem::Week => {
                    let used =
                        percent_used(held_window(reading, true, now).map(|w| w.used_percent));
                    match used {
                        None => missing(),
                        Some(used) => vec![mark(format_percent(Some(used), language))],
                    }
                }
                MenuBarItem::Reset => {
                    if five_used.is_none() {
                        return missing();
                    }
                    clock
                        .clone()
                        .or_else(|| tray_countdown(resets_at(five), now))
                        .into_iter()
                        .collect()
                }
                MenuBarItem::Tokens => today
                    .map(|today| tray_tokens(today.tokens, language))
                    .into_iter()
                    .collect(),
                MenuBarItem::Cost => today
                    .map(|today| {
                        tray_cost(today.cost, language, today.cost_estimated == Some(true))
                    })
                    .into_iter()
                    .collect(),
                MenuBarItem::Account => {
                    let Some(active) = active_account(snapshot) else {
                        return Vec::new();
                    };
                    let name = tray_short_name(&active.name, TRAY_ITEM_NAME_MAX);
                    let whole = name == trim(&one_line(&active.name));
                    vec![if whole { name } else { format!("{name}…") }]
                }
            }
        })
        .collect();
    // One dash says the limits are unknown, however many of their items are chosen.
    let first_dash = parts.iter().position(|p| p == "—");
    let shown: Vec<&str> = parts
        .iter()
        .enumerate()
        .filter(|(i, part)| *part != "—" || first_dash == Some(*i))
        .map(|(_, part)| part.as_str())
        .collect();
    shown.join(if shown.len() > 3 {
        NARROW_SEPARATOR
    } else {
        SEPARATOR
    })
}

/// The title these items would give, for Settings to preview: 40 % of the five-hour window used
/// with 1:50 left, 35 % of the week, and today 12,4M tokens worth $18,20, on the account `name`
/// (TS default "Max").
pub fn menu_bar_preview(items: &[MenuBarItem], language: Locale, name: &str, now: f64) -> String {
    let zone = "UTC";
    let at = |ms: f64| iso(now + ms);
    let mut usage = JsMap::new();
    usage.insert(
        "preview",
        AccountUsage {
            checked_at: Some(at(0.0)),
            five_hour: Some(UsageWindow::new(40.0, Some(&at(110.0 * 60_000.0)))),
            seven_day: Some(UsageWindow::new(35.0, Some(&at(3.0 * 86_400_000.0)))),
            ..AccountUsage::new("preview", UsageStatus::Ready)
        },
    );
    let snapshot = TraySnapshot {
        accounts: vec![Account::new("preview", name)],
        usage,
        desktop: Some(DesktopState {
            available: true,
            running: true,
            active_profile_id: Some("preview".into()),
            ..DesktopState::default()
        }),
        title_items: Some(items.to_vec()),
        today: Some(TrayToday {
            date: local_date(now, zone),
            tokens: 12_430_000.0,
            cost: 18.2,
            cost_estimated: None,
        }),
        time_zone: Some(zone.into()),
        ..TraySnapshot::default()
    };
    tray_title(&snapshot, now, language)
}
