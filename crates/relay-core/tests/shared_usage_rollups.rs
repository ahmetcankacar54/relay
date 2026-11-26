//! Port of tests/usage-rollups.test.ts (`shared/usage-rollups`).

use relay_core::shared::types::UsageWindow;
use relay_core::shared::types::js::{date_parse, iso as js_iso};
use relay_core::shared::usage_rollups::{
    HourRollup, LimitHit, LimitHitKind, ROLLUP_DAYS, UsageRollups, WindowRecord, catch_up,
    empty_rollups, fold_sample, fold_samples, hour_key,
};
use relay_core::shared::usage_statistics::UsageSample;
use serde_json::json;

const MINUTE: f64 = 60_000.0;
const DAY: f64 = 86_400_000.0;

/// 07:50 UTC, so 5-minute steps cross into the 08:00 hour on the third sample.
fn t0() -> f64 {
    date_parse("2026-10-13T07:50:00.000Z")
}
fn iso(m: f64) -> String {
    js_iso(t0() + m * MINUTE)
}
fn now() -> f64 {
    t0() + 10.0 * 60.0 * MINUTE
}

/// `s(identity, m, fivePct, resetMinutes, weekPct?, weekResetMinutes = 7 days)`.
fn sw(
    identity: &str,
    m: f64,
    five_pct: Option<f64>,
    reset_minutes: f64,
    week_pct: Option<f64>,
    week_reset_minutes: f64,
) -> UsageSample {
    UsageSample {
        account_id: "a".into(),
        identity: identity.into(),
        checked_at: iso(m),
        five_hour: five_pct.map(|pct| UsageWindow::new(pct, Some(&iso(reset_minutes)))),
        seven_day: week_pct.map(|pct| UsageWindow::new(pct, Some(&iso(week_reset_minutes)))),
    }
}
fn s(identity: &str, m: f64, five_pct: f64, reset_minutes: f64) -> UsageSample {
    sw(
        identity,
        m,
        Some(five_pct),
        reset_minutes,
        None,
        7.0 * 24.0 * 60.0,
    )
}
fn fold_at(samples: &[UsageSample], at: f64) -> UsageRollups {
    samples
        .iter()
        .fold(empty_rollups(), |r, sample| fold_sample(&r, sample, at))
}
fn fold(samples: &[UsageSample]) -> UsageRollups {
    fold_at(samples, now())
}
fn h(m: f64) -> String {
    hour_key(t0() + m * MINUTE)
}
fn hour<'a>(r: &'a UsageRollups, identity: &str, key: &str) -> &'a HourRollup {
    r.hours
        .get(identity)
        .and_then(|hours| hours.get(key))
        .unwrap_or_else(|| panic!("hour {key} of {identity}"))
}
fn rollup(points: f64, windows: f64, covered_minutes: f64) -> HourRollup {
    HourRollup {
        points,
        windows,
        covered_minutes,
    }
}
fn sum(r: &UsageRollups, identity: &str, pick: impl Fn(&HourRollup) -> f64) -> f64 {
    r.hours
        .get(identity)
        .map_or(0.0, |hours| hours.values().map(&pick).sum())
}
fn windows<'a>(r: &'a UsageRollups, identity: &str) -> &'a [WindowRecord] {
    r.windows.get(identity).map_or(&[], Vec::as_slice)
}
fn record(reset_at: String, max_percent: f64) -> WindowRecord {
    WindowRecord {
        reset_at,
        max_percent,
    }
}
fn hit(
    identity: &str,
    kind: LimitHitKind,
    at: String,
    until: Option<String>,
    reset_at: String,
) -> LimitHit {
    LimitHit {
        identity: identity.into(),
        kind,
        at,
        until,
        reset_at: Some(reset_at),
    }
}
fn last_checked(r: &UsageRollups, identity: &str) -> String {
    r.last
        .get(identity)
        .expect("last sample")
        .checked_at
        .clone()
}

#[test]
fn hour_key_is_the_utc_hour_start() {
    assert_eq!(ROLLUP_DAYS, 90.0);
    assert_eq!(h(0.0), "2026-10-13T07:00:00.000Z");
    assert_eq!(h(10.0), "2026-10-13T08:00:00.000Z");
    assert_eq!(
        serde_json::to_value(empty_rollups()).unwrap(),
        json!({ "version": 2, "hours": {}, "windows": {}, "hits": [], "last": {} })
    );
}

#[test]
fn same_window_increases_are_attributed_to_the_hour_of_the_later_sample() {
    let r = fold(&[
        s("x", 0.0, 10.0, 200.0),
        s("x", 5.0, 14.0, 200.0),
        s("x", 10.0, 20.0, 200.0),
    ]);
    // 07:50 → 07:55 → 08:00: both gaps fall inside the 07:00 hour.
    assert_eq!(hour(&r, "x", &h(0.0)), &rollup(4.0, 1.0, 10.0));
    assert_eq!(hour(&r, "x", &h(10.0)), &rollup(6.0, 0.0, 0.0));
    assert_eq!(sum(&r, "x", |h| h.covered_minutes), 10.0);
    assert_eq!(windows(&r, "x"), [record(iso(200.0), 20.0)]);
    assert_eq!(last_checked(&r, "x"), iso(10.0));
}

#[test]
fn a_gap_over_35_minutes_makes_the_next_sample_a_baseline() {
    let r = fold(&[s("x", 0.0, 10.0, 200.0), s("x", 40.0, 30.0, 200.0)]);
    assert_eq!(sum(&r, "x", |h| h.points), 0.0);
    assert_eq!(sum(&r, "x", |h| h.covered_minutes), 0.0);
    assert_eq!(windows(&r, "x"), [record(iso(200.0), 30.0)]);
}

#[test]
fn coverage_splits_a_gap_across_the_utc_hours_it_spans() {
    // 23:50 → 00:15 is 10 minutes in one hour and 15 in the next.
    let poll = |checked_at: &str| UsageSample {
        account_id: "a".into(),
        identity: "x".into(),
        checked_at: checked_at.into(),
        five_hour: Some(UsageWindow::new(10.0, Some("2026-10-14T02:00:00.000Z"))),
        seven_day: None,
    };
    let r = fold_at(
        &[
            poll("2026-10-13T23:50:00.000Z"),
            poll("2026-10-14T00:15:00.000Z"),
        ],
        date_parse("2026-10-14T01:00:00.000Z"),
    );
    assert_eq!(
        hour(&r, "x", "2026-10-13T23:00:00.000Z").covered_minutes,
        10.0
    );
    assert_eq!(
        hour(&r, "x", "2026-10-14T00:00:00.000Z").covered_minutes,
        15.0
    );
}

#[test]
fn coverage_counts_consecutive_polls_outside_a_valid_window() {
    let week = 7.0 * 24.0 * 60.0;
    let r = fold(&[
        sw("x", 0.0, None, 0.0, Some(10.0), week),
        sw("x", 5.0, None, 0.0, Some(10.0), week),
        s("x", 15.0, 10.0, 200.0),
        s("x", 20.0, 12.0, 260.0),
        s("x", 70.0, 15.0, 260.0),
    ]);
    // 5 + 10 + 5 minutes; the 50-minute gap is not covered.
    assert_eq!(sum(&r, "x", |h| h.covered_minutes), 20.0);
    // Points stay window-scoped: the window change is a baseline.
    assert_eq!(sum(&r, "x", |h| h.points), 0.0);
}

#[test]
fn drops_do_not_lower_the_high_water_mark() {
    let r = fold(&[
        s("x", 0.0, 20.0, 200.0),
        s("x", 5.0, 15.0, 200.0),
        s("x", 10.0, 22.0, 200.0),
    ]);
    assert_eq!(hour(&r, "x", &h(0.0)).points, 0.0);
    assert_eq!(hour(&r, "x", &h(10.0)).points, 2.0);
    assert_eq!(windows(&r, "x")[0].max_percent, 22.0);
}

#[test]
fn a_new_window_is_counted_once_and_its_first_sample_is_a_baseline() {
    let r = fold(&[
        s("x", 0.0, 10.0, 30.0),
        s("x", 25.0, 40.0, 30.0),
        s("x", 35.0, 5.0, 30.0 + 300.0),
        s("x", 40.0, 9.0, 30.0 + 300.0),
    ]);
    assert_eq!(
        windows(&r, "x"),
        [record(iso(30.0), 40.0), record(iso(330.0), 9.0)]
    );
    assert_eq!(hour(&r, "x", &h(0.0)).windows, 1.0);
    // 30 from the first window, 0 for the new window's baseline, then 4.
    assert_eq!(hour(&r, "x", &h(25.0)), &rollup(34.0, 1.0, 30.0));
}

#[test]
fn resets_at_differing_by_90_seconds_is_the_same_window() {
    let first = s("x", 0.0, 10.0, 200.0);
    let mut second = s("x", 5.0, 14.0, 200.0);
    let first_reset = first.five_hour.as_ref().unwrap().resets_at.clone().unwrap();
    second.five_hour.as_mut().unwrap().resets_at =
        Some(js_iso(date_parse(&first_reset) + 90_000.0));
    let r = fold(&[first, second]);
    assert_eq!(windows(&r, "x").len(), 1);
    assert_eq!(hour(&r, "x", &h(0.0)).windows, 1.0);
    assert_eq!(hour(&r, "x", &h(0.0)).points, 4.0);
    assert_eq!(windows(&r, "x")[0].max_percent, 14.0);
}

#[test]
fn out_of_order_or_duplicate_samples_leave_the_rollups_unchanged() {
    let r = fold(&[s("x", 0.0, 10.0, 200.0), s("x", 5.0, 14.0, 200.0)]);
    let copy = r.clone();
    assert_eq!(fold_sample(&r, &s("x", 5.0, 50.0, 200.0), now()), copy);
    assert_eq!(fold_sample(&r, &s("x", 1.0, 50.0, 200.0), now()), copy);
    assert_eq!(r, copy);
}

#[test]
fn fold_sample_does_not_mutate_its_input() {
    let r = fold(&[s("x", 0.0, 10.0, 200.0)]);
    let copy = r.clone();
    let next = fold_sample(&r, &s("x", 5.0, 14.0, 200.0), now());
    assert_eq!(r, copy);
    assert_ne!(next, r);
}

#[test]
fn limit_hits_open_at_100_and_close_on_a_drop_or_at_the_window_reset() {
    use LimitHitKind::{FiveHour, Weekly};
    let mut r = fold(&[s("x", 0.0, 90.0, 200.0), s("x", 60.0, 100.0, 200.0)]);
    assert_eq!(r.hits, [hit("x", FiveHour, iso(60.0), None, iso(200.0))]);
    r = fold_sample(&r, &s("x", 65.0, 100.0, 200.0), now());
    assert_eq!(r.hits.len(), 1);
    r = fold_sample(&r, &s("x", 70.0, 95.0, 200.0), now());
    assert_eq!(
        r.hits,
        [hit("x", FiveHour, iso(60.0), Some(iso(70.0)), iso(200.0))]
    );

    // Weekly hit, then a sample past its reset while still at 100.
    let week_reset = 120.0;
    let next_week = week_reset + 7.0 * 24.0 * 60.0;
    let mut w = fold(&[
        sw("y", 0.0, Some(10.0), 200.0, Some(100.0), week_reset),
        sw("y", 5.0, Some(10.0), 200.0, Some(100.0), week_reset),
    ]);
    assert_eq!(w.hits, [hit("y", Weekly, iso(0.0), None, iso(week_reset))]);
    w = fold_sample(
        &w,
        &sw("y", 130.0, Some(10.0), 200.0, Some(100.0), next_week),
        now(),
    );
    assert_eq!(
        w.hits[0],
        hit(
            "y",
            Weekly,
            iso(0.0),
            Some(iso(week_reset)),
            iso(week_reset)
        )
    );
    // The next week starts already exhausted: that is a new hit.
    assert_eq!(
        w.hits[1],
        hit("y", Weekly, iso(130.0), None, iso(next_week))
    );
}

#[test]
fn records_older_than_90_days_relative_to_now_are_pruned() {
    let r = fold(&[
        s("x", 0.0, 100.0, 200.0),
        s("x", 5.0, 100.0, 200.0),
        s("z", 0.0, 10.0, 200.0),
    ]);
    assert!(
        r.hours
            .get("x")
            .and_then(|hours| hours.get(&h(0.0)))
            .is_some()
    );
    let later = t0() + 90.0 * DAY + 6.0 * 60.0 * MINUTE;
    let m = 91.0 * 24.0 * 60.0;
    let pruned = fold_sample(&r, &s("z", m, 10.0, m + 60.0), later);
    assert!(
        pruned
            .hours
            .get("x")
            .and_then(|hours| hours.get(&h(0.0)))
            .is_none()
    );
    assert!(
        pruned
            .hours
            .get("z")
            .expect("z hours")
            .get(&h(0.0))
            .is_none()
    );
    assert!(windows(&pruned, "x").is_empty());
    assert_eq!(
        pruned.windows.get("z").expect("z windows"),
        &[record(iso(m + 60.0), 10.0)]
    );
    assert!(pruned.hits.is_empty());
    assert!(pruned.hours.get("z").expect("z hours").get(&h(m)).is_some());
    assert!(pruned.last.get("x").is_none());
    assert_eq!(last_checked(&pruned, "z"), iso(m));
}

#[test]
fn monotonic_reset_drift_within_2_minutes_per_step_stays_one_window() {
    let reset = 200.0;
    let drift = |mut sample: UsageSample, seconds: f64| {
        sample.five_hour.as_mut().unwrap().resets_at =
            Some(js_iso(t0() + reset * MINUTE + seconds * 1000.0));
        sample
    };
    let r = fold(&[
        drift(s("x", 0.0, 10.0, reset), 0.0),
        drift(s("x", 5.0, 20.0, reset), 90.0),
        drift(s("x", 10.0, 30.0, reset), 180.0),
        drift(s("x", 15.0, 40.0, reset), 180.0),
    ]);
    assert_eq!(sum(&r, "x", |h| h.points), 30.0);
    assert_eq!(sum(&r, "x", |h| h.windows), 1.0);
    assert_eq!(windows(&r, "x").len(), 1);
    assert_eq!(windows(&r, "x")[0].max_percent, 40.0);
}

#[test]
fn an_open_hit_closes_at_its_reset_even_when_the_sample_lacks_that_window() {
    let mut r = fold(&[s("x", 0.0, 90.0, 200.0), s("x", 60.0, 100.0, 200.0)]);
    r = fold_sample(
        &r,
        &sw("x", 210.0, None, 0.0, Some(50.0), 7.0 * 24.0 * 60.0),
        now(),
    );
    assert_eq!(
        r.hits,
        [hit(
            "x",
            LimitHitKind::FiveHour,
            iso(60.0),
            Some(iso(200.0)),
            iso(200.0)
        )]
    );
}

#[test]
fn catch_up_folds_only_samples_newer_than_each_identitys_last() {
    let all = [
        s("x", 0.0, 10.0, 200.0),
        s("x", 5.0, 14.0, 200.0),
        s("y", 1.0, 5.0, 200.0),
        s("x", 10.0, 20.0, 200.0),
        s("y", 6.0, 9.0, 200.0),
    ];
    let stale = fold_samples(&all[..2], now());
    assert_eq!(catch_up(&stale, &all, now()), fold_samples(&all, now()));
    let current = fold_samples(&all, now());
    // The TS checks object identity; a Rust value can only be compared.
    assert_eq!(catch_up(&current, &all, now()), current);
    assert_eq!(stale, fold_samples(&all[..2], now()));
}

#[test]
fn fold_samples_over_shuffled_input_equals_folding_in_order() {
    let week = 7.0 * 24.0 * 60.0;
    let ordered = [
        s("x", 0.0, 10.0, 200.0),
        sw("x", 5.0, Some(14.0), 200.0, Some(50.0), week),
        sw("x", 10.0, Some(20.0), 200.0, Some(100.0), week),
        sw("x", 15.0, Some(18.0), 200.0, Some(99.0), week),
        s("x", 60.0, 40.0, 200.0),
        s("y", 2.0, 5.0, 230.0),
        s("y", 7.0, 25.55, 230.0),
        s("y", 12.0, 100.0, 230.0),
    ];
    // `ordered` is already sorted by identity, then time.
    let expected = fold(&ordered);
    let shuffled: Vec<UsageSample> = [6, 2, 0, 7, 4, 1, 5, 3]
        .iter()
        .map(|&i| ordered[i].clone())
        .collect();
    assert_eq!(fold_samples(&shuffled, now()), expected);
    assert_eq!(hour(&expected, "y", &h(0.0)).points, 20.55);
}

#[test]
fn an_open_hit_follows_its_windows_drifting_reset_instead_of_reopening() {
    let reset = t0() + 200.0 * MINUTE;
    let mut r = fold(&[s("x", 0.0, 90.0, 200.0), s("x", 60.0, 100.0, 200.0)]);
    // 30 s after the stored reset, still full, the reset is reported 90 s later.
    let mut late = s("x", 200.0, 100.0, 200.0);
    late.checked_at = js_iso(reset + 30_000.0);
    let drifted = js_iso(reset + 120_000.0);
    late.five_hour.as_mut().unwrap().resets_at = Some(drifted.clone());
    r = fold_sample(&r, &late, now());
    assert_eq!(
        r.hits,
        [hit(
            "x",
            LimitHitKind::FiveHour,
            iso(60.0),
            None,
            drifted.clone()
        )]
    );
    assert_eq!(windows(&r, "x").len(), 1);
    // The next window closes the one hit at the drifted reset.
    r = fold_sample(&r, &s("x", 205.0, 10.0, 500.0), now());
    assert_eq!(r.hits.len(), 1);
    assert_eq!(r.hits[0].until, Some(drifted));
}

#[test]
fn last_checks_stamped_later_than_now_are_clamped_and_nothing_else_changes() {
    // Folded while the clock ran ahead: minutes 120 and 180 are in the future
    // once the clock moves back to minute 30.
    let samples = [
        s("x", 0.0, 10.0, 200.0),
        s("x", 180.0, 100.0, 400.0),
        s("y", 0.0, 100.0, 200.0),
        s("y", 120.0, 50.0, 200.0),
    ];
    let r = fold(&samples);
    let copy = r.clone();
    let back = t0() + 30.0 * MINUTE;
    let clamped = catch_up(&r, &[], back);
    assert_ne!(clamped, r);
    assert_eq!(r, copy);
    // Hours, windows and hits stay, the future hit and the one it closed too.
    let mut expected = r.clone();
    for identity in ["x", "y"] {
        expected.last.get_mut(identity).unwrap().checked_at = iso(30.0);
    }
    assert_eq!(clamped, expected);
    // Samples up to the clamped check were folded already and are not replayed.
    assert_eq!(
        catch_up(&r, &[samples[0].clone(), samples[2].clone()], back),
        clamped
    );
    assert_eq!(fold_sample(&r, &s("x", 25.0, 20.0, 200.0), back), clamped);
    // Nothing in the future: catchUp keeps returning the same object (compared by value here).
    assert_eq!(
        catch_up(&clamped, &[samples[0].clone(), samples[2].clone()], back),
        clamped
    );
    // Samples after the clamped check are accepted again.
    let later = t0() + 40.0 * MINUTE;
    assert_eq!(
        last_checked(
            &catch_up(&clamped, &[s("x", 40.0, 20.0, 200.0)], later),
            "x"
        ),
        iso(40.0)
    );
    assert_eq!(
        last_checked(
            &fold_sample(&clamped, &s("x", 40.0, 20.0, 200.0), later),
            "x"
        ),
        iso(40.0)
    );
    // A kept window seen again is the same record: not counted twice.
    let again = fold_sample(
        &clamped,
        &s("x", 200.0, 100.0, 400.0),
        t0() + 200.0 * MINUTE,
    );
    assert_eq!(windows(&again, "x"), windows(&r, "x"));
    assert_eq!(sum(&again, "x", |h| h.windows), 2.0);
    assert_eq!(again.hits, r.hits);
}

#[test]
fn coverage_never_credits_an_hour_more_than_60_minutes() {
    // 08:00 → 08:55 every 5 minutes, then the clock moves back to 08:53.
    let polls: Vec<UsageSample> = (0..12)
        .map(|i| s("x", 10.0 + 5.0 * f64::from(i), 10.0, 300.0))
        .collect();
    let r = fold(&polls);
    assert_eq!(hour(&r, "x", &h(10.0)).covered_minutes, 55.0);
    let clamped = catch_up(&r, &[], t0() + 63.0 * MINUTE);
    // 08:53 → 08:59 overlaps the 08:53 → 08:55 already covered.
    let next = fold_sample(&clamped, &s("x", 69.0, 10.0, 300.0), t0() + 69.0 * MINUTE);
    assert_eq!(last_checked(&next, "x"), iso(69.0));
    assert_eq!(hour(&next, "x", &h(10.0)).covered_minutes, 60.0);
}

#[test]
fn a_hit_closed_by_a_sample_before_it_opened_ends_where_it_began() {
    let mut r = fold(&[s("x", 0.0, 90.0, 200.0), s("x", 60.0, 100.0, 200.0)]);
    // The clock moves back to minute 30; the next sample is below 100.
    r = catch_up(&r, &[], t0() + 30.0 * MINUTE);
    r = fold_sample(&r, &s("x", 40.0, 50.0, 200.0), t0() + 40.0 * MINUTE);
    assert_eq!(
        r.hits,
        [hit(
            "x",
            LimitHitKind::FiveHour,
            iso(60.0),
            Some(iso(60.0)),
            iso(200.0)
        )]
    );
}
