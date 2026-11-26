//! Port of `shared/limit-calibration.ts`: what one percent of an account's 5-hour window took, in
//! API-price dollars, from the token table and the recorded usage samples.

// `!(a > b)` is kept where the TS writes it: it is also true when either side is NaN.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use std::collections::HashMap;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::planning::{local_date, wall_time};
use super::types::js::{JsMap, date_parse, round, ser_num, sort_by};
use super::usage_statistics::UsageSample;

const MINUTE_MS: f64 = 60_000.0;
const QUARTER_MS: f64 = 15.0 * MINUTE_MS;
const HOUR_MS: f64 = 60.0 * MINUTE_MS;
const DAY_MS: f64 = 24.0 * HOUR_MS;
/// A window counts when its percent rose this much over at least a quarter hour.
const MIN_RISE: f64 = 3.0;
const MIN_SPAN_MS: f64 = QUARTER_MS;
/// An account is calibrated from at least this many windows and this much rise in all.
const MIN_WINDOWS: u32 = 2;
const MIN_TOTAL_RISE: f64 = 10.0;
/// A window counts only while spending on no account stays under this share of the account's.
const UNPLACED_SHARE: f64 = 0.1;
/// A window's dollars per percent must be within these multiples of the median window's.
const NEAR_MEDIAN_LOW: f64 = 0.4;
const NEAR_MEDIAN_HIGH: f64 = 2.5;

/// What one percent of an account's 5-hour window took, in API-price dollars.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitCalibration {
    pub account_id: String,
    #[serde(serialize_with = "ser_num")]
    pub dollars_per_percent: f64,
    /// The 5-hour windows the estimate rests on.
    pub windows: u32,
    /// The rise and the spending it rests on.
    #[serde(serialize_with = "ser_num")]
    pub percent: f64,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
}

/// A slot's cost (`{ cost: number }`, the token table's `SlotCounts` read for its cost only).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct SlotCost {
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
}

/// The token table's quarter-hour slots: date → who → slot (0–95) → cost.
pub type CostSlots = JsMap<JsMap<JsMap<SlotCost>>>;

/// Slot start times already worked out, by `date|slot`.
pub type SlotStarts = HashMap<String, Option<f64>>;

/// The cost the token table counted for `who` between two times: each quarter hour's cost,
/// weighed by how much of it falls inside. Slots are in the planning time zone's local time.
pub fn slot_cost_between(
    slots: &CostSlots,
    who: &[&str],
    from: f64,
    to: f64,
    zone: &str,
    starts: &mut SlotStarts,
) -> f64 {
    if !(to > from) {
        return 0.0;
    }
    let mut cost = 0.0;
    let first = local_date(from - DAY_MS, zone);
    let last = local_date(to + DAY_MS, zone);
    for (date, by_who) in slots {
        if date.as_str() < first.as_str() || date.as_str() > last.as_str() {
            continue;
        }
        for key in who {
            let Some(day_slots) = by_who.get(key) else {
                continue;
            };
            for (slot, counts) in day_slots {
                let index = super::types::js::number_value(slot);
                if index.fract() != 0.0 || !(0.0..=95.0).contains(&index) || !(counts.cost > 0.0) {
                    continue;
                }
                let index = index as u32;
                let start = *starts.entry(format!("{date}|{index}")).or_insert_with(|| {
                    let clock = format!("{:02}:{:02}", index / 4, (index % 4) * 15);
                    wall_time(date, &clock, zone)
                });
                let Some(start) = start else { continue };
                let overlap = (start + QUARTER_MS).min(to) - start.max(from);
                if overlap > 0.0 {
                    cost += (counts.cost * overlap) / QUARTER_MS;
                }
            }
        }
    }
    cost
}

/// What `calibrate_limits` reads.
pub struct CalibrationInput<'a> {
    pub samples: &'a [UsageSample],
    pub slots: &'a CostSlots,
    pub zone: &'a str,
    pub now: f64,
    /// Missing means 7.
    pub days: Option<f64>,
}

#[derive(Clone, Copy)]
struct Point {
    at: f64,
    percent: f64,
    resets_at: Option<f64>,
}

/// Each account's dollars per percent of its 5-hour window over the last `days`: the spending
/// the token table put on the account while its 5-hour percent rose, divided by the rise, summed
/// over the windows that rose enough and sit near the median window.
pub fn calibrate_limits(input: CalibrationInput<'_>) -> JsMap<LimitCalibration> {
    let since = input.now - input.days.unwrap_or(7.0) * DAY_MS;
    let mut by_account: IndexMap<String, Vec<Point>> = IndexMap::new();
    for sample in input.samples {
        let at = date_parse(&sample.checked_at);
        let Some(percent) = sample.five_hour.as_ref().map(|w| w.used_percent) else {
            continue;
        };
        if !at.is_finite() || at < since || at > input.now || !percent.is_finite() {
            continue;
        }
        let reset = match sample
            .five_hour
            .as_ref()
            .and_then(|w| w.resets_at.as_deref())
            .filter(|r| !r.is_empty())
        {
            Some(r) => date_parse(r),
            None => f64::NAN,
        };
        by_account
            .entry(sample.account_id.clone())
            .or_default()
            .push(Point {
                at,
                percent,
                resets_at: reset.is_finite().then_some(reset),
            });
    }
    let mut out = JsMap::new();
    let mut starts = SlotStarts::new();
    for (account_id, mut points) in by_account {
        sort_by(&mut points, |a, b| a.at - b.at);
        let mut windows: Vec<(Point, Point)> = Vec::new();
        for point in points {
            let new_window = match windows.last() {
                None => true,
                Some((_, last)) => {
                    point.percent < last.percent
                        || point.at - last.at > 5.0 * HOUR_MS
                        || matches!((last.resets_at, point.resets_at), (Some(a), Some(b)) if (b - a).abs() >= HOUR_MS)
                }
            };
            if new_window {
                windows.push((point, point));
            } else {
                windows.last_mut().expect("a window").1 = point;
            }
        }
        let own = [format!("acct:{account_id}"), format!("est:{account_id}")];
        let own: [&str; 2] = [&own[0], &own[1]];
        let mut counted: Vec<(f64, f64)> = Vec::new();
        for (first, last) in &windows {
            let rise = last.percent - first.percent;
            if rise < MIN_RISE || last.at - first.at < MIN_SPAN_MS {
                continue;
            }
            let spent = slot_cost_between(
                input.slots,
                &own,
                first.at,
                last.at,
                input.zone,
                &mut starts,
            );
            // Nothing in the table while the percent rose: the use was elsewhere.
            if !(spent > 0.0) {
                continue;
            }
            // Spending the table could not put on an account may be this account's.
            let unplaced = slot_cost_between(
                input.slots,
                &["terminal", "unknown"],
                first.at,
                last.at,
                input.zone,
                &mut starts,
            );
            if unplaced > spent * UNPLACED_SHARE {
                continue;
            }
            counted.push((rise, spent));
        }
        // Use outside Claude Code fills the window with little in the table: only windows near the
        // median count.
        let mut ratios: Vec<f64> = counted.iter().map(|(rise, spent)| spent / rise).collect();
        sort_by(&mut ratios, |a, b| a - b);
        let middle = match ratios.len() {
            0 => 0.0,
            n if n % 2 == 1 => ratios[(n - 1) / 2],
            n => (ratios[n / 2 - 1] + ratios[n / 2]) / 2.0,
        };
        let (mut percent, mut cost, mut used) = (0.0, 0.0, 0u32);
        for (rise, spent) in counted {
            let ratio = spent / rise;
            if ratio < middle * NEAR_MEDIAN_LOW || ratio > middle * NEAR_MEDIAN_HIGH {
                continue;
            }
            percent += rise;
            cost += spent;
            used += 1;
        }
        if used < MIN_WINDOWS || percent < MIN_TOTAL_RISE {
            continue;
        }
        out.insert(
            account_id.clone(),
            LimitCalibration {
                account_id,
                dollars_per_percent: round((cost / percent) * 1000.0) / 1000.0,
                windows: used,
                percent: round(percent * 10.0) / 10.0,
                cost: round(cost * 100.0) / 100.0,
            },
        );
    }
    out
}
