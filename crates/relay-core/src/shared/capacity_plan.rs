//! Port of `shared/capacity-plan.ts`: a day simulated account by account, and the warm-up times
//! that leave the least unmet demand.

use std::cell::Cell;
use std::rc::Rc;

use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};

use super::account_order::week_band;
use super::types::js::{self, JsMap, Num, ser_num, ser_opt_num};
use super::work_hours::WINDOW_MS;

const HOUR_MS: f64 = 3_600_000.0;
const WEEK_MS: f64 = 7.0 * 24.0 * HOUR_MS;
const MINUTE_MS: f64 = 60_000.0;
pub const SIM_STEP_MS: f64 = 5.0 * MINUTE_MS;
const EPSILON: f64 = 1e-6;
/// A run-out this close to the step's end is float noise (it depends on how large the times
/// are), so it counts as running out at the end.
const RUN_OUT_SLACK_MS: f64 = 1.0;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimAccount {
    pub id: String,
    /// Pro-account multiples: a window holds `100 × capacity` Pro units.
    #[serde(serialize_with = "ser_num")]
    pub capacity: f64,
    /// A new window starts at each reset.
    pub keep_alive: bool,
    /// Pro units left in the open window.
    #[serde(serialize_with = "ser_num")]
    pub remaining: f64,
    /// Out of reach (for example, its weekly limit is used up).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
    /// When a `blocked` account is back (its week resets); absent means out all day.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub blocked_until: Option<f64>,
    /// When its week ends: a week that ends sooner is used first, since what is left of it is
    /// lost. Absent counts as a whole week away, as in the gateway.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub week_ends: Option<f64>,
    /// Reset of the open window; absent means no window is open.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub first_reset: Option<f64>,
    /// Hold the restart after the open window's reset until this time (first use starts it
    /// earlier).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub restart_at: Option<f64>,
    /// Planned start of a closed window (used only while no window is open).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub warm_up: Option<f64>,
}

/// The input of [`simulate_day`].
#[derive(Clone, Copy)]
pub struct SimInput<'a> {
    pub from: f64,
    pub to: f64,
    /// Demand in Pro units per hour at `time`.
    pub rate: &'a dyn Fn(f64) -> f64,
    pub accounts: &'a [SimAccount],
    /// The account in use at `from`, kept first while it has quota. Without one the first
    /// account is chosen when demand first arises.
    pub active: Option<&'a str>,
    /// Stops once this holds for the unmet demand and switches so far (both only grow), with
    /// the forecast cut short: the optimizer's way to drop a candidate that has already lost.
    pub stop_when: Option<&'a dyn Fn(f64, u32) -> bool>,
}

/// A stretch served by one account; no `account_id` is an outage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastSegment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(serialize_with = "ser_num")]
    pub from: f64,
    #[serde(serialize_with = "ser_num")]
    pub to: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub segments: Vec<ForecastSegment>,
    /// Pro units of demand nobody could serve.
    #[serde(serialize_with = "ser_num")]
    pub unmet: f64,
    #[serde(serialize_with = "ser_num")]
    pub outage_minutes: f64,
    pub switches: u32,
    #[serde(serialize_with = "ser_times")]
    pub exhausted_at: JsMap<Vec<f64>>,
}

/// A record of time lists, numbers written as `JSON.stringify` does.
pub fn ser_times<S: Serializer>(map: &JsMap<Vec<f64>>, serializer: S) -> Result<S::Ok, S::Error> {
    let mut out = serializer.serialize_map(Some(map.len()))?;
    for (key, times) in map {
        let times: Vec<Num> = times.iter().map(|t| Num(*t)).collect();
        out.serialize_entry(key, &times)?;
    }
    out.end()
}

/// A record of numbers, written as `JSON.stringify` does.
pub fn ser_num_map<S: Serializer>(map: &JsMap<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    let mut out = serializer.serialize_map(Some(map.len()))?;
    for (key, value) in map {
        out.serialize_entry(key, &Num(*value))?;
    }
    out.end()
}

thread_local! {
    static SIMULATIONS: Cell<u64> = const { Cell::new(0) };
}

/// How many days this thread has simulated: tests count a search's simulations with it (the
/// TS tests count demand reads through a tempo whose numbers count themselves).
pub fn simulations_on_this_thread() -> u64 {
    SIMULATIONS.with(Cell::get)
}

struct SimState {
    capacity: f64,
    order: usize,
    reset: Option<f64>,
    warm_up: Option<f64>,
    restart_at: Option<f64>,
    keep_alive: bool,
    left: f64,
    blocked: bool,
    blocked_until: Option<f64>,
    week_ends: f64,
}

fn minute(time: f64) -> f64 {
    js::round(time / MINUTE_MS) * MINUTE_MS
}

/// `a || b` on numbers: `0` and `NaN` fall through.
fn or(a: f64, b: impl FnOnce() -> f64) -> f64 {
    if a != 0.0 && !a.is_nan() { a } else { b() }
}

/// An open segment: the account's index (none is an outage), from, to.
type Segment = (Option<usize>, f64, f64);

struct Sim<'a> {
    input: SimInput<'a>,
    states: Vec<SimState>,
    earliest_week: f64,
    segments: Vec<Segment>,
    /// The segment still running; none after a gap closes with the demand.
    open: Option<usize>,
    exhausted_at: JsMap<Vec<f64>>,
    unmet: f64,
    outage_ms: f64,
    switches: u32,
    last_used: Option<usize>,
    stopped: bool,
}

impl Sim<'_> {
    fn advance(&mut self, time: f64) {
        for s in &mut self.states {
            if s.blocked && s.blocked_until.is_some_and(|until| time >= until) {
                s.blocked = false;
            }
            // A week that ended starts again: what it has left is no longer at risk.
            while s.week_ends <= time {
                s.week_ends += WEEK_MS;
            }
            loop {
                if s.reset.is_none()
                    && let Some(warm_up) = s.warm_up.filter(|w| *w <= time)
                {
                    s.reset = Some(warm_up + WINDOW_MS);
                    s.left = 100.0 * s.capacity;
                    s.warm_up = None;
                    continue;
                }
                if let Some(reset) = s.reset.filter(|r| *r <= time) {
                    s.left = 100.0 * s.capacity;
                    match s.restart_at.filter(|r| *r > reset) {
                        // Held: closed (full) until the restart, unless used first.
                        Some(restart) => {
                            s.warm_up = Some(restart);
                            s.reset = None;
                        }
                        None => {
                            s.reset = s.keep_alive.then_some(reset + WINDOW_MS);
                        }
                    }
                    s.restart_at = None;
                    continue;
                }
                break;
            }
        }
    }

    fn precedes(&self, a: &SimState, b: &SimState) -> bool {
        // Two closed windows give Infinity − Infinity = NaN, which falls through.
        let band =
            week_band(a.week_ends, self.earliest_week) - week_band(b.week_ends, self.earliest_week);
        or(band, || {
            or(
                a.reset.unwrap_or(f64::INFINITY) - b.reset.unwrap_or(f64::INFINITY),
                || or(b.capacity - a.capacity, || a.order as f64 - b.order as f64),
            )
        }) < 0.0
    }

    fn choose(&self) -> Option<usize> {
        let mut chosen: Option<usize> = None;
        for (i, s) in self.states.iter().enumerate() {
            if !s.blocked
                && s.left > EPSILON
                && chosen.is_none_or(|c| self.precedes(s, &self.states[c]))
            {
                chosen = Some(i);
            }
        }
        chosen
    }

    /// A blocked account coming back is an event too: an outage ends then.
    fn next_event(&self, after: f64) -> f64 {
        let mut next = f64::INFINITY;
        for s in &self.states {
            if let Some(time) = s.reset.or(s.warm_up)
                && time > after
                && time < next
            {
                next = time;
            }
            if s.blocked
                && let Some(until) = s.blocked_until
                && until > after
                && until < next
            {
                next = until;
            }
        }
        next
    }

    fn check(&mut self) {
        if self
            .input
            .stop_when
            .is_some_and(|stop| stop(self.unmet, self.switches))
        {
            self.stopped = true;
        }
    }

    fn mark(&mut self, account: Option<usize>, at: f64) {
        let time = minute(at);
        if let Some(open) = self.open {
            if self.segments[open].0 == account {
                return;
            }
            self.segments[open].2 = time;
        }
        if let (Some(a), Some(last)) = (account, self.last_used)
            && a != last
        {
            self.switches += 1;
            self.check();
        }
        if account.is_some() {
            self.last_used = account;
        }
        self.segments.push((account, time, time));
        self.open = Some(self.segments.len() - 1);
    }

    fn exhaust(&mut self, account: usize, at: f64) {
        let id = &self.input.accounts[account].id;
        self.exhausted_at
            .entry_or_insert_with(id, Vec::new)
            .push(minute(at));
    }
}

/// One person working on one account at a time: the open account serves the demand; when it
/// runs out, the account with quota whose week ends first takes over (weeks within a few hours
/// of each other tie), then the one whose window resets soonest (closed windows last), then
/// larger capacity, then order.
pub fn simulate_day(input: SimInput<'_>) -> Forecast {
    SIMULATIONS.with(|count| count.set(count.get() + 1));
    let unknown_week = input.from + WEEK_MS;
    let states: Vec<SimState> = input
        .accounts
        .iter()
        .enumerate()
        .map(|(order, a)| SimState {
            capacity: a.capacity,
            order,
            reset: a.first_reset,
            warm_up: if a.first_reset.is_none() {
                a.warm_up
            } else {
                None
            },
            restart_at: a.restart_at,
            keep_alive: a.keep_alive,
            left: a.remaining,
            blocked: a.blocked == Some(true),
            blocked_until: a.blocked_until,
            // An unknown week counts as a whole week away, so weeks always compare.
            week_ends: a.week_ends.unwrap_or(unknown_week),
        })
        .collect();
    let mut earliest_week = f64::INFINITY;
    for s in &states {
        if s.week_ends < earliest_week {
            earliest_week = s.week_ends;
        }
    }
    let mut sim = Sim {
        input,
        states,
        earliest_week,
        segments: Vec::new(),
        open: None,
        exhausted_at: JsMap::new(),
        unmet: 0.0,
        outage_ms: 0.0,
        switches: 0,
        last_used: None,
        stopped: false,
    };

    sim.advance(input.from);
    let mut active = sim.states.iter().enumerate().position(|(i, s)| {
        input.active == Some(input.accounts[i].id.as_str()) && !s.blocked && s.left > EPSILON
    });
    if active.is_some() {
        sim.mark(active, input.from);
    }
    let mut t = input.from;
    while t < input.to && !sim.stopped {
        let end = input.to.min(t + SIM_STEP_MS);
        sim.advance(t);
        let per_ms = js::max([0.0, (input.rate)(t)]) / HOUR_MS;
        if per_ms <= 0.0
            && let Some(open) = sim.open
            && sim.segments[open].0.is_none()
        {
            // A gap is unmet demand only: it closes when the demand stops; the next account is
            // chosen when the demand resumes.
            sim.segments[open].2 = minute(t);
            sim.open = None;
        }
        let mut cursor = t;
        while cursor < end && per_ms > 0.0 && !sim.stopped {
            if active.is_none_or(|a| sim.states[a].left <= EPSILON) {
                sim.advance(cursor);
                active = sim.choose();
                sim.mark(active, cursor);
                if active.is_none() {
                    let until = end.min(sim.next_event(cursor));
                    sim.unmet += per_ms * (until - cursor);
                    sim.check();
                    sim.outage_ms += until - cursor;
                    cursor = until;
                    sim.advance(cursor);
                    continue;
                }
            }
            let a = active.expect("an account was chosen");
            let state = &mut sim.states[a];
            let reset = match state.reset {
                Some(reset) => reset,
                None => {
                    state.warm_up = None;
                    *state.reset.insert(cursor + WINDOW_MS)
                }
            };
            // Its own window refreshes within this step: serve until then and go on with it,
            // the way a refresh at a step boundary does.
            let until = if reset > cursor && reset < end {
                reset
            } else {
                end
            };
            let run_out = cursor + state.left / per_ms;
            if run_out >= until - RUN_OUT_SLACK_MS {
                state.left -= per_ms * (until - cursor);
                cursor = until;
                if state.left <= EPSILON {
                    state.left = 0.0;
                    sim.exhaust(a, until);
                }
                if until < end {
                    sim.advance(until);
                }
            } else {
                state.left = 0.0;
                sim.exhaust(a, run_out);
                cursor = run_out;
            }
        }
        t = end;
    }
    if let Some(open) = sim.open {
        sim.segments[open].2 = minute(t);
    }
    Forecast {
        segments: sim
            .segments
            .iter()
            .filter(|(_, from, to)| to > from)
            .map(|&(account, from, to)| ForecastSegment {
                account_id: account.map(|a| input.accounts[a].id.clone()),
                from,
                to,
            })
            .collect(),
        unmet: js::round(sim.unmet * 10.0) / 10.0,
        outage_minutes: js::round(sim.outage_ms / MINUTE_MS),
        switches: sim.switches,
        exhausted_at: sim.exhausted_at,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StartInterval {
    #[serde(serialize_with = "ser_num")]
    pub start: f64,
    #[serde(serialize_with = "ser_num")]
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartAccount {
    pub id: String,
    #[serde(serialize_with = "ser_num")]
    pub capacity: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub manual: Option<f64>,
}

/// The input of [`optimize_starts`].
#[derive(Clone, Copy)]
pub struct StartPlanInput<'a> {
    pub interval: StartInterval,
    pub accounts: &'a [StartAccount],
    pub rate: &'a dyn Fn(f64) -> f64,
    /// The even spread: the baseline every plan is compared with. It is evaluated as given, so
    /// for an account with a `manual` start the caller must put that same start at its index.
    pub even: &'a [f64],
    /// Whether a candidate's simulation stops once it is sure to lose (`None` = the default,
    /// on; tests compare the plans with and without).
    pub early_stop: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPlan {
    #[serde(serialize_with = "js::ser_nums")]
    pub starts: Vec<f64>,
    pub forecast: Forecast,
    pub even_forecast: Forecast,
}

const GRID_MS: f64 = 15.0 * MINUTE_MS;
const CANDIDATES: usize = 20;
const EXHAUSTIVE_FINE: usize = 3;
const EXHAUSTIVE_COARSE: usize = 4;
const SEEDS: usize = 8;
const ROUNDS: usize = 4;

/// The smallest distance between two accounts' reset phases around the five-hour cycle; a lone
/// account has the whole cycle.
fn min_circular_gap(starts: &[f64], origin: f64) -> f64 {
    if starts.len() < 2 {
        return WINDOW_MS;
    }
    let mut phases: Vec<f64> = starts
        .iter()
        .map(|s| (((s - origin) % WINDOW_MS) + WINDOW_MS) % WINDOW_MS)
        .collect();
    js::sort_by(&mut phases, |a, b| a - b);
    let mut gap = phases[0] + WINDOW_MS - phases[phases.len() - 1];
    for i in 1..phases.len() {
        gap = gap.min(phases[i] - phases[i - 1]);
    }
    gap
}

struct Scored {
    starts: Vec<f64>,
    forecast: Forecast,
    key: [f64; 5],
}

/// The plan's order: every part of the key.
fn better(a: &Scored, b: &Scored) -> bool {
    for i in 0..a.key.len() {
        if a.key[i] != b.key[i] {
            return a.key[i] < b.key[i];
        }
    }
    false
}

/// The search's order: the key without the spread. Descents and the kept seeds follow it, so
/// the search visits what it visited before the spread counted and the spread only chooses
/// among what it finds; a descent led by the spread settles early and misses plans with fewer
/// switches.
fn leads(a: &Scored, b: &Scored) -> bool {
    for i in 0..a.key.len() {
        if i != 2 && a.key[i] != b.key[i] {
            return a.key[i] < b.key[i];
        }
    }
    false
}

struct Optimizer<'a> {
    input: StartPlanInput<'a>,
    free: Vec<usize>,
    best: Rc<Scored>,
    /// The best by the search's order: where the last descent starts.
    lead: Rc<Scored>,
}

fn simulate(
    input: &StartPlanInput<'_>,
    starts: &[f64],
    stop_when: Option<&dyn Fn(f64, u32) -> bool>,
) -> Forecast {
    let start = input.interval.start;
    let accounts: Vec<SimAccount> = input
        .accounts
        .iter()
        .enumerate()
        .map(|(i, a)| SimAccount {
            id: a.id.clone(),
            capacity: a.capacity,
            keep_alive: true,
            remaining: 100.0 * a.capacity,
            first_reset: (starts[i] <= start).then_some(starts[i] + WINDOW_MS),
            warm_up: (starts[i] > start).then_some(starts[i]),
            ..SimAccount::default()
        })
        .collect();
    simulate_day(SimInput {
        from: start,
        to: input.interval.end,
        rate: input.rate,
        accounts: &accounts,
        active: None,
        stop_when,
    })
}

/// Scores `starts`. With a `rival` the simulation stops once the candidate is sure to lose to
/// it, so a stopped forecast is never kept. Unmet demand and switches only grow: more than the
/// rival's rounded unmet + 0.5 rounds above it, and at least its rounded unmet rounds no lower.
fn scored(input: &StartPlanInput<'_>, starts: Vec<f64>, rival: Option<&Scored>) -> Scored {
    let stop = rival
        .filter(|_| input.early_stop != Some(false))
        .map(|rival| {
            let (unmet_key, switches_key) = (rival.key[0], rival.key[1]);
            move |unmet: f64, switches: u32| {
                unmet > unmet_key + 0.5
                    || (unmet >= unmet_key && f64::from(switches) > switches_key)
            }
        });
    let forecast = simulate(
        input,
        &starts,
        stop.as_ref().map(|f| f as &dyn Fn(f64, u32) -> bool),
    );
    let key = [
        js::round(forecast.unmet * 2.0) / 2.0,
        f64::from(forecast.switches),
        -min_circular_gap(&starts, input.interval.start),
        -js::min(starts.iter().copied()),
        -starts.iter().sum::<f64>(),
    ];
    Scored {
        starts,
        forecast,
        key,
    }
}

impl Optimizer<'_> {
    /// Scores `starts` and keeps the best; it may stop early against a `rival` that the best is
    /// no worse than.
    fn consider(&mut self, starts: Vec<f64>, rival: Option<&Scored>) -> Rc<Scored> {
        let candidate = Rc::new(scored(&self.input, starts, rival));
        if better(&candidate, &self.best) {
            self.best = candidate.clone();
        }
        if leads(&candidate, &self.lead) {
            self.lead = candidate.clone();
        }
        candidate
    }

    /// Moves one free account at a time while that improves the plan.
    fn descend(&mut self, from: Rc<Scored>, grid: &[f64]) {
        let mut current = from;
        for _ in 0..ROUNDS {
            let mut moved = false;
            for i in self.free.clone() {
                for &c in grid {
                    if c == current.starts[i] {
                        continue;
                    }
                    let mut starts = current.starts.clone();
                    starts[i] = c;
                    // Only a candidate better than the current one matters (the best is no
                    // worse than the current one).
                    let candidate = self.consider(starts, Some(&current));
                    if leads(&candidate, &current) {
                        current = candidate;
                        moved = true;
                    }
                }
            }
            if !moved {
                break;
            }
        }
    }

    /// Every combination of `grid` for the free accounts; returns the best `keep`.
    fn enumerate(&mut self, grid: &[f64], keep: usize, fixed: &[f64]) -> Vec<Rc<Scored>> {
        let mut top: Vec<Rc<Scored>> = Vec::new();
        let mut starts = fixed.to_vec();
        self.pick(0, &mut starts, grid, keep, &mut top);
        top
    }

    fn pick(
        &mut self,
        index: usize,
        starts: &mut Vec<f64>,
        grid: &[f64],
        keep: usize,
        top: &mut Vec<Rc<Scored>>,
    ) {
        if index == self.free.len() {
            // A candidate matters while it could still join the kept few (the best is no worse
            // than any of them); with none to keep, only the best counts.
            let rival = if top.len() < keep {
                None
            } else {
                Some(
                    keep.checked_sub(1)
                        .and_then(|k| top.get(k))
                        .unwrap_or(&self.best)
                        .clone(),
                )
            };
            let candidate = self.consider(starts.clone(), rival.as_deref());
            let at = top
                .iter()
                .position(|t| leads(&candidate, t))
                .unwrap_or(top.len());
            if at < keep {
                top.insert(at, candidate);
                top.truncate(keep);
            }
            return;
        }
        for &c in grid {
            starts[self.free[index]] = c;
            self.pick(index + 1, starts, grid, keep, top);
        }
    }
}

/// Warm-up times for the free accounts that leave the least unmet demand, then the fewest
/// switches, then resets spread widest around the cycle (a surprise in demand finds a fresh
/// window sooner), then start as late as possible. Manual starts stay; the even spread is
/// always a candidate, so the result is never worse.
pub fn optimize_starts(input: StartPlanInput<'_>) -> StartPlan {
    let StartInterval { start, .. } = input.interval;
    let free: Vec<usize> = input
        .accounts
        .iter()
        .enumerate()
        .filter(|(_, a)| a.manual.is_none())
        .map(|(i, _)| i)
        .collect();
    let even_scored = Rc::new(scored(&input, input.even.to_vec(), None));
    if free.is_empty() {
        return StartPlan {
            starts: input.even.to_vec(),
            forecast: even_scored.forecast.clone(),
            even_forecast: even_scored.forecast.clone(),
        };
    }
    let mut optimizer = Optimizer {
        input,
        free,
        best: even_scored.clone(),
        lead: even_scored.clone(),
    };
    // Phase 0 is the work start itself: a window opened then costs no warm-up, so no candidate
    // warms up five hours early for nothing.
    let fine: Vec<f64> = (0..CANDIDATES)
        .map(|k| start - WINDOW_MS + (k + 1) as f64 * GRID_MS)
        .collect();
    let coarse: Vec<f64> = fine
        .iter()
        .enumerate()
        .filter(|(k, _)| k % 2 == 1)
        .map(|(_, c)| *c)
        .collect();
    let fixed: Vec<f64> = input
        .accounts
        .iter()
        .enumerate()
        .map(|(i, a)| a.manual.unwrap_or(input.even[i]))
        .collect();
    let free_count = optimizer.free.len();
    if free_count <= EXHAUSTIVE_FINE {
        optimizer.enumerate(&fine, 0, &fixed);
    } else if free_count <= EXHAUSTIVE_COARSE {
        for seed in optimizer.enumerate(&coarse, SEEDS, &fixed) {
            optimizer.descend(seed, &fine);
        }
    } else {
        let total: f64 = input.accounts.iter().map(|a| a.capacity).sum();
        let mut before = 0.0;
        let proportional: Vec<f64> = input
            .accounts
            .iter()
            .map(|a| {
                if let Some(manual) = a.manual {
                    return manual;
                }
                let target = start + (WINDOW_MS * (before + a.capacity / 2.0)) / total - WINDOW_MS;
                before += a.capacity;
                coarse
                    .iter()
                    .copied()
                    .reduce(|closest, c| {
                        if (c - target).abs() < (closest - target).abs() {
                            c
                        } else {
                            closest
                        }
                    })
                    .expect("the coarse grid is not empty")
            })
            .collect();
        let proportional = optimizer.consider(proportional, None);
        for seed in [even_scored.clone(), proportional] {
            optimizer.descend(seed, &coarse);
        }
        let lead = optimizer.lead.clone();
        optimizer.descend(lead, &fine);
    }
    StartPlan {
        starts: optimizer.best.starts.clone(),
        forecast: optimizer.best.forecast.clone(),
        even_forecast: even_scored.forecast.clone(),
    }
}
