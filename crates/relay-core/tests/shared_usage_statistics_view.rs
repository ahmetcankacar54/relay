//! Port of `tests/usage-statistics-view.test.ts`.

#[path = "common/shared_views.rs"]
mod helpers;

use helpers::{from_json, named, to_json, with};
use relay_core::shared::types::Account;
use relay_core::shared::types::js::{date_parse, iso, round};
use relay_core::shared::usage_rollups::{LimitHit, UsageRollups, empty_rollups, fold_samples};
use relay_core::shared::usage_statistics::{UsageSample, usage_identity};
use relay_core::shared::usage_statistics_view::{
    Insight, StatisticsInput, StatisticsStatus, UsageStatisticsView, build_statistics_view,
};
use relay_i18n::{Args, Locale, translate};
use serde_json::{Value, json};

const ZONE: &str = "Europe/Istanbul";
const H: f64 = 3_600_000.0;
// Wednesday 2026-10-14 15:00 in Istanbul (UTC+3).
fn now() -> f64 {
    date_parse("2026-10-14T12:00:00.000Z")
}

fn max() -> Account {
    named("max", "Max", "max5")
}
fn pro() -> Account {
    named("pro", "Pro", "pro")
}
fn unlinked() -> Account {
    Account {
        auth: None,
        ..named("none", "None", "pro")
    }
}
// Linked, but no usage in any range: no row.
fn spare() -> Account {
    named("spare", "Spare", "max20")
}
fn accounts() -> Vec<Account> {
    vec![max(), pro(), unlinked(), spare()]
}
fn max_id() -> String {
    usage_identity(&max()).unwrap()
}
fn pro_id() -> String {
    usage_identity(&pro()).unwrap()
}
fn old_id() -> String {
    serde_json::to_string(&["uuid", "gone", "org-gone"]).unwrap()
}

fn h(points: f64, windows: f64, covered_minutes: f64) -> Value {
    json!({ "points": points, "windows": windows, "coveredMinutes": covered_minutes })
}
fn h1(points: f64) -> Value {
    h(points, 0.0, 30.0)
}

fn rollups(hours: Value, windows: Value, hits: Value) -> UsageRollups {
    from_json(json!({ "version": 2, "hours": hours, "windows": windows, "hits": hits, "last": {} }))
}

fn fixture() -> UsageRollups {
    let (max, pro, old) = (max_id(), pro_id(), old_id());
    rollups(
        json!({
            max.clone(): {
                // Tue 2026-10-13 11:00 Istanbul
                "2026-10-13T08:00:00.000Z": h(4.0, 1.0, 60.0),
                // Sat 2026-10-10: observed but idle
                "2026-10-10T09:00:00.000Z": h1(0.0),
                // Sun 2026-10-11: polled once, no coverage, so not an idle day
                "2026-10-11T09:00:00.000Z": h(0.0, 0.0, 0.0),
                // previous 7-day period
                "2026-10-05T08:00:00.000Z": h1(2.0),
                // older than 90 days: ignored even for range 90
                "2026-06-01T08:00:00.000Z": h1(50.0),
            },
            // 22:00 UTC is 01:00 on Wed 2026-10-14 in Istanbul
            pro.clone(): { "2026-10-13T22:00:00.000Z": h(10.0, 1.0, 45.0) },
            old.clone(): { "2026-10-12T09:00:00.000Z": h1(0.0) },
        }),
        json!({
            max.clone(): [
                { "resetAt": "2026-10-01T10:00:00.000Z", "maxPercent": 100 },
                { "resetAt": "2026-10-13T12:00:00.000Z", "maxPercent": 30 },
                { "resetAt": "2026-10-13T18:00:00.000Z", "maxPercent": 50 },
                // still open at NOW: counted as started, not in averageFill
                { "resetAt": "2026-10-14T14:00:00.000Z", "maxPercent": 90 },
            ],
            pro.clone(): [{ "resetAt": "2026-10-14T02:00:00.000Z", "maxPercent": 70 }],
        }),
        json!([
            { "identity": max, "kind": "five-hour", "at": "2026-10-13T09:00:00.000Z", "until": "2026-10-13T10:10:00.000Z" },
            { "identity": pro, "kind": "weekly", "at": "2026-10-14T01:00:00.000Z" },
            { "identity": old, "kind": "five-hour", "at": "2026-10-12T09:30:00.000Z" },
            // before the range
            { "identity": max, "kind": "five-hour", "at": "2026-10-01T09:00:00.000Z" },
        ]),
    )
}

/// `build(over)`: the TS defaults, each overridable.
struct Build {
    rollups: Option<UsageRollups>,
    available: bool,
    accounts: Vec<Account>,
    range: u32,
    account_id: Option<&'static str>,
    zone: &'static str,
    now: f64,
}

impl Default for Build {
    fn default() -> Self {
        Build {
            rollups: Some(fixture()),
            available: true,
            accounts: accounts(),
            range: 7,
            account_id: None,
            zone: ZONE,
            now: now(),
        }
    }
}

impl Build {
    fn run(&self) -> UsageStatisticsView {
        build_statistics_view(&StatisticsInput {
            rollups: self.rollups.as_ref(),
            available: self.available,
            accounts: &self.accounts,
            range: self.range,
            account_id: self.account_id,
            zone: self.zone,
            now: self.now,
            hours: None,
        })
    }
}

fn build() -> UsageStatisticsView {
    Build::default().run()
}
fn with_rollups(r: UsageRollups) -> Build {
    Build {
        rollups: Some(r),
        ..Build::default()
    }
}

#[test]
fn pro_units_scale_points_by_plan_capacity_and_shares_split_the_total() {
    let view = build();
    assert_eq!(view.status, StatisticsStatus::Available);
    assert_eq!(view.range, 7);
    assert_eq!(view.totals.pro_units, 30.0);
    let rows: Vec<Value> = view
        .accounts
        .iter()
        .map(|a| json!([a.account_id, a.former, a.name, a.plan, a.pro_units, a.share]))
        .collect();
    assert_eq!(
        rows,
        vec![
            json!(["max", null, "Max", "Max 5×", 20.0, 66.7]),
            json!(["pro", null, "Pro", "Pro", 10.0, 33.3]),
            json!([null, true, "Eski hesap", null, 0.0, 0.0]),
        ]
    );
}

#[test]
fn daily_series_buckets_by_local_day_in_the_planning_zone() {
    let view = build();
    let dates: Vec<&str> = view.daily.iter().map(|d| d.date.as_str()).collect();
    assert_eq!(
        dates,
        [
            "2026-10-08",
            "2026-10-09",
            "2026-10-10",
            "2026-10-11",
            "2026-10-12",
            "2026-10-13",
            "2026-10-14"
        ]
    );
    let by_date = |view: &UsageStatisticsView, date: &str| {
        to_json(
            &view
                .daily
                .iter()
                .find(|d| d.date == date)
                .unwrap()
                .by_account,
        )
    };
    assert_eq!(by_date(&view, "2026-10-13"), json!({ "max": 20 }));
    assert_eq!(by_date(&view, "2026-10-14"), json!({ "pro": 10 }));
    assert_eq!(by_date(&view, "2026-10-10"), json!({}));

    let mut r = fixture();
    r.hours
        .get_mut(&old_id())
        .unwrap()
        .get_mut("2026-10-12T09:00:00.000Z")
        .unwrap()
        .points = 3.0;
    let old = with_rollups(r).run();
    assert_eq!(by_date(&old, "2026-10-12"), json!({ "former": 3 }));
}

#[test]
fn heatmap_is_weekday_mon_0_local_hour_in_pro_units() {
    let view = build();
    assert_eq!(view.heatmap.len(), 7);
    assert!(view.heatmap.iter().all(|row| row.len() == 24));
    assert_eq!(view.heatmap[1][11].0, 20.0);
    assert_eq!(view.heatmap[2][1].0, 10.0);
    let sum: f64 = view.heatmap.iter().flatten().map(|n| n.0).sum();
    assert_eq!(sum, 30.0);
}

#[test]
fn average_fill_uses_closed_windows_started_in_range_idle_days_are_covered_days_without_use() {
    let view = build();
    let row = |id: Option<&str>| {
        view.accounts
            .iter()
            .find(|a| a.account_id.as_deref() == id)
            .unwrap()
    };
    assert_eq!(row(Some("max")).average_fill, Some(40.0));
    assert_eq!(row(Some("pro")).average_fill, Some(70.0));
    assert_eq!(row(None).average_fill, None);
    assert_eq!(row(Some("max")).idle_days, 1);
    assert_eq!(row(Some("pro")).idle_days, 0);
    assert_eq!(row(None).idle_days, 1);
    assert_eq!(view.totals.windows, 4);
}

#[test]
fn previous_period_is_reported_only_for_ranges_up_to_45_days() {
    assert_eq!(build().totals.previous_pro_units, Some(10.0));
    assert_eq!(
        Build {
            range: 30,
            ..Build::default()
        }
        .run()
        .totals
        .previous_pro_units,
        Some(0.0)
    );
    assert_eq!(
        Build {
            range: 90,
            ..Build::default()
        }
        .run()
        .totals
        .previous_pro_units,
        None
    );
    assert_eq!(
        Build {
            range: 90,
            ..Build::default()
        }
        .run()
        .totals
        .pro_units,
        40.0
    );
}

#[test]
fn busiest_cell_and_weekday_10_18_work_share() {
    assert_eq!(
        to_json(&build().totals.busiest),
        json!({ "weekday": 1, "hour": 11, "workShare": 66.7 })
    );
    let empty = rollups(
        json!({ max_id(): { "2026-10-13T08:00:00.000Z": h1(0.0) } }),
        json!({}),
        json!([]),
    );
    assert_eq!(with_rollups(empty).run().totals.busiest, None);
}

fn insight_rollups(max_fills: &[f64], pro_fills: &[f64]) -> UsageRollups {
    let windows = |fills: &[f64]| -> Value {
        fills
            .iter()
            .enumerate()
            .map(|(i, fill)| {
                json!({
                    "resetAt": iso(date_parse("2026-10-09T10:00:00.000Z") + i as f64 * 6.0 * H),
                    "maxPercent": fill,
                })
            })
            .collect()
    };
    rollups(
        json!({
            max_id(): { "2026-10-13T08:00:00.000Z": h1(1.0) },
            pro_id(): { "2026-10-13T08:00:00.000Z": h1(1.0) },
        }),
        json!({ max_id(): windows(max_fills), pro_id(): windows(pro_fills) }),
        json!([]),
    )
}

/// The insight as Turkish and English text.
fn said(insight: &Option<Insight>) -> Option<(String, String)> {
    insight.as_ref().map(|i| {
        let args = Args::from_json(&Value::Object(i.params.clone()));
        (
            translate(Locale::Tr, &i.id, &args),
            translate(Locale::En, &i.id, &args),
        )
    })
}

fn pair(tr: &str, en: &str) -> Option<(String, String)> {
    Some((tr.to_string(), en.to_string()))
}

#[test]
fn insight_rule_1_highest_capacity_account_barely_fills_five_or_more_windows() {
    let view = with_rollups(insight_rollups(&[10.0, 10.0, 10.0, 10.0, 20.0], &[90.0])).run();
    assert_eq!(
        said(&view.insight),
        pair(
            "Max (Max 5×) dönemlerinin ortalama yalnızca %12 kadarını dolduruyor.",
            "Max (Max 5×) fills only 12% of its periods on average.",
        )
    );
}

#[test]
fn insight_rule_2_lowest_capacity_account_is_almost_always_full() {
    // Four windows are not enough for rule 1.
    let view = with_rollups(insight_rollups(&[10.0, 10.0, 10.0, 10.0], &[90.0, 85.0])).run();
    assert_eq!(
        said(&view.insight),
        pair(
            "Pro (Pro) açıldığında neredeyse hep doluyor.",
            "Pro (Pro) is almost always full when it opens."
        )
    );
}

#[test]
fn insight_an_idle_account_beside_a_full_one_suggests_shifting_the_order() {
    // Alto was last used on Thursday the 8th and observed idle every day since,
    // today included; Kişisel fills its windows.
    let alto = named("alto", "Alto", "max5");
    let kisisel = named("kisisel", "Kişisel", "pro");
    let anka = usage_identity(&alto).unwrap();
    let kisisel_id = usage_identity(&kisisel).unwrap();
    let idle_rollups = |idle_from: u32| {
        let mut alto_hours = serde_json::Map::new();
        alto_hours.insert("2026-10-08T08:00:00.000Z".into(), h1(2.0));
        for day in idle_from..=14 {
            alto_hours.insert(format!("2026-10-{day:02}T09:00:00.000Z"), h1(0.0));
        }
        // The 11th was not observed: it neither counts nor ends the idle days.
        alto_hours.insert("2026-10-11T09:00:00.000Z".into(), h(0.0, 0.0, 0.0));
        rollups(
            json!({ anka.clone(): alto_hours, kisisel_id.clone(): { "2026-10-13T08:00:00.000Z": h1(1.0) } }),
            json!({ kisisel_id.clone(): [
                { "resetAt": "2026-10-12T10:00:00.000Z", "maxPercent": 95 },
                { "resetAt": "2026-10-13T10:00:00.000Z", "maxPercent": 90 },
            ] }),
            json!([]),
        )
    };
    let both = vec![alto, kisisel];
    let run = |idle_from: u32, account_id: Option<&'static str>| {
        Build {
            accounts: both.clone(),
            rollups: Some(idle_rollups(idle_from)),
            account_id,
            ..Build::default()
        }
        .run()
    };
    assert_eq!(
        said(&run(9, None).insight),
        pair(
            "Alto 5 gündür boşta; Kişisel ise dönemi açıldığında neredeyse hep doluyor. 5 saatlik limite daha az takılmak için Alto hesabını sırada öne al.",
            "Alto was idle for the last 5 days; Kişisel is almost always full when it opens. Move Alto up the order to hit the 5-hour limit less often.",
        )
    );
    // Idle for two days only, or a single account's view: the plain note that Kişisel fills.
    let plain = pair(
        "Kişisel (Pro) açıldığında neredeyse hep doluyor.",
        "Kişisel (Pro) is almost always full when it opens.",
    );
    assert_eq!(said(&run(13, None).insight), plain);
    assert_eq!(said(&run(9, Some("kisisel")).insight), plain);
}

#[test]
fn no_insight_when_neither_rule_applies() {
    assert_eq!(
        with_rollups(insight_rollups(&[50.0, 50.0, 50.0, 50.0, 50.0], &[60.0]))
            .run()
            .insight,
        None
    );
}

#[test]
fn hits_are_named_newest_first_and_counted_per_kind() {
    let view = build();
    assert_eq!(
        to_json(&view.hits),
        json!([
            { "accountId": "pro", "name": "Pro", "kind": "weekly", "at": "2026-10-14T01:00:00.000Z" },
            {
                "accountId": "max",
                "name": "Max",
                "kind": "five-hour",
                "at": "2026-10-13T09:00:00.000Z",
                "until": "2026-10-13T10:10:00.000Z",
            },
            { "former": true, "name": "Eski hesap", "kind": "five-hour", "at": "2026-10-12T09:30:00.000Z" },
        ])
    );
    assert_eq!(
        to_json(&view.totals.hits),
        json!({ "fiveHour": 2, "weekly": 1 })
    );
}

#[test]
fn account_filter_keeps_only_that_account_s_identity() {
    let view = Build {
        account_id: Some("pro"),
        ..Build::default()
    }
    .run();
    assert_eq!(view.status, StatisticsStatus::Available);
    let ids: Vec<Option<&str>> = view
        .accounts
        .iter()
        .map(|a| a.account_id.as_deref())
        .collect();
    assert_eq!(ids, [Some("pro")]);
    assert_eq!(view.totals.pro_units, 10.0);
    assert_eq!(view.accounts[0].share, 100.0);
    let hits: Vec<Option<&str>> = view.hits.iter().map(|x| x.account_id.as_deref()).collect();
    assert_eq!(hits, [Some("pro")]);
    assert_eq!(
        Build {
            account_id: Some("none"),
            ..Build::default()
        }
        .run()
        .status,
        StatisticsStatus::Empty
    );
    assert_eq!(
        Build {
            account_id: Some("missing"),
            ..Build::default()
        }
        .run()
        .status,
        StatisticsStatus::Empty
    );
}

#[test]
fn unavailable_and_empty_states() {
    let unavailable = Build {
        available: false,
        ..Build::default()
    }
    .run();
    assert_eq!(unavailable.status, StatisticsStatus::Unavailable);
    assert!(unavailable.accounts.is_empty());
    assert_eq!(
        Build {
            rollups: None,
            ..Build::default()
        }
        .run()
        .status,
        StatisticsStatus::Empty
    );
    assert_eq!(
        with_rollups(empty_rollups()).run().status,
        StatisticsStatus::Empty
    );
    let stale = rollups(
        json!({ max_id(): { "2026-09-01T08:00:00.000Z": h1(4.0) } }),
        json!({}),
        json!([]),
    );
    let view = with_rollups(stale).run();
    assert_eq!(view.status, StatisticsStatus::Empty);
    assert_eq!(view.heatmap.len(), 7);
    assert_eq!(view.daily.len(), 7);
}

#[test]
fn coverage_is_observed_minutes_over_the_range_so_far() {
    let view = Build {
        range: 7,
        ..Build::default()
    }
    .run();
    // Range starts 2026-10-08 00:00 Istanbul (2026-10-07T21:00Z); 6.625 days to NOW.
    // Covered: max 60 + 30, pro 45, former 30 → per-hour max summed = 165 minutes.
    let minutes = (now() - date_parse("2026-10-07T21:00:00.000Z")) / 60_000.0;
    assert_eq!(
        view.coverage_percent,
        round((165.0 / minutes) * 1000.0) / 10.0
    );
}

#[test]
fn a_25_hour_dst_day_totals_the_sum_of_its_25_hourly_buckets() {
    let zone = "Europe/Berlin";
    let now = date_parse("2026-10-26T12:00:00.000Z");
    let mut hours = serde_json::Map::new();
    // 2026-10-25 00:00 CEST = 2026-10-24T22:00Z; 2026-10-26 00:00 CET = 23:00Z.
    for i in -2..27 {
        hours.insert(
            iso(date_parse("2026-10-24T22:00:00.000Z") + f64::from(i) * H),
            h1(1.0),
        );
    }
    let r = rollups(json!({ pro_id(): hours }), json!({}), json!([]));
    let view = Build {
        rollups: Some(r),
        zone,
        now,
        ..Build::default()
    }
    .run();
    let day = view.daily.iter().find(|d| d.date == "2026-10-25").unwrap();
    assert_eq!(to_json(&day.by_account), json!({ "pro": 25 }));
    // The repeated 02:00 hour lands in the same heatmap cell (Sunday = 6).
    assert_eq!(view.heatmap[6][2].0, 2.0);
    assert_eq!(view.heatmap[6].iter().map(|n| n.0).sum::<f64>(), 25.0);
}

#[test]
fn rows_without_in_range_hours_windows_or_hits_are_dropped() {
    let view = build();
    assert!(
        !view
            .accounts
            .iter()
            .any(|a| a.account_id.as_deref() == Some("spare"))
    );
    let mut r = fixture();
    r.hours.insert(
        old_id(),
        from_json(json!({ "2026-08-01T09:00:00.000Z": h1(5.0) })),
    );
    r.hits.retain(|hit| hit.identity != old_id());
    assert!(
        !with_rollups(r)
            .run()
            .accounts
            .iter()
            .any(|a| a.former.is_some())
    );
}

#[test]
fn polls_every_10_minutes_for_7_days_with_one_window_a_day_cover_the_range() {
    let now = date_parse("2026-10-14T12:00:00.000Z");
    let first = date_parse("2026-10-07T21:00:00.000Z"); // 2026-10-08 00:00 local
    let mut samples: Vec<UsageSample> = Vec::new();
    let mut t = first;
    while t <= now {
        let day_start = first + ((t - first) / 86_400_000.0).floor() * 86_400_000.0;
        let opened = day_start + 8.0 * H;
        let open = t >= opened && t < opened + 5.0 * H;
        let mut sample = json!({ "accountId": "max", "identity": max_id(), "checkedAt": iso(t) });
        if open {
            sample["fiveHour"] = json!({
                "usedPercent": f64::min(100.0, (t - opened) / 600_000.0),
                "resetsAt": iso(opened + 5.0 * H),
            });
        }
        samples.push(from_json(sample));
        t += 10.0 * 60_000.0;
    }
    let view = Build {
        rollups: Some(fold_samples(&samples, now)),
        now,
        ..Build::default()
    }
    .run();
    assert!(view.coverage_percent >= 99.0, "{}", view.coverage_percent);
    assert_eq!(view.totals.windows, 7);
    assert_eq!(view.accounts.len(), 1);
    assert_eq!(view.accounts[0].idle_days, 0);
}

#[test]
fn an_open_hit_whose_reset_has_passed_ends_at_that_reset() {
    let mut r = fixture();
    r.hits = from_json::<Vec<LimitHit>>(json!([
        { "identity": max_id(), "kind": "five-hour", "at": "2026-10-14T08:00:00.000Z", "resetAt": "2026-10-14T10:00:00.000Z" },
        { "identity": pro_id(), "kind": "five-hour", "at": "2026-10-14T10:00:00.000Z", "resetAt": "2026-10-14T13:00:00.000Z" },
    ]));
    let view = with_rollups(r.clone()).run();
    let hit = |id: &str| {
        view.hits
            .iter()
            .find(|x| x.account_id.as_deref() == Some(id))
            .unwrap()
            .clone()
    };
    assert_eq!(
        hit("max").until.as_deref(),
        Some("2026-10-14T10:00:00.000Z")
    );
    // The reset is still ahead: the hit is ongoing.
    assert!(to_json(&hit("pro")).get("until").is_none());
    // A reset exactly at now has passed.
    r.hits[1].reset_at = Some(iso(now()));
    let view = with_rollups(r).run();
    let pro_hit = view
        .hits
        .iter()
        .find(|x| x.account_id.as_deref() == Some("pro"))
        .unwrap();
    assert_eq!(pro_hit.until, Some(iso(now())));
}

fn signed_out(account: &Account) -> Account {
    let mut out = account.clone();
    out.auth.as_mut().unwrap().logged_in = false;
    out
}

#[test]
fn a_signed_out_account_keeps_its_history_under_its_own_name_and_plan() {
    let signed_out = signed_out(&max());
    let view = Build {
        accounts: vec![signed_out.clone(), pro(), unlinked(), spare()],
        ..Build::default()
    }
    .run();
    let rows: Vec<Value> = view
        .accounts
        .iter()
        .map(|a| json!([a.account_id, a.former, a.pro_units]))
        .collect();
    assert_eq!(
        rows,
        vec![
            json!(["max", null, 20.0]),
            json!(["pro", null, 10.0]),
            json!([null, true, 0.0])
        ]
    );
    assert_eq!(
        view.hits
            .iter()
            .find(|x| x.at == "2026-10-13T09:00:00.000Z")
            .unwrap()
            .account_id
            .as_deref(),
        Some("max")
    );
    let filtered = Build {
        accounts: vec![signed_out, pro()],
        account_id: Some("max"),
        ..Build::default()
    }
    .run();
    assert_eq!(filtered.status, StatisticsStatus::Available);
    assert_eq!(filtered.totals.pro_units, 20.0);
}

#[test]
fn a_signed_in_account_claims_an_identity_it_shares_with_a_signed_out_one() {
    let stale = signed_out(&with(
        &max(),
        json!({ "id": "stale", "name": "Stale", "planning": { "plan": "pro", "capacityWeight": 1 } }),
    ));
    let view = Build {
        accounts: vec![stale, max(), pro()],
        ..Build::default()
    }
    .run();
    let rows: Vec<Value> = view
        .accounts
        .iter()
        .map(|a| json!([a.account_id, a.pro_units]))
        .collect();
    assert_eq!(
        rows,
        vec![
            json!(["max", 20.0]),
            json!(["pro", 10.0]),
            json!([null, 0.0])
        ]
    );
    // Among equals the account list order decides.
    let twin = with(&max(), json!({ "id": "twin", "name": "Twin" }));
    let view = Build {
        accounts: vec![twin, max(), pro()],
        ..Build::default()
    }
    .run();
    assert_eq!(view.accounts[0].account_id.as_deref(), Some("twin"));
}

#[test]
fn the_previous_period_is_compared_only_when_recording_reaches_back_to_its_start() {
    // Range 7 at NOW: the previous period starts 2026-10-01 00:00 Istanbul.
    let start = "2026-09-30T21:00:00.000Z";
    let mut r = rollups(
        json!({ max_id(): { "2026-10-06T08:00:00.000Z": h1(2.0), "2026-10-13T08:00:00.000Z": h1(4.0) } }),
        json!({}),
        json!([]),
    );
    // Recording began inside the previous period: no comparison.
    assert_eq!(
        with_rollups(r.clone()).run().totals.previous_pro_units,
        None
    );
    r.hours
        .get_mut(&max_id())
        .unwrap()
        .insert(start, from_json(h1(0.0)));
    assert_eq!(
        with_rollups(r.clone()).run().totals.previous_pro_units,
        Some(10.0)
    );
    // Only identities in the view count: Pro's own history starts later.
    r.hours.insert(
        pro_id(),
        from_json(json!({ "2026-10-13T22:00:00.000Z": h1(1.0) })),
    );
    assert_eq!(
        Build {
            rollups: Some(r),
            account_id: Some("pro"),
            ..Build::default()
        }
        .run()
        .totals
        .previous_pro_units,
        None
    );
}
