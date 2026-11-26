//! Port of `shared/tempo.ts`: how fast usage is consumed, in Pro units per hour, learned from the
//! rollups or taken from a preset.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::planning::{local_date, local_hour, local_slot, plan_capacity};
use super::types::js::{date_parse, round, ser_nums, sort_by};
use super::types::{Account, PlanningSettings, TempoChoice, literal_enum};
use super::usage_rollups::UsageRollups;
use super::usage_statistics::identity_owners;
use super::work_hours::{is_weekend, shift_date, work_interval};

const HOUR_MS: f64 = 3_600_000.0;
const TEMPO_DAYS: i32 = 28;
const MIN_TEMPO_DAYS: usize = 5;
const MIN_HOUR_COVERAGE: f64 = 15.0;
const BUSY_PERCENTILE: f64 = 0.75;

/// `TEMPO_PRESETS`: Pro units per hour of each preset.
pub fn tempo_preset(choice: TempoChoice) -> Option<f64> {
    match choice {
        TempoChoice::Light => Some(20.0),
        TempoChoice::Medium => Some(50.0),
        TempoChoice::Heavy => Some(120.0),
        TempoChoice::Auto => None,
    }
}

literal_enum!(TempoSource { Learned = "learned", Preset = "preset", Default = "default" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TempoRates {
    #[serde(serialize_with = "super::types::js::ser_num")]
    pub weekday: f64,
    #[serde(serialize_with = "super::types::js::ser_num")]
    pub weekend: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TempoDays {
    pub weekday: u32,
    pub weekend: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tempo {
    pub source: TempoSource,
    /// 24 values, Pro units per hour by local clock hour.
    #[serde(serialize_with = "ser_nums")]
    pub weekday: Vec<f64>,
    #[serde(serialize_with = "ser_nums")]
    pub weekend: Vec<f64>,
    /// Busy-day rate per day type.
    pub rate: TempoRates,
    /// Qualifying days used.
    pub days: TempoDays,
}

fn flat(rate: f64) -> Vec<f64> {
    vec![rate; 24]
}

fn round1(n: f64) -> f64 {
    round(n * 10.0) / 10.0
}

/// A preset's flat tempo; `choice` is never `Auto` (it reads as medium).
pub fn preset_tempo(choice: TempoChoice, source: TempoSource, days: TempoDays) -> Tempo {
    let rate = tempo_preset(choice).unwrap_or(50.0);
    Tempo {
        source,
        weekday: flat(rate),
        weekend: flat(rate),
        rate: TempoRates {
            weekday: rate,
            weekend: rate,
        },
        days,
    }
}

/// What the renderer assumes until the main process reports a tempo.
pub fn fallback_tempo(settings: &PlanningSettings) -> Tempo {
    match settings.tempo.unwrap_or(TempoChoice::Auto) {
        TempoChoice::Auto => preset_tempo(
            TempoChoice::Medium,
            TempoSource::Default,
            TempoDays::default(),
        ),
        choice => preset_tempo(choice, TempoSource::Preset, TempoDays::default()),
    }
}

struct DaySample {
    rate: f64,
    /// Local hour → rate, in insertion order.
    hours: IndexMap<u32, f64>,
}

#[derive(Clone, Copy, Default)]
struct Sum {
    units: f64,
    covered: f64,
}

/// What `learn_tempo` reads.
pub struct LearnTempoInput<'a> {
    pub rollups: Option<&'a UsageRollups>,
    pub accounts: &'a [Account],
    pub settings: &'a PlanningSettings,
    pub now: f64,
}

/// Pro units per hour on a busy day (75th percentile of recent work days), shaped by the hour of
/// day. Unknown or thin history falls back to medium.
pub fn learn_tempo(input: LearnTempoInput<'_>) -> Tempo {
    let choice = input.settings.tempo.unwrap_or(TempoChoice::Auto);
    if choice != TempoChoice::Auto {
        return preset_tempo(choice, TempoSource::Preset, TempoDays::default());
    }
    let (weekday, weekend) = match input.rollups {
        Some(rollups) => day_samples(rollups, input.accounts, input.settings, input.now),
        None => (Vec::new(), Vec::new()),
    };
    let days = TempoDays {
        weekday: weekday.len() as u32,
        weekend: weekend.len() as u32,
    };
    let learned_weekday = profile(&weekday);
    let learned_weekend = profile(&weekend);
    // A day type without its own profile runs flat at the other one's rate.
    let other = |p: &Option<(f64, Vec<f64>)>| p.as_ref().map(|(rate, _)| (*rate, flat(*rate)));
    let weekday = learned_weekday.clone().or_else(|| other(&learned_weekend));
    let weekend = learned_weekend.or_else(|| other(&learned_weekday));
    match (weekday, weekend) {
        (Some((weekday_rate, weekday)), Some((weekend_rate, weekend))) => Tempo {
            source: TempoSource::Learned,
            weekday,
            weekend,
            rate: TempoRates {
                weekday: weekday_rate,
                weekend: weekend_rate,
            },
            days,
        },
        _ => preset_tempo(TempoChoice::Medium, TempoSource::Default, days),
    }
}

fn day_samples(
    rollups: &UsageRollups,
    accounts: &[Account],
    settings: &PlanningSettings,
    now: f64,
) -> (Vec<DaySample>, Vec<DaySample>) {
    let capacity: HashMap<String, f64> = identity_owners(accounts)
        .into_iter()
        .map(|(identity, account)| (identity, plan_capacity(account)))
        .collect();
    // All identities polled together: Pro units add up, observed minutes do not.
    let mut merged: HashMap<u64, Sum> = HashMap::new();
    for (identity, hours) in &rollups.hours {
        let cap = capacity.get(identity).copied().unwrap_or(1.0);
        for (key, hour) in hours {
            let time = date_parse(key);
            if !time.is_finite() {
                continue;
            }
            let entry = merged.entry(time.to_bits()).or_default();
            entry.units += hour.points * cap;
            entry.covered = entry.covered.max(hour.covered_minutes);
        }
    }
    let (mut weekday, mut weekend) = (Vec::new(), Vec::new());
    let today = local_date(now, &settings.time_zone);
    for back in 1..=TEMPO_DAYS {
        let Some(interval) = work_interval(&shift_date(&today, -f64::from(back)), settings) else {
            continue;
        };
        if interval.end > now {
            continue;
        }
        let (mut units, mut covered) = (0.0, 0.0);
        // Units and observed minutes per local clock hour; in a zone whose offset is not a whole
        // number of hours a UTC hour is split between two local hours by the minutes in each.
        let mut local: IndexMap<u32, Sum> = IndexMap::new();
        let mut add = |hour: u32, share: f64, units: f64, covered: f64| {
            if share <= 0.0 {
                return;
            }
            let sum = local.entry(hour).or_default();
            sum.units += units * share;
            sum.covered += covered * share;
        };
        // UTC hour buckets whose middle falls inside the work interval.
        let mut time = (interval.start / HOUR_MS).floor() * HOUR_MS;
        while time < interval.end {
            let middle = time + HOUR_MS / 2.0;
            let bucket = time;
            time += HOUR_MS;
            if middle < interval.start || middle >= interval.end {
                continue;
            }
            let Some(entry) = merged.get(&bucket.to_bits()).copied() else {
                continue;
            };
            units += entry.units;
            covered += entry.covered;
            // The bucket starts `m` minutes into a local hour: (60 − m)/60 of it is that hour,
            // m/60 the next. Each hour gets only the part inside the work interval.
            let slot = local_slot(bucket, &settings.time_zone);
            let first = (slot / 4.0).floor();
            let split = bucket + (1.0 - (slot % 4.0) / 4.0) * HOUR_MS;
            let from = bucket.max(interval.start);
            let to = (bucket + HOUR_MS).min(interval.end);
            add(
                first as u32,
                (split.min(to) - from) / HOUR_MS,
                entry.units,
                entry.covered,
            );
            add(
                ((first + 1.0) % 24.0) as u32,
                (to - split.max(from)) / HOUR_MS,
                entry.units,
                entry.covered,
            );
        }
        let mut hours = IndexMap::new();
        for (hour, sum) in &local {
            if sum.covered >= MIN_HOUR_COVERAGE {
                hours.insert(*hour, sum.units / (sum.covered / 60.0));
            }
        }
        if covered < (interval.end - interval.start) / 60_000.0 / 2.0 {
            continue;
        }
        let sample = DaySample {
            rate: units / (covered / 60.0),
            hours,
        };
        if interval.weekend {
            weekend.push(sample)
        } else {
            weekday.push(sample)
        }
    }
    (weekday, weekend)
}

/// The busy-day rate and its 24 hourly values, when there are enough days.
fn profile(samples: &[DaySample]) -> Option<(f64, Vec<f64>)> {
    if samples.len() < MIN_TEMPO_DAYS {
        return None;
    }
    let rate = percentile(samples.iter().map(|s| s.rate).collect(), BUSY_PERCENTILE);
    if rate < 1.0 {
        return None;
    }
    let mut sums = [0.0f64; 24];
    let mut counts = [0u32; 24];
    for s in samples {
        if s.rate <= 0.0 {
            continue;
        }
        for (hour, r) in &s.hours {
            sums[*hour as usize] += r / s.rate;
            counts[*hour as usize] += 1;
        }
    }
    let shape: Vec<Option<f64>> = (0..24)
        .map(|h| {
            if counts[h] > 0 {
                Some(sums[h] / f64::from(counts[h]))
            } else {
                None
            }
        })
        .collect();
    let known: Vec<f64> = shape.iter().flatten().copied().collect();
    let mean = if known.is_empty() {
        1.0
    } else {
        known.iter().sum::<f64>() / known.len() as f64
    };
    let values = shape
        .iter()
        .map(|v| match v {
            Some(v) if mean > 0.0 => round1(rate * (v / mean)),
            _ => round1(rate),
        })
        .collect();
    Some((round1(rate), values))
}

fn percentile(mut values: Vec<f64>, p: f64) -> f64 {
    sort_by(&mut values, |a, b| a - b);
    let position = p * (values.len() as f64 - 1.0);
    let low = position.floor() as usize;
    let high = position.ceil() as usize;
    values[low] + (values[high] - values[low]) * (position - low as f64)
}

/// Pro units per hour at `time`, by its local date's day type.
pub fn tempo_at(tempo: &Tempo, settings: &PlanningSettings, time: f64) -> f64 {
    let weekend = is_weekend(&local_date(time, &settings.time_zone));
    let profile = if weekend {
        &tempo.weekend
    } else {
        &tempo.weekday
    };
    hour_value(profile, local_hour(time, &settings.time_zone))
}

fn hour_value(profile: &[f64], hour: f64) -> f64 {
    if hour.is_finite() && hour >= 0.0 {
        profile.get(hour as usize).copied().unwrap_or(0.0)
    } else {
        0.0
    }
}

/// Step-indexed rate lookup for a simulation starting at `from` (one zone read per step, once).
pub fn tempo_rate(
    tempo: &Tempo,
    weekend: bool,
    zone: &str,
    from: f64,
    to: f64,
    step: f64,
) -> impl Fn(f64) -> f64 {
    let profile = if weekend {
        tempo.weekend.clone()
    } else {
        tempo.weekday.clone()
    };
    let mut table: Vec<f64> = Vec::new();
    let mut time = from;
    while time < to {
        table.push(hour_value(&profile, local_hour(time, zone)));
        time += step;
    }
    let zone = zone.to_string();
    move |time: f64| {
        let index = ((time - from) / step).floor();
        if index.is_finite() && index >= 0.0 && (index as usize) < table.len() {
            return table[index as usize];
        }
        hour_value(&profile, local_hour(time, &zone))
    }
}
