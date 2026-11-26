//! Port of `tests/adaptive-schedule.test.ts`.

#[path = "common/planning.rs"]
mod helpers;

use std::sync::{Arc, Mutex};

use helpers::{
    HOUR, MINUTE, ZONE, busy_scaled, flat_tempo, fresh_at, hours, planning_account, schedule,
    team_account, wall,
};
use relay_core::adaptive_schedule::{
    AdaptiveInput, AdaptiveNotice, AdaptiveNoticeKind, AdaptiveResult, AdaptiveSchedule,
    NOTIFY_EVERY_MS, SEARCH_EVERY_MS, Search,
};
use relay_core::shared::adaptive_plan::{Replan, ReplanInput, replan_starts};
use relay_core::shared::capacity_plan::Forecast;
use relay_core::shared::day_plan::{day_plan, plan_context};
use relay_core::shared::live_forecast::{LiveInput, live_forecast};
use relay_core::shared::tempo::{Tempo, tempo_at};
use relay_core::shared::types::js::{self, JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountUsage, PlanningAccount, PlanningSettings, UsageWindow,
    default_planning_settings,
};
use relay_core::shared::usage_statistics::{UsageSample, usage_identity};

const WEDNESDAY: &str = "2026-10-14";
const THURSDAY: &str = "2026-10-15";

fn at(clock: &str) -> f64 {
    wall(WEDNESDAY, clock, ZONE)
}
fn on(date: &str, clock: &str) -> f64 {
    wall(date, clock, ZONE)
}
fn settings_with(accounts: &[Account], start: &str, end: &str) -> PlanningSettings {
    PlanningSettings {
        auto_start: true,
        time_zone: ZONE.into(),
        weekday: hours(true, start, end),
        weekend: hours(false, "11:00", "18:00"),
        accounts: helpers::planned_accounts(accounts),
        ..default_planning_settings()
    }
}
fn settings_for(accounts: &[Account]) -> PlanningSettings {
    settings_with(accounts, "09:00", "18:00")
}
/// Usage read at `now`; the five-hour window is open until `resets` when given.
fn fresh(id: &str, now: f64, used: f64, resets: Option<f64>) -> AccountUsage {
    fresh_at(id, now, used, resets.filter(|r| *r != 0.0), 20.0)
}
fn input(accounts: &[Account], rate: f64, now: f64, usage: JsMap<AccountUsage>) -> AdaptiveInput {
    AdaptiveInput {
        settings: settings_for(accounts),
        accounts: accounts.to_vec(),
        usage,
        tempo: flat_tempo(rate),
        recent_samples: Vec::new(),
        active_id: None,
        blocked: Vec::new(),
        now,
    }
}
/// The live forecast the class sees for `value` with `schedule` (today's plan).
fn forecast_with(value: &AdaptiveInput, schedule: &JsMap<f64>) -> Forecast {
    let context = plan_context(&value.accounts, value.tempo.clone());
    let plan = day_plan(WEDNESDAY, &value.settings, &context, None);
    live_forecast(LiveInput {
        plan: &plan,
        settings: &value.settings,
        context: &context,
        usage: &value.usage,
        active_id: value.active_id.as_deref(),
        now: value.now,
        factor: None,
        schedule: Some(schedule),
        exact: false,
    })
    .expect("a forecast")
}

type Pick = dyn Fn(&ReplanInput<'_>, Option<Replan>, usize) -> Option<Replan> + Send + Sync;

/// Counts searches by their `now`; `pick` may replace what the real search found.
fn searching(pick: Option<Arc<Pick>>) -> (Arc<Mutex<Vec<f64>>>, Search) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let search: Search = Box::new(move |value: &ReplanInput<'_>| {
        let call = {
            let mut calls = seen.lock().expect("calls");
            calls.push(value.live.now);
            calls.len()
        };
        let replan = replan_starts(value);
        match &pick {
            Some(pick) => pick(value, replan, call),
            None => replan,
        }
    });
    (calls, search)
}
fn calls_of(calls: &Arc<Mutex<Vec<f64>>>) -> Vec<f64> {
    calls.lock().expect("calls").clone()
}
fn with_search(search: Search) -> AdaptiveSchedule {
    AdaptiveSchedule::new(None, Some(search))
}

fn result(
    schedule_entries: &[(&str, f64)],
    factor: f64,
    since: Option<f64>,
    notice: Option<AdaptiveNoticeKind>,
) -> AdaptiveResult {
    AdaptiveResult {
        schedule: schedule(schedule_entries),
        factor,
        observed_rate: None,
        since,
        notice: notice.map(|kind| AdaptiveNotice {
            kind,
            schedule: schedule(schedule_entries),
        }),
    }
}
fn nothing() -> AdaptiveResult {
    result(&[], 1.0, None, None)
}

fn a() -> Account {
    team_account("a", 3.0)
}
fn b() -> Account {
    planning_account("b", "pro")
}
/// The hold scenario: from 09:30 `a` serves at 100 an hour on its last 250 Pro units (they
/// last until its reset at 12:00) while `b`'s idle window resets at 10:00. Holding b's restart
/// to 11:00 removes an hour's outage.
fn hold_with(now: f64, b_usage: AccountUsage) -> AdaptiveInput {
    let used = 100.0 / 6.0 + (((now - at("09:30")) / HOUR) * 100.0) / 3.0;
    AdaptiveInput {
        active_id: Some("a".into()),
        ..input(
            &[a(), b()],
            100.0,
            now,
            helpers::usage_map(vec![
                ("a", fresh("a", now, used, Some(at("12:00")))),
                ("b", b_usage),
            ]),
        )
    }
}
fn hold(now: f64) -> AdaptiveInput {
    hold_with(now, fresh("b", now, 0.0, Some(at("10:00"))))
}

fn trio() -> Vec<Account> {
    vec![
        planning_account("max", "max5"),
        team_account("vertex", 2.0),
        planning_account("pro", "pro"),
    ]
}
/// The Mac wakes at `now` with every window closed and usage just refreshed.
fn wake_up(now: f64) -> AdaptiveInput {
    let accounts = trio();
    let usage = accounts
        .iter()
        .map(|a| (a.id.clone(), fresh(&a.id, now, 0.0, None)))
        .collect();
    input(&accounts, 120.0, now, usage)
}

/// `a`'s five-hour use every five minutes over the last hour, as `used(time)` percent.
fn a_samples(now: f64, used: &dyn Fn(f64) -> f64) -> Vec<UsageSample> {
    let mut out = Vec::new();
    let mut time = now - HOUR;
    while time <= now {
        if time >= at("09:00") {
            out.push(UsageSample {
                account_id: "a".into(),
                identity: usage_identity(&a()).expect("an identity"),
                checked_at: iso(time),
                five_hour: Some(UsageWindow::new(used(time), Some(&iso(at("12:00"))))),
                seven_day: None,
            });
        }
        time += 5.0 * MINUTE;
    }
    out
}
/// The pace scenario, planned at 60 an hour: from 09:00 to 09:30 `a` spends 48 Pro units (96
/// an hour, 1.6 times the plan), then pauses; `b`'s idle window resets at 10:00. At 1.6 times
/// the pace holding b's restart to 11:00 removes the outage; at the planned pace the default
/// needs no hold.
fn pace_with(now: f64, b_usage: AccountUsage) -> AdaptiveInput {
    let used = |time: f64| 16f64.min(((time - at("09:00")) / (30.0 * MINUTE)) * 16.0);
    AdaptiveInput {
        active_id: Some("a".into()),
        recent_samples: a_samples(now, &used),
        ..input(
            &[a(), b()],
            60.0,
            now,
            helpers::usage_map(vec![
                ("a", fresh("a", now, used(now), Some(at("12:00")))),
                ("b", b_usage),
            ]),
        )
    }
}
fn pace(now: f64) -> AdaptiveInput {
    pace_with(now, fresh("b", now, 0.0, Some(at("10:00"))))
}
/// The pace scenario at `per_hour` over the last hour (a's samples only set the pace); from
/// 10:00 b's window has reset and waits for its hold.
fn paced(now: f64, per_hour: f64) -> AdaptiveInput {
    let value = if now < at("10:00") {
        pace(now)
    } else {
        pace_with(now, fresh("b", now, 0.0, None))
    };
    let used = move |time: f64| 16.0 + ((time - now) / HOUR) * (per_hour / 3.0);
    AdaptiveInput {
        recent_samples: a_samples(now, &used),
        ..value
    }
}
fn without_adaptation(mut value: AdaptiveInput) -> AdaptiveInput {
    value.settings.adaptive = Some(false);
    value
}
fn without_auto_start(mut value: AdaptiveInput) -> AdaptiveInput {
    value.settings.auto_start = false;
    value
}

#[test]
fn the_search_and_notice_intervals_are_15_and_30_minutes() {
    assert_eq!(SEARCH_EVERY_MS, 15.0 * MINUTE);
    assert_eq!(NOTIFY_EVERY_MS, 30.0 * MINUTE);
}

#[test]
fn adaptation_off_auto_start_off_or_no_work_interval_no_schedule_at_the_planned_pace() {
    let (calls, search) = searching(None);
    let mut adaptive = with_search(search);
    let now = at("09:30");
    for value in [without_adaptation(pace(now)), without_auto_start(pace(now))] {
        assert_eq!(adaptive.update(&value), nothing());
    }
    // Before the plan's first warm-up (Vertex at 05:30) and once work ends.
    for time in [at("05:00"), at("18:00")] {
        assert_eq!(adaptive.update(&wake_up(time)), nothing());
    }
    assert!(calls_of(&calls).is_empty());
}

#[test]
fn turning_adaptation_or_auto_start_off_or_leaving_work_drops_the_schedule_quietly() {
    // Turning it off is the user's own doing: no "back to normal", then or once the 30
    // minutes since the last notice are up.
    let mut adaptive = AdaptiveSchedule::default();
    assert_eq!(
        adaptive.update(&hold(at("09:30"))).schedule,
        schedule(&[("b", at("11:00"))])
    );
    for clock in ["10:05", "10:30"] {
        assert_eq!(
            adaptive.update(&without_adaptation(hold(at(clock)))),
            nothing(),
            "{clock}"
        );
    }
    let mut quiet = AdaptiveSchedule::default();
    quiet.update(&hold(at("09:30")));
    for clock in ["09:40", "10:00", "11:05"] {
        let now = at(clock);
        assert_eq!(
            quiet.update(&without_auto_start(hold_with(
                now,
                fresh("b", now, 0.0, None)
            ))),
            nothing(),
            "{clock}"
        );
    }
    // Outside the work interval (here the day was cut short to end at 10:00) the schedule goes
    // quietly too.
    let mut short = AdaptiveSchedule::default();
    short.update(&hold(at("09:30")));
    let after = AdaptiveInput {
        settings: settings_with(&[a(), b()], "09:00", "10:00"),
        ..hold(at("10:30"))
    };
    assert_eq!(short.update(&after), nothing());
}

#[test]
fn holding_a_restart_is_adopted_once_and_kept_without_searching_again() {
    let clock = Arc::new(Mutex::new(at("09:30")));
    let (calls, search) = searching(None);
    let read = clock.clone();
    let mut adaptive = AdaptiveSchedule::new(
        Some(Box::new(move || *read.lock().expect("clock"))),
        Some(search),
    );
    let first = adaptive.update(&hold(at("09:30")));
    assert_eq!(
        first,
        result(
            &[("b", at("11:00"))],
            1.0,
            Some(at("09:30")),
            Some(AdaptiveNoticeKind::Updated)
        )
    );
    *clock.lock().expect("clock") = at("09:31");
    let second = adaptive.update(&hold(at("09:31")));
    assert_eq!(
        second,
        result(&[("b", at("11:00"))], 1.0, Some(at("09:30")), None)
    );
    assert_eq!(calls_of(&calls), [at("09:30")]);
    // The last result without its notice.
    assert_eq!(adaptive.current(), second);
}

#[test]
fn a_search_runs_at_most_every_15_minutes_while_the_forecast_stays_worse() {
    let (calls, search) = searching(None);
    let mut adaptive = with_search(search);
    // Neither account can be started, so nothing improves and every update finds the forecast
    // an hour short of the plan.
    for clock in ["09:30", "09:35", "09:44", "09:45", "09:50"] {
        let value = AdaptiveInput {
            blocked: vec!["a".into(), "b".into()],
            ..hold(at(clock))
        };
        assert_eq!(adaptive.update(&value), nothing(), "{clock}");
    }
    assert_eq!(calls_of(&calls), [at("09:30"), at("09:45")]);
}

#[test]
fn an_equally_good_alternative_never_replaces_the_adopted_schedule() {
    // b's window resets at 10:15 here: held to 10:45 or to 11:15 it leaves 15 minutes without
    // quota either way; the search prefers the shorter hold.
    let late = |now: f64| hold_with(now, fresh("b", now, 0.0, Some(at("10:15"))));
    let alternative = schedule(&[("b", at("11:15"))]);
    let other = alternative.clone();
    let pick: Arc<Pick> = Arc::new(move |value, replan, call| {
        if call == 1 {
            return replan;
        }
        let replan = replan.expect("a replan");
        Some(Replan {
            schedule: other.clone(),
            forecast: live_forecast(LiveInput {
                schedule: Some(&other),
                ..value.live
            })
            .expect("a forecast"),
            ..replan
        })
    });
    let (calls, search) = searching(Some(pick));
    let mut adaptive = with_search(search);
    assert_eq!(
        adaptive.update(&late(at("09:30"))).schedule,
        schedule(&[("b", at("10:45"))])
    );
    let now = at("09:45");
    let adopted = forecast_with(&late(now), &schedule(&[("b", at("10:45"))]));
    let other = forecast_with(&late(now), &alternative);
    assert_eq!(adopted.outage_minutes, 15.0);
    assert_eq!(
        (other.unmet, other.switches),
        (adopted.unmet, adopted.switches)
    );
    // Still 15 minutes short of the plan, so the search runs again.
    let outcome = adaptive.update(&late(now));
    assert_eq!(calls_of(&calls).len(), 2);
    assert_eq!(
        outcome,
        result(&[("b", at("10:45"))], 1.0, Some(at("09:30")), None)
    );
}

#[test]
fn today_s_pace_scales_the_forecast_1_6_times_the_plan_adopts_a_hold() {
    let mut adaptive = AdaptiveSchedule::default();
    let outcome = adaptive.update(&pace(at("09:30")));
    assert_eq!(outcome.factor, 1.6);
    assert_eq!(outcome.observed_rate, Some(96.0));
    assert_eq!(outcome.schedule, schedule(&[("b", at("11:00"))]));
    assert_eq!(
        outcome.notice.map(|n| n.kind),
        Some(AdaptiveNoticeKind::Updated)
    );
    // At the planned pace the same moment needs nothing.
    let calm = AdaptiveSchedule::default().update(&AdaptiveInput {
        recent_samples: Vec::new(),
        ..pace(at("09:30"))
    });
    assert_eq!(calm, nothing());
}

#[test]
fn a_gain_that_rests_on_two_resets_at_the_plan_s_same_instant_is_not_adopted() {
    // Planned at 50 an hour, both accounts warmed up at 08:45 (set by hand: the plan alone
    // spreads the two resets apart). At 09:56 a has been used at 93 an hour (1.9 times the
    // plan) and runs out at 12:07; b runs out at 13:10, and both windows reset at about 13:45
    // (a at 13:45:08, b at 13:46:20), both within the plan's own 13:45.
    let now = at("09:56") + 5_000.0;
    let a_reset = at("13:45") + 8_000.0;
    let read = input(
        &[a(), b()],
        50.0,
        now,
        helpers::usage_map(vec![
            ("a", fresh("a", now, 31.0, Some(a_reset))),
            ("b", fresh("b", now, 0.0, Some(at("13:46") + 20_000.0))),
        ]),
    );
    let mut settings = read.settings.clone();
    settings.accounts = ["a", "b"]
        .iter()
        .map(|id| PlanningAccount {
            id: (*id).into(),
            first_start: Some("08:45".into()),
        })
        .collect();
    let mut samples = Vec::new();
    let mut time = now - HOUR;
    while time <= now {
        samples.push(UsageSample {
            account_id: "a".into(),
            identity: usage_identity(&a()).expect("an identity"),
            checked_at: iso(time),
            five_hour: Some(UsageWindow::new(
                (31.0 * (time - now + HOUR)) / HOUR,
                Some(&iso(a_reset)),
            )),
            seven_day: None,
        });
        time += 5.0 * MINUTE;
    }
    let fast = AdaptiveInput {
        settings,
        active_id: Some("a".into()),
        recent_samples: samples,
        ..read
    };
    // Counted as one instant, the larger a refills first and serves on, so holding its
    // restart to 14:15 seems to save a switch.
    let context = plan_context(&[a(), b()], fast.tempo.clone());
    let plan = day_plan(WEDNESDAY, &fast.settings, &context, None);
    let replan = replan_starts(&ReplanInput {
        live: LiveInput {
            plan: &plan,
            settings: &fast.settings,
            context: &context,
            usage: &fast.usage,
            active_id: Some("a"),
            now,
            factor: Some(1.9),
            schedule: None,
            exact: false,
        },
        blocked: &[],
    })
    .expect("a replan");
    assert_eq!(replan.schedule, schedule(&[("a", at("14:15"))]));
    // As read, a resets first either way: nothing is adopted or announced.
    assert_eq!(
        AdaptiveSchedule::default().update(&fast),
        AdaptiveResult {
            observed_rate: Some(93.0),
            ..result(&[], 1.9, None, None)
        }
    );
}

#[test]
fn a_slower_day_clears_the_schedule_once_two_reviews_in_a_row_agree_with_one_notice() {
    let mut adaptive = AdaptiveSchedule::default();
    let mut kinds = Vec::new();
    let mut run = |clock: &str, per_hour: f64| {
        let outcome = adaptive.update(&paced(at(clock), per_hour));
        if let Some(notice) = &outcome.notice {
            kinds.push(notice.kind);
        }
        outcome
    };
    assert_eq!(run("09:30", 96.0).factor, 1.6);
    let held = schedule(&[("b", at("11:00"))]);
    // 09:45: the planned pace, where the default does as well. One review is not enough.
    assert_eq!(run("09:45", 60.0).schedule, held);
    // 10:00: fast again, the hold is better, and the count starts over.
    assert_eq!(run("10:00", 96.0).schedule, held);
    // 10:15 and 10:30: the planned pace twice in a row clears it.
    assert_eq!(run("10:15", 60.0).schedule, held);
    for clock in ["10:16", "10:29"] {
        assert_eq!(run(clock, 60.0).schedule, held, "{clock}");
    }
    let cleared = run("10:30", 60.0);
    assert!(cleared.schedule.is_empty());
    assert_eq!(
        cleared.notice,
        Some(AdaptiveNotice {
            kind: AdaptiveNoticeKind::Normal,
            schedule: JsMap::new(),
        })
    );
    assert_eq!(
        kinds,
        [AdaptiveNoticeKind::Updated, AdaptiveNoticeKind::Normal]
    );
}

#[test]
fn a_schedule_the_default_matches_just_before_its_last_start_goes_then_quietly() {
    let mut adaptive = AdaptiveSchedule::default();
    let mut kinds = Vec::new();
    let mut run = |clock: &str, per_hour: f64| {
        let outcome = adaptive.update(&paced(at(clock), per_hour));
        if let Some(notice) = &outcome.notice {
            kinds.push(notice.kind);
        }
        outcome.schedule
    };
    assert_eq!(run("09:30", 96.0), schedule(&[("b", at("11:00"))]));
    // The planned pace from 10:30: two reviews in a row find the default as good, the second
    // at 10:45, 15 minutes before b's start. Dropped then, it would say "back to normal" for a
    // hold that ends at the next review.
    assert_eq!(run("10:30", 60.0), schedule(&[("b", at("11:00"))]));
    assert_eq!(run("10:45", 60.0), schedule(&[("b", at("11:00"))]));
    assert!(run("11:00", 60.0).is_empty());
    assert_eq!(kinds, [AdaptiveNoticeKind::Updated]);
}

#[test]
fn after_a_reset_what_the_user_heard_stands_where_it_still_holds_the_rest_goes_quietly() {
    let (calls, search) = searching(None);
    let mut adaptive = with_search(search);
    adaptive.update(&hold(at("09:30")));
    adaptive.reset();
    // Nothing adopted is left, and the next update searches at once: the same hold, which the
    // user heard of at 09:30.
    assert_eq!(adaptive.current(), nothing());
    assert_eq!(
        adaptive.update(&hold(at("09:31"))),
        result(&[("b", at("11:00"))], 1.0, Some(at("09:31")), None)
    );
    assert_eq!(calls_of(&calls), [at("09:30"), at("09:31")]);
    // Reset again when the work was cut short to 15:00: no hold is needed any more, and none
    // is announced, then or once the 30 minutes are up.
    adaptive.reset();
    let short = |now: f64| AdaptiveInput {
        settings: settings_with(&[a(), b()], "09:00", "15:00"),
        ..hold(now)
    };
    for clock in ["09:35", "10:01"] {
        assert_eq!(adaptive.update(&short(at(clock))), nothing(), "{clock}");
    }
}

#[test]
fn a_change_inside_the_30_minutes_is_announced_only_if_it_still_stands() {
    let (calls, search) = searching(None);
    let mut adaptive = with_search(search);
    adaptive.update(&hold(at("09:30")));
    // Adaptation off at 09:40 and on again at 09:45: the same hold comes back, so the user,
    // who heard of it at 09:30, hears nothing more.
    assert_eq!(
        adaptive.update(&without_adaptation(hold(at("09:40")))),
        nothing()
    );
    assert_eq!(
        adaptive.update(&hold(at("09:45"))),
        result(&[("b", at("11:00"))], 1.0, Some(at("09:45")), None)
    );
    assert_eq!(calls_of(&calls), [at("09:30"), at("09:45")]);
    for clock in ["10:00", "10:15"] {
        let now = at(clock);
        assert_eq!(
            adaptive
                .update(&hold_with(now, fresh("b", now, 0.0, None)))
                .notice,
            None,
            "{clock}"
        );
    }
}

fn pros() -> Vec<Account> {
    ["p1", "p2", "p3", "p4"]
        .iter()
        .map(|id| planning_account(id, "pro"))
        .collect()
}

#[test]
fn the_mac_waking_at_08_50_with_every_warm_up_missed_is_re_planned_before_work() {
    let now = at("08:50");
    let (calls, search) = searching(None);
    let outcome = with_search(search).update(&wake_up(now));
    // No samples: the planned pace.
    assert_eq!(outcome.factor, 1.0);
    assert_eq!(outcome.observed_rate, None);
    // Max's window is planned to open with work at 09:00. Started now, vertex and pro would
    // switch twice against the plan's once; pro held to 09:00 too switches once.
    assert_eq!(forecast_with(&wake_up(now), &JsMap::new()).switches, 2);
    assert_eq!(outcome.schedule, schedule(&[("pro", at("09:00"))]));
    assert_eq!(forecast_with(&wake_up(now), &outcome.schedule).switches, 1);
    assert_eq!(
        outcome.notice.map(|n| n.kind),
        Some(AdaptiveNoticeKind::Updated)
    );
    assert_eq!(calls_of(&calls), [now]);
    // Four Pros planned at 100 an hour warm up at 05:00, 06:00 and 07:00, the fourth opening
    // with work at 09:00. Started at 08:50 (the fourth at 09:00) they leave 60 minutes without
    // quota and 7 switches against the plan's none and 4, so the search runs; but no later
    // start does better (two windows a Pro after 08:50 hold 800 of the 900 Pro units of
    // demand).
    let pros = pros();
    let usage = pros
        .iter()
        .map(|a| (a.id.clone(), fresh(&a.id, now, 0.0, None)))
        .collect();
    let four = input(&pros, 100.0, now, usage);
    let fallback = forecast_with(&four, &JsMap::new());
    assert_eq!((fallback.outage_minutes, fallback.switches), (60.0, 7));
    let (other_calls, other_search) = searching(None);
    assert_eq!(with_search(other_search).update(&four), nothing());
    assert_eq!(calls_of(&other_calls), [now]);
}

#[test]
fn a_calm_morning_that_follows_the_plan_never_searches_before_work_or_after_its_start() {
    for (accounts, rate) in [(trio(), 120.0), (pros(), 100.0)] {
        let settings = settings_for(&accounts);
        let plan = day_plan(
            WEDNESDAY,
            &settings,
            &plan_context(&accounts, flat_tempo(rate)),
            None,
        );
        let (calls, search) = searching(None);
        let mut adaptive = with_search(search);
        for clock in [
            "04:00", "05:30", "06:30", "07:30", "08:00", "08:50", "09:00",
        ] {
            let now = at(clock);
            // Every window warmed up when planned, and nothing is used before work.
            let usage = plan
                .accounts
                .iter()
                .map(|p| {
                    let mut reset = p.active_from;
                    while reset <= now {
                        reset += 5.0 * HOUR;
                    }
                    let open = (p.active_from <= now).then_some(reset);
                    (p.account_id.clone(), fresh(&p.account_id, now, 0.0, open))
                })
                .collect();
            assert_eq!(
                adaptive.update(&input(&accounts, rate, now, usage)),
                nothing(),
                "{clock}"
            );
        }
        assert!(calls_of(&calls).is_empty());
    }
}

#[test]
fn a_start_whose_time_came_is_dropped_quietly_the_keeper_starts_the_window() {
    let mut adaptive = AdaptiveSchedule::default();
    adaptive.update(&hold(at("09:30")));
    let now = at("11:00");
    // b's window reset at 10:00 and stayed closed.
    assert_eq!(
        adaptive.update(&hold_with(now, fresh("b", now, 0.0, None))),
        nothing()
    );
}

/// A morning run the way the keeper runs it: a tick every minute, `phase` past the minute, the
/// adaptive update first, then at most one due window started (`late` after its warm-up time at
/// the earliest), open in the usage read at the next tick. Every adoption or notice is kept.
fn keeper_morning(
    accounts: &[Account],
    rate: f64,
    phase: f64,
    night: &[(&str, f64)],
    late: f64,
) -> Vec<String> {
    let settings = settings_for(accounts);
    let plan = day_plan(
        WEDNESDAY,
        &settings,
        &plan_context(accounts, flat_tempo(rate)),
        None,
    );
    let mut resets: JsMap<f64> = schedule(night);
    let open =
        |resets: &JsMap<f64>, id: &str, now: f64| resets.get(id).copied().unwrap_or(0.0) > now;
    let mut adaptive = AdaptiveSchedule::default();
    let mut seen = Vec::new();
    let first = js::min(plan.accounts.iter().map(|p| p.active_from));
    let mut now = first + phase;
    while now < at("09:30") {
        let usage = plan
            .accounts
            .iter()
            .map(|p| {
                let reset = open(&resets, &p.account_id, now)
                    .then(|| *resets.get(&p.account_id).expect("a reset"));
                (p.account_id.clone(), fresh(&p.account_id, now, 0.0, reset))
            })
            .collect();
        let outcome = adaptive.update(&input(accounts, rate, now, usage));
        if outcome.notice.is_some() || !outcome.schedule.is_empty() {
            seen.push(format!(
                "{} {}",
                iso(now),
                serde_json::to_string(&outcome).expect("json")
            ));
        }
        let due = plan.accounts.iter().find(|p| {
            now >= p.active_from + late
                && !open(&resets, &p.account_id, now)
                && outcome.schedule.get(&p.account_id).copied().unwrap_or(0.0) <= now
        });
        if let Some(due) = due {
            resets.insert(due.account_id.clone(), now + 5.0 * HOUR);
        }
        now += MINUTE;
    }
    seen
}

#[test]
fn calm_mornings_run_the_way_the_keeper_runs_them_adopt_nothing_and_say_nothing() {
    let cases: [(Vec<Account>, f64); 8] = [
        (trio(), 100.0),
        (trio(), 120.0),
        (trio(), 150.0),
        (pros(), 80.0),
        (pros(), 100.0),
        (vec![a(), b()], 60.0),
        (vec![a(), b()], 80.0),
        (vec![a(), b()], 100.0),
    ];
    for phase in [5_000.0, 30_000.0] {
        for (accounts, rate) in &cases {
            assert_eq!(
                keeper_morning(accounts, *rate, phase, &[], 0.0),
                Vec::<String>::new(),
                "{:?} at {rate}, +{} s",
                accounts.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
                phase / 1000.0
            );
        }
        // At 80 an hour p3 warms up at 07:30, but its window from the night resets at 07:15:
        // the keeper waits for 07:30, as planned.
        assert_eq!(
            keeper_morning(&pros(), 80.0, phase, &[("p3", at("07:15"))], 0.0),
            Vec::<String>::new()
        );
    }
    // Warm-ups a few minutes late (several due at once, a slow refresh) are not missed ones:
    // before work nothing is searched for them.
    for late in [3.0, 8.0] {
        for rate in [80.0, 100.0] {
            assert_eq!(
                keeper_morning(&pros(), rate, 5_000.0, &[], late * MINUTE),
                Vec::<String>::new(),
                "{late} min late at {rate}"
            );
        }
    }
}

#[test]
fn an_adopted_hold_stays_in_force_minute_by_minute_through_b_s_reset() {
    // The hold scenario updated every minute from 09:30 to b's reset at 10:00, with a's usage
    // recomputed each minute or read every five minutes in whole percent. With 249 Pro units
    // left at 09:30 instead of 250, a's quota runs out within a minute of its 12:00 reset: the
    // 10:00 read (34%) puts the run-out a minute early, where the default does as well as the
    // hold. One such review does not clear it.
    for (left, exact) in [(250.0, true), (250.0, false), (249.0, false)] {
        let mut adaptive = AdaptiveSchedule::default();
        let mut kinds = Vec::new();
        let mut adopted: Option<f64> = None;
        let mut now = at("09:30");
        while now <= at("10:00") {
            let read = if exact {
                now
            } else {
                at("09:30") + ((now - at("09:30")) / (5.0 * MINUTE)).floor() * 5.0 * MINUTE
            };
            // a serves 100 Pro units an hour out of its 300.
            let used = (300.0 - left + ((read - at("09:30")) / HOUR) * 100.0) / 3.0;
            let value = hold(read);
            let b_usage = if now < at("10:00") {
                value.usage.get("b").expect("b").clone()
            } else {
                // Held, b's window stays closed once it resets at 10:00.
                fresh("b", now, 0.0, None)
            };
            let outcome = adaptive.update(&AdaptiveInput {
                usage: helpers::usage_map(vec![
                    (
                        "a",
                        fresh(
                            "a",
                            read,
                            if exact { used } else { js::round(used) },
                            Some(at("12:00")),
                        ),
                    ),
                    ("b", b_usage),
                ]),
                now,
                ..value
            });
            let label = format!("{left} {exact} {now}");
            if let Some(notice) = &outcome.notice {
                kinds.push(notice.kind);
            }
            if adopted.is_none() && outcome.schedule.contains_key("b") {
                adopted = Some(now);
            }
            if adopted.is_some() {
                assert_eq!(outcome.schedule, schedule(&[("b", at("11:00"))]), "{label}");
            }
            now += MINUTE;
        }
        assert!(adopted.is_some(), "{left} {exact}");
        assert_eq!(kinds, [AdaptiveNoticeKind::Updated], "{left} {exact}");
    }
}

#[test]
fn an_entry_dropped_from_the_schedule_starts_the_count_of_agreeing_reviews_over() {
    // At 1.6 times the plan the search holds b's restart to 11:00; an injected search adds a
    // restart of a at 09:50, before a's own reset, which changes nothing (the verdict is not
    // under test), then finds nothing more. From 09:45 the day runs at the planned pace, where
    // the default does as well.
    let both = schedule(&[("a", at("09:50")), ("b", at("11:00"))]);
    let pick: Arc<Pick> = Arc::new(|_, replan, call| {
        if call != 1 {
            return None;
        }
        let mut replan = replan.expect("a replan");
        replan.schedule.insert("a", at("09:50"));
        Some(replan)
    });
    let (_, search) = searching(Some(pick));
    let mut adaptive = with_search(search);
    assert_eq!(adaptive.update(&pace(at("09:30"))).schedule, both);
    // 09:45: the first review that agrees.
    assert_eq!(adaptive.update(&paced(at("09:45"), 60.0)).schedule, both);
    // 09:50: a's start has come; the schedule that review compared is gone.
    assert_eq!(
        adaptive.update(&paced(at("09:50"), 60.0)).schedule,
        schedule(&[("b", at("11:00"))])
    );
    // So 10:00 agrees for the first time again, and only 10:15 clears it.
    assert_eq!(
        adaptive.update(&paced(at("10:00"), 60.0)).schedule,
        schedule(&[("b", at("11:00"))])
    );
    assert!(
        adaptive
            .update(&paced(at("10:15"), 60.0))
            .schedule
            .is_empty()
    );
}

#[test]
fn the_window_open_at_the_adoption_is_not_mistaken_for_use_when_its_reset_is_reported_90_s_later() {
    // The hold scenario with a third account and work until 19:00: c's idle window resets at
    // 10:00, and b's opened at 09:29:30, half a minute before the adoption at 09:30. Holding
    // both restarts saves a switch.
    let c = planning_account("c", "pro");
    let opened = at("09:29") + 30_000.0;
    let trio = |now: f64, b_usage: AccountUsage| {
        let value = hold_with(now, b_usage);
        let mut usage = value.usage.clone();
        usage.insert("c", fresh("c", now, 0.0, Some(at("10:00"))));
        AdaptiveInput {
            accounts: vec![a(), b(), c.clone()],
            settings: settings_with(&[a(), b(), c.clone()], "09:00", "19:00"),
            usage,
            ..value
        }
    };
    let mut adaptive = AdaptiveSchedule::default();
    let adoption = at("09:30");
    let held = schedule(&[("b", opened + 8.0 * HOUR), ("c", at("11:00"))]);
    assert_eq!(
        adaptive
            .update(&trio(
                adoption,
                fresh("b", adoption, 0.0, Some(opened + 5.0 * HOUR))
            ))
            .schedule,
        held
    );
    let now = at("09:35");
    assert_eq!(
        adaptive.update(&trio(
            now,
            fresh("b", now, 1.0, Some(opened + 5.0 * HOUR + 90_000.0))
        )),
        AdaptiveResult {
            schedule: held,
            factor: 1.0,
            observed_rate: None,
            since: Some(adoption),
            notice: None,
        }
    );
}

#[test]
fn a_deferred_account_used_by_hand_loses_its_deferral_without_a_notice() {
    let mut adaptive = AdaptiveSchedule::default();
    adaptive.update(&hold(at("09:30")));
    // The window b had at the adoption is not a sign of use.
    let now = at("09:45");
    assert_eq!(
        adaptive.update(&hold(now)).schedule,
        schedule(&[("b", at("11:00"))])
    );
    // At 10:10 b runs a window the user opened after its reset.
    let now = at("10:10");
    assert_eq!(
        adaptive.update(&AdaptiveInput {
            active_id: Some("b".into()),
            ..hold_with(now, fresh("b", now, 5.0, Some(at("15:10"))))
        }),
        nothing()
    );
}

#[test]
fn a_clock_moved_back_starts_the_schedule_over() {
    let (calls, search) = searching(None);
    let mut adaptive = with_search(search);
    adaptive.update(&hold(at("09:30")));
    let outcome = adaptive.update(&hold(at("09:20")));
    // Adopted anew at once, and the user, who heard of it, hears nothing more.
    assert_eq!(calls_of(&calls), [at("09:30"), at("09:20")]);
    assert_eq!(
        outcome,
        result(&[("b", at("11:00"))], 1.0, Some(at("09:20")), None)
    );
    // The last notice counts as given at 09:20: the next one may come 30 minutes later, at
    // 09:50, not only at 10:00. (From 09:35 b's window reads as resetting at 11:00, where the
    // hold changes nothing: the reviews at 09:35 and 09:50 find the default as good.)
    let later = |now: f64| hold_with(now, fresh("b", now, 0.0, Some(at("11:00"))));
    assert_eq!(adaptive.update(&later(at("09:35"))).notice, None);
    assert_eq!(
        adaptive.update(&later(at("09:50"))).notice,
        Some(AdaptiveNotice {
            kind: AdaptiveNoticeKind::Normal,
            schedule: JsMap::new(),
        })
    );
}

#[test]
fn a_new_plan_date_starts_over_its_first_update_searches_at_once() {
    // Work runs around the clock, so Wednesday's interval ends as Thursday's starts.
    let accounts = [a(), b()];
    let day = |now: f64| AdaptiveInput {
        settings: settings_with(&accounts, "09:00", "09:00"),
        blocked: vec!["a".into(), "b".into()],
        ..input(
            &accounts,
            100.0,
            now,
            helpers::usage_map(vec![
                // Both are used up until 11:00 and neither can be started.
                ("a", fresh("a", now, 100.0, Some(on(THURSDAY, "11:00")))),
                ("b", fresh("b", now, 100.0, Some(on(THURSDAY, "11:00")))),
            ]),
        )
    };
    let (calls, search) = searching(None);
    let mut adaptive = with_search(search);
    for clock in ["08:50", "08:55", "09:00"] {
        adaptive.update(&day(on(THURSDAY, clock)));
    }
    assert_eq!(
        calls_of(&calls),
        [on(THURSDAY, "08:50"), on(THURSDAY, "09:00")]
    );
}

#[test]
fn an_overnight_interval_keeps_the_schedule_across_local_midnight() {
    // The hold scenario 14 h 20 min later: work runs from 23:20 to 08:20, and at 23:50 b's
    // restart at 00:20 is held to 01:20.
    let night = |now: f64, b_usage: AccountUsage| {
        let value = hold_with(now - 14.0 * HOUR - 20.0 * MINUTE, b_usage.clone());
        let used = value
            .usage
            .get("a")
            .and_then(|u| u.five_hour.as_ref())
            .expect("a's window")
            .used_percent;
        AdaptiveInput {
            usage: helpers::usage_map(vec![
                ("a", fresh("a", now, used, Some(on(THURSDAY, "02:20")))),
                ("b", b_usage),
            ]),
            settings: settings_with(&[a(), b()], "23:20", "08:20"),
            now,
            ..value
        }
    };
    let (calls, search) = searching(None);
    let mut adaptive = with_search(search);
    let adoption = at("23:50");
    let first = adaptive.update(&night(
        adoption,
        fresh("b", adoption, 0.0, Some(on(THURSDAY, "00:20"))),
    ));
    assert_eq!(first.schedule, schedule(&[("b", on(THURSDAY, "01:20"))]));
    // Past midnight the local date is Thursday, but Wednesday's plan still runs.
    let now = on(THURSDAY, "00:01");
    assert_eq!(
        adaptive.update(&night(
            now,
            fresh("b", now, 0.0, Some(on(THURSDAY, "00:20")))
        )),
        result(&[("b", on(THURSDAY, "01:20"))], 1.0, Some(adoption), None)
    );
    assert_eq!(calls_of(&calls), [adoption]);
}

#[test]
fn an_account_taken_out_of_the_plan_leaves_the_schedule_at_once_and_quietly() {
    let mut adaptive = AdaptiveSchedule::default();
    adaptive.update(&hold(at("09:30")));
    let without = |now: f64| AdaptiveInput {
        settings: settings_for(&[a()]),
        ..hold_with(now, fresh("b", now, 0.0, Some(at("10:00"))))
    };
    assert_eq!(adaptive.update(&without(at("09:35"))), nothing());
    assert_eq!(adaptive.update(&without(at("09:59"))).notice, None);
}

#[test]
fn current_leaves_out_starts_whose_time_has_come_since_the_last_update() {
    let clock = Arc::new(Mutex::new(at("09:30")));
    let read = clock.clone();
    let mut adaptive =
        AdaptiveSchedule::new(Some(Box::new(move || *read.lock().expect("clock"))), None);
    adaptive.update(&hold(at("09:30")));
    *clock.lock().expect("clock") = at("10:59");
    assert_eq!(
        adaptive.current(),
        result(&[("b", at("11:00"))], 1.0, Some(at("09:30")), None)
    );
    *clock.lock().expect("clock") = at("11:00");
    assert_eq!(adaptive.current(), nothing());
}

/// A calm day minute by minute from `wake` to the work end: work at exactly the tempo from
/// 09:00, one account at a time (the one in use until it runs out, then the one with quota
/// that resets soonest, the larger first); each window opens when the keeper starts it
/// (honouring the schedule, a tick after `phase`) or at first use. Every account is read every
/// five minutes (each a minute later than the one before) in whole percent, and the reads are
/// the samples. Returns every notice and adopted schedule.
fn calm_day(accounts: &[Account], tempo: &Tempo, wake: f64, phase: f64) -> Vec<String> {
    #[derive(Clone, Copy)]
    struct Window {
        reset: f64,
        used: f64,
    }
    let settings = settings_for(accounts);
    let context = plan_context(accounts, tempo.clone());
    let plan = day_plan(WEDNESDAY, &settings, &context, None);
    let interval = plan.interval.clone().expect("hours");
    let end = interval.end;
    let capacity = |id: &str| 100.0 * context.capacities.get(id).copied().expect("a capacity");
    let mut state: JsMap<Window> = accounts
        .iter()
        .map(|a| {
            (
                a.id.clone(),
                Window {
                    reset: 0.0,
                    used: 0.0,
                },
            )
        })
        .collect();
    let open =
        |state: &JsMap<Window>, id: &str, time: f64| state.get(id).expect("state").reset > time;
    let start = |state: &mut JsMap<Window>, id: &str, time: f64| {
        state.insert(
            id,
            Window {
                reset: time + 5.0 * HOUR,
                used: 0.0,
            },
        );
    };
    let mut usage: JsMap<AccountUsage> = JsMap::new();
    let mut samples: Vec<UsageSample> = Vec::new();
    let read = |state: &JsMap<Window>,
                usage: &mut JsMap<AccountUsage>,
                samples: &mut Vec<UsageSample>,
                account: &Account,
                time: f64| {
        let s = *state.get(&account.id).expect("state");
        let is_open = open(state, &account.id, time);
        let percent = if is_open {
            100f64.min(js::round((s.used / capacity(&account.id)) * 100.0))
        } else {
            0.0
        };
        let read = fresh(&account.id, time, percent, is_open.then_some(s.reset));
        samples.push(UsageSample {
            account_id: account.id.clone(),
            identity: usage_identity(account).expect("an identity"),
            checked_at: iso(time),
            five_hour: read.five_hour.clone(),
            seven_day: None,
        });
        usage.insert(account.id.clone(), read);
    };
    let left = |state: &JsMap<Window>, id: &str, time: f64| {
        if open(state, id, time) {
            capacity(id) - state.get(id).expect("state").used
        } else {
            capacity(id)
        }
    };
    let mut active: Option<String> = None;
    let mut adaptive = AdaptiveSchedule::default();
    let mut seen = Vec::new();
    let mut minute = wake;
    while minute < end {
        let now = minute + phase;
        for (k, account) in accounts.iter().enumerate() {
            let due = match usage.get(&account.id) {
                // First read k minutes after waking, then every five minutes; a window that
                // reset since the last read is read again at once.
                Some(u) => {
                    now - date_parse(u.checked_at.as_deref().unwrap_or("")) >= 5.0 * MINUTE
                        || date_parse(
                            u.five_hour
                                .as_ref()
                                .and_then(|w| w.resets_at.as_deref())
                                .unwrap_or(""),
                        ) <= now
                }
                None => now - wake >= k as f64 * MINUTE,
            };
            if due {
                read(&state, &mut usage, &mut samples, account, now);
            }
        }
        if accounts.iter().all(|a| usage.contains_key(&a.id)) {
            let outcome = adaptive.update(&AdaptiveInput {
                active_id: active.clone(),
                recent_samples: samples
                    .iter()
                    .filter(|sample| date_parse(&sample.checked_at) >= now - HOUR)
                    .cloned()
                    .collect(),
                tempo: tempo.clone(),
                ..input(accounts, 0.0, now, usage.clone())
            });
            let clock = iso(now);
            if let Some(notice) = &outcome.notice {
                seen.push(format!("{clock} notice {:?}", notice.kind));
            }
            if !outcome.schedule.is_empty() {
                seen.push(format!(
                    "{clock} {} f {}",
                    serde_json::to_string(&outcome.schedule).expect("json"),
                    outcome.factor
                ));
            }
            let due = plan.accounts.iter().find(|p| {
                now >= p.active_from
                    && !open(&state, &p.account_id, now)
                    && outcome.schedule.get(&p.account_id).copied().unwrap_or(0.0) <= now
            });
            if let Some(due) = due {
                start(&mut state, &due.account_id, now + 3000.0);
                let account = accounts
                    .iter()
                    .find(|a| a.id == due.account_id)
                    .expect("an account");
                read(&state, &mut usage, &mut samples, account, now + 4000.0);
            }
        }
        // The work in this minute.
        let mut need = if minute >= interval.start {
            tempo_at(tempo, &settings, minute) / 60.0
        } else {
            0.0
        };
        while need > 1e-9 {
            if active
                .as_deref()
                .is_none_or(|id| left(&state, id, minute) <= 1e-9)
            {
                let mut choices: Vec<&str> = accounts
                    .iter()
                    .map(|a| a.id.as_str())
                    .filter(|id| left(&state, id, minute) > 1e-9)
                    .collect();
                let reset = |id: &str| {
                    if open(&state, id, minute) {
                        state.get(id).expect("state").reset
                    } else {
                        f64::INFINITY
                    }
                };
                js::sort_by(&mut choices, |x, y| {
                    let by_reset = reset(x) - reset(y);
                    if by_reset != 0.0 && !by_reset.is_nan() {
                        by_reset
                    } else {
                        capacity(y) - capacity(x)
                    }
                });
                active = choices.first().map(|id| id.to_string());
                if active.is_none() {
                    break;
                }
            }
            let id = active.clone().expect("an account in use");
            if !open(&state, &id, minute) {
                start(&mut state, &id, minute);
            }
            let take = need.min(left(&state, &id, minute));
            state.get_mut(&id).expect("state").used += take;
            need -= take;
        }
        minute += MINUTE;
    }
    seen
}

#[test]
fn a_calm_day_read_in_whole_percent_adopts_nothing_and_says_nothing() {
    // Awake from 03:00: every warm-up as planned, the pace read all night.
    let three: Vec<Account> = ["p1", "p2", "p3"]
        .iter()
        .map(|id| planning_account(id, "pro"))
        .collect();
    let cases: [(&str, Vec<Account>, f64); 4] = [
        ("a and b", vec![a(), b()], 0.45),
        (
            "max and pro",
            vec![
                planning_account("max", "max5"),
                planning_account("pro", "pro"),
            ],
            0.45,
        ),
        ("max, team and pro", trio(), 0.6),
        ("three Pros", three, 0.2),
    ];
    for (label, accounts, scale) in &cases {
        for phase in [5_000.0, 40_000.0] {
            assert_eq!(
                calm_day(accounts, &busy_scaled(*scale), at("03:00"), phase),
                Vec::<String>::new(),
                "{label} ×{scale} +{} s",
                phase / 1000.0
            );
        }
    }
}
