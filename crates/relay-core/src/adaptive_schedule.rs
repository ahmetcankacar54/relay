//! Port of `electron/core/adaptive-schedule.ts`: today's next window starts, re-chosen only when
//! the live forecast falls behind the plan's own, and the notices the user hears about them.

use serde::{Deserialize, Serialize};

use crate::shared::adaptive_plan::{
    PACE_WINDOW_MS, PaceInput, Replan, ReplanInput, replan_starts, todays_pace,
};
use crate::shared::capacity_plan::{Forecast, ser_num_map};
use crate::shared::day_plan::{
    DayPlan, PlanContext, WINDOW_MS, day_plan, plan_context, shift_date,
};
use crate::shared::live_forecast::{LiveInput, live_forecast};
use crate::shared::planning::local_date;
use crate::shared::tempo::Tempo;
use crate::shared::types::js::{self, JsMap, date_parse, iso, ser_num, ser_opt_num};
use crate::shared::types::{Account, AccountUsage, PlanningSettings};
use crate::shared::usage::fresh_usage;
use crate::shared::usage_rollups::same_reset;
use crate::shared::usage_statistics::UsageSample;

const MINUTE_MS: f64 = 60_000.0;
/// At most one search, and one check whether to drop the schedule, this often.
pub const SEARCH_EVERY_MS: f64 = 15.0 * MINUTE_MS;
/// At most one notice this often.
pub const NOTIFY_EVERY_MS: f64 = 30.0 * MINUTE_MS;
// This many more minutes without quota than the plan makes a forecast worse.
const WORSE_BY_MINUTES: f64 = 5.0;
// A warm-up still not started this long after its time was missed (the Mac slept), rather
// than being on its way with the keeper's next tick.
const MISSED_MS: f64 = 10.0 * MINUTE_MS;

/// accountId → next window start.
pub type Schedule = JsMap<f64>;

#[derive(Debug, Clone, PartialEq)]
pub struct AdaptiveInput {
    /// Planned accounts only (deleted ones filtered out).
    pub settings: PlanningSettings,
    pub accounts: Vec<Account>,
    pub usage: JsMap<AccountUsage>,
    pub tempo: Tempo,
    /// Raw usage samples of the last hour: today's pace.
    pub recent_samples: Vec<UsageSample>,
    /// The account Claude Desktop uses now.
    pub active_id: Option<String>,
    /// Accounts the keeper cannot start now; they keep their default start.
    pub blocked: Vec<String>,
    pub now: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdaptiveNoticeKind {
    Updated,
    Normal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdaptiveNotice {
    pub kind: AdaptiveNoticeKind,
    #[serde(serialize_with = "ser_num_map")]
    pub schedule: Schedule,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaptiveResult {
    /// accountId → next window start, only where it differs from the default.
    #[serde(serialize_with = "ser_num_map")]
    pub schedule: Schedule,
    /// Today's pace multiplier for the tempo.
    #[serde(serialize_with = "ser_num")]
    pub factor: f64,
    /// Pro units an hour over the last hour, when observed long enough.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub observed_rate: Option<f64>,
    /// When the current schedule was adopted.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub since: Option<f64>,
    /// Set when the user should hear about a change (already throttled).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<AdaptiveNotice>,
}

impl AdaptiveResult {
    fn empty() -> Self {
        AdaptiveResult {
            schedule: JsMap::new(),
            factor: 1.0,
            observed_rate: None,
            since: None,
            notice: None,
        }
    }
}

/// The accounts and their times, comparable across objects.
fn key(schedule: &Schedule) -> String {
    let mut entries: Vec<String> = schedule
        .iter()
        .map(|(id, time)| format!("{id}@{}", js::number_string(*time)))
        .collect();
    js::sort_by(&mut entries, |a, b| js::compare_str(a, b));
    entries.join(",")
}

fn unmet(forecast: &Forecast) -> f64 {
    js::round(forecast.unmet * 2.0) / 2.0
}

/// Strictly better on unmet demand (to half a Pro unit), then on switches.
fn beats(a: &Forecast, b: &Forecast) -> bool {
    unmet(a) < unmet(b) || (unmet(a) == unmet(b) && a.switches < b.switches)
}

/// A live forecast where a plan is in force (it always has one).
fn forecast_in_force(input: LiveInput<'_>) -> Forecast {
    live_forecast(input).expect("the plan in force has work left")
}

/// The schedule still beats the default with live times exactly as read. Near times count as
/// the plan's own, so two resets a minute apart can become one instant at which the simulation
/// refills the larger account first; a gain that rests on that tie is none.
fn wins_as_read(live: LiveInput<'_>, schedule: &Schedule) -> bool {
    schedule.is_empty()
        || beats(
            &forecast_in_force(LiveInput {
                schedule: Some(schedule),
                exact: true,
                ..live
            }),
            &forecast_in_force(LiveInput {
                exact: true,
                ..live
            }),
        )
}

struct PlanAfter {
    outage_minutes: f64,
    switches: u32,
}

/// The plan's own forecast in [from, to): minutes without quota and switches.
fn plan_after(forecast: &Forecast, from: f64, to: f64) -> PlanAfter {
    let mut outage = 0.0;
    let mut switches = 0;
    let mut last: Option<&str> = None;
    for s in &forecast.segments {
        if s.to <= from || s.from >= to {
            continue;
        }
        match &s.account_id {
            None => outage += s.to.min(to) - s.from.max(from),
            Some(id) => {
                if last.is_some_and(|l| l != id) {
                    switches += 1;
                }
                last = Some(id);
            }
        }
    }
    PlanAfter {
        outage_minutes: outage / MINUTE_MS,
        switches,
    }
}

/// The plan in force at `now`: yesterday's, today's or tomorrow's (first match) from its first
/// warm-up to the end of its work.
fn plan_at(input: &AdaptiveInput, context: &PlanContext) -> Option<DayPlan> {
    // Live resets place the window chain as the Planning page draws it.
    let mut live = JsMap::new();
    for (id, u) in &input.usage {
        let reset = date_parse(
            u.five_hour
                .as_ref()
                .and_then(|w| w.resets_at.as_deref())
                .unwrap_or(""),
        );
        // `Date.parse(…) || undefined`: NaN and 0 are no reset.
        if reset != 0.0 && !reset.is_nan() {
            live.insert(id.clone(), reset);
        }
    }
    let today = local_date(input.now, &input.settings.time_zone);
    for delta in [-1.0, 0.0, 1.0] {
        let plan = day_plan(
            &shift_date(&today, delta),
            &input.settings,
            context,
            Some(&live),
        );
        let Some(interval) = &plan.interval else {
            continue;
        };
        if plan.forecast.is_none() {
            continue;
        }
        let first = js::min(
            std::iter::once(interval.start).chain(plan.accounts.iter().map(|a| a.active_from)),
        );
        if first <= input.now && input.now < interval.end {
            return Some(plan);
        }
    }
    None
}

/// A planned account the keeper could start is still closed well after its warm-up time.
fn missed_warm_up(plan: &DayPlan, input: &AdaptiveInput) -> bool {
    plan.accounts.iter().any(|p| {
        let u = input.usage.get(&p.account_id);
        input.now - p.active_from >= MISSED_MS
            && !input.blocked.contains(&p.account_id)
            && fresh_usage(u, input.now)
            && u.and_then(|u| u.five_hour.as_ref())
                .and_then(|w| w.resets_at.as_deref())
                .is_none_or(str::is_empty)
    })
}

/// The search [`AdaptiveSchedule`] runs: `replan_starts` unless a test injects another.
pub type Search = Box<dyn Fn(&ReplanInput<'_>) -> Option<Replan> + Send>;
/// The clock [`AdaptiveSchedule::current`] reads.
pub type Clock = Box<dyn Fn() -> f64 + Send>;

/// Each planned account's next window start for the rest of the plan in force (from its first
/// warm-up to the end of work), re-chosen only when the live forecast falls behind the plan's
/// own. A search result is adopted only when strictly better than the schedule held, and than
/// the default with live times exactly as read; the schedule is dropped once the default does
/// as well at two reviews in a row, unless every start left comes before the next review;
/// reviews come at most every 15 minutes. Turning adaptation or auto start off, and a planning
/// edit (`reset`), drop it without a notice. Kept in memory; the keeper updates it before its
/// decisions.
pub struct AdaptiveSchedule {
    schedule: Schedule,
    /// What the user last heard, less the entries dropped quietly since.
    announced: Schedule,
    since: Option<f64>,
    date: Option<String>,
    last_update: Option<f64>,
    /// The last search or check whether to drop the schedule.
    last_review: Option<f64>,
    /// The default did as well as the schedule held at the last review.
    default_no_worse: bool,
    last_notice: Option<f64>,
    /// The user turned adaptation off or edited the plan: what they last heard may go without
    /// a notice. At the next update with adaptation on it stands only where the schedule still
    /// holds it.
    quiet: bool,
    last: AdaptiveResult,
    now: Clock,
    search: Search,
}

impl Default for AdaptiveSchedule {
    fn default() -> Self {
        Self::new(None, None)
    }
}

impl AdaptiveSchedule {
    /// `now` defaults to the wall clock, `search` to [`replan_starts`].
    pub fn new(now: Option<Clock>, search: Option<Search>) -> Self {
        AdaptiveSchedule {
            schedule: JsMap::new(),
            announced: JsMap::new(),
            since: None,
            date: None,
            last_update: None,
            last_review: None,
            default_no_worse: false,
            last_notice: None,
            quiet: false,
            last: AdaptiveResult::empty(),
            now: now.unwrap_or_else(|| Box::new(|| crate::clock::now_ms() as f64)),
            search: search.unwrap_or_else(|| Box::new(replan_starts)),
        }
    }

    pub fn update(&mut self, input: &AdaptiveInput) -> AdaptiveResult {
        let AdaptiveInput {
            settings,
            usage,
            now,
            ..
        } = input;
        let now = *now;
        // A clock moved back leaves every kept time meaningless.
        if self.last_update.is_some_and(|last| now < last) {
            self.restart();
            // The last notice counts as just now.
            if let Some(notice) = self.last_notice {
                self.last_notice = Some(notice.min(now));
            }
        }
        self.last_update = Some(now);
        let on = settings.adaptive != Some(false) && settings.auto_start;
        if !on {
            self.quiet = true;
        }
        let context = plan_context(&input.accounts, input.tempo.clone());
        let plan = if on { plan_at(input, &context) } else { None };
        if let Some(plan) = &plan
            && self.date.as_deref() != Some(plan.date.as_str())
        {
            self.restart();
            self.date = Some(plan.date.clone());
        }
        // Dropped quietly: starts whose time came (the keeper starts them now), accounts used
        // by hand, accounts no longer planned, and outside the plan whatever is left.
        let planned: Vec<&str> = settings.accounts.iter().map(|a| a.id.as_str()).collect();
        let dropped: Vec<String> = self
            .schedule
            .iter()
            .filter(|(id, time)| {
                (on && plan.is_none())
                    || **time <= now
                    || !planned.contains(&id.as_str())
                    || self.used_by_hand(usage.get(id.as_str()), now)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in dropped {
            self.schedule.remove(&id);
            self.announced.remove(&id);
            // What the last review compared is gone.
            self.default_no_worse = false;
        }
        if self.schedule.is_empty() {
            self.since = None;
        }
        self.announced
            .retain(|id, time| !(*time <= now || !planned.contains(&id.as_str())));
        let mut factor = 1.0;
        let mut observed: Option<f64> = None;
        match &plan {
            // Turned off (or outside the plan): dropped.
            None => self.clear(),
            Some(plan) => {
                let planned_accounts: Vec<Account> = input
                    .accounts
                    .iter()
                    .filter(|a| planned.contains(&a.id.as_str()))
                    .cloned()
                    .collect();
                let pace = todays_pace(PaceInput {
                    samples: &input.recent_samples,
                    accounts: &planned_accounts,
                    tempo: &input.tempo,
                    settings,
                    from: now - PACE_WINDOW_MS,
                    // `to` is exclusive: a sample read just now counts.
                    to: now + 1.0,
                });
                factor = pace.factor;
                observed = pace.observed;
                let live = LiveInput {
                    plan,
                    settings,
                    context: &context,
                    usage,
                    active_id: input.active_id.as_deref(),
                    now,
                    factor: Some(factor),
                    schedule: None,
                    exact: false,
                };
                let interval = plan.interval.as_ref().expect("a plan in force has hours");
                let mut current = forecast_in_force(LiveInput {
                    schedule: Some(&self.schedule),
                    ..live
                });
                let reference = plan_after(
                    plan.forecast
                        .as_ref()
                        .expect("a plan in force is simulated"),
                    now,
                    interval.end,
                );
                let worse = current.outage_minutes >= reference.outage_minutes + WORSE_BY_MINUTES
                    || current.switches > reference.switches;
                let due = self
                    .last_review
                    .is_none_or(|last| now - last >= SEARCH_EVERY_MS);
                // Before work a search is worth it only when a warm-up was missed; otherwise
                // the keeper is still warming the windows up as planned.
                let search = worse && (now >= interval.start || missed_warm_up(plan, input));
                if due && (search || !self.schedule.is_empty()) {
                    self.last_review = Some(now);
                    if search {
                        let replan = (self.search)(&ReplanInput {
                            live,
                            blocked: &input.blocked,
                        });
                        if let Some(replan) = replan
                            && beats(&replan.forecast, &current)
                            && wins_as_read(live, &replan.schedule)
                        {
                            self.adopt(&replan.schedule, now);
                            current = replan.forecast;
                        }
                    }
                    // The pace dropped, or the day turned out fine: the default does as well.
                    // Only two reviews in a row clear the schedule, so a single read on the
                    // wrong side of a reset cannot flap it. When every start left comes before
                    // the next review, it goes then, quietly, rather than with "back to normal"
                    // now.
                    if !self.schedule.is_empty() {
                        if beats(&current, &forecast_in_force(live)) {
                            self.default_no_worse = false;
                        } else if !self.default_no_worse {
                            self.default_no_worse = true;
                        } else if self
                            .schedule
                            .values()
                            .any(|time| time - now > SEARCH_EVERY_MS)
                        {
                            self.clear();
                        }
                    }
                }
            }
        }
        if on && self.quiet {
            let schedule = &self.schedule;
            self.announced
                .retain(|id, time| schedule.get(id) == Some(&*time));
            self.quiet = false;
        }
        self.finish(now, factor, observed, on)
    }

    /// The plan was edited: nothing adopted still applies. It goes without a notice, and the
    /// next update reviews the day at once.
    pub fn reset(&mut self) {
        self.restart();
        self.quiet = true;
        self.last.schedule = JsMap::new();
        self.last.since = None;
    }

    /// The last result without its notice, less any start whose time has come.
    pub fn current(&self) -> AdaptiveResult {
        let now = (self.now)();
        let schedule: Schedule = self
            .last
            .schedule
            .iter()
            .filter(|(_, time)| **time > now)
            .map(|(id, time)| (id.clone(), *time))
            .collect();
        AdaptiveResult {
            since: if schedule.is_empty() {
                None
            } else {
                self.last.since
            },
            schedule,
            factor: self.last.factor,
            observed_rate: self.last.observed_rate,
            notice: None,
        }
    }

    /// The result; a notice when the schedule differs from what the user last heard, never
    /// while adaptation is off.
    fn finish(&mut self, now: f64, factor: f64, observed: Option<f64>, on: bool) -> AdaptiveResult {
        self.last = AdaptiveResult {
            schedule: self.schedule.clone(),
            factor,
            observed_rate: observed,
            since: self.since,
            notice: None,
        };
        if !on
            || key(&self.schedule) == key(&self.announced)
            || self
                .last_notice
                .is_some_and(|last| now - last < NOTIFY_EVERY_MS)
        {
            return self.last.clone();
        }
        self.last_notice = Some(now);
        self.announced = self.schedule.clone();
        AdaptiveResult {
            notice: Some(AdaptiveNotice {
                kind: if self.schedule.is_empty() {
                    AdaptiveNoticeKind::Normal
                } else {
                    AdaptiveNoticeKind::Updated
                },
                schedule: self.schedule.clone(),
            }),
            ..self.last.clone()
        }
    }

    /// The account runs a window opened after the adoption: someone used it. A window that
    /// opened by the adoption, give or take the jitter of reported resets, does not count.
    fn used_by_hand(&self, usage: Option<&AccountUsage>, now: f64) -> bool {
        let resets_at = usage
            .and_then(|u| u.five_hour.as_ref())
            .and_then(|w| w.resets_at.as_deref())
            .filter(|r| !r.is_empty());
        let (Some(since), Some(resets_at)) = (self.since, resets_at) else {
            return false;
        };
        if !fresh_usage(usage, now) {
            return false;
        }
        date_parse(resets_at) - WINDOW_MS > since && !same_reset(resets_at, &iso(since + WINDOW_MS))
    }

    fn adopt(&mut self, schedule: &Schedule, now: f64) {
        self.schedule = schedule.clone();
        self.since = if schedule.is_empty() { None } else { Some(now) };
        self.default_no_worse = false;
    }

    fn clear(&mut self) {
        self.schedule = JsMap::new();
        self.since = None;
        self.default_no_worse = false;
    }

    /// A new plan date or a clock moved back: nothing kept still applies.
    fn restart(&mut self) {
        self.clear();
        self.last_review = None;
    }
}
