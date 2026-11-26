//! Port of `tests/live-forecast.test.ts`.

#[path = "common/planning.rs"]
mod helpers;

use helpers::{
    MINUTE, ZONE, busy_tempo, clock_in, flat_tempo, fresh_at, hours, planning_account, schedule,
    team_account, usage_map, wall,
};
use relay_core::shared::capacity_plan::{Forecast, SimAccount};
use relay_core::shared::day_plan::{DayPlan, PlanContext, day_plan, plan_context};
use relay_core::shared::live_forecast::{LiveInput, live_forecast, live_setup};
use relay_core::shared::tempo::{Tempo, TempoDays, TempoSource, preset_tempo};
use relay_core::shared::types::js::{JsMap, iso};
use relay_core::shared::types::{
    Account, AccountUsage, PlanningSettings, TempoChoice, default_planning_settings,
};

const WEDNESDAY: &str = "2026-10-14";

fn at(clock: &str) -> f64 {
    wall(WEDNESDAY, clock, ZONE)
}
/// Segments as "account from-to"; "-" is an outage.
fn lane(forecast: &Forecast) -> Vec<String> {
    helpers::lane(forecast, ZONE, "-")
}
fn preset(choice: TempoChoice) -> Tempo {
    preset_tempo(choice, TempoSource::Preset, TempoDays::default())
}
/// `{ ...presetTempo("medium"), weekday/weekend/rate: rate }`.
fn flat(rate: f64) -> Tempo {
    Tempo {
        source: TempoSource::Preset,
        days: TempoDays::default(),
        ..flat_tempo(rate)
    }
}
fn trio() -> Vec<Account> {
    vec![
        planning_account("max", "max5"),
        team_account("vertex", 2.0),
        planning_account("pro", "pro"),
    ]
}
fn settings() -> PlanningSettings {
    PlanningSettings {
        auto_start: true,
        time_zone: ZONE.into(),
        weekday: hours(true, "09:00", "18:00"),
        weekend: hours(false, "11:00", "18:00"),
        accounts: helpers::planned(&["max", "vertex", "pro"]),
        ..default_planning_settings()
    }
}
fn context(tempo: Tempo) -> PlanContext {
    plan_context(&trio(), tempo)
}
fn medium() -> PlanContext {
    context(preset(TempoChoice::Medium))
}
// Windows: max 06:15–11:15–16:15, vertex 08:15–13:15, pro 06:30–11:30–16:30.
fn plan() -> DayPlan {
    day_plan(WEDNESDAY, &settings(), &context(busy_tempo()), None)
}

/// Usage read at `now`; the five-hour window is open until `resets`.
fn fresh(id: &str, now: f64, used: f64, resets: Option<&str>, weekly: f64) -> AccountUsage {
    fresh_at(id, now, used, resets.map(at), weekly)
}

fn input<'a>(
    plan: &'a DayPlan,
    settings: &'a PlanningSettings,
    context: &'a PlanContext,
    usage: &'a JsMap<AccountUsage>,
    active_id: Option<&'a str>,
    now: f64,
) -> LiveInput<'a> {
    LiveInput {
        plan,
        settings,
        context,
        usage,
        active_id,
        now,
        factor: None,
        schedule: None,
        exact: false,
    }
}

#[test]
fn the_scenario_plan_s_windows_are_the_ones_the_live_forecast_falls_back_on() {
    let plan = plan();
    let windows = |id: &str| {
        plan.accounts
            .iter()
            .find(|a| a.account_id == id)
            .expect("planned")
            .windows
            .iter()
            .map(|w| clock_in(w.start, ZONE))
            .collect::<Vec<_>>()
    };
    assert_eq!(windows("max"), ["06:15", "11:15", "16:15"]);
    assert_eq!(windows("vertex"), ["08:15", "13:15"]);
    assert_eq!(windows("pro"), ["06:30", "11:30", "16:30"]);
}

#[test]
fn live_usage_goes_on_from_now_with_the_active_account_stale_accounts_follow_the_plan_s_chain() {
    let (plan, settings) = (plan(), settings());
    let now = at("10:00");
    let mut stale = fresh("pro", now, 100.0, Some("13:00"), 20.0);
    // Stale data is ignored, even when it says the window is used up.
    stale.stale = true;
    let usage = usage_map(vec![
        ("max", fresh("max", now, 80.0, Some("11:15"), 20.0)),
        ("vertex", fresh("vertex", now, 0.0, Some("12:00"), 20.0)),
        ("pro", stale),
    ]);
    let medium = medium();
    let forecast = live_forecast(input(&plan, &settings, &medium, &usage, Some("max"), now))
        .expect("a forecast");
    assert_eq!(forecast.segments[0].account_id.as_deref(), Some("max"));
    assert_eq!(forecast.segments[0].from, now);
    assert_eq!(forecast.segments[0].to, at("18:00"));
    assert_eq!(forecast.unmet, 0.0);
    // Stale data is replaced by the plan's chain: pro's planned window (06:30–11:30) with a
    // full quota, and no known week.
    let heavy_context = context(preset(TempoChoice::Heavy));
    let heavy_input = input(&plan, &settings, &heavy_context, &usage, Some("max"), now);
    let setup = live_setup(heavy_input).expect("a setup");
    assert_eq!(
        setup.accounts.iter().find(|a| a.id == "pro"),
        Some(&SimAccount {
            id: "pro".into(),
            capacity: 1.0,
            keep_alive: true,
            remaining: 100.0,
            first_reset: Some(at("11:30")),
            ..SimAccount::default()
        })
    );
    // An unknown week counts as a whole week away (as in the gateway), so pro comes after
    // vertex, whose week ends in three days. At 120 Pro units/h max's 100 units last until
    // 10:50; vertex serves until its 12:00 reset and on a fresh window until 13:40; max is
    // fresh again since 11:15.
    let heavy = live_forecast(heavy_input).expect("a forecast");
    assert_eq!(
        lane(&heavy),
        ["max 10:00-10:50", "vertex 10:50-13:40", "max 13:40-18:00"]
    );
    assert_eq!(heavy.switches, 2);
    assert_eq!(heavy.unmet, 0.0);
}

#[test]
fn an_active_account_outside_the_plan_or_none_starts_with_the_soonest_reset() {
    let (plan, settings, ctx) = (plan(), settings(), medium());
    let now = at("10:00");
    // Pro has no usage at all: its week is unknown and counts as a whole week away, after
    // max's and vertex's (three days); of those vertex resets first.
    let usage = usage_map(vec![
        ("max", fresh("max", now, 80.0, Some("13:00"), 20.0)),
        ("vertex", fresh("vertex", now, 0.0, Some("12:00"), 20.0)),
    ]);
    let base = input(&plan, &settings, &ctx, &usage, None, now);
    let outside = live_forecast(LiveInput {
        active_id: Some("not-planned"),
        ..base
    })
    .expect("a forecast");
    assert_eq!(lane(&outside), ["vertex 10:00-16:00", "max 16:00-18:00"]);
    assert_eq!(live_forecast(base), Some(outside));
    assert_eq!(
        live_forecast(LiveInput {
            active_id: Some("max"),
            ..base
        })
        .expect("a forecast")
        .segments[0]
            .account_id
            .as_deref(),
        Some("max")
    );
}

#[test]
fn an_account_whose_weekly_limit_is_used_up_never_serves() {
    let (plan, settings) = (plan(), settings());
    let ctx = context(flat(300.0));
    let now = at("10:00");
    let usage = usage_map(vec![
        ("max", fresh("max", now, 80.0, Some("11:15"), 20.0)),
        ("vertex", fresh("vertex", now, 0.0, Some("12:00"), 20.0)),
    ]);
    // 300 Pro units/h runs through every open window before 11:15.
    let open = live_forecast(input(&plan, &settings, &ctx, &usage, Some("vertex"), now))
        .expect("a forecast");
    assert_eq!(open.segments[0].account_id.as_deref(), Some("vertex"));
    let mut spent = usage.clone();
    spent.insert("vertex", fresh("vertex", now, 0.0, Some("12:00"), 100.0));
    let blocked = live_forecast(input(&plan, &settings, &ctx, &spent, Some("vertex"), now))
        .expect("a forecast");
    assert!(
        blocked
            .segments
            .iter()
            .all(|s| s.account_id.as_deref() != Some("vertex"))
    );
    assert_eq!(blocked.segments[0].account_id.as_deref(), Some("max"));
    assert!(blocked.unmet > open.unmet);
}

#[test]
fn after_work_there_is_nothing_to_forecast_before_work_it_starts_at_the_work_start() {
    let (plan, settings, ctx) = (plan(), settings(), medium());
    let usage = JsMap::new();
    for clock in ["18:00", "20:00"] {
        assert_eq!(
            live_forecast(input(&plan, &settings, &ctx, &usage, None, at(clock))),
            None
        );
    }
    // A day off and a plan without accounts have nothing to forecast either.
    let saturday = day_plan("2026-10-17", &settings, &ctx, None);
    assert_eq!(saturday.interval, None);
    assert_eq!(
        live_forecast(input(&saturday, &settings, &ctx, &usage, None, at("10:00"))),
        None
    );
    let empty = day_plan(
        WEDNESDAY,
        &PlanningSettings {
            accounts: Vec::new(),
            ..settings.clone()
        },
        &ctx,
        None,
    );
    assert_eq!(
        live_forecast(input(&empty, &settings, &ctx, &usage, None, at("10:00"))),
        None
    );
    let early = live_forecast(input(&plan, &settings, &ctx, &usage, None, at("08:00")))
        .expect("a forecast");
    assert_eq!(early.segments[0].from, at("09:00"));
    assert_eq!(early.segments.last().expect("segments").to, at("18:00"));
    // With the plan's own tempo and windows kept as planned it is the plan's forecast, at any
    // time before work (off the five-minute grid too); the account in use before work does not
    // count.
    let busy = context(busy_tempo());
    for clock in ["04:00", "06:20", "08:00", "08:47", "08:59"] {
        let morning = input(&plan, &settings, &busy, &usage, None, at(clock));
        // Simulated from now, on the work start's five-minute grid.
        let from = live_setup(morning).expect("a setup").from;
        assert!(
            from <= at(clock) && at(clock) - from < 5.0 * MINUTE,
            "{clock}"
        );
        assert_eq!((at("09:00") - from) % (5.0 * MINUTE), 0.0, "{clock}");
        assert_eq!(
            live_forecast(morning).as_ref(),
            plan.forecast.as_deref(),
            "{clock}"
        );
        assert_eq!(
            live_forecast(LiveInput {
                active_id: Some("vertex"),
                ..morning
            })
            .as_ref(),
            plan.forecast.as_deref(),
            "{clock}"
        );
    }
}

#[test]
fn without_auto_start_a_closed_window_opens_at_first_use_not_at_its_planned_warm_up() {
    let (plan, ctx) = (plan(), medium());
    let now = at("10:00");
    let usage = usage_map(vec![
        // 100 Pro units until 12:00; the window resets at 17:30.
        ("max", fresh("max", now, 80.0, Some("17:30"), 20.0)),
        ("vertex", fresh("vertex", now, 0.0, Some("12:00"), 100.0)),
        // No window open; the plan warms pro up at 11:30.
        ("pro", fresh("pro", now, 0.0, None, 20.0)),
    ]);
    // Pro's window starts when it takes over at 12:00, so it resets at 17:00.
    let manual = PlanningSettings {
        auto_start: false,
        ..settings()
    };
    let first_use =
        live_forecast(input(&plan, &manual, &ctx, &usage, Some("max"), now)).expect("a forecast");
    assert_eq!(
        lane(&first_use),
        [
            "max 10:00-12:00",
            "pro 12:00-14:00",
            "- 14:00-17:00",
            "pro 17:00-18:00",
        ]
    );
    assert_eq!(first_use.outage_minutes, 180.0);
    // With auto start the keeper starts it right away (its planned window is due), so it
    // resets at 15:00 and again at 20:00; max is back at 17:30.
    let auto = settings();
    let warmed =
        live_forecast(input(&plan, &auto, &ctx, &usage, Some("max"), now)).expect("a forecast");
    assert_eq!(
        lane(&warmed),
        [
            "max 10:00-12:00",
            "pro 12:00-14:00",
            "- 14:00-15:00",
            "pro 15:00-17:00",
            "- 17:00-17:30",
            "max 17:30-18:00",
        ]
    );
    assert_eq!(warmed.outage_minutes, 90.0);
}

#[test]
fn with_auto_start_a_closed_window_warms_now_as_the_keeper_starts_a_due_window() {
    let (plan, settings, ctx) = (plan(), settings(), medium());
    let now = at("10:00");
    let base = vec![
        ("max", fresh("max", now, 80.0, Some("17:30"), 20.0)),
        ("vertex", fresh("vertex", now, 0.0, Some("12:00"), 100.0)),
    ];
    let mut opened = base.clone();
    opened.push(("pro", fresh("pro", now, 0.0, Some("15:00"), 20.0)));
    let opened = usage_map(opened);
    let mut closed = base;
    closed.push(("pro", fresh("pro", now, 0.0, None, 20.0)));
    let closed = usage_map(closed);
    // No window open forecasts like a window opened right now.
    assert_eq!(
        live_forecast(input(&plan, &settings, &ctx, &closed, Some("max"), now)),
        live_forecast(input(&plan, &settings, &ctx, &opened, Some("max"), now))
    );
}

#[test]
fn before_work_a_window_resets_or_a_missed_warm_up_starts_when_the_keeper_would() {
    let (plan, settings) = (plan(), settings());
    let ctx = context(preset(TempoChoice::Heavy));
    let now = at("08:00");
    let blocked = |id: &str| fresh(id, now, 0.0, None, 100.0);
    // 90% used, but the window resets at 08:30 and restarts then: a full Max 5× window from
    // 09:00 (500 Pro units at 120/h) lasts until 13:10 and comes back at 13:30.
    let usage = usage_map(vec![
        ("max", fresh("max", now, 90.0, Some("08:30"), 20.0)),
        ("vertex", blocked("vertex")),
        ("pro", blocked("pro")),
    ]);
    let reset =
        live_forecast(input(&plan, &settings, &ctx, &usage, None, now)).expect("a forecast");
    assert_eq!(
        lane(&reset),
        [
            "max 09:00-13:10",
            "- 13:10-13:30",
            "max 13:30-17:40",
            "- 17:40-18:00",
        ]
    );
    // Closed at 08:00 (the Mac slept through its 06:15 warm-up), it starts now and refills at
    // 13:00 while still in use.
    let usage = usage_map(vec![
        ("max", fresh("max", now, 0.0, None, 20.0)),
        ("vertex", blocked("vertex")),
        ("pro", blocked("pro")),
    ]);
    let missed =
        live_forecast(input(&plan, &settings, &ctx, &usage, None, now)).expect("a forecast");
    assert_eq!(lane(&missed), ["max 09:00-17:10", "- 17:10-18:00"]);
}

#[test]
fn a_pace_factor_scales_the_demand_one_or_none_leaves_the_forecast_alone() {
    let (plan, settings) = (plan(), settings());
    let ctx = context(preset(TempoChoice::Heavy));
    let now = at("10:00");
    let mut stale = fresh("pro", now, 100.0, Some("13:00"), 20.0);
    stale.stale = true;
    let usage = usage_map(vec![
        ("max", fresh("max", now, 80.0, Some("11:15"), 20.0)),
        ("vertex", fresh("vertex", now, 0.0, Some("12:00"), 20.0)),
        ("pro", stale),
    ]);
    let base = input(&plan, &settings, &ctx, &usage, Some("max"), now);
    // Max's 100 units last until 10:50 at 120 an hour; twice as fast, 25 minutes.
    let steady = live_forecast(base).expect("a forecast");
    assert_eq!(lane(&steady)[0], "max 10:00-10:50");
    assert_eq!(
        live_forecast(LiveInput {
            factor: Some(1.0),
            ..base
        }),
        Some(steady.clone())
    );
    let faster = live_forecast(LiveInput {
        factor: Some(2.0),
        ..base
    })
    .expect("a forecast");
    assert_eq!(lane(&faster)[0], "max 10:00-10:25");
    assert!(
        faster.exhausted_at.get("max").expect("max")[0]
            < steady.exhausted_at.get("max").expect("max")[0]
    );
}

fn duo(rate: f64) -> (DayPlan, PlanContext) {
    let ctx = context(flat(rate));
    let plan = day_plan(
        WEDNESDAY,
        &PlanningSettings {
            accounts: helpers::planned(&["max", "pro"]),
            ..settings()
        },
        &ctx,
        None,
    );
    (plan, ctx)
}

#[test]
fn a_schedule_restarts_an_open_window_later_and_starts_a_closed_one_at_its_time() {
    let (duo, ctx) = duo(100.0);
    let settings = settings();
    let now = at("10:00");
    // Pro's open window resets at 10:30; max (500 units) serves until 15:00.
    let open = usage_map(vec![
        ("max", fresh("max", now, 0.0, Some("20:00"), 20.0)),
        ("pro", fresh("pro", now, 0.0, Some("10:30"), 20.0)),
    ]);
    let base = input(&duo, &settings, &ctx, &open, Some("max"), now);
    // Restarting at once, pro resets at 15:30 and serves on until 16:30.
    assert_eq!(
        lane(&live_forecast(base).expect("a forecast")),
        ["max 10:00-15:00", "pro 15:00-16:30", "- 16:30-18:00"]
    );
    // Held to 11:30, its window resets at 16:30: an hour of quota, a wait, an hour more.
    let hold = schedule(&[("pro", at("11:30"))]);
    let held = live_forecast(LiveInput {
        schedule: Some(&hold),
        ..base
    })
    .expect("a forecast");
    assert_eq!(
        lane(&held),
        [
            "max 10:00-15:00",
            "pro 15:00-16:00",
            "- 16:00-16:30",
            "pro 16:30-17:30",
            "- 17:30-18:00",
        ]
    );
    // A restart scheduled at the reset itself holds nothing.
    let at_reset = schedule(&[("pro", at("10:30"))]);
    assert_eq!(
        live_forecast(LiveInput {
            schedule: Some(&at_reset),
            ..base
        }),
        live_forecast(base)
    );

    // The plan's window chain (pro's planned window opens with work at 09:00 and resets at
    // 14:00) is held the same way for an account with stale usage.
    let mut stale_pro = open.get("pro").expect("pro").clone();
    stale_pro.stale = true;
    let stale = usage_map(vec![
        ("max", open.get("max").expect("max").clone()),
        ("pro", stale_pro),
    ]);
    let later = schedule(&[("pro", at("14:45"))]);
    assert_eq!(
        live_setup(LiveInput {
            usage: &stale,
            schedule: Some(&later),
            ..base
        })
        .expect("a setup")
        .accounts[1],
        SimAccount {
            id: "pro".into(),
            capacity: 1.0,
            keep_alive: true,
            remaining: 100.0,
            first_reset: Some(at("14:00")),
            restart_at: Some(at("14:45")),
            ..SimAccount::default()
        }
    );

    // A closed window is started now by the keeper, so it resets at 15:00.
    let closed = usage_map(vec![
        ("max", open.get("max").expect("max").clone()),
        ("pro", fresh("pro", now, 0.0, None, 20.0)),
    ]);
    let closed_input = LiveInput {
        usage: &closed,
        ..base
    };
    assert_eq!(
        lane(&live_forecast(closed_input).expect("a forecast")),
        ["max 10:00-15:00", "pro 15:00-16:00", "- 16:00-18:00"]
    );
    // Started at 12:00 as scheduled, it resets at 17:00.
    let noon = schedule(&[("pro", at("12:00"))]);
    assert_eq!(
        lane(
            &live_forecast(LiveInput {
                schedule: Some(&noon),
                ..closed_input
            })
            .expect("a forecast")
        ),
        [
            "max 10:00-15:00",
            "pro 15:00-16:00",
            "- 16:00-17:00",
            "pro 17:00-18:00",
        ]
    );
}

#[test]
fn the_account_in_use_is_read_as_of_now_its_use_since_the_read_at_today_s_pace_comes_off() {
    let (duo, ctx) = duo(120.0);
    let settings = settings();
    // Every read five minutes old.
    let read = |id: &str, now: f64, used: f64, resets: &str| AccountUsage {
        checked_at: Some(iso(now - 5.0 * MINUTE)),
        ..fresh(id, now, used, Some(resets), 20.0)
    };
    let remaining = |now: f64, usage: &JsMap<AccountUsage>, factor: Option<f64>| {
        live_setup(LiveInput {
            factor,
            ..input(&duo, &settings, &ctx, usage, Some("max"), now)
        })
        .expect("a setup")
        .accounts
        .iter()
        .map(|a| relay_core::shared::types::js::round(a.remaining * 1000.0) / 1000.0)
        .collect::<Vec<_>>()
    };
    // Read at 09:55 with 100 Pro units left; at 120 an hour 10 went since.
    let now = at("10:00");
    let usage = usage_map(vec![
        ("max", read("max", now, 80.0, "14:00")),
        ("pro", read("pro", now, 50.0, "13:00")),
    ]);
    // Pro is not in use: as read.
    assert_eq!(remaining(now, &usage, None), [90.0, 50.0]);
    // At twice the pace, 20 went.
    assert_eq!(remaining(now, &usage, Some(2.0)), [80.0, 50.0]);
    // Never below empty.
    let mut dry = usage.clone();
    dry.insert("max", read("max", now, 99.0, "14:00"));
    assert_eq!(remaining(now, &dry, None), [0.0, 50.0]);
    // Only work time counts: read at 08:58, three minutes of work by 09:03.
    let start = at("09:03");
    let started = usage_map(vec![
        ("max", read("max", start, 80.0, "14:00")),
        ("pro", read("pro", start, 50.0, "13:00")),
    ]);
    assert_eq!(remaining(start, &started, None), [94.0, 50.0]);
    // Before work no account is in use: as read.
    let early = at("08:50");
    let before = usage_map(vec![
        ("max", read("max", early, 80.0, "14:00")),
        ("pro", read("pro", early, 50.0, "13:00")),
    ]);
    assert_eq!(remaining(early, &before, None), [100.0, 50.0]);
}

// Four Pros on a flat day, read with second-precise resets (no resets: closed).
fn pros() -> Vec<Account> {
    ["p1", "p2", "p3", "p4"]
        .iter()
        .map(|id| planning_account(id, "pro"))
        .collect()
}
fn quad() -> PlanningSettings {
    PlanningSettings {
        accounts: helpers::planned_accounts(&pros()),
        ..settings()
    }
}
fn quad_context(rate: f64) -> PlanContext {
    plan_context(&pros(), flat(rate))
}
fn read(now: f64, resets: &[(&str, f64)]) -> JsMap<AccountUsage> {
    pros()
        .iter()
        .map(|a| {
            let reset = resets.iter().find(|(id, _)| *id == a.id).map(|(_, t)| *t);
            (a.id.clone(), fresh_at(&a.id, now, 0.0, reset, 20.0))
        })
        .collect()
}

#[test]
fn live_times_within_a_tick_of_the_plan_s_own_windows_count_as_planned() {
    let (quad, context) = (quad(), quad_context(100.0));
    let four = day_plan(WEDNESDAY, &quad, &context, None);
    // p4's window opens with work at 09:00: no warm-up five hours early.
    assert_eq!(
        four.accounts
            .iter()
            .map(|a| clock_in(a.active_from, ZONE))
            .collect::<Vec<_>>(),
        ["05:00", "06:00", "07:00", "09:00"]
    );
    let second = 1000.0;
    let live = |usage: &JsMap<AccountUsage>, now: f64, exact: bool| {
        live_setup(LiveInput {
            exact,
            ..input(&four, &quad, &context, usage, None, now)
        })
        .expect("a setup")
        .accounts
    };
    // The keeper's tick at 05:00:05 has not started p1 yet: it warms at 05:00.
    let dawn = at("05:00") + 5.0 * second;
    let dawn_usage = read(dawn, &[]);
    assert_eq!(live(&dawn_usage, dawn, false)[0].warm_up, Some(at("05:00")));
    // Started at 05:00:05, p1 resets at 10:00:05: its planned 10:00. p2 has been due since
    // 06:00.
    let tick = at("06:00") + 30.0 * second;
    let tick_usage = read(tick, &[("p1", at("10:00") + 5.0 * second)]);
    assert_eq!(
        live(&tick_usage, tick, false)[0].first_reset,
        Some(at("10:00"))
    );
    assert_eq!(live(&tick_usage, tick, false)[1].warm_up, Some(at("06:00")));
    assert_eq!(
        live_forecast(input(&four, &quad, &context, &tick_usage, None, tick)).as_ref(),
        four.forecast.as_deref()
    );
    // Three minutes off is not a tick: p2 warms now, p1 keeps its reset.
    let late_usage = read(at("06:03"), &[("p1", at("10:03"))]);
    let late = live(&late_usage, at("06:03"), false);
    assert_eq!(late[0].first_reset, Some(at("10:03")));
    assert_eq!(late[1].warm_up, Some(at("06:03")));
    // Asked for the times exactly as read, none counts as planned.
    let exact = live(&tick_usage, tick, true);
    assert_eq!(exact[0].first_reset, Some(at("10:00") + 5.0 * second));
    assert_eq!(exact[1].warm_up, Some(at("06:00") + 30.0 * second));
    assert_eq!(
        live(&dawn_usage, dawn, true)[0].warm_up,
        Some(at("05:00") + 5.0 * second)
    );
}

#[test]
fn a_window_resetting_before_its_account_s_active_range_restarts_when_the_range_begins() {
    // At 80 an hour p3 and p4 warm up at 07:30. At 06:00 p3 still has a window from the night
    // that resets at 07:15; the keeper restarts it at 07:30.
    let (quad, context) = (quad(), quad_context(80.0));
    let plan80 = day_plan(WEDNESDAY, &quad, &context, None);
    assert_eq!(clock_in(plan80.accounts[2].active_from, ZONE), "07:30");
    let now = at("06:00");
    let usage = read(
        now,
        &[
            ("p1", at("10:00")),
            ("p2", at("10:00")),
            ("p3", at("07:15")),
        ],
    );
    let live = input(&plan80, &quad, &context, &usage, None, now);
    assert_eq!(
        live_setup(live).expect("a setup").accounts[2].restart_at,
        Some(at("07:30"))
    );
    assert_eq!(live_forecast(live).as_ref(), plan80.forecast.as_deref());
}

#[test]
fn a_closed_window_scheduled_before_now_starts_now_not_at_the_past_time() {
    let (duo, ctx) = duo(100.0);
    let settings = settings();
    let now = at("10:00");
    let usage = usage_map(vec![
        ("max", fresh("max", now, 0.0, Some("20:00"), 20.0)),
        ("pro", fresh("pro", now, 0.0, None, 20.0)),
    ]);
    let base = input(&duo, &settings, &ctx, &usage, Some("max"), now);
    // Started at 07:00, pro's window would reset at 12:00 and again at 17:00.
    let seven = schedule(&[("pro", at("07:00"))]);
    let past = LiveInput {
        schedule: Some(&seven),
        ..base
    };
    assert_eq!(
        live_setup(past).expect("a setup").accounts[1].warm_up,
        Some(now)
    );
    assert_eq!(live_forecast(past), live_forecast(base));
}

#[test]
fn an_account_whose_used_up_week_resets_during_work_serves_from_then() {
    let (plan, settings) = (plan(), settings());
    let ctx = context(flat(300.0));
    let now = at("09:00");
    let mut vertex = fresh("vertex", now, 0.0, Some("12:00"), 20.0);
    vertex.seven_day = Some(relay_core::shared::types::UsageWindow::new(
        100.0,
        Some(&iso(at("11:00"))),
    ));
    let usage = usage_map(vec![
        ("max", fresh("max", now, 80.0, Some("11:15"), 20.0)),
        ("vertex", vertex),
    ]);
    let forecast =
        live_forecast(input(&plan, &settings, &ctx, &usage, Some("max"), now)).expect("a forecast");
    let served: Vec<_> = forecast
        .segments
        .iter()
        .filter(|s| s.account_id.as_deref() == Some("vertex"))
        .collect();
    assert!(!served.is_empty());
    assert!(served.iter().all(|s| s.from >= at("11:00")));
}
