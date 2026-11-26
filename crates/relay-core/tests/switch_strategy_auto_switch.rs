//! Port of the `autoSwitchDecision` parts of tests/switch-strategy.test.ts: "automatic
//! switching, the fleet, the suggestion and the panel agree on the strategy's target" (prepare on
//! quit) and "an account's own switch line: it is left earlier and never chosen past it"
//! (preparing on quit at the source's own line). The ranking, suggestion and line assertions are
//! in tests/shared_switch_strategy.rs; `chooseTarget` (fleet-continuation), `overviewAccounts`
//! (UI selectors) and the store schema assertions belong to those ports. Cases with no
//! `autoSwitchDecision` part ("each strategy picks a different target from the same three
//! accounts", "the strategy and the line are saved only as whole known values") are not here.

#[path = "common/fleet_switch.rs"]
mod helpers;

use helpers::{closed_on, signed_in_account, usage_map};
use relay_core::auto_switch::auto_switch_decision;
use relay_core::shared::continuation_target_ranking::AUTO_SWITCH_STRATEGIES;
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountPlan, AccountPlanning, AccountUsage, AutoSwitchMode, AutoSwitchReason,
    AutoSwitchState, AutoSwitchStrategy, RelaySettings, UsageStatus, UsageWindow, default_settings,
};

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
    let mut account = signed_in_account(name, "personal", &at(-DAY));
    account.planning = Some(AccountPlanning {
        plan: AccountPlan::Pro,
        capacity_weight: 1.0,
    });
    account.auth.as_mut().unwrap().checked_at = at(0.0);
    account
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
    fn decide(&self, settings: &RelaySettings) -> AutoSwitchState {
        auto_switch_decision(
            settings,
            &self.accounts(),
            &closed_on(&self.source),
            &self.readings,
            now(),
            false,
            Some(true),
            None,
            false,
        )
        .state
    }
}

fn expected(strategy: AutoSwitchStrategy) -> &'static str {
    match strategy {
        AutoSwitchStrategy::Best => "Vertex",
        AutoSwitchStrategy::WeeklyFirst => "Cirrus",
        AutoSwitchStrategy::ConsumeFirst => "Alto",
    }
}

#[test]
fn automatic_switching_the_fleet_the_suggestion_and_the_panel_agree_on_the_strategys_target() {
    for strategy in std::iter::once(None).chain(AUTO_SWITCH_STRATEGIES.map(Some)) {
        let f = Fleet::new();
        let settings = f.settings_for(strategy);
        let decision = f.decide(&settings);
        let accounts = f.accounts();
        assert_eq!(
            accounts
                .iter()
                .find(|a| Some(&a.id) == decision.target_id.as_ref())
                .map(|a| a.name.as_str()),
            Some(expected(strategy.unwrap_or(AutoSwitchStrategy::Best))),
            "prepare on quit {strategy:?}"
        );
    }
}

#[test]
fn an_accounts_own_switch_line_it_is_left_earlier_and_never_chosen_past_it() {
    // A source with its own line is suggested away from before the warning threshold (90%).
    let mut early = Fleet::new();
    early.readings.insert(
        early.source.id.clone(),
        usage(&early.source, (75.0, Some(2.0 * HOUR)), (10.0, 4.0 * DAY)),
    );
    let early_settings = early.settings_for(None);
    early.source.switch_at_percent = Some(70.0);
    // Preparing on quit leaves it at 70% too, not only at a full limit.
    let decision = early.decide(&early_settings);
    assert_eq!(decision.reason, AutoSwitchReason::QuotaExhausted);
    assert_eq!(decision.target_id, Some(early.vertex.id.clone()));
    early.source.switch_at_percent = None;
    assert_eq!(
        early.decide(&early_settings).reason,
        AutoSwitchReason::QuotaAvailable
    );
}
