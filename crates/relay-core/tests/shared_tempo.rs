//! Port of tests/tempo.test.ts (`shared/tempo`).

use relay_core::shared::planning::{local_hour, wall_time};
use relay_core::shared::tempo::{
    LearnTempoInput, Tempo, TempoDays, TempoRates, TempoSource, fallback_tempo, learn_tempo,
    tempo_at, tempo_preset, tempo_rate,
};
use relay_core::shared::types::js::iso;
use relay_core::shared::types::{
    Account, AccountPlan, AccountPlanning, PlanningHours, PlanningSettings, TempoChoice,
    default_planning_settings,
};
use relay_core::shared::usage_rollups::{HourRollup, UsageRollups, empty_rollups};
use relay_core::shared::usage_statistics::history_identity;
use relay_core::shared::work_hours::{is_weekend, shift_date};
use serde_json::json;

const ZONE: &str = "Europe/Istanbul";

fn now() -> f64 {
    wall_time("2026-10-14", "10:00", ZONE).expect("wall time")
}
fn hours(enabled: bool, start: &str, end: &str) -> PlanningHours {
    PlanningHours {
        enabled,
        start: start.into(),
        end: end.into(),
    }
}
fn settings() -> PlanningSettings {
    PlanningSettings {
        time_zone: ZONE.into(),
        weekday: hours(true, "09:00", "18:00"),
        weekend: hours(false, "11:00", "17:00"),
        ..default_planning_settings()
    }
}
/// `planningAccount("pro", "pro")` signed in as `u` of `o`.
fn pro() -> Account {
    serde_json::from_value(json!({
        "id": "pro",
        "name": "pro",
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        "createdAt": "2026-10-13T05:59:45.000Z",
        "planning": { "plan": "pro", "capacityWeight": 1 },
        "auth": {
            "loggedIn": true,
            "accountUuid": "u",
            "orgId": "o",
            "subscription": "pro",
            "checkedAt": "2026-10-13T05:59:45.000Z",
        },
    }))
    .expect("account fixture")
}
fn identity() -> String {
    history_identity(&pro()).expect("identity")
}
fn max5() -> Account {
    Account {
        planning: Some(AccountPlanning {
            plan: AccountPlan::Max5,
            capacity_weight: 1.0,
        }),
        ..pro()
    }
}

/// 2026-09-30 … 2026-10-13 without weekends (2026-10-14 is a Wednesday).
fn weekdays() -> Vec<String> {
    let mut out = Vec::new();
    let mut back = 1.0;
    while out.len() < 10 {
        let date = shift_date("2026-10-14", -back);
        if !is_weekend(&date) {
            out.push(date);
        }
        back += 1.0;
    }
    out
}
fn clock(hour: u32) -> String {
    format!("{hour:02}:00")
}
fn set(rollups: &mut UsageRollups, identity: &str, key: String, points: f64, covered_minutes: f64) {
    rollups
        .hours
        .entry_or_insert_with(identity, Default::default)
        .insert(
            key,
            HourRollup {
                points,
                windows: 0.0,
                covered_minutes,
            },
        );
}
/// Writes one local-clock hour into the rollups of `identity`.
fn put(
    rollups: &mut UsageRollups,
    identity: &str,
    date: &str,
    hour: u32,
    points: f64,
    covered_minutes: f64,
) {
    let key = iso(wall_time(date, &clock(hour), ZONE).expect("wall time"));
    set(rollups, identity, key, points, covered_minutes);
}
/// Day `i` (0 = the latest) spends 40 + 10·i points an hour from 09 to 17, hour 12 at half.
fn ten_days() -> UsageRollups {
    let mut rollups = empty_rollups();
    for (i, date) in weekdays().iter().enumerate() {
        for hour in 9..18 {
            let points = (40.0 + 10.0 * i as f64) / if hour == 12 { 2.0 } else { 1.0 };
            put(&mut rollups, &identity(), date, hour, points, 60.0);
        }
    }
    rollups
}
fn learn_with(
    rollups: &UsageRollups,
    accounts: &[Account],
    settings: &PlanningSettings,
    now: f64,
) -> Tempo {
    learn_tempo(LearnTempoInput {
        rollups: Some(rollups),
        accounts,
        settings,
        now,
    })
}
fn learn(rollups: &UsageRollups, over: impl FnOnce(&mut PlanningSettings)) -> Tempo {
    let mut s = settings();
    over(&mut s);
    learn_with(rollups, &[pro()], &s, now())
}
fn as_is(_: &mut PlanningSettings) {}
fn weekend_only(s: &mut PlanningSettings) {
    s.weekday = hours(false, "09:00", "18:00");
    s.weekend = hours(true, "11:00", "17:00");
}

#[test]
fn ten_weekdays_give_a_learned_busy_day_rate_shaped_by_the_hour() {
    let tempo = learn(&ten_days(), as_is);
    assert_eq!(tempo.source, TempoSource::Learned);
    assert_eq!(tempo.rate.weekday, 101.5);
    assert_eq!(tempo.weekday[9], 107.5);
    assert_eq!(tempo.weekday[12], 53.8);
    // Outside work hours the busy-day rate is used instead of zero.
    assert_eq!(tempo.weekday[20], 101.5);
    assert_eq!(
        tempo.days,
        TempoDays {
            weekday: 10,
            weekend: 0
        }
    );
    assert_eq!(tempo.weekday.len(), 24);
    assert_eq!(tempo.weekend, vec![101.5; 24]);
    assert_eq!(tempo.rate.weekend, 101.5);
}

#[test]
fn points_are_scaled_to_the_observed_minutes_of_each_hour() {
    let mut rollups = empty_rollups();
    // 25 points over 30 observed minutes an hour: exactly half of every work
    // hour is covered (still enough to qualify), and the pace is 50 an hour.
    for date in weekdays() {
        for hour in 9..18 {
            put(&mut rollups, &identity(), &date, hour, 25.0, 30.0);
        }
    }
    let tempo = learn(&rollups, as_is);
    assert_eq!(tempo.source, TempoSource::Learned);
    assert_eq!(tempo.rate.weekday, 50.0);
    assert_eq!(tempo.weekday[10], 50.0);
    assert_eq!(tempo.days.weekday, 10);
}

#[test]
fn a_day_with_under_half_of_its_work_minutes_observed_is_skipped() {
    let mut rollups = ten_days();
    // Keep only two of the nine hours (120 of 540 minutes) on the latest day.
    let date = &weekdays()[0];
    for hour in 11..18 {
        let key = iso(wall_time(date, &clock(hour), ZONE).expect("wall time"));
        rollups.hours.get_mut(&identity()).unwrap().remove(&key);
    }
    let tempo = learn(&rollups, as_is);
    assert_eq!(tempo.days.weekday, 9);
    assert_eq!(tempo.source, TempoSource::Learned);
}

#[test]
fn fewer_than_five_qualifying_weekdays_fall_back_to_the_default_tempo() {
    let mut rollups = empty_rollups();
    for date in &weekdays()[..4] {
        for hour in 9..18 {
            put(&mut rollups, &identity(), date, hour, 80.0, 60.0);
        }
    }
    let tempo = learn(&rollups, as_is);
    assert_eq!(tempo.source, TempoSource::Default);
    assert_eq!(tempo.weekday, vec![50.0; 24]);
    assert_eq!(tempo.weekend, vec![50.0; 24]);
    assert_eq!(
        tempo.days,
        TempoDays {
            weekday: 4,
            weekend: 0
        }
    );
}

#[test]
fn a_weekend_only_schedule_learns_the_weekend_and_uses_its_rate_on_weekdays() {
    // Six weekend days 09-26 … 10-11, 11:00–17:00, at 30 an hour and 60 at 13.
    let mut weekends = Vec::new();
    let mut back = 1.0;
    while weekends.len() < 6 {
        let date = shift_date("2026-10-14", -back);
        if is_weekend(&date) {
            weekends.push(date);
        }
        back += 1.0;
    }
    let mut rollups = empty_rollups();
    for date in &weekends {
        for hour in 11..17 {
            put(
                &mut rollups,
                &identity(),
                date,
                hour,
                if hour == 13 { 60.0 } else { 30.0 },
                60.0,
            );
        }
    }
    let tempo = learn(&rollups, weekend_only);
    assert_eq!(tempo.source, TempoSource::Learned);
    assert_eq!(
        tempo.days,
        TempoDays {
            weekday: 0,
            weekend: 6
        }
    );
    assert_eq!(
        tempo.rate,
        TempoRates {
            weekday: 35.0,
            weekend: 35.0
        }
    );
    assert_eq!(tempo.weekend[13], 60.0);
    assert_eq!(tempo.weekend[11], 30.0);
    assert_eq!(tempo.weekend[20], 35.0);
    assert_eq!(tempo.weekday, vec![35.0; 24]);
    // Four weekend days are not enough either.
    let mut thin = empty_rollups();
    for date in &weekends[..4] {
        for hour in 11..17 {
            put(&mut thin, &identity(), date, hour, 30.0, 60.0);
        }
    }
    assert_eq!(learn(&thin, weekend_only).source, TempoSource::Default);
}

#[test]
fn points_count_at_the_accounts_plan_capacity_and_unknown_identities_at_1() {
    let mut rollups = empty_rollups();
    for date in weekdays() {
        for hour in 9..18 {
            put(&mut rollups, &identity(), &date, hour, 60.0, 60.0);
        }
    }
    assert_eq!(learn(&rollups, as_is).rate.weekday, 60.0);
    let big = learn_with(&rollups, &[max5()], &settings(), now());
    assert_eq!(big.rate.weekday, 300.0);
    assert_eq!(big.weekday[10], 300.0);
    let stranger = learn_with(&rollups, &[], &settings(), now());
    assert_eq!(stranger.rate.weekday, 60.0);
}

#[test]
fn the_tempo_choice_overrides_learning_and_the_fallback_follows_the_setting() {
    let heavy = learn(&ten_days(), |s| s.tempo = Some(TempoChoice::Heavy));
    assert_eq!(heavy.source, TempoSource::Preset);
    assert_eq!(
        heavy.weekday,
        vec![tempo_preset(TempoChoice::Heavy).unwrap(); 24]
    );
    assert_eq!(heavy.weekend, vec![120.0; 24]);
    assert_eq!(heavy.rate.weekday, 120.0);
    let with = |tempo| PlanningSettings {
        tempo,
        ..settings()
    };
    let unset = fallback_tempo(&with(None));
    assert_eq!(unset.source, TempoSource::Default);
    assert_eq!(unset.weekday, vec![50.0; 24]);
    let light = fallback_tempo(&with(Some(TempoChoice::Light)));
    assert_eq!(light.source, TempoSource::Preset);
    assert_eq!(light.weekday, vec![20.0; 24]);
    assert_eq!(
        fallback_tempo(&with(Some(TempoChoice::Auto))).source,
        TempoSource::Default
    );
}

#[test]
fn an_overnight_interval_is_learned_from_the_nights_that_have_finished() {
    let night = |s: &mut PlanningSettings| s.weekday = hours(true, "22:00", "06:00");
    let mut rollups = empty_rollups();
    // Five finished nights starting 09-30 … 10-13 (weekdays only).
    for date in &weekdays()[..5] {
        for hour in [22, 23] {
            put(&mut rollups, &identity(), date, hour, 60.0, 60.0);
        }
        let next = shift_date(date, 1.0);
        for hour in 0..6 {
            put(&mut rollups, &identity(), &next, hour, 60.0, 60.0);
        }
    }
    // Tonight's interval (starts 10-14 22:00) is unfinished and holds noise.
    put(&mut rollups, &identity(), "2026-10-14", 22, 999.0, 60.0);
    let tempo = learn(&rollups, night);
    assert_eq!(tempo.source, TempoSource::Learned);
    assert_eq!(tempo.rate.weekday, 60.0);
    assert_eq!(tempo.weekday[23], 60.0);
    assert_eq!(tempo.weekday[3], 60.0);
    // At 03:00 the 13th's night is still running, so only four nights count.
    let mut s = settings();
    night(&mut s);
    let early = learn_with(
        &rollups,
        &[pro()],
        &s,
        wall_time("2026-10-14", "03:00", ZONE).unwrap(),
    );
    assert_eq!(early.days.weekday, 4);
    assert_eq!(early.source, TempoSource::Default);
}

#[test]
fn tempo_at_and_tempo_rate_read_the_profile_of_the_local_day_type_and_hour() {
    let tempo = learn(&ten_days(), as_is);
    let saturday = wall_time("2026-10-17", "12:00", ZONE).unwrap();
    assert_eq!(tempo_at(&tempo, &settings(), saturday), tempo.weekend[12]);
    let wednesday = wall_time("2026-10-14", "12:00", ZONE).unwrap();
    assert_eq!(tempo_at(&tempo, &settings(), wednesday), tempo.weekday[12]);
    let from = wall_time("2026-10-14", "09:00", ZONE).unwrap();
    let to = wall_time("2026-10-14", "18:00", ZONE).unwrap();
    let rate = tempo_rate(&tempo, false, ZONE, from, to, 300_000.0);
    let mut t = from;
    while t < to {
        assert_eq!(rate(t), tempo.weekday[local_hour(t, ZONE) as usize]);
        t += 300_000.0;
    }
    let past = to + 2.0 * 3_600_000.0;
    assert_eq!(rate(past), tempo.weekday[local_hour(past, ZONE) as usize]);
}

/// Every weekday's UTC hours 03–11 at `points(hour)`, fully observed.
fn utc_hours(points: impl Fn(u32) -> f64) -> UsageRollups {
    let mut rollups = empty_rollups();
    for date in weekdays() {
        for hour in 3..12 {
            set(
                &mut rollups,
                &identity(),
                format!("{date}T{hour:02}:00:00.000Z"),
                points(hour),
                60.0,
            );
        }
    }
    rollups
}

#[test]
fn in_a_half_hour_zone_a_utc_hour_is_split_between_the_two_local_hours_it_spans() {
    // Kolkata is UTC+05:30: work 09:00–18:00 is 03:30–12:30Z, and the
    // 10:00–11:00Z bucket is 15:30–16:30 local, half in hour 15, half in 16.
    let rollups = utc_hours(|hour| if hour == 10 { 40.0 } else { 10.0 });
    let tempo = learn(&rollups, |s| s.time_zone = "Asia/Kolkata".into());
    assert_eq!(tempo.source, TempoSource::Learned);
    // Hours 15 and 16 each get half the busy bucket and half a calm one.
    assert_eq!(tempo.weekday[15], tempo.weekday[16]);
    assert_eq!(tempo.weekday[14], tempo.weekday[17]);
    assert!(
        (tempo.weekday[15] / tempo.weekday[14] - 2.5).abs() < 0.05,
        "{} vs {}",
        tempo.weekday[15],
        tempo.weekday[14]
    );
}

#[test]
fn in_a_half_hour_zone_no_hour_outside_work_is_credited_with_work_time() {
    // Kolkata 09:00–18:00 is 03:30–12:30Z: the calm 03:00Z bucket is 08:30–09:30
    // local, and only its 09:00–09:30 half is work.
    let rollups = utc_hours(|hour| if hour == 3 { 10.0 } else { 60.0 });
    let tempo = learn(&rollups, |s| s.time_zone = "Asia/Kolkata".into());
    assert_eq!(tempo.source, TempoSource::Learned);
    // Hour 8 is not part of the profile: it reads the busy-day rate.
    assert_eq!(tempo.weekday[8], tempo.rate.weekday);
    // The work hours keep the busy-day rate on average instead of being
    // inflated by a calm hour outside work.
    let work = &tempo.weekday[9..18];
    let average = work.iter().sum::<f64>() / work.len() as f64;
    assert!(
        (average - tempo.rate.weekday).abs() < 0.1,
        "{average} vs {}",
        tempo.rate.weekday
    );
    assert!(tempo.weekday[9] < tempo.weekday[10]);
}
