//! Port of `tests/adaptive-replan.test.ts`. The TS counts simulations through a tempo whose
//! numbers count their reads; here `simulations_on_this_thread` counts them.

#[path = "common/planning.rs"]
mod helpers;

use helpers::{
    MINUTE, ZONE, flat_tempo, fresh_at, hours, planning_account, schedule, team_account, wall,
};
use relay_core::shared::adaptive_plan::{
    Replan, ReplanInput, next_start_candidates, replan_starts,
};
use relay_core::shared::capacity_plan::{SimAccount, simulations_on_this_thread};
use relay_core::shared::day_plan::{DayPlan, PlanContext, day_plan, plan_context};
use relay_core::shared::live_forecast::{LiveInput, live_forecast, live_setup};
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{
    Account, AccountUsage, PlanningSettings, default_planning_settings,
};

const WEDNESDAY: &str = "2026-10-14";

fn at(clock: &str) -> f64 {
    wall(WEDNESDAY, clock, ZONE)
}
fn settings(accounts: &[Account]) -> PlanningSettings {
    PlanningSettings {
        auto_start: true,
        time_zone: ZONE.into(),
        weekday: hours(true, "09:00", "18:00"),
        weekend: hours(false, "11:00", "18:00"),
        accounts: helpers::planned_accounts(accounts),
        ..default_planning_settings()
    }
}
/// Usage read at `now`; the five-hour window is open until `resets` when given.
fn fresh(id: &str, now: f64, used: f64, resets: Option<&str>, weekly: f64) -> AccountUsage {
    fresh_at(id, now, used, resets.map(at), weekly)
}

/// Today's plan for `accounts` at a flat `rate`, replanned at `now` at that same rate.
struct Fixture {
    plan: DayPlan,
    settings: PlanningSettings,
    context: PlanContext,
    usage: JsMap<AccountUsage>,
    now: f64,
    active: Option<String>,
    blocked: Vec<String>,
}

impl Fixture {
    fn new(accounts: &[Account], rate: f64, now: f64, usage: JsMap<AccountUsage>) -> Self {
        let settings = settings(accounts);
        let context = plan_context(accounts, flat_tempo(rate));
        Fixture {
            plan: day_plan(WEDNESDAY, &settings, &context, None),
            settings,
            context,
            usage,
            now,
            active: None,
            blocked: Vec::new(),
        }
    }
    fn live(&self) -> LiveInput<'_> {
        LiveInput {
            plan: &self.plan,
            settings: &self.settings,
            context: &self.context,
            usage: &self.usage,
            active_id: self.active.as_deref(),
            now: self.now,
            factor: Some(1.0),
            schedule: None,
            exact: false,
        }
    }
    fn input(&self) -> ReplanInput<'_> {
        ReplanInput {
            live: self.live(),
            blocked: &self.blocked,
        }
    }
    fn replan(&self) -> Option<Replan> {
        replan_starts(&self.input())
    }
}

fn trio() -> Vec<Account> {
    vec![
        planning_account("max", "max5"),
        team_account("vertex", 2.0),
        planning_account("pro", "pro"),
    ]
}
/// The Mac wakes at 08:50: every window closed, usage just refreshed.
fn wake_up(accounts: &[Account], rate: f64) -> Fixture {
    let now = at("08:50");
    let usage = accounts
        .iter()
        .map(|a| (a.id.clone(), fresh(&a.id, now, 0.0, None, 20.0)))
        .collect();
    Fixture::new(accounts, rate, now, usage)
}

/// At 09:30 `a` serves on its last 250 Pro units while `b`'s idle window resets at 10:00.
fn hold_input() -> Fixture {
    let a = team_account("a", 3.0);
    let b = planning_account("b", "pro");
    let now = at("09:30");
    let mut fixture = Fixture::new(
        &[a, b],
        100.0,
        now,
        helpers::usage_map(vec![
            // 250 of a's 300 Pro units are left: they last until 12:00 at 100 an hour.
            ("a", fresh("a", now, 100.0 / 6.0, Some("12:00"), 20.0)),
            ("b", fresh("b", now, 0.0, Some("10:00"), 20.0)),
        ]),
    );
    fixture.active = Some("a".into());
    fixture
}

#[test]
fn holding_a_restart_until_the_busy_account_runs_out_removes_the_outage() {
    let input = hold_input();
    let replan = input.replan().expect("a replan");
    // Restarted at 10:00, b's window is idle while a serves and resets at 15:00, so its single
    // hour runs out at 16:00 with a back only at 17:00. Held to 11:00 it resets at 16:00, just
    // as its first hour runs out.
    assert_eq!(replan.schedule, schedule(&[("b", at("11:00"))]));
    assert_eq!(replan.forecast.outage_minutes, 0.0);
    assert_eq!(replan.default_forecast.outage_minutes, 60.0);
    // The live forecast with the schedule is the one the search scored.
    assert_eq!(
        live_forecast(LiveInput {
            schedule: Some(&replan.schedule),
            ..input.live()
        }),
        Some(replan.forecast.clone())
    );
    assert_eq!(live_forecast(input.live()), Some(replan.default_forecast));
}

#[test]
fn after_a_sleep_with_every_window_closed_staggered_starts_save_a_switch() {
    let input = wake_up(&trio(), 120.0);
    let replan = input.replan().expect("a replan");
    assert_eq!(replan.default_forecast.switches, 2);
    assert_eq!(replan.forecast.switches, 1);
    assert!(replan.forecast.unmet <= replan.default_forecast.unmet);
    assert_eq!(
        live_forecast(LiveInput {
            schedule: Some(&replan.schedule),
            ..input.live()
        }),
        Some(replan.forecast.clone())
    );
    assert_eq!(
        live_forecast(input.live()),
        Some(replan.default_forecast.clone())
    );
    let setup = live_setup(input.live()).expect("a setup");
    assert!(!replan.schedule.is_empty());
    for (id, time) in &replan.schedule {
        let account = setup
            .accounts
            .iter()
            .find(|a| a.id == *id)
            .expect("planned");
        let candidates = next_start_candidates(account, setup.from, setup.to);
        assert!(candidates[1..].contains(time), "{id} at {time}");
    }
}

#[test]
fn a_schedule_carried_in_the_input_does_not_change_the_search() {
    for input in [hold_input(), wake_up(&trio(), 120.0)] {
        let replan = input.replan().expect("a replan");
        let deferred: JsMap<f64> = input
            .plan
            .accounts
            .iter()
            .map(|a| (a.account_id.clone(), at("12:30")))
            .collect();
        // The schedule adopted last time, and one deferring every account to 12:30.
        for schedule in [&replan.schedule, &deferred] {
            assert_eq!(
                replan_starts(&ReplanInput {
                    live: LiveInput {
                        schedule: Some(schedule),
                        ..input.live()
                    },
                    blocked: &input.blocked,
                }),
                Some(replan.clone())
            );
        }
    }
}

#[test]
fn a_calm_day_keeps_the_default_starts() {
    let replan = wake_up(&trio(), 40.0).replan().expect("a replan");
    assert!(replan.schedule.is_empty());
    assert_eq!(replan.forecast, replan.default_forecast);
}

#[test]
fn accounts_the_keeper_cannot_start_keep_their_default_start() {
    let mut input = wake_up(&trio(), 120.0);
    let moved: Vec<String> = input
        .replan()
        .expect("a replan")
        .schedule
        .keys()
        .cloned()
        .collect();
    assert!(!moved.is_empty());
    for id in &moved {
        input.blocked = vec![id.clone()];
        assert!(
            !input.replan().expect("a replan").schedule.contains_key(id),
            "{id}"
        );
    }
    input.blocked = Vec::new();
    // A weekly limit used up keeps an account out of the search as well.
    for id in &moved {
        let mut spent = wake_up(&trio(), 120.0);
        spent
            .usage
            .insert(id.clone(), fresh(id, spent.now, 0.0, None, 100.0));
        assert!(
            !spent.replan().expect("a replan").schedule.contains_key(id),
            "{id}"
        );
    }
    input.blocked = trio().iter().map(|a| a.id.clone()).collect();
    let none = input.replan().expect("a replan");
    assert!(none.schedule.is_empty());
    assert_eq!(none.forecast, none.default_forecast);
}

#[test]
fn outside_work_there_is_nothing_to_replan() {
    let mut input = wake_up(&trio(), 120.0);
    input.now = at("18:00");
    assert_eq!(input.replan(), None);
}

#[test]
fn the_next_start_candidates_are_the_default_then_later_half_hours_after_now_and_before_the_work_end()
 {
    let account = SimAccount {
        id: "a".into(),
        capacity: 1.0,
        keep_alive: true,
        remaining: 100.0,
        ..SimAccount::default()
    };
    let half_hours = |from: &str, count: usize| -> Vec<f64> {
        (0..count)
            .map(|k| at(from) + k as f64 * 30.0 * MINUTE)
            .collect()
    };
    let end = at("18:00");
    let with =
        |first_reset: Option<f64>, restart_at: Option<f64>, warm_up: Option<f64>| SimAccount {
            first_reset,
            restart_at,
            warm_up,
            ..account.clone()
        };
    // An open window restarts at its reset, or a half hour or more later.
    assert_eq!(
        next_start_candidates(&with(Some(at("10:00")), None, None), at("09:30"), end),
        half_hours("10:00", 11)
    );
    // A closed window starts now, or at the next half hours.
    let mut expected = vec![at("08:50")];
    expected.extend(half_hours("09:00", 10));
    assert_eq!(
        next_start_candidates(&with(None, None, Some(at("08:50"))), at("08:50"), end),
        expected
    );
    assert_eq!(
        next_start_candidates(&account, at("09:00"), end),
        half_hours("09:00", 11)
    );
    // A warm-up counted at its planned 08:59 a tick later: no later start lies in the past.
    let mut expected = vec![at("08:59")];
    expected.extend(half_hours("09:30", 9));
    assert_eq!(
        next_start_candidates(
            &with(None, None, Some(at("08:59"))),
            at("09:00") + 30_000.0,
            end
        ),
        expected
    );
    // A window that resets before its active range waits for it to begin.
    assert_eq!(
        next_start_candidates(
            &with(Some(at("07:15")), Some(at("07:30")), None),
            at("06:00"),
            end
        ),
        half_hours("07:30", 11)
    );
    // Nothing at or after the work end.
    assert_eq!(
        next_start_candidates(&with(Some(at("16:00")), None, None), at("15:00"), end),
        half_hours("16:00", 4)
    );
    assert!(
        next_start_candidates(&with(Some(at("18:00")), None, None), at("15:00"), end).is_empty()
    );
}

#[test]
fn an_account_with_no_start_left_before_the_work_end_does_not_stop_the_others_search() {
    let a = team_account("a", 2.0);
    let x = planning_account("x", "pro");
    let z = team_account("z", 3.0);
    let now = at("14:00");
    let mut input = Fixture::new(
        &[a, x, z],
        100.0,
        now,
        helpers::usage_map(vec![
            // a's 100 Pro units last until 15:00; it resets only after work.
            ("a", fresh("a", now, 50.0, Some("18:10"), 20.0)),
            ("x", fresh("x", now, 100.0, Some("14:10"), 20.0)),
            ("z", fresh("z", now, 100.0, Some("14:20"), 20.0)),
        ]),
    );
    input.active = Some("a".into());
    let replan = input.replan().expect("a replan");
    // Restarted at 14:10, x resets before z and goes next at 15:00, running out at 16:00 for z
    // to finish the day. Held to 14:40 it resets after z, so z serves 15:00–18:00 alone.
    assert_eq!(replan.schedule, schedule(&[("x", at("14:40"))]));
    assert_eq!(replan.forecast.switches, 1);
    assert_eq!(replan.default_forecast.switches, 2);
}

/// Simulations one replan of `accounts` waking at 08:50 runs, and its result.
fn count_simulations(accounts: &[Account], rate: f64) -> (u64, Option<Replan>, Fixture) {
    let input = wake_up(accounts, rate);
    let before = simulations_on_this_thread();
    let replan = input.replan();
    (simulations_on_this_thread() - before, replan, input)
}

#[test]
fn up_to_four_accounts_try_every_combination_of_their_candidates() {
    // The default, then every combination of the candidates.
    let combinations = |input: &Fixture| {
        let setup = live_setup(input.live()).expect("a setup");
        1 + setup
            .accounts
            .iter()
            .map(|a| next_start_candidates(a, setup.from, setup.to).len() as u64)
            .product::<u64>()
    };
    let (three, replan, input) = count_simulations(&trio(), 120.0);
    assert!(three <= 11u64.pow(3) + 1);
    assert_eq!(three, combinations(&input));
    // Counting the simulations does not change the search.
    assert_eq!(replan, input.replan());
    let mut four_accounts = trio();
    four_accounts.push(planning_account("pro2", "pro"));
    let (four, _, input) = count_simulations(&four_accounts, 120.0);
    assert!(four <= 11u64.pow(4) + 1);
    assert_eq!(four, combinations(&input));
}

#[test]
fn five_or_more_accounts_descend_one_account_at_a_time_bounded_and_deterministic() {
    let six: Vec<Account> = ["a", "b", "c", "d", "e", "f"]
        .iter()
        .map(|id| planning_account(id, "pro"))
        .collect();
    let (first, first_replan, input) = count_simulations(&six, 100.0);
    let first_replan = first_replan.expect("a replan");
    // The default, then up to four rounds of each account's ten other starts.
    assert!(first > 1);
    assert!(first <= 1 + 4 * 6 * 10, "{first}");
    assert!(first_replan.forecast.switches < first_replan.default_forecast.switches);
    assert!(first_replan.forecast.unmet <= first_replan.default_forecast.unmet);
    let (second, second_replan, _) = count_simulations(&six, 100.0);
    assert_eq!(second, first);
    assert_eq!(second_replan.as_ref(), Some(&first_replan));
    assert_eq!(Some(first_replan), input.replan());
}
