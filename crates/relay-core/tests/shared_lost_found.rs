//! Port of `tests/lost-found.test.ts`.

#[path = "common/shared_views.rs"]
mod helpers;

use helpers::{from_json, to_json, with};
use relay_core::shared::lost_found::{
    LOST_ITEM_KINDS, LostFoundCollection, LostFoundInput, LostFoundWeek, LostItemKind, LostSegment,
    LostTier, add_days, lost_found_collection, lost_found_week, model_family, monday_of, next_tier,
    tier_of, valid_lost_item,
};
use relay_core::shared::types::Account;
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::usage_rollups::UsageRollups;
use relay_core::token_ledger::{LedgerDays, LedgerSlots};
use serde_json::{Value, json};

// Monday 19 October 2026, 13:00 in Istanbul (UTC+3): the newest complete week is 12–18 October,
// which runs from 11 October 21:00 UTC to 18 October 21:00 UTC.
const ZONE: &str = "Europe/Istanbul";
const H: f64 = 3_600_000.0;
const MIN: f64 = 60_000.0;
fn now() -> f64 {
    date_parse("2026-10-19T10:00:00Z")
}
/// UTC time on a day of October 2026 (`Date.UTC` rolls hours past 23 over).
fn oct(day: u32, hour: u32) -> f64 {
    oct_m(day, hour, 0)
}
fn oct_m(day: u32, hour: u32, minute: u32) -> f64 {
    date_parse("2026-10-01T00:00:00Z")
        + f64::from(day - 1) * 24.0 * H
        + f64::from(hour) * H
        + f64::from(minute) * MIN
}

fn account(id: &str, n: u32) -> Account {
    from_json(json!({
        "id": id,
        "name": id.to_uppercase(),
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        // The TS fixture casts away `checkedAt`; the Rust type requires it and the bureau ignores it.
        "auth": {
            "loggedIn": true,
            "accountUuid": format!("uuid-{n}"),
            "orgId": format!("org-{n}"),
            "checkedAt": "2026-09-01T00:00:00.000Z",
        },
        "createdAt": "2026-09-01T00:00:00.000Z",
        "desktop": { "accountUuid": format!("uuid-{n}"), "orgId": format!("org-{n}"), "savedAt": iso(now()) },
    }))
}
fn a() -> Account {
    account("a", 1)
}
fn b() -> Account {
    account("b", 2)
}
fn c() -> Account {
    account("c", 3)
}
fn identity(n: u32) -> String {
    serde_json::to_string(&["uuid".to_string(), format!("uuid-{n}"), format!("org-{n}")]).unwrap()
}

fn rollups(hours: Value, windows: Value, hits: Value) -> UsageRollups {
    from_json(json!({ "version": 2, "hours": hours, "windows": windows, "hits": hits, "last": {} }))
}
fn hours(hours: Value) -> UsageRollups {
    rollups(hours, json!({}), json!([]))
}
fn hits(hits: Value) -> UsageRollups {
    rollups(json!({}), json!({}), hits)
}
/// Active hours for account `n`, each with one point.
fn active(n: u32, times: &[f64]) -> Value {
    let mut by_hour = serde_json::Map::new();
    for t in times {
        by_hour.insert(
            iso(*t),
            json!({ "points": 1, "windows": 1, "coveredMinutes": 60 }),
        );
    }
    json!({ identity(n): by_hour })
}
/// `{ ...a, ...b, … }`.
fn merge(parts: &[Value]) -> Value {
    let mut out = serde_json::Map::new();
    for part in parts {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// `input(parts)`: the TS defaults, each overridable.
struct Input {
    rollups: Option<UsageRollups>,
    segments: Vec<LostSegment>,
    ledger_days: LedgerDays,
    ledger_slots: Option<LedgerSlots>,
    slots_since: Option<f64>,
    accounts: Vec<Account>,
    zone: &'static str,
    now: f64,
    week_start: Option<&'static str>,
}

impl Default for Input {
    fn default() -> Self {
        Input {
            rollups: Some(rollups(json!({}), json!({}), json!([]))),
            segments: Vec::new(),
            ledger_days: LedgerDays::new(),
            ledger_slots: None,
            slots_since: None,
            accounts: vec![a(), b(), c()],
            zone: ZONE,
            now: now(),
            week_start: None,
        }
    }
}

impl Input {
    fn input(&self) -> LostFoundInput<'_> {
        LostFoundInput {
            rollups: self.rollups.as_ref(),
            segments: &self.segments,
            ledger_days: &self.ledger_days,
            ledger_slots: self.ledger_slots.as_ref(),
            slots_since: self.slots_since,
            accounts: &self.accounts,
            zone: self.zone,
            now: self.now,
            week_start: self.week_start,
        }
    }
    fn week(&self) -> LostFoundWeek {
        lost_found_week(&self.input())
    }
    fn collection(&self) -> LostFoundCollection {
        lost_found_collection(&self.input())
    }
}

fn week_of(r: UsageRollups) -> LostFoundWeek {
    Input {
        rollups: Some(r),
        ..Input::default()
    }
    .week()
}
fn kinds(week: &LostFoundWeek) -> Vec<LostItemKind> {
    week.items.iter().map(|item| item.moment.kind()).collect()
}
/// The item of `kind` as its JSON, or `None`.
fn item_of(week: &LostFoundWeek, kind: LostItemKind) -> Option<Value> {
    week.items
        .iter()
        .find(|item| item.moment.kind() == kind)
        .map(to_json)
}

/// Ledger counts as the TS fixtures write them (`responses` is required by the Rust ledger type).
fn ledger_counts(tokens: f64, cost: Option<f64>) -> Value {
    let mut value =
        json!({ "input": tokens, "output": 0, "cacheWrite": 0, "cacheRead": 0, "responses": 0 });
    if let Some(cost) = cost {
        value["cost"] = json!(cost);
    }
    value
}
fn ledger_day(who: &str, model: &str, tokens: f64, cost: f64) -> Value {
    json!({ who: { model: ledger_counts(tokens, Some(cost)) } })
}
fn ledger_days(entries: &[(String, Value)]) -> LedgerDays {
    let mut map = serde_json::Map::new();
    for (date, day) in entries {
        map.insert(date.clone(), day.clone());
    }
    from_json(Value::Object(map))
}

fn segment(n: u32, from: f64, to: Option<f64>) -> Value {
    let mut value = json!({ "accountUuid": format!("uuid-{n}"), "orgId": format!("org-{n}"), "from": iso(from) });
    if let Some(to) = to {
        value["to"] = json!(iso(to));
    }
    value
}
fn segments(values: &[Value]) -> Vec<LostSegment> {
    values.iter().map(|v| from_json(v.clone())).collect()
}

#[test]
fn mondays_and_day_arithmetic() {
    assert_eq!(monday_of("2026-10-14"), "2026-10-12");
    assert_eq!(monday_of("2026-10-12"), "2026-10-12");
    assert_eq!(monday_of("2026-10-18"), "2026-10-12");
    assert_eq!(add_days("2026-10-30", 3.0), "2026-11-02");
}

#[test]
fn the_bureau_opens_the_newest_complete_week_any_monday_of_the_last_twelve_weeks_and_nothing_else()
{
    let week = Input::default().week();
    assert_eq!(
        (
            week.start.as_str(),
            week.end.as_str(),
            week.latest.as_str(),
            week.oldest.as_str()
        ),
        ("2026-10-12", "2026-10-18", "2026-10-12", "2026-07-27")
    );
    let start = |week_start: &'static str| {
        Input {
            week_start: Some(week_start),
            ..Input::default()
        }
        .week()
        .start
    };
    assert_eq!(start("2026-10-14"), "2026-10-12");
    assert_eq!(start("2026-10-05"), "2026-10-05");
    assert_eq!(start("2026-07-27"), "2026-07-27");
    // The running week is not complete, and older weeks are out of reach: both open the newest.
    assert_eq!(start("2026-10-19"), "2026-10-12");
    assert_eq!(start("2026-07-20"), "2026-10-12");
    assert!(week.items.is_empty());
}

#[test]
fn hourglass_the_five_hour_window_that_ran_out_soonest_after_it_began_within_two_and_a_half_hours()
{
    let hit = |n: u32, started_at: f64, minutes: f64, kind: &str| {
        json!({
            "identity": identity(n),
            "kind": kind,
            "at": iso(started_at + minutes * MIN),
            "resetAt": iso(started_at + 5.0 * H),
        })
    };
    let week = week_of(hits(json!([
        hit(1, oct(13, 6), 120.0, "five-hour"),
        hit(2, oct(14, 6), 66.0, "five-hour"),
        hit(3, oct(15, 6), 30.0, "weekly"),
        hit(3, oct(16, 6), 151.0, "five-hour"),
        // Outside the week.
        hit(1, oct(10, 6), 10.0, "five-hour"),
    ])));
    assert_eq!(
        item_of(&week, LostItemKind::Hourglass),
        Some(
            json!({ "kind": "hourglass", "at": iso(oct(14, 6) + 66.0 * MIN), "accountId": "b", "minutes": 66 })
        )
    );
    assert_eq!(
        week_of(hits(json!([hit(1, oct(13, 6), 151.0, "five-hour")])))
            .items
            .len(),
        0
    );
}

#[test]
fn boomerang_off_to_another_account_and_back_within_fifteen_minutes() {
    let run = |values: &[Value]| {
        item_of(
            &Input {
                segments: segments(values),
                ..Input::default()
            }
            .week(),
            LostItemKind::Boomerang,
        )
    };
    let segs = [
        segment(1, oct(14, 9), Some(oct_m(14, 11, 10))),
        segment(2, oct_m(14, 11, 10), Some(oct_m(14, 11, 18))),
        segment(1, oct_m(14, 11, 18), Some(oct(14, 18))),
    ];
    assert_eq!(
        run(&segs),
        Some(
            json!({ "kind": "boomerang", "at": iso(oct_m(14, 11, 10)), "accountIds": ["a", "b"], "minutes": 8 })
        )
    );
    let long = [
        segs[0].clone(),
        segment(2, oct_m(14, 11, 10), Some(oct_m(14, 11, 26))),
        segment(1, oct_m(14, 11, 26), None),
    ];
    assert_eq!(run(&long), None);
    // An account Relay does not know cannot be the place you went.
    let mut stranger = segs[1].clone();
    stranger["accountUuid"] = json!("uuid-9");
    assert_eq!(run(&[segs[0].clone(), stranger, segs[2].clone()]), None);
    // After a gap (Relay or the Claude app closed), how long B lasted is unknown: no boomerang.
    let gap = [
        segment(1, oct(1, 9), Some(oct(1, 10))),
        segment(2, oct_m(14, 11, 10), Some(oct_m(14, 11, 15))),
        segment(1, oct_m(14, 11, 16), None),
    ];
    assert_eq!(run(&gap), None);
}

#[test]
fn trophy_the_week_s_busiest_token_day_when_it_is_also_the_busiest_of_the_last_30_days() {
    let day = |tokens: f64| json!({ "acct:a": { "model": ledger_counts(tokens, None) } });
    let run = |entries: &[(String, Value)]| {
        item_of(
            &Input {
                ledger_days: ledger_days(entries),
                ..Input::default()
            }
            .week(),
            LostItemKind::Trophy,
        )
    };
    let mut entries: Vec<(String, Value)> = (1..=9)
        .map(|i| (add_days("2026-10-14", -f64::from(i)), day(100.0)))
        .collect();
    entries.push(("2026-10-14".into(), day(430.0)));
    entries.push(("2026-10-15".into(), day(200.0)));
    assert_eq!(
        run(&entries),
        Some(json!({
            "kind": "trophy",
            "date": "2026-10-14",
            "tokens": 430,
            "times": 4.3,
            // The day's tokens and their API value, here unpriced.
            "spend": { "tokens": 430, "cost": 0 },
        }))
    );
    // A busier day within the 30 days takes the record away.
    entries.push(("2026-09-20".into(), day(500.0)));
    assert_eq!(run(&entries), None);
    // So does having fewer than five other active days to compare with…
    let mut few = vec![("2026-10-14".to_string(), day(430.0))];
    few.extend((1..=4).map(|i| (add_days("2026-10-14", -f64::from(i)), day(100.0))));
    assert_eq!(run(&few), None);
    // …and a day barely ahead of an ordinary one.
    let mut close = vec![("2026-10-14".to_string(), day(140.0))];
    close.extend((1..=9).map(|i| (add_days("2026-10-14", -f64::from(i)), day(100.0))));
    assert_eq!(run(&close), None);
}

#[test]
fn scroll_eight_active_hours_in_a_row_any_account_seven_are_not_enough() {
    let eight: Vec<f64> = (0..8).map(|i| oct(16, 8 + i)).collect();
    let week = week_of(hours(merge(&[
        active(1, &eight[..4]),
        active(2, &eight[4..]),
    ])));
    assert_eq!(
        item_of(&week, LostItemKind::Scroll),
        Some(json!({ "kind": "scroll", "at": iso(oct(16, 8)), "hours": 8 }))
    );
    let seven = week_of(hours(active(1, &eight[1..])));
    assert_eq!(item_of(&seven, LostItemKind::Scroll), None);
}

#[test]
fn scarf_three_accounts_on_one_local_day_busiest_first_a_local_day_starts_at_21_00_utc() {
    let h = merge(&[
        // 13 October 21:00 UTC is 14 October 00:00 in Istanbul.
        active(1, &[oct(13, 21)]),
        json!({ identity(2): { iso(oct(14, 9)): { "points": 3, "windows": 1, "coveredMinutes": 60 } } }),
        active(3, &[oct(14, 12)]),
    ]);
    assert_eq!(
        item_of(&week_of(hours(h)), LostItemKind::Scarf),
        Some(json!({ "kind": "scarf", "date": "2026-10-14", "accountIds": ["b", "a", "c"] }))
    );
    let two = merge(&[active(1, &[oct(14, 9)]), active(2, &[oct(14, 10)])]);
    assert_eq!(item_of(&week_of(hours(two)), LostItemKind::Scarf), None);
}

fn window(time: f64) -> Value {
    json!({ "resetAt": iso(time), "maxPercent": 50 })
}

#[test]
fn clocks_two_accounts_windows_resetting_within_ten_minutes_the_closest_pair_is_shown_all_are_counted()
 {
    let week = week_of(rollups(
        json!({}),
        json!({
            identity(1): [window(oct_m(14, 14, 10)), window(oct(16, 9))],
            identity(2): [window(oct_m(14, 14, 15)), window(oct(16, 9))],
            // Eleven minutes apart: not a pair.
            identity(3): [window(oct(15, 8)), window(oct_m(15, 8, 11))],
        }),
        json!([]),
    ));
    assert_eq!(
        item_of(&week, LostItemKind::Clocks),
        Some(
            json!({ "kind": "clocks", "at": iso(oct(16, 9)), "accountIds": ["a", "b"], "gapMinutes": 0, "count": 2 })
        )
    );
}

#[test]
fn spare_an_account_never_used_while_others_ran_into_five_hour_limits() {
    let hit = json!({ "identity": identity(1), "kind": "five-hour", "at": iso(oct(14, 9)), "resetAt": iso(oct(14, 12)) });
    let h = merge(&[active(1, &[oct(14, 6)]), active(2, &[oct(14, 7)])]);
    assert_eq!(
        item_of(
            &week_of(rollups(h.clone(), json!({}), json!([hit.clone()]))),
            LostItemKind::Spare
        ),
        Some(json!({ "kind": "spare", "accountIds": ["c"], "hits": 1 }))
    );
    assert_eq!(
        item_of(&week_of(hours(h.clone())), LostItemKind::Spare),
        None
    );
    // An account added after the week began, or one sharing another's usage identity, sat nothing out.
    let late = with(
        &account("d", 4),
        json!({ "createdAt": "2026-10-17T00:00:00.000Z" }),
    );
    let twin = with(&account("e", 1), json!({ "id": "e" }));
    let week = Input {
        accounts: vec![a(), b(), c(), late, twin],
        rollups: Some(rollups(h, json!({}), json!([hit]))),
        ..Input::default()
    }
    .week();
    assert_eq!(
        item_of(&week, LostItemKind::Spare).map(|v| v["accountIds"].clone()),
        Some(json!(["c"]))
    );
}

#[test]
fn clocks_count_every_pair_of_accounts_within_the_gap_not_only_neighbours() {
    let week = week_of(rollups(
        json!({}),
        json!({
            identity(1): [window(oct(14, 10))],
            identity(2): [window(oct_m(14, 10, 4))],
            identity(3): [window(oct_m(14, 10, 8))],
        }),
        json!([]),
    ));
    let clocks = item_of(&week, LostItemKind::Clocks).unwrap();
    assert_eq!(clocks["count"], json!(3));
    assert_eq!(clocks["gapMinutes"], json!(4));
}

#[test]
fn in_a_zone_half_an_hour_off_utc_an_hour_bucket_counts_where_most_of_it_lies() {
    // Asia/Kolkata is UTC+5:30: the 22:00 UTC bucket is 03:30–04:30 there, a night hour; the 23:00 one,
    // 04:30–05:30, is mostly morning.
    let h = active(1, &[oct(14, 22), oct(14, 23)]);
    let week = Input {
        zone: "Asia/Kolkata",
        rollups: Some(hours(h)),
        ..Input::default()
    }
    .week();
    assert_eq!(
        item_of(&week, LostItemKind::Feather),
        Some(json!({ "kind": "feather", "at": iso(oct(14, 22)), "hours": 1 }))
    );
}

#[test]
fn a_kept_item_is_told_only_when_it_has_what_its_kind_needs() {
    assert!(valid_lost_item(
        &json!({ "kind": "hourglass", "at": "2026-10-14T06:56:00Z", "minutes": 66 })
    ));
    assert!(valid_lost_item(
        &json!({ "kind": "scarf", "date": "2026-10-14", "accountIds": ["a", "b", "c"] })
    ));
    assert!(!valid_lost_item(
        &json!({ "kind": "hourglass", "at": "yesterday", "minutes": 66 })
    ));
    assert!(!valid_lost_item(
        &json!({ "kind": "trophy", "date": "2026-10-14", "tokens": 5 })
    ));
    assert!(!valid_lost_item(&json!({ "kind": "unicorn" })));
    assert!(!valid_lost_item(&Value::Null));
}

#[test]
fn feather_hours_after_local_midnight_the_latest_is_the_one_nearest_morning() {
    // 01:00 and 04:00 in Istanbul.
    let h = active(1, &[oct(14, 22), oct(15, 1), oct(15, 9)]);
    assert_eq!(
        item_of(&week_of(hours(h)), LostItemKind::Feather),
        Some(json!({ "kind": "feather", "at": iso(oct(15, 1)), "hours": 2 }))
    );
}

#[test]
fn the_items_come_most_striking_first_so_the_first_is_the_week_s_featured_one() {
    let eight: Vec<f64> = (0..9).map(|i| oct(14, 20 + i)).collect();
    let week = week_of(rollups(
        merge(&[active(1, &eight), active(2, &[oct(14, 9)])]),
        json!({
            identity(1): [{ "resetAt": iso(oct(16, 9)), "maxPercent": 10 }],
            identity(2): [{ "resetAt": iso(oct_m(16, 9, 5)), "maxPercent": 10 }],
        }),
        json!([{ "identity": identity(1), "kind": "five-hour", "at": iso(oct(14, 7)), "resetAt": iso(oct(14, 11)) }]),
    ));
    let found = kinds(&week);
    let ordered: Vec<LostItemKind> = LOST_ITEM_KINDS
        .iter()
        .copied()
        .filter(|k| found.contains(k))
        .collect();
    assert_eq!(found, ordered);
    assert_eq!(found[0], LostItemKind::Hourglass);
}

#[test]
fn baton_the_account_in_the_claude_app_hits_a_limit_and_another_takes_over_at_once_the_quickest_is_shown_all_are_counted()
 {
    let hit = |n: u32, at: f64, kind: &str| json!({ "identity": identity(n), "kind": kind, "at": iso(at), "resetAt": iso(at + 2.0 * H) });
    let run = |segs: &[Value], hit_list: Value| {
        item_of(
            &Input {
                segments: segments(segs),
                rollups: Some(hits(hit_list)),
                ..Input::default()
            }
            .week(),
            LostItemKind::Baton,
        )
    };
    let segs = [
        segment(1, oct(14, 9), Some(oct_m(14, 11, 4))),
        segment(2, oct_m(14, 11, 4), Some(oct_m(15, 9, 1))),
        // The poll saw the limit a minute after Relay had already switched.
        segment(3, oct_m(15, 9, 1), Some(oct(15, 12))),
    ];
    let hit_list = json!([
        hit(1, oct(14, 11), "five-hour"),
        hit(2, oct_m(15, 9, 2), "five-hour"),
        // The same poll saw the weekly limit too: still one hand-over.
        hit(2, oct_m(15, 9, 2), "weekly"),
    ]);
    assert_eq!(
        run(&segs, hit_list),
        Some(
            json!({ "kind": "baton", "at": iso(oct_m(15, 9, 1)), "accountIds": ["b", "c"], "minutes": 0, "count": 2 })
        )
    );
    // A switch long after the hit is not a hand-over, nor is a hit on an account not in the Claude app.
    let late = [
        segment(1, oct(14, 9), Some(oct_m(14, 11, 40))),
        segment(2, oct_m(14, 11, 40), None),
    ];
    assert_eq!(run(&late, json!([hit(1, oct(14, 11), "five-hour")])), None);
    let elsewhere = [
        segment(1, oct(14, 9), Some(oct_m(14, 11, 4))),
        segment(2, oct_m(14, 11, 4), None),
    ];
    assert_eq!(
        run(&elsewhere, json!([hit(3, oct(14, 11), "five-hour")])),
        None
    );
    // After a gap the Claude app was closed: nobody handed anything over.
    let gap = [
        segment(1, oct(14, 9), Some(oct(14, 10))),
        segment(2, oct_m(14, 11, 4), None),
    ];
    assert_eq!(run(&gap, json!([hit(1, oct(14, 11), "five-hour")])), None);
}

#[test]
fn tally_active_hours_on_every_local_day_of_the_week_six_days_are_not_enough() {
    // Noon in Istanbul, Monday 12 to Sunday 18 October.
    let days: Vec<f64> = (0..7).map(|i| oct(12 + i, 9)).collect();
    let mut with_extra = days.clone();
    with_extra.push(oct(14, 10));
    assert_eq!(
        item_of(&week_of(hours(active(1, &with_extra))), LostItemKind::Tally),
        Some(json!({ "kind": "tally", "hours": 8 }))
    );
    assert_eq!(
        item_of(&week_of(hours(active(1, &days[1..]))), LostItemKind::Tally),
        None
    );
}

#[test]
fn compass_twenty_active_hours_and_no_limit_hit_nor_one_still_holding_when_the_week_began() {
    let twenty: Vec<f64> = (0..20)
        .map(|i| oct(13, 6) + f64::from(i) * 2.0 * H)
        .collect();
    let h = active(1, &twenty);
    let compass = |hit_list: Value| {
        item_of(
            &week_of(rollups(h.clone(), json!({}), hit_list)),
            LostItemKind::Compass,
        )
    };
    assert_eq!(
        compass(json!([])),
        Some(json!({ "kind": "compass", "hours": 20 }))
    );
    assert_eq!(
        item_of(
            &week_of(hours(active(1, &twenty[1..]))),
            LostItemKind::Compass
        ),
        None
    );
    let inside = json!({ "identity": identity(2), "kind": "five-hour", "at": iso(oct(15, 9)) });
    assert_eq!(compass(json!([inside])), None);
    let holding = json!({ "identity": identity(2), "kind": "weekly", "at": iso(oct(10, 9)), "until": iso(oct(13, 9)) });
    assert_eq!(compass(json!([holding.clone()])), None);
    let mut over = holding;
    over["until"] = json!(iso(oct(11, 9)));
    assert_eq!(
        compass(json!([over])).map(|v| v["hours"].clone()),
        Some(json!(20))
    );
}

#[test]
fn tea_glass_hours_from_five_to_eight_in_the_morning_the_earliest_is_the_one_nearest_dawn() {
    // 05:00, 07:00 and 08:00 in Istanbul; eight is no longer morning.
    let h = active(1, &[oct(14, 4), oct(15, 2), oct(15, 5)]);
    assert_eq!(
        item_of(&week_of(hours(h)), LostItemKind::Teaglass),
        Some(json!({ "kind": "teaglass", "at": iso(oct(15, 2)), "hours": 2 }))
    );
    assert_eq!(
        item_of(
            &week_of(hours(active(1, &[oct(15, 5)]))),
            LostItemKind::Teaglass
        ),
        None
    );
}

#[test]
fn the_new_kinds_are_told_only_when_they_have_what_they_need() {
    assert!(valid_lost_item(
        &json!({ "kind": "baton", "at": "2026-10-14T08:04:00Z", "accountIds": ["a", "b"], "minutes": 4, "count": 1 })
    ));
    assert!(!valid_lost_item(
        &json!({ "kind": "baton", "at": "2026-10-14T08:04:00Z", "accountIds": ["a", "b"], "minutes": 4 })
    ));
    assert!(valid_lost_item(&json!({ "kind": "tally", "hours": 30 })));
    assert!(!valid_lost_item(&json!({ "kind": "compass" })));
    assert!(valid_lost_item(
        &json!({ "kind": "teaglass", "at": "2026-10-15T02:00:00Z", "hours": 2 })
    ));
}

#[test]
fn the_collection_lists_each_kind_s_weeks_within_reach_newest_first() {
    // Night hours in the newest week and three weeks before it; a morning hour two weeks before.
    let h = active(
        1,
        &[
            oct(14, 22),
            oct(1, 22),
            oct(1, 23),
            oct(2, 3),
            date_parse("2026-09-23T22:00:00Z"),
        ],
    );
    let collection = Input {
        rollups: Some(hours(h)),
        ..Input::default()
    }
    .collection();
    assert_eq!(collection.latest, "2026-10-12");
    assert_eq!(collection.oldest, "2026-07-27");
    let weeks = |kind: LostItemKind| -> Vec<String> {
        collection.found.get(&kind).map_or(Vec::new(), |finds| {
            finds
                .iter()
                .map(|find| format!("{}…{}", find.start, find.end))
                .collect()
        })
    };
    assert_eq!(
        weeks(LostItemKind::Feather),
        [
            "2026-10-12…2026-10-18",
            "2026-09-28…2026-10-04",
            "2026-09-21…2026-09-27"
        ]
    );
    assert_eq!(weeks(LostItemKind::Teaglass), ["2026-09-28…2026-10-04"]);
    // Each find tells its own week's story.
    assert_eq!(
        to_json(&collection.found.get(&LostItemKind::Feather).unwrap()[1].item),
        json!({ "kind": "feather", "at": iso(oct(1, 23)), "hours": 2 })
    );
}

#[test]
fn a_pin_s_finish_bronze_on_the_first_week_silver_on_the_third_gold_on_the_sixth() {
    assert_eq!(tier_of(0.0), None);
    assert_eq!(tier_of(1.0), Some(LostTier::Bronze));
    assert_eq!(tier_of(2.0), Some(LostTier::Bronze));
    assert_eq!(tier_of(3.0), Some(LostTier::Silver));
    assert_eq!(tier_of(6.0), Some(LostTier::Gold));
    assert_eq!(tier_of(40.0), Some(LostTier::Gold));
    assert_eq!(next_tier(1.0), Some((LostTier::Silver, 3)));
    assert_eq!(next_tier(6.0), None);
}

#[test]
fn tightrope_the_fullest_five_hour_window_that_never_hit_its_limit_95_or_more() {
    let window =
        |time: f64, max_percent: f64| json!({ "resetAt": iso(time), "maxPercent": max_percent });
    let week = week_of(rollups(
        json!({}),
        json!({
            identity(1): [window(oct(14, 12), 97.4), window(oct(15, 12), 99.2), window(oct(16, 12), 100.0)],
            identity(2): [window(oct(13, 12), 94.0)],
        }),
        // The 99 % window did hit its limit, a poll before the reset.
        json!([{ "identity": identity(1), "kind": "five-hour", "at": iso(oct(15, 11)), "resetAt": iso(oct_m(15, 12, 1)) }]),
    ));
    assert_eq!(
        item_of(&week, LostItemKind::Tightrope),
        Some(
            json!({ "kind": "tightrope", "at": iso(oct(14, 12)), "accountId": "a", "percent": 97 })
        )
    );
}

#[test]
fn lantern_both_weekend_days_active_six_hours_or_more_over_them() {
    // Saturday 17 and Sunday 18 October, from noon in Istanbul.
    let weekend = |n: u32| -> Vec<f64> {
        (0..3)
            .map(|i| oct(17, 9 + i))
            .chain((0..n - 3).map(|i| oct(18, 9 + i)))
            .collect()
    };
    assert_eq!(
        item_of(
            &week_of(hours(active(1, &weekend(6)))),
            LostItemKind::Lantern
        ),
        Some(json!({ "kind": "lantern", "hours": 6 }))
    );
    assert_eq!(
        item_of(
            &week_of(hours(active(1, &weekend(5)))),
            LostItemKind::Lantern
        ),
        None
    );
    let saturday: Vec<f64> = (0..6).map(|i| oct(17, 9 + i)).collect();
    assert_eq!(
        item_of(&week_of(hours(active(1, &saturday))), LostItemKind::Lantern),
        None
    );
}

#[test]
fn hammock_a_weekday_off_between_two_active_days_in_a_week_of_four_active_days_or_more() {
    let days = |dates: &[u32]| active(1, &dates.iter().map(|day| oct(*day, 9)).collect::<Vec<_>>());
    assert_eq!(
        item_of(
            &week_of(hours(days(&[12, 13, 15, 16]))),
            LostItemKind::Hammock
        ),
        Some(json!({ "kind": "hammock", "date": "2026-10-14", "activeDays": 4 }))
    );
    // Three active days are not a busy week, and a Monday off has no day before it in the week.
    assert_eq!(
        item_of(&week_of(hours(days(&[12, 13, 15]))), LostItemKind::Hammock),
        None
    );
    assert_eq!(
        item_of(
            &week_of(hours(days(&[13, 14, 15, 16]))),
            LostItemKind::Hammock
        ),
        None
    );
}

#[test]
fn scales_accounts_sharing_a_week_of_ten_hours_or_more_within_fifteen_points() {
    let spread = |a: u32, b: u32| {
        let first: Vec<f64> = (0..a).map(|i| oct(14, i)).collect();
        let second: Vec<f64> = (0..b).map(|i| oct(15, i)).collect();
        item_of(
            &week_of(hours(merge(&[active(1, &first), active(2, &second)]))),
            LostItemKind::Scales,
        )
    };
    assert_eq!(
        spread(6, 5),
        Some(json!({ "kind": "scales", "accountIds": ["a", "b"], "low": 45, "high": 55 }))
    );
    assert_eq!(spread(8, 3), None);
    // Nine hours are too few to weigh.
    assert_eq!(spread(5, 4), None);
}

#[test]
fn chest_the_week_s_api_value_beats_every_earlier_week_in_reach_at_least_four_of_them() {
    let opus = |tokens: f64, cost: f64| ledger_day("acct:a", "claude-opus-5-5", tokens, cost);
    let run = |entries: &[(String, Value)]| {
        item_of(
            &Input {
                ledger_days: ledger_days(entries),
                ..Input::default()
            }
            .week(),
            LostItemKind::Chest,
        )
    };
    let mut entries: Vec<(String, Value)> = (1..=5)
        .map(|i| {
            (
                add_days("2026-10-14", -7.0 * f64::from(i)),
                opus(1000.0, 10.0),
            )
        })
        .collect();
    entries.push(("2026-10-14".into(), opus(4000.0, 30.0)));
    assert_eq!(
        run(&entries),
        Some(json!({ "kind": "chest", "cost": 30, "tokens": 4000, "times": 3 }))
    );
    // A week before it that cost more takes the chest away.
    entries.push(("2026-09-30".into(), opus(1000.0, 31.0)));
    assert_eq!(run(&entries), None);
    // So do too few earlier weeks.
    let mut few = vec![("2026-10-14".to_string(), opus(4000.0, 30.0))];
    few.extend((1..=3).map(|i| {
        (
            add_days("2026-10-14", -7.0 * f64::from(i)),
            opus(1000.0, 10.0),
        )
    }));
    assert_eq!(run(&few), None);
}

#[test]
fn piggy_bank_one_account_s_api_value_in_a_week_paid_for_its_plan_s_month() {
    let plan = |account: Account, value: &str| {
        with(
            &account,
            json!({ "planning": { "plan": value, "capacityWeight": 1 } }),
        )
    };
    let days = ledger_days(&[
        (
            "2026-10-13".into(),
            ledger_day("acct:a", "claude-opus-5-5", 1000.0, 120.0),
        ),
        (
            "2026-10-15".into(),
            merge(&[
                ledger_day("acct:a", "claude-opus-5-5", 1000.0, 116.4),
                ledger_day("est:b", "claude-sonnet-5-5", 1000.0, 19.0),
            ]),
        ),
    ]);
    let week = Input {
        ledger_days: days.clone(),
        accounts: vec![plan(a(), "max20"), plan(b(), "pro"), c()],
        ..Input::default()
    }
    .week();
    // A paid back 1.18 times, B 0.95: A is shown.
    assert_eq!(
        item_of(&week, LostItemKind::Piggy),
        Some(json!({ "kind": "piggy", "accountId": "a", "cost": 236.4, "price": 200 }))
    );
    // A Team seat's price is not known, so it cannot be paid back.
    let team = Input {
        ledger_days: days,
        accounts: vec![plan(a(), "team"), b(), c()],
        ..Input::default()
    }
    .week();
    assert_eq!(item_of(&team, LostItemKind::Piggy), None);
}

#[test]
fn fan_three_model_families_each_with_at_least_one_percent_of_the_week_s_tokens() {
    let days = |haiku: f64| {
        ledger_days(&[(
            "2026-10-14".into(),
            json!({
                "acct:a": {
                    "claude-opus-5-5": ledger_counts(600.0, None),
                    "claude-sonnet-5-5-20261001": ledger_counts(300.0, None),
                    "claude-haiku-5-5": ledger_counts(haiku, None),
                },
            }),
        )])
    };
    let fan = |haiku: f64| {
        item_of(
            &Input {
                ledger_days: days(haiku),
                ..Input::default()
            }
            .week(),
            LostItemKind::Fan,
        )
    };
    assert_eq!(
        fan(100.0),
        Some(json!({ "kind": "fan", "families": ["Opus", "Sonnet", "Haiku"] }))
    );
    assert_eq!(fan(5.0), None);
    assert_eq!(model_family("claude-fable-5-1").as_deref(), Some("Fable"));
    assert_eq!(model_family("gpt-5"), None);
}

#[test]
fn a_moment_within_hours_says_what_it_used_when_the_ledger_kept_every_quarter_of_it() {
    // Eight hours from 11:00 on 16 October in Istanbul; one kept quarter at 12:00 (slot 48), one after it (20:00).
    let eight: Vec<f64> = (0..8).map(|i| oct(16, 8 + i)).collect();
    let counts = |tokens: f64, cost: f64| json!({ "input": tokens, "output": 0, "cacheWrite": 0, "cacheRead": 0, "cost": cost });
    let base = || Input {
        rollups: Some(hours(active(1, &eight))),
        ledger_days: ledger_days(&[(
            "2026-10-16".into(),
            ledger_day("acct:a", "claude-opus-5-5", 3000.0, 7.5),
        )]),
        ledger_slots: Some(from_json(
            json!({ "2026-10-16": { "acct:a": { "48": counts(1000.0, 2.5), "80": counts(2000.0, 5.0) } } }),
        )),
        ..Input::default()
    };
    let scroll_spend = |input: Input| {
        item_of(&input.week(), LostItemKind::Scroll).and_then(|v| v.get("spend").cloned())
    };
    assert_eq!(
        scroll_spend(Input {
            slots_since: Some(oct(1, 0)),
            ..base()
        }),
        Some(json!({ "tokens": 1000, "cost": 2.5 }))
    );
    // Quarters kept only from after the moment began, or not at all, tell nothing.
    assert_eq!(
        scroll_spend(Input {
            slots_since: Some(oct(16, 12)),
            ..base()
        }),
        None
    );
    assert_eq!(
        scroll_spend(Input {
            ledger_slots: None,
            ..base()
        }),
        None
    );
    // A day-long moment reads the day's totals.
    let scarf = Input {
        rollups: Some(hours(merge(&[
            active(1, &[oct(16, 8)]),
            active(2, &[oct(16, 9)]),
            active(3, &[oct(16, 10)]),
        ]))),
        ..base()
    }
    .week();
    assert_eq!(
        item_of(&scarf, LostItemKind::Scarf).and_then(|v| v.get("spend").cloned()),
        Some(json!({ "tokens": 3000, "cost": 7.5 }))
    );
}
