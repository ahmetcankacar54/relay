//! Port of `tests/widget-snapshot.test.ts`: `shared/widget-snapshot`, `electron/core/widget-file`
//! and `electron/core/widget-center`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use relay_core::shared::token_usage_view::{TokenCell, TokenCounts, TokenDay, TokenToday};
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountDesktop, AccountUsage, RelaySettings, UsageStatus, UsageWindow,
    default_settings,
};
use relay_core::shared::widget_snapshot::{
    WidgetLimits, WidgetMood, WidgetMoodLimits, WidgetProgress, WidgetSnapshot,
    WidgetSnapshotInput, WidgetState, build_widget_snapshot, widget_countdown, widget_mood,
    widget_visible_key,
};
use relay_core::widget_center::{ReloadTimelines, load_widget_center};
use relay_core::widget_file::{WIDGET_RELOAD_MS, WidgetFile};
use relay_i18n::Locale;
use serde_json::{Value, json};

const ZONE: &str = "Europe/Istanbul";

/// 20:24 in Istanbul.
fn now() -> f64 {
    date_parse("2026-10-22T17:24:00Z")
}

fn totals() -> TokenCounts {
    TokenCounts {
        input: 8_720.0,
        output: 3_250_000.0,
        cache_write: 10_000_000.0,
        cache_read: 1_300_000_000.0,
        responses: 900.0,
        cost: Some(444.56),
        unpriced: Some(0.0),
        cost_estimated: None,
    }
}

fn today() -> TokenToday {
    TokenToday {
        date: "2026-10-22".into(),
        totals: totals(),
        slots: (0..96)
            .map(|i| (i <= 81).then_some(f64::from(i) / 10.0))
            .collect(),
        current_slot: 81.0,
        change: Some(0.5719),
        yesterday_average: Some(3.1),
        slots_since: None,
    }
}

fn slots_with(at81: f64) -> Vec<Option<f64>> {
    today()
        .slots
        .into_iter()
        .enumerate()
        .map(|(i, v)| if i == 81 { Some(at81) } else { v })
        .collect()
}

struct Limits {
    accounts: Vec<Account>,
    usage: JsMap<AccountUsage>,
    active_id: Option<String>,
    settings: RelaySettings,
}

/// The TS `build` argument, owned.
struct Input {
    today: TokenToday,
    progress: WidgetProgress,
    language: Locale,
    now: f64,
    days: Option<Vec<TokenDay>>,
    limits: Option<Limits>,
    hits: Option<f64>,
}

impl Default for Input {
    fn default() -> Self {
        Input {
            today: today(),
            progress: WidgetProgress {
                complete: true,
                percent: 100.0,
            },
            language: Locale::Tr,
            now: now(),
            days: None,
            limits: None,
            hits: None,
        }
    }
}

fn build(input: Input) -> WidgetSnapshot {
    build_widget_snapshot(&WidgetSnapshotInput {
        today: &input.today,
        progress: input.progress,
        language: input.language,
        zone: ZONE,
        now: input.now,
        days: input.days.as_deref(),
        limits: input.limits.as_ref().map(|l| WidgetLimits {
            accounts: &l.accounts,
            usage: &l.usage,
            active_id: l.active_id.as_deref(),
            settings: &l.settings,
            rate: None,
        }),
        hits: input.hits,
    })
}

/// Compact units and currency come with a no-break space; read it as a plain one.
fn plain(s: &str) -> String {
    s.replace('\u{a0}', " ")
}

fn plain_deep<T: serde::Serialize>(value: &T) -> Value {
    serde_json::from_str(&plain(&serde_json::to_string(value).unwrap())).unwrap()
}

#[test]
fn the_widget_file_carries_todays_numbers_and_every_string_formatted_in_turkish() {
    let snap = build(Input::default());
    assert_eq!(snap.version, 2);
    assert_eq!(snap.state, WidgetState::Data);
    assert_eq!(snap.date, "2026-10-22");
    assert_eq!(snap.generated_at, now());
    assert_eq!(
        serde_json::to_value(&snap.totals).unwrap(),
        json!({ "input": 8_720, "output": 3_250_000, "cache": 1_310_000_000, "total": 1_313_258_720u64 })
    );
    assert_eq!(snap.cost, 444.56);
    assert_eq!(snap.slots.len(), 96);
    assert_eq!(snap.slots[82], None);
    assert_eq!(
        plain_deep(&snap.text),
        json!({
            "title": "Bugün",
            "subtitle": "CLAUDE CODE · TOKEN",
            "rows": ["Girdi", "Çıktı", "Önbellek"],
            "input": "8,7 B",
            "output": "3,3 Mn",
            "cache": "1,3 Mr",
            "total": "1,3 Mr",
            "cost": "$444,56",
            "change": "+%57,2",
            "status": "",
            "empty": "Bugün henüz token yok",
            "stale": "Son güncelleme 20:24",
            "costTokens": "$444,56 · 1,3 Mr token",
            "tokens": "1,3 Mr token",
            "apiTitle": "Bugün · API karşılığı",
            "others": "Diğer hesaplar",
            "todayWord": "bugün",
            "inClaude": "Claude’da açık",
            "suggested": "önerilen",
            "todayLine": "Bugün toplam $444,56 · 1,3 Mr token",
            "allToday": "Bugün · tüm hesaplar",
            "switch": "Geç",
            "left": "kaldı",
            "noActive": "Kayıtlı hesap açık değil",
        })
    );
    // Without Relay's accounts and days the widget has no accounts to show.
    assert!(snap.active.is_none());
    assert!(snap.accounts.is_empty());
    assert!(snap.split.is_empty());
    assert!(snap.week.is_none());
}

#[test]
fn english_an_estimated_cost_no_change_the_empty_day_and_the_scan_each_read_as_they_should() {
    let en = build(Input {
        language: Locale::En,
        today: TokenToday {
            change: None,
            ..today()
        },
        ..Input::default()
    });
    assert_eq!(en.text.title, "Today");
    assert_eq!(en.text.cost, "$444.56");
    assert_eq!(en.text.change, "");
    assert_eq!(en.text.stale, "Last updated 20:24");
    let estimated = build(Input {
        today: TokenToday {
            totals: TokenCounts {
                cost_estimated: Some(true),
                ..totals()
            },
            ..today()
        },
        ..Input::default()
    });
    assert_eq!(estimated.text.cost, "≈$444,56");
    let empty = build(Input {
        today: TokenToday {
            totals: TokenCounts {
                cost: Some(0.0),
                unpriced: Some(0.0),
                ..TokenCounts::default()
            },
            ..today()
        },
        ..Input::default()
    });
    assert_eq!(empty.state, WidgetState::Empty);
    assert_eq!(empty.text.status, "Bugün henüz token yok");
    let scanning = build(Input {
        progress: WidgetProgress {
            complete: false,
            percent: 42.0,
        },
        ..Input::default()
    });
    assert_eq!(scanning.state, WidgetState::Scanning);
    assert_eq!(scanning.text.status, "Relay tarıyor… %42");
}

#[test]
fn the_visible_key_ignores_when_the_file_was_written_and_moves_with_what_the_widget_draws() {
    let a = build(Input::default());
    assert_eq!(
        widget_visible_key(&a),
        widget_visible_key(&build(Input {
            now: now() + 60_000.0,
            ..Input::default()
        }))
    );
    let later = build(Input {
        today: TokenToday {
            slots: slots_with(9.0),
            ..today()
        },
        ..Input::default()
    });
    assert_ne!(widget_visible_key(&a), widget_visible_key(&later));
    assert_ne!(
        widget_visible_key(&a),
        widget_visible_key(&build(Input {
            language: Locale::En,
            ..Input::default()
        }))
    );
}

/// A fresh `<tmp>/relay-widget-*/widget` folder (not created), removed when the guard drops.
fn temp_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("relay-widget-")
        .tempdir()
        .unwrap();
    let widget = dir.path().join("widget");
    (dir, widget)
}

type Reloads = Arc<Mutex<Vec<String>>>;

fn widget_file(dir: &Path, reloads: &Reloads, now: &Arc<Mutex<f64>>) -> WidgetFile {
    let reloads = Arc::clone(reloads);
    let now = Arc::clone(now);
    WidgetFile::new(
        dir,
        Some(Box::new(move || {
            reloads.lock().unwrap().push("all".into());
            Ok(())
        })),
        Some(Box::new(move || *now.lock().unwrap())),
    )
}

fn count(reloads: &Reloads) -> usize {
    reloads.lock().unwrap().len()
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn the_widget_file_is_private_and_reloads_come_at_most_every_5_minutes_unless_the_day_changed() {
    let (_guard, dir) = temp_dir();
    let clock = Arc::new(Mutex::new(now()));
    let reloads: Reloads = Arc::default();
    let mut file = widget_file(&dir, &reloads, &clock);
    let snap = build(Input::default());
    file.write(&snap, false).unwrap();
    let written = dir.join("today.json");
    let text = std::fs::read_to_string(&written).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        serde_json::to_value(&snap).unwrap()
    );
    assert_eq!(
        serde_json::from_str::<WidgetSnapshot>(&text).unwrap(),
        snap,
        "the file reads back as the snapshot"
    );
    #[cfg(unix)]
    {
        assert_eq!(mode(&written), 0o600);
        assert_eq!(mode(&dir), 0o700);
    }
    assert_eq!(*reloads.lock().unwrap(), ["all"]);
    // The same picture: written again, no reload.
    *clock.lock().unwrap() += WIDGET_RELOAD_MS * 2.0;
    let at = || *clock.lock().unwrap();
    file.write(
        &build(Input {
            now: at(),
            ..Input::default()
        }),
        false,
    )
    .unwrap();
    assert_eq!(count(&reloads), 1);
    // A new picture soon after a reload waits for the next write past 5 minutes.
    let changed = |n: f64, now: f64| {
        build(Input {
            now,
            today: TokenToday {
                slots: slots_with(n),
                ..today()
            },
            ..Input::default()
        })
    };
    file.write(&changed(1.0, at()), false).unwrap();
    assert_eq!(count(&reloads), 2);
    *clock.lock().unwrap() += 60_000.0;
    file.write(&changed(2.0, at()), false).unwrap();
    assert_eq!(count(&reloads), 2);
    *clock.lock().unwrap() += WIDGET_RELOAD_MS;
    file.write(&changed(2.0, at()), false).unwrap();
    assert_eq!(count(&reloads), 3);
    // A new day reloads at once.
    *clock.lock().unwrap() += 1_000.0;
    file.write(
        &build(Input {
            now: at(),
            today: TokenToday {
                date: "2026-10-23".into(),
                ..today()
            },
            ..Input::default()
        }),
        false,
    )
    .unwrap();
    assert_eq!(count(&reloads), 4);
}

#[test]
fn a_failing_reload_or_none_at_all_never_stops_the_file() {
    let (_guard, dir) = temp_dir();
    WidgetFile::new(&dir, Some(Box::new(|| Err("chronod said no".into()))), None)
        .write(&build(Input::default()), false)
        .unwrap();
    assert!(dir.join("today.json").exists());
    let (_quiet_guard, quiet) = temp_dir();
    WidgetFile::new(&quiet, None, None)
        .write(&build(Input::default()), false)
        .unwrap();
    assert!(quiet.join("today.json").exists());
}

#[test]
fn the_reload_addon_is_optional_a_missing_or_wrong_one_turns_reloads_off() {
    if !cfg!(target_os = "macos") {
        assert!(load_widget_center(Path::new("/nowhere"), |_| Err("not found".into())).is_none());
        return;
    }
    let calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let reload = load_widget_center(Path::new("/addon"), |_| {
        let calls = Arc::clone(&calls);
        let reload: ReloadTimelines = Arc::new(move |kind: Option<&str>| {
            calls.lock().unwrap().push(kind.unwrap_or("all").into())
        });
        Ok(Some(reload))
    })
    .unwrap();
    reload(Some("RelayToday"));
    // Without a kind, every widget of Relay's.
    reload(None);
    assert_eq!(*calls.lock().unwrap(), ["RelayToday", "all"]);
    assert!(load_widget_center(Path::new("/addon"), |_| Err("not found".into())).is_none());
    assert!(load_widget_center(Path::new("/addon"), |_| Ok(None)).is_none());
}

#[test]
fn a_language_change_reloads_at_once_whatever_the_throttle_says() {
    let (_guard, dir) = temp_dir();
    let reloads: Reloads = Arc::default();
    let mut file = widget_file(&dir, &reloads, &Arc::new(Mutex::new(now())));
    file.write(&build(Input::default()), false).unwrap();
    // A tick soon after: throttled.
    file.write(
        &build(Input {
            today: TokenToday {
                change: Some(0.9),
                ..today()
            },
            ..Input::default()
        }),
        false,
    )
    .unwrap();
    assert_eq!(count(&reloads), 1);
    let en = || {
        build(Input {
            language: Locale::En,
            ..Input::default()
        })
    };
    file.write(&en(), true).unwrap();
    assert_eq!(count(&reloads), 2);
    // Forced but what the widget shows already: nothing to redraw.
    file.write(&en(), true).unwrap();
    assert_eq!(count(&reloads), 2);
}

// Accounts, limits and the week.

const PERSONAL: &str = "00000000-0000-4000-8000-000000000001";
const VERTEX: &str = "00000000-0000-4000-8000-000000000002";
const WORK: &str = "00000000-0000-4000-8000-000000000003";
const SPARE: &str = "00000000-0000-4000-8000-000000000004";
const FIFTH: &str = "00000000-0000-4000-8000-000000000005";

fn person(id: &str, name: &str, linked: bool) -> Account {
    Account {
        group: "default".into(),
        color: "#000".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        desktop: linked.then(|| AccountDesktop {
            account_uuid: id.into(),
            org_id: id.into(),
            saved_at: "2026-01-01T00:00:00Z".into(),
            ..AccountDesktop::default()
        }),
        ..Account::new(id, name)
    }
}

fn accounts() -> Vec<Account> {
    vec![
        person(PERSONAL, "Kişisel", true),
        person(VERTEX, "Vertex", true),
        person(WORK, "İş", true),
        person(SPARE, "Yedek", false),
        person(FIFTH, "Beşinci", true),
    ]
}

fn reading_at(id: &str, five_hour: f64, week: f64, five_reset: f64) -> AccountUsage {
    AccountUsage {
        checked_at: Some(iso(now() - 60_000.0)),
        five_hour: Some(UsageWindow::new(five_hour, Some(&iso(five_reset)))),
        // Saturday 24 October, 21:30 in Istanbul.
        seven_day: Some(UsageWindow::new(week, Some("2026-10-24T18:30:00Z"))),
        ..AccountUsage::new(id, UsageStatus::Ready)
    }
}

fn reading(id: &str, five_hour: f64, week: f64) -> AccountUsage {
    reading_at(id, five_hour, week, now() + 110.0 * 60_000.0)
}

fn usage() -> JsMap<AccountUsage> {
    [
        (PERSONAL, reading(PERSONAL, 94.6, 68.2)),
        (
            VERTEX,
            reading_at(VERTEX, 22.0, 35.0, now() + 3.0 * 3_600_000.0),
        ),
        (WORK, reading(WORK, 100.0, 80.0)),
        (
            FIFTH,
            reading_at(FIFTH, 50.0, 60.0, now() + 4.0 * 3_600_000.0),
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

fn usage_with(id: &str, reading: AccountUsage) -> JsMap<AccountUsage> {
    let mut usage = usage();
    usage.insert(id, reading);
    usage
}

fn counts(cost: f64, tokens: f64) -> TokenCell {
    TokenCell {
        counts: TokenCounts {
            output: tokens,
            responses: 1.0,
            cost: Some(cost),
            unpriced: Some(0.0),
            ..TokenCounts::default()
        },
        estimated: false,
    }
}

fn days() -> Vec<TokenDay> {
    [
        "2026-10-16",
        "2026-10-17",
        "2026-10-18",
        "2026-10-19",
        "2026-10-20",
        "2026-10-21",
        "2026-10-22",
    ]
    .iter()
    .enumerate()
    .map(|(i, date)| {
        let row: Vec<(&str, TokenCell)> = if *date == "2026-10-22" {
            vec![
                (PERSONAL, counts(69.18, 64_200_000.0)),
                (VERTEX, counts(12.3, 10_000_000.0)),
                (WORK, counts(5.0, 6_000_000.0)),
                (FIFTH, counts(5.0, 6_300_000.0)),
            ]
        } else if i == 4 {
            vec![
                (VERTEX, counts(142.1, 90_000_000.0)),
                ("terminal", counts(3.0, 1_000_000.0)),
            ]
        } else if i == 0 {
            vec![]
        } else {
            vec![(PERSONAL, counts(10.0, 5_000_000.0))]
        };
        TokenDay {
            date: date.to_string(),
            by_row: row.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        }
    })
    .collect()
}

fn limits(usage: JsMap<AccountUsage>, active_id: Option<&str>) -> Option<Limits> {
    Some(Limits {
        accounts: accounts(),
        usage,
        active_id: active_id.map(String::from),
        settings: default_settings(),
    })
}

fn with_accounts(input: Input) -> Input {
    Input {
        days: input.days.or_else(|| Some(days())),
        limits: input.limits.or_else(|| limits(usage(), Some(PERSONAL))),
        ..input
    }
}

/// `withAccounts()` with its default `hits: 2`.
fn with_accounts_hits(input: Input) -> Input {
    with_accounts(Input {
        hits: input.hits.or(Some(2.0)),
        ..input
    })
}

#[test]
fn the_active_account_carries_its_limits_its_countdown_and_todays_cost_and_tokens_in_turkish() {
    let snap = plain_deep(&build(with_accounts_hits(Input::default())));
    let active = &snap["active"];
    assert_eq!(active["id"], PERSONAL);
    assert_eq!(active["name"], "Kişisel");
    assert_eq!(active["fiveHour"], 94);
    assert_eq!(active["week"], 68);
    assert_eq!(
        active["fiveHourResetsAt"],
        json!(now() as i64 + 110 * 60_000)
    );
    assert_eq!(active["cost"], 69.18);
    assert_eq!(active["tokens"], 64_200_000);
    assert_eq!(active["color"], 0);
    assert_eq!(
        active["text"],
        json!({
            "fiveHour": "%94",
            "week": "%68",
            "limits": "%94 / %68",
            "cost": "$69,18",
            "tokens": "64,2 Mn",
            "costTokens": "$69,18 · 64,2 Mn",
            "left": "1:50",
            "weekReset": "Cmt 21:30",
            "weekShort": "hafta %68",
            "weekLine": "Hafta %68 · Cmt 21:30’da yenilenir",
            "costChip": "$69,18 bugün",
            "tokensChip": "64,2 Mn token",
        })
    );
}

#[test]
fn other_accounts_follow_the_panel_the_suggested_one_first_at_most_three_and_only_a_ready_one_links_to_the_review()
 {
    let snap = plain_deep(&build(with_accounts_hits(Input::default())));
    let others = snap["accounts"].as_array().unwrap();
    assert_eq!(
        others
            .iter()
            .map(|a| json!([a["name"], a["suggested"], a["switchable"]]))
            .collect::<Vec<_>>(),
        [
            json!(["Vertex", true, true]),
            json!(["Beşinci", false, true]),
            json!(["İş", false, false]),
        ]
    );
    let (vertex, work) = (&others[0], &others[2]);
    assert_eq!(vertex["link"], format!("relay://switch?account={VERTEX}"));
    assert_eq!(work.get("link"), None);
    assert_eq!(vertex["text"]["switchTo"], "Vertex’e geç · %22");
    assert_eq!(vertex["text"]["limits"], "%22 / %35");
    assert_eq!(vertex["text"]["costTokens"], "$12,30 · 10 Mn");
    assert_eq!(work["text"]["fiveHour"], "%100");
    // An account without a current reading shows no figure rather than an old one.
    let stale = AccountUsage {
        stale: true,
        ..usage().get(VERTEX).unwrap().clone()
    };
    let old = plain_deep(&build(with_accounts_hits(Input {
        limits: limits(usage_with(VERTEX, stale), Some(PERSONAL)),
        ..Input::default()
    })));
    let unknown = old["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == VERTEX)
        .unwrap();
    assert_eq!(unknown.get("fiveHour"), None);
    assert_eq!(unknown["text"]["limits"], "— / —");
    assert_eq!(unknown["switchable"], false);
    assert_eq!(unknown["text"]["switchTo"], "Vertex’e geç");
}

#[test]
fn todays_split_and_the_weeks_bars_share_one_set_of_colours_the_active_account_first_then_the_rest()
{
    let snap = plain_deep(&build(with_accounts_hits(Input::default())));
    assert_eq!(
        snap["series"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| json!([s["name"], s["color"]]))
            .collect::<Vec<_>>(),
        [
            json!(["Kişisel", 0]),
            json!(["Vertex", 1]),
            json!(["İş", 2]),
            json!(["Diğer", 3]),
        ]
    );
    assert_eq!(
        snap["split"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| json!([
                p["name"],
                p["text"]["cost"],
                (p["share"].as_f64().unwrap() * 1000.0).round()
            ]))
            .collect::<Vec<_>>(),
        [
            json!(["Kişisel", "$69,18", 756.0]),
            json!(["Vertex", "$12,30", 134.0]),
            json!(["İş", "$5,00", 55.0]),
            json!(["Diğer", "$5,00", 55.0]),
        ]
    );
    let week = &snap["week"];
    assert_eq!(
        week["days"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["label"].clone())
            .collect::<Vec<_>>(),
        ["Cum", "Cmt", "Paz", "Pzt", "Sal", "Çar", "Per"]
    );
    assert_eq!(
        week["days"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["today"].clone())
            .collect::<Vec<_>>(),
        [false, false, false, false, false, false, true]
    );
    assert_eq!(week["days"][4]["parts"], json!([0, 142.1, 0, 3]));
    assert_eq!(week["hits"], 2);
    assert_eq!(
        week["text"],
        json!({
            "title": "Son 7 gün",
            "cost": "$276,58",
            "tokens": "197,5 Mn token",
            "average": "Günde $39,51",
            "busiest": "En yoğun Sal · $145,10",
            "hits": "Limit 2 kez doldu",
            "activeWeek": "Kişisel · hafta %68",
            "pairs": [
                { "label": "Günde", "figure": "$39,51" },
                { "label": "En yoğun Sal", "figure": "$145,10" },
                { "label": "Limit doldu", "figure": "2 kez" },
            ],
        })
    );
}

#[test]
fn the_accounts_and_the_week_read_in_english_too_and_parts_without_data_are_left_out() {
    let snap = plain_deep(&build(with_accounts(Input {
        language: Locale::En,
        ..Input::default()
    })));
    assert_eq!(
        snap["active"]["text"]["weekLine"],
        "Week 68% · renews Sat 21:30"
    );
    assert_eq!(snap["active"]["text"]["costChip"], "$69.18 today");
    assert_eq!(snap["active"]["text"]["tokensChip"], "64.2m tokens");
    assert_eq!(
        snap["accounts"][0]["text"]["switchTo"],
        "Switch to Vertex · 22%"
    );
    assert_eq!(
        snap["text"]["todayLine"],
        "Total today $444.56 · 1.3bn tokens"
    );
    assert_eq!(snap["text"]["switch"], "Switch");
    let series = snap["series"].as_array().unwrap();
    assert_eq!(series.last().unwrap()["name"], "Other");
    let week = &snap["week"];
    assert_eq!(week["text"]["title"], "Last 7 days");
    assert_eq!(week["text"]["average"], "$39.51 a day");
    assert_eq!(week["text"]["busiest"], "Busiest Tue · $145.10");
    assert_eq!(week.get("hits"), None);
    assert_eq!(week["text"]["hits"], "");
    assert_eq!(week["text"]["activeWeek"], "Kişisel · week 68%");
    assert_eq!(
        week["text"]["pairs"],
        json!([
            { "label": "Per day", "figure": "$39.51" },
            { "label": "Busiest Tue", "figure": "$145.10" },
        ])
    );
    // The widget sets the figure apart however the language writes money, and a zero count has none.
    assert_eq!(
        plain_deep(&build(with_accounts(Input {
            language: Locale::Fr,
            hits: Some(0.0),
            ..Input::default()
        })))["week"]["text"]["pairs"],
        json!([
            { "label": "Par jour", "figure": "39,51 $" },
            { "label": "Plus chargé mar", "figure": "145,10 $" },
            { "label": "Aucune limite atteinte" },
        ])
    );
    // No account open in Claude: no active part, the others still listed.
    let none = build(with_accounts_hits(Input {
        limits: limits(usage(), None),
        ..Input::default()
    }));
    assert!(none.active.is_none());
    assert_eq!(none.accounts.len(), 3);
    assert_eq!(none.week.unwrap().text.active_week, "");
}

#[test]
fn the_panda_is_happy_alarmed_from_80_of_the_five_hours_worried_at_a_full_limit_asleep_with_nothing_to_watch()
 {
    let mood = |five_hour: f64, week: f64| {
        build(with_accounts_hits(Input {
            limits: limits(
                usage_with(PERSONAL, reading(PERSONAL, five_hour, week)),
                Some(PERSONAL),
            ),
            ..Input::default()
        }))
        .mood
    };
    assert_eq!(mood(40.0, 50.0), WidgetMood::Happy);
    assert_eq!(mood(79.9, 50.0), WidgetMood::Happy);
    assert_eq!(mood(80.0, 50.0), WidgetMood::Alert);
    assert_eq!(
        build(with_accounts_hits(Input::default())).mood,
        WidgetMood::Alert
    );
    assert_eq!(mood(100.0, 50.0), WidgetMood::Worried);
    assert_eq!(mood(30.0, 100.0), WidgetMood::Worried);
    // No Relay account open in Claude, no accounts at all, or the first scan: asleep.
    assert_eq!(
        build(with_accounts_hits(Input {
            limits: limits(usage(), None),
            ..Input::default()
        }))
        .mood,
        WidgetMood::Sleeping
    );
    assert_eq!(build(Input::default()).mood, WidgetMood::Sleeping);
    assert_eq!(
        build(with_accounts_hits(Input {
            progress: WidgetProgress {
                complete: false,
                percent: 30.0
            },
            ..Input::default()
        }))
        .mood,
        WidgetMood::Sleeping
    );
    assert_eq!(
        widget_mood(WidgetState::Data, Some(WidgetMoodLimits::default())),
        WidgetMood::Happy
    );
    let en = || {
        build(with_accounts_hits(Input {
            language: Locale::En,
            ..Input::default()
        }))
    };
    assert_eq!(plain(&en().text.tokens), "1.3bn tokens");
    assert_eq!(en().text.api_title, "Today · API value");
}

#[test]
fn the_countdown_reads_h_mm_and_is_empty_once_the_window_renewed() {
    assert_eq!(
        widget_countdown(Some(now() + 110.0 * 60_000.0), now()),
        "1:50"
    );
    assert_eq!(
        widget_countdown(Some(now() + 7.0 * 60_000.0 - 30_000.0), now()),
        "0:07"
    );
    assert_eq!(widget_countdown(Some(now() - 1.0), now()), "");
    assert_eq!(widget_countdown(None, now()), "");
}

#[test]
fn the_visible_key_ignores_the_countdown_but_moves_with_limits_and_the_open_account() {
    let a = build(with_accounts_hits(Input::default()));
    assert_eq!(
        widget_visible_key(&a),
        widget_visible_key(&build(with_accounts_hits(Input {
            now: now() + 60_000.0,
            ..Input::default()
        })))
    );
    let higher = build(with_accounts_hits(Input {
        limits: limits(
            usage_with(PERSONAL, reading(PERSONAL, 97.0, 68.2)),
            Some(PERSONAL),
        ),
        ..Input::default()
    }));
    assert_ne!(widget_visible_key(&a), widget_visible_key(&higher));
    let switched = build(with_accounts_hits(Input {
        limits: limits(usage(), Some(VERTEX)),
        ..Input::default()
    }));
    assert_ne!(widget_visible_key(&a), widget_visible_key(&switched));
}

#[test]
fn a_switch_to_another_account_reloads_the_widgets_at_once_whatever_the_throttle_says() {
    let (_guard, dir) = temp_dir();
    let reloads: Reloads = Arc::default();
    let mut file = widget_file(&dir, &reloads, &Arc::new(Mutex::new(now())));
    file.write(&build(with_accounts_hits(Input::default())), false)
        .unwrap();
    let usage_moved = build(with_accounts_hits(Input {
        limits: limits(
            usage_with(PERSONAL, reading(PERSONAL, 97.0, 68.2)),
            Some(PERSONAL),
        ),
        ..Input::default()
    }));
    file.write(&usage_moved, false).unwrap();
    assert_eq!(count(&reloads), 1);
    file.write(
        &build(with_accounts_hits(Input {
            limits: limits(usage(), Some(VERTEX)),
            ..Input::default()
        })),
        false,
    )
    .unwrap();
    assert_eq!(count(&reloads), 2);
}
