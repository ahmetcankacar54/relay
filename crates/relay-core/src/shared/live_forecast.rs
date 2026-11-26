//! Port of `shared/live-forecast.ts`: the rest of today's work simulated from live usage.

use super::capacity_plan::{Forecast, SIM_STEP_MS, SimAccount, SimInput, simulate_day};
use super::day_plan::{DayPlan, PlanContext};
use super::tempo::tempo_rate;
use super::types::js::{self, JsMap, date_parse, iso};
use super::types::{AccountUsage, PlanningSettings};
use super::usage::fresh_usage;
use super::usage_rollups::same_reset;
use super::work_hours::WINDOW_MS;

const MINUTE_MS: f64 = 60_000.0;
const HOUR_MS: f64 = 3_600_000.0;
// A warm-up this recent counts at its planned time: the keeper's tick starts it a little late.
const ON_TIME_MS: f64 = 2.0 * MINUTE_MS;

/// `Math.max(a, b)`: `NaN` when either is.
fn max2(a: f64, b: f64) -> f64 {
    js::max([a, b])
}

/// The simulation inputs [`live_setup`] builds.
pub struct LiveSetup<'a> {
    pub from: f64,
    pub to: f64,
    pub accounts: Vec<SimAccount>,
    pub rate: Box<dyn Fn(f64) -> f64 + 'a>,
    pub active: Option<String>,
}

impl LiveSetup<'_> {
    /// The setup as a simulation input.
    pub fn sim_input(&self) -> SimInput<'_> {
        SimInput {
            from: self.from,
            to: self.to,
            rate: &*self.rate,
            accounts: &self.accounts,
            active: self.active.as_deref(),
            stop_when: None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LiveInput<'a> {
    pub plan: &'a DayPlan,
    pub settings: &'a PlanningSettings,
    pub context: &'a PlanContext,
    pub usage: &'a JsMap<AccountUsage>,
    /// The account Claude Desktop uses now; ignored unless it is planned.
    pub active_id: Option<&'a str>,
    pub now: f64,
    /// Today's pace multiplier for the tempo (default 1).
    pub factor: Option<f64>,
    /// accountId → next window start: an open window restarts then, a closed one starts then.
    pub schedule: Option<&'a JsMap<f64>>,
    /// Live times exactly as read: none counts as the plan's own nearby time.
    pub exact: bool,
}

/// The simulation inputs for the rest of today's work from live usage: what happens if work
/// goes on at the planned tempo (times `factor`). Accounts with fresh usage start from their
/// open window (weekly limit used up: out of reach until the week resets; a week that ends
/// sooner is used first); the others from the plan's window chain with a full quota. With
/// `autoStart` a closed window starts when the keeper would start it (now, or when the
/// account's active range begins), else at first use; a `schedule` entry holds an open window's
/// restart, or starts a closed window, at its time (now, if that has passed). Before work the
/// day runs from now with no demand until the work starts, so warm-ups and resets on the way
/// happen as they would; the account in use then does not count. During work the account in
/// use is read as of now: what the work since its read used (at the same pace) comes off, so a
/// read minutes old leaves no quota that is gone. A window the keeper may not restart yet (it
/// resets before the account's active range) restarts when that range begins. Live times
/// within a tick of the plan's own windows (a warm-up just started, a reset within the reported
/// jitter) count as planned, unless `exact`. Shared with the adaptive search.
pub fn live_setup(input: LiveInput<'_>) -> Option<LiveSetup<'_>> {
    let LiveInput {
        plan,
        settings,
        context,
        usage,
        active_id,
        now,
        factor,
        schedule,
        exact,
    } = input;
    let interval = plan.interval.as_ref()?;
    if now >= interval.end || plan.accounts.is_empty() {
        return None;
    }
    let early = now < interval.start;
    // Steps on the work start's five-minute grid, so the demand begins exactly then (nothing
    // happens between this and now).
    let from = if early {
        interval.start - ((interval.start - now) / SIM_STEP_MS).ceil() * SIM_STEP_MS
    } else {
        now
    };
    let keep_alive = settings.auto_start;
    let base = tempo_rate(
        &context.tempo,
        interval.weekend,
        &settings.time_zone,
        if early { interval.start } else { from },
        interval.end,
        SIM_STEP_MS,
    );
    let rate: Box<dyn Fn(f64) -> f64 + '_> = match factor.filter(|f| *f != 1.0) {
        None => Box::new(base),
        Some(factor) => Box::new(move |time| factor * base(time)),
    };
    let active = active_id.filter(|id| !early && plan.accounts.iter().any(|a| a.account_id == *id));
    // Pro units the work used from `checked` (or the work start) to now.
    let used_since = |checked: f64| {
        let mut units = 0.0;
        let mut time = max2(checked, interval.start);
        while time < now {
            units += (rate(time) * MINUTE_MS.min(now - time)) / HOUR_MS;
            time += MINUTE_MS;
        }
        units
    };
    let accounts: Vec<SimAccount> = plan
        .accounts
        .iter()
        .map(|p| {
            let capacity = context
                .capacities
                .get(&p.account_id)
                .copied()
                .unwrap_or(1.0);
            let next = schedule.and_then(|s| s.get(&p.account_id)).copied();
            // The plan's own window boundary nearest `time`: the warm-up at activeFrom, then
            // every five hours.
            let planned = |time: f64| {
                p.active_from + max2(0.0, js::round((time - p.active_from) / WINDOW_MS)) * WINDOW_MS
            };
            // The keeper starts a due window right away (inside its active range); a
            // scheduled start already past starts it now, too.
            let due = || {
                if now < p.active_from {
                    return p.active_from;
                }
                let start = planned(now);
                if !exact && start <= now && now - start < ON_TIME_MS {
                    start
                } else {
                    now
                }
            };
            let closed_warm_up = match next {
                Some(next) => Some(max2(now, next)),
                None if keep_alive && now < p.active_until => Some(due()),
                None => None,
            };
            let u = usage.get(&p.account_id);
            if let Some(u) = u.filter(|u| fresh_usage(Some(u), now)) {
                let five = u.five_hour.as_ref();
                let reported = date_parse(five.and_then(|w| w.resets_at.as_deref()).unwrap_or(""));
                let open = reported.is_finite() && reported > now;
                let used = if open {
                    five.map_or(0.0, |w| w.used_percent)
                } else {
                    0.0
                };
                let end = planned(reported);
                let reset = if !exact
                    && end > max2(now, p.active_from)
                    && same_reset(&iso(reported), &iso(end))
                {
                    end
                } else {
                    reported
                };
                let restart_at = next.or(if keep_alive && reset < p.active_from {
                    Some(p.active_from)
                } else {
                    None
                });
                let left = 100.0 * capacity * max2(0.0, 1.0 - used / 100.0);
                let week = u.seven_day.as_ref();
                let week_ends = date_parse(week.and_then(|w| w.resets_at.as_deref()).unwrap_or(""));
                let week_known = week_ends.is_finite();
                let week_spent = week.map_or(0.0, |w| w.used_percent) >= 100.0;
                let remaining = if open && Some(p.account_id.as_str()) == active {
                    let checked = date_parse(u.checked_at.as_deref().unwrap_or(""));
                    max2(0.0, left - used_since(checked))
                } else {
                    left
                };
                return SimAccount {
                    id: p.account_id.clone(),
                    capacity,
                    keep_alive,
                    remaining,
                    // A used-up week is out of reach until it resets (all day when no reset is
                    // known).
                    blocked: Some(week_spent),
                    blocked_until: (week_spent && week_known).then_some(week_ends),
                    week_ends: week_known.then_some(week_ends),
                    first_reset: open.then_some(reset),
                    restart_at: if open { restart_at } else { None },
                    warm_up: if open { None } else { closed_warm_up },
                };
            }
            let current = p.windows.iter().find(|w| w.start <= now && w.end > now);
            SimAccount {
                id: p.account_id.clone(),
                capacity,
                keep_alive,
                remaining: 100.0 * capacity,
                first_reset: current.map(|w| w.end),
                restart_at: if current.is_some() { next } else { None },
                warm_up: if current.is_some() {
                    None
                } else {
                    closed_warm_up
                },
                ..SimAccount::default()
            }
        })
        .collect();
    let work_start = interval.start;
    Some(LiveSetup {
        from,
        to: interval.end,
        accounts,
        rate: if early {
            Box::new(move |time| if time < work_start { 0.0 } else { rate(time) })
        } else {
            rate
        },
        active: active.map(str::to_string),
    })
}

/// The rest of today's work from live usage, simulated from [`live_setup`].
pub fn live_forecast(input: LiveInput<'_>) -> Option<Forecast> {
    let setup = live_setup(input)?;
    Some(simulate_day(setup.sim_input()))
}
