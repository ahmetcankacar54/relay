//! Port of `shared/adaptive-plan.ts`: today's pace, and the next window starts re-chosen for
//! the rest of the day at that pace.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::capacity_plan::{Forecast, SimAccount, SimInput, ser_num_map, simulate_day};
use super::live_forecast::{LiveInput, live_setup};
use super::planning::plan_capacity;
use super::tempo::{Tempo, tempo_at};
use super::types::js::{self, JsMap, date_parse, ser_num, ser_opt_num};
use super::types::{Account, PlanningSettings};
use super::usage_rollups::{same_reset, valid_window};
use super::usage_statistics::{MAX_USAGE_GAP_MS, UsageSample, identity_owners};

const MINUTE_MS: f64 = 60_000.0;
const HOUR_MS: f64 = 3_600_000.0;
// Every zone's local hours begin on a quarter hour, so the tempo is constant within each.
const QUARTER_MS: f64 = 15.0 * MINUTE_MS;
/// How far back today's pace is measured.
pub const PACE_WINDOW_MS: f64 = HOUR_MS;
/// The plan never assumes more than three times its tempo.
pub const MAX_PACE: f64 = 3.0;
/// Under this many times the planned rate the day is on plan: whole-percent reads and the
/// minutes between them are this coarse.
pub const PACE_DEAD_BAND: f64 = 1.2;
// Under this much observed time a rate would be noise, not a pace.
const MIN_OBSERVED_MS: f64 = 30.0 * MINUTE_MS;

/// A stretch of time: `from` inclusive, `to` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Span {
    #[serde(serialize_with = "ser_num")]
    pub from: f64,
    #[serde(serialize_with = "ser_num")]
    pub to: f64,
}

struct Observation {
    /// Pro units used.
    units: f64,
    /// How far whole-percent reads may put `units` off: a percent of each window whose use
    /// rose (its first and highest reads are each rounded).
    resolution: f64,
    /// How long any identity was observed.
    observed_ms: f64,
    /// When any identity was observed, earliest first, apart.
    spans: Vec<Span>,
}

struct High<'a> {
    reset: &'a str,
    used: f64,
    rose: bool,
}

/// Pro units used in [from, to): increases over each five-hour window's high-water mark
/// between samples at most 35 minutes apart (the statistics rule), times the owning account's
/// plan capacity. Observed time is every gap of at most 35 minutes between an identity's
/// samples, whatever the window (a read without a usable window too), counted once where
/// identities overlap: every unit falls within it.
fn observe(samples: &[UsageSample], accounts: &[Account], from: f64, to: f64) -> Observation {
    let owners = identity_owners(accounts);
    let mut by_identity: IndexMap<&str, Vec<(f64, &UsageSample)>> = IndexMap::new();
    for sample in samples {
        let time = date_parse(&sample.checked_at);
        if !(time >= from && time < to) || !owners.contains_key(&sample.identity) {
            continue;
        }
        by_identity
            .entry(sample.identity.as_str())
            .or_default()
            .push((time, sample));
    }
    let mut units = 0.0;
    let mut resolution = 0.0;
    let mut gaps: Vec<Span> = Vec::new();
    for (identity, mut list) in by_identity {
        js::sort_by(&mut list, |a, b| a.0 - b.0);
        let capacity = plan_capacity(owners[identity]);
        let mut high: Option<High<'_>> = None;
        // A run of one window ends: a percent of it, if its use rose.
        let end = |high: &Option<High<'_>>, resolution: &mut f64| {
            if high.as_ref().is_some_and(|h| h.rose) {
                *resolution += capacity;
            }
        };
        for i in 0..list.len() {
            let (time, sample) = list[i];
            let before = if i > 0 {
                list[i - 1].0
            } else {
                f64::NEG_INFINITY
            };
            let gap = time - before;
            if gap <= MAX_USAGE_GAP_MS {
                gaps.push(Span {
                    from: before,
                    to: time,
                });
            }
            // Without a usable window there is no baseline, so no increase either here or at
            // the next sample.
            if !valid_window(sample) {
                end(&high, &mut resolution);
                high = None;
                continue;
            }
            let window = sample.five_hour.as_ref().expect("a valid window");
            let reset = window.resets_at.as_deref().expect("a valid window resets");
            let used = window.used_percent;
            match &high {
                Some(h) if gap <= MAX_USAGE_GAP_MS && same_reset(h.reset, reset) => {
                    units += js::max([0.0, used - h.used]) * capacity;
                    high = Some(High {
                        reset,
                        used: js::max([h.used, used]),
                        rose: h.rose || used > h.used,
                    });
                }
                _ => {
                    // A new window, or a sample after a gap: only a new baseline.
                    end(&high, &mut resolution);
                    high = Some(High {
                        reset,
                        used,
                        rose: false,
                    });
                }
            }
        }
        end(&high, &mut resolution);
    }
    js::sort_by(&mut gaps, |a, b| a.from - b.from);
    let mut spans: Vec<Span> = Vec::new();
    for gap in gaps {
        match spans.last_mut() {
            Some(last) if gap.from <= last.to => last.to = js::max([last.to, gap.to]),
            _ => spans.push(gap),
        }
    }
    let observed_ms = spans.iter().fold(0.0, |sum, s| sum + s.to - s.from);
    Observation {
        units,
        resolution,
        observed_ms,
        spans,
    }
}

/// Mean Pro units per hour the tempo plans over `spans` (0 for none), exact: each minute at its
/// own local hour and day type.
pub fn planned_rate(tempo: &Tempo, settings: &PlanningSettings, spans: &[Span]) -> f64 {
    let mut units = 0.0;
    let mut ms = 0.0;
    for span in spans {
        let mut time = span.from;
        while time < span.to {
            let next = span
                .to
                .min(((time / QUARTER_MS).floor() + 1.0) * QUARTER_MS);
            units += (tempo_at(tempo, settings, time) * (next - time)) / HOUR_MS;
            time = next;
        }
        ms += js::max([0.0, span.to - span.from]);
    }
    if ms > 0.0 {
        units / (ms / HOUR_MS)
    } else {
        0.0
    }
}

/// How many times faster than planned today is going: 1 (under 1.2 times the plan, no usable
/// measurement, or nothing planned) up to MAX_PACE, in tenths.
pub fn pace_factor(observed: Option<f64>, planned: f64) -> f64 {
    let Some(observed) = observed.filter(|o| o.is_finite()) else {
        return 1.0;
    };
    // `!(planned >= 1)`: NaN is no plan.
    if planned.is_nan() || planned < 1.0 {
        return 1.0;
    }
    let ratio = observed / planned;
    if ratio.is_nan() || ratio < PACE_DEAD_BAND {
        return 1.0;
    }
    js::round(MAX_PACE.min(ratio) * 10.0) / 10.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pace {
    /// Pro units an hour observed; absent under 30 observed minutes.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub observed: Option<f64>,
    /// Pro units an hour the tempo plans over the same stretches.
    #[serde(serialize_with = "ser_num")]
    pub planned: f64,
    #[serde(serialize_with = "ser_num")]
    pub factor: f64,
}

/// The input of [`todays_pace`].
#[derive(Debug, Clone, Copy)]
pub struct PaceInput<'a> {
    pub samples: &'a [UsageSample],
    pub accounts: &'a [Account],
    pub tempo: &'a Tempo,
    pub settings: &'a PlanningSettings,
    pub from: f64,
    pub to: f64,
}

/// Today's pace in [from, to): Pro units an hour observed (see `observe`) against the tempo's
/// over exactly the stretches observed, so time without a read counts on neither side; under
/// 30 observed minutes there is no rate. Use above the plan by no more than the reads' rounding
/// is no pace either (early in the work a percent of a large window can be most of it).
pub fn todays_pace(input: PaceInput<'_>) -> Pace {
    let seen = observe(input.samples, input.accounts, input.from, input.to);
    let planned = planned_rate(input.tempo, input.settings, &seen.spans);
    if seen.observed_ms < MIN_OBSERVED_MS {
        return Pace {
            observed: None,
            planned,
            factor: 1.0,
        };
    }
    let hours = seen.observed_ms / HOUR_MS;
    let observed = seen.units / hours;
    Pace {
        observed: Some(observed),
        planned,
        factor: if seen.units - planned * hours <= seen.resolution {
            1.0
        } else {
            pace_factor(Some(observed), planned)
        },
    }
}

/// The search starts from the default: `live.schedule` (an adopted schedule) is ignored.
#[derive(Debug, Clone, Copy)]
pub struct ReplanInput<'a> {
    /// The live forecast's input; `factor` is today's pace.
    pub live: LiveInput<'a>,
    /// Accounts the keeper cannot start now (identity, weekly limit, policy stop, daily limit,
    /// auto start off).
    pub blocked: &'a [String],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replan {
    /// Only accounts whose next start differs from the default.
    #[serde(serialize_with = "ser_num_map")]
    pub schedule: JsMap<f64>,
    pub forecast: Forecast,
    pub default_forecast: Forecast,
}

const HALF_HOUR: f64 = 30.0 * MINUTE_MS;
// Later starts tried per account besides the default.
const CHOICES: usize = 10;
fn ceil_half_hour(t: f64) -> f64 {
    (t / HALF_HOUR).ceil() * HALF_HOUR
}
// Up to this many accounts every combination is tried; more descend.
const EXHAUSTIVE: usize = 4;
const ROUNDS: usize = 4;

/// The default first (restart at the reset, or when the account's active range begins if that
/// is later; or start now / at the active range), then later half hours after `from` and
/// before `to`.
pub fn next_start_candidates(a: &SimAccount, from: f64, to: f64) -> Vec<f64> {
    let open = a.first_reset.is_some_and(|r| r > from);
    let base = match a.first_reset {
        Some(reset) if open => js::max([reset, a.restart_at.unwrap_or(reset)]),
        _ => a.warm_up.unwrap_or(from),
    };
    let first = if open || ceil_half_hour(base) == base {
        base + HALF_HOUR
    } else {
        ceil_half_hour(base)
    };
    let mut out = vec![base];
    for k in 0..CHOICES {
        out.push(first + k as f64 * HALF_HOUR);
    }
    // A warm-up counted at its planned time can lie a tick in the past; a later start must not.
    out.into_iter()
        .enumerate()
        .filter(|(k, t)| *t < to && (*k == 0 || *t > from))
        .map(|(_, t)| t)
        .collect()
}

struct Scored {
    picks: Vec<f64>,
    forecast: Forecast,
    key: [f64; 4],
}

fn better(a: &Scored, b: &Scored) -> bool {
    for i in 0..a.key.len() {
        if a.key[i] != b.key[i] {
            return a.key[i] < b.key[i];
        }
    }
    false
}

/// Re-chooses each startable account's next window start for the rest of today at today's
/// pace. The default (restart at reset, start a closed window now) is always scored, so the
/// result is never worse.
pub fn replan_starts(input: &ReplanInput<'_>) -> Option<Replan> {
    // A schedule carried along anyway would become the default.
    let setup = live_setup(LiveInput {
        schedule: None,
        ..input.live
    })?;
    // (index into the setup's accounts, its candidates)
    let searchable: Vec<(usize, Vec<f64>)> = setup
        .accounts
        .iter()
        .enumerate()
        .filter(|(_, a)| a.keep_alive && a.blocked != Some(true) && !input.blocked.contains(&a.id))
        .map(|(i, a)| (i, next_start_candidates(a, setup.from, setup.to)))
        // An account with no other start before the work end has nothing to choose.
        .filter(|(_, choices)| choices.len() > 1)
        .collect();
    let simulate = |picks: &[f64]| {
        let accounts: Vec<SimAccount> = setup
            .accounts
            .iter()
            .enumerate()
            .map(|(j, a)| {
                let Some(at) = searchable.iter().position(|(i, _)| *i == j) else {
                    return a.clone();
                };
                if picks[at] == searchable[at].1[0] {
                    return a.clone();
                }
                if a.first_reset.is_some_and(|r| r > setup.from) {
                    SimAccount {
                        restart_at: Some(picks[at]),
                        ..a.clone()
                    }
                } else {
                    SimAccount {
                        warm_up: Some(picks[at]),
                        ..a.clone()
                    }
                }
            })
            .collect();
        simulate_day(SimInput {
            accounts: &accounts,
            ..setup.sim_input()
        })
    };
    let score = |picks: Vec<f64>| {
        let forecast = simulate(&picks);
        let moved = picks
            .iter()
            .enumerate()
            .filter(|(k, p)| **p != searchable[*k].1[0])
            .count();
        let shift = picks
            .iter()
            .enumerate()
            .fold(0.0, |sum, (k, p)| sum + (p - searchable[k].1[0]));
        Scored {
            key: [
                js::round(forecast.unmet * 2.0) / 2.0,
                f64::from(forecast.switches),
                moved as f64,
                shift / MINUTE_MS,
            ],
            picks,
            forecast,
        }
    };
    let fallback = score(searchable.iter().map(|(_, c)| c[0]).collect());
    let mut best: Option<Scored> = None;
    if searchable.len() <= EXHAUSTIVE {
        fn pick(
            k: usize,
            picks: &mut Vec<f64>,
            searchable: &[(usize, Vec<f64>)],
            visit: &mut dyn FnMut(&[f64]),
        ) {
            if k == searchable.len() {
                visit(picks);
                return;
            }
            for &c in &searchable[k].1 {
                picks.truncate(k);
                picks.push(c);
                pick(k + 1, picks, searchable, visit);
            }
        }
        let mut visit = |picks: &[f64]| {
            let s = score(picks.to_vec());
            if better(&s, best.as_ref().unwrap_or(&fallback)) {
                best = Some(s);
            }
        };
        pick(0, &mut Vec::new(), &searchable, &mut visit);
    } else {
        for _ in 0..ROUNDS {
            let mut moved = false;
            for k in 0..searchable.len() {
                for &c in &searchable[k].1 {
                    let current = &best.as_ref().unwrap_or(&fallback).picks;
                    if c == current[k] {
                        continue;
                    }
                    let picks: Vec<f64> = current
                        .iter()
                        .enumerate()
                        .map(|(j, p)| if j == k { c } else { *p })
                        .collect();
                    let s = score(picks);
                    if better(&s, best.as_ref().unwrap_or(&fallback)) {
                        best = Some(s);
                        moved = true;
                    }
                }
            }
            if !moved {
                break;
            }
        }
    }
    let best = best.unwrap_or(Scored {
        picks: fallback.picks.clone(),
        forecast: fallback.forecast.clone(),
        key: fallback.key,
    });
    let mut schedule = JsMap::new();
    for (k, p) in best.picks.iter().enumerate() {
        if *p != searchable[k].1[0] {
            schedule.insert(setup.accounts[searchable[k].0].id.clone(), *p);
        }
    }
    Some(Replan {
        schedule,
        forecast: best.forecast,
        default_forecast: fallback.forecast,
    })
}
