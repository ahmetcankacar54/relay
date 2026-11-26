//! Port of `shared/day-plan.ts`: each planned account's warm-ups and windows for one day.

use std::sync::{Arc, LazyLock, Mutex};

use indexmap::IndexMap;
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::capacity_plan::{
    Forecast, SIM_STEP_MS, StartAccount, StartInterval, StartPlanInput, optimize_starts,
};
use super::planning::{local_date, plan_capacity, wall_time};
use super::tempo::{Tempo, tempo_rate};
use super::types::js::{self, JsMap, ser_num};
use super::types::{Account, PlanningSettings};

pub use super::work_hours::{
    WINDOW_MS, WorkInterval, day_start, is_weekend, shift_date, work_interval,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlannedWindow {
    #[serde(serialize_with = "ser_num")]
    pub start: f64,
    #[serde(serialize_with = "ser_num")]
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDayPlan {
    pub account_id: String,
    /// Warm-up time of the day's first window.
    #[serde(serialize_with = "ser_num")]
    pub first_start: f64,
    /// The evenly spread warm-up the capacity-aware plan is compared with.
    #[serde(serialize_with = "ser_num")]
    pub even_start: f64,
    pub manual: bool,
    pub windows: Vec<PlannedWindow>,
    /// Relay keeps a window running between these times.
    #[serde(serialize_with = "ser_num")]
    pub active_from: f64,
    #[serde(serialize_with = "ser_num")]
    pub active_until: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayPlan {
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<WorkInterval>,
    /// The day simulated with the chosen first starts (shared with the cache).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_shared",
        deserialize_with = "de_shared"
    )]
    pub forecast: Option<Arc<Forecast>>,
    /// The day simulated with the even spread (shared with the cache).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_shared",
        deserialize_with = "de_shared"
    )]
    pub even_forecast: Option<Arc<Forecast>>,
    pub accounts: Vec<AccountDayPlan>,
}

fn ser_shared<S: Serializer>(
    value: &Option<Arc<Forecast>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(forecast) => forecast.as_ref().serialize(serializer),
        None => serializer.serialize_none(),
    }
}

fn de_shared<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Arc<Forecast>>, D::Error> {
    Ok(Option::<Forecast>::deserialize(deserializer)?.map(Arc::new))
}

/// What the plan needs beyond the settings: how big each account is and how fast quota goes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanContext {
    /// `plan_capacity` per account id; a missing id counts as 1.
    #[serde(serialize_with = "super::capacity_plan::ser_num_map")]
    pub capacities: JsMap<f64>,
    pub tempo: Tempo,
}

pub fn plan_context(accounts: &[Account], tempo: Tempo) -> PlanContext {
    PlanContext {
        capacities: accounts
            .iter()
            .map(|a| (a.id.clone(), plan_capacity(a)))
            .collect(),
        tempo,
    }
}

fn cycle(value: f64) -> f64 {
    ((value % WINDOW_MS) + WINDOW_MS) % WINDOW_MS
}

/// Reset phases within the five-hour cycle. Without fixed phases they are spread evenly;
/// otherwise each free account takes the middle of the widest gap.
pub fn cycle_phases(fixed: &[Option<f64>]) -> Vec<f64> {
    let count = fixed.len() as f64;
    if fixed.iter().all(Option::is_none) {
        return (0..fixed.len())
            .map(|index| (WINDOW_MS * (index as f64 + 0.5)) / count)
            .collect();
    }
    let mut phases: Vec<Option<f64>> = fixed.iter().map(|p| p.map(cycle)).collect();
    let mut placed: Vec<f64> = phases.iter().flatten().copied().collect();
    js::sort_by(&mut placed, |a, b| a - b);
    for phase in &mut phases {
        if phase.is_some() {
            continue;
        }
        let (mut gap_start, mut gap) = (0.0, -1.0);
        for (k, &point) in placed.iter().enumerate() {
            let next = if k + 1 < placed.len() {
                placed[k + 1]
            } else {
                placed[0] + WINDOW_MS
            };
            if next - point > gap {
                gap = next - point;
                gap_start = point;
            }
        }
        let chosen = cycle(gap_start + gap / 2.0);
        *phase = Some(chosen);
        placed.push(chosen);
        js::sort_by(&mut placed, |a, b| a - b);
    }
    phases.into_iter().map(|p| p.unwrap_or(f64::NAN)).collect()
}

/// `Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))`.
fn clock_minutes(clock: &str) -> f64 {
    let part = |range: std::ops::Range<usize>| clock.get(range).map_or(f64::NAN, js::number_value);
    part(0..2) * 60.0 + part(3..5)
}

/// A manual first start is the occurrence of its clock between five hours before work and the
/// end of work (earliest first), so a night shift's 00:30 is that night. A clock with no useful
/// occurrence — or one skipped by DST — keeps its five-hour rhythm and warms up in the five
/// hours before work.
fn manual_start(
    date: &str,
    clock: &str,
    interval: &WorkInterval,
    start_clock: &str,
    zone: &str,
) -> f64 {
    let useful: Vec<f64> = [-1.0, 0.0, 1.0]
        .into_iter()
        .filter_map(|delta| wall_time(&shift_date(date, delta), clock, zone))
        .filter(|time| *time > interval.start - WINDOW_MS && *time < interval.end)
        .collect();
    if !useful.is_empty() {
        return js::min(useful);
    }
    let phase = cycle((clock_minutes(clock) - clock_minutes(start_clock)) * 60_000.0);
    interval.start + phase - WINDOW_MS
}

// Optimizing is the expensive part. It does not depend on live resets, and a day solved
// relative to its work start serves every date of the same shape: the same length, demand per
// simulation step, accounts and start offsets.
const CACHE_SIZE: usize = 32;

/// An optimized day: starts and the two forecasts, shared by every plan that uses them.
#[derive(Debug)]
struct SharedPlan {
    starts: Vec<f64>,
    forecast: Arc<Forecast>,
    even_forecast: Arc<Forecast>,
}

#[derive(Default)]
struct PlanCache {
    /// Plans by day shape, in times relative to the work start.
    shape: IndexMap<String, Arc<SharedPlan>>,
    /// Plans by date in absolute times, so a repeated call shares the same forecasts.
    date: IndexMap<String, Arc<SharedPlan>>,
    /// Shape-cache misses, each one optimization.
    optimizations: u64,
}

static CACHE: LazyLock<Mutex<PlanCache>> = LazyLock::new(Mutex::default);

fn cache() -> std::sync::MutexGuard<'static, PlanCache> {
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn remember(cache: &mut IndexMap<String, Arc<SharedPlan>>, key: String, plan: Arc<SharedPlan>) {
    cache.insert(key, plan);
    if cache.len() > CACHE_SIZE {
        cache.shift_remove_index(0);
    }
}

/// Forgets every cached optimization (tests compare cached and fresh plans).
pub fn clear_plan_cache() {
    let mut cache = cache();
    cache.shape.clear();
    cache.date.clear();
    cache.optimizations = 0;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanCacheStats {
    pub optimizations: u64,
}

/// How many optimizations ran since the cache was last cleared.
pub fn plan_cache_stats() -> PlanCacheStats {
    PlanCacheStats {
        optimizations: cache().optimizations,
    }
}

fn shifted(forecast: &Forecast, by: f64) -> Forecast {
    let mut out = forecast.clone();
    for s in &mut out.segments {
        s.from += by;
        s.to += by;
    }
    for times in out.exhausted_at.values_mut() {
        for time in times {
            *time += by;
        }
    }
    out
}

fn account_key(account: &StartAccount) -> serde_json::Value {
    match account.manual {
        Some(manual) => json!({"id": account.id, "capacity": account.capacity, "manual": manual}),
        None => json!({"id": account.id, "capacity": account.capacity}),
    }
}

fn planned_starts(
    interval: &WorkInterval,
    settings: &PlanningSettings,
    context: &PlanContext,
    manual: &[Option<f64>],
    even: &[f64],
) -> Arc<SharedPlan> {
    let accounts: Vec<StartAccount> = settings
        .accounts
        .iter()
        .enumerate()
        .map(|(i, a)| StartAccount {
            id: a.id.clone(),
            capacity: context.capacities.get(&a.id).copied().unwrap_or(1.0),
            manual: manual[i],
        })
        .collect();
    let profile = if interval.weekend {
        &context.tempo.weekend
    } else {
        &context.tempo.weekday
    };
    let date_key = json!([
        interval.start,
        interval.end,
        settings.time_zone,
        accounts.iter().map(account_key).collect::<Vec<_>>(),
        even,
        profile,
    ])
    .to_string();
    if let Some(known) = cache().date.get(&date_key) {
        return known.clone();
    }
    let origin = interval.start;
    let duration = interval.end - origin;
    // Demand per step from the work start; it carries the zone's offsets (DST).
    let rate = tempo_rate(
        &context.tempo,
        interval.weekend,
        &settings.time_zone,
        origin,
        interval.end,
        SIM_STEP_MS,
    );
    let mut steps: Vec<f64> = Vec::new();
    let mut time = origin;
    while time < interval.end {
        steps.push(rate(time));
        time += SIM_STEP_MS;
    }
    let relative: Vec<StartAccount> = accounts
        .iter()
        .map(|a| StartAccount {
            manual: a.manual.map(|m| m - origin),
            ..a.clone()
        })
        .collect();
    let offsets: Vec<f64> = even.iter().map(|start| start - origin).collect();
    let shape_key = json!([
        duration,
        steps,
        relative.iter().map(account_key).collect::<Vec<_>>(),
        offsets,
    ])
    .to_string();
    let known = cache().shape.get(&shape_key).cloned();
    let shape = match known {
        Some(shape) => shape,
        None => {
            let step_rate = |time: f64| {
                let index = (time / SIM_STEP_MS).floor();
                if index >= 0.0 {
                    steps.get(index as usize).copied().unwrap_or(0.0)
                } else {
                    0.0
                }
            };
            let plan = optimize_starts(StartPlanInput {
                interval: StartInterval {
                    start: 0.0,
                    end: duration,
                },
                accounts: &relative,
                rate: &step_rate,
                even: &offsets,
                early_stop: None,
            });
            let shape = Arc::new(SharedPlan {
                starts: plan.starts,
                forecast: Arc::new(plan.forecast),
                even_forecast: Arc::new(plan.even_forecast),
            });
            let mut cache = cache();
            cache.optimizations += 1;
            remember(&mut cache.shape, shape_key, shape.clone());
            shape
        }
    };
    let plan = Arc::new(SharedPlan {
        starts: shape.starts.iter().map(|start| start + origin).collect(),
        forecast: Arc::new(shifted(&shape.forecast, origin)),
        even_forecast: Arc::new(shifted(&shape.even_forecast, origin)),
    });
    remember(&mut cache().date, date_key, plan.clone());
    plan
}

/// The day's warm-ups and windows per planned account. Automatic first starts come from
/// simulating the day by capacity and tempo; manual ones stay. `live_resets` (account id → the
/// open window's reset) continues an account's chain from its actual window.
pub fn day_plan(
    date: &str,
    settings: &PlanningSettings,
    context: &PlanContext,
    live_resets: Option<&JsMap<f64>>,
) -> DayPlan {
    let interval = match work_interval(date, settings) {
        Some(interval) if !settings.accounts.is_empty() => interval,
        interval => {
            return DayPlan {
                date: date.to_string(),
                interval,
                forecast: None,
                even_forecast: None,
                accounts: Vec::new(),
            };
        }
    };
    let start_clock = if interval.weekend {
        &settings.weekend.start
    } else {
        &settings.weekday.start
    };
    let manual: Vec<Option<f64>> = settings
        .accounts
        .iter()
        .map(|account| {
            account
                .first_start
                .as_deref()
                .filter(|clock| !clock.is_empty())
                .map(|clock| manual_start(date, clock, &interval, start_clock, &settings.time_zone))
        })
        .collect();
    let phases = cycle_phases(
        &manual
            .iter()
            .map(|start| start.map(|s| s + WINDOW_MS - interval.start))
            .collect::<Vec<_>>(),
    );
    let even: Vec<f64> = (0..settings.accounts.len())
        .map(|i| manual[i].unwrap_or(interval.start + phases[i] - WINDOW_MS))
        .collect();
    let planned = planned_starts(&interval, settings, context, &manual, &even);
    let accounts = settings
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let first_start = planned.starts[index];
            let mut windows = Vec::new();
            let mut cursor = first_start;
            if let Some(live) = live_resets.and_then(|l| l.get(&account.id)).copied()
                && live > first_start
                && live - WINDOW_MS < interval.end
            {
                while cursor + WINDOW_MS <= live - WINDOW_MS {
                    windows.push(PlannedWindow {
                        start: cursor,
                        end: cursor + WINDOW_MS,
                    });
                    cursor += WINDOW_MS;
                }
                cursor = live - WINDOW_MS;
            }
            while cursor < interval.end {
                windows.push(PlannedWindow {
                    start: cursor,
                    end: cursor + WINDOW_MS,
                });
                cursor += WINDOW_MS;
            }
            AccountDayPlan {
                account_id: account.id.clone(),
                first_start,
                even_start: even[index],
                manual: manual[index].is_some(),
                windows,
                active_from: first_start,
                active_until: interval.end,
            }
        })
        .collect();
    DayPlan {
        date: date.to_string(),
        forecast: Some(planned.forecast.clone()),
        even_forecast: Some(planned.even_forecast.clone()),
        interval: Some(interval),
        accounts,
    }
}

fn plans_around(
    now: f64,
    settings: &PlanningSettings,
    context: &PlanContext,
    deltas: &[f64],
) -> Vec<DayPlan> {
    let today = local_date(now, &settings.time_zone);
    deltas
        .iter()
        .map(|delta| day_plan(&shift_date(&today, *delta), settings, context, None))
        .collect()
}

/// Whether Relay should keep a window running for this account now.
pub fn should_have_window(
    account_id: &str,
    now: f64,
    settings: &PlanningSettings,
    context: &PlanContext,
) -> bool {
    plans_around(now, settings, context, &[-1.0, 0.0, 1.0])
        .iter()
        .any(|plan| {
            plan.accounts.iter().any(|account| {
                account.account_id == account_id
                    && now >= account.active_from
                    && now < account.active_until
            })
        })
}

pub fn next_planned_start(
    account_id: &str,
    now: f64,
    settings: &PlanningSettings,
    context: &PlanContext,
) -> Option<f64> {
    let deltas: Vec<f64> = (0..8).map(f64::from).collect();
    let starts: Vec<f64> = plans_around(now, settings, context, &deltas)
        .iter()
        .flat_map(|plan| {
            plan.accounts
                .iter()
                .filter(|a| a.account_id == account_id && a.active_from > now)
                .map(|a| a.active_from)
                .collect::<Vec<_>>()
        })
        .collect();
    (!starts.is_empty()).then(|| js::min(starts))
}
