//! Port of `tests/limit-notice.test.ts`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use relay_core::limit_notice::{
    LimitNoticeDeps, LimitNoticeSettings, LimitNotices, READY_FRESH_MS,
};
use relay_core::shared::types::js::{date_parse, number_string};
use relay_core::shared::types::{
    Account, AccountUsage, LimitResetNotice, NotificationSettings, UsageStatus, UsageWindow,
};

const FIVE_RESET: &str = "2026-11-23T14:00:00.000Z";
const WEEK_RESET: &str = "2026-11-27T09:00:00.000Z";

fn account(id: &str) -> Account {
    Account {
        group: "personal".into(),
        color: "olive".into(),
        created_at: "2026-11-23T00:00:00Z".into(),
        ..Account::new(id, id)
    }
}

/// `five_reset` `None`: a 5-hour window with no reset time, as an unused window after its reset reads.
fn reading_at(
    id: &str,
    five: Option<f64>,
    week: Option<f64>,
    five_reset: Option<&str>,
) -> AccountUsage {
    AccountUsage {
        five_hour: five.map(|f| UsageWindow::new(f, five_reset)),
        seven_day: week.map(|w| UsageWindow::new(w, Some(WEEK_RESET))),
        ..AccountUsage::new(id, UsageStatus::Ready)
    }
}

fn reading(id: &str, five: Option<f64>, week: Option<f64>) -> AccountUsage {
    reading_at(id, five, week, Some(FIVE_RESET))
}

#[derive(Default)]
struct Options {
    warnings: Option<bool>,
    threshold: Option<u32>,
    in_use: Option<&'static str>,
    notifications: Option<NotificationSettings>,
    file: Option<PathBuf>,
    now: Option<f64>,
}

struct Setup {
    notices: LimitNotices,
    told: Arc<Mutex<Vec<String>>>,
    ready: Arc<Mutex<Vec<String>>>,
    in_use: Arc<Mutex<String>>,
    now: Arc<Mutex<f64>>,
}

impl Setup {
    fn told(&self) -> Vec<String> {
        self.told.lock().unwrap().clone()
    }
    fn ready(&self) -> Vec<String> {
        self.ready.lock().unwrap().clone()
    }
    fn use_account(&self, id: &str) {
        *self.in_use.lock().unwrap() = id.into();
    }
    fn at(&self, iso: &str) {
        *self.now.lock().unwrap() = date_parse(iso);
    }
    fn observe(&mut self, id: &str, usage: AccountUsage) {
        self.notices.observe(&account(id), &usage);
    }
}

fn setup(o: Options) -> Setup {
    let told = Arc::new(Mutex::new(Vec::new()));
    let ready = Arc::new(Mutex::new(Vec::new()));
    let in_use = Arc::new(Mutex::new(o.in_use.unwrap_or("a").to_string()));
    let now = Arc::new(Mutex::new(
        o.now.unwrap_or_else(|| date_parse("2026-11-23T12:00:00Z")),
    ));
    let settings = LimitNoticeSettings {
        usage_warnings: o.warnings.unwrap_or(true),
        usage_warning_percent: o.threshold.unwrap_or(90),
        notifications: o.notifications,
    };
    let notices = LimitNotices::new(LimitNoticeDeps {
        settings: Box::new(move || settings),
        in_use: Box::new({
            let in_use = Arc::clone(&in_use);
            move || Some(in_use.lock().unwrap().clone())
        }),
        notify: Box::new({
            let told = Arc::clone(&told);
            move |acc, kind, window| {
                told.lock().unwrap().push(format!(
                    "{}:{}:{}",
                    acc.id,
                    kind.as_str(),
                    number_string(window.used_percent)
                ))
            }
        }),
        ready: Box::new({
            let ready = Arc::clone(&ready);
            move |acc, kind| {
                ready
                    .lock()
                    .unwrap()
                    .push(format!("{}:{}", acc.id, kind.as_str()))
            }
        }),
        file: o
            .file
            .map(|f| Box::new(move || f.clone()) as Box<dyn Fn() -> PathBuf + Send>),
        now: Some(Box::new({
            let now = Arc::clone(&now);
            move || *now.lock().unwrap()
        })),
    });
    Setup {
        notices,
        told,
        ready,
        in_use,
        now,
    }
}

/// A private folder for the saved reset memory, removed when the guard drops.
fn memory_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("relay-limit-notice-")
        .tempdir()
        .unwrap();
    let file = dir.path().join("limit-notices.json");
    (dir, file)
}

#[cfg(unix)]
fn mode(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn the_account_in_use_tells_once_when_a_window_crosses_the_threshold() {
    let mut s = setup(Options::default());
    s.observe("a", reading("a", Some(70.0), Some(40.0)));
    s.observe("a", reading("a", Some(91.0), Some(40.0)));
    s.observe("a", reading("a", Some(95.0), Some(40.0)));
    assert_eq!(s.told(), ["a:five_hour:91"]);
    // The weekly window crosses on its own.
    s.observe("a", reading("a", Some(96.0), Some(92.0)));
    assert_eq!(s.told(), ["a:five_hour:91", "a:seven_day:92"]);
}

#[test]
fn a_first_reading_already_past_the_threshold_says_nothing_so_a_restart_or_a_switch_never_repeats_it()
 {
    let mut s = setup(Options::default());
    s.observe("a", reading("a", Some(95.0), None));
    s.observe("a", reading("a", Some(97.0), None));
    // Switched to b, which is already past it: nothing either.
    s.use_account("b");
    s.observe("b", reading("b", Some(93.0), None));
    assert!(s.told().is_empty());
}

#[test]
fn a_reset_brings_the_window_under_the_threshold_and_arms_it_again() {
    let mut s = setup(Options::default());
    for used in [85.0, 92.0, 3.0, 90.0] {
        s.observe("a", reading("a", Some(used), None));
    }
    assert_eq!(s.told(), ["a:five_hour:92", "a:five_hour:90"]);
}

#[test]
fn a_gateway_fraction_and_an_older_poll_around_the_threshold_tell_once_not_twice() {
    let mut s = setup(Options::default());
    for used in [85.0, 90.2, 89.0, 91.0] {
        s.observe("a", reading("a", Some(used), None));
    }
    assert_eq!(s.told(), ["a:five_hour:90.2"]);
}

#[test]
fn accounts_not_in_use_the_switch_turned_off_and_the_chosen_threshold() {
    let mut other = setup(Options {
        in_use: Some("b"),
        ..Options::default()
    });
    other.observe("a", reading("a", Some(50.0), None));
    other.observe("a", reading("a", Some(99.0), None));
    assert!(other.told().is_empty());

    let mut off = setup(Options {
        warnings: Some(false),
        ..Options::default()
    });
    off.observe("a", reading("a", Some(50.0), None));
    off.observe("a", reading("a", Some(99.0), None));
    assert!(off.told().is_empty());

    let mut eighty = setup(Options {
        threshold: Some(80),
        ..Options::default()
    });
    eighty.observe("a", reading("a", Some(79.0), None));
    eighty.observe("a", reading("a", Some(80.0), None));
    assert_eq!(eighty.told(), ["a:five_hour:80"]);
}

#[test]
fn a_window_that_reached_the_threshold_says_ready_again_once_when_it_resets() {
    let mut s = setup(Options::default());
    s.observe("a", reading("a", Some(95.0), Some(40.0)));
    s.at("2026-11-23T13:00:00Z");
    s.observe("a", reading("a", Some(96.0), Some(40.0)));
    // After the reset the 5-hour window has no reset time until it is used again.
    s.at("2026-11-23T14:02:00Z");
    s.observe("a", reading_at("a", Some(0.0), Some(41.0), None));
    assert_eq!(s.ready(), ["a:five_hour"]);
    s.at("2026-11-23T14:07:00Z");
    s.observe(
        "a",
        reading_at("a", Some(1.0), Some(41.0), Some("2026-11-23T19:07:00Z")),
    );
    // An older poll still showing the full window does not wait for that reset again.
    s.observe("a", reading("a", Some(97.0), Some(41.0)));
    s.at("2026-11-23T14:12:00Z");
    s.observe(
        "a",
        reading_at("a", Some(2.0), Some(41.0), Some("2026-11-23T19:07:00Z")),
    );
    assert_eq!(s.ready(), ["a:five_hour"]);
}

#[test]
fn the_weekly_window_and_an_early_reset_say_ready_again_too() {
    let mut weekly = setup(Options::default());
    weekly.observe("a", reading("a", None, Some(92.0)));
    weekly.at("2026-11-27T09:05:00Z");
    weekly.observe(
        "a",
        AccountUsage {
            seven_day: Some(UsageWindow::new(0.0, None)),
            ..AccountUsage::new("a", UsageStatus::Ready)
        },
    );
    assert_eq!(weekly.ready(), ["a:seven_day"]);

    // A later window began before the awaited reset time: the limit was reset early.
    let mut early = setup(Options::default());
    early.observe("a", reading("a", Some(95.0), None));
    early.at("2026-11-23T12:30:00Z");
    early.observe(
        "a",
        reading_at("a", Some(5.0), None, Some("2026-11-23T17:30:00Z")),
    );
    assert_eq!(early.ready(), ["a:five_hour"]);

    // Under the threshold before the reset time with the same window: no reset.
    let mut drop = setup(Options::default());
    drop.observe("a", reading("a", Some(95.0), None));
    drop.observe("a", reading("a", Some(3.0), None));
    assert!(drop.ready().is_empty());
}

#[test]
fn a_restart_neither_repeats_ready_again_nor_forgets_a_window_that_filled_before_it() {
    let (_dir, file) = memory_file();
    let mut before = setup(Options {
        file: Some(file.clone()),
        ..Options::default()
    });
    before.observe("a", reading("a", Some(95.0), None));
    assert!(file.exists());
    #[cfg(unix)]
    assert_eq!(mode(&file), 0o600);

    // Relay restarted around the reset: the first reading after it tells once.
    let mut after = setup(Options {
        file: Some(file.clone()),
        now: Some(date_parse("2026-11-23T14:05:00Z")),
        ..Options::default()
    });
    after.observe("a", reading_at("a", Some(0.0), None, None));
    assert_eq!(after.ready(), ["a:five_hour"]);

    // Another restart: the same reset, and an older poll of the full window, say nothing.
    let mut again = setup(Options {
        file: Some(file.clone()),
        now: Some(date_parse("2026-11-23T14:10:00Z")),
        ..Options::default()
    });
    again.observe("a", reading("a", Some(97.0), None));
    again.observe("a", reading_at("a", Some(0.0), None, None));
    assert!(again.ready().is_empty());
}

#[test]
fn a_reset_found_long_after_it_happened_is_old_news_and_not_told() {
    let (_dir, file) = memory_file();
    setup(Options {
        file: Some(file.clone()),
        ..Options::default()
    })
    .observe("a", reading("a", Some(95.0), None));
    let mut late = setup(Options {
        file: Some(file.clone()),
        now: Some(date_parse(FIVE_RESET) + READY_FRESH_MS + 60_000.0),
        ..Options::default()
    });
    late.observe("a", reading_at("a", Some(0.0), None, None));
    assert!(late.ready().is_empty());
    // Passed, not pending: a later reading says nothing either.
    let mut later = setup(Options {
        file: Some(file.clone()),
        now: Some(date_parse(FIVE_RESET) + READY_FRESH_MS + 120_000.0),
        ..Options::default()
    });
    later.observe("a", reading_at("a", Some(0.0), None, None));
    assert!(later.ready().is_empty());
}

#[test]
fn the_window_switches_the_ready_again_choice_and_the_account_it_is_for() {
    // The 5-hour window off: neither its warning nor its ready again; the weekly one still warns.
    let mut five = setup(Options {
        notifications: Some(NotificationSettings {
            limit_five_hour: Some(false),
            ..NotificationSettings::default()
        }),
        ..Options::default()
    });
    five.observe("a", reading("a", Some(70.0), Some(70.0)));
    five.observe("a", reading("a", Some(95.0), Some(95.0)));
    five.at("2026-11-23T14:05:00Z");
    five.observe("a", reading_at("a", Some(0.0), Some(95.0), None));
    assert_eq!(five.told(), ["a:seven_day:95"]);
    assert!(five.ready().is_empty());

    // Ready again off: the warning stays.
    let mut off = setup(Options {
        notifications: Some(NotificationSettings {
            limit_reset: Some(LimitResetNotice::Off),
            ..NotificationSettings::default()
        }),
        ..Options::default()
    });
    off.observe("a", reading("a", Some(70.0), None));
    off.observe("a", reading("a", Some(95.0), None));
    off.at("2026-11-23T14:05:00Z");
    off.observe("a", reading_at("a", Some(0.0), None, None));
    assert_eq!(off.told(), ["a:five_hour:95"]);
    assert!(off.ready().is_empty());

    // The default is the account in use; "all" tells for an account that is not.
    for (limit_reset, expected) in [
        (None, vec![]),
        (Some(LimitResetNotice::All), vec!["a:five_hour".to_string()]),
    ] {
        let mut other = setup(Options {
            in_use: Some("b"),
            notifications: limit_reset.map(|limit_reset| NotificationSettings {
                limit_reset: Some(limit_reset),
                ..NotificationSettings::default()
            }),
            ..Options::default()
        });
        other.observe("a", reading("a", Some(95.0), None));
        other.at("2026-11-23T14:05:00Z");
        other.observe("a", reading_at("a", Some(0.0), None, None));
        assert_eq!(other.ready(), expected);
    }

    // Ready again does not need the marks: it fires with "Mark accounts near their limit" off.
    let mut unmarked = setup(Options {
        warnings: Some(false),
        ..Options::default()
    });
    unmarked.observe("a", reading("a", Some(95.0), None));
    unmarked.at("2026-11-23T14:05:00Z");
    unmarked.observe("a", reading_at("a", Some(0.0), None, None));
    assert_eq!(unmarked.ready(), ["a:five_hour"]);
}
