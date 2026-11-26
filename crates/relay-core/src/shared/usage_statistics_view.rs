//! Port of `shared/usage-statistics-view.ts`: the Usage page model built from the hourly rollups.

use std::collections::HashSet;

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::planning::{local_date, local_hour, plan_capacity, wall_time};
use super::types::js::{JsMap, date_parse, iso, min, round, ser_num, ser_opt_num, sort_by};
use super::types::{Account, AccountPlan, PlanningHours, literal_enum};
use super::usage_rollups::{LimitHitKind, UsageRollups};
use super::usage_statistics::history_identity;

literal_enum!(StatisticsStatus { Available = "available", Unavailable = "unavailable", Empty = "empty" });

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitTotals {
    pub five_hour: u32,
    pub weekly: u32,
}

/// The weekday (0 = Monday) and hour with the most use, and the share inside work hours.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Busiest {
    pub weekday: u32,
    pub hour: u32,
    #[serde(serialize_with = "ser_num")]
    pub work_share: f64,
}

/// The three local hours of the day with the most use: `start`…`end` (exclusive, may pass 24).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusiestWindow {
    pub start: u32,
    pub end: u32,
}

/// The totals, in the key order the TS fills them.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsTotals {
    #[serde(serialize_with = "ser_num")]
    pub pro_units: f64,
    pub windows: u32,
    pub hits: HitTotals,
    /// Full 5-hour periods used: each account's own limit points over 100, unweighted.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub periods: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub previous_pro_units: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busiest: Option<Busiest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busiest_window: Option<BusiestWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsAccount {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// `true` or absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub former: Option<bool>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(serialize_with = "ser_num")]
    pub pro_units: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub periods: Option<f64>,
    #[serde(serialize_with = "ser_num")]
    pub share: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub average_fill: Option<f64>,
    pub idle_days: u32,
}

/// A day's Pro units by row key (and the same day in 5-hour periods).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsDay {
    pub date: String,
    pub by_account: JsMap<super::types::js::Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub periods: Option<JsMap<super::types::js::Num>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsHit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub former: Option<bool>,
    pub name: String,
    pub kind: LimitHitKind,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

/// One suggestion about the accounts' balance, as a message id and its parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Insight {
    pub id: String,
    pub params: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatisticsView {
    /// 7, 30 or 90.
    pub range: u32,
    pub status: StatisticsStatus,
    /// Observed minutes over the range so far, 0–100.
    #[serde(serialize_with = "ser_num")]
    pub coverage_percent: f64,
    pub totals: StatisticsTotals,
    pub accounts: Vec<StatisticsAccount>,
    pub daily: Vec<StatisticsDay>,
    /// [weekday 0 = Monday][local hour] → Pro units
    pub heatmap: Vec<Vec<super::types::js::Num>>,
    pub hits: Vec<StatisticsHit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insight: Option<Insight>,
}

/// The work hours the share of use is measured against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatisticsHours {
    pub weekday: PlanningHours,
    pub weekend: PlanningHours,
}

/// What `build_statistics_view` reads.
#[derive(Debug, Clone, Copy)]
pub struct StatisticsInput<'a> {
    pub rollups: Option<&'a UsageRollups>,
    pub available: bool,
    pub accounts: &'a [Account],
    pub range: u32,
    pub account_id: Option<&'a str>,
    pub zone: &'a str,
    pub now: f64,
    pub hours: Option<&'a StatisticsHours>,
}

fn minutes(hhmm: &str) -> f64 {
    let mut parts = hhmm.split(':').map(super::types::js::number_value);
    let h = parts.next().unwrap_or(f64::NAN);
    let m = parts.next().unwrap_or(f64::NAN);
    let or_zero = |v: f64| if v.is_nan() || v == 0.0 { 0.0 } else { v };
    or_zero(h) * 60.0 + or_zero(m)
}

/// Whether the local hour `hour` of `weekday` (0 = Monday) starts inside the work hours.
pub fn in_work_hours(weekday: u32, hour: u32, hours: Option<&StatisticsHours>) -> bool {
    let Some(hours) = hours else {
        return weekday < 5 && (10..18).contains(&hour);
    };
    let day = if weekday < 5 {
        &hours.weekday
    } else {
        &hours.weekend
    };
    if !day.enabled {
        return false;
    }
    let (start, end) = (minutes(&day.start), minutes(&day.end));
    let at = f64::from(hour) * 60.0;
    // An end before the start runs past midnight.
    if end > start {
        at >= start && at < end
    } else {
        at >= start || at < end
    }
}

pub const FORMER_KEY: &str = "former";
pub const FORMER_NAME: &str = "Eski hesap";
const DAY_MS: f64 = 86_400_000.0;
const FIVE_HOURS_MS: f64 = 5.0 * 3_600_000.0;
const PREVIOUS_MAX_DAYS: u32 = 45;
const INSIGHT_MIN_WINDOWS: usize = 5;
/// Days an account must have sat idle before the order insight names it.
const INSIGHT_IDLE_DAYS: u32 = 3;

fn plan_label(plan: AccountPlan) -> Option<&'static str> {
    match plan {
        AccountPlan::Pro => Some("Pro"),
        AccountPlan::Max5 => Some("Max 5×"),
        AccountPlan::Max20 => Some("Max 20×"),
        AccountPlan::Team => Some("Team"),
        AccountPlan::Unknown => None,
    }
}

fn round1(v: f64) -> f64 {
    round(v * 10.0) / 10.0
}
fn round2(v: f64) -> f64 {
    round(v * 100.0) / 100.0
}

fn shift_date(date: &str, days: f64) -> String {
    let text = iso(date_parse(&format!("{date}T00:00:00Z")) + days * DAY_MS);
    text.get(..10).unwrap_or("").to_string()
}

/// 0 = Monday … 6 = Sunday for a YYYY-MM-DD calendar date.
fn weekday(date: &str) -> usize {
    let at = date_parse(&format!("{date}T00:00:00Z"));
    (((at / DAY_MS).floor() as i64 + 4).rem_euclid(7) as usize + 6) % 7
}

/// Days a row has sat idle up to today: observed days without use, counted back to its last
/// active day. Days Relay did not observe are skipped.
fn idle_streak(dates: &[String], covered: &IndexSet<String>, active: &IndexSet<String>) -> u32 {
    let mut days = 0;
    for date in dates.iter().rev() {
        if active.contains(date) {
            break;
        }
        if covered.contains(date) {
            days += 1;
        }
    }
    days
}

struct Row<'a> {
    key: String,
    account: Option<&'a Account>,
    identities: Vec<String>,
    capacity: f64,
}

fn empty_view(range: u32, status: StatisticsStatus, dates: &[String]) -> UsageStatisticsView {
    UsageStatisticsView {
        range,
        status,
        coverage_percent: 0.0,
        totals: StatisticsTotals::default(),
        accounts: Vec::new(),
        daily: dates
            .iter()
            .map(|d| StatisticsDay {
                date: d.clone(),
                by_account: JsMap::new(),
                periods: None,
            })
            .collect(),
        heatmap: vec![vec![super::types::js::Num(0.0); 24]; 7],
        hits: Vec::new(),
        insight: None,
    }
}

/// A number as a message parameter: an integer stays one.
fn param_number(value: f64) -> Value {
    serde_json::to_value(super::types::js::Num(value)).unwrap_or(Value::Null)
}

/// Builds the Usage page model from hourly rollups. Days and hours follow `zone`; the range is the
/// last `range` local days including today. Pro units apply each account's current plan capacity.
pub fn build_statistics_view(input: &StatisticsInput<'_>) -> UsageStatisticsView {
    let (accounts, range, zone, now) = (input.accounts, input.range, input.zone, input.now);
    let today = local_date(now, zone);
    let dates: Vec<String> = (0..range)
        .map(|i| shift_date(&today, f64::from(i) - f64::from(range) + 1.0))
        .collect();
    if !input.available {
        return empty_view(range, StatisticsStatus::Unavailable, &dates);
    }
    let in_range: HashSet<&str> = dates.iter().map(String::as_str).collect();
    let previous_first = shift_date(&dates[0], -f64::from(range));
    let previous: HashSet<String> = (0..range)
        .map(|i| shift_date(&previous_first, f64::from(i)))
        .collect();

    // Identity → row: current accounts in their order, then one "former" row.
    // `identityOwners` over the scoped accounts, by index: the first signed-in account sharing an
    // identity, else the first; a row is the account object that owns its identity.
    let scoped = |a: &Account| {
        input
            .account_id
            .is_none_or(|id| id.is_empty() || a.id == id)
    };
    let logged_in = |a: &Account| a.auth.as_ref().is_some_and(|x| x.logged_in);
    let mut owner: IndexMap<String, usize> = IndexMap::new();
    for (index, account) in accounts.iter().enumerate() {
        if !scoped(account) {
            continue;
        }
        let Some(identity) = history_identity(account) else {
            continue;
        };
        match owner.get(&identity) {
            Some(&current) if logged_in(&accounts[current]) || !logged_in(account) => {}
            _ => {
                owner.insert(identity, index);
            }
        }
    }
    let mut rows: Vec<Row<'_>> = Vec::new();
    let mut row_of: IndexMap<String, usize> = IndexMap::new();
    for (index, account) in accounts.iter().enumerate() {
        let Some(identity) = history_identity(account) else {
            continue;
        };
        if owner.get(&identity) != Some(&index) {
            continue;
        }
        row_of.insert(identity.clone(), rows.len());
        rows.push(Row {
            key: account.id.clone(),
            account: Some(account),
            identities: vec![identity],
            capacity: plan_capacity(account),
        });
    }
    let rollups = input.rollups;
    if input.account_id.is_none_or(str::is_empty) {
        let known: HashSet<Option<String>> = accounts.iter().map(history_identity).collect();
        let mut former = Row {
            key: FORMER_KEY.into(),
            account: None,
            identities: Vec::new(),
            capacity: 1.0,
        };
        let mut seen: IndexSet<String> = IndexSet::new();
        if let Some(r) = rollups {
            seen.extend(r.hours.keys().cloned());
            seen.extend(r.windows.keys().cloned());
            seen.extend(r.hits.iter().map(|h| h.identity.clone()));
        }
        for identity in seen {
            if !known.contains(&Some(identity.clone())) {
                former.identities.push(identity.clone());
                row_of.insert(identity, rows.len());
            }
        }
        if !former.identities.is_empty() {
            rows.push(former);
        }
    }
    let Some(rollups) = rollups.filter(|_| !rows.is_empty()) else {
        return empty_view(range, StatisticsStatus::Empty, &dates);
    };

    let mut view = empty_view(range, StatisticsStatus::Available, &dates);
    for day in &mut view.daily {
        day.periods = Some(JsMap::new());
    }
    let day_index: IndexMap<String, usize> = dates
        .iter()
        .enumerate()
        .map(|(i, d)| (d.clone(), i))
        .collect();
    let n = rows.len();
    let mut periods: Vec<Option<f64>> = vec![None; n];
    let mut periods_total = 0.0;
    let mut units = vec![0.0; n];
    let mut covered_days: Vec<IndexSet<String>> = vec![IndexSet::new(); n];
    let mut present = vec![false; n];
    let mut active_days: Vec<IndexSet<String>> = vec![IndexSet::new(); n];
    let mut coverage: IndexMap<String, f64> = IndexMap::new();
    let mut total = 0.0;
    let mut previous_total = 0.0;
    // Earliest stored hour of the identities shown.
    let mut recorded_from = f64::INFINITY;
    let mut observed_any = false;
    let mut heat = vec![vec![0.0f64; 24]; 7];

    for (r, row) in rows.iter().enumerate() {
        for identity in &row.identities {
            let Some(hours) = rollups.hours.get(identity) else {
                continue;
            };
            for (key, hour) in hours {
                let time = date_parse(key);
                recorded_from = min([recorded_from, time]);
                let date = local_date(time, zone);
                let value = hour.points * row.capacity;
                if previous.contains(&date) {
                    previous_total += value;
                }
                if !in_range.contains(date.as_str()) {
                    continue;
                }
                observed_any = true;
                present[r] = true;
                if hour.covered_minutes > 0.0 {
                    covered_days[r].insert(date.clone());
                }
                let cell = coverage.entry(key.clone()).or_insert(0.0);
                *cell = super::types::js::max([*cell, 60f64.min(hour.covered_minutes)]);
                if hour.points > 0.0 {
                    active_days[r].insert(date.clone());
                }
                if value == 0.0 || value.is_nan() {
                    continue;
                }
                let used = hour.points / 100.0;
                periods_total += used;
                periods[r] = Some(periods[r].unwrap_or(0.0) + used);
                let day = &mut view.daily[day_index[&date]];
                let day_periods = day.periods.as_mut().expect("set above");
                let before = day_periods.get(&row.key).map_or(0.0, |v| v.0);
                day_periods.insert(
                    row.key.clone(),
                    super::types::js::Num(round2(before + used)),
                );
                total += value;
                units[r] += value;
                let before = day.by_account.get(&row.key).map_or(0.0, |v| v.0);
                day.by_account.insert(
                    row.key.clone(),
                    super::types::js::Num(round2(before + value)),
                );
                let h = local_hour(time, zone);
                if h.is_finite() {
                    heat[weekday(&date)][h as usize] += value;
                }
            }
        }
    }
    if !observed_any {
        return empty_view(range, StatisticsStatus::Empty, &dates);
    }

    // Windows that started (resetAt − 5h) inside the range; a window still open at `now` counts as
    // started but its fill is not final.
    let mut fills: Vec<Vec<f64>> = vec![Vec::new(); n];
    for (r, row) in rows.iter().enumerate() {
        for identity in &row.identities {
            let Some(windows) = rollups.windows.get(identity) else {
                continue;
            };
            for w in windows {
                let reset_at = date_parse(&w.reset_at);
                let date = local_date(reset_at - FIVE_HOURS_MS, zone);
                if !in_range.contains(date.as_str()) {
                    continue;
                }
                present[r] = true;
                active_days[r].insert(date);
                view.totals.windows += 1;
                if reset_at <= now {
                    fills[r].push(w.max_percent);
                }
            }
        }
    }

    for hit in &rollups.hits {
        let Some(&r) = row_of.get(&hit.identity) else {
            continue;
        };
        if !in_range.contains(local_date(date_parse(&hit.at), zone).as_str()) {
            continue;
        }
        present[r] = true;
        let row = &rows[r];
        // A hit ends at its reset at the latest, even without a later sample.
        let until = hit.until.clone().or_else(|| {
            hit.reset_at
                .clone()
                .filter(|reset| !reset.is_empty() && date_parse(reset) <= now)
        });
        view.hits.push(StatisticsHit {
            account_id: row.account.map(|a| a.id.clone()),
            former: row.account.is_none().then_some(true),
            name: row
                .account
                .map_or_else(|| FORMER_NAME.to_string(), |a| a.name.clone()),
            kind: hit.kind,
            at: hit.at.clone(),
            until: until.filter(|u| !u.is_empty()),
        });
        match hit.kind {
            LimitHitKind::FiveHour => view.totals.hits.five_hour += 1,
            LimitHitKind::Weekly => view.totals.hits.weekly += 1,
        }
    }
    sort_by(&mut view.hits, |a, b| date_parse(&b.at) - date_parse(&a.at));

    let shown: Vec<usize> = (0..n).filter(|r| present[*r]).collect();
    view.accounts = shown
        .iter()
        .map(|&r| {
            let row = &rows[r];
            let list = &fills[r];
            let plan = row
                .account
                .and_then(|a| a.planning.as_ref())
                .and_then(|p| plan_label(p.plan));
            StatisticsAccount {
                account_id: row.account.map(|a| a.id.clone()),
                former: row.account.is_none().then_some(true),
                name: row
                    .account
                    .map_or_else(|| FORMER_NAME.to_string(), |a| a.name.clone()),
                plan: plan.map(str::to_string),
                pro_units: round2(units[r]),
                periods: Some(round2(periods[r].unwrap_or(0.0))),
                share: if total > 0.0 {
                    round1((units[r] / total) * 100.0)
                } else {
                    0.0
                },
                average_fill: (!list.is_empty())
                    .then(|| round1(list.iter().fold(0.0, |a, b| a + b) / list.len() as f64)),
                idle_days: covered_days[r]
                    .iter()
                    .filter(|d| !active_days[r].contains(*d))
                    .count() as u32,
            }
        })
        .collect();

    view.totals.pro_units = round2(total);
    view.totals.periods = Some(round2(periods_total));
    // Compare only with a previous period that recording covers from its start.
    let previous_start =
        wall_time(&previous_first, "00:00", zone).unwrap_or(now - 2.0 * f64::from(range) * DAY_MS);
    if range <= PREVIOUS_MAX_DAYS && recorded_from <= previous_start {
        view.totals.previous_pro_units = Some(round2(previous_total));
    }

    let heat: Vec<Vec<f64>> = heat
        .into_iter()
        .map(|row| row.into_iter().map(round2).collect())
        .collect();
    if total > 0.0 {
        let (mut best_day, mut best_hour, mut best_value) = (0u32, 0u32, -1.0);
        let mut work = 0.0;
        let mut by_hour = [0.0f64; 24];
        for (day, row) in heat.iter().enumerate() {
            for (hour, value) in row.iter().enumerate() {
                if *value > best_value {
                    (best_day, best_hour, best_value) = (day as u32, hour as u32, *value);
                }
                if in_work_hours(day as u32, hour as u32, input.hours) {
                    work += value;
                }
                by_hour[hour] += value;
            }
        }
        view.totals.busiest = Some(Busiest {
            weekday: best_day,
            hour: best_hour,
            work_share: round1((work / total) * 100.0),
        });
        // The three hours in a row (around midnight too) with the most use.
        let (mut start, mut most) = (0u32, -1.0);
        for h in 0..24 {
            let sum = by_hour[h] + by_hour[(h + 1) % 24] + by_hour[(h + 2) % 24];
            if sum > most {
                (most, start) = (sum, h as u32);
            }
        }
        view.totals.busiest_window = Some(BusiestWindow {
            start,
            end: start + 3,
        });
    }
    view.heatmap = heat
        .into_iter()
        .map(|row| row.into_iter().map(super::types::js::Num).collect())
        .collect();

    let start = wall_time(&dates[0], "00:00", zone).unwrap_or(now - f64::from(range) * DAY_MS);
    let range_minutes = super::types::js::max([1.0, (now - start) / 60_000.0]);
    let covered: f64 = coverage.values().fold(0.0, |a, b| a + b);
    view.coverage_percent = 100f64.min(round1((covered / range_minutes) * 100.0));

    let idle: Vec<u32> = shown
        .iter()
        .map(|&r| idle_streak(&dates, &covered_days[r], &active_days[r]))
        .collect();
    view.insight = build_insight(&rows, &shown, &view.accounts, &fills, &idle);
    view
}

fn build_insight(
    rows: &[Row<'_>],
    shown: &[usize],
    out: &[StatisticsAccount],
    fills: &[Vec<f64>],
    idle: &[u32],
) -> Option<Insight> {
    // Index into `shown`/`out`/`idle`, for the rows that are accounts.
    let accounts: Vec<usize> = (0..shown.len())
        .filter(|i| rows[shown[*i]].account.is_some())
        .collect();
    let candidates: Vec<usize> = accounts
        .iter()
        .copied()
        .filter(|i| out[*i].average_fill.is_some())
        .collect();
    let label = |i: usize| match &out[i].plan {
        Some(plan) => format!("{} ({plan})", out[i].name),
        None => out[i].name.clone(),
    };
    let capacity = |i: usize| rows[shown[i]].capacity;
    let fill = |i: usize| out[i].average_fill.unwrap_or(f64::NAN);
    // Rule 1 counts the same closed windows that averageFill is built from. Stable sorts keep
    // account order between equal capacities.
    let mut sparse: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|i| fills[shown[*i]].len() >= INSIGHT_MIN_WINDOWS && fill(*i) < 20.0)
        .collect();
    sort_by(&mut sparse, |a, b| capacity(*b) - capacity(*a));
    if let Some(&s) = sparse.first() {
        // The view crosses IPC as data: the percent is a fraction the message formats per language.
        let fraction = round(fill(s)) / 100.0;
        let mut params = serde_json::Map::new();
        params.insert("label".into(), Value::String(label(s)));
        params.insert("fill".into(), param_number(fraction));
        return Some(Insight {
            id: "usageStatisticsView.fillsOnlyOfItsPeriods".into(),
            params,
        });
    }
    let mut full: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|i| fill(*i) > 80.0)
        .collect();
    sort_by(&mut full, |a, b| capacity(*a) - capacity(*b));
    let full = full.first().copied()?;
    // A full account beside one that has sat idle for days: shifting the order moves work to the
    // idle one (the longest idle is named) before the plain note that it fills.
    let mut spare: Vec<usize> = accounts
        .iter()
        .copied()
        .filter(|c| shown[*c] != shown[full] && idle[*c] >= INSIGHT_IDLE_DAYS)
        .collect();
    sort_by(&mut spare, |a, b| f64::from(idle[*b]) - f64::from(idle[*a]));
    let mut params = serde_json::Map::new();
    if let Some(&spare) = spare.first() {
        params.insert("spare".into(), Value::String(out[spare].name.clone()));
        params.insert("full".into(), Value::String(out[full].name.clone()));
        params.insert("days".into(), param_number(f64::from(idle[spare])));
        return Some(Insight {
            id: "usageStatisticsView.wasIdleMoveUpTheOrder".into(),
            params,
        });
    }
    params.insert("label".into(), Value::String(label(full)));
    Some(Insight {
        id: "usageStatisticsView.isAlmostAlwaysFull".into(),
        params,
    })
}
