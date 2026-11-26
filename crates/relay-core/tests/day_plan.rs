//! Port of `tests/day-plan.test.ts`. The plan cache is process-wide (as the TS module's), so
//! every case holds one lock: the cache counters one case reads are not bumped by another.

#[path = "common/planning.rs"]
mod helpers;

use std::sync::{Arc, Mutex, MutexGuard};

use helpers::{HOUR as H, ZONE, busy_tempo, clock_in, hours, planning_account, team_account, wall};
use relay_core::shared::capacity_plan::{
    SIM_STEP_MS, StartAccount, StartInterval, StartPlan, StartPlanInput, optimize_starts,
};
use relay_core::shared::day_plan::{
    DayPlan, PlanContext, WINDOW_MS, clear_plan_cache, cycle_phases, day_plan, day_start,
    next_planned_start, plan_cache_stats, plan_context, shift_date, should_have_window,
    work_interval,
};
use relay_core::shared::planning::{plan_capacity, wall_time};
use relay_core::shared::tempo::{Tempo, TempoDays, TempoSource, preset_tempo, tempo_rate};
use relay_core::shared::types::js::{JsMap, date_parse};
use relay_core::shared::types::{
    Account, PlanningAccount, PlanningHours, PlanningSettings, TempoChoice,
    default_planning_settings,
};

fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

const TUESDAY: &str = "2026-10-13";
const SATURDAY: &str = "2026-10-17";
const WEDNESDAY: &str = "2026-10-14";
const FRIDAY: &str = "2026-10-16";
const A: &str = "8a3f0c1e-4f7d-4c3a-9d4e-0a1b2c3d4e5f";
const B: &str = "5b2e9d7c-1a4f-4e8b-8c6d-7f8e9a0b1c2d";
const C: &str = "c4d5e6f7-0819-4a2b-b3c4-d5e6f708192a";

fn at(date: &str, clock: &str) -> f64 {
    wall(date, clock, ZONE)
}
fn accounts() -> Vec<Account> {
    [A, B, C]
        .iter()
        .map(|id| planning_account(id, "pro"))
        .collect()
}
fn medium() -> Tempo {
    preset_tempo(
        TempoChoice::Medium,
        TempoSource::Preset,
        TempoDays::default(),
    )
}
fn context() -> PlanContext {
    plan_context(&accounts(), medium())
}
/// Five-hour windows from `first` while they start before `end`.
fn chain(first: f64, end: f64) -> Vec<f64> {
    let mut starts = Vec::new();
    let mut start = first;
    while start < end {
        starts.push(start);
        start += WINDOW_MS;
    }
    starts
}
fn ids(list: &[(&str, Option<&str>)]) -> Vec<PlanningAccount> {
    list.iter()
        .map(|(id, first)| PlanningAccount {
            id: (*id).into(),
            first_start: first.map(str::to_string),
        })
        .collect()
}
/// `settings(patch)`: 09:00–21:00 weekdays, weekends off, A planned.
fn settings() -> PlanningSettings {
    PlanningSettings {
        time_zone: ZONE.into(),
        weekday: hours(true, "09:00", "21:00"),
        weekend: hours(false, "11:00", "18:00"),
        accounts: ids(&[(A, None)]),
        ..default_planning_settings()
    }
}
fn with_accounts(list: &[(&str, Option<&str>)]) -> PlanningSettings {
    PlanningSettings {
        accounts: ids(list),
        ..settings()
    }
}
fn with_weekday(weekday: PlanningHours) -> PlanningSettings {
    PlanningSettings {
        weekday,
        ..settings()
    }
}
fn plan(date: &str, settings: &PlanningSettings, context: &PlanContext) -> DayPlan {
    day_plan(date, settings, context, None)
}

#[test]
fn phases_spread_resets_evenly_over_the_five_hour_cycle() {
    let _serial = serial();
    assert_eq!(cycle_phases(&[None]), [2.5 * H]);
    assert_eq!(cycle_phases(&[None, None]), [1.25 * H, 3.75 * H]);
    assert_eq!(
        cycle_phases(&[None, None, None]),
        [50.0 * 60_000.0, 150.0 * 60_000.0, 250.0 * 60_000.0]
    );
}

#[test]
fn fixed_phases_stay_and_the_others_fill_the_widest_gaps() {
    let _serial = serial();
    assert_eq!(cycle_phases(&[Some(0.0), None]), [0.0, 2.5 * H]);
    assert_eq!(cycle_phases(&[Some(H), None, None]), [H, 3.5 * H, 2.25 * H]);
    assert_eq!(cycle_phases(&[Some(6.0 * H), None]), [H, 3.5 * H]);
}

#[test]
fn two_accounts_spread_evenly_at_05_15_and_07_45_and_roll_every_five_hours_until_work_ends() {
    let _serial = serial();
    let plan = plan(TUESDAY, &with_accounts(&[(A, None), (B, None)]), &context());
    let interval = plan.interval.as_ref().expect("hours");
    assert_eq!(interval.start, at(TUESDAY, "09:00"));
    assert_eq!(interval.end, at(TUESDAY, "21:00"));
    let (a, b) = (&plan.accounts[0], &plan.accounts[1]);
    assert_eq!(a.even_start, at(TUESDAY, "05:15"));
    assert_eq!(b.even_start, at(TUESDAY, "07:45"));
    assert_eq!(
        a.windows.iter().map(|w| w.start).collect::<Vec<_>>(),
        chain(a.first_start, at(TUESDAY, "21:00"))
    );
    assert_eq!(
        b.windows.iter().map(|w| w.start).collect::<Vec<_>>(),
        chain(b.first_start, at(TUESDAY, "21:00"))
    );
    assert!(a.windows.iter().all(|w| w.end - w.start == WINDOW_MS));
    assert_eq!(a.active_from, a.first_start);
    assert_eq!(a.active_until, at(TUESDAY, "21:00"));
    assert!(!a.manual);
}

#[test]
fn a_manual_first_start_keeps_its_time_and_the_others_move_around_it() {
    let _serial = serial();
    let plan = plan(
        TUESDAY,
        &with_accounts(&[(A, Some("07:00")), (B, None)]),
        &context(),
    );
    assert_eq!(plan.accounts[0].first_start, at(TUESDAY, "07:00"));
    assert_eq!(plan.accounts[0].even_start, at(TUESDAY, "07:00"));
    assert!(plan.accounts[0].manual);
    // A resets at 12:00 (phase 3 h); evenly B goes half a cycle away (phase 0.5 h).
    assert_eq!(plan.accounts[1].even_start, at(TUESDAY, "04:30"));
    assert!(!plan.accounts[1].manual);
    // A clock outside (start − 5 h, end) keeps its rhythm and warms up before work: 22:30 with
    // 09:00–21:00 → 07:30 (07:30, 12:30, 17:30, 22:30 …).
    let late = day_plan(
        TUESDAY,
        &with_accounts(&[(A, Some("22:30"))]),
        &context(),
        None,
    );
    assert_eq!(late.accounts[0].first_start, at(TUESDAY, "07:30"));
    assert!(late.accounts[0].manual);
}

#[test]
fn night_shifts_take_a_manual_time_after_midnight_as_the_same_night() {
    let _serial = serial();
    let night = PlanningSettings {
        weekday: hours(true, "22:00", "06:00"),
        accounts: ids(&[(A, Some("00:30"))]),
        ..settings()
    };
    let plan = plan(TUESDAY, &night, &context());
    assert_eq!(plan.accounts[0].first_start, at("2026-10-14", "00:30"));
    assert!(!should_have_window(
        A,
        at(TUESDAY, "12:00"),
        &night,
        &context()
    ));
    assert!(should_have_window(
        A,
        at("2026-10-14", "01:00"),
        &night,
        &context()
    ));
    // A clock that is useless for the shift keeps its rhythm before work.
    let noon = day_plan(
        TUESDAY,
        &PlanningSettings {
            weekday: hours(true, "22:00", "06:00"),
            accounts: ids(&[(A, Some("12:00"))]),
            ..settings()
        },
        &context(),
        None,
    );
    assert_eq!(noon.accounts[0].first_start, at(TUESDAY, "17:00"));
}

#[test]
fn a_manual_clock_that_does_not_exist_on_a_dst_day_is_skipped_keeping_the_rhythm() {
    let _serial = serial();
    let zone = "Europe/Berlin";
    let plan = plan(
        "2026-03-29",
        &PlanningSettings {
            time_zone: zone.into(),
            weekend: hours(true, "06:00", "14:00"),
            accounts: ids(&[(A, Some("02:30"))]),
            ..default_planning_settings()
        },
        &context(),
    );
    assert_eq!(
        Some(plan.accounts[0].first_start),
        wall_time("2026-03-29", "01:30", zone)
    );
}

#[test]
fn a_day_starts_at_its_first_existing_minute_when_midnight_is_skipped() {
    let _serial = serial();
    let zone = "Africa/Cairo";
    assert_eq!(wall_time("2026-04-24", "00:00", zone), None);
    assert_eq!(
        Some(day_start("2026-04-24", zone)),
        wall_time("2026-04-24", "01:00", zone)
    );
    assert_eq!(day_start(TUESDAY, ZONE), at(TUESDAY, "00:00"));
}

#[test]
fn weekend_hours_apply_on_saturday_disabled_days_and_empty_plans_have_no_interval() {
    let _serial = serial();
    assert_eq!(work_interval(SATURDAY, &settings()), None);
    let weekend = PlanningSettings {
        weekend: hours(true, "11:00", "18:00"),
        ..settings()
    };
    assert_eq!(
        work_interval(SATURDAY, &weekend).map(|i| i.start),
        Some(at(SATURDAY, "11:00"))
    );
    assert_eq!(
        work_interval(SATURDAY, &weekend).map(|i| i.weekend),
        Some(true)
    );
    let none = with_weekday(hours(false, "09:00", "21:00"));
    assert_eq!(work_interval(TUESDAY, &none), None);
    assert!(plan(TUESDAY, &none, &context()).accounts.is_empty());
    assert_eq!(plan(TUESDAY, &none, &context()).forecast, None);
    assert_eq!(
        next_planned_start(A, at(TUESDAY, "10:00"), &none, &context()),
        None
    );
    let empty = plan(TUESDAY, &with_accounts(&[]), &context());
    assert!(empty.accounts.is_empty());
    assert_eq!(empty.forecast, None);
    assert_eq!(empty.even_forecast, None);
}

#[test]
fn overnight_and_full_day_intervals() {
    let _serial = serial();
    let night = with_weekday(hours(true, "22:00", "04:00"));
    assert_eq!(
        work_interval(TUESDAY, &night).map(|i| i.end),
        Some(at("2026-10-14", "04:00"))
    );
    let full = with_weekday(hours(true, "00:00", "00:00"));
    let interval = work_interval(TUESDAY, &full).expect("hours");
    assert_eq!(interval.end - interval.start, 24.0 * H);
}

#[test]
fn a_window_should_run_from_the_first_warm_up_until_work_ends_including_after_midnight() {
    let _serial = serial();
    let s = settings();
    let first = plan(TUESDAY, &s, &context()).accounts[0].first_start;
    assert!(first <= at(TUESDAY, "09:00"));
    assert!(!should_have_window(A, first - 60_000.0, &s, &context()));
    assert!(should_have_window(A, first, &s, &context()));
    assert!(should_have_window(A, at(TUESDAY, "20:59"), &s, &context()));
    assert!(!should_have_window(A, at(TUESDAY, "21:00"), &s, &context()));
    assert!(!should_have_window(C, at(TUESDAY, "12:00"), &s, &context()));
    let night = with_weekday(hours(true, "22:00", "04:00"));
    assert!(should_have_window(
        A,
        at("2026-10-14", "02:00"),
        &night,
        &context()
    ));
}

#[test]
fn the_next_planned_start_is_the_following_day_s_warm_up() {
    let _serial = serial();
    assert_eq!(
        next_planned_start(A, at(TUESDAY, "22:00"), &settings(), &context()),
        Some(plan("2026-10-14", &settings(), &context()).accounts[0].first_start)
    );
}

#[test]
fn a_live_reset_continues_the_chain_from_the_actual_window() {
    let _serial = serial();
    let live: JsMap<f64> = [(A.to_string(), at(TUESDAY, "12:00"))]
        .into_iter()
        .collect();
    let plan = day_plan(TUESDAY, &settings(), &context(), Some(&live));
    assert!(plan.accounts[0].first_start < at(TUESDAY, "12:00"));
    assert_eq!(
        plan.accounts[0]
            .windows
            .iter()
            .map(|w| (w.start, w.end))
            .collect::<Vec<_>>(),
        [
            (at(TUESDAY, "07:00"), at(TUESDAY, "12:00")),
            (at(TUESDAY, "12:00"), at(TUESDAY, "17:00")),
            (at(TUESDAY, "17:00"), at(TUESDAY, "17:00") + WINDOW_MS),
        ]
    );
}

#[test]
fn plan_weights_are_ratios_team_and_unknown_need_their_explicit_manual_capacity() {
    let _serial = serial();
    for (plan, expected) in [("pro", 1.0), ("max5", 5.0), ("max20", 20.0)] {
        let mut a = planning_account("a", plan);
        a.planning.as_mut().expect("planned").capacity_weight = 99.0;
        assert_eq!(plan_capacity(&a), expected);
    }
    let mut a = planning_account("a", "team");
    assert_eq!(plan_capacity(&a), 1.0);
    a.planning.as_mut().expect("planned").capacity_weight = 12.0;
    assert_eq!(plan_capacity(&a), 12.0);
    a.planning.as_mut().expect("planned").capacity_weight = f64::NAN;
    assert_eq!(plan_capacity(&a), 1.0);
}

// The capacity scenario: Max 5×, Team (weight 2) and Pro on a busy Wednesday.
fn scenario_accounts() -> Vec<Account> {
    vec![
        planning_account("max", "max5"),
        team_account("vertex", 2.0),
        planning_account("pro", "pro"),
    ]
}
fn scenario() -> PlanningSettings {
    PlanningSettings {
        weekday: hours(true, "09:00", "18:00"),
        accounts: ids(&[("max", None), ("vertex", None), ("pro", None)]),
        ..settings()
    }
}
fn scenario_context() -> PlanContext {
    plan_context(&scenario_accounts(), busy_tempo())
}
fn clocks(times: impl IntoIterator<Item = f64>) -> Vec<String> {
    times.into_iter().map(|t| clock_in(t, ZONE)).collect()
}

#[test]
fn capacities_and_tempo_pick_the_first_starts_that_leave_no_demand_unmet() {
    let _serial = serial();
    let plan = plan(WEDNESDAY, &scenario(), &scenario_context());
    assert_eq!(
        clocks(plan.accounts.iter().map(|a| a.first_start)),
        ["06:15", "08:15", "06:30"]
    );
    assert_eq!(
        clocks(plan.accounts.iter().map(|a| a.even_start)),
        ["04:50", "06:30", "08:10"]
    );
    assert!(plan.accounts.iter().all(|a| !a.manual));
    let forecast = plan.forecast.as_ref().expect("simulated");
    assert_eq!(forecast.unmet, 0.0);
    assert_eq!(forecast.switches, 3);
    assert_eq!(
        plan.even_forecast
            .as_ref()
            .expect("simulated")
            .outage_minutes,
        32.0
    );
    // Windows and the active range follow the chosen first start.
    let first = &plan.accounts[0];
    assert_eq!(first.active_from, first.first_start);
    assert_eq!(
        first.windows.iter().map(|w| w.start).collect::<Vec<_>>(),
        chain(first.first_start, at(WEDNESDAY, "18:00"))
    );
}

#[test]
fn a_manual_first_start_stays_exactly_while_the_others_are_optimized() {
    let _serial = serial();
    let plan = plan(
        WEDNESDAY,
        &PlanningSettings {
            accounts: ids(&[("max", Some("07:10")), ("vertex", None), ("pro", None)]),
            ..scenario()
        },
        &scenario_context(),
    );
    assert_eq!(plan.accounts[0].first_start, at(WEDNESDAY, "07:10"));
    assert_eq!(plan.accounts[0].even_start, at(WEDNESDAY, "07:10"));
    assert!(plan.accounts[0].manual);
    assert_eq!(
        plan.accounts.iter().map(|a| a.manual).collect::<Vec<_>>(),
        [true, false, false]
    );
    let (forecast, even) = (
        plan.forecast.as_ref().expect("simulated"),
        plan.even_forecast.as_ref().expect("simulated"),
    );
    assert!(forecast.unmet <= even.unmet);
}

#[test]
fn the_same_input_returns_the_same_plan_and_a_capacity_change_replans() {
    let _serial = serial();
    let first = plan(WEDNESDAY, &scenario(), &scenario_context());
    let again = plan(WEDNESDAY, &scenario(), &scenario_context());
    assert_eq!(again, first);
    // The optimized starts are cached and shared.
    assert!(Arc::ptr_eq(
        again.forecast.as_ref().expect("simulated"),
        first.forecast.as_ref().expect("simulated")
    ));
    let mut smaller = scenario_context();
    smaller.capacities.insert("max", 1.0);
    let replanned = plan(WEDNESDAY, &scenario(), &smaller);
    let (replanned, first) = (
        replanned.forecast.expect("simulated"),
        first.forecast.expect("simulated"),
    );
    assert!(!Arc::ptr_eq(&replanned, &first));
    assert_ne!(replanned, first);
    assert!(replanned.unmet > first.unmet);
}

#[test]
fn a_planned_account_without_a_known_capacity_counts_as_one_pro_account() {
    let _serial = serial();
    let unknown = "0f1e2d3c-4b5a-4968-8776-655443322110";
    let s = with_accounts(&[(A, None), (unknown, None)]);
    let ctx = plan_context(
        &accounts()[..1],
        preset_tempo(
            TempoChoice::Heavy,
            TempoSource::Preset,
            TempoDays::default(),
        ),
    );
    assert_eq!(ctx.capacities.get(unknown), None);
    let day = plan(TUESDAY, &s, &ctx);
    assert_eq!(day.accounts.len(), 2);
    let mut known = ctx.clone();
    known.capacities.insert(unknown, 1.0);
    assert_eq!(day, plan(TUESDAY, &s, &known));
    assert!(should_have_window(unknown, at(TUESDAY, "12:00"), &s, &ctx));
}

#[test]
fn a_night_shift_is_simulated_across_midnight_with_the_start_day_s_profile() {
    let _serial = serial();
    // Demand only between 22:00 and 06:00 on weekdays; none on weekends, so the Saturday hours
    // of a Friday night count only through the weekday profile.
    let night_tempo = Tempo {
        weekday: (0..24)
            .map(|hour| if !(6..22).contains(&hour) { 100.0 } else { 0.0 })
            .collect(),
        weekend: vec![0.0; 24],
        ..busy_tempo()
    };
    let night = PlanningSettings {
        weekday: hours(true, "22:00", "06:00"),
        accounts: ids(&[(A, None)]),
        ..settings()
    };
    let plan = plan(FRIDAY, &night, &plan_context(&accounts(), night_tempo));
    assert_eq!(plan.interval.as_ref().map(|i| i.weekend), Some(false));
    let forecast = plan.forecast.as_ref().expect("simulated");
    assert_eq!(forecast.segments[0].from, at(FRIDAY, "22:00"));
    assert_eq!(
        forecast.segments.last().expect("segments").to,
        at("2026-10-17", "06:00")
    );
    // Eight hours at 100 Pro units/h, a Pro window holds 100: three windows touch the night,
    // the other 500 units are unmet.
    assert_eq!(forecast.unmet, 500.0);
    assert_eq!(plan.accounts[0].first_start, at(FRIDAY, "19:00"));
}

#[test]
fn the_keeper_s_checks_agree_with_the_capacity_aware_plan() {
    let _serial = serial();
    let s = scenario();
    let ctx = scenario_context();
    let tomorrow = plan(WEDNESDAY, &s, &ctx);
    for account in &tomorrow.accounts {
        assert_eq!(
            next_planned_start(&account.account_id, at(TUESDAY, "22:00"), &s, &ctx),
            Some(account.first_start)
        );
        assert!(!should_have_window(
            &account.account_id,
            account.first_start - 60_000.0,
            &s,
            &ctx
        ));
        assert!(should_have_window(
            &account.account_id,
            account.first_start,
            &s,
            &ctx
        ));
    }
}

#[test]
fn the_default_tempo_plans_a_lone_pro_and_two_pro_accounts_at_fixed_times() {
    let _serial = serial();
    let nine = || hours(true, "09:00", "18:00");
    // Nine hours at 50 Pro units/h, 100 per window: only a 06:00 warm-up uses three whole
    // windows (09:00–11:00, 11:00–13:00, 16:00–18:00).
    let lone = plan(TUESDAY, &with_weekday(nine()), &context());
    assert_eq!(
        clocks(lone.accounts.iter().map(|a| a.first_start)),
        ["06:00"]
    );
    assert_eq!(lone.forecast.as_ref().map(|f| f.unmet), Some(150.0));
    let two = plan(
        TUESDAY,
        &PlanningSettings {
            weekday: nine(),
            accounts: ids(&[(A, None), (B, None)]),
            ..settings()
        },
        &context(),
    );
    // 450 Pro units of demand, 100 per window: no gap with two switches. Of those plans, 06:00
    // and 09:00 put the resets furthest apart (11:00/16:00 and 14:00: two and three hours);
    // the 09:00 window opens with the work, so nothing warms up five hours early.
    assert_eq!(
        clocks(two.accounts.iter().map(|a| a.first_start)),
        ["06:00", "09:00"]
    );
    assert_eq!(two.forecast.as_ref().map(|f| f.unmet), Some(0.0));
    assert_eq!(two.forecast.as_ref().map(|f| f.switches), Some(2));
}

#[test]
fn plans_shared_across_dates_equal_plans_optimized_for_each_date_alone() {
    let _serial = serial();
    // Hour-shaped demand, so the profile's alignment with the work start matters.
    let shaped = Tempo {
        weekday: (0..24).map(|hour| 40.0 + f64::from(hour) * 7.0).collect(),
        weekend: (0..24).map(|hour| 120.0 - f64::from(hour) * 3.0).collect(),
        ..busy_tempo()
    };
    // Night shifts in Berlin span both DST changes (2026-03-29, 2026-10-25), with a manual
    // clock after the change.
    let night = PlanningSettings {
        time_zone: "Europe/Berlin".into(),
        weekday: hours(true, "22:00", "06:00"),
        weekend: hours(true, "22:00", "06:00"),
        accounts: ids(&[("max", None), ("vertex", None), ("pro", Some("03:30"))]),
        ..settings()
    };
    let days = |from: &str, count: usize| -> Vec<String> {
        (0..count).map(|i| shift_date(from, i as f64)).collect()
    };
    let mut night_dates = days("2026-03-26", 6);
    night_dates.extend(days("2026-10-22", 6));
    let cases = [
        (scenario(), scenario_context(), days("2026-10-12", 3)),
        (
            night,
            plan_context(&scenario_accounts(), shaped),
            night_dates,
        ),
    ];
    for (s, ctx, dates) in &cases {
        clear_plan_cache();
        let warm: Vec<DayPlan> = dates.iter().map(|date| plan(date, s, ctx)).collect();
        let cold: Vec<DayPlan> = dates
            .iter()
            .map(|date| {
                clear_plan_cache();
                plan(date, s, ctx)
            })
            .collect();
        assert_eq!(warm, cold);
        // The same as optimizing the day in absolute time.
        for plan in &warm {
            let interval = plan.interval.as_ref().expect("hours");
            let accounts: Vec<StartAccount> = plan
                .accounts
                .iter()
                .map(|a| StartAccount {
                    id: a.account_id.clone(),
                    capacity: ctx.capacities.get(&a.account_id).copied().unwrap_or(1.0),
                    manual: a.manual.then_some(a.first_start),
                })
                .collect();
            let even: Vec<f64> = plan.accounts.iter().map(|a| a.even_start).collect();
            let rate = tempo_rate(
                &ctx.tempo,
                interval.weekend,
                &s.time_zone,
                interval.start,
                interval.end,
                SIM_STEP_MS,
            );
            let direct = optimize_starts(StartPlanInput {
                interval: StartInterval {
                    start: interval.start,
                    end: interval.end,
                },
                accounts: &accounts,
                rate: &rate,
                even: &even,
                early_stop: None,
            });
            assert_eq!(
                StartPlan {
                    starts: plan.accounts.iter().map(|a| a.first_start).collect(),
                    forecast: plan.forecast.as_deref().expect("simulated").clone(),
                    even_forecast: plan.even_forecast.as_deref().expect("simulated").clone(),
                },
                direct,
                "{}",
                plan.date
            );
        }
    }
}

#[test]
fn a_week_of_plans_optimizes_each_distinct_day_shape_once() {
    let _serial = serial();
    let mut four = scenario_accounts();
    four.push(planning_account("pro2", "pro"));
    let s = PlanningSettings {
        weekday: hours(true, "09:00", "21:00"),
        weekend: hours(true, "11:00", "17:00"),
        accounts: helpers::planned_accounts(&four),
        ..settings()
    };
    let ctx = plan_context(&four, busy_tempo());
    let week: Vec<String> = (0..7)
        .map(|i| shift_date("2026-10-12", f64::from(i)))
        .collect();
    clear_plan_cache();
    assert_eq!(plan_cache_stats().optimizations, 0);
    for date in &week {
        plan(date, &s, &ctx);
    }
    // One weekday shape and one weekend shape.
    assert_eq!(plan_cache_stats().optimizations, 2);
    for date in &week {
        plan(date, &s, &ctx);
    }
    assert_eq!(plan_cache_stats().optimizations, 2);
    clear_plan_cache();
    assert_eq!(plan_cache_stats().optimizations, 0);
}

#[test]
fn work_hours_that_end_in_a_skipped_dst_hour_end_at_the_first_time_after_it() {
    let _serial = serial();
    let night = PlanningSettings {
        time_zone: "Europe/Berlin".into(),
        weekend: hours(true, "22:00", "02:30"),
        ..settings()
    };
    // 2026-03-29 02:00 CET jumps to 03:00 CEST: 02:30 never happens.
    let interval = work_interval("2026-03-28", &night).expect("hours");
    assert_eq!(interval.start, date_parse("2026-03-28T21:00:00Z"));
    assert_eq!(interval.end, date_parse("2026-03-29T01:00:00Z"));
}
