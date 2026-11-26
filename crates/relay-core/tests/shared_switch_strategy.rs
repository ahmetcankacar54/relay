//! Port of the `shared/continuation-target-ranking` and `shared/usage` parts of
//! tests/switch-strategy.test.ts. The `chooseTarget` (electron fleet-continuation),
//! `autoSwitchDecision` (electron auto-switch), `overviewAccounts` (UI selectors) and store
//! schema assertions belong to those ports and are left out of the mixed cases.

#[path = "common/shared_misc.rs"]
mod helpers;

use helpers::{order, random_uuid, usage_map};
use relay_core::shared::continuation_target_ranking::{
    AUTO_SWITCH_STRATEGIES, ContinuationTargetCandidate, RankingContext, rank_continuation_targets,
    switch_at_percent,
};
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountPlan, AccountPlanning, AccountUsage,
    AutoSwitchMode, AutoSwitchStrategy, RelaySettings, UsageStatus, UsageWindow, default_settings,
};
use relay_core::shared::usage::suggested_account;

const HOUR: f64 = 3_600_000.0;
const DAY: f64 = 86_400_000.0;

fn now() -> f64 {
    date_parse("2026-10-13T06:00:00Z")
}
fn at(ms: f64) -> String {
    iso(now() + ms)
}

/// A Pro account the Claude app is signed in to, as every automatic switch requires.
fn account(name: &str) -> Account {
    let (account_uuid, org_id) = (random_uuid(), random_uuid());
    Account {
        created_at: at(-DAY),
        color: "olive".into(),
        group: "personal".into(),
        planning: Some(AccountPlanning {
            plan: AccountPlan::Pro,
            capacity_weight: 1.0,
        }),
        desktop: Some(AccountDesktop {
            account_uuid: account_uuid.clone(),
            org_id: org_id.clone(),
            saved_at: at(-DAY),
            ..Default::default()
        }),
        auth: Some(AccountAuth {
            logged_in: true,
            account_uuid: Some(account_uuid),
            org_id: Some(org_id),
            checked_at: at(0.0),
            ..Default::default()
        }),
        ..Account::new(random_uuid(), name)
    }
}

fn usage(account: &Account, five_hour: (f64, Option<f64>), week: (f64, f64)) -> AccountUsage {
    AccountUsage {
        stale: false,
        checked_at: Some(at(0.0)),
        five_hour: Some(UsageWindow::new(
            five_hour.0,
            five_hour.1.map(at).as_deref(),
        )),
        seven_day: Some(UsageWindow::new(week.0, Some(&at(week.1)))),
        ..AccountUsage::new(account.id.clone(), UsageStatus::Ready)
    }
}

/// Three accounts that each lead under one strategy: Alto is the most used (30% left, its 5-hour
/// period resets in 4 h), Vertex's open 5-hour period resets soonest (1 h), and Cirrus has a
/// closed 5-hour period but its week resets first (1 day).
struct Fleet {
    source: Account,
    alto: Account,
    vertex: Account,
    cirrus: Account,
    readings: JsMap<AccountUsage>,
}

impl Fleet {
    fn new() -> Self {
        let (source, alto, vertex, cirrus) = (
            account("Source"),
            account("Alto"),
            account("Vertex"),
            account("Cirrus"),
        );
        let readings = usage_map([
            usage(&source, (100.0, Some(2.0 * HOUR)), (50.0, 4.0 * DAY)),
            usage(&alto, (70.0, Some(4.0 * HOUR)), (20.0, 6.0 * DAY)),
            usage(&vertex, (20.0, Some(HOUR)), (10.0, 5.0 * DAY)),
            usage(&cirrus, (0.0, None), (40.0, DAY)),
        ]);
        Fleet {
            source,
            alto,
            vertex,
            cirrus,
            readings,
        }
    }
    fn accounts(&self) -> Vec<Account> {
        vec![
            self.source.clone(),
            self.alto.clone(),
            self.vertex.clone(),
            self.cirrus.clone(),
        ]
    }
    fn settings_for(&self, strategy: Option<AutoSwitchStrategy>) -> RelaySettings {
        RelaySettings {
            auto_switch_strategy: strategy,
            auto_switch_mode: AutoSwitchMode::AfterExit,
            auto_switch_accounts: self.accounts().iter().map(|a| a.id.clone()).collect(),
            ..default_settings()
        }
    }
}

fn expected(strategy: AutoSwitchStrategy) -> &'static str {
    match strategy {
        AutoSwitchStrategy::Best => "Vertex",
        AutoSwitchStrategy::WeeklyFirst => "Cirrus",
        AutoSwitchStrategy::ConsumeFirst => "Alto",
    }
}

fn targets<'a>(
    accounts: &'a [Account],
    readings: &'a JsMap<AccountUsage>,
) -> Vec<ContinuationTargetCandidate<'a>> {
    accounts
        .iter()
        .map(|account| ContinuationTargetCandidate {
            account,
            usage: readings.get(&account.id),
        })
        .collect()
}

#[test]
fn each_strategy_picks_a_different_target_from_the_same_three_accounts() {
    let f = Fleet::new();
    let accounts = [f.alto.clone(), f.vertex.clone(), f.cirrus.clone()];
    let list = targets(&accounts, &f.readings);
    for rate in [None, Some(60.0)] {
        for strategy in AUTO_SWITCH_STRATEGIES {
            let context = RankingContext {
                now: now(),
                rate,
                strategy: Some(strategy),
            };
            assert_eq!(
                rank_continuation_targets(&list, Some(context))[0]
                    .account
                    .name,
                expected(strategy),
                "{strategy:?} at {rate:?} tempo"
            );
        }
    }
    // No strategy is "best", today's rule: the open 5-hour period that resets soonest.
    let context = RankingContext {
        now: now(),
        rate: None,
        strategy: None,
    };
    assert_eq!(
        rank_continuation_targets(&list, Some(context))[0]
            .account
            .name,
        "Vertex"
    );
    // Without a context there is no strategy: capacity × remaining, as before (Vertex has 80% left).
    assert_eq!(
        order(&rank_continuation_targets(&list, None)),
        ["Vertex", "Cirrus", "Alto"]
    );
}

#[test]
fn automatic_switching_the_fleet_the_suggestion_and_the_panel_agree_on_the_strategys_target() {
    for strategy in std::iter::once(None).chain(AUTO_SWITCH_STRATEGIES.map(Some)) {
        let f = Fleet::new();
        let settings = f.settings_for(strategy);
        let accounts = f.accounts();
        assert_eq!(
            suggested_account(
                Some(&f.source),
                &accounts,
                &f.readings,
                &settings,
                now(),
                None
            )
            .map(|a| a.name.as_str()),
            Some(expected(strategy.unwrap_or(AutoSwitchStrategy::Best))),
            "suggestion {strategy:?}"
        );
    }
}

#[test]
fn an_accounts_own_switch_line_it_is_left_earlier_and_never_chosen_past_it() {
    let mut f = Fleet::new();
    assert_eq!(switch_at_percent(&f.alto, 90.0), 90.0);
    f.alto.switch_at_percent = Some(60.0);
    assert_eq!(switch_at_percent(&f.alto, 90.0), 60.0);
    // Alto is 70% used, past its own 60%: consume-first drains Cirrus (60% left) next instead.
    let settings = f.settings_for(Some(AutoSwitchStrategy::ConsumeFirst));
    let three = [f.alto.clone(), f.vertex.clone(), f.cirrus.clone()];
    let context = RankingContext {
        now: now(),
        rate: None,
        strategy: Some(AutoSwitchStrategy::ConsumeFirst),
    };
    let ranked = rank_continuation_targets(&targets(&three, &f.readings), Some(context));
    assert_eq!(ranked[0].account.name, "Cirrus");
    assert_eq!(ranked.last().unwrap().account.name, "Alto");
    let accounts = f.accounts();
    assert_ne!(
        suggested_account(
            Some(&f.source),
            &accounts,
            &f.readings,
            &settings,
            now(),
            None
        )
        .map(|a| a.name.as_str()),
        Some("Alto")
    );
    // A source with its own line is suggested away from before the warning threshold (90%).
    let mut early = Fleet::new();
    early.readings.insert(
        early.source.id.clone(),
        usage(&early.source, (75.0, Some(2.0 * HOUR)), (10.0, 4.0 * DAY)),
    );
    let early_settings = early.settings_for(None);
    let accounts = early.accounts();
    assert_eq!(
        suggested_account(
            Some(&early.source),
            &accounts,
            &early.readings,
            &early_settings,
            now(),
            None
        ),
        None
    );
    early.source.switch_at_percent = Some(70.0);
    let accounts = early.accounts();
    assert_eq!(
        suggested_account(
            Some(&early.source),
            &accounts,
            &early.readings,
            &early_settings,
            now(),
            None
        )
        .map(|a| a.name.as_str()),
        Some("Vertex")
    );
}

#[test]
fn the_strategy_and_the_line_are_saved_only_as_whole_known_values() {
    // A saved line outside 50–100 (a hand-edited file) falls back to the rule's own.
    let hand_edited = Account {
        switch_at_percent: Some(20.0),
        ..Account::new("a", "a")
    };
    assert_eq!(switch_at_percent(&hand_edited, 90.0), 90.0);
    assert_eq!(
        default_settings().auto_switch_strategy,
        Some(AutoSwitchStrategy::Best)
    );
}
