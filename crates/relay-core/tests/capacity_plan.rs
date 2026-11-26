//! Port of `tests/capacity-plan.test.ts`.

#[path = "common/planning.rs"]
mod helpers;

use std::cell::Cell;
use std::time::Instant;

use helpers::{HOUR as H, MINUTE as MIN, hhmm};
use relay_core::shared::capacity_plan::{
    Forecast, SIM_STEP_MS, SimAccount, SimInput, StartAccount, StartInterval, StartPlanInput,
    optimize_starts, simulate_day,
};
use relay_core::shared::types::js::date_parse;
use relay_core::shared::work_hours::WINDOW_MS;

fn base() -> f64 {
    date_parse("2026-10-14T00:00:00Z")
}
fn s() -> f64 {
    base() + 9.0 * H
}
fn e() -> f64 {
    base() + 18.0 * H
}

fn profile(hour: f64) -> f64 {
    match hour as i64 {
        9 => 220.0,
        10 | 11 | 14 | 15 => 242.0,
        12 => 110.0,
        13 => 198.0,
        16 => 220.0,
        17 => 154.0,
        _ => 0.0,
    }
}
fn rate(time: f64) -> f64 {
    let hour = ((time - base()) / H).floor();
    if (9.0..=17.0).contains(&hour) {
        profile(hour)
    } else {
        0.0
    }
}
fn scaled(factor: f64) -> impl Fn(f64) -> f64 {
    move |time| rate(time) * factor
}
fn flat(per_hour: f64) -> impl Fn(f64) -> f64 {
    move |time| {
        if time >= s() && time < e() {
            per_hour
        } else {
            0.0
        }
    }
}

fn start_account(id: &str, capacity: f64) -> StartAccount {
    StartAccount {
        id: id.into(),
        capacity,
        manual: None,
    }
}
fn accounts() -> Vec<StartAccount> {
    vec![
        start_account("max", 5.0),
        start_account("vertex", 2.0),
        start_account("pro", 1.0),
    ]
}
fn even_for(count: usize) -> Vec<f64> {
    (0..count)
        .map(|i| s() + (WINDOW_MS * (i as f64 + 0.5)) / count as f64 - WINDOW_MS)
        .collect()
}
fn with_pro(count: usize) -> Vec<StartAccount> {
    let mut list = accounts();
    list.extend((0..count).map(|i| start_account(&format!("pro{}", i + 2), 1.0)));
    list
}

fn acc(id: &str, capacity: f64, keep_alive: bool, remaining: f64) -> SimAccount {
    SimAccount {
        id: id.into(),
        capacity,
        keep_alive,
        remaining,
        ..SimAccount::default()
    }
}
fn reset_at(mut a: SimAccount, reset: f64) -> SimAccount {
    a.first_reset = Some(reset);
    a
}

fn run(
    from: f64,
    to: f64,
    rate: &dyn Fn(f64) -> f64,
    list: &[SimAccount],
    active: Option<&str>,
) -> Forecast {
    simulate_day(SimInput {
        from,
        to,
        rate,
        accounts: list,
        active,
        stop_when: None,
    })
}
fn sim(list: &[SimAccount], per_hour: &dyn Fn(f64) -> f64, active: Option<&str>) -> Forecast {
    run(s(), e(), per_hour, list, active)
}
fn plan(
    interval: (f64, f64),
    accounts: &[StartAccount],
    rate: &dyn Fn(f64) -> f64,
    even: &[f64],
) -> relay_core::shared::capacity_plan::StartPlan {
    optimize_starts(StartPlanInput {
        interval: StartInterval {
            start: interval.0,
            end: interval.1,
        },
        accounts,
        rate,
        even,
        early_stop: None,
    })
}

/// The score the optimizer ranks first: unmet (to 0.5), then switches.
fn score(forecast: &Forecast) -> (f64, f64) {
    (
        relay_core::shared::types::js::round(forecast.unmet * 2.0) / 2.0,
        f64::from(forecast.switches),
    )
}
fn not_worse(result: &Forecast, reference: &Forecast) -> bool {
    let (a, b) = (score(result), score(reference));
    a.0 < b.0 || (a.0 == b.0 && a.1 <= b.1)
}
fn view(forecast: &Forecast) -> Vec<String> {
    forecast
        .segments
        .iter()
        .map(|s| {
            format!(
                "{} {}-{}",
                s.account_id.as_deref().unwrap_or("outage"),
                hhmm(s.from),
                hhmm(s.to)
            )
        })
        .collect()
}
fn exhausted(forecast: &Forecast, id: &str) -> Vec<String> {
    forecast
        .exhausted_at
        .get(id)
        .expect("exhausted")
        .iter()
        .map(|t| hhmm(*t))
        .collect()
}

/// The TS tests' `seed * 16807 % 2147483647` generator.
struct Random(f64);
impl Random {
    fn next(&mut self) -> f64 {
        self.0 = (self.0 * 16807.0) % 2147483647.0;
        self.0 / 2147483647.0
    }
}

#[test]
fn the_simulation_step_is_five_minutes() {
    assert_eq!(SIM_STEP_MS, 300_000.0);
}

#[test]
fn the_optimizer_spreads_three_accounts_to_leave_no_demand_unmet() {
    let plan = plan((s(), e()), &accounts(), &rate, &even_for(3));
    assert_eq!(
        plan.starts.iter().map(|t| hhmm(*t)).collect::<Vec<_>>(),
        ["06:15", "08:15", "06:30"]
    );
    assert_eq!(
        view(&plan.forecast),
        [
            "max 09:00-11:09",
            "pro 11:09-11:55",
            "vertex 11:55-14:13",
            "max 14:13-18:00",
        ]
    );
    assert_eq!(plan.forecast.unmet, 0.0);
    assert_eq!(plan.forecast.switches, 3);
    assert_eq!(plan.even_forecast.outage_minutes, 32.0);
    assert_eq!(
        plan.even_forecast
            .segments
            .iter()
            .filter(|s| s.account_id.is_none())
            .map(|s| format!("{}-{}", hhmm(s.from), hhmm(s.to)))
            .collect::<Vec<_>>(),
        ["14:18-14:50"]
    );
    assert_eq!(plan.even_forecast.switches, 5);
    assert_eq!(plan.even_forecast.unmet, 130.3);
}

#[test]
fn the_account_whose_window_resets_soonest_goes_first() {
    let forecast = sim(
        &[
            reset_at(acc("a", 1.0, false, 100.0), base() + 11.0 * H),
            reset_at(acc("b", 5.0, false, 500.0), base() + 13.0 * H),
        ],
        &|_| 60.0,
        None,
    );
    assert_eq!(forecast.segments[0].account_id.as_deref(), Some("a"));
    assert_eq!(hhmm(forecast.segments[0].from), "09:00");
    // 100 units at 60 an hour: a lasts 100 minutes, then b takes over.
    assert_eq!(hhmm(forecast.segments[0].to), "10:40");
    assert_eq!(forecast.segments[1].account_id.as_deref(), Some("b"));
}

#[test]
fn a_step_that_runs_an_account_dry_spills_into_the_next_account() {
    let forecast = sim(
        &[
            reset_at(acc("a", 1.0, false, 1.0), base() + 10.0 * H),
            reset_at(acc("b", 20.0, false, 2000.0), base() + 14.0 * H),
        ],
        &|_| 120.0,
        None,
    );
    assert_eq!(exhausted(&forecast, "a"), ["09:01"]);
    assert_eq!(view(&forecast)[..2], ["a 09:00-09:01", "b 09:01-18:00"]);
    assert_eq!(forecast.unmet, 0.0);
    assert_eq!(forecast.outage_minutes, 0.0);
}

#[test]
fn a_spill_consumes_exactly_the_demand_of_the_step() {
    // One hour at 120 an hour is 120 units; a holds 1 and b holds 109, so the last 10 units
    // (the final five minutes) are unmet.
    let forecast = run(
        s(),
        s() + H,
        &|_| 120.0,
        &[
            reset_at(acc("a", 1.0, false, 1.0), base() + 10.0 * H),
            reset_at(acc("b", 1.0, false, 109.0), base() + 14.0 * H),
        ],
        None,
    );
    assert!(
        (forecast.unmet - 10.0).abs() <= 0.1,
        "unmet {}",
        forecast.unmet
    );
    assert_eq!(forecast.outage_minutes, 5.0);
    assert_eq!(
        view(&forecast),
        ["a 09:00-09:01", "b 09:01-09:55", "outage 09:55-10:00"]
    );
    // b runs dry exactly at the end of a step; that is still an exhaustion.
    assert_eq!(exhausted(&forecast, "b"), ["09:55"]);
}

#[test]
fn a_pro_account_refills_at_its_reset_and_idles_in_the_outage_between() {
    let forecast = sim(
        &[SimAccount {
            warm_up: Some(s() - 3.0 * H),
            ..acc("pro", 1.0, true, 100.0)
        }],
        &|_| 50.0,
        None,
    );
    assert_eq!(
        view(&forecast),
        ["pro 09:00-13:00", "outage 13:00-16:00", "pro 16:00-18:00"]
    );
    assert_eq!(forecast.outage_minutes, 180.0);
    assert_eq!(forecast.unmet, 150.0);
    assert_eq!(forecast.switches, 0);
    // 100 units at 50 an hour run out on a step boundary, window after window; the last one
    // lands exactly on the end of the day.
    assert_eq!(exhausted(&forecast, "pro"), ["11:00", "13:00", "18:00"]);
}

#[test]
fn a_run_out_exactly_on_a_step_boundary_is_recorded_once() {
    let forecast = run(
        s(),
        s() + 3.0 * H,
        &|_| 100.0,
        &[acc("c", 1.0, false, 100.0)],
        None,
    );
    assert_eq!(exhausted(&forecast, "c"), ["10:00"]);
    assert_eq!(view(&forecast), ["c 09:00-10:00", "outage 10:00-12:00"]);
}

#[test]
fn running_out_exactly_at_its_own_reset_keeps_the_account_at_any_time_scale() {
    // b serves 11:00–13:00 and its window resets at 13:00: no switch to a and back, whether
    // times are absolute or relative to the work start.
    let day = |origin: f64| {
        run(
            origin,
            origin + 9.0 * H,
            &|_| 50.0,
            &[
                reset_at(acc("a", 1.0, true, 100.0), origin + 3.0 * H),
                reset_at(acc("b", 1.0, true, 100.0), origin + 4.0 * H),
            ],
            None,
        )
    };
    let absolute = day(s());
    assert_eq!(
        view(&absolute),
        ["a 09:00-11:00", "b 11:00-15:00", "a 15:00-18:00"]
    );
    assert_eq!(absolute.switches, 2);
    let relative = day(0.0);
    assert_eq!(relative.switches, 2);
    assert_eq!(
        relative
            .segments
            .iter()
            .map(|x| (x.account_id.clone(), x.from + s(), x.to + s()))
            .collect::<Vec<_>>(),
        absolute
            .segments
            .iter()
            .map(|x| (x.account_id.clone(), x.from, x.to))
            .collect::<Vec<_>>()
    );
}

#[test]
fn running_out_exactly_at_its_own_reset_inside_a_step_keeps_the_account_too() {
    // From 09:01 the five-minute steps miss the hours: a lasts exactly until its reset at
    // 12:00, inside the step from 11:56, and goes on with its refill rather than handing over
    // to b, whose refilled window resets sooner (15:00 against 17:00).
    let day = |from: f64, left: f64| {
        run(
            from,
            e(),
            &|_| 60.0,
            &[
                reset_at(acc("a", 3.0, true, left), base() + 12.0 * H),
                reset_at(acc("b", 1.0, true, 100.0), base() + 10.0 * H),
            ],
            Some("a"),
        )
    };
    let off_grid = day(s() + MIN, 179.0);
    assert_eq!(view(&off_grid), ["a 09:01-18:00"]);
    assert_eq!(off_grid.switches, 0);
    assert_eq!(view(&day(s(), 180.0)), ["a 09:00-18:00"]);
    // It runs dry exactly at each reset and goes on with the refill.
    assert_eq!(exhausted(&off_grid, "a"), ["12:00", "17:00"]);
}

#[test]
fn without_an_account_in_use_the_first_is_chosen_when_demand_first_arises() {
    // Quiet until 09:00: q's window warms up at 06:30 and resets at 11:30, before p's at
    // 12:00, so q goes first although only p was open at 06:00.
    let forecast = run(
        base() + 6.0 * H,
        e(),
        &flat(100.0),
        &[
            reset_at(acc("p", 1.0, true, 100.0), base() + 12.0 * H),
            SimAccount {
                warm_up: Some(base() + 6.5 * H),
                ..acc("q", 1.0, true, 100.0)
            },
        ],
        None,
    );
    assert_eq!(view(&forecast)[0], "q 09:00-10:00");
}

#[test]
fn a_window_that_reset_during_the_step_is_available_when_the_active_one_runs_dry() {
    // a runs out at 09:02:30; b's window reset at 09:02, mid-step.
    let forecast = sim(
        &[
            reset_at(acc("a", 1.0, false, 5.0), base() + 14.0 * H),
            reset_at(acc("b", 20.0, false, 0.0), s() + 2.0 * MIN),
        ],
        &|_| 120.0,
        None,
    );
    assert_eq!(forecast.outage_minutes, 0.0);
    assert_eq!(forecast.unmet, 0.0);
    assert_eq!(view(&forecast), ["a 09:00-09:03", "b 09:03-18:00"]);
    assert_eq!(exhausted(&forecast, "a"), ["09:03"]);
    assert_eq!(forecast.switches, 1);
}

#[test]
fn a_closed_window_starts_on_first_use_and_refills_five_hours_later() {
    let forecast = sim(
        &[acc("c", 1.0, false, 100.0)],
        &|time| {
            if time >= base() + 10.0 * H && time < base() + 16.0 * H {
                100.0
            } else {
                0.0
            }
        },
        None,
    );
    // Used from 10:00, so the window ends 15:00 (not 14:00, five hours after 09:00); the
    // account is chosen only when the demand starts.
    assert_eq!(
        view(&forecast),
        ["c 10:00-11:00", "outage 11:00-15:00", "c 15:00-18:00"]
    );
    assert_eq!(forecast.outage_minutes, 240.0);
    assert_eq!(forecast.unmet, 400.0);
    assert_eq!(exhausted(&forecast, "c"), ["11:00", "16:00"]);
}

#[test]
fn time_without_demand_is_never_an_outage() {
    let forecast = sim(
        &[
            SimAccount {
                blocked: Some(true),
                ..reset_at(acc("a", 5.0, true, 500.0), base() + 12.0 * H)
            },
            reset_at(acc("b", 1.0, false, 0.0), base() + 12.0 * H),
        ],
        &|_| 0.0,
        None,
    );
    assert_eq!(forecast.outage_minutes, 0.0);
    assert_eq!(forecast.unmet, 0.0);
    assert_eq!(forecast.switches, 0);
}

#[test]
fn a_gap_covers_only_unmet_demand_and_a_refill_over_lunch_takes_over_when_demand_resumes() {
    // 60 an hour from 11:00 with lunch from 12:20 to 13:00; everything runs out at 12:10 and
    // `a` refills at 12:40, in the middle of lunch.
    let lunch = |time: f64| {
        if time >= base() + 12.0 * H + 20.0 * MIN && time < base() + 13.0 * H {
            0.0
        } else {
            60.0
        }
    };
    let day = |list: &[SimAccount]| run(base() + 11.0 * H, base() + 15.0 * H, &lunch, list, None);
    let gap_minutes = |forecast: &Forecast| {
        forecast
            .segments
            .iter()
            .filter(|s| s.account_id.is_none())
            .fold(0.0, |sum, s| sum + (s.to - s.from) / MIN)
    };
    let a = |reset: f64| reset_at(acc("a", 2.0, false, 70.0), reset);

    let refilled = day(&[a(base() + 12.0 * H + 40.0 * MIN)]);
    assert_eq!(
        view(&refilled),
        ["a 11:00-12:10", "outage 12:10-12:20", "a 13:00-15:00"]
    );
    assert_eq!(refilled.outage_minutes, 10.0);
    assert_eq!(gap_minutes(&refilled), refilled.outage_minutes);
    assert_eq!(refilled.unmet, 10.0);
    assert_eq!(refilled.switches, 0);

    // Still nothing when work resumes: a second gap until the refill.
    let late = day(&[a(base() + 13.0 * H + 10.0 * MIN)]);
    assert_eq!(
        view(&late),
        [
            "a 11:00-12:10",
            "outage 12:10-12:20",
            "outage 13:00-13:10",
            "a 13:10-15:00",
        ]
    );
    assert_eq!(late.outage_minutes, 20.0);
    assert_eq!(gap_minutes(&late), late.outage_minutes);

    // Another account refilling over lunch is the switch, when demand resumes.
    let other = day(&[
        SimAccount {
            remaining: 70.0,
            ..a(base() + 18.0 * H)
        },
        reset_at(acc("b", 2.0, false, 0.0), base() + 12.0 * H + 40.0 * MIN),
    ]);
    assert_eq!(
        view(&other),
        ["a 11:00-12:10", "outage 12:10-12:20", "b 13:00-15:00"]
    );
    assert_eq!(other.switches, 1);
    assert_eq!(gap_minutes(&other), other.outage_minutes);
}

#[test]
fn a_blocked_account_is_never_chosen() {
    let forecast = sim(
        &[
            SimAccount {
                blocked: Some(true),
                ..reset_at(acc("a", 5.0, true, 500.0), base() + 10.0 * H)
            },
            reset_at(acc("b", 1.0, false, 100.0), base() + 14.0 * H),
        ],
        &|_| 60.0,
        Some("a"),
    );
    assert!(
        forecast
            .segments
            .iter()
            .all(|s| s.account_id.as_deref() != Some("a"))
    );
    assert_eq!(
        forecast.segments[..2]
            .iter()
            .map(|s| s.account_id.as_deref())
            .collect::<Vec<_>>(),
        [Some("b"), None]
    );
    assert!(forecast.outage_minutes > 0.0);
    assert_eq!(forecast.exhausted_at.get("a"), None);
}

#[test]
fn a_live_active_account_stays_first_even_when_another_resets_sooner() {
    let list = [
        reset_at(acc("max", 5.0, true, 100.0), base() + 14.0 * H),
        reset_at(acc("vertex", 2.0, true, 200.0), base() + 11.0 * H),
    ];
    let live = sim(&list, &|_| 60.0, Some("max"));
    assert_eq!(live.segments[0].account_id.as_deref(), Some("max"));
    assert_eq!(hhmm(live.segments[0].to), "10:40");
    assert_eq!(live.segments[1].account_id.as_deref(), Some("vertex"));
    assert_eq!(
        sim(&list, &|_| 60.0, None).segments[0]
            .account_id
            .as_deref(),
        Some("vertex")
    );
}

#[test]
fn a_single_account_is_warmed_up_so_its_refill_lands_where_demand_is() {
    let plan = plan(
        (s(), e()),
        &[start_account("pro", 1.0)],
        &|_| 50.0,
        &[s() - 2.5 * H],
    );
    assert_eq!(
        plan.starts.iter().map(|t| hhmm(*t)).collect::<Vec<_>>(),
        ["06:00"]
    );
    assert_eq!(plan.forecast.outage_minutes, 180.0);
    assert_eq!(plan.even_forecast.outage_minutes, 210.0);
    assert!(plan.forecast.outage_minutes <= plan.even_forecast.outage_minutes);
}

#[test]
fn a_manual_start_stays_and_the_plan_is_never_worse_than_even() {
    let mut list = accounts();
    list[0].manual = Some(base() + 7.0 * H);
    let plan = plan((s(), e()), &list, &rate, &even_for(3));
    assert_eq!(hhmm(plan.starts[0]), "07:00");
    assert!(not_worse(&plan.forecast, &plan.even_forecast));
}

#[test]
fn when_every_start_is_manual_the_even_spread_is_returned_as_is() {
    let even = even_for(3);
    let list: Vec<StartAccount> = accounts()
        .into_iter()
        .enumerate()
        .map(|(i, a)| StartAccount {
            manual: Some(even[i]),
            ..a
        })
        .collect();
    let plan = plan((s(), e()), &list, &rate, &even);
    assert_eq!(plan.starts, even);
    assert_eq!(plan.forecast, plan.even_forecast);
}

#[test]
fn without_demand_the_resets_spread_widest_and_nothing_warms_up_earlier_than_that_needs() {
    let all = accounts();
    let plan = |count: usize| plan((s(), e()), &all[..count], &|_| 0.0, &even_for(count));
    let clocks = |starts: &[f64]| starts.iter().map(|t| hhmm(*t)).collect::<Vec<_>>();
    // Every plan ties on unmet demand and switches. A lone account has the whole cycle: it
    // opens at the work start, with no warm-up at all.
    assert_eq!(clocks(&plan(1).starts), ["09:00"]);
    // Two resets 2½ hours apart: one opens at the work start, the other warms up only as early
    // as the spread needs (not a whole window early).
    let mut two = clocks(&plan(2).starts);
    two.sort();
    assert_eq!(two, ["06:30", "09:00"]);
    // No 15-minute combination spreads three resets as wide as the even 100 minutes apart.
    let three = plan(3);
    assert_eq!(clocks(&three.starts), ["04:50", "06:30", "08:10"]);
    assert_eq!(three.forecast.switches, 0);
    assert_eq!(three.forecast.unmet, 0.0);
    for count in [1, 2, 3] {
        for start in plan(count).starts {
            assert!(start > s() - WINDOW_MS && start <= s(), "{}", hhmm(start));
        }
    }
}

#[test]
fn the_result_is_never_worse_than_the_even_spread_on_random_days() {
    let mut random = Random(1.0);
    let capacities = [5.0, 2.0, 1.0];
    for day in 0..20 {
        let hourly: Vec<f64> = (0..9)
            .map(|_| relay_core::shared::types::js::round(random.next() * 300.0))
            .collect();
        let count = 1 + (random.next() * 3.0).floor() as usize;
        let list: Vec<StartAccount> = capacities[..count]
            .iter()
            .enumerate()
            .map(|(i, c)| start_account(&format!("a{i}"), *c))
            .collect();
        let rate = |time: f64| {
            let hour = ((time - s()) / H).floor();
            if hour >= 0.0 {
                hourly.get(hour as usize).copied().unwrap_or(0.0)
            } else {
                0.0
            }
        };
        let plan = plan((s(), e()), &list, &rate, &even_for(count));
        assert!(
            not_worse(&plan.forecast, &plan.even_forecast),
            "day {day}: {:?} vs {:?}",
            score(&plan.forecast),
            score(&plan.even_forecast)
        );
    }
}

#[test]
fn equal_input_gives_equal_starts() {
    let (list, even) = (accounts(), even_for(3));
    assert_eq!(
        plan((s(), e()), &list, &rate, &even).starts,
        plan((s(), e()), &list, &rate, &even).starts
    );
}

#[test]
fn planning_stays_bounded_with_three_four_and_six_accounts() {
    // The simulation reads the demand once per step, so demand reads bound the simulations: a
    // whole simulated day is `steps` reads.
    let steps = (e() - s()) / SIM_STEP_MS;
    let counted = |list: &[StartAccount], factor: f64| {
        let reads = Cell::new(0u64);
        let scaled = scaled(factor);
        let rate = |time: f64| {
            reads.set(reads.get() + 1);
            scaled(time)
        };
        let plan = plan((s(), e()), list, &rate, &even_for(list.len()));
        (plan, reads.get() as f64 / steps)
    };
    let began = Instant::now();

    // Every 15-minute combination, plus the even spread.
    let (_, three) = counted(&accounts(), 1.0);
    assert!(three >= 1.0, "{three}");
    assert!(three <= 20f64.powi(3) + 1.0, "{three}");

    // Every 30-minute combination, then four descent rounds from the best 8.
    let (_, four) = counted(&with_pro(1), 1.15);
    assert!(
        four <= 10f64.powi(4) + 1.0 + 8.0 * 4.0 * 4.0 * 19.0,
        "{four}"
    );

    // Descent only: from the even and the proportional spread, then fine.
    let six_list = with_pro(3);
    let (six_plan, six) = counted(&six_list, 1.15);
    assert!(six < 1_000.0, "{six}");
    // A loose canary for a per-simulation slowdown, not a speed budget; unoptimized test
    // builds on shared CI runners are several times slower than release.
    let took = began.elapsed().as_millis();
    let budget = if cfg!(debug_assertions) {
        15_000
    } else {
        2_000
    };
    assert!(took < budget, "planning took {took} ms");

    assert_eq!(six_plan.starts.len(), 6);
    for start in &six_plan.starts {
        assert_eq!(
            (start - (s() - WINDOW_MS)) % (15.0 * MIN),
            0.0,
            "{} is off the 15-minute grid",
            hhmm(*start)
        );
    }
    assert_eq!(
        plan((s(), e()), &six_list, &scaled(1.15), &even_for(6)).starts,
        six_plan.starts
    );
}

#[test]
fn stopping_a_losing_candidate_early_changes_no_plan() {
    let mut random = Random(7.0);
    struct Case {
        interval: (f64, f64),
        accounts: Vec<StartAccount>,
        rate: Box<dyn Fn(f64) -> f64>,
        even: Vec<f64>,
    }
    let random_days: Vec<Case> = (0..6)
        .map(|day| {
            let hourly: Vec<f64> = (0..9)
                .map(|_| relay_core::shared::types::js::round(random.next() * 400.0))
                .collect();
            let list: Vec<StartAccount> = with_pro(day % 3).into_iter().take(1 + day % 4).collect();
            let count = list.len();
            Case {
                interval: (s(), e()),
                accounts: list,
                rate: Box::new(move |time| {
                    let hour = ((time - s()) / H).floor();
                    if hour >= 0.0 {
                        hourly.get(hour as usize).copied().unwrap_or(0.0)
                    } else {
                        0.0
                    }
                }),
                even: even_for(count),
            }
        })
        .collect();
    let mut manual = accounts();
    manual[0].manual = Some(base() + 7.0 * H);
    let mut inputs = vec![
        Case {
            interval: (s(), e()),
            accounts: accounts(),
            rate: Box::new(rate),
            even: even_for(3),
        },
        Case {
            interval: (s(), e()),
            accounts: with_pro(1),
            rate: Box::new(scaled(1.15)),
            even: even_for(4),
        },
        Case {
            interval: (s(), e()),
            accounts: with_pro(3),
            rate: Box::new(scaled(1.15)),
            even: even_for(6),
        },
        Case {
            interval: (s(), e()),
            accounts: manual,
            rate: Box::new(rate),
            even: even_for(3),
        },
        Case {
            interval: (s(), e()),
            accounts: vec![start_account("pro", 1.0)],
            rate: Box::new(|_| 50.0),
            even: vec![s() - 2.5 * H],
        },
        // A whole day around the clock.
        Case {
            interval: (s(), s() + 24.0 * H),
            accounts: with_pro(1),
            rate: Box::new(flat(150.0)),
            even: even_for(4),
        },
    ];
    inputs.extend(random_days);
    let (stopped, whole) = (Cell::new(0u64), Cell::new(0u64));
    for (index, input) in inputs.iter().enumerate() {
        let optimize = |count: &Cell<u64>, early_stop: Option<bool>| {
            let rate = |time: f64| {
                count.set(count.get() + 1);
                (input.rate)(time)
            };
            optimize_starts(StartPlanInput {
                interval: StartInterval {
                    start: input.interval.0,
                    end: input.interval.1,
                },
                accounts: &input.accounts,
                rate: &rate,
                even: &input.even,
                early_stop,
            })
        };
        let early = optimize(&stopped, None);
        let full = optimize(&whole, Some(false));
        assert_eq!(early, full, "input {index}");
    }
    assert!(
        stopped.get() < whole.get(),
        "{} demand reads vs {}",
        stopped.get(),
        whole.get()
    );
}

#[test]
fn a_held_restart_keeps_a_refilled_window_closed_until_the_hold() {
    let list = |restart_at: Option<f64>| {
        vec![
            reset_at(acc("a", 3.0, true, 250.0), base() + 12.0 * H),
            SimAccount {
                restart_at,
                ..reset_at(acc("b", 1.0, true, 100.0), base() + 10.0 * H)
            },
        ]
    };
    let day = |accounts: &[SimAccount]| {
        run(
            base() + 9.5 * H,
            base() + 18.0 * H,
            &|_| 100.0,
            accounts,
            Some("a"),
        )
    };
    // b refills at 10:00 but its next window starts at 11:00 (the hold), so it resets at 16:00
    // and again at 21:00: it serves 15:00–17:00 on two quotas.
    let held = day(&list(Some(base() + 11.0 * H)));
    assert_eq!(
        view(&held),
        ["a 09:30-15:00", "b 15:00-17:00", "a 17:00-18:00"]
    );
    assert_eq!(held.outage_minutes, 0.0);
    assert_eq!(held.switches, 2);
    // Without the hold the window restarts at 10:00 and resets at 15:00 and 20:00.
    let free = day(&list(None));
    assert_eq!(
        view(&free),
        [
            "a 09:30-15:00",
            "b 15:00-16:00",
            "outage 16:00-17:00",
            "a 17:00-18:00",
        ]
    );
    assert_eq!(free.outage_minutes, 60.0);
}

#[test]
fn first_use_starts_a_held_window_before_the_hold() {
    let forecast = run(
        base() + 9.5 * H,
        base() + 18.0 * H,
        &|_| 100.0,
        &[
            reset_at(acc("a", 1.0, true, 100.0), base() + 20.0 * H),
            SimAccount {
                restart_at: Some(base() + 12.0 * H),
                ..reset_at(acc("b", 1.0, true, 0.0), base() + 10.0 * H)
            },
        ],
        Some("a"),
    );
    // b refills at 10:00 and is held until 12:00, but a runs dry at 10:30 and b starts then:
    // its window resets at 15:30, not at the hold's 17:00.
    assert_eq!(
        view(&forecast),
        [
            "a 09:30-10:30",
            "b 10:30-11:30",
            "outage 11:30-15:30",
            "b 15:30-16:30",
            "outage 16:30-18:00",
        ]
    );
}

#[test]
fn the_next_account_is_chosen_when_demand_resumes_not_while_it_is_quiet() {
    // 60 an hour from 11:00 until 12:20, then nothing until the end at 13:00.
    let quiet = |time: f64| {
        if time < base() + 12.0 * H + 20.0 * MIN {
            60.0
        } else {
            0.0
        }
    };
    let forecast = run(
        base() + 11.0 * H,
        base() + 13.0 * H,
        &quiet,
        &[
            reset_at(acc("a", 1.0, true, 70.0), base() + 16.0 * H),
            reset_at(acc("b", 1.0, true, 0.0), base() + 12.0 * H + 40.0 * MIN),
        ],
        None,
    );
    // a runs dry at 12:10 and b refills at 12:40, but nobody asks for it.
    assert_eq!(view(&forecast), ["a 11:00-12:10", "outage 12:10-12:20"]);
    assert_eq!(forecast.switches, 0);
    assert!(
        forecast
            .segments
            .iter()
            .all(|s| s.account_id.as_deref() != Some("b"))
    );
}

#[test]
fn without_auto_start_the_account_that_starts_when_demand_resumes_is_the_larger_of_the_closed_ones()
{
    // 100 an hour until 17:00 with a pause from 12:20 to 13:00.
    let paused = |time: f64| {
        if time >= base() + 12.0 * H + 20.0 * MIN && time < base() + 13.0 * H {
            0.0
        } else if time < base() + 17.0 * H {
            100.0
        } else {
            0.0
        }
    };
    let forecast = run(
        base() + 12.0 * H,
        base() + 17.0 * H,
        &paused,
        &[
            reset_at(acc("max", 5.0, false, 20.0), base() + 12.0 * H + 45.0 * MIN),
            reset_at(acc("pro", 1.0, false, 0.0), base() + 12.0 * H + 30.0 * MIN),
        ],
        Some("max"),
    );
    // max runs dry at 12:12; both have refilled and closed by 13:00, so the larger one takes
    // the demand when it resumes.
    assert_eq!(
        forecast
            .segments
            .iter()
            .find(|s| s.from >= base() + 13.0 * H)
            .expect("a segment after 13:00")
            .account_id
            .as_deref(),
        Some("max")
    );
    assert_eq!(forecast.switches, 0);
}

#[test]
fn five_pro_accounts_on_a_flat_day_leave_no_gap_and_spread_their_resets() {
    let pros: Vec<StartAccount> = (0..5)
        .map(|i| start_account(&format!("pro{i}"), 1.0))
        .collect();
    let plan = plan((s(), e()), &pros, &flat(20.0), &even_for(5));
    assert_eq!(plan.forecast.unmet, 0.0);
    let mut phases: Vec<f64> = plan
        .starts
        .iter()
        .map(|start| (((start - s()) % WINDOW_MS) + WINDOW_MS) % WINDOW_MS)
        .collect();
    phases.sort_by(f64::total_cmp);
    let gaps: Vec<f64> = (0..phases.len())
        .map(|i| {
            if i > 0 {
                phases[i] - phases[i - 1]
            } else {
                phases[0] + WINDOW_MS - phases[phases.len() - 1]
            }
        })
        .collect();
    assert!(
        gaps.iter().copied().fold(f64::INFINITY, f64::min) >= 45.0 * MIN,
        "{:?}",
        gaps.iter().map(|g| g / MIN).collect::<Vec<_>>()
    );
}

#[test]
fn an_account_out_for_its_week_serves_once_the_week_resets() {
    let forecast = sim(
        &[SimAccount {
            blocked: Some(true),
            blocked_until: Some(s() + 2.0 * H),
            ..acc("weekly", 5.0, true, 500.0)
        }],
        &flat(50.0),
        None,
    );
    assert_eq!(
        view(&forecast),
        ["outage 09:00-11:00", "weekly 11:00-18:00"]
    );
    assert_eq!(forecast.unmet, 100.0);
}

#[test]
fn the_account_whose_week_ends_first_takes_over_before_a_sooner_5_hour_reset() {
    let list = |late: f64| {
        vec![
            SimAccount {
                week_ends: Some(s() + 5.0 * 24.0 * H),
                ..reset_at(acc("soon-reset", 1.0, true, 100.0), s() + H)
            },
            SimAccount {
                week_ends: Some(s() + late),
                ..reset_at(acc("week-ends", 1.0, true, 100.0), s() + 4.0 * H)
            },
        ]
    };
    // A week ending a day sooner goes first; weeks within six hours tie and the 5-hour reset
    // decides.
    assert_eq!(
        sim(&list(24.0 * H), &flat(10.0), None).segments[0]
            .account_id
            .as_deref(),
        Some("week-ends")
    );
    assert_eq!(
        sim(&list(5.0 * 24.0 * H - 2.0 * H), &flat(10.0), None).segments[0]
            .account_id
            .as_deref(),
        Some("soon-reset")
    );
}

#[test]
fn the_next_account_does_not_depend_on_the_order_of_the_list() {
    let accounts = [
        SimAccount {
            week_ends: Some(s() + 24.0 * H),
            ..reset_at(acc("A", 1.0, true, 100.0), s() + 4.0 * H)
        },
        reset_at(acc("B", 1.0, true, 100.0), s() + 2.0 * H),
        SimAccount {
            week_ends: Some(s() + 6.0 * 24.0 * H),
            ..reset_at(acc("C", 1.0, true, 100.0), s() + H)
        },
    ];
    let orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    // An unknown week counts as a whole week away: A's week ends first, then C's, then B's,
    // whatever the order.
    for order in orders {
        let list: Vec<SimAccount> = order.iter().map(|i| accounts[*i].clone()).collect();
        let forecast = sim(&list, &flat(10.0), None);
        assert_eq!(
            forecast.segments[0].account_id.as_deref(),
            Some("A"),
            "{order:?}"
        );
    }
}
