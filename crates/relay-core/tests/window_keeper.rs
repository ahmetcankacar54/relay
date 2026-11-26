//! Port of `tests/window-keeper.test.ts`. The TS deps are async; here they block. "A failing
//! re-plan" breaks the TS update with `null` samples; here the injected search panics.

#[path = "common/planning.rs"]
mod helpers;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use helpers::{ZONE, flat_tempo, hours, planning_account, team_account, wall};
use relay_core::adaptive_schedule::{AdaptiveNoticeKind, Search};
use relay_core::shared::day_plan::{DayPlan, day_plan, plan_context};
use relay_core::shared::tempo::{Tempo, TempoDays, TempoSource, preset_tempo};
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountUsage, KeeperAccountState, KeeperAdaptation, KeeperNext, PlanningSettings,
    ScheduledStart, TempoChoice, UsageIssue, UsageStatus, UsageWindow, WindowAttemptStatus,
    default_planning_settings,
};
use relay_core::shared::usage_statistics::{UsageSample, usage_identity};
use relay_core::window_keeper::{
    AdaptedNotice, KEEPER_COOLDOWN_MS, KEEPER_DAILY_LIMIT, KEEPER_STOP_RETRY_MS, KeeperDeps,
    KeeperState, WindowKeeper, keeper_decision,
};
use serde_json::json;
use uuid::Uuid;

const WEDNESDAY: &str = "2026-10-14";

fn at(clock: &str) -> f64 {
    wall("2026-10-13", clock, ZONE)
}
fn on(date: &str, clock: &str) -> f64 {
    wall(date, clock, ZONE)
}
fn account(name: &str) -> Account {
    helpers::from_json(json!({
        "id": Uuid::new_v4().to_string(),
        "name": name,
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        "createdAt": iso(at("00:00")),
        "auth": {
            "loggedIn": true,
            "accountUuid": Uuid::new_v4().to_string(),
            "orgId": Uuid::new_v4().to_string(),
            "checkedAt": iso(at("00:00")),
        },
    }))
}

/// Everything the test deps read and record.
struct World {
    now: f64,
    settings: PlanningSettings,
    accounts: Vec<Account>,
    usage: JsMap<AccountUsage>,
    tempo: Tempo,
    starts: Vec<String>,
    refreshes: Vec<String>,
    notes: Vec<String>,
    fail: Option<String>,
    refresh_fails: bool,
    blocked: bool,
    busy: Vec<String>,
    samples: Vec<UsageSample>,
    active_id: Option<String>,
    adapted: Vec<AdaptedNotice>,
    /// Refreshes, starts and notices in order, when tracked.
    order: Option<Vec<String>>,
    state_fails: bool,
    adapted_fails: bool,
    told: u32,
}

impl World {
    fn fresh(&self, a: &Account, resets_at: Option<f64>) -> AccountUsage {
        let mut usage = AccountUsage::new(a.id.clone(), UsageStatus::Ready);
        usage.checked_at = Some(iso(self.now - 60_000.0));
        usage.five_hour = Some(UsageWindow::new(
            if resets_at.is_some() { 10.0 } else { 0.0 },
            resets_at.map(iso).as_deref(),
        ));
        usage
    }
}

#[derive(Clone)]
struct Deps(Arc<Mutex<World>>);

impl Deps {
    fn world(&self) -> MutexGuard<'_, World> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl KeeperDeps for Deps {
    fn now(&self) -> f64 {
        self.world().now
    }
    fn state(&self) -> KeeperState {
        let w = self.world();
        assert!(!w.state_fails, "the day plan is not needed");
        KeeperState {
            settings: w.settings.clone(),
            accounts: w.accounts.clone(),
            usage: w.usage.clone(),
            tempo: w.tempo.clone(),
            blocked: w.blocked,
            busy_account_ids: w.busy.clone(),
            recent_samples: w.samples.clone(),
            active_id: w.active_id.clone(),
        }
    }
    fn refresh(&self, id: &str) -> Result<(), String> {
        let mut w = self.world();
        if let Some(order) = &mut w.order {
            order.push(format!("refresh {id}"));
        }
        w.refreshes.push(id.into());
        if w.refresh_fails {
            return Err("offline".into());
        }
        let a = w
            .accounts
            .iter()
            .find(|x| x.id == id)
            .expect("an account")
            .clone();
        let reset = date_parse(
            w.usage
                .get(id)
                .and_then(|u| u.five_hour.as_ref())
                .and_then(|f| f.resets_at.as_deref())
                .unwrap_or(""),
        );
        let usage = w.fresh(&a, (reset != 0.0 && !reset.is_nan()).then_some(reset));
        w.usage.insert(id, usage);
        Ok(())
    }
    fn refresh_after_start(&self, id: &str) -> Result<AccountUsage, String> {
        let mut w = self.world();
        let a = w
            .accounts
            .iter()
            .find(|x| x.id == id)
            .expect("an account")
            .clone();
        let usage = w.fresh(&a, Some(w.now + 5.0 * 3_600_000.0));
        w.usage.insert(id, usage.clone());
        Ok(usage)
    }
    fn start(&self, a: &Account) -> Result<(), String> {
        let mut w = self.world();
        if let Some(order) = &mut w.order {
            order.push(format!("start {}", a.id));
        }
        w.starts.push(a.id.clone());
        match &w.fail {
            Some(reason) => Err(reason.clone()),
            None => Ok(()),
        }
    }
    fn notify(&self, a: &Account, reason: &str) {
        self.world().notes.push(format!("{}:{reason}", a.name));
    }
    fn adapted(&self, notice: &AdaptedNotice) -> Result<(), String> {
        let mut w = self.world();
        if let Some(order) = &mut w.order {
            let kind = match notice.kind {
                AdaptiveNoticeKind::Updated => "updated",
                AdaptiveNoticeKind::Normal => "normal",
            };
            order.push(format!("adapted {kind}"));
        }
        if w.adapted_fails {
            return Err("notifications unavailable".into());
        }
        w.adapted.push(notice.clone());
        Ok(())
    }
    fn changed(&self) {
        self.world().told += 1;
    }
}

struct Fixture {
    directory: tempfile::TempDir,
    deps: Deps,
}

impl Fixture {
    fn new(accounts: Vec<Account>) -> Self {
        let mut world = World {
            now: at("10:00"),
            settings: PlanningSettings {
                auto_start: true,
                time_zone: ZONE.into(),
                weekday: hours(true, "09:00", "21:00"),
                weekend: hours(true, "09:00", "21:00"),
                accounts: helpers::planned_accounts(&accounts),
                ..default_planning_settings()
            },
            accounts: Vec::new(),
            usage: JsMap::new(),
            tempo: preset_tempo(
                TempoChoice::Medium,
                TempoSource::Default,
                TempoDays::default(),
            ),
            starts: Vec::new(),
            refreshes: Vec::new(),
            notes: Vec::new(),
            fail: None,
            refresh_fails: false,
            blocked: false,
            busy: Vec::new(),
            samples: Vec::new(),
            active_id: None,
            adapted: Vec::new(),
            order: None,
            state_fails: false,
            adapted_fails: false,
            told: 0,
        };
        for a in &accounts {
            let usage = world.fresh(a, None);
            world.usage.insert(a.id.clone(), usage);
        }
        world.accounts = accounts;
        Fixture {
            directory: tempfile::Builder::new()
                .prefix("relay-keeper-")
                .tempdir()
                .expect("a temp dir"),
            deps: Deps(Arc::new(Mutex::new(world))),
        }
    }
    fn single() -> Self {
        Self::new(vec![account("A")])
    }
    fn world(&self) -> MutexGuard<'_, World> {
        self.deps.world()
    }
    fn keeper(&self) -> WindowKeeper {
        WindowKeeper::new(self.directory.path(), Arc::new(self.deps.clone())).expect("a keeper")
    }
    fn keeper_with(&self, search: Search) -> WindowKeeper {
        WindowKeeper::with_search(
            self.directory.path(),
            Arc::new(self.deps.clone()),
            Some(search),
        )
        .expect("a keeper")
    }
    fn file(&self) -> PathBuf {
        self.directory.path().join("attempts.json")
    }
    fn id(&self, index: usize) -> String {
        self.world().accounts[index].id.clone()
    }
    fn fresh(&self, index: usize, resets_at: Option<f64>) -> AccountUsage {
        let w = self.world();
        w.fresh(&w.accounts[index], resets_at)
    }
    /// Today's plan as the keeper sees it, with the state's tempo.
    fn plan(&self) -> DayPlan {
        let w = self.world();
        day_plan(
            "2026-10-13",
            &w.settings,
            &plan_context(&w.accounts, w.tempo.clone()),
            None,
        )
    }
    fn identity_key(&self, index: usize) -> String {
        let w = self.world();
        let auth = w.accounts[index].auth.as_ref().expect("auth");
        format!(
            "{}:{}",
            auth.account_uuid.as_deref().unwrap_or(""),
            auth.org_id.as_deref().unwrap_or("")
        )
    }
}

fn tick(keeper: &WindowKeeper) {
    keeper.tick().expect("a tick");
}

#[test]
fn off_and_outside_work_hours_never_start() {
    let f = Fixture::single();
    f.world().settings.auto_start = false;
    let keeper = f.keeper();
    tick(&keeper);
    assert_eq!(keeper.snapshot().accounts[0].state, KeeperAccountState::Off);
    {
        let mut w = f.world();
        w.settings.auto_start = true;
        w.now = at("05:00");
    }
    tick(&keeper);
    let status = keeper.snapshot().accounts[0].clone();
    assert_eq!(status.state, KeeperAccountState::Outside);
    let first = f.plan().accounts[0].first_start;
    assert!(first > f.world().now);
    assert_eq!(status.next_start_at, Some(iso(first)));
    assert!(f.world().starts.is_empty());
}

#[test]
fn a_due_account_is_started_once_and_verified_an_active_window_is_left_alone() {
    let f = Fixture::single();
    let keeper = f.keeper();
    tick(&keeper);
    let a = f.id(0);
    assert_eq!(f.world().starts, [a]);
    let snapshot = keeper.snapshot();
    assert_eq!(snapshot.attempts[0].status, WindowAttemptStatus::Verified);
    assert_eq!(snapshot.accounts[0].state, KeeperAccountState::Active);
    // At the planned pace with nothing moved there is no adaptation to show.
    assert_eq!(snapshot.adaptation, None);
    assert!(f.world().adapted.is_empty());
    tick(&keeper);
    assert_eq!(f.world().starts.len(), 1);
}

#[test]
fn the_recent_attempts_match_the_snapshot_s_without_reading_the_state() {
    let f = Fixture::single();
    let keeper = f.keeper();
    tick(&keeper);
    let expected = keeper.snapshot().attempts;
    assert_eq!(expected.len(), 1);
    f.world().state_fails = true;
    assert_eq!(keeper.recent_attempts(), expected);
    // A copy: the caller cannot change the keeper's log.
    keeper.recent_attempts()[0].status = WindowAttemptStatus::Failed;
    assert_eq!(keeper.recent_attempts()[0].status, expected[0].status);
}

#[test]
fn stale_usage_is_refreshed_before_deciding_a_failing_refresh_waits_without_starting() {
    let f = Fixture::single();
    let a = f.id(0);
    {
        let mut w = f.world();
        let checked = iso(w.now - 10.0 * 60_000.0);
        w.usage.get_mut(&a).expect("usage").checked_at = Some(checked);
        w.refresh_fails = true;
    }
    let keeper = f.keeper();
    tick(&keeper);
    assert_eq!(f.world().refreshes, std::slice::from_ref(&a));
    assert!(f.world().starts.is_empty());
    assert_eq!(
        keeper.snapshot().accounts[0].reason.as_deref(),
        Some("usage-stale")
    );
    f.world().refresh_fails = false;
    tick(&keeper);
    assert_eq!(f.world().starts, [a]);
}

#[test]
fn a_failure_is_reported_once_an_hour_and_retried_only_after_the_cooldown() {
    let f = Fixture::single();
    f.world().fail = Some("routine-request-failed".into());
    let keeper = f.keeper();
    tick(&keeper);
    assert_eq!(
        keeper.snapshot().attempts[0].status,
        WindowAttemptStatus::Failed
    );
    assert_eq!(
        keeper.snapshot().accounts[0].reason.as_deref(),
        Some("cooldown")
    );
    f.world().now += KEEPER_COOLDOWN_MS - 1000.0;
    tick(&keeper);
    assert_eq!(f.world().starts.len(), 1);
    f.world().now += 2000.0;
    tick(&keeper);
    assert_eq!(f.world().starts.len(), 2);
    assert_eq!(f.world().notes.len(), 1);
}

#[test]
fn at_most_the_daily_limit_of_attempts_per_account() {
    let f = Fixture::single();
    f.world().fail = Some("routine-request-failed".into());
    let keeper = f.keeper();
    for _ in 0..KEEPER_DAILY_LIMIT + 3 {
        tick(&keeper);
        f.world().now += KEEPER_COOLDOWN_MS + 1000.0;
    }
    assert_eq!(f.world().starts.len(), KEEPER_DAILY_LIMIT);
    assert_eq!(
        keeper.snapshot().accounts[0].reason.as_deref(),
        Some("daily-limit")
    );
}

#[test]
fn one_start_per_tick_blocked_relay_busy_accounts_and_full_weeks_wait() {
    let f = Fixture::new(vec![account("A"), account("B")]);
    let (a, b) = (f.id(0), f.id(1));
    let keeper = f.keeper();
    f.world().blocked = true;
    tick(&keeper);
    assert!(f.world().starts.is_empty());
    assert_eq!(
        keeper.snapshot().accounts[0].reason.as_deref(),
        Some("relay-busy")
    );
    {
        let mut w = f.world();
        w.blocked = false;
        w.busy = vec![a.clone()];
        w.usage.get_mut(&b).expect("usage").seven_day = Some(UsageWindow::new(100.0, None));
    }
    tick(&keeper);
    assert!(f.world().starts.is_empty());
    assert_eq!(
        keeper.snapshot().accounts[0].reason.as_deref(),
        Some("in-use")
    );
    assert_eq!(
        keeper.snapshot().accounts[1].reason.as_deref(),
        Some("weekly-limit")
    );
    let fresh_b = f.fresh(1, None);
    {
        let mut w = f.world();
        w.busy = Vec::new();
        w.usage.insert(b.clone(), fresh_b);
    }
    tick(&keeper);
    assert_eq!(f.world().starts, std::slice::from_ref(&a));
    tick(&keeper);
    assert_eq!(f.world().starts, [a, b]);
}

#[test]
fn an_interrupted_attempt_is_never_resent_and_counts_toward_the_cooldown() {
    let f = Fixture::single();
    let attempt = json!({
        "version": 1,
        "attempts": [{
            "id": Uuid::new_v4().to_string(),
            "accountId": f.id(0),
            "identityKey": f.identity_key(0),
            "at": iso(f.world().now - 60_000.0),
            "status": "started",
        }],
    });
    std::fs::write(f.file(), attempt.to_string()).expect("a log");
    let keeper = f.keeper();
    assert_eq!(
        keeper.snapshot().attempts[0].status,
        WindowAttemptStatus::Failed
    );
    assert_eq!(
        keeper.snapshot().attempts[0].reason.as_deref(),
        Some("interrupted")
    );
    tick(&keeper);
    assert!(f.world().starts.is_empty());
}

#[test]
fn a_future_attempt_time_does_not_block_deleted_planned_accounts_are_ignored() {
    let f = Fixture::single();
    f.world()
        .settings
        .accounts
        .extend(helpers::planned(&[&Uuid::new_v4().to_string()]));
    let attempt = json!({
        "version": 1,
        "attempts": [{
            "id": Uuid::new_v4().to_string(),
            "accountId": f.id(0),
            "identityKey": f.identity_key(0),
            "at": iso(f.world().now + 3.0 * 3_600_000.0),
            "status": "failed",
            "reason": "routine-request-failed",
        }],
    });
    std::fs::write(f.file(), attempt.to_string()).expect("a log");
    let keeper = f.keeper();
    tick(&keeper);
    let a = f.id(0);
    assert_eq!(f.world().starts, [a]);
    assert_eq!(keeper.snapshot().accounts.len(), 1);
}

#[test]
fn a_deleted_planned_account_takes_no_slot_in_the_staggering_or_today_s_count() {
    let f = Fixture::single();
    {
        let mut w = f.world();
        w.settings
            .accounts
            .extend(helpers::planned(&[&Uuid::new_v4().to_string()]));
        w.now = at("05:30");
    }
    let keeper = f.keeper();
    tick(&keeper);
    let snapshot = keeper.snapshot();
    let status = &snapshot.accounts[0];
    assert_eq!(status.state, KeeperAccountState::Outside);
    // Planned as if the deleted account were not listed at all.
    f.world().settings.accounts.pop();
    let plan = f.plan();
    let only = &plan.accounts[0];
    assert!(only.first_start > f.world().now);
    assert_eq!(status.next_start_at, Some(iso(only.first_start)));
    assert_eq!(snapshot.planned_today, only.windows.len() as f64);
}

#[test]
fn local_administrator_policy_stops_the_account_until_the_plan_changes_or_six_hours_pass() {
    let f = Fixture::single();
    f.world().fail = Some("routine-policy-unverified".into());
    let keeper = f.keeper();
    for _ in 0..5 {
        tick(&keeper);
        f.world().now += KEEPER_COOLDOWN_MS + 1000.0;
    }
    assert_eq!(f.world().starts.len(), 1);
    assert_eq!(f.world().notes.len(), 1);
    let status = keeper.snapshot().accounts[0].clone();
    assert_eq!(status.state, KeeperAccountState::Blocked);
    assert_eq!(status.reason.as_deref(), Some("routine-policy-unverified"));
    // A restart keeps the stop; changing the plan lets it try again.
    let restarted = f.keeper();
    tick(&restarted);
    assert_eq!(f.world().starts.len(), 1);
    f.world().fail = None;
    restarted.resume();
    tick(&restarted);
    assert_eq!(f.world().starts.len(), 2);
}

fn broken_usage(id: &str, issue: Option<UsageIssue>, renewal: bool) -> AccountUsage {
    let mut usage = AccountUsage::new(id, UsageStatus::Error);
    usage.stale = true;
    usage.issue = issue;
    usage.connection_renewal_required = renewal.then_some(true);
    usage
}

#[test]
fn an_expired_usage_connection_is_reported_still_refreshed_and_never_starts() {
    let f = Fixture::single();
    let a = f.id(0);
    {
        let mut w = f.world();
        w.usage.insert(
            a.clone(),
            broken_usage(&a, Some(UsageIssue::Expired), false),
        );
        w.refresh_fails = true;
    }
    let keeper = f.keeper();
    tick(&keeper);
    assert!(f.world().starts.is_empty());
    assert_eq!(f.world().refreshes, [a]);
    let status = keeper.snapshot().accounts[0].clone();
    assert_eq!(status.state, KeeperAccountState::Blocked);
    assert_eq!(status.reason.as_deref(), Some("usage-connection"));
}

#[test]
fn a_connection_flag_left_over_from_before_does_not_block_while_the_service_is_rate_limited_or_down()
 {
    for issue in [UsageIssue::RateLimited, UsageIssue::Unavailable] {
        let f = Fixture::single();
        let a = f.id(0);
        {
            let mut w = f.world();
            w.usage
                .insert(a.clone(), broken_usage(&a, Some(issue), true));
            w.refresh_fails = true;
        }
        let keeper = f.keeper();
        tick(&keeper);
        assert!(f.world().starts.is_empty(), "{issue:?}");
        let status = keeper.snapshot().accounts[0].clone();
        assert_eq!(status.state, KeeperAccountState::Waiting, "{issue:?}");
        assert_eq!(status.reason.as_deref(), Some("usage-stale"), "{issue:?}");
    }
}

#[test]
fn a_connection_flag_with_no_reported_issue_blocks_the_account_like_a_renewal_to_do() {
    let f = Fixture::single();
    let a = f.id(0);
    {
        let mut w = f.world();
        w.usage.insert(a.clone(), broken_usage(&a, None, true));
        w.refresh_fails = true;
    }
    let keeper = f.keeper();
    tick(&keeper);
    assert!(f.world().starts.is_empty());
    let status = keeper.snapshot().accounts[0].clone();
    assert_eq!(status.state, KeeperAccountState::Blocked);
    assert_eq!(status.reason.as_deref(), Some("usage-connection"));
}

#[test]
fn while_relay_is_busy_a_stale_account_waits_for_relay_not_for_usage() {
    let f = Fixture::single();
    let a = f.id(0);
    {
        let mut w = f.world();
        let checked = iso(w.now - 10.0 * 60_000.0);
        w.usage.get_mut(&a).expect("usage").checked_at = Some(checked);
        w.blocked = true;
    }
    let keeper = f.keeper();
    tick(&keeper);
    assert_eq!(
        keeper.snapshot().accounts[0].reason.as_deref(),
        Some("relay-busy")
    );
}

#[test]
fn the_snapshot_carries_the_state_s_tempo() {
    let f = Fixture::single();
    let heavy = preset_tempo(
        TempoChoice::Heavy,
        TempoSource::Preset,
        TempoDays::default(),
    );
    f.world().tempo = heavy.clone();
    let keeper = f.keeper();
    assert_eq!(keeper.snapshot().tempo, Some(heavy));
    let light = preset_tempo(
        TempoChoice::Light,
        TempoSource::Preset,
        TempoDays::default(),
    );
    f.world().tempo = light.clone();
    assert_eq!(keeper.snapshot().tempo, Some(light));
}

#[test]
fn today_s_count_and_the_next_start_follow_the_capacity_aware_plan() {
    let mut max = account("Max");
    max.planning = Some(helpers::from_json(
        json!({ "plan": "max5", "capacityWeight": 5 }),
    ));
    let mut pro = account("Pro");
    pro.planning = Some(helpers::from_json(
        json!({ "plan": "pro", "capacityWeight": 1 }),
    ));
    let f = Fixture::new(vec![max, pro]);
    f.world().now = at("05:00");
    let keeper = f.keeper();
    tick(&keeper);
    let expected = f.plan();
    let windows: usize = expected.accounts.iter().map(|a| a.windows.len()).sum();
    assert!(windows >= 2);
    assert_eq!(keeper.snapshot().planned_today, windows as f64);
    for (i, status) in keeper.snapshot().accounts.iter().enumerate() {
        assert_eq!(status.state, KeeperAccountState::Outside);
        assert_eq!(
            status.next_start_at,
            Some(iso(expected.accounts[i].first_start))
        );
    }
}

#[test]
fn the_keeper_plans_with_the_state_s_tempo_as_soon_as_it_changes() {
    let f = Fixture::single();
    f.world().now = at("04:00");
    let keeper = f.keeper();
    tick(&keeper);
    let medium = f.plan().accounts[0].clone();
    assert_eq!(keeper.snapshot().planned_today, medium.windows.len() as f64);
    f.world().tempo = preset_tempo(
        TempoChoice::Heavy,
        TempoSource::Preset,
        TempoDays::default(),
    );
    tick(&keeper);
    let heavy = f.plan().accounts[0].clone();
    // A heavy day needs another window and an earlier warm-up.
    assert!(heavy.windows.len() > medium.windows.len());
    assert!(heavy.first_start < medium.first_start);
    assert_eq!(keeper.snapshot().planned_today, heavy.windows.len() as f64);
    assert_eq!(
        keeper.snapshot().accounts[0].next_start_at,
        Some(iso(heavy.first_start))
    );
}

#[test]
fn a_closed_window_waits_for_its_adapted_start_and_is_due_at_that_time() {
    let f = Fixture::single();
    let (a, settings, tempo, now) = {
        let w = f.world();
        (
            w.accounts[0].clone(),
            w.settings.clone(),
            w.tempo.clone(),
            w.now,
        )
    };
    let context = plan_context(std::slice::from_ref(&a), tempo);
    let scheduled = now + 30.0 * 60_000.0;
    let decide = |now: f64, usage: AccountUsage| {
        let usage = AccountUsage {
            checked_at: Some(iso(now)),
            ..usage
        };
        keeper_decision(
            &a,
            Some(&usage),
            &settings,
            &context,
            &[],
            now,
            false,
            None,
            Some(scheduled),
        )
    };
    let waiting = decide(now, f.fresh(0, None));
    assert!(!waiting.refresh);
    assert_eq!(waiting.status.account_id, a.id);
    assert_eq!(waiting.status.state, KeeperAccountState::Waiting);
    assert_eq!(waiting.status.reason.as_deref(), Some("adapted"));
    assert_eq!(waiting.status.next_start_at, Some(iso(scheduled)));
    assert_eq!(waiting.status.resets_at, None);
    let due = decide(scheduled, f.fresh(0, None));
    assert_eq!(due.status.state, KeeperAccountState::Due);
    assert_eq!(
        (
            due.status.reason,
            due.status.next_start_at,
            due.status.resets_at
        ),
        (None, None, None)
    );
    // A full week still blocks: the keeper could not start it then either.
    let full = decide(
        now,
        AccountUsage {
            seven_day: Some(UsageWindow::new(100.0, None)),
            ..f.fresh(0, None)
        },
    );
    assert_eq!(full.status.state, KeeperAccountState::Blocked);
    assert_eq!(full.status.reason.as_deref(), Some("weekly-limit"));
    assert_eq!(full.status.next_start_at, None);
}

/// The Mac wakes at 08:50 on a 09:00–18:00 Wednesday planned at 120 Pro units an hour: every
/// warm-up (08:00, 08:45, 08:45) was missed, every window is closed and the usage was last read
/// `read_ago` before (the evening before).
fn wake(adaptive: Option<bool>, read_ago: f64) -> Fixture {
    let f = Fixture::new(vec![
        planning_account("max", "max5"),
        team_account("vertex", 2.0),
        planning_account("pro", "pro"),
    ]);
    {
        let mut w = f.world();
        w.settings.weekday = hours(true, "09:00", "18:00");
        if adaptive.is_some() {
            w.settings.adaptive = adaptive;
        }
        w.tempo = flat_tempo(120.0);
        w.now = on(WEDNESDAY, "08:50");
        let accounts = w.accounts.clone();
        for a in &accounts {
            let mut usage = w.fresh(a, None);
            usage.checked_at = Some(iso(w.now - read_ago));
            w.usage.insert(a.id.clone(), usage);
        }
        w.order = Some(Vec::new());
    }
    f
}
fn order(f: &Fixture) -> Vec<String> {
    f.world().order.clone().unwrap_or_default()
}
const EVENING: f64 = 10.0 * 3_600_000.0;

#[test]
fn a_mac_waking_with_every_window_closed_refreshes_re_plans_then_starts_only_what_is_not_deferred()
{
    let f = wake(None, EVENING);
    let keeper = f.keeper();
    tick(&keeper);
    // Max's window is planned to open with work at 09:00, so it is not due and not read.
    // Started now, vertex and pro would switch twice; pro held to 09:00 as well switches once
    // (the adaptive schedule's own wake-up case).
    assert_eq!(
        order(&f),
        [
            "refresh vertex",
            "refresh pro",
            "adapted updated",
            "start vertex"
        ]
    );
    let nine = iso(on(WEDNESDAY, "09:00"));
    let schedule = vec![ScheduledStart {
        account_id: "pro".into(),
        start_at: nine.clone(),
    }];
    assert_eq!(
        f.world().adapted,
        [AdaptedNotice {
            kind: AdaptiveNoticeKind::Updated,
            schedule: schedule.clone(),
        }]
    );
    let snapshot = keeper.snapshot();
    assert_eq!(
        snapshot.adaptation,
        Some(KeeperAdaptation {
            factor: 1.0,
            observed_rate: None,
            schedule,
            since: Some(iso(on(WEDNESDAY, "08:50"))),
        })
    );
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .map(|s| (s.account_id.as_str(), s.state, s.reason.as_deref()))
            .collect::<Vec<_>>(),
        [
            ("max", KeeperAccountState::Outside, None),
            ("vertex", KeeperAccountState::Active, None),
            ("pro", KeeperAccountState::Waiting, Some("adapted")),
        ]
    );
    assert_eq!(snapshot.accounts[0].next_start_at, Some(nine.clone()));
    assert_eq!(
        snapshot.next,
        Some(KeeperNext {
            account_id: "max".into(),
            at: nine,
        })
    );
    // Nothing else starts before 09:00, and nothing more is announced.
    for clock in ["08:51", "08:55", "08:59"] {
        f.world().now = on(WEDNESDAY, clock);
        tick(&keeper);
    }
    assert_eq!(f.world().starts, ["vertex"]);
    // At 09:00 the deferred accounts start, one a tick, quietly.
    for clock in ["09:00", "09:01"] {
        f.world().now = on(WEDNESDAY, clock);
        tick(&keeper);
    }
    assert_eq!(f.world().starts, ["vertex", "max", "pro"]);
    assert_eq!(f.world().adapted.len(), 1);
    assert_eq!(keeper.snapshot().adaptation, None);
}

#[test]
fn with_adaptation_off_the_waking_mac_starts_the_first_planned_account() {
    let f = wake(Some(false), EVENING);
    let keeper = f.keeper();
    tick(&keeper);
    // Vertex warms up first (05:30); max's window opens with work at 09:00.
    assert_eq!(order(&f), ["refresh vertex", "refresh pro", "start vertex"]);
    assert_eq!(keeper.snapshot().adaptation, None);
}

#[test]
fn today_s_faster_pace_shows_in_the_snapshot_without_a_schedule_or_a_notice() {
    let f = Fixture::single();
    // Planned at 60 an hour; the last hour used 90% of a Pro window.
    let resets_at = iso(at("12:00"));
    {
        let mut w = f.world();
        w.tempo = flat_tempo(60.0);
        let a = w.accounts[0].clone();
        let mut time = at("09:00");
        while time <= w.now {
            let used = ((time - at("09:00")) / 3_600_000.0) * 90.0;
            w.samples.push(UsageSample {
                account_id: a.id.clone(),
                identity: usage_identity(&a).expect("an identity"),
                checked_at: iso(time),
                five_hour: Some(UsageWindow::new(used, Some(&resets_at))),
                seven_day: None,
            });
            time += 5.0 * 60_000.0;
        }
        let mut usage = w.fresh(&a, Some(at("12:00")));
        usage.five_hour = Some(UsageWindow::new(90.0, Some(&resets_at)));
        w.usage.insert(a.id.clone(), usage);
    }
    let keeper = f.keeper();
    tick(&keeper);
    assert_eq!(
        keeper.snapshot().adaptation,
        Some(KeeperAdaptation {
            factor: 1.5,
            observed_rate: Some(90.0),
            schedule: Vec::new(),
            since: None,
        })
    );
    assert!(f.world().adapted.is_empty());
    assert!(f.world().starts.is_empty());
}

#[test]
fn while_relay_is_busy_nothing_is_searched_or_adopted_the_next_free_tick_refreshes_adapts_then_starts()
 {
    // Read 10 minutes ago: fresh enough for a forecast, stale for the keeper.
    let f = wake(None, 10.0 * 60_000.0);
    let keeper = f.keeper();
    f.world().blocked = true;
    tick(&keeper);
    assert!(order(&f).is_empty());
    assert!(f.world().adapted.is_empty());
    assert_eq!(keeper.snapshot().adaptation, None);
    // No review was spent: the first free tick searches at once.
    {
        let mut w = f.world();
        w.blocked = false;
        w.now = on(WEDNESDAY, "08:51");
    }
    tick(&keeper);
    assert_eq!(
        order(&f),
        [
            "refresh vertex",
            "refresh pro",
            "adapted updated",
            "start vertex"
        ]
    );
}

/// The adaptive schedule's hold scenario at 09:30 on Wednesday: `a` serves at 100 Pro units an
/// hour on its last 250 (until its 12:00 reset) while `b`'s idle window resets at 10:00;
/// holding b's restart to 11:00 removes an hour without quota.
fn holding() -> (Fixture, WindowKeeper) {
    let f = Fixture::new(vec![team_account("a", 3.0), planning_account("b", "pro")]);
    {
        let mut w = f.world();
        w.settings.weekday = hours(true, "09:00", "18:00");
        w.tempo = flat_tempo(100.0);
        w.now = on(WEDNESDAY, "09:30");
        w.active_id = Some("a".into());
        // Read at 09:30: a's use since an older read would come off its 250.
        let accounts = w.accounts.clone();
        for (a, used, clock) in [
            (&accounts[0], 100.0 / 6.0, "12:00"),
            (&accounts[1], 0.0, "10:00"),
        ] {
            let mut usage = w.fresh(a, None);
            usage.checked_at = Some(iso(w.now));
            usage.five_hour = Some(UsageWindow::new(used, Some(&iso(on(WEDNESDAY, clock)))));
            w.usage.insert(a.id.clone(), usage);
        }
    }
    let keeper = f.keeper();
    (f, keeper)
}

#[test]
fn a_held_restart_is_the_next_start_adaptation_turned_off_drops_it_quietly() {
    let (f, keeper) = holding();
    tick(&keeper);
    let eleven = iso(on(WEDNESDAY, "11:00"));
    assert_eq!(
        f.world().adapted,
        [AdaptedNotice {
            kind: AdaptiveNoticeKind::Updated,
            schedule: vec![ScheduledStart {
                account_id: "b".into(),
                start_at: eleven.clone(),
            }],
        }]
    );
    let snapshot = keeper.snapshot();
    // b's window still resets at 10:00, but the keeper restarts it at 11:00.
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .map(|s| (s.account_id.as_str(), s.state, s.resets_at.clone()))
            .collect::<Vec<_>>(),
        [
            (
                "a",
                KeeperAccountState::Active,
                Some(iso(on(WEDNESDAY, "12:00")))
            ),
            (
                "b",
                KeeperAccountState::Active,
                Some(iso(on(WEDNESDAY, "10:00")))
            ),
        ]
    );
    assert_eq!(
        snapshot.next,
        Some(KeeperNext {
            account_id: "b".into(),
            at: eleven,
        })
    );
    // Turned off at 10:05, while Relay is busy: dropped at once, and quietly (the user turned
    // it off), though the last notice was 35 minutes ago.
    {
        let mut w = f.world();
        w.now = on(WEDNESDAY, "10:05");
        w.settings.adaptive = Some(false);
        w.blocked = true;
    }
    tick(&keeper);
    assert_eq!(f.world().adapted.len(), 1);
    assert_eq!(keeper.snapshot().adaptation, None);
    assert!(f.world().starts.is_empty());
    // Free again: b's window, closed since 10:00, starts at once.
    f.world().blocked = false;
    tick(&keeper);
    assert_eq!(f.world().starts, ["b"]);
    assert_eq!(f.world().adapted.len(), 1);
}

#[test]
fn a_planning_edit_re_plans_today_at_once_and_quietly() {
    let (f, keeper) = holding();
    tick(&keeper);
    assert_eq!(f.world().adapted.len(), 1);
    // The edit drops the held restart at once: b's next start is its reset.
    keeper.resume();
    assert_eq!(keeper.snapshot().adaptation, None);
    assert_eq!(
        keeper.snapshot().next,
        Some(KeeperNext {
            account_id: "b".into(),
            at: iso(on(WEDNESDAY, "10:00")),
        })
    );
    // The next tick searches at once and holds it again; the user heard of that hold at 09:30.
    f.world().now = on(WEDNESDAY, "09:31");
    tick(&keeper);
    assert_eq!(
        keeper.snapshot().adaptation,
        Some(KeeperAdaptation {
            factor: 1.0,
            observed_rate: None,
            schedule: vec![ScheduledStart {
                account_id: "b".into(),
                start_at: iso(on(WEDNESDAY, "11:00")),
            }],
            since: Some(iso(on(WEDNESDAY, "09:31"))),
        })
    );
    assert_eq!(f.world().adapted.len(), 1);
    // Work cut short to 15:00 needs no hold: dropped quietly, and b, closed since 10:00, starts
    // at once.
    f.world().settings.weekday = hours(true, "09:00", "15:00");
    keeper.resume();
    f.world().now = on(WEDNESDAY, "10:05");
    tick(&keeper);
    assert_eq!(keeper.snapshot().adaptation, None);
    assert_eq!(f.world().starts, ["b"]);
    assert_eq!(f.world().adapted.len(), 1);
}

#[test]
fn a_failing_re_plan_or_notification_never_stops_the_keep_alive() {
    // The schedule cannot be computed: the plan's own starts, quietly.
    let broken = wake(None, EVENING);
    let keeper = broken.keeper_with(Box::new(|_| panic!("the re-plan failed")));
    tick(&keeper);
    assert_eq!(
        order(&broken),
        ["refresh vertex", "refresh pro", "start vertex"]
    );
    assert!(broken.world().adapted.is_empty());
    // The notification fails: the adopted schedule still holds.
    let silent = wake(None, EVENING);
    silent.world().adapted_fails = true;
    let keeper = silent.keeper();
    tick(&keeper);
    assert_eq!(
        order(&silent),
        [
            "refresh vertex",
            "refresh pro",
            "adapted updated",
            "start vertex"
        ]
    );
}

#[test]
fn the_windows_are_told_only_when_the_keeper_s_snapshot_changed() {
    let f = Fixture::single();
    let keeper = f.keeper();
    // The first tick starts a window: that is news.
    tick(&keeper);
    assert_eq!(f.world().told, 1);
    // A minute later nothing changed.
    f.world().now += 60_000.0;
    tick(&keeper);
    assert_eq!(f.world().told, 1);
    // Turning auto start off changes every account's state.
    f.world().settings.auto_start = false;
    tick(&keeper);
    assert_eq!(f.world().told, 2);
    tick(&keeper);
    assert_eq!(f.world().told, 2);
}

#[test]
fn a_stopping_refusal_is_tried_again_six_hours_later_also_after_a_restart() {
    let f = Fixture::single();
    f.world().fail = Some("routine-policy-unverified".into());
    tick(&f.keeper());
    assert_eq!(f.world().starts.len(), 1);
    // Seen 2026-10-18: one refusal left every account stopped for nine days.
    {
        let mut w = f.world();
        w.fail = None;
        w.now += KEEPER_STOP_RETRY_MS - 60_000.0;
    }
    let restarted = f.keeper();
    tick(&restarted);
    assert_eq!(f.world().starts.len(), 1);
    assert_eq!(
        restarted.snapshot().accounts[0].reason.as_deref(),
        Some("routine-policy-unverified")
    );
    f.world().now += 2.0 * 60_000.0;
    tick(&restarted);
    assert_eq!(f.world().starts.len(), 2);
}
