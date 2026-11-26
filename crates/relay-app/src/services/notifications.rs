//! Relay's notifications, on this computer and posted to the user's ntfy topic or webhook (port
//! of electron/main/notifications.ts).
//!
//! Each notice carries the page a click opens as its `action` (crate::notify routes the click).

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};

use relay_core::adaptive_schedule::AdaptiveNoticeKind;
use relay_core::draft_main::draft_notice;
use relay_core::draft_restorer::DraftCounts;
use relay_core::fleet_continuation::fleet_notice;
use relay_core::host::Notice;
use relay_core::limit_notice::{
    LimitNoticeDeps, LimitNoticeSettings, LimitNotices, LimitWindowKind,
};
use relay_core::meters::{MeterService, MeterServiceOptions};
use relay_core::remote_notify::{RemoteDeps, RemoteEventName, RemoteNotice, RemoteNotifier};
use relay_core::shared::browser_extension::{ExtensionCurrent, ExtensionReason, ExtensionResult};
use relay_core::shared::feature_risk::{meter_risk, needs_risk_ack};
use relay_core::shared::meters::{MeterReading, enabled_meters};
use relay_core::shared::notifications::notification_settings;
use relay_core::shared::percent::{format_percent, percent_used};
use relay_core::shared::planning::local_parts;
use relay_core::shared::proxy_types::ProxyLoopAlarm;
use relay_core::shared::types::js::date_parse;
use relay_core::shared::types::{Account, FleetLast, UsageWindow};
use relay_core::window_keeper::AdaptedNotice;
use relay_i18n::{Args, Locale};

use crate::i18n::{locale, say, say_with};
use crate::state::{STATE, lock};

/// Shows a notification on this computer; `action` is the page a click opens.
pub fn show(title: String, body: String, action: Option<&str>) {
    if let Some(shell) = STATE.shell.get() {
        shell.notify(&Notice {
            title,
            body,
            silent: false,
            action: action.map(str::to_owned),
        });
    }
}

fn now() -> f64 {
    relay_core::clock::now_ms() as f64
}

/// The limit notices: a warning when the account in use crosses the threshold (also gated by
/// "Mark accounts near their limit"), and "ready again" after a window that reached it resets.
static LIMIT_NOTICES: LazyLock<Mutex<LimitNotices>> = LazyLock::new(|| {
    Mutex::new(LimitNotices::new(LimitNoticeDeps {
        settings: Box::new(|| LimitNoticeSettings::from(&STATE.settings())),
        in_use: Box::new(|| {
            STATE
                .observed_desktop()
                .and_then(|state| state.active_profile_id)
        }),
        notify: Box::new(notify_limit_near),
        ready: Box::new(notify_limit_ready),
        file: Some(Box::new(|| {
            STATE.paths().data_dir().join("limit-notices.json")
        })),
        now: None,
    }))
});

/// `limitNotices.observe`: a verified limit reading of `account`.
pub fn observe_limits(account: &Account, usage: &relay_core::shared::types::AccountUsage) {
    lock(&LIMIT_NOTICES).observe(account, usage);
}

/// The remote notifications (Settings → General → Notifications): the same events, posted to the
/// saved ntfy topic or webhook. A failed post is recorded redacted, without the URL.
static REMOTE_NOTIFIER: LazyLock<RemoteNotifier> = LazyLock::new(|| {
    let mut deps = RemoteDeps::new(|| {
        STATE.paths.get().map_or_else(
            || env!("CARGO_PKG_VERSION").to_owned(),
            |paths| paths.app_version(),
        )
    });
    deps.log = Some(Arc::new(|line: &str| {
        crate::services::errors::record_main_error("remote-notify", line);
    }));
    RemoteNotifier::new(deps, || {
        STATE.service.get().and_then(|service| {
            service
                .store
                .with_state(|s| s.settings.remote_notify.clone())
        })
    })
});

/// `remoteNotifier`.
pub fn remote_notifier() -> &'static RemoteNotifier {
    &REMOTE_NOTIFIER
}

/// The other tools' usage meters (Settings → Other tools): only those turned on and whose risk
/// is accepted, so a list restored from a backup without the answer reads nothing until it is
/// given.
static METERS: LazyLock<MeterService> = LazyLock::new(|| {
    let mut options = MeterServiceOptions::new(|| {
        let Some(service) = STATE.service.get() else {
            return Vec::new();
        };
        let settings = service.store.with_state(|s| s.settings.clone());
        enabled_meters(settings.meters.as_deref())
            .into_iter()
            .filter(|&provider| {
                !needs_risk_ack(Some(&settings.risk_acknowledged), meter_risk(provider))
            })
            .collect()
    });
    options.on_change = Some(Arc::new(crate::events::changed));
    options.log = Some(Arc::new(|line: &str| {
        crate::services::errors::record_main_error("meters", line);
    }));
    MeterService::new(options)
});

/// `meters.start()`.
pub fn meters_start() {
    METERS.start();
}

/// `meters.stop()`.
pub fn meters_stop() {
    METERS.stop();
}

/// `void meters.tick()`.
pub fn meters_tick() {
    let meters = METERS.clone();
    std::thread::spawn(move || meters.tick());
}

/// `meters.snapshot()`.
pub fn meters_snapshot() -> Vec<MeterReading> {
    METERS.snapshot()
}

/// A notification type of Settings → General → Notifications.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyKind {
    Switches,
    SignIns,
    EarlyStart,
    Updates,
}

/// Whether a notification type is on in Settings → General → Notifications.
pub fn notifies(kind: NotifyKind) -> bool {
    let choices = notification_settings(STATE.settings().notifications.as_ref());
    match kind {
        NotifyKind::Switches => choices.switches,
        NotifyKind::SignIns => choices.sign_ins,
        NotifyKind::EarlyStart => choices.early_start,
        NotifyKind::Updates => choices.updates,
    }
}

/// Accounts the extension notice was shown for since Relay started: once each, not every switch.
static EXTENSION_NOTICE_SHOWN: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// After a manual switch whose extension step left the Claude browser extension on another
/// account (mode "guide", or "closed" with the browser open): Claude's browser tools only work
/// when the extension is on the conversation's account, so the user hears it here and not only
/// in the panel. A click opens Settings → Switching.
pub fn notify_extension_left(target: &Account) {
    let Some(outcome) = STATE.desktop.get().and_then(|d| d.extension_outcome()) else {
        return;
    };
    // Every outcome that leaves the extension elsewhere, not only a running browser: the target
    // has no pair saved ("saved", "no-saved-login"), its owner is unclear, or the step failed.
    let quiet = matches!(
        outcome.reason,
        Some(
            ExtensionReason::Off
                | ExtensionReason::NotInstalled
                | ExtensionReason::AlreadyThere
                | ExtensionReason::NotOpened
                | ExtensionReason::ChooseInstance
        )
    );
    let left = outcome.result == ExtensionResult::Saved
        || (matches!(
            outcome.result,
            ExtensionResult::Skipped | ExtensionResult::Failed
        ) && !quiet);
    // An unparsable time is NaN in the TS: the comparison is false and the notice goes.
    if !notifies(NotifyKind::Switches)
        || !left
        || now() - date_parse(&outcome.at) > 5.0 * 60_000.0
        || lock(&EXTENSION_NOTICE_SHOWN).contains(&target.id)
    {
        return;
    }
    lock(&EXTENSION_NOTICE_SHOWN).insert(target.id.clone());
    let on = match &outcome.current {
        Some(ExtensionCurrent::SignedIn {
            account_uuid: Some(uuid),
            ..
        }) if !uuid.is_empty() => {
            let uuid = uuid.to_lowercase();
            STATE
                .accounts()
                .into_iter()
                .find(|a| {
                    let desktop = a.desktop.as_ref().map(|d| d.account_uuid.to_lowercase());
                    let auth = a
                        .auth
                        .as_ref()
                        .and_then(|auth| auth.account_uuid.as_ref())
                        .map(|u| u.to_lowercase());
                    desktop.as_ref() == Some(&uuid) || auth.as_ref() == Some(&uuid)
                })
                .map(|a| a.name)
        }
        _ => None,
    };
    let title = match on {
        Some(on) => say_with("electronMain.extensionStillOn", &Args::new().set("on", on)),
        None => say("electronMain.extensionNotSwitched"),
    };
    let body = say_with(
        "electronMain.claudeSBrowserToolsDoNot",
        &Args::new().set("targetName", &target.name),
    );
    show(title, body, Some("gecis"));
}

/// A prompt through the gateway went past a loop bound: said once per prompt; a click opens the
/// gateway page.
pub fn notify_loop_alarm(alarm: &ProxyLoopAlarm) {
    let account = alarm.account_id.as_ref().and_then(|id| {
        STATE
            .accounts()
            .into_iter()
            .find(|a| &a.id == id)
            .map(|a| a.name)
    });
    show(
        say("electronMain.aPromptKeepsSendingRequests"),
        say_with(
            "electronMain.requestsSubagentsItMayBeIn",
            &Args::new()
                .set("alarmRequests", alarm.requests)
                .set("alarmSubagents", alarm.subagents)
                .set(
                    "p1",
                    account.map_or_else(String::new, |name| format!(" · {name}")),
                ),
        ),
        Some("proxy"),
    );
}

/// After a step put a claude.ai login in place and the extension could not sign in to `account`
/// with it: Relay forgot that login, and Claude's browser tools stay off until the user signs in
/// again. A click opens Settings → Switching, where the reconnect steps are.
pub fn notify_extension_broken(account: &Account) {
    if !notifies(NotifyKind::SignIns) {
        return;
    }
    show(
        say("electronMain.extensionCannotSignIn"),
        say_with(
            "electronMain.claudeSBrowserToolsDoNot2",
            &Args::new().set("accountName", &account.name),
        ),
        Some("gecis"),
    );
}

/// Says that an account's Claude Code sign-in ends soon (or ended) and Relay could not renew it.
pub fn notify_sign_in_ending(account: &Account, ends_at: Option<&str>) {
    let end = ends_at.map_or(f64::NAN, date_parse);
    let now = now();
    let days = if end.is_finite() && end > now {
        ((end - now) / 86_400_000.0).ceil().max(1.0)
    } else {
        0.0
    };
    let title = if days > 0.0 {
        say_with(
            "electronMain.claudeCodeSignInEndsIn",
            &Args::new()
                .set("accountName", &account.name)
                .set("days", days),
        )
    } else {
        say_with(
            "electronMain.claudeCodeSignInEnded",
            &Args::new().set("accountName", &account.name),
        )
    };
    let body = say("electronMain.signInToThisAccountAgain");
    remote(RemoteEventName::SignInEnding, &account.name, &title, &body);
    if !notifies(NotifyKind::SignIns) {
        return;
    }
    show(title, body, Some("hesaplar"));
}

/// A remote notice with only the account's name, the title and the text.
fn remote(event: RemoteEventName, account_name: &str, title: &str, message: &str) {
    REMOTE_NOTIFIER.notify(RemoteNotice {
        event,
        account_name: Some(account_name.to_owned()),
        window: None,
        used_percent: None,
        resets_at: None,
        title: title.to_owned(),
        message: message.to_owned(),
    });
}

/// Weekday names as `Intl` prints `{ weekday: "long" }` in each format locale, Sunday first.
fn long_weekday(language: Locale, day: usize) -> &'static str {
    let names: [&str; 7] = match language {
        Locale::En => [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ],
        Locale::Tr => [
            "Pazar",
            "Pazartesi",
            "Salı",
            "Çarşamba",
            "Perşembe",
            "Cuma",
            "Cumartesi",
        ],
        Locale::De => [
            "Sonntag",
            "Montag",
            "Dienstag",
            "Mittwoch",
            "Donnerstag",
            "Freitag",
            "Samstag",
        ],
        Locale::Fr => [
            "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
        ],
        Locale::Es => [
            "domingo",
            "lunes",
            "martes",
            "miércoles",
            "jueves",
            "viernes",
            "sábado",
        ],
        Locale::PtBr => [
            "domingo",
            "segunda-feira",
            "terça-feira",
            "quarta-feira",
            "quinta-feira",
            "sexta-feira",
            "sábado",
        ],
        Locale::It => [
            "domenica",
            "lunedì",
            "martedì",
            "mercoledì",
            "giovedì",
            "venerdì",
            "sabato",
        ],
        Locale::Ja => [
            "日曜日",
            "月曜日",
            "火曜日",
            "水曜日",
            "木曜日",
            "金曜日",
            "土曜日",
        ],
        Locale::Ko => [
            "일요일",
            "월요일",
            "화요일",
            "수요일",
            "목요일",
            "금요일",
            "토요일",
        ],
        Locale::ZhHans | Locale::ZhHant => [
            "星期日",
            "星期一",
            "星期二",
            "星期三",
            "星期四",
            "星期五",
            "星期六",
        ],
        Locale::Ru => [
            "воскресенье",
            "понедельник",
            "вторник",
            "среда",
            "четверг",
            "пятница",
            "суббота",
        ],
        Locale::Uk => [
            "неділя",
            "понеділок",
            "вівторок",
            "середа",
            "четвер",
            "пʼятниця",
            "субота",
        ],
        Locale::Pl => [
            "niedziela",
            "poniedziałek",
            "wtorek",
            "środa",
            "czwartek",
            "piątek",
            "sobota",
        ],
        Locale::Nl => [
            "zondag",
            "maandag",
            "dinsdag",
            "woensdag",
            "donderdag",
            "vrijdag",
            "zaterdag",
        ],
    };
    names[day % 7]
}

/// `reset.toLocaleString(FORMAT_LOCALE[language], …)` in the system's zone: the clock, and for
/// the weekly window its weekday before it.
fn reset_when(resets_at: Option<&str>, kind: LimitWindowKind, language: Locale) -> Option<String> {
    use chrono::{Datelike, TimeZone, Timelike};
    let ms = date_parse(resets_at?);
    if !ms.is_finite() {
        return None;
    }
    let local = chrono::Local.timestamp_millis_opt(ms as i64).single()?;
    let clock = format!("{:02}:{:02}", local.hour(), local.minute());
    Some(match kind {
        LimitWindowKind::FiveHour => clock,
        LimitWindowKind::SevenDay => format!(
            "{} {clock}",
            long_weekday(language, local.weekday().num_days_from_sunday() as usize)
        ),
    })
}

/// Says that the account in use passed the warning threshold, and when that window resets; a
/// click opens Overview.
fn notify_limit_near(account: &Account, kind: LimitWindowKind, window: &UsageWindow) {
    let language = locale();
    // Rounded down, as every bar shows it: 99.6 reads 99, not 100.
    let percent = format_percent(percent_used(Some(window.used_percent)), language);
    let when = reset_when(window.resets_at.as_deref(), kind, language);
    let title = say_with(
        if kind == LimitWindowKind::FiveHour {
            "electronMain.fiveHourLimitNear"
        } else {
            "electronMain.weeklyLimitNear"
        },
        &Args::new()
            .set("accountName", &account.name)
            .set("percent", percent),
    );
    let body = when.map_or_else(String::new, |when| {
        say_with("electronMain.limitResetsAt", &Args::new().set("when", when))
    });
    REMOTE_NOTIFIER.notify(RemoteNotice {
        event: RemoteEventName::LimitNear,
        account_name: Some(account.name.clone()),
        window: Some(kind),
        used_percent: Some(window.used_percent),
        resets_at: window.resets_at.clone(),
        title: title.clone(),
        message: body.clone(),
    });
    show(title, body, Some("genel"));
}

/// Says that a window which reached the warning threshold has reset; a click opens Overview.
fn notify_limit_ready(account: &Account, kind: LimitWindowKind) {
    let title = say_with(
        "electronMain.accountReadyAgain",
        &Args::new().set("accountName", &account.name),
    );
    let body = say(if kind == LimitWindowKind::FiveHour {
        "electronMain.fiveHourLimitReset"
    } else {
        "electronMain.weeklyLimitReset"
    });
    REMOTE_NOTIFIER.notify(RemoteNotice {
        event: RemoteEventName::LimitReady,
        account_name: Some(account.name.clone()),
        window: Some(kind),
        used_percent: None,
        resets_at: None,
        title: title.clone(),
        message: body.clone(),
    });
    show(title, body, Some("genel"));
}

/// Says that an account's saved Claude sign-in ended; a click opens the account.
pub fn notify_sign_in_ended(account: &Account) {
    let title = say("electronMain.claudeSignInEnded");
    let body = say_with(
        "electronMain.theSavedSignInOfNo",
        &Args::new().set("accountName", &account.name),
    );
    remote(RemoteEventName::SignInEnded, &account.name, &title, &body);
    if !notifies(NotifyKind::SignIns) {
        return;
    }
    show(title, body, Some("hesaplar"));
}

/// Says once per version that a downloaded update is ready; a click opens Overview, where the
/// sidebar row offers it.
pub fn notify_update(version: &str) {
    if !notifies(NotifyKind::Updates) {
        return;
    }
    show(
        say("electronMain.updateReady"),
        say_with(
            "electronMain.clickToInstallRelay",
            &Args::new().set("version", version),
        ),
        Some("genel"),
    );
}

/// Same copy as the menu bar switch; shown after a tray or panel switch.
pub fn notify_switched(name: &str) {
    if !notifies(NotifyKind::Switches) {
        return;
    }
    show(
        say("electronMain.switchComplete"),
        say_with(
            "electronMain.theClaudeAppSwitchedTo",
            &Args::new().set("name", name),
        ),
        None,
    );
}

/// After the fleet switched at the limit: where Claude went, and what became of the
/// conversations.
pub fn notify_fleet(last: &FleetLast, reason: Option<&str>) {
    let target = STATE
        .accounts()
        .into_iter()
        .find(|a| a.id == last.target_id);
    let name = target
        .as_ref()
        .map_or_else(|| say("electronMain.another"), |t| t.name.clone());
    let title = say("electronMain.automaticSwitch");
    let body = fleet_notice(last, &name, locale(), reason);
    if let Some(target) = &target {
        remote(RemoteEventName::AutoSwitch, &target.name, &title, &body);
    }
    if !notifies(NotifyKind::Switches) {
        return;
    }
    show(title, body, None);
}

/// After preparing on quit put the Claude app on another account: posted remotely only, as the
/// window's automation card already says it and Relay never showed a notification for it.
pub fn remote_auto_switched(target_id: &str) {
    let Some(target) = STATE.accounts().into_iter().find(|a| a.id == target_id) else {
        return;
    };
    remote(
        RemoteEventName::AutoSwitch,
        &target.name,
        &say("electronMain.automaticSwitch"),
        &say_with(
            "electronMain.theClaudeAppSwitchedTo",
            &Args::new().set("name", &target.name),
        ),
    );
}

/// After a draft restore: how many drafts were typed back, and how many wait in the panel.
pub fn notify_drafts(summary: DraftCounts) {
    let Some(body) = draft_notice(summary, locale(), None) else {
        return;
    };
    if !notifies(NotifyKind::Switches) {
        return;
    }
    show(say("common.rescuedDrafts"), body, None);
}

/// Today's plan was re-planned at today's pace, or is back to normal.
pub fn notify_adapted(notice: &AdaptedNotice) {
    if !notifies(NotifyKind::EarlyStart) {
        return;
    }
    let (accounts, settings) = STATE
        .service()
        .store
        .with_state(|s| (s.accounts.clone(), s.settings.clone()));
    // Clocks in the planning zone, without suffixes.
    let zone = &settings.planning.time_zone;
    let list = notice
        .schedule
        .iter()
        .filter_map(|start| {
            let account = accounts.iter().find(|a| a.id == start.account_id)?;
            let clock = local_parts(date_parse(&start.start_at), zone)
                .map_or_else(String::new, |p| format!("{:02}:{:02}", p.hour, p.minute));
            Some(format!("{} {clock}", account.name))
        })
        .collect::<Vec<_>>()
        .join(", ");
    show(
        say("electronMain.earlyStart"),
        if notice.kind == AdaptiveNoticeKind::Normal {
            say("electronMain.thePlanIsBackToNormal")
        } else {
            say_with(
                "electronMain.planAdaptedToTodaySPace",
                &Args::new().set("list", list),
            )
        },
        None,
    );
}
