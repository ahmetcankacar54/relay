//! Port of tests/automatic-target-ranking.test.ts. "fleet switching and the suggestion pick the
//! account the ranking puts first" keeps its `suggestedAccount` assertions; its `chooseTarget`
//! ones belong to the electron fleet-continuation port.

#[path = "common/shared_misc.rs"]
mod helpers;

use helpers::{
    candidates, fixture_now, from_json, order, planning_account, planning_usage, random_uuid,
    usage_map,
};
use relay_core::shared::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, continuation_target_score,
    rank_continuation_targets,
};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    Account, AccountDesktop, AccountUsage, UsageStatus, UsageWindow, default_settings,
};
use relay_core::shared::usage::suggested_account;
use serde_json::json;

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 3_600_000.0;

fn now() -> f64 {
    date_parse("2026-10-13T06:00:00Z")
}

fn usage_for(account: &Account, five_hour_used: f64, seven_day_used: f64) -> AccountUsage {
    AccountUsage {
        five_hour: Some(UsageWindow::new(five_hour_used, None)),
        seven_day: Some(UsageWindow::new(seven_day_used, None)),
        ..planning_usage(account, fixture_now())
    }
}

/// `left`% of the five-hour window left, open until `resets_in` (closed without).
fn window_usage(account: &Account, left: f64, resets_in: Option<f64>) -> AccountUsage {
    AccountUsage {
        five_hour: Some(UsageWindow::new(
            100.0 - left,
            resets_in.map(|r| iso(now() + r)).as_deref(),
        )),
        seven_day: Some(UsageWindow::new(
            0.0,
            Some(&iso(now() + 3.0 * 86_400_000.0)),
        )),
        ..planning_usage(account, now())
    }
}

fn context(rate: Option<f64>) -> Option<RankingContext> {
    Some(RankingContext {
        now: now(),
        rate,
        strategy: None,
    })
}

#[test]
fn continuation_targets_weigh_both_quota_windows_by_relative_plan_capacity() {
    let pro = planning_account("pro", "pro");
    let max5 = planning_account("max5", "max5");
    let max20 = planning_account("max20", "max20");
    assert_eq!(
        continuation_target_score(&pro, Some(&usage_for(&pro, 20.0, 50.0))),
        0.5
    );
    assert_eq!(
        continuation_target_score(&max5, Some(&usage_for(&max5, 50.0, 20.0))),
        2.5
    );
    assert_eq!(
        continuation_target_score(&max20, Some(&usage_for(&max20, 20.0, 50.0))),
        10.0
    );
    assert_eq!(
        continuation_target_score(&max20, Some(&usage_for(&max20, 100.0, 0.0))),
        0.0
    );
    assert_eq!(
        continuation_target_score(&max20, Some(&usage_for(&max20, 0.0, 100.0))),
        0.0
    );
}

#[test]
fn manual_team_and_unknown_capacity_reuse_the_planners_bounded_weights() {
    for plan in ["team", "unknown"] {
        let mut account = planning_account(plan, plan);
        account.planning.as_mut().unwrap().capacity_weight = 12.0;
        assert_eq!(
            continuation_target_score(&account, Some(&usage_for(&account, 50.0, 0.0))),
            6.0
        );
        account.planning.as_mut().unwrap().capacity_weight = 200.0;
        assert_eq!(
            continuation_target_score(&account, Some(&usage_for(&account, 0.0, 0.0))),
            100.0
        );
        account.planning.as_mut().unwrap().capacity_weight = f64::NAN;
        assert_eq!(
            continuation_target_score(&account, Some(&usage_for(&account, 0.0, 0.0))),
            1.0
        );
    }
}

#[test]
fn unknown_or_invalid_live_quotas_score_zero_rather_than_inferring_capacity() {
    let account = planning_account("max", "max20");
    assert_eq!(continuation_target_score(&account, None), 0.0);
    let mut without_five_hour = usage_for(&account, 0.0, 0.0);
    without_five_hour.five_hour = None;
    assert_eq!(
        continuation_target_score(&account, Some(&without_five_hour)),
        0.0
    );
    // A seat that reports no weekly window is scored by its five-hour window alone.
    let mut without_weekly = usage_for(&account, 40.0, 0.0);
    without_weekly.seven_day = None;
    assert_eq!(
        continuation_target_score(&account, Some(&without_weekly)),
        continuation_target_score(&account, Some(&usage_for(&account, 40.0, 40.0)))
    );
    for five_hour in [true, false] {
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 100.1] {
            let mut usage = usage_for(&account, 0.0, 0.0);
            let window = if five_hour {
                &mut usage.five_hour
            } else {
                &mut usage.seven_day
            };
            window.as_mut().unwrap().used_percent = invalid;
            assert_eq!(continuation_target_score(&account, Some(&usage)), 0.0);
        }
    }
    let mut invalids = vec![
        AccountUsage {
            stale: true,
            ..usage_for(&account, 0.0, 0.0)
        },
        AccountUsage {
            account_id: "another-account".into(),
            ..usage_for(&account, 0.0, 0.0)
        },
    ];
    for status in [UsageStatus::Idle, UsageStatus::Loading, UsageStatus::Error] {
        invalids.push(AccountUsage {
            status,
            ..usage_for(&account, 0.0, 0.0)
        });
    }
    for invalid in &invalids {
        assert_eq!(continuation_target_score(&account, Some(invalid)), 0.0);
    }
    let historical: AccountUsage = from_json(json!({
        "accountId": account.id,
        "status": "error",
        "stale": true,
        "lastKnownResets": {
            "fiveHour": { "checkedAt": "2026-10-13T00:00:00Z", "resetsAt": "2026-10-13T05:00:00Z" },
        },
    }));
    assert_eq!(continuation_target_score(&account, Some(&historical)), 0.0);
}

#[test]
fn ranking_is_descending_capacity_then_remaining_quota_then_account_id() {
    let larger = planning_account("larger", "max20");
    let smaller = planning_account("smaller", "max5");
    let a = planning_account("a", "pro");
    let b = planning_account("b", "pro");
    let pairs = [
        (b.clone(), usage_for(&b, 0.0, 0.0)),
        (smaller.clone(), usage_for(&smaller, 80.0, 0.0)),
        (larger.clone(), usage_for(&larger, 50.0, 0.0)),
        (a.clone(), usage_for(&a, 0.0, 0.0)),
    ];
    let list = candidates(&pairs);
    let ranked = rank_continuation_targets(&list, None);
    let ids: Vec<&str> = ranked.iter().map(|r| r.account.id.as_str()).collect();
    assert_eq!(ids, ["larger", "a", "b", "smaller"]);
    assert_eq!(
        ranked
            .iter()
            .map(|r| [r.score, r.remaining_percent])
            .collect::<Vec<_>>(),
        [[10.0, 50.0], [1.0, 100.0], [1.0, 100.0], [1.0, 20.0]]
    );
    assert_eq!(
        list.iter()
            .map(|c| c.account.id.as_str())
            .collect::<Vec<_>>(),
        ["b", "smaller", "larger", "a"]
    );
    assert_eq!(rank_continuation_targets(&[], None), []);
    let reversed: Vec<ContinuationTargetCandidate> = list.iter().rev().cloned().collect();
    assert_eq!(
        rank_continuation_targets(&reversed, None)
            .iter()
            .map(|r| r.account.id.as_str())
            .collect::<Vec<_>>(),
        ids
    );
}

#[test]
fn with_the_tempo_the_open_window_that_resets_soonest_leads_when_it_holds_half_an_hour() {
    let max5 = planning_account("max5", "max5");
    let pro = planning_account("pro", "pro");
    let pairs = [
        (max5.clone(), window_usage(&max5, 50.0, Some(4.0 * HOUR))),
        (pro.clone(), window_usage(&pro, 80.0, Some(HOUR))),
    ];
    let list = candidates(&pairs);
    // Without a context: capacity × remaining (250 vs 80 Pro units).
    assert_eq!(
        order(&rank_continuation_targets(&list, None)),
        ["max5", "pro"]
    );
    // 80 Pro units cover half an hour at 60 units/h and are lost at the reset.
    assert_eq!(
        order(&rank_continuation_targets(&list, context(Some(60.0)))),
        ["pro", "max5"]
    );
}

#[test]
fn accounts_short_of_half_an_hour_are_skipped_and_closed_windows_follow_every_open_one() {
    let short = planning_account("short", "pro");
    let max5 = planning_account("max5", "max5");
    let late = planning_account("late", "pro");
    let max20 = planning_account("max20", "max20");
    let closed_pro = planning_account("closed-pro", "pro");
    let expired = planning_account("expired", "pro");
    let tiny = planning_account("tiny", "max5");
    let pairs = [
        (max20.clone(), window_usage(&max20, 100.0, None)),
        (closed_pro.clone(), window_usage(&closed_pro, 100.0, None)),
        (late.clone(), window_usage(&late, 90.0, Some(4.0 * HOUR))),
        // 20 Pro units < 30 (half an hour at 60/h), although it resets first.
        (
            short.clone(),
            window_usage(&short, 20.0, Some(10.0 * MINUTE)),
        ),
        (max5.clone(), window_usage(&max5, 40.0, Some(3.0 * HOUR))),
        // A reset already in the past is a closed window.
        (expired.clone(), window_usage(&expired, 60.0, Some(-MINUTE))),
        // 25 Pro units: short as well.
        (tiny.clone(), window_usage(&tiny, 5.0, Some(2.0 * HOUR))),
    ];
    assert_eq!(
        order(&rank_continuation_targets(
            &candidates(&pairs),
            context(Some(60.0))
        )),
        // Open by reset; closed by capacity × remaining; the short ones last by capacity × remaining.
        [
            "max5",
            "late",
            "max20",
            "closed-pro",
            "expired",
            "tiny",
            "short"
        ]
    );
}

#[test]
fn when_nobody_holds_half_an_hour_the_order_is_capacity_x_remaining() {
    let short = planning_account("short", "pro");
    let max5 = planning_account("max5", "max5");
    let full = planning_account("full", "pro");
    let pairs = [
        (
            short.clone(),
            window_usage(&short, 20.0, Some(10.0 * MINUTE)),
        ),
        (full.clone(), window_usage(&full, 100.0, None)),
        (max5.clone(), window_usage(&max5, 40.0, Some(3.0 * HOUR))),
    ];
    let list = candidates(&pairs);
    // 600 units/h needs 300 left: 200, 100 and 20 all fall short.
    let ranked = rank_continuation_targets(&list, context(Some(600.0)));
    assert_eq!(order(&ranked), ["max5", "full", "short"]);
    assert_eq!(ranked, rank_continuation_targets(&list, None));
}

#[test]
fn without_a_tempo_an_account_needs_10_left_to_lead() {
    let max20 = planning_account("max20", "max20");
    let pro = planning_account("pro", "pro");
    let closed = planning_account("closed", "pro");
    let pairs = [
        // 8% of Max 20× is 160 Pro units and resets first, but 8% < 10%.
        (max20.clone(), window_usage(&max20, 8.0, Some(5.0 * MINUTE))),
        (pro.clone(), window_usage(&pro, 10.0, Some(4.0 * HOUR))),
    ];
    let list = candidates(&pairs);
    assert_eq!(
        order(&rank_continuation_targets(&list, None)),
        ["max20", "pro"]
    );
    assert_eq!(
        order(&rank_continuation_targets(&list, context(None))),
        ["pro", "max20"]
    );
    // A closed window with 10% left still leads over 8% in an open one.
    let closed_pair = [
        pairs[0].clone(),
        (closed.clone(), window_usage(&closed, 10.0, None)),
    ];
    assert_eq!(
        order(&rank_continuation_targets(
            &candidates(&closed_pair),
            context(None)
        )),
        ["closed", "max20"]
    );
}

#[test]
fn a_zero_or_invalid_tempo_behaves_like_no_tempo() {
    let max20 = planning_account("max20", "max20");
    let pro = planning_account("pro", "pro");
    let max5 = planning_account("max5", "max5");
    let pairs = [
        (max20.clone(), window_usage(&max20, 8.0, Some(5.0 * MINUTE))),
        (max5.clone(), window_usage(&max5, 40.0, Some(3.0 * HOUR))),
        (pro.clone(), window_usage(&pro, 10.0, Some(30.0 * MINUTE))),
    ];
    let list = candidates(&pairs);
    let expected = rank_continuation_targets(&list, context(None));
    assert_eq!(order(&expected), ["pro", "max5", "max20"]);
    for rate in [0.0, -5.0, f64::NAN] {
        assert_eq!(
            rank_continuation_targets(&list, context(Some(rate))),
            expected
        );
    }
}

/// An account Claude Desktop is signed in to, as the continuation and suggestion checks require.
fn enrolled_account(name: &str, plan: &str) -> Account {
    let account = planning_account(&random_uuid(), plan);
    let (account_uuid, org_id) = (random_uuid(), random_uuid());
    let mut auth = account.auth.clone().unwrap();
    auth.account_uuid = Some(account_uuid.clone());
    auth.org_id = Some(org_id.clone());
    Account {
        name: name.into(),
        desktop: Some(AccountDesktop {
            account_uuid,
            org_id,
            saved_at: iso(now()),
            ..Default::default()
        }),
        auth: Some(auth),
        ..account
    }
}

#[test]
fn fleet_switching_and_the_suggestion_pick_the_account_the_ranking_puts_first() {
    let source = enrolled_account("source", "max5");
    let max5 = enrolled_account("max5", "max5");
    let pro = enrolled_account("pro", "pro");
    let short = enrolled_account("short", "pro");
    let max20 = enrolled_account("max20", "max20");
    let accounts = [
        source.clone(),
        max5.clone(),
        pro.clone(),
        short.clone(),
        max20.clone(),
    ];
    let usage = usage_map([
        window_usage(&source, 5.0, Some(2.0 * HOUR)),
        window_usage(&max5, 50.0, Some(4.0 * HOUR)),
        window_usage(&pro, 80.0, Some(HOUR)),
        window_usage(&short, 20.0, Some(10.0 * MINUTE)),
        window_usage(&max20, 100.0, None),
    ]);
    let list: Vec<ContinuationTargetCandidate> = accounts
        .iter()
        .filter(|a| a.id != source.id)
        .map(|account| ContinuationTargetCandidate {
            account,
            usage: usage.get(&account.id),
        })
        .collect();
    let settings = default_settings();
    let firsts: Vec<String> = [None, Some(60.0), Some(400.0)]
        .into_iter()
        .map(|rate| {
            let ranked = rank_continuation_targets(&list, context(rate))[0].account;
            assert_eq!(
                suggested_account(Some(&source), &accounts, &usage, &settings, now(), rate),
                Some(ranked)
            );
            ranked.name.clone()
        })
        .collect();
    // 10% left; 30 Pro units at 60/h; 200 Pro units at 400/h.
    assert_eq!(firsts, ["short", "pro", "max5"]);
}

#[test]
fn the_weekly_window_binds_the_threshold_when_it_has_less_left() {
    let max5 = planning_account("max5", "max5");
    let pro = planning_account("pro", "pro");
    // 80% of the five-hour window but only 5% of the week: 25 Pro units.
    let weekly_short = AccountUsage {
        seven_day: Some(UsageWindow::new(95.0, Some(&iso(now() + 86_400_000.0)))),
        ..window_usage(&max5, 80.0, Some(10.0 * MINUTE))
    };
    let pairs = [
        (max5.clone(), weekly_short.clone()),
        (pro.clone(), window_usage(&pro, 50.0, Some(4.0 * HOUR))),
    ];
    for rate in [None, Some(60.0)] {
        assert_eq!(
            order(&rank_continuation_targets(
                &candidates(&pairs),
                context(rate)
            )),
            ["pro", "max5"]
        );
    }
    // Its five-hour window alone would have led.
    let five_hour_only = [
        (
            max5.clone(),
            AccountUsage {
                seven_day: None,
                ..weekly_short
            },
        ),
        pairs[1].clone(),
    ];
    assert_eq!(
        order(&rank_continuation_targets(
            &candidates(&five_hour_only),
            context(Some(60.0))
        )),
        ["max5", "pro"]
    );
}

#[test]
fn a_weekly_bound_account_is_not_urgent_it_ranks_with_the_closed_windows() {
    let max5 = planning_account("max5", "max5");
    let max20 = planning_account("max20", "max20");
    let pro = planning_account("pro", "pro");
    // Its five-hour window is untouched and resets in an hour, but 8% of the week is left: 40 Pro
    // units, enough for half an hour at 60/h.
    let weekly_bound = |weekly_reset: Option<f64>| AccountUsage {
        seven_day: Some(UsageWindow::new(
            92.0,
            weekly_reset.map(|r| iso(now() + r)).as_deref(),
        )),
        ..window_usage(&max5, 100.0, Some(HOUR))
    };
    let full = (max20.clone(), window_usage(&max20, 100.0, None));
    let open = (pro.clone(), window_usage(&pro, 80.0, Some(4.0 * HOUR)));
    // Its quota is not lost for days, whether or not the weekly reset is known: after every open
    // window, then capacity × remaining against the closed ones, so the full Max 20× goes first.
    for weekly_reset in [None, Some(3.0 * 86_400_000.0)] {
        let pairs = [
            (max5.clone(), weekly_bound(weekly_reset)),
            full.clone(),
            open.clone(),
        ];
        assert_eq!(
            order(&rank_continuation_targets(
                &candidates(&pairs),
                context(Some(60.0))
            )),
            ["pro", "max20", "max5"],
            "weekly reset in {weekly_reset:?}"
        );
    }
    // A closed five-hour window stays with the closed ones, even when its weekly window has less
    // left: by capacity × remaining.
    let closed_pro = (
        pro.clone(),
        AccountUsage {
            seven_day: Some(UsageWindow::new(50.0, Some(&iso(now() + HOUR)))),
            ..window_usage(&pro, 100.0, None)
        },
    );
    assert_eq!(
        order(&rank_continuation_targets(
            &candidates(&[closed_pro, full]),
            context(Some(60.0))
        )),
        ["max20", "pro"]
    );
    // When the five-hour window has less left, it binds as before.
    let pairs = [
        open,
        (
            max5.clone(),
            AccountUsage {
                seven_day: Some(UsageWindow::new(50.0, None)),
                ..window_usage(&max5, 20.0, Some(HOUR))
            },
        ),
    ];
    assert_eq!(
        order(&rank_continuation_targets(
            &candidates(&pairs),
            context(Some(60.0))
        )),
        ["max5", "pro"]
    );
}
