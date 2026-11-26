//! The `chooseTarget` (electron fleet-continuation) part of
//! tests/automatic-target-ranking.test.ts: the `chooseTarget` assertions of "fleet switching and
//! the suggestion pick the account the ranking puts first". The file's other cases, and that
//! case's `suggestedAccount` assertions, are in `shared_automatic_target_ranking.rs`.

#[path = "common/shared_misc.rs"]
mod misc;

use misc::{planning_account, planning_usage, random_uuid, usage_map};
use relay_core::fleet_continuation::choose_target;
use relay_core::shared::continuation_target_ranking::{
    ContinuationTargetCandidate, RankingContext, rank_continuation_targets,
};
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    Account, AccountDesktop, AccountUsage, UsageWindow, default_settings,
};

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 3_600_000.0;

fn now() -> f64 {
    date_parse("2026-10-13T06:00:00Z")
}

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

/// An account Claude Desktop is signed in to, as the continuation checks require.
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
    let candidates: Vec<ContinuationTargetCandidate> = accounts
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
            let context = RankingContext {
                now: now(),
                rate,
                strategy: None,
            };
            let ranked = rank_continuation_targets(&candidates, Some(context))[0].account;
            assert_eq!(
                choose_target(&source, &accounts, &settings, &usage, now(), rate),
                Some(ranked)
            );
            ranked.name.clone()
        })
        .collect();
    // 10% left; 30 Pro units at 60/h; 200 Pro units at 400/h.
    assert_eq!(firsts, ["short", "pro", "max5"]);
}
