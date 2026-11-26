//! Port of `tests/adaptive-pace.test.ts`.

#[path = "common/planning.rs"]
mod helpers;

use helpers::{MINUTE as MINUTE_MS, ZONE, flat_tempo, hours, learned, planning_account, wall};
use relay_core::shared::adaptive_plan::{
    MAX_PACE, PACE_DEAD_BAND, PACE_WINDOW_MS, Pace, PaceInput, Span, pace_factor, planned_rate,
    todays_pace,
};
use relay_core::shared::tempo::Tempo;
use relay_core::shared::types::js::{self, date_parse, iso};
use relay_core::shared::types::{
    Account, PlanningSettings, UsageWindow, default_planning_settings,
};
use relay_core::shared::usage_statistics::{UsageSample, usage_identity};

fn settings() -> PlanningSettings {
    PlanningSettings {
        time_zone: ZONE.into(),
        weekday: hours(true, "09:00", "18:00"),
        weekend: hours(false, "11:00", "17:00"),
        ..default_planning_settings()
    }
}
fn at(clock: &str) -> f64 {
    wall("2026-10-14", clock, ZONE)
}
fn pro() -> Account {
    planning_account("pro", "pro")
}
fn max5() -> Account {
    planning_account("max", "max5")
}
// Samples at 09:00, 09:05 … 10:00 are the last hour; `to` lies just past 10:00.
fn from() -> f64 {
    at("09:00")
}
fn to() -> f64 {
    at("10:00") + 1.0
}

/// One sample per `used` value, `step` minutes apart from `start`.
fn series(account: &Account, start: f64, used: &[f64], reset: &str, step: f64) -> Vec<UsageSample> {
    used.iter()
        .enumerate()
        .map(|(i, used_percent)| UsageSample {
            account_id: account.id.clone(),
            identity: usage_identity(account).expect("an identity"),
            checked_at: iso(start + i as f64 * step * MINUTE_MS),
            five_hour: Some(UsageWindow::new(*used_percent, Some(reset))),
            seven_day: None,
        })
        .collect()
}
const RESET: &str = "2026-10-14T09:30:00.000Z";
fn default_series(account: &Account, start: f64, used: &[f64]) -> Vec<UsageSample> {
    series(account, start, used, RESET, 5.0)
}
/// 0 → `top` in 12 equal steps over the hour from 09:00 to 10:00.
fn hour(account: &Account, top: f64) -> Vec<UsageSample> {
    let used: Vec<f64> = (0..13).map(|i| (top * f64::from(i)) / 12.0).collect();
    default_series(account, from(), &used)
}
fn near(actual: Option<f64>, expected: f64) {
    assert!(
        actual.is_some_and(|a| (a - expected).abs() < 1e-9),
        "{actual:?} is not {expected}"
    );
}
fn rate_between(samples: &[UsageSample], from: f64, to: f64) -> Option<f64> {
    todays_pace(PaceInput {
        samples,
        accounts: &[pro(), max5()],
        tempo: &flat_tempo(50.0),
        settings: &settings(),
        from,
        to,
    })
    .observed
}
fn rate(samples: &[UsageSample]) -> Option<f64> {
    rate_between(samples, from(), to())
}
fn concat(parts: &[Vec<UsageSample>]) -> Vec<UsageSample> {
    parts.concat()
}

#[test]
fn a_pro_account_rising_30_in_an_hour_is_30_pro_units_an_hour_a_max_5x_150() {
    assert_eq!(rate(&hour(&pro(), 30.0)), Some(30.0));
    assert_eq!(rate(&hour(&max5(), 30.0)), Some(150.0));
}

#[test]
fn identities_add_their_units_but_not_their_observed_time() {
    assert_eq!(
        rate(&concat(&[hour(&pro(), 30.0), hour(&max5(), 30.0)])),
        Some(180.0)
    );
}

#[test]
fn a_drop_and_a_rise_in_one_window_count_only_above_the_high_water_mark() {
    // 0, 10, 20, drop to 10, back to 15 (below the mark), then 25 (5 above).
    let samples = default_series(
        &pro(),
        from(),
        &[
            0.0, 10.0, 20.0, 10.0, 15.0, 25.0, 25.0, 25.0, 25.0, 25.0, 25.0, 25.0, 25.0,
        ],
    );
    assert_eq!(rate(&samples), Some(25.0));
}

#[test]
fn a_changed_window_is_a_new_baseline_not_a_negative_or_a_jump() {
    let first = series(
        &pro(),
        from(),
        &[0.0, 5.0, 10.0, 15.0, 15.0, 15.0, 15.0],
        "2026-10-14T09:30:00.000Z",
        5.0,
    );
    let next = |used: &[f64]| {
        series(
            &pro(),
            from() + 35.0 * MINUTE_MS,
            used,
            "2026-10-14T11:00:00.000Z",
            5.0,
        )
    };
    // 15 units in the first window and 5 in the second, over 60 observed minutes. A second
    // window opening at 60% is not a jump of 45; one opening at 2% is not a negative step that
    // hides the 5 it then rises.
    assert_eq!(
        rate(&concat(&[
            first.clone(),
            next(&[60.0, 61.0, 62.0, 63.0, 64.0, 65.0])
        ])),
        Some(20.0)
    );
    assert_eq!(
        rate(&concat(&[first, next(&[2.0, 3.0, 4.0, 5.0, 6.0, 7.0])])),
        Some(20.0)
    );
}

#[test]
fn a_reset_time_that_drifts_by_under_two_minutes_stays_one_window() {
    let samples: Vec<UsageSample> = hour(&pro(), 30.0)
        .into_iter()
        .enumerate()
        .map(|(i, mut sample)| {
            let window = sample.five_hour.as_mut().expect("a window");
            window.resets_at = Some(iso(
                date_parse("2026-10-14T10:00:00.000Z") + (i % 2) as f64 * 90_000.0
            ));
            sample
        })
        .collect();
    assert_eq!(rate(&samples), Some(30.0));
}

#[test]
fn a_gap_of_more_than_35_minutes_adds_neither_time_nor_units() {
    // 08:00–08:30 rises 30 over 30 minutes; the jump to 70 at 09:10 follows a 40-minute gap;
    // 09:10–09:40 rises 10 over 30 more minutes.
    let samples = concat(&[
        default_series(
            &pro(),
            at("08:00"),
            &[0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0],
        ),
        default_series(
            &pro(),
            at("09:10"),
            &[70.0, 72.0, 74.0, 76.0, 78.0, 79.0, 80.0],
        ),
    ]);
    // 40 units over 60 observed minutes; the gap is neither time nor units.
    assert_eq!(rate_between(&samples, at("08:00"), at("10:00")), Some(40.0));
}

#[test]
fn a_gap_of_exactly_35_minutes_still_counts() {
    let samples = concat(&[
        default_series(&pro(), from(), &[0.0, 10.0]),
        default_series(&pro(), from() + 40.0 * MINUTE_MS, &[20.0, 30.0]),
    ]);
    // 09:00 → 09:05 (+10), 09:05 → 09:40 (+10 above the mark), 09:40 → 09:45 (+10): 45
    // observed minutes, 30 units.
    assert_eq!(
        rate_between(&samples, from(), from() + 80.0 * MINUTE_MS),
        Some(30.0 / 0.75)
    );
}

#[test]
fn under_30_observed_minutes_there_is_no_rate_at_30_there_is() {
    assert_eq!(
        rate(&default_series(
            &pro(),
            from(),
            &[0.0, 5.0, 10.0, 15.0, 20.0, 25.0]
        )),
        None
    );
    assert_eq!(
        rate(&default_series(
            &pro(),
            from(),
            &[0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0]
        )),
        Some(60.0)
    );
    assert_eq!(rate(&[]), None);
}

#[test]
fn only_samples_inside_from_to_are_read() {
    let samples = concat(&[
        default_series(&pro(), at("08:00"), &[0.0, 40.0]),
        hour(&pro(), 30.0),
        default_series(&pro(), at("10:30"), &[90.0, 100.0]),
    ]);
    // A late sample past `to` and an early one before `from` change nothing.
    assert_eq!(rate(&samples), Some(30.0));
    // `to` is exclusive: the 09:50 sample, which would add 55 units, is out.
    let spike = default_series(
        &pro(),
        from(),
        &[
            0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 100.0,
        ],
    );
    assert_eq!(rate_between(&spike, from(), at("09:50")), Some(60.0));
}

#[test]
fn an_identity_with_no_current_account_is_ignored() {
    let stranger = planning_account("gone", "max20");
    assert_eq!(rate(&hour(&stranger, 50.0)), None);
    assert_eq!(
        rate(&concat(&[hour(&stranger, 50.0), hour(&pro(), 30.0)])),
        Some(30.0)
    );
}

#[test]
fn a_sample_without_a_usable_window_breaks_the_baseline_but_still_counts_as_observed_time() {
    let mut samples = default_series(
        &pro(),
        from(),
        &[0.0, 10.0, 12.0, 90.0, 95.0, 100.0, 100.0, 100.0],
    );
    // 09:10 reports a reset that already passed.
    samples[2].five_hour = Some(UsageWindow::new(12.0, Some("2026-10-14T05:00:00.000Z")));
    // 0 → 10 counts; the 12 → 90 step is not seen as an increase, 90 → 100 counts. Every
    // 5-minute gap is observed: 20 units over 35 minutes.
    near(rate(&samples), (20.0 * 60.0) / 35.0);
}

#[test]
fn an_hour_that_turns_from_idle_to_active_uses_the_whole_hour_as_observed_time() {
    // 09:00–09:25 idle (the window has no reset yet), then 09:30–10:00 rising from 10 to 40.
    // The first active sample is a baseline, so 30 units over the 60 observed minutes (not
    // over the 30 active ones).
    let idle: Vec<UsageSample> = default_series(&pro(), from(), &[0.0; 6])
        .into_iter()
        .map(|sample| UsageSample {
            five_hour: Some(UsageWindow::new(0.0, None)),
            ..sample
        })
        .collect();
    let active = default_series(
        &pro(),
        at("09:30"),
        &[10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0],
    );
    assert_eq!(rate(&concat(&[idle, active])), Some(30.0));
}

#[test]
fn the_pace_factor_is_1_below_1_2_times_the_plan_then_at_most_3_in_tenths() {
    assert_eq!(PACE_WINDOW_MS, 3_600_000.0);
    assert_eq!(MAX_PACE, 3.0);
    assert_eq!(PACE_DEAD_BAND, 1.2);
    assert_eq!(pace_factor(None, 50.0), 1.0);
    assert_eq!(pace_factor(Some(80.0), 0.5), 1.0);
    assert_eq!(pace_factor(Some(40.0), 50.0), 1.0);
    // Within the dead band whole-percent reads and timing are noise, not a pace.
    assert_eq!(pace_factor(Some(57.0), 50.0), 1.0);
    assert_eq!(pace_factor(Some(59.9), 50.0), 1.0);
    assert_eq!(pace_factor(Some(60.0), 50.0), 1.2);
    assert_eq!(pace_factor(Some(80.0), 50.0), 1.6);
    assert_eq!(pace_factor(Some(500.0), 50.0), 3.0);
    assert_eq!(pace_factor(Some(63.3), 50.0), 1.3);
    // Anything that is not a finite measurement against a plan is no pace.
    assert_eq!(pace_factor(Some(f64::NAN), 50.0), 1.0);
    assert_eq!(pace_factor(Some(f64::INFINITY), 50.0), 1.0);
    assert_eq!(pace_factor(Some(80.0), f64::NAN), 1.0);
}

#[test]
fn the_planned_rate_is_the_tempo_s_exact_mean_over_the_stretches_given() {
    let mut profile = vec![0.0; 24];
    profile[9] = 220.0;
    profile[10] = 242.0;
    let tempo = Tempo {
        days: relay_core::shared::tempo::TempoDays {
            weekday: 10,
            weekend: 0,
        },
        ..learned(profile.clone(), profile, (242.0, 242.0))
    };
    let planned = |spans: &[(f64, f64)]| {
        planned_rate(
            &tempo,
            &settings(),
            &spans
                .iter()
                .map(|(from, to)| Span {
                    from: *from,
                    to: *to,
                })
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(planned(&[(at("09:00"), at("10:00"))]), 220.0);
    near(Some(planned(&[(at("09:30"), at("10:30"))])), 231.0);
    // Two stretches with a gap between them: only their minutes count.
    near(
        Some(planned(&[
            (at("09:00"), at("09:30")),
            (at("10:00"), at("10:30")),
        ])),
        231.0,
    );
    // Seconds past the minute, across the work start: 25 min 5 s at 220 of 30 min.
    let second = 1000.0;
    near(
        Some(planned(&[(
            at("08:55") + 5.0 * second,
            at("09:25") + 5.0 * second,
        )])),
        (220.0 * (25.0 * 60.0 + 5.0)) / (30.0 * 60.0),
    );
    // Nothing to average.
    assert_eq!(planned(&[]), 0.0);
    assert_eq!(planned(&[(at("10:00"), at("10:00"))]), 0.0);
}

#[test]
fn the_planned_rate_follows_each_minute_s_own_day_type_across_midnight() {
    let mut weekday = vec![0.0; 24];
    let mut weekend = vec![0.0; 24];
    weekday[23] = 60.0;
    weekday[0] = 30.0;
    weekend[0] = 120.0;
    let tempo = Tempo {
        days: relay_core::shared::tempo::TempoDays {
            weekday: 10,
            weekend: 4,
        },
        ..learned(weekday, weekend, (60.0, 120.0))
    };
    let span = |date: &str, next: &str| {
        [Span {
            from: wall(date, "23:30", ZONE),
            to: wall(next, "00:30", ZONE),
        }]
    };
    // Friday 23:30 to Saturday 00:30: half an hour of each day's profile.
    assert_eq!(
        planned_rate(&tempo, &settings(), &span("2026-10-16", "2026-10-17")),
        90.0
    );
    // Tuesday to Wednesday: the weekday profile on both sides of midnight.
    assert_eq!(
        planned_rate(&tempo, &settings(), &span("2026-10-13", "2026-10-14")),
        45.0
    );
}

/// One account's five-hour use read every five minutes, `offset` past the minute, from `wake`
/// until `until`, in whole percent: it serves `tempo` from the work start at 09:00 (nothing
/// before), in windows from 08:45 renewed every five hours; the Mac sleeps through `sleep`.
fn calm_reads(
    account: &Account,
    tempo: &Tempo,
    wake: f64,
    until: f64,
    offset: f64,
    sleep: Option<(f64, f64)>,
) -> Vec<UsageSample> {
    let capacity = match account.planning.as_ref().expect("planned").plan.as_str() {
        "pro" => 1.0,
        "max5" => 5.0,
        _ => 20.0,
    };
    let window = 5.0 * 60.0 * MINUTE_MS;
    let window_start = |time: f64| at("08:45") + ((time - at("08:45")) / window).floor() * window;
    let mut out = Vec::new();
    let mut time = wake + offset;
    while time <= until {
        if sleep.is_some_and(|(from, to)| time >= from && time < to) {
            time += 5.0 * MINUTE_MS;
            continue;
        }
        let start = window_start(time);
        let begin = start.max(at("09:00"));
        let units = planned_rate(
            tempo,
            &settings(),
            &[Span {
                from: begin,
                to: time,
            }],
        ) * (0f64.max(time - begin) / (60.0 * MINUTE_MS));
        out.push(UsageSample {
            account_id: account.id.clone(),
            identity: usage_identity(account).expect("an identity"),
            checked_at: iso(time),
            five_hour: Some(UsageWindow::new(
                100f64.min(js::round(units / capacity)),
                Some(&iso(start + window)),
            )),
            seven_day: None,
        });
        time += 5.0 * MINUTE_MS;
    }
    out
}

fn pace_of(samples: &[UsageSample], account: &Account, tempo: &Tempo, now: f64) -> Pace {
    todays_pace(PaceInput {
        samples,
        accounts: std::slice::from_ref(account),
        tempo,
        settings: &settings(),
        from: now - PACE_WINDOW_MS,
        to: now + 1.0,
    })
}

/// Busy from 09:00 to 18:00 at `rate`, nothing outside.
fn working(rate: f64) -> Tempo {
    let mut tempo = flat_tempo(rate);
    tempo.weekday = (0..24)
        .map(|h| if (9..18).contains(&h) { rate } else { 0.0 })
        .collect();
    tempo
}

#[test]
fn today_s_pace_compares_the_observed_rate_with_the_plan_over_the_same_stretches() {
    // Awake from 08:55, a Pro used at the planned 120 an hour from 09:00.
    let p = planning_account("p", "pro");
    let tempo = working(120.0);
    let now = at("09:25");
    let pace = pace_of(
        &calm_reads(&p, &tempo, at("08:55"), now, 0.0, None),
        &p,
        &tempo,
        now,
    );
    // 50 units over the 30 observed minutes, as planned over those 30 minutes (25 of them at
    // 120), not over the whole hour.
    assert_eq!(
        pace,
        Pace {
            observed: Some(100.0),
            planned: 100.0,
            factor: 1.0,
        }
    );
    // Under 30 observed minutes: no observed rate, and the plan's pace.
    let early = pace_of(
        &calm_reads(&p, &tempo, at("09:00"), now, 0.0, None),
        &p,
        &tempo,
        now,
    );
    assert_eq!(early.observed, None);
    assert_eq!(early.factor, 1.0);
}

#[test]
fn use_above_the_plan_by_no_more_than_a_percent_of_each_window_that_rose_is_no_pace() {
    // A Max 20× planned at 180 an hour from 09:00, read every five minutes overnight. By 09:10
    // the plan has used 30 Pro units (1.5%).
    let x = planning_account("x", "max20");
    let tempo = working(180.0);
    let now = at("09:10");
    let reads = |late: &[f64]| {
        let mut used = vec![0.0; 11];
        used.extend_from_slice(late);
        series(&x, at("08:10"), &used, "2026-10-14T10:45:00.000Z", 5.0)
    };
    // Read as 2% (40 units, 1.33 times the plan): a percent is 20 units, so the 10 above the
    // plan are rounding.
    assert_eq!(
        pace_of(&reads(&[1.0, 2.0]), &x, &tempo, now),
        Pace {
            observed: Some(40.0),
            planned: 30.0,
            factor: 1.0,
        }
    );
    // 3% (60 units) is 30 above: twice the plan.
    assert_eq!(
        pace_of(&reads(&[2.0, 3.0]), &x, &tempo, now),
        Pace {
            observed: Some(60.0),
            planned: 30.0,
            factor: 2.0,
        }
    );
}

#[test]
fn calm_use_read_every_five_minutes_in_whole_percent_keeps_the_pace_at_1_minute_by_minute() {
    let cases = [
        (planning_account("p", "pro"), 0.1),
        (planning_account("p", "pro"), 0.11),
        (planning_account("m", "max5"), 0.45),
        (planning_account("m", "max5"), 0.5),
        (planning_account("x", "max20"), 1.0),
        (planning_account("x", "max20"), 2.0),
    ];
    type Night = (&'static str, f64, Option<(f64, f64)>);
    let nights: [Night; 5] = [
        ("overnight", at("03:00"), None),
        ("awake from 08:30", at("08:30"), None),
        ("awake from 08:40", at("08:40"), None),
        ("awake from 08:50", at("08:50"), None),
        (
            "asleep over lunch",
            at("03:00"),
            Some((at("12:00"), at("13:00"))),
        ),
    ];
    for (account, scale) in &cases {
        for (label, wake, sleep) in &nights {
            for offset in (0..5).map(|m| f64::from(m) * MINUTE_MS + 5_000.0) {
                let tempo = helpers::busy_scaled(*scale);
                let samples = calm_reads(account, &tempo, *wake, at("15:00"), offset, *sleep);
                let mut now = at("09:00");
                while now <= at("15:00") {
                    if sleep.is_some_and(|(from, to)| now >= from && now < to) {
                        now += MINUTE_MS;
                        continue;
                    }
                    let seen: Vec<UsageSample> = samples
                        .iter()
                        .filter(|s| date_parse(&s.checked_at) <= now)
                        .cloned()
                        .collect();
                    let pace = pace_of(&seen, account, &tempo, now);
                    assert_eq!(
                        pace.factor,
                        1.0,
                        "{} ×{scale} {label} +{}s at {}: {:?} / {}",
                        account.planning.as_ref().expect("planned").plan.as_str(),
                        offset / 1000.0,
                        iso(now),
                        pace.observed,
                        pace.planned
                    );
                    now += MINUTE_MS;
                }
            }
        }
    }
}
