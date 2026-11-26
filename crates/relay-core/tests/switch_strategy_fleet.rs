//! The `chooseTarget` (electron fleet-continuation) parts of tests/switch-strategy.test.ts:
//! the fleet's assertions in "automatic switching, the fleet, the suggestion and the panel
//! agree on the strategy's target" and "an account's own switch line: it is left earlier and
//! never chosen past it". Their `suggestedAccount` and ranking assertions are in
//! `shared_switch_strategy.rs`; `autoSwitchDecision` (electron auto-switch), `overviewAccounts`
//! (UI selectors) and the store schema case belong to those ports.

#[path = "common/shared_misc.rs"]
mod misc;

use misc::{random_uuid, usage_map};
use relay_core::fleet_continuation::choose_target;
use relay_core::shared::continuation_target_ranking::AUTO_SWITCH_STRATEGIES;
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountPlan, AccountPlanning, AccountUsage,
    AutoSwitchMode, AutoSwitchStrategy, RelaySettings, UsageStatus, UsageWindow, default_settings,
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
    fn chosen(&self, settings: &RelaySettings) -> Option<String> {
        let accounts = self.accounts();
        choose_target(
            &self.source,
            &accounts,
            settings,
            &self.readings,
            now(),
            None,
        )
        .map(|a| a.name.clone())
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
        assert_eq!(
            f.chosen(&settings).as_deref(),
            Some(expected(strategy.unwrap_or(AutoSwitchStrategy::Best))),
            "fleet {strategy:?}"
        );
    }
}

#[test]
fn an_accounts_own_switch_line_it_is_left_earlier_and_never_chosen_past_it() {
    let mut f = Fleet::new();
    f.alto.switch_at_percent = Some(60.0);
    // Alto is 70% used, past its own 60%: consume-first drains Cirrus (60% left) next instead.
    let settings = f.settings_for(Some(AutoSwitchStrategy::ConsumeFirst));
    assert_ne!(f.chosen(&settings).as_deref(), Some("Alto"));
}
